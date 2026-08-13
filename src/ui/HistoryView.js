/**
 * HistoryView.js
 *
 * Displays past sessions in a scrollable list with a ROM trend chart.
 *
 * Layout:
 *   ┌─────────────────────┐
 *   │ [Right Knee][L Sh.] │  joint+side chips — scope the chart
 *   │  ROM trend (chart)  │
 *   ├─────────────────────┤
 *   │  Session list       │
 *   │  [date] [ROM] [del] │
 *   │  [date] [ROM] [del] │
 *   └─────────────────────┘
 *
 * THE CHART IS SCOPED TO ONE JOINT AND SIDE. It used to plot every session the
 * patient had, in date order, on a single line — so a knee measurement and a
 * shoulder measurement became consecutive points on one "progress" trend. The
 * chips pick which joint+side the trend describes; the LIST below stays
 * unfiltered so nothing is hidden from view.
 *
 * IT PLOTS THE ARC, NOT THE SUBTRACTION. Two lines — the peak and the minimum
 * — because `rom` alone is max minus min, and a knee that gains 10° of flexion
 * and one that recovers 10° of extension produce an identical rising line.
 * Watching the two lines converge is the clinically meaningful picture.
 *
 * NAVIGATION:
 * This view receives an onBack callback to return to MeasureView.
 * main.js handles swapping views.
 */

import { loadSessions, deleteSession, getActivePatientId, getPatient } from '../core/storage.js'
import {
  jointLabel, positionLabel, romArc, motionLabel,
  formatSessionDate, formatSessionTime, formatDuration,
} from '../core/labels.js'
import { sessionProvenance } from '../core/provenance.js'
import { exportSessionsAsPdf } from './exportPdf.js'
import { Chart } from 'chart.js/auto'

export class HistoryView {
  /**
   * @param {HTMLElement} container  - the #app div
   * @param {Function}    onBack     - called when user taps "Back"
   * @param {Function}    onShowDetail - called with (session) to open detail view
   */
  constructor(container, onBack, onShowDetail) {
    this.container      = container
    this.onBack         = onBack
    this.onShowDetail   = onShowDetail
    this._chart         = null
    this._scope         = null   // { joint, side } the chart is currently showing
    this._selectMode    = false  // rows pick instead of navigate
    this._selected      = new Set()
  }

  mount() {
    this.container.innerHTML = this._template()
    this._render()
  }

  unmount() {
    if (this._chart) {
      this._chart.destroy()
      this._chart = null
    }
    this.container.innerHTML = ''
  }

  // ─── Private: render ────────────────────────────────────────────────

  _render() {
    const sessions = this._loadScopedSessions()   // newest first

    const patient = getPatient(getActivePatientId())
    if (patient) {
      document.querySelector('.history-title').textContent = patient.name
    }

    this._renderChart(sessions)
    this._renderScopeChips(sessions)
    this._renderList(sessions)

    document.getElementById('btn-back')
      .addEventListener('click', () => this.onBack())

    document.getElementById('btn-select-mode')
      .addEventListener('click', () => this._toggleSelectMode())
    document.getElementById('btn-export-selected')
      .addEventListener('click', () => this._exportSelected())
    document.getElementById('btn-select-cancel')
      .addEventListener('click', () => this._toggleSelectMode(false))
  }

  // ─── Multi-session export ───────────────────────────────────────────
  //
  // The list is deliberately unfiltered by joint (unlike the chart above it),
  // so a selection may legitimately span joints and sides — the PDF gives each
  // session its own page and does not try to relate them.

  _toggleSelectMode(next = !this._selectMode) {
    this._selectMode = next
    this._selected.clear()
    this.container.querySelector('.history-view').classList.toggle('selecting', next)
    document.getElementById('btn-select-mode').textContent = next ? 'Done' : 'Select'
    this._renderList(this._loadScopedSessions())
    this._updateSelectionBar()
  }

  _updateSelectionBar() {
    const bar = document.getElementById('selection-bar')
    if (!bar) return
    bar.style.display = this._selectMode ? 'flex' : 'none'

    const n   = this._selected.size
    const btn = document.getElementById('btn-export-selected')
    document.getElementById('selection-count').textContent =
      n === 0 ? 'Select sessions' : `${n} selected`
    btn.disabled = n === 0
    btn.textContent = 'Export PDF'
  }

