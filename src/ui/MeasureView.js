/**
 * MeasureView.js — Milestone 2 + Calibration
 */

import { Camera }            from '../detection/camera.js'
import { PoseDetector }      from '../detection/pose.js'
import { Overlay }           from '../detection/overlay.js'
import { jointAngle, toClinicalAngle, toInteriorAngle, motionTerms, MedianFilter3, OneEuroFilter } from '../core/angle.js'
import { JOINT_NAMES, POSITION_NAMES, positionsFor, sideLabel } from '../core/labels.js'
import { SessionRecorder }   from '../core/session.js'
import { saveSession, getActivePatientId, getPatient, enqueueImageUpload } from '../core/storage.js'
import { CalibrationManager } from '../core/calibration.js'
import { isConfigured }      from '../core/supabase.js'
import { normalizeSet }      from '../core/landmarks.js'
import { MODEL_ID, MODEL_VERSION } from '../detection/pose.js'
import { getStatus, onSyncStatus } from '../core/sync.js'
import { putImage, usage, BUDGET_BYTES } from '../core/imageStore.js'

const DETECTION_HZ          = 10
const DETECTION_INTERVAL_MS = 1000 / DETECTION_HZ

// Snapshot encoding. Capture retains full retina-density pixels during the
// sweep; we downscale ONLY at encode time. Dimension is the primary lever —
// it shrinks the file without the JPEG ringing that low quality inflicts on
// the overlay's thin lines and angle text. ~1 MB retina JPEG → ~120-180 KB.
const SNAPSHOT_MAX_EDGE = 1100   // px, longest edge
const SNAPSHOT_QUALITY  = 0.78

