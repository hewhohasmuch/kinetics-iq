/**
 * extremes.test.js
 *
 * This accessor decides which numbers reach a patient record, so the tests
 * that matter are about SEMANTICS, not arithmetic: that an unverified session
 * is untouched, that a verified endpoint never masquerades as a timeline
 * extreme, and that the shape cannot be misread as the extrema of the motion.
 */

import { describe, it, expect } from 'vitest'
import { reportedExtremes, currentVerification } from './extremes.js'

/** A raw, unverified session as SessionRecorder.finalize() writes it. */
const raw = {
  min: 9, max: 121.8, rom: 112.8,
  angleTimeline: [0, 40, 97, 121.8, 100, 9],
  joint: 'knee', side: 'right',
}

const verification = (angles, extra = {}) => ({
  verifications: [{
    id: 'v1', at: 1000, by: null, byMode: 'device', byDevice: 'dev-1',
    landmarks: { peak: {}, min: {} },
    angles,
    ...extra,
  }],
})

describe('currentVerification', () => {

  it('treats null and [] as never verified, not as verified-and-unchanged', () => {
    expect(currentVerification({ ...raw })).toBeNull()
    expect(currentVerification({ ...raw, verifications: null })).toBeNull()
    expect(currentVerification({ ...raw, verifications: [] })).toBeNull()
  })

  it('reads the last element, so appended history stays compatible', () => {
    const s = { verifications: [{ id: 'old' }, { id: 'new' }] }
    expect(currentVerification(s).id).toBe('new')
  })
})

describe('reportedExtremes — unverified sessions are untouched', () => {

  it('returns the stored values verbatim with source "model"', () => {
    const e = reportedExtremes(raw)
    expect(e.reportedMin).toBe(9)
    expect(e.reportedMax).toBe(121.8)
    expect(e.source).toBe('model')
    expect(e.endpointsOnly).toBe(false)
  })

  it('returns the STORED rom, never a recomputed one', () => {
    // rom was rounded once from the unrounded pair; recomputing from the
    // rounded pair can differ in the last decimal, and that difference would
    // look like adopting this accessor changed the data.
    const s = { min: 0.05, max: 10.04, rom: 9.99 }
    expect(reportedExtremes(s).reportedRom).toBe(9.99)
  })

  it('is behaviour-identical for null and empty verification arrays', () => {
    for (const v of [null, undefined, []]) {
      expect(reportedExtremes({ ...raw, verifications: v })).toMatchObject({
        reportedMin: 9, reportedMax: 121.8, reportedRom: 112.8, source: 'model',
      })
    }
  })
})

describe('reportedExtremes — the shape resists misuse', () => {

  it('emits NO key called min or max', () => {
    // `const { min, max } = reportedExtremes(s)` must break loudly rather than
    // silently read as the extrema of the motion. Do not add these back.
    const e = reportedExtremes(raw)
    expect(e).not.toHaveProperty('min')
    expect(e).not.toHaveProperty('max')
    expect(e.min).toBeUndefined()
    expect(e.max).toBeUndefined()
  })
})

describe('reportedExtremes — verified endpoints', () => {

  it('reports the verified angles and marks them endpoint-only', () => {
    const e = reportedExtremes({ ...raw, ...verification({ min: 2.1, max: 127.3 }) })
    expect(e.reportedMin).toBe(2.1)
    expect(e.reportedMax).toBe(127.3)
    expect(e.reportedRom).toBe(125.2)
    expect(e.source).toBe('clinician')
    expect(e.endpointsOnly).toBe(true)
  })

  it('reports ROM that is NARROWER than the raw timeline when verified inward', () => {
    // Not a bug: ROM between verified endpoints is a different quantity from
    // ROM across the raw timeline.
    const e = reportedExtremes({ ...raw, ...verification({ min: 12, max: 110 }) })
    expect(e.reportedRom).toBe(98)
    expect(e.reportedRom).toBeLessThan(raw.rom)
  })

  it('keeps each end\'s source separate when only one end is verified', () => {
    const e = reportedExtremes({ ...raw, ...verification({ min: null, max: 127.3 }) })
    expect(e.reportedMin).toBe(9)          // untouched model value
    expect(e.reportedMax).toBe(127.3)      // verified
    expect(e.minSource).toBe('model')
    expect(e.maxSource).toBe('clinician')
    expect(e.source).toBe('mixed')         // never collapsed to one claim
    expect(e.endpointsOnly).toBe(true)
  })

  it('treats a verified 0 as a real value, not as absence', () => {
    const e = reportedExtremes({ ...raw, ...verification({ min: 0, max: 120 }) })
    expect(e.reportedMin).toBe(0)
    expect(e.minSource).toBe('clinician')
  })

  it('treats a negative verified minimum as real (extension past neutral)', () => {
    const e = reportedExtremes({ ...raw, ...verification({ min: -4, max: 120 }) })
    expect(e.reportedMin).toBe(-4)
    expect(e.reportedRom).toBe(124)
  })
})

describe('THE pathological case — a verified peak is not a timeline maximum', () => {

  // The single most important distinction in the feature. The peak FRAME was
  // the 100 deg sample; the clinician verifies that frame down to 92. Another
  // timeline sample sits at 97 — higher than the verified peak, and
  // unverifiable because no snapshot of it exists.
  const session = {
    min: 5, max: 100, rom: 95,
    angleTimeline: [0, 40, 97, 100, 88, 5],
    ...verification({ min: 5, max: 92 }),
  }

  it('preserves the raw record untouched', () => {
    reportedExtremes(session)
    expect(session.max).toBe(100)
    expect(Math.max(...session.angleTimeline)).toBe(100)
    expect(session.angleTimeline).toEqual([0, 40, 97, 100, 88, 5])
  })

  it('reports the verified endpoint, not the timeline maximum', () => {
    const e = reportedExtremes(session)
    expect(e.reportedMax).toBe(92)
    expect(e.maxSource).toBe('clinician')
    expect(e.endpointsOnly).toBe(true)
  })

  it('reports a peak LOWER than a sample the timeline still contains', () => {
    // 97 > 92. This is the correct outcome, and the reason no wording may
    // call the verified value "the maximum reached".
    const e = reportedExtremes(session)
    const timelineMax = Math.max(...session.angleTimeline)
    expect(e.reportedMax).toBeLessThan(timelineMax)
    expect(session.angleTimeline.some(a => a > e.reportedMax)).toBe(true)
  })

  it('derives ROM from the verified endpoints', () => {
    expect(reportedExtremes(session).reportedRom).toBe(87)
  })
})