  async _exportSelected() {
    const btn = document.getElementById('btn-export-selected')
    if (!btn || btn.disabled) return

    // Read from the store rather than the DOM, and keep the store's order.
    const chosen = this._loadScopedSessions().filter(s => this._selected.has(s.id))
    if (chosen.length === 0) return

    btn.disabled = true
    btn.textContent = 'Preparing…'
    try {
      const { missingImages } = await exportSessionsAsPdf(chosen)
      btn.textContent = missingImages > 0 ? 'Saved — photos missing' : 'Saved ✓'
      setTimeout(() => this._toggleSelectMode(false), 1500)
    } catch (e) {
      console.error('PDF export failed:', e)
      btn.textContent = 'Export failed'
      btn.disabled = false
    }
  }

  /**
   * Sessions scoped to the active patient. With no active patient (local-only
   * mode, or nothing selected yet) all sessions show, matching old behavior.
   */
  _loadScopedSessions() {
    return loadSessions(getActivePatientId() ?? undefined)
  }

  /**
   * The distinct joint+side combinations present, newest session first. Each
   * becomes a chip; the first is the default scope.
   */
  _scopesIn(sessions) {
    const seen   = new Map()
    for (const s of sessions) {                 // sessions arrive newest-first
      const { joint, side } = this._scopeOf(s)
      const key = `${joint}|${side ?? ''}`
      if (!seen.has(key)) seen.set(key, { joint, side, key, label: jointLabel(s) })
    }
    return [...seen.values()]
  }

  /** A session's scope key parts, tolerating the legacy combined 'knee_right'. */
  _scopeOf(session) {
    if (session.side) return { joint: session.joint, side: session.side }
    const [joint, side] = String(session.joint ?? '').split('_')
    return { joint, side: side || null }
  }

  _inScope(session, scope) {
    if (!scope) return true
    const s = this._scopeOf(session)
    return s.joint === scope.joint && s.side === scope.side
  }

