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
import {
  jointAngle, toFlexionAngle, AngleSmoother, applyCalibration, DeadZoneFilter,
  MedianFilter3, OneEuroFilter,
  JOINT_ANGLE_CONVENTION, toClinicalAngle, toInteriorAngle,
  JOINT_MOTION_TERMS, motionTerms,
} from './angle.js'

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

// ─── MedianFilter3 ─────────────────────────────────────────────────────────────

describe('MedianFilter3', () => {

  it('passes the first value through unchanged', () => {
    const f = new MedianFilter3()
    expect(f.push(90)).toBe(90)
  })

  it('rejects a single-frame spike', () => {
    const f = new MedianFilter3()
    f.push(90)
    f.push(90)
    expect(f.push(150)).toBe(90)   // one bad landmark frame — never surfaces
    expect(f.push(90)).toBe(90)
  })

  it('passes a genuine sustained peak through', () => {
    // A real end-range peak lasts more than one frame, so it must survive.
    const f = new MedianFilter3()
    f.push(90)
    f.push(90)
    f.push(130)
    expect(f.push(130)).toBe(130)
  })

  it('holds the current value when the pose is lost', () => {
    const f = new MedianFilter3()
    f.push(90)
    f.push(90)
    f.push(90)
    expect(f.push(null)).toBe(90)      // null does not enter the buffer
    expect(f.push(90)).toBe(90)        // ...and did not corrupt it
  })

  it('resets cleanly', () => {
    const f = new MedianFilter3()
    f.push(90)
    f.push(90)
    f.reset()
    expect(f.push(45)).toBe(45)
  })
})

// ─── OneEuroFilter ─────────────────────────────────────────────────────────────

describe('OneEuroFilter', () => {

  it('passes the first sample through as its seed', () => {
    const f = new OneEuroFilter()
    expect(f.push(90, 0)).toBe(90)
  })

  it('converges to a constant input and stays there', () => {
    const f = new OneEuroFilter()
    let out = null
    for (let i = 0; i < 50; i++) out = f.push(90, i * 100)
    expectAngle(out, 90, 0.1)
  })

  it('re-seeds after a gap instead of integrating a huge derivative', () => {
    // Pose lost for 2s, reacquired at a very different angle. Without a reset
    // the derivative term explodes and the output overshoots wildly.
    const f = new OneEuroFilter()
    for (let i = 0; i < 20; i++) f.push(90, i * 100)
    const out = f.push(30, 20 * 100 + 2000)
    expectAngle(out, 30, 0.01)
  })

  it('holds the current value when the pose is lost', () => {
    const f = new OneEuroFilter()
    for (let i = 0; i < 20; i++) f.push(90, i * 100)
    expect(f.push(null, 2100)).toBeCloseTo(90, 1)
  })

  it('resets cleanly', () => {
    const f = new OneEuroFilter()
    for (let i = 0; i < 20; i++) f.push(90, i * 100)
    f.reset()
    expect(f.push(45, 5000)).toBe(45)
  })
})

// ─── Peak-flexion clipping regression ──────────────────────────────────────────

/**
 * Deterministic pseudo-random in [-1, 1] — seeded so the jitter test can't
 * flake between runs.
 */
function seededNoise(seed) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return (s / 4294967296) * 2 - 1
  }
}

/**
 * A realistic ROM sweep: the joint accelerates out of neutral, decelerates
 * into end range, and returns — one cosine cycle from 0° to `amplitude` and
 * back. A perfect triangle wave would be unfair to any median prefilter
 * (its apex is a single sample, indistinguishable from a spike); a real
 * turnaround dwells near the peak because the limb has to decelerate.
 */
function sweepSamples({ amplitude = 130, periodS = 4, hz = 10 } = {}) {
  const out = []
  const n = Math.round(periodS * hz)
  for (let i = 0; i <= n; i++) {
    const t = i / hz
    out.push({
      ms:    t * 1000,
      value: (amplitude / 2) * (1 - Math.cos((2 * Math.PI * t) / periodS)),
    })
  }
  return out
}

/** The chain as it was: 1.5s moving average, then a 2° dead zone. */
function runOldChain(samples) {
  const smoother = new AngleSmoother(15)
  const deadZone = new DeadZoneFilter(2.0)
  let peak = -Infinity
  for (const s of samples) {
    const out = deadZone.push(smoother.push(s.value))
    if (out !== null) peak = Math.max(peak, out)
  }
  return peak
}

/** The chain as it is now: median-of-3 spike rejection, then One Euro. */
function runNewChain(samples) {
  const median = new MedianFilter3()
  const euro   = new OneEuroFilter()
  let peak = -Infinity
  for (const s of samples) {
    const out = euro.push(median.push(s.value), s.ms)
    if (out !== null) peak = Math.max(peak, out)
  }
  return peak
}

