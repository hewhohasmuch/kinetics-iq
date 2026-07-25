/**
 * session.js
 *
 * SessionRecorder — captures angle samples during a measurement session
 * and computes the clinically meaningful ROM metrics.
 *
 * PURE LOGIC — no DOM, no localStorage. Storage is handled by storage.js.
 * This class is fully testable in Node with no browser required.
 *
 * A "session" represents one measurement bout:
 *   user taps Start → moves joint through range → taps Stop
 *   result = { min, max, rom, duration, samples }
 *
 * ROM (Range of Motion) = max flexion angle − min flexion angle
 * This is the primary clinical metric. Higher = better (more range).
 *
 * Angle convention (from angle.js):
 *   0°   = full extension (straight leg)
 *   90°  = right angle
 *   135° = significant flexion
 */

import { generateId } from './id.js'

export class SessionRecorder {
  constructor() {
    this._angles    = []      // all angle samples captured this session
    this._startTime = null    // Date.now() at start
    this._active    = false
    this._joint     = 'knee'
    this._side      = 'right'
    this._position  = 'prone'
  }

  // Set the joint, side, and position before start() so they appear in the saved session.
  setContext(joint, side, position) {
    this._joint    = joint
    this._side     = side
    this._position = position ?? 'prone'
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Begin a new recording session.
   * Clears any previous data.
   */
  start() {
    this._angles    = []
    this._startTime = Date.now()
    this._active    = true
  }

  /**
   * Record one angle sample.
   * Call this at detection rate (~10Hz) while session is active.
   * Silently ignores null values (marker lost frames).
   *
   * @param {number|null} angle - smoothed flexion angle in degrees
   */
  record(angle) {
    if (!this._active) return
    if (angle === null || angle === undefined || isNaN(angle)) return
    this._angles.push(angle)
  }

  /**
   * Stop recording and return the completed session object.
   * Returns null if fewer than 3 samples were captured (not enough data).
   *
   * @returns {Session|null}
   */
  stop() {
    if (!this._active) return null
    this._active = false

    if (this._angles.length < 1) return null

    const min      = Math.min(...this._angles)
    const max      = Math.max(...this._angles)
    const duration = Math.round((Date.now() - this._startTime) / 1000)

    // Round each sample to 1dp to keep localStorage size reasonable.
    // At 10Hz for 60s = 600 samples ≈ 3-4KB per session.
    const timeline = this._angles.map(a => Math.round(a * 10) / 10)

    return {
      // UUID (not sess_<timestamp>) so offline-created sessions upsert
      // cleanly into the cloud's uuid primary key without id remapping
      id:            generateId(),
      timestamp:     this._startTime,
      date:          new Date(this._startTime).toISOString().split('T')[0],
      joint:         this._joint,
      side:          this._side,
      position:      this._position,
      min:           Math.round(min * 10) / 10,
      max:           Math.round(max * 10) / 10,
      rom:           Math.round((max - min) * 10) / 10,
      duration_s:    duration,
      samples:       this._angles.length,
      angleTimeline: timeline,   // full sample array for detail chart
      angleMode:     '3d',       // measured with 3D world landmarks; older sessions lack this (2D)
      // Filter generation that produced these angles. Sessions without this
      // field predate the peak-clipping fix and read systematically low at the
      // extremes — do not compare their ROM against 'euro1' sessions as if the
      // difference were the patient's.
      angleFilter:   'euro1',
      notes:         '',
      app_version:   '0.1.0',
    }
  }

  // ─── State queries ──────────────────────────────────────────────────

  /**
   * Attach a notes string to the session after stop().
   * Call this with the session object returned by stop().
   *
   * @param {Session} session - returned from stop()
   * @param {string}  notes   - free-text note from user
   * @returns {Session} the same session with notes attached
   */
  static attachNotes(session, notes) {
    if (!session) return null
    return { ...session, notes: (notes || '').trim().slice(0, 200) }
  }

  /**
   * Attach the snapshots taken at both range extremes.
   * peakFrame keeps its legacy name (max flexion) so old sessions and
   * existing readers keep working; minFrame is the max-extension pose.
   *
   * @param {Session} session
   * @param {{maxFrame?: string|null, minFrame?: string|null}} frames
   * @returns {Session} the same session with frames attached
   */
  static attachFrames(session, { maxFrame, minFrame } = {}) {
    if (!session) return session
    if (maxFrame) session.peakFrame = maxFrame
    if (minFrame) session.minFrame  = minFrame
    return session
  }

  get isActive()     { return this._active }
  get sampleCount()  { return this._angles.length }

  /**
   * Live min/max during an active session — for the real-time range bar.
   * Returns null if no samples yet.
   */
  getLiveStats() {
    if (this._angles.length === 0) return null
    return {
      min: Math.min(...this._angles),
      max: Math.max(...this._angles),
      rom: Math.max(...this._angles) - Math.min(...this._angles),
    }
  }
}
