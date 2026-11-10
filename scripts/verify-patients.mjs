/**
 * verify-patients.mjs — the Patients screen's search and "Save & measure".
 *
 * src/ui/ has no unit tests, so this drives the real view. What it pins:
 *   1. Search filters the list by name or MRN as you type, says so when
 *      nothing matches, and a tap on a filtered row selects THAT patient.
 *   2. Save & measure on the New patient form stores the patient, makes them
 *      active and opens Measure on them — and does none of that for an empty
 *      name or when storage refuses the write (the form used to close as if
 *      it had saved).
 *   3. Plain Save (and the keyboard's Enter) still stays on Patients, and
 *      drops a leftover search so the new row is visible.
 *   4. The Edit form offers no Save & measure.
 *
 * Usage: node scripts/verify-patients.mjs [--headed] [--shots <dir>]
 * Camera-free, under a minute.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE   = dirname(fileURLToPath(import.meta.url))
const HEADED = process.argv.includes('--headed')
const SHOTS  = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null
const PORT   = 5180
const URL    = `https://localhost:${PORT}/`

const now = new Date().toISOString()
const patient = (id, name, mrn = '', dob = null) => ({
  id, name, dob, mrn, diagnosis: '', surgeryDate: null,
  affectedSide: null, notes: '', created_at: now, updated_at: now,
})
const ANN    = patient('11111111-2222-4333-8444-555555555555', 'Ann Lee', 'A-100')
const JOANNE = patient('22222222-3333-4444-8555-666666666666', 'Joanne Smith', '2201', '1961-03-02')
const JOHN   = patient('33333333-4444-4555-8666-777777777777', 'John Smith', '4471', '1984-11-20')
const JOSE   = patient('44444444-5555-4666-8777-888888888888', 'José Álvarez', '9005')

let failures = 0
const pass = (m) => console.log(`  ok    ${m}`)
const fail = (m) => { console.error(`  FAIL  ${m}`); failures++ }
const check = (cond, okMsg, failMsg) => cond ? pass(okMsg) : fail(failMsg ?? okMsg)

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

const stored   = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key)
const rowNames = (page) => page.$$eval('.patient-row .patient-name',
  els => els.map(e => e.childNodes[0].textContent.trim()))
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }) }

async function openPatients(page) {
  await page.click('#patient-chip')
  await page.waitForSelector('.patients-view')
}
async function search(page, text) {
  await page.fill('#patient-search', text)
}

async function main() {
  // Vite's own entry run with node, not `npx` through a shell: on Windows
  // kill() then ends only the shell, and the orphaned server keeps the port.
  const root = join(HERE, '..')
  const server = spawn(process.execPath,
    [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: 'ignore' })
  let browser

  try {
    await waitForServer(URL)
    browser = await chromium.launch({ headless: !HEADED })
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 430, height: 932 } })
    await context.addInitScript(({ patients, activeId }) => {
      if (localStorage.getItem('rom_patients')) return   // seed once, not per reload
      localStorage.setItem('rom_patients', JSON.stringify(patients))
      localStorage.setItem('rom_settings', JSON.stringify({ active_patient_id: activeId, calibration_version: 3 }))
      localStorage.setItem('rom_sessions', '[]')
      localStorage.setItem('rom_outbox', '[]')
    }, { patients: [JOHN, ANN, JOSE, JOANNE], activeId: ANN.id })

    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#patient-chip', { timeout: 30_000 })

    console.log('\n1. Search filters the list')
    await openPatients(page)
    check(await page.isVisible('#patient-search'), 'search field shown when there are patients')
    let names = await rowNames(page)
    check(names.length === 4, 'all four patients listed', `listed: ${names.join(', ')}`)
    await shot(page, 'patients-list')

    await page.click('#patient-search')
    await page.keyboard.type('smith')
    names = await rowNames(page)
    check(names.join('|') === 'Joanne Smith|John Smith', '"smith" → both Smiths', `"smith" → ${names.join(', ')}`)
    check(await page.evaluate(() => document.activeElement?.id === 'patient-search'),
      'the field keeps focus while the list re-renders')
    const meta = await page.$$eval('.patient-row .patient-meta', els => els.map(e => e.textContent))
    check(meta.some(m => m.includes('1984-11-20')) && meta.some(m => m.includes('1961-03-02')),
      'filtered rows still show DOB, to tell similar names apart', `meta: ${meta.join(' / ')}`)
    await shot(page, 'patients-filtered')

    await page.keyboard.type(' john')
    names = await rowNames(page)
    check(names.join('|') === 'John Smith', 'a second word narrows to John Smith', `"smith john" → ${names.join(', ')}`)

    await search(page, '2201')
    names = await rowNames(page)
    check(names.join('|') === 'Joanne Smith', 'an MRN finds its patient', `"2201" → ${names.join(', ')}`)

    await search(page, 'zzz')
    check(await page.locator('.patient-row').count() === 0 &&
      (await page.textContent('#patient-no-match')).includes('No patients match “zzz”'),
      'no match says so')
    await shot(page, 'patients-no-match')

    await search(page, '')
    check((await rowNames(page)).length === 4, 'clearing the search restores the list')

    await search(page, 'jose')
    names = await rowNames(page)
    check(names.join('|') === 'José Álvarez', 'accents are ignored', `"jose" → ${names.join(', ')}`)
    await page.click('.patient-row')
    await page.waitForSelector('#patient-chip-label')
    check((await page.textContent('#patient-chip-label')).trim() === 'José Álvarez' &&
      (await stored(page, 'rom_settings')).active_patient_id === JOSE.id,
      'tapping the filtered row opens Measure on that patient')

    console.log('\n2. Save & measure')
    await openPatients(page)
    check(await page.inputValue('#patient-search') === '', 'the search does not carry over to a fresh visit')
    await page.click('#btn-new-patient')
    await page.waitForSelector('#patient-form-panel', { state: 'visible' })
    check(await page.isVisible('#btn-form-save-measure'), 'New patient form offers Save & measure')
    await shot(page, 'patients-new-form')
    const oneRow = await page.$$eval('.form-buttons button', els => new Set(els.map(e => Math.round(e.getBoundingClientRect().top))).size === 1)
    check(oneRow, 'the three form buttons fit on one row')

    await page.click('#btn-form-save-measure')
    check(await page.isVisible('#patient-form-panel') && (await stored(page, 'rom_patients')).length === 4,
      'an empty name saves nothing and stays on the form')

    // Storage refusing the write: upsertPatient() returns null.
    await page.evaluate(() => {
      const real = Storage.prototype.setItem
      window.__restoreSetItem = () => { Storage.prototype.setItem = real }
      Storage.prototype.setItem = function (k, v) {
        if (k === 'rom_patients') throw new Error('QuotaExceededError (simulated)')
        return real.call(this, k, v)
      }
    })
    await page.fill('#pf-name', 'Zed Newman')
    await page.fill('#pf-mrn', '7007')
    await page.click('#btn-form-save-measure')
    check(await page.isVisible('#patient-form-error') && await page.isVisible('#patient-form-panel') &&
      await page.locator('.patients-view').count() === 1 &&
      (await stored(page, 'rom_settings')).active_patient_id === JOSE.id,
      'a refused write shows "Could not save", keeps the form open and does not navigate')
    await page.evaluate(() => window.__restoreSetItem())

    const outboxBefore = (await stored(page, 'rom_outbox')).length
    await page.click('#btn-form-save-measure')
    await page.waitForSelector('#patient-chip-label')
    const patients = await stored(page, 'rom_patients')
    const zed = patients.find(p => p.name === 'Zed Newman')
    check(Boolean(zed) && patients.length === 5 && zed.mrn === '7007', 'the new patient is stored with the form fields')
    check((await page.textContent('#patient-chip-label')).trim() === 'Zed Newman', 'Measure opens on the new patient')
    check((await stored(page, 'rom_settings')).active_patient_id === zed?.id, 'the new patient is the active patient')
    const newOps = (await stored(page, 'rom_outbox')).slice(outboxBefore)
    check(newOps.length === 1 && newOps[0].type === 'upsert_patient' && newOps[0].entity_id === zed?.id,
      'exactly one upsert_patient op queued', `new ops: ${JSON.stringify(newOps)}`)

    console.log('\n3. Plain Save stays on Patients')
    await openPatients(page)
    await search(page, 'smith')
    await page.click('#btn-new-patient')
    await page.waitForSelector('#patient-form-panel', { state: 'visible' })
    await page.fill('#pf-name', 'Quinn Park')
    await page.press('#pf-name', 'Enter')          // the keyboard's Go key = the form's submit = plain Save
    await page.waitForSelector('#patient-form-panel', { state: 'hidden' })
    check(await page.locator('.patients-view').count() === 1, 'Enter saves without leaving Patients')
    names = await rowNames(page)
    check(await page.inputValue('#patient-search') === '' && names.includes('Quinn Park') && names.length === 6,
      'the leftover search is cleared so the new row shows', `search "${await page.inputValue('#patient-search')}", rows: ${names.join(', ')}`)
    check((await stored(page, 'rom_settings')).active_patient_id === zed?.id, 'the active patient is unchanged')

    console.log('\n4. Edit form')
    await search(page, 'smith')
    await page.click(`.btn-edit[data-id="${JOHN.id}"]`)
    await page.waitForSelector('#patient-form-panel', { state: 'visible' })
    check(!(await page.isVisible('#btn-form-save-measure')), 'Edit form has no Save & measure')
    check(await page.$eval('#btn-form-save', el => el.classList.contains('btn-primary')), 'Save is the primary button when editing')
    await shot(page, 'patients-edit-form')
    await page.fill('#pf-diagnosis', 'ACL reconstruction')
    await page.click('#btn-form-save')
    await page.waitForSelector('#patient-form-panel', { state: 'hidden' })
    names = await rowNames(page)
    check(await page.inputValue('#patient-search') === 'smith' && names.join('|') === 'Joanne Smith|John Smith',
      'saving an edit keeps the search in place', `search "${await page.inputValue('#patient-search')}", rows: ${names.join(', ')}`)

    check(errors.length === 0, 'no page errors', `page errors: ${errors.join(' | ')}`)
  } finally {
    await browser?.close()
    server.kill()
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
