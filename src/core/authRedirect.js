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
 * parseAuthRedirect() only READS the hash. Clearing it is main.js's job, and
 * must wait until supabase-js has consumed it — clearing early would stop the
 * link from signing in at all.
 */

const RECOVERY_KEY = 'kiq_recovery_pending'

const GENERIC_LINK_ERROR = 'This reset link is invalid or has expired — request a new one.'

/**
 * @param {string|undefined} hash - location.hash, with or without the '#'
 * @returns {'recovery' | {error: string, code: string|null} | null}
 */
export function parseAuthRedirect(hash) {
  if (!hash) return null
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)

  if (params.get('error') || params.get('error_code')) {
    return {
      error: params.get('error_description') || GENERIC_LINK_ERROR,
      code:  params.get('error_code'),
    }
  }
  if (params.get('type') === 'recovery') return 'recovery'
  return null
}

export function beginRecovery() {
  try { globalThis.sessionStorage?.setItem(RECOVERY_KEY, '1') } catch { /* unavailable */ }
}

export function isRecoveryPending() {
  try { return globalThis.sessionStorage?.getItem(RECOVERY_KEY) === '1' } catch { return false }
}

export function endRecovery() {
  try { globalThis.sessionStorage?.removeItem(RECOVERY_KEY) } catch { /* unavailable */ }
}

export { GENERIC_LINK_ERROR }
