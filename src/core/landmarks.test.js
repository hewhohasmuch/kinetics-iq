/**
 * landmarks.test.js
 *
 * The stored landmark set is the evidence a clinician's verification is
 * measured against, and the coordinate space it uses is the reason a snapshot
 * can be re-annotated at all. Both are pinned here.
 */

import { describe, it, expect } from 'vitest'
import {
  JOINT_CONFIG, ROLES, LANDMARK_SPACE,
  landmarkKind, normalizeSet, normalizeSetInRect, denormalizeSet, isLandmarkSet,
} from './landmarks.js'
import { jointAngle } from './angle.js'

// Deliberately BENT, not collinear. Collinear points stay collinear under any
// affine transform, so they cannot detect an aspect-ratio mistake at all — and
// they would make the scale-invariance test below pass trivially at 0 degrees.
const markers = {
  proximal: { center: { x: 320, y: 180 }, visibility: 0.9 },
  joint:    { center: { x: 640, y: 540 }, visibility: 0.95 },
  distal:   { center: { x: 960, y: 300 }, visibility: 0.8 },
}
const VW = 1280
const VH = 720

describe('landmarkKind — derived from JOINT_CONFIG, never stored separately', () => {

  it('calls a single landmark index anatomical', () => {
    expect(landmarkKind('knee', 'right', 'proximal')).toBe('anatomical')
    expect(landmarkKind('elbow', 'left', 'joint')).toBe('anatomical')
  })

  it('calls the ankle\'s midpoint proximal point DERIVED', () => {
    // { midpoint: [knee, ankle] } is a constructed geometric reference with no
    // anatomy behind it. An editor must label it "shin direction", never
    // "joint centre".
    expect(landmarkKind('ankle', 'left', 'proximal')).toBe('derived')
    expect(landmarkKind('ankle', 'right', 'proximal')).toBe('derived')
  })

  it('still calls the ankle\'s own joint and distal points anatomical', () => {
    expect(landmarkKind('ankle', 'right', 'joint')).toBe('anatomical')
    expect(landmarkKind('ankle', 'right', 'distal')).toBe('anatomical')
  })

  it('returns null for an unknown joint or side rather than guessing', () => {
    expect(landmarkKind('wrist', 'right', 'joint')).toBeNull()
    expect(landmarkKind('knee', 'middle', 'joint')).toBeNull()
  })

  it('gives every configured joint/side/role a kind', () => {
    // A joint added to JOINT_CONFIG later gets the right behaviour for free —
    // that is the whole reason this derives rather than being maintained.
    for (const joint of Object.keys(JOINT_CONFIG)) {
      for (const side of ['left', 'right']) {
        for (const role of ROLES) {
          expect(landmarkKind(joint, side, role)).toMatch(/^(anatomical|derived)$/)
        }
      }
    }
  })
})

describe('normalizeSet', () => {

  it('stores coordinates as fractions of the frame buffer', () => {
    const set = normalizeSet(markers, VW, VH, 'knee', 'right')
    expect(set.joint.x).toBeCloseTo(0.5, 10)
    expect(set.joint.y).toBeCloseTo(0.75, 10)
  })

  it('carries visibility and kind on every point', () => {
    const set = normalizeSet(markers, VW, VH, 'ankle', 'right')
    expect(set.proximal.visibility).toBe(0.9)
    expect(set.proximal.kind).toBe('derived')
    expect(set.joint.kind).toBe('anatomical')
  })

  it('returns null when any role is missing — all three or nothing', () => {
    // A partial set cannot produce an angle, and storing one would invite a
    // consumer to assume the missing point sat at the origin.
    const { distal, ...partial } = markers
    expect(normalizeSet(partial, VW, VH, 'knee', 'right')).toBeNull()
  })

  it('returns null without frame dimensions rather than dividing by zero', () => {
    expect(normalizeSet(markers, 0, VH, 'knee', 'right')).toBeNull()
    expect(normalizeSet(markers, VW, 0, 'knee', 'right')).toBeNull()
  })
})

describe('coordinate round trip', () => {

  it('normalized → pixels → normalized returns the original point', () => {
    const set = normalizeSet(markers, VW, VH, 'knee', 'right')
    const px  = denormalizeSet(set, VW, VH)
    for (const role of ROLES) {
      expect(px[role].x).toBeCloseTo(markers[role].center.x, 6)
      expect(px[role].y).toBeCloseTo(markers[role].center.y, 6)
    }
  })

  it('preserves kind and visibility through denormalization', () => {
    const set = normalizeSet(markers, VW, VH, 'ankle', 'right')
    const px  = denormalizeSet(set, 400, 300)
    expect(px.proximal.kind).toBe('derived')
    expect(px.distal.visibility).toBe(0.8)
  })
})

