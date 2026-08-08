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
import { writeFileSync } from 'node:fs'
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

/**
 * Read a saved snapshot back out of IndexedDB and measure its high-frequency
 * energy on a 12x12 grid — mean absolute difference between horizontally
 * adjacent pixels, red channel. A blurred region reads near zero; detailed
 * photo texture reads high.
 *
 * @param {import('playwright').Page} page
 * @param {string} sid  session id
 * @param {'peak'|'min'} which
 */
function gridFor(page, sid, which) {
  return page.evaluate(async ({ sid, which }) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('kinetics_images', 1)
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    })
    const all = await new Promise((res, rej) => {
      const req = db.transaction('images', 'readonly').objectStore('images').getAll()
      req.onsuccess = () => res(req.result || []); req.onerror = () => rej(req.error)
    })
    const rec = all.find((r) => r.sessionId === sid && r.which === which)
    if (!rec || !rec.blob) return null

    const bmp = await createImageBitmap(rec.blob)
    const cv  = document.createElement('canvas')
    cv.width = bmp.width; cv.height = bmp.height
    const cx = cv.getContext('2d')
    cx.drawImage(bmp, 0, 0)
    const { data } = cx.getImageData(0, 0, cv.width, cv.height)

    const N  = 12
    const cw = Math.floor(cv.width / N)
    const ch = Math.floor(cv.height / N)
    if (cw < 2 || ch < 2) return null

    // Kept in grid order (gy, gx) so the caller can locate cells, not just
    // magnitudes.
    const grid = []
    for (let gy = 0; gy < N; gy++) {
      const row = []
      for (let gx = 0; gx < N; gx++) {
        let sum = 0, n = 0
        for (let y = gy * ch; y < (gy + 1) * ch; y++) {
          for (let x = gx * cw; x < (gx + 1) * cw - 1; x++) {
            const i = (y * cv.width + x) * 4
            sum += Math.abs(data[i] - data[i + 4])
            n++
          }
        }
        row.push(n ? sum / n : 0)
      }
      grid.push(row)
    }

    const sorted = grid.flat().slice().sort((a, b) => a - b)
    let minGx = -1, minGy = -1, minVal = Infinity
    for (let gy = 0; gy < N; gy++) {
      for (let gx = 0; gx < N; gx++) {
        if (grid[gy][gx] < minVal) { minVal = grid[gy][gx]; minGx = gx; minGy = gy }
      }
    }
    return {
      min: sorted[0],
      median: sorted[Math.floor(sorted.length / 2)],
      minGx, minGy,
      grid, N,
      width: cv.width, height: cv.height,
      dataUrl: cv.toDataURL('image/png'),
    }
  }, { sid, which })
}

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
    if (process.env.E2E_DIAG) {
      // DIAG: the LIVE preview — overlay canvas stacked over the video element
      // by CSS. Alignment here is guaranteed by construction (same box, same
      // _scale), so this is the control for whether a misaligned redaction in
      // the stored snapshot is a compositing bug or a capture-timing artifact.
      const p = join(FIXTURE_DIR, 'live-preview.png')
      await page.locator('.camera-stack').screenshot({ path: p })
      info(`DIAG live preview -> ${p}`)
    }
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

    // Snapshots moved off localStorage: the session must carry NO inline image
    // bytes, only (initially null) cloud path fields. The JPEG blobs live in
    // IndexedDB instead. This is the regression guard for the storage-full bug.
    if (s.peakFrame === undefined && s.minFrame === undefined)
      pass('no inline image bytes on the saved session (localStorage stays small)')
    else fail('session still carries inline peakFrame/minFrame bytes')

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

    // Grid the peak snapshot for the redaction checks below. This catches the
    // whole class of silent failures in one measurement — unsupported
    // ctx.filter, an alpha leak, redaction drawn in the wrong order, a region
    // computed somewhere daft. The geometry itself is pinned by
    // src/core/headRegion.test.js, and the screenshot below is still checked
    // by eye.
    const smooth = await gridFor(page, s.id, 'peak')

    // DIAG: dump the grid and export the analysed snapshot, so the head cells
    // below can be re-measured against the image they were derived from.
    if (smooth && process.env.E2E_DIAG) {
      for (const which of ['peak', 'min']) {
        const d = which === 'peak' ? smooth : await gridFor(page, s.id, which)
        if (!d) { info(`DIAG ${which}: unavailable`); continue }
        const p = join(FIXTURE_DIR, `${which}-analysed.png`)
        writeFileSync(p, Buffer.from(d.dataUrl.split(',')[1], 'base64'))
        info(`DIAG ${which} ${d.width}x${d.height} -> ${p}  (cell ${Math.floor(d.width / d.N)}x${Math.floor(d.height / d.N)}px)`)
        info(`DIAG ${which} grid (row=gy, col=gx):\n` +
          '      gx:' + Array.from({ length: d.N }, (_, i) => String(i).padStart(5)).join(' ') + '\n' +
          d.grid.map((row, gy) => `  gy=${String(gy).padStart(2)} ` +
            row.map((v) => v.toFixed(1).padStart(5)).join(' ')).join('\n'))
      }
    }

    // REDACTION CHECK — uniformity, not relative smoothness.
    //
    // This replaces a head-vs-body comparison that the blur forced on us. The
    // obvious formulation ("head is smoother than the frame median") was
    // unsatisfiable: roughly half this fixture is flat sky and ocean, dragging
    // the median to ~0.8, while a genuinely blurred face measured 1.3-3.8. The
    // only way to pass a median-relative ceiling was for the blur to land ON
    // the sky — precisely the bug the check existed to catch.
    //
    // An opaque occluder makes the assertion absolute instead of comparative.
    // A solid fill has NO internal texture, so its cells read at JPEG-noise
    // level. That is a property of the redaction itself, not of how it compares
    // to its surroundings, and nothing about the sky can satisfy it while the
    // body cells stay textured.
    //
    // HEAD CELLS ARE FIXTURE-SPECIFIC. At the stored resolution of 430x644 with
    // a 12x12 grid (cell 35x53px) the head sits at columns 4-6, rows 4-5;
    // column 6 is excluded because it is dominated by the sharp hairline and
    // collar just outside the mask. RE-MEASURE if scripts/e2e/fixture.mjs or
    // the source photo changes: rerun with E2E_DIAG=1, open
    // .fixtures/peak-analysed.png, grid-overlay a candidate block and confirm
    // by eye that it sits on the mask.
    const HEAD_CELL_GX = [4, 5]
    const HEAD_CELL_GY = [4, 5]
    const BODY_CELL_GX = [4, 5, 6, 7]
    const BODY_CELL_GY = [8, 9]        // torso/legs — always sharp, never masked

    // An opaque fill measured through JPEG at quality 0.78. Cells that overlap
    // the feather band or the outline read higher, so the assertion is on the
    // FLATTEST head cell, which is pure core.
    const UNIFORM_MAX  = 1.0
    // Proves the frame is a real photo and not a blank canvas — without this,
    // an all-black snapshot would pass the uniformity test triumphantly.
    const TEXTURED_MIN = 3.0

    if (!smooth) {
      fail('could not read the peak snapshot back for redaction check')
    } else {
      const cellsOf = (gxs, gys) => {
        const out = []
        for (const gy of gys) for (const gx of gxs) out.push(smooth.grid[gy][gx])
        return out
      }
      const headCells = cellsOf(HEAD_CELL_GX, HEAD_CELL_GY)
      const bodyCells = cellsOf(BODY_CELL_GX, BODY_CELL_GY)
      const headMin   = Math.min(...headCells)
      const bodyMean  = bodyCells.reduce((a, b) => a + b, 0) / bodyCells.length

      const dumpGrid = () => info('grid (row=gy, col=gx):\n' +
        smooth.grid.map((row) => row.map((v) => v.toFixed(1).padStart(5)).join(' ')).join('\n'))

      if (headMin < UNIFORM_MAX) {
        pass(`head region is a uniform opaque mask (flattest head cell ${headMin.toFixed(2)}, ` +
             `required < ${UNIFORM_MAX})`)
      } else {
        dumpGrid()
        fail(`head region is NOT masked — flattest head cell (gx ${HEAD_CELL_GX}, ` +
             `gy ${HEAD_CELL_GY}) is ${headMin.toFixed(2)}, required < ${UNIFORM_MAX}. ` +
             `Rerun with E2E_DIAG=1 to dump the grid and export the snapshot.`)
      }

      if (bodyMean > TEXTURED_MIN) {
        pass(`snapshot is a real photograph (sharp body detail ${bodyMean.toFixed(1)})`)
      } else {
        dumpGrid()
        fail(`snapshot has no sharp detail anywhere — body cells mean ${bodyMean.toFixed(1)}, ` +
             `required > ${TEXTURED_MIN}. The uniformity check above is meaningless ` +
             `if the whole frame is flat.`)
      }
    }

    // Redaction mode reached the record.
    if (s.faceRedaction === 'mask1')
      pass(`session stamped faceRedaction=${s.faceRedaction}`)
    else fail(`session faceRedaction is ${JSON.stringify(s.faceRedaction)}, expected "mask1"`)

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
    info('check by eye: the head is fully masked in both frames, opaque core, no sharp rim')

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
