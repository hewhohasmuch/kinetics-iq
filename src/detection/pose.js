import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { JOINT_CONFIG } from '../core/landmarks.js'

const WASM_CDN  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task'
const MIN_VISIBILITY = 0.3

/**
 * Which model produced a session's landmarks, stamped onto the record.
 *
 * The validation dataset must be analysable by model version: the retained
 * `verified - frameAngleRaw` delta characterises THIS model's bias, and
 * records that cannot say which model they came from pool two different
 * instruments into one distribution. Bump MODEL_VERSION whenever MODEL_URL or
 * the @mediapipe/tasks-vision dependency changes.
 */
export const MODEL_ID      = 'blazepose-full'
export const MODEL_VERSION = 'tasks-vision@0.10.35+float16/latest'

// The landmark index table moved to core/landmarks.js — it is data about
// anatomy, and the stored landmark set derives each point's `kind` from it, so
// asking that question must not require importing MediaPipe. Re-exported here
// because this remains the natural place to look for it.
export { JOINT_CONFIG }

export class PoseDetector {
  constructor() {
    this._landmarker  = null
    this._ready       = false
    this._initPromise = null
    this.joint        = 'knee'
    this.side         = 'right'
  }

  // Load MediaPipe WASM and model. Safe to call multiple times — deduplicates.
  init() {
    if (this._initPromise) return this._initPromise
    this._initPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM_CDN)
      this._landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numPoses: 1,
      })
      this._ready = true
    })()
    return this._initPromise
  }

  // Drop-in replacement for ArucoDetector.detect().
  //
  // `source` is any TexImageSource — a video element or a canvas; MediaPipe's
  // detectForVideo accepts either. IN THIS APP IT IS ALWAYS A CANVAS:
  // MeasureView passes its per-tick frame buffer so detection and the stored
  // snapshot read the same pixels (see the frame-grab comment in
  // MeasureView._runDetection()). Named `source` rather than `videoElement`
  // for that reason — the old name outlived the thing it described and had to
  // be corrected in CLAUDE.md before it misled someone into reading the live
  // <video> here.
  //
  // Returns { markers, allFound, foundIds } with centers in video pixel space.
  detect(source) {
    if (!this._ready || !source) {
      return { markers: {}, allFound: false, foundIds: [] }
    }

    const result = this._landmarker.detectForVideo(source, performance.now())

    if (!result.landmarks || result.landmarks.length === 0) {
      return { markers: {}, allFound: false, foundIds: [] }
    }

    const lmNorm = result.landmarks[0]
    // Metric 3D landmarks (meters, relative to hip midpoint). May be absent for
    // a frame — callers fall back to the 2D center when world is undefined.
    const wlm    = result.worldLandmarks?.[0] ?? null
    // An HTMLVideoElement exposes videoWidth/videoHeight; a canvas exposes
    // width/height. MeasureView passes the latter.
    const vw     = source.videoWidth ?? source.width
    const vh     = source.videoHeight ?? source.height
    const cfg    = JOINT_CONFIG[this.joint][this.side]

    const markers = {}
    let   allFound = true

    for (const role of ['proximal', 'joint', 'distal']) {
      const resolved = this._resolveLandmark(cfg[role], lmNorm, vw, vh, wlm)
      if (!resolved) {
        allFound = false
        continue
      }
      markers[role] = {
        id:         role,
        center:     { x: resolved.x, y: resolved.y },
        world:      resolved.world,   // { x, y, z } in meters, or undefined
        corners:    [],
        visibility: resolved.visibility,
      }
    }

    return {
      markers,
      allFound: allFound && Object.keys(markers).length === 3,
      foundIds: Object.keys(markers),
    }
  }

  // Resolve a landmark config entry to { x, y, visibility } in video pixel space,
  // or null if below the visibility threshold.
  _resolveLandmark(cfg, lmNorm, vw, vh, wlm = null) {
    if (typeof cfg === 'number') {
      const lm = lmNorm[cfg]
      if (!lm || lm.visibility < MIN_VISIBILITY) return null
      const w = wlm?.[cfg]
      return {
        x:          lm.x * vw,
        y:          lm.y * vh,
        visibility: lm.visibility,
        world:      w ? { x: w.x, y: w.y, z: w.z } : undefined,
      }
    }
    if (cfg.midpoint) {
      const [a, b] = cfg.midpoint
      const lmA = lmNorm[a], lmB = lmNorm[b]
      if (!lmA || !lmB) return null
      // Both landmarks must be visible — if the knee is out of frame the
      // midpoint would be unreliable and cause jumping dots
      if (lmA.visibility < MIN_VISIBILITY || lmB.visibility < MIN_VISIBILITY) return null
      const wA = wlm?.[a], wB = wlm?.[b]
      return {
        x:          ((lmA.x + lmB.x) / 2) * vw,
        y:          ((lmA.y + lmB.y) / 2) * vh,
        visibility: Math.max(lmA.visibility, lmB.visibility),
        world:      (wA && wB)
          ? { x: (wA.x + wB.x) / 2, y: (wA.y + wB.y) / 2, z: (wA.z + wB.z) / 2 }
          : undefined,
      }
    }
    return null
  }

  // Drop-in replacement for ArucoDetector.getJointPoints().
  // Returns 2D { x, y } video-pixel points — used for the overlay and as the
  // fallback when 3D world data is unavailable.
  getJointPoints(markers) {
    const p = markers['proximal']
    const j = markers['joint']
    const d = markers['distal']
    if (!p || !j || !d) return null
    return {
      proximal: p.center,
      joint:    j.center,
      distal:   d.center,
    }
  }

  // 3D variant — returns world-space { x, y, z } points in meters so the angle
  // is computed in real space (immune to camera-perspective foreshortening).
  // Returns null if any marker lacks world data; the caller then falls back to
  // the 2D getJointPoints() so a bad frame degrades rather than drops.
  getJointPoints3D(markers) {
    const p = markers['proximal']
    const j = markers['joint']
    const d = markers['distal']
    if (!p || !j || !d) return null
    if (!p.world || !j.world || !d.world) return null
    return {
      proximal: p.world,
      joint:    j.world,
      distal:   d.world,
    }
  }

  /**
   * How far the joint's two segments lie OUT OF THE IMAGE PLANE, in degrees.
   *
   * WHY THIS EXISTS: the measured angle is computed from the 2D image points
   * (see MeasureView._runDetection), and that is only the joint angle when the
   * limb moves parallel to the image plane. A segment tilted toward or away
   * from the camera projects SHORT, and the angle reads low. Comparing each
   * segment's in-plane projection against its world-space length recovers that
   * tilt with no ground truth needed:
   *
   *   ratio = |seg_xy| / |seg_xyz|      tilt = acos(ratio)
   *
   * COARSE ON PURPOSE. The world lengths it divides by come from the same
   * depth estimate the 3D angle path was dropped for: measured across two
   * frames of one subject, rigid bone lengths drift ~8% RMS, which is ~23 deg
   * of apparent tilt near zero. So this catches GROSS off-axis filming and
   * nothing finer. Show the clinician a caution, never a number.
   *
   * Returns the larger of the two segments' tilt, or null when any marker
   * lacks world data -- the same condition getJointPoints3D() returns null on.
   *
   * @param {object} markers - from detect()
   * @returns {number|null} degrees; 0 = the segment lies in the image plane
   */
  segmentTilt(markers) {
    const p = markers['proximal']
    const j = markers['joint']
    const d = markers['distal']
    if (!p || !j || !d) return null
    if (!p.world || !j.world || !d.world) return null

    const tilt = (a, b) => {
      const dx = a.world.x - b.world.x
      const dy = a.world.y - b.world.y
      const dz = a.world.z - b.world.z
      const xyz = Math.sqrt(dx * dx + dy * dy + dz * dz)
      // A zero-length segment has no direction in which to be tilted.
      if (xyz < 1e-6) return 0
      const xy = Math.sqrt(dx * dx + dy * dy)
      // xy > xyz is geometrically impossible but reachable in floating point,
      // and acos would hand back NaN.
      return Math.acos(Math.min(1, xy / xyz)) * (180 / Math.PI)
    }

    return Math.max(tilt(p, j), tilt(j, d))
  }

  setJoint(joint) { this.joint = joint }
  setSide(side)   { this.side  = side  }

  get isReady() { return this._ready }
}
