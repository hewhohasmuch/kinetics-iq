/**
 * headRegion.js
 *
 * Locates the patient's head in a MediaPipe pose result, as an oriented
 * ellipse, so it can be blurred out of the session snapshots.
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
export const ELLIPSE_ACROSS = 0.92  // seed semi-axis across the head axis, x rHeuristic
export const ELLIPSE_ALONG  = 1.14  // seed semi-axis along it — a head is taller than wide
export const FEATHER_EXTENT = 1.35  // alpha reaches 0 here, as a multiple of the core
export const OUTLINE_AT     = 1.04  // outline sits just outside the core

/**
 * The containment guarantee. After the centre is placed, the ellipse semi-axes
 * are grown until every one of the eleven face landmarks is inside it with this
 * much slack:
 *
 *   grow = max(1, t * COVERAGE_MARGIN)
 *
 * where t is the factor by which the seeded ellipse must grow for every face
 * landmark to sit inside. This turns "the heuristics probably cover the face"
 * into an invariant. Before it existed, a close-framed profile pose — where the
 * torso estimator takes over and CRANIUM_NUDGE keeps pushing the centre toward
 * the cranium — left the mouth landmarks ~5% of r OUTSIDE.
 *
 * The margin is NOT mere slack — it carries the whole cranium. MediaPipe's
 * eleven face landmarks bound the FACE (eye line to mouth, ear to ear); the
 * skull, hairline and the back of the head extend well past them and have no
 * landmarks of their own, so containment alone can never reach them. Tuned
 * against the e2e fixture by inspecting the exported snapshot, not derived:
 * at 1.10 the face was covered but hair, ear and the back of the head were
 * left sharp in the stored image.
 */
export const COVERAGE_MARGIN     = 1.60
export const MOTION_GAIN         = 1.0  // occluder growth per pixel of inter-frame head travel

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
 * Whether any FACE landmark (0–10) maps to a point actually inside the video
 * frame. Non-finite landmarks are skipped when scanning — headInputsFinite()
 * already covers that case; this function only answers "is a face pixel on
 * screen", not "are the inputs trustworthy".
 *
 * Exists because headRegion()'s radius is CAPPED (MAX_RADIUS_FRACTION), and
 * the off-frame rejection is applied to the CAPPED circle: a head that is
 * large and mostly off-frame (e.g. camera held close) can yield a clamped
 * circle that lies entirely outside the video rect while a face landmark is
 * still a few pixels inside it. headRegion() returning null there does NOT
 * mean "nothing to redact" — this function is what actually proves that.
 *
 * WARNING: this function SKIPS non-finite landmarks rather than failing on
 * them, so it is only safe to call after `headInputsFinite()` has passed —
 * a standalone caller can get a false "no face in frame" from inputs that
 * are actually unreliable, not actually face-free.
 *
 * @param {Array<{x:number,y:number}>|null} landmarksNorm
 * @param {number} videoW
 * @param {number} videoH
 * @returns {boolean}
 */
export function anyFaceLandmarkInFrame(landmarksNorm, videoW, videoH) {
  if (!landmarksNorm || landmarksNorm.length === 0) return false
  if (!videoW || !videoH) return false
  for (const i of FACE_LANDMARKS) {
    const lm = landmarksNorm[i]
    if (!lm) continue
    if (!Number.isFinite(lm.x) || !Number.isFinite(lm.y)) continue
    const x = lm.x * videoW
    const y = lm.y * videoH
    if (x >= 0 && x <= videoW && y >= 0 && y <= videoH) return true
  }
  return false
}

/**
 * @param {Array<{x:number,y:number}>|null} landmarksNorm - MediaPipe normalised (0–1) landmarks
 * @param {number} videoW - intrinsic video width in pixels
 * @param {number} videoH - intrinsic video height in pixels
 * @returns {{cx:number, cy:number, rAcross:number, rAlong:number, ux:number, uy:number}|null}
 *          oriented ellipse in VIDEO PIXEL space — `(ux, uy)` is the unit
 *          shoulders→head axis, `rAlong` is the semi-axis along it, `rAcross`
 *          the semi-axis perpendicular to it — or null when there is no head
 *          in the picture to redact
 *
 * CONTAINMENT, AND ITS ONE EXCEPTION. The returned ellipse contains every face
 * landmark with COVERAGE_MARGIN of slack — by construction, not by hoping the
 * heuristics were generous enough. The one exception is MAX_RADIUS_FRACTION,
 * which is applied LAST and therefore WINS: on a garbage landmark frame the
 * sanity cap takes precedence over containment, because an ellipse covering
 * half the frame is its own failure. **Containment is guaranteed only when
 * neither semi-axis is capped** — i.e. when both
 * `rAcross, rAlong < MAX_RADIUS_FRACTION × min(videoW, videoH)`. A capped
 * frame is by definition one whose landmarks are not to be trusted anyway;
 * callers that need a hard guarantee should treat a capped result as
 * unreliable rather than as proof the face is covered.
 */
