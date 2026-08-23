/**
 * pdf.test.js
 *
 * Tests for the document a clinician attaches to a permanent medical record.
 *
 * Same discipline as report.test.js — the wording IS the clinical claim — plus
 * two things unique to a PDF:
 *
 *   THE ENCODING TRAP. jsPDF's base Helvetica is WinAnsi. A character it cannot
 *   represent does not drop itself; jsPDF re-encodes the WHOLE STRING as UTF-16
 *   and the base font renders it as garbage. So one emoji typed into a note on
 *   a phone would corrupt that entire line, and the note's `⚠` prefix would
 *   corrupt the most important line in the document. Every string reaching
 *   doc.text() is pinned as WinAnsi-representable.
 *
 *   THE FILENAME IS PART OF THE EXPORT. A file is more detachable than a
 *   clipboard paste — it sits in Files, it can be mailed — so the no-identifier
 *   rule report.test.js pins for the text is pinned here for the filename too.
 *
 * jsPDF is mocked: these assert what the document is TOLD to draw, which is the
 * part that carries clinical meaning. That the bytes are a valid PDF is checked
 * end-to-end instead — see the verification notes in CLAUDE.md.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

/** Every text()/addImage() call the module makes, in order. */
let drawn
/**
 * The stub models text WIDTH, not just calls, because pdf.js now shrinks the
 * ROM headline to fit. A stub returning 0 would let an overflowing headline
 * pass the tests and ship truncated — which is exactly what happened once.
 */
let fontSize = 10

const docStub = {
  text: vi.fn((s, x, y) => {
    for (const line of Array.isArray(s) ? s : [s]) {
      drawn.texts.push(String(line))
      drawn.sized.push({ text: String(line), size: fontSize })
    }
  }),
  addImage:  vi.fn((...a) => drawn.images.push(a)),
  addPage:   vi.fn(() => { drawn.pages++ }),
  splitTextToSize: (s, _w) => String(s).split('\n'),
  setFont: vi.fn(() => docStub),
  setFontSize: vi.fn((s) => { fontSize = s; return docStub }),
  // Rough but monotonic in both length and size, which is all the fit loop needs.
  getTextWidth: vi.fn((s) => String(s).length * fontSize * 0.5),
  setTextColor: vi.fn(() => docStub),
  setFillColor: vi.fn(() => docStub),
  setDrawColor: vi.fn(() => docStub),
  setLineWidth: vi.fn(() => docStub),
  rect: vi.fn(() => docStub),
  line: vi.fn(() => docStub),
  output: vi.fn(() => new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' })),
  internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
}

vi.mock('jspdf', () => ({ jsPDF: vi.fn(() => docStub) }))

import { buildSessionPdf, pdfFilename, winAnsi } from './pdf.js'

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

/** A tiny valid-enough JPEG stand-in; only its bytes and size are used. */
function fakeJpeg() {
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], { type: 'image/jpeg' })
}

beforeEach(() => {
  drawn = { texts: [], images: [], pages: 1, sized: [] }
  fontSize = 10
  vi.clearAllMocks()
  // pdf.js measures the natural size of each snapshot before placing it.
  globalThis.createImageBitmap = vi.fn(async () => ({ width: 800, height: 1100, close() {} }))
})

const allText = () => drawn.texts.join('\n')

// ─── The measurement ───────────────────────────────────────────────────────

