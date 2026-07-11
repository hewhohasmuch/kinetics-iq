/**
 * storage.js
 *
 * Thin wrapper around localStorage — the ONLY module that touches it.
 *
 * LOCAL-FIRST DESIGN:
 * localStorage remains the source of truth on the device. Views read and
 * write through this module exactly as before cloud sync existed. Every
 * mutation also appends an op to the outbox (another localStorage key);
 * sync.js drains that outbox to Supabase when online and merges remote
 * rows back in via the mergeRemote* helpers. This module never imports
 * supabase.js — sync registers a listener to hear about new ops instead —
 * so there is no circular dependency and no network I/O here.
 *
 * STORAGE KEYS:
 *   'rom_sessions'  — array of Session objects
 *   'rom_settings'  — app settings object
 *   'rom_patients'  — array of Patient objects (cache of the cloud table)
 *   'rom_outbox'    — array of pending sync ops, oldest first
 *
 * PATIENT SHAPE:
 *   { id, name, dob, mrn, diagnosis, surgeryDate, affectedSide, notes,
 *     archived, created_at, updated_at }         (timestamps are epoch ms)
 *
 * OUTBOX OP SHAPE:
 *   { id, type: 'upsert_session'|'delete_session'|'upsert_patient',
 *     entity_id, queued_at }
 *   Payloads are NOT stored in the op — sync reads the entity fresh from
 *   the local cache at push time, so N edits collapse into one upsert.
 *
 * CONFLICTS: last-write-wins by updated_at (epoch ms). Entities with a
 * pending outbox op are skipped during merge so unsynced local edits win
 * until they have been pushed.
 */

import { generateId } from './id.js'

const KEYS = {
  SESSIONS: 'rom_sessions',
  SETTINGS: 'rom_settings',
  PATIENTS: 'rom_patients',
  OUTBOX:   'rom_outbox',
}

// sync.js registers a callback here to kick a push after each mutation.
let _onOutboxChange = null

// ─── Sessions ─────────────────────────────────────────────────────────────────

/**
 * Load saved sessions, sorted newest first.
 * Returns empty array if none exist or on any error.
 *
 * @param {string} [patientId] - when given, only that patient's sessions
 * @returns {Session[]}
 */
export function loadSessions(patientId) {
  try {
    const raw = localStorage.getItem(KEYS.SESSIONS)
    if (!raw) return []
    let sessions = JSON.parse(raw)
    if (patientId) sessions = sessions.filter(s => s.patient_id === patientId)
    // Sort newest first for display
    return sessions.sort((a, b) => b.timestamp - a.timestamp)
  } catch (e) {
    console.error('Failed to load sessions:', e)
    return []
  }
}

/**
 * Save a new session. Appends to existing sessions and queues a cloud push.
 * Silently fails if localStorage is unavailable (e.g. private browsing).
 *
 * @param {Session} session - from SessionRecorder.stop()
 * @returns {boolean} true if saved successfully
 */
export function saveSession(session) {
  try {
    const stamped  = { ...session, updated_at: Date.now() }
    const existing = loadSessions().filter(s => s.id !== stamped.id)
    // Prepend so newest is first in the array too (consistent with loadSessions sort)
    const updated = [stamped, ...existing]
    localStorage.setItem(KEYS.SESSIONS, JSON.stringify(updated))
    enqueueOp({ type: 'upsert_session', entity_id: stamped.id })
    return true
  } catch (e) {
    console.error('Failed to save session:', e)
    return false
  }
}

/**
 * Delete a session by ID (locally and, via the outbox, in the cloud).
 *
 * @param {string} sessionId - session.id from the session object
 * @returns {boolean} true if deleted
 */
export function deleteSession(sessionId) {
  try {
    const sessions = loadSessions()
    const filtered = sessions.filter(s => s.id !== sessionId)
    localStorage.setItem(KEYS.SESSIONS, JSON.stringify(filtered))
    enqueueOp({ type: 'delete_session', entity_id: sessionId })
    return true
  } catch (e) {
    console.error('Failed to delete session:', e)
    return false
  }
}

/**
 * Clear ALL sessions locally. Used for testing / reset / sign-out.
 * Does not queue cloud deletes — cloud data is untouched.
 */
