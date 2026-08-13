/**
 * exportPdf.js
 *
 * Gets a built PDF off the device: resolve the snapshots, build the document,
 * hand the user a file.
 *
 * WHY THE SAFARI GESTURE RULE COMES OUT THE OPPOSITE WAY HERE:
 * SessionDetailView._handleCopy() calls navigator.clipboard.writeText() as the
 * very first thing in its handler, because any `await` before the write drops
 * the user-gesture context on iOS and the write fails silently. The instinct to
 * copy that discipline here is wrong. Building a PDF means awaiting IndexedDB,
 * possibly a Storage download, and jsPDF itself — the gesture is unavoidably
 * gone by the time there is a file, so there is no ordering that preserves it.
 *
 * So the primary path is an <a download> on an object URL, which needs no
 * gesture at all and lands in Files on iOS. navigator.share() DOES need a live
 * gesture, so it is offered only as a second button the user taps afterwards,
 * with the finished file already in hand. Do not move the share into this
 * function to "save a tap" — it will fail silently on the one platform this app
 * targets.
 *
 * THE CONFIRMATION SHEET IS A SAFETY INTERLOCK, NOT A COURTESY:
 * an exported file is identified only by its NAME while it travels phone →
 * Files → cloud → desktop → EHR upload, so the moment before it is created is
 * the last one at which a clinician can catch that they are about to make a
 * document for the wrong patient. It shows the name on screen, previews the
 * exact filename, and is where the initials setting lives — there is no
 * settings screen in this app, and this is the only moment the choice means
 * anything. It fires for single and multi-session exports alike; the single
 * export between two patients is precisely the one done in a hurry.
 *
 * DOM work, hence src/ui/ — pdf.js stays pure and frames.js owns retrieval.
 */

import { resolveFrameBlob } from '../core/frames.js'
import { buildSessionPdf, pdfFilename } from '../core/pdf.js'
import { getPatient, loadSettings, saveSettings } from '../core/storage.js'
import { patientInitials, jointLabel, formatSessionDate, formatSessionTime } from '../core/labels.js'

/**
 * Fetch both snapshots for every session, in parallel.
 *
 * A frame that cannot be resolved comes back null and the document prints a
 * placeholder for it — an evicted blob with the device offline is an expected
 * outcome, not a reason to fail the export.
 *
 * @param {Session[]} sessions
 * @returns {Promise<Map<string, {peak: Blob|null, min: Blob|null}>>}
 */
async function collectImages(sessions) {
  const entries = await Promise.all(sessions.map(async (s) => {
    const [peak, min] = await Promise.all([
      resolveFrameBlob(s.id, 'peak', s.peakFramePath ?? null),
      resolveFrameBlob(s.id, 'min',  s.minFramePath  ?? null),
    ])
    return [s.id, { peak, min }]
  }))
  return new Map(entries)
}

/**
 * The patient a set of sessions belongs to, or null when they disagree.
 *
 * Null on disagreement is the important case: labelling a mixed file with one
 * patient's initials would assert something false about the other's data, which
 * is the exact failure the initials exist to prevent. History scopes its list to
 * the active patient so this should not arise — but "should not" is not a
 * guarantee worth a mislabelled chart document.
 */
function patientFor(sessions) {
  const ids = new Set(sessions.map(s => s.patient_id ?? null))
  if (ids.size !== 1) return null
  return getPatient([...ids][0])
}

/**
 * Build and download a PDF of the given sessions, after confirmation.
 *
 * @param {Session[]} sessions
 * @param {{onStart?: Function}} [opts] - called once the sheet is confirmed, so
 *        callers can show a busy state without it sitting behind the dialog
 * @returns {Promise<{blob: Blob, filename: string, missingImages: number}|null>}
 *          null when the clinician cancelled — not an error
 */
