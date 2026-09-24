/**
 * main.js — App entry point with view routing + auth gate
 *
 * Routes:
 *   Login    → clinician sign-in / sign-up / password reset (only when
 *              Supabase is configured; a reset link routes here, not into
 *              the app, until the new password is saved)
 *   Patients → patient roster + intake form; picks the active patient
 *   Measure  → main camera + recording screen
 *   History  → active patient's session list + trend chart
 *   Detail   → single session detail + timeline chart
 *
 * BOOT:
 * With Supabase configured, a cached auth session (persisted by supabase-js
 * in localStorage) skips the login screen — including offline. Without
 * Supabase env vars the app runs local-only exactly as it did before
 * accounts existed: no login, no sync.
 */

import './style.css'
import { MeasureView }       from './ui/MeasureView.js'
import { HistoryView }       from './ui/HistoryView.js'
import { SessionDetailView } from './ui/SessionDetailView.js'
import { LoginView }         from './ui/LoginView.js'
import { PatientsView }      from './ui/PatientsView.js'
import { isConfigured, getSession, onAuthChange } from './core/supabase.js'
import { initSync }          from './core/sync.js'
import { parseAuthRedirect, beginRecovery, isRecoveryPending, endRecovery, GENERIC_LINK_ERROR } from './core/authRedirect.js'
import { loadPatients, clearAllLocalData, migrateInlineImages } from './core/storage.js'

const app = document.getElementById('app')
let currentView = null

function unmountCurrent() {
  if (currentView) currentView.unmount()
}

function showLogin(options) {
  unmountCurrent()
  currentView = new LoginView(app, enterApp, options)
  currentView.mount()
}

function showPatients() {
  unmountCurrent()
  currentView = new PatientsView(app, showMeasure, showMeasure)
  currentView.mount()
}

function showMeasure() {
  unmountCurrent()
  currentView = new MeasureView(app, showHistory, showPatients)
  currentView.mount()
}

function showHistory() {
  unmountCurrent()
  currentView = new HistoryView(app, showMeasure, showDetail)
  currentView.mount()
}

function showDetail(session) {
  unmountCurrent()
  currentView = new SessionDetailView(app, session, showHistory)
  currentView.mount()
}

function enterApp() {
  if (isConfigured()) initSync()
  // One-time rescue: convert any pre-IndexedDB inline snapshot data URLs to
  // blobs + queue their upload, freeing localStorage. Fire-and-forget — its
  // outbox enqueues trigger a sync via the outbox listener initSync installed.
  migrateInlineImages()
  // First run after login: no patients cached yet — start at the roster
  if (loadPatients().length === 0) {
    showPatients()
  } else {
    showMeasure()
  }
}

async function boot() {
  if (!isConfigured()) {
    // Local-only mode — pre-accounts behavior
    enterApp()
    return
  }

  // A password-reset link must be recognised BEFORE the client is created:
  // supabase-js consumes the hash during initialization and signs the user
  // in, after which the recovery session is indistinguishable from a
  // returning clinician. Read-only here — see the replaceState below.
  const redirect = parseAuthRedirect(window.location.hash)
  if (redirect === 'recovery') beginRecovery()

  let routed = false
  onAuthChange((event) => {
    // Event names only — never the session, which carries the token.
    if (import.meta.env.DEV) console.debug('[auth]', event)

    if (event === 'SIGNED_OUT') {
      endRecovery()
      // Shared-device hygiene: patient data leaves with the clinician
      clearAllLocalData()
      showLogin()
    } else if (event === 'PASSWORD_RECOVERY') {
      // Backstop for a link the hash parse missed. Before boot() has
      // routed, setting the guard is enough; after, switch the screen.
      const wasPending = isRecoveryPending()
      beginRecovery()
      if (routed && !wasPending) showLogin({ mode: 'recovery' })
    }
    // SIGNED_IN / INITIAL_SESSION / TOKEN_REFRESHED deliberately never call
    // enterApp(): during recovery they fire for the link's session, and
    // opening the app then would leave the forgotten password in place.
    // Only boot() and LoginView's onLogin enter the app.
  })

  // Awaiting this waits for client initialization, which is when supabase-js
  // reads the link out of the URL and establishes the session.
  const session = await getSession()

  // Only now is it safe to drop the token-bearing hash: clearing it before
  // the client consumed it would stop the link from signing in at all.
  if (redirect) {
    history.replaceState(null, '', window.location.pathname + window.location.search)
  }

  routed = true
  if (isRecoveryPending()) {
    if (session) {
      showLogin({ mode: 'recovery' })
    } else {
      // Link was bad or already used — no session to set a password on
      endRecovery()
      showLogin({ error: GENERIC_LINK_ERROR })
    }
  } else if (redirect?.error) {
    showLogin({ error: redirect.error })
  } else if (session) {
    enterApp()
  } else {
    showLogin()
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}

if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({
      onNeedRefresh() { window.location.reload() },
      onOfflineReady() { console.log('KineticsIQ ready offline.') },
    })
  }).catch(() => {})
}
