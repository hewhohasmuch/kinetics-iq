/**
 * pdf.js
 *
 * Renders saved sessions as a PDF a clinician can attach to a chart.
 *
 * WHY A PDF AND NOT THE CLIPBOARD TEXT:
 * "Copy for note" (report.js) puts a text block on the clipboard for pasting
 * into a note field. That reaches the note and nothing else — the two annotated
 * snapshots, which are the most persuasive part of the record, could not travel
 * at all. eClinicalWorks, WebPT and Prompt all attach outside documents through
 * an upload module built around PDF, so a PDF is what actually lands in a
 * chart. The clipboard path stays; pasting into a note is a different job and
 * a faster one.
 *
 * NOTHING HERE COMPOSES A CLINICAL STRING. Every line comes from
 * sessionReportModel(), the same model sessionNoteText() renders, so the note
 * and the document cannot disagree about the same measurement. This module owns
 * layout — where a line sits on the page — and nothing about what it says.
 *
 * NO PATIENT IDENTIFIER IN THE DOCUMENT. report.js omits name, DOB and MRN
 * because the clipboard is a promiscuous surface, and a page filed into a chart
 * is permanent, so nothing here ever prints one. `buildSessionPdf` is never
 * given a patient record at all — see pdfFilename below.
 *
 * THE FILENAME IS THE EXCEPTION, AND DELIBERATELY SO. The original rule was
 * inherited from the clipboard, where the clinician is already inside the chart
 * when they paste. A file is not so lucky: it travels phone → Files → cloud →
 * desktop → EHR upload, and at every step nothing said who it belonged to — two
 * right-knee sessions exported the same day produced byte-identical filenames.
 * The risk there is not exposure but MIS-FILING, which is its own incident and
 * the worse of the two. So the filename carries a timestamp always, and the
 * patient's INITIALS when the clinician leaves the setting on. Both live only
 * in the name, so the identifier exists exactly during the transit window and
 * is gone once the EHR files the document under its own naming.
 *
 * ── THE ENCODING TRAP ────────────────────────────────────────────────────
 * jsPDF's built-in Helvetica is WinAnsi-encoded. `°` (0xB0) and the en dash
 * `–` (0x96) are both in WinAnsi and render correctly, which matters because
 * romArc() puts both on the headline. But a character WinAnsi cannot represent
 * does NOT simply drop itself — jsPDF re-encodes the WHOLE STRING as UTF-16,
 * which the base font renders as garbage. One `⚠`, or one emoji typed into a
 * note on a phone keyboard, corrupts its entire line.
 *
 * So: the note's `⚠` prefix must never reach this module (the warning is drawn
 * as a filled band instead), and every string that reaches doc.text() goes
 * through winAnsi() first. Verified against jsPDF 4.x by inspecting the emitted
 * content stream, not assumed.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Images are passed IN rather than fetched here, which keeps this module free
 * of IndexedDB and the network — frames.js owns that — and testable in Node
 * against a mocked jsPDF.
 */

import { sessionReportModel, ATTRIBUTION } from './report.js'
import { extremeLabels, jointLabel, formatSessionDate } from './labels.js'
import { reportedExtremes } from './extremes.js'

// US Letter in points. Portrait: a page filed alongside other chart documents.
const PAGE = { w: 612, h: 792 }
const MARGIN = 54                      // 0.75" — survives any printer's margin
const CONTENT_W = PAGE.w - MARGIN * 2

const COLOR = {
  ink:     [23, 23, 23],
  muted:   [110, 110, 110],
  rule:    [214, 214, 214],
  accent:  [21, 128, 61],              // the ROM arc — dark enough to photocopy
  warnBg:  [254, 243, 199],
  warnInk: [124, 76, 6],
}

/**
 * Characters WinAnsi (CP1252) can represent. Anything else would flip the whole
 * string to UTF-16 and render as garbage — see the encoding trap above.
 */
const CP1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'

/**
 * Make a string safe to hand to doc.text().
 *
 * Unrepresentable characters are replaced rather than stripped, so a note
 * containing an emoji degrades to a visible '?' instead of silently losing a
 * word — and, critically, without dragging the rest of the line into UTF-16.
 *
 * @param {string} s
 * @returns {string}
 */
export function winAnsi(s) {
  // Iterated by code POINT, not code unit: an emoji is one surrogate pair and
  // should degrade to one marker, not two.
  return String(s ?? '').replace(/./gsu, (ch) => {
    const c = ch.codePointAt(0)
    if (c === 0x0a || c === 0x0d) return ch
    if (c >= 0x20 && c <= 0x7e) return ch
    if (c >= 0xa0 && c <= 0xff) return ch
    if (CP1252_EXTRA.includes(ch)) return ch
    return '?'
  })
}

