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

  it('never reports a mode implying no redaction', () => {
    for (const filterSupported of [true, false]) {
      stubDocument({ filterSupported })
      const overlay = new Overlay()
      overlay.attach(fakeCanvas)
      expect(['blur1', 'solid1']).toContain(overlay.redactionMode)
    }
  })
})
