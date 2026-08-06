/**
 * headRegion.js
 *
 * Locates the patient's head in a MediaPipe pose result so it can be blurred
 * out of the session snapshots.
 *
 * PURE GEOMETRY — no DOM, no canvas. Fully testable in Node.
 *
 * WHAT THIS IS FOR: data minimisation. Removing the face does NOT de-identify
 * the record — the images stay linked to a named patient and a date of service,
 * so they remain PHI. This reduces the severity of a leak, nothing more.
 *
 * WHY NOT A PADDED BOUNDING BOX of the face landmarks:
 *
 *   1. Landmarks 0–10 cover the FACE, not the skull. They span the eye line
 *      down to the mouth; the cranium and hair sit above the topmost one, so a
 *      tight box leaves the top of the head sharp.
 *   2. The box COLLAPSES IN PROFILE. Turned side-on — common for knee and hip
 *      work — the ears and nose stack up in x and the box badly under-estimates
 *      head size. The radius would shrink exactly where someone is still
 *      recognisable.
 *
 * So the scale comes from two independent estimators, whichever is larger:
 * the face-landmark span, and a torso-relative distance that is rotation-
 * invariant (a distance, not a projection) and therefore survives profile,
 * prone, supine and seated alike.
 *
 * NO VISIBILITY THRESHOLD IS APPLIED. Position only. A confidence threshold
 * silently no-ops in precisely the hard cases — backlit, face-down on a table,
 * occluded by a pillow — which is when a clinician most needs the guarantee to
 * hold. Over-blurring is free: the head is never the joint being measured.
 */

// Starting values, biased to over-cover. Tune against the e2e fixture and
// on-device; do not treat as derived truth.
export const HEAD_RADIUS_FACTOR  = 0.85  // radius as a multiple of the scale estimate
export const TORSO_SCALE_COEFF   = 0.70  // makes the torso estimate ≈ the face estimate frontally
export const CRANIUM_NUDGE       = 0.35  // centre offset along the shoulders→head axis, as a fraction of r
export const MAX_RADIUS_FRACTION = 0.50  // sanity cap against a garbage landmark frame
export const BLUR_RADIUS_FACTOR  = 0.35  // blur radius as a fraction of the display radius

const FACE_LANDMARKS  = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const LEFT_SHOULDER   = 11
const RIGHT_SHOULDER  = 12

/**
 * Whether headRegion's inputs are usable at all — i.e. whether a `null`
 * result means "no head in the picture" (safe to skip redaction) or "we
 * cannot tell" (unsafe: treat as if a face might be in shot).
 *
 * Checks indices 0–12 inclusive: the face landmarks (0–10) AND both
 * shoulders (11, 12). The shoulders matter here even though they are not
 * face landmarks — a NaN/missing shoulder poisons the sTorso estimate and
 * makes headRegion() return null even with a face plainly in shot, which
 * would otherwise be a third, silent leak path alongside a fully-dropped
 * pose.
 *
 * Deliberately stricter than headRegion() strictly requires (e.g. it
 * doesn't tolerate a missing landmark the way headRegion's `if (!lm)
 * continue` does): healthy MediaPipe output always satisfies this, and a
 * false negative only ever costs a skipped snapshot, never a leaked one.
 *
 * @param {Array<{x:number,y:number}>|null} landmarksNorm
 * @returns {boolean}
 */
export function headInputsFinite(landmarksNorm) {
  if (!landmarksNorm) return false
  for (let i = 0; i <= RIGHT_SHOULDER; i++) {
    const lm = landmarksNorm[i]
    if (!lm) return false
    if (!Number.isFinite(lm.x) || !Number.isFinite(lm.y)) return false
  }
  return true
}

/**
 * @param {Array<{x:number,y:number}>|null} landmarksNorm - MediaPipe normalised (0–1) landmarks
 * @param {number} videoW - intrinsic video width in pixels
 * @param {number} videoH - intrinsic video height in pixels
 * @returns {{cx:number, cy:number, r:number}|null} circle in VIDEO PIXEL space,
 *          or null when there is no head in the picture to redact
 */
export function headRegion(landmarksNorm, videoW, videoH) {
  if (!landmarksNorm || landmarksNorm.length <= RIGHT_SHOULDER) return null
  if (!videoW || !videoH) return null

  // Face landmarks → video pixel space, collecting centroid and bounding box.
  let sumX = 0, sumY = 0, count = 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const i of FACE_LANDMARKS) {
    const lm = landmarksNorm[i]
    if (!lm) continue
    const x = lm.x * videoW
    const y = lm.y * videoH
    sumX += x; sumY += y; count++
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (count === 0) return null

  const faceX = sumX / count
  const faceY = sumY / count
  const sFace = Math.hypot(maxX - minX, maxY - minY)

  // Torso-relative scale + the shoulders→head axis. Both are rotation-
  // invariant, which is what makes this work for a patient lying down with
  // the camera at any rotation.
  let sTorso = 0
  let upX = 0, upY = -1          // fallback: screen-up, if shoulders are absent
  const ls = landmarksNorm[LEFT_SHOULDER]
  const rs = landmarksNorm[RIGHT_SHOULDER]
  if (ls && rs) {
    const shX = ((ls.x + rs.x) / 2) * videoW
    const shY = ((ls.y + rs.y) / 2) * videoH
    const dx  = faceX - shX
    const dy  = faceY - shY
    const d   = Math.hypot(dx, dy)
    sTorso = TORSO_SCALE_COEFF * d
    if (d > 1e-6) { upX = dx / d; upY = dy / d }
  }

  const scale = Math.max(sFace, sTorso)
  if (!(scale > 0)) return null

  const maxR = MAX_RADIUS_FRACTION * Math.min(videoW, videoH)
  const r    = Math.min(HEAD_RADIUS_FACTOR * scale, maxR)

  const cx = faceX + upX * (CRANIUM_NUDGE * r)
  const cy = faceY + upY * (CRANIUM_NUDGE * r)

  // Reject NaN or infinite values.
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) return null

  // No head in the picture → nothing to redact.
  if (cx + r < 0 || cx - r > videoW || cy + r < 0 || cy - r > videoH) return null

  return { cx, cy, r }
}

/**
 * Derive the blur strength and the padded source square for a head circle
 * already mapped into DISPLAY CSS PIXEL space.
 *
 * A canvas blur() filter fades to transparent at the SOURCE IMAGE's edges.
 * Padding the source square by twice the blur radius puts that soft edge
 * outside the clip circle, so the circle comes out uniformly opaque and no
 * sharp face pixels leak around its rim.
 *
 * @param {{cx:number, cy:number, r:number}|null} displayRegion
 * @returns {{blurRadius:number, padding:number, x:number, y:number, size:number}|null}
 */
export function redactionGeometry(displayRegion) {
  if (!displayRegion || !(displayRegion.r > 0)) return null
  const { cx, cy, r } = displayRegion

  const blurRadius = Math.max(1, BLUR_RADIUS_FACTOR * r)
  const padding    = 2 * blurRadius
  const half       = r + padding

  return {
    blurRadius,
    padding,
    x:    cx - half,
    y:    cy - half,
    size: 2 * half,
  }
}
