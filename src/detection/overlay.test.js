/**
 * overlay.test.js
 *
 * `drawPoseOverlay` is the ONE renderer the live view and the stored snapshot
 * both call. Pixel equality is not testable in Vitest and would be flaky in a
 * browser, so what is pinned here is the SEQUENCE OF DRAW CALLS — the same
 * approach pdf.test.js uses to assert what a document is told to draw.
 *
 * The single most important assertion in this file is that the label prints the
 * angle it was HANDED. Deriving one here would fork "one value, everywhere"
 * into a second, joint-blind number the readout never showed.
 */

import { describe, it, expect } from 'vitest'
import { drawPoseOverlay, scaleFor, MARKER_COLORS, Overlay } from './overlay.js'
import { coverTransform } from '../core/frameCrop.js'

function fakeCtx() {
  const calls = []
  const rec = (name) => (...args) => { calls.push([name, ...args]) }
  return {
    calls,
    beginPath: rec('beginPath'),
    arc:       rec('arc'),
    fill:      rec('fill'),
    stroke:    rec('stroke'),
    moveTo:    rec('moveTo'),
    lineTo:    rec('lineTo'),
    quadraticCurveTo: rec('quadraticCurveTo'),
    closePath: rec('closePath'),
    setLineDash: rec('setLineDash'),
    fillText:  rec('fillText'),
    measureText: (t) => ({ width: String(t).length * 10 }),
    fillStyle: '', strokeStyle: '', lineWidth: 0,
    globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
  }
}

const points = {
  proximal: { x: 100, y: 100, visibility: 0.9 },
  joint:    { x: 200, y: 200, visibility: 0.95 },
  distal:   { x: 300, y: 100, visibility: 0.8 },
}

const names = (ctx) => ctx.calls.map(c => c[0])
const textDrawn = (ctx) => ctx.calls.filter(c => c[0] === 'fillText').map(c => c[1])

describe('drawPoseOverlay — the label is the value it was given', () => {

  it('prints the supplied labelAngle, rounded', () => {
    const ctx = fakeCtx()
    drawPoseOverlay(ctx, points, { interiorAngle: 90, labelAngle: 121.8 })
    expect(textDrawn(ctx)).toEqual(['122°'])
  })

  it('prints a NEGATIVE label as signed — extension is the measurement', () => {
    const ctx = fakeCtx()
    drawPoseOverlay(ctx, points, { interiorAngle: 185, labelAngle: -4.2 })
    expect(textDrawn(ctx)).toEqual(['-4°'])
  })

  it('does NOT re-derive the label from the geometry', () => {
    // The drawn points describe 90°, but the supplied clinical value is 121.8.
    // A joint-blind `180 - interior` here would print 90° and contradict the
    // readout, the recorder and the record.
    const ctx = fakeCtx()
    drawPoseOverlay(ctx, points, { interiorAngle: 90, labelAngle: 121.8 })
    expect(textDrawn(ctx)).not.toContain('90°')
  })

  it('falls back to the hinge convention only when no label is supplied', () => {
    const ctx = fakeCtx()
    drawPoseOverlay(ctx, points, { interiorAngle: 60 })
    expect(textDrawn(ctx)).toEqual(['120°'])
  })
})

describe('drawPoseOverlay — what gets drawn', () => {

  it('draws a dot and a confidence ring for each of the three roles', () => {
    const ctx = fakeCtx()
    drawPoseOverlay(ctx, points, { interiorAngle: 90, labelAngle: 90 })
    // 3 roles × (dot + ring) = 6 arcs, plus one angle arc.
    expect(ctx.calls.filter(c => c[0] === 'arc')).toHaveLength(7)
  })

  it('draws both bones', () => {
    const ctx = fakeCtx()
    drawPoseOverlay(ctx, points, {})
    expect(ctx.calls.filter(c => c[0] === 'moveTo')).toHaveLength(2)
  })

  it('omits the arc and label when no angle was resolvable', () => {
    const ctx = fakeCtx()
    drawPoseOverlay(ctx, points, { interiorAngle: null, labelAngle: null })
    expect(textDrawn(ctx)).toEqual([])
    // 6 arcs for the dots and rings, none for the angle.
    expect(ctx.calls.filter(c => c[0] === 'arc')).toHaveLength(6)
  })

  it('returns how many roles it drew, so the caller can warn', () => {
    expect(drawPoseOverlay(fakeCtx(), points, {})).toBe(3)
    const { distal, ...partial } = points
    expect(drawPoseOverlay(fakeCtx(), partial, {})).toBe(2)
  })

  it('draws the partial bone but no arc when a landmark is missing', () => {
    const ctx = fakeCtx()
    const { distal, ...partial } = points
    drawPoseOverlay(ctx, partial, { interiorAngle: 90, labelAngle: 90 })
    expect(ctx.calls.filter(c => c[0] === 'moveTo')).toHaveLength(1)
    expect(textDrawn(ctx)).toEqual([])
  })

  it('survives an empty point set without throwing', () => {
    expect(drawPoseOverlay(fakeCtx(), {}, {})).toBe(0)
    expect(drawPoseOverlay(fakeCtx(), null, {})).toBe(0)
  })
})

