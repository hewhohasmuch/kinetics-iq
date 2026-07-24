/**
 * MeasureView.js — Milestone 2 + Calibration
 */

import { Camera }            from '../detection/camera.js'
import { PoseDetector }      from '../detection/pose.js'
import { Overlay }           from '../detection/overlay.js'
import { jointAngle, toFlexionAngle, MedianFilter3, OneEuroFilter } from '../core/angle.js'
import { SessionRecorder }   from '../core/session.js'
import { saveSession, getActivePatientId, getPatient } from '../core/storage.js'
import { CalibrationManager } from '../core/calibration.js'
import { isConfigured }      from '../core/supabase.js'
import { getStatus, onSyncStatus } from '../core/sync.js'

const DETECTION_HZ          = 10
const DETECTION_INTERVAL_MS = 1000 / DETECTION_HZ

export class MeasureView {
  constructor(container, onShowHistory, onShowPatients) {
    this.container      = container
    this.onShowHistory  = onShowHistory
    this.onShowPatients = onShowPatients

    this.camera      = new Camera()
    this.detector    = new PoseDetector()
    this.overlay     = new Overlay()
    // Median rejects single-frame landmark glitches; One Euro then smooths
    // adaptively — calm while the joint is still, responsive while it moves,
    // so end-range peaks survive instead of being averaged away.
    this.median      = new MedianFilter3()
    this.euro        = new OneEuroFilter()
    this.recorder    = new SessionRecorder()
    this.calibration = new CalibrationManager()

    this._loopActive    = false
    this._lastDetection = 0
    this._rafId         = null
    this._joint         = 'knee'
    this._side          = 'right'
    this._position      = 'prone'
    this._drawerOpen    = false

    this.currentAngle  = null
    this._pendingSession = null  // holds session between stop() and note entry
    this._unsubSync      = null
  }

  mount() {
    this.container.innerHTML = this._template()
    this._bindElements()
    this._bindEvents()
    this._updateCalibrationUI()
    this._updatePatientChip()
    if (isConfigured()) {
      this._updateSyncDot(getStatus())
      this._unsubSync = onSyncStatus((status) => this._updateSyncDot(status))
    }
  }

  unmount() {
    if (this._unsubSync) {
      this._unsubSync()
      this._unsubSync = null
    }
    this._stopLoop()
    this.camera.stop()
    this.container.innerHTML = ''
  }

  // ─── Template ─────────────────────────────────────────────────────

