/**
 * frameCrop.js
 *
 * The geometry of "what the clinician actually saw".
 *
 * The live video element uses `object-fit: cover`, so the camera stack shows a
 * CROP of the video stream — scaled to fill the div and centred, with the
 * overflowing axis cut off. Everything the clinician frames, watches and judges
 * during a bout happens inside that crop.
 *
 * The stored snapshot used to be the whole frame buffer. That is a different
 * picture from the one that was recorded: on a portrait phone against a 16:9
 * stream, more than half of it is off-screen scenery the clinician never saw,
 * and it shrinks the part that carries the measurement — the three landmarks
 * and the limb between them — to a fraction of the exported page and of the
 * landmark editor's canvas, where one pixel is worth about a degree.
 *
 * So the crop is computed here, applied at capture time, and the landmarks are
 * normalized against it: what you recorded is what you get.
 *
 * PURE LOGIC — no DOM, no canvas, no browser API. `detection/overlay.js` uses
 * `coverTransform()` for its own live display transform, so the cover maths has
 * exactly one implementation and the stored crop cannot drift from the drawn
 * one.
 */

/** Extra room kept around a landmark that falls outside the visible crop, as a
 *  fraction of the video's shorter edge — enough that its dot is not clipped. */
const OUTSIDE_MARGIN_FRAC = 0.04

/**
 * The `object-fit: cover` mapping between a video stream and a display box.
 *
 *   scale   = max(displayW / videoW, displayH / videoH)   — FILL, not fit
 *   offset  = how far the scaled video is shifted to centre it, in display px
 *             (negative on the cropped axis — that is correct)
 *   visible = the sub-rect of the VIDEO that survives the crop, in video px
 *
 * @param {number} videoW
 * @param {number} videoH
 * @param {number} displayW
 * @param {number} displayH
 * @returns {{scale: number, offsetX: number, offsetY: number,
 *            visible: {x: number, y: number, width: number, height: number}}|null}
 *          null when any dimension is zero — a layout that has not settled yet,
 *          which callers must treat as "no crop known", never as an empty one.
 */
export function coverTransform(videoW, videoH, displayW, displayH) {
  if (!videoW || !videoH || !displayW || !displayH) return null

  const scale = Math.max(displayW / videoW, displayH / videoH)

  // One axis is the full video by construction; min() only absorbs float error.
  const width  = Math.min(videoW, displayW / scale)
  const height = Math.min(videoH, displayH / scale)

  return {
    scale,
    offsetX: (displayW - videoW * scale) / 2,
    offsetY: (displayH - videoH * scale) / 2,
    visible: {
      x: (videoW - width)  / 2,
      y: (videoH - height) / 2,
      width,
      height,
    },
  }
}

/**
 * Grow a rect until it contains every given point, with a margin, staying
 * inside the video bounds.
 *
 * WHY THE CROP IS NOT SIMPLY THE VISIBLE RECT. A landmark can sit outside what
 * the camera stack showed — the subject was framed loosely, or a hip is just
 * past the edge while the knee and ankle are dead centre. Cropping it away
 * would put a stored point outside its own image: `frameRender` would draw a
 * dot in the wrong place and the landmark editor could not show, let alone
 * drag, a point it cannot address. So the crop yields to the evidence. It stays
 * "what you saw" in the ordinary case and degrades to something slightly wider
 * in the case where the alternative is a picture that contradicts its record.
 *
 * @param {{x,y,width,height}} rect - starting rect, in video px
 * @param {Array<{x: number, y: number}>} points - in video px
 * @param {number} videoW
 * @param {number} videoH
 * @param {number} [margin] - px kept beyond an outside point
 * @returns {{x,y,width,height}}
 */
export function expandRectToPoints(rect, points, videoW, videoH,
                                   margin = Math.min(videoW, videoH) * OUTSIDE_MARGIN_FRAC) {
  let left   = rect.x
  let top    = rect.y
  let right  = rect.x + rect.width
  let bottom = rect.y + rect.height

  for (const p of points || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    left   = Math.min(left,   p.x - margin)
    top    = Math.min(top,    p.y - margin)
    right  = Math.max(right,  p.x + margin)
    bottom = Math.max(bottom, p.y + margin)
  }

  left   = Math.max(0, left)
  top    = Math.max(0, top)
  right  = Math.min(videoW, right)
  bottom = Math.min(videoH, bottom)

  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Snap a rect to whole video pixels, clamped to the frame.
 *
 * Integer bounds let the capture copy the region 1:1 — no resampling, and no
 * sub-pixel disagreement between the pixels stored and the rect the landmarks
 * were normalized against.
 *
 * @param {{x,y,width,height}} rect
 * @param {number} videoW
 * @param {number} videoH
 * @returns {{x,y,width,height}}
 */
export function snapRect(rect, videoW, videoH) {
  const x = Math.max(0, Math.min(videoW - 1, Math.floor(rect.x)))
  const y = Math.max(0, Math.min(videoH - 1, Math.floor(rect.y)))
  return {
    x,
    y,
    width:  Math.max(1, Math.min(videoW - x, Math.round(rect.width))),
    height: Math.max(1, Math.min(videoH - y, Math.round(rect.height))),
  }
}

/**
 * The region of the frame buffer a snapshot should store: the visible crop,
 * widened to hold any landmark outside it, snapped to whole pixels.
 *
 * THE ONE PLACE that decides what a stored frame contains. It is composed here
 * rather than at the capture site so the decision is unit-testable — `src/ui/`
 * has no unit tests, and this rule governs what a clinician later drags points
 * on and what gets filed into a chart.
 *
 * @param {{x,y,width,height}|null} visible - from coverTransform(); null = unknown
 * @param {Array<{x: number, y: number}>} points - landmark centres, video px
 * @param {number} videoW
 * @param {number} videoH
 * @returns {{x,y,width,height}} always a usable rect — the whole frame when the
 *          visible region is unknown, so a snapshot is never lost to a layout
 *          that had not settled.
 */
export function storedFrameRect(visible, points, videoW, videoH) {
  const full = { x: 0, y: 0, width: videoW, height: videoH }
  if (!videoW || !videoH) return full
  if (!visible || !visible.width || !visible.height) return full

  return snapRect(expandRectToPoints(visible, points, videoW, videoH), videoW, videoH)
}
