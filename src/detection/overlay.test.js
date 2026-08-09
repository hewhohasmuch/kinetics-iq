import { describe, it, expect, afterEach } from 'vitest'
import { Overlay } from './overlay.js'
import { FEATHER_EXTENT, OUTLINE_AT } from '../core/headRegion.js'

/**
 * A canvas 2D context that records every call and every relevant property
 * assignment, in order, so tests can assert both WHICH calls happened and
 * their relative ordering.
 */
function createRecordingCtx() {
  const calls = []
  const stops = []
  const rec = (name) => (...args) => { calls.push({ name, args }) }
  const ctx = {
    save: rec('save'), restore: rec('restore'),
    beginPath: rec('beginPath'), arc: rec('arc'), ellipse: rec('ellipse'),
    clip: rec('clip'), fill: rec('fill'), stroke: rec('stroke'), fillRect: rec('fillRect'),
    drawImage: rec('drawImage'),
    translate: rec('translate'), rotate: rec('rotate'), scale: rec('scale'),
    clearRect: rec('clearRect'), measureText: () => ({ width: 10 }),
    createRadialGradient: (...args) => {
      calls.push({ name: 'createRadialGradient', args })
      return { addColorStop: (o, c) => stops.push({ offset: o, color: c }) }
    },
    // A flat mid-grey frame: every sample outside the head reads the same.
    getImageData: (x, y, w, h) => ({
      data: new Uint8ClampedArray(w * h * 4).fill(128).map((v, i) => (i % 4 === 3 ? 255 : 120)),
    }),
    _filter: 'none', _globalAlpha: undefined, _fillStyle: undefined, _strokeStyle: undefined,
    _lineWidth: undefined, _font: undefined, _textAlign: undefined, _textBaseline: undefined,
  }
  for (const p of ['filter', 'globalAlpha', 'fillStyle', 'strokeStyle', 'lineWidth']) {
    Object.defineProperty(ctx, p, {
      get() { return this[`_${p}`] },
      set(v) { this[`_${p}`] = v; calls.push({ name: `set:${p}`, args: [v] }) },
    })
  }
  return { ctx, calls, stops }
}

/** Stub document.createElement so the neutral-fill sample canvas is recorded. */
function stubDocument() {
  const { ctx, calls } = createRecordingCtx()
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  global.document = { createElement: () => canvas }
  return { sampleCanvas: canvas, sampleCtx: ctx, sampleCalls: calls }
}

function createOverlayCanvas() {
  const { ctx, calls, stops } = createRecordingCtx()
  const canvas = { getContext: () => ctx, clientWidth: 400, clientHeight: 700 }
  return { canvas, ctx, calls, stops }
}

function stubWindow(dpr) { global.window = { devicePixelRatio: dpr } }

const fakeFrame = { width: 1280, height: 720 }
const HEAD = { cx: 100, cy: 100, rAcross: 40, rAlong: 50, ux: 0, uy: -1 }

function makeOverlay(canvas) {
  const overlay = new Overlay()
  overlay.attach(canvas)
  overlay._scale = 1
  overlay._offsetX = 0
  overlay._offsetY = 0
  return overlay
}

afterEach(() => { delete global.document; delete global.window })

describe('Overlay redaction mode', () => {
  it('always reports mask1 — there is no device-dependent fallback left', () => {
    // The blur version reported blur1 or solid1 depending on whether Canvas 2D
    // filters worked. Nothing about an opaque fill is device-dependent, so a
    // branch here would be a lie waiting to be told.
    stubDocument()
    const overlay = new Overlay()
    overlay.attach(createOverlayCanvas().canvas)
    expect(overlay.redactionMode).toBe('mask1')
  })

  it('reports mask1 even with no DOM at all', () => {
    const overlay = new Overlay()
    overlay.attach(createOverlayCanvas().canvas)
    expect(overlay.redactionMode).toBe('mask1')
  })
})

