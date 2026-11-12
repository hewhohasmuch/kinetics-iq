/**
 * verify-camera-flip.mjs — switching between the rear and front camera.
 *
 * Drives the real app (fake camera). Chromium's fake device has no notion of
 * front or rear, so the page's getUserMedia is wrapped: each call is logged,
 * and what the track REPORTS (front, rear, or nothing), whether the front
 * camera exists, how long a start takes and the stream's size are scripted
 * per step. Checks:
 *   - a confirmed front camera mirrors the preview and the overlay, and the
 *     session is stamped 'user'; the stored snapshot and landmarks are NOT
 *     flipped;
 *   - requested front but reported rear / reported nothing: never mirrored,
 *     never stamped front;
 *   - front unavailable: an error, and the previous camera comes back;
 *   - quick double tap: one switch, one live stream;
 *   - leaving mid-switch leaves no camera running;
 *   - Set Zero is cleared by a switch, and by a resume that falls back to the
 *     other camera;
 *   - the switch is gone while recording and disabled with the note box open;
 *   - SessionDetail's camera line, including "Not applicable" for a session
 *     saved before the camera was recorded.
 *
 * Usage: node scripts/verify-camera-flip.mjs [--headed]
 * A few minutes headless. Cannot tell whether iOS Safari reports the camera
 * direction or allows the switch inside one tap — that needs a device.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureFixture } from './e2e/fixture.mjs'

const HERE   = dirname(fileURLToPath(import.meta.url))
const HEADED = process.argv.includes('--headed')
const PORT   = 5179
const URL    = `https://localhost:${PORT}/`

const now = new Date().toISOString()
const P1 = {
  id: '11111111-2222-4333-8444-555555555555', name: 'Patient One', dob: null, mrn: '',
  diagnosis: '', surgeryDate: null, affectedSide: 'right', notes: '', created_at: now, updated_at: now,
}
// Saved before the camera was recorded: no cameraFacing at all.
const LEGACY_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const LEGACY = {
  id: LEGACY_ID, patient_id: P1.id, date: '2026-01-05', timestamp: Date.parse('2026-01-05T10:00:00'),
  joint: 'knee', side: 'right', position: null, min: 4, max: 96, rom: 92, samples: 40,
  duration_s: 4, angleTimeline: [4, 50, 96], angleMode: '2d2', angleFilter: 'euro1',
  angleConvention: 'perjoint1', calibrated: false, calibrationOffset: 0, notes: '',
  updated_at: Date.parse('2026-01-05T10:00:00'),
}

let failures = 0
const pass = (m) => console.log(`  ok    ${m}`)
const fail = (m) => { console.error(`  FAIL  ${m}`); failures++ }
const info = (m) => console.log(`        ${m}`)
const expectEq = (actual, expected, what) =>
  actual === expected ? pass(`${what}: ${actual}`) : fail(`${what}: got "${actual}", expected "${expected}"`)
const expectTrue = (cond, what) => (cond ? pass(what) : fail(what))

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

/** Camera ready: a reading on screen and Record available. */
async function waitForMeasuring(page) {
  await page.waitForFunction(() => {
    const rec = document.getElementById('btn-record-start')
    return /^-?\d+°$/.test(document.getElementById('angle-display')?.textContent ?? '') &&
           rec && rec.offsetParent !== null && !rec.disabled
  }, null, { timeout: 180_000 })
}

const cam        = (page) => page.evaluate(() => window.__cam.snapshot())
const setCam     = (page, patch) => page.evaluate((p) => Object.assign(window.__cam.script, p), patch)
const flipText   = (page) => page.textContent('#btn-flip-camera')
const settings   = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('rom_settings') || '{}'))
const sessions   = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('rom_sessions') || '[]'))
const isMirrored = (page) => page.evaluate(() => {
  const v = document.getElementById('rom-video')
  return { cls: v.classList.contains('mirrored'), flipped: getComputedStyle(v).transform.startsWith('matrix(-1') }
})