  _template() {
    return `
      <div class="measure-view">

        <div class="camera-stack">
          <video id="rom-video" class="camera-video" playsinline muted autoplay></video>
          <canvas id="rom-overlay" class="camera-overlay"></canvas>
          <div id="status-badge" class="status-badge status-idle">Tap to start</div>

          <!-- Active patient chip + sync indicator -->
          <button id="patient-chip" class="patient-chip">
            <span id="sync-dot" class="sync-dot" style="display:none"></span>
            <span id="patient-chip-label">Select patient</span>
            <span class="chip-chevron">›</span>
          </button>

          <!-- Calibration sampling progress — shown during 2s capture -->
          <div id="cal-progress" class="cal-progress" style="display:none">
            <div id="cal-bar" class="cal-bar"></div>
            <div class="cal-progress-label">Hold still…</div>
          </div>

          <!-- Collapsible selector drawer — peeks as a handle, slides up on tap -->
          <div id="selector-drawer" class="selector-drawer" style="display:none">
            <div id="selector-handle" class="selector-handle">
              <div class="handle-grip"></div>
              <span id="handle-label">Right Knee · Prone</span>
              <div class="handle-chevron">›</div>
            </div>
            <div class="selector-rows">
              <div class="seg-group" id="seg-joint">
                <button class="seg-btn active" data-joint="knee">Knee</button>
                <button class="seg-btn" data-joint="hip">Hip</button>
                <button class="seg-btn" data-joint="shoulder">Shoulder</button>
                <button class="seg-btn" data-joint="elbow">Elbow</button>
                <button class="seg-btn" data-joint="ankle">Ankle</button>
              </div>
              <div class="seg-group" id="seg-side">
                <button class="seg-btn active" data-side="right">Right</button>
                <button class="seg-btn" data-side="left">Left</button>
              </div>
              <div class="seg-group" id="seg-position">
                <button class="seg-btn active" data-position="prone">Prone</button>
                <button class="seg-btn" data-position="supine">Supine</button>
                <button class="seg-btn" data-position="seated">Seated</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Live angle readout -->
        <div class="angle-panel">
          <div id="angle-display" class="angle-display">--°</div>
          <div id="angle-label" class="angle-label">Right Knee flexion</div>

          <!-- Calibration status pill -->
          <div id="cal-status" class="cal-status"></div>

          <!-- Live ROM bar — visible during recording -->
          <div id="rom-bar" class="rom-bar" style="display:none">
            <div class="rom-bar-labels">
              <span id="rom-min">--°</span>
              <span class="rom-bar-title">ROM: <strong id="rom-value">--°</strong></span>
              <span id="rom-max">--°</span>
            </div>
          </div>
        </div>

        <!-- Camera controls -->
        <div class="controls">
          <button id="btn-start-camera" class="btn-primary">Start Camera</button>
          <button id="btn-stop-camera"  class="btn-ghost" style="display:none">Stop Camera</button>
        </div>

        <!-- Calibration + recording controls — shown when camera running -->
        <div id="active-controls" class="controls" style="display:none">
          <button id="btn-calibrate"    class="btn-calibrate">Set Zero</button>
          <button id="btn-record-start" class="btn-record">● Record</button>
          <button id="btn-record-stop"  class="btn-record-stop" style="display:none">■ Stop & Save</button>
          <button id="btn-history"      class="btn-ghost btn-sm">History</button>
        </div>

        <!-- Notes entry — slides in after Stop & Save -->
        <div id="notes-panel" class="notes-panel" style="display:none">
          <div class="notes-row">
            <input id="notes-input" class="notes-input" type="text"
              placeholder="Add a note… (day 14 post-op, after warm-up)"
              maxlength="200" autocomplete="off" autocorrect="on" />
            <button id="btn-notes-save" class="btn-primary btn-notes-save">Save</button>
            <button id="btn-notes-skip" class="btn-ghost btn-notes-skip">Skip</button>
          </div>
        </div>

        <div id="save-feedback" class="save-feedback" style="display:none">Session saved ✓</div>
        <div id="error-msg"     class="error-msg"     style="display:none"></div>

      </div>

      <style>
        .measure-view {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background: #0a0a0a;
          overflow: hidden;
        }

        .camera-stack {
          position: relative;
          flex: 1;
          background: #111;
          overflow: hidden;
          min-height: 0;
        }

        .camera-video {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          touch-action: none;
        }

        .camera-overlay {
          position: absolute;
          top: 0; left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
        }

        .status-badge {
          position: absolute;
          top: 12px; left: 12px;
          padding: 4px 10px;
          border-radius: 12px;
          font-size: 13px;
          font-weight: 600;
        }
        .patient-chip {
          position: absolute;
          top: 12px; right: 12px;
          display: flex;
          align-items: center;
          gap: 6px;
          max-width: 55%;
          padding: 5px 10px;
          background: rgba(0,0,0,0.55);
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 14px;
          color: #f0f0f0;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .patient-chip:active { background: rgba(255,255,255,0.12); }
        .patient-chip.no-patient { color: #facc15; border-color: rgba(250,204,21,0.4); }

        #patient-chip-label {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .chip-chevron { color: #666; font-size: 14px; line-height: 1; }

        .sync-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          flex-shrink: 0;
          background: #4ade80;
        }
        .sync-dot.pending { background: #facc15; }
        .sync-dot.offline { background: #666; }

        .status-idle      { background: rgba(0,0,0,0.5);       color: #888; }
        .status-running   { background: rgba(74,222,128,0.2);  color: #4ade80; }
        .status-lost      { background: rgba(250,204,21,0.2);  color: #facc15; }
        .status-error     { background: rgba(248,113,113,0.2); color: #f87171; }
        .status-recording { background: rgba(248,113,113,0.3); color: #f87171; }
        .status-cal       { background: rgba(96,165,250,0.3);  color: #60a5fa; }

        /* Calibration progress bar — overlaid on camera */
        .cal-progress {
          position: absolute;
          bottom: 16px;
          left: 50%;
          transform: translateX(-50%);
          width: 200px;
          text-align: center;
        }
        .cal-bar {
          height: 6px;
          background: #1a1a1a;
          border-radius: 3px;
          overflow: hidden;
          margin-bottom: 6px;
        }
        .cal-bar::after {
          content: '';
          display: block;
          height: 100%;
          background: #60a5fa;
          border-radius: 3px;
          width: var(--cal-pct, 0%);
          transition: width 0.1s linear;
        }
        .cal-progress-label {
          font-size: 13px;
          color: #60a5fa;
          font-weight: 600;
        }

        .angle-panel {
          padding: 10px 20px 6px;
          text-align: center;
          background: #111;
          flex-shrink: 0;
        }

        .angle-display {
          font-size: 64px;
          font-weight: 700;
          line-height: 1;
          color: #4ade80;
          font-variant-numeric: tabular-nums;
          letter-spacing: -2px;
        }
        .angle-display.lost      { color: #facc15; }
        .angle-display.recording { color: #f87171; }
        .angle-display.sampling  { color: #60a5fa; }

        .angle-label {
          font-size: 12px;
          color: #666;
          margin-top: 2px;
        }

        /* Calibration status pill under the angle */
        .cal-status {
          display: inline-block;
          margin-top: 4px;
          padding: 2px 10px;
          border-radius: 10px;
          font-size: 12px;
          font-weight: 500;
          min-height: 20px;
        }
        .cal-status.calibrated {
          background: rgba(74,222,128,0.15);
          color: #4ade80;
        }
        .cal-status.uncalibrated {
          background: rgba(250,204,21,0.15);
          color: #facc15;
        }

        .rom-bar {
          margin-top: 8px;
          padding: 6px 0 2px;
          border-top: 1px solid #222;
        }
        .rom-bar-labels {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 13px;
          color: #888;
        }
        .rom-bar-title { color: #f0f0f0; font-size: 14px; }
        .rom-bar-title strong { color: #f87171; }

        .controls {
          padding: 8px 16px;
          display: flex;
          gap: 8px;
          background: #111;
          flex-shrink: 0;
        }
        .controls button { flex: 1; padding: 13px; }

        .btn-calibrate {
          flex: 1 !important;
          background: #1e3a5f;
          color: #60a5fa;
          font-weight: 700;
          border: 1px solid #60a5fa;
          border-radius: 8px;
          font-size: 15px;
          cursor: pointer;
          transition: opacity 0.15s;
        }
        .btn-calibrate:active  { opacity: 0.8; }
        .btn-calibrate:disabled { opacity: 0.35; cursor: not-allowed; }
        .btn-calibrate.sampling {
          background: #60a5fa;
          color: #000;
        }

        .btn-record {
          flex: 2 !important;
          background: #f87171;
          color: #000;
          font-weight: 700;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          cursor: pointer;
          transition: opacity 0.15s;
        }
        .btn-record:active   { opacity: 0.8; }
        .btn-record:disabled { opacity: 0.35; cursor: not-allowed; }

        .btn-record-stop {
          flex: 2 !important;
          background: #333;
          color: #f87171;
          font-weight: 700;
          border: 1px solid #f87171;
          border-radius: 8px;
          font-size: 16px;
          cursor: pointer;
        }
        .btn-record-stop:active { opacity: 0.8; }

        .btn-sm {
          flex: 1 !important;
          font-size: 13px;
          padding: 10px 8px !important;
        }

        .save-feedback {
          text-align: center;
          padding: 8px;
          font-size: 14px;
          color: #4ade80;
          background: rgba(74,222,128,0.08);
          flex-shrink: 0;
        }

        .error-msg {
          margin: 0 16px 8px;
          padding: 10px 12px;
          background: rgba(248,113,113,0.1);
          border: 1px solid rgba(248,113,113,0.3);
          border-radius: 8px;
          color: #f87171;
          font-size: 14px;
          line-height: 1.4;
          flex-shrink: 0;
        }

        .notes-panel {
          background: #111;
          border-top: 1px solid #222;
          padding: 10px 16px;
          flex-shrink: 0;
        }

        .notes-row {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .notes-input {
          flex: 1;
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 8px;
          color: #f0f0f0;
          font-size: 14px;
          padding: 10px 12px;
          font-family: -apple-system, sans-serif;
          outline: none;
          -webkit-appearance: none;
        }

        .notes-input:focus {
          border-color: #4ade80;
        }

        .notes-input::placeholder {
          color: #555;
        }

        .btn-notes-save {
          padding: 10px 16px !important;
          font-size: 14px;
          flex-shrink: 0;
        }

        .btn-notes-skip {
          padding: 10px 12px !important;
          font-size: 14px;
          flex-shrink: 0;
        }

        .selector-drawer {
          position: absolute;
          bottom: 0; left: 0; right: 0;
          background: rgba(10, 10, 10, 0.82);
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          transform: translateY(calc(100% - 36px));
          transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .selector-drawer.open {
          transform: translateY(0);
        }

        .selector-handle {
          height: 36px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          cursor: pointer;
          user-select: none;
        }

        .handle-grip {
          width: 32px;
          height: 3px;
          background: rgba(255, 255, 255, 0.3);
          border-radius: 2px;
        }

        #handle-label {
          font-size: 12px;
          font-weight: 600;
          color: #aaa;
          letter-spacing: 0.02em;
        }

        .handle-chevron {
          font-size: 16px;
          color: #555;
          transform: rotate(-90deg);
          transition: transform 0.25s;
          line-height: 1;
        }

        .selector-drawer.open .handle-chevron {
          transform: rotate(90deg);
        }

        .selector-rows {
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding: 4px 12px 12px;
        }

        .seg-group {
          display: flex;
          gap: 4px;
        }

        .seg-btn {
          flex: 1;
          padding: 5px 3px;
          font-size: 11px;
          font-weight: 600;
          background: rgba(255, 255, 255, 0.07);
          color: #888;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 6px;
          cursor: pointer;
          transition: background 0.15s, color 0.15s;
        }

        .seg-btn.active {
          background: rgba(255, 255, 255, 0.18);
          color: #f0f0f0;
          border-color: rgba(255, 255, 255, 0.3);
        }

        .seg-btn:active { opacity: 0.7; }
      </style>
    `
  }

