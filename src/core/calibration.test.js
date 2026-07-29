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

const { loadSettings } = await import('./storage.js')
const { CalibrationManager, CALIBRATION_VERSION } = await import('./calibration.js')

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

  // Previously this clamped at 0 ("no negative flexion"). That clamp discarded
  // the entire extension side of the zero point, so an extension measurement
  // read a flat 0° for its whole duration — and since the same value feeds the
  // recorder and the snapshots, the saved ROM was 0 too. Extension is the
  // measurement, not an error: it must survive as a negative number.
  it('apply() returns negative values below the zero point (extension)', () => {
    cal._offset = 15
    expect(cal.apply(10)).toBe(-5)
    expect(cal.apply(0)).toBe(-15)
  })

  it('apply() does not flatten a movement that stays below the offset', () => {
    // The reported bug: Set Zero at the shoulder captured an offset near the
    // top of the scale, and every later sample sat below it.
    cal._offset = 165
    const outputs = [165, 140, 100, 60, 20].map(v => cal.apply(v))
    expect(new Set(outputs).size).toBe(outputs.length)  // all distinct, none pinned
    expect(Math.min(...outputs)).toBeLessThan(0)
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

  // A captured offset of exactly 0.0 is legitimate (a joint genuinely at its
  // neutral). Inferring "calibrated" from `offset !== 0` reported that as
  // "Not zeroed — tap Set Zero", so the state must be tracked explicitly.
  it('isCalibrated is true after capturing an offset of exactly 0', () => {
    cal.startSampling(() => {})
    for (let i = 0; i < 20; i++) cal.addSample(0)

    expect(cal.offset).toBe(0)
    expect(cal.isCalibrated).toBe(true)
  })

  // ─── Schema version ──────────────────────────────────────────────────

  it('discards an offset captured under an older convention', () => {
    // A shoulder offset of ~165 captured under the old inverted scale would
    // put the whole range below zero if carried over.
    loadSettings.mockReturnValueOnce({
      calibration_offset:  165.4,
      calibration_version: 1,
      calibration_captured: true,
    })

    const stale = new CalibrationManager()
    expect(stale.offset).toBe(0)
    expect(stale.isCalibrated).toBe(false)
  })

  it('keeps an offset captured under the current version', () => {
    loadSettings.mockReturnValueOnce({
      calibration_offset:   12.5,
      calibration_version:  CALIBRATION_VERSION,
      calibration_captured: true,
    })

    const fresh = new CalibrationManager()
    expect(fresh.offset).toBe(12.5)
    expect(fresh.isCalibrated).toBe(true)
  })

})
