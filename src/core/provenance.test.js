/**
 * provenance.test.js
 *
 * These verdicts drive a warning the clinician sees on a patient record, so
 * the ordering and the absence semantics both matter more than the wording.
 */

import { describe, it, expect } from 'vitest'
import { sessionProvenance, isLegacySession, calibrationSummary, extensionFloorCaveat } from './provenance.js'

const current = { angleMode: '2d2', angleFilter: 'euro1', angleConvention: 'perjoint1' }

describe('sessionProvenance', () => {

  it('clears a fully stamped session', () => {
    const p = sessionProvenance(current)
    expect(p.level).toBe('ok')
    expect(p.label).toBeNull()
  })

  it('flags a session missing the angle convention as unrecoverable', () => {
    const p = sessionProvenance({ ...current, angleConvention: undefined })
    expect(p.level).toBe('convention')
    expect(p.label).toBe('Legacy scale')
    expect(p.reason).toMatch(/cannot be compared/)
  })

  // The depth stamp is the reason this file gained a third verdict. A '3d'
  // session is not merely imprecise: measured against a goniometer on a right
  // elbow, a true 10.4°–140° arc recorded as 13.6°–115.4°, understating total
  // ROM by 21%, with the error reversing sign across the range.
  it('flags a 3d session as depth-estimated', () => {
    const p = sessionProvenance({ ...current, angleMode: '3d' })
    expect(p.level).toBe('depth')
    expect(p.label).toBe('Depth-estimated angles')
    expect(p.reason).toMatch(/reverses sign/)
  })

  // ABSENT angleMode is the pre-3D era, which was ALSO 2D. Reporting it as
  // depth-estimated would assert a mechanism that did not apply — the same
  // discipline calibrationSummary() keeps between "not recorded" and "raw".
  it('does not treat an absent angleMode as depth-estimated', () => {
    expect(sessionProvenance({ ...current, angleMode: undefined }).level).toBe('ok')
  })

  it('clears the current 2d2 stamp', () => {
    expect(sessionProvenance({ ...current, angleMode: '2d2' }).level).toBe('ok')
  })

  // Ordering again: the convention is unrecoverable and outranks depth, and
  // depth outranks the filter because it distorts the whole range rather than
  // clipping the extremes.
  it('reports the convention over depth when both apply', () => {
    const p = sessionProvenance({ ...current, angleMode: '3d', angleConvention: undefined })
    expect(p.level).toBe('convention')
  })

  it('reports depth over the filter when both apply', () => {
    const p = sessionProvenance({ ...current, angleMode: '3d', angleFilter: undefined })
    expect(p.level).toBe('depth')
  })

  it('counts a depth-estimated session as legacy', () => {
    expect(isLegacySession({ ...current, angleMode: '3d' })).toBe(true)
  })

  it('flags a session missing only the filter as reading low', () => {
    const p = sessionProvenance({ ...current, angleFilter: undefined })
    expect(p.level).toBe('filter')
    expect(p.label).toBe('Legacy filter')
    expect(p.reason).toMatch(/clipped/)
  })

  // Order matters. A session missing both is missing the worse of the two, and
  // calling it "Legacy filter" would understate a scale that is inverted at the
  // shoulder and offset by 90° at the ankle.
  it('reports the convention when BOTH stamps are missing', () => {
    expect(sessionProvenance({}).level).toBe('convention')
  })

  it('treats an empty-string stamp as missing, not as a value', () => {
    expect(sessionProvenance({ ...current, angleConvention: '' }).level).toBe('convention')
  })

  it('does not throw on null or undefined', () => {
    expect(sessionProvenance(null).level).toBe('convention')
    expect(sessionProvenance(undefined).level).toBe('convention')
  })

})

describe('isLegacySession', () => {

  it('is false only for a fully stamped session', () => {
    expect(isLegacySession(current)).toBe(false)
    expect(isLegacySession({ ...current, angleFilter: undefined })).toBe(true)
    expect(isLegacySession({})).toBe(true)
  })

})