  // ─── DOM binding ────────────────────────────────────────────────────

  _bindElements() {
    this._video          = document.getElementById('rom-video')
    this._overlayCanvas  = document.getElementById('rom-overlay')
    this._statusBadge    = document.getElementById('status-badge')
    this._angleDisplay   = document.getElementById('angle-display')
    this._calStatus      = document.getElementById('cal-status')
    this._calProgress    = document.getElementById('cal-progress')
    this._calBar         = document.getElementById('cal-bar')
    this._btnStart       = document.getElementById('btn-start-camera')
    this._btnStop        = document.getElementById('btn-stop-camera')
    this._activeControls = document.getElementById('active-controls')
    this._btnCalibrate   = document.getElementById('btn-calibrate')
    this._btnRecordStart = document.getElementById('btn-record-start')
    this._btnRecordStop  = document.getElementById('btn-record-stop')
    this._btnHistory     = document.getElementById('btn-history')
    this._romBar         = document.getElementById('rom-bar')
    this._romMin         = document.getElementById('rom-min')
    this._romMax         = document.getElementById('rom-max')
    this._romValue       = document.getElementById('rom-value')
    this._notesPanel     = document.getElementById('notes-panel')
    this._notesInput     = document.getElementById('notes-input')
    this._btnNotesSave   = document.getElementById('btn-notes-save')
    this._btnNotesSkip   = document.getElementById('btn-notes-skip')
    this._saveFeedback   = document.getElementById('save-feedback')
    this._errorMsg       = document.getElementById('error-msg')
    this._patientChip    = document.getElementById('patient-chip')
    this._patientChipLabel = document.getElementById('patient-chip-label')
    this._syncDot        = document.getElementById('sync-dot')

    this._selectorDrawer = document.getElementById('selector-drawer')
    this._handleLabel    = document.getElementById('handle-label')
    this._segJoint       = document.getElementById('seg-joint')
    this._segSide        = document.getElementById('seg-side')
    this._segPosition    = document.getElementById('seg-position')
    this._angleLabel     = document.getElementById('angle-label')

    this.camera.attach(this._video)
    this.overlay.attach(this._overlayCanvas)
  }

