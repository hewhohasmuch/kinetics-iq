/**
 * calibration.test.js
 *
 * NOTE: CalibrationManager calls saveSettings() which uses localStorage.
 * localStorage doesn't exist in Node/Vitest — we mock it here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock localStorage before importing CalibrationManager
const store = {}
global.localStorage = {
  getItem:    (k) => store[k] ?? null,
  setItem:    (k, v) => { store[k] = v },
  removeItem: (k) => { delete store[k] },
}

// Mock storage module to avoid real localStorage dependency
vi.mock('./storage.js', () => ({
  saveSettings: vi.fn(),
  loadSettings: vi.fn(() => ({ calibration_offset: 0 })),
}))

const { CalibrationManager } = await import('./calibration.js')

describe('CalibrationManager', () => {

  let cal

  beforeEach(() => {
    cal = new CalibrationManager()
  })

  // ─── Initial state ──────────────────────────────────────────────────

  it('starts with zero offset', () => {
    expect(cal.offset).toBe(0)
    expect(cal.isCalibrated).toBe(false)
    expect(cal.isSampling).toBe(false)
  })

  // ─── apply() ────────────────────────────────────────────────────────

  it('apply() returns rawAngle unchanged when offset is 0', () => {
    expect(cal.apply(90)).toBe(90)
    expect(cal.apply(45)).toBe(45)
  })

  it('apply() subtracts offset', () => {
    cal._offset = 10   // simulate calibrated at 10°
    expect(cal.apply(90)).toBe(80)
    expect(cal.apply(10)).toBe(0)
  })

  it('apply() clamps to 0 minimum (no negative flexion)', () => {
    cal._offset = 15
    expect(cal.apply(10)).toBe(0)   // 10 - 15 = -5 → clamped to 0
  })

  it('apply() returns null for null input', () => {
    expect(cal.apply(null)).toBeNull()
    expect(cal.apply(undefined)).toBeNull()
  })

  // ─── Sampling flow ───────────────────────────────────────────────────

  it('startSampling sets isSampling to true', () => {
    cal.startSampling(() => {})
    expect(cal.isSampling).toBe(true)
    expect(cal.sampleProgress).toBe(0)
  })

  it('addSample accumulates samples', () => {
    cal.startSampling(() => {})
    cal.addSample(10)
    cal.addSample(12)
    expect(cal.sampleProgress).toBe(2)
  })

  it('addSample ignores null values', () => {
    cal.startSampling(() => {})
    cal.addSample(null)
    cal.addSample(undefined)
    expect(cal.sampleProgress).toBe(0)
  })

  it('finalizes and calls onComplete when target reached', () => {
    const onComplete = vi.fn()
    cal.startSampling(onComplete)

    // Feed 20 samples all at 10°
    for (let i = 0; i < 20; i++) cal.addSample(10)

    expect(cal.isSampling).toBe(false)
    expect(cal.offset).toBe(10)
    expect(cal.isCalibrated).toBe(true)
    expect(onComplete).toHaveBeenCalledWith(10)
  })

  it('averages samples correctly', () => {
    cal.startSampling(() => {})
    // 10 samples at 8° and 10 samples at 12° → average = 10°
    for (let i = 0; i < 10; i++) cal.addSample(8)
    for (let i = 0; i < 10; i++) cal.addSample(12)
    expect(cal.offset).toBe(10)
  })

  it('cancel() stops sampling without saving', () => {
    const onComplete = vi.fn()
    cal.startSampling(onComplete)
    cal.addSample(10)
    cal.cancel()

    expect(cal.isSampling).toBe(false)
    expect(cal.offset).toBe(0)   // unchanged
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('clear() resets offset to 0', () => {
    cal._offset = 15
    cal.clear()
    expect(cal.offset).toBe(0)
    expect(cal.isCalibrated).toBe(false)
  })

  it('does not accept samples when not sampling', () => {
    cal.addSample(90)   // not sampling — should be ignored
    expect(cal.sampleProgress).toBe(0)
  })

})
