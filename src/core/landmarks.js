/**
 * landmarks.js
 *
 * The landmark model: which MediaPipe points each joint uses, what KIND of
 * thing each one is, and the normalized shape stored on a session.
 *
 * WHY THIS IS IN core/ AND NOT detection/
 * `JOINT_CONFIG` is data, not detection logic, and it now has a second reader:
 * the stored landmark set needs each point's `kind`, and deriving that from the
 * config is the only way a joint added later gets the right behaviour for free
 * (the same discipline `rawCannotGoBelowNeutral()` follows against the
 * convention table in angle.js). Leaving the config in `pose.js` would mean
 * importing MediaPipe to ask a question about anatomy — and would pull the
 * ~7MB tasks-vision bundle into the pure, unit-tested layer. `pose.js`
 * re-exports it, so existing importers are unaffected.
 *
 * PURE LOGIC — no DOM, no browser API, no MediaPipe.
 */

// MediaPipe landmark indices (subject-anatomical left/right).
// proximal/joint/distal can be:
//   - a number: single landmark index
//   - { midpoint: [a, b] }: average of two landmarks (visibility = max of the two)
import { jointAngle, toClinicalAngle } from './angle.js'

export const JOINT_CONFIG = {
  knee: {
    left:  { proximal: 23, joint: 25, distal: 27 },
    right: { proximal: 24, joint: 26, distal: 28 },
  },
  hip: {
    left:  { proximal: 11, joint: 23, distal: 25 },
    right: { proximal: 12, joint: 24, distal: 26 },
  },
  shoulder: {
    left:  { proximal: 13, joint: 11, distal: 23 },
    right: { proximal: 14, joint: 12, distal: 24 },
  },
  elbow: {
    left:  { proximal: 11, joint: 13, distal: 15 },
    right: { proximal: 12, joint: 14, distal: 16 },
  },
  ankle: {
    // Proximal = shin midpoint (knee + ankle average) so the knee can be
    // partially out of frame while still capturing the shin's direction.
    left:  { proximal: { midpoint: [25, 27] }, joint: 27, distal: 31 },
    right: { proximal: { midpoint: [26, 28] }, joint: 28, distal: 32 },
  },
}

export const ROLES = ['proximal', 'joint', 'distal']

/**
 * The coordinate space stamp written alongside a stored landmark set.
 *
 * 'video1' = fractions of the RAW per-tick frame buffer (`center.x / videoW`),
 * not the displayed canvas. That deliberately excludes the object-fit: cover
 * crop, the devicePixelRatio and the overlay's scale/offset transform, none of
 * which are properties of the measurement — and it means no landmark can fall
 * outside the stored image. Fractions also survive the SNAPSHOT_MAX_EDGE
 * downscale and any future re-encode.
 *
 * ABSENT on a session = recorded before landmark capture existed. That session
 * is not verifiable and its stored image is the legacy baked composite.
 */
export const LANDMARK_SPACE = 'video1'

/**
 * What kind of thing a landmark is — derived from JOINT_CONFIG, never stored
 * independently of it.
 *
 * NOT EVERY DRAGGABLE POINT IS THE SAME KIND OF THING. Four of the five joints
 * use an anatomical landmark as their proximal point; `ankle` uses
 * `{ midpoint: [knee, ankle] }`, a constructed geometric reference with no
 * anatomy behind it. An editor must label that "shin direction" and never
 * "joint centre", and downstream code must not treat the two as equivalent.
 *
 * @param {string} joint
 * @param {string} side
 * @param {'proximal'|'joint'|'distal'} role
 * @returns {'anatomical'|'derived'|null} null when the joint/side is unknown
 */
export function landmarkKind(joint, side, role) {
  const cfg = JOINT_CONFIG[joint]?.[side]
  if (!cfg || !(role in cfg)) return null
  return typeof cfg[role] === 'number' ? 'anatomical' : 'derived'
}

