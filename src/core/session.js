/**
 * session.js
 *
 * SessionRecorder — captures angle samples during a measurement session
 * and computes the clinically meaningful ROM metrics.
 *
 * PURE LOGIC — no DOM, no localStorage. Storage is handled by storage.js.
 * This class is fully testable in Node with no browser required.
 *
 * A "session" represents one measurement bout:
 *   user taps Start → moves joint through range → taps Stop
 *   result = { min, max, rom, duration, samples }
 *
 * ROM (Range of Motion) = max flexion angle − min flexion angle
 * This is the primary clinical metric. Higher = better (more range).
 *
 * Angle convention (from angle.js):
 *   0°   = full extension (straight leg)
 *   90°  = right angle
 *   135° = significant flexion
 */

import { generateId } from './id.js'

export class SessionRecorder {
  constructor() {
    this._angles    = []      // all angle samples captured this session
    this._startTime = null    // Date.now() at start
    this._active    = false
    this._joint     = 'knee'
    this._side      = 'right'
    this._position  = null
    this._calOffset = null    // null = no calibration state supplied
    this._calibrated = null
    this._maxTilt   = null    // null = never measured, distinct from 0
  }

  // Set the joint, side, and position before start() so they appear in the saved session.
  //
  // An absent position stays null rather than defaulting to 'prone'. That default
  // is what stamped "Prone" onto standing shoulder measurements: the UI hid the
  // position row for joints it considered position-less, but the recorder filled
  // one in anyway and it was written to the patient record. A position nobody
  // chose is not data — the views already omit the badge when it is null.
  setContext(joint, side, position) {
    this._joint    = joint
    this._side     = side
    this._position = position ?? null
  }