  /**
   * Chips selecting which joint+side the trend chart describes. Hidden when the
   * patient only has one, since there is then nothing to choose between.
   */
  _renderScopeChips(sessions) {
    const row = document.getElementById('scope-chips')
    if (!row) return

    const scopes = this._scopesIn(sessions)
    if (scopes.length <= 1) {
      row.style.display = 'none'
      return
    }

    row.style.display = 'flex'
    row.innerHTML = scopes.map(sc => {
      const active = sc.key === `${this._scope?.joint}|${this._scope?.side ?? ''}` ? ' active' : ''
      return `<button class="scope-chip${active}" data-key="${sc.key}">${sc.label}</button>`
    }).join('')

    row.querySelectorAll('.scope-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const sc = scopes.find(s => s.key === btn.dataset.key)
        if (!sc) return
        this._scope = { joint: sc.joint, side: sc.side }
        const all = this._loadScopedSessions()
        this._renderScopeChips(all)
        this._renderChart(all)
      })
    })
  }

  _renderChart(sessions) {
    const canvas = document.getElementById('rom-chart')
    if (!canvas) return

    if (sessions.length === 0) {
      canvas.parentElement.style.display = 'none'
      return
    }
    canvas.parentElement.style.display = ''

    // Default the trend to whatever was measured most recently.
    if (!this._scope || !sessions.some(s => this._inScope(s, this._scope))) {
      this._scope = this._scopeOf(sessions[0])
    }

    // Chart shows oldest→newest (reverse of list display), last 10 in scope.
    const chartData = sessions
      .filter(s => this._inScope(s, this._scope))
      .reverse()
      .slice(-10)

    if (chartData.length === 0) {
      canvas.parentElement.style.display = 'none'
      return
    }

    const labels = chartData.map(s => formatSessionDate(s.date))
    const motion = motionLabel(chartData[0].joint)

    // Legacy sessions are marked, not dropped. Excluding them would quietly
    // change the shape of a trend the clinician is reading as the patient's.
    const flags       = chartData.map(s => sessionProvenance(s).level !== 'ok')
    const pointColor  = (ok) => flags.map(bad => bad ? '#fbbf24' : ok)
    const pointStyle  = flags.map(bad => bad ? 'triangle' : 'circle')

    if (this._chart) this._chart.destroy()

    this._chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: `Peak ${motion.toLowerCase()}`,
            data: chartData.map(s => s.max),
            borderColor: '#4ade80',
            backgroundColor: 'rgba(74, 222, 128, 0.10)',
            borderWidth: 2,
            pointBackgroundColor: pointColor('#4ade80'),
            pointStyle,
            pointRadius: 4,
            pointHoverRadius: 6,
            tension: 0.3,
            fill: '+1',            // shade the arc between the two lines
          },
          {
            label: 'Minimum',
            data: chartData.map(s => s.min),
            borderColor: '#60a5fa',
            borderWidth: 2,
            borderDash: [4, 3],
            pointBackgroundColor: pointColor('#60a5fa'),
            pointStyle,
            pointRadius: 4,
            pointHoverRadius: 6,
            tension: 0.3,
            fill: false,
          },
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            labels: { color: '#888', boxWidth: 10, font: { size: 10 }, usePointStyle: true },
          },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y}°`,
              // Total and position ride along in the tooltip: the chips group by
              // joint+side only, but prone and seated knee flexion are not
              // strictly comparable either, and that has to stay visible.
              afterBody: (items) => {
                const s = chartData[items[0].dataIndex]
                const lines = [`Total range ${s.rom}°`]
                const pos = positionLabel(s.position)
                if (pos) lines.push(pos)
                const p = sessionProvenance(s)
                if (p.level !== 'ok') lines.push(`⚠ ${p.label}`)
                return lines
              },
            }
          }
        },
        scales: {
          x: {
            ticks: { color: '#666', font: { size: 11 }, maxRotation: 0 },
            grid: { color: 'rgba(255,255,255,0.05)' },
          },
          y: {
            ticks: { color: '#666', font: { size: 11 }, callback: v => `${v}°` },
            grid: { color: 'rgba(255,255,255,0.05)' },
            // Was `min: 0`, which clipped the extension side of the zero point
            // straight off the axis. Angles are signed and negative values are
            // the measurement, not an error.
            suggestedMin: Math.min(0, ...chartData.map(s => s.min)),
          }
        }
      }
    })
  }

  _renderList(sessions) {
    const listEl = document.getElementById('session-list')
    if (!listEl) return

    if (sessions.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          No sessions yet.<br>Record your first session to see history.
        </div>`
      return
    }

    listEl.innerHTML = sessions.map(s => this._sessionRow(s)).join('')

    // In select mode a row toggles instead of navigating.
    listEl.querySelectorAll('.session-row').forEach(row => {
      row.addEventListener('click', (e) => {
        const id = row.dataset.id

        if (this._selectMode) {
          if (this._selected.has(id)) this._selected.delete(id)
          else                        this._selected.add(id)
          row.classList.toggle('selected', this._selected.has(id))
          row.querySelector('.row-check').textContent = this._selected.has(id) ? '✓' : ''
          this._updateSelectionBar()
          return
        }

        // Don't trigger if delete button was tapped
        if (e.target.closest('.btn-delete')) return
        const session = this._loadScopedSessions().find(s => s.id === id)
        if (session && this.onShowDetail) this.onShowDetail(session)
      })
    })

    listEl.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const id = e.currentTarget.dataset.id
        this._deleteSession(id)
      })
    })
  }

  _sessionRow(session) {
    const date     = formatSessionDate(session.date)
    const time     = formatSessionTime(session.timestamp)
    const duration = formatDuration(session.duration_s)
    const joint    = jointLabel(session)
    const position = positionLabel(session.position)
    const prov     = sessionProvenance(session)

    // Badges carry their own spacing rather than a " · " separator: a badge
    // that wraps to the next line would otherwise leave the dot dangling at the
    // end of the one above it.
    const positionBadge = position
      ? `<span class="position-badge">${position}</span>`
      : ''
    // Amber, and carrying the reason as a tooltip: these numbers cannot be
    // compared with a current recording, and nothing used to say so.
    const legacyBadge = prov.level !== 'ok'
      ? `<span class="legacy-badge" title="${prov.reason}">⚠ ${prov.label}</span>`
      : ''

    const selected = this._selected.has(session.id)

    return `
      <div class="session-row${selected ? ' selected' : ''}" data-id="${session.id}">
        <div class="row-check">${selected ? '✓' : ''}</div>
        <div class="session-info">
          <div class="session-date">${date} <span class="session-time">${time}</span></div>
          <div class="session-meta">${duration} · ${session.samples} samples · ${joint}${positionBadge}${legacyBadge}</div>
          ${session.notes ? `<div class="session-notes">${session.notes}</div>` : ''}
        </div>
        <div class="session-stats">
          <div class="stat-rom">${romArc(session.min, session.max)}</div>
          <div class="stat-range">${session.rom}° total</div>
        </div>
        <div class="row-chevron">›</div>
        <button class="btn-delete" data-id="${session.id}" aria-label="Delete session">
          ✕
        </button>
      </div>`
  }

  _deleteSession(id) {
    // Confirm before deleting — data loss is irreversible
    if (!confirm('Delete this session?')) return
    deleteSession(id)
    // Re-render the full view with updated data
    const sessions = this._loadScopedSessions()
    this._renderChart(sessions)
    this._renderScopeChips(sessions)
    this._renderList(sessions)
  }

  // ─── Template ────────────────────────────────────────────────────────

  _template() {
    return `
      <div class="history-view">

        <div class="history-header">
          <button id="btn-back" class="btn-ghost btn-back">← Back</button>
          <h1 class="history-title">History</h1>
          <button id="btn-select-mode" class="btn-select-mode">Select</button>
        </div>

        <div id="scope-chips" class="scope-chips"></div>

        <div class="chart-container">
          <canvas id="rom-chart"></canvas>
        </div>

        <div class="list-header">
          <span>Sessions</span>
          <span class="list-header-hint">min – max · total</span>
        </div>

        <div id="session-list" class="session-list"></div>

        <!-- Only visible in select mode. Sits at the bottom, away from the
             per-row delete controls that select mode hides. -->
        <div id="selection-bar" class="selection-bar" style="display:none">
          <button id="btn-select-cancel" class="btn-ghost btn-select-cancel">Cancel</button>
          <span id="selection-count" class="selection-count">Select sessions</span>
          <button id="btn-export-selected" class="btn-export-selected" disabled>Export PDF</button>
        </div>

      </div>

      <style>
        .history-view {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background: #0a0a0a;
          overflow: hidden;
        }

        .history-header {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px 16px 12px;
          background: #111;
          border-bottom: 1px solid #222;
          flex-shrink: 0;
        }

        .history-title {
          font-size: 18px;
          font-weight: 600;
          color: #f0f0f0;
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .btn-select-mode {
          background: none;
          border: 1px solid #333;
          border-radius: 8px;
          color: #ccc;
          font-family: inherit;
          font-size: 13px;
          font-weight: 500;
          padding: 7px 12px;
          flex-shrink: 0;
        }

        .btn-select-mode:active { background: #1a1a1a; }

        /* Select mode hides the per-row delete: a checkbox row sitting next to
           a live delete control invites the one mis-tap that cannot be undone. */
        .selecting .btn-delete,
        .selecting .row-chevron { display: none; }

        .row-check { display: none; }

        .selecting .row-check {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border: 1px solid #444;
          border-radius: 50%;
          color: #0a0a0a;
          font-size: 13px;
          font-weight: 700;
          flex-shrink: 0;
        }

        .selecting .session-row.selected .row-check {
          background: #4ade80;
          border-color: #4ade80;
        }

        .selecting .session-row.selected { background: rgba(74,222,128,0.07); }

        .selection-bar {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          padding-bottom: calc(12px + env(safe-area-inset-bottom));
          background: #111;
          border-top: 1px solid #222;
          flex-shrink: 0;
        }

        .selection-count {
          flex: 1;
          font-size: 13px;
          color: #888;
        }

        .btn-export-selected {
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 10px;
          color: #f0f0f0;
          font-family: inherit;
          font-size: 14px;
          font-weight: 600;
          padding: 10px 16px;
          flex-shrink: 0;
        }

        .btn-export-selected:disabled { opacity: 0.45; }

        .btn-select-cancel { padding: 8px 10px; font-size: 13px; flex-shrink: 0; }

        .btn-back {
          padding: 8px 14px;
          font-size: 14px;
          flex-shrink: 0;
        }

        /* Scopes the trend to one joint+side. Horizontally scrollable rather
           than wrapping, so a patient with many joints keeps the chart on
           screen. */
        .scope-chips {
          display: flex;
          gap: 6px;
          padding: 10px 16px 0;
          background: #111;
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
          flex-shrink: 0;
        }

        .scope-chips::-webkit-scrollbar { display: none; }

        .scope-chip {
          background: #1a1a1a;
          border: 1px solid #262626;
          color: #888;
          border-radius: 999px;
          padding: 5px 11px;
          font-size: 12px;
          font-weight: 500;
          white-space: nowrap;
          flex-shrink: 0;
        }

        .scope-chip.active {
          background: rgba(74,222,128,0.12);
          border-color: rgba(74,222,128,0.4);
          color: #4ade80;
        }

        .chart-container {
          height: 180px;
          padding: 12px 16px 8px;
          background: #111;
          flex-shrink: 0;
        }

        .list-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 16px 6px;
          font-size: 12px;
          font-weight: 600;
          color: #666;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          flex-shrink: 0;
        }

        .list-header-hint {
          font-weight: 400;
          text-transform: none;
          letter-spacing: 0;
        }

        .session-list {
          flex: 1;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          padding: 0 0 24px;
        }

        .session-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          border-bottom: 1px solid #1a1a1a;
          cursor: pointer;
        }

        .session-row:active {
          background: #1a1a1a;
        }

        .session-info {
          flex: 1;
          min-width: 0;
        }

        .session-date {
          font-size: 14px;
          font-weight: 500;
          color: #f0f0f0;
        }

        .session-time {
          font-weight: 400;
          color: #888;
          font-size: 13px;
        }

        .session-meta {
          font-size: 12px;
          color: #666;
          margin-top: 2px;
        }

        .position-badge {
          display: inline-block;
          background: rgba(96,165,250,0.15);
          color: #60a5fa;
          border-radius: 4px;
          padding: 0 4px;
          margin-left: 5px;
          font-size: 11px;
          font-weight: 500;
        }

        /* Amber, not red: the session is readable, its numbers just are not
           comparable with a current recording. */
        .legacy-badge {
          display: inline-block;
          background: rgba(251,191,36,0.15);
          color: #fbbf24;
          border-radius: 4px;
          padding: 0 4px;
          margin-left: 5px;
          font-size: 11px;
          font-weight: 500;
        }

        .session-notes {
          font-size: 12px;
          color: #888;
          margin-top: 2px;
          font-style: italic;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .session-stats {
          text-align: right;
          flex-shrink: 0;
        }

        /* The arc, not the subtraction — so it carries two numbers and a dash
           where it used to carry one, and needs to be a little smaller. */
        .stat-rom {
          font-size: 19px;
          font-weight: 700;
          color: #4ade80;
          line-height: 1;
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
        }

        .stat-range {
          font-size: 11px;
          color: #666;
          margin-top: 3px;
        }

        .row-chevron {
          color: #333;
          font-size: 20px;
          flex-shrink: 0;
          line-height: 1;
          margin-right: -4px;
        }

        .btn-delete {
          background: none;
          border: none;
          color: #444;
          font-size: 16px;
          padding: 8px;
          border-radius: 6px;
          flex-shrink: 0;
          line-height: 1;
        }

        .btn-delete:active {
          color: #f87171;
          background: rgba(248,113,113,0.1);
        }

        .empty-state {
          text-align: center;
          color: #666;
          font-size: 14px;
          line-height: 1.6;
          padding: 48px 32px;
        }
      </style>
    `
  }
}
