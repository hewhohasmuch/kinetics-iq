/**
 * extremes.js
 *
 * The single accessor deciding which numbers a session REPORTS as its range.
 *
 * WHY THIS EXISTS
 * A session carries two kinds of extreme. The model's — min/max/rom, produced
 * by the filter chain across the whole recording — and, once a clinician has
 * placed the landmarks themselves on a stored frame, a verified ENDPOINT
 * OBSERVATION. Every consumer (History rows and trend chart, SessionDetail,
 * the clipboard note, the PDF, the extension-floor caveat) must agree on which
 * it is showing, so they all read it from here.
 *
 * VERIFICATION IS AN ANNOTATION LAYER, NOT A REWRITE OF HISTORY.
 * Nothing here writes anything. `session.min`, `session.max`, `session.rom`
 * and `session.angleTimeline` are never modified by verification, and this
 * module never touches them — it chooses between them and the annotation.
 *
 * THE DISTINCTION THAT MATTERS MOST — read before changing this file:
 * A verified peak is NOT a recomputed timeline maximum. Only the two stored
 * extreme frames have snapshots, so only they can be verified. If a clinician
 * verifies the peak DOWNWARD, some other frame in `angleTimeline` may hold a
 * higher value — and that frame cannot be verified, because no image of it
 * exists. So a verified maximum is authoritative as an OBSERVATION AT AN
 * ENDPOINT and never as "the largest angle reached". ROM between verified
 * endpoints is therefore a different quantity from ROM across the raw
 * timeline, and can legitimately be NARROWER. `endpointsOnly` is how a
 * consumer knows it is holding that quantity, and it must be attributed in
 * any wording the clinician reads.
 *
 * WHY THE FIELDS ARE NAMED `reported*` AND WHY THERE IS NO `min`/`max`
 * The values' meaning changes with their source: unverified, they genuinely
 * ARE the timeline extrema; verified, they are endpoint observations. Any
 * name asserting one of those would be false in the other case, so the fields
 * assert only that these are the numbers the session reports.
 *
 * Deliberately, NO key is called `min` or `max`. The failure this prevents is
 * a future caller writing `const { min, max } = reportedExtremes(s)` and
 * reading the result as the extrema of the motion. With no such keys that
 * destructure yields `undefined` and breaks loudly at the first use, instead
 * of silently producing a wrong clinical claim. Do not add them back.
 *
 * PURE LOGIC — no DOM, no localStorage, no network.
 */

/**
 * The current verification for a session, or null.
 *
 * `verifications` is an array so that full history can be added later without
 * a migration, but TODAY IT HOLDS AT MOST ONE ELEMENT (storage.js asserts
 * this). Reading the last element is what makes that future change compatible.
 *
 * Absence is a distinct third state: null or [] means NEVER VERIFIED, which is
 * not the same claim as "verified and found unchanged".
 *
 * @param {object} session
 * @returns {object|null}
 */
export function currentVerification(session) {
  const list = session?.verifications
  if (!Array.isArray(list) || list.length === 0) return null
  return list[list.length - 1] ?? null
}

/**
 * Which numbers this session reports as its range, and where they came from.
 *
 * With no verification present this returns the raw values unchanged and
 * `source: 'model'`, so adopting it anywhere is behaviour-identical.
 *
 * Verification can be PARTIAL — a session may have only one usable snapshot,
 * or the clinician may verify only the end that matters — so each end carries
 * its own source and `source` is a rollup that can read 'mixed'. Collapsing a
 * partial verification to either 'model' or 'clinician' would state something
 * false about one of the two numbers.
 *
 * @param {object} session
 * @returns {{
 *   reportedMin: number, reportedMax: number, reportedRom: number,
 *   minSource: 'model'|'clinician', maxSource: 'model'|'clinician',
 *   source: 'model'|'clinician'|'mixed',
 *   endpointsOnly: boolean
 * }}
 */
export function reportedExtremes(session) {
  const v      = currentVerification(session)
  const angles = v?.angles ?? {}

  // Only a real number counts as verified. null/undefined means that end was
  // not verified — not that it was verified as zero.
  const vMin = Number.isFinite(angles.min) ? angles.min : null
  const vMax = Number.isFinite(angles.max) ? angles.max : null

  const minSource = vMin === null ? 'model' : 'clinician'
  const maxSource = vMax === null ? 'model' : 'clinician'

  const reportedMin = vMin ?? session?.min
  const reportedMax = vMax ?? session?.max

  const source = minSource === maxSource ? minSource : 'mixed'

  // Untouched sessions must report EXACTLY what they stored — recomputing
  // max-min from two already-rounded values can differ in the last decimal
  // from the stored `rom`, which was rounded once from the unrounded pair.
  // That difference would look like a data change caused by adopting this
  // accessor, which is precisely what must not happen.
  const reportedRom = source === 'model'
    ? session?.rom
    : Math.round((reportedMax - reportedMin) * 10) / 10

  return {
    reportedMin,
    reportedMax,
    reportedRom,
    minSource,
    maxSource,
    source,
    // True as soon as EITHER end is a verified endpoint observation: the pair
    // can then no longer be described as the extrema of the motion.
    endpointsOnly: source !== 'model',
  }
}
