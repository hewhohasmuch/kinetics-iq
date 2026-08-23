/**
 * report.js
 *
 * Turns a saved session into the words a clinician hands to the EHR — as a
 * structured model (sessionReportModel) and as the paste-ready plain text built
 * from it (sessionNoteText).
 *
 * THE MODEL IS THE POINT. There are two renderings of a session now, the
 * clipboard note and the exported PDF (pdf.js), and a second one composing its
 * own strings would be free to disagree with the first about the same
 * measurement. Both read the model; neither formats a clinical value itself.
 *
 * WHY THIS MODULE EXISTS:
 * The app produced a rich record — signed extremes, the ROM arc, position,
 * calibration provenance, two annotated snapshots — and then stranded it on a
 * phone. There was no export of any kind, so the numbers were read off the
 * screen and retyped, dropping every provenance stamp on the way. A paste-ready
 * block works against every EHR with no integration, no vendor review and no
 * waiting.
 *
 * WHAT THE TEXT MUST CARRY:
 * Everything that qualifies the numbers travels with them. The arc leads
 * because that is how goniometry is documented; the extremes are named by the
 * joint's own motion; the calibration line is ALWAYS emitted, because raw and
 * zeroed are different measurements; and a legacy session carries a warning,
 * because the one thing worse than not exporting a number is exporting a
 * known-bad one into a permanent medical record with no caveat.
 *
 * WHAT IT MUST NOT CARRY — patient name, DOB, MRN:
 * The clipboard is a promiscuous surface. On iOS any app can read it when the
 * user pastes, and Universal Clipboard syncs it to their other devices. The
 * clinician is already inside that patient's chart when they paste, so an
 * identifier here adds exposure and no information. report.test.js pins the
 * omission so it does not get helpfully added later.
 *
 * Every clinical string comes from an existing core helper — labels.js for the
 * arc and the extreme names, provenance.js for the two warnings — so the note
 * cannot disagree with the stat card or the snapshot caption about the same
 * number. Nothing is reimplemented here.
 *
 * Pure — no DOM, no browser APIs beyond Intl, testable in Node.
 */

import {
  jointLabel,
  positionLabel,
  romArc,
  extremeLabels,
  formatSessionDate,
  formatSessionTime,
  formatDuration,
} from './labels.js'
import { sessionProvenance, calibrationSummary, extensionFloorCaveat, verificationSummary } from './provenance.js'
import { reportedExtremes } from './extremes.js'

/** The trailing attribution, shared by every rendering of a session. */
export const ATTRIBUTION = 'Measured with KineticsIQ'

/**
 * The composed clinical strings for one session, as fields.
 *
 * WHY A MODEL AND NOT JUST THE TEXT:
 * There are now two renderings of a session — the clipboard note and the
 * exported PDF — and they must never disagree about the same measurement. That
 * is the same "one value, everywhere" rule the capture path follows for the
 * readout, the overlay, the burned-in snapshot label and the recorder. Both
 * renderings read this model; neither composes a clinical string of its own.
 *
 * The fields are already-formatted strings, not raw numbers, because the
 * formatting IS the clinical claim: `romArc` leads with the arc rather than the
 * subtraction, and `extremeLabels` decides whether a value is captioned "Peak
 * extension" or "Min flexion" — which are claims about different motions.
 *
 * @param {Session} session
 * @returns {{
 *   heading: string, dateLine: string, romLine: string,
 *   maxLabel: string, maxValue: string, minLabel: string, minValue: string,
 *   durationLine: string, calibrationLine: string,
 *   verification: {level: string, label: string, detail: string, attribution: string|null},
 *   warnings: Array<{level: string, label: string, tail: string}>,
 *   notes: string|null, attribution: string,
 * }}
 */