/**
 * Convert this tick's markers into the normalized set stored on a session.
 *
 * @param {object} markers - from PoseDetector.detect(), centres in video pixels
 * @param {number} videoW  - the frame buffer's width  (NOT the display canvas)
 * @param {number} videoH  - the frame buffer's height
 * @param {string} joint
 * @param {string} side
 * @returns {object|null} { proximal, joint, distal } or null if any role is missing
 */
export function normalizeSet(markers, videoW, videoH, joint, side) {
  if (!markers || !videoW || !videoH) return null

  const set = {}
  for (const role of ROLES) {
    const m = markers[role]
    // All three or nothing: a partial set cannot produce an angle, and storing
    // one would invite a consumer to assume the missing point was at the origin.
    if (!m || !m.center) return null
    set[role] = {
      x:          m.center.x / videoW,
      y:          m.center.y / videoH,
      visibility: m.visibility ?? 1,
      kind:       landmarkKind(joint, side, role),
    }
  }
  return set
}

/**
 * Project a normalized set into a specific image's pixel space.
 *
 * `jointAngle()` is scale- and translation-invariant and every transform in the
 * chain is uniform, so the angle recomputed from these points reproduces the
 * live 2D angle exactly, at any image resolution.
 *
 * @param {object} set - normalized set
 * @param {number} imgW
 * @param {number} imgH
 * @returns {object|null} { proximal, joint, distal } with x/y in image pixels
 */
export function denormalizeSet(set, imgW, imgH) {
  if (!isLandmarkSet(set) || !imgW || !imgH) return null
  const out = {}
  for (const role of ROLES) {
    out[role] = {
      ...set[role],
      x: set[role].x * imgW,
      y: set[role].y * imgH,
    }
  }
  return out
}

/**
 * Whether a value is a usable landmark set. Absence is ordinary — a legacy
 * session has none, and a frame where a landmark dropped below the visibility
 * threshold stored none.
 *
 * @param {*} set
 * @returns {boolean}
 */
export function isLandmarkSet(set) {
  if (!set || typeof set !== 'object') return false
  return ROLES.every(r =>
    set[r] && Number.isFinite(set[r].x) && Number.isFinite(set[r].y)
  )
}

// ─── Recomputing from a set (the verification path) ──────────────────────────

/**
 * The clinical angle a landmark set describes.
 *
 * THE ASPECT RATIO IS NOT OPTIONAL, and getting this wrong is silent.
 * `jointAngle()` is invariant to UNIFORM scale, but a normalized set divides x
 * by the width and y by the height — which is a NON-uniform scaling whenever
 * the frame is not square. Computing an angle straight from the fractions
 * therefore measures the angle in a stretched space and returns a plausible,
 * wrong number: on a 16:9 frame a true 120° reads about 133°. So the set is
 * always projected back into a real pixel space of the frame's own aspect ratio
 * first. Any width/height with that ratio gives the same answer — that part IS
 * scale-invariant — which is why the snapshot's own dimensions are fine even
 * after the SNAPSHOT_MAX_EDGE downscale.
 *
 * Returns the CALIBRATED clinical angle when an offset is supplied, so a
 * verification on a zeroed session is on the same scale as the session's own
 * numbers. The offset is a plain subtraction, exactly as CalibrationManager
 * applies it live.
 *
 * @param {object} set - normalized landmark set
 * @param {object} opts
 * @param {string} opts.joint
 * @param {number} opts.width  - the frame's pixel width  (aspect ratio source)
 * @param {number} opts.height - the frame's pixel height
 * @param {number} [opts.calibrationOffset] - degrees to subtract; 0 when raw
 * @returns {number|null} degrees, rounded to 1dp, or null if not computable
 */
export function recomputeAngle(set, { joint, width, height, calibrationOffset = 0 } = {}) {
  const px = denormalizeSet(set, width, height)
  if (!px) return null

  const interior = jointAngle(px.proximal, px.joint, px.distal)
  if (interior === null) return null

  const clinical = toClinicalAngle(interior, joint)
  if (clinical === null) return null

  return Math.round((clinical - (calibrationOffset ?? 0)) * 10) / 10
}

