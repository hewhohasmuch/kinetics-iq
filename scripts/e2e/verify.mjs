/**
 * verify.mjs — drives KineticsIQ end-to-end in a real browser.
 *
 * Unit tests cover src/core/ thoroughly, but the measurement pipeline only
 * exists once camera, MediaPipe, the overlay canvas and storage are wired
 * together in MeasureView — and none of that is unit tested. This run exercises
 * the whole thing against a fake camera showing a real pose.
 *
 * Usage:
 *   npm run verify:e2e              # starts its own dev server
 *   npm run verify:e2e -- --headed  # watch it happen
 *   npm run verify:e2e -- --url https://localhost:5173/   # reuse a running one
 *
 * Takes a few minutes on first run: it downloads the pose image, builds the
 * fake-camera video, and MediaPipe fetches a ~7MB model.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureFixture, FIXTURE_DIR } from './fixture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const argv     = process.argv.slice(2)
const HEADED   = argv.includes('--headed')
const urlArg   = argv.indexOf('--url')
const OWN_URL  = urlArg !== -1 ? argv[urlArg + 1] : null
const PORT     = 5174
const URL      = OWN_URL ?? `https://localhost:${PORT}/`
const RECORD_MS = 12_000

const PATIENT = {
  id: '11111111-2222-4333-8444-555555555555',
  name: 'E2E Test Patient',
  dob: null, mrn: 'TEST-1', diagnosis: 'e2e verification',
  surgeryDate: null, affectedSide: 'right', notes: '',
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
}

let failures = 0
const pass = (m) => console.log(`  ok    ${m}`)
const fail = (m) => { console.error(`  FAIL  ${m}`); failures++ }
const info = (m) => console.log(`        ${m}`)

/** Resolve once the dev server answers, or throw after `timeoutMs`. */
function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = httpsRequest(url, { rejectUnauthorized: false, method: 'GET' }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`dev server did not come up at ${url}`))
        else setTimeout(attempt, 500)
      })
      req.end()
    }
    attempt()
  })
}

