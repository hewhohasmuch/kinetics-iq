/**
 * frames.js
 *
 * Gets a session's peak/min snapshot back, wherever it currently lives.
 *
 * WHY THIS IS NOT TRIVIAL:
 * A snapshot has three possible homes and the caller cannot assume any of them.
 * Every capture lands in IndexedDB first (imageStore), sync uploads it to the
 * private session-images bucket, and once uploaded it becomes eligible for
 * eviction when the local cache passes its budget — so a perfectly good session
 * can have no local copy at all. The rule is: try the device, then the cloud,
 * and re-cache what the cloud gives back so the next read is local again.
 *
 * WHY IT LIVES IN ITS OWN MODULE:
 * This rule used to be private to SessionDetailView, which was the only thing
 * that displayed a snapshot. The PDF export needs the identical rule, and a
 * second copy of it would be free to drift — one surface silently showing a
 * placeholder where the other re-downloads, for the same session. There is one
 * implementation and both read it.
 *
 * Returns a Blob rather than an object URL: the view needs createObjectURL, the
 * PDF needs the bytes, and only the caller knows which — and only the caller
 * can know when to revoke a URL it created.
 *
 * Network I/O but no DOM, same as sync.js.
 */

import { getImage, cacheUploaded } from './imageStore.js'
import { getClient, isConfigured } from './supabase.js'

/** The private Storage bucket holding uploaded snapshots. */
export const IMAGE_BUCKET = 'session-images'

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/**
 * Resolve one snapshot to its bytes, or null when it is genuinely unreachable.
 *
 * Null is an expected outcome, not an error: an evicted blob with the device
 * offline has no copy within reach, and callers are expected to show a
 * placeholder rather than treat it as a failure.
 *
 * @param {string} sessionId
 * @param {'peak'|'min'} which
 * @param {string|null} path - Storage object path, null until the upload lands
 * @returns {Promise<Blob|null>}
 */
export async function resolveFrameBlob(sessionId, which, path) {
  let blob = await getImage(sessionId, which)
  if (blob) return blob

  if (path && isConfigured() && isOnline()) {
    try {
      const { data, error } = await getClient().storage.from(IMAGE_BUCKET).download(path)
      if (!error && data) {
        // Fire-and-forget: the caller is waiting on bytes, not on the re-cache.
        cacheUploaded(sessionId, which, data)
        return data
      }
    } catch (_) { /* caller's placeholder path handles it */ }
  }

  return null
}
