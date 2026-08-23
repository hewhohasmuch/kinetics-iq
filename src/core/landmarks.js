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