/**
 * A filename for one or more sessions.
 *
 * `initials` is an already-derived STRING, never a patient record — this module
 * is deliberately incapable of learning a patient's name, which is what makes
 * "no identifier in the document" a property of the module boundary rather than
 * of anyone's discipline. Callers derive it with `patientInitials()` and pass it
 * only when the clinician has left the setting on. See exportPdf.js.
 *
 * The TIME matters as much as the initials. Two sessions of the same joint on
 * the same day used to produce byte-identical filenames, which is the worst
 * possible property for a file about to be filed into a chart. For a single
 * session the time is the SESSION's, not the export's: it is what distinguishes
 * two measurements, and it makes re-exporting the same session idempotent.
 *
 * @param {Session[]} sessions
 * @param {{initials?: string}} [opts]
 * @returns {string}
 */
export function pdfFilename(sessions, { initials = '' } = {}) {
  const list = sessions ?? []
  const who  = initials ? `${slug(initials)}-` : ''

  if (list.length === 1) {
    const s = list[0]
    return `kineticsiq-${who}${slug(jointLabel(s))}-${s.date}-${hhmm(s.timestamp)}.pdf`
  }

  const now = new Date()
  return `kineticsiq-${who}${list.length}-sessions-${ymd(now)}-${hhmm(now.getTime())}.pdf`
}

const pad = (n) => String(n).padStart(2, '0')

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function hhmm(timestamp) {
  const d = new Date(timestamp ?? Date.now())
  return `${pad(d.getHours())}${pad(d.getMinutes())}`
}

/**
 * Build the document.
 *
 * @param {Session[]} sessions - rendered oldest first, one page each
 * @param {Map<string, {peak: Blob|null, min: Blob|null}>} imagesBySessionId
 * @returns {Promise<Blob>}
 */
export async function buildSessionPdf(sessions, imagesBySessionId = new Map()) {
  const list = [...(sessions ?? [])].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
  if (list.length === 0) throw new Error('buildSessionPdf: no sessions given')

  // Dynamic import: jsPDF becomes its own Vite chunk instead of riding in the
  // initial bundle. The emitted chunk is a .js file in dist, so the existing
  // Workbox precache glob covers it and generation still works offline.
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true })

  for (let i = 0; i < list.length; i++) {
    if (i > 0) doc.addPage()
    await renderSessionPage(doc, list[i], imagesBySessionId.get(list[i].id) ?? {})
    drawFooter(doc, i + 1, list.length)
  }

  return doc.output('blob')
}

// ─── One page ──────────────────────────────────────────────────────────────

async function renderSessionPage(doc, session, images) {
  const m = sessionReportModel(session)
  let y = MARGIN

  // Heading
  setInk(doc, COLOR.ink)
  doc.setFont('helvetica', 'bold').setFontSize(18)
  doc.text(winAnsi(m.heading), MARGIN, y)
  y += 18

  setInk(doc, COLOR.muted)
  doc.setFont('helvetica', 'normal').setFontSize(10)
  doc.text(winAnsi(m.dateLine), MARGIN, y)
  y += 16

  y = rule(doc, y)

  // ── The measurement. The arc leads, at a size that reads across a desk.
  setInk(doc, COLOR.accent)
  doc.setFont('helvetica', 'bold').setFontSize(24)
  doc.text(winAnsi(m.romLine), MARGIN, y + 8)
  y += 34

  // Both extremes, named per joint and per side of zero.
  setInk(doc, COLOR.ink)
  doc.setFontSize(11)
  for (const [label, value] of [[m.maxLabel, m.maxValue], [m.minLabel, m.minValue]]) {
    doc.setFont('helvetica', 'normal')
    doc.text(winAnsi(label), MARGIN, y)
    doc.setFont('helvetica', 'bold')
    doc.text(winAnsi(value), MARGIN + 150, y)
    y += 15
  }

  y += 4
  setInk(doc, COLOR.muted)
  doc.setFont('helvetica', 'normal').setFontSize(10)
  doc.text(winAnsi(m.durationLine), MARGIN, y)
  y += 13

  // Always emitted — a document that omits whether this was raw or zeroed is
  // claiming neither, and those are different measurements.
  doc.text(winAnsi(m.calibrationLine), MARGIN, y)
  y += 16

  // One band each. A session can be on the legacy scale AND report an
  // un-zeroed minimum, and a document that prints only the first is the same
  // failure this module exists to prevent.
  for (const w of m.warnings) y = drawWarning(doc, y, w)

  if (m.notes) {
    y += 4
    setInk(doc, COLOR.ink)
    doc.setFont('helvetica', 'italic').setFontSize(10)
    const wrapped = doc.splitTextToSize(winAnsi(`Note: ${m.notes}`), CONTENT_W)
    doc.text(wrapped, MARGIN, y)
    y += wrapped.length * 13
  }

  y = rule(doc, y + 8)
  await drawFrames(doc, y, session, images)
}

