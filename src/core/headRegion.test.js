import { describe, it, expect } from 'vitest'
import {
  headRegion, occluderGeometry, expandForMotion,
  headInputsFinite, anyFaceLandmarkInFrame,
  MAX_RADIUS_FRACTION, COVERAGE_MARGIN, ELLIPSE_ACROSS, ELLIPSE_ALONG,
  HEAD_RADIUS_FACTOR, TORSO_SCALE_COEFF,
  FEATHER_EXTENT,
} from './headRegion.js'

const W = 720, H = 1280

/**
 * Build a normalised landmark array for a head centred at (hx, hy) with
 * half-width `hw` and half-height `hh` (all normalised 0–1), and shoulders
 * `shDrop` below it.
 *
 * Indices: 0 nose, 1-3 left eye, 4-6 right eye, 7-8 ears, 9-10 mouth,
 *          11-12 shoulders.
 */
function pose({ hx = 0.5, hy = 0.25, hw = 0.06, hh = 0.04, shDrop = 0.18 } = {}) {
  const lm = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }))
  const at = (i, x, y) => { lm[i] = { x, y, z: 0, visibility: 0.9 } }
  at(0,  hx,          hy)              // nose
  at(1,  hx - hw*0.3, hy - hh*0.4)     // left eye inner
  at(2,  hx - hw*0.5, hy - hh*0.4)     // left eye
  at(3,  hx - hw*0.7, hy - hh*0.4)     // left eye outer
  at(4,  hx + hw*0.3, hy - hh*0.4)     // right eye inner
  at(5,  hx + hw*0.5, hy - hh*0.4)     // right eye
  at(6,  hx + hw*0.7, hy - hh*0.4)     // right eye outer
  at(7,  hx - hw,     hy - hh*0.2)     // left ear
  at(8,  hx + hw,     hy - hh*0.2)     // right ear
  at(9,  hx - hw*0.4, hy + hh)         // mouth left
  at(10, hx + hw*0.4, hy + hh)         // mouth right
  at(11, hx - 0.10,   hy + shDrop)     // left shoulder
  at(12, hx + 0.10,   hy + shDrop)     // right shoulder
  return lm
}

/** Same subject rotated to profile: the face box collapses horizontally. */
function profilePose(opts = {}) {
  const lm = pose(opts)
  const hx = opts.hx ?? 0.5
  // Ears, eyes and nose stack up in x when side-on.
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    lm[i] = { ...lm[i], x: hx + (lm[i].x - hx) * 0.15 }
  }
  return lm
}

/**
 * Prone patient, camera rotated ~90° relative to the body: the shoulders
 * project out to the SIDE of the head rather than below it, and the face
 * landmarks foreshorten vertically the way profilePose() foreshortens them
 * horizontally. Exercises the CRANIUM_NUDGE direction logic (axis computed
 * from shoulders→face, not assumed screen-up) together with a genuinely
 * foreshortened face box.
 */
function proneRotatedPose(opts = {}) {
  const lm = pose(opts)
  const hx = opts.hx ?? 0.5
  const hy = opts.hy ?? 0.25
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    lm[i] = { ...lm[i], y: hy + (lm[i].y - hy) * 0.15 }
  }
  for (const i of [11, 12]) lm[i] = { ...lm[i], x: hx + 0.30, y: hy + 0.02 }
  return lm
}

/**
 * Elliptical containment metric. Returns q for a landmark: q <= 1 means the
 * point is inside the ellipse, q = 0 is dead centre. This is the elliptical
 * analogue of `dist / r` in the circle version.
 */
function ellipseQ(reg, xPx, yPx) {
  const dx = xPx - reg.cx
  const dy = yPx - reg.cy
  const px = -reg.uy, py = reg.ux              // perpendicular to the head axis
  const across = dx * px + dy * py
  const along  = dx * reg.ux + dy * reg.uy
  return Math.hypot(across / reg.rAcross, along / reg.rAlong)
}

/** Axis-aligned half-extents of the oriented ellipse, for off-frame tests. */
function halfExtents(reg) {
  return {
    hx: Math.hypot(reg.rAcross * reg.uy, reg.rAlong * reg.ux),
    hy: Math.hypot(reg.rAcross * reg.ux, reg.rAlong * reg.uy),
  }
}