export function headRegion(landmarksNorm, videoW, videoH) {
  if (!landmarksNorm || landmarksNorm.length <= RIGHT_SHOULDER) return null
  if (!videoW || !videoH) return null

  // Face landmarks → video pixel space, collecting centroid and bounding box.
  // The points are retained: the containment term below needs each one's
  // distance from the FINAL centre, which is not known during this pass.
  const facePts = []
  let sumX = 0, sumY = 0, count = 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const i of FACE_LANDMARKS) {
    const lm = landmarksNorm[i]
    if (!lm) continue
    const x = lm.x * videoW
    const y = lm.y * videoH
    facePts.push({ x, y })
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
  let ux = 0, uy = -1          // fallback: screen-up, if shoulders are absent
  const ls = landmarksNorm[LEFT_SHOULDER]
  const rs = landmarksNorm[RIGHT_SHOULDER]
  if (ls && rs) {
    const shX = ((ls.x + rs.x) / 2) * videoW
    const shY = ((ls.y + rs.y) / 2) * videoH
    const dx  = faceX - shX
    const dy  = faceY - shY
    const d   = Math.hypot(dx, dy)
    sTorso = TORSO_SCALE_COEFF * d
    if (d > 1e-6) { ux = dx / d; uy = dy / d }
  }

  const scale = Math.max(sFace, sTorso)
  if (!(scale > 0)) return null

  const maxR = MAX_RADIUS_FRACTION * Math.min(videoW, videoH)

  // The heuristic radius. It places the CENTRE (via CRANIUM_NUDGE), seeds the
  // semi-axes, and acts as the floor on the final size — it is what covers the
  // cranium and hair, which have no landmarks of their own to be contained.
  //
  // Capped HERE as well as at the end, which is what keeps the centre finite
  // and on-frame for a garbage landmark frame.
  const rHeuristic = Math.min(HEAD_RADIUS_FACTOR * scale, maxR)

  const cx = faceX + ux * (CRANIUM_NUDGE * rHeuristic)
  const cy = faceY + uy * (CRANIUM_NUDGE * rHeuristic)

  // Seed the ellipse from the heuristic, then grow it to contain.
  let rAcross = ELLIPSE_ACROSS * rHeuristic
  let rAlong  = ELLIPSE_ALONG  * rHeuristic
  if (!(rAcross > 0) || !(rAlong > 0)) return null

  // Perpendicular to the head axis. (ux, uy) and (px, py) form the ellipse's
  // local frame; both are unit vectors, so the projections below are distances.
  const px = -uy, py = ux

  // CONTAINMENT TERM, elliptical. `t` is the factor by which the seeded
  // ellipse must grow for every face landmark to sit inside it.
  let t = 0
  for (const p of facePts) {
    const dx = p.x - cx
    const dy = p.y - cy
    const across = dx * px + dy * py
    const along  = dx * ux + dy * uy
    const q = Math.hypot(across / rAcross, along / rAlong)
    if (q > t) t = q
  }

  // NOTE THE MARGIN'S PLACEMENT — inside the max(), not outside it. This is
  // the faithful analogue of the circle version's
  //   r = max(rHeuristic, maxDist * COVERAGE_MARGIN)
  // where the heuristic floor wins OUTRIGHT when it already over-covers.
  // Writing `Math.max(1, t) * COVERAGE_MARGIN` would instead scale every
  // region by 1.60 even when containment is inert, inflating the occluder on
  // every normal frame — and no containment assertion would catch it.
  const grow = Math.max(1, t * COVERAGE_MARGIN)
  rAcross *= grow
  rAlong  *= grow

  // The sanity cap is applied LAST to BOTH axes and therefore OVERRIDES
  // containment: a garbage landmark frame must not be able to mask the whole
  // picture. Containment holds only while the shape is uncapped.
  rAcross = Math.min(rAcross, maxR)
  rAlong  = Math.min(rAlong,  maxR)

  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
  if (!Number.isFinite(rAcross) || !Number.isFinite(rAlong)) return null
  if (!Number.isFinite(ux) || !Number.isFinite(uy)) return null

  // Axis-aligned half-extents of the ORIENTED ellipse — the correct bounding
  // box for the off-frame test. Using rAcross/rAlong directly would be wrong
  // for any head axis that is not screen-aligned, i.e. every prone patient.
  const hx = Math.hypot(rAcross * uy, rAlong * ux)
  const hy = Math.hypot(rAcross * ux, rAlong * uy)

  // No head in the picture → nothing to redact.
  if (cx + hx < 0 || cx - hx > videoW || cy + hy < 0 || cy - hy > videoH) return null

  return { cx, cy, rAcross, rAlong, ux, uy }
}

