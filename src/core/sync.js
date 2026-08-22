/**
 * sync.js
 *
 * Push/pull between the localStorage cache (storage.js) and Supabase.
 *
 * DESIGN:
 * - Views never call this module for data — they read/write storage.js and
 *   this module moves data in the background.
 * - PUSH: drain the outbox oldest-first. The payload is read fresh from the
 *   local cache at push time, so repeated edits collapse into one upsert.
 * - PULL: full select of both tables (RLS scopes rows to the signed-in
 *   clinician), merged into the cache with last-write-wins by updated_at.
 *   Fine at prototype scale (hundreds of sessions × a few KB).
 * - FAILURES: network errors keep the op for retry; permanent errors
 *   (4xx / RLS rejection) drop the op and log the id only — record
 *   contents never go to the console (PHI hygiene).
 * - peakFrame/minFrame (large JPEG data URLs) are stripped from pushed
 *   payloads; images stay local-only for now.
 *
 * TRIGGERS: login (initSync), window 'online', tab becoming visible, and
 * every outbox enqueue (via storage.setOutboxListener). No polling.
 */

import { getClient, getUserId } from './supabase.js'
import { isUuid } from './id.js'
import {
  loadOutbox, removeOp, setOutboxListener,
  loadSessions, getPatient, setSessionFramePath, enqueueOp,
  mergeRemotePatients, mergeRemoteSessions,
} from './storage.js'
import * as imageStore from './imageStore.js'

const IMAGE_BUCKET = 'session-images'

let _running   = false
let _queued    = false   // a trigger fired while a sync was in flight
let _listeners = []
// Set when the server rejects a write for naming a column it does not have —
// i.e. the code was deployed before its migration. Sticky until a push
// succeeds, because the condition persists until someone applies the SQL.
let _schemaMismatch = false

// ─── Status pub-sub ───────────────────────────────────────────────────────────

/**
 * Current sync state for the UI badge.
 * @returns {{state: 'offline'|'pending'|'synced', pendingCount: number}}
 */
export function getStatus() {
  const pendingCount = loadOutbox().length
  if (_schemaMismatch) return { state: 'schema_mismatch', pendingCount, schemaMismatch: true }
  if (!_isOnline()) return { state: 'offline', pendingCount, schemaMismatch: false }
  return { state: pendingCount > 0 ? 'pending' : 'synced', pendingCount, schemaMismatch: false }
}

/**
 * Subscribe to status changes. Returns an unsubscribe function.
 */
export function onSyncStatus(callback) {
  _listeners.push(callback)
  return () => { _listeners = _listeners.filter(cb => cb !== callback) }
}

function _notifyStatus() {
  const status = getStatus()
  for (const cb of _listeners) cb(status)
}

function _isOnline() {
  // navigator is absent in Node (tests); treat unknown as online.
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Start background sync. Call once after login (only when Supabase is
 * configured). Safe to call again after sign-in/sign-out cycles.
 */
export function initSync() {
  setOutboxListener(() => {
    _notifyStatus()
    syncNow()
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => syncNow())
    window.addEventListener('offline', () => _notifyStatus())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncNow()
    })
  }
  syncNow()
}

/**
 * Push pending ops, then pull remote changes. No-ops when offline; if
 * called while a sync is already running, one follow-up run is queued so
 * ops enqueued mid-sync aren't stranded until the next trigger.
 */
export async function syncNow() {
  if (!_isOnline()) { _notifyStatus(); return }
  if (_running) { _queued = true; return }
  _running = true
  try {
    await processOutbox()
    await pullAll()
  } catch (e) {
    // Unexpected failure (e.g. auth token refresh offline) — leave the
    // outbox intact and retry on the next trigger.
    console.warn('Sync pass failed:', e?.message ?? e)
  } finally {
    _running = false
    _notifyStatus()
    if (_queued) {
      _queued = false
      syncNow()
    }
  }
}

// ─── Push ─────────────────────────────────────────────────────────────────────