export async function exportSessionsAsPdf(sessions, { onStart } = {}) {
  const list = sessions ?? []
  if (list.length === 0) throw new Error('exportSessionsAsPdf: no sessions given')

  const patient = patientFor(list)
  const choice  = await confirmExport(list, patient)
  if (!choice) return null

  onStart?.()

  const images = await collectImages(list)
  const blob   = await buildSessionPdf(list, images)
  const filename = pdfFilename(list, { initials: choice.initials })

  // Count what the document had to placeholder, so the caller can say so
  // rather than letting the user discover a gap after they have filed it.
  let missingImages = 0
  for (const s of list) {
    const pair = images.get(s.id) ?? {}
    if (!pair.peak) missingImages++
    if (!pair.min)  missingImages++
  }

  triggerDownload(blob, filename)
  return { blob, filename, missingImages }
}

// ─── The confirmation sheet ────────────────────────────────────────────────

/**
 * Ask before creating the file. Resolves null on cancel.
 *
 * @param {Session[]} sessions
 * @param {Patient|null} patient
 * @returns {Promise<{initials: string}|null>}
 */
export function confirmExport(sessions, patient) {
  return new Promise((resolve) => {
    const initials = patientInitials(patient?.name)
    // No initials to offer (no patient record, or a mixed selection) means no
    // toggle — an unticked box the user cannot influence is just noise.
    const canLabel = initials.length > 0

    let include = canLabel && loadSettings().export_include_initials !== false

    const host = document.createElement('div')
    host.className = 'export-confirm'
    host.innerHTML = template(sessions, patient, initials, canLabel, include)
    document.body.appendChild(host)

    const nameEl = host.querySelector('#ec-filename')
    const box    = host.querySelector('#ec-initials')

    const preview = () =>
      pdfFilename(sessions, { initials: include ? initials : '' })

    nameEl.textContent = preview()

    const close = (result) => {
      host.remove()
      document.removeEventListener('keydown', onKey)
      resolve(result)
    }
    const onKey = (e) => { if (e.key === 'Escape') close(null) }
    document.addEventListener('keydown', onKey)

    box?.addEventListener('change', () => {
      include = box.checked
      // Persisted immediately, so the choice survives to the next export even
      // if this one is cancelled — it is a preference, not part of the action.
      saveSettings({ export_include_initials: include })
      nameEl.textContent = preview()
    })

    host.querySelector('#ec-cancel').addEventListener('click', () => close(null))
    host.querySelector('#ec-confirm').addEventListener('click', () =>
      close({ initials: include ? initials : '' }))

    // Tapping the backdrop cancels; tapping the card must not.
    host.addEventListener('click', (e) => { if (e.target === host) close(null) })

    host.querySelector('#ec-confirm').focus()
  })
}

