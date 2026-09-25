/**
 * authRedirect.js
 *
 * Reads the hash a Supabase password-reset link lands with, and tracks the
 * "recovery in progress" state across auth events and reloads.
 *
 * WHY A GUARD:
 * supabase-js turns a reset link into a live signed-in session during client
 * initialization. To the rest of the app that looks exactly like a returning
 * clinician, so without a guard boot() — or any SIGNED_IN / INITIAL_SESSION
 * handler — walks straight into the app and the forgotten password is never
 * replaced. The guard is set the moment a recovery link is seen and cleared
 * only after updateUser() succeeds (or on sign-out).
 *
 * It lives in sessionStorage rather than memory so a reload before the new
 * password is saved still shows the recovery form. sessionStorage is per-tab
 * and never holds patient data, so this does not compete with storage.js's
 * ownership of localStorage. Every entry point no-ops when sessionStorage is
 * absent or throws (Node, blocked site data).
 *
 * WHY THE LINK'S TOKENS ARE KEPT:
 * On an iPhone, a reset link that had demonstrably signed in (Supabase logged
 * GET /user 200) reached "Save new password" with no session in storage, and
 * updateUser() failed "Auth session missing!" without ever calling the
 * server. That could not be reproduced in Chromium or WebKit, and Supabase's
 * own forums report the same failure without a cause. So the tokens are held
 * beside the guard for the life of the recovery — they are the same tokens
 * supabase-js already stores, and are dropped by endRecovery() — and
 * LoginView re-establishes the session from them if it has vanished.
 * formatRecoveryDiagnostics() records the device's state when that happens,
 * so the next occurrence names its cause instead of repeating it.
 *
 * parseAuthRedirect() only READS the hash. Clearing it is main.js's job, and
 * must wait until supabase-js has consumed it — clearing early would stop the
 * link from signing in at all.
 */

const RECOVERY_KEY = 'kiq_recovery_pending'
const TOKENS_KEY   = 'kiq_recovery_tokens'

const GENERIC_LINK_ERROR = 'This reset link is invalid or has expired — request a new one.'

/**
 * How long after a reset email an emailed-link sign-in still counts as that
 * reset. Supabase's link lifetime is configurable up to 24h.
 */
const RESET_WINDOW_S = 24 * 60 * 60

const params = (hash) =>
  new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)

/**
 * @param {string|undefined} hash - location.hash, with or without the '#'
 * @returns {'recovery' | {error: string, code: string|null} | null}
 */
export function parseAuthRedirect(hash) {
  if (!hash) return null
  const p = params(hash)

  if (p.get('error') || p.get('error_code')) {
    return {
      error: p.get('error_description') || GENERIC_LINK_ERROR,
      code:  p.get('error_code'),
    }
  }
  if (p.get('type') === 'recovery') return 'recovery'
  return null
}

/**
 * The session tokens a recovery link carries, or null.
 * @returns {{access_token: string, refresh_token: string} | null}
 */
export function readRecoveryTokens(hash) {
  if (!hash || parseAuthRedirect(hash) !== 'recovery') return null
  const p = params(hash)
  const access_token  = p.get('access_token')
  const refresh_token = p.get('refresh_token')
  return access_token && refresh_token ? { access_token, refresh_token } : null
}

// ─── Recovery guard ─────────────────────────────────────────────────────

/**
 * Arm the guard. Re-arming keeps the original start time and any tokens
 * already held — PASSWORD_RECOVERY re-arms after boot has stored them.
 * @param {{access_token: string, refresh_token: string}} [tokens]
 */
export function beginRecovery(tokens) {
  try {
    const ss = globalThis.sessionStorage
    if (!ss) return
    if (ss.getItem(RECOVERY_KEY) === null) ss.setItem(RECOVERY_KEY, String(Date.now()))
    if (tokens) ss.setItem(TOKENS_KEY, JSON.stringify(tokens))
  } catch { /* unavailable */ }
}

export function isRecoveryPending() {
  try { return globalThis.sessionStorage?.getItem(RECOVERY_KEY) != null } catch { return false }
}

export function endRecovery() {
  try {
    globalThis.sessionStorage?.removeItem(RECOVERY_KEY)
    globalThis.sessionStorage?.removeItem(TOKENS_KEY)
  } catch { /* unavailable */ }
}