describe('buildSessionPdf — the measurement', () => {

  it('leads with the ROM arc and keeps the total secondary', async () => {
    await buildSessionPdf([makeSession()])
    expect(allText()).toContain('ROM 5° – 120° (115° total)')
  })

  it('names both extremes per joint rather than "min" and "max"', async () => {
    await buildSessionPdf([makeSession()])
    expect(allText()).toContain('Peak flexion')
    expect(allText()).toContain('Min flexion')
  })

  it('calls the minimum an extension peak only once it crosses zero', async () => {
    await buildSessionPdf([makeSession({ min: -4, rom: 124 })])
    expect(allText()).toContain('Peak extension')
  })

  it('uses the joint\'s own motion words, not a blanket "flexion"', async () => {
    await buildSessionPdf([makeSession({ joint: 'ankle', side: 'left', position: 'seated' })])
    expect(allText().toLowerCase()).toContain('dorsiflexion')
  })

  it('takes every clinical line from sessionReportModel, not its own formatting', async () => {
    const { sessionReportModel } = await import('./report.js')
    const s = makeSession({ notes: 'day 14 post-op' })
    const m = sessionReportModel(s)

    await buildSessionPdf([s])
    const text = allText()

    for (const line of [m.heading, m.dateLine, m.romLine, m.durationLine, m.calibrationLine]) {
      expect(text).toContain(line)
    }
  })
})

// ─── Provenance and calibration ────────────────────────────────────────────

describe('buildSessionPdf — provenance', () => {

  it('warns on a session recorded before the per-joint convention', async () => {
    await buildSessionPdf([makeSession({ angleConvention: undefined })])
    const text = allText()
    expect(text).toContain('LEGACY SCALE')
    expect(text).toContain('cannot be compared or corrected')
    // Standing alone under a heading, the sentence gets its own capital.
    expect(text).toContain('These numbers cannot be compared')
  })

  it('warns that a legacy-filter session reads low', async () => {
    await buildSessionPdf([makeSession({ angleFilter: undefined })])
    expect(allText()).toContain('reads low')
  })

  it('draws the warning as a filled band, never the ⚠ the base font lacks', async () => {
    await buildSessionPdf([makeSession({ angleConvention: undefined })])
    expect(allText()).not.toContain('⚠')
    expect(docStub.rect).toHaveBeenCalled()      // the band itself
  })

  it('stays clean for a current session', async () => {
    await buildSessionPdf([makeSession()])
    expect(allText()).not.toMatch(/LEGACY/i)
    expect(allText()).not.toMatch(/measurement floor/i)
  })

  // The stamps cannot catch this one: every stamp on this session is current,
  // so the document would otherwise print "5° – 120°" — a claimed extension
  // deficit — with nothing qualifying it.
  it('warns that an un-zeroed minimum may be the measurement floor', async () => {
    await buildSessionPdf([makeSession({ calibrated: false, min: 9 })])
    const text = allText()
    expect(text).toContain('MINIMUM MAY BE MEASUREMENT FLOOR')
    expect(text).toContain('should not be read as an extension deficit')
  })

  // A single warning field printed only the first of these.
  it('stacks a band for each caveat when a session is legacy AND un-zeroed', async () => {
    await buildSessionPdf([makeSession({
      angleConvention: undefined, calibrated: false, min: 9,
    })])
    const text = allText()
    expect(text).toContain('LEGACY SCALE')
    expect(text).toContain('MINIMUM MAY BE MEASUREMENT FLOOR')
    expect(allText()).not.toContain('⚠')
  })

  it('always states the calibration, including when it was never recorded', async () => {
    await buildSessionPdf([makeSession({ calibrated: undefined, calibrationOffset: undefined })])
    const text = allText()
    expect(text).toContain('Calibration not recorded')
    // "never recorded" and "measured raw" are different claims about the
    // measurement and must not collapse into each other.
    expect(text).not.toContain('Not zeroed')
  })

  it('distinguishes a raw measurement from an unrecorded one', async () => {
    await buildSessionPdf([makeSession({ calibrated: false, calibrationOffset: 0 })])
    expect(allText()).toContain('Not zeroed')
  })

  it('treats a captured offset of exactly 0 as a real calibration', async () => {
    await buildSessionPdf([makeSession({ calibrated: true, calibrationOffset: 0 })])
    expect(allText()).toContain('Zeroed at 0°')
  })
})

// ─── Snapshots ─────────────────────────────────────────────────────────────