export function sessionReportModel(session) {
  const s = session ?? {}

  // A null position is dropped with its separator — the recorder leaves an
  // unchosen position absent rather than inventing one, and a dangling em dash
  // would read as a missing word rather than an absent field.
  const position = positionLabel(s.position)

  // Named per joint and per side of zero, from the same helper the stat cards
  // and snapshot captions use. Values stay signed.
  // Which numbers this session reports, and from where. For an unverified
  // session these are the stored values unchanged, so adopting the accessor is
  // behaviour-free; once a clinician has verified an endpoint they are that
  // observation instead.
  const e = reportedExtremes(s)
  const { reportedMin, reportedMax, reportedRom } = e

  const { maxLabel, minLabel } = extremeLabels(s.joint, reportedMin)

  const prov  = sessionProvenance(s)
  const notes = String(s.notes ?? '').trim()

  // NOT a warning, and deliberately not part of `warnings`: clinician
  // verification is an upgrade, and `warnings` is a list of defects that the
  // PDF paints amber. This gets its own field so one computation reaches the
  // History badge, the SessionDetail chip, the note and the PDF at once.
  const verification = verificationSummary(s)

  // Provenance leads: it invalidates the numbers outright, where the floor
  // caveat qualifies one of them. Both can apply to the same session.
  const warnings = []
  if (prov.level !== 'ok') {
    warnings.push({ level: prov.level, label: prov.label, tail: warningTail(prov.level) })
  }
  const floor = extensionFloorCaveat(s)
  if (floor) {
    warnings.push({ level: 'floor', label: floor.label, tail: floor.tail })
  }

  return {
    heading:  position ? `${jointLabel(s)} — ${position}` : jointLabel(s),
    dateLine: `${formatSessionDate(s.date, { weekday: true, year: true })} ${formatSessionTime(s.timestamp)}`,

    // The arc is the finding; the total is secondary. A knee lacking 5° of
    // extension and one with full extension subtract to the same total.
    romLine: e.endpointsOnly
      // ROM between verified endpoints is a DIFFERENT QUANTITY from ROM across
      // the raw timeline and can legitimately be narrower. Printing it
      // unattributed would read as the same measurement having improved.
      ? `ROM ${romArc(reportedMin, reportedMax)} (${reportedRom}° total, between clinician-verified endpoints)`
      : `ROM ${romArc(reportedMin, reportedMax)} (${reportedRom}° total)`,

    maxLabel,
    maxValue: `${reportedMax}°`,
    minLabel,
    minValue: `${reportedMin}°`,

    durationLine: `Duration ${formatDuration(s.duration_s)}, ${s.samples} samples`,

    // Always present, including the "not recorded" case: a report that silently
    // omits whether this was a raw or a zeroed measurement is claiming neither.
    calibrationLine: calibrationSummary(s).text,

    verification,

    // The most important field when it is non-empty. Entries carry no glyph
    // and no markup — each rendering marks them however its medium supports,
    // and a glyph baked in here would corrupt the PDF outright (pdf.js).
    //
    // A LIST because a session can carry more than one caveat at once: a record
    // can be on the legacy scale AND report an un-zeroed minimum. This was a
    // single field, which silently dropped whichever caveat came second.
    warnings,

    notes: notes || null,
    attribution: ATTRIBUTION,
  }
}

/**
 * Build the paste-ready summary of one session.
 *
 * A plain-text rendering of sessionReportModel() and nothing more — every
 * clinical string above is composed there so this and the PDF cannot drift.
 *
 * @param {Session} session
 * @returns {string} newline-separated plain text
 */
export function sessionNoteText(session) {
  const m = sessionReportModel(session)
  const lines = [
    m.heading,
    m.dateLine,
    m.romLine,
    `${m.maxLabel} ${m.maxValue}`,
    `${m.minLabel} ${m.minValue}`,
    m.durationLine,
    m.calibrationLine,
  ]

  // Stated on every session, model-measured included: a note that mentions
  // verification only when it happened would leave the reader guessing what
  // silence meant.
  lines.push(m.verification.attribution
    ? `${m.verification.label} — ${m.verification.attribution}`
    : m.verification.label)

  // Prefixed with a glyph rather than any markup, so it survives a paste into a
  // plain-text note field. (The PDF cannot use this character — see pdf.js.)
  // One line each: a session carrying two caveats must state both.
  for (const w of m.warnings) lines.push(`⚠ ${w.label} — ${w.tail}`)

  if (m.notes) lines.push(`Note: ${m.notes}`)

  lines.push(m.attribution)

  return lines.join('\n')
}

/**
 * The one-sentence version of a provenance reason. The tooltip text in
 * provenance.js is a paragraph — right for a screen you can hover, too long for
 * a chart note — but the verdict it carries must not soften on the way here.
 */
function warningTail(level) {
  if (level === 'convention') return 'these numbers cannot be compared or corrected.'
  if (level === 'depth')      return 'measured from monocular depth, which understates range; ' +
                                     'the total reads low by an unknown amount.'
  return 'recorded through the old moving-average filter; the range reads low.'
}