describe('drawPoseOverlay — deterministic rendering', () => {

  it('produces an identical call sequence for the same input', () => {
    // The invariant the stored frame depends on: re-rendering a snapshot must
    // not drift from what was drawn live, or from the last time it was viewed.
    const a = fakeCtx(), b = fakeCtx()
    const opts = { interiorAngle: 52.4, labelAngle: 127.6, scale: 1.5 }
    drawPoseOverlay(a, points, opts)
    drawPoseOverlay(b, points, opts)
    expect(a.calls).toEqual(b.calls)
  })

  it('scales geometry with the scale factor, not the coordinates', () => {
    // Landmark positions are already in the target space; only element SIZES
    // scale, so a full-resolution frame gets proportionate dots rather than
    // displaced ones.
    const small = fakeCtx(), large = fakeCtx()
    drawPoseOverlay(small, points, { scale: 1 })
    drawPoseOverlay(large, points, { scale: 2 })

    const firstArc = (ctx) => ctx.calls.find(c => c[0] === 'arc')
    expect(firstArc(small)[1]).toBe(firstArc(large)[1])   // same x
    expect(firstArc(small)[2]).toBe(firstArc(large)[2])   // same y
    expect(firstArc(large)[3]).toBe(firstArc(small)[3] * 2) // double radius
  })
})

describe('scaleFor', () => {

  it('is 1x at the 700px reference height', () => {
    expect(scaleFor(700)).toBe(1)
  })

  it('scales proportionally, so a phone and a stored frame match', () => {
    expect(scaleFor(1400)).toBe(2)
    expect(scaleFor(350)).toBe(0.5)
  })

  it('falls back to 1x rather than collapsing to 0 on a zero height', () => {
    expect(scaleFor(0)).toBe(1)
    expect(scaleFor(undefined)).toBe(1)
  })
})

describe('marker colours are role-stable', () => {

  it('keeps one colour per role so a frame reads the same as the live view', () => {
    expect(Object.keys(MARKER_COLORS).sort()).toEqual(['distal', 'joint', 'proximal'])
  })
})


// ─── The live overlay's crop ─────────────────────────────────────────────────

describe('Overlay.visibleVideoRect — the crop the snapshot will store', () => {

  // The class needs a canvas element and a window; neither exists in Node, and
  // neither is what is under test here — the geometry is.
  function attachedOverlay(displayW, displayH) {
    const ctx = { ...fakeCtx(), setTransform: () => {}, clearRect: () => {} }
    const canvas = {
      clientWidth: displayW, clientHeight: displayH, width: 0, height: 0,
      getContext: () => ctx,
    }
    globalThis.window = globalThis.window || {}
    globalThis.window.devicePixelRatio = 2
    const o = new Overlay()
    o.attach(canvas)
    return o
  }

  it('reports the SAME region the live transform draws against', () => {
    // One computation feeding both: if these ever diverge, the stored picture
    // is not the one the clinician watched the dots move on.
    const o = attachedOverlay(430, 700)
    o.resize(1280, 720)
    expect(o.visibleVideoRect()).toEqual(coverTransform(1280, 720, 430, 700).visible)
  })

  it('is null before a resize — "crop unknown", never "nothing visible"', () => {
    expect(new Overlay().visibleVideoRect()).toBeNull()
  })

  it('is null when the layout cannot be measured', () => {
    const o = attachedOverlay(0, 0)
    o.resize(1280, 720)
    expect(o.visibleVideoRect()).toBeNull()
  })

  it('drops a stale rect when the layout goes unmeasurable after a good resize', () => {
    // A capture must then store the whole frame — merely wider — rather than a
    // rect describing a stream size or a layout that no longer exists.
    const o = attachedOverlay(430, 700)
    o.resize(1280, 720)
    o.canvas.clientWidth = 0
    o.resize(1280, 720)
    expect(o.visibleVideoRect()).toBeNull()
  })

  it('refuses to answer for a different stream size than it was resized for', () => {
    const o = attachedOverlay(430, 700)
    o.resize(1280, 720)
    expect(o.visibleVideoRect(640, 480)).toBeNull()
    expect(o.visibleVideoRect(1280, 720)).not.toBeNull()
  })
})
