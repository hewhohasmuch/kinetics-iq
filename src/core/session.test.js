/**
 * session.test.js
 *
 * Tests for SessionRecorder.
 * Storage tests are skipped here — localStorage doesn't exist in Node.
 * Storage logic is simple enough (JSON.parse/stringify + key names) that
 * manual testing in the browser is sufficient for the MVP.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SessionRecorder } from './session.js'

describe('SessionRecorder', () => {

  let recorder

  beforeEach(() => {
    recorder = new SessionRecorder()
  })

  // ─── Initial state ────────────────────────────────────────────────

  it('starts inactive', () => {
    expect(recorder.isActive).toBe(false)
    expect(recorder.sampleCount).toBe(0)
  })

  it('getLiveStats returns null when no samples', () => {
    recorder.start()
    expect(recorder.getLiveStats()).toBeNull()
  })

  // ─── Basic recording flow ─────────────────────────────────────────

  it('records samples and returns correct min/max/rom', () => {
    recorder.start()
    recorder.record(10)
    recorder.record(45)
    recorder.record(90)
    recorder.record(120)
    recorder.record(30)

    const session = recorder.stop()

    expect(session).not.toBeNull()
    expect(session.min).toBe(10)
    expect(session.max).toBe(120)
    expect(session.rom).toBe(110)
    expect(session.samples).toBe(5)
  })

  it('generates a session with required fields', () => {
    recorder.start()
    recorder.record(45)
    recorder.record(90)
    recorder.record(120)

    const session = recorder.stop()

    expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(session.timestamp).toBeTypeOf('number')
    expect(session.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(session.joint).toBe('knee')
    expect(session.side).toBe('right')
    expect(session.duration_s).toBeGreaterThanOrEqual(0)
    expect(session.app_version).toBe('0.1.0')
  })

  it('stamps the filter generation that produced the angles', () => {
    // Sessions recorded before the peak-clipping fix are systematically low.
    // Without this marker they would be compared against post-fix sessions as
    // if equivalent, showing improvement that is really just the filter change.
    recorder.start()
    recorder.record(45)

    expect(recorder.stop().angleFilter).toBe('euro1')
  })

  // ─── setContext ───────────────────────────────────────────────────

  it('setContext values appear in the session object', () => {
    recorder.setContext('elbow', 'left')
    recorder.start()
    recorder.record(45)
    const session = recorder.stop()
    expect(session.joint).toBe('elbow')
    expect(session.side).toBe('left')
  })

  it('defaults to knee/right when setContext not called', () => {
    recorder.start()
    recorder.record(45)
    const session = recorder.stop()
    expect(session.joint).toBe('knee')
    expect(session.side).toBe('right')
  })

  // ─── Edge cases ───────────────────────────────────────────────────

  it('ignores null samples (marker lost frames)', () => {
    recorder.start()
    recorder.record(45)
    recorder.record(null)
    recorder.record(null)
    recorder.record(90)
    recorder.record(60)   // third valid sample — stop() requires at least 3

    const session = recorder.stop()
    expect(session.samples).toBe(3)   // only non-null values counted
    expect(session.min).toBe(45)
    expect(session.max).toBe(90)
  })

  it('ignores NaN samples', () => {
    recorder.start()
    recorder.record(NaN)
    recorder.record(60)
    recorder.record(90)
    recorder.record(45)

    const session = recorder.stop()
    expect(session.samples).toBe(3)
  })

  it('returns null when stopped with zero samples', () => {
    recorder.start()
    // no samples recorded at all
    expect(recorder.stop()).toBeNull()
  })

  it('saves with just 1 sample', () => {
    recorder.start()
    recorder.record(45)
    const session = recorder.stop()
    expect(session).not.toBeNull()
    expect(session.samples).toBe(1)
    expect(session.rom).toBe(0)   // min === max when only one sample
  })

  it('returns null when stopped with zero samples', () => {
    recorder.start()
    expect(recorder.stop()).toBeNull()
  })

  it('does nothing when record() called before start()', () => {
    recorder.record(90)  // not active — should be silently ignored
    expect(recorder.sampleCount).toBe(0)
  })

  it('clears previous data on start()', () => {
    recorder.start()
    recorder.record(90)
    recorder.stop()

    // Start a new session
    recorder.start()
    recorder.record(45)
    recorder.record(60)
    recorder.record(75)
    const session = recorder.stop()

    // Should only have the 3 new samples, not the original 1
    expect(session.samples).toBe(3)
    expect(session.min).toBe(45)
  })

  it('stop() returns null if called when not active', () => {
    expect(recorder.stop()).toBeNull()
  })

  // ─── getLiveStats ─────────────────────────────────────────────────

  it('getLiveStats returns correct live min/max during recording', () => {
    recorder.start()
    recorder.record(30)

    let stats = recorder.getLiveStats()
    expect(stats.min).toBe(30)
    expect(stats.max).toBe(30)
    expect(stats.rom).toBe(0)

    recorder.record(90)
    stats = recorder.getLiveStats()
    expect(stats.min).toBe(30)
    expect(stats.max).toBe(90)
    expect(stats.rom).toBe(60)
  })

  // ─── angleTimeline ────────────────────────────────────────────────

  it('includes angleTimeline in session output', () => {
    recorder.start()
    recorder.record(10)
    recorder.record(45)
    recorder.record(90)
    recorder.record(120)

    const session = recorder.stop()
    expect(session.angleTimeline).toBeDefined()
    expect(session.angleTimeline).toHaveLength(4)
    expect(session.angleTimeline[0]).toBe(10)
    expect(session.angleTimeline[2]).toBe(90)
  })

  it('rounds angleTimeline values to 1 decimal place', () => {
    recorder.start()
    recorder.record(10.123)
    recorder.record(89.987)
    recorder.record(50.005)

    const session = recorder.stop()
    expect(session.angleTimeline[0]).toBe(10.1)
    expect(session.angleTimeline[1]).toBe(90)
    expect(session.angleTimeline[2]).toBe(50)
  })

  // ─── Rounding ─────────────────────────────────────────────────────

  it('rounds min/max/rom to 1 decimal place', () => {
    recorder.start()
    recorder.record(10.123)
    recorder.record(89.987)
    recorder.record(50)

    const session = recorder.stop()
    // 10.123 rounded to 1dp = 10.1
    expect(session.min).toBe(10.1)
    // 89.987 rounded to 1dp = 90.0
    expect(session.max).toBe(90)
    // rom = 90 - 10.1 = 79.9
    expect(session.rom).toBe(79.9)
  })

})

// ─── SessionRecorder.attachNotes ─────────────────────────────────────────────

describe('SessionRecorder.attachNotes()', () => {

  it('attaches a note to a session', () => {
    const recorder = new SessionRecorder()
    recorder.start()
    recorder.record(45)
    recorder.record(90)
    recorder.record(120)
    const session = recorder.stop()
    const withNote = SessionRecorder.attachNotes(session, 'day 14 post-op')
    expect(withNote.notes).toBe('day 14 post-op')
  })

  it('trims whitespace', () => {
    const recorder = new SessionRecorder()
    recorder.start()
    recorder.record(90)
    recorder.record(100)
    recorder.record(110)
    const session = recorder.stop()
    const withNote = SessionRecorder.attachNotes(session, '  after warm-up  ')
    expect(withNote.notes).toBe('after warm-up')
  })

  it('handles empty note', () => {
    const recorder = new SessionRecorder()
    recorder.start()
    recorder.record(90)
    recorder.record(100)
    recorder.record(110)
    const session = recorder.stop()
    const withNote = SessionRecorder.attachNotes(session, '')
    expect(withNote.notes).toBe('')
  })

  it('truncates notes to 200 characters', () => {
    const recorder = new SessionRecorder()
    recorder.start()
    recorder.record(90)
    recorder.record(100)
    recorder.record(110)
    const session  = recorder.stop()
    const longNote = 'x'.repeat(300)
    const withNote = SessionRecorder.attachNotes(session, longNote)
    expect(withNote.notes.length).toBe(200)
  })

  it('returns null when session is null', () => {
    expect(SessionRecorder.attachNotes(null, 'test')).toBeNull()
  })

  it('does not mutate original session', () => {
    const recorder = new SessionRecorder()
    recorder.start()
    recorder.record(90)
    recorder.record(100)
    recorder.record(110)
    const session  = recorder.stop()
    SessionRecorder.attachNotes(session, 'test note')
    expect(session.notes).toBe('')   // original unchanged
  })

})

// ─── Snapshot frame paths ────────────────────────────────────────────────────

describe('snapshot frame paths', () => {

  function recordedSession() {
    const recorder = new SessionRecorder()
    recorder.start()
    recorder.record(5)
    recorder.record(60)
    recorder.record(110)
    return recorder.stop()
  }

  it('a fresh session carries null cloud paths and NO inline image bytes', () => {
    const session = recordedSession()
    // Paths start null — set later by sync.js once the blob is uploaded.
    expect(session.peakFramePath).toBeNull()
    expect(session.minFramePath).toBeNull()
    // Image bytes must never live on the session object (that filled localStorage).
    expect(session).not.toHaveProperty('peakFrame')
    expect(session).not.toHaveProperty('minFrame')
  })

})