describe('headRegion', () => {
  it('centres above the face centroid, toward the cranium', () => {
    const reg = headRegion(pose(), W, H)
    const noseY = 0.25 * H
    expect(reg.cy).toBeLessThan(noseY)   // smaller y = further up the frame
  })

  it('pushes the centre away from the shoulders regardless of body rotation', () => {
    // Patient prone with the camera rotated: shoulders are to the RIGHT of the
    // head, so the cranium nudge must push LEFT, not up the screen.
    const lm = pose()
    for (const i of [11, 12]) lm[i] = { ...lm[i], x: 0.75, y: 0.25 }
    const reg = headRegion(lm, W, H)
    expect(reg.cx).toBeLessThan(0.5 * W)
  })

  it('returns null for missing or empty landmarks', () => {
    expect(headRegion(null, W, H)).toBeNull()
    expect(headRegion([], W, H)).toBeNull()
    expect(headRegion(pose(), 0, 0)).toBeNull()
  })

  it('returns null when landmark coordinates are NaN', () => {
    const lm = pose()
    lm[0].x = NaN  // Inject NaN into the nose landmark
    expect(headRegion(lm, W, H)).toBeNull()
  })
})

describe('headInputsFinite', () => {
  it('is true for a normal pose', () => {
    expect(headInputsFinite(pose())).toBe(true)
  })

  it('is false for null or empty input', () => {
    expect(headInputsFinite(null)).toBe(false)
    expect(headInputsFinite([])).toBe(false)
  })

  it('is false when a face landmark has NaN x', () => {
    const lm = pose()
    lm[0].x = NaN
    expect(headInputsFinite(lm)).toBe(false)
  })

  it('is false when a shoulder landmark has NaN y', () => {
    const lm = pose()
    lm[12].y = NaN
    expect(headInputsFinite(lm)).toBe(false)
  })

  it('is true for a head positioned entirely outside the frame (case b: usable, nothing to redact)', () => {
    const lm = pose({ hx: -1.5, hy: -1.5 })
    expect(headInputsFinite(lm)).toBe(true)
    // Sanity check this is really the off-frame case headRegion treats as null.
    expect(headRegion(lm, W, H)).toBeNull()
  })

  it('is false when a landmark object is present but x/y are undefined', () => {
    const lm = pose()
    lm[5] = { visibility: 0.9 }  // no x/y at all
    expect(headInputsFinite(lm)).toBe(false)
  })

  it('is false when a required index is null', () => {
    const lm = pose()
    lm[11] = null
    expect(headInputsFinite(lm)).toBe(false)
  })
})

describe('anyFaceLandmarkInFrame', () => {
  it('is true for a normal centred pose', () => {
    expect(anyFaceLandmarkInFrame(pose(), W, H)).toBe(true)
  })

  it('is false for a pose entirely off-frame', () => {
    expect(anyFaceLandmarkInFrame(pose({ hx: -1.5, hy: -1.5 }), W, H)).toBe(false)
  })

  it('is false for null/empty input or zero dimensions', () => {
    expect(anyFaceLandmarkInFrame(null, W, H)).toBe(false)
    expect(anyFaceLandmarkInFrame([], W, H)).toBe(false)
    expect(anyFaceLandmarkInFrame(pose(), 0, 0)).toBe(false)
  })
})