async function main() {
  console.log('\nPreparing fixture (first run downloads + encodes; later runs reuse it)')
  const y4m = await ensureFixture()
  info(y4m)

  let server = null
  if (!OWN_URL) {
    console.log('\nStarting dev server')
    server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
      cwd: join(HERE, '..', '..'),
      shell: true,
      stdio: 'ignore',
    })
    await waitForServer(URL)
    info(URL)
  }

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
      ignoreHTTPSErrors: true,          // vite dev uses a self-signed cert
      permissions: ['camera'],
      viewport: { width: 430, height: 932 },
    })

    // Seed a patient and make it active — recording is blocked without one,
    // and this boots straight into MeasureView.
    await context.addInitScript(([patient]) => {
      localStorage.setItem('rom_patients', JSON.stringify([patient]))
      localStorage.setItem('rom_settings', JSON.stringify({
        active_patient_id: patient.id, calibration_offset: 0, calibration_version: 1,
      }))
      localStorage.setItem('rom_sessions', JSON.stringify([]))
      localStorage.setItem('rom_outbox', JSON.stringify([]))
    }, [PATIENT])

    // Record every value the readout actually renders. A MutationObserver in
    // the page is lossless; polling textContent from Node drops values and
    // makes the display-vs-record comparison below untrustworthy.
    await context.addInitScript(() => {
      window.__shownAngles = []
      const attach = () => {
        const el = document.getElementById('angle-display')
        if (!el) return false
        new MutationObserver(() => {
          const n = parseInt(el.textContent, 10)
          if (!Number.isNaN(n)) window.__shownAngles.push(n)
        }).observe(el, { childList: true, characterData: true, subtree: true })
        return true
      }
      if (!attach()) {
        const poll = setInterval(() => { if (attach()) clearInterval(poll) }, 100)
      }
    })

    const page = await context.newPage()
    const consoleErrors = []
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

    console.log('\n1. App boots into MeasureView')
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#btn-start-camera', { timeout: 30_000 })
    pass('mounted with an active patient')

    console.log('\n2. Camera + MediaPipe')
    await page.click('#btn-start-camera')
    await page.waitForFunction(
      () => /^\d+°$/.test(document.getElementById('angle-display')?.textContent ?? ''),
      null, { timeout: 180_000 },
    )
    pass(`pose detected, readout = ${await page.textContent('#angle-display')}`)

    console.log('\n3. Record across the clip (angle swings when the video mirrors)')
    await page.click('#btn-record-start')
    await page.evaluate(() => { window.__shownAngles.length = 0 })
    await page.waitForTimeout(RECORD_MS)
    info(`live ROM bar reads ${await page.textContent('#rom-value')}`)
    await page.click('#btn-record-stop')
    await page.waitForSelector('#notes-panel', { state: 'visible', timeout: 10_000 })
    const shown = await page.evaluate(() => window.__shownAngles.slice())
    await page.click('#btn-notes-skip')
    await page.waitForTimeout(500)
    pass('recorded, stopped and saved')

    console.log('\n4. The saved record')
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('rom_sessions') || '[]'))
    if (saved.length !== 1) { fail(`expected 1 saved session, got ${saved.length}`); return }
    const s = saved[0]
    info(`${s.joint}/${s.side}  min=${s.min}°  max=${s.max}°  rom=${s.rom}°  samples=${s.samples}`)

    if (s.angleMode === '3d') pass('angleMode: 3d — measured from world landmarks')
    else fail(`angleMode is ${JSON.stringify(s.angleMode)}, expected '3d'`)

    // Headless Chromium runs BlazePose on CPU and lands nearer 2Hz than the
    // app's 10Hz target, so assert that recording happened and report the rate
    // rather than asserting a rate this environment cannot reach.
    const hz = (s.samples / (RECORD_MS / 1000)).toFixed(1)
    if (s.samples > 15) pass(`${s.samples} samples (~${hz}Hz; CPU-bound headless, not the 10Hz target)`)
    else fail(`only ${s.samples} samples recorded`)

    if (s.rom > 1) pass(`ROM ${s.rom}° — the angle moved`)
    else fail(`ROM ${s.rom}° — angle never changed; is the fixture looping?`)

    // The invariant that matters clinically: the extremes written to the record
    // must be values the clinician actually saw, not a separately filtered
    // stream. Tolerance is 1° because the readout renders whole degrees.
    const shownMax = Math.max(...shown), shownMin = Math.min(...shown)
    info(`readout spanned ${shownMin}°..${shownMax}° across ${shown.length} renders`)
    if (Math.abs(s.max - shownMax) <= 1) pass(`saved max ${s.max}° matches displayed ${shownMax}°`)
    else fail(`saved max ${s.max}° but the readout never exceeded ${shownMax}°`)
    if (Math.abs(s.min - shownMin) <= 1) pass(`saved min ${s.min}° matches displayed ${shownMin}°`)
    else fail(`saved min ${s.min}° but the readout never went below ${shownMin}°`)

    for (const [label, frame] of [['peak', s.peakFrame], ['min', s.minFrame]]) {
      if (typeof frame === 'string' && frame.startsWith('data:image/jpeg'))
        pass(`${label} snapshot encoded (${Math.round(frame.length / 1024)}KB)`)
      else fail(`${label} snapshot missing or not a JPEG data URL`)
    }

    console.log('\n5. History and detail')
    await page.click('#btn-history')
    await page.waitForSelector('.session-row', { timeout: 15_000 })
    pass('session listed in History')
    await page.click('.session-row')
    await page.waitForTimeout(1500)   // Chart.js has a 400ms entry animation
    const shot = join(FIXTURE_DIR, 'session-detail.png')
    await page.screenshot({ path: shot })
    pass(`SessionDetail rendered — screenshot: ${shot}`)
    info('check by eye: the angle burned into each frame should match its caption')

    console.log('\n6. Console health')
    const real = consoleErrors.filter((e) => !/ERR_CERT|self.signed|favicon/i.test(e))
    if (real.length === 0) pass('no console errors')
    else { real.slice(0, 5).forEach((e) => console.error(`        ${e}`)); fail(`${real.length} console error(s)`) }
  } finally {
    await browser.close()
    if (server) server.kill()
  }
}

await main()
console.log(failures ? `\nFAILED — ${failures} check(s)\n` : '\nPASSED\n')
process.exit(failures ? 1 : 0)
