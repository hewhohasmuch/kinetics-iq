import { describe, it, expect, afterEach } from 'vitest'
import { Overlay } from './overlay.js'

/**
 * Stub `document.createElement('canvas').getContext('2d')` with a context whose
 * `filter` setter either sticks or silently no-ops, mimicking a browser with
 * and without Canvas 2D filter support.
 */
function stubDocument({ filterSupported }) {
  global.document = {
    createElement: () => ({
      getContext: () => {
        const ctx = { _filter: 'none' }
        Object.defineProperty(ctx, 'filter', {
          get() { return this._filter },
          set(v) { if (filterSupported) this._filter = v },
        })
        return ctx
      },
    }),
  }
}

const fakeCanvas = { getContext: () => ({}) }

/**
 * A document stub whose canvases (used for the internal filter-support probe
 * AND the scratch canvas `_getScratch()` blits into) support the handful of
 * 2D context members `_drawRedaction`'s blur branch actually calls. Distinct
 * from `stubDocument()` above, which only needs to model `filter`.
 */
function stubScratchDocument() {
  global.document = {
    createElement: () => ({
      getContext: () => ({
        _filter: 'none',
        get filter() { return this._filter },
        set filter(v) { this._filter = v },
        fillStyle: null,
        fillRect: () => {},
        drawImage: () => {},
      }),
    }),
  }
}

/**
 * A canvas 2D context that records every call/assignment `_drawRedaction`
 * makes, in order, so tests can assert both WHICH calls happened and their
 * relative ordering (e.g. clip() before the fallback fill, filter reset
 * after the blurred draw).
 */
function createRecordingCanvas() {
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
    set(v) { this._filter = v; calls.push({ name: 'set:filter', args: [v] }) },
  })
  Object.defineProperty(ctx, 'globalAlpha', {
    get() { return this._globalAlpha },
    set(v) { this._globalAlpha = v; calls.push({ name: 'set:globalAlpha', args: [v] }) },
  })
  Object.defineProperty(ctx, 'fillStyle', {
    get() { return this._fillStyle },
    set(v) { this._fillStyle = v; calls.push({ name: 'set:fillStyle', args: [v] }) },
  })
  const canvas = { getContext: () => ctx, clientWidth: 400, clientHeight: 700 }
  return { canvas, ctx, calls }
}

const fakeVideo = {}
const HEAD = { cx: 100, cy: 100, r: 50 }

afterEach(() => { delete global.document })

describe('Overlay redaction mode', () => {
  it('reports blur1 where Canvas 2D filters are supported', () => {
    stubDocument({ filterSupported: true })
    const overlay = new Overlay()
    overlay.attach(fakeCanvas)
    expect(overlay.redactionMode).toBe('blur1')
  })

  it('falls back to solid1 when assigning ctx.filter silently no-ops', () => {
    // Safari before 17. The assignment does not throw — it just does nothing,
    // which is why an unguarded blur draw would emit a SHARP face.
    stubDocument({ filterSupported: false })
    const overlay = new Overlay()
    overlay.attach(fakeCanvas)
    expect(overlay.redactionMode).toBe('solid1')
  })

  it('falls back to solid1 when there is no DOM at all', () => {
    const overlay = new Overlay()
    overlay.attach(fakeCanvas)
    expect(overlay.redactionMode).toBe('solid1')
  })

})

describe('Overlay._drawRedaction', () => {
  it('blurs when Canvas 2D filters are supported: filter set before drawImage, reset after', () => {
    stubScratchDocument()
    const { canvas, calls } = createRecordingCanvas()
    const overlay = new Overlay()
    overlay.attach(canvas)
    overlay._filterSupported = true
    overlay._scale = 1
    overlay._offsetX = 0
    overlay._offsetY = 0

    overlay._drawRedaction(HEAD, fakeVideo)

    const names = calls.map((c) => c.name)
    expect(names).toContain('drawImage')
    expect(names).toContain('clip')

    const filterSets = calls.filter((c) => c.name === 'set:filter')
    // First assignment blurs; the mutant that deletes the reset would leave
    // 'blur(...)' as the final filter value instead of 'none'.
    expect(filterSets[0].args[0]).toMatch(/^blur\(\d/)
    expect(filterSets.at(-1).args[0]).toBe('none')

    const filterOnIdx  = names.indexOf('set:filter')
    const drawImageIdx = names.indexOf('drawImage')
    const filterOffIdx = names.lastIndexOf('set:filter')
    expect(filterOnIdx).toBeLessThan(drawImageIdx)
    expect(filterOffIdx).toBeGreaterThan(drawImageIdx)

    // fillRect on the overlay's own context would mean the solid fallback
    // fired alongside the blur — never both.
    expect(names).not.toContain('fillRect')
  })

  it('falls back to an opaque fill when Canvas 2D filters are unsupported: no drawImage, clip before fillRect', () => {
    stubScratchDocument()
    const { canvas, calls } = createRecordingCanvas()
    const overlay = new Overlay()
    overlay.attach(canvas)
    overlay._filterSupported = false
    overlay._scale = 1
    overlay._offsetX = 0
    overlay._offsetY = 0

    overlay._drawRedaction(HEAD, fakeVideo)

    const names = calls.map((c) => c.name)
    // This is the mutant this test exists to kill: a solid fallback that
    // silently draws the (sharp) video instead of filling would still "look
    // opaque" by eye but leak the unblurred face.
    expect(names).not.toContain('drawImage')
    expect(names).toContain('fillRect')

    const clipIdx     = names.indexOf('clip')
    const fillRectIdx = names.indexOf('fillRect')
    expect(clipIdx).toBeGreaterThanOrEqual(0)
    expect(clipIdx).toBeLessThan(fillRectIdx)

    const alphaSet = calls.find((c) => c.name === 'set:globalAlpha')
    expect(alphaSet.args[0]).toBe(1)
  })
})