describe('peak flexion is not clipped by the filter chain', () => {

  const TRUE_PEAK = 130

  it('documents the clipping in the old moving-average chain', () => {
    // Regression guard on the bug itself: a 1.5s trailing average still holds
    // 0.7s of shallower angles at the turnaround, so the apex is attenuated.
    const clipped = TRUE_PEAK - runOldChain(sweepSamples())
    expect(clipped).toBeGreaterThan(10)
  })

  it('recovers the peak on a dynamic sweep', () => {
    const clipped = TRUE_PEAK - runNewChain(sweepSamples())
    expect(clipped).toBeLessThan(3)
  })

  it('recovers most of the peak on an unrealistically fast sweep', () => {
    // Stress case: 130° out and back in 2s (peak ~204°/s), faster than a
    // clinical ROM assessment. The ~3° residual here is NOT filter lag —
    // widening `beta` five-fold barely moves it. At 10Hz the apex of a sweep
    // this fast spans about one sample (its neighbours sit 3.2° below it), so
    // the median prefilter rounds it off. That is the sample rate talking, and
    // it is the argument for raising the detection rate if fast sweeps ever
    // matter clinically. Still a 5x improvement on the old chain's 15°.
    const clipped = TRUE_PEAK - runNewChain(sweepSamples({ periodS: 2 }))
    expect(clipped).toBeLessThan(4)
  })

  it('still holds steady on a stationary joint', () => {
    // The other half of the trade-off: recovering the peak must not buy a
    // twitchy readout. ±1.5° of landmark noise on a held 90° position.
    const noise = seededNoise(12345)
    const median = new MedianFilter3()
    const euro   = new OneEuroFilter()
    const outputs = []
    for (let i = 0; i < 100; i++) {
      const out = euro.push(median.push(90 + noise() * 1.5), i * 100)
      if (i >= 50) outputs.push(out)   // ignore the settling period
    }
    const mean = outputs.reduce((a, b) => a + b, 0) / outputs.length
    const sd   = Math.sqrt(outputs.reduce((a, b) => a + (b - mean) ** 2, 0) / outputs.length)
    expect(sd).toBeLessThan(0.5)
  })
})

// ─── Per-joint clinical convention ───────────────────────────────────────────
//
// `180 - interior` is only correct for joints whose neutral is collinear.
// The shoulder is measured elbow→shoulder→hip, where both vectors point
// DOWNWARD at rest (interior ≈ 15°), so the old global rule inverted its whole
// scale — an arm at the side read 165° and an arm overhead read ~20°. The ankle
// has the same defect in milder form: its neutral interior is 90°, not 180°.
//
// These landmark coordinates mimic MediaPipe world landmarks: metres, origin at
// the hip midpoint, +y DOWN, +z ANTERIOR. Right side of a standing subject.

const BODY = {
  hip:      { x: 0.10, y:  0.00, z: 0 },
  shoulder: { x: 0.18, y: -0.55, z: 0 },
  knee:     { x: 0.10, y:  0.45, z: 0 },
  ankle:    { x: 0.10, y:  0.90, z: 0 },
}
// Shin midpoint — what JOINT_CONFIG.ankle uses as its proximal point.
const SHIN_MID = { x: 0.10, y: 0.675, z: 0 }

/** Clinical angle for a joint from three landmark points. */
function clinical(joint, proximal, vertex, distal) {
  return toClinicalAngle(jointAngle(proximal, vertex, distal), joint)
}

