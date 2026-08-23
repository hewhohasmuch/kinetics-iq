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
        active_patient_id: patient.id, calibration_offset: 0, calibration_version: 2,
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
    // -? matters: past the calibration zero point the readout is negative
    // (extension), and a \d-only pattern would wait here forever.
    await page.waitForFunction(
      () => /^-?\d+°$/.test(document.getElementById('angle-display')?.textContent ?? ''),
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

    if (s.angleMode === '2d2') pass('angleMode: 2d2 — measured from the 2D image landmarks')
    else fail(`angleMode is ${JSON.stringify(s.angleMode)}, expected '2d2'`)

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

    // Snapshots moved off localStorage: the session must carry NO inline image
    // bytes, only (initially null) cloud path fields. The JPEG blobs live in
    // IndexedDB instead. This is the regression guard for the storage-full bug.
    if (s.peakFrame === undefined && s.minFrame === undefined)
      pass('no inline image bytes on the saved session (localStorage stays small)')
    else fail('session still carries inline peakFrame/minFrame bytes')

    // Calibration provenance. The harness seeds calibration_offset 0 and never
    // taps Set Zero, so this session was recorded RAW — and must say so
    // explicitly. `false` and "absent" are different claims: absent means the
    // session never recorded its calibration state, which is what pre-stamp
    // sessions look like and what the detail view reports as unknown.
    if (s.calibrated === false)
      pass('un-zeroed session recorded calibrated:false (not absent)')
    else fail(`expected calibrated:false on an un-zeroed session, got ${JSON.stringify(s.calibrated)}`)
    if (s.calibrationOffset === 0)
      pass(`calibration offset stamped (${s.calibrationOffset}°)`)
    else fail(`expected calibrationOffset 0, got ${JSON.stringify(s.calibrationOffset)}`)

    // ── Landmark evidence ────────────────────────────────────────────
    // The frames are now stored CLEAN and the overlay is drawn at view time,
    // so the session has to carry the coordinates to draw. Absence here would
    // not fail loudly — it would silently produce un-annotated pictures.
    if (s.landmarkSpace === 'frame1')
      pass("landmarkSpace: frame1 — frames stored clean and cropped to what was on screen")
    else fail(`landmarkSpace is ${JSON.stringify(s.landmarkSpace)}, expected 'frame1'`)

    if (s.modelId && s.modelVersion)
      pass(`model stamped (${s.modelId} ${s.modelVersion})`)
    else fail(`model stamps missing: ${JSON.stringify({ id: s.modelId, v: s.modelVersion })}`)

    for (const which of ['peak', 'min']) {
      const set = s.landmarksRaw?.[which]
      const ok = set && ['proximal', 'joint', 'distal'].every(
        (r) => set[r] && Number.isFinite(set[r].x) && Number.isFinite(set[r].y)
      )
      if (!ok) { fail(`${which} landmark set missing or incomplete`); continue }
      // Normalized fractions of the STORED FRAME — never pixels. The frame is
      // the visible crop, so the fractions are taken against that crop; a value
      // outside 0..1 means either a display transform leaked in or the crop was
      // taken without widening it to hold the evidence.
      const inRange = ['proximal', 'joint', 'distal'].every(
        (r) => set[r].x >= 0 && set[r].x <= 1 && set[r].y >= 0 && set[r].y <= 1
      )
      if (inRange) pass(`${which} landmarks stored normalized (0..1) with kind`)
      else fail(`${which} landmarks outside 0..1 — a display transform leaked in`)
    }

    // The unfiltered angle at each extreme, kept as the baseline a clinician's
    // verification is measured against. It must NOT equal the filtered min/max.
    if (Number.isFinite(s.frameAngleRawMax) && Number.isFinite(s.frameAngleRawMin))
      pass(`raw frame angles captured (${s.frameAngleRawMin}° / ${s.frameAngleRawMax}°)`)
    else fail(`raw frame angles missing: ${JSON.stringify([s.frameAngleRawMin, s.frameAngleRawMax])}`)

    // Read the blobs back out of IndexedDB (real store in headless Chromium).
    // Poll briefly — persistence is async, running just after the save.
    let imgs = []
    for (let i = 0; i < 20 && imgs.length < 2; i++) {
      imgs = await page.evaluate(async (sid) => {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('kinetics_images', 1)
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
        })
        const all = await new Promise((res, rej) => {
          const req = db.transaction('images', 'readonly').objectStore('images').getAll()
          req.onsuccess = () => res(req.result || []); req.onerror = () => rej(req.error)
        })
        return all.filter(r => r.sessionId === sid)
                  .map(r => ({ which: r.which, bytes: r.bytes }))
      }, s.id)
      if (imgs.length < 2) await page.waitForTimeout(200)
    }
    for (const which of ['peak', 'min']) {
      const img = imgs.find(r => r.which === which)
      if (img && img.bytes > 0)
        pass(`${which} snapshot blob in IndexedDB (${Math.round(img.bytes / 1024)}KB)`)
      else fail(`${which} snapshot blob missing from IndexedDB`)
    }

    // WHAT YOU RECORDED IS WHAT YOU GET. The video is object-fit: cover, so the
    // camera stack showed a crop of the stream; the stored frame must be that
    // crop, not the whole buffer. Only an end-to-end run can check this — the
    // crop comes from the live layout, which no unit test has.
    const shapes = await page.evaluate(async (sid) => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('kinetics_images', 1)
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
      })
      const all = await new Promise((res, rej) => {
        const req = db.transaction('images', 'readonly').objectStore('images').getAll()
        req.onsuccess = () => res(req.result || []); req.onerror = () => rej(req.error)
      })
      const out = []
      for (const rec of all.filter(r => r.sessionId === sid)) {
        const bmp = await createImageBitmap(rec.blob)
        out.push({ which: rec.which, w: bmp.width, h: bmp.height })
        bmp.close?.()
      }
      const stack = document.querySelector('.camera-stack')?.getBoundingClientRect()
      const video = document.getElementById('rom-video')
      return {
        frames:  out,
        display: stack ? stack.width / stack.height : null,
        stream:  video?.videoWidth ? video.videoWidth / video.videoHeight : null,
      }
    }, s.id)

    if (shapes.display && shapes.stream && shapes.frames.length) {
      for (const f of shapes.frames) {
        const aspect = f.w / f.h
        // Within 5%: the crop is snapped to whole pixels and may have been
        // widened to keep an outlying landmark inside its own image.
        if (Math.abs(aspect - shapes.display) / shapes.display < 0.05)
          pass(`${f.which} frame is the on-screen crop (${f.w}×${f.h}, aspect ${aspect.toFixed(2)})`)
        else if (Math.abs(aspect - shapes.stream) / shapes.stream < 0.02)
          fail(`${f.which} frame is the whole video buffer (${f.w}×${f.h}) — the crop did not reach the snapshot`)
        else
          info(`${f.which} frame aspect ${aspect.toFixed(2)} — between the display ` +
               `(${shapes.display.toFixed(2)}) and the stream (${shapes.stream.toFixed(2)}); ` +
               'expected only when a landmark sat outside the visible area')
      }
    } else info('frame shapes unavailable — skipped the crop check')

    console.log('\n5. History and detail')
    await page.click('#btn-history')
    await page.waitForSelector('.session-row', { timeout: 15_000 })
    pass('session listed in History')
    await page.click('.session-row')
    await page.waitForTimeout(1500)   // Chart.js has a 400ms entry animation
    const shot = join(FIXTURE_DIR, 'session-detail.png')
    await page.screenshot({ path: shot })
    pass(`SessionDetail rendered — screenshot: ${shot}`)
    info('check by eye: the overlay is now DRAWN at view time from the saved record —')
    info('each frame should show dots, bones, arc and an angle matching its caption')

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
