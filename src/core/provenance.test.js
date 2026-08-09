/**
 * provenance.test.js
 *
 * These verdicts drive a warning the clinician sees on a patient record, so
 * the ordering and the absence semantics both matter more than the wording.
 */

import { describe, it, expect } from 'vitest'
import { sessionProvenance, isLegacySession, calibrationSummary } from './provenance.js'

const current = { angleMode: '3d', angleFilter: 'euro1', angleConvention: 'perjoint1' }

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