describe('scale invariance — why normalized fractions are safe to store', () => {

  it('yields the SAME angle at any image resolution', () => {
    // The stored snapshot is downscaled to SNAPSHOT_MAX_EDGE and may be
    // re-encoded later. jointAngle() is scale- and translation-invariant, so a
    // recompute from these fractions reproduces the live 2D angle exactly —
    // which is what makes the frame re-annotatable at all.
    const set = normalizeSet(markers, VW, VH, 'knee', 'right')

    const angleAt = (w, h) => {
      const p = denormalizeSet(set, w, h)
      return jointAngle(p.proximal, p.joint, p.distal)
    }

    const full = angleAt(VW, VH)
    // Same aspect ratio, three very different sizes — EXACTLY equal.
    expect(angleAt(640, 360)).toBeCloseTo(full, 10)
    expect(angleAt(1920, 1080)).toBeCloseTo(full, 10)
    expect(angleAt(160, 90)).toBeCloseTo(full, 10)
  })

  it('is bounded, not exact, once the stored frame rounds to whole pixels', () => {
    // SNAPSHOT_MAX_EDGE downscales 1280x720 by 1100/1280, giving a height of
    // 618.75 that must round to 619 — a 0.04% aspect change the recompute
    // cannot undo. Measured at 0.1 degrees on this geometry, which is two
    // orders of magnitude below the landmark bias this feature exists to
    // address. Worth knowing about; not worth correcting.
    const set = normalizeSet(markers, VW, VH, 'knee', 'right')
    const exact   = recomputeAngle(set, { joint: 'knee', width: VW,   height: VH })
    const stored  = recomputeAngle(set, { joint: 'knee', width: 1100, height: 619 })
    expect(Math.abs(stored - exact)).toBeLessThanOrEqual(0.2)
  })
})

describe('isLandmarkSet', () => {

  it('accepts a complete set', () => {
    expect(isLandmarkSet(normalizeSet(markers, VW, VH, 'knee', 'right'))).toBe(true)
  })

  it('rejects absence, which is an ordinary outcome not an error', () => {
    expect(isLandmarkSet(null)).toBe(false)
    expect(isLandmarkSet(undefined)).toBe(false)
    expect(isLandmarkSet({})).toBe(false)
  })

  it('rejects a set with a non-finite coordinate', () => {
    const set = normalizeSet(markers, VW, VH, 'knee', 'right')
    expect(isLandmarkSet({ ...set, joint: { x: NaN, y: 0.5 } })).toBe(false)
  })

  it('accepts a point at exactly 0 — the top-left corner is a real position', () => {
    const set = normalizeSet(markers, VW, VH, 'knee', 'right')
    expect(isLandmarkSet({ ...set, proximal: { x: 0, y: 0 } })).toBe(true)
  })
})

