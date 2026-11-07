/**
 * selection.js — which joint, side and position MeasureView opens on.
 *
 * MeasureView is rebuilt on every navigation, and used to open on Right Knee
 * with no position every time, so a clinician measuring a left hip re-selected
 * it after every trip to History. The selection now carries over, under rules
 * that keep the position honest:
 *
 * - Joint and side carry over for the SAME patient only.
 * - The position carries over only together with the joint it was tapped for.
 *   MeasureView nulls the position whenever the joint changes and saves the
 *   selection on every change, so a stored position always belongs to the
 *   stored joint. It is re-checked against positionsFor() anyway, because a
 *   position the clinician never chose must never be filed (see CLAUDE.md,
 *   "MeasureView selection"): carrying one across joints is how a shoulder was
 *   once recorded as prone.
 * - With nothing to restore: knee, the patient's affected side when it is
 *   left or right (else right), and no position.
 *
 * Pure: no storage, no DOM.
 */

import { JOINT_NAMES, positionsFor } from './labels.js'

const SIDES = ['left', 'right']

/**
 * @param {{patientId: string|null, joint: string, side: string, position: string|null}|null} stored
 * @param {{id: string, affectedSide?: string|null}|null} patient - the active patient
 * @returns {{joint: string, side: string, position: string|null}}
 */
export function restoreSelection(stored, patient) {
  const patientId = patient?.id ?? null

  if (!stored || (stored.patientId ?? null) !== patientId ||
      !(stored.joint in JOINT_NAMES) || !SIDES.includes(stored.side)) {
    return {
      joint:    'knee',
      side:     SIDES.includes(patient?.affectedSide) ? patient.affectedSide : 'right',
      position: null,
    }
  }

  return {
    joint:    stored.joint,
    side:     stored.side,
    position: positionsFor(stored.joint).includes(stored.position) ? stored.position : null,
  }
}
