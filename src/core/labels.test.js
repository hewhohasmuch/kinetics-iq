/**
 * labels.test.js
 *
 * Tests for the display-name helpers. The wording these produce is clinical,
 * not decorative — extremeLabels in particular decides whether a frame is
 * captioned "Peak extension" or "Min flexion", which are claims about
 * different motions.
 */

import { describe, it, expect } from 'vitest'
import {
  JOINT_NAMES,
  JOINT_POSITIONS,
  positionsFor,
  splitJoint,
  jointLabel,
  sideLabel,
  positionLabel,
  motionLabel,
  extremeLabels,
  romArc,
  formatSessionDate,
  formatSessionTime,
  formatDuration,
} from './labels.js'

describe('splitJoint', () => {

  it('uses the separate side field when present', () => {
    expect(splitJoint({ joint: 'knee', side: 'right' }))
      .toEqual({ joint: 'knee', side: 'right' })
  })

  it('splits the legacy combined form', () => {
    expect(splitJoint({ joint: 'shoulder_left' }))
      .toEqual({ joint: 'shoulder', side: 'left' })
  })

  it('returns a null side when neither form carries one', () => {
    expect(splitJoint({ joint: 'ankle' })).toEqual({ joint: 'ankle', side: null })
  })

})

describe('jointLabel', () => {

  it('formats joint and side', () => {
    expect(jointLabel({ joint: 'knee', side: 'right' })).toBe('Right Knee')
  })

  it('handles the legacy combined form', () => {
    expect(jointLabel({ joint: 'knee_right' })).toBe('Right Knee')
  })

  it('omits the side when a session has none', () => {
    expect(jointLabel({ joint: 'elbow' })).toBe('Elbow')
  })

  it('falls back to the raw value for an unknown joint rather than blanking', () => {
    expect(jointLabel({ joint: 'wrist', side: 'left' })).toBe('Left wrist')
  })

})

describe('sideLabel', () => {

  it('capitalises', () => {
    expect(sideLabel('left')).toBe('Left')
  })

  it('returns empty string for an absent side', () => {
    expect(sideLabel(null)).toBe('')
  })

})

describe('positionLabel', () => {

  it('uses the display name', () => {
    expect(positionLabel('standing')).toBe('Standing')
  })

  // Null is meaningful — the recorder leaves an unchosen position absent, and
  // the views omit the badge rather than inventing one.
  it('returns null for an absent position', () => {
    expect(positionLabel(null)).toBeNull()
    expect(positionLabel(undefined)).toBeNull()
  })

})

describe('positionsFor', () => {

  it('offers the positions each joint is actually measured in', () => {
    expect(positionsFor('shoulder')).toEqual(['standing', 'seated'])
    expect(positionsFor('knee')).toEqual(['prone', 'supine', 'seated'])
  })

  it('falls back to the knee list for an unknown joint', () => {
    expect(positionsFor('wrist')).toEqual(JOINT_POSITIONS.knee)
  })

  it('never offers a position without a display name', () => {
    for (const positions of Object.values(JOINT_POSITIONS)) {
      for (const p of positions) expect(positionLabel(p)).not.toBeNull()
    }
  })

})

describe('motionLabel', () => {

  it('names the motion per joint, capitalised', () => {
    expect(motionLabel('knee')).toBe('Flexion')
    expect(motionLabel('shoulder')).toBe('Elevation')
    expect(motionLabel('ankle')).toBe('Dorsiflexion')
  })

  it('accepts the legacy combined form', () => {
    expect(motionLabel('shoulder_left')).toBe('Elevation')
  })

  it('falls back to the hinge term for an unknown joint', () => {
    expect(motionLabel('wrist')).toBe('Flexion')
  })

})

