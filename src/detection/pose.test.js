import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock is hoisted, so we use vi.hoisted() to define variables that hoist with it
const { mockDetectForVideo } = vi.hoisted(() => ({
  mockDetectForVideo: vi.fn(),
}))

vi.mock('@mediapipe/tasks-vision', () => ({
  PoseLandmarker: {
    createFromOptions: vi.fn().mockResolvedValue({
      detectForVideo: mockDetectForVideo,
    }),
  },
  FilesetResolver: {
    forVisionTasks: vi.fn().mockResolvedValue({}),
  },
}))

import { PoseDetector, JOINT_CONFIG } from './pose.js'

function makeVideoEl(w = 1280, h = 720) {
  return { videoWidth: w, videoHeight: h }
}

// Build a full set of 33 mock landmarks at (0.5, 0.5) with high visibility
function makeLandmarks(overrides = {}) {
  const base = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.95 }))
  for (const [idx, val] of Object.entries(overrides)) {
    base[Number(idx)] = { ...base[Number(idx)], ...val }
  }
  return base
}

// Build 33 mock world landmarks (meters) at the origin; override by index.
function makeWorld(overrides = {}) {
  const base = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }))
  for (const [idx, val] of Object.entries(overrides)) {
    base[Number(idx)] = { ...base[Number(idx)], ...val }
  }
  return base
}

