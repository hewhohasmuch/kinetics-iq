import { describe, it, expect } from 'vitest'
import { headRegion, redactionGeometry, headInputsFinite, anyFaceLandmarkInFrame, MAX_RADIUS_FRACTION } from './headRegion.js'

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

describe('headRegion', () => {
  it('covers the whole head, including above the topmost face landmark', () => {
    const reg = headRegion(pose(), W, H)
    expect(reg).not.toBeNull()

    // Topmost face landmark is the eye line; the cranium sits above it.
    const eyeY = (0.25 - 0.04 * 0.4) * H
    expect(reg.cy - reg.r).toBeLessThan(eyeY)

    // And the chin (mouth line) is still inside the circle.
    const mouthY = (0.25 + 0.04) * H
    expect(reg.cy + reg.r).toBeGreaterThan(mouthY)
  })

  it('centres above the face centroid, toward the cranium', () => {
    const reg = headRegion(pose(), W, H)
    const noseY = 0.25 * H
    expect(reg.cy).toBeLessThan(noseY)   // smaller y = further up the frame
  })

  it('does not collapse in profile — the failure the two estimators exist for', () => {
    // Use a tighter close-up where face estimator dominates frontally,
    // so the profile transform flips which term wins.
    const frontal = headRegion(pose({ shDrop: 0.10 }), W, H)
    const profile = headRegion(profilePose({ shDrop: 0.10 }), W, H)
    expect(profile).not.toBeNull()

    // The fixture parameters yield:
    //   Face centroid y ≈ 0.2470909 (not 0.25, because landmarks cluster at eye line)
    //   For shDrop=0.10: d_px ≈ 131.724 → sTorso ≈ 92.21px
    //   With sFace ≈ 112.26px → frontal.r ≈ 95.42px (face wins)
    //
    // Both assertions are load-bearing; each catches a different mutation:
    //
    //   Mutation A — delete sFace (scale=sTorso):
    //     frontal.r = 0.85 × 92.21 = 78.38px, profile.r = 78.38px (ratio 1.0)
    //     band assertion (90 < r < 100) catches it
    //
    //   Mutation B — delete sTorso (scale=sFace):
    //     frontal.r = 95.42px (unchanged, sFace already dominated), profile.r = 61.91px (ratio 0.649)
    //     ratio assertion (>= 0.75) catches it
    //
    // Band assertion: pin the face estimator in use for frontal
    expect(frontal.r).toBeGreaterThan(90)
    expect(frontal.r).toBeLessThan(100)

    // Ratio assertion: ensure the torso fallback engages in profile
    expect(profile.r).toBeGreaterThanOrEqual(0.75 * frontal.r)
  })

  it('pushes the centre away from the shoulders regardless of body rotation', () => {
    // Patient prone with the camera rotated: shoulders are to the RIGHT of the
    // head, so the cranium nudge must push LEFT, not up the screen.
    const lm = pose()
    for (const i of [11, 12]) lm[i] = { ...lm[i], x: 0.75, y: 0.25 }
    const reg = headRegion(lm, W, H)
    expect(reg.cx).toBeLessThan(0.5 * W)
  })

  it('returns null when the head is entirely off-frame', () => {
    expect(headRegion(pose({ hx: -1.5, hy: -1.5 }), W, H)).toBeNull()
  })

  it('returns a region when the head is only partly off-frame', () => {
    const reg = headRegion(pose({ hx: 0.02, hy: 0.03 }), W, H)
    expect(reg).not.toBeNull()
  })

  it('caps the radius so a garbage frame cannot blur the whole image', () => {
    const reg = headRegion(pose({ hw: 5, hh: 5, shDrop: 8 }), W, H)
    expect(reg.r).toBeLessThanOrEqual(MAX_RADIUS_FRACTION * Math.min(W, H))
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

describe('headRegion — face landmark coverage', () => {
  // Indices 0-10: the eleven face landmarks the redaction exists to hide.
  // Nothing before this test asserted they actually land INSIDE the
  // returned circle — the profile test above only pins the radius against
  // collapsing, never checks containment.
  const FACE_IDX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  /** Returns { worstIdx, worstMargin } — margin is (r - dist) / r for the
   *  tightest landmark; negative means that landmark is OUTSIDE the circle. */
  function assertAllInside(landmarksNorm, reg, label) {
    expect(reg, `${label}: headRegion returned null`).not.toBeNull()
    let worstMargin = Infinity
    let worstIdx = -1
    for (const i of FACE_IDX) {
      const lm = landmarksNorm[i]
      const dist = Math.hypot(lm.x * W - reg.cx, lm.y * H - reg.cy)
      const margin = (reg.r - dist) / reg.r
      if (margin < worstMargin) { worstMargin = margin; worstIdx = i }
      expect(
        dist,
        `${label}: landmark ${i} at dist ${dist.toFixed(2)}px vs r=${reg.r.toFixed(2)}px ` +
        `(margin ${(margin * 100).toFixed(2)}% of r)`
      ).toBeLessThanOrEqual(reg.r)
    }
    return { worstIdx, worstMargin }
  }

  it('contains every face landmark for a frontal pose', () => {
    const lm = pose()
    const { worstIdx, worstMargin } = assertAllInside(lm, headRegion(lm, W, H), 'frontal')
    // Observed: worst landmark 9/10 (mouth), margin ≈ 24.55% of r.
    expect(worstIdx).toBeGreaterThanOrEqual(0)
    expect(worstMargin).toBeGreaterThan(0)
  })

  it('contains every face landmark for a profile pose', () => {
    const lm = profilePose()
    const { worstMargin } = assertAllInside(lm, headRegion(lm, W, H), 'profile')
    // Observed: worst landmark 9/10 (mouth), margin ≈ 25.55% of r.
    expect(worstMargin).toBeGreaterThan(0)
  })

  it('contains every face landmark for a prone/rotated pose', () => {
    const lm = proneRotatedPose()
    const { worstMargin } = assertAllInside(lm, headRegion(lm, W, H), 'prone/rotated')
    // Observed: worst landmark 8 (right ear), margin ≈ 31.80% of r.
    expect(worstMargin).toBeGreaterThan(0)
  })

  // --- Genuine finding from review, reproduced with this file's own fixtures ---
  //
  // The three tests above use this file's default fixture proportions
  // (shDrop=0.18), under which sFace always dominates sTorso and the torso
  // estimator never actually engages — they exercise the "normal" path
  // only. The "does not collapse in profile" test earlier in this file
  // deliberately tightens shDrop to 0.10 to force the sFace/sTorso
  // crossover; that closer framing is also common for a side-on knee/hip
  // shot, and it is the scenario the reviewer's arithmetic flagged as
  // marginal (sTorso taking over shrinks the profile radius well below the
  // frontal one, while CRANIUM_NUDGE keeps pushing the centre toward the
  // cranium, away from the mouth/jaw).
  //
  // Reusing that exact fixture here reproduces the concern with this
  // repo's real constants:
  //   frontal.r ≈ 95.42px  (sFace wins)
  //   profile.r ≈ 78.38px  (sTorso wins — the torso estimator takes over)
  // and the mouth landmarks (9, 10) land OUTSIDE the circle by ~5% of r
  // (~4px, ≈0.05 head-widths).
  //
  // Per instructions this is REPORTED, not silently fixed by tuning
  // HEAD_RADIUS_FACTOR / TORSO_SCALE_COEFF / CRANIUM_NUDGE — see
  // .superpowers/sdd/2026-08-05-face-blur-redaction/fix-wave-report.md.
  // This test is intentionally left failing as a canary: it should only
  // go green again once someone deliberately revisits those constants.
  it('KNOWN GAP: close-framed profile pose (sTorso takeover) does not cover the mouth landmarks', () => {
    const lm = profilePose({ shDrop: 0.10 })
    const reg = headRegion(lm, W, H)
    assertAllInside(lm, reg, 'profile (shDrop=0.10, close framing — sTorso takeover)')
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

describe('redactionGeometry', () => {
  it('pads the source square by twice the blur radius', () => {
    const g = redactionGeometry({ cx: 200, cy: 300, r: 100 })
    expect(g.padding).toBeCloseTo(2 * g.blurRadius)
    expect(g.size).toBeCloseTo(2 * (100 + g.padding))
    expect(g.x).toBeCloseTo(200 - g.size / 2)
    expect(g.y).toBeCloseTo(300 - g.size / 2)
  })

  it('scales blur strength with head size, so a close-up is not under-blurred', () => {
    const near = redactionGeometry({ cx: 0, cy: 0, r: 200 })
    const far  = redactionGeometry({ cx: 0, cy: 0, r: 50 })
    expect(near.blurRadius).toBeGreaterThan(far.blurRadius * 3)
  })

  it('returns null for a missing or degenerate region', () => {
    expect(redactionGeometry(null)).toBeNull()
    expect(redactionGeometry({ cx: 1, cy: 1, r: 0 })).toBeNull()
  })
})