describe('calibrationSummary', () => {

  it('reports a captured zero with its offset', () => {
    const c = calibrationSummary({ calibrated: true, calibrationOffset: -1.4 })
    expect(c.known).toBe(true)
    expect(c.calibrated).toBe(true)
    expect(c.text).toBe('Zeroed at -1.4°')
  })

  // A captured offset of exactly 0.0 is legitimate — the joint really was at
  // neutral. Same reason CalibrationManager tracks an explicit captured flag
  // instead of inferring one from `offset !== 0`.
  it('treats a captured offset of exactly 0 as zeroed', () => {
    expect(calibrationSummary({ calibrated: true, calibrationOffset: 0 }).text)
      .toBe('Zeroed at 0°')
  })

  it('reports an explicit false as raw angles', () => {
    const c = calibrationSummary({ calibrated: false, calibrationOffset: 0 })
    expect(c.known).toBe(true)
    expect(c.calibrated).toBe(false)
    expect(c.text).toMatch(/Not zeroed/)
  })

  // The distinction the goniometer comparison depends on: a session predating
  // these stamps never recorded whether it was zeroed, and claiming "Not
  // zeroed" would assert a fact about the measurement that nobody captured.
  it('distinguishes "never recorded" from "recorded as not zeroed"', () => {
    const unknown = calibrationSummary({})
    expect(unknown.known).toBe(false)
    expect(unknown.text).toBe('Calibration not recorded')
    expect(unknown.text).not.toMatch(/Not zeroed/)
  })

  it('treats null the same as absent', () => {
    expect(calibrationSummary({ calibrated: null }).known).toBe(false)
    expect(calibrationSummary(null).known).toBe(false)
  })

})

// ─── The measurement floor ─────────────────────────────────────────────────

describe('extensionFloorCaveat', () => {

  const raw = { joint: 'knee', calibrated: false, min: 9 }

  it('flags an un-zeroed knee whose minimum sits above neutral', () => {
    const c = extensionFloorCaveat(raw)
    expect(c.label).toBe('Minimum may be measurement floor')
    expect(c.tail).toContain('9°')
    expect(c.tail).toContain('extension deficit')
  })

  // The raw reading cannot go below 0, so a minimum of exactly 0 has not been
  // pushed up by anything — there is nothing to caveat.
  it('is silent when the minimum is exactly 0', () => {
    expect(extensionFloorCaveat({ ...raw, min: 0 })).toBeNull()
  })

  it('is silent once a zero was captured', () => {
    expect(extensionFloorCaveat({ ...raw, calibrated: true })).toBeNull()
  })

  // Absence is the third state, as everywhere else in this file: nobody
  // recorded whether this was zeroed, and "Calibration not recorded" already
  // says so. Firing here would assert a mechanism we cannot confirm applied.
  it('is silent when the calibration state was never recorded', () => {
    expect(extensionFloorCaveat({ joint: 'knee', min: 9 })).toBeNull()
    expect(extensionFloorCaveat({ ...raw, calibrated: null })).toBeNull()
  })

  // The ankle's neutral is mid-range (interior 90 of 0–180), so its errors are
  // two-sided and cancel. It has no floor to warn about.
  it('is silent for the ankle, whose neutral is mid-range', () => {
    expect(extensionFloorCaveat({ ...raw, joint: 'ankle' })).toBeNull()
  })

  // Same mechanism, larger: the shoulder's raw reading sits ~25° high at rest.
  it('flags the shoulder, whose neutral is also at a range end', () => {
    expect(extensionFloorCaveat({ joint: 'shoulder', calibrated: false, min: 24.6 })).not.toBeNull()
  })

  it('reads the legacy combined joint form off a saved record', () => {
    expect(extensionFloorCaveat({ ...raw, joint: 'knee_right' })).not.toBeNull()
  })

  // It must not prescribe Set Zero. Measured on the knee, the error reverses
  // sign across the range (+8.2° at extension, -5.5° at flexion), and
  // CalibrationManager.apply() is a single subtraction — zeroing would fix the
  // minimum and push the peak further from truth.
  it('states what is unknown without recommending a fix', () => {
    const c = extensionFloorCaveat(raw)
    expect(`${c.tail} ${c.reason}`).not.toMatch(/Set Zero|re-?zero|calibrate/i)
  })

  it('does not throw on null or undefined', () => {
    expect(extensionFloorCaveat(null)).toBeNull()
    expect(extensionFloorCaveat(undefined)).toBeNull()
  })

})

// ─── Verification (PR 3) ─────────────────────────────────────────────────────

import { verificationSummary } from './provenance.js'