/** Where the joint dot is drawn, as a fraction of the overlay's width. */
async function jointDotX(page) {
  return page.evaluate(async () => {
    const read = () => {
      const c = document.getElementById('rom-overlay')
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let sum = 0, n = 0
      for (let y = 0; y < c.height; y += 2) {
        for (let x = 0; x < c.width; x += 2) {
          const p = (y * c.width + x) * 4
          // MARKER_COLORS.joint, #4ade80
          if (d[p + 3] > 150 && Math.abs(d[p] - 74) < 30 && Math.abs(d[p + 1] - 222) < 30 && Math.abs(d[p + 2] - 128) < 30) {
            sum += x; n++
          }
        }
      }
      return n > 20 ? sum / n / c.width : null
    }
    for (let i = 0; i < 40; i++) {
      const x = read()
      if (x !== null) return x
      await new Promise(r => setTimeout(r, 250))
    }
    return null
  })
}

/** Record a short take and save it. Returns the saved session. */
async function recordTake(page, { during } = {}) {
  const before = (await sessions(page)).length
  await page.click('#btn-record-start')
  await page.waitForTimeout(3_000)
  if (during) await during()
  await page.click('#btn-record-stop')
  await page.waitForSelector('#notes-panel', { state: 'visible' })
  const disabledWithNote = await page.isDisabled('#btn-flip-camera')
  await page.click('#btn-notes-skip')
  await page.waitForFunction((n) => JSON.parse(localStorage.getItem('rom_sessions') || '[]').length > n, before)
  const all = await sessions(page)
  const session = all.reduce((a, b) => (b.timestamp > a.timestamp ? b : a))
  return { session, disabledWithNote }
}

/** A stored snapshot as a small greyscale grid, plus its pixel size. */
async function snapshotGrid(page, sessionId, which = 'peak') {
  return page.evaluate(async ({ key }) => {
    const blob = await new Promise((resolve) => {
      let tries = 0
      const attempt = () => {
        const open = indexedDB.open('kinetics_images')
        open.onsuccess = () => {
          const db = open.result
          const get = db.transaction('images').objectStore('images').get(key)
          get.onsuccess = () => {
            db.close()
            if (get.result?.blob) resolve(get.result.blob)
            else if (++tries > 40) resolve(null)
            else setTimeout(attempt, 250)
          }
          get.onerror = () => { db.close(); resolve(null) }
        }
        open.onerror = () => resolve(null)
      }
      attempt()
    })
    if (!blob) return null
    const bmp = await createImageBitmap(blob)
    const W = 48, H = 36
    const c = document.createElement('canvas')
    c.width = W; c.height = H
    const ctx = c.getContext('2d')
    ctx.drawImage(bmp, 0, 0, W, H)
    const d = ctx.getImageData(0, 0, W, H).data
    const grey = []
    for (let i = 0; i < W * H; i++) grey.push(Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]))
    return { grey, W, H, width: bmp.width, height: bmp.height }
  }, { key: `${sessionId}:${which}` })
}

function mse(a, b, W, H, flipB) {
  let sum = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const bv = b[y * W + (flipB ? W - 1 - x : x)]
      sum += (a[y * W + x] - bv) ** 2
    }
  }
  return sum / (W * H)
}

