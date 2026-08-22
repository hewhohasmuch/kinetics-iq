/**
 * storage.test.js
 *
 * Tests for the patient/outbox/merge logic in storage.js. The original thin
 * JSON wrappers (loadSessions/saveSettings/…) were deliberately untested;
 * the sync outbox and LWW merge are real logic, so they get coverage.
 *
 * Uses an in-memory localStorage stub (same pattern as calibration.test.js).
 */

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadSessions, saveSession, deleteSession,
  loadPatients, getPatient, upsertPatient, archivePatient,
  getActivePatientId, setActivePatientId,
  loadOutbox, enqueueOp, removeOp, setOutboxListener,
  mergeRemoteSessions, mergeRemotePatients,
  clearAllLocalData, loadSettings,
  migrateInlineImages, setSessionFramePath, setSessionVerification, getDeviceId,
} from './storage.js'
import * as imageStore from './imageStore.js'
import { generateId } from './id.js'

// ─── localStorage stub ───────────────────────────────────────────────────────

let store = {}
global.localStorage = {
  getItem:    (k) => store[k] ?? null,
  setItem:    (k, v) => { store[k] = v },
  removeItem: (k) => { delete store[k] },
}

beforeEach(() => {
  store = {}
  setOutboxListener(null)
})

function makeSession(overrides = {}) {
  return {
    id: generateId(),
    timestamp: Date.now(),
    date: '2026-07-11',
    joint: 'knee', side: 'right', position: 'prone',
    min: 5, max: 120, rom: 115,
    duration_s: 30, samples: 300,
    angleTimeline: [5, 60, 120],
    angleMode: '2d2', notes: '', app_version: '0.1.0',
    patient_id: generateId(),
    ...overrides,
  }
}

// ─── Sessions + outbox ───────────────────────────────────────────────────────

describe('saveSession / deleteSession outbox behavior', () => {

  it('stamps updated_at and enqueues an upsert op', () => {
    const session = makeSession()
    saveSession(session)

    const stored = loadSessions()[0]
    expect(stored.updated_at).toBeTypeOf('number')

    const outbox = loadOutbox()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].type).toBe('upsert_session')
    expect(outbox[0].entity_id).toBe(session.id)
  })

  it('re-saving the same session dedupes to one pending op and one record', () => {
    const session = makeSession()
    saveSession(session)
    saveSession({ ...session, notes: 'edited' })

    expect(loadSessions()).toHaveLength(1)
    expect(loadSessions()[0].notes).toBe('edited')
    expect(loadOutbox()).toHaveLength(1)
  })

  it('delete supersedes a pending upsert for the same session', () => {
    const session = makeSession()
    saveSession(session)
    deleteSession(session.id)

    expect(loadSessions()).toHaveLength(0)
    const outbox = loadOutbox()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].type).toBe('delete_session')
  })

  it('notifies the outbox listener on enqueue', () => {
    let calls = 0
    setOutboxListener(() => { calls++ })
    saveSession(makeSession())
    expect(calls).toBe(1)
  })

  it('removeOp drops exactly the given op', () => {
    saveSession(makeSession())
    saveSession(makeSession())
    const [first, second] = loadOutbox()
    removeOp(first.id)
    expect(loadOutbox().map(o => o.id)).toEqual([second.id])
  })
})

describe('loadSessions(patientId)', () => {

  it('filters to the given patient, newest first', () => {
    const patientA = generateId()
    const patientB = generateId()
    saveSession(makeSession({ patient_id: patientA, timestamp: 1000 }))
    saveSession(makeSession({ patient_id: patientB, timestamp: 2000 }))
    saveSession(makeSession({ patient_id: patientA, timestamp: 3000 }))

    const forA = loadSessions(patientA)
    expect(forA).toHaveLength(2)
    expect(forA.map(s => s.timestamp)).toEqual([3000, 1000])
  })

  it('returns all sessions when no patientId given', () => {
    saveSession(makeSession())
    saveSession(makeSession({ patient_id: undefined }))
    expect(loadSessions()).toHaveLength(2)
  })
})

// ─── Patients ────────────────────────────────────────────────────────────────