export function clearSessions() {
  try {
    localStorage.removeItem(KEYS.SESSIONS)
    return true
  } catch (e) {
    return false
  }
}

// ─── Patients ─────────────────────────────────────────────────────────────────

/**
 * Load patient records, sorted by name.
 *
 * @param {boolean} [includeArchived=false]
 * @returns {Patient[]}
 */
export function loadPatients(includeArchived = false) {
  try {
    const raw = localStorage.getItem(KEYS.PATIENTS)
    if (!raw) return []
    let patients = JSON.parse(raw)
    if (!includeArchived) patients = patients.filter(p => !p.archived)
    return patients.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  } catch (e) {
    console.error('Failed to load patients:', e)
    return []
  }
}

/**
 * Look up one patient by id (archived included). Returns null if absent.
 */
export function getPatient(id) {
  if (!id) return null
  return loadPatients(true).find(p => p.id === id) ?? null
}

/**
 * Create or update a patient record and queue a cloud push.
 * Assigns an id and created_at on first save; stamps updated_at always.
 *
 * @param {Partial<Patient>} patient - must include name for new records
 * @returns {Patient|null} the stored record, or null on failure
 */
export function upsertPatient(patient) {
  try {
    const now    = Date.now()
    const record = {
      dob: null, mrn: '', diagnosis: '', surgeryDate: null,
      affectedSide: null, notes: '', archived: false,
      ...patient,
      id:         patient.id || generateId(),
      created_at: patient.created_at ?? now,
      updated_at: now,
    }
    const others = loadPatients(true).filter(p => p.id !== record.id)
    localStorage.setItem(KEYS.PATIENTS, JSON.stringify([...others, record]))
    enqueueOp({ type: 'upsert_patient', entity_id: record.id })
    return record
  } catch (e) {
    console.error('Failed to save patient:', e)
    return null
  }
}

/**
 * Archive (soft-delete) a patient. The record and its sessions stay in the
 * cloud; the patient just disappears from the default list.
 */
export function archivePatient(id) {
  const patient = getPatient(id)
  if (!patient) return false
  const archived = upsertPatient({ ...patient, archived: true })
  if (archived && getActivePatientId() === id) setActivePatientId(null)
  return Boolean(archived)
}

// ─── Active patient ───────────────────────────────────────────────────────────

/** @returns {string|null} */
export function getActivePatientId() {
  return loadSettings().active_patient_id ?? null
}

/**
 * Set the active patient. Changing patient also clears the calibration
 * offset — the "zero" captured for one person's setup doesn't transfer to
 * another (same rule as switching joint/side in MeasureView).
 */
export function setActivePatientId(id) {
  const current = getActivePatientId()
  if (current === (id ?? null)) return true
  return saveSettings({ active_patient_id: id ?? null, calibration_offset: 0 })
}

// ─── Outbox (pending sync ops) ────────────────────────────────────────────────

/** @returns {Op[]} pending ops, oldest first */
export function loadOutbox() {
  try {
    const raw = localStorage.getItem(KEYS.OUTBOX)
    return raw ? JSON.parse(raw) : []
  } catch (e) {
    return []
  }
}

/**
 * Queue a sync op. Deduped: one pending op per entity+type, and a delete
 * supersedes any pending upsert for the same entity (no point pushing a
 * record we are about to delete).
 *
 * @param {{type: string, entity_id: string}} op
 */
export function enqueueOp(op) {
  try {
    let outbox = loadOutbox().filter(o => !(o.entity_id === op.entity_id && o.type === op.type))
    if (op.type.startsWith('delete_')) {
      const upsertType = op.type.replace('delete_', 'upsert_')
      outbox = outbox.filter(o => !(o.entity_id === op.entity_id && o.type === upsertType))
    }
    outbox.push({ ...op, id: generateId(), queued_at: Date.now() })
    localStorage.setItem(KEYS.OUTBOX, JSON.stringify(outbox))
    if (_onOutboxChange) _onOutboxChange()
    return true
  } catch (e) {
    console.error('Failed to enqueue sync op:', e)
    return false
  }
}

