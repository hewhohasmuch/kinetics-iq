/**
 * Drives the extension-floor caveat at the real UI surface: History badge,
 * SessionDetail chip, the copied note, and the exported PDF.
 *
 * src/ui/ has no unit tests and pdf.test.js mocks jsPDF, so this is the only
 * thing that proves the caveat actually reaches a clinician.
 */
import { chromium } from 'playwright'
import { readFileSync, mkdirSync } from 'node:fs'

const BS = String.fromCharCode(92)   // backslash, so the octal below is not a JS escape
const OUT = 'tmp/floor-verify'
mkdirSync(OUT, { recursive: true })
const URL = 'https://localhost:5174/'
const PATIENT = '11111111-1111-4111-8111-111111111111'

const base = (id, over) => ({
  id, patient_id: PATIENT, joint: 'knee', side: 'right', position: 'supine',
  date: '2026-08-11', timestamp: new Date(2026, 7, 11, 20, 32).getTime(),
  min: 9, max: 121.8, rom: 112.8, duration_s: 12, samples: 120,
  angleTimeline: [9, 40, 90, 121.8, 90, 9], notes: '',
  angleMode: '3d', angleFilter: 'euro1', angleConvention: 'perjoint1',
  calibrated: false, calibrationOffset: 0,
  peakFramePath: null, minFramePath: null,
  updated_at: new Date().toISOString(), ...over,
})

const seed = {
  patients: [{ id: PATIENT, name: 'Jane Poppins', dob: '1980-04-02', mrn: 'MRN-99887',
               updated_at: new Date().toISOString() }],
  sessions: [
    base('aaaaaaaa-0000-4000-8000-000000000001'),                               // un-zeroed, current stamps
    base('bbbbbbbb-0000-4000-8000-000000000002', { angleConvention: undefined }),// legacy AND un-zeroed
    base('cccccccc-0000-4000-8000-000000000003', { calibrated: true, calibrationOffset: 8.6, min: 0.4 }),
    base('dddddddd-0000-4000-8000-000000000004', { calibrated: undefined, calibrationOffset: undefined }),
  ],
  activePatient: PATIENT,
}

const browser = await chromium.launch()
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true, acceptDownloads: true,
  permissions: ['clipboard-read', 'clipboard-write'],
})
await ctx.addInitScript((s) => {
  localStorage.setItem('rom_patients', JSON.stringify(s.patients))
  localStorage.setItem('rom_sessions', JSON.stringify(s.sessions))
  localStorage.setItem('rom_settings', JSON.stringify({ active_patient_id: s.activePatient }))
}, seed)

const page = await ctx.newPage()
const fails = []
const check = (name, cond, detail='') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? ' :: ' + detail : ''))
  if (!cond) fails.push(name)
}

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#btn-history', { state: 'attached', timeout: 30000 })
await page.evaluate(() => document.getElementById('btn-history').click())
await page.waitForSelector('.session-row', { timeout: 15000 })
await page.waitForTimeout(1200)
await page.screenshot({ path: `${OUT}/history.png`, fullPage: true })

// ── History badges ──
const rows = await page.evaluate(() =>
  [...document.querySelectorAll('.session-row')].map(r => ({
    text: r.innerText,
    badges: [...r.querySelectorAll('.legacy-badge')].map(b => b.textContent.trim()),
  })))
const all = rows.map(r => r.badges.join('|'))
check('History: un-zeroed row carries the floor badge',
  all.some(b => b.includes('Minimum may be measurement floor')), JSON.stringify(all))
check('History: legacy+un-zeroed row carries BOTH badges',
  all.some(b => b.includes('Legacy scale') && b.includes('Minimum may be measurement floor')))
check('History: zeroed row carries neither', all.some(b => b === ''))

// ── SessionDetail on the un-zeroed, current-stamps session ──
const idx = rows.findIndex(r => r.badges.join('|').includes('Minimum') && !r.badges.join('|').includes('Legacy'))
await page.evaluate(i => document.querySelectorAll('.session-row')[i].click(), idx)
await page.waitForSelector('#detail-provenance', { timeout: 15000 })
await page.waitForTimeout(1400)
await page.screenshot({ path: `${OUT}/detail.png`, fullPage: true })

const chips = await page.evaluate(() =>
  [...document.querySelectorAll('#detail-provenance .prov-chip')].map(c => c.textContent.trim()))
check('Detail: shows "Not zeroed" and the floor chip together',
  chips.some(c => c.includes('Not zeroed')) && chips.some(c => c.includes('Minimum may be measurement floor')),
  JSON.stringify(chips))
const tip = await page.evaluate(() =>
  [...document.querySelectorAll('#detail-provenance .prov-chip')].map(c => c.title).join(' '))
check('Detail: tooltip does not prescribe Set Zero', !/set zero|re-?zero|calibrate/i.test(tip))

// ── Copy for note ──
await page.click('#btn-copy-note')
await page.waitForTimeout(400)
const note = await page.evaluate(() => navigator.clipboard.readText())
console.log('\n--- clipboard ---\n' + note + '\n-----------------\n')
check('Note: carries the floor caveat', note.includes('⚠ Minimum may be measurement floor'))
check('Note: names the actual minimum', note.includes('9°'))
check('Note: still states calibration', note.includes('Not zeroed'))
check('Note: does not prescribe Set Zero', !/Set Zero|re-?zero|calibrate/i.test(note))
check('Note: no patient identifier', !note.includes('Jane') && !note.includes('MRN-99887') && !note.includes('1980'))

// ── PDF export ──
await page.click('#btn-export-pdf')
await page.waitForSelector('.export-confirm', { timeout: 10000 })
const dl = page.waitForEvent('download', { timeout: 60000 })
await page.click('#ec-confirm')
const download = await dl
const pdfPath = `${OUT}/export.pdf`
await download.saveAs(pdfPath)
const name = download.suggestedFilename()
const buf = readFileSync(pdfPath)
const bin = buf.toString('latin1')

check('PDF: header present', bin.startsWith('%PDF-'))
check('PDF: filename carries no identifier', !/jane|poppins|99887|1980/i.test(name), name)
check('PDF: no UTF-16 strings (encoding trap did not fire)', !bin.includes('(' + BS + '376' + BS + '377'))
check('PDF: one page', (bin.match(/\/Type\s*\/Page[^s]/g) || []).length === 1,
  String((bin.match(/\/Type\s*\/Page[^s]/g) || []).length))

await browser.close()
console.log('\n' + (fails.length ? 'FAILED: ' + fails.join('; ') : 'ALL CHECKS PASSED'))
process.exit(fails.length ? 1 : 0)