const verified = (angles, over = {}) => ({
  ...current, joint: 'knee', calibrated: false,
  min: 9, max: 121.8, rom: 112.8,
  verifications: [{ id: 'v1', byMode: 'device', landmarks: {}, angles, ...over }],
})

describe('verificationSummary', () => {

  it('reports a model-measured session as the default, with no attribution', () => {
    const v = verificationSummary({ ...current, min: 9, max: 121.8 })
    expect(v.level).toBe('model')
    expect(v.ends).toEqual([])
    expect(v.attribution).toBeNull()
  })

  it('names both ends when both were verified', () => {
    const v = verificationSummary(verified({ min: 2.1, max: 127.3 }))
    expect(v.level).toBe('clinician')
    expect(v.ends).toEqual(['peak', 'minimum'])
    expect(v.label).toBe('Clinician-verified endpoints')
  })

  it('names only the end that was actually verified', () => {
    const v = verificationSummary(verified({ min: null, max: 127.3 }))
    expect(v.ends).toEqual(['peak'])
    expect(v.label).toMatch(/peak/)
  })

  it('says the rest of the recording is unchanged', () => {
    // The scope IS the claim: these are endpoint observations, not the
    // extremes of the whole motion.
    expect(verificationSummary(verified({ min: 2.1, max: 127.3 })).detail)
      .toMatch(/rest of the recording is unchanged/)
  })

  it('distinguishes an account from a device, and names no person', () => {
    const acct = verificationSummary(verified({ min: 2, max: 120 }, { byMode: 'account', by: 'user-1' }))
    const dev  = verificationSummary(verified({ min: 2, max: 120 }, { byMode: 'device', by: null }))
    expect(acct.attribution).toMatch(/signed in/)
    expect(dev.attribution).toMatch(/no account/)
    expect(dev.attribution).not.toMatch(/user-1/)
    expect(acct.attribution).not.toMatch(/user-1/)
  })

  it('NEVER strengthens the claim past "verified"', () => {
    // This app has no role model: an account proves signup, not a licence, and
    // the software does not confirm the placed points are anatomically right.
    for (const s of [verified({ min: 2, max: 120 }), { ...current, min: 9, max: 120 }]) {
      const v = verificationSummary(s)
      const text = `${v.label} ${v.detail} ${v.attribution ?? ''}`.toLowerCase()
      expect(text).not.toMatch(/validated|corrected|accurate/)
    }
  })
})

describe('extensionFloorCaveat once an endpoint is verified', () => {

  it('DROPS the floor caveat when the verified minimum clears the bound', () => {
    // The lag is now a finding a clinician stands behind.
    expect(extensionFloorCaveat(verified({ min: 6.5, max: 121.8 }))).toBeNull()
  })

  it('still fires — with a DIFFERENT claim — when the minimum sits at the bound', () => {
    // acos is bounded at 0 for this joint no matter where the points go, so a
    // minimum resting there cannot separate neutral from hyperextension.
    const c = extensionFloorCaveat(verified({ min: 0, max: 121.8 }))
    expect(c.label).toBe('Cannot show hyperextension')
    expect(c.tail).toMatch(/cannot be measured below 0/)
    expect(c.reason).toMatch(/inverse cosine|bounded/)
  })

  it('does not credit verification of the PEAK for the minimum', () => {
    // Only the end that was verified changes the claim.
    const c = extensionFloorCaveat(verified({ min: null, max: 127.3 }))
    expect(c.label).toBe('Minimum may be measurement floor')
  })

  it('leaves unverified sessions exactly as they were', () => {
    const raw = { ...current, joint: 'knee', calibrated: false, min: 9, max: 121.8 }
    expect(extensionFloorCaveat(raw).label).toBe('Minimum may be measurement floor')
    expect(extensionFloorCaveat({ ...raw, calibrated: true })).toBeNull()
    expect(extensionFloorCaveat({ ...raw, calibrated: undefined })).toBeNull()
  })

  it('never claims a floor for a joint whose range is two-sided', () => {
    expect(extensionFloorCaveat(verified({ min: 0, max: 30 }, {}))).not.toBeNull()
    const ankle = { ...verified({ min: 0, max: 30 }), joint: 'ankle' }
    expect(extensionFloorCaveat(ankle)).toBeNull()
  })
})
