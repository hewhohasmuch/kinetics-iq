/**
 * report.test.js
 *
 * Tests for the text a clinician pastes into a permanent medical record.
 *
 * Like labels.test.js and provenance.test.js, this pins WORDING, because the
 * wording is a clinical claim: whether a number is a peak or a minimum, whether
 * it was measured raw or against a captured zero, and whether it is known to be
 * on a scale that cannot be compared with a current recording. A note that
 * drops the last of those puts a known-bad number in a chart with no caveat.
 *
 * It also pins what must NOT be there: the clipboard is a promiscuous surface
 * (any app can read it on paste, and Universal Clipboard syncs it to other
 * devices), and the clinician is already inside the patient's chart when they
 * paste, so identifiers would add risk and no information.
 */

import { describe, it, expect } from 'vitest'
import { sessionNoteText, sessionReportModel } from './report.js'

/** A current, well-provenanced session. Override per test. */
function makeSession(overrides = {}) {
  return {
    id:                'c0ffee00-0000-4000-8000-000000000000',
    joint:             'knee',
    side:              'right',
    position:          'prone',
    date:              '2026-08-12',
    timestamp:         new Date(2026, 7, 12, 15, 42).getTime(),
    min:               5,
    max:               120,
    rom:               115,
    duration_s:        64,
    samples:           384,
    notes:             '',
    angleMode:         '2d2',
    angleFilter:       'euro1',
    angleConvention:   'perjoint1',
    calibrated:        true,
    calibrationOffset: 2.4,
    ...overrides,
  }
}

const lines = (s) => sessionNoteText(s).split('\n')

describe('sessionNoteText — the measurement', () => {

  it('leads the ROM with the arc, not the subtraction', () => {
    const text = sessionNoteText(makeSession())
    expect(text).toContain('ROM 5° – 120°')
  })

  // A knee lacking 5° of extension and one with full extension subtract to the
  // same total, and the deficit is the finding — so the total is secondary.
  it('demotes the total to a parenthetical', () => {
    const romLine = lines(makeSession()).find(l => l.startsWith('ROM'))
    expect(romLine).toBe('ROM 5° – 120° (115° total)')
  })

  it('names both extremes by the joint\'s own motion', () => {
    const text = sessionNoteText(makeSession({ joint: 'shoulder', side: 'left', position: 'standing' }))
    expect(text).toContain('Peak elevation 120°')
    expect(text).toContain('Min elevation 5°')
  })

  it('reports duration and sample count', () => {
    expect(sessionNoteText(makeSession())).toContain('Duration 1m 4s, 384 samples')
  })

  // Same boundary extremeLabels() is pinned on: exactly 0 has not crossed
  // neutral, so it is a minimum of flexion, not a peak of extension.
  it('calls a min of exactly 0 a minimum, not a peak of the opposite motion', () => {
    const text = sessionNoteText(makeSession({ min: 0, rom: 120 }))
    expect(text).toContain('Min flexion 0°')
    expect(text).not.toContain('extension')
  })

  it('keeps a negative minimum signed', () => {
    const text = sessionNoteText(makeSession({ min: -4, rom: 124 }))
    expect(text).toContain('ROM -4° – 120°')
    expect(text).toContain('Peak extension -4°')
  })

})

describe('sessionNoteText — the heading', () => {

  it('names joint, side and position', () => {
    expect(lines(makeSession())[0]).toBe('Right Knee — Prone')
  })

  // Null position is meaningful: the recorder leaves an unchosen position
  // absent rather than inventing one, and a dangling "— " would read as a
  // missing word rather than an absent field.
  it('omits the position segment entirely when none was recorded', () => {
    const heading = lines(makeSession({ position: null }))[0]
    expect(heading).toBe('Right Knee')
    expect(heading).not.toContain('—')
  })

  it('renders a heading for a legacy combined-joint session', () => {
    const heading = lines(makeSession({ joint: 'knee_right', side: undefined }))[0]
    expect(heading).toBe('Right Knee — Prone')
  })

  it('carries the date and time on their own line', () => {
    const dateLine = lines(makeSession())[1].replace(/[  ]/g, ' ')
    expect(dateLine).toBe('Wed, Aug 12, 2026 3:42 PM')
  })

})

describe('sessionNoteText — provenance', () => {

  // The most important line in the module. Without it a number known to be on
  // an inverted or clamped scale lands in a permanent record with no caveat.
  it('warns when the session predates the per-joint angle convention', () => {
    const text = sessionNoteText(makeSession({ angleConvention: undefined }))
    expect(text).toContain('⚠')
    expect(text).toContain('Legacy scale')
    expect(text).toContain('cannot be compared or corrected')
  })

  it('warns when the session went through the old moving-average filter', () => {
    const text = sessionNoteText(makeSession({ angleFilter: undefined }))
    expect(text).toContain('⚠')
    expect(text).toContain('Legacy filter')
  })

  it('adds no warning to a current session', () => {
    expect(sessionNoteText(makeSession())).not.toContain('⚠')
  })

})

