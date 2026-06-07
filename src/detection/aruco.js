/**
 * aruco.js
 *
 * Wraps js-aruco2 which is loaded as a plain <script> tag (public/aruco.js).
 * The detector is constructed lazily on first use — this avoids any
 * script load order dependency between aruco.js and the ES module bundle.
 */

export const MARKER_ROLES = {
  PROXIMAL: 0,
  JOINT:    1,
  DISTAL:   2,
}

export class ArucoDetector {
  constructor() {
    // Do NOT construct window.AR.Detector here.
    // aruco.js (classic script) and the app bundle (ES module) both use
    // defer, but browsers do not guarantee classic-before-module ordering
    // when both are deferred. We construct lazily on first detect() call.
    this._detector = null
    this.lastDetectedIds = []
  }

  /**
   * Lazily initialize the AR.Detector on first call.
   * By the time the user taps "Start Camera" and frames start arriving,
   * aruco.js is guaranteed to have loaded.
   */
  _getDetector() {
    if (this._detector) return this._detector

    if (!window.AR || !window.AR.Detector) {
      console.warn('window.AR not ready yet — aruco.js may still be loading')
      return null
    }

    this._detector = new window.AR.Detector({ dictionaryName: 'ARUCO_4X4_1000' })
    return this._detector
  }

  detect(imageData) {
    if (!imageData) {
      return { markers: {}, rawMarkers: [], allFound: false, foundIds: [] }
    }

    const detector = this._getDetector()
    if (!detector) {
      // aruco.js not ready yet — return empty result, try again next frame
      return { markers: {}, rawMarkers: [], allFound: false, foundIds: [] }
    }

    let rawMarkers = []
    try {
      rawMarkers = detector.detect(imageData)
    } catch (e) {
      console.warn('ArUco detection error:', e)
      return { markers: {}, rawMarkers: [], allFound: false, foundIds: [] }
    }

    const markers = {}
    for (const raw of rawMarkers) {
      markers[raw.id] = {
        id:      raw.id,
        corners: raw.corners,
        center:  this._computeCenter(raw.corners),
      }
    }

    const foundIds = Object.keys(markers).map(Number)
    const allFound = MARKER_ROLES.PROXIMAL in markers
                  && MARKER_ROLES.JOINT    in markers
                  && MARKER_ROLES.DISTAL   in markers

    this.lastDetectedIds = foundIds
    return { markers, rawMarkers, allFound, foundIds }
  }

  getJointPoints(markers) {
    const p = markers[MARKER_ROLES.PROXIMAL]
    const j = markers[MARKER_ROLES.JOINT]
    const d = markers[MARKER_ROLES.DISTAL]
    if (!p || !j || !d) return null
    return {
      proximal: p.center,
      joint:    j.center,
      distal:   d.center,
    }
  }

  _computeCenter(corners) {
    const x = corners.reduce((sum, c) => sum + c.x, 0) / corners.length
    const y = corners.reduce((sum, c) => sum + c.y, 0) / corners.length
    return { x, y }
  }
}