/**
 * The two segment lengths a set describes, in pixels of the given frame.
 *
 * ADVISORY ONLY — see the "bone length is a diagnostic, not a corrector" rule
 * in CLAUDE.md. A large change while dragging suggests a point has been put
 * somewhere anatomically implausible, but the lengths cannot be LOCKED: the
 * proximal distance is acromion-to-elbow rather than a real bone, and it is a
 * 2D projection already shortened by out-of-plane tilt, so constraining a drag
 * to it would pin the point to a circle of the wrong radius about the wrong
 * centre.
 *
 * @param {object} set
 * @param {number} width
 * @param {number} height
 * @returns {{proximal: number, distal: number}|null}
 */
export function segmentLengths(set, width, height) {
  const px = denormalizeSet(set, width, height)
  if (!px) return null
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  return {
    proximal: d(px.proximal, px.joint),
    distal:   d(px.joint, px.distal),
  }
}

/**
 * How far each point moved between the model's set and a clinician's.
 *
 * DERIVED, NEVER STORED. Which landmark moved is exactly recoverable by
 * comparing the two sets, and storing it separately would create a second
 * source of truth that can disagree with the coordinates it summarises.
 *
 * Distances are in NORMALIZED units against the frame's own axes, so `moved`
 * answers "did this point change" without needing the image; use
 * `segmentLengths` when a pixel distance is what matters.
 *
 * @param {object} raw
 * @param {object} verified
 * @returns {object|null} { proximal: {dx,dy,distance}, joint: …, distal: …, moved: string[] }
 */
export function landmarkDelta(raw, verified) {
  if (!isLandmarkSet(raw) || !isLandmarkSet(verified)) return null
  const out = { moved: [] }
  for (const role of ROLES) {
    const dx = verified[role].x - raw[role].x
    const dy = verified[role].y - raw[role].y
    const distance = Math.hypot(dx, dy)
    out[role] = { dx, dy, distance }
    // A point the clinician looked at and left alone is not "moved"; exact
    // equality is the right test because an untouched point is copied, not
    // recomputed.
    if (dx !== 0 || dy !== 0) out.moved.push(role)
  }
  return out
}

/**
 * Build a verification record. THE ONLY constructor for one.
 *
 * The editor never assembles this shape piecemeal: a half-built record —
 * landmarks without an angle, or angles without attribution — is what the
 * single-column storage design exists to make unrepresentable, and that
 * guarantee is worth nothing if a caller can hand-roll the object.
 *
 * ATTRIBUTION IS NOT QUALIFICATION. `by`/`byMode`/`byDevice` record who and in
 * what mode; this application has no role model and cannot establish that
 * anyone was qualified to measure. Nothing built from this may be described as
 * "validated", "corrected" or "accurate".
 *
 * @param {object} opts
 * @param {object} opts.landmarks - { peak: Set|null, min: Set|null }
 * @param {object} opts.angles    - { max: number|null, min: number|null }
 * @param {string|null} opts.by
 * @param {'account'|'device'} opts.byMode
 * @param {string} opts.byDevice
 * @param {string|null} [opts.modelId]
 * @param {string|null} [opts.modelVersion]
 * @param {string} opts.id  - caller supplies, so the id is generated once
 * @param {number} [opts.at]
 * @returns {object}
 */
export function buildVerification({
  id, at, landmarks, angles, by, byMode, byDevice, modelId, modelVersion,
}) {
  return {
    id,
    at: at ?? Date.now(),
    by: by ?? null,
    // Explicit, never inferred from `by` being null.
    byMode: byMode ?? (by ? 'account' : 'device'),
    byDevice: byDevice ?? null,
    landmarks: {
      peak: landmarks?.peak ?? null,
      min:  landmarks?.min  ?? null,
    },
    // null for an end that was not verified — NOT 0, which would be a reading.
    angles: {
      max: Number.isFinite(angles?.max) ? angles.max : null,
      min: Number.isFinite(angles?.min) ? angles.min : null,
    },
    modelId:      modelId ?? null,
    modelVersion: modelVersion ?? null,
  }
}
