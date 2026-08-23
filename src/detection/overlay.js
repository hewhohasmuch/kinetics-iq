/**
 * overlay.js
 *
 * Draws the AR overlay — landmark dots, bones, angle arc and label.
 *
 * TWO CALLERS, ONE RENDERER. The `Overlay` class draws live over the video;
 * `core/frameRender.js` draws the same graphics onto a stored snapshot at view
 * time. They share the exported primitives below and, above them,
 * `drawPoseOverlay()`. That sharing is the point: the live view and the stored
 * frame cannot drift apart into two slightly different pictures of one
 * measurement, which is the same "one value, everywhere" rule the angle chain
 * follows.
 *
 * The primitives take an explicit `ctx` and `scale` instead of reading class
 * state, so they work on any 2D context — a display canvas transformed by
 * devicePixelRatio, or an offscreen canvas at a JPEG's natural size.
 *
 * COORDINATE SYSTEM — this is the critical part for the LIVE overlay:
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
 *
 * WHAT REACHES THE STORED FRAME, AND WHAT DOES NOT. The devicePixelRatio and
 * the display offsets are live-display concerns and stay here — a snapshot
 * keeps raw frame-buffer pixels and normalized landmarks. The CROP is the one
 * part that does travel: a snapshot stores only the region this transform
 * leaves visible, because that is the picture the clinician framed and judged
 * (see core/frameCrop.js). Both sides therefore read the crop from
 * `coverTransform()` rather than each deriving their own.
 */

import { coverTransform } from '../core/frameCrop.js'

export const MARKER_COLORS = {
  proximal: '#60a5fa',
  joint:    '#4ade80',
  distal:   '#f472b6',
}
export const FALLBACK_COLOR = '#ffffff'
const LINE_COLOR     = 'rgba(255, 255, 255, 0.7)'
const ARC_COLOR      = '#facc15'
const ANGLE_TEXT_BG  = 'rgba(0, 0, 0, 0.65)'
const ANGLE_TEXT_FG  = '#ffffff'

/** Reference height at which UI elements draw at 1× (see scaleFor). */
const REFERENCE_HEIGHT = 700

/**
 * Size multiplier for dots, line widths and text, relative to the canvas
 * height, so the overlay looks the same on a phone screen and on a
 * full-resolution stored frame.
 *
 * @param {number} heightPx
 * @returns {number}
 */
export function scaleFor(heightPx) {
  return (heightPx || REFERENCE_HEIGHT) / REFERENCE_HEIGHT
}

// ─── Primitives ───────────────────────────────────────────────────────────────
// All coordinates are already in the target context's own pixel space.

export function drawLandmarkDot(ctx, center, color, visibility = 1, scale = 1) {
  const r = 10 * scale

  ctx.beginPath()
  ctx.arc(center.x, center.y, r, 0, Math.PI * 2)
  ctx.fillStyle   = color
  ctx.globalAlpha = 0.85
  ctx.fill()
  ctx.globalAlpha = 1

  // Confidence ring — dashed when visibility is low
  ctx.beginPath()
  ctx.arc(center.x, center.y, r + 3 * scale, 0, Math.PI * 2)
  ctx.strokeStyle = color
  ctx.lineWidth   = 1.5 * scale
  ctx.globalAlpha = visibility
  if (visibility < 0.7) ctx.setLineDash([3 * scale, 3 * scale])
  ctx.stroke()
  ctx.setLineDash([])
  ctx.globalAlpha = 1
}

export function drawBone(ctx, from, to, scale = 1) {
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.strokeStyle = LINE_COLOR
  ctx.lineWidth   = 2.5 * scale
  ctx.globalAlpha = 0.8
  ctx.setLineDash([7 * scale, 4 * scale])
  ctx.stroke()
  ctx.setLineDash([])
  ctx.globalAlpha = 1
}

/**
 * The arc between the two segments.
 *
 * It is swept between the DRAWN point directions, so it always agrees with the
 * bones beside it. The angle VALUE is not an input here — that is the label's
 * job, and the label is handed the one smoothed value the readout shows.
 */
export function drawAngleArc(ctx, proximal, joint, distal, scale = 1) {
  const angle1 = Math.atan2(proximal.y - joint.y, proximal.x - joint.x)
  const angle2 = Math.atan2(distal.y   - joint.y, distal.x   - joint.x)

  ctx.beginPath()
  ctx.arc(joint.x, joint.y, 36 * scale, angle1, angle2)
  ctx.strokeStyle = ARC_COLOR
  ctx.lineWidth   = 2.5 * scale
  ctx.globalAlpha = 0.9
  ctx.stroke()
  ctx.globalAlpha = 1
}

