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
  landmarkKind, normalizeSet, denormalizeSet, isLandmarkSet,
} from './landmarks.js'
import { jointAngle } from './angle.js'

const markers = {
  proximal: { center: { x: 320, y: 180 }, visibility: 0.9 },
  joint:    { center: { x: 640, y: 540 }, visibility: 0.95 },
  distal:   { center: { x: 960, y: 900 }, visibility: 0.8 },
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
    // Same aspect ratio, three very different sizes.
    expect(angleAt(640, 360)).toBeCloseTo(full, 10)
    expect(angleAt(1100, 619)).toBeCloseTo(full, 6)
    expect(angleAt(160, 90)).toBeCloseTo(full, 10)
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

describe('LANDMARK_SPACE', () => {

  it('is the stamp the migration and the renderer both branch on', () => {
    expect(LANDMARK_SPACE).toBe('video1')
  })
})
