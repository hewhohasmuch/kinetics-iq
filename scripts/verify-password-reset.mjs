/**
 * Drives the password-reset flow at the real UI surface, against a mock
 * Supabase, because src/ui/ has no unit tests and the dangerous part — a
 * recovery link's session walking straight into the app — lives in the
 * interaction between main.js's boot order and supabase-js's URL detection.
 *
 * Starts its own mock (https://localhost:54329) and its own vite (5175).
 *   node scripts/verify-password-reset.mjs [--webkit] [--headed]
 * --webkit runs Safari's engine; the default is Chromium.
 */
import { chromium, webkit } from 'playwright'
import { createServer } from 'node:https'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'

const OUT = 'tmp/password-reset-verify'
mkdirSync(OUT, { recursive: true })
const MOCK_PORT = 54329
const APP = 'https://localhost:5175/'

// ── Mock Supabase ────────────────────────────────────────────────────────
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
// Shaped like a real reset: Supabase stamps a reset-link session's amr 'otp'
// and the user carries recovery_sent_at. That is what boot() uses to spot a
// reset an older cached build left unfinished, so a mock without it would
// let a false positive on every recovery session pass unnoticed.
const USER = { id: '22222222-2222-4222-8222-222222222222', aud: 'authenticated',
               role: 'authenticated', email: 'clinician@example.com',
               recovery_sent_at: new Date(Date.now() - 60_000).toISOString() }
// A recovery link as Supabase's /verify redirects it back to the app
const recoveryHash = () => `#access_token=${fakeJwt()}&expires_at=${Math.floor(Date.now() / 1000) + 3600}` +
  '&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery'
let sessionSeq = 0
const fakeJwt = () => [b64url({ alg: 'HS256', typ: 'JWT' }),
  b64url({ sub: USER.id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
           session_id: `sess-${++sessionSeq}`,
           amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }] }),
  'sig'].join('.')
// What supabase-js stores under its key once a reset link has signed in
const storedResetSession = () => ({
  access_token: fakeJwt(), refresh_token: 'r-stale', token_type: 'bearer',
  expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: USER,
})

const log = []                       // every auth request, in order
let failRecover = false
// HTTPS because WebKit (Safari's engine) blocks an https page from calling
// http://localhost at all. vite's basic-ssl cert is cached before vite runs
// once; the key and cert live in the same PEM.
const PEM = readFileSync('node_modules/.vite/basic-ssl/_cert.pem')
const mock = createServer({ key: PEM, cert: PEM }, (req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
                 'access-control-allow-methods': '*' }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  let body = ''
  req.on('data', c => (body += c))
  req.on('end', () => {
    const url = new URL(req.url, 'http://x')
    const send = (code, obj) => {
      res.writeHead(code, { ...cors, 'content-type': 'application/json' })
      res.end(obj === undefined ? '' : JSON.stringify(obj))
    }
    if (url.pathname.startsWith('/auth/')) log.push({ method: req.method, path: url.pathname, query: url.search, body, t: Date.now() })

    if (url.pathname === '/auth/v1/recover') {
      return failRecover
        ? send(429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' })
        : send(200, {})
    }
    if (url.pathname === '/auth/v1/user') {
      if (req.method === 'PUT') return send(200, { ...USER, updated_at: new Date().toISOString() })
      return send(200, USER)
    }
    if (url.pathname === '/auth/v1/token') {
      return send(200, { access_token: fakeJwt(), token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r2', user: USER })
    }
    if (url.pathname === '/auth/v1/logout') return send(204)
    if (url.pathname.startsWith('/rest/v1/')) return send(200, [])
    send(404, { msg: 'not mocked: ' + url.pathname })
  })
})
await new Promise(r => mock.listen(MOCK_PORT, r))

// ── Vite in cloud mode ───────────────────────────────────────────────────
// Run vite's own entry with node, not via `npx` + a shell: on Windows the
// shell/npx layers orphan the real server, and killing the shell's pid leaves
// it holding the port for the next run.
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '--port', '5175', '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VITE_SUPABASE_URL: `https://localhost:${MOCK_PORT}`,
         VITE_SUPABASE_ANON_KEY: 'anon-test-key' },
})
let out = ''
const stopVite = () => { vite.kill() }
await new Promise((resolve, reject) => {
  const t = setTimeout(() => { stopVite(); mock.close(); reject(new Error('vite did not start:\n' + out)) }, 60000)
  const onData = d => {
    out += String(d).replace(/\x1b\[[0-9;]*m/g, '')   // vite colours "Local:"
    if (/Local:/.test(out)) { clearTimeout(t); resolve() }
  }
  vite.stdout.on('data', onData)
  vite.stderr.on('data', onData)
})

const fails = []
const check = (name, cond, detail = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? ' :: ' + detail : ''))
  if (!cond) fails.push(name)
}

