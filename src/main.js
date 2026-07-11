/**
 * main.js — App entry point with view routing + auth gate
 *
 * Routes:
 *   Login    → clinician sign-in / sign-up (only when Supabase is configured)
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
import { loadPatients, clearAllLocalData } from './core/storage.js'

const app = document.getElementById('app')
let currentView = null

function unmountCurrent() {
  if (currentView) currentView.unmount()
}

function showLogin() {
  unmountCurrent()
  currentView = new LoginView(app, enterApp)
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

  onAuthChange((event) => {
    if (event === 'SIGNED_OUT') {
      // Shared-device hygiene: patient data leaves with the clinician
      clearAllLocalData()
      showLogin()
    }
  })

  const session = await getSession()
  if (session) {
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