describe('normalizeSetInRect — the stored frame is a CROP of the buffer', () => {

  // The region the camera view was actually showing: portrait phone against a
  // landscape stream, so a tall centre slice of it.
  const rect = { x: 419, y: 0, width: 442, height: 720 }

  it('takes fractions of the STORED region, not of the buffer it came from', () => {
    const set = normalizeSetInRect(markers, rect, 'knee', 'right')
    expect(set.joint.x).toBeCloseTo((640 - 419) / 442, 10)
    expect(set.joint.y).toBeCloseTo(540 / 720, 10)
  })

  it('agrees with normalizeSet when the rect IS the whole buffer', () => {
    expect(normalizeSetInRect(markers, { x: 0, y: 0, width: VW, height: VH }, 'knee', 'right'))
      .toEqual(normalizeSet(markers, VW, VH, 'knee', 'right'))
  })

  it('does NOT clamp a point that fell outside the rect', () => {
    // The proximal point here sits left of this crop, and the honest answer is
    // a negative fraction. Clamping would move a landmark — silently inventing
    // a placement the model never made — so keeping every point inside its own
    // image is the CROP's job, not this function's: storedFrameRect() widens
    // the rect until the evidence fits. See frameCrop.test.js.
    const set = normalizeSetInRect(markers, rect, 'knee', 'right')
    expect(set.proximal.x).toBeLessThan(0)
  })

  it('carries the same kind and visibility as the uncropped set', () => {
    const cropped = normalizeSetInRect(markers, rect, 'ankle', 'left')
    expect(cropped.proximal.kind).toBe('derived')     // shin direction, not a joint
    expect(cropped.distal.visibility).toBe(0.8)
  })

  it('RECOMPUTES TO THE SAME ANGLE as the uncropped set', () => {
    // The whole reason cropping is safe. Cropping translates the points and
    // renormalizes against a different aspect; projecting back into a space of
    // the CROP's own ratio makes that a translation plus a UNIFORM scale, which
    // jointAngle() is invariant to. If this ever fails, every stored angle and
    // every verification on a cropped frame is measuring a stretched space.
    const truth = recomputeAngle(normalizeSet(markers, VW, VH, 'knee', 'right'),
                                 { joint: 'knee', width: VW, height: VH })
    const cropped = recomputeAngle(normalizeSetInRect(markers, rect, 'knee', 'right'),
                                   { joint: 'knee', width: rect.width, height: rect.height })
    expect(cropped).toBeCloseTo(truth, 5)
  })

  it('holds for a crop on the OTHER axis too', () => {
    const wide = { x: 0, y: 96, width: 1280, height: 528 }
    const truth = recomputeAngle(normalizeSet(markers, VW, VH, 'knee', 'right'),
                                 { joint: 'knee', width: VW, height: VH })
    const cropped = recomputeAngle(normalizeSetInRect(markers, wide, 'knee', 'right'),
                                   { joint: 'knee', width: wide.width, height: wide.height })
    expect(cropped).toBeCloseTo(truth, 5)
  })

  it('returns null for a degenerate rect rather than dividing by zero', () => {
    expect(normalizeSetInRect(markers, { x: 0, y: 0, width: 0, height: 720 }, 'knee', 'right')).toBeNull()
    expect(normalizeSetInRect(markers, null, 'knee', 'right')).toBeNull()
  })
})

describe('LANDMARK_SPACE', () => {

  it('is the stamp the migration and the renderer both branch on', () => {
    // Bumped from 'video1' when snapshots stopped storing the whole video
    // buffer and started storing the visible crop: the stamp describes HOW THE
    // FRAME WAS STORED, so it moves when that changes. Nothing branches on
    // which of the two it is — only on presence, which still means "clean frame
    // plus landmarks" and absence still means the legacy baked composite.
    expect(LANDMARK_SPACE).toBe('frame1')
  })
})

// ─── Recomputing from a set (the verification path) ──────────────────────────

import { recomputeAngle, segmentLengths, landmarkDelta, buildVerification } from './landmarks.js'
import { toClinicalAngle } from './angle.js'

describe('recomputeAngle', () => {

  const W = 1280, H = 720
  const set = normalizeSet(markers, W, H, 'knee', 'right')

  // What the live path computed, from the same points in video pixel space.
  const truth = Math.round(
    toClinicalAngle(jointAngle(markers.proximal.center, markers.joint.center, markers.distal.center), 'knee') * 10
  ) / 10

  it('reproduces the angle the live path measured', () => {
    expect(recomputeAngle(set, { joint: 'knee', width: W, height: H })).toBe(truth)
  })

  it('gives the same answer at any resolution of the SAME aspect ratio', () => {
    // This is what makes the SNAPSHOT_MAX_EDGE downscale harmless.
    expect(recomputeAngle(set, { joint: 'knee', width: 640,  height: 360 })).toBe(truth)
    expect(recomputeAngle(set, { joint: 'knee', width: 1100, height: 619 })).toBeCloseTo(truth, 0)
  })

  it('THE TRAP — treating normalized fractions as a square space is wrong', () => {
    // x is divided by width and y by height, which is NON-uniform whenever the
    // frame is not square. Computing in that space returns a plausible, wrong
    // number rather than failing, which is why the aspect ratio is required.
    const asSquare = recomputeAngle(set, { joint: 'knee', width: 1, height: 1 })
    expect(asSquare).not.toBe(truth)
    expect(Math.abs(asSquare - truth)).toBeGreaterThan(5)
  })

  it('applies the calibration offset as a plain subtraction', () => {
    const raw = recomputeAngle(set, { joint: 'knee', width: W, height: H })
    const zeroed = recomputeAngle(set, { joint: 'knee', width: W, height: H, calibrationOffset: 8.6 })
    expect(zeroed).toBeCloseTo(Math.round((raw - 8.6) * 10) / 10, 5)
  })

  it('honours the per-joint convention rather than a hinge rule', () => {
    // A shoulder and a knee with identical geometry are different clinical
    // angles — the whole reason JOINT_ANGLE_CONVENTION exists.
    const knee = recomputeAngle(set, { joint: 'knee', width: W, height: H })
    const shoulder = recomputeAngle(set, { joint: 'shoulder', width: W, height: H })
    expect(shoulder).not.toBe(knee)
  })

  it('returns null rather than a number when the set is unusable', () => {
    expect(recomputeAngle(null, { joint: 'knee', width: W, height: H })).toBeNull()
    expect(recomputeAngle(set, { joint: 'knee', width: 0, height: H })).toBeNull()
  })
})