export async function processOutbox() {
  const ops = loadOutbox()   // oldest first
  for (const op of ops) {
    // Legacy pre-sync ids (sess_<ts>) can't live in a uuid column — those
    // records stay local-only. For upload_image the entity_id is
    // `${sessionId}:${which}`, so validate the sessionId portion.
    const entityUuid = op.type === 'upload_image' ? op.entity_id.split(':')[0] : op.entity_id
    if (!isUuid(entityUuid)) { removeOp(op.id); continue }

    const { error, missing } = await _pushOp(op)

    if (missing) { removeOp(op.id); continue }   // entity deleted locally since queueing
    if (!error)  { removeOp(op.id); _schemaMismatch = false; _notifyStatus(); continue }

    // A missing column is a DEPLOY FAULT, not a rejection of the data, and it
    // is checked before the generic retry test so the alarm is raised. Dropping
    // the op here — which is what happened before this branch existed — loses
    // the record permanently and silently: the migration gets applied later,
    // everything looks healthy, and the session simply never reaches the cloud.
    if (_isSchemaMismatch(error)) {
      if (!_schemaMismatch) {
        console.error(
          `Sync halted: the database is missing a column this build writes (${error.code}). ` +
          `Apply the pending migration in supabase/migrations. ` +
          `Ops are RETAINED and will drain once the schema matches.`
        )
      }
      _schemaMismatch = true
      _notifyStatus()
      return   // keep op, stop the drain
    }

    if (_isRetryable(error)) return   // keep op, stop the drain, retry later
    // Permanent rejection — drop the op. Ids only, never record contents.
    console.warn(`Sync op dropped (${op.type} ${op.entity_id}):`, error.code ?? error.message)
    removeOp(op.id)
  }
}

async function _pushOp(op) {
  const client = getClient()
  switch (op.type) {
    case 'upsert_session': {
      const session = loadSessions().find(s => s.id === op.entity_id)
      if (!session) return { missing: true }
      if (!isUuid(session.patient_id)) return { error: { message: 'session has no patient_id' } }
      const { error } = await client.from('sessions').upsert(sessionToRow(session))
      return { error }
    }
    case 'delete_session': {
      // PHI hygiene: remove the row AND any cloud snapshots for it. Removing
      // absent objects is a no-op, so this is safe for sessions that never
      // had images.
      const userId = await getUserId()
      if (userId) {
        await client.storage.from(IMAGE_BUCKET).remove([
          `${userId}/${op.entity_id}/peak.jpg`,
          `${userId}/${op.entity_id}/min.jpg`,
        ])
      }
      const { error } = await client.from('sessions').delete().eq('id', op.entity_id)
      return { error }
    }
    case 'upload_image': {
      const [sessionId, which] = op.entity_id.split(':')
      const blob = await imageStore.getImage(sessionId, which)
      if (!blob) return { missing: true }   // evicted or session deleted since queueing
      const userId = await getUserId()
      // No cached session (rare — shouldn't drain while signed out). Keep the op.
      if (!userId) return { error: { message: 'no auth session', retry: true } }
      const path = `${userId}/${sessionId}/${which}.jpg`
      const { error } = await client.storage
        .from(IMAGE_BUCKET)
        .upload(path, blob, { upsert: true, contentType: 'image/jpeg' })
      if (error) return { error }
      // Record the path locally, mark the blob backed-up (now evictable), and
      // queue a session upsert so the path column reaches the DB.
      setSessionFramePath(sessionId, which, path)
      await imageStore.markUploaded(sessionId, which)
      enqueueOp({ type: 'upsert_session', entity_id: sessionId })
      await imageStore.enforceBudget()
      return { error: null }
    }
    case 'upsert_patient': {
      const patient = getPatient(op.entity_id)
      if (!patient) return { missing: true }
      const { error } = await client.from('patients').upsert(patientToRow(patient))
      return { error }
    }
    default:
      return { error: { message: `unknown op type ${op.type}` } }
  }
}

// PostgREST returns PGRST204 when a payload names a column the schema cache
// does not have; the database itself raises 42703 (undefined_column). Both mean
// THE CODE IS AHEAD OF THE MIGRATION — a condition that fixes itself the moment
// the SQL is applied, which is exactly what makes them retryable.
//
// This is categorically different from an RLS 403, which is a legitimate
// rejection that will never succeed. Keep the two apart: widening this to "any
// 4xx is retryable" would make genuinely rejected ops retry forever.
const SCHEMA_MISMATCH_CODES = new Set(['PGRST204', '42703'])