describe('extremeLabels', () => {

  it('names the peak by the joint, not by "flexion" everywhere', () => {
    expect(extremeLabels('shoulder', 20).maxLabel).toBe('Peak elevation')
    expect(extremeLabels('ankle', 2).maxLabel).toBe('Peak dorsiflexion')
    expect(extremeLabels('knee', 5).maxLabel).toBe('Peak flexion')
  })

  // The regression this guards: an un-zeroed shoulder resting at 24.6° of
  // elevation was captioned "Peak extension", claiming a motion that never
  // happened. Only a value below zero actually crossed neutral.
  it('calls the min a MINIMUM of the positive motion when it never crossed zero', () => {
    expect(extremeLabels('shoulder', 24.6).minLabel).toBe('Min elevation')
    expect(extremeLabels('knee', 5).minLabel).toBe('Min flexion')
  })

  it('calls the min a PEAK of the negative motion once it goes below zero', () => {
    expect(extremeLabels('knee', -4).minLabel).toBe('Peak extension')
    expect(extremeLabels('ankle', -12).minLabel).toBe('Peak plantarflexion')
  })

  it('treats exactly zero as not having crossed neutral', () => {
    expect(extremeLabels('knee', 0).minLabel).toBe('Min flexion')
  })

  it('accepts the legacy combined form', () => {
    expect(extremeLabels('shoulder_left', -3).minLabel).toBe('Peak extension')
  })

})

describe('romArc', () => {

  it('documents the arc rather than the subtraction', () => {
    expect(romArc(5, 120)).toBe('5° – 120°')
  })

  // A 5° extension lag and full extension subtract to the same total; the
  // deficit is the finding, so the arc has to keep both ends.
  it('distinguishes ranges that share a total', () => {
    expect(romArc(5, 120)).not.toBe(romArc(0, 115))
  })

  it('keeps a negative minimum visible', () => {
    expect(romArc(-4, 130)).toBe('-4° – 130°')
  })

})

/**
 * The three formatters used to live privately in HistoryView and
 * SessionDetailView — verbatim copies differing only in the weekday. report.js
 * needs all three, which would have made a third copy of the same intent.
 *
 * en-US time formatting puts a narrow no-break space (U+202F) before the
 * meridiem on modern ICU, so the tests normalise whitespace rather than pinning
 * a character that is an ICU detail, not a clinical claim.
 */
const flattenSpace = (s) => s.replace(/[  ]/g, ' ')

describe('formatSessionDate', () => {

  // Byte-identical to HistoryView._formatDate, which omitted the weekday.
  it('formats a YYYY-MM-DD date without a weekday by default', () => {
    expect(formatSessionDate('2026-08-12')).toBe('Aug 12')
  })

  // Byte-identical to SessionDetailView._formatDate, which included it.
  it('adds the weekday on request', () => {
    expect(formatSessionDate('2026-08-12', { weekday: true })).toBe('Wed, Aug 12')
  })

  // A note pasted into a chart outlives the session list it came from.
  it('adds the year on request', () => {
    expect(formatSessionDate('2026-08-12', { weekday: true, year: true }))
      .toBe('Wed, Aug 12, 2026')
  })

  it('reads the date as local, not UTC', () => {
    // Constructed from the parts, so a timezone behind UTC cannot roll it back
    // to the 11th the way Date.parse('2026-08-12') would.
    expect(formatSessionDate('2026-01-01')).toBe('Jan 1')
  })

})

describe('formatSessionTime', () => {

  it('formats a timestamp as a 12-hour local time', () => {
    const ts = new Date(2026, 7, 12, 15, 42).getTime()
    expect(flattenSpace(formatSessionTime(ts))).toBe('3:42 PM')
  })

  it('pads the minute', () => {
    const ts = new Date(2026, 7, 12, 9, 5).getTime()
    expect(flattenSpace(formatSessionTime(ts))).toBe('9:05 AM')
  })

})

describe('formatDuration', () => {

  it('leaves a sub-minute duration in seconds', () => {
    expect(formatDuration(42)).toBe('42s')
  })

  it('splits a longer duration into minutes and seconds', () => {
    expect(formatDuration(64)).toBe('1m 4s')
  })

  it('keeps the seconds component at an exact minute', () => {
    expect(formatDuration(120)).toBe('2m 0s')
  })

})

describe('JOINT_NAMES', () => {

  it('covers every joint that has positions defined', () => {
    for (const joint of Object.keys(JOINT_POSITIONS)) {
      expect(JOINT_NAMES[joint]).toBeDefined()
    }
  })

})
