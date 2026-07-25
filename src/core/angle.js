/**
 * angle.js — Core ROM calculation math
 *
 * PURE FUNCTIONS ONLY — no DOM, no camera, no side effects.
 * Everything here is independently testable with Vitest.
 *
 * Coordinate system:
 *   - Points are {x, y} in canvas/video pixel space
 *   - Y increases DOWNWARD (standard screen coords)
 *   - Angles are returned in degrees (0–180 for a knee)
 *
 * Anatomical mapping for knee flexion:
 *   - A = proximal = thigh marker (marker ID 0)
 *   - B = joint    = knee marker  (marker ID 1)  ← angle measured here
 *   - C = distal   = shin marker  (marker ID 2)
 *
 *   0°   = fully extended (straight leg)
 *   90°  = right angle
 *   135° = moderate flexion
 *   160°+ = deep flexion (limited by anatomy)
 *
 * Note: our angle is the INTERIOR angle at B (the angle between
 * the two limb segments). A perfectly straight leg gives ~180°
 * from the vectors, but we subtract from 180 to get the
 * clinically reported flexion angle (0° = straight).
 */

/**
 * Calculate the joint angle at point B, given three points A, B, C.
 *
 * Uses the dot product formula:
 *   cos(θ) = (BA · BC) / (|BA| × |BC|)
 *
 * Returns the angle in degrees between 0 and 180.
 * Returns null if any point is missing or the vectors have zero length.
 *
 * @param {{ x: number, y: number }} A - proximal point (thigh)
 * @param {{ x: number, y: number }} B - joint point (knee)
 * @param {{ x: number, y: number }} C - distal point (shin)
 * @returns {number|null} angle in degrees
 */
export function jointAngle(A, B, C) {
  if (!A || !B || !C) return null

  // Optional z: when points carry a z component (3D world landmarks) the angle
  // is computed in real space; when they don't (2D pixel points) z is 0 and the
  // math reduces exactly to the original 2D calculation.
  const Az = A.z ?? 0, Bz = B.z ?? 0, Cz = C.z ?? 0

  // Vectors from B (knee) outward toward A (thigh) and C (shin)
  const BAx = A.x - B.x
  const BAy = A.y - B.y
  const BAz = Az - Bz
  const BCx = C.x - B.x
  const BCy = C.y - B.y
  const BCz = Cz - Bz

  // Magnitudes (lengths of the limb segments)
  const magBA = Math.sqrt(BAx * BAx + BAy * BAy + BAz * BAz)
  const magBC = Math.sqrt(BCx * BCx + BCy * BCy + BCz * BCz)

  // Guard against zero-length vectors (markers stacked on each other)
  if (magBA < 1e-6 || magBC < 1e-6) return null

  // Dot product
  const dot = BAx * BCx + BAy * BCy + BAz * BCz

  // Clamp to [-1, 1] to guard against floating-point errors in acos
  // Without this, values like 1.0000000002 cause acos to return NaN
  const cosTheta = Math.max(-1, Math.min(1, dot / (magBA * magBC)))

  // Interior angle at B in degrees
  const angleDeg = Math.acos(cosTheta) * (180 / Math.PI)

  return angleDeg
}

/**
 * Convert the raw interior angle to clinical flexion angle.
 *
 * Clinical convention: 0° = full extension (straight leg)
 * Raw interior angle at full extension ≈ 180°
 *
 * flexion = 180 - interiorAngle
 *
 * So: full extension = 180 - 180 = 0° ✓
 *     right angle    = 180 - 90  = 90° ✓
 *     deep flexion   = 180 - 40  = 140° ✓
 *
 * @param {number} interiorAngle - from jointAngle()
 * @returns {number} flexion angle (0 = straight, increasing = more bent)
 */
export function toFlexionAngle(interiorAngle) {
  return 180 - interiorAngle
}

