import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

const WASM_CDN  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task'
const MIN_VISIBILITY = 0.5

// MediaPipe landmark indices (subject-anatomical left/right).
// Each entry is { proximal, joint, distal } landmark indices.
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
    left:  { proximal: 25, joint: 27, distal: 31 },
    right: { proximal: 26, joint: 28, distal: 32 },
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
  // Takes a video element directly (MediaPipe processes it natively).
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
    const vw     = videoElement.videoWidth
    const vh     = videoElement.videoHeight
    const cfg    = JOINT_CONFIG[this.joint][this.side]

    const markers = {}
    let   allFound = true

    for (const role of ['proximal', 'joint', 'distal']) {
      const idx = cfg[role]
      const lm  = lmNorm[idx]
      if (!lm || lm.visibility < MIN_VISIBILITY) {
        allFound = false
        continue
      }
      markers[role] = {
        id:         role,
        center:     { x: lm.x * vw, y: lm.y * vh },
        corners:    [],
        visibility: lm.visibility,
      }
    }

    return {
      markers,
      allFound: allFound && Object.keys(markers).length === 3,
      foundIds: Object.keys(markers),
    }
  }

  // Drop-in replacement for ArucoDetector.getJointPoints().
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

  setJoint(joint) { this.joint = joint }
  setSide(side)   { this.side  = side  }

  get isReady() { return this._ready }
}