function template(sessions, patient, initials, canLabel, include) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  // The patient's full name goes on SCREEN, never into the file. Seeing it here
  // is the whole point — this is the check against building the wrong document.
  const who = patient?.name
    ? `<div class="ec-patient">${esc(patient.name)}</div>`
    : `<div class="ec-patient ec-unknown">No patient record</div>`

  const what = sessions.length === 1
    ? `${esc(jointLabel(sessions[0]))} · ${esc(formatSessionDate(sessions[0].date))} ${esc(formatSessionTime(sessions[0].timestamp))}`
    : `${sessions.length} sessions`

  const toggle = canLabel ? `
    <label class="ec-toggle">
      <input type="checkbox" id="ec-initials" ${include ? 'checked' : ''}>
      <span>Put initials <strong>${esc(initials)}</strong> in the filename</span>
    </label>
    <div class="ec-hint">Helps you file it against the right chart. The initials
      are in the filename only — never on the page.</div>` : ''

  return `
    <div class="ec-card" role="dialog" aria-modal="true" aria-label="Confirm export">
      <div class="ec-title">Export PDF</div>
      ${who}
      <div class="ec-what">${what}</div>
      <div class="ec-filelabel">Saves as</div>
      <div class="ec-filename" id="ec-filename"></div>
      ${toggle}
      <div class="ec-actions">
        <button id="ec-cancel" class="ec-btn ec-btn-ghost">Cancel</button>
        <button id="ec-confirm" class="ec-btn ec-btn-primary">Export</button>
      </div>
    </div>
    <style>
      .export-confirm {
        position: fixed; inset: 0; z-index: 1000;
        display: flex; align-items: flex-end; justify-content: center;
        background: rgba(0,0,0,0.6);
        padding: 16px;
        padding-bottom: calc(16px + env(safe-area-inset-bottom));
      }
      @media (min-height: 600px) { .export-confirm { align-items: center; } }

      .ec-card {
        width: 100%; max-width: 420px;
        background: #141414;
        border: 1px solid #2a2a2a;
        border-radius: 16px;
        padding: 20px;
        /* Never taller than the viewport: the Export button must stay reachable
           on a short phone screen with the keyboard-free layout. */
        max-height: 100%;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
      }
      .ec-title {
        font-size: 12px; font-weight: 700; letter-spacing: 0.08em;
        text-transform: uppercase; color: #666; margin-bottom: 10px;
      }
      .ec-patient { font-size: 20px; font-weight: 700; color: #f0f0f0; }
      .ec-patient.ec-unknown { color: #fbbf24; font-size: 15px; font-weight: 600; }
      .ec-what { font-size: 13px; color: #888; margin-top: 3px; }

      .ec-filelabel {
        font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
        text-transform: uppercase; color: #666; margin: 16px 0 5px;
      }
      .ec-filename {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px; color: #4ade80;
        background: #0d0d0d; border: 1px solid #262626; border-radius: 8px;
        padding: 9px 11px;
        /* Long names must wrap, not scroll the dialog sideways. */
        overflow-wrap: anywhere; word-break: break-all; line-height: 1.5;
      }

      .ec-toggle {
        display: flex; align-items: flex-start; gap: 10px;
        margin-top: 16px; font-size: 14px; color: #ddd; cursor: pointer;
      }
      .ec-toggle input { width: 20px; height: 20px; flex-shrink: 0; accent-color: #4ade80; margin: 0; }
      .ec-toggle strong { color: #4ade80; font-variant-numeric: tabular-nums; }
      .ec-hint { font-size: 12px; color: #666; line-height: 1.45; margin-top: 7px; padding-left: 30px; }

      .ec-actions { display: flex; gap: 10px; margin-top: 22px; }
      .ec-btn {
        flex: 1; padding: 13px; border-radius: 10px;
        font-family: inherit; font-size: 15px; font-weight: 600; cursor: pointer;
      }
      .ec-btn-ghost { background: none; border: 1px solid #333; color: #ccc; }
      .ec-btn-primary { background: #4ade80; border: 1px solid #4ade80; color: #0a0a0a; }
      .ec-btn-primary:active { background: #3ec26c; }
    </style>`
}

/** Anchor download — no user gesture required, unlike share(). */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next frame, not synchronously: Safari has not necessarily
  // started reading the blob by the time click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** True when a follow-up "Share" button can usefully be offered. */
export function canShareFile(blob, filename) {
  if (typeof navigator === 'undefined' || !navigator.canShare || !navigator.share) return false
  try {
    return navigator.canShare({ files: [new File([blob], filename, { type: 'application/pdf' })] })
  } catch (_) {
    return false
  }
}

/**
 * Open the OS share sheet for an already-built file.
 *
 * MUST be called directly from a user gesture — that is the whole reason it is
 * a separate function rather than a step inside exportSessionsAsPdf().
 *
 * @returns {Promise<boolean>} false when the user dismissed the sheet
 */
export async function shareFile(blob, filename) {
  try {
    await navigator.share({
      files: [new File([blob], filename, { type: 'application/pdf' })],
      title: filename,
    })
    return true
  } catch (_) {
    return false     // AbortError when dismissed — not worth surfacing
  }
}