describe('per-joint clinical angle convention', () => {

  it('maps each joint neutral to ~0° — no joint is inverted or offset', () => {
    // Knee: hip → knee → ankle, leg straight (exactly collinear)
    expectAngle(clinical('knee', BODY.hip, BODY.knee, BODY.ankle), 0, 0.5)

    // Elbow: shoulder → elbow → wrist, arm straight down at the side
    const elbowDown = { x: 0.21, y: -0.28, z: 0 }
    const wristDown = { x: 0.24, y: -0.01, z: 0 }   // continues the shoulder→elbow line
    expectAngle(clinical('elbow', BODY.shoulder, elbowDown, wristDown), 0, 0.5)

    // Ankle: shin midpoint → ankle → foot index, foot flat (shin ⟂ foot)
    const footNeutral = { x: 0.10, y: 0.90, z: 0.15 }
    expectAngle(clinical('ankle', SHIN_MID, BODY.ankle, footNeutral), 0, 0.5)

    // Hip: shoulder → hip → knee, standing. Not exactly 0 — the shoulder sits
    // ~8cm lateral of the hip, so the trunk vector is genuinely off vertical.
    // The point is that it is small, not that it is zero; Set Zero absorbs it.
    const hipNeutral = clinical('hip', BODY.shoulder, BODY.hip, BODY.knee)
    expect(Math.abs(hipNeutral)).toBeLessThan(12)

    // Shoulder: arm hanging at the side. Same story as the hip — a small
    // positive elevation, NOT the ~165° the old global convention produced.
    const shoulderNeutral = clinical('shoulder', elbowDown, BODY.shoulder, BODY.hip)
    expect(Math.abs(shoulderNeutral)).toBeLessThan(20)
  })

  it('shoulder elevation INCREASES as the arm is raised (pins the inversion)', () => {
    const atSide   = { x: 0.21, y: -0.28, z: 0    }  // hanging
    const forward  = { x: 0.18, y: -0.55, z: 0.27 }  // 90° forward flexion
    const overhead = { x: 0.18, y: -0.82, z: 0    }  // near full elevation

    const a = clinical('shoulder', atSide,   BODY.shoulder, BODY.hip)
    const b = clinical('shoulder', forward,  BODY.shoulder, BODY.hip)
    const c = clinical('shoulder', overhead, BODY.shoulder, BODY.hip)

    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)

    // The specific regression: an arm raised nearly overhead must read as a
    // LARGE elevation. The bug reported it as ~24° of "peak extension".
    expect(c).toBeGreaterThan(150)
    expectAngle(b, 90, 1)
  })

  it('knee flexion increases as the knee bends', () => {
    const straight = clinical('knee', BODY.hip, BODY.knee, BODY.ankle)
    const bent90   = clinical('knee', BODY.hip, BODY.knee, { x: 0.10, y: 0.45, z: -0.45 })
    expect(straight).toBeLessThan(bent90)
    expectAngle(bent90, 90, 1)
  })

  it('ankle dorsiflexion is positive and plantarflexion negative', () => {
    const dorsi   = { x: 0.10, y: 0.85, z: 0.14 }   // toes pulled toward the shin
    const plantar = { x: 0.10, y: 1.00, z: 0.12 }   // toes pointed away

    expect(clinical('ankle', SHIN_MID, BODY.ankle, dorsi)).toBeGreaterThan(5)
    expect(clinical('ankle', SHIN_MID, BODY.ankle, plantar)).toBeLessThan(-5)
  })

  it('produces negative values past neutral instead of flooring at 0', () => {
    // Knee hyperextension: interior angle beyond 180° is impossible, but a
    // clinical angle below the zero point must survive as a negative number.
    expect(toClinicalAngle(185, 'knee')).toBeLessThan(0)
    expect(toClinicalAngle(120, 'ankle')).toBeLessThan(0)
  })

  it('toInteriorAngle() is the exact inverse of toClinicalAngle()', () => {
    for (const joint of Object.keys(JOINT_ANGLE_CONVENTION)) {
      for (const interior of [0, 15, 42.5, 90, 137, 180]) {
        const roundTripped = toInteriorAngle(toClinicalAngle(interior, joint), joint)
        expectAngle(roundTripped, interior, 1e-9)
      }
    }
  })

  it('falls back to the knee convention for an unknown joint', () => {
    expect(toClinicalAngle(180, 'wrist')).toBe(toClinicalAngle(180, 'knee'))
    expect(toClinicalAngle(120, undefined)).toBe(toClinicalAngle(120, 'knee'))
  })

  it('passes null through untouched', () => {
    expect(toClinicalAngle(null, 'knee')).toBeNull()
    expect(toInteriorAngle(null, 'knee')).toBeNull()
  })
})

// ─── Clinical motion terms ────────────────────────────────────────────────────

describe('motionTerms()', () => {
  it('names the hinge joints flexion / extension', () => {
    for (const joint of ['knee', 'hip', 'elbow']) {
      expect(motionTerms(joint)).toEqual({ positive: 'flexion', negative: 'extension' })
    }
  })

  it('names shoulder motion elevation, not flexion', () => {
    // The whole point: an arm-at-side frame used to be captioned "peak
    // extension" because every joint borrowed the knee's vocabulary.
    expect(motionTerms('shoulder').positive).toBe('elevation')
  })

  it('names ankle motion dorsiflexion / plantarflexion', () => {
    expect(motionTerms('ankle')).toEqual({
      positive: 'dorsiflexion',
      negative: 'plantarflexion',
    })
  })

  it('resolves the legacy combined joint_side form', () => {
    // Sessions saved before the joint/side split store joint: 'shoulder_left'.
    // Without the split these fall back to the hinge terms and read "flexion".
    expect(motionTerms('shoulder_left')).toEqual(motionTerms('shoulder'))
    expect(motionTerms('knee_right')).toEqual(motionTerms('knee'))
    expect(motionTerms('ankle_left')).toEqual(motionTerms('ankle'))
  })

  it('falls back to the hinge terms for an unknown or missing joint', () => {
    expect(motionTerms('wrist')).toEqual(motionTerms('knee'))
    expect(motionTerms(undefined)).toEqual(motionTerms('knee'))
    expect(motionTerms(null)).toEqual(motionTerms('knee'))
  })

  it('covers every joint that has an angle convention', () => {
    // The two tables must not drift apart: a joint that can be measured must
    // also be nameable.
    for (const joint of Object.keys(JOINT_ANGLE_CONVENTION)) {
      expect(JOINT_MOTION_TERMS[joint]).toBeDefined()
    }
  })
})
