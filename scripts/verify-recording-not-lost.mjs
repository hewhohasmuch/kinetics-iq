/**
 * verify-recording-not-lost.mjs — leaving Measure never discards a measurement.
 *
 * Tapping History or the patient chip mid-recording used to stop the take,
 * open the note box for it, and then navigate away — so the session existed
 * only in the discarded view and was never saved. The same happened to a take
 * whose note box was still open, and Stop Camera mid-recording threw the take
 * away outright. Each path below must end with the session in storage, its
 * snapshots in IndexedDB, and (where typed) its note.
 *
 * Usage: node scripts/verify-recording-not-lost.mjs [--headed]
 * Reuses the verify:e2e fake-camera fixture. A few minutes headless.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureFixture } from './e2e/fixture.mjs'

const HERE   = dirname(fileURLToPath(import.meta.url))
const HEADED = process.argv.includes('--headed')
const PORT   = 5179   // 5178 is verify-landmark-verification.mjs
const URL    = `https://localhost:${PORT}/`
const TAKE_MS = 5_000

const now = new Date().toISOString()
const patient = (id, name) => ({
  id, name, dob: null, mrn: '', diagnosis: '', surgeryDate: null,
  affectedSide: null, notes: '', created_at: now, updated_at: now,
})
const P1 = patient('11111111-2222-4333-8444-555555555555', 'Patient One')
const P2 = patient('66666666-7777-4888-9999-aaaaaaaaaaaa', 'Patient Two')

let failures = 0
const pass = (m) => console.log(`  ok    ${m}`)
const fail = (m) => { console.error(`  FAIL  ${m}`); failures++ }

function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = httpsRequest(url, { rejectUnauthorized: false }, (res) => { res.resume(); resolve() })
      req.on('error', () => Date.now() > deadline
        ? reject(new Error(`dev server did not come up at ${url}`))
        : setTimeout(attempt, 500))
      req.end()
    }
    attempt()
  })
}

const sessions = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('rom_sessions') || '[]'))

/** Snapshot blob keys in IndexedDB for one session. */
const blobKeys = (page, id) => page.evaluate((sid) => new Promise((resolve) => {
  const req = indexedDB.open('kinetics_images')
  req.onerror = () => resolve([])
  req.onsuccess = () => {
    const db = req.result
    if (!db.objectStoreNames.contains('images')) return resolve([])
    const keys = db.transaction('images').objectStore('images').getAllKeys()
    keys.onsuccess = () => resolve(keys.result.filter(k => String(k).startsWith(`${sid}:`)))
    keys.onerror = () => resolve([])
  }
}), id)

/** blobKeys, polled: encoding + the IndexedDB write finish after Skip returns. */
async function blobKeysEventually(page, id, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let keys = await blobKeys(page, id)
  while (keys.length < 2 && Date.now() < deadline) {
    await page.waitForTimeout(250)
    keys = await blobKeys(page, id)
  }
  return keys
}

async function waitForReadout(page) {
  await page.waitForFunction(
    () => /^-?\d+°$/.test(document.getElementById('angle-display')?.textContent ?? ''),
    null, { timeout: 180_000 },
  )
}

async function record(page) {
  await page.click('#btn-record-start')
  await page.waitForTimeout(TAKE_MS)
}

/** Assert exactly one new session appeared, with both snapshots. */
async function expectSaved(page, before, what, { patientId = P1.id, note } = {}) {
  const after = await sessions(page)
  const added = after.filter(s => !before.some(b => b.id === s.id))
  if (added.length !== 1) { fail(`${what}: ${added.length} new sessions (expected 1)`); return }
  const s = added[0]
  pass(`${what}: session saved (${s.samples} samples, ${s.min}°–${s.max}°)`)
  if (s.patient_id === patientId) pass(`${what}: filed under the patient being measured`)
  else fail(`${what}: filed under ${s.patient_id}`)
  if (note !== undefined) {
    if (s.notes === note) pass(`${what}: note kept ("${note}")`)
    else fail(`${what}: note is "${s.notes}", expected "${note}"`)
  }
  const keys = await blobKeys(page, s.id)
  if (keys.length === 2) pass(`${what}: both snapshots in IndexedDB`)
  else fail(`${what}: ${keys.length} snapshot blobs (expected 2)`)
}

