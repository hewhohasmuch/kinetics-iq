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

import { occluderGeometry } from '../core/headRegion.js'

const MARKER_COLORS = {
  proximal: '#60a5fa',
  joint:    '#4ade80',
  distal:   '#f472b6',
}
const FALLBACK_COLOR = '#ffffff'
const LINE_COLOR     = 'rgba(255, 255, 255, 0.7)'
const ARC_COLOR      = '#facc15'
const ANGLE_TEXT_BG  = 'rgba(0, 0, 0, 0.65)'
const ANGLE_TEXT_FG  = '#ffffff'

// Fill used when no colour could be sampled from the frame. Deliberately a mid
// neutral rather than near-black: it reads as a deliberate mask rather than as
// a hole punched in the picture.
const OCCLUDER_FALLBACK = { r: 107, g: 114, b: 128 }
const OUTLINE_COLOR     = 'rgba(255,255,255,0.30)'
const SAMPLE_GRID       = 8      // 8x8 = 64 samples, regardless of video resolution
const SAMPLE_RING       = 1.45   // sample box extends to this multiple of the head
const FILL_SMOOTHING    = 0.2    // EMA factor, so the fill does not flicker frame to frame

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
    // Reused across frames — a fresh canvas per frame at 10Hz is needless GC churn.
    this._sampleCanvas = null
    // Exponentially smoothed occluder fill, so the colour does not flicker.
    this._fill = null
  }

  attach(canvasElement) {
    this.canvas = canvasElement
    this.ctx    = canvasElement.getContext('2d')
  }

  /**
   * What this device actually did — stamped onto the session record.
   *
   * A constant, unlike the blur version which reported 'blur1' or 'solid1'
   * depending on Canvas 2D filter support. Nothing about an opaque fill is
   * device-dependent, so a branch here would only ever be able to lie.
   */
  get redactionMode() {
    return 'mask1'
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
   *
   * @param {object}      markers       - proximal/joint/distal, video pixel space
   * @param {number|null} interiorAngle - geometric angle at the joint, for the arc
   * @param {object}      opts
   * @param {string}      [opts.joint]      - joint name, for setup hints
   * @param {number|null} [opts.labelAngle] - clinical angle to print; must be the
   *                        same value the readout shows. Falls back to the hinge
   *                        convention when absent.
   * @param {object|null} [opts.head] - head ellipse in video pixel space, to mask
   * @param {HTMLCanvasElement|null} [opts.video] - frame buffer, for the fill colour sample only
   */
  draw(markers, interiorAngle, opts = {}) {
    if (!this.ctx) return
    this.clear()

    // BEFORE the no-markers early return below. Losing the joint landmarks
    // mid-session — patient shifts, limb leaves frame — must not un-blur the
    // preview at exactly the moment the clinician looks at the screen to fix it.
    this._drawRedaction(opts.head ?? null, opts.video ?? null)

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

    // Convert all centers to display space up front
    const display = {}
    for (const role of roles) {
      display[role] = {
        ...markers[role],
        displayCenter: this._toDisplay(markers[role].center),
      }
    }

    // Draw landmark dots
    for (const role of roles) {
      this._drawLandmarkDot(
        display[role].displayCenter,
        MARKER_COLORS[role] || FALLBACK_COLOR,
        display[role].visibility ?? 1,
      )
    }

    const p = display['proximal']
    const j = display['joint']
    const d = display['distal']

    if (p && j && d) {
      this._drawBone(p.displayCenter, j.displayCenter)
      this._drawBone(j.displayCenter, d.displayCenter)

      if (interiorAngle !== null && interiorAngle !== undefined) {
        this._drawAngleArc(p.displayCenter, j.displayCenter, d.displayCenter, interiorAngle)
        // The clinical value differs per joint (see JOINT_ANGLE_CONVENTION in
        // angle.js), so it is supplied by the caller — the one value that also
        // reaches the readout, the recorder and the snapshots. Deriving it here
        // would fork that into a second, joint-blind number.
        this._drawAngleLabel(
          j.displayCenter,
          opts.labelAngle ?? (180 - interiorAngle),
        )
      }
    } else {
      if (p && j) this._drawBone(p.displayCenter, j.displayCenter)
      if (j && d) this._drawBone(j.displayCenter, d.displayCenter)
      this._drawMissingWarning(roles.length)
    }
  }

  // ─── Private drawing helpers ─────────────────────────────────────────
  // All coordinates here are already in display CSS pixel space.
  // _scalePx() scales UI element sizes (dots, line widths) relative to
  // the display height so they look consistent on all screen sizes.

  /**
   * Mask the patient's head out of the frame with an opaque occluder.
   *
   * Drawn into the OVERLAY canvas, which is what makes the live preview and the
   * stored snapshot agree by construction: MeasureView._captureFrameTo()
   * composites this same canvas over the video frame, so both surfaces come
   * from this one code path and cannot drift apart.
   *
   * WHY THIS IS NOT A BLUR ANY MORE. The blur version needed six things to be
   * simultaneously correct — a source rect mapped out of display space and back
   * into video space, a scratch canvas sized in device pixels, a blur radius
   * scaled by dpr, an opaque pre-fill, padding to keep the filter's transparent
   * fade outside the clip, and Canvas 2D `filter` actually taking effect. Five
   * of those cannot be verified headless. On-device they produced a mask that
   * was both displaced and barely blurred, while the session still stamped
   * 'blur1' and the detail view still reported success. Nothing here samples a
   * patch and nothing here sets a filter, so neither failure is reachable.
   *
   * WHAT IS DRAWN: an opaque ellipse out to the containment boundary, a feather
   * from there outwards, and a thin outline so it reads as UI rather than as a
   * smudge or a fault. THE CORE STAYS FULLY OPAQUE — all softening is outside
   * it, over background pixels that were never part of the head.
   *
   * @param {{cx,cy,rAcross,rAlong,ux,uy}|null} head - VIDEO pixel space
   * @param {HTMLCanvasElement|null} frame - per-tick frame buffer, for the colour sample only
   */
  _drawRedaction(head, frame) {
    if (!head) return

    const display = {
      cx:      head.cx * this._scale + this._offsetX,
      cy:      head.cy * this._scale + this._offsetY,
      rAcross: head.rAcross * this._scale,
      rAlong:  head.rAlong  * this._scale,
      ux:      head.ux,
      uy:      head.uy,
    }
    const g = occluderGeometry(display)
    if (!g) return

    const c = this._occluderFill(head, frame)
    const solid       = `rgb(${c.r}, ${c.g}, ${c.b})`
    const transparent = `rgba(${c.r}, ${c.g}, ${c.b}, 0)`

    const ctx = this.ctx

    // ── Opaque core + feather ────────────────────────────────────────
    // Built as a unit circle in a space scaled to the FEATHER extent, so the
    // gradient stretches with the ellipse. innerStop is where the opaque core
    // ends; everything before it is at full alpha.
    ctx.save()
    // Set explicitly: the helpers in this file leave globalAlpha dirty, and a
    // translucent redaction leaks the sharp face straight through — in the
    // snapshot and the live view alike, since both sit over raw video pixels.
    ctx.globalAlpha = 1
    ctx.filter = 'none'
    ctx.translate(g.cx, g.cy)
    ctx.rotate(g.rotation)
    ctx.scale(g.feather.rAcross, g.feather.rAlong)

    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
    grad.addColorStop(0, solid)
    grad.addColorStop(g.innerStop, solid)
    grad.addColorStop(1, transparent)
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(0, 0, 1, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    // ── Outline ──────────────────────────────────────────────────────
    // Drawn WITHOUT the non-uniform scale above — a stroke under that scale
    // would come out thicker on one axis than the other.
    ctx.save()
    ctx.globalAlpha = 1
    ctx.translate(g.cx, g.cy)
    ctx.rotate(g.rotation)
    ctx.beginPath()
    ctx.ellipse(0, 0, g.outline.rAcross, g.outline.rAlong, 0, 0, Math.PI * 2)
    ctx.strokeStyle = OUTLINE_COLOR
    ctx.lineWidth   = this._scalePx(2)
    ctx.stroke()
    ctx.restore()
  }

  /**
   * The occluder's fill colour: one average of the frame OUTSIDE the head,
   * smoothed across frames.
   *
   * A single averaged colour carries no recoverable facial detail — this is
   * emphatically not the patch sampling the blur version did. Sampling is
   * bounded to SAMPLE_GRID^2 points regardless of video resolution, so the
   * cost does not scale with the camera.
   *
   * A failure here costs the colour, never the redaction: it falls back to
   * OCCLUDER_FALLBACK rather than returning and leaving the face sharp.
   */
  _occluderFill(head, frame) {
    const sample = this._sampleNeutral(head, frame)
    if (sample) {
      this._fill = this._fill
        ? {
            r: this._fill.r + FILL_SMOOTHING * (sample.r - this._fill.r),
            g: this._fill.g + FILL_SMOOTHING * (sample.g - this._fill.g),
            b: this._fill.b + FILL_SMOOTHING * (sample.b - this._fill.b),
          }
        : sample
    }
    const c = this._fill ?? OCCLUDER_FALLBACK
    return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) }
  }

  /** @returns {{r,g,b}|null} average of frame pixels OUTSIDE the head ellipse */
  _sampleNeutral(head, frame) {
    if (!frame || typeof document === 'undefined') return null
    // Deliberately broad: any failure here must cost only the fill colour,
    // never the redaction. A narrowed catch that rethrows would propagate out
    // of _occluderFill and skip the draw entirely, leaving the face sharp.
    try {
      // Axis-aligned half-extents of the oriented ellipse.
      const hx = Math.hypot(head.rAcross * head.uy, head.rAlong * head.ux) * SAMPLE_RING
      const hy = Math.hypot(head.rAcross * head.ux, head.rAlong * head.uy) * SAMPLE_RING
      const bx = head.cx - hx, by = head.cy - hy
      const bw = 2 * hx,       bh = 2 * hy
      if (!(bw > 0) || !(bh > 0)) return null

      const N = SAMPLE_GRID
      if (!this._sampleCanvas) this._sampleCanvas = document.createElement('canvas')
      const cv = this._sampleCanvas
      if (cv.width !== N || cv.height !== N) { cv.width = N; cv.height = N }
      const sctx = cv.getContext('2d', { willReadFrequently: true })
      sctx.clearRect(0, 0, N, N)
      sctx.drawImage(frame, bx, by, bw, bh, 0, 0, N, N)
      const { data } = sctx.getImageData(0, 0, N, N)

      const px = -head.uy, py = head.ux
      let r = 0, g = 0, b = 0, n = 0
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          // Centre of this sample cell, back in video pixel space.
          const sx = bx + ((i + 0.5) / N) * bw
          const sy = by + ((j + 0.5) / N) * bh
          const dx = sx - head.cx, dy = sy - head.cy
          const across = dx * px + dy * py
          const along  = dx * head.ux + dy * head.uy
          // Skip anything inside the head — sampling the face would tint the
          // mask toward skin, which is the opposite of blending into the room.
          if (Math.hypot(across / head.rAcross, along / head.rAlong) <= 1) continue
          const k = (j * N + i) * 4
          if (data[k + 3] === 0) continue     // off the edge of the frame
          r += data[k]; g += data[k + 1]; b += data[k + 2]; n++
        }
      }
      return n ? { r: r / n, g: g / n, b: b / n } : null
    } catch (_) {
      return null
    }
  }

  _drawLandmarkDot(center, color, visibility = 1) {
    const r   = this._scalePx(10)
    const ctx = this.ctx

    ctx.beginPath()
    ctx.arc(center.x, center.y, r, 0, Math.PI * 2)
    ctx.fillStyle   = color
    ctx.globalAlpha = 0.85
    ctx.fill()
    ctx.globalAlpha = 1

    // Confidence ring — dashed when visibility is low
    ctx.beginPath()
    ctx.arc(center.x, center.y, r + this._scalePx(3), 0, Math.PI * 2)
    ctx.strokeStyle = color
    ctx.lineWidth   = this._scalePx(1.5)
    ctx.globalAlpha = visibility
    if (visibility < 0.7) ctx.setLineDash([this._scalePx(3), this._scalePx(3)])
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
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
    const text = `${foundCount}/3 landmarks`
    const displayH = this.canvas.clientHeight

    ctx.font         = `${this._scalePx(16)}px -apple-system, sans-serif`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = '#facc15'
    ctx.globalAlpha  = 0.9
    ctx.fillText(text, this.canvas.clientWidth / 2, displayH - this._scalePx(50))
    ctx.globalAlpha  = 1
  }

  _drawSetupHint(text) {
    const ctx = this.ctx
    ctx.font         = `${this._scalePx(12)}px -apple-system, sans-serif`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle    = 'rgba(250,204,21,0.75)'
    ctx.fillText(text, this.canvas.clientWidth / 2, this._scalePx(12))
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