  /**
   * Record the calibration state these angles were measured under. Call before
   * start(), alongside setContext().
   *
   * WHY THIS IS ON THE SESSION AND NOT JUST IN SETTINGS:
   * The offset lives in rom_settings, which is global and is cleared on every
   * joint, side or patient switch. Once a session was saved there was no way to
   * tell whether its numbers were raw or re-based on a captured neutral — and
   * those are different measurements. The shoulder is the clearest case: the
   * same joint reads roughly 24.6°→160.7° raw and −1.4°→129.8° zeroed, and the
   * saved records were indistinguishable.
   *
   * `captured` is passed explicitly rather than inferred from a non-zero
   * offset, for the same reason CalibrationManager tracks its own flag: an
   * offset of exactly 0.0 is a legitimate capture.
   *
   * @param {number|null}  offset   degrees subtracted from each raw angle
   * @param {boolean|null} captured whether a zero was actually captured
   */
  setCalibration(offset, captured) {
    this._calOffset  = offset ?? null
    this._calibrated = captured ?? null
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Begin a new recording session.
   * Clears any previous data.
   */
  start() {
    this._angles    = []
    this._startTime = Date.now()
    this._active    = true
    this._maxTilt   = null
  }

  /**
   * Record how far out of the image plane the limb was on this frame, keeping
   * the worst value seen. See PoseDetector.segmentTilt().
   *
   * WHY THE WORST AND NOT THE MEAN: the angle that matters is the one at the
   * extremes, and that is exactly where a limb swings off-axis. An average over
   * a bout that was in-plane for 90% of its duration would hide the moment the
   * peak was captured — which is the only moment this is about.
   *
   * Stays null when nothing was ever measured, which is a different claim from
   * "measured, and it was 0" — same discipline as the calibration stamps.
   *
   * @param {number|null} tiltDeg
   */
  recordTilt(tiltDeg) {
    if (!this._active) return
    if (tiltDeg === null || tiltDeg === undefined || isNaN(tiltDeg)) return
    this._maxTilt = this._maxTilt === null ? tiltDeg : Math.max(this._maxTilt, tiltDeg)
  }

  /**
   * Record one angle sample.
   * Call this at detection rate (~10Hz) while session is active.
   * Silently ignores null values (marker lost frames).
   *
   * @param {number|null} angle - smoothed flexion angle in degrees
   */
  record(angle) {
    if (!this._active) return
    if (angle === null || angle === undefined || isNaN(angle)) return
    this._angles.push(angle)
  }

  /**
   * Stop recording and return the completed session object.
   * Returns null if fewer than 3 samples were captured (not enough data).
   *
   * @returns {Session|null}
   */
  stop() {
    if (!this._active) return null
    this._active = false

    if (this._angles.length < 1) return null

    const min      = Math.min(...this._angles)
    const max      = Math.max(...this._angles)
    const duration = Math.round((Date.now() - this._startTime) / 1000)

    // Round each sample to 1dp to keep localStorage size reasonable.
    // At 10Hz for 60s = 600 samples ≈ 3-4KB per session.
    const timeline = this._angles.map(a => Math.round(a * 10) / 10)

    return {
      // UUID (not sess_<timestamp>) so offline-created sessions upsert
      // cleanly into the cloud's uuid primary key without id remapping
      id:            generateId(),
      timestamp:     this._startTime,
      date:          new Date(this._startTime).toISOString().split('T')[0],
      joint:         this._joint,
      side:          this._side,
      position:      this._position,
      min:           Math.round(min * 10) / 10,
      max:           Math.round(max * 10) / 10,
      rom:           Math.round((max - min) * 10) / 10,
      duration_s:    duration,
      samples:       this._angles.length,
      angleTimeline: timeline,   // full sample array for detail chart
      // Angle source generation. '2d2' = measured from the 2D image landmarks.
      // '3d' = the monocular world landmarks, whose depth error reverses sign
      // across the range (+13.5 deg at extension, -18.4 deg at peak on the
      // measured elbow) and understated total ROM by 21%; those sessions read
      // LOW and provenance.js flags them. ABSENT is a third value again: the
      // pre-3D era, which was also 2D but on the old filter and convention, so
      // it cannot be equated with '2d2'.
      angleMode:     '2d2',
      // Filter generation that produced these angles. Sessions without this
      // field predate the peak-clipping fix and read systematically low at the
      // extremes — do not compare their ROM against 'euro1' sessions as if the
      // difference were the patient's.
      angleFilter:   'euro1',
      // Angle convention generation. Sessions without this field were measured
      // with a single `180 - interior` rule applied to every joint, which
      // inverted the shoulder scale and offset the ankle by 90°, and whose
      // calibration clamped away everything below the zero point. Their
      // shoulder/ankle numbers are not comparable with 'perjoint1' sessions —
      // and are not recoverable, since the offset used was never stored.
      angleConvention: 'perjoint1',
      // Calibration state these angles were measured under. `calibrated` is
      // null — not false — when no state was supplied, because absence means
      // "never recorded", which is a different claim from "recorded raw". Old
      // sessions carry neither field and must not be read as un-zeroed.
      calibrated:       this._calibrated,
      calibrationOffset: this._calOffset,
      // Worst out-of-plane excursion seen during the bout, in degrees, or null
      // if it was never measured. The 2D angle is only the joint angle while
      // the limb stays in the image plane, so this is the record of whether
      // that held. Rounded to 1dp like everything else here.
      maxSegmentTilt: this._maxTilt === null ? null : Math.round(this._maxTilt * 10) / 10,
      notes:         '',
      app_version:   '0.1.0',
      // Supabase Storage paths for the two overlay snapshots. Null until the
      // blob (held in imageStore/IndexedDB) has been uploaded by sync.js; the
      // image BYTES never live on the session object — that filled localStorage.
      peakFramePath: null,
      minFramePath:  null,
    }
  }

  // ─── State queries ──────────────────────────────────────────────────

  /**
   * Attach a notes string to the session after stop().
   * Call this with the session object returned by stop().
   *
   * @param {Session} session - returned from stop()
   * @param {string}  notes   - free-text note from user
   * @returns {Session} the same session with notes attached
   */
  static attachNotes(session, notes) {
    if (!session) return null
    return { ...session, notes: (notes || '').trim().slice(0, 200) }
  }

  get isActive()     { return this._active }
  get sampleCount()  { return this._angles.length }

  /**
   * Live min/max during an active session — for the real-time range bar.
   * Returns null if no samples yet.
   */
  getLiveStats() {
    if (this._angles.length === 0) return null
    return {
      min: Math.min(...this._angles),
      max: Math.max(...this._angles),
      rom: Math.max(...this._angles) - Math.min(...this._angles),
    }
  }
}
