import { describe, it, expect, afterEach } from 'vitest'
import { Overlay } from './overlay.js'

/**
 * A canvas 2D context that records every call and every relevant property
 * assignment, in order, so tests can assert both WHICH calls happened and
 * their relative ordering (clip before fill, filter set before the blit and
 * reset after, opaque fill before the video lands).
 */
function createRecordingCtx({ filterSupported = true } = {}) {
  const calls = []
  const rec = (name) => (...args) => { calls.push({ name, args }) }
  const ctx = {
    save:      rec('save'),
    restore:   rec('restore'),
    beginPath: rec('beginPath'),
    arc:       rec('arc'),
    clip:      rec('clip'),
    fillRect:  rec('fillRect'),
    drawImage: rec('drawImage'),
    _filter: 'none',
    _globalAlpha: undefined,
    _fillStyle: undefined,
  }
  Object.defineProperty(ctx, 'filter', {
    get() { return this._filter },
    // filterSupported:false models Safari before 17 — the assignment does NOT
    // throw, it silently does nothing, which is why an unguarded blur draw
    // would emit a SHARP face.
    set(v) { if (filterSupported) this._filter = v; calls.push({ name: 'set:filter', args: [v] }) },
  })
  Object.defineProperty(ctx, 'globalAlpha', {
    get() { return this._globalAlpha },
    set(v) { this._globalAlpha = v; calls.push({ name: 'set:globalAlpha', args: [v] }) },
  })
  Object.defineProperty(ctx, 'fillStyle', {
    get() { return this._fillStyle },
    set(v) { this._fillStyle = v; calls.push({ name: 'set:fillStyle', args: [v] }) },
  })
  return { ctx, calls }
}

/**
 * Stub `document.createElement('canvas')` so the SCRATCH canvas the overlay
 * creates is a recording one. Overlay reuses a single scratch canvas across
 * frames, so a single shared context is the faithful model.
 *
 * Returns the scratch's recording handles — the blur now happens on THIS
 * context, not the overlay's, so this is where the interesting assertions are.
 */
function stubScratchDocument({ filterSupported = true } = {}) {
  const { ctx, calls } = createRecordingCtx({ filterSupported })
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  global.document = { createElement: () => canvas }
  return { scratchCanvas: canvas, scratchCtx: ctx, scratchCalls: calls }
}

/** The overlay's own canvas — separate recording context. */
function createOverlayCanvas() {
  const { ctx, calls } = createRecordingCtx({ filterSupported: true })
  const canvas = { getContext: () => ctx, clientWidth: 400, clientHeight: 700 }
  return { canvas, ctx, calls }
}

function stubWindow(dpr) { global.window = { devicePixelRatio: dpr } }

const fakeVideo = {}
const HEAD = { cx: 100, cy: 100, r: 50 }

// With _scale=1 and zero offsets, redactionGeometry({cx:100,cy:100,r:50}) gives
// blurRadius 17.5, padding 35, x/y 15, size 170. Kept in sync by assertion, not
// by trust: the numbers below are derived from these.
const G = { blurRadius: 17.5, x: 15, y: 15, size: 170 }

/** An overlay wired for _drawRedaction with an identity video→display map. */
function makeOverlay(canvas, filterSupported) {
  const overlay = new Overlay()
  overlay.attach(canvas)
  overlay._filterSupported = filterSupported
  overlay._scale = 1
  overlay._offsetX = 0
  overlay._offsetY = 0
  return overlay
}

afterEach(() => { delete global.document; delete global.window })

