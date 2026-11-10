import { describe, it, expect } from 'vitest'
import { filterPatients } from './patientSearch.js'

const P = (name, mrn = '', extra = {}) => ({ id: name, name, mrn, ...extra })

const ROSTER = [
  P('Ann Lee', 'A-100'),
  P('Joanne Smith', '2201'),
  P('John Smith', '4471'),
  P('José Álvarez', '9005'),
  P('Mary-Jane O’Neil', ''),
]
const names = (list) => list.map(p => p.name)

describe('filterPatients', () => {
  it('returns the whole list, in order, for an empty or blank query', () => {
    expect(filterPatients(ROSTER, '')).toEqual(ROSTER)
    expect(filterPatients(ROSTER, '   ')).toEqual(ROSTER)
    expect(filterPatients(ROSTER, undefined)).toEqual(ROSTER)
    expect(filterPatients(ROSTER, ' , ')).toEqual(ROSTER)
  })

  it('matches a fragment of the name, ignoring case', () => {
    expect(names(filterPatients(ROSTER, 'SMI'))).toEqual(['Joanne Smith', 'John Smith'])
    expect(names(filterPatients(ROSTER, 'lee'))).toEqual(['Ann Lee'])
  })

  it('requires every word, so a second word narrows the list', () => {
    expect(names(filterPatients(ROSTER, 'smith'))).toEqual(['Joanne Smith', 'John Smith'])
    expect(names(filterPatients(ROSTER, 'smith john'))).toEqual(['John Smith'])
    expect(names(filterPatients(ROSTER, 'jo smi'))).toEqual(['Joanne Smith', 'John Smith'])
    expect(names(filterPatients(ROSTER, 'john lee'))).toEqual([])
  })

  it('accepts the chart form "Last, First"', () => {
    expect(names(filterPatients(ROSTER, 'Smith, John'))).toEqual(['John Smith'])
    expect(names(filterPatients(ROSTER, 'smith,john'))).toEqual(['John Smith'])
  })

  it('matches the MRN, and a name word together with an MRN fragment', () => {
    expect(names(filterPatients(ROSTER, '4471'))).toEqual(['John Smith'])
    expect(names(filterPatients(ROSTER, 'a-100'))).toEqual(['Ann Lee'])
    expect(names(filterPatients(ROSTER, 'smith 22'))).toEqual(['Joanne Smith'])
  })

  it('ignores accents in both the query and the name', () => {
    expect(names(filterPatients(ROSTER, 'jose alvarez'))).toEqual(['José Álvarez'])
    expect(names(filterPatients(ROSTER, 'JOSÉ'))).toEqual(['José Álvarez'])
  })

  it('does not search diagnosis or notes', () => {
    const roster = [P('Ann Lee', '', { diagnosis: 'ACL tear', notes: 'smith referral' })]
    expect(filterPatients(roster, 'acl')).toEqual([])
    expect(filterPatients(roster, 'smith')).toEqual([])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterPatients(ROSTER, 'zzz')).toEqual([])
  })

  it('tolerates missing fields and a missing list', () => {
    expect(filterPatients([{ id: 'x' }, { id: 'y', name: null, mrn: undefined }], 'a')).toEqual([])
    expect(filterPatients(null, 'a')).toEqual([])
    expect(filterPatients(undefined, '')).toEqual([])
  })

  it('does not reorder or mutate the list it is given', () => {
    const copy = [...ROSTER]
    filterPatients(ROSTER, 'smith')
    expect(ROSTER).toEqual(copy)
  })
})