describe('PoseDetector', () => {
  let detector

  beforeEach(() => {
    detector = new PoseDetector()
    mockDetectForVideo.mockReset()
  })

  it('returns allFound: false before init()', () => {
    const result = detector.detect(makeVideoEl())
    expect(result.allFound).toBe(false)
    expect(result.markers).toEqual({})
  })

  it('returns allFound: false when no landmarks returned', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [] })
    const result = detector.detect(makeVideoEl())
    expect(result.allFound).toBe(false)
  })

  it('returns allFound: false when a landmark visibility is below threshold', async () => {
    await detector.init()
    // knee right: proximal=24, joint=26, distal=28 — make distal invisible
    mockDetectForVideo.mockReturnValue({
      landmarks: [makeLandmarks({ 28: { x: 0.5, y: 0.5, z: 0, visibility: 0.2 } })],
    })
    const result = detector.detect(makeVideoEl())
    expect(result.allFound).toBe(false)
    expect('distal' in result.markers).toBe(false)
  })

  it('converts normalized coords to video pixel space', async () => {
    await detector.init()
    // All 3 knee-right landmarks (24, 26, 28) at (0.5, 0.5)
    mockDetectForVideo.mockReturnValue({ landmarks: [makeLandmarks()] })
    const result = detector.detect(makeVideoEl(1280, 720))
    expect(result.allFound).toBe(true)
    expect(result.markers['proximal'].center).toEqual({ x: 640, y: 360 })
    expect(result.markers['joint'].center).toEqual({ x: 640, y: 360 })
    expect(result.markers['distal'].center).toEqual({ x: 640, y: 360 })
  })

  it('getJointPoints returns correct struct from full markers', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [makeLandmarks()] })
    const { markers } = detector.detect(makeVideoEl())
    const pts = detector.getJointPoints(markers)
    expect(pts).not.toBeNull()
    expect(pts.proximal).toEqual(markers['proximal'].center)
    expect(pts.joint).toEqual(markers['joint'].center)
    expect(pts.distal).toEqual(markers['distal'].center)
  })

  it('getJointPoints returns null when a landmark is missing', async () => {
    await detector.init()
    // distal is below visibility threshold
    mockDetectForVideo.mockReturnValue({
      landmarks: [makeLandmarks({ 28: { x: 0.5, y: 0.5, z: 0, visibility: 0.1 } })],
    })
    const { markers } = detector.detect(makeVideoEl())
    expect(detector.getJointPoints(markers)).toBeNull()
  })

  it('setJoint changes which landmarks are used', async () => {
    await detector.init()
    detector.setJoint('elbow')
    detector.setSide('left')
    // elbow left: proximal=11, joint=13, distal=15
    // Place only these 3 at a distinctive position
    const overrides = {
      11: { x: 0.1, y: 0.1, z: 0, visibility: 0.95 },
      13: { x: 0.2, y: 0.2, z: 0, visibility: 0.95 },
      15: { x: 0.3, y: 0.3, z: 0, visibility: 0.95 },
    }
    mockDetectForVideo.mockReturnValue({ landmarks: [makeLandmarks(overrides)] })
    const result = detector.detect(makeVideoEl(1000, 1000))
    expect(result.allFound).toBe(true)
    expect(result.markers['proximal'].center.x).toBeCloseTo(100)
    expect(result.markers['joint'].center.x).toBeCloseTo(200)
    expect(result.markers['distal'].center.x).toBeCloseTo(300)
  })

  it('getJointPoints3D returns world coords when worldLandmarks present', async () => {
    await detector.init()
    // knee right: proximal=24, joint=26, distal=28
    const world = makeWorld({
      24: { x: 0.1, y: 0.2, z: 0.3 },
      26: { x: 0.4, y: 0.5, z: 0.6 },
      28: { x: 0.7, y: 0.8, z: 0.9 },
    })
    mockDetectForVideo.mockReturnValue({ landmarks: [makeLandmarks()], worldLandmarks: [world] })
    const { markers } = detector.detect(makeVideoEl())
    const pts = detector.getJointPoints3D(markers)
    expect(pts).not.toBeNull()
    expect(pts.proximal).toEqual({ x: 0.1, y: 0.2, z: 0.3 })
    expect(pts.joint).toEqual({ x: 0.4, y: 0.5, z: 0.6 })
    expect(pts.distal).toEqual({ x: 0.7, y: 0.8, z: 0.9 })
  })

  it('getJointPoints3D returns null when worldLandmarks absent (2D fallback still works)', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [makeLandmarks()] })  // no worldLandmarks
    const { markers } = detector.detect(makeVideoEl())
    expect(detector.getJointPoints3D(markers)).toBeNull()
    expect(detector.getJointPoints(markers)).not.toBeNull()
  })

  it('init() deduplicates concurrent calls', async () => {
    const p1 = detector.init()
    const p2 = detector.init()
    expect(p1).toBe(p2)
    await p1
    expect(detector.isReady).toBe(true)
  })

  // Face clustered near the top of the frame, shoulders below it.
  const HEAD_POSE = {
    0:  { x: 0.50, y: 0.20 },                                            // nose
    1:  { x: 0.48, y: 0.19 }, 2:  { x: 0.47, y: 0.19 }, 3: { x: 0.46, y: 0.19 },
    4:  { x: 0.52, y: 0.19 }, 5:  { x: 0.53, y: 0.19 }, 6: { x: 0.54, y: 0.19 },
    7:  { x: 0.44, y: 0.20 }, 8:  { x: 0.56, y: 0.20 },                  // ears
    9:  { x: 0.48, y: 0.22 }, 10: { x: 0.52, y: 0.22 },                  // mouth
    11: { x: 0.40, y: 0.40 }, 12: { x: 0.60, y: 0.40 },                  // shoulders
  }

  it('returns a head region alongside the joint markers', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [makeLandmarks(HEAD_POSE)] })

    const result = detector.detect(makeVideoEl())

    expect(result.head).not.toBeNull()
    // Verify all three components pinned to the fixture:
    // The fixture is horizontally symmetric, so cx should be at frame center
    expect(result.head.cx).toBeCloseTo(640, 1)
    // Unnudged face centroid would be at 142.69; with CRANIUM_NUDGE applied, cy ≈ 96.5.
    // Assert it's well below the unnudged value to prove the nudge is applied.
    expect(result.head.cy).toBeLessThan(110)
    // Semi-axes should be substantial but not unreasonable for the fixture
    // geometry. Measured for this exact fixture (1280x720 video):
    // rAcross ≈ 137.31px, rAlong ≈ 170.15px (rAlong > rAcross, as expected —
    // a head is taller than wide). Bounds below give ~10px of slack each
    // side, enough to catch a collapsed or ballooned ellipse without being
    // so tight the test pins float noise.
    expect(result.head.rAcross).toBeGreaterThan(125)
    expect(result.head.rAcross).toBeLessThan(150)
    expect(result.head.rAlong).toBeGreaterThan(158)
    expect(result.head.rAlong).toBeLessThan(182)
  })

  it('returns head: null when no pose is detected', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [] })
    expect(detector.detect(makeVideoEl()).head).toBeNull()
  })

  it('returns head: null before init()', () => {
    expect(detector.detect(makeVideoEl()).head).toBeNull()
  })

  it('returns head even when the measured joint is invisible (joint landmarks fail visibility gate)', async () => {
    await detector.init()
    // detector defaults to knee/right; distal is index 28. Make it invisible.
    mockDetectForVideo.mockReturnValue({
      landmarks: [makeLandmarks({ ...HEAD_POSE, 28: { visibility: 0.2 } })],
    })

    const result = detector.detect(makeVideoEl())

    // The joint should fail its visibility gate
    expect(result.allFound).toBe(false)
    expect('distal' in result.markers).toBe(false)
    // But the head region is computed from face/shoulder landmarks, not gated by joint visibility
    expect(result.head).not.toBeNull()
    expect(result.head.rAcross).toBeGreaterThan(0)
    expect(result.head.rAlong).toBeGreaterThan(0)
  })

  it('returns headResolved: true on a normal pose', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [makeLandmarks(HEAD_POSE)] })
    const result = detector.detect(makeVideoEl())
    expect(result.headResolved).toBe(true)
  })

  it('returns headResolved: false when no landmarks are returned', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [] })
    const result = detector.detect(makeVideoEl())
    expect(result.headResolved).toBe(false)
  })

  it('returns headResolved: false before init()', () => {
    const result = detector.detect(makeVideoEl())
    expect(result.headResolved).toBe(false)
  })

  it('returns headResolved: false when a face landmark has NaN x', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({
      landmarks: [makeLandmarks({ ...HEAD_POSE, 3: { x: NaN, y: 0.19 } })],
    })
    const result = detector.detect(makeVideoEl())
    expect(result.headResolved).toBe(false)
  })

  // Regression guard for the leak Finding A found: ten of the eleven face
  // landmarks (1–10) sit far off the right edge of the frame, dragging the
  // face CENTROID outside the video rect, while the eleventh (the nose,
  // index 0) sits a few pixels inside it. headRegion() returns null here
  // regardless of MAX_RADIUS_FRACTION — unclamped, cx - r_raw = 1342.85 is
  // still > 1280 (the frame width), so the circle is rejected as off-frame
  // either way. The clamp is not what's under test; the off-screen-centroid
  // mechanism is. headInputsFinite() alone can't catch this — every
  // coordinate here is finite — only anyFaceLandmarkInFrame() can, which is
  // why headResolved must check both.
  const CLAMPED_CLOSEUP = {
    0:  { x: 1270 / 1280, y: 0.5 },   // nose — just inside the right edge
    1:  { x: 2500 / 1280, y: 0.5 }, 2: { x: 2500 / 1280, y: 0.5 }, 3: { x: 2500 / 1280, y: 0.5 },
    4:  { x: 2500 / 1280, y: 0.5 }, 5: { x: 2500 / 1280, y: 0.5 }, 6: { x: 2500 / 1280, y: 0.5 },
    7:  { x: 2500 / 1280, y: 0.5 }, 8: { x: 2500 / 1280, y: 0.5 },
    9:  { x: 2500 / 1280, y: 0.5 }, 10: { x: 2500 / 1280, y: 0.5 },
    11: { x: 2388 / 1280, y: 760 / 720 }, 12: { x: 2388 / 1280, y: 760 / 720 },
  }

  it('returns headResolved: false for a large head whose clamped circle falls off-frame while a face landmark stays on screen', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [makeLandmarks(CLAMPED_CLOSEUP)] })
    const result = detector.detect(makeVideoEl())
    // headRegion() itself sees only the clamped, off-frame circle.
    expect(result.head).toBeNull()
    // headResolved must catch that a face landmark is still on screen.
    expect(result.headResolved).toBe(false)
  })

  // Landmarks for a head at (hx, hy) with shoulders below — enough spread for
  // headRegion() to return a region.
  //
  // NOTE: the brief's version of this fixture left indices 1-6 (the eyes,
  // part of headRegion.js's FACE_LANDMARKS = [0..10]) at makeLandmarks()'s
  // default (0.5, 0.5). That default sits far from an off-center head, and
  // FACE_LANDMARKS folds it into the bounding-box estimate — asymmetrically,
  // since a head nearer to (0.5, 0.5) picks up less spurious spread than one
  // farther away. At hx=0.30 that alone was enough to hit MAX_RADIUS_FRACTION's
  // cap, breaking the "expands when the head moves" test regardless of
  // whether motion expansion is wired correctly. Setting the eyes here (within
  // the x/y extremes already spanned by the ears/mouth below, so the intended
  // bounding box is unchanged) matches the canonical fixture convention in
  // headRegion.test.js's pose(), where every FACE_LANDMARKS index is explicit.
  function headLandmarks(hx = 0.5, hy = 0.25) {
    const lm = makeLandmarks()
    const at = (i, x, y) => { lm[i] = { x, y, z: 0, visibility: 0.95 } }
    at(0, hx, hy)
    at(1, hx - 0.02, hy); at(2, hx - 0.035, hy); at(3, hx - 0.05, hy)
    at(4, hx + 0.02, hy); at(5, hx + 0.035, hy); at(6, hx + 0.05, hy)
    at(7, hx - 0.06, hy); at(8, hx + 0.06, hy)
    at(9, hx - 0.02, hy + 0.04); at(10, hx + 0.02, hy + 0.04)
    at(11, hx - 0.10, hy + 0.18); at(12, hx + 0.10, hy + 0.18)
    return lm
  }

  it('does not expand the head region on the first detection', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(0.5)] })
    const first = detector.detect(makeVideoEl())
    mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(0.5)] })
    const still = detector.detect(makeVideoEl())
    expect(still.head.rAcross).toBeCloseTo(first.head.rAcross, 6)
  })

  it('expands the head region when the head moves between detections', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(0.30)] })
    const a = detector.detect(makeVideoEl())
    mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(0.50)] })
    const b = detector.detect(makeVideoEl())
    expect(b.head.rAcross).toBeGreaterThan(a.head.rAcross)
  })

  it('does not compound expansion across frames', async () => {
    // THE MUTANT THIS KILLS: storing the EXPANDED region as `_prevHead`. The
    // stored value must be the raw region, or a head moving at constant speed
    // grows the occluder without bound until it hits the cap.
    await detector.init()
    const xs = [0.30, 0.40, 0.50, 0.60]
    const widths = []
    for (const x of xs) {
      mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(x)] })
      widths.push(detector.detect(makeVideoEl()).head.rAcross)
    }
    // Steps 2, 3 and 4 all travel the same distance, so they must all expand
    // by the same amount.
    expect(widths[3]).toBeCloseTo(widths[2], 4)
  })

  it('clears motion state when the pose is lost, so a gap cannot carry a stale jump', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(0.30)] })
    detector.detect(makeVideoEl())
    mockDetectForVideo.mockReturnValue({ landmarks: [] })
    detector.detect(makeVideoEl())                       // pose lost
    mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(0.70)] })
    const after = detector.detect(makeVideoEl())
    mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(0.70)] })
    const settled = detector.detect(makeVideoEl())
    expect(after.head.rAcross).toBeCloseTo(settled.head.rAcross, 6)
  })
})

