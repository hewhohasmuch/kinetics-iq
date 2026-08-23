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

  // ─── setCalibration ───────────────────────────────────────────────
  //
  // The offset lives in device-global settings that are cleared on every
  // joint/side/patient switch, so unless it is stamped here a saved session
  // cannot say whether its numbers were raw or re-based on a captured neutral.

  it('stamps the calibration state onto the session', () => {
    recorder.setCalibration(-1.4, true)
    recorder.start()
    recorder.record(45)
    const session = recorder.stop()
    expect(session.calibrated).toBe(true)
    expect(session.calibrationOffset).toBe(-1.4)
  })

  // A captured offset of exactly 0.0 is legitimate — the joint really was at
  // neutral — which is why `captured` is passed explicitly rather than inferred
  // from a non-zero offset.
  it('records a captured zero of exactly 0 as calibrated', () => {
    recorder.setCalibration(0, true)
    recorder.start()
    recorder.record(45)
    const session = recorder.stop()
    expect(session.calibrated).toBe(true)
    expect(session.calibrationOffset).toBe(0)
  })

  it('records an un-zeroed recording as explicitly false', () => {
    recorder.setCalibration(0, false)
    recorder.start()
    recorder.record(45)
    expect(recorder.stop().calibrated).toBe(false)
  })

  // Absence is a third state: "never recorded" is not the same claim as
  // "measured raw", and old sessions carry neither field.
  it('leaves the calibration state null when it was never supplied', () => {
    recorder.start()
    recorder.record(45)
    const session = recorder.stop()
    expect(session.calibrated).toBeNull()
    expect(session.calibrated).not.toBe(false)
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

// ─── Clinical position ────────────────────────────────────────────────────────

describe('measurement position', () => {

  function sessionWithContext(...args) {
    const recorder = new SessionRecorder()
    if (args.length) recorder.setContext(...args)
    recorder.start()
    recorder.record(30)
    return recorder.stop()
  }

  it('stamps the position it was given', () => {
    expect(sessionWithContext('shoulder', 'left', 'standing').position).toBe('standing')
  })

  it('does NOT invent a position when none is supplied', () => {
    // This defaulted to 'prone', which is how standing shoulder measurements
    // were written into the patient record as "Prone". A position nobody chose
    // is not data — the views omit the badge when it is null.
    expect(sessionWithContext('shoulder', 'left', null).position).toBeNull()
    expect(sessionWithContext('shoulder', 'left').position).toBeNull()
    expect(sessionWithContext().position).toBeNull()
  })

  // ─── out-of-plane provenance ─────────────────────────────────────────
  //
  // The measured angle is the 2D projection, which is the joint angle only
  // while the limb stays in the image plane. maxSegmentTilt is the saved
  // record of whether that held, so its absence semantics matter as much as
  // the calibration stamps': null means nobody measured, 0 means measured and
  // in plane, and those are different claims.
  describe('segment tilt', () => {
    const run = (tilts) => {
      const r = new SessionRecorder()
      r.start()
      r.record(10)
      for (const t of tilts) r.recordTilt(t)
      return r.stop()
    }

    it('keeps the WORST excursion, not the last or the mean', () => {
      expect(run([2, 31.4, 3]).maxSegmentTilt).toBe(31.4)
    })

    it('records 0 when the limb stayed in plane', () => {
      expect(run([0, 0]).maxSegmentTilt).toBe(0)
    })

    it('stays null when tilt was never measured', () => {
      expect(run([]).maxSegmentTilt).toBeNull()
    })

    it('ignores null and NaN samples rather than poisoning the max', () => {
      expect(run([null, undefined, NaN, 12]).maxSegmentTilt).toBe(12)
    })

    it('ignores tilt recorded outside an active session', () => {
      const r = new SessionRecorder()
      r.recordTilt(40)
      r.start()
      r.record(10)
      expect(r.stop().maxSegmentTilt).toBeNull()
    })

    it('does not carry a previous bout\u0027s tilt into the next', () => {
      const r = new SessionRecorder()
      r.start(); r.record(10); r.recordTilt(40); r.stop()
      r.start(); r.record(10)
      expect(r.stop().maxSegmentTilt).toBeNull()
    })

    it('rounds to 1dp like every other saved figure', () => {
      expect(run([27.26666]).maxSegmentTilt).toBe(27.3)
    })
  })

})

// ─── Landmark evidence (PR 2) ────────────────────────────────────────────────

describe('landmark evidence', () => {

  const set = (x) => ({
    proximal: { x, y: 0.2, visibility: 0.9, kind: 'anatomical' },
    joint:    { x, y: 0.5, visibility: 0.9, kind: 'anatomical' },
    distal:   { x, y: 0.8, visibility: 0.9, kind: 'anatomical' },
  })

  function run(evidence = {}) {
    const r = new SessionRecorder()
    r.setContext('knee', 'right', 'supine')
    r.setModel('blazepose-full', 'tasks-vision@0.10.35+float16/latest')
    r.start()
    r.record(5); r.record(60); r.record(120)
    for (const [which, e] of Object.entries(evidence)) r.setExtremeEvidence(which, e)
    return r.stop()
  }

  it('stamps the landmark space unconditionally', () => {
    // It describes HOW THE FRAMES WERE STORED, not whether landmarks resolved.
    // Absence must keep meaning "recorded before landmark capture existed",
    // whose stored image is the legacy baked composite.
    expect(run().landmarkSpace).toBe('frame1')
  })

  it('stamps which model produced the landmarks', () => {
    const s = run()
    expect(s.modelId).toBe('blazepose-full')
    expect(s.modelVersion).toBe('tasks-vision@0.10.35+float16/latest')
  })

  it('maps max evidence to the PEAK slot and min to min', () => {
    const s = run({ max: { set: set(0.7), rawAngle: 121.4, tilt: 8.2 },
                    min: { set: set(0.3), rawAngle: 4.9,   tilt: 3.1 } })
    expect(s.landmarksRaw.peak).toEqual(set(0.7))
    expect(s.landmarksRaw.min).toEqual(set(0.3))
    expect(s.frameAngleRawMax).toBe(121.4)
    expect(s.frameAngleRawMin).toBe(4.9)
    expect(s.frameTiltMax).toBe(8.2)
    expect(s.frameTiltMin).toBe(3.1)
  })

  it('keeps the raw frame angle DISTINCT from the filtered min/max', () => {
    // The delta a verification is measured against is `verified − frameAngleRaw`.
    // Comparing against the filtered, calibrated max would fold the filter's
    // behaviour into a measurement of landmark bias.
    const s = run({ max: { set: set(0.7), rawAngle: 118.2, tilt: null } })
    expect(s.max).toBe(120)
    expect(s.frameAngleRawMax).toBe(118.2)
  })

  it('leaves an end null when that extreme was never captured', () => {
    const s = run({ max: { set: set(0.7), rawAngle: 121.4, tilt: 8.2 } })
    expect(s.landmarksRaw.min).toBeNull()
    expect(s.frameAngleRawMin).toBeNull()
    expect(s.frameTiltMin).toBeNull()
  })

  it('stores a picture with a null set when landmarks did not resolve', () => {
    const s = run({ max: { set: null, rawAngle: null, tilt: null } })
    expect(s.landmarkSpace).toBe('frame1')   // still a clean frame
    expect(s.landmarksRaw.peak).toBeNull()
  })

  it('survives a measured tilt of exactly 0 as 0, not as never-measured', () => {
    const s = run({ max: { set: set(0.7), rawAngle: 90, tilt: 0 } })
    expect(s.frameTiltMax).toBe(0)
    expect(s.frameTiltMin).toBeNull()
  })

  it('keeps a NEGATIVE raw frame angle signed', () => {
    const s = run({ min: { set: set(0.3), rawAngle: -4.26, tilt: null } })
    expect(s.frameAngleRawMin).toBe(-4.3)
  })

  it('rounds frame angles and tilts to 1dp like every other stored angle', () => {
    const s = run({ max: { set: set(0.7), rawAngle: 121.4444, tilt: 8.2666 } })
    expect(s.frameAngleRawMax).toBe(121.4)
    expect(s.frameTiltMax).toBe(8.3)
  })

  it('ignores evidence offered while not recording', () => {
    const r = new SessionRecorder()
    r.setExtremeEvidence('max', { set: set(0.7), rawAngle: 100, tilt: 1 })
    r.setContext('knee', 'right', 'supine')
    r.start()
    r.record(5); r.record(120)
    expect(r.stop().landmarksRaw.peak).toBeNull()
  })

  it('clears evidence from a previous bout on start()', () => {
    const r = new SessionRecorder()
    r.setContext('knee', 'right', 'supine')
    r.start()
    r.record(5); r.record(120)
    r.setExtremeEvidence('max', { set: set(0.7), rawAngle: 100, tilt: 1 })
    r.stop()

    r.start()
    r.record(10); r.record(90)
    expect(r.stop().landmarksRaw.peak).toBeNull()
  })

  it('records null model stamps when none were supplied', () => {
    const r = new SessionRecorder()
    r.setContext('knee', 'right', 'supine')
    r.start()
    r.record(5); r.record(120)
    const s = r.stop()
    expect(s.modelId).toBeNull()
    expect(s.modelVersion).toBeNull()
  })
})
