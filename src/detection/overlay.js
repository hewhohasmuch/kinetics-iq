/**
 * overlay.js
 *
 * Draws the AR overlay on a canvas element positioned over the video feed.
 *
 * COORDINATE SYSTEM — this is the critical part:
 *
 * The video element uses object-fit: cover, which means the video stream
 * is scaled and CROPPED to fill the camera-stack div. The canvas sits on
 * top and must match the DISPLAYED image exactly — not the raw video pixels.
 *
 * object-fit: cover scale/crop math:
 *   - Scale factor = max(displayW / videoW, displayH / videoH)
 *   - The video is scaled by that factor, then centered and cropped
 *   - Offset X = (displayW - videoW * scale) / 2  (negative = cropped)
 *   - Offset Y = (displayH - videoH * scale) / 2  (negative = cropped)
 *
 * We set the canvas intrinsic size to match the CSS display size (in real
 * device pixels via devicePixelRatio), then transform marker coordinates
 * from video-space into display-space before drawing.
 *
 * This guarantees dots land exactly on the physical markers regardless of
 * phone orientation, video resolution, or screen size.
 */

const MARKER_COLORS = {
  0: '#60a5fa',
  1: '#4ade80',
  2: '#f472b6',
}
const FALLBACK_COLOR = '#ffffff'
const LINE_COLOR     = 'rgba(255, 255, 255, 0.7)'
const ARC_COLOR      = '#facc15'
const ANGLE_TEXT_BG  = 'rgba(0, 0, 0, 0.65)'
const ANGLE_TEXT_FG  = '#ffffff'

export class Overlay {
  constructor() {
    this.canvas    = null
    this.ctx       = null
    // Stored transform parameters — recomputed on each resize()
    this._scale    = 1
    this._offsetX  = 0
    this._offsetY  = 0
    this._videoW   = 0
    this._videoH   = 0
  }

  attach(canvasElement) {
    this.canvas = canvasElement
    this.ctx    = canvasElement.getContext('2d')
  }

  /**
   * Call this whenever the video starts or the layout changes.
   * Computes the object-fit: cover transform so we can map video
   * coordinates → display coordinates correctly.
   *
   * @param {number} videoW - video.videoWidth  (intrinsic video pixels)
   * @param {number} videoH - video.videoHeight (intrinsic video pixels)
   */
  resize(videoW, videoH) {
    if (!this.canvas || videoW === 0 || videoH === 0) return

    this._videoW = videoW
    this._videoH = videoH

    // Get the CSS display size of the canvas element
    const displayW = this.canvas.clientWidth
    const displayH = this.canvas.clientHeight

    if (displayW === 0 || displayH === 0) return

    // Match canvas intrinsic size to display size × device pixel ratio
    // This prevents blurry drawing on high-DPI (Retina) screens
    const dpr = window.devicePixelRatio || 1
    this.canvas.width  = Math.round(displayW * dpr)
    this.canvas.height = Math.round(displayH * dpr)

    // Scale the context so we can draw in CSS pixels (not device pixels)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // object-fit: cover scale factor:
    // Pick the scale that makes the video FILL the display (not fit inside it)
    const scaleX = displayW / videoW
    const scaleY = displayH / videoH
    this._scale  = Math.max(scaleX, scaleY)

    // Offset: how much the scaled video is shifted to center it
    // (will be negative on the cropped axis — that's correct)
    this._offsetX = (displayW - videoW * this._scale) / 2
    this._offsetY = (displayH - videoH * this._scale) / 2
  }

  /**
   * Convert a point from video pixel space → display CSS pixel space.
   * Apply this to every marker coordinate before drawing.
   */
  _toDisplay(pt) {
    return {
      x: pt.x * this._scale + this._offsetX,
      y: pt.y * this._scale + this._offsetY,
    }
  }

