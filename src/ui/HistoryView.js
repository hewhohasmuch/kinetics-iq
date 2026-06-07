/**
 * HistoryView.js
 *
 * Displays past sessions in a scrollable list with a ROM trend chart.
 *
 * Layout:
 *   ┌─────────────────────┐
 *   │  ROM trend (chart)  │
 *   ├─────────────────────┤
 *   │  Session list       │
 *   │  [date] [ROM] [del] │
 *   │  [date] [ROM] [del] │
 *   └─────────────────────┘
 *
 * Chart.js is loaded from CDN — no npm install needed.
 * We use a simple line chart showing ROM over time (most recent 10 sessions).
 *
 * NAVIGATION:
 * This view receives an onBack callback to return to MeasureView.
 * main.js handles swapping views.
 */

import { loadSessions, deleteSession } from '../core/storage.js'
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
    const sessions = loadSessions()   // newest first

    this._renderChart(sessions)
    this._renderList(sessions)

    document.getElementById('btn-back')
      .addEventListener('click', () => this.onBack())
  }

  _renderChart(sessions) {
    const canvas = document.getElementById('rom-chart')
    if (!canvas) return

    // Chart shows oldest→newest (reverse of list display)
    // Take up to last 10 sessions, oldest first
    const chartData = [...sessions]
      .reverse()
      .slice(-10)

    if (chartData.length === 0) {
      canvas.parentElement.style.display = 'none'
      return
    }

    const labels = chartData.map(s => this._formatDate(s.date))
    const romValues = chartData.map(s => s.rom)

    // Chart.js is loaded from CDN in the template <script> tag.
    // It attaches to window.Chart — we wait for it here.
    if (this._chart) this._chart.destroy()

    const initChart = () => {
      this._chart = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'ROM (degrees)',
            data: romValues,
            borderColor: '#4ade80',
            backgroundColor: 'rgba(74, 222, 128, 0.1)',
            borderWidth: 2,
            pointBackgroundColor: '#4ade80',
            pointRadius: 4,
            pointHoverRadius: 6,
            tension: 0.3,
            fill: true,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => ` ${ctx.parsed.y}°`
              }
            }
          },
          scales: {
            x: {
              ticks: {
                color: '#666',
                font: { size: 11 },
                maxRotation: 0,
              },
              grid: { color: 'rgba(255,255,255,0.05)' },
            },
            y: {
              ticks: {
                color: '#666',
                font: { size: 11 },
                callback: v => `${v}°`,
              },
              grid: { color: 'rgba(255,255,255,0.05)' },
              min: 0,
            }
          }
        }
      })
    }

    initChart()
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

    // Bind delete buttons
    // Tap row to open detail
    listEl.querySelectorAll('.session-row').forEach(row => {
      row.addEventListener('click', (e) => {
        // Don't trigger if delete button was tapped
        if (e.target.closest('.btn-delete')) return
        const id      = row.dataset.id
        const session = loadSessions().find(s => s.id === id)
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
    const date     = this._formatDate(session.date)
    const time     = this._formatTime(session.timestamp)
    const duration = this._formatDuration(session.duration_s)
    const joint    = this._jointLabel(session)

    return `
      <div class="session-row" data-id="${session.id}">
        <div class="session-info">
          <div class="session-date">${date} <span class="session-time">${time}</span></div>
          <div class="session-meta">${duration} · ${session.samples} samples · ${joint}</div>
          ${session.notes ? `<div class="session-notes">${session.notes}</div>` : ''}
        </div>
        <div class="session-stats">
          <div class="stat-rom">${session.rom}°</div>
          <div class="stat-range">${session.min}° – ${session.max}°</div>
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
    const sessions = loadSessions()
    this._renderChart(sessions)
    this._renderList(sessions)
  }

  _jointLabel(session) {
    const names = { knee: 'Knee', hip: 'Hip', shoulder: 'Shoulder', elbow: 'Elbow', ankle: 'Ankle' }
    if (session.side) {
      const side = session.side.charAt(0).toUpperCase() + session.side.slice(1)
      return `${side} ${names[session.joint] || session.joint}`
    }
    // old format: 'knee_right' → 'Right Knee'
    const [joint, side] = session.joint.split('_')
    if (side) return `${side.charAt(0).toUpperCase() + side.slice(1)} ${names[joint] || joint}`
    return names[session.joint] || session.joint
  }

  // ─── Private: formatters ─────────────────────────────────────────────

  _formatDate(dateStr) {
    // dateStr is 'YYYY-MM-DD'
    const [year, month, day] = dateStr.split('-').map(Number)
    const date = new Date(year, month - 1, day)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  _formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  }

  _formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  }

  // ─── Template ────────────────────────────────────────────────────────

  _template() {
    return `
      <div class="history-view">

        <div class="history-header">
          <button id="btn-back" class="btn-ghost btn-back">← Back</button>
          <h1 class="history-title">History</h1>
        </div>

        <div class="chart-container">
          <canvas id="rom-chart"></canvas>
        </div>

        <div class="list-header">
          <span>Sessions</span>
          <span class="list-header-hint">ROM = total range</span>
        </div>

        <div id="session-list" class="session-list"></div>

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
        }

        .btn-back {
          padding: 8px 14px;
          font-size: 14px;
          flex-shrink: 0;
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

        .stat-rom {
          font-size: 24px;
          font-weight: 700;
          color: #4ade80;
          line-height: 1;
          font-variant-numeric: tabular-nums;
        }

        .stat-range {
          font-size: 11px;
          color: #666;
          margin-top: 2px;
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