describe('patients', () => {

  it('upsertPatient assigns id/timestamps and enqueues an op', () => {
    const patient = upsertPatient({ name: 'Jane S.' })
    expect(patient.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(patient.created_at).toBeTypeOf('number')
    expect(patient.updated_at).toBeTypeOf('number')

    expect(getPatient(patient.id).name).toBe('Jane S.')
    expect(loadOutbox()[0]).toMatchObject({ type: 'upsert_patient', entity_id: patient.id })
  })

  it('loadPatients sorts by name and hides archived by default', () => {
    upsertPatient({ name: 'Zoe' })
    upsertPatient({ name: 'Adam' })
    const archived = upsertPatient({ name: 'Middle' })
    archivePatient(archived.id)

    expect(loadPatients().map(p => p.name)).toEqual(['Adam', 'Zoe'])
    expect(loadPatients(true).map(p => p.name)).toEqual(['Adam', 'Middle', 'Zoe'])
  })

  it('archiving the active patient clears the active selection', () => {
    const patient = upsertPatient({ name: 'Jane' })
    setActivePatientId(patient.id)
    archivePatient(patient.id)
    expect(getActivePatientId()).toBeNull()
  })

  it('update keeps id and created_at, bumps updated_at', () => {
    const patient = upsertPatient({ name: 'Jane' })
    const updated = upsertPatient({ ...patient, diagnosis: 'ACL repair', updated_at: 0 })
    expect(updated.id).toBe(patient.id)
    expect(updated.created_at).toBe(patient.created_at)
    expect(updated.updated_at).toBeGreaterThanOrEqual(patient.updated_at)
    expect(loadPatients(true)).toHaveLength(1)
  })
})

// ─── Active patient + calibration coupling ───────────────────────────────────

describe('setActivePatientId', () => {

  it('clears the calibration offset when the patient changes', () => {
    localStorage.setItem('rom_settings', JSON.stringify({ calibration_offset: 12.5 }))
    setActivePatientId(generateId())
    expect(loadSettings().calibration_offset).toBe(0)
  })

  it('does not touch calibration when re-selecting the same patient', () => {
    const id = generateId()
    setActivePatientId(id)
    localStorage.setItem('rom_settings', JSON.stringify({ active_patient_id: id, calibration_offset: 12.5 }))
    setActivePatientId(id)
    expect(loadSettings().calibration_offset).toBe(12.5)
  })

  it('round-trips through getActivePatientId', () => {
    const id = generateId()
    setActivePatientId(id)
    expect(getActivePatientId()).toBe(id)
    setActivePatientId(null)
    expect(getActivePatientId()).toBeNull()
  })
})

// ─── Remote merge (LWW) ──────────────────────────────────────────────────────

describe('mergeRemoteSessions / mergeRemotePatients', () => {

  it('adds unseen remote sessions and keeps newer local ones', () => {
    const local = makeSession({ updated_at: 5000 })
    saveSession(local)                     // enqueues an op…
    removeOp(loadOutbox()[0].id)           // …simulate it already pushed

    const staleRemote = { ...local, notes: 'stale cloud copy', updated_at: 1 }
    const newRemote   = makeSession({ updated_at: 2000 })
    mergeRemoteSessions([staleRemote, newRemote])

    const sessions = loadSessions()
    expect(sessions).toHaveLength(2)
    expect(sessions.find(s => s.id === local.id).notes).toBe('')   // local won
  })

  it('remote wins when strictly newer', () => {
    const local = makeSession()
    saveSession(local)
    removeOp(loadOutbox()[0].id)

    const newer = { ...loadSessions()[0], notes: 'from other device', updated_at: Date.now() + 10000 }
    mergeRemoteSessions([newer])
    expect(loadSessions()[0].notes).toBe('from other device')
  })

  it('skips entities with a pending outbox op (unsynced local edit wins)', () => {
    const local = makeSession()
    saveSession(local)   // op still pending

    const remote = { ...local, notes: 'cloud version', updated_at: Date.now() + 10000 }
    mergeRemoteSessions([remote])
    expect(loadSessions()[0].notes).toBe('')
  })

  it('merges patients with the same LWW rules', () => {
    const patient = upsertPatient({ name: 'Jane' })
    removeOp(loadOutbox()[0].id)

    mergeRemotePatients([{ ...patient, name: 'Jane Smith', updated_at: patient.updated_at + 1 }])
    expect(getPatient(patient.id).name).toBe('Jane Smith')
  })
})

// ─── Sign-out wipe ───────────────────────────────────────────────────────────

describe('clearAllLocalData', () => {

  it('removes sessions, patients, outbox, and the active patient', () => {
    const patient = upsertPatient({ name: 'Jane' })
    setActivePatientId(patient.id)
    saveSession(makeSession({ patient_id: patient.id }))

    clearAllLocalData()

    expect(loadSessions()).toHaveLength(0)
    expect(loadPatients(true)).toHaveLength(0)
    expect(loadOutbox()).toHaveLength(0)
    expect(getActivePatientId()).toBeNull()
  })
})

// ─── setSessionFramePath ─────────────────────────────────────────────────────

describe('setSessionFramePath', () => {
  it('records the cloud path on the matching session and bumps updated_at', () => {
    const s = saveSession(makeSession()) && loadSessions()[0]
    const before = loadSessions()[0].updated_at

    setSessionFramePath(s.id, 'peak', 'user/abc/peak.jpg')
    setSessionFramePath(s.id, 'min', 'user/abc/min.jpg')

    const after = loadSessions()[0]
    expect(after.peakFramePath).toBe('user/abc/peak.jpg')
    expect(after.minFramePath).toBe('user/abc/min.jpg')
    expect(after.updated_at).toBeGreaterThanOrEqual(before)
  })

  it('is a no-op for an unknown session id', () => {
    expect(setSessionFramePath('missing', 'peak', 'x')).toBe(false)
  })
})

// ─── migrateInlineImages ─────────────────────────────────────────────────────

describe('migrateInlineImages', () => {
  // A 1x1 JPEG data URL (smallest valid-ish base64 payload for the decoder).
  const DATA_URL = 'data:image/jpeg;base64,' + btoa('fake-jpeg-bytes')

  beforeEach(async () => { await imageStore.clearAll() })

  it('moves inline images to imageStore, queues uploads, and strips the fields', async () => {
    // Simulate a legacy session with inline base64 frames in localStorage.
    const legacy = { ...makeSession(), peakFrame: DATA_URL, minFrame: DATA_URL }
    localStorage.setItem('rom_sessions', JSON.stringify([legacy]))

    const migrated = await migrateInlineImages()

    expect(migrated).toBe(2)
    // Inline bytes gone from localStorage.
    const stored = loadSessions()[0]
    expect(stored).not.toHaveProperty('peakFrame')
    expect(stored).not.toHaveProperty('minFrame')
    // Blobs now in imageStore, queued for upload.
    expect(await imageStore.getImage(legacy.id, 'peak')).toBeInstanceOf(Blob)
    expect(await imageStore.listPending()).toHaveLength(2)
    expect(loadOutbox().filter(o => o.type === 'upload_image')).toHaveLength(2)
  })

  it('is idempotent — a second run finds nothing to migrate', async () => {
    const legacy = { ...makeSession(), peakFrame: DATA_URL }
    localStorage.setItem('rom_sessions', JSON.stringify([legacy]))

    expect(await migrateInlineImages()).toBe(1)
    expect(await migrateInlineImages()).toBe(0)
  })
})

// ─── Verification: an annotation layer, never a rewrite of history ───────────

describe('setSessionVerification', () => {

  const record = (angles = { min: 2.1, max: 127.3 }) => ({
    id: 'v1', at: 1700000002000, by: null, byMode: 'device', byDevice: 'dev-1',
    landmarks: { peak: { proximal: { x: 0.1, y: 0.2, kind: 'anatomical' } }, min: null },
    angles,
  })

  function seed(overrides = {}) {
    const s = makeSession({
      min: 9, max: 121.8, rom: 112.8,
      angleTimeline: [0, 40, 97, 121.8, 100, 9],
      landmarksRaw: { peak: { proximal: { x: 0.5, y: 0.5 } }, min: null },
      ...overrides,
    })
    saveSession(s)
    return s
  }

  it('stores the record as the single element of the array', () => {
    const s = seed()
    expect(setSessionVerification(s.id, record())).toBe(true)
    const saved = loadSessions().find(x => x.id === s.id)
    expect(saved.verifications).toHaveLength(1)
    expect(saved.verifications[0].angles).toEqual({ min: 2.1, max: 127.3 })
  })

  it('REPLACES rather than appends — latest-wins in the UI today', () => {
    const s = seed()
    setSessionVerification(s.id, record({ min: 1, max: 100 }))
    setSessionVerification(s.id, record({ min: 2, max: 110 }))
    const saved = loadSessions().find(x => x.id === s.id)
    expect(saved.verifications).toHaveLength(1)
    expect(saved.verifications[0].angles).toEqual({ min: 2, max: 110 })
  })

  it('reverts to an empty array, so the session reads as model-measured again', () => {
    const s = seed()
    setSessionVerification(s.id, record())
    expect(setSessionVerification(s.id, null)).toBe(true)
    expect(loadSessions().find(x => x.id === s.id).verifications).toEqual([])
  })

  it('NEVER alters the measurement or the raw evidence', () => {
    const s = seed()
    setSessionVerification(s.id, record({ min: 2.1, max: 92 }))
    const saved = loadSessions().find(x => x.id === s.id)

    expect(saved.min).toBe(9)
    expect(saved.max).toBe(121.8)
    expect(saved.rom).toBe(112.8)
    expect(saved.angleTimeline).toEqual([0, 40, 97, 121.8, 100, 9])
    // landmarksRaw is the baseline the research delta is measured against
    // forever; rewriting it would destroy the only reason to keep it.
    expect(saved.landmarksRaw).toEqual({ peak: { proximal: { x: 0.5, y: 0.5 } }, min: null })
  })

  it('leaves angleTimeline untouched even when the verified peak is lower', () => {
    const s = seed({ max: 100, angleTimeline: [0, 40, 97, 100, 88, 5] })
    setSessionVerification(s.id, record({ min: 5, max: 92 }))
    const saved = loadSessions().find(x => x.id === s.id)
    expect(Math.max(...saved.angleTimeline)).toBe(100)
    expect(saved.max).toBe(100)
  })

  it('queues a session upsert, deduped to one op for the session', () => {
    // enqueueOp dedupes per entity+type by design — the save and the
    // verification collapse into a single upsert that sync reads fresh at
    // push time. One write, one op.
    const s = seed()
    setSessionVerification(s.id, record())
    const ops = loadOutbox().filter(o => o.entity_id === s.id)
    expect(ops).toHaveLength(1)
    expect(ops[0].type).toBe('upsert_session')
  })

  it('bumps updated_at so the annotation wins the last-write-wins merge', () => {
    const s = seed({ updated_at: 1 })
    setSessionVerification(s.id, record())
    expect(loadSessions().find(x => x.id === s.id).updated_at).toBeGreaterThan(1)
  })

  it('returns false for an unknown session without throwing', () => {
    seed()
    expect(setSessionVerification(generateId(), record())).toBe(false)
  })

  it('THROWS if the stored array already holds more than one element', () => {
    // "Append-ready" is not permission to append now. Enabling history is a
    // deliberate change to this function and to every reader of the array.
    const s = seed({ verifications: [record(), record()] })
    expect(() => setSessionVerification(s.id, record())).toThrow(/single-element invariant/)
  })
})

describe('getDeviceId', () => {

  it('mints a uuid on first use and returns the same one after', () => {
    const first = getDeviceId()
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(getDeviceId()).toBe(first)
  })

  it('SURVIVES sign-out — it identifies a browser profile, not a person', () => {
    // Deliberate: it is what lets a verification made with no account be
    // attributed once an account signs in on this device. It must therefore
    // never be surfaced as identifying anyone.
    const before = getDeviceId()
    clearAllLocalData()
    expect(getDeviceId()).toBe(before)
  })
})
