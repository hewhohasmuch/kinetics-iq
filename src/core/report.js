/**
 * report.js
 *
 * Turns a saved session into a block of text a clinician can paste into the
 * EHR note.
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
import { sessionProvenance, calibrationSummary } from './provenance.js'

/**
 * Build the paste-ready summary of one session.
 *
 * @param {Session} session
 * @returns {string} newline-separated plain text
 */
export function sessionNoteText(session) {
  const s = session ?? {}
  const lines = []

  // Heading. A null position is dropped with its separator — the recorder
  // leaves an unchosen position absent rather than inventing one, and a
  // dangling em dash would read as a missing word rather than an absent field.
  const position = positionLabel(s.position)
  lines.push(position ? `${jointLabel(s)} — ${position}` : jointLabel(s))

  lines.push(`${formatSessionDate(s.date, { weekday: true, year: true })} ${formatSessionTime(s.timestamp)}`)

  // The arc is the finding; the total is secondary. A knee lacking 5° of
  // extension and one with full extension subtract to the same total.
  lines.push(`ROM ${romArc(s.min, s.max)} (${s.rom}° total)`)

  // Named per joint and per side of zero, from the same helper the stat cards
  // and snapshot captions use. Values stay signed.
  const { maxLabel, minLabel } = extremeLabels(s.joint, s.min)
  lines.push(`${maxLabel} ${s.max}°`)
  lines.push(`${minLabel} ${s.min}°`)

  lines.push(`Duration ${formatDuration(s.duration_s)}, ${s.samples} samples`)

  // Always emitted, including the "not recorded" case: a note that silently
  // omits whether this was a raw or a zeroed measurement is claiming neither.
  lines.push(calibrationSummary(s).text)

  // The most important line when it appears. Prefixed with a glyph rather than
  // any markup, so it survives a paste into a plain-text note field.
  const prov = sessionProvenance(s)
  if (prov.level !== 'ok') {
    lines.push(`⚠ ${prov.label} — ${warningTail(prov.level)}`)
  }

  const notes = String(s.notes ?? '').trim()
  if (notes) lines.push(`Note: ${notes}`)

  lines.push('Measured with KineticsIQ')

  return lines.join('\n')
}

/**
 * The one-sentence version of a provenance reason. The tooltip text in
 * provenance.js is a paragraph — right for a screen you can hover, too long for
 * a chart note — but the verdict it carries must not soften on the way here.
 */
function warningTail(level) {
  return level === 'convention'
    ? 'these numbers cannot be compared or corrected.'
    : 'recorded through the old moving-average filter; the range reads low.'
}