  _bindEvents() {
    this._btnStart.addEventListener('click',       () => this._startCamera())
    this._btnStop.addEventListener('click',        () => this._stopCamera())
    this._btnCalibrate.addEventListener('click',   () => this._handleCalibrateBtn())
    this._btnRecordStart.addEventListener('click', () => this._startRecording())
    this._btnRecordStop.addEventListener('click',  () => this._stopRecording())
    this._btnNotesSave.addEventListener('click', () => this._saveWithNote())
    this._btnNotesSkip.addEventListener('click', () => this._saveWithNote(''))
    this._notesInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._saveWithNote()
    })
    this._btnHistory.addEventListener('click',     () => {
      if (this.recorder.isActive) this._stopRecording()
      this._stopCamera()
      this.onShowHistory()
    })
    this._patientChip.addEventListener('click', () => {
      if (this.recorder.isActive) this._stopRecording()
      this._stopCamera()
      this.onShowPatients()
    })

    document.getElementById('selector-handle').addEventListener('click', () => this._toggleDrawer())

    this._overlayCanvas.closest('.camera-stack').addEventListener('click', (e) => {
      if (this._drawerOpen && !e.target.closest('#selector-drawer')) {
        this._closeDrawer()
      }
    })

    this._segJoint.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-joint]')
      if (btn) this._selectJoint(btn.dataset.joint)
    })
    this._segSide.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-side]')
      if (btn) this._selectSide(btn.dataset.side)
    })
    this._segPosition.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-position]')
      if (btn) this._selectPosition(btn.dataset.position)
    })
  }

  // ─── Camera lifecycle ────────────────────────────────────────────────

  async _startCamera() {
    this._btnStart.disabled = true
    this._hideError()
    this._setStatus('idle', 'Starting…')

    try {
      const { width, height } = await this.camera.start()
      this.overlay.resize(width, height)

      this._setStatus('idle', 'Loading AI model…')
      await this.detector.init()

      this._btnStart.style.display          = 'none'
      this._btnStop.style.display           = 'block'
      this._activeControls.style.display    = 'flex'
      this._selectorDrawer.style.display    = 'block'
      this._updatePositionVisibility()
      this._setStatus('running', 'Detecting pose…')
      this._startLoop()
    } catch (err) {
      this._showError(err.message)
      this._setStatus('error', 'Error')
      this._btnStart.disabled = false
    }
  }

  _stopCamera() {
    if (this.recorder.isActive)    this.recorder.stop()
    if (this.calibration.isSampling) this.calibration.cancel()

    this._stopLoop()
    this.camera.stop()
    this.overlay.clear()
    this.median.reset()
    this.euro.reset()

    this._btnStop.style.display           = 'none'
    this._btnStart.style.display          = 'block'
    this._btnStart.disabled               = false
    this._activeControls.style.display    = 'none'
    this._closeDrawer()
    this._selectorDrawer.style.display    = 'none'
    this._romBar.style.display          = 'none'
    this._calProgress.style.display     = 'none'
    this._angleDisplay.className        = 'angle-display'
    this._setStatus('idle', 'Tap to start')
    this._updateAngleDisplay(null)
  }

  // ─── Calibration ─────────────────────────────────────────────────────

  _handleCalibrateBtn() {
    if (this.calibration.isSampling) {
      // Cancel in-progress calibration
      this.calibration.cancel()
      this._endCalibrationUI()
      return
    }

    if (this.recorder.isActive) return  // can't calibrate while recording

    this._beginCalibrationUI()
    this.calibration.startSampling((offset) => {
      this._endCalibrationUI()
      this._updateCalibrationUI()
      this._showSaveFeedback(`Zeroed at ${offset.toFixed(1)}° ✓`)
    })
  }

  _beginCalibrationUI() {
    this._btnCalibrate.textContent = 'Cancel'
    this._btnCalibrate.classList.add('sampling')
    this._btnRecordStart.disabled = true
    this._calProgress.style.display = 'block'
    this._angleDisplay.classList.add('sampling')
    this._setStatus('cal', 'Hold still…')
  }

  _endCalibrationUI() {
    this._btnCalibrate.textContent = 'Set Zero'
    this._btnCalibrate.classList.remove('sampling')
    this._btnRecordStart.disabled = false
    this._calProgress.style.display = 'none'
    this._angleDisplay.classList.remove('sampling')
    this._setStatus('running', 'Detecting pose…')
  }

  _updateCalibrationUI() {
    if (this.calibration.isCalibrated) {
      this._calStatus.className   = 'cal-status calibrated'
      this._calStatus.textContent = `Zeroed at ${this.calibration.offset.toFixed(1)}°`
    } else {
      this._calStatus.className   = 'cal-status uncalibrated'
      this._calStatus.textContent = 'Not zeroed — tap Set Zero'
    }
  }

  _updateCalProgressBar() {
    const pct = (this.calibration.sampleProgress / this.calibration.sampleTarget) * 100
    this._calBar.style.setProperty('--cal-pct', `${pct}%`)
  }

  // ─── Recording lifecycle ─────────────────────────────────────────────

  _startRecording() {
    // Recording is blocked (not just saving) so a finished measurement can
    // never be lost navigating away to pick a patient afterwards.
    if (!getActivePatientId()) {
      this._showError('Select a patient before recording — tap the patient chip at the top right.')
      return
    }
    this._hideError()
    this.recorder.setContext(this._joint, this._side, this._position)
    this.recorder.start()
    this._maxAngle    = -Infinity
    this._minAngle    = Infinity
    this._maxHasFrame = false
    this._minHasFrame = false
    this._btnRecordStart.style.display = 'none'
    this._btnRecordStop.style.display  = 'block'
    this._btnCalibrate.disabled        = true
    this._romBar.style.display         = 'block'
    this._angleDisplay.classList.add('recording')
    this._hideSaveFeedback()
    this._setStatus('recording', '● Recording')
  }

  _stopRecording() {
    const session = this.recorder.stop()

    this._btnRecordStop.style.display  = 'none'
    this._btnRecordStart.style.display = 'block'
    this._btnCalibrate.disabled        = false
    this._angleDisplay.classList.remove('recording')
    this._setStatus('running', 'Detecting pose…')

    if (!session) {
      this._showError('No angle data recorded — make sure the selected joint is clearly visible.')
      return
    }

    // Encode once here rather than on every new extreme during the sweep.
    SessionRecorder.attachFrames(session, {
      maxFrame: this._maxHasFrame ? this._encodeCapture('max') : null,
      minFrame: this._minHasFrame ? this._encodeCapture('min') : null,
    })
    this._maxHasFrame = false
    this._minHasFrame = false

    // Hold the session, show notes panel
    this._pendingSession = session
    this._showNotesPanel()
  }

  _showNotesPanel() {
    this._notesInput.value        = ''
    this._notesPanel.style.display = 'block'
    // Small delay so the keyboard doesn't open immediately on mobile
    setTimeout(() => this._notesInput.focus(), 300)
  }

  _hideNotesPanel() {
    this._notesPanel.style.display = 'none'
    this._notesInput.value         = ''
    this._notesInput.blur()
  }

  _saveWithNote(forceNote) {
    const note    = forceNote !== undefined ? forceNote : this._notesInput.value
    const session = SessionRecorder.attachNotes(this._pendingSession, note)
    this._pendingSession = null
    this._hideNotesPanel()

    if (!session) return

    session.patient_id = getActivePatientId()
    const saved = saveSession(session)
    if (saved) {
      this._showSaveFeedback('Session saved ✓')
    } else {
      this._showError('Could not save — storage may be full.')
    }
  }

  // ─── Detection loop ──────────────────────────────────────────────────

  _startLoop() {
    this._loopActive    = true
    this._lastDetection = 0
    this._tick()
  }

  _stopLoop() {
    this._loopActive = false
    if (this._rafId) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
    }
  }

  _tick() {
    if (!this._loopActive) return
    this._rafId = requestAnimationFrame((timestamp) => {
      if (!this._loopActive) return
      if (timestamp - this._lastDetection >= DETECTION_INTERVAL_MS) {
        this._lastDetection = timestamp
        this._runDetection()
      }
      this._tick()
    })
  }

  _runDetection() {
    const videoEl = this.camera.videoEl
    if (!videoEl || !this.detector.isReady) return

    const { markers, allFound } = this.detector.detect(videoEl)

    // ── Angle calculation ──────────────────────────────────────────
    let rawFlexion  = null
    let smoothAngle = null
    let displayAngle = null

    if (allFound) {
      // Prefer 3D world landmarks (perspective-independent); fall back to the
      // 2D points if a frame lacks world data so a bad frame degrades, not drops.
      const points = this.detector.getJointPoints3D(markers)
                  ?? this.detector.getJointPoints(markers)
      if (points) {
        const interior = jointAngle(points.proximal, points.joint, points.distal)
        if (interior !== null) {
          rawFlexion = toFlexionAngle(interior)
        }
      }
    }

    // Median (spike rejection) → One Euro (adaptive smoothing) → calibrate.
    // This produces the ONE value used for the readout, the overlay, the peak
    // snapshot and the recorder — they must never disagree, or the patient
    // record ends up holding two different numbers for the same measurement.
    smoothAngle  = this.median.push(rawFlexion)
    smoothAngle  = this.euro.push(smoothAngle, performance.now())
    displayAngle = this.calibration.apply(smoothAngle)
    this.currentAngle = displayAngle

    // ── Feed calibration sampler ───────────────────────────────────
    if (this.calibration.isSampling) {
      this.calibration.addSample(smoothAngle)  // raw flexion, pre-calibration
      this._updateCalProgressBar()
    }

    // ── Feed session recorder (calibrated angles) ──────────────────
    if (this.recorder.isActive) {
      this.recorder.record(displayAngle)
      this._updateRomBar()
      if (displayAngle !== null) {
        // Snapshot both extremes: max flexion (most bent) and min flexion
        // (straightest). Extension tests peak at the minimum, not the maximum.
        if (displayAngle > this._maxAngle) {
          this._maxAngle    = displayAngle
          this._maxHasFrame = this._captureFrameTo('max') || this._maxHasFrame
        }
        if (displayAngle < this._minAngle) {
          this._minAngle    = displayAngle
          this._minHasFrame = this._captureFrameTo('min') || this._minHasFrame
        }
      }
    }

    // ── Overlay ────────────────────────────────────────────────────
    // The overlay label must show the same smoothed + calibrated value as
    // the readout below the camera; it un-inverts internally (180 - x).
    const videoDims = this.camera.getDimensions()
    this.overlay.resize(videoDims.width, videoDims.height)
    this.overlay.draw(markers, displayAngle !== null ? 180 - displayAngle : null, { joint: this._joint })

    // ── UI ─────────────────────────────────────────────────────────
    this._updateAngleDisplay(displayAngle)
    this._updateStatus(allFound, Object.keys(markers).length)
  }

  // ─── UI updates ──────────────────────────────────────────────────────

  _updateAngleDisplay(angle) {
    if (angle === null || angle === undefined) {
      this._angleDisplay.textContent = '--°'
      this._angleDisplay.classList.add('lost')
    } else {
      this._angleDisplay.textContent = `${Math.round(angle)}°`
      this._angleDisplay.classList.remove('lost')
    }
  }

  /**
   * Composite the current video frame + overlay into the retained canvas for
   * `which` ('max' or 'min'), overwriting whatever extreme was held before.
   *
   * Only the pixels are kept here — JPEG encoding happens once at stop().
   * A sweep produces many successive new extremes, and encoding each one
   * would stall the detection loop for no benefit since all but the last
   * are discarded.
   *
   * @param {'max'|'min'} which
   * @returns {boolean} whether a frame was captured (non-critical if not)
   */
  _captureFrameTo(which) {
    try {
      const overlayCanvas = this._overlayCanvas
      const videoEl = this.camera.videoEl
      if (!overlayCanvas || !videoEl) return false

      const w = overlayCanvas.width
      const h = overlayCanvas.height
      const key = which === 'max' ? '_maxCanvas' : '_minCanvas'
      if (!this[key]) this[key] = document.createElement('canvas')
      const offscreen = this[key]
      offscreen.width  = w
      offscreen.height = h
      const ctx = offscreen.getContext('2d')

      // Draw video frame scaled to match the object-fit:cover transform
      const o = this.overlay
      const dpr = window.devicePixelRatio || 1
      ctx.save()
      ctx.scale(dpr, dpr)
      ctx.drawImage(
        videoEl,
        o._offsetX, o._offsetY,
        videoEl.videoWidth * o._scale,
        videoEl.videoHeight * o._scale
      )
      ctx.restore()

      // Draw overlay (landmarks + arc) on top
      ctx.drawImage(overlayCanvas, 0, 0)

      return true
    } catch (_) {
      // Non-critical — silently skip if capture fails
      return false
    }
  }

  /**
   * Encode a retained extreme-frame canvas to a JPEG data URL.
   * @param {'max'|'min'} which
   * @returns {string|null}
   */
  _encodeCapture(which) {
    try {
      const canvas = which === 'max' ? this._maxCanvas : this._minCanvas
      return canvas ? canvas.toDataURL('image/jpeg', 0.82) : null
    } catch (_) {
      return null
    }
  }

  _updateRomBar() {
    const stats = this.recorder.getLiveStats()
    if (!stats) return
    this._romMin.textContent   = `${Math.round(stats.min)}°`
    this._romMax.textContent   = `${Math.round(stats.max)}°`
    this._romValue.textContent = `${Math.round(stats.rom)}°`
  }

  _updateStatus(allFound, foundCount) {
    if (this.calibration.isSampling) return  // status managed by calibration UI
    if (this.recorder.isActive) {
      this._setStatus('recording', `● ${this.recorder.sampleCount} samples`)
      return
    }
    if (allFound)             this._setStatus('running',  'Pose detected')
    else if (foundCount > 0)  this._setStatus('lost',     `${foundCount}/3 landmarks`)
    else                      this._setStatus('lost',     'No pose detected')
  }

  _setStatus(type, text) {
    this._statusBadge.className   = `status-badge status-${type}`
    this._statusBadge.textContent = text
  }

  _showSaveFeedback(msg) {
    this._saveFeedback.textContent   = msg
    this._saveFeedback.style.display = 'block'
    setTimeout(() => this._hideSaveFeedback(), 2500)
  }

  _hideSaveFeedback() {
    this._saveFeedback.style.display = 'none'
  }

  _showError(msg) {
    this._errorMsg.textContent   = msg
    this._errorMsg.style.display = 'block'
  }

  _hideError() {
    this._errorMsg.style.display = 'none'
  }

  // ─── Patient chip + sync indicator ───────────────────────────────────

  _updatePatientChip() {
    const patient = getPatient(getActivePatientId())
    if (patient) {
      this._patientChipLabel.textContent = patient.name
      this._patientChip.classList.remove('no-patient')
    } else {
      this._patientChipLabel.textContent = 'Select patient'
      this._patientChip.classList.add('no-patient')
    }
  }

  _updateSyncDot(status) {
    this._syncDot.style.display = 'inline-block'
    this._syncDot.className = 'sync-dot' +
      (status.state === 'pending' ? ' pending' : status.state === 'offline' ? ' offline' : '')
    this._syncDot.title = status.state === 'pending'
      ? `${status.pendingCount} change(s) waiting to sync`
      : status.state
  }

  // ─── Drawer ──────────────────────────────────────────────────────────

  _toggleDrawer() {
    this._drawerOpen ? this._closeDrawer() : this._openDrawer()
  }

  _openDrawer() {
    this._drawerOpen = true
    this._selectorDrawer.classList.add('open')
  }

  _closeDrawer() {
    this._drawerOpen = false
    this._selectorDrawer.classList.remove('open')
  }

  // ─── Joint / side / position selection ───────────────────────────────

  _selectJoint(joint) {
    this._joint = joint
    this.detector.setJoint(joint)
    this._segJoint.querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.joint === joint)
    })
    // Reset to the clinically typical position for each joint
    const defaultPosition = { knee: 'prone', hip: 'supine' }
    if (defaultPosition[joint]) this._selectPosition(defaultPosition[joint])
    this._updateSelectionLabel()
    this._updatePositionVisibility()
    this.calibration.clear()
    this._updateCalibrationUI()
  }

  _selectSide(side) {
    this._side = side
    this.detector.setSide(side)
    this._segSide.querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.side === side)
    })
    this._updateSelectionLabel()
    this.calibration.clear()
    this._updateCalibrationUI()
  }

  _selectPosition(position) {
    this._position = position
    this._segPosition.querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.position === position)
    })
    this._updateSelectionLabel()
  }

  _updateSelectionLabel() {
    const jointNames   = { knee: 'Knee', hip: 'Hip', shoulder: 'Shoulder', elbow: 'Elbow', ankle: 'Ankle' }
    const posNames     = { prone: 'Prone', supine: 'Supine', seated: 'Seated' }
    const side         = this._side.charAt(0).toUpperCase() + this._side.slice(1)
    const usesPosition = this._joint === 'knee' || this._joint === 'hip'
    this._angleLabel.textContent  = `${side} ${jointNames[this._joint]} flexion`
    this._handleLabel.textContent = usesPosition
      ? `${side} ${jointNames[this._joint]} · ${posNames[this._position]}`
      : `${side} ${jointNames[this._joint]}`
  }

  _updatePositionVisibility() {
    const usesPosition = this._joint === 'knee' || this._joint === 'hip'
    this._segPosition.style.display = usesPosition ? 'flex' : 'none'
  }
}