const browser = await (process.argv.includes('--webkit') ? webkit : chromium).launch({ headless: !process.argv.includes('--headed') })
try {
  const visible = (page, sel) => page.evaluate(s => {
    const el = document.querySelector(s); return !!el && el.offsetParent !== null
  }, sel)
  const text = (page, sel) => page.evaluate(s => document.querySelector(s)?.textContent.trim() ?? null, sel)
  const inApp = (page) => page.evaluate(() =>
    !!document.querySelector('#btn-new-patient, #btn-history, #btn-start-camera'))

  // ── 1. Forgot password: success and failure ─────────────────────────────
  {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    await page.goto(APP)
    await page.waitForSelector('#login-forgot')
    check('Sign-in screen offers "Forgot password?"', await visible(page, '#login-forgot'))

    await page.click('#login-forgot')
    check('Forgot mode hides the password field', !(await visible(page, '#login-password')))
    await page.fill('#login-email', 'clinician@example.com')
    await page.click('#login-submit')
    await page.waitForSelector('#login-info', { state: 'visible' })
    check('Success shows the account-neutral message',
      /If an account exists/.test(await text(page, '#login-info')))
    const rec = log.find(r => r.path === '/auth/v1/recover')
    check('/recover was called with redirect_to back to the app',
      !!rec && decodeURIComponent(rec.query).includes('redirect_to=' + APP), rec?.query)
    await page.screenshot({ path: `${OUT}/1-forgot-sent.png` })

    failRecover = true
    await page.click('#login-submit')
    await page.waitForSelector('#login-error', { state: 'visible' })
    check('Rate-limited send shows the "couldn\'t send" message',
      /couldn.t send a reset link/.test(await text(page, '#login-error')))
    check('...and does not claim an email was sent', !(await visible(page, '#login-info')))
    failRecover = false
    await page.screenshot({ path: `${OUT}/2-forgot-failed.png` })
    await ctx.close()
  }

  // ── 2. Recovery link: event order, hash, reloads ───────────────────────
  {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    const events = []
    page.on('console', m => { const x = /^\[auth\] (\w+)/.exec(m.text()); if (x) events.push(x[1]) })

    const hash = `#access_token=${fakeJwt()}&expires_at=${Math.floor(Date.now() / 1000) + 3600}` +
      '&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery'
    await page.goto(APP + hash)
    await page.waitForSelector('#login-confirm', { state: 'visible', timeout: 20000 })
    await page.waitForTimeout(1500)   // give any stray SIGNED_IN handler time to misroute

    check('Recovery link shows the set-password form',
      (await text(page, '#login-heading')) === 'Set a new password')
    const hasSession = await page.evaluate(() =>
      Object.keys(localStorage).some(k => /^sb-.*-auth-token$/.test(k)))
    check('supabase-js consumed the link into a session', hasSession)
    check('The token-bearing hash is gone', (await page.evaluate(() => location.hash)) === '')
    check('SIGNED_IN / INITIAL_SESSION fired', events.some(e => e === 'SIGNED_IN' || e === 'INITIAL_SESSION'),
      events.join(','))
    check('...yet the app did not open before PUT /user',
      !(await inApp(page)) && !log.some(r => r.method === 'PUT'))
    await page.screenshot({ path: `${OUT}/3-recovery-form.png` })

    await page.reload()
    await page.waitForSelector('#login-heading')
    await page.waitForTimeout(1500)
    check('Reload before saving returns to the recovery form',
      (await text(page, '#login-heading')) === 'Set a new password' && !(await inApp(page)))

    await page.fill('#login-password', 'correct-horse')
    await page.fill('#login-confirm', 'correct-horsE')
    await page.click('#login-submit')
    check('Mismatched passwords are refused',
      /don.t match/.test(await text(page, '#login-error')) && !log.some(r => r.method === 'PUT'))

    await page.fill('#login-confirm', 'correct-horse')
    await page.click('#login-submit')
    await page.waitForFunction(() =>
      !!document.querySelector('#btn-new-patient, #btn-history, #btn-start-camera'), null, { timeout: 15000 })
    const put = log.find(r => r.method === 'PUT' && r.path === '/auth/v1/user')
    check('Saving calls PUT /user with the new password',
      !!put && JSON.parse(put.body).password === 'correct-horse')
    check('...and then enters the app', await inApp(page))
    check('Recovery guard cleared', !(await page.evaluate(() => sessionStorage.getItem('kiq_recovery_pending'))))

    await page.reload()
    await page.waitForFunction(() =>
      !!document.querySelector('#btn-new-patient, #btn-history, #btn-start-camera, #login-heading'), null, { timeout: 15000 })
    check('Reload after saving enters the app normally', await inApp(page))
    await page.screenshot({ path: `${OUT}/4-after-update.png` })
    await ctx.close()
  }

  // ── 3. Expired link ─────────────────────────────────────────────────────
  {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    await page.goto(APP + '#error=access_denied&error_code=otp_expired' +
      '&error_description=Email+link+is+invalid+or+has+expired')
    await page.waitForSelector('#login-error', { state: 'visible', timeout: 15000 })
    check('Expired link shows the sign-in form with the expiry message',
      (await text(page, '#login-heading')) === 'Sign in' &&
      /invalid or has expired/.test(await text(page, '#login-error')))
    check('...and clears the hash', (await page.evaluate(() => location.hash)) === '')
    await page.screenshot({ path: `${OUT}/5-expired.png` })
    await ctx.close()
  }

  // ── 4. The session vanishes before Save (seen on an iPhone) ────────────
  // Reproduce the device's state directly: the link signed in, then
  // supabase-js's stored session disappeared. The fallback must rebuild it
  // from the link's tokens and still save — and show a reference code.
  {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    await page.goto(APP + recoveryHash())
    await page.waitForSelector('#login-confirm', { state: 'visible', timeout: 20000 })
    await page.evaluate(() => Object.keys(localStorage)
      .filter(k => /^sb-.*-auth-token$/.test(k)).forEach(k => localStorage.removeItem(k)))
    const putsBefore = log.filter(r => r.method === 'PUT').length
    await page.fill('#login-password', 'correct-horse')
    await page.fill('#login-confirm', 'correct-horse')
    await page.click('#login-submit')
    await page.waitForSelector('#login-info', { state: 'visible', timeout: 10000 })
    const info = await text(page, '#login-info')
    check('Vanished session: the fallback still saves the password',
      log.filter(r => r.method === 'PUT').length === putsBefore + 1, info)
    check('...and shows "Password saved" with a diagnostic ref',
      (await text(page, '#login-heading')) === 'Password saved' && /ref s0 w1 t1 g1 /.test(info), info)
    await page.screenshot({ path: `${OUT}/7-fallback-saved.png` })
    await page.click('#login-submit')
    await page.waitForFunction(() =>
      !!document.querySelector('#btn-new-patient, #btn-history, #btn-start-camera'), null, { timeout: 15000 })
    check('...and Continue enters the app', await inApp(page))
    await ctx.close()
  }

  // ── 5. The session vanishes and no link tokens are held ─────────────────
  {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    await page.goto(APP + recoveryHash())
    await page.waitForSelector('#login-confirm', { state: 'visible', timeout: 20000 })
    await page.evaluate(() => {
      Object.keys(localStorage).filter(k => /^sb-.*-auth-token$/.test(k)).forEach(k => localStorage.removeItem(k))
      sessionStorage.removeItem('kiq_recovery_tokens')
    })
    const putsBefore = log.filter(r => r.method === 'PUT').length
    await page.fill('#login-password', 'correct-horse')
    await page.fill('#login-confirm', 'correct-horse')
    await page.click('#login-submit')
    await page.waitForSelector('#login-error', { state: 'visible', timeout: 10000 })
    check('No session, no tokens: says the session ended and offers a new link',
      (await text(page, '#login-heading')) === 'Reset password' &&
      /request a new link/.test(await text(page, '#login-error')), await text(page, '#login-error'))
    check('...sends no PUT and releases the guard',
      log.filter(r => r.method === 'PUT').length === putsBefore &&
      !(await page.evaluate(() => sessionStorage.getItem('kiq_recovery_pending'))))
    await page.screenshot({ path: `${OUT}/8-session-ended.png` })
    await ctx.close()
  }

  // ── 6. A reset left unfinished by an older cached build ─────────────────
  // An old service worker served the pre-recovery app for the link: it
  // signed in and walked past the password form, leaving an ordinary session
  // and no guard. The current build must recognise it and finish the reset.
  {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
    await ctx.addInitScript((sess) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('sb-localhost-auth-token', JSON.stringify(sess))
        sessionStorage.setItem('seeded', '1')
      }
    }, storedResetSession())
    const page = await ctx.newPage()
    await page.goto(APP)
    await page.waitForSelector('#login-heading, #btn-new-patient, #btn-start-camera', { timeout: 20000 })
    await page.waitForTimeout(1000)
    check('Unfinished reset from an old build: the set-password form shows, not the app',
      (await text(page, '#login-heading')) === 'Set a new password' && !(await inApp(page)))
    await page.fill('#login-password', 'correct-horse')
    await page.fill('#login-confirm', 'correct-horse')
    await page.click('#login-submit')
    await page.waitForFunction(() =>
      !!document.querySelector('#btn-new-patient, #btn-history, #btn-start-camera'), null, { timeout: 15000 })
    await page.reload()
    await page.waitForSelector('#login-heading, #btn-new-patient, #btn-history, #btn-start-camera', { timeout: 15000 })
    await page.waitForTimeout(1000)
    check('...and once saved, a reload enters the app (reset marked finished)', await inApp(page))
    await ctx.close()
  }

  // A password sign-in must never be mistaken for an unfinished reset
  {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
    const pwSession = storedResetSession()
    pwSession.access_token = [b64url({ alg: 'HS256' }), b64url({ sub: USER.id, session_id: 'sess-pw',
      exp: Math.floor(Date.now() / 1000) + 3600,
      amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] }), 'sig'].join('.')
    await ctx.addInitScript((sess) => localStorage.setItem('sb-localhost-auth-token', JSON.stringify(sess)), pwSession)
    const page = await ctx.newPage()
    await page.goto(APP)
    await page.waitForSelector('#login-heading, #btn-new-patient, #btn-history, #btn-start-camera', { timeout: 20000 })
    await page.waitForTimeout(1000)
    check('A password session with a reset email outstanding still enters the app', await inApp(page))
    await ctx.close()
  }

  // ── 7. Two tabs: reset requested in one, link opened in another ────────
  // The real sequence on a phone: "Forgot password?" in tab A, then Mail
  // opens the link in a NEW tab B of the same browser. supabase-js relays
  // auth events between same-origin tabs over a BroadcastChannel, so both
  // tabs react to the link — and the new password must save from either.
  for (const saveIn of ['B', 'A']) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
    const tabA = await ctx.newPage()
    const errs = []
    await tabA.goto(APP)
    await tabA.waitForSelector('#login-forgot')
    await tabA.click('#login-forgot')
    await tabA.fill('#login-email', 'clinician@example.com')
    await tabA.click('#login-submit')
    await tabA.waitForSelector('#login-info', { state: 'visible' })

    const tabB = await ctx.newPage()
    for (const [name, pg] of [['A', tabA], ['B', tabB]]) {
      pg.on('console', m => { if (m.type() === 'error' || /\[auth\]/.test(m.text())) errs.push(`${name}: ${m.text()}`) })
    }
    const putsBefore = log.filter(r => r.method === 'PUT').length
    await tabB.goto(APP + recoveryHash())
    await tabB.waitForSelector('#login-confirm', { state: 'visible', timeout: 20000 })
    await tabB.waitForTimeout(1500)

    const saver = saveIn === 'A' ? tabA : tabB
    await saver.bringToFront()
    const heading = await text(saver, '#login-heading')
    check(`Two tabs: tab ${saveIn} shows the set-password form`, heading === 'Set a new password', heading)
    await saver.fill('#login-password', 'correct-horse')
    await saver.fill('#login-confirm', 'correct-horse')
    await saver.click('#login-submit')
    await saver.waitForTimeout(3000)
    const err = (await visible(saver, '#login-error')) ? await text(saver, '#login-error') : null
    check(`Two tabs: saving from tab ${saveIn} sends PUT /user and enters the app`,
      log.filter(r => r.method === 'PUT').length > putsBefore && await inApp(saver),
      err ? `error shown: "${err}" :: ${errs.join(' | ')}` : errs.join(' | '))
    await saver.screenshot({ path: `${OUT}/6-two-tabs-save-in-${saveIn}.png` })
    await ctx.close()
  }
} finally {
  await browser.close()
  mock.close()
  stopVite()
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)
