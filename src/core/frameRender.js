/**
 * frameRender.js
 *
 * Draws the overlay onto a stored snapshot AT VIEW TIME.
 *
 * WHY THE OVERLAY IS NO LONGER BURNED IN AT CAPTURE
 * Snapshots used to be a flattened composite of video + dots + arc + label, so
 * there was no clean frame anywhere. That is fine while a picture is only ever
 * looked at, and fatal the moment a clinician can move a landmark: dragging on
 * a baked composite shows the new skeleton over the old one, with a stale
 * number printed beside the new one — two contradicting angles on one picture,
 * which is exactly what "one value, everywhere" exists to prevent.
 *
 * Storing the clean frame plus the landmarks and rendering here STRENGTHENS
 * that rule rather than bending it: the label is drawn from the saved record,
 * so it cannot be a historical artefact of the capture moment that later
 * disagrees with the record beside it.
 *
 * ONE RENDERER. The drawing primitives come from detection/overlay.js — the
 * same ones the live view uses — so a snapshot shows what the clinician saw.
 *
 * LEGACY FRAMES ARE NOT RE-RENDERED. A session without `landmarkSpace` was
 * captured as a baked composite and has no stored landmarks; callers must show
 * its image as-is. Drawing over it would double the skeleton.
 *
 * WHY THIS LIVES IN core/ DESPITE TOUCHING A CANVAS
 * It takes a Blob and returns a Blob, with no DOM tree access — the same shape
 * as pdf.js, which is in core for the same reason. It is a documented exception
 * to the "core is pure" rule, alongside storage.js (localStorage) and
 * sync.js/frames.js (network).
 */

import { drawPoseOverlay, scaleFor } from '../detection/overlay.js'
import { denormalizeSet, isLandmarkSet } from './landmarks.js'
import { toInteriorAngle } from './angle.js'

/**
 * Whether a session's frames should have the overlay drawn at view time.
 *
 * Absence of `landmarkSpace` is the legacy marker and is a positive fact about
 * the stored image, not a missing field to paper over: that image already has
 * the overlay in its pixels.
 *
 * @param {object} session
 * @returns {boolean}
 */
export function hasRenderableLandmarks(session) {
  return Boolean(session?.landmarkSpace) && Boolean(session?.landmarksRaw)
}

/**
 * The landmark set to draw on one of a session's two frames, or null.
 *
 * Prefers a clinician's verified set over the model's raw one, so a verified
 * session's pictures show the points that produced the number beside them.
 *
 * @param {object} session
 * @param {'peak'|'min'} which
 * @returns {object|null}
 */
export function frameLandmarks(session, which) {
  if (!hasRenderableLandmarks(session)) return null
  const verified = session.verifications?.[session.verifications.length - 1]
  const set = verified?.landmarks?.[which] ?? session.landmarksRaw?.[which] ?? null
  return isLandmarkSet(set) ? set : null
}

async function decode(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob)
  // Safari before 15 lacks createImageBitmap for blobs.
  const url = URL.createObjectURL(blob)
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload  = () => resolve(img)
      img.onerror = () => reject(new Error('image decode failed'))
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Size multiplier for the overlay drawn onto a STORED frame.
 *
 * WHY THIS IS NOT simply `scaleFor(height)`, which is what the live view uses.
 * The live overlay draws on the camera canvas — a portrait rectangle roughly
 * 430x700, where 700 is its LONG edge and the 700px reference was chosen
 * against it. A stored frame is the raw video buffer, typically LANDSCAPE
 * (1280x720, 1920x1080), where the height is the SHORT edge. Referencing the
 * height there sizes the overlay as though the frame were only 720 across when
 * it is really 1280+, and the dots and angle label come out roughly half the
 * size they should be — illegible once two frames sit side by side on a phone.
 *
 * Referencing the LONGEST edge is orientation-independent and reproduces the
 * apparent size the burned-in overlay used to have.
 *
 * @param {number} w
 * @param {number} h
 * @returns {number}
 */
export function frameScale(w, h) {
  return scaleFor(Math.max(w || 0, h || 0))
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function toBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality })
  return new Promise(resolve => canvas.toBlob(resolve, type, quality))
}

/**
 * Render one stored frame with its overlay drawn on top.
 *
 * Returns the ORIGINAL blob unchanged when there is nothing to draw — a legacy
 * baked composite, a frame whose landmarks did not survive, or a decode
 * failure. A caller can therefore always display what it gets back, and a
 * missing overlay degrades to "the picture without annotations" rather than to
 * no picture at all.
 *
 * @param {Blob} blob - the stored snapshot
 * @param {object|null} set - normalized landmark set for this frame
 * @param {object} opts
 * @param {string} opts.joint       - for the per-joint angle convention
 * @param {number|null} opts.labelAngle - the clinical value to print; must be the
 *                        number the record reports for this extreme
 * @returns {Promise<Blob>}
 */
export async function renderFrame(blob, set, { joint, labelAngle = null } = {}) {
  if (!blob || !isLandmarkSet(set)) return blob

  try {
    const img = await decode(blob)
    const w = img.width
    const h = img.height
    if (!w || !h) return blob

    const canvas = makeCanvas(w, h)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, w, h)

    // Normalized fractions → this image's own pixel space. jointAngle() is
    // scale- and translation-invariant, so the geometry drawn here is the same
    // geometry that produced the number, at any resolution.
    const points = denormalizeSet(set, w, h)

    drawPoseOverlay(ctx, points, {
      // The arc is gated on an angle existing, exactly as it is live.
      interiorAngle: toInteriorAngle(labelAngle, joint),
      labelAngle,
      scale: frameScale(w, h),
    })

    if (img.close) img.close()

    const out = await toBlob(canvas, 'image/jpeg', 0.9)
    return out || blob
  } catch (_) {
    // A frame that will not decode is still worth showing unannotated.
    return blob
  }
}