/**
 * AngleSmoother — reduces frame-to-frame jitter using a moving average.
 *
 * Raw ArUco detection gives ±3–8° noise even on stationary markers.
 * Averaging the last N frames smooths this into ±1–2°.
 *
 * windowSize tradeoff:
 *   - Smaller (3–5): more responsive, more jitter
 *   - Larger  (8–10): smoother, but lags behind fast movements
 *   - 5 is a good starting point for ROM measurement
 */
export class AngleSmoother {
  constructor(windowSize = 10) {
    if (windowSize < 1) throw new Error('windowSize must be >= 1')
    this.windowSize = windowSize
    this._buffer = []
  }

  /**
   * Add a new angle reading and return the smoothed value.
   * If angle is null (markers lost), returns null and does NOT push to buffer.
   * This prevents a single missed frame from corrupting the smooth.
   *
   * @param {number|null} angle
   * @returns {number|null}
   */
  push(angle) {
    if (angle === null || angle === undefined || isNaN(angle)) {
      return this.current()
    }

    this._buffer.push(angle)
    if (this._buffer.length > this.windowSize) {
      this._buffer.shift()
    }

    return this.current()
  }

  /**
   * Get the current smoothed angle without pushing a new value.
   * @returns {number|null}
   */
  current() {
    if (this._buffer.length === 0) return null
    const sum = this._buffer.reduce((a, b) => a + b, 0)
    return sum / this._buffer.length
  }

  /**
   * Clear the buffer. Call this when a new session starts or
   * when markers are lost for more than a few frames.
   */
  reset() {
    this._buffer = []
  }

  get bufferLength() {
    return this._buffer.length
  }
}

/**
 * Apply a calibration offset to an angle reading.
 *
 * Usage:
 *   1. User stands with leg straight
 *   2. Capture the raw angle → this becomes the calibration offset
 *   3. All future angles are: rawAngle - offset
 *   4. Now "straight leg" reads 0° regardless of camera position
 *
 * @param {number} rawAngle      - current angle from jointAngle()
 * @param {number} offsetAngle   - angle captured at "zero position"
 * @returns {number}
 */
export function applyCalibration(rawAngle, offsetAngle) {
  return rawAngle - offsetAngle
}

/**
 * MedianFilter3 — returns the median of the last three samples.
 *
 * This is the spike defence for the measurement chain. MediaPipe occasionally
 * misplaces a landmark for a single frame; a mean drags that error into the
 * output, a median discards it outright.
 *
 * Crucially — unlike a moving average — a median does not round off peaks.
 * A real end-range position lasts more than one frame (the limb has to
 * decelerate into it), so it survives; a one-frame outlier does not.
 *
 * Costs one sample of delay (~100ms at 10Hz).
 */
export class MedianFilter3 {
  constructor() {
    this._buffer = []
  }

  /**
   * Add a sample and return the median of the last ≤3.
   * Null (pose lost) returns the current value without entering the buffer —
   * same contract as AngleSmoother.push().
   *
   * @param {number|null} value
   * @returns {number|null}
   */
  push(value) {
    if (value === null || value === undefined || isNaN(value)) {
      return this.current()
    }

    this._buffer.push(value)
    if (this._buffer.length > 3) {
      this._buffer.shift()
    }

    return this.current()
  }

  /**
   * Current median without pushing a new value.
   * @returns {number|null}
   */
  current() {
    const n = this._buffer.length
    if (n === 0) return null
    // Sort a copy — the buffer must stay in arrival order for the shift above
    const sorted = [...this._buffer].sort((a, b) => a - b)
    return sorted[Math.floor(n / 2)]
  }

  reset() {
    this._buffer = []
  }
}