describe('JOINT_CONFIG', () => {
  const isValidLandmark = v =>
    typeof v === 'number' || (Array.isArray(v?.midpoint) && v.midpoint.length === 2)

  it('has valid landmark entries for all 5 joints × 2 sides', () => {
    for (const joint of ['knee', 'hip', 'shoulder', 'elbow', 'ankle']) {
      for (const side of ['left', 'right']) {
        const cfg = JOINT_CONFIG[joint][side]
        expect(isValidLandmark(cfg.proximal)).toBe(true)
        expect(typeof cfg.joint).toBe('number')
        expect(typeof cfg.distal).toBe('number')
      }
    }
  })

  it('ankle proximal is a midpoint config', () => {
    expect(JOINT_CONFIG.ankle.left.proximal).toEqual({ midpoint: [25, 27] })
    expect(JOINT_CONFIG.ankle.right.proximal).toEqual({ midpoint: [26, 28] })
  })
})

describe('PoseDetector._resolveLandmark (midpoint)', () => {
  it('averages two landmark positions and uses max visibility', () => {
    const detector = new PoseDetector()
    const lmNorm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }))
    lmNorm[25] = { x: 0.2, y: 0.4, visibility: 0.9 }
    lmNorm[27] = { x: 0.6, y: 0.8, visibility: 0.5 }

    const result = detector._resolveLandmark({ midpoint: [25, 27] }, lmNorm, 1000, 1000)
    expect(result).not.toBeNull()
    expect(result.x).toBeCloseTo(400)   // (0.2 + 0.6) / 2 * 1000
    expect(result.y).toBeCloseTo(600)   // (0.4 + 0.8) / 2 * 1000
    expect(result.visibility).toBe(0.9) // max of 0.9, 0.5
  })

  it('returns null when either landmark is below threshold', () => {
    const detector = new PoseDetector()
    const lmNorm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.95 }))
    // Make knee (25) invisible — ankle (27) is still visible
    lmNorm[25] = { x: 0.5, y: 0.5, visibility: 0.1 }
    const result = detector._resolveLandmark({ midpoint: [25, 27] }, lmNorm, 1000, 1000)
    expect(result).toBeNull()
  })

  it('ankle detection uses midpoint for proximal', async () => {
    const { mockDetectForVideo: mock } = vi.hoisted(() => ({ mockDetectForVideo: vi.fn() }))
    // Use the already-mocked module — just set up fresh landmarks
    const detector = new PoseDetector()
    await detector.init()
    detector.setJoint('ankle')
    detector.setSide('right')

    // right ankle: proximal=midpoint(26,28), joint=28, distal=32
    // Place knee(26) and ankle(28) at different positions so midpoint is distinct
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.95 }))
    lm[26] = { x: 0.2, y: 0.2, z: 0, visibility: 0.95 }  // knee
    lm[28] = { x: 0.4, y: 0.6, z: 0, visibility: 0.95 }  // ankle (joint)
    lm[32] = { x: 0.8, y: 0.8, z: 0, visibility: 0.95 }  // foot index
    mockDetectForVideo.mockReturnValue({ landmarks: [lm] })

    const result = detector.detect({ videoWidth: 1000, videoHeight: 1000 })
    expect(result.allFound).toBe(true)
    // proximal should be midpoint of knee(0.2,0.2) and ankle(0.4,0.6) = (0.3,0.4)
    expect(result.markers['proximal'].center.x).toBeCloseTo(300)
    expect(result.markers['proximal'].center.y).toBeCloseTo(400)
  })

  it('averages world coords for a midpoint proximal (ankle)', async () => {
    const detector = new PoseDetector()
    await detector.init()
    detector.setJoint('ankle')
    detector.setSide('right')

    // right ankle: proximal=midpoint(26,28), joint=28, distal=32
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.95 }))
    const world = makeWorld({
      26: { x: 0.2, y: 0.2, z: 0.2 },  // knee
      28: { x: 0.4, y: 0.6, z: 0.8 },  // ankle (joint)
      32: { x: 0.9, y: 0.9, z: 0.9 },  // foot index
    })
    mockDetectForVideo.mockReturnValue({ landmarks: [lm], worldLandmarks: [world] })

    const { markers } = detector.detect({ videoWidth: 1000, videoHeight: 1000 })
    const pts = detector.getJointPoints3D(markers)
    expect(pts).not.toBeNull()
    // proximal world = midpoint of knee(0.2,0.2,0.2) and ankle(0.4,0.6,0.8) = (0.3,0.4,0.5)
    expect(pts.proximal.x).toBeCloseTo(0.3)
    expect(pts.proximal.y).toBeCloseTo(0.4)
    expect(pts.proximal.z).toBeCloseTo(0.5)
  })
})
