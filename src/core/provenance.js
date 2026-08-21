/**
 * provenance.js
 *
 * Reads the angle-provenance stamps on a saved session and says, in one short
 * phrase, whether its numbers can be compared with a current recording.
 *
 * WHY THIS IS A UI CONCERN AND NOT JUST A DATABASE DETAIL:
 * The stamps have been stored and synced for a while, but nothing ever showed
 * them, so a clinician looking at a patient's history had no way to tell a
 * trustworthy session from one whose numbers are artefacts. That is the
 * dangerous direction: the old moving-average filter clipped 10-15° off the
 * peak of a dynamic sweep, so an old session sitting next to a new one looks
 * like the patient improved when all that changed was the filter.
 *
 * The three stamps are not equally bad, so they get different verdicts:
 *
 *   angleConvention 'perjoint1' — the per-joint clinical mapping. WITHOUT it,
 *     shoulder values are on an inverted scale, ankle values are offset by 90°,
 *     and anything recorded after a Set Zero had everything below the zero
 *     point clamped to 0. These numbers are NOT recoverable: the calibration
 *     offset was never stored on the session and the clamped samples are gone.
 *
 *   angleMode '3d' — the monocular world landmarks. Those sessions read LOW at
 *     end range and HIGH near neutral, because the depth estimate is not
 *     metrically self-consistent: rigid bone lengths drift ~8% RMS between two
 *     frames of the same person. Measured on a right elbow against a goniometer,
 *     a true 10.4°–140° arc recorded as 13.6°–115.4° — total ROM understated by
 *     21%. Because the error REVERSES SIGN across the range, no calibration
 *     offset can remove it. Current sessions carry angleMode '2d2'.
 *
 *   angleFilter 'euro1' — One Euro smoothing. WITHOUT it, the session went
 *     through the 15-sample moving average, whose ~0.7s of lag clipped the
 *     peaks. The shape is right and the joint is right; the extremes read low.
 *
 * A session missing the convention is missing the worst of the three, so it is
 * checked first — reporting it as merely "peaks read low" would understate it,
 * and the depth verdict is checked before the filter one for the same reason.
 * Note ABSENT angleMode is NOT the depth case: it means the pre-3D era, which
 * was also 2D, and those sessions are already caught by the two checks around
 * it. Only the positive claim '3d' is flagged.
 *
 * Pure — no DOM, testable in Node.
 */

import { rawCannotGoBelowNeutral, motionTerms } from './angle.js'

/**
 * @typedef {object} Provenance
 * @property {'ok'|'filter'|'depth'|'convention'} level
 * @property {string|null} label   short badge text, null when nothing to flag
 * @property {string|null} reason  longer explanation for a tooltip
 */

/**
 * Assess a saved session's angle provenance.
 *
 * @param {{angleConvention?: string, angleMode?: string, angleFilter?: string}} session
 * @returns {Provenance}
 */
export function sessionProvenance(session) {
  if (!session?.angleConvention) {
    return {
      level:  'convention',
      label:  'Legacy scale',
      reason: 'Recorded before the per-joint angle convention: shoulder values are on an ' +
              'inverted scale, ankle values are offset by 90°, and any reading past a Set ' +
              'Zero was clamped to 0. These numbers cannot be compared or corrected.',
    }
  }

  if (session.angleMode === '3d') {
    return {
      level:  'depth',
      label:  'Depth-estimated angles',
      reason: 'Measured from monocular 3D world landmarks. That depth estimate is not ' +
              'metrically self-consistent — rigid bone lengths drift about 8% between frames ' +
              'of the same person — and the resulting angle error reverses sign across the ' +
              'range, reading high near neutral and low at end range. On the measured elbow it ' +
              'understated total ROM by 21%. The error cannot be removed by a Set Zero, ' +
              'because a single subtraction cannot correct an error that changes sign.',
    }
  }

  if (!session.angleFilter) {
    return {
      level:  'filter',
      label:  'Legacy filter',
      reason: 'Recorded through the old moving-average filter, which clipped 10-15° off the ' +
              'peak of a fast movement. Its range reads low — the difference from a newer ' +
              'session looks like progress but is the filter change.',
    }
  }

  return { level: 'ok', label: null, reason: null }
}