/**
 * One caveat band — legacy provenance, or a minimum that cannot be separated
 * from the measurement floor. Called once per entry in the model's `warnings`.
 *
 * Drawn as a filled block rather than prefixed with the note's `⚠`, which the
 * base font cannot render (see the encoding trap). The wording is the model's,
 * unchanged — only the marking differs between the two media.
 */
function drawWarning(doc, y, warning) {
  // The model's wording is phrased to follow a dash in the note ("Legacy scale
  // — these numbers…"). Standing alone under a heading here, it needs its own
  // capital; the words themselves are unchanged.
  const sentence = warning.tail.charAt(0).toUpperCase() + warning.tail.slice(1)

  doc.setFont('helvetica', 'normal').setFontSize(9.5)
  const body = doc.splitTextToSize(winAnsi(sentence), CONTENT_W - 24)
  const h = 20 + body.length * 12

  doc.setFillColor(...COLOR.warnBg)
  doc.rect(MARGIN, y - 2, CONTENT_W, h, 'F')

  setInk(doc, COLOR.warnInk)
  doc.setFont('helvetica', 'bold').setFontSize(9.5)
  doc.text(winAnsi(warning.label.toUpperCase()), MARGIN + 12, y + 13)
  doc.setFont('helvetica', 'normal')
  doc.text(body, MARGIN + 12, y + 26)

  return y + h + 10
}

/**
 * The two annotated snapshots, side by side beneath the numbers.
 *
 * An unresolvable frame prints its caption with a note rather than vanishing:
 * a silently absent picture looks like a session that never captured one, which
 * is a different fact from one whose cache was evicted while offline.
 */
async function drawFrames(doc, y, session, images) {
  // The reported minimum, so a caption can never name a different motion from
  // the stat card above it — extremeLabels decides between "Peak extension" and
  // "Min flexion", which are claims about different things.
  const { maxLabel, minLabel } = extremeLabels(session.joint, reportedExtremes(session).reportedMin)
  const specs = [
    { which: 'peak', caption: maxLabel, blob: images.peak ?? null },
    { which: 'min',  caption: minLabel, blob: images.min  ?? null },
  ]

  const gap    = 16
  const cellW  = (CONTENT_W - gap) / 2
  const availH = PAGE.h - MARGIN - 24 - y - 16   // leave room for the footer

  setInk(doc, COLOR.muted)
  doc.setFont('helvetica', 'normal').setFontSize(9)

  for (let i = 0; i < specs.length; i++) {
    const x = MARGIN + i * (cellW + gap)
    const { caption, blob } = specs[i]

    if (!blob) {
      doc.text(winAnsi(`${caption} — image not available`), x, y + 12)
      continue
    }

    const placed = await placeImage(doc, blob, x, y, cellW, availH)
    doc.text(winAnsi(caption), x, y + placed.h + 12)
  }
}

/**
 * Draw one JPEG, letterboxed into its cell.
 *
 * Snapshots are capped at 1100px on the longest edge but are not a fixed shape,
 * so the aspect ratio is measured rather than assumed — a portrait capture
 * stretched to a landscape box would distort the very angle the picture exists
 * to document.
 */
async function placeImage(doc, blob, x, y, maxW, maxH) {
  const { width, height } = await imageSize(blob)
  const scale = Math.min(maxW / width, maxH / height)
  const w = width * scale
  const h = height * scale
  const dataUri = await blobToDataUri(blob)
  doc.addImage(dataUri, 'JPEG', x, y, w, h)
  return { w, h }
}

/** Natural pixel dimensions of an image blob. */
async function imageSize(blob) {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(blob)
    const size = { width: bmp.width, height: bmp.height }
    bmp.close?.()
    return size
  }
  // No createImageBitmap (older Safari): fall back to an <img>.
  const url = URL.createObjectURL(blob)
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload  = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
      img.onerror = reject
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function blobToDataUri(blob) {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const CHUNK = 0x8000        // chunked: apply() blows the stack on a ~150KB blob
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return `data:image/jpeg;base64,${btoa(binary)}`
}

// ─── Page furniture ────────────────────────────────────────────────────────

function drawFooter(doc, page, total) {
  const y = PAGE.h - MARGIN + 12
  setInk(doc, COLOR.muted)
  doc.setFont('helvetica', 'normal').setFontSize(8.5)
  doc.text(winAnsi(`${ATTRIBUTION}  ·  Generated ${formatSessionDate(todayIso(), { year: true })}`), MARGIN, y)
  if (total > 1) {
    doc.text(winAnsi(`Page ${page} of ${total}`), PAGE.w - MARGIN, y, { align: 'right' })
  }
}

function rule(doc, y) {
  doc.setDrawColor(...COLOR.rule).setLineWidth(0.5)
  doc.line(MARGIN, y, PAGE.w - MARGIN, y)
  return y + 18
}

function setInk(doc, rgb) {
  doc.setTextColor(...rgb)
}

function todayIso() {
  return ymd(new Date())
}