describe('buildSessionPdf — snapshots', () => {

  it('places both frames when they resolve', async () => {
    const images = new Map([['c0ffee00-0000-4000-8000-000000000000',
      { peak: fakeJpeg(), min: fakeJpeg() }]])
    await buildSessionPdf([makeSession()], images)
    expect(drawn.images).toHaveLength(2)
  })

  it('preserves aspect ratio rather than stretching to the cell', async () => {
    const images = new Map([['c0ffee00-0000-4000-8000-000000000000',
      { peak: fakeJpeg(), min: null }]])
    await buildSessionPdf([makeSession()], images)

    // addImage(data, fmt, x, y, w, h) — 800x1100 source
    const [, , , , w, h] = drawn.images[0]
    expect(h / w).toBeCloseTo(1100 / 800, 2)
  })

  it('says a frame is unavailable rather than silently omitting it', async () => {
    await buildSessionPdf([makeSession()], new Map())
    expect(allText()).toContain('image not available')
    expect(drawn.images).toHaveLength(0)
  })
})

// ─── Multi-session ─────────────────────────────────────────────────────────

describe('buildSessionPdf — multiple sessions', () => {

  it('gives each session its own page', async () => {
    await buildSessionPdf([
      makeSession({ id: 'a', timestamp: 2000 }),
      makeSession({ id: 'b', timestamp: 3000 }),
      makeSession({ id: 'c', timestamp: 4000 }),
    ])
    expect(docStub.addPage).toHaveBeenCalledTimes(2)   // 3 pages, 2 breaks
  })

  it('orders pages oldest first regardless of the order given', async () => {
    await buildSessionPdf([
      makeSession({ id: 'newer', timestamp: 9000, max: 130, rom: 125 }),
      makeSession({ id: 'older', timestamp: 1000, max: 110, rom: 105 }),
    ])
    const text = allText()
    expect(text.indexOf('110°')).toBeLessThan(text.indexOf('130°'))
  })

  it('refuses an empty selection rather than emitting a blank document', async () => {
    await expect(buildSessionPdf([])).rejects.toThrow(/no sessions/i)
  })
})

// ─── PHI ───────────────────────────────────────────────────────────────────

describe('buildSessionPdf — PHI', () => {

  // THIS IS THE LOAD-BEARING ONE. The filename now carries initials by
  // arrangement (see the filename suite below), so the document is the only
  // place the no-identifier rule still holds absolutely — and it is the part
  // that ends up permanently in a chart. buildSessionPdf is never handed a
  // patient record at all, which is what makes this structural rather than a
  // matter of remembering.
  it('carries no patient identifier anywhere in the document', async () => {
    const s = makeSession({
      patient_id:   'b0b0b0b0-0000-4000-8000-000000000000',
      patientName:  'Jane Q. Patient',
      patient_name: 'Jane Q. Patient',
      dob:          '1979-03-02',
      mrn:          'MRN-88213',
    })
    await buildSessionPdf([s])
    const text = allText()

    expect(text).not.toContain('Jane')
    expect(text).not.toContain('Patient')
    expect(text).not.toContain('1979')
    expect(text).not.toContain('MRN-88213')
    expect(text).not.toContain('b0b0b0b0')
  })

})

// ─── The filename ──────────────────────────────────────────────────────────
//
// This suite REVERSES an earlier rule on purpose, so it says why. The original
// export carried no identifier at all, inherited from the clipboard note where
// the clinician is already inside the chart when they paste. A file is not so
// lucky — it travels phone → Files → cloud → desktop → EHR upload identified by
// nothing but its name, and two right-knee sessions on one day produced
// BYTE-IDENTICAL filenames. The risk there is mis-filing, not exposure, and
// mis-filing PHI into the wrong chart is the worse incident.
//
// So: a timestamp always, and initials when the caller asks for them. Both live
// only in the name. The document itself is still pinned identifier-free above.

