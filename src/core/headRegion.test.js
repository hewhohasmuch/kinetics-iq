import { describe, it, expect } from 'vitest'
import { headRegion, redactionGeometry, headInputsFinite, anyFaceLandmarkInFrame, MAX_RADIUS_FRACTION, COVERAGE_MARGIN } from './headRegion.js'

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

  // ─── Mutation guards: each scale estimator must be load-bearing ──────
  //
  // These two tests replace an earlier single test that pinned
  //   90 < frontal(shDrop=0.10).r < 100  and  profile.r >= 0.75 × frontal.r
  // Both of those assertions went VACUOUS when COVERAGE_MARGIN containment
  // was added, because shDrop=0.10 is precisely the sFace/sTorso crossover —
  // the point where deleting either estimator barely moves the radius,
  // since the containment term picks up most of the slack:
  //
  //   fixture              baseline   scale=sTorso     scale=sFace
  //   frontal shDrop 0.10    99.00      92.56 (-6.5%)    99.00 ( 0.0%)
  //   profile shDrop 0.10    90.64      90.64 ( 0.0%)    84.30 (-7.0%)
  //   → old band  (90..100):  99.00 ok,  92.56 ok  ← MISSES scale=sTorso
  //   → old ratio (>= 0.75):  0.9155,    0.9792,   0.8516 ← MISSES both
  //
  // So each estimator is now pinned at the framing where it actually does
  // the work, and the numbers below are measured, not assumed.

  it('keeps sFace load-bearing: close framing, where the torso distance is too short to set the scale', () => {
    // shDrop=0.04 puts the shoulders almost at the chin: the face-centroid →
    // shoulder distance is ~36.9px, so sTorso ≈ 25.8px and only the face span
    // can set a sensible scale.
    const reg = headRegion(pose({ shDrop: 0.04 }), W, H)
    expect(reg).not.toBeNull()

    // MUTATION (i) — delete sFace (scale = sTorso):
    //   r 99.00 → 75.43 (-23.8%), cy 282.88 → 304.84.
    //   The circle collapses onto the face landmarks themselves (containment
    //   alone, from a centre that barely gets nudged) and stops covering the
    //   cranium: clearance above the eye line falls 115.6px → 70.1px.
    // MUTATION (ii) — delete sTorso: r unchanged at 99.00. This fixture is
    //   deliberately silent about sTorso; the profile test below covers it.
    expect(reg.r).toBeGreaterThan(90)

    // The same failure stated as the property that actually matters — the
    // cranium and hair sit above the topmost landmark and have no landmark
    // of their own, so containment cannot cover them. Only the heuristic can.
    const eyeY = (0.25 - 0.04 * 0.4) * H   // 299.5px
    expect(eyeY - (reg.cy - reg.r)).toBeGreaterThan(100)   // observed 115.64px
  })

  it('keeps sTorso load-bearing: does not collapse in profile', () => {
    // Default framing (shDrop=0.18), where the profile squeeze is the real
    // scenario. The x-only squeeze leaves the face centroid — and therefore
    // sTorso — untouched, so the radius must not move at all.
    const frontal = headRegion(pose(), W, H)
    const profile = headRegion(profilePose(), W, H)
    expect(profile).not.toBeNull()

    // Baseline: frontal.r = profile.r = 139.30 (sTorso dominates both).
    // MUTATION (ii) — delete sTorso (scale = sFace):
    //   frontal.r 139.30 → 99.00, profile.r 139.30 → 84.30 (-39.5%),
    //   ratio 1.0000 → 0.8516. Both assertions below fail.
    // MUTATION (i) — delete sFace: both unchanged at 139.30. Not this test's
    //   job; the close-framing test above is what catches that one.
    expect(profile.r).toBeGreaterThan(120)
    expect(profile.r).toBeGreaterThanOrEqual(0.95 * frontal.r)
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

  it('lets the cap OVERRIDE containment — the one documented exception', () => {
    // The containment term (COVERAGE_MARGIN) is applied BEFORE the cap, so on
    // a garbage landmark frame the cap wins and containment does NOT hold.
    // This is deliberate: a circle covering half the picture is its own
    // failure, and a frame whose landmarks are this wrong is untrustworthy
    // anyway. Pinned here so the ordering cannot be "fixed" the other way
    // round without someone reading the JSDoc first.
    const lm  = pose({ hw: 5, hh: 5, shDrop: 8 })
    const reg = headRegion(lm, W, H)
    expect(reg.r).toBe(MAX_RADIUS_FRACTION * Math.min(W, H))   // capped, 360px

    // ...and with the radius capped, at least one face landmark really is
    // outside. This is the honest statement of the guarantee's limit, not a
    // bug: containment holds only while the radius is uncapped.
    const outside = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].some(
      (i) => Math.hypot(lm[i].x * W - reg.cx, lm[i].y * H - reg.cy) > reg.r
    )
    expect(outside).toBe(true)
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
  //
  // Containment is now an INVARIANT, not an observation: headRegion() grows
  // the radius to maxDistanceFromCentre × COVERAGE_MARGIN. So the floor these
  // tests assert is the guarantee itself — every landmark must sit at least
  // (1 - 1/COVERAGE_MARGIN) = 9.09% of r inside the circle — and anything
  // above that floor is the heuristic over-covering on its own, which is
  // reported per fixture but not pinned.
  //
  // The one documented exception is MAX_RADIUS_FRACTION, applied after the
  // expansion and therefore overriding it; see the 'caps the radius' test.
  const FACE_IDX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  // 1 - 1/1.10 = 0.0909…  The guaranteed slack, minus float slop.
  const GUARANTEED_MARGIN = 1 - 1 / COVERAGE_MARGIN - 1e-9

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
    // Observed: worst landmark 9 (mouth left), 105.11px vs r=139.30px —
    // margin 24.55% of r. Heuristic-driven here; containment is inert.
    expect(worstIdx).toBeGreaterThanOrEqual(0)
    expect(worstMargin).toBeGreaterThan(GUARANTEED_MARGIN)
  })

  it('contains every face landmark for a profile pose', () => {
    const lm = profilePose()
    const { worstMargin } = assertAllInside(lm, headRegion(lm, W, H), 'profile')
    // Observed: worst landmark 10 (mouth right), 103.71px vs r=139.30px —
    // margin 25.55% of r. Heuristic-driven; containment inert.
    expect(worstMargin).toBeGreaterThan(GUARANTEED_MARGIN)
  })

  it('contains every face landmark for a prone/rotated pose', () => {
    const lm = proneRotatedPose()
    const { worstMargin } = assertAllInside(lm, headRegion(lm, W, H), 'prone/rotated')
    // Observed: worst landmark 8 (right ear), 88.30px vs r=129.46px —
    // margin 31.80% of r. Heuristic-driven; containment inert.
    expect(worstMargin).toBeGreaterThan(GUARANTEED_MARGIN)
  })

  // --- The case containment was added for -----------------------------
  //
  // The three fixtures above use shDrop=0.18, where sTorso dominates and the
  // heuristic radius already over-covers by ~25-32%. This one is the close
  // framing common to a side-on knee or hip shot (shDrop=0.10), sitting at
  // the sFace/sTorso crossover: the torso estimator takes over in profile
  // while CRANIUM_NUDGE keeps pushing the centre up toward the cranium and
  // away from the mouth/jaw.
  //
  // BEFORE COVERAGE_MARGIN this was a real, reported gap:
  //   profile.r = 78.38px, mouth landmark 9 at 82.40px — OUTSIDE by 5.13%
  //   of r (~4px), i.e. an unblurred mouth and chin in a stored snapshot.
  // It was carried as a deliberately failing canary rather than papered over
  // by re-tuning HEAD_RADIUS_FACTOR / TORSO_SCALE_COEFF / CRANIUM_NUDGE.
  //
  // The containment term fixes it by construction rather than by tuning:
  //   profile.r = 82.40 × 1.10 = 90.64px, worst margin exactly the
  //   guaranteed 9.09%. Note the constants above are UNCHANGED — the fix is
  //   the invariant, not a bigger fudge factor.
  it('contains every face landmark for a close-framed profile pose (the sTorso-takeover gap)', () => {
    const lm  = profilePose({ shDrop: 0.10 })
    const reg = headRegion(lm, W, H)
    const { worstIdx, worstMargin } =
      assertAllInside(lm, reg, 'profile (shDrop=0.10, close framing — sTorso takeover)')

    expect(worstIdx).toBe(9)                                  // mouth left, as before
    expect(worstMargin).toBeGreaterThan(GUARANTEED_MARGIN)

    // Pin that containment — not the heuristic — is what covers this frame.
    // If someone deletes the containment term, r drops back to the heuristic
    // 78.38px and the mouth is outside again.
    expect(reg.r).toBeGreaterThan(85)                         // observed 90.64px
  })

  it('keeps the heuristic as a floor when the face landmarks give no spread', () => {
    // This guards the heuristic's REMAINING job. At COVERAGE_MARGIN 1.60 the
    // containment term out-reaches the heuristic in every realistic pose, so
    // the old version of this test — asserting the frontal radius stayed above
    // 130px — became vacuous: containment produces 168px there with or without
    // the floor, and deleting the floor changed nothing.
    //
    // Where the floor still decides the outcome is a degenerate but reachable
    // frame: MediaPipe collapses the face landmarks onto a point (heavy
    // occlusion, or the subject far from the camera). maxDist is then only the
    // cranium nudge, so containment alone would draw a circle around nothing.
    const lm = pose()
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      lm[i] = { x: 0.5, y: 0.25, z: 0, visibility: 0.9 }
    }
    const reg = headRegion(lm, W, H)
    // Floor gives 0.85 × sTorso ≈ 137px; containment alone would give
    // 1.60 × nudge ≈ 77px, which this bound rejects.
    expect(reg.r).toBeGreaterThan(120)
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