/** @returns {{access_token: string, refresh_token: string} | null} */
export function recoveryTokens() {
  try {
    const raw = globalThis.sessionStorage?.getItem(TOKENS_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

/** Seconds since the guard was armed, or null when not pending. */
export function recoveryAgeSeconds(now = Date.now()) {
  try {
    const started = Number(globalThis.sessionStorage?.getItem(RECOVERY_KEY))
    // A guard written by the first release held '1', not a timestamp
    return started > 1 ? Math.round((now - started) / 1000) : null
  } catch { return null }
}

// ─── Reset sessions left unfinished ─────────────────────────────────────

function jwtClaims(token) {
  try {
    const part = token.split('.')[1]
    const b64  = part.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
  } catch {
    return null
  }
}

/** The server-side session id in a session's access token, or null. */
export function sessionIdOf(session) {
  return (session?.access_token && jwtClaims(session.access_token)?.session_id) || null
}

/**
 * Whether a signed-in session came from a password-reset link whose new
 * password was never saved on this device.
 *
 * The case this exists for: a service worker from an older deploy serves the
 * *old* app for the reset link. The old app knows nothing about recovery, so
 * supabase-js consumes the one-time link, signs in, and the old app walks
 * into the app — the link is spent and the password unchanged. When the new
 * app next boots it sees only an ordinary session.
 *
 * Supabase stamps a reset-link session's `amr` as 'otp' — the same as magic
 * links and signup confirmations, and it survives the password change — so
 * 'otp' alone proves nothing. It must follow the account's `recovery_sent_at`
 * within the link lifetime; this app sends no other emailed links that could.
 * `completedSessionId` is the session this device last finished a reset in.
 */
export function isUnfinishedResetSession(session, completedSessionId) {
  const claims = session?.access_token && jwtClaims(session.access_token)
  if (!claims) return false
  if (claims.session_id && claims.session_id === completedSessionId) return false

  const sentAt = Date.parse(session.user?.recovery_sent_at ?? '') / 1000
  if (!Number.isFinite(sentAt)) return false

  const amr = Array.isArray(claims.amr) ? claims.amr : []
  return amr.some(e => e?.method === 'otp' &&
    e.timestamp - sentAt >= 0 && e.timestamp - sentAt <= RESET_WINDOW_S)
}

// ─── Diagnostics ────────────────────────────────────────────────────────

const recentEvents = []

/** Called by main.js for every auth event name (never the session). */
export function noteAuthEvent(name) {
  recentEvents.push(name)
  if (recentEvents.length > 12) recentEvents.shift()
}

const flag = (v) => (v === true ? '1' : v === false ? '0' : '?')

/**
 * One short, secret-free code describing the device when a recovery save
 * failed or needed the fallback, e.g. `s0 w1 t1 g1 nr c1 a42 e:IP`:
 * s stored session present · w storage writable · t link tokens held ·
 * g guard armed · n navigation (navigate/reload/back_forward) ·
 * c page controlled by a service worker · a seconds since the link ·
 * e initials of the auth events this page saw.
 */
export function formatRecoveryDiagnostics(d) {
  return [
    's' + flag(d.storedSession),
    'w' + flag(d.storageWritable),
    't' + flag(d.hasTokens),
    'g' + flag(d.guard),
    'n' + (d.navType ? d.navType[0] : '?'),
    'c' + flag(d.controlled),
    'a' + (d.ageS ?? '?'),
    'e:' + (d.events ?? []).map(e => e[0]).join(''),
  ].join(' ')
}

/** Gather formatRecoveryDiagnostics()'s inputs from the live page. */
export function collectRecoveryDiagnostics() {
  const probe = (fn) => { try { return fn() } catch { return undefined } }
  return formatRecoveryDiagnostics({
    // Read-only look at supabase-js's own key; never its contents
    storedSession: probe(() =>
      Object.keys(localStorage).some(k => /^sb-.*-auth-token$/.test(k))),
    storageWritable: probe(() => {
      localStorage.setItem('kiq_probe', '1')
      localStorage.removeItem('kiq_probe')
      return true
    }) ?? false,
    hasTokens:  recoveryTokens() !== null,
    guard:      isRecoveryPending(),
    navType:    probe(() => performance.getEntriesByType('navigation')[0]?.type),
    controlled: probe(() => Boolean(navigator.serviceWorker?.controller)),
    ageS:       recoveryAgeSeconds(),
    events:     [...recentEvents],
  })
}

export { GENERIC_LINK_ERROR }
