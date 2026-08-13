/**
 * SessionDetailView.js
 *
 * Shows the full detail of a single session:
 *   - Stat cards: the ROM arc, both extremes named per joint, duration
 *   - Provenance: whether the session was zeroed, and whether its numbers are
 *     comparable with a current recording
 *   - Full angle timeline chart (Chart.js)
 *   - Notes, editable after the fact
 *   - Delete button
 *
 * THE EXTREMES ARE NAMED, NOT NUMBERED. The cards used to read "Min" and
 * "Max", which say nothing about what motion produced them — and the frame
 * captions right below them already said "Peak flexion". Both now read from
 * extremeLabels() so the card and the picture beneath it cannot disagree about
 * the same number.
 *
 * Receives a session object directly — loaded by HistoryView before navigating.
 */

import { deleteSession, saveSession } from '../core/storage.js'
import { SessionRecorder } from '../core/session.js'
import {
  extremeLabels, jointLabel, positionLabel, romArc, motionLabel,
  formatSessionDate, formatSessionTime, formatDuration,
} from '../core/labels.js'
import { sessionProvenance, calibrationSummary } from '../core/provenance.js'
import { sessionNoteText } from '../core/report.js'
import { resolveFrameBlob } from '../core/frames.js'
import { exportSessionsAsPdf, canShareFile, shareFile } from './exportPdf.js'
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
    this._objectUrls = []   // blob: URLs to revoke on unmount
    this._copyTimer  = null // "Copied ✓" label reset
    this._pdfTimer   = null // "Saved ✓" label reset
    this._pdf        = null // last built PDF, held so Share gets its own gesture
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
    clearTimeout(this._copyTimer)
    clearTimeout(this._pdfTimer)
    this._pdf = null
    for (const url of this._objectUrls) URL.revokeObjectURL(url)
    this._objectUrls = []
    this.container.innerHTML = ''
  }

  // ─── Private ────────────────────────────────────────────────────────

  _render() {
    const s = this.session

    // Stat cards. The arc leads — a knee lacking 5° of extension and one with
    // full extension subtract to the same total, and the deficit is the
    // finding, so `rom` alone cannot be the headline figure.
    const { maxLabel, minLabel } = extremeLabels(s.joint, s.min)
    document.getElementById('stat-rom').textContent   = romArc(s.min, s.max)
    document.getElementById('stat-rom-total').textContent = `${s.rom}° total`
    document.getElementById('stat-min').textContent   = `${s.min}°`
    document.getElementById('stat-max').textContent   = `${s.max}°`
    document.getElementById('stat-min-label').textContent = minLabel
    document.getElementById('stat-max-label').textContent = maxLabel
    document.getElementById('stat-dur').textContent  = formatDuration(s.duration_s)
    document.getElementById('stat-samples').textContent = `${s.samples} samples`

    // Header date/time and joint label
    document.getElementById('detail-title').textContent =
      `${formatSessionDate(s.date, { weekday: true })}  ${formatSessionTime(s.timestamp)}`
    const jointEl = document.getElementById('detail-joint')
    jointEl.textContent = jointLabel(s)
    const position = positionLabel(s.position)
    if (position) {
      const badge = document.createElement('span')
      badge.className = 'detail-position-badge'
      badge.textContent = position
      jointEl.appendChild(badge)
    }

    this._renderProvenance(s)
    this._renderNotes()

    // ROM frames load asynchronously from IndexedDB (local cache) or the cloud
    // — see _renderFrames. Not awaited: the rest of the detail renders now.
    this._renderFrames(s)

    // Chart
    this._renderChart(s.angleTimeline, s.duration_s)

    // Events
    document.getElementById('btn-detail-back')
      .addEventListener('click', () => this.onBack())

    document.getElementById('btn-detail-delete')
      .addEventListener('click', () => this._handleDelete())

    document.getElementById('btn-copy-note')
      .addEventListener('click', () => this._handleCopy())

    document.getElementById('btn-export-pdf')
      .addEventListener('click', () => this._handleExportPdf())
    document.getElementById('btn-share-pdf')
      .addEventListener('click', () => this._handleShare())

    document.getElementById('detail-notes')
      .addEventListener('click', () => this._openNotesEditor())
    document.getElementById('btn-notes-save')
      .addEventListener('click', () => this._saveNotes())
    document.getElementById('btn-notes-cancel')
      .addEventListener('click', () => this._renderNotes())
  }

  /**
   * How much this session's numbers can be trusted, in one line each.
   *
   * Both facts were previously stored (or, for calibration, not stored at all)
   * and never shown, which is the dangerous direction: a session recorded under
   * the old filter reads systematically low at the extremes, and sitting next
   * to a current one it looks like the patient improved.
   */
  _renderProvenance(s) {
    const row = document.getElementById('detail-provenance')
    if (!row) return

    const parts = []

    // Whether a zero was captured. Absence is its own state — a session saved
    // before this was recorded cannot be described as raw, only as unknown.
    const cal = calibrationSummary(s)
    parts.push(
      `<span class="prov-chip${cal.known ? '' : ' unknown'}">${cal.text}</span>`
    )

    const prov = sessionProvenance(s)
    if (prov.level !== 'ok') {
      parts.push(
        `<span class="prov-chip legacy" title="${prov.reason}">⚠ ${prov.label}</span>`
      )
    }

    row.innerHTML = parts.join('')
  }

  // ─── Notes ───────────────────────────────────────────────────────────

  /**
   * Notes are editable here, not only at capture time. They used to be
   * write-once in the panel that appears straight after Stop & Save — the one
   * moment a clinician is least likely to be typing — and read-only forever
   * afterwards.
   */
  _renderNotes() {
    const display = document.getElementById('detail-notes')
    const editor  = document.getElementById('notes-editor')
    if (!display || !editor) return

    editor.style.display  = 'none'
    display.style.display = 'block'
    display.textContent   = this.session.notes || 'Add a note'
    display.classList.toggle('empty', !this.session.notes)
  }

  _openNotesEditor() {
    const display = document.getElementById('detail-notes')
    const editor  = document.getElementById('notes-editor')
    const input   = document.getElementById('notes-edit-input')
    if (!display || !editor || !input) return

    input.value           = this.session.notes || ''
    display.style.display = 'none'
    editor.style.display  = 'block'
    input.focus()
  }

  _saveNotes() {
    const input = document.getElementById('notes-edit-input')
    if (!input) return

    // Same 200-char cap the capture path applies, enforced in one place rather
    // than re-implemented here.
    const updated = SessionRecorder.attachNotes({ ...this.session }, input.value)
    if (!updated) return

    if (saveSession(updated)) {
      // saveSession upserts by id, stamps updated_at and enqueues the sync op.
      this.session = updated
    } else {
      this._showNotesError()
      return
    }
    this._renderNotes()
  }

  _showNotesError() {
    const err = document.getElementById('notes-error')
    if (!err) return
    err.style.display = 'block'
    setTimeout(() => { err.style.display = 'none' }, 3000)
  }

  /**
   * Load and display the two extreme-pose snapshots. Each frame resolves from
   * the local IndexedDB cache first (offline-safe), then falls back to a cloud
   * download when a path is known and we're online. A frame that exists in the
   * cloud but can't be fetched right now shows an offline placeholder.
   *
   * peakFrame = max flexion (most bent); minFrame = max extension (straightest).
   */
  async _renderFrames(s) {
    const framesEl = document.getElementById('detail-frames')
    if (!framesEl) return

    // The motion is named per joint — a shoulder elevates, an ankle dorsiflexes
    // — and the min frame is only the NEGATIVE motion when the value actually
    // crossed the zero point. extremeLabels() owns that rule so these captions
    // and the stat cards above them stay in step. Both captions keep the signed
    // value the overlay burned into the image — an abs() here would put two
    // different numbers on one picture.
    const { maxLabel, minLabel } = extremeLabels(s.joint, s.min)

    const specs = [
      { which: 'peak', path: s.peakFramePath, figId: 'frame-max', caption: `${maxLabel}: ${s.max}°` },
      { which: 'min',  path: s.minFramePath,  figId: 'frame-min', caption: `${minLabel}: ${s.min}°` },
    ]

    let shown = 0
    for (const spec of specs) {
      const fig = document.getElementById(spec.figId)
      if (!fig) continue
      const url = await this._resolveFrameUrl(s.id, spec.which, spec.path)
      if (url) {
        const img = fig.querySelector('img')
        img.src = url
        img.alt = `${spec.caption} pose`
        fig.querySelector('.peak-frame-caption').textContent = spec.caption
        fig.style.display = 'block'
        shown++
      } else if (spec.path) {
        // Known in the cloud, just not reachable now.
        this._showFramePlaceholder(fig, spec.caption)
        fig.style.display = 'block'
        shown++
      }
    }

    if (shown === 1) framesEl.querySelector('.rom-frames').classList.add('single')
    if (shown > 0)   framesEl.style.display = 'block'
  }

  /**
   * Resolve a displayable object URL for one frame, or null if unavailable.
   *
   * The IndexedDB → cloud → re-cache rule lives in frames.js because the PDF
   * export needs exactly the same one; all this adds is the object URL and its
   * bookkeeping for revocation on unmount.
   *
   * @returns {Promise<string|null>}
   */
  async _resolveFrameUrl(sessionId, which, path) {
    const blob = await resolveFrameBlob(sessionId, which, path)
    if (!blob) return null
    const url = URL.createObjectURL(blob)
    this._objectUrls.push(url)
    return url
  }

  _showFramePlaceholder(fig, caption) {
    const img = fig.querySelector('img')
    if (img) { img.removeAttribute('src'); img.style.display = 'none' }
    fig.querySelector('.peak-frame-caption').textContent =
      `${caption} — image not available offline`
  }

  _renderChart(timeline, durationS) {
    const canvas = document.getElementById('detail-chart')
    if (!canvas || !timeline || timeline.length === 0) return

    const timeStep = durationS / timeline.length
    const labels   = timeline.map((_, i) => {
      const t = i * timeStep
      return t % 5 === 0 || i === 0 ? `${Math.round(t)}s` : ''
    })

    // Axis is named for the joint's positive motion, not a blanket "Flexion".
    // This string used to go only into the dataset label, which the disabled
    // legend never rendered — so nothing on screen said whether the axis was
    // flexion, elevation or dorsiflexion. It is now the axis title as well.
    const axisLabel = `${motionLabel(this.session?.joint)} (°)`

    // Load Chart.js dynamically if not already available.
    // innerHTML does not execute <script> tags — we must use this approach.
    if (this._chart) this._chart.destroy()

    const initChart = () => {

      this._chart = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: axisLabel,
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
              title: {
                display: true,
                text:    axisLabel,
                color:   '#777',
                font:    { size: 11 },
              },
              ticks: {
                color:    '#555',
                font:     { size: 11 },
                callback: v => `${v}°`,
              },
              grid:    { color: 'rgba(255,255,255,0.04)' },
              // Floor at 0 for a normal flexion sweep, but drop below it when
              // the session actually went into extension — a hard min of 0
              // clipped negative values off the bottom of the chart entirely.
              suggestedMin: Math.min(0, Math.floor((Math.min(...timeline) - 10) / 10) * 10),
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

  // ─── Copy for note ───────────────────────────────────────────────────

  /**
   * Put a paste-ready summary of this session on the clipboard.
   *
   * The app produced a full record and then stranded it on the phone: the
   * numbers were read off this screen and retyped into the EHR, dropping the
   * provenance stamps on the way. report.js owns the wording; this only moves
   * it to the clipboard.
   *
   * SAFARI GESTURE RULE: the text is built synchronously and writeText() is the
   * first thing the handler does. Any `await` before the write drops the
   * user-gesture context on iOS and the write fails silently — hence the
   * .then() chain rather than an async handler.
   */
  _handleCopy() {
    const text = sessionNoteText(this.session)

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(()  => this._flashCopied())
        .catch(() => this._showCopyFallback(text))
      return
    }
    // No clipboard API at all: http:// on a LAN address, or an older iOS.
    this._showCopyFallback(text)
  }

  _flashCopied() {
    const btn = document.getElementById('btn-copy-note')
    if (!btn) return
    clearTimeout(this._copyTimer)
    btn.textContent = 'Copied ✓'
    btn.classList.add('copied')
    this._copyTimer = setTimeout(() => {
      btn.textContent = 'Copy for note'
      btn.classList.remove('copied')
    }, 2000)
  }

  // ─── Export PDF ──────────────────────────────────────────────────────

  /**
   * Build a chart-ready PDF of this session and hand it to the user.
   *
   * Deliberately NOT modelled on _handleCopy's gesture discipline — see the
   * header of exportPdf.js. Generation is unavoidably async, so the download
   * goes through an anchor (which needs no gesture) and sharing is offered
   * afterwards as its own tap.
   */
  async _handleExportPdf() {
    const btn = document.getElementById('btn-export-pdf')
    if (!btn || btn.disabled) return

    const restore = btn.textContent
    btn.disabled = true
    btn.textContent = 'Preparing…'      // two JPEGs — not instant on a phone

    try {
      const { blob, filename, missingImages } = await exportSessionsAsPdf([this.session])
      this._pdf = { blob, filename }

      btn.textContent = missingImages > 0 ? 'Saved — photos missing' : 'Saved ✓'
      btn.classList.add('copied')

      // Share needs a live gesture of its own, so it appears as a button
      // rather than firing from here.
      const share = document.getElementById('btn-share-pdf')
      if (share && canShareFile(blob, filename)) share.style.display = 'block'
    } catch (e) {
      console.error('PDF export failed:', e)
      btn.textContent = 'Export failed'
    } finally {
      btn.disabled = false
      clearTimeout(this._pdfTimer)
      this._pdfTimer = setTimeout(() => {
        btn.textContent = restore
        btn.classList.remove('copied')
      }, 3000)
    }
  }

  /** Fresh user gesture — required by navigator.share() on iOS. */
  _handleShare() {
    if (this._pdf) shareFile(this._pdf.blob, this._pdf.filename)
  }

  /**
   * The real failure mode on a non-secure context, not optional polish: reveal
   * the text with its contents selected so it can be long-pressed → Copy.
   */
  _showCopyFallback(text) {
    const area = document.getElementById('copy-fallback')
    const hint = document.getElementById('copy-fallback-hint')
    if (!area) return
    area.value = text
    area.style.display = 'block'
    if (hint) hint.style.display = 'block'
    area.focus()
    area.setSelectionRange(0, text.length)
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

        <!-- Provenance: how much these numbers can be trusted -->
        <div id="detail-provenance" class="detail-provenance"></div>

        <!-- Stat cards. The arc leads; the total is secondary. -->
        <div class="stat-cards">
          <div class="stat-card stat-card-primary">
            <div id="stat-rom"  class="stat-value stat-value-arc">--</div>
            <div class="stat-label">ROM</div>
            <div id="stat-rom-total" class="stat-sub">--</div>
          </div>
          <div class="stat-card">
            <div id="stat-min"  class="stat-value">--</div>
            <div id="stat-min-label" class="stat-label">Min</div>
          </div>
          <div class="stat-card">
            <div id="stat-max"  class="stat-value">--</div>
            <div id="stat-max-label" class="stat-label">Max</div>
          </div>
          <div class="stat-card">
            <div id="stat-dur"  class="stat-value">--</div>
            <div class="stat-label">Duration</div>
          </div>
        </div>

        <!-- Copy for note. Deliberately NOT in .detail-header, which already
             holds Delete — putting Copy next to a destructive control on a
             phone invites a mis-tap on the one action that cannot be undone. -->
        <div class="copy-section">
          <button id="btn-copy-note" class="btn-copy-note">Copy for note</button>
          <!-- The document, as opposed to the note text: this is what actually
               attaches to a chart in eCW / WebPT / Prompt, and the only path
               the snapshots can travel by. -->
          <button id="btn-export-pdf" class="btn-copy-note btn-export-pdf">Export PDF</button>
          <!-- Revealed only after a PDF exists, because navigator.share() needs
               a live user gesture and generation has already consumed one. -->
          <button id="btn-share-pdf" class="btn-copy-note btn-share-pdf"
                  style="display:none">Share PDF…</button>
          <!-- Fallback for a non-secure context or an older iOS with no
               clipboard API: show the text selected so it can be long-pressed. -->
          <textarea id="copy-fallback" class="copy-fallback" readonly rows="9"
                    style="display:none"></textarea>
          <div id="copy-fallback-hint" class="copy-fallback-hint" style="display:none">
            Clipboard unavailable — select the text above and copy.
          </div>
        </div>

        <!-- Notes — editable here, not only at capture time -->
        <div class="notes-section">
          <div id="detail-notes" class="detail-notes"></div>
          <div id="notes-editor" class="notes-editor" style="display:none">
            <textarea id="notes-edit-input" class="notes-edit-input" rows="2"
                      maxlength="200" placeholder="Add a note… (day 14 post-op, after warm-up)"></textarea>
            <div class="notes-editor-actions">
              <button id="btn-notes-save" class="btn-notes-save">Save</button>
              <button id="btn-notes-cancel" class="btn-notes-cancel">Cancel</button>
            </div>
          </div>
          <div id="notes-error" class="notes-error" style="display:none">
            Could not save the note — storage may be full.
          </div>
        </div>

        <!-- ROM extreme frames -->
        <div id="detail-frames" class="peak-frame-section" style="display:none">
          <div class="chart-section-label">Range of motion frames</div>
          <div class="rom-frames">
            <!-- alt is set from the per-joint caption in _renderFrames() -->
            <figure id="frame-max" class="rom-frame" style="display:none">
              <img class="peak-frame-img" alt="Range of motion frame" />
              <div class="peak-frame-caption"></div>
            </figure>
            <figure id="frame-min" class="rom-frame" style="display:none">
              <img class="peak-frame-img" alt="Range of motion frame" />
              <div class="peak-frame-caption"></div>
            </figure>
          </div>
        </div>

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

        .detail-position-badge {
          display: inline-block;
          background: rgba(96,165,250,0.15);
          border-radius: 4px;
          padding: 0 5px;
          font-size: 11px;
          margin-left: 6px;
          vertical-align: middle;
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

        /* The arc carries two numbers and a dash where the total carried one. */
        .stat-card-primary .stat-value-arc {
          font-size: 19px;
          white-space: nowrap;
        }

        .stat-label {
          font-size: 11px;
          color: #666;
          margin-top: 4px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        /* Motion names are longer than "Min"/"Max" and must not be clipped. */
        .stat-card .stat-label {
          font-size: 10px;
          line-height: 1.25;
          letter-spacing: 0.03em;
        }

        .stat-sub {
          font-size: 10px;
          color: #4ade80;
          opacity: 0.65;
          margin-top: 3px;
          font-variant-numeric: tabular-nums;
        }

        /* Copy for note — full-width secondary, well away from Delete */
        .copy-section { padding: 12px 16px 0; }

        .btn-copy-note {
          width: 100%;
          padding: 12px;
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 10px;
          color: #f0f0f0;
          font-size: 14px;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          transition: all 0.15s;
        }

        .btn-copy-note:active { background: #222; border-color: #444; }

        .btn-copy-note + .btn-copy-note { margin-top: 8px; }

        .btn-export-pdf:disabled { opacity: 0.6; }

        .btn-copy-note.copied {
          color: #4ade80;
          border-color: rgba(74,222,128,0.4);
          background: rgba(74,222,128,0.08);
        }

        .copy-fallback {
          width: 100%;
          box-sizing: border-box;
          margin-top: 8px;
          padding: 10px 12px;
          background: #111;
          border: 1px solid #333;
          border-radius: 8px;
          color: #ddd;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12px;
          line-height: 1.5;
          resize: vertical;
        }

        .copy-fallback-hint {
          margin-top: 6px;
          font-size: 12px;
          color: #888;
        }

        /* Provenance chips */
        .detail-provenance {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          padding: 12px 16px 0;
        }

        .prov-chip {
          background: #1a1a1a;
          color: #888;
          border: 1px solid #262626;
          border-radius: 999px;
          padding: 3px 9px;
          font-size: 11px;
          font-weight: 500;
        }

        /* "Calibration not recorded" is a different claim from "measured raw",
           and reads dimmer so it is not mistaken for a positive finding. */
        .prov-chip.unknown { color: #5a5a5a; font-style: italic; }

        .prov-chip.legacy {
          background: rgba(251,191,36,0.12);
          border-color: rgba(251,191,36,0.35);
          color: #fbbf24;
        }

        /* Notes */
        .notes-section { margin: 12px 16px 0; }

        .detail-notes {
          padding: 10px 14px;
          background: #1a1a1a;
          border-radius: 8px;
          font-size: 14px;
          color: #aaa;
          font-style: italic;
          line-height: 1.5;
          cursor: pointer;
        }

        .detail-notes:active { background: #222; }

        .detail-notes.empty { color: #555; }

        .notes-edit-input {
          width: 100%;
          box-sizing: border-box;
          padding: 10px 14px;
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 8px;
          font-size: 14px;
          color: #f0f0f0;
          font-family: inherit;
          line-height: 1.5;
          resize: vertical;
        }

        .notes-editor-actions {
          display: flex;
          gap: 8px;
          margin-top: 8px;
        }

        .btn-notes-save, .btn-notes-cancel {
          flex: 1;
          padding: 8px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          border: none;
        }

        .btn-notes-save   { background: #4ade80; color: #0a0a0a; }
        .btn-notes-cancel { background: #1a1a1a; color: #888; border: 1px solid #333; }

        .notes-error {
          margin-top: 8px;
          font-size: 12px;
          color: #f87171;
        }

        /* ROM extreme frames */
        .peak-frame-section {
          padding: 16px 16px 0;
        }

        .rom-frames {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }

        /* A lone frame (old sessions) spans the full width */
        .rom-frames.single {
          grid-template-columns: 1fr;
        }

        .rom-frame {
          margin: 0;
          min-width: 0;
        }

        .peak-frame-img {
          width: 100%;
          border-radius: 10px;
          display: block;
          background: #111;
        }

        .peak-frame-caption {
          font-size: 12px;
          color: #4ade80;
          font-weight: 600;
          text-align: center;
          margin-top: 6px;
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
