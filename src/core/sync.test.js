/**
 * sync.test.js
 *
 * Tests for the outbox drain, failure handling, and shape mapping in sync.js.
 * Both supabase.js and storage.js are mocked (pattern per calibration.test.js)
 * so no network or localStorage is involved.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./supabase.js', () => ({
  getClient: vi.fn(),
}))

vi.mock('./storage.js', () => ({
  loadOutbox:          vi.fn(() => []),
  removeOp:            vi.fn(),
  setOutboxListener:   vi.fn(),
  loadSessions:        vi.fn(() => []),
  getPatient:          vi.fn(() => null),
  mergeRemotePatients: vi.fn(),
  mergeRemoteSessions: vi.fn(),
}))

import { getClient } from './supabase.js'
import * as storage from './storage.js'
import {
  processOutbox, pullAll,
  sessionToRow, rowToSession, patientToRow, rowToPatient,
} from './sync.js'
import { generateId } from './id.js'

// ─── Fake supabase client ────────────────────────────────────────────────────

function fakeClient({ upsert, del, select } = {}) {
  return {
    from: (table) => ({
      upsert: (row) => Promise.resolve(upsert ? upsert(table, row) : { error: null }),
      delete: () => ({
        eq: (col, val) => Promise.resolve(del ? del(table, col, val) : { error: null }),
      }),
      select: () => Promise.resolve(select ? select(table) : { data: [], error: null }),
    }),
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
})