describe('pdfFilename — telling two exports apart', () => {

  it('distinguishes two same-day sessions of the same joint by time', () => {
    const morning = pdfFilename([makeSession({ timestamp: new Date(2026, 7, 12, 9, 14).getTime() })])
    const later   = pdfFilename([makeSession({ timestamp: new Date(2026, 7, 12, 14, 42).getTime() })])
    expect(morning).not.toBe(later)
    expect(morning).toContain('0914')
    expect(later).toContain('1442')
  })

  it('uses the session\'s time, not the export time, so re-exporting is stable', () => {
    const s = makeSession()
    expect(pdfFilename([s])).toBe(pdfFilename([s]))
    expect(pdfFilename([s])).toBe('kineticsiq-right-knee-2026-08-12-1542.pdf')
  })

  it('omits the initials segment entirely when none are given', () => {
    expect(pdfFilename([makeSession()])).toBe('kineticsiq-right-knee-2026-08-12-1542.pdf')
  })

  it('includes initials when the caller asks for them', () => {
    expect(pdfFilename([makeSession()], { initials: 'JP' }))
      .toBe('kineticsiq-jp-right-knee-2026-08-12-1542.pdf')
  })

  it('never carries a full name, DOB or MRN — initials are the most it will take', () => {
    const s = makeSession({ patientName: 'Jane Q. Patient', dob: '1979-03-02', mrn: 'MRN-88213' })
    const name = pdfFilename([s], { initials: 'JP' })
    expect(name).not.toMatch(/jane|patient|1979|88213/i)
  })

  it('names a multi-session export by count and date', () => {
    const name = pdfFilename([makeSession({ id: 'a' }), makeSession({ id: 'b' })])
    expect(name).toMatch(/^kineticsiq-2-sessions-\d{4}-\d{2}-\d{2}-\d{4}\.pdf$/)
  })

  it('carries initials on a multi-session export too', () => {
    const name = pdfFilename([makeSession({ id: 'a' }), makeSession({ id: 'b' })], { initials: 'JP' })
    expect(name).toMatch(/^kineticsiq-jp-2-sessions-/)
  })
})

// ─── The encoding trap ─────────────────────────────────────────────────────

describe('winAnsi — the encoding trap', () => {

  it('passes through the degree sign and en dash the ROM arc depends on', () => {
    expect(winAnsi('5° – 120°')).toBe('5° – 120°')
  })

  it('replaces characters that would flip the whole string to UTF-16', () => {
    expect(winAnsi('⚠ warning')).toBe('? warning')
    expect(winAnsi('done ✓')).toBe('done ?')
  })

  it('degrades an emoji in a note to a visible marker, not a lost word', () => {
    // One marker, not two: an emoji is a surrogate PAIR, and iterating by code
    // unit would turn each one-character emoji into '??'.
    expect(winAnsi('great progress 🎉')).toBe('great progress ?')
  })

  it('keeps accented names and punctuation intact', () => {
    expect(winAnsi('flexión — après')).toBe('flexión — après')
  })
})

describe('buildSessionPdf — every drawn string is WinAnsi-safe', () => {

  it('sanitises an emoji typed into a note', async () => {
    await buildSessionPdf([makeSession({ notes: 'felt great today 🎉 no pain' })])
    const text = allText()
    expect(text).toContain('felt great today')
    expect(text).not.toContain('🎉')
  })

  it('leaves nothing unrepresentable anywhere in the document', async () => {
    await buildSessionPdf([makeSession({
      joint: 'shoulder', side: 'left', position: 'standing',
      min: -3, max: 160, rom: 163,
      angleConvention: undefined,          // force the warning band
      notes: 'sharp pain at end range 😖',
    })])

    for (const line of drawn.texts) {
      expect(winAnsi(line)).toBe(line)
    }
  })
})

// ─── The verification band (PR 3) ────────────────────────────────────────────