/** Remove a completed (or permanently failed) op from the outbox. */
export function removeOp(opId) {
  try {
    const outbox = loadOutbox().filter(o => o.id !== opId)
    localStorage.setItem(KEYS.OUTBOX, JSON.stringify(outbox))
    return true
  } catch (e) {
    return false
  }
}

/**
 * Register the single listener called after each enqueue (sync.js uses this
 * to push soon after a save). Returns an unregister function.
 */
export function setOutboxListener(callback) {
  _onOutboxChange = callback
  return () => { if (_onOutboxChange === callback) _onOutboxChange = null }
}

// ─── Remote merge (called by sync.js after a pull) ────────────────────────────

function _hasPendingOp(outbox, entityId) {
  return outbox.some(o => o.entity_id === entityId)
}

/**
 * Merge pulled patient records (already mapped to the client shape) into the
 * local cache. Last-write-wins by updated_at; entities with a pending outbox
 * op keep their local version until it has been pushed. Additive — records
 * that only exist locally are never removed here.
 */
export function mergeRemotePatients(rows) {
  try {
    const outbox = loadOutbox()
    const local  = loadPatients(true)
    const byId   = new Map(local.map(p => [p.id, p]))
    for (const row of rows) {
      if (_hasPendingOp(outbox, row.id)) continue
      const existing = byId.get(row.id)
      if (!existing || (row.updated_at ?? 0) > (existing.updated_at ?? 0)) {
        byId.set(row.id, row)
      }
    }
    localStorage.setItem(KEYS.PATIENTS, JSON.stringify([...byId.values()]))
    return true
  } catch (e) {
    console.error('Failed to merge remote patients:', e)
    return false
  }
}

/**
 * Merge pulled sessions (client shape) into the local cache.
 * Same LWW + pending-op rules as mergeRemotePatients.
 */
export function mergeRemoteSessions(rows) {
  try {
    const outbox = loadOutbox()
    const local  = loadSessions()
    const byId   = new Map(local.map(s => [s.id, s]))
    for (const row of rows) {
      if (_hasPendingOp(outbox, row.id)) continue
      const existing = byId.get(row.id)
      if (!existing || (row.updated_at ?? 0) > (existing.updated_at ?? 0)) {
        byId.set(row.id, row)
      }
    }
    localStorage.setItem(KEYS.SESSIONS, JSON.stringify([...byId.values()]))
    return true
  } catch (e) {
    console.error('Failed to merge remote sessions:', e)
    return false
  }
}

// ─── Sign-out wipe ────────────────────────────────────────────────────────────

/**
 * Remove all patient data from the device (sessions, patients, pending ops,
 * active patient). Called on sign-out so the next clinician on a shared
 * device can't read the previous one's records. Cloud data is untouched.
 */
export function clearAllLocalData() {
  try {
    localStorage.removeItem(KEYS.SESSIONS)
    localStorage.removeItem(KEYS.PATIENTS)
    localStorage.removeItem(KEYS.OUTBOX)
    saveSettings({ active_patient_id: null, calibration_offset: 0 })
    return true
  } catch (e) {
    return false
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  calibration_offset: 0,
  // Bumped when the angle math changes in a way that invalidates a stored
  // calibration offset (e.g. the 2D → 3D switch). CalibrationManager clears the
  // offset once when it sees an older version. Absent/0 = pre-3D (2D era).
  calibration_version: 0,
  smoothing_window:   5,
  sample_rate_hz:     10,
  marker_ids: {
    proximal: 0,
    joint:    1,
    distal:   2,
  },
  active_patient_id: null,
}

/**
 * Load app settings, merging with defaults for any missing keys.
 * Safe to call even if no settings have been saved yet.
 *
 * @returns {Settings}
 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEYS.SETTINGS)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch (e) {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * Save settings. Merges with existing settings (partial update safe).
 *
 * @param {Partial<Settings>} updates
 */
export function saveSettings(updates) {
  try {
    const current = loadSettings()
    const merged  = { ...current, ...updates }
    localStorage.setItem(KEYS.SETTINGS, JSON.stringify(merged))
    return true
  } catch (e) {
    console.error('Failed to save settings:', e)
    return false
  }
}