describe('Overlay._drawRedaction', () => {
  it('never samples a patch of the frame into the overlay', () => {
    // THE FAILURE THIS DESIGN EXISTS TO REMOVE. The blur version copied a
    // padded square of video into the circle — an on-device screenshot showed
    // that patch landing visibly offset from the head. Nothing may be
    // blitted onto the overlay context.
    stubWindow(3)
    stubDocument()
    const { canvas, calls } = createOverlayCanvas()
    makeOverlay(canvas)._drawRedaction(HEAD, fakeFrame)
    expect(calls.map((c) => c.name)).not.toContain('drawImage')
  })

  it('never sets a Canvas 2D filter', () => {
    // No filter means no dpr/CTM question, no support probe, and no way to
    // land at a fraction of the intended strength while still reporting success.
    stubWindow(3)
    stubDocument()
    const { canvas, calls } = createOverlayCanvas()
    makeOverlay(canvas)._drawRedaction(HEAD, fakeFrame)
    for (const s of calls.filter((c) => c.name === 'set:filter')) {
      expect(s.args[0]).toBe('none')
    }
  })

  it('keeps the core fully opaque and fades only outside it', () => {
    // THE INVARIANT. The gradient must be at full alpha from the centre all
    // the way to innerStop (= 1 / FEATHER_EXTENT), and only then fade. A
    // mutant that fades from offset 0 makes the whole head translucent while
    // still looking softened.
    stubWindow(2)
    stubDocument()
    const { canvas, stops } = createOverlayCanvas()
    makeOverlay(canvas)._drawRedaction(HEAD, fakeFrame)

    expect(stops.length).toBeGreaterThanOrEqual(3)
    const inner = stops.find((s) => Math.abs(s.offset - 1 / FEATHER_EXTENT) < 1e-9)
    expect(inner, 'no gradient stop at the core boundary').toBeTruthy()

    const opaque = (c) => !/rgba\([^)]*,\s*0(\.0+)?\s*\)$/.test(c)
    expect(opaque(stops[0].color), 'centre stop must be opaque').toBe(true)
    expect(opaque(inner.color), 'core-boundary stop must be opaque').toBe(true)
    expect(stops[0].color).toBe(inner.color)
    expect(opaque(stops.at(-1).color), 'outer stop must be transparent').toBe(false)
    expect(stops.at(-1).offset).toBe(1)
  })

  it('sets globalAlpha explicitly to 1 in every drawing block', () => {
    // The recording double's save()/restore() do not restore state the way a
    // real Canvas 2D context does, so checking only the FIRST set:globalAlpha
    // call would miss a regression that dropped the outline block's own
    // reset. Assert every occurrence is 1, and that there are at least two —
    // one per block (core+feather, outline).
    stubWindow(2)
    stubDocument()
    const { canvas, calls } = createOverlayCanvas()
    makeOverlay(canvas)._drawRedaction(HEAD, fakeFrame)
    const alphaSets = calls.filter((c) => c.name === 'set:globalAlpha')
    expect(alphaSets.length).toBeGreaterThanOrEqual(2)
    for (const s of alphaSets) expect(s.args[0]).toBe(1)
  })

  it('orients and scales the shape to the head ellipse', () => {
    stubWindow(1)
    stubDocument()
    const { canvas, calls } = createOverlayCanvas()
    makeOverlay(canvas)._drawRedaction(HEAD, fakeFrame)

    const translate = calls.find((c) => c.name === 'translate')
    expect(translate.args).toEqual([100, 100])

    // Scaled to the FEATHER extent, because the gradient is built in a unit
    // circle and stretched: 40 * 1.35 across, 50 * 1.35 along.
    const scale = calls.find((c) => c.name === 'scale')
    expect(scale.args[0]).toBeCloseTo(40 * FEATHER_EXTENT, 6)
    expect(scale.args[1]).toBeCloseTo(50 * FEATHER_EXTENT, 6)

    // The outline is stroked as a real ellipse, NOT under the non-uniform
    // scale — a stroke there would come out thicker on one axis.
    const outline = calls.find((c) => c.name === 'ellipse')
    expect(outline.args[2]).toBeCloseTo(40 * OUTLINE_AT, 6)
    expect(outline.args[3]).toBeCloseTo(50 * OUTLINE_AT, 6)

    // POSITIONAL, DELIBERATELY. `calls.find((c) => c.name === 'scale')` above
    // always returns the FIRST scale in the whole sequence — the core
    // block's — and would not notice a regression that reintroduced a scale
    // call inside the outline block too. The recording double also logs
    // ellipse()'s arguments verbatim, without applying any prior scale, so a
    // naive "was scale ever called with these values" check can't catch it
    // either. Find the save that opens the outline block (the nearest one
    // before its ellipse() call) and assert no scale call falls between
    // them. Do not "simplify" this back to a .find() — that is exactly the
    // form that let the regression through.
    const ellipseIdx = calls.findIndex((c) => c.name === 'ellipse')
    let outlineSaveIdx = -1
    for (let i = ellipseIdx - 1; i >= 0; i--) {
      if (calls[i].name === 'save') { outlineSaveIdx = i; break }
    }
    expect(outlineSaveIdx, 'no save() precedes the outline ellipse() call').toBeGreaterThan(-1)
    const scaleBetween = calls.some(
      (c, i) => c.name === 'scale' && i > outlineSaveIdx && i < ellipseIdx,
    )
    expect(
      scaleBetween,
      'ctx.scale() between the outline save and its ellipse() would distort the stroke thickness anisotropically',
    ).toBe(false)
  })

  it('maps video pixel space to display space before drawing', () => {
    stubWindow(1)
    stubDocument()
    const { canvas, calls } = createOverlayCanvas()
    const overlay = makeOverlay(canvas)
    overlay._scale = 2
    overlay._offsetX = 10
    overlay._offsetY = -20
    overlay._drawRedaction(HEAD, fakeFrame)

    expect(calls.find((c) => c.name === 'translate').args).toEqual([210, 180])
    expect(calls.find((c) => c.name === 'scale').args[0]).toBeCloseTo(80 * FEATHER_EXTENT, 6)
  })

  it('draws nothing when there is no head', () => {
    stubWindow(1)
    stubDocument()
    const { canvas, calls } = createOverlayCanvas()
    makeOverlay(canvas)._drawRedaction(null, fakeFrame)
    expect(calls.map((c) => c.name)).not.toContain('fill')
  })

  it('draws nothing when the geometry is degenerate', () => {
    // occluderGeometry() returns null when a semi-axis is non-positive (e.g.
    // rAcross: 0). _drawRedaction must no-op cleanly rather than drawing a
    // collapsed shape.
    stubWindow(1)
    stubDocument()
    const { canvas, calls } = createOverlayCanvas()
    const degenerate = { ...HEAD, rAcross: 0 }
    makeOverlay(canvas)._drawRedaction(degenerate, fakeFrame)
    expect(calls.map((c) => c.name)).not.toContain('fill')
    expect(calls.map((c) => c.name)).not.toContain('stroke')
  })

  it('still masks when the frame is unavailable, falling back to a fixed fill', () => {
    // A missing frame costs the colour sample, never the redaction. Returning
    // early here would leave the face sharp on exactly the frames where
    // something already went wrong.
    stubWindow(1)
    stubDocument()
    const { canvas, calls, stops } = createOverlayCanvas()
    makeOverlay(canvas)._drawRedaction(HEAD, null)
    expect(calls.map((c) => c.name)).toContain('fill')
    expect(stops.length).toBeGreaterThanOrEqual(3)
  })
})