/** Convenience for the common "should I draw a warning badge" branch. */
export function isLegacySession(session) {
  return sessionProvenance(session).level !== 'ok'
}

/**
 * Describe whether a session was zeroed before it was recorded.
 *
 * Absence is NOT "not zeroed". Sessions saved before the calibration stamps
 * existed carry no `calibrated` field at all, and reporting those as "Not
 * zeroed" would assert something about the measurement that was never
 * recorded. Same discipline the angle stamps already follow — undefined means
 * unknown.
 *
 * @param {{calibrated?: boolean, calibrationOffset?: number}} session
 * @returns {{known: boolean, calibrated: boolean, text: string}}
 */
export function calibrationSummary(session) {
  if (session?.calibrated === undefined || session?.calibrated === null) {
    return { known: false, calibrated: false, text: 'Calibration not recorded' }
  }
  if (!session.calibrated) {
    return { known: true, calibrated: false, text: 'Not zeroed — raw angles' }
  }
  const offset = session.calibrationOffset
  return {
    known:      true,
    calibrated: true,
    text:       offset === undefined || offset === null
      ? 'Zeroed'
      : `Zeroed at ${offset}°`,
  }
}

/**
 * Flag a minimum that cannot be distinguished from the measurement floor.
 *
 * WHY THIS IS DIFFERENT FROM THE TWO ABOVE:
 * sessionProvenance() and calibrationSummary() read STAMPS — facts about which
 * version of the app produced the record. This one reads the MEASUREMENT, and
 * fires on sessions whose stamps are all current. That gap was the hazard: a
 * session recorded by today's build exports looking clean, and romArc leads the
 * note and the PDF with the arc, whose lower end is exactly the number in
 * question. A knee reported as "9° – 121.8°" is claiming a 9° extension lag —
 * a real, treatment-driving finding — when the raw reading cannot go below 0
 * at all (see rawCannotGoBelowNeutral in angle.js).
 *
 * FIRES ONLY ON THE POSITIVE CLAIM. `calibrated === false` means the session
 * recorded that it was measured raw. Absence means nobody recorded anything,
 * and those sessions already surface "Calibration not recorded", which carries
 * its own uncertainty — asserting this mechanism applied to them would
 * manufacture the very claim calibrationSummary() is careful not to make.
 *
 * DELIBERATELY DOES NOT RECOMMEND SET ZERO. Measured on the knee in
 * tmp/right knee supine.png, the error reverses sign across the range (+8.2° at
 * extension, -5.5° at flexion), and CalibrationManager.apply() is a single
 * subtraction — so zeroing at full extension would fix the bottom and push the
 * peak further from truth, exactly as the shoulder limitation in CLAUDE.md
 * describes. The caveat states what is not known; it does not prescribe.
 *
 * @param {{joint?: string, calibrated?: boolean, min?: number}} session
 * @returns {{label: string, reason: string, tail: string}|null}
 */
export function extensionFloorCaveat(session) {
  if (!session) return null
  if (session.calibrated !== false) return null
  if (!rawCannotGoBelowNeutral(session.joint)) return null
  if (!(session.min > 0)) return null

  const negative = motionTerms(session.joint).negative

  return {
    label:  'Minimum may be measurement floor',
    tail:   `measured raw, and the ${session.min}° minimum cannot be separated from the ` +
            `measurement floor, so it should not be read as an ${negative} deficit on its own.`,
    reason: `This session was recorded without a captured zero. The raw angle for this joint ` +
            `cannot go below 0°, so every landmark error at neutral is folded into apparent ` +
            `motion and the minimum sits above the true value by an unknown amount. The ` +
            `figure is what was measured; it is not, on its own, evidence of an ${negative} ` +
            `deficit.`,
  }
}