describe('sessionNoteText — calibration', () => {

  it('states the captured zero', () => {
    expect(sessionNoteText(makeSession())).toContain('Zeroed at 2.4°')
  })

  // An offset of exactly 0.0 is a legitimate capture, not an absent one.
  it('treats a captured offset of exactly 0 as zeroed', () => {
    const text = sessionNoteText(makeSession({ calibrated: true, calibrationOffset: 0 }))
    expect(text).toContain('Zeroed at 0°')
  })

  it('states raw measurement as the positive claim it is', () => {
    const text = sessionNoteText(makeSession({ calibrated: false, calibrationOffset: 0 }))
    expect(text).toContain('Not zeroed — raw angles')
    expect(text).not.toContain('not recorded')
  })

  // Absence is a third state. Raw and zeroed are different measurements, and
  // an old session cannot be described as either.
  it('keeps "not recorded" distinct from "not zeroed"', () => {
    const text = sessionNoteText(makeSession({ calibrated: undefined, calibrationOffset: undefined }))
    expect(text).toContain('Calibration not recorded')
    expect(text).not.toContain('Not zeroed')
  })

  it('always emits a calibration line, never silently omits which it was', () => {
    for (const s of [
      makeSession(),
      makeSession({ calibrated: false }),
      makeSession({ calibrated: undefined }),
    ]) {
      expect(sessionNoteText(s)).toMatch(/[Zz]eroed|Calibration not recorded/)
    }
  })

})

describe('sessionNoteText — notes and attribution', () => {

  it('includes the session note when there is one', () => {
    expect(sessionNoteText(makeSession({ notes: 'day 14 post-op, after warm-up' })))
      .toContain('day 14 post-op, after warm-up')
  })

  it('adds no empty note line when there is none', () => {
    expect(lines(makeSession({ notes: '' })).some(l => l.trim() === '')).toBe(false)
    expect(lines(makeSession({ notes: undefined })).some(l => l.trim() === '')).toBe(false)
  })

  it('attributes the measurement', () => {
    expect(sessionNoteText(makeSession())).toContain('KineticsIQ')
  })

})

describe('sessionNoteText — PHI', () => {

  // Deliberate omission, pinned so it is not "helpfully" added later. The
  // clinician is already in the patient's chart when they paste; the
  // identifiers would only widen the clipboard's exposure.
  it('contains no patient identifiers, even when the session carries them', () => {
    const text = sessionNoteText(makeSession({
      patient_id:   'a1b2c3d4-0000-4000-8000-000000000000',
      patientName:  'Jane Doe',
      patient:      { name: 'Jane Doe', dob: '1981-04-02', mrn: 'MRN-99871' },
    }))
    expect(text).not.toContain('Jane')
    expect(text).not.toContain('Doe')
    expect(text).not.toContain('1981-04-02')
    expect(text).not.toContain('MRN-99871')
    expect(text).not.toContain('a1b2c3d4')
  })

})

