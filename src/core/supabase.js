/**
 * supabase.js
 *
 * The ONLY module that imports @supabase/supabase-js. Everything else talks
 * to this thin wrapper so the SDK stays swappable and mockable in tests.
 *
 * CONFIGURATION:
 * Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from Vite env
 * (.env.local — see .env.example). When unset, isConfigured() is false and
 * the app runs in local-only mode: no login, no sync, localStorage only.
 *
 * OFFLINE:
 * supabase-js persists its auth session in localStorage, so getSession()
 * resolves from cache without network — the installed PWA boots offline
 * after one successful login. Only sync needs a fresh token.
 */

import { createClient } from '@supabase/supabase-js'

const URL      = import.meta.env.VITE_SUPABASE_URL
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

let _client = null

/**
 * Whether Supabase credentials are present. When false the app must not
 * call any other function in this module.
 */
export function isConfigured() {
  return Boolean(URL && ANON_KEY)
}

/** Lazy singleton supabase-js client. */
export function getClient() {
  if (!isConfigured()) {
    throw new Error(
      'Supabase is not configured — set VITE_SUPABASE_URL and ' +
      'VITE_SUPABASE_ANON_KEY in .env.local (see .env.example).'
    )
  }
  if (!_client) {
    _client = createClient(URL, ANON_KEY)
  }
  return _client
}

/**
 * Current auth session, or null when signed out.
 * Resolves from the locally cached session, so it works offline.
 */
export async function getSession() {
  const { data } = await getClient().auth.getSession()
  return data?.session ?? null
}

/**
 * The signed-in clinician's user id, or null when signed out. Used to build
 * per-owner Storage paths (`${userId}/${sessionId}/${which}.jpg`). Resolves
 * from the cached session, so it works offline.
 * @returns {Promise<string|null>}
 */
export async function getUserId() {
  const session = await getSession()
  return session?.user?.id ?? null
}

export async function signIn(email, password) {
  const { data, error } = await getClient().auth.signInWithPassword({ email, password })
  if (error) throw error
  return data.session
}

/**
 * Create a clinician account. Depending on the Supabase project's email
 * settings this may return a live session (auto-confirm) or null
 * (confirmation email sent — user must verify before signing in).
 */
export async function signUp(email, password) {
  const { data, error } = await getClient().auth.signUp({ email, password })
  if (error) throw error
  return data.session
}

export async function signOut() {
  const { error } = await getClient().auth.signOut()
  if (error) throw error
}

/**
 * Subscribe to auth state changes ('SIGNED_IN', 'SIGNED_OUT', …).
 * Returns an unsubscribe function.
 */
export function onAuthChange(callback) {
  const { data } = getClient().auth.onAuthStateChange((event, session) => {
    callback(event, session)
  })
  return () => data.subscription.unsubscribe()
}
