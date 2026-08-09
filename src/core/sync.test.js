/**
 * sync.test.js
 *
 * Tests for the outbox drain, failure handling, and shape mapping in sync.js.
 * Both supabase.js and storage.js are mocked (pattern per calibration.test.js)
 * so no network or localStorage is involved.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./supabase.js', () => ({
  getClient:  vi.fn(),
  getUserId:  vi.fn(() => Promise.resolve('user-123')),
}))

vi.mock('./storage.js', () => ({
  loadOutbox:          vi.fn(() => []),
  removeOp:            vi.fn(),
  setOutboxListener:   vi.fn(),
  loadSessions:        vi.fn(() => []),
  getPatient:          vi.fn(() => null),
  setSessionFramePath: vi.fn(),
  enqueueOp:           vi.fn(),
  mergeRemotePatients: vi.fn(),
  mergeRemoteSessions: vi.fn(),
}))

vi.mock('./imageStore.js', () => ({
  getImage:      vi.fn(() => Promise.resolve(null)),
  markUploaded:  vi.fn(() => Promise.resolve(true)),
  enforceBudget: vi.fn(() => Promise.resolve(0)),
}))

import { getClient, getUserId } from './supabase.js'
import * as storage from './storage.js'
import * as imageStore from './imageStore.js'
import {
  processOutbox, pullAll,
  sessionToRow, rowToSession, patientToRow, rowToPatient,
} from './sync.js'
import { generateId } from './id.js'

// ─── Fake supabase client ────────────────────────────────────────────────────

function fakeClient({ upsert, del, select, upload, removeObj } = {}) {
  return {
    from: (table) => ({
      upsert: (row) => Promise.resolve(upsert ? upsert(table, row) : { error: null }),
      delete: () => ({
        eq: (col, val) => Promise.resolve(del ? del(table, col, val) : { error: null }),
      }),
      select: () => Promise.resolve(select ? select(table) : { data: [], error: null }),
    }),
    storage: {
      from: (bucket) => ({
        upload: (path, blob, opts) =>
          Promise.resolve(upload ? upload(bucket, path, blob, opts) : { error: null }),
        remove: (paths) =>
          Promise.resolve(removeObj ? removeObj(bucket, paths) : { data: [], error: null }),
      }),
    },
  }
}

function makeSession(overrides = {}) {
  return {
    id: generateId(),
    patient_id: generateId(),
    timestamp: 1700000000000,
    date: '2026-07-11',
    joint: 'knee', side: 'right', position: 'prone',
    min: 5, max: 120, rom: 115,
    duration_s: 30, samples: 300,
    angleTimeline: [5, 60, 120],
    angleMode: '3d', notes: 'hi', app_version: '0.1.0',
    updated_at: 1700000001000,
    peakFramePath: 'user-123/sess/peak.jpg',
    minFramePath:  'user-123/sess/min.jpg',
    // Legacy inline bytes — must never leak into a pushed row.
    peakFrame: 'data:image/jpeg;base64,xxxx',
    minFrame:  'data:image/jpeg;base64,yyyy',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('navigator', { onLine: true })
})

// ─── processOutbox ───────────────────────────────────────────────────────────

describe('processOutbox', () => {

  it('pushes a session upsert and removes the op on success', async () => {
    const session = makeSession()
    const pushed  = []
    storage.loadOutbox.mockReturnValue([{ id: 'op1', type: 'upsert_session', entity_id: session.id }])
    storage.loadSessions.mockReturnValue([session])
    getClient.mockReturnValue(fakeClient({
      upsert: (table, row) => { pushed.push({ table, row }); return { error: null } },
    }))

    await processOutbox()

    expect(pushed).toHaveLength(1)
    expect(pushed[0].table).toBe('sessions')
    expect(storage.removeOp).toHaveBeenCalledWith('op1')
  })

  it('maps camelCase to snake_case and strips frame images from the payload', async () => {
    const session = makeSession()
    let sent = null
    storage.loadOutbox.mockReturnValue([{ id: 'op1', type: 'upsert_session', entity_id: session.id }])
    storage.loadSessions.mockReturnValue([session])
    getClient.mockReturnValue(fakeClient({
      upsert: (_t, row) => { sent = row; return { error: null } },
    }))

    await processOutbox()

    expect(sent.measured_at).toBe(session.timestamp)
    expect(sent.angle_timeline).toEqual(session.angleTimeline)
    expect(sent.angle_mode).toBe('3d')
    expect(sent.updated_at).toBe(new Date(session.updated_at).toISOString())
    expect(sent).not.toHaveProperty('peakFrame')
    expect(sent).not.toHaveProperty('minFrame')
    expect(sent).not.toHaveProperty('angleTimeline')
    expect(sent).not.toHaveProperty('clinician_id')   // column default fills it
    // Only the lightweight cloud paths travel, not the bytes.
    expect(sent.peak_frame_path).toBe('user-123/sess/peak.jpg')
    expect(sent.min_frame_path).toBe('user-123/sess/min.jpg')
  })

  it('keeps the op and stops the drain on a network error', async () => {
    const a = makeSession()
    const b = makeSession()
    const attempts = []
    storage.loadOutbox.mockReturnValue([
      { id: 'op1', type: 'upsert_session', entity_id: a.id },
      { id: 'op2', type: 'upsert_session', entity_id: b.id },
    ])
    storage.loadSessions.mockReturnValue([a, b])
    getClient.mockReturnValue(fakeClient({
      upsert: (_t, row) => {
        attempts.push(row.id)
        return { error: { message: 'TypeError: Failed to fetch' } }   // no code = never reached server
      },
    }))

    await processOutbox()

    expect(attempts).toEqual([a.id])            // drain stopped at the first failure
    expect(storage.removeOp).not.toHaveBeenCalled()
  })

  it('drops the op (id-only warning) on a permanent server rejection', async () => {
    const session = makeSession()
    storage.loadOutbox.mockReturnValue([{ id: 'op1', type: 'upsert_session', entity_id: session.id }])
    storage.loadSessions.mockReturnValue([session])
    getClient.mockReturnValue(fakeClient({
      upsert: () => ({ error: { code: '42501', message: 'RLS violation' } }),
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await processOutbox()

    expect(storage.removeOp).toHaveBeenCalledWith('op1')
    // PHI hygiene: the warning must not contain record contents
    expect(warn.mock.calls.flat().join(' ')).not.toContain('hi')
    warn.mockRestore()
  })

  it('skips legacy non-UUID ids without pushing', async () => {
    let pushes = 0
    storage.loadOutbox.mockReturnValue([{ id: 'op1', type: 'upsert_session', entity_id: 'sess_1700000000000' }])
    getClient.mockReturnValue(fakeClient({ upsert: () => { pushes++; return { error: null } } }))

    await processOutbox()

    expect(pushes).toBe(0)
    expect(storage.removeOp).toHaveBeenCalledWith('op1')
  })

  it('removes the op when the entity was deleted locally since queueing', async () => {
    storage.loadOutbox.mockReturnValue([{ id: 'op1', type: 'upsert_patient', entity_id: generateId() }])
    storage.getPatient.mockReturnValue(null)
    getClient.mockReturnValue(fakeClient())

    await processOutbox()

    expect(storage.removeOp).toHaveBeenCalledWith('op1')
  })

  it('pushes deletes with the entity id', async () => {
    const id = generateId()
    let deleted = null
    storage.loadOutbox.mockReturnValue([{ id: 'op1', type: 'delete_session', entity_id: id }])
    getClient.mockReturnValue(fakeClient({
      del: (table, col, val) => { deleted = { table, col, val }; return { error: null } },
    }))

    await processOutbox()

    expect(deleted).toEqual({ table: 'sessions', col: 'id', val: id })
    expect(storage.removeOp).toHaveBeenCalledWith('op1')
  })

  it('removes cloud snapshots alongside a session delete (PHI hygiene)', async () => {
    const id = generateId()
    let removedPaths = null
    storage.loadOutbox.mockReturnValue([{ id: 'op1', type: 'delete_session', entity_id: id }])
    getClient.mockReturnValue(fakeClient({
      removeObj: (_bucket, paths) => { removedPaths = paths; return { data: [], error: null } },
    }))

    await processOutbox()

    expect(removedPaths).toEqual([`user-123/${id}/peak.jpg`, `user-123/${id}/min.jpg`])
    expect(storage.removeOp).toHaveBeenCalledWith('op1')
  })
})

// ─── upload_image ────────────────────────────────────────────────────────────

describe('upload_image op', () => {

  it('uploads the blob, records the path, marks uploaded, and queues a session upsert', async () => {
    const id = generateId()
    const blob = new Blob(['jpegbytes'], { type: 'image/jpeg' })
    let uploaded = null
    storage.loadOutbox.mockReturnValue([{ id: 'op1', type: 'upload_image', entity_id: `${id}:peak` }])
    imageStore.getImage.mockResolvedValue(blob)
    getClient.mockReturnValue(fakeClient({
      upload: (bucket, path, b, opts) => { uploaded = { bucket, path, b, opts }; return { error: null } },
    }))

    await processOutbox()

    expect(uploaded.bucket).toBe('session-images')
    expect(uploaded.path).toBe(`user-123/${id}/peak.jpg`)
    expect(uploaded.opts).toMatchObject({ upsert: true, contentType: 'image/jpeg' })
    expect(storage.setSessionFramePath).toHaveBeenCalledWith(id, 'peak', `user-123/${id}/peak.jpg`)
    expect(imageStore.markUploaded).toHaveBeenCalledWith(id, 'peak')
    expect(storage.enqueueOp).toHaveBeenCalledWith({ type: 'upsert_session', entity_id: id })
    expect(imageStore.enforceBudget).toHaveBeenCalled()
    expect(storage.removeOp).toHaveBeenCalledWith('op1')
  })

  it('drops the op when the blob is gone (evicted or session deleted)', async () => {
    const id = generateId()
    storage.loadOutbox.mockReturnValue([{ id: 'op1', type: 'upload_image', entity_id: `${id}:min` }])
    imageStore.getImage.mockResolvedValue(null)
    getClient.mockReturnValue(fakeClient())

    await processOutbox()

    expect(storage.setSessionFramePath).not.toHaveBeenCalled()
    expect(storage.removeOp).toHaveBeenCalledWith('op1')   // missing → drop, don't retry forever
  })

  it('keeps the op and stops the drain on an upload network error', async () => {
    const id = generateId()
    storage.loadOutbox.mockReturnValue([{ id: 'op1', type: 'upload_image', entity_id: `${id}:peak` }])
    imageStore.getImage.mockResolvedValue(new Blob(['x']))
    getClient.mockReturnValue(fakeClient({
      upload: () => ({ error: { message: 'TypeError: Failed to fetch' } }),
    }))

    await processOutbox()

    expect(storage.removeOp).not.toHaveBeenCalled()
    expect(imageStore.markUploaded).not.toHaveBeenCalled()
  })

  it('validates the sessionId portion — legacy non-UUID session ids are skipped', async () => {
    storage.loadOutbox.mockReturnValue([{ id: 'op1', type: 'upload_image', entity_id: 'sess_1700000000000:peak' }])
    let uploads = 0
    getClient.mockReturnValue(fakeClient({ upload: () => { uploads++; return { error: null } } }))

    await processOutbox()

    expect(uploads).toBe(0)
    expect(storage.removeOp).toHaveBeenCalledWith('op1')
  })
})

// ─── pullAll ─────────────────────────────────────────────────────────────────

describe('pullAll', () => {

  it('maps pulled rows to the client shape and merges them', async () => {
    const patientId = generateId()
    const sessionId = generateId()
    getClient.mockReturnValue(fakeClient({
      select: (table) => table === 'patients'
        ? { data: [{ id: patientId, name: 'Jane', surgery_date: '2026-01-05', affected_side: 'left', archived: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }], error: null }
        : { data: [{ id: sessionId, patient_id: patientId, measured_at: '1700000000000', date: '2026-07-11', joint: 'knee', side: 'right', angle_timeline: [1, 2], updated_at: '2026-01-02T00:00:00Z' }], error: null },
    }))

    await pullAll()

    const patients = storage.mergeRemotePatients.mock.calls[0][0]
    expect(patients[0]).toMatchObject({ id: patientId, name: 'Jane', surgeryDate: '2026-01-05', affectedSide: 'left' })

    const sessions = storage.mergeRemoteSessions.mock.calls[0][0]
    expect(sessions[0]).toMatchObject({ id: sessionId, patient_id: patientId, timestamp: 1700000000000, angleTimeline: [1, 2] })
    expect(sessions[0].updated_at).toBe(Date.parse('2026-01-02T00:00:00Z'))
  })

  it('does not merge anything when the pull errors', async () => {
    getClient.mockReturnValue(fakeClient({
      select: () => ({ data: null, error: { code: '500', message: 'boom' } }),
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await pullAll()

    expect(storage.mergeRemotePatients).not.toHaveBeenCalled()
    expect(storage.mergeRemoteSessions).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

// ─── Shape mapping round-trips ───────────────────────────────────────────────

describe('shape mapping', () => {

  it('session survives a client → row → client round trip', () => {
    const session = makeSession()
    const back = rowToSession({
      ...sessionToRow(session),
      created_at: new Date().toISOString(),
    })
    expect(back.id).toBe(session.id)
    expect(back.timestamp).toBe(session.timestamp)
    expect(back.angleTimeline).toEqual(session.angleTimeline)
    expect(back.notes).toBe(session.notes)
    expect(back.updated_at).toBe(session.updated_at)
    expect(back).not.toHaveProperty('peakFrame')
    expect(back.peakFramePath).toBe(session.peakFramePath)
    expect(back.minFramePath).toBe(session.minFramePath)
  })

  it('patient survives a client → row → client round trip', () => {
    const patient = {
      id: generateId(), name: 'Jane S.', dob: '1980-04-02', mrn: 'MRN-1',
      diagnosis: 'TKA', surgeryDate: '2026-06-01', affectedSide: 'right',
      notes: 'n', archived: false, created_at: 1700000000000, updated_at: 1700000001000,
    }
    const back = rowToPatient({
      ...patientToRow(patient),
      created_at: new Date(patient.created_at).toISOString(),
    })
    expect(back).toMatchObject({
      id: patient.id, name: 'Jane S.', dob: '1980-04-02', mrn: 'MRN-1',
      diagnosis: 'TKA', surgeryDate: '2026-06-01', affectedSide: 'right',
    })
    expect(back.updated_at).toBe(patient.updated_at)
  })

  it('pushes the face-redaction stamp', () => {
    const row = sessionToRow({ ...makeSession(), faceRedaction: 'blur1' })
    expect(row.face_redaction).toBe('blur1')
  })

  it('pushes null when a session predates redaction', () => {
    const row = sessionToRow(makeSession())
    expect(row.face_redaction).toBeNull()
  })

  it('round-trips the stamp so a pull cannot erase it', () => {
    const original = { ...makeSession(), faceRedaction: 'solid1' }
    const back     = rowToSession(sessionToRow(original))
    expect(back.faceRedaction).toBe('solid1')
  })

  // ─── Angle provenance ────────────────────────────────────────────────
  //
  // These say how a session's numbers were produced, and a session missing
  // them has to be treated as suspect: without `angleFilter` the old moving
  // average clipped its peaks (its `rom` is not comparable with a 'euro1'
  // session's — the difference looks like patient progress but is the filter),
  // and without `angleConvention` the shoulder values are on an inverted scale
  // and the ankle values offset by 90°.
  //
  // Only `angle_mode` was mapped originally, so a cloud pull silently stripped
  // the other two and a round-tripped session came back looking like a
  // pre-fix recording. Each direction is pinned separately below because a
  // half-fix — pushing but not reading, or the reverse — still loses the stamp.

  it('pushes all three angle-provenance stamps, not just angle_mode', () => {
    const row = sessionToRow({
      ...makeSession(), angleMode: '3d', angleFilter: 'euro1', angleConvention: 'perjoint1',
    })
    expect(row.angle_mode).toBe('3d')
    expect(row.angle_filter).toBe('euro1')
    expect(row.angle_convention).toBe('perjoint1')
  })

  it('pushes null for stamps a legacy session never had', () => {
    const { angleMode, ...legacy } = makeSession()
    const row = sessionToRow(legacy)
    expect(row.angle_mode).toBeNull()
    expect(row.angle_filter).toBeNull()
    expect(row.angle_convention).toBeNull()
  })

  it('reads all three stamps back off a row', () => {
    const back = rowToSession({
      id: 'x', patient_id: 'p', measured_at: 1, date: '2026-07-11',
      angle_mode: '3d', angle_filter: 'euro1', angle_convention: 'perjoint1',
      updated_at: new Date(0).toISOString(),
    })
    expect(back.angleMode).toBe('3d')
    expect(back.angleFilter).toBe('euro1')
    expect(back.angleConvention).toBe('perjoint1')
  })

  it('leaves absent stamps undefined rather than null, so pre-stamp sessions stay detectable', () => {
    const back = rowToSession({
      id: 'x', patient_id: 'p', measured_at: 1, date: '2026-07-11',
      updated_at: new Date(0).toISOString(),
    })
    expect(back.angleFilter).toBeUndefined()
    expect(back.angleConvention).toBeUndefined()
  })

  it('round-trips angle provenance so a pull cannot downgrade a good session', () => {
    // THE REGRESSION THIS FILE EXISTS TO PIN. Before the fix this returned
    // undefined for both, turning a session whose numbers are trustworthy into
    // one that reads as unrecoverable.
    const original = {
      ...makeSession(), angleMode: '3d', angleFilter: 'euro1', angleConvention: 'perjoint1',
    }
    const back = rowToSession(sessionToRow(original))
    expect(back.angleFilter).toBe('euro1')
    expect(back.angleConvention).toBe('perjoint1')
  })
})