/**
 * Grow a head region to cover the distance the head travelled since the last
 * detection.
 *
 * WHY THIS EXISTS. Detection runs at 10Hz plus BlazePose inference (~150ms end
 * to end) while the <video> element underneath keeps playing at 30fps, so the
 * overlay is positioned from landmarks that are already stale by the time it is
 * composited over the live preview. At walking pace that is 80-90px — about one
 * head radius, which is exactly the offset seen in tmp/blur1.jpg. Growing the
 * shape by the last displacement covers the swept path instead of a stale
 * point.
 *
 * The CENTRE is deliberately not moved. Extrapolating it forward would guess at
 * a velocity from two samples and can overshoot off the head entirely; growing
 * is strictly conservative — it only ever covers more.
 *
 * The STORED snapshot does not need this (it composites over the same buffered
 * frame the landmarks came from) but gets it anyway, because preview and
 * snapshot come from one draw. Over-covering there is free.
 *
 * @param {{cx:number,cy:number,rAcross:number,rAlong:number,ux:number,uy:number}|null} region
 * @param {object|null} prevRegion - the previous frame's region; only its
 *        centre (cx, cy) is read — rAcross/rAlong are ignored, so passing the
 *        raw or the already-expanded previous region currently makes no
 *        difference to the output
 * @param {number} videoW
 * @param {number} videoH
 * @param {number} [gain]
 * @returns the same reference when there is nothing to expand, else a new region
 */
export function expandForMotion(region, prevRegion, videoW, videoH, gain = MOTION_GAIN) {
  if (!region || !prevRegion) return region
  // Mirrors headRegion()'s guard at line 162. A <video> element can report 0
  // between frames; without this, maxR is NaN and Math.min() poisons both
  // semi-axes — a NaN ellipse draws no occluder at all, leaving the face
  // visible on exactly the frames where something already went wrong. Returning
  // the region unchanged is safe: it is still drawable, it just cannot be
  // safely expanded.
  if (!videoW || !videoH) return region
  if (!Number.isFinite(prevRegion.cx) || !Number.isFinite(prevRegion.cy)) return region

  const d = Math.hypot(region.cx - prevRegion.cx, region.cy - prevRegion.cy)
  if (!Number.isFinite(d) || d <= 0) return region

  const maxR = MAX_RADIUS_FRACTION * Math.min(videoW, videoH)
  return {
    ...region,
    rAcross: Math.min(region.rAcross + gain * d, maxR),
    rAlong:  Math.min(region.rAlong  + gain * d, maxR),
  }
}

/**
 * Derive the drawing geometry for a head ellipse already mapped into DISPLAY
 * CSS PIXEL space.
 *
 * WHAT REPLACED WHAT, AND WHY. The blur version of this function returned a
 * `blurRadius` and a `padding = 2 * blurRadius`. That padding existed only
 * because a Canvas 2D blur fades to TRANSPARENT at its source image's edges,
 * so the source square had to overhang the clip circle to keep the rim opaque.
 * With an opaque fill there is no fade to hide and no source to overhang, so
 * both are gone.
 *
 * THE CORE IS THE CONTAINMENT ELLIPSE, UNCHANGED. Every softening term here —
 * the feather, the outline — is strictly OUTSIDE it, over background pixels
 * that were never part of the head. That is what lets the occluder be made to
 * look deliberate without weakening what it guarantees. Do not shrink the core
 * to start the fade earlier.
 *
 * @param {{cx:number,cy:number,rAcross:number,rAlong:number,ux:number,uy:number}|null} displayRegion
 */
export function occluderGeometry(displayRegion) {
  if (!displayRegion) return null
  const { cx, cy, rAcross, rAlong, ux, uy } = displayRegion
  if (!(rAcross > 0) || !(rAlong > 0)) return null
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null

  // ctx.rotate(theta) sends the local y-axis to (-sin theta, cos theta). We
  // need that to be the head axis (ux, uy) so that radiusY = rAlong runs along
  // the head and radiusX = rAcross runs across it.
  const rotation = Math.atan2(-ux, uy)

  return {
    cx, cy, rotation,
    core:    { rAcross, rAlong },
    feather: { rAcross: rAcross * FEATHER_EXTENT, rAlong: rAlong * FEATHER_EXTENT },
    outline: { rAcross: rAcross * OUTLINE_AT,     rAlong: rAlong * OUTLINE_AT },
    innerStop: 1 / FEATHER_EXTENT,
  }
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
