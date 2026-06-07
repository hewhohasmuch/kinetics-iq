/**
 * SessionDetailView.js
 *
 * Shows the full detail of a single session:
 *   - Stat cards: ROM, Min, Max, Duration
 *   - Full angle timeline chart (Chart.js)
 *   - Notes
 *   - Delete button
 *
 * Receives a session object directly — loaded by HistoryView before navigating.
 */

import { deleteSession } from '../core/storage.js'
import { Chart } from 'chart.js/auto'

export class SessionDetailView {
  /**
   * @param {HTMLElement} container
   * @param {Session}     session   - full session object including angleTimeline
   * @param {Function}    onBack    - called when user taps Back (returns to history)
   */
  constructor(container, session, onBack) {
    this.container = container
    this.session   = session
    this.onBack    = onBack
    this._chart    = null
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

  // ─── Private ────────────────────────────────────────────────────────

  _render() {
    const s = this.session

    // Stat cards
    document.getElementById('stat-rom').textContent  = `${s.rom}°`
    document.getElementById('stat-min').textContent  = `${s.min}°`
    document.getElementById('stat-max').textContent  = `${s.max}°`
    document.getElementById('stat-dur').textContent  = this._formatDuration(s.duration_s)
    document.getElementById('stat-samples').textContent = `${s.samples} samples`

    // Header date/time and joint label
    document.getElementById('detail-title').textContent =
      `${this._formatDate(s.date)}  ${this._formatTime(s.timestamp)}`
    document.getElementById('detail-joint').textContent = this._jointLabel(s)

    // Notes
    const notesEl = document.getElementById('detail-notes')
    if (s.notes) {
      notesEl.textContent    = s.notes
      notesEl.style.display  = 'block'
    } else {
      notesEl.style.display  = 'none'
    }

    // Chart
    this._renderChart(s.angleTimeline, s.duration_s)

    // Events
    document.getElementById('btn-detail-back')
      .addEventListener('click', () => this.onBack())

    document.getElementById('btn-detail-delete')
      .addEventListener('click', () => this._handleDelete())
  }

  _renderChart(timeline, durationS) {
    const canvas = document.getElementById('detail-chart')
    if (!canvas || !timeline || timeline.length === 0) return

    const timeStep = durationS / timeline.length
    const labels   = timeline.map((_, i) => {
      const t = i * timeStep
      return t % 5 === 0 || i === 0 ? `${Math.round(t)}s` : ''
    })

    // Load Chart.js dynamically if not already available.
    // innerHTML does not execute <script> tags — we must use this approach.
    if (this._chart) this._chart.destroy()

    const initChart = () => {

      this._chart = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Flexion (°)',
            data:  timeline,
            borderColor:     '#4ade80',
            backgroundColor: 'rgba(74,222,128,0.08)',
            borderWidth:     2,
            pointRadius:     0,         // no dots — too many samples
            pointHoverRadius: 4,
            tension:         0.3,
            fill:            true,
          }]
        },
        options: {
          responsive:          true,
          maintainAspectRatio: false,
          animation:           { duration: 400 },
          plugins: {
            legend: { display: false },
            tooltip: {
              mode: 'index',
              intersect: false,
              callbacks: {
                title: (items) => `${(items[0].dataIndex * timeStep).toFixed(1)}s`,
                label: (ctx)   => ` ${ctx.parsed.y.toFixed(1)}°`,
              }
            }
          },
          scales: {
            x: {
              ticks: {
                color:       '#555',
                font:        { size: 11 },
                maxRotation: 0,
                autoSkip:    false,
              },
              grid: { color: 'rgba(255,255,255,0.04)' },
            },
            y: {
              ticks: {
                color:    '#555',
                font:     { size: 11 },
                callback: v => `${v}°`,
              },
              grid:    { color: 'rgba(255,255,255,0.04)' },
              min:     0,
              suggestedMax: Math.ceil((Math.max(...timeline) + 10) / 10) * 10,
            }
          },
          interaction: {
            mode:      'nearest',
            axis:      'x',
            intersect: false,
          }
        }
      })
    }

    initChart()
  }

  _handleDelete() {
    if (!confirm('Delete this session? This cannot be undone.')) return
    deleteSession(this.session.id)
    this.onBack()
  }

  _jointLabel(session) {
    const names = { knee: 'Knee', hip: 'Hip', shoulder: 'Shoulder', elbow: 'Elbow' }
    if (session.side) {
      const side = session.side.charAt(0).toUpperCase() + session.side.slice(1)
      return `${side} ${names[session.joint] || session.joint}`
    }
    const [joint, side] = session.joint.split('_')
    if (side) return `${side.charAt(0).toUpperCase() + side.slice(1)} ${names[joint] || joint}`
    return names[session.joint] || session.joint
  }

  // ─── Formatters ──────────────────────────────────────────────────────

  _formatDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric'
    })
  }

  _formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true
    })
  }

  _formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  }

  // ─── Template ─────────────────────────────────────────────────────────

  _template() {
    return `
      <div class="detail-view">

        <div class="detail-header">
          <button id="btn-detail-back" class="btn-ghost btn-back">← Back</button>
          <div class="detail-title-group">
            <div id="detail-title" class="detail-title"></div>
            <div id="detail-joint" class="detail-joint"></div>
          </div>
          <button id="btn-detail-delete" class="btn-delete-sm">Delete</button>
        </div>

        <!-- Stat cards -->
        <div class="stat-cards">
          <div class="stat-card stat-card-primary">
            <div id="stat-rom"  class="stat-value">--</div>
            <div class="stat-label">ROM</div>
          </div>
          <div class="stat-card">
            <div id="stat-min"  class="stat-value">--</div>
            <div class="stat-label">Min</div>
          </div>
          <div class="stat-card">
            <div id="stat-max"  class="stat-value">--</div>
            <div class="stat-label">Max</div>
          </div>
          <div class="stat-card">
            <div id="stat-dur"  class="stat-value">--</div>
            <div class="stat-label">Duration</div>
          </div>
        </div>

        <!-- Notes -->
        <div id="detail-notes" class="detail-notes"></div>

        <!-- Timeline chart -->
        <div class="chart-section">
          <div class="chart-section-label">Angle timeline</div>
          <div class="detail-chart-container">
            <canvas id="detail-chart"></canvas>
          </div>
          <div id="stat-samples" class="chart-meta"></div>
        </div>

      </div>

      <style>
        .detail-view {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background: #0a0a0a;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
        }

        .detail-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 16px 12px;
          background: #111;
          border-bottom: 1px solid #222;
          flex-shrink: 0;
          position: sticky;
          top: 0;
          z-index: 10;
        }

        .detail-title-group {
          flex: 1;
          margin: 0 8px;
          text-align: center;
          min-width: 0;
        }

        .detail-title {
          font-size: 14px;
          font-weight: 500;
          color: #f0f0f0;
        }

        .detail-joint {
          font-size: 12px;
          color: #60a5fa;
          margin-top: 2px;
          font-weight: 500;
        }

        .btn-back {
          padding: 8px 14px;
          font-size: 14px;
          flex-shrink: 0;
        }

        .btn-delete-sm {
          background: none;
          border: 1px solid #333;
          color: #666;
          padding: 8px 12px;
          border-radius: 8px;
          font-size: 13px;
          cursor: pointer;
          flex-shrink: 0;
          transition: all 0.15s;
        }

        .btn-delete-sm:active {
          border-color: #f87171;
          color: #f87171;
          background: rgba(248,113,113,0.1);
        }

        /* Stat cards */
        .stat-cards {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr 1fr;
          gap: 8px;
          padding: 16px;
          background: #111;
          border-bottom: 1px solid #1a1a1a;
          flex-shrink: 0;
        }

        .stat-card {
          background: #1a1a1a;
          border-radius: 10px;
          padding: 10px 8px;
          text-align: center;
        }

        .stat-card-primary {
          background: rgba(74,222,128,0.08);
          border: 1px solid rgba(74,222,128,0.2);
        }

        .stat-value {
          font-size: 22px;
          font-weight: 700;
          color: #f0f0f0;
          font-variant-numeric: tabular-nums;
          line-height: 1;
        }

        .stat-card-primary .stat-value {
          color: #4ade80;
          font-size: 26px;
        }

        .stat-label {
          font-size: 11px;
          color: #666;
          margin-top: 4px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        /* Notes */
        .detail-notes {
          margin: 12px 16px 0;
          padding: 10px 14px;
          background: #1a1a1a;
          border-radius: 8px;
          font-size: 14px;
          color: #aaa;
          font-style: italic;
          line-height: 1.5;
        }

        /* Timeline chart */
        .chart-section {
          padding: 16px;
          flex: 1;
        }

        .chart-section-label {
          font-size: 11px;
          font-weight: 600;
          color: #555;
          text-transform: uppercase;
          letter-spacing: 0.07em;
          margin-bottom: 10px;
        }

        .detail-chart-container {
          height: 220px;
          background: #111;
          border-radius: 10px;
          padding: 12px;
        }

        .chart-meta {
          font-size: 12px;
          color: #444;
          margin-top: 8px;
          text-align: right;
        }
      </style>
    `
  }
}
