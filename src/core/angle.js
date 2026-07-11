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
