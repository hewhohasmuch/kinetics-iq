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
 * The two stamps are not equally bad, so they get different verdicts:
 *
 *   angleConvention 'perjoint1' — the per-joint clinical mapping. WITHOUT it,
 *     shoulder values are on an inverted scale, ankle values are offset by 90°,
 *     and anything recorded after a Set Zero had everything below the zero
 *     point clamped to 0. These numbers are NOT recoverable: the calibration
 *     offset was never stored on the session and the clamped samples are gone.
 *
 *   angleFilter 'euro1' — One Euro smoothing. WITHOUT it, the session went
 *     through the 15-sample moving average, whose ~0.7s of lag clipped the
 *     peaks. The shape is right and the joint is right; the extremes read low.
 *
 * A session missing the convention is missing the worse of the two, so it is
 * checked first — reporting it as merely "peaks read low" would understate it.
 *
 * Pure — no DOM, testable in Node.
 */

/**
 * @typedef {object} Provenance
 * @property {'ok'|'filter'|'convention'} level
 * @property {string|null} label   short badge text, null when nothing to flag
 * @property {string|null} reason  longer explanation for a tooltip
 */

/**
 * Assess a saved session's angle provenance.
 *
 * @param {{angleConvention?: string, angleFilter?: string}} session
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