describe('sessionReportModel — the shared source of both renderings', () => {

  // The model exists so the clipboard note and the exported PDF cannot drift
  // into stating different things about the same measurement. If a field ever
  // stops reaching the note, one of the two surfaces has started composing its
  // own clinical string — which is exactly what this prevents.
  it('puts every field it produces into the note text', () => {
    const s = makeSession({ notes: 'day 14 post-op, after warm-up' })
    const m = sessionReportModel(s)
    const text = sessionNoteText(s)

    for (const field of [
      m.heading, m.dateLine, m.romLine, m.maxLabel, m.maxValue,
      m.minLabel, m.minValue, m.durationLine, m.calibrationLine,
      m.notes, m.attribution,
    ]) {
      expect(text).toContain(field)
    }
  })

  it('carries warnings as data, leaving each medium to mark them', () => {
    // The note prefixes a ⚠; the PDF draws a band, because its base font has
    // no such glyph. Neither claim belongs in the model.
    const m = sessionReportModel(makeSession({ angleConvention: undefined }))
    expect(m.warnings[0]).toMatchObject({ level: 'convention', label: 'Legacy scale' })
    expect(m.warnings[0].tail).not.toContain('⚠')
  })

  it('reports no warnings for a fully stamped, zeroed session', () => {
    expect(sessionReportModel(makeSession()).warnings).toEqual([])
  })

  // A single `warning` field silently dropped whichever caveat came second,
  // and the two say different things: one invalidates every number on the
  // page, the other qualifies one of them.
  it('carries BOTH caveats when a session is legacy AND un-zeroed', () => {
    const m = sessionReportModel(makeSession({
      angleConvention: undefined, calibrated: false, min: 9,
    }))
    expect(m.warnings.map(w => w.level)).toEqual(['convention', 'floor'])
  })

  it('emits one ⚠ line per warning, provenance first', () => {
    const flagged = lines(makeSession({
      angleConvention: undefined, calibrated: false, min: 9,
    })).filter(l => l.startsWith('⚠'))
    expect(flagged).toHaveLength(2)
    expect(flagged[0]).toContain('Legacy scale')
    expect(flagged[1]).toContain('Minimum may be measurement floor')
  })

  // The whole point of the caveat: this session's stamps are all CURRENT, so
  // sessionProvenance() clears it and it would otherwise export looking clean
  // while its headline arc claims a 9° extension deficit.
  it('flags an un-zeroed minimum on a session whose stamps are all current', () => {
    const text = sessionNoteText(makeSession({ calibrated: false, min: 9 }))
    expect(text).toContain('⚠ Minimum may be measurement floor')
    expect(text).toContain('9°')
    expect(text).not.toContain('Legacy')
  })

  // It must not prescribe Set Zero: the error reverses sign across the range
  // (+8.2° at extension, -5.5° at flexion on the measured knee), so a single
  // subtraction would fix the minimum and push the peak further from truth.
  it('states what is unknown without recommending Set Zero', () => {
    const text = sessionNoteText(makeSession({ calibrated: false, min: 9 }))
    expect(text).not.toMatch(/Set Zero|re-?zero|calibrate/i)
  })

  it('leaves absent notes and position as null rather than empty strings', () => {
    const m = sessionReportModel(makeSession({ notes: '   ', position: null }))
    expect(m.notes).toBeNull()
    expect(m.heading).toBe('Right Knee')      // no dangling separator
  })

})

// ─── Verification reaches the note (PR 3) ────────────────────────────────────

describe('verification in the report model', () => {

  const verifiedSession = (angles) => makeSession({
    verifications: [{ id: 'v1', byMode: 'device', landmarks: {}, angles }],
  })

  it('carries a verification field on every session, model-measured included', () => {
    // Mentioning it only when it happened would leave the reader guessing what
    // silence meant.
    expect(sessionReportModel(makeSession()).verification.level).toBe('model')
    expect(sessionReportModel(verifiedSession({ min: 2, max: 130 })).verification.level).toBe('clinician')
  })

  it('keeps verification OUT of warnings — it is an upgrade, not a defect', () => {
    const m = sessionReportModel(verifiedSession({ min: 2, max: 130 }))
    expect(m.warnings.some(w => /verif/i.test(w.label))).toBe(false)
  })

  it('states it on the note for a model-measured session too', () => {
    expect(lines(makeSession()).some(l => /Model-measured/.test(l))).toBe(true)
  })

  it('names the mode without naming a person', () => {
    const text = sessionNoteText(verifiedSession({ min: 2, max: 130 }))
    expect(text).toMatch(/no account/)
    expect(text).toMatch(/Clinician-verified/)
  })

  it('ATTRIBUTES a ROM derived from verified endpoints', () => {
    // ROM between verified endpoints is a different quantity from ROM across
    // the raw timeline and can legitimately be narrower — printing it
    // unattributed would read as the same measurement having improved.
    const m = sessionReportModel(verifiedSession({ min: 10, max: 100 }))
    expect(m.romLine).toMatch(/between clinician-verified endpoints/)
    expect(m.romLine).toMatch(/10° – 100°/)
  })

  it('leaves the ROM line unattributed when nothing was verified', () => {
    expect(sessionReportModel(makeSession()).romLine).not.toMatch(/verified/)
  })

  it('reports the verified numbers, not the stored ones', () => {
    const m = sessionReportModel(verifiedSession({ min: 10, max: 100 }))
    expect(m.maxValue).toBe('100°')
    expect(m.minValue).toBe('10°')
  })

  it('NEVER strengthens the claim anywhere in the note', () => {
    for (const s of [makeSession(), verifiedSession({ min: 2, max: 130 })]) {
      const text = sessionNoteText(s).toLowerCase()
      expect(text).not.toMatch(/validated|corrected|accurate/)
    }
  })

  it('still carries no patient identifier once verification is added', () => {
    const text = sessionNoteText(verifiedSession({ min: 2, max: 130 }))
    expect(text).not.toMatch(/MRN|dob|Poppins/i)
  })
})