async function main() {
  const y4m = await ensureFixture({ still: true })

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
    await context.addInitScript(({ patients, legacy }) => {
      // Seed once: a reload must keep what the run has saved.
      if (!localStorage.getItem('rom_patients')) {
        localStorage.setItem('rom_patients', JSON.stringify(patients))
        localStorage.setItem('rom_settings', JSON.stringify({
          active_patient_id: patients[0].id, calibration_version: 3,
        }))
        localStorage.setItem('rom_sessions', JSON.stringify([legacy]))
        localStorage.setItem('rom_outbox', '[]')
      }

      // ── The scripted camera ────────────────────────────────────────────
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      const cam = window.__cam = {
        requests: [],          // 'exact:user' | 'ideal:environment' | …
        streams: [],
        script: {
          report: { user: 'user', environment: 'environment' },  // undefined = says nothing
          failUser: false,     // the front camera does not exist
          delayMs: 0,          // how long a start takes
          size: { user: null, environment: null },               // {width,height} or null
        },
        snapshot() {
          return {
            requests: cam.requests.slice(),
            live: cam.streams.filter(s => s.getTracks().some(t => t.readyState === 'live')).length,
          }
        },
      }
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const fm = constraints?.video?.facingMode ?? {}
        const mode = fm.exact ? 'exact' : 'ideal'
        const want = fm.exact ?? fm.ideal ?? 'environment'
        cam.requests.push(`${mode}:${want}`)
        if (cam.script.delayMs) await new Promise(r => setTimeout(r, cam.script.delayMs))
        if (want === 'user' && cam.script.failUser) {
          throw new DOMException('no such camera', 'OverconstrainedError')
        }
        const size = cam.script.size[want]
        const video = size
          ? { width: { ideal: size.width }, height: { ideal: size.height } }
          : { width: { ideal: 640 }, height: { ideal: 480 } }
        const stream = await real({ video, audio: false })
        const reported = cam.script.report[want]
        for (const track of stream.getVideoTracks()) {
          const settingsOf = track.getSettings.bind(track)
          track.getSettings = () => {
            const s = { ...settingsOf() }
            delete s.facingMode
            if (reported) s.facingMode = reported
            return s
          }
        }
        cam.streams.push(stream)
        return stream
      }
    }, { patients: [P1], legacy: LEGACY })

    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#btn-start-camera', { timeout: 30_000 })

    console.log('\n1. Rear camera (the default)')
    expectEq(await flipText(page), '⇄ Rear', 'switch names the rear camera before any start')
    await page.click('#btn-start-camera')
    await waitForMeasuring(page)
    expectEq((await cam(page)).requests.at(-1), 'ideal:environment', 'request')
    let m = await isMirrored(page)
    expectTrue(!m.cls && !m.flipped, 'rear preview is not mirrored')
    const rearDot = await jointDotX(page)
    info(`joint dot at ${rearDot?.toFixed(3)} of the overlay width`)
    const rearSize = await page.evaluate(() => ({ w: document.getElementById('rom-video').videoWidth, h: document.getElementById('rom-video').videoHeight }))
    const rear = await recordTake(page, {
      during: async () => expectTrue(!(await page.isVisible('#btn-flip-camera')), 'switch is gone while a take records'),
    })
    expectTrue(rear.disabledWithNote, 'switch is disabled while the note box is open')
    expectEq(rear.session.cameraFacing, 'environment', 'rear session stamp')

    console.log('\n2. Set Zero, then switch to the front camera')
    await page.click('#btn-calibrate')
    await page.waitForFunction(() => document.getElementById('cal-status')?.textContent.startsWith('Zeroed'), null, { timeout: 120_000 })
    pass('zero set on the rear camera')
    // A different stream size and shape, as a real front camera has.
    await setCam(page, { size: { user: { width: 480, height: 480 }, environment: null } })
    await page.click('#btn-flip-camera')
    await waitForMeasuring(page)
    let c = await cam(page)
    expectEq(c.requests.at(-1), 'exact:user', 'request')
    expectEq(c.live, 1, 'live streams after the switch')
    m = await isMirrored(page)
    expectTrue(m.cls && m.flipped, 'front preview is mirrored')
    expectEq(await flipText(page), '⇄ Front', 'switch names the front camera')
    expectEq((await settings(page)).camera_facing, 'user', 'preference saved once confirmed')
    expectEq(await page.textContent('#cal-status'), 'Not zeroed — raw angles', 'zero cleared by the switch')
    const frontSize = await page.evaluate(() => ({ w: document.getElementById('rom-video').videoWidth, h: document.getElementById('rom-video').videoHeight }))
    info(`rear stream ${rearSize.w}x${rearSize.h}, front stream ${frontSize.w}x${frontSize.h}`)
    expectTrue(frontSize.w !== rearSize.w || frontSize.h !== rearSize.h, 'the front stream has a different size')

    const front = await recordTake(page)
    expectEq(front.session.cameraFacing, 'user', 'front session stamp')
    expectEq(front.session.calibrated, false, 'front session saved as not zeroed')

    console.log('\n3. Mirroring is display only')
    const frontSameSize = frontSize.w === rearSize.w && frontSize.h === rearSize.h
    if (frontSameSize) {
      const frontDot = await jointDotX(page)
      expectTrue(rearDot !== null && frontDot !== null && Math.abs(frontDot - (1 - rearDot)) < 0.04,
        `overlay dot is mirrored on screen (${frontDot?.toFixed(3)} vs ${(1 - rearDot).toFixed(3)})`)
    }
    // Same stream shape for a like-for-like picture: switch back and forth once.
    await setCam(page, { size: { user: null, environment: null } })
    await page.click('#btn-flip-camera'); await waitForMeasuring(page)
    await page.click('#btn-flip-camera'); await waitForMeasuring(page)
    expectEq(await flipText(page), '⇄ Front', 'front again, same stream size as the rear')
    const frontDot = await jointDotX(page)
    expectTrue(rearDot !== null && frontDot !== null && Math.abs(frontDot - (1 - rearDot)) < 0.04,
      `overlay dot is mirrored on screen (${frontDot?.toFixed(3)} vs ${rearDot === null ? 'n/a' : (1 - rearDot).toFixed(3)})`)
    const front2 = await recordTake(page)
    const rearJoint  = rear.session.landmarksRaw?.peak?.joint
    const frontJoint = front2.session.landmarksRaw?.peak?.joint
    expectTrue(rearJoint && frontJoint && Math.abs(rearJoint.x - frontJoint.x) < 0.04,
      `stored landmark x is not flipped (rear ${rearJoint?.x.toFixed(3)}, front ${frontJoint?.x.toFixed(3)})`)
    const rearGrid  = await snapshotGrid(page, rear.session.id)
    const frontGrid = await snapshotGrid(page, front2.session.id)
    if (!rearGrid || !frontGrid) fail('stored snapshots not found in IndexedDB')
    else {
      const same    = mse(frontGrid.grey, rearGrid.grey, rearGrid.W, rearGrid.H, false)
      const flipped = mse(frontGrid.grey, rearGrid.grey, rearGrid.W, rearGrid.H, true)
      info(`snapshot difference: vs rear ${same.toFixed(1)}, vs mirrored rear ${flipped.toFixed(1)}`)
      expectTrue(same * 4 < flipped, 'stored front snapshot is the true image, not its mirror')
    }
    // The differently-sized front take: its snapshot follows the camera stack.
    const sizedGrid = await snapshotGrid(page, front.session.id)
    const stack = await page.evaluate(() => {
      const r = document.querySelector('.camera-stack').getBoundingClientRect()
      return r.width / r.height
    })
    if (!sizedGrid) fail('snapshot for the differently-sized stream not found')
    else {
      const aspect = sizedGrid.width / sizedGrid.height
      info(`stored ${sizedGrid.width}x${sizedGrid.height} (aspect ${aspect.toFixed(3)}), camera stack ${stack.toFixed(3)}`)
      const lm = Object.values(front.session.landmarksRaw?.peak ?? {})
      expectTrue(lm.length === 3 && lm.every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1),
        'landmarks of the differently-sized stream lie inside its stored frame')
    }

    console.log('\n4. History and back: the front camera resumes')
    await page.click('#btn-history')
    await page.waitForSelector('.history-view')
    await page.click('#btn-back')
    await waitForMeasuring(page)
    expectEq((await cam(page)).requests.at(-1), 'exact:user', 'resume request')
    m = await isMirrored(page)
    expectTrue(m.cls && m.flipped, 'still mirrored after the round trip')
    expectEq((await cam(page)).live, 1, 'live streams')

    console.log('\n5. Requested front, but the stream reports rear')
    await page.click('#btn-flip-camera'); await waitForMeasuring(page)       // to rear
    expectEq(await flipText(page), '⇄ Rear', 'back on the rear camera')
    await setCam(page, { report: { user: 'environment', environment: 'environment' } })
    await page.click('#btn-flip-camera'); await waitForMeasuring(page)
    expectEq((await cam(page)).requests.at(-1), 'exact:user', 'request')
    m = await isMirrored(page)
    expectTrue(!m.cls && !m.flipped, 'not mirrored: the confirmed camera is rear')
    expectEq(await flipText(page), '⇄ Rear', 'switch names the camera actually running')
    expectEq((await settings(page)).camera_facing, 'environment', 'preference follows the confirmed camera')
    const lied = await recordTake(page)
    expectEq(lied.session.cameraFacing, 'environment', 'session stamp is the confirmed camera')

    console.log('\n6. The stream reports nothing')
    await setCam(page, { report: { user: undefined, environment: undefined } })
    await page.click('#btn-flip-camera'); await waitForMeasuring(page)
    m = await isMirrored(page)
    expectTrue(!m.cls && !m.flipped, 'not mirrored: the camera is not identified')
    expectEq(await flipText(page), '⇄ Camera', 'switch does not name a camera it cannot confirm')
    expectEq((await settings(page)).camera_facing, 'environment', 'an unconfirmed camera is not remembered')
    const silent = await recordTake(page)
    expectEq(silent.session.cameraFacing, 'unknown', 'session stamp')

    console.log('\n7. Front camera not available')
    await setCam(page, { report: { user: 'user', environment: 'environment' } })
    await page.click('#btn-flip-camera'); await waitForMeasuring(page)       // to a confirmed rear
    expectEq(await flipText(page), '⇄ Rear', 'on the rear camera')
    await setCam(page, { failUser: true })
    await page.click('#btn-flip-camera')
    await waitForMeasuring(page)
    expectEq(await page.textContent('#error-msg'), 'This device has no front camera available.', 'error shown')
    expectEq(await flipText(page), '⇄ Rear', 'previous camera restored')
    m = await isMirrored(page)
    expectTrue(!m.cls, 'not mirrored')
    expectEq((await settings(page)).camera_facing, 'environment', 'preference unchanged')
    expectEq((await cam(page)).live, 1, 'live streams')

    console.log('\n8. Quick double tap')
    await setCam(page, { failUser: false, delayMs: 800 })
    let before = (await cam(page)).requests.length
    await page.evaluate(() => {
      const b = document.getElementById('btn-flip-camera')
      b.click(); b.click()
    })
    await waitForMeasuring(page)
    await page.waitForTimeout(1_500)
    c = await cam(page)
    expectEq(c.requests.length - before, 1, 'camera requests from two taps')
    expectEq(c.live, 1, 'live streams')
    expectEq(await flipText(page), '⇄ Front', 'ended on the front camera')

    console.log('\n9. Set Zero on the front camera, then leave mid-switch')
    await setCam(page, { delayMs: 0 })
    await page.click('#btn-calibrate')
    await page.waitForFunction(() => document.getElementById('cal-status')?.textContent.startsWith('Zeroed'), null, { timeout: 120_000 })
    await setCam(page, { delayMs: 1_500 })
    await page.click('#btn-flip-camera')                 // to rear, slowly
    await page.click('#patient-chip')                    // leave while it starts
    await page.waitForSelector(`.patient-row[data-id="${P1.id}"]`)
    await page.waitForTimeout(3_000)                     // the late stream arrives now
    expectEq((await cam(page)).live, 0, 'live streams after leaving mid-switch')
    expectEq((await settings(page)).camera_facing, 'user', 'an unfinished switch is not remembered')

    console.log('\n10. Return: the remembered front camera fails, the rear one takes over')
    await setCam(page, { delayMs: 0, failUser: true })
    before = (await cam(page)).requests.length
    await page.click(`.patient-row[data-id="${P1.id}"]`)
    await waitForMeasuring(page)
    c = await cam(page)
    expectEq(c.requests.slice(before).join(', '), 'exact:user, ideal:environment', 'requests on resume')
    expectEq(c.live, 1, 'live streams')
    expectEq(await flipText(page), '⇄ Rear', 'running on the rear camera')
    m = await isMirrored(page)
    expectTrue(!m.cls, 'not mirrored')
    expectEq((await settings(page)).camera_facing, 'environment', 'preference reset to rear')
    expectEq(await page.textContent('#cal-status'), 'Not zeroed — raw angles', 'front-camera zero dropped on the rear camera')
    const fallback = await recordTake(page)
    expectEq(fallback.session.calibrated, false, 'session saved as not zeroed')
    expectEq(fallback.session.cameraFacing, 'environment', 'session stamp')

    console.log('\n11. SessionDetail camera line')
    await page.click('#btn-history')
    await page.waitForSelector('.history-view')
    const expectLine = async (id, text, what) => {
      await page.click(`.session-row[data-id="${id}"]`)
      await page.waitForSelector('#detail-camera')
      expectEq(await page.textContent('#detail-camera'), text, what)
      await page.click('#btn-detail-back')
      await page.waitForSelector('.history-view')
    }
    await expectLine(front.session.id,  'Camera: Front',          'front session')
    await expectLine(rear.session.id,   'Camera: Rear',           'rear session')
    await expectLine(silent.session.id, 'Camera: Not identified', 'unidentified camera')
    await expectLine(LEGACY_ID,         'Camera: Not applicable', 'session saved before the camera was recorded')

    console.log('\n12. Whole run')
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