export function drawAngleLabel(ctx, joint, flexionDeg, scale = 1) {
  const text     = `${Math.round(flexionDeg)}°`
  const fontSize = 26 * scale
  const x        = joint.x + 46 * scale
  const y        = joint.y - 18 * scale
  const pad      = 5 * scale

  ctx.font         = `bold ${fontSize}px -apple-system, sans-serif`
  ctx.textAlign    = 'left'
  ctx.textBaseline = 'middle'

  const metrics = ctx.measureText(text)
  const boxW    = metrics.width + pad * 2
  const boxH    = fontSize + pad * 2

  ctx.fillStyle   = ANGLE_TEXT_BG
  ctx.globalAlpha = 0.85
  roundRect(ctx, x - pad, y - boxH / 2, boxW, boxH, 5 * scale)
  ctx.fill()

  ctx.globalAlpha = 1
  ctx.fillStyle   = ANGLE_TEXT_FG
  ctx.fillText(text, x, y)
}

export function roundRect(ctx, x, y, w, h, r) {
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

// ─── The shared renderer ──────────────────────────────────────────────────────

/**
 * Draw the full skeleton — dots, bones, arc, label — into any 2D context.
 *
 * THE ONE RENDERER both the live overlay and the stored-frame render call, so a
 * snapshot shows exactly what the clinician saw while measuring.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} points - { proximal?, joint?, distal? }, each { x, y, visibility? },
 *                          already in this context's pixel space
 * @param {object} opts
 * @param {number|null} [opts.interiorAngle] - gates the arc and label; null when
 *                        no angle was resolvable for this frame
 * @param {number|null} [opts.labelAngle]    - the clinical value to print. Must be
 *                        the same number the readout shows; falls back to the
 *                        hinge convention only when absent.
 * @param {number} [opts.scale]
 * @param {boolean} [opts.showLabel] - false suppresses the printed angle. The
 *                        editor sets this: it shows a much larger live readout
 *                        of its own, and a label on the canvas sits exactly
 *                        where the finger is dragging.
 * @returns {number} how many of the three roles were drawn (callers use this to
 *                   decide whether to show a "n/3 landmarks" warning)
 */
export function drawPoseOverlay(ctx, points, opts = {}) {
  const { interiorAngle = null, labelAngle = null, scale = 1, showLabel = true } = opts

  const roles = ['proximal', 'joint', 'distal'].filter(r => points?.[r])
  for (const role of roles) {
    drawLandmarkDot(ctx, points[role], MARKER_COLORS[role] || FALLBACK_COLOR,
                    points[role].visibility ?? 1, scale)
  }

  const p = points?.proximal
  const j = points?.joint
  const d = points?.distal

  if (p && j && d) {
    drawBone(ctx, p, j, scale)
    drawBone(ctx, j, d, scale)

    if (interiorAngle !== null && interiorAngle !== undefined) {
      drawAngleArc(ctx, p, j, d, scale)
      // The clinical value differs per joint (see JOINT_ANGLE_CONVENTION in
      // angle.js), so it is supplied by the caller — the one value that also
      // reaches the readout, the recorder and the snapshots. Deriving it here
      // would fork that into a second, joint-blind number.
      if (showLabel) drawAngleLabel(ctx, j, labelAngle ?? (180 - interiorAngle), scale)
    }
  } else {
    if (p && j) drawBone(ctx, p, j, scale)
    if (j && d) drawBone(ctx, j, d, scale)
  }

  return roles.length
}

// ─── The live overlay ─────────────────────────────────────────────────────────

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
    // Sub-rect of the video the display shows; null until resize() runs.
    this._visible  = null
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
    // Dropped up front, not on the way out: every path below that gives up —
    // an unmeasurable layout, a stream that has changed size — must leave the
    // crop UNKNOWN rather than let a stale rect describe a different picture.
    // A capture then stores the whole frame, which is merely wider.
    this._visible = null

    // Get the CSS display size of the canvas element
    const displayW = this.canvas.clientWidth
    const displayH = this.canvas.clientHeight

    if (displayW === 0 || displayH === 0) return

    // The cover maths lives in core/frameCrop.js because the CAPTURE needs the
    // same answer: the stored snapshot is cropped to the region this transform
    // leaves visible. Two implementations of it would let the drawn picture and
    // the stored one drift apart, which is the failure this file exists to
    // prevent.
    const cover = coverTransform(videoW, videoH, displayW, displayH)
    if (!cover) return

    // Match canvas intrinsic size to display size × device pixel ratio
    // This prevents blurry drawing on high-DPI (Retina) screens
    const dpr = window.devicePixelRatio || 1
    this.canvas.width  = Math.round(displayW * dpr)
    this.canvas.height = Math.round(displayH * dpr)

    // Scale the context so we can draw in CSS pixels (not device pixels)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Scale that makes the video FILL the display (not fit inside it), and the
    // offsets that centre it — negative on the cropped axis, which is correct.
    this._scale   = cover.scale
    this._offsetX = cover.offsetX
    this._offsetY = cover.offsetY
    // The sub-rect of the VIDEO that survives the crop, in video pixels. This
    // is what the clinician can actually see, so it is what a snapshot stores.
    this._visible = cover.visible
  }

  /**
   * The region of the video the display is currently showing, in video pixel
   * space — i.e. what the clinician is looking at.
   *
   * Returns null until resize() has run against these exact video dimensions,
   * and the caller must treat that as "crop unknown" (store the whole frame),
   * never as "nothing visible".
   *
   * @param {number} [videoW] - assert the rect belongs to this stream size
   * @param {number} [videoH]
   * @returns {{x,y,width,height}|null}
   */
  visibleVideoRect(videoW, videoH) {
    if (!this._visible) return null
    if (videoW && videoH && (videoW !== this._videoW || videoH !== this._videoH)) return null
    return this._visible
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
   *
   * @param {object}      markers       - proximal/joint/distal, video pixel space
   * @param {number|null} interiorAngle - geometric angle at the joint, for the arc
   * @param {object}      opts
   * @param {string}      [opts.joint]      - joint name, for setup hints
   * @param {number|null} [opts.labelAngle] - clinical angle to print; must be the
   *                        same value the readout shows.
   */
  draw(markers, interiorAngle, opts = {}) {
    if (!this.ctx) return
    this.clear()

    const roles = Object.keys(markers)
    if (roles.length === 0) {
      const hint = opts.joint === 'ankle'
        ? 'Frame knee to foot · big toe toward camera'
        : 'Point camera at subject'
      this._drawHint(hint)
      return
    }

    if (opts.joint === 'ankle') {
      this._drawSetupHint('Frame knee to foot · big toe toward camera')
    }

    // Convert all centers to display space up front, then hand the shared
    // renderer plain points — the same call the stored frame makes.
    const points = {}
    for (const role of roles) {
      points[role] = {
        ...this._toDisplay(markers[role].center),
        visibility: markers[role].visibility ?? 1,
      }
    }

    const drawn = drawPoseOverlay(this.ctx, points, {
      interiorAngle,
      labelAngle: opts.labelAngle,
      scale:      scaleFor(this.canvas.clientHeight),
    })

    if (drawn < 3) this._drawMissingWarning(drawn)
  }

  // ─── Live-only chrome ────────────────────────────────────────────────
  // Hints and warnings belong to the camera view, not to a stored record:
  // "2/3 landmarks" is advice about how to hold the phone RIGHT NOW, and
  // printing it onto a saved snapshot would caption a finished measurement
  // with a transient instruction.

  _drawMissingWarning(foundCount) {
    const ctx  = this.ctx
    const text = `${foundCount}/3 landmarks`
    const scale = scaleFor(this.canvas.clientHeight)

    ctx.font         = `${16 * scale}px -apple-system, sans-serif`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = '#facc15'
    ctx.globalAlpha  = 0.9
    ctx.fillText(text, this.canvas.clientWidth / 2, this.canvas.clientHeight - 50 * scale)
    ctx.globalAlpha  = 1
  }

  _drawSetupHint(text) {
    const ctx = this.ctx
    const scale = scaleFor(this.canvas.clientHeight)
    ctx.font         = `${12 * scale}px -apple-system, sans-serif`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle    = 'rgba(250,204,21,0.75)'
    ctx.fillText(text, this.canvas.clientWidth / 2, 12 * scale)
  }

  _drawHint(text) {
    const ctx = this.ctx
    const scale = scaleFor(this.canvas.clientHeight)
    ctx.font         = `${16 * scale}px -apple-system, sans-serif`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = 'rgba(255,255,255,0.4)'
    ctx.fillText(text, this.canvas.clientWidth / 2, this.canvas.clientHeight - 50 * scale)
  }
}