describe('Overlay redaction mode', () => {
  it('reports blur1 where Canvas 2D filters are supported', () => {
    stubScratchDocument({ filterSupported: true })
    const overlay = new Overlay()
    overlay.attach(createOverlayCanvas().canvas)
    expect(overlay.redactionMode).toBe('blur1')
  })

  it('falls back to solid1 when assigning filter silently no-ops on the SCRATCH context', () => {
    // The probe must interrogate the scratch context, because that is where
    // the blur is now applied. A probe of some other context could report
    // support the blur path never actually gets.
    stubScratchDocument({ filterSupported: false })
    const overlay = new Overlay()
    overlay.attach(createOverlayCanvas().canvas)
    expect(overlay.redactionMode).toBe('solid1')
  })

  it('falls back to solid1 when there is no DOM at all', () => {
    const overlay = new Overlay()
    overlay.attach(createOverlayCanvas().canvas)
    expect(overlay.redactionMode).toBe('solid1')
  })
})

describe('Overlay._drawRedaction — blur branch', () => {
  it('applies the blur on the SCRATCH context, never on the overlay context', () => {
    // This is the whole point of the change. resize() leaves the overlay
    // context with a dpr CTM; whether Canvas 2D blur lengths scale with the
    // CTM is unresolved across engines, so a blur set there could land at
    // 1/dpr strength while still being stamped 'blur1'. The scratch context
    // has the identity CTM, so the question does not arise.
    stubWindow(3)
    const { scratchCalls } = stubScratchDocument({ filterSupported: true })
    const { canvas, calls } = createOverlayCanvas()
    const overlay = makeOverlay(canvas, true)
    scratchCalls.length = 0            // discard the attach-time support probe

    overlay._drawRedaction(HEAD, fakeVideo)

    // Overlay context: blitted, clipped — and its filter is only ever 'none'.
    const names = calls.map((c) => c.name)
    expect(names).toContain('drawImage')
    expect(names).toContain('clip')
    for (const set of calls.filter((c) => c.name === 'set:filter')) {
      expect(set.args[0]).toBe('none')
    }

    // Scratch context: this is where a blur must appear.
    const scratchFilters = scratchCalls.filter((c) => c.name === 'set:filter')
    expect(scratchFilters.some((c) => /^blur\(\d/.test(c.args[0]))).toBe(true)
  })

  it('scales the scratch and the blur radius by devicePixelRatio together', () => {
    // Sized in DEVICE pixels so the patch is blurred at native resolution
    // rather than upsampled dpr× on the way out; the blur radius is scaled to
    // match, which is what keeps redactionGeometry's padding = 2 × blurRadius
    // coupling intact.
    stubWindow(3)
    const { scratchCanvas, scratchCalls } = stubScratchDocument({ filterSupported: true })
    const { canvas } = createOverlayCanvas()
    const overlay = makeOverlay(canvas, true)
    scratchCalls.length = 0

    overlay._drawRedaction(HEAD, fakeVideo)

    expect(scratchCanvas.width).toBe(Math.ceil(G.size * 3))    // 510
    expect(scratchCanvas.height).toBe(Math.ceil(G.size * 3))

    const blurSet = scratchCalls.find((c) => c.name === 'set:filter' && /^blur\(/.test(c.args[0]))
    expect(blurSet.args[0]).toBe(`blur(${G.blurRadius * 3}px)`)  // blur(52.5px)
  })

  it('does not scale by dpr when dpr is 1', () => {
    stubWindow(1)
    const { scratchCanvas, scratchCalls } = stubScratchDocument({ filterSupported: true })
    const { canvas } = createOverlayCanvas()
    const overlay = makeOverlay(canvas, true)
    scratchCalls.length = 0

    overlay._drawRedaction(HEAD, fakeVideo)

    expect(scratchCanvas.width).toBe(G.size)
    const blurSet = scratchCalls.find((c) => c.name === 'set:filter' && /^blur\(/.test(c.args[0]))
    expect(blurSet.args[0]).toBe(`blur(${G.blurRadius}px)`)
  })

  it('fills the scratch opaque BEFORE the video lands, and resets the filter after', () => {
    stubWindow(2)
    const { scratchCalls } = stubScratchDocument({ filterSupported: true })
    const { canvas } = createOverlayCanvas()
    const overlay = makeOverlay(canvas, true)
    scratchCalls.length = 0

    overlay._drawRedaction(HEAD, fakeVideo)

    const names = scratchCalls.map((c) => c.name)
    const fillIdx = names.indexOf('fillRect')
    const drawIdx = names.indexOf('drawImage')

    // Opaque-first. Near a frame edge the padded source square runs off the
    // video and leaves transparent scratch pixels; blurring toward transparent
    // inside the clip would let the sharp face show through.
    expect(fillIdx).toBeGreaterThanOrEqual(0)
    expect(drawIdx).toBeGreaterThan(fillIdx)

    // ...and the opaque fill itself must NOT be blurred, or the padded rim
    // stops being uniformly opaque.
    const filterAtFill = scratchCalls
      .slice(0, fillIdx)
      .filter((c) => c.name === 'set:filter')
      .at(-1)
    expect(filterAtFill.args[0]).toBe('none')

    // Blur on before the blit, off after — a mutant dropping the reset would
    // leave 'blur(...)' as the scratch's final filter state.
    const blurIdx = names.findIndex(
      (n, i) => n === 'set:filter' && /^blur\(/.test(scratchCalls[i].args[0]),
    )
    expect(blurIdx).toBeGreaterThan(fillIdx)
    expect(blurIdx).toBeLessThan(drawIdx)
    expect(scratchCalls.filter((c) => c.name === 'set:filter').at(-1).args[0]).toBe('none')
  })

  it('keeps the redaction fully opaque and clipped, and does not also run the solid fallback', () => {
    stubWindow(2)
    stubScratchDocument({ filterSupported: true })
    const { canvas, calls } = createOverlayCanvas()
    const overlay = makeOverlay(canvas, true)

    overlay._drawRedaction(HEAD, fakeVideo)

    const names = calls.map((c) => c.name)
    // The helpers in overlay.js leave globalAlpha dirty; a translucent
    // redaction leaks the sharp face straight through.
    expect(calls.find((c) => c.name === 'set:globalAlpha').args[0]).toBe(1)
    expect(names.indexOf('clip')).toBeLessThan(names.indexOf('drawImage'))
    // fillRect on the OVERLAY context would mean the solid fallback fired
    // alongside the blur — never both.
    expect(names).not.toContain('fillRect')
    // Drawn at CSS-pixel geometry, not device pixels: the overlay context
    // already carries the dpr transform.
    const blit = calls.find((c) => c.name === 'drawImage')
    expect(blit.args.slice(1)).toEqual([G.x, G.y, G.size, G.size])
  })
})

describe('Overlay._drawRedaction — solid fallback branch', () => {
  it('fills opaque and never blits the video when filters are unsupported', () => {
    stubWindow(3)
    const { scratchCalls } = stubScratchDocument({ filterSupported: false })
    const { canvas, calls } = createOverlayCanvas()
    const overlay = makeOverlay(canvas, false)
    scratchCalls.length = 0

    overlay._drawRedaction(HEAD, fakeVideo)

    const names = calls.map((c) => c.name)
    // THE MUTANT THIS KILLS: dropping the `if (this._filterSupported)` guard
    // so the blur branch always runs. Without filter support that draws the
    // SHARP video into the circle — it still "looks opaque" by eye while
    // leaking the unblurred face.
    expect(names).not.toContain('drawImage')
    expect(names).toContain('fillRect')

    // The same mutant, caught from the other side: no video ever reaches the
    // scratch canvas either.
    expect(scratchCalls.map((c) => c.name)).not.toContain('drawImage')

    const clipIdx     = names.indexOf('clip')
    const fillRectIdx = names.indexOf('fillRect')
    expect(clipIdx).toBeGreaterThanOrEqual(0)
    expect(clipIdx).toBeLessThan(fillRectIdx)

    expect(calls.find((c) => c.name === 'set:globalAlpha').args[0]).toBe(1)
    expect(calls.find((c) => c.name === 'set:fillStyle').args[0]).toBeTruthy()
  })
})
