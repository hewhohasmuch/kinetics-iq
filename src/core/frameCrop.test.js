/**
 * frameCrop.test.js
 *
 * The crop decides what a clinician later drags landmarks on and what gets
 * filed into a chart, and `src/ui/` has no unit tests — so the rule lives in a
 * pure module and is pinned here, on both sides of every boundary it draws.
 */

import { describe, it, expect } from 'vitest'
import { coverTransform, expandRectToPoints, snapRect, storedFrameRect } from './frameCrop.js'

describe('coverTransform — the object-fit: cover mapping', () => {

  it('crops the WIDTH when a landscape stream fills a portrait box', () => {
    // 1280×720 into a 430×700 camera stack: scale is set by the height, and
    // more than half the stream's width falls off both edges.
    const t = coverTransform(1280, 720, 430, 700)
    expect(t.scale).toBeCloseTo(700 / 720, 10)
    expect(t.visible.height).toBe(720)                        // uncropped axis
    expect(t.visible.width).toBeCloseTo(430 / t.scale, 6)
    expect(t.visible.x).toBeCloseTo((1280 - t.visible.width) / 2, 6)
    expect(t.visible.y).toBe(0)
    // The clinician saw about a third of the frame — the rest is why exports
    // looked mostly like scenery.
    expect(t.visible.width / 1280).toBeLessThan(0.4)
  })

  it('crops the HEIGHT when a portrait stream fills a wider box', () => {
    const t = coverTransform(720, 1280, 390, 500)
    expect(t.scale).toBeCloseTo(390 / 720, 10)
    expect(t.visible.width).toBe(720)
    expect(t.visible.height).toBeCloseTo(500 / t.scale, 6)
    expect(t.visible.x).toBe(0)
    expect(t.visible.y).toBeCloseTo((1280 - t.visible.height) / 2, 6)
  })

  it('is the whole frame when the aspects match — cropping is then a no-op', () => {
    const t = coverTransform(1280, 720, 640, 360)
    expect(t.visible).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
  })

  it('agrees with the offsets the live overlay draws with', () => {
    // Same numbers on both sides of the transform: a point at the left edge of
    // the visible rect must land at display x = 0.
    const t = coverTransform(1280, 720, 430, 700)
    const displayX = t.visible.x * t.scale + t.offsetX
    expect(displayX).toBeCloseTo(0, 6)
    expect((t.visible.x + t.visible.width) * t.scale + t.offsetX).toBeCloseTo(430, 6)
  })

  it('returns null — not an empty rect — before the layout has settled', () => {
    // A caller must read this as "crop unknown" and store the whole frame,
    // never as "nothing was visible".
    expect(coverTransform(1280, 720, 0, 700)).toBeNull()
    expect(coverTransform(0, 0, 430, 700)).toBeNull()
  })
})

describe('expandRectToPoints — the crop yields to the evidence', () => {

  const rect = { x: 400, y: 0, width: 400, height: 720 }

  it('leaves the rect alone when every point is already inside it', () => {
    const points = [{ x: 500, y: 100 }, { x: 640, y: 400 }, { x: 700, y: 600 }]
    expect(expandRectToPoints(rect, points, 1280, 720, 30)).toEqual(rect)
  })

  it('grows to hold a landmark that fell outside, with a margin', () => {
    const out = expandRectToPoints(rect, [{ x: 320, y: 180 }], 1280, 720, 30)
    expect(out.x).toBe(290)
    expect(out.x + out.width).toBe(800)
  })

  it('never grows past the frame itself', () => {
    const out = expandRectToPoints(rect, [{ x: 5, y: 5 }], 1280, 720, 30)
    expect(out.x).toBe(0)
    expect(out.y).toBe(0)
  })

  it('ignores missing or non-finite points instead of collapsing the rect', () => {
    // A role can be absent for this frame; that is ordinary, not a reason to
    // store a different picture.
    expect(expandRectToPoints(rect, [undefined, null, { x: NaN, y: 3 }], 1280, 720, 30)).toEqual(rect)
    expect(expandRectToPoints(rect, undefined, 1280, 720, 30)).toEqual(rect)
  })
})

describe('snapRect — whole pixels, so the copy resamples nothing', () => {

  it('rounds to integers inside the frame', () => {
    const out = snapRect({ x: 418.86, y: 0, width: 442.29, height: 720 }, 1280, 720)
    expect(Object.values(out).every(Number.isInteger)).toBe(true)
    expect(out).toEqual({ x: 418, y: 0, width: 442, height: 720 })
  })

  it('clamps a rect that would run past the right or bottom edge', () => {
    const out = snapRect({ x: 1200, y: 700, width: 200, height: 200 }, 1280, 720)
    expect(out.x + out.width).toBe(1280)
    expect(out.y + out.height).toBe(720)
  })

  it('never produces a zero-sized region', () => {
    const out = snapRect({ x: 0, y: 0, width: 0.2, height: 0.2 }, 1280, 720)
    expect(out.width).toBe(1)
    expect(out.height).toBe(1)
  })
})

describe('storedFrameRect — what a snapshot actually contains', () => {

  const inView = [{ x: 500, y: 180 }, { x: 640, y: 540 }, { x: 760, y: 300 }]

  it('is the visible crop when the landmarks are inside it', () => {
    const visible = coverTransform(1280, 720, 430, 700).visible
    const rect = storedFrameRect(visible, inView, 1280, 720)
    expect(rect).toEqual({ x: 418, y: 0, width: 442, height: 720 })
  })

  it('keeps every stored landmark inside its own image', () => {
    // The property the landmark editor depends on: a point it cannot address
    // is a point a clinician cannot verify. Here the proximal landmark sits
    // well outside the visible crop, so the crop widens rather than dropping it.
    const outside = [{ x: 120, y: 180 }, { x: 640, y: 540 }, { x: 760, y: 300 }]
    const visible = coverTransform(1280, 720, 430, 700).visible
    const rect = storedFrameRect(visible, outside, 1280, 720)

    for (const p of outside) {
      expect((p.x - rect.x) / rect.width).toBeGreaterThanOrEqual(0)
      expect((p.x - rect.x) / rect.width).toBeLessThanOrEqual(1)
      expect((p.y - rect.y) / rect.height).toBeGreaterThanOrEqual(0)
      expect((p.y - rect.y) / rect.height).toBeLessThanOrEqual(1)
    }
  })

  it('falls back to the WHOLE frame when the visible region is unknown', () => {
    // A layout that has not settled must cost a wider picture, never a lost
    // snapshot — the measurement is already over by the time this is noticed.
    expect(storedFrameRect(null, inView, 1280, 720)).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
    expect(storedFrameRect({ x: 0, y: 0, width: 0, height: 0 }, inView, 1280, 720))
      .toEqual({ x: 0, y: 0, width: 1280, height: 720 })
  })

  it('crops meaningfully less area than the buffer it came from', () => {
    const visible = coverTransform(1280, 720, 430, 700).visible
    const rect = storedFrameRect(visible, inView, 1280, 720)
    expect(rect.width * rect.height).toBeLessThan(0.4 * 1280 * 720)
  })
})
