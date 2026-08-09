import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

const WASM_CDN  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task'
const MIN_VISIBILITY = 0.3

// MediaPipe landmark indices (subject-anatomical left/right).
// proximal/joint/distal can be:
//   - a number: single landmark index
//   - { midpoint: [a, b] }: average of two landmarks (visibility = max of the two)
const JOINT_CONFIG = {
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
  // Takes a video element OR a canvas (MediaPipe's detectForVideo accepts
  // either as a TexImageSource). MeasureView passes its per-tick frame-buffer
  // canvas so detection and the stored snapshot read the same pixels — see the
  // frame-grab comment in MeasureView._runDetection().
  // Returns { markers, allFound, foundIds } with centers in video pixel space.
  detect(videoElement) {
    if (!this._ready || !videoElement) {
      return { markers: {}, allFound: false, foundIds: [] }
    }

    const result = this._landmarker.detectForVideo(videoElement, performance.now())

    if (!result.landmarks || result.landmarks.length === 0) {
      return { markers: {}, allFound: false, foundIds: [] }
    }

    const lmNorm = result.landmarks[0]
    // Metric 3D landmarks (meters, relative to hip midpoint). May be absent for
    // a frame — callers fall back to the 2D center when world is undefined.
    const wlm    = result.worldLandmarks?.[0] ?? null
    // videoElement may be an HTMLVideoElement (videoWidth/videoHeight) or an
    // HTMLCanvasElement (width/height) — MeasureView passes the latter.
    const vw     = videoElement.videoWidth ?? videoElement.width
    const vh     = videoElement.videoHeight ?? videoElement.height
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

  setJoint(joint) { this.joint = joint }
  setSide(side)   { this.side  = side  }

  get isReady() { return this._ready }
}