/**
 * OneEuroFilter — an adaptive low-pass filter.
 *
 * WHY THIS AND NOT A MOVING AVERAGE:
 * A fixed-window average has a fixed lag — here 0.7s, which clipped 10–15° off
 * the peak of any dynamic sweep, because at the turnaround the window still
 * held 0.7s of shallower angles. Widening it calms the readout and worsens the
 * clipping; narrowing it does the reverse. There is no good setting.
 *
 * One Euro escapes that trade-off by varying its cutoff with speed:
 *   - joint stationary → low cutoff → heavy smoothing → calm readout
 *   - joint moving     → high cutoff → light smoothing → the peak survives
 *
 * Speed is what distinguishes jitter from real movement, so the filter can be
 * calm exactly when calmness is free.
 *
 * It is also timestamp-aware: it takes dt per sample rather than assuming a
 * fixed rate, so it degrades gracefully if the detection rate varies — where a
 * fixed-window average silently changes its own time constant.
 *
 * Reference: Casiez, Roussel & Vogel, "1€ Filter" (CHI 2012).
 *
 * @param {number} minCutoff - cutoff (Hz) at rest. Lower = calmer, more lag.
 *                             This is the knob to turn if the readout feels twitchy.
 * @param {number} beta      - how fast the cutoff opens with speed (deg/s).
 *                             Higher = less lag when moving, more noise.
 * @param {number} dCutoff   - cutoff (Hz) for the speed estimate itself.
 */
export class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.04, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff
    this.beta      = beta
    this.dCutoff   = dCutoff
    this.reset()
  }

  /**
   * Filter one sample.
   *
   * @param {number|null} value       - raw angle in degrees
   * @param {number}      timestampMs - monotonic timestamp (performance.now())
   * @returns {number|null} filtered angle, or the current value if input is null
   */
  push(value, timestampMs) {
    if (value === null || value === undefined || isNaN(value)) {
      return this._xHat
    }

    // First sample, or the pose was lost long enough that continuity is broken:
    // seed from this sample rather than integrating a huge derivative across
    // the gap, which would send the output flying past the true angle.
    const dt = this._lastTime === null ? null : (timestampMs - this._lastTime) / 1000
    if (dt === null || dt <= 0 || dt > GAP_RESET_S) {
      this._xHat     = value
      this._dxHat    = 0
      this._lastTime = timestampMs
      return this._xHat
    }

    // Low-pass the derivative before using it to steer the cutoff — the raw
    // frame-to-frame derivative is far too noisy to drive the filter with.
    const dx    = (value - this._xHat) / dt
    this._dxHat = this._lowPass(dx, this._dxHat, this.dCutoff, dt)

    // Adaptive cutoff: opens as the joint moves faster.
    const cutoff = this.minCutoff + this.beta * Math.abs(this._dxHat)
    this._xHat   = this._lowPass(value, this._xHat, cutoff, dt)

    this._lastTime = timestampMs
    return this._xHat
  }

  /** Current filtered value without pushing a sample. */
  get value() { return this._xHat }

  reset() {
    this._xHat     = null
    this._dxHat    = 0
    this._lastTime = null
  }

  // Exponential smoothing with the time constant implied by `cutoff`.
  _lowPass(value, prev, cutoff, dt) {
    const tau   = 1 / (2 * Math.PI * cutoff)
    const alpha = 1 / (1 + tau / dt)
    return alpha * value + (1 - alpha) * prev
  }
}

// Gap (seconds) beyond which the filter re-seeds instead of smoothing across.
// Roughly "the pose was lost, not merely slow" — a few dropped frames at 10Hz
// stay well inside this.
const GAP_RESET_S = 0.5

/**
 * DeadZoneFilter — only passes a new value through if it has changed
 * by more than `threshold` degrees from the last output.
 *
 * Eliminates display flickering on stationary markers.
 * A threshold of 1.5° is invisible to the human eye but absorbs
 * the typical ±1–2° noise from ArUco detection.
 *
 * @param {number} threshold - minimum change in degrees to update (default 1.5)
 */
export class DeadZoneFilter {
  constructor(threshold = 1.5) {
    this.threshold = threshold
    this._last = null
  }

  /**
   * @param {number|null} angle
   * @returns {number|null} last stable value if change < threshold, new value otherwise
   */
  push(angle) {
    if (angle === null || angle === undefined) return this._last
    if (this._last === null) {
      this._last = angle
      return angle
    }
    if (Math.abs(angle - this._last) >= this.threshold) {
      this._last = angle
    }
    return this._last
  }

  reset() {
    this._last = null
  }

  get value() { return this._last }
}
