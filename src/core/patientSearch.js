/**
 * patientSearch.js — filter the patient roster by what the clinician typed.
 *
 * Pure, so the matching rule is testable without a DOM. PatientsView renders
 * whatever this returns.
 */

/** Lowercase and strip accents, so "jose" finds "José". */
function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
}

/**
 * Patients whose name or MRN contains EVERY word of the query.
 *
 * Words are split on spaces and commas, so "smith, john", "john smith" and
 * "jo smi" all find John Smith. Requiring every word (rather than any) is what
 * keeps a second word narrowing the list instead of widening it.
 *
 * Only name and MRN are searched: they are what a clinician reads off a chart
 * to find someone. Diagnosis is shared by many patients and would turn a name
 * fragment like "ann" into a match on unrelated rows.
 *
 * @param {Array<{name?: string, mrn?: string}>} patients
 * @param {string} query
 * @returns {Array} matching patients, in the order given; all of them for an empty query
 */
export function filterPatients(patients, query) {
  const list  = Array.isArray(patients) ? patients : []
  const words = fold(query).split(/[\s,]+/).filter(Boolean)
  if (words.length === 0) return list

  return list.filter((p) => {
    const haystack = `${fold(p?.name)} ${fold(p?.mrn)}`
    return words.every(w => haystack.includes(w))
  })
}
