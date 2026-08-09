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

// ─── Status pub-sub ───────────────────────────────────────────────────────────

/**
 * Current sync state for the UI badge.
 * @returns {{state: 'offline'|'pending'|'synced', pendingCount: number}}
 */
export function getStatus() {
  const pendingCount = loadOutbox().length
  if (!_isOnline()) return { state: 'offline', pendingCount }
  return { state: pendingCount > 0 ? 'pending' : 'synced', pendingCount }
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
    if (!error)  { removeOp(op.id); _notifyStatus(); continue }

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

function _isRetryable(error) {
  // supabase-js surfaces network failures as fetch TypeErrors without a
  // PostgREST code; anything with a code reached the server and won't
  // succeed on retry.
  if (error.retry) return true   // explicit transient signal (e.g. no cached session yet)
  if (!_isOnline()) return true
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
