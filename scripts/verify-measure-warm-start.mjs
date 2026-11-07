/**
 * verify-measure-warm-start.mjs — returning to Measure is warm, and the
 * selection carries over.
 *
 * Drives the real app (fake camera) through what used to be a cold start on
 * every return from History or Patients:
 *   - the pose model is fetched ONCE for the whole run (shared detector);
 *   - coming back with the camera running restarts it without a tap, and
 *     never shows "Loading AI model…" again;
 *   - coming back with the camera stopped leaves it stopped;
 *   - joint, side and position survive the round trip for the same patient;
 *     changing joint clears the position, changing side keeps it;
 *   - another patient opens on knee, their affected side, no position;
 *   - the drawer is usable before the camera starts.
 *
 * Usage: node scripts/verify-measure-warm-start.mjs [--headed]
 * Reuses the verify:e2e fake-camera fixture. A few minutes headless.
 * Chromium grants getUserMedia without a gesture, so this cannot tell whether
 * iOS Safari does — that needs a device.
 */
import { chromium } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureFixture } from './e2e/fixture.mjs'

const HERE   = dirname(fileURLToPath(import.meta.url))
const HEADED = process.argv.includes('--headed')
const PORT   = 5177
const URL    = `https://localhost:${PORT}/`

const now = new Date().toISOString()
const patient = (id, name, affectedSide) => ({
  id, name, dob: null, mrn: '', diagnosis: '', surgeryDate: null,
  affectedSide, notes: '', created_at: now, updated_at: now,
})
const P1 = patient('11111111-2222-4333-8444-555555555555', 'Patient One', 'left')
const P2 = patient('66666666-7777-4888-9999-aaaaaaaaaaaa', 'Patient Two', 'right')

let failures = 0
const pass = (m) => console.log(`  ok    ${m}`)
const fail = (m) => { console.error(`  FAIL  ${m}`); failures++ }
const info = (m) => console.log(`        ${m}`)
const expectEq = (actual, expected, what) =>
  actual === expected ? pass(`${what}: ${actual}`) : fail(`${what}: got "${actual}", expected "${expected}"`)

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

const handle = (page) => page.textContent('#handle-label')
const waitForReadout = (page) => page.waitForFunction(
  () => /^-?\d+°$/.test(document.getElementById('angle-display')?.textContent ?? ''),
  null, { timeout: 180_000 },
)

async function tapInDrawer(page, attr, value) {
  await page.click('#selector-handle')
  await page.waitForTimeout(450)                       // drawer transition
  await page.click(`#selector-drawer .seg-btn[data-${attr}="${value}"]`)
  await page.click('#selector-handle')
  await page.waitForTimeout(450)
}