// Off-axis caution thresholds, in degrees of segment tilt out of the image
// plane. WARN is where the signal first clears its own noise: at 20° a segment
// projects only 6% short, which is inside the drift of the world landmarks the
// tilt is derived from. CLEAR is lower so the caution does not strobe.
const PLANE_TILT_WARN_DEG  = 25
const PLANE_TILT_CLEAR_DEG = 20

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
    // NOT defaulted to the first valid position. Auto-selecting one writes a
    // clinical claim nobody made into the patient record — a standing elbow
    // measurement saved as "Seated", the same failure the prone-shoulder fix
    // addressed from the other direction. SessionRecorder.setContext() already
    // keeps an absent position null; the UI has to actually give it one.
    this._position      = null
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
    this._updateStorageGauge()
    if (isConfigured()) {
      this._updateSyncDot(getStatus())
      this._unsubSync = onSyncStatus((status) => {
        this._updateSyncDot(status)
        this._updateStorageGauge()
      })
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

          <!-- Off-axis caution. Deliberately wordy and deliberately numberless:
               the tilt it is derived from is coarse (see PoseDetector.segmentTilt),
               so it can say "reposition" honestly but must not quote a figure. -->
          <div id="plane-warning" class="plane-warning" style="display:none">
            ⚠ Limb is angled toward the camera — move so the movement is side-on
          </div>

          <!-- Calibration sampling progress — shown during 2s capture -->
          <div id="cal-progress" class="cal-progress" style="display:none">
            <div id="cal-bar" class="cal-bar"></div>
            <div class="cal-progress-label">Hold still…</div>
          </div>

          <!-- Collapsible selector drawer — peeks as a handle, slides up on tap -->
          <div id="selector-drawer" class="selector-drawer" style="display:none">
            <div id="selector-handle" class="selector-handle">
              <div class="handle-grip"></div>
              <!-- Placeholder only; _updateSelectionLabel() overwrites it as
                   soon as the drawer is shown. Names no position on purpose. -->
              <span id="handle-label">Right Knee</span>
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
              <!-- Rebuilt per joint by _renderPositions() -->
              <div class="seg-group" id="seg-position"></div>
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
              <span class="rom-end"><span id="rom-min">--°</span><em id="rom-min-term">extension</em></span>
              <span class="rom-bar-title">ROM: <strong id="rom-value">--°</strong></span>
              <span class="rom-end rom-end-right"><span id="rom-max">--°</span><em id="rom-max-term">flexion</em></span>
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

        <!-- Local snapshot-cache gauge: fills as IndexedDB fills; shows how many
             images still await cloud upload. Amber ≥80%, red ≥95% of budget. -->
        <div id="storage-gauge" class="storage-gauge" style="display:none">
          <div class="gauge-track"><div id="gauge-fill" class="gauge-fill"></div></div>
          <span id="gauge-label" class="gauge-label"></span>
        </div>

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

        .plane-warning {
          position: absolute;
          left: 12px;
          right: 12px;
          bottom: 96px;
          padding: 9px 12px;
          border-radius: 10px;
          background: rgba(120, 53, 15, 0.92);
          border: 1px solid #f59e0b;
          color: #fde68a;
          font-size: 13px;
          line-height: 1.35;
          text-align: center;
          pointer-events: none;
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

        .storage-gauge {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 6px 12px 0;
        }
        .gauge-track {
          flex: 1;
          height: 4px;
          border-radius: 2px;
          background: #2a2a2a;
          overflow: hidden;
        }
        .gauge-fill {
          height: 100%;
          width: 0%;
          background: #4ade80;
          transition: width 0.3s ease, background 0.3s ease;
        }
        .storage-gauge.warn .gauge-fill { background: #facc15; }
        .storage-gauge.crit .gauge-fill { background: #f87171; }
        .gauge-label {
          color: #888;
          font-size: 11px;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .storage-gauge.warn .gauge-label { color: #facc15; }
        .storage-gauge.crit .gauge-label { color: #f87171; }

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
        /* Each end of the bar names its own motion, so the two bare numbers
           can't be read the wrong way round. */
        .rom-end { display: flex; flex-direction: column; line-height: 1.2; }
        .rom-end-right { text-align: right; }
        .rom-end em {
          font-style: normal;
          font-size: 10px;
          color: #666;
          text-transform: lowercase;
        }

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
    this._romMinTerm     = document.getElementById('rom-min-term')
    this._romMaxTerm     = document.getElementById('rom-max-term')
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
    this._storageGauge   = document.getElementById('storage-gauge')
    this._planeWarning   = document.getElementById('plane-warning')
    this._gaugeFill      = document.getElementById('gauge-fill')
    this._gaugeLabel     = document.getElementById('gauge-label')

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
      this._renderPositions(this._joint)
      // Must follow _renderPositions: until this runs the handle still shows
      // the static placeholder from the template, which named a position
      // ("Prone") that _position does not hold. That is the same false claim
      // the auto-select fix exists to remove, just rendered instead of saved.
      this._updateSelectionLabel()
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
    // Stamp the calibration state onto the session. Safe to read at start
    // rather than stop: _btnCalibrate is disabled for the whole recording
    // (below), so the offset cannot move mid-session.
    this.recorder.setCalibration(this.calibration.offset, this.calibration.isCalibrated)
    this.recorder.setModel(MODEL_ID, MODEL_VERSION)
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

    // Hold the session (with its retained extreme-frame canvases) until the
    // note is entered; frames are encoded + stored in _saveWithNote so the
    // session exists in storage before its image-upload ops are queued.
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

  async _saveWithNote(forceNote) {
    const note    = forceNote !== undefined ? forceNote : this._notesInput.value
    const session = SessionRecorder.attachNotes(this._pendingSession, note)
    this._pendingSession = null
    this._hideNotesPanel()

    if (!session) return

    session.patient_id = getActivePatientId()
    const saved = saveSession(session)
    if (saved) {
      // Persist snapshot blobs to IndexedDB and queue them for cloud upload.
      // The session numbers are already saved — image persistence is best-effort
      // and must not turn a successful measurement into a failure.
      await this._persistFrames(session.id)
      this._showSaveFeedback('Session saved ✓')
      this._updateStorageGauge()
    } else {
      this._showError('Could not save — storage may be full.')
    }
    this._maxHasFrame = false
    this._minHasFrame = false
  }

  /**
   * Encode both retained extreme-frame canvases to lightweight JPEG blobs,
   * store them in imageStore (IndexedDB), and enqueue a cloud upload for each.
   * @param {string} sessionId
   */
  async _persistFrames(sessionId) {
    // Canvas key ('max'/'min') → image key ('peak'/'min'). peakFrame is the
    // max-flexion pose, keeping the legacy naming from the session record.
    for (const [canvasWhich, imageWhich, has] of [
      ['max', 'peak', this._maxHasFrame],
      ['min', 'min',  this._minHasFrame],
    ]) {
      if (!has) continue
      try {
        const blob = await this._encodeCapture(canvasWhich)
        if (blob && await putImage(sessionId, imageWhich, blob)) {
          enqueueImageUpload(sessionId, imageWhich)
        }
      } catch (e) {
        console.error(`Failed to persist ${imageWhich} frame:`, e)
      }
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
    if (!videoEl.videoWidth || !videoEl.videoHeight) return  // no frame yet

    // Grab the video frame ONCE into a reusable offscreen canvas, then feed
    // that SAME canvas to detection and to the retained snapshot below.
    // `videoEl` is a live element: two separate `drawImage(videoEl, ...)` reads
    // in one tick — one for detection, one after it for the capture — can each
    // see a different decoded frame. The angle is computed from the landmarks
    // detection saw; if the snapshot pixels come from a later frame, the number
    // burned into the stored image describes a frame it does not depict. One
    // buffer makes analysis and stored photo the same pixels by construction.
    if (!this._frameCanvas) this._frameCanvas = document.createElement('canvas')
    const frame = this._frameCanvas
    if (frame.width !== videoEl.videoWidth || frame.height !== videoEl.videoHeight) {
      // Assigning .width/.height clears the canvas — only do it on an actual
      // resolution change, not every tick.
      frame.width  = videoEl.videoWidth
      frame.height = videoEl.videoHeight
    }
    frame.getContext('2d').drawImage(videoEl, 0, 0, frame.width, frame.height)

    const { markers, allFound } = this.detector.detect(frame)

    // ── Angle calculation ──────────────────────────────────────────
    let rawFlexion  = null
    let smoothAngle = null
    let displayAngle = null

    if (allFound) {
      // MEASURED FROM THE 2D IMAGE POINTS, NOT THE 3D WORLD LANDMARKS.
      //
      // The 3D path was adopted to defeat perspective foreshortening, and it
      // does — but it pays for that with a monocular depth estimate that is not
      // metrically self-consistent. Measured on a right-elbow session (see
      // CLAUDE.md), rigid bone lengths drift ~8% RMS between two frames of the
      // same person, and the resulting angle error REVERSES SIGN across the
      // range: +13.5 deg at the extension end, -18.4 deg at peak flexion. It
      // read a 140 deg elbow as 115.4 deg and understated total ROM by 21%.
      // The 2D points came within 3% of the same session's measured ROM.
      //
      // A sign-reversing error is also the one shape CalibrationManager.apply()
      // — a single subtraction — provably cannot correct, which is why Set Zero
      // is not offered as the cure.
      //
      // The cost of this choice is real: 2D is only the joint angle while the
      // limb moves parallel to the image plane. That is what segmentTilt()
      // below watches for, and it is not optional cover — it is the other half
      // of this decision.
      const points = this.detector.getJointPoints(markers)
      if (points) {
        const interior = jointAngle(points.proximal, points.joint, points.distal)
        if (interior !== null) {
          // Per-joint convention: the shoulder's neutral interior angle is ~0°
          // and the ankle's is 90°, so a single `180 - interior` rule inverts
          // the shoulder scale and offsets the ankle. See angle.js.
          rawFlexion = toClinicalAngle(interior, this._joint)
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

    // ── Out-of-plane guard ─────────────────────────────────────────
    // The measured angle above comes from the 2D image points, which equal the
    // joint angle only while the limb moves parallel to the image plane. This
    // is the check that the assumption holds. It uses the world landmarks —
    // the ones we no longer trust for the ANGLE — because a coarse tilt is all
    // that is needed to catch gross off-axis filming, and comparing a segment's
    // projection against its own 3D length needs no ground truth.
    const tilt = allFound ? this.detector.segmentTilt(markers) : null
    this._updatePlaneWarning(tilt)

    // ── Feed session recorder (calibrated angles) ──────────────────
    if (this.recorder.isActive) {
      this.recorder.record(displayAngle)
      // Worst excursion over the whole bout, so the saved session can say the
      // camera was off-axis even though the caution has long since cleared.
      if (tilt !== null) this.recorder.recordTilt(tilt)
      this._updateRomBar()
    }

    // ── Overlay ────────────────────────────────────────────────────
    // The arc is drawn from the geometric angle, but the LABEL must be the
    // exact value the readout shows — passed through explicitly rather than
    // re-derived, so the two can never disagree. Converting back via
    // toInteriorAngle keeps the arc on the smoothed value instead of the raw
    // landmarks, which would visibly jitter against a calm readout.
    const videoDims = this.camera.getDimensions()
    this.overlay.resize(videoDims.width, videoDims.height)
    this.overlay.draw(markers, toInteriorAngle(displayAngle, this._joint), {
      joint:      this._joint,
      labelAngle: displayAngle,
    })

    // ── Extreme snapshots ──────────────────────────────────────────
    // THIS USED TO HAVE TO RUN AFTER overlay.draw(), and the reason is worth
    // keeping: the snapshot composited the overlay canvas, so capturing first
    // burned in the PREVIOUS frame's angle — which put a number from the
    // opposite end of the range onto the peak-extension image. That was
    // expensive to find.
    //
    // The constraint is gone because the composite is gone. Snapshots now store
    // the CLEAN frame plus the landmarks, and the overlay is drawn at view time
    // from the saved record (core/frameRender.js). There is no longer a label
    // baked into the pixels that could be a frame out of date — which is why
    // this strengthens "one value, everywhere" rather than relaxing it.
    //
    // What HAS NOT changed: the pixels must still come from this tick's frame
    // buffer, never a fresh read of the live video element. See the frame-grab
    // comment at the top of this method.
    if (this.recorder.isActive && displayAngle !== null) {
      // Snapshot both extremes: max flexion (most bent) and min flexion
      // (straightest). Extension tests peak at the minimum, not the maximum.
      if (displayAngle > this._maxAngle) {
        this._maxAngle    = displayAngle
        this._maxHasFrame = this._captureFrameTo('max', markers, rawFlexion, tilt) || this._maxHasFrame
      }
      if (displayAngle < this._minAngle) {
        this._minAngle    = displayAngle
        this._minHasFrame = this._captureFrameTo('min', markers, rawFlexion, tilt) || this._minHasFrame
      }
    }

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
   * Retain the current video frame — CLEAN, with no overlay composited — as the
   * snapshot for `which` ('max' or 'min'), together with the landmarks and the
   * raw evidence for that frame. Overwrites whatever extreme was held before.
   *
   * WHY THE OVERLAY IS NOT DRAWN IN. A baked composite leaves no clean frame
   * anywhere, so a clinician dragging a landmark later would see the new
   * skeleton over the old one with a stale number printed beside the new one.
   * The overlay is drawn at view time instead (core/frameRender.js), from the
   * saved record — so the label can never fall out of step with the number the
   * record reports.
   *
   * This also does strictly LESS work per capture than the composite did: no
   * object-fit:cover transform, no devicePixelRatio scaling, no second
   * drawImage. And because the stored coordinates are fractions of this buffer,
   * none of that display geometry has to be reconstructed later to use them.
   *
   * Only the pixels are kept here — JPEG encoding happens once at stop().
   * A sweep produces many successive new extremes, and encoding each one
   * would stall the detection loop for no benefit since all but the last
   * are discarded.
   *
   * @param {'max'|'min'} which
   * @param {object} markers      - this tick's markers, in video pixel space
   * @param {number|null} rawAngle - UNFILTERED angle from those landmarks
   * @param {number|null} tilt     - this frame's out-of-plane tilt
   * @returns {boolean} whether a frame was captured (non-critical if not)
   */
  _captureFrameTo(which, markers, rawAngle, tilt) {
    try {
      // Same frame-buffer canvas that fed detect() this tick — not a fresh read
      // of the live video element. See the frame-grab comment at the top of
      // _runDetection().
      const frame = this._frameCanvas
      if (!frame || !frame.width || !frame.height) return false

      const key = which === 'max' ? '_maxCanvas' : '_minCanvas'
      if (!this[key]) this[key] = document.createElement('canvas')
      const offscreen = this[key]
      if (offscreen.width !== frame.width || offscreen.height !== frame.height) {
        // Assigning .width/.height clears the canvas — only on a real change.
        offscreen.width  = frame.width
        offscreen.height = frame.height
      }
      // The video frame is opaque and covers the canvas, so this fully replaces
      // the previous extreme rather than compositing over it.
      offscreen.getContext('2d').drawImage(frame, 0, 0)

      // Coordinates are fractions of THIS buffer, so they survive the
      // SNAPSHOT_MAX_EDGE downscale at encode time and any later re-encode.
      this.recorder.setExtremeEvidence(which, {
        set:      normalizeSet(markers, frame.width, frame.height, this._joint, this._side),
        rawAngle,
        tilt,
      })

      return true
    } catch (_) {
      // Non-critical — silently skip if capture fails
      return false
    }
  }

  /**
   * Encode a retained extreme-frame canvas to a lightweight JPEG Blob,
   * downscaling so the longest edge is ≤ SNAPSHOT_MAX_EDGE. Async because
   * `toBlob` is — and a Blob is ~33% smaller than the old base64 data URL.
   *
   * @param {'max'|'min'} which
   * @returns {Promise<Blob|null>}
   */
  _encodeCapture(which) {
    return new Promise((resolve) => {
      try {
        const src = which === 'max' ? this._maxCanvas : this._minCanvas
        if (!src || !src.width || !src.height) return resolve(null)

        const longest = Math.max(src.width, src.height)
        const scale   = Math.min(1, SNAPSHOT_MAX_EDGE / longest)

        let canvas = src
        if (scale < 1) {
          canvas = document.createElement('canvas')
          canvas.width  = Math.round(src.width  * scale)
          canvas.height = Math.round(src.height * scale)
          canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height)
        }
        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', SNAPSHOT_QUALITY)
      } catch (_) {
        resolve(null)
      }
    })
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

  /**
   * Refresh the local snapshot-cache gauge from imageStore usage. Cheap and
   * async; called on mount, after each save, and whenever sync status changes
   * (an upload completing drops the pending count and frees cache).
   */
  /**
   * Show or hide the off-axis caution.
   *
   * THRESHOLD, and why it is not lower: below about 20° the projected
   * shortening is under 6%, which is smaller than the landmark placement noise
   * the tilt is computed from, so a lower threshold would fire on nothing. 25°
   * is the first point where the signal clears its own noise floor.
   *
   * Hysteresis on the CLEAR edge only. Tilt hovers around the threshold when a
   * limb sits near it, and a caution that strobes reads as a glitch and gets
   * ignored — which is the one outcome that makes it worthless. Note this
   * stabilises the RENDERING, never the measured value; the same rule the
   * angle chain follows.
   */
  _updatePlaneWarning(tilt) {
    if (!this._planeWarning) return
    if (tilt === null) return                       // no world data this frame; leave as-is
    const shown = this._planeWarning.style.display !== 'none'
    const on    = shown ? tilt > PLANE_TILT_CLEAR_DEG : tilt > PLANE_TILT_WARN_DEG
    this._planeWarning.style.display = on ? 'block' : 'none'
  }

  async _updateStorageGauge() {
    if (!this._storageGauge) return
    const u   = await usage()
    const pct = BUDGET_BYTES > 0 ? Math.min(100, Math.round((u.bytes / BUDGET_BYTES) * 100)) : 0

    this._gaugeFill.style.width = pct + '%'
    this._storageGauge.classList.toggle('warn', pct >= 80 && pct < 95)
    this._storageGauge.classList.toggle('crit', pct >= 95)

    // pendingCount = un-uploaded blobs (the only local copy) — the real backlog.
    const cloud = (isConfigured() && u.pendingCount > 0) ? ` · ☁ ${u.pendingCount} to upload` : ''
    this._gaugeLabel.textContent = `Cache ${pct}%${cloud}`

    // Only surface the gauge once there's something cached, to avoid clutter.
    this._storageGauge.style.display = u.count > 0 ? 'flex' : 'none'
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
    // Offer this joint's positions with NONE selected. Carrying the previous
    // joint's position over is how a shoulder ended up recorded as "prone";
    // auto-selecting the first one is how a standing elbow ended up recorded
    // as "seated". Both write a position the clinician never chose, and the
    // record cannot tell that apart from one they did.
    this._renderPositions(joint)
    this._selectPosition(null)
    this._updateSelectionLabel()
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

  /** Rebuild the position row for `joint`. The click handler is delegated on
   *  #seg-position, so replacing the buttons needs no rebinding. */
  _renderPositions(joint) {
    this._segPosition.innerHTML = positionsFor(joint)
      .map(p => {
        const active = p === this._position ? ' active' : ''
        return `<button class="seg-btn${active}" data-position="${p}">${POSITION_NAMES[p]}</button>`
      })
      .join('')
  }

  _updateSelectionLabel() {
    const side  = sideLabel(this._side)
    const name  = JOINT_NAMES[this._joint] ?? this._joint
    // "flexion" is not the motion at every joint — the shoulder elevates and
    // the ankle dorsiflexes.
    const terms = motionTerms(this._joint)
    this._angleLabel.textContent  = `${side} ${name} ${terms.positive}`
    this._handleLabel.textContent = this._position
      ? `${side} ${name} · ${POSITION_NAMES[this._position]}`
      : `${side} ${name} · position not set`

    // Name both ends of the live ROM bar. Without these the bar showed two bare
    // numbers, leaving which end was which to be inferred from their order.
    if (this._romMinTerm) this._romMinTerm.textContent = terms.negative
    if (this._romMaxTerm) this._romMaxTerm.textContent = terms.positive
  }
}
