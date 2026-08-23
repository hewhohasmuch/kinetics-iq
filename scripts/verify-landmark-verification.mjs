/**
 * Drives clinician landmark verification at the real UI surface: the editor
 * modal, the drag, the recomputed angle, what persists, and every place the
 * result is supposed to surface (stat cards, chip, note, History badge).
 *
 * src/ui/ has no unit tests, so this is the only thing that proves the feature
 * reaches a clinician rather than merely existing in core/.
 *
 *   node scripts/verify-landmark-verification.mjs
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { request as httpsRequest } from 'node:https'

const PORT = 5178
const URL = `https://localhost:${PORT}/`
const PATIENT = '11111111-1111-4111-8111-111111111111'
const SID = 'aaaaaaaa-0000-4000-8000-000000000001'

/** A bent set: collinear points would make every angle 0 and prove nothing. */
const set = (jx, jy) => ({
  proximal: { x: 0.25, y: 0.25, visibility: 0.95, kind: 'anatomical' },
  joint:    { x: jx,   y: jy,   visibility: 0.95, kind: 'anatomical' },
  distal:   { x: 0.75, y: 0.25, visibility: 0.95, kind: 'anatomical' },
})

const session = {
  id: SID, patient_id: PATIENT, joint: 'knee', side: 'right', position: 'supine',
  date: '2026-08-22', timestamp: Date.now(),
  min: 3.5, max: 74.8, rom: 71.3, duration_s: 27, samples: 24,
  angleTimeline: [3.5, 40, 74.8, 40, 3.5], notes: '',
  angleMode: '2d2', angleFilter: 'euro1', angleConvention: 'perjoint1',
  calibrated: false, calibrationOffset: 0,
  peakFramePath: null, minFramePath: null,
  landmarkSpace: 'video1',
  modelId: 'blazepose-full', modelVersion: 'tasks-vision@0.10.35+float16/latest',
  landmarksRaw: { peak: set(0.5, 0.6), min: set(0.5, 0.3) },
  frameAngleRawMax: 74.2, frameAngleRawMin: 4.1,
  frameTiltMax: 6.2, frameTiltMin: 3.9,
  updated_at: Date.now(),
}

const fails = []
const check = (name, cond, detail = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? ' :: ' + detail : ''))
  if (!cond) fails.push(name)
}

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: process.cwd(), shell: true, stdio: 'pipe' })
server.stdout.on('data', () => {}); server.stderr.on('data', () => {})

function waitForServer(url, timeoutMs = 60000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = httpsRequest(url, { rejectUnauthorized: false, method: 'GET' }, () => resolve())
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error('server never came up'))
        else setTimeout(tryOnce, 500)
      })
      req.end()
    }
    tryOnce()
  })
}

const readSession = (page) => page.evaluate(
  () => JSON.parse(localStorage.getItem('rom_sessions'))[0])