describe('headRegion — oriented ellipse', () => {
  const FACE_IDX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  it('returns semi-axes and a unit head axis instead of a single radius', () => {
    const reg = headRegion(pose(), W, H)
    expect(reg.rAcross).toBeGreaterThan(0)
    expect(reg.rAlong).toBeGreaterThan(0)
    expect(reg.r).toBeUndefined()
    expect(Math.hypot(reg.ux, reg.uy)).toBeCloseTo(1, 6)
  })

  it('is longer along the head axis than across it', () => {
    // A head is taller than it is wide. Scaling both axes by the SAME
    // containment factor is what preserves this; a mutant that grows them
    // independently flattens the ellipse in profile — the exact
    // under-estimate the circle version existed to avoid.
    const reg = headRegion(pose(), W, H)
    expect(reg.rAlong).toBeGreaterThan(reg.rAcross)
    expect(reg.rAlong / reg.rAcross).toBeCloseTo(ELLIPSE_ALONG / ELLIPSE_ACROSS, 6)
  })

  it('points the head axis away from the shoulders, whatever the body rotation', () => {
    const lm = pose()
    for (const i of [11, 12]) lm[i] = { ...lm[i], x: 0.75, y: 0.25 }
    const reg = headRegion(lm, W, H)
    expect(reg.ux).toBeLessThan(-0.9)       // shoulders right → axis points left
    expect(Math.abs(reg.uy)).toBeLessThan(0.2)
  })

  it('contains every face landmark for frontal, profile, close profile and prone', () => {
    const fixtures = {
      frontal:        pose(),
      profile:        profilePose(),
      'close profile': profilePose({ shDrop: 0.10 }),
      prone:          proneRotatedPose(),
    }
    for (const [label, lm] of Object.entries(fixtures)) {
      const reg = headRegion(lm, W, H)
      expect(reg, `${label}: null region`).not.toBeNull()
      for (const i of FACE_IDX) {
        const q = ellipseQ(reg, lm[i].x * W, lm[i].y * H)
        expect(q, `${label}: landmark ${i} q=${q.toFixed(3)}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('leaves the guaranteed slack the coverage margin promises', () => {
    // Containment grows the ellipse by t * COVERAGE_MARGIN, so the worst
    // landmark ends at q = 1 / COVERAGE_MARGIN. Where the heuristic floor
    // wins outright the worst q is smaller still. Either way this bound holds
    // while the shape is uncapped.
    for (const lm of [pose(), profilePose(), profilePose({ shDrop: 0.10 }), proneRotatedPose()]) {
      const reg = headRegion(lm, W, H)
      const worst = Math.max(...FACE_IDX.map((i) => ellipseQ(reg, lm[i].x * W, lm[i].y * H)))
      expect(worst).toBeLessThanOrEqual(1 / COVERAGE_MARGIN + 1e-9)
    }
  })

  it('does not inflate a region the heuristic already covers', () => {
    // THE MUTANT THIS KILLS: writing the growth factor as
    // `max(1, t) * COVERAGE_MARGIN` instead of `max(1, t * COVERAGE_MARGIN)`.
    // That multiplies EVERY region by 1.60 even when containment is inert,
    // which no containment assertion above would ever catch — every landmark
    // is still inside, just inside a needlessly huge ellipse.
    //
    // The heuristic is recomputed here from the same inputs rather than
    // hardcoded, so this stays a statement about the FORMULA and cannot be
    // silenced by editing a number to match whatever the code now produces.
    //
    // FIXTURE CHOICE MATTERS HERE. The default pose() (shDrop: 0.18) does NOT
    // work: at COVERAGE_MARGIN 1.60 containment genuinely binds there, so the
    // correct formula and the `max(1, t) * COVERAGE_MARGIN` mutant would both
    // produce growth > 1 and this test couldn't tell them apart. Measured:
    //   shDrop=0.18  rHeuristic=139.30  growth=1.0666  (binds)
    //   shDrop=0.22  rHeuristic=169.77  growth=1.0000  (inert)
    //   shDrop=0.30  rHeuristic=230.70  growth=1.0000  (inert)
    // shDrop: 0.30 is comfortably inside the inert region: the correct
    // formula gives growth exactly 1.0 while the mutant gives 1.60 — a 60%
    // error this assertion catches cleanly.
    const lm = pose({ shDrop: 0.30 })
    const idx = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const xs = idx.map((i) => lm[i].x * W)
    const ys = idx.map((i) => lm[i].y * H)
    const fx = xs.reduce((a, b) => a + b, 0) / xs.length
    const fy = ys.reduce((a, b) => a + b, 0) / ys.length
    const shX = ((lm[11].x + lm[12].x) / 2) * W
    const shY = ((lm[11].y + lm[12].y) / 2) * H
    const sTorso = TORSO_SCALE_COEFF * Math.hypot(fx - shX, fy - shY)
    const sFace  = Math.hypot(Math.max(...xs) - Math.min(...xs),
                              Math.max(...ys) - Math.min(...ys))
    const rHeuristic = HEAD_RADIUS_FACTOR * Math.max(sFace, sTorso)

    // At this framing containment is inert, so the seed must survive untouched.
    const reg = headRegion(lm, W, H)
    expect(reg.rAcross).toBeCloseTo(ELLIPSE_ACROSS * rHeuristic, 6)
    expect(reg.rAlong).toBeCloseTo(ELLIPSE_ALONG * rHeuristic, 6)
  })

  it('caps both semi-axes, and the cap overrides containment', () => {
    const lm  = pose({ hw: 5, hh: 5, shDrop: 8 })
    const reg = headRegion(lm, W, H)
    const cap = MAX_RADIUS_FRACTION * Math.min(W, H)
    expect(reg.rAcross).toBeLessThanOrEqual(cap)
    expect(reg.rAlong).toBeLessThanOrEqual(cap)
    const outside = FACE_IDX.some((i) => ellipseQ(reg, lm[i].x * W, lm[i].y * H) > 1)
    expect(outside).toBe(true)
  })

  it('keeps the heuristic as a floor when the face landmarks give no spread', () => {
    // Guards the heuristic's remaining job. MediaPipe can collapse the face
    // landmarks onto a point (heavy occlusion, subject far from camera);
    // containment alone would then draw an ellipse around nothing.
    const lm = pose()
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      lm[i] = { x: 0.5, y: 0.25, z: 0, visibility: 0.9 }
    }
    const reg = headRegion(lm, W, H)
    expect(reg.rAcross).toBeGreaterThan(100)
  })

  it('rejects a head whose ellipse lies entirely off-frame', () => {
    expect(headRegion(pose({ hx: -1.5, hy: -1.5 }), W, H)).toBeNull()
  })

  it('keeps a head that is only partly off-frame', () => {
    const reg = headRegion(pose({ hx: 0.02, hy: 0.03 }), W, H)
    expect(reg).not.toBeNull()
    const { hx } = halfExtents(reg)
    expect(reg.cx + hx).toBeGreaterThan(0)
  })
})

describe('headRegion — scale estimators stay load-bearing', () => {
  it('keeps sFace load-bearing at close framing', () => {
    // shDrop=0.04 puts the shoulders almost at the chin, so sTorso is far too
    // short to set the scale and only the face span can.
    // MUTATION (force scale = sTorso): the ellipse collapses onto the face
    // landmarks themselves and stops covering the cranium.
    const reg = headRegion(pose({ shDrop: 0.04 }), W, H)
    expect(reg.rAcross).toBeGreaterThan(80)
    const eyeY = (0.25 - 0.04 * 0.4) * H
    const { hy } = halfExtents(reg)
    expect(eyeY - (reg.cy - hy)).toBeGreaterThan(90)
  })

  it('keeps sTorso load-bearing: does not collapse in profile', () => {
    // MUTATION (force scale = sFace): the x-only profile squeeze shrinks the
    // face span badly, so the ellipse shrinks with it.
    const frontal = headRegion(pose(), W, H)
    const profile = headRegion(profilePose(), W, H)
    expect(profile.rAcross).toBeGreaterThanOrEqual(0.95 * frontal.rAcross)
    expect(profile.rAcross).toBeGreaterThan(110)
  })
})

describe('expandForMotion', () => {
  const base = () => ({ cx: 300, cy: 400, rAcross: 100, rAlong: 120, ux: 0, uy: -1 })

  it('returns the region untouched when there is no previous frame', () => {
    const r = base()
    expect(expandForMotion(r, null, W, H)).toBe(r)
  })

  it('returns the region untouched when the head has not moved', () => {
    const r = base()
    expect(expandForMotion(r, { ...base() }, W, H)).toBe(r)
  })

  it('grows both semi-axes by the displacement since the last detection', () => {
    // The video element runs at 30fps while detection runs at 10Hz plus
    // inference, so the occluder is drawn over a frame ~150ms newer than the
    // landmarks that placed it. Growing by the last displacement covers the
    // swept path instead of a stale point.
    const prev = { ...base(), cx: 260, cy: 400 }     // moved 40px in x
    const out  = expandForMotion(base(), prev, W, H)
    expect(out.rAcross).toBeCloseTo(140, 6)
    expect(out.rAlong).toBeCloseTo(160, 6)
    expect(out.cx).toBe(300)                          // centre is NOT moved
  })

  it('covers where the head was as well as where it is', () => {
    const prev = { ...base(), cx: 260, cy: 400 }
    const out  = expandForMotion(base(), prev, W, H)
    const dist = Math.hypot(prev.cx - out.cx, prev.cy - out.cy)
    expect(dist).toBeLessThanOrEqual(out.rAcross)
  })

  it('stays subject to the radius cap', () => {
    const prev = { ...base(), cx: -5000 }
    const out  = expandForMotion(base(), prev, W, H)
    const cap  = MAX_RADIUS_FRACTION * Math.min(W, H)
    expect(out.rAcross).toBeLessThanOrEqual(cap)
    expect(out.rAlong).toBeLessThanOrEqual(cap)
  })

  it('returns null input unchanged and ignores a non-finite previous centre', () => {
    expect(expandForMotion(null, base(), W, H)).toBeNull()
    const r = base()
    expect(expandForMotion(r, { ...base(), cx: NaN }, W, H)).toBe(r)
  })

  it('returns the region untouched when the video dimensions are unusable', () => {
    // Mirrors headRegion()'s own guard. A <video> element can report 0
    // between frames; without this, maxR is NaN and Math.min() poisons BOTH
    // semi-axes — a NaN ellipse draws no occluder at all, leaving the face
    // visible on exactly the frames where something already went wrong.
    const r = base()
    const prev = { ...base(), cx: 260 }
    expect(expandForMotion(r, prev, 0, 0)).toBe(r)
    expect(expandForMotion(r, prev, NaN, 720)).toBe(r)
    expect(expandForMotion(r, prev, 1280, undefined)).toBe(r)
  })
})

describe('occluderGeometry', () => {
  const disp = { cx: 200, cy: 300, rAcross: 100, rAlong: 120, ux: 0, uy: -1 }

  it('keeps the core exactly at the containment ellipse', () => {
    // THE INVARIANT THE WHOLE DESIGN RESTS ON: softening happens strictly
    // OUTSIDE the shape that provably contains every face landmark. A mutant
    // that shrinks the core to make the feather start earlier trades the
    // guarantee for looks.
    const g = occluderGeometry(disp)
    expect(g.core.rAcross).toBe(100)
    expect(g.core.rAlong).toBe(120)
  })

  it('feathers and outlines outside the core, never inside', () => {
    const g = occluderGeometry(disp)
    expect(g.feather.rAcross).toBeGreaterThan(g.core.rAcross)
    expect(g.feather.rAlong).toBeGreaterThan(g.core.rAlong)
    expect(g.outline.rAcross).toBeGreaterThan(g.core.rAcross)
  })

  it('puts the gradient stop where the opaque core ends', () => {
    // The gradient is drawn in a space scaled to the FEATHER extent, so the
    // core boundary lands at core/feather = 1 / FEATHER_EXTENT. Getting this
    // wrong is how the fade ends up starting at the centre.
    const g = occluderGeometry(disp)
    expect(g.innerStop).toBeCloseTo(1 / FEATHER_EXTENT, 9)
    expect(g.innerStop).toBeCloseTo(g.core.rAcross / g.feather.rAcross, 9)
    expect(g.innerStop).toBeCloseTo(g.core.rAlong / g.feather.rAlong, 9)
  })

  it('rotates so the long axis follows the head axis', () => {
    // ctx.rotate(theta) maps the local y-axis to (-sin, cos); we need that to
    // equal (ux, uy) so radiusY (rAlong) runs along the head.
    for (const u of [{ ux: 0, uy: -1 }, { ux: -1, uy: 0 }, { ux: 0.6, uy: -0.8 }]) {
      const g = occluderGeometry({ ...disp, ...u })
      expect(-Math.sin(g.rotation)).toBeCloseTo(u.ux, 6)
      expect(Math.cos(g.rotation)).toBeCloseTo(u.uy, 6)
    }
  })

  it('returns null for a missing or degenerate region', () => {
    expect(occluderGeometry(null)).toBeNull()
    expect(occluderGeometry({ ...disp, rAcross: 0 })).toBeNull()
    expect(occluderGeometry({ ...disp, rAlong: -1 })).toBeNull()
  })
})
