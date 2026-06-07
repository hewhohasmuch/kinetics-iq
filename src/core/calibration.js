/**
 * calibration.js
 *
 * Manages the calibration offset for clinically meaningful angle readings.
 *
 * WHAT CALIBRATION DOES:
 * The raw angle from jointAngle() is affected by camera position, distance,
 * and marker placement. Without calibration, "straight leg" might read 168°
 * one session and 172° the next — making progress tracking unreliable.
 *
 * Calibration captures the raw angle at "neutral position" (straight leg)
 * and stores it as an offset. All subsequent readings are reported relative
 * to that neutral, so straight leg always = 0° of flexion.
 *
 * CONVENTION (matches PT goniometer convention):
 *   0°   = full extension (neutral / straight)
 *   +ve  = flexion (bending)
 *
 *   flexionAngle = calibrationOffset - rawFlexionAngle
 *
 * PERSISTENCE:
 * The offset is saved to localStorage so it survives page reloads.
 * It should be re-calibrated at the start of each session if the phone
 * is repositioned or markers are reapplied.
 *
 * SAMPLING:
 * We capture 20 frames (~2 seconds at 10Hz) and average them for the
 * offset — more stable than a single-frame capture.
 */

import { saveSettings, loadSettings } from './storage.js'

const SAMPLE_COUNT = 20   // frames to average during calibration capture

export class CalibrationManager {
  constructor() {
    this._offset        = loadSettings().calibration_offset ?? 0
    this._sampling      = false
    this._samples       = []
    this._onComplete    = null   // callback(offset) when calibration finishes
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Current calibration offset in degrees.
   * This is the raw flexion angle at "standing straight".
   */
  get offset() { return this._offset }

  /**
   * Whether calibration has been set (non-zero offset captured).
   */
  get isCalibrated() { return this._offset !== 0 }

  /**
   * Whether we are currently sampling frames for a new calibration.
   */
  get isSampling() { return this._sampling }

  /**
   * How many samples collected so far (0–SAMPLE_COUNT).
   */
  get sampleProgress() { return this._samples.length }

  get sampleTarget() { return SAMPLE_COUNT }

  /**
   * Apply the calibration offset to a raw flexion angle.
   * Returns the clinically meaningful flexion angle (0 = straight).
   *
   * @param {number|null} rawFlexionAngle - from toFlexionAngle()
   * @returns {number|null}
   */
  apply(rawFlexionAngle) {
    if (rawFlexionAngle === null || rawFlexionAngle === undefined) return null
    // Raw flexion at neutral = offset.
    // Flexion relative to neutral = raw - offset.
    // Clamp to 0 minimum — negative flexion (hyperextension) shown as 0.
    return Math.max(0, rawFlexionAngle - this._offset)
  }

  /**
   * Begin sampling for a new calibration.
   * Call this when the user taps "Set Zero".
   * Feed angle samples via addSample() until isSampling becomes false.
   *
   * @param {Function} onComplete - called with (offset) when done
   */
  startSampling(onComplete) {
    this._samples    = []
    this._sampling   = true
    this._onComplete = onComplete
  }

  /**
   * Feed one angle sample during calibration sampling.
   * Called from the detection loop — same rate as normal measurement.
   * Automatically finalizes when SAMPLE_COUNT samples are collected.
   *
   * @param {number|null} rawFlexionAngle
   */
  addSample(rawFlexionAngle) {
    if (!this._sampling) return
    if (rawFlexionAngle === null || rawFlexionAngle === undefined) return

    this._samples.push(rawFlexionAngle)

    if (this._samples.length >= SAMPLE_COUNT) {
      this._finalize()
    }
  }

  /**
   * Cancel an in-progress calibration without saving.
   */
  cancel() {
    this._sampling   = false
    this._samples    = []
    this._onComplete = null
  }

  /**
   * Clear calibration — resets offset to 0.
   * Readings will be raw flexion angles again.
   */
  clear() {
    this._offset = 0
    saveSettings({ calibration_offset: 0 })
  }

  // ─── Private ─────────────────────────────────────────────────────────

  _finalize() {
    // Average all samples for a stable offset
    const avg = this._samples.reduce((a, b) => a + b, 0) / this._samples.length
    this._offset  = Math.round(avg * 10) / 10   // 1 decimal place

    // Persist to localStorage
    saveSettings({ calibration_offset: this._offset })

    this._sampling = false
    const cb = this._onComplete
    this._onComplete = null
    this._samples    = []

    if (cb) cb(this._offset)
  }
}