try {
  await waitForServer(URL)
  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 430, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })

  await ctx.addInitScript(({ s, sid }) => {
    localStorage.setItem('rom_patients', JSON.stringify([{ id: s.patient_id, name: 'Jane Poppins', updated_at: Date.now() }]))
    localStorage.setItem('rom_sessions', JSON.stringify([s]))
    localStorage.setItem('rom_settings', JSON.stringify({ active_patient_id: s.patient_id }))
    window.__seedImages = async () => {
      const c = document.createElement('canvas')
      c.width = 1280; c.height = 720
      const cx = c.getContext('2d')
      cx.fillStyle = '#2a4d6e'; cx.fillRect(0, 0, 1280, 720)
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9))
      const db = await new Promise((res, rej) => {
        const rq = indexedDB.open('kinetics_images', 1)
        rq.onupgradeneeded = () => {
          if (!rq.result.objectStoreNames.contains('images')) rq.result.createObjectStore('images', { keyPath: 'key' })
        }
        rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error)
      })
      for (const which of ['peak', 'min']) {
        await new Promise((res, rej) => {
          const tx = db.transaction('images', 'readwrite')
          tx.objectStore('images').put({ key: `${sid}:${which}`, sessionId: sid, which, blob, uploaded: false, at: Date.now() })
          tx.oncomplete = res; tx.onerror = () => rej(tx.error)
        })
      }
    }
  }, { s: session, sid: SID })

  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.__seedImages())

  console.log('\n1. A model-measured session offers verification')
  await page.waitForSelector('#btn-history', { state: 'attached', timeout: 30000 })
  await page.evaluate(() => document.getElementById('btn-history').click())
  await page.waitForSelector('.session-row', { timeout: 15000 })
  check('History shows no verified badge yet', await page.locator('.verified-badge').count() === 0)

  await page.click('.session-row')
  await page.waitForTimeout(1200)
  check('stat card shows the model maximum', (await page.textContent('#stat-max')).includes('74.8'))
  check('verify button offered on the peak frame',
    await page.locator('.btn-verify[data-which="peak"]').isVisible())
  check('no "remove verification" control yet',
    !(await page.locator('#btn-unverify').isVisible()))

  console.log('\n2. The editor opens on the stored frame')
  await page.click('.btn-verify[data-which="peak"]')
  await page.waitForSelector('#lm-canvas', { timeout: 10000 })
  const before = await page.textContent('#lm-angle')
  check('editor shows a starting angle', /\d/.test(before), before)

  console.log('\n3. Dragging a landmark recomputes the angle')
  const box = await page.locator('#lm-canvas').boundingBox()
  // The joint point sits at normalized (0.5, 0.6) in the seeded set.
  const from = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.6 }
  const to   = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.85 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  await page.screenshot({ path: 'tmp/verify-landmarks-editor.png' })
  const after = await page.textContent('#lm-angle')
  check('angle changed while dragging', before !== after, `${before} -> ${after}`)
  check('a segment-length advisory is shown',
    ((await page.textContent('#lm-lengths')) || '').includes('Segment length'))

  console.log('\n4. Saving records an endpoint observation, not a rewrite')
  await page.click('#lm-save')
  await page.waitForTimeout(900)

  const saved = await readSession(page)
  const v = saved.verifications?.[0]
  check('exactly one verification stored', saved.verifications?.length === 1)
  check('verified peak angle stored', Number.isFinite(v?.angles?.max), JSON.stringify(v?.angles))
  check('minimum left unverified', v?.angles?.min === null)
  check('attribution records device mode', v?.byMode === 'device' && Boolean(v?.byDevice))
  check('RAW landmarks untouched',
    JSON.stringify(saved.landmarksRaw) === JSON.stringify(session.landmarksRaw))
  check('stored max UNCHANGED — verification is an annotation', saved.max === 74.8)
  check('angleTimeline untouched',
    JSON.stringify(saved.angleTimeline) === JSON.stringify(session.angleTimeline))
  check('a sync op was queued (this is what blocks sign-out)',
    JSON.parse(await page.evaluate(() => localStorage.getItem('rom_outbox') || '[]'))
      .some(o => o.type === 'upsert_session' && o.entity_id === SID))

  console.log('\n5. The result surfaces where a clinician reads it')
  const statMax = await page.textContent('#stat-max')
  check('stat card now shows the VERIFIED maximum',
    statMax.includes(String(v.angles.max)), statMax)
  check('SessionDetail shows the verified chip',
    (await page.textContent('#detail-provenance')).includes('Clinician-verified'))
  check('"remove verification" is now offered',
    await page.locator('#btn-unverify').isVisible())

  const note = await page.evaluate(async () => {
    const m = await import('/src/core/report.js')
    return m.sessionNoteText(JSON.parse(localStorage.getItem('rom_sessions'))[0])
  })
  check('note states the verification', /Clinician-verified/.test(note))
  check('note attributes the ROM to verified endpoints',
    /between clinician-verified endpoints/.test(note))
  check('note names no person', !/user-|Poppins/i.test(note))
  check('note never strengthens the claim',
    !/validated|corrected|accurate/i.test(note))

  await page.screenshot({ path: 'tmp/verify-landmarks-detail.png', fullPage: true })

  console.log('\n6. History marks it')
  await page.click('#btn-back, .btn-back, header button')
    .catch(() => page.evaluate(() => document.querySelector('#btn-back')?.click()))
  await page.waitForTimeout(900)
  check('History row carries the verified badge',
    await page.locator('.verified-badge').count() > 0)

  console.log('\n7. Revert returns it to model-measured')
  await page.click('.session-row')
  await page.waitForTimeout(900)
  await page.click('#btn-unverify')
  await page.waitForTimeout(900)
  const reverted = await readSession(page)
  check('verification layer emptied', Array.isArray(reverted.verifications) && reverted.verifications.length === 0)
  check('stat card back to the model maximum',
    (await page.textContent('#stat-max')).includes('74.8'))
  check('verified chip gone',
    !(await page.textContent('#detail-provenance')).includes('Clinician-verified'))

  console.log('\n8. Console health')
  const real = errors.filter(e => !/ERR_CERT|favicon|self.signed/i.test(e))
  check('no console errors', real.length === 0, real.slice(0, 3).join(' | '))

  await browser.close()
} catch (e) {
  console.error('HARNESS ERROR:', e && e.stack || e)
  fails.push('harness')
} finally {
  server.kill()
  console.log(fails.length === 0 ? '\nPASSED' : `\nFAILED: ${fails.length}\n - ` + fails.join('\n - '))
  setTimeout(() => process.exit(fails.length === 0 ? 0 : 1), 200)
}
