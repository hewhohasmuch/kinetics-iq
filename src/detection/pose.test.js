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

  it('init() deduplicates concurrent calls', async () => {
    const p1 = detector.init()
    const p2 = detector.init()
    expect(p1).toBe(p2)
    await p1
    expect(detector.isReady).toBe(true)
  })
})

describe('JOINT_CONFIG', () => {
  it('has entries for all 4 joints × 2 sides', () => {
    for (const joint of ['knee', 'hip', 'shoulder', 'elbow', 'ankle']) {
      for (const side of ['left', 'right']) {
        const cfg = JOINT_CONFIG[joint][side]
        expect(typeof cfg.proximal).toBe('number')
        expect(typeof cfg.joint).toBe('number')
        expect(typeof cfg.distal).toBe('number')
      }
    }
  })
})
