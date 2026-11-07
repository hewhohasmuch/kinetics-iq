import { describe, it, expect } from 'vitest'
import { restoreSelection } from './selection.js'

const P1 = { id: 'p1', affectedSide: null }

describe('restoreSelection', () => {

  it('restores joint, side and position for the same patient', () => {
    const stored = { patientId: 'p1', joint: 'hip', side: 'left', position: 'supine' }
    expect(restoreSelection(stored, P1)).toEqual({ joint: 'hip', side: 'left', position: 'supine' })
  })

  it('keeps a null position null', () => {
    const stored = { patientId: 'p1', joint: 'hip', side: 'left', position: null }
    expect(restoreSelection(stored, P1).position).toBeNull()
  })

  it('ignores a selection made for another patient', () => {
    const stored = { patientId: 'p2', joint: 'hip', side: 'left', position: 'supine' }
    expect(restoreSelection(stored, P1)).toEqual({ joint: 'knee', side: 'right', position: null })
  })

  // The position rule: never file a position the clinician did not tap for
  // this joint. A shoulder was once recorded "prone" by a carried-over value.
  it('drops a position that does not belong to the stored joint', () => {
    const stored = { patientId: 'p1', joint: 'shoulder', side: 'right', position: 'prone' }
    expect(restoreSelection(stored, P1)).toEqual({ joint: 'shoulder', side: 'right', position: null })
  })

  it.each([
    ['no stored selection', null],
    ['an unknown joint',    { patientId: 'p1', joint: 'wrist', side: 'left', position: null }],
    ['an unknown side',     { patientId: 'p1', joint: 'hip',   side: 'both', position: null }],
  ])('falls back to the default for %s', (_, stored) => {
    expect(restoreSelection(stored, P1)).toEqual({ joint: 'knee', side: 'right', position: null })
  })

  it.each([
    ['left',  'left'],
    ['right', 'right'],
    ['both',  'right'],
    [null,    'right'],
  ])('defaults the side from affectedSide %s → %s', (affected, side) => {
    expect(restoreSelection(null, { id: 'p1', affectedSide: affected }).side).toBe(side)
  })

  it('works with no active patient (local-only, before one is picked)', () => {
    const stored = { patientId: null, joint: 'elbow', side: 'left', position: null }
    expect(restoreSelection(stored, null)).toEqual({ joint: 'elbow', side: 'left', position: null })
    expect(restoreSelection(null, null)).toEqual({ joint: 'knee', side: 'right', position: null })
  })
})
