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
 * DOM work, hence src/ui/ — pdf.js stays pure and frames.js owns retrieval.
 */

import { resolveFrameBlob } from '../core/frames.js'
import { buildSessionPdf, pdfFilename } from '../core/pdf.js'

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
 * Build and download a PDF of the given sessions.
 *
 * @param {Session[]} sessions
 * @returns {Promise<{blob: Blob, filename: string, missingImages: number}>}
 */
export async function exportSessionsAsPdf(sessions) {
  const list = sessions ?? []
  if (list.length === 0) throw new Error('exportSessionsAsPdf: no sessions given')

  const images = await collectImages(list)
  const blob   = await buildSessionPdf(list, images)
  const filename = pdfFilename(list)

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