async function goHistoryAndBack(page) {
  await page.click('#btn-history')
  await page.waitForSelector('.history-view')
  await page.click('#btn-back')
  await page.waitForSelector('#angle-display')
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
      // Every status the badge shows, losslessly, across view swaps.
      window.__statuses = []
      new MutationObserver(() => {
        const t = document.getElementById('status-badge')?.textContent
        if (t && window.__statuses.at(-1) !== t) window.__statuses.push(t)
      }).observe(document, { childList: true, characterData: true, subtree: true })
    }, { patients: [P1, P2] })

    const page = await context.newPage()
    let modelFetches = 0
    let resolveModelFetched
    const modelFetched = new Promise((resolve) => { resolveModelFetched = resolve })
    page.on('request', (r) => { if (/pose_landmarker.*\.task/.test(r.url())) modelFetches++ })
    // Listening from before the page loads: a fast warm-up can finish the
    // fetch before the drawer taps below are done, which a listener attached
    // afterwards would miss.
    page.on('requestfinished', (r) => { if (/pose_landmarker.*\.task/.test(r.url())) resolveModelFetched(true) })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const statusesSince = async (mark) => (await page.evaluate(() => window.__statuses.slice())).slice(mark)
    const statusMark = () => page.evaluate(() => window.__statuses.length)

    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#btn-start-camera', { timeout: 30_000 })

    console.log('\n1. First mount: defaults from the patient, drawer usable before the camera')
    expectEq(await page.textContent('#angle-label'), 'Left Knee flexion', 'side from affectedSide')
    expectEq(await handle(page), 'Left Knee · position not set', 'handle names no position')
    if (await page.isVisible('#selector-handle')) pass('drawer handle visible before Start Camera')
    else fail('drawer hidden before Start Camera')
    await tapInDrawer(page, 'joint', 'hip')
    await tapInDrawer(page, 'position', 'supine')
    expectEq(await handle(page), 'Left Hip · Supine', 'selected before the camera started')

    console.log('\n2. Start the camera (the model was already warming since boot)')
    // MediaPipe loads its WASM runtime before it fetches the model, so give
    // the warm-up time; nothing here taps Start Camera.
    const fetched = await Promise.race([
      modelFetched,
      new Promise((resolve) => setTimeout(() => resolve(false), 120_000)),
    ])
    if (fetched) pass('model fetched at boot with no Start Camera tap')
    else fail('no model fetch within 120s of boot — warm-up not running')
    await page.waitForTimeout(5_000)                   // landmarker + GPU init after the fetch
    let mark = await statusMark()
    await page.click('#btn-start-camera')
    await waitForReadout(page)
    const first = await statusesSince(mark)
    info(`first start statuses: ${first.join(' → ')}`)
    if (!first.includes('Loading AI model…')) pass('first Start Camera found the model ready')
    else fail('first Start Camera still loaded the model')

    console.log('\n3. History → Back with the camera running')
    mark = await statusMark()
    await goHistoryAndBack(page)
    await waitForReadout(page)
    const resumed = await statusesSince(mark)
    info(`statuses: ${resumed.join(' → ')}`)
    pass('readout live again with no Start Camera tap')
    if (!(await page.isVisible('#btn-start-camera'))) pass('Start Camera stayed hidden')
    else fail('Start Camera visible after resume')
    if (!resumed.includes('Loading AI model…')) pass('no "Loading AI model…" on return')
    else fail('model reloaded on return')
    expectEq(await handle(page), 'Left Hip · Supine', 'selection kept')
    expectEq(await page.textContent('#angle-label'), 'Left Hip flexion', 'readout label kept')

    console.log('\n4. Changing side keeps the position; changing joint clears it')
    await tapInDrawer(page, 'side', 'right')
    expectEq(await handle(page), 'Right Hip · Supine', 'after side change')
    await tapInDrawer(page, 'joint', 'knee')
    expectEq(await handle(page), 'Right Knee · position not set', 'after joint change')
    await tapInDrawer(page, 'position', 'prone')

    console.log('\n5. Patients → another patient (camera running)')
    await page.click('#patient-chip')
    await page.waitForSelector(`.patient-row[data-id="${P2.id}"]`)
    await page.click(`.patient-row[data-id="${P2.id}"]`)
    await waitForReadout(page)
    pass('camera resumed after picking a patient')
    expectEq(await handle(page), 'Right Knee · position not set', 'new patient: defaults, no position')

    console.log('\n6. Back to the first patient: their selection returns')
    await page.click('#patient-chip')
    await page.click(`.patient-row[data-id="${P1.id}"]`)
    await waitForReadout(page)
    // Mounting saves nothing, so P2's visit left P1's stored selection intact.
    // (One slot: had the clinician tapped a selection for P2, P1's is gone.)
    expectEq(await handle(page), 'Right Knee · Prone', 'P1 selection back after visiting P2')

    console.log('\n7. Stop the camera, then History → Back: it stays stopped')
    await page.click('#btn-stop-camera')
    await page.evaluate(() => document.getElementById('btn-history').click())
    await page.waitForSelector('.history-view')
    await page.click('#btn-back')
    await page.waitForSelector('#btn-start-camera')
    await page.waitForTimeout(2_000)
    if (await page.isVisible('#btn-start-camera')) pass('camera not auto-started')
    else fail('camera auto-started although it was stopped')
    expectEq(await page.textContent('#status-badge'), 'Tap to start', 'status')

    console.log('\n8. Whole run')
    expectEq(modelFetches, 1, 'model fetches')
    if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
    else pass('no page errors')
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
