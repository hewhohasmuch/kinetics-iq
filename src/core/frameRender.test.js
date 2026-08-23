/**
 * frameRender.test.js
 *
 * The branching, not the pixels. Which set gets drawn on a frame — and whether
 * anything is drawn at all — is where a wrong picture comes from: a legacy
 * snapshot drawn over twice, or a verified session still showing the model's
 * points beside a clinician's number.
 *
 * The actual drawing is pinned by the call-sequence tests in
 * detection/overlay.test.js; the canvas work is covered end-to-end.
 */

import { describe, it, expect } from 'vitest'
import { hasRenderableLandmarks, frameLandmarks, renderFrame, frameScale } from './frameRender.js'

const set = (x = 0.5) => ({
  proximal: { x, y: 0.2, visibility: 0.9, kind: 'anatomical' },
  joint:    { x, y: 0.5, visibility: 0.9, kind: 'anatomical' },
  distal:   { x, y: 0.8, visibility: 0.9, kind: 'anatomical' },
})

const current = {
  joint: 'knee',
  landmarkSpace: 'video1',
  landmarksRaw: { peak: set(0.5), min: set(0.4) },
}

// A session recorded before landmark capture: its stored image already has the
// overlay burned into the pixels.
const legacy = { joint: 'knee', min: 5, max: 120 }

describe('hasRenderableLandmarks', () => {

  it('accepts a session stamped with the landmark space and carrying evidence', () => {
    expect(hasRenderableLandmarks(current)).toBe(true)
  })

  it('REJECTS a legacy session — its overlay is already in the pixels', () => {
    // Drawing over it would put a second skeleton on top of the first.
    expect(hasRenderableLandmarks(legacy)).toBe(false)
  })

  it('rejects a stamped session whose evidence is absent', () => {
    expect(hasRenderableLandmarks({ ...current, landmarksRaw: null })).toBe(false)
  })

  it('tolerates null and undefined sessions', () => {
    expect(hasRenderableLandmarks(null)).toBe(false)
    expect(hasRenderableLandmarks(undefined)).toBe(false)
  })
})

describe('frameLandmarks', () => {

  it('returns the raw set when nothing has been verified', () => {
    expect(frameLandmarks(current, 'peak')).toEqual(current.landmarksRaw.peak)
    expect(frameLandmarks(current, 'min')).toEqual(current.landmarksRaw.min)
  })

  it('PREFERS a clinician\'s verified set over the model\'s', () => {
    // The picture must show the points that produced the number beside it.
    const verified = set(0.77)
    const s = { ...current, verifications: [{ landmarks: { peak: verified, min: null } }] }
    expect(frameLandmarks(s, 'peak')).toEqual(verified)
  })

  it('falls back to raw for an end that was not verified', () => {
    // Partial verification is legitimate — one usable snapshot, or only the end
    // that matters.
    const s = { ...current, verifications: [{ landmarks: { peak: set(0.77), min: null } }] }
    expect(frameLandmarks(s, 'min')).toEqual(current.landmarksRaw.min)
  })

  it('reads the LAST verification, so appended history stays compatible', () => {
    const newer = set(0.9)
    const s = {
      ...current,
      verifications: [
        { landmarks: { peak: set(0.6), min: null } },
        { landmarks: { peak: newer,    min: null } },
      ],
    }
    expect(frameLandmarks(s, 'peak')).toEqual(newer)
  })

  it('returns null for a legacy session', () => {
    expect(frameLandmarks(legacy, 'peak')).toBeNull()
  })

  it('returns null when the stored set is incomplete', () => {
    // A frame captured while a landmark was below the visibility threshold has
    // a picture but nothing to draw on it.
    const s = { ...current, landmarksRaw: { peak: { joint: { x: 0.5, y: 0.5 } }, min: null } }
    expect(frameLandmarks(s, 'peak')).toBeNull()
    expect(frameLandmarks(s, 'min')).toBeNull()
  })
})

describe('renderFrame — degrading without losing the picture', () => {

  const blob = { size: 123, type: 'image/jpeg' }   // opaque; never decoded here

  it('returns the ORIGINAL blob unchanged when there is nothing to draw', async () => {
    // A legacy composite must come back untouched, not be dropped: a silently
    // absent picture looks like a session that never captured one.
    expect(await renderFrame(blob, null, { joint: 'knee', labelAngle: 120 })).toBe(blob)
  })

  it('returns the original blob for an incomplete set', async () => {
    expect(await renderFrame(blob, { joint: { x: 1, y: 1 } }, { joint: 'knee' })).toBe(blob)
  })

  it('passes a missing blob straight through', async () => {
    expect(await renderFrame(null, set(), { joint: 'knee' })).toBeNull()
  })
})

describe('frameScale — legibility on a stored frame', () => {

  it('references the LONGEST edge, not the height', () => {
    // A landscape video buffer must not be sized as though it were only as
    // wide as it is tall. 1280x720 against the 700px reference:
    expect(frameScale(1280, 720)).toBeCloseTo(1280 / 700, 10)
  })

  it('is orientation-independent', () => {
    // The same frame rotated must draw the overlay at the same size.
    expect(frameScale(1280, 720)).toBe(frameScale(720, 1280))
  })

  it('scales up for a higher-resolution capture', () => {
    // A 1080p buffer holds the same scene in more pixels, so the overlay must
    // grow with it or it shrinks away when the frame is displayed small.
    expect(frameScale(1920, 1080)).toBeGreaterThan(frameScale(1280, 720))
  })

  it('does not collapse to zero on a degenerate size', () => {
    expect(frameScale(0, 0)).toBe(1)
    expect(frameScale(undefined, undefined)).toBe(1)
  })
})