async function main() {
  const y4m = await ensureFixture()

  // Vite's own entry run with node, not `npx` through a shell: on Windows
  // kill() then ends only the shell, and the orphaned server keeps the port.
  const root = join(HERE, '..')
  const server = spawn(process.execPath,
    [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: 'ignore' })
  await waitForServer(URL)

  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${y4m}`,
    ],
  })

  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true, permissions: ['camera'],
      viewport: { width: 430, height: 932 },
    })
    await context.addInitScript(({ patients }) => {
      if (localStorage.getItem('rom_patients')) return   // seed once, not per reload
      localStorage.setItem('rom_patients', JSON.stringify(patients))
      localStorage.setItem('rom_settings', JSON.stringify({
        active_patient_id: patients[0].id, calibration_version: 3,
      }))
      localStorage.setItem('rom_sessions', '[]')
      localStorage.setItem('rom_outbox', '[]')
    }, { patients: [P1, P2] })

    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#btn-start-camera', { timeout: 30_000 })
    await page.click('#btn-start-camera')
    await waitForReadout(page)

    console.log('\n1. Tap History mid-recording')
    let before = await sessions(page)
    await record(page)
    await page.click('#btn-history')
    await page.waitForSelector('.history-view')
    await expectSaved(page, before, 'History mid-take')
    if (await page.locator('.session-row').count() === 1) pass('listed in History')
    else fail(`History lists ${await page.locator('.session-row').count()} sessions`)

    console.log('\n2. Stop & Save, type a note, then tap History without saving it')
    await page.click('#btn-back')
    await waitForReadout(page)
    before = await sessions(page)
    await record(page)
    await page.click('#btn-record-stop')
    await page.waitForSelector('#notes-panel', { state: 'visible' })
    await page.fill('#notes-input', 'day 14 post-op')
    await page.click('#btn-history')
    await page.waitForSelector('.history-view')
    await expectSaved(page, before, 'History with note open', { note: 'day 14 post-op' })

    console.log('\n3. Tap the patient chip mid-recording')
    await page.click('#btn-back')
    await waitForReadout(page)
    before = await sessions(page)
    await record(page)
    await page.click('#patient-chip')
    await page.waitForSelector('.patients-view')
    await expectSaved(page, before, 'patient chip mid-take', { patientId: P1.id })

    console.log('\n4. Stop Camera mid-recording: the note box opens, nothing is thrown away')
    await page.click(`.patient-row[data-id="${P1.id}"]`)
    await waitForReadout(page)
    before = await sessions(page)
    await record(page)
    await page.click('#btn-stop-camera')
    if (await page.isVisible('#notes-panel')) pass('note box offered for the stopped take')
    else fail('no note box after Stop Camera mid-take')
    if (await page.isVisible('#btn-notes-skip')) await page.click('#btn-notes-skip')
    await page.waitForTimeout(1_000)
    await expectSaved(page, before, 'Stop Camera mid-take')

    console.log('\n5. Stop & Save, then Record again without answering the note box')
    await page.click('#btn-start-camera')
    await waitForReadout(page)
    before = await sessions(page)
    await record(page)
    await page.click('#btn-record-stop')
    await page.waitForSelector('#notes-panel', { state: 'visible' })
    await page.fill('#notes-input', 'first take')
    await record(page)                                 // second take starts here
    await page.click('#btn-record-stop')
    await page.waitForSelector('#notes-panel', { state: 'visible' })
    await page.click('#btn-notes-skip')
    await page.waitForTimeout(1_000)
    const both = (await sessions(page)).filter(s => !before.some(b => b.id === s.id))
    if (both.length === 2) pass('both takes saved')
    else fail(`${both.length} of 2 takes saved`)
    const first = both.find(s => s.notes === 'first take')
    if (first) pass('first take kept its typed note')
    else fail(`first take's note lost (notes: ${both.map(s => JSON.stringify(s.notes)).join(', ')})`)
    for (const s of both) {
      const keys = await blobKeysEventually(page, s.id)
      const label = `take ${s.notes ? '1' : '2'}`
      if (keys.length === 2) pass(`${label}: both snapshots in IndexedDB`)
      else fail(`${label}: blobs ${JSON.stringify(keys.map(k => k.split(':')[1]))}; ` +
        `landmarks peak=${!!s.landmarksRaw?.peak} min=${!!s.landmarksRaw?.min}; ` +
        `frames ${s.min}°–${s.max}° over ${s.samples} samples`)
    }
    if (both.length === 2 && first) {
      const second = both.find(s => s !== first)
      if (second.timestamp > first.timestamp) pass('takes are distinct recordings (later timestamp)')
      else fail('second take is not later than the first')
    }

    if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
    else pass('no page errors')
  } finally {
    await browser.close()
    server.kill()
  }

  console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