  clear() {
    if (!this.ctx) return
    // Clear in display CSS pixels (transform is already applied)
    this.ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight)
  }

  /**
   * Draw the full overlay for one frame.
   * All marker coordinates are in video pixel space — we convert internally.
   */
  draw(markers, interiorAngle, opts = {}) {
    if (!this.ctx) return
    this.clear()

    const ids = Object.keys(markers).map(Number)
    if (ids.length === 0) {
      this._drawHint('Point camera at markers')
      return
    }

    // Convert all centers to display space up front
    const display = {}
    for (const id of ids) {
      display[id] = {
        ...markers[id],
        displayCenter: this._toDisplay(markers[id].center),
        displayCorners: markers[id].corners.map(c => this._toDisplay(c)),
      }
    }

    // Draw each marker
    for (const id of ids) {
      if (opts.showCorners) {
        this._drawCorners(display[id].displayCorners, MARKER_COLORS[id] || FALLBACK_COLOR)
      }
      this._drawMarkerDot(display[id].displayCenter, MARKER_COLORS[id] || FALLBACK_COLOR, id)
    }

    // Draw bones using explicit ID order: 0→1→2 (thigh→knee→shin)
    // Never sort by position — ID assignment is authoritative
    const m0 = display[0]
    const m1 = display[1]
    const m2 = display[2]

    if (m0 && m1 && m2) {
      this._drawBone(m0.displayCenter, m1.displayCenter)  // thigh → knee
      this._drawBone(m1.displayCenter, m2.displayCenter)  // knee  → shin

      if (interiorAngle !== null && interiorAngle !== undefined) {
        this._drawAngleArc(m0.displayCenter, m1.displayCenter, m2.displayCenter, interiorAngle)
        this._drawAngleLabel(m1.displayCenter, 180 - interiorAngle)
      }
    } else {
      // Partial lines for whatever is visible
      if (m0 && m1) this._drawBone(m0.displayCenter, m1.displayCenter)
      if (m1 && m2) this._drawBone(m1.displayCenter, m2.displayCenter)
      this._drawMissingWarning(ids.length)
    }
  }

  // ─── Private drawing helpers ─────────────────────────────────────────
  // All coordinates here are already in display CSS pixel space.
  // _scalePx() scales UI element sizes (dots, line widths) relative to
  // the display height so they look consistent on all screen sizes.

  _drawMarkerDot(center, color, id) {
    const r   = this._scalePx(12)
    const ctx = this.ctx

    ctx.beginPath()
    ctx.arc(center.x, center.y, r, 0, Math.PI * 2)
    ctx.fillStyle   = color
    ctx.globalAlpha = 0.9
    ctx.fill()

    ctx.strokeStyle = 'rgba(0,0,0,0.5)'
    ctx.lineWidth   = this._scalePx(2)
    ctx.stroke()

    ctx.globalAlpha  = 1
    ctx.fillStyle    = '#000'
    ctx.font         = `bold ${this._scalePx(10)}px -apple-system, sans-serif`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(id.toString(), center.x, center.y)
  }

  _drawBone(from, to) {
    const ctx = this.ctx
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.strokeStyle = LINE_COLOR
    ctx.lineWidth   = this._scalePx(2.5)
    ctx.globalAlpha = 0.8
    ctx.setLineDash([this._scalePx(7), this._scalePx(4)])
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }

  _drawAngleArc(proximal, joint, distal, interiorAngleDeg) {
    const ctx    = this.ctx
    const angle1 = Math.atan2(proximal.y - joint.y, proximal.x - joint.x)
    const angle2 = Math.atan2(distal.y   - joint.y, distal.x   - joint.x)
    const r      = this._scalePx(36)

    ctx.beginPath()
    ctx.arc(joint.x, joint.y, r, angle1, angle2)
    ctx.strokeStyle = ARC_COLOR
    ctx.lineWidth   = this._scalePx(2.5)
    ctx.globalAlpha = 0.9
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  _drawAngleLabel(joint, flexionDeg) {
    const ctx      = this.ctx
    const text     = `${Math.round(flexionDeg)}°`
    const fontSize = this._scalePx(26)
    const ox       = this._scalePx(46)
    const oy       = this._scalePx(-18)
    const x        = joint.x + ox
    const y        = joint.y + oy
    const pad      = this._scalePx(5)

    ctx.font         = `bold ${fontSize}px -apple-system, sans-serif`
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'

    const metrics = ctx.measureText(text)
    const boxW    = metrics.width + pad * 2
    const boxH    = fontSize + pad * 2

    ctx.fillStyle   = ANGLE_TEXT_BG
    ctx.globalAlpha = 0.85
    this._roundRect(x - pad, y - boxH / 2, boxW, boxH, this._scalePx(5))
    ctx.fill()

    ctx.globalAlpha = 1
    ctx.fillStyle   = ANGLE_TEXT_FG
    ctx.fillText(text, x, y)
  }

  _drawMissingWarning(foundCount) {
    const ctx  = this.ctx
    const text = `${foundCount}/3 markers`
    const displayH = this.canvas.clientHeight

    ctx.font         = `${this._scalePx(16)}px -apple-system, sans-serif`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = '#facc15'
    ctx.globalAlpha  = 0.9
    ctx.fillText(text, this.canvas.clientWidth / 2, displayH - this._scalePx(50))
    ctx.globalAlpha  = 1
  }

  _drawHint(text) {
    const ctx = this.ctx
    ctx.font         = `${this._scalePx(16)}px -apple-system, sans-serif`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = 'rgba(255,255,255,0.4)'
    ctx.fillText(text, this.canvas.clientWidth / 2, this.canvas.clientHeight - this._scalePx(50))
  }

  _drawCorners(corners, color) {
    const ctx = this.ctx
    const r   = this._scalePx(4)
    ctx.fillStyle   = color
    ctx.globalAlpha = 0.6
    for (const c of corners) {
      ctx.beginPath()
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  /**
   * Scale a size value relative to the display height.
   * Reference: 700px display height = 1× scale.
   * Keeps dots and text consistently sized on all phones.
   */
  _scalePx(value) {
    if (!this.canvas) return value
    const displayH = this.canvas.clientHeight || 700
    return value * (displayH / 700)
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r)
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x + r, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - r)
    ctx.lineTo(x, y + r)
    ctx.quadraticCurveTo(x, y, x + r, y)
    ctx.closePath()
  }
}
