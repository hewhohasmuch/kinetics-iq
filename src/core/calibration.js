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
 *   0°   = the captured neutral position
 *   +ve  = flexion (or elevation / dorsiflexion, per joint)
 *   -ve  = extension past neutral (including hyperextension)
 *
 *   clinicalAngle = rawAngle - calibrationOffset
 *
 * The raw angle fed in here already carries its per-joint convention from
 * toClinicalAngle() in angle.js — this stage only re-bases it on the neutral
 * the clinician captured.
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

// Current calibration schema version. A stored offset from an older version is
// discarded once and the user is prompted to re-zero.
//   1 — the 3D angle switch invalidated offsets captured under the old 2D math.
//   2 — the per-joint angle convention (see JOINT_ANGLE_CONVENTION in angle.js)
//       rescaled the shoulder and ankle. A shoulder offset captured under the
//       old inverted scale was ~165°, at the very top of the range; carried
//       over, it would put every subsequent reading far below zero.
export const CALIBRATION_VERSION = 2

export class CalibrationManager {
  constructor() {
    const settings = loadSettings()

    if ((settings.calibration_version ?? 0) < CALIBRATION_VERSION) {
      // Stale offset — clear it once and record the new version so this only
      // happens on the first run after the upgrade.
      this._offset   = 0
      this._captured = false
      saveSettings({
        calibration_offset:   0,
        calibration_version:  CALIBRATION_VERSION,
        calibration_captured: false,
      })
    } else {
      this._offset   = settings.calibration_offset ?? 0
      this._captured = settings.calibration_captured ?? false
    }

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
   * Whether an offset has been captured.
   *
   * Tracked explicitly rather than inferred from `offset !== 0`: a captured
   * offset of exactly 0.0 is legitimate (the joint really was at neutral), and
   * inferring it reported that as "Not zeroed — tap Set Zero".
   */
  get isCalibrated() { return this._captured }

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
   * Apply the calibration offset to a raw clinical angle.
   * Returns the angle relative to the captured neutral (0 = neutral).
   *
   * The result is SIGNED. Negative means the joint is past neutral in the
   * extension direction, which is a measurement — not an error to be swallowed.
   * This used to clamp at 0, which discarded the entire extension side of the
   * zero point: an extension test read a flat 0° for its whole duration, and
   * because this same value feeds the readout, the overlay, the snapshots and
   * SessionRecorder, the saved session recorded a range of motion of 0°.
   *
   * @param {number|null} rawAngle - from toClinicalAngle()
   * @returns {number|null}
   */
  apply(rawAngle) {
    if (rawAngle === null || rawAngle === undefined) return null
    return rawAngle - this._offset
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
    this._offset   = 0
    this._captured = false
    saveSettings({ calibration_offset: 0, calibration_captured: false })
  }

  // ─── Private ─────────────────────────────────────────────────────────

  _finalize() {
    // Average all samples for a stable offset
    const avg = this._samples.reduce((a, b) => a + b, 0) / this._samples.length
    this._offset   = Math.round(avg * 10) / 10   // 1 decimal place
    this._captured = true

    // Persist to localStorage
    saveSettings({ calibration_offset: this._offset, calibration_captured: true })

    this._sampling = false
    const cb = this._onComplete
    this._onComplete = null
    this._samples    = []

    if (cb) cb(this._offset)
  }
}