function _isSchemaMismatch(error) {
  return SCHEMA_MISMATCH_CODES.has(error?.code)
}

function _isRetryable(error) {
  // supabase-js surfaces network failures as fetch TypeErrors without a
  // PostgREST code; anything with a code reached the server and won't
  // succeed on retry — EXCEPT a schema mismatch, which is a deploy fault.
  if (error.retry) return true   // explicit transient signal (e.g. no cached session yet)
  if (!_isOnline()) return true
  if (_isSchemaMismatch(error)) return true
  return !error.code && /fetch|network|load failed/i.test(error.message ?? '')
}

// ─── Pull ─────────────────────────────────────────────────────────────────────

export async function pullAll() {
  const client = getClient()

  const { data: patients, error: pErr } = await client.from('patients').select('*')
  if (pErr) { console.warn('Patient pull failed:', pErr.code ?? pErr.message); return }
  mergeRemotePatients(patients.map(rowToPatient))

  const { data: sessions, error: sErr } = await client.from('sessions').select('*')
  if (sErr) { console.warn('Session pull failed:', sErr.code ?? sErr.message); return }
  mergeRemoteSessions(sessions.map(rowToSession))
}

// ─── Shape mapping (client camelCase ⇄ Postgres snake_case) ──────────────────
// clinician_id is never sent — the column default auth.uid() fills it and
// RLS rejects anything else.

export function sessionToRow(s) {
  return {
    id:             s.id,
    patient_id:     s.patient_id,
    measured_at:    s.timestamp,
    date:           s.date,
    joint:          s.joint,
    side:           s.side,
    position:       s.position ?? null,
    min:            s.min,
    max:            s.max,
    rom:            s.rom,
    duration_s:     s.duration_s,
    samples:        s.samples,
    angle_timeline: s.angleTimeline ?? null,
    // All three angle-provenance stamps must travel. They say how the numbers
    // in this row were produced, and a session missing them has to be treated
    // as suspect: no `angle_filter` means the old moving average clipped its
    // peaks, and no `angle_convention` means shoulder values are on an inverted
    // scale and ankle values offset by 90°. Mapping `angle_mode` alone — which
    // is what this did originally — let a cloud pull silently downgrade a good
    // session into one that looks unrecoverable.
    angle_mode:       s.angleMode ?? null,
    angle_filter:     s.angleFilter ?? null,
    angle_convention: s.angleConvention ?? null,
    // Calibration state travels for the same reason: a session's numbers mean
    // something different raw than re-based on a captured neutral, and the
    // offset itself lives only in device-local settings that are cleared on
    // every joint/side/patient switch. If this were dropped in the round-trip
    // the session would come back claiming its calibration was never recorded.
    calibrated:         s.calibrated ?? null,
    calibration_offset: s.calibrationOffset ?? null,
    // Out-of-plane provenance travels for the same reason as the stamps above.
    // The 2D angle is the joint angle only while the limb stays in the image
    // plane; this says whether it did. Dropping it in the round-trip would
    // bring the session back claiming that was never checked.
    max_segment_tilt:   s.maxSegmentTilt ?? null,
    // ── Landmark evidence + verification (0006) ──────────────────────────────
    // Same rule as every stamp above: if these do not travel, a cloud pull
    // brings the session back claiming evidence was never captured, and a
    // clinician's verification is silently discarded. `landmarks_raw` is the
    // immutable baseline the research delta is measured against — it is
    // written once at capture and must never be rewritten from here.
    landmark_space:      s.landmarkSpace ?? null,
    model_id:            s.modelId ?? null,
    model_version:       s.modelVersion ?? null,
    landmarks_raw:       s.landmarksRaw ?? null,
    frame_angle_raw_max: s.frameAngleRawMax ?? null,
    frame_angle_raw_min: s.frameAngleRawMin ?? null,
    // `?? null` and not `|| null`: a measured tilt of exactly 0 is the positive
    // claim that the frame was in plane, and must survive as 0.
    frame_tilt_max:      s.frameTiltMax ?? null,
    frame_tilt_min:      s.frameTiltMin ?? null,
    verifications:       s.verifications ?? null,
    notes:          s.notes ?? '',
    app_version:    s.app_version ?? null,
    peak_frame_path: s.peakFramePath ?? null,
    min_frame_path:  s.minFramePath ?? null,
    updated_at:     new Date(s.updated_at ?? Date.now()).toISOString(),
    // Image BYTES are never sent here — the blobs live in imageStore/IndexedDB
    // and upload_image ops push them straight to Storage; only the paths sync.
  }
}

