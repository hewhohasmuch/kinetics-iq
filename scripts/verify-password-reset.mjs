/**
 * Drives the password-reset flow at the real UI surface, against a mock
 * Supabase, because src/ui/ has no unit tests and the dangerous part — a
 * recovery link's session walking straight into the app — lives in the
 * interaction between main.js's boot order and supabase-js's URL detection.
 *
 * Starts its own mock (http://localhost:54329) and its own vite (5175).
 *   node scripts/verify-password-reset.mjs [--headed]
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const OUT = 'tmp/password-reset-verify'
mkdirSync(OUT, { recursive: true })
const MOCK_PORT = 54329
const APP = 'https://localhost:5175/'

// ── Mock Supabase ────────────────────────────────────────────────────────
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const USER = { id: '22222222-2222-4222-8222-222222222222', aud: 'authenticated',
               role: 'authenticated', email: 'clinician@example.com' }
const fakeJwt = () => [b64url({ alg: 'HS256', typ: 'JWT' }),
  b64url({ sub: USER.id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }),
  'sig'].join('.')

const log = []                       // every auth request, in order
let failRecover = false
const mock = createServer((req, res) => {
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
const vite = spawn('npx', ['vite', '--host', '--port', '5175', '--strictPort'], {
  shell: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VITE_SUPABASE_URL: `http://localhost:${MOCK_PORT}`,
         VITE_SUPABASE_ANON_KEY: 'anon-test-key' },
})
let out = ''
const stopVite = () => {
  vite.kill()
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'])
}
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

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
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
} finally {
  await browser.close()
  mock.close()
  stopVite()
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)
