/**
 * id.js
 *
 * Client-generated UUIDs for sessions and patients.
 *
 * IDs are generated on the device (not by the server) so records created
 * offline can be upserted to Supabase later without any id remapping.
 * PURE LOGIC — no DOM, no localStorage.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Generate a v4 UUID. Uses crypto.randomUUID (Safari 15.4+); falls back to
 * crypto.getRandomValues for older WebKit builds.
 *
 * @returns {string}
 */
export function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40   // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80   // variant 10
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Whether a string is a UUID. Sync uses this to skip legacy `sess_<ts>` ids
 * that predate cloud sync — those records stay local-only.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isUuid(id) {
  return typeof id === 'string' && UUID_RE.test(id)
}