export function rowToSession(row) {
  return {
    id:            row.id,
    patient_id:    row.patient_id,
    timestamp:     Number(row.measured_at),
    date:          row.date,
    joint:         row.joint,
    side:          row.side,
    position:      row.position ?? undefined,
    min:           row.min,
    max:           row.max,
    rom:           row.rom,
    duration_s:    row.duration_s,
    samples:       row.samples,
    angleTimeline: row.angle_timeline ?? [],
    // `undefined`, not null — absence is what marks a pre-stamp session, and
    // storage/UI already branch on the field being missing.
    angleMode:       row.angle_mode ?? undefined,
    angleFilter:     row.angle_filter ?? undefined,
    angleConvention: row.angle_convention ?? undefined,
    // Same absence rule: `undefined` marks a session that never recorded its
    // calibration state. Mapping a null column to `false` here would turn "not
    // recorded" into the positive claim "measured raw".
    calibrated:        row.calibrated ?? undefined,
    calibrationOffset: row.calibration_offset ?? undefined,
    // Null column -> null, NOT undefined and NOT 0: "never measured" is the
    // same claim on both sides of the wire here, and 0 would assert the limb
    // was checked and found in plane.
    maxSegmentTilt:    row.max_segment_tilt ?? null,
    // ── Landmark evidence + verification (0006) ──────────────────────────────
    // `undefined` for the three stamps: their ABSENCE is what marks a session
    // recorded before landmark capture existed, which is not verifiable and
    // whose stored image is the legacy baked composite.
    landmarkSpace:    row.landmark_space ?? undefined,
    modelId:          row.model_id ?? undefined,
    modelVersion:     row.model_version ?? undefined,
    // `null` for the rest: null is the same claim on both sides of the wire.
    // For `verifications`, null/[] means NEVER VERIFIED — never "verified and
    // found unchanged", and no consumer may collapse the two.
    landmarksRaw:     row.landmarks_raw ?? null,
    frameAngleRawMax: row.frame_angle_raw_max ?? null,
    frameAngleRawMin: row.frame_angle_raw_min ?? null,
    frameTiltMax:     row.frame_tilt_max ?? null,
    frameTiltMin:     row.frame_tilt_min ?? null,
    verifications:    row.verifications ?? null,
    notes:         row.notes ?? '',
    app_version:   row.app_version ?? undefined,
    peakFramePath: row.peak_frame_path ?? null,
    minFramePath:  row.min_frame_path ?? null,
    updated_at:    Date.parse(row.updated_at) || 0,
  }
}

export function patientToRow(p) {
  return {
    id:            p.id,
    name:          p.name,
    dob:           p.dob || null,
    mrn:           p.mrn || null,
    diagnosis:     p.diagnosis || null,
    surgery_date:  p.surgeryDate || null,
    affected_side: p.affectedSide || null,
    notes:         p.notes ?? '',
    archived:      Boolean(p.archived),
    updated_at:    new Date(p.updated_at ?? Date.now()).toISOString(),
  }
}

export function rowToPatient(row) {
  return {
    id:           row.id,
    name:         row.name,
    dob:          row.dob ?? null,
    mrn:          row.mrn ?? '',
    diagnosis:    row.diagnosis ?? '',
    surgeryDate:  row.surgery_date ?? null,
    affectedSide: row.affected_side ?? null,
    notes:        row.notes ?? '',
    archived:     Boolean(row.archived),
    created_at:   Date.parse(row.created_at) || 0,
    updated_at:   Date.parse(row.updated_at) || 0,
  }
}
