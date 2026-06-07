/**
 * main.js — App entry point with three-view routing
 *
 * Routes:
 *   Measure  → main camera + recording screen
 *   History  → session list + trend chart
 *   Detail   → single session detail + timeline chart
 */

import './style.css'
import { MeasureView }       from './ui/MeasureView.js'
import { HistoryView }       from './ui/HistoryView.js'
import { SessionDetailView } from './ui/SessionDetailView.js'

const app = document.getElementById('app')
let currentView = null

function unmountCurrent() {
  if (currentView) currentView.unmount()
}

function showMeasure() {
  unmountCurrent()
  currentView = new MeasureView(app, showHistory)
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', showMeasure)
} else {
  showMeasure()
}

if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({
      onNeedRefresh() { window.location.reload() },
      onOfflineReady() { console.log('KineticsIQ ready offline.') },
    })
  }).catch(() => {})
}
