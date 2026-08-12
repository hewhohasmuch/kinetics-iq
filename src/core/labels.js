/**
 * labels.js
 *
 * Display names for joints, sides, positions and motions — the one place the
 * UI turns a saved record into words a clinician reads.
 *
 * WHY THIS MODULE EXISTS:
 * The `{ knee: 'Knee', … }` map used to be written out separately in
 * MeasureView, HistoryView and SessionDetailView, side capitalisation was
 * inlined at each call site, and the position badges built their own
 * `charAt(0).toUpperCase()` string instead of using POSITION_NAMES at all.
 * Four copies of the same intent drift, and the wording here is clinical, not
 * cosmetic — the snapshot caption and the stat card above it must say the same
 * thing about the same number.
 *
 * SOURCE OF TRUTH:
 * angle.js owns the motion TERMS (JOINT_MOTION_TERMS / motionTerms) because
 * they belong with the angle convention that gives them meaning. This module
 * only formats them for display; it does not redefine them.
 *
 * Pure — no DOM, no browser APIs, testable in Node like the rest of src/core/.
 */

import { motionTerms } from './angle.js'

/** Display name per joint. Keys match the `joint` field on a saved session. */
export const JOINT_NAMES = {
  knee:     'Knee',
  hip:      'Hip',
  shoulder: 'Shoulder',
  elbow:    'Elbow',
  ankle:    'Ankle',
}

/**
 * Clinical positions offered per joint, first entry = default.
 *
 * This used to be a hardcoded prone/supine/seated row that was simply HIDDEN
 * for shoulder, elbow and ankle — but _position kept its 'prone' initial value
 * and was still stamped onto the saved session, so standing shoulder
 * measurements went into the patient record as "Prone". Every joint now offers
 * the positions it is actually measured in, so nothing is recorded that the
 * clinician did not pick.
 */
export const JOINT_POSITIONS = {
  knee:     ['prone', 'supine', 'seated'],
  hip:      ['supine', 'prone', 'seated'],
  shoulder: ['standing', 'seated'],
  elbow:    ['seated', 'standing'],
  ankle:    ['seated', 'standing'],
}

export const POSITION_NAMES = {
  prone:    'Prone',
  supine:   'Supine',
  seated:   'Seated',
  standing: 'Standing',
}

/** Positions offered for `joint`; unknown joints fall back to the knee list. */
export const positionsFor = (joint) => JOINT_POSITIONS[joint] ?? JOINT_POSITIONS.knee

/** Capitalise the first character. Internal — the maps above cover known values. */
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1)

/**
 * Split a session's joint field into base joint and side.
 *
 * Sessions saved before the joint/side split carry a combined
 * `joint: 'knee_right'` and no `side` field. Both shapes still live in the
 * store and neither can be migrated away, so every reader has to handle them.
 *
 * @param {{joint: string, side?: string}} session
 * @returns {{joint: string, side: string|null}}
 */
export function splitJoint(session) {
  const raw = String(session?.joint ?? '')
  if (session?.side) return { joint: raw, side: session.side }
  const [joint, side] = raw.split('_')
  return { joint, side: side || null }
}

/**
 * "Right Knee" — the joint and side of a session, for a heading or a row.
 * Falls back to the raw value for an unrecognised joint rather than blanking.
 *
 * @param {{joint: string, side?: string}} session
 * @returns {string}
 */
export function jointLabel(session) {
  const { joint, side } = splitJoint(session)
  const name = JOINT_NAMES[joint] ?? joint
  return side ? `${cap(side)} ${name}` : name
}

/** "Right" / "Left". */
export function sideLabel(side) {
  return side ? cap(side) : ''
}

/**
 * "Prone", or null when no position was recorded.
 *
 * Null is meaningful: setContext() deliberately leaves an unchosen position
 * absent rather than defaulting one in, and the views omit the badge entirely
 * rather than inventing a position the clinician never picked.
 *
 * @param {string|null|undefined} position
 * @returns {string|null}
 */
export function positionLabel(position) {
  if (!position) return null
  return POSITION_NAMES[position] ?? cap(position)
}

/**
 * "Flexion" / "Elevation" / "Dorsiflexion" — the positive motion, capitalised,
 * for a chart axis title.
 *
 * @param {string} joint - accepts the legacy combined 'knee_right' form
 * @returns {string}
 */
export function motionLabel(joint) {
  return cap(motionTerms(joint).positive)
}

/**
 * Names for a session's two extremes, given where its minimum sits.
 *
 * The min is only the NEGATIVE motion when the value actually crossed the zero
 * point. An un-zeroed shoulder resting at 24.6° of elevation was once
 * captioned "Peak extension: 24.6°", which it is not — it is the minimum
 * elevation reached. Below zero the joint really did travel past neutral, and
 * "Peak extension" is then correct.
 *
 * The snapshot captions and the stat cards both read from here so the picture
 * and the number above it can never describe the same frame differently.
 *
 * @param {string} joint - accepts the legacy combined 'knee_right' form
 * @param {number} min   - the session's minimum angle, signed
 * @returns {{maxLabel: string, minLabel: string}}
 */
export function extremeLabels(joint, min) {
  const terms = motionTerms(joint)
  return {
    maxLabel: `Peak ${terms.positive}`,
    minLabel: min < 0 ? `Peak ${terms.negative}` : `Min ${terms.positive}`,
  }
}

/**
 * The clinical arc, "5° – 120°" — how a range of motion is documented.
 *
 * Deliberately NOT max-min. A knee lacking 5° of extension and one with full
 * extension both subtract to the same total, and the deficit is the finding.
 *
 * @param {number} min - signed
 * @param {number} max - signed
 * @returns {string}
 */
export function romArc(min, max) {
  return `${min}° – ${max}°`
}

// ─── Date, time and duration ──────────────────────────────────────────────
//
// These three lived privately in HistoryView and SessionDetailView as verbatim
// copies, differing only in whether the date carried a weekday. report.js needs
// all three, which would have made a third copy — the same drift this module
// exists to prevent. Moved here unchanged; both original call sites must still
// produce byte-identical output.

/**
 * "Aug 12" / "Tue, Aug 12" / "Tue, Aug 12, 2026" from a 'YYYY-MM-DD' date.
 *
 * The parts are split and fed to the Date constructor rather than parsed:
 * `new Date('2026-08-12')` is UTC midnight, which renders as the 11th anywhere
 * west of Greenwich, and a session's date is a local calendar day.
 *
 * @param {string} dateStr - 'YYYY-MM-DD' as stored on a session
 * @param {{weekday?: boolean, year?: boolean}} [opts]
 * @returns {string}
 */
export function formatSessionDate(dateStr, { weekday = false, year = false } = {}) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    ...(weekday ? { weekday: 'short' } : {}),
    month: 'short',
    day:   'numeric',
    ...(year ? { year: 'numeric' } : {}),
  })
}

/**
 * "3:42 PM" from an epoch-millisecond timestamp, in the device's timezone.
 *
 * @param {number} timestamp
 * @returns {string}
 */
export function formatSessionTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true
  })
}

/**
 * "42s" / "1m 4s" — a recording length, not a clock time.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
