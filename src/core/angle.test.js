/**
 * angle.test.js
 *
 * Tests for the core angle calculation functions.
 * Run with: npm test
 *
 * These tests use exact geometric configurations where the correct
 * answer is known analytically — no approximation needed.
 */

import { describe, it, expect } from 'vitest'
import { jointAngle, toFlexionAngle, AngleSmoother, applyCalibration, DeadZoneFilter } from './angle.js'

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Check angle within a tolerance (floating point math) */
function expectAngle(actual, expected, toleranceDeg = 0.01) {
  expect(actual).not.toBeNull()
  expect(Math.abs(actual - expected)).toBeLessThan(toleranceDeg)
}

// ─── jointAngle() ─────────────────────────────────────────────────────────────

describe('jointAngle()', () => {

  it('returns 180° for a perfectly straight leg (collinear points)', () => {
    // A directly above B, C directly below B — straight vertical line
    const A = { x: 100, y: 0   }
    const B = { x: 100, y: 100 }
    const C = { x: 100, y: 200 }
    expectAngle(jointAngle(A, B, C), 180)
  })

  it('returns 90° for a right angle', () => {
    // A is directly above B, C is directly to the right of B
    const A = { x: 0, y: 0 }   // up
    const B = { x: 0, y: 100 } // joint
    const C = { x: 100, y: 100 } // right
    expectAngle(jointAngle(A, B, C), 90)
  })

  it('returns 90° for right angle in opposite orientation', () => {
    const A = { x: 100, y: 100 } // right
    const B = { x: 0, y: 100 }   // joint
    const C = { x: 0, y: 0 }     // up
    expectAngle(jointAngle(A, B, C), 90)
  })

  it('is symmetric — angle(A,B,C) === angle(C,B,A)', () => {
    const A = { x: 50,  y: 0   }
    const B = { x: 100, y: 100 }
    const C = { x: 200, y: 80  }
    const forward  = jointAngle(A, B, C)
    const reversed = jointAngle(C, B, A)
    expectAngle(forward, reversed)
  })

  it('returns 60° for an equilateral triangle configuration', () => {
    // Equilateral triangle: all angles = 60°
    const A = { x: 0,  y: 0 }
    const B = { x: 1,  y: 0 }
    const C = { x: 0.5, y: Math.sqrt(3) / 2 }
    expectAngle(jointAngle(A, B, C), 60, 0.1)
  })

  it('handles non-symmetric / diagonal markers (realistic scenario)', () => {
    // Markers placed as they'd appear in a real camera frame:
    // person standing sideways, camera slightly off-center
    const thigh = { x: 320, y: 150 }  // proximal
    const knee  = { x: 340, y: 320 }  // joint
    const shin  = { x: 310, y: 490 }  // distal
    const angle = jointAngle(thigh, knee, shin)
    expect(angle).not.toBeNull()
    expect(angle).toBeGreaterThan(150)  // near-straight leg
    expect(angle).toBeLessThan(180)
  })

  it('handles a bent knee (~90° flexion in camera view)', () => {
    // Knee bent to ~90° as it would appear in video:
    // thigh going up-left, shin going down-left
    const thigh = { x: 200, y: 100 }
    const knee  = { x: 300, y: 300 }
    const shin  = { x: 150, y: 400 }
    const angle = jointAngle(thigh, knee, shin)
    expect(angle).not.toBeNull()
    expect(angle).toBeGreaterThan(60)
    expect(angle).toBeLessThan(120)
  })

  it('returns null for missing points', () => {
    expect(jointAngle(null, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeNull()
    expect(jointAngle({ x: 0, y: 0 }, null, { x: 1, y: 0 })).toBeNull()
    expect(jointAngle({ x: 0, y: 0 }, { x: 1, y: 0 }, null)).toBeNull()
    expect(jointAngle(null, null, null)).toBeNull()
  })

  it('returns null when markers are at the same position (zero-length vector)', () => {
    const same = { x: 100, y: 100 }
    expect(jointAngle(same, same, { x: 200, y: 200 })).toBeNull()
  })

})

// ─── jointAngle() with 3D (z) coordinates ──────────────────────────────────────

describe('jointAngle() with 3D (z) coordinates', () => {

  it('2D regression: points without z behave exactly as before', () => {
    // Right angle in the xy-plane, no z → must still be 90°
    const A = { x: 0, y: 0 }
    const B = { x: 0, y: 100 }
    const C = { x: 100, y: 100 }
    expectAngle(jointAngle(A, B, C), 90)
  })

  it('treats a missing z as 0 (2D and explicit-z-0 agree)', () => {
    const A2 = { x: 0, y: 0 },       B2 = { x: 0, y: 100 },       C2 = { x: 100, y: 100 }
    const A3 = { x: 0, y: 0, z: 0 }, B3 = { x: 0, y: 100, z: 0 }, C3 = { x: 100, y: 100, z: 0 }
    expectAngle(jointAngle(A3, B3, C3), jointAngle(A2, B2, C2))
  })

  it('returns 90° for a right angle spanning the z axis', () => {
    // BA points along +z, BC points along +x → perpendicular
    const A = { x: 0, y: 0, z: 1 }
    const B = { x: 0, y: 0, z: 0 }
    const C = { x: 1, y: 0, z: 0 }
    expectAngle(jointAngle(A, B, C), 90)
  })

  it('returns 180° for points collinear in 3D space', () => {
    const A = { x: 0, y: 0, z: 0 }
    const B = { x: 1, y: 1, z: 1 }
    const C = { x: 2, y: 2, z: 2 }
    expectAngle(jointAngle(A, B, C), 180)
  })

  it('recovers the true angle where the 2D projection is misleading', () => {
    // A limb bent ~116.6° in real space, but whose camera projection (drop z)
    // looks like a straight 180° line — the exact foreshortening case 3D fixes.
    const A = { x: 0, y: 1,  z: 0 }
    const B = { x: 0, y: 0,  z: 0 }
    const C = { x: 0, y: -1, z: 2 }

    // True 3D angle = acos(-1/√5) ≈ 116.565°
    expectAngle(jointAngle(A, B, C), 116.565, 0.01)

    // Same points projected to 2D (z stripped) read as a straight line
    const strip = p => ({ x: p.x, y: p.y })
    expectAngle(jointAngle(strip(A), strip(B), strip(C)), 180)
  })

})

// ─── toFlexionAngle() ──────────────────────────────────────────────────────────

describe('toFlexionAngle()', () => {

  it('converts 180° interior angle to 0° flexion (full extension)', () => {
    expect(toFlexionAngle(180)).toBe(0)
  })

  it('converts 90° interior angle to 90° flexion', () => {
    expect(toFlexionAngle(90)).toBe(90)
  })

  it('converts 40° interior angle to 140° flexion (deep bend)', () => {
    expect(toFlexionAngle(40)).toBe(140)
  })

})

// ─── AngleSmoother ─────────────────────────────────────────────────────────────

describe('AngleSmoother', () => {

  it('returns null when buffer is empty', () => {
    const s = new AngleSmoother(5)
    expect(s.current()).toBeNull()
  })

  it('returns exact value with window of 1', () => {
    const s = new AngleSmoother(1)
    expect(s.push(42)).toBe(42)
    expect(s.push(99)).toBe(99)
  })

  it('averages correctly across window', () => {
    const s = new AngleSmoother(4)
    s.push(10)
    s.push(20)
    s.push(30)
    s.push(40)
    expectAngle(s.current(), 25)  // (10+20+30+40)/4 = 25
  })

  it('slides the window (drops oldest values)', () => {
    const s = new AngleSmoother(3)
    s.push(10)
    s.push(20)
    s.push(30)
    s.push(40)  // drops 10
    expectAngle(s.current(), 30)  // (20+30+40)/3 = 30
  })

  it('ignores null values (marker lost)', () => {
    const s = new AngleSmoother(5)
    s.push(90)
    s.push(92)
    const before = s.current()
    s.push(null)   // marker lost
    s.push(null)   // still lost
    // Buffer unchanged — last known value returned
    expect(s.current()).toBeCloseTo(before, 1)
  })

  it('resets cleanly', () => {
    const s = new AngleSmoother(5)
    s.push(90)
    s.push(92)
    s.reset()
    expect(s.current()).toBeNull()
    expect(s.bufferLength).toBe(0)
  })

  it('throws if windowSize < 1', () => {
    expect(() => new AngleSmoother(0)).toThrow()
    expect(() => new AngleSmoother(-1)).toThrow()
  })

})

// ─── applyCalibration() ────────────────────────────────────────────────────────

describe('applyCalibration()', () => {

  it('returns 0 when rawAngle equals offset (standing straight)', () => {
    expect(applyCalibration(175, 175)).toBe(0)
  })

  it('returns correct delta for bent position', () => {
    expect(applyCalibration(90, 170)).toBe(-80)
  })

  it('works with zero offset', () => {
    expect(applyCalibration(90, 0)).toBe(90)
  })

})

// ─── DeadZoneFilter ────────────────────────────────────────────────────────────

describe('DeadZoneFilter', () => {
  it('returns null when empty', () => {
    const f = new DeadZoneFilter(1.5)
    expect(f.push(null)).toBeNull()
  })

  it('passes first value through unconditionally', () => {
    const f = new DeadZoneFilter(1.5)
    expect(f.push(45)).toBe(45)
  })

  it('holds value when change is below threshold', () => {
    const f = new DeadZoneFilter(1.5)
    f.push(45)
    expect(f.push(45.5)).toBe(45)   // 0.5° change — below threshold
    expect(f.push(46.0)).toBe(45)   // 1.0° change — still below
    expect(f.push(44.8)).toBe(45)   // 0.2° change — still below
  })

  it('updates when change meets or exceeds threshold', () => {
    const f = new DeadZoneFilter(1.5)
    f.push(45)
    expect(f.push(46.5)).toBe(46.5)  // exactly 1.5° — updates
    expect(f.push(48.1)).toBe(48.1)  // 1.6° change — updates
  })

  it('resets cleanly', () => {
    const f = new DeadZoneFilter(1.5)
    f.push(90)
    f.reset()
    expect(f.value).toBeNull()
    expect(f.push(45)).toBe(45)  // first value after reset passes through
  })
})
