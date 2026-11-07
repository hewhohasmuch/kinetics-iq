/**
 * verify-calibration-scope.mjs — a Set Zero offset applies only to the patient,
 * joint and side it was captured on.
 *
 * Two bugs this pins, both in the MeasureView wiring that src/ui/ has no unit
 * tests for:
 *   1. MeasureView used to remount on Right Knee after any trip to History or
 *      Patients but keep the stored offset — so a left hip's zero was applied
 *      to the right knee, and the session stamped calibrated. The view now
 *      reopens on its saved selection, so the drive seeds a selection that
 *      disagrees with the stored zero to reach the same mismatch.
 *   2. Switching patient reset the offset to 0 but left it flagged captured, so
 *      the next session read "Zeroed at 0.0°" and saved calibrated: true for a
 *      raw reading (which suppresses the extension-floor caveat on export).
 * And the guard against over-correcting: a zero on the SAME joint and side
 * survives the History round-trip.
 *
 * Usage: node scripts/verify-calibration-scope.mjs [--headed]
 * Reuses the verify:e2e fake-camera fixture. Several minutes headless.
 */
import { chromium } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureFixture } from './e2e/fixture.mjs'

const HERE   = dirname(fileURLToPath(import.meta.url))
const HEADED = process.argv.includes('--headed')
const PORT   = 5176
const URL    = `https://localhost:${PORT}/`

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
const info = (m) => console.log(`        ${m}`)

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

const settings = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('rom_settings') || '{}'))
const calStatus = (page) => page.textContent('#cal-status')

async function startCamera(page) {
  await page.click('#btn-start-camera')
  await page.waitForFunction(
    () => /^-?\d+°$/.test(document.getElementById('angle-display')?.textContent ?? ''),
    null, { timeout: 180_000 },
  )
}

async function select(page, attr, value) {
  await page.click('#selector-handle')
  await page.waitForTimeout(450)                       // drawer transition
  await page.click(`#selector-drawer .seg-btn[data-${attr}="${value}"]`)
  await page.click('#selector-handle')
  await page.waitForTimeout(450)
}

async function setZero(page) {
  await page.click('#btn-calibrate')
  // Sampling ends by itself after 20 detection frames — ~10-20s headless.
  await page.waitForFunction(
    () => document.getElementById('btn-calibrate')?.textContent === 'Set Zero',
    null, { timeout: 120_000 },
  )
}

async function main() {
  const y4m = await ensureFixture()

  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: join(HERE, '..'), shell: true, stdio: 'ignore',
  })
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

    console.log('\n1. Zero on Left Hip, then History → back (reopens on Left Hip)')
    await startCamera(page)
    await select(page, 'joint', 'hip')
    await select(page, 'side', 'left')
    await setZero(page)
    const zeroed = await calStatus(page)
    info(`after Set Zero: ${zeroed}`)
    if (zeroed.startsWith('Zeroed at')) pass('left hip zeroed')
    else fail('Set Zero did not capture an offset')
    if ((await settings(page)).calibration_context?.joint === 'hip') pass('offset stored with its context')
    else fail(`stored context: ${JSON.stringify((await settings(page)).calibration_context)}`)

    await page.click('#btn-history')
    await page.waitForSelector('.history-view')
    await page.click('#btn-back')
    await page.waitForSelector('#angle-display')
    info(`after remount: ${await page.textContent('#angle-label')} — ${await calStatus(page)}`)
    if ((await calStatus(page)) === zeroed) pass(`same-joint zero survives the round trip (${zeroed})`)
    else fail(`same-joint zero lost: "${zeroed}" became "${await calStatus(page)}"`)

    console.log('\n2. Reopen on Right Knee with the left hip zero still stored')
    await page.click('#btn-stop-camera')
    await page.evaluate(() => document.getElementById('btn-history').click())
    await page.waitForSelector('.history-view')
    await page.evaluate((pid) => {
      const s = JSON.parse(localStorage.getItem('rom_settings'))
      s.measure_selection = { patientId: pid, joint: 'knee', side: 'right', position: null }
      localStorage.setItem('rom_settings', JSON.stringify(s))
    }, P1.id)
    await page.click('#btn-back')
    await page.waitForSelector('#btn-start-camera')
    info(`after remount: ${await page.textContent('#angle-label')} — ${await calStatus(page)}`)
    if ((await calStatus(page)).startsWith('Not zeroed')) pass('hip zero NOT applied to the right knee')
    else fail(`hip zero leaked onto the right knee: "${await calStatus(page)}"`)
    if ((await settings(page)).calibration_captured === false) pass('stored offset cleared')
    else fail('stored offset still flagged captured')

    console.log('\n3. Switch patient → next session is recorded raw')
    await page.click('#patient-chip')
    await page.waitForSelector(`.patient-row[data-id="${P2.id}"]`)
    await page.click(`.patient-row[data-id="${P2.id}"]`)
    await page.waitForSelector('#btn-start-camera')
    info(`after switch: ${await calStatus(page)}`)
    if ((await calStatus(page)).startsWith('Not zeroed')) pass('no zero carried to the new patient')
    else fail(`new patient shows "${await calStatus(page)}"`)

    await startCamera(page)
    await page.click('#btn-record-start')
    await page.waitForTimeout(6_000)
    await page.click('#btn-record-stop')
    await page.waitForSelector('#notes-panel', { state: 'visible' })
    await page.click('#btn-notes-skip')
    await page.waitForTimeout(800)
    const sessions = await page.evaluate(() => JSON.parse(localStorage.getItem('rom_sessions') || '[]'))
    const s = sessions.find(x => x.patient_id === P2.id)
    if (!s) fail('no session saved for the new patient')
    else if (s.calibrated === false) pass('saved calibrated: false')
    else fail(`saved calibrated: ${JSON.stringify(s.calibrated)}, offset ${s.calibrationOffset}`)

    if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
  } finally {
    await browser.close()
    // With shell: true, kill() on Windows ends only the shell, leaving vite
    // holding the port; take the whole tree down.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
    else server.kill()
  }

  console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