describe('segmentLengths — advisory, never a lock', () => {

  const W = 1280, H = 720
  const set = normalizeSet(markers, W, H, 'knee', 'right')

  it('measures both segments in the frame\'s pixel space', () => {
    const len = segmentLengths(set, W, H)
    expect(len.proximal).toBeCloseTo(Math.hypot(640 - 320, 540 - 180), 6)
    expect(len.distal).toBeCloseTo(Math.hypot(960 - 640, 300 - 540), 6)
  })

  it('returns null for an unusable set', () => {
    expect(segmentLengths(null, W, H)).toBeNull()
  })
})

describe('landmarkDelta — derived, never stored', () => {

  const raw = normalizeSet(markers, 1280, 720, 'knee', 'right')

  it('reports nothing moved when the sets are identical', () => {
    const d = landmarkDelta(raw, { ...raw })
    expect(d.moved).toEqual([])
    expect(d.joint.distance).toBe(0)
  })

  it('names only the points that actually moved', () => {
    const verified = { ...raw, joint: { ...raw.joint, x: raw.joint.x + 0.02 } }
    const d = landmarkDelta(raw, verified)
    expect(d.moved).toEqual(['joint'])
    expect(d.joint.dx).toBeCloseTo(0.02, 10)
    expect(d.proximal.distance).toBe(0)
  })

  it('is recoverable for every role, so nothing needs storing alongside', () => {
    const verified = {
      proximal: { ...raw.proximal, y: raw.proximal.y - 0.01 },
      joint:    { ...raw.joint,    x: raw.joint.x + 0.02 },
      distal:   { ...raw.distal,   x: raw.distal.x - 0.03 },
    }
    expect(landmarkDelta(raw, verified).moved.sort()).toEqual(['distal', 'joint', 'proximal'])
  })

  it('returns null when either set is unusable', () => {
    expect(landmarkDelta(raw, null)).toBeNull()
    expect(landmarkDelta(null, raw)).toBeNull()
  })
})

describe('buildVerification — the only constructor', () => {

  const raw = normalizeSet(markers, 1280, 720, 'knee', 'right')
  const base = { id: 'v1', at: 1000, landmarks: { peak: raw, min: null },
                 angles: { max: 127.3, min: null }, byDevice: 'dev-1' }

  it('records attribution mode explicitly', () => {
    const v = buildVerification({ ...base, by: 'user-1', byMode: 'account' })
    expect(v.by).toBe('user-1')
    expect(v.byMode).toBe('account')
    expect(v.byDevice).toBe('dev-1')
  })

  it('defaults the mode from whether an account exists, but stores it either way', () => {
    expect(buildVerification({ ...base, by: null }).byMode).toBe('device')
    expect(buildVerification({ ...base, by: 'user-1' }).byMode).toBe('account')
  })

  it('keeps an unverified end as NULL, never as 0', () => {
    // 0 is a legitimate reading; absence is not.
    const v = buildVerification(base)
    expect(v.angles.min).toBeNull()
    expect(v.landmarks.min).toBeNull()
  })

  it('keeps a verified 0 as 0', () => {
    const v = buildVerification({ ...base, angles: { max: 120, min: 0 } })
    expect(v.angles.min).toBe(0)
  })

  it('keeps a negative verified angle signed', () => {
    const v = buildVerification({ ...base, angles: { max: 120, min: -4.2 } })
    expect(v.angles.min).toBe(-4.2)
  })

  it('always produces both landmark and angle slots, so the shape is total', () => {
    const v = buildVerification({ id: 'v2', byDevice: 'd' })
    expect(v.landmarks).toEqual({ peak: null, min: null })
    expect(v.angles).toEqual({ max: null, min: null })
  })
})