describe('buildSessionPdf — verification is stated, never as a warning', () => {

  const verifiedSession = (angles = { min: 2, max: 130 }) => makeSession({
    verifications: [{ id: 'v1', byMode: 'device', landmarks: {}, angles }],
  })

  it('draws the verification band for a verified session', async () => {
    await buildSessionPdf([verifiedSession()])
    expect(allText()).toMatch(/CLINICIAN-VERIFIED/)
  })

  it('draws NO band for a model-measured session', async () => {
    // The default needs no announcement; a band on every page would train the
    // reader to ignore bands.
    await buildSessionPdf([makeSession()])
    expect(allText()).not.toMatch(/CLINICIAN-VERIFIED/)
  })

  it('paints it in the NEUTRAL colour, never the warning amber', async () => {
    // Amber is what a reader has learned to read as "something is wrong".
    await buildSessionPdf([verifiedSession()])
    const fills = docStub.setFillColor.mock.calls.map(c => c.join(','))
    expect(fills).toContain('237,242,247')      // noteBg
    expect(fills).not.toContain('254,243,199')  // warnBg
  })

  it('carries the endpoint-only scope onto the page', async () => {
    await buildSessionPdf([verifiedSession()])
    expect(allText()).toMatch(/rest of the recording is unchanged/)
  })

  it('attributes a ROM derived from verified endpoints', async () => {
    await buildSessionPdf([verifiedSession({ min: 10, max: 100 })])
    expect(allText()).toMatch(/between clinician-verified endpoints/)
  })

  it('names no person and no patient identifier', async () => {
    await buildSessionPdf([verifiedSession()])
    const text = allText()
    expect(text).not.toMatch(/user-1|MRN|Poppins/i)
  })

  it('NEVER strengthens the claim on a document filed in a chart', async () => {
    await buildSessionPdf([verifiedSession()])
    expect(allText().toLowerCase()).not.toMatch(/validated|accurate/)
  })

  it('keeps every drawn string WinAnsi-safe', async () => {
    // One un-encodable character flips the WHOLE string to UTF-16 and renders
    // as garbage — so the new band's text is held to the same rule.
    await buildSessionPdf([verifiedSession()])
    for (const s of drawn.texts) expect(winAnsi(s)).toBe(s)
  })

  it('draws BOTH the neutral band and a caveat band when both apply', async () => {
    // A verified peak with a minimum sitting at the bound: the session is
    // verified AND still cannot show hyperextension.
    await buildSessionPdf([makeSession({
      calibrated: false, min: 0, max: 130,
      verifications: [{ id: 'v1', byMode: 'device', landmarks: {}, angles: { min: 0, max: 130 } }],
    })])
    const fills = docStub.setFillColor.mock.calls.map(c => c.join(','))
    expect(fills).toContain('237,242,247')      // verification
    expect(fills).toContain('254,243,199')      // the caveat
    expect(allText()).toMatch(/CANNOT SHOW HYPEREXTENSION/)
  })
})

describe('buildSessionPdf — the ROM headline never runs off the page', () => {

  // PAGE 612 wide, MARGIN 54 each side.
  const CONTENT_W = 612 - 54 * 2
  const width = ({ text, size }) => text.length * size * 0.5
  const headline = () => drawn.sized.find(d => /^ROM /.test(d.text))

  it('fits the ordinary case at full size', async () => {
    await buildSessionPdf([makeSession()])
    const h = headline()
    expect(h).toBeTruthy()
    expect(width(h)).toBeLessThanOrEqual(CONTENT_W)
  })

  it('SHRINKS rather than overflowing when the numbers are long', async () => {
    // This is the shipped bug: text() neither wraps nor clips, so an over-long
    // headline is silently lost at the margin.
    await buildSessionPdf([makeSession({ min: -123.4, max: 149.1, rom: 272.5 })])
    const h = headline()
    expect(width(h)).toBeLessThanOrEqual(CONTENT_W)
  })

  it('still prints the qualifier, just not inside the headline', async () => {
    await buildSessionPdf([makeSession({
      verifications: [{ id: 'v1', byMode: 'device', landmarks: {}, angles: { min: 10, max: 100 } }],
    })])
    expect(headline().text).not.toMatch(/verified/)
    expect(allText()).toMatch(/clinician-verified endpoints/)
  })
})
