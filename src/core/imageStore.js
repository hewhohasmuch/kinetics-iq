/**
 * imageStore.js
 *
 * The ONLY module that touches IndexedDB — the on-device home for session
 * snapshot blobs (peak/min overlay JPEGs). Mirrors storage.js's ownership of
 * localStorage.
 *
 * WHY NOT localStorage: snapshots are ~120-180 KB each and localStorage caps
 * at ~5 MB on iOS Safari, so a handful of sessions used to blow the quota
 * ("Could not save — storage may be full"). IndexedDB has a far larger quota
 * and stores Blobs natively (no ~33% base64 inflation).
 *
 * ROLE: offline-safe staging + a bounded local cache.
 *   - Every capture lands here first (works offline, instant).
 *   - sync.js uploads each blob to Supabase Storage and calls markUploaded().
 *   - When over BUDGET_BYTES, enforceBudget() evicts the OLDEST UPLOADED blobs
 *     first. Un-uploaded blobs are the only copy and are NEVER evicted.
 *   - Evicted blobs re-download from the cloud on demand (SessionDetailView).
 *
 * KEY: `${sessionId}:${which}` where which ∈ 'peak' | 'min'.
 * RECORD: { key, sessionId, which, blob, uploaded, capturedAt, bytes }
 *
 * NODE-SAFE: sync.js imports this and runs under Vitest's Node environment,
 * where `indexedDB` is absent. Every entry point degrades to a no-op / empty
 * result when indexedDB is unavailable, so importers never crash. (Unit tests
 * install `fake-indexeddb` to exercise the real paths.)
 */

const DB_NAME  = 'kinetics_images'
const STORE    = 'images'
const DB_VERSION = 1

/** Local cache budget. Over this, enforceBudget() evicts oldest uploaded. */
export const BUDGET_BYTES = 45 * 1024 * 1024

function _available() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

let _dbPromise = null

/** Open (and lazily create) the database. Resolves null when unavailable. */
function _openDB() {
  if (!_available()) return Promise.resolve(null)
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' })
        store.createIndex('uploaded',   'uploaded',   { unique: false })
        store.createIndex('capturedAt', 'capturedAt', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => { console.error('imageStore open failed:', req.error); resolve(null) }
  })
  return _dbPromise
}

/** Promisify a single-store transaction. `fn(store)` returns a request or nothing. */
function _tx(mode, fn) {
  return _openDB().then((db) => {
    if (!db) return null
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE, mode)
      const store = tx.objectStore(STORE)
      let result
      Promise.resolve(fn(store, (r) => { result = r }))
        .catch(reject)
      tx.oncomplete = () => resolve(result)
      tx.onerror    = () => reject(tx.error)
      tx.onabort    = () => reject(tx.error)
    })
  })
}

function _key(sessionId, which) {
  return `${sessionId}:${which}`
}

// ─── Reads/writes ───────────────────────────────────────────────────────────

/**
 * Store (or replace) a snapshot blob, marked not-yet-uploaded.
 * @param {string} sessionId
 * @param {'peak'|'min'} which
 * @param {Blob} blob
 * @returns {Promise<boolean>} true if stored
 */
export async function putImage(sessionId, which, blob) {
  if (!blob) return false
  try {
    const record = {
      key:        _key(sessionId, which),
      sessionId,
      which,
      blob,
      uploaded:   false,
      capturedAt: Date.now(),
      bytes:      blob.size ?? 0,
    }
    await _tx('readwrite', (store) => store.put(record))
    return true
  } catch (e) {
    console.error('imageStore.putImage failed:', e)
    return false
  }
}

/**
 * Cache a blob already known to be in the cloud (re-download path).
 * Stored with uploaded:true so it counts toward the evictable cache.
 */
export async function cacheUploaded(sessionId, which, blob) {
  if (!blob) return false
  try {
    const record = {
      key:        _key(sessionId, which),
      sessionId,
      which,
      blob,
      uploaded:   true,
      capturedAt: Date.now(),
      bytes:      blob.size ?? 0,
    }
    await _tx('readwrite', (store) => store.put(record))
    return true
  } catch (e) {
    console.error('imageStore.cacheUploaded failed:', e)
    return false
  }
}

/**
 * @returns {Promise<Blob|null>} the stored blob, or null if absent/unavailable
 */
export async function getImage(sessionId, which) {
  try {
    const rec = await _tx('readonly', (store, done) => {
      const req = store.get(_key(sessionId, which))
      req.onsuccess = () => done(req.result)
    })
    return rec ? rec.blob : null
  } catch (e) {
    console.error('imageStore.getImage failed:', e)
    return null
  }
}

/** Flag a stored blob as uploaded so it becomes eligible for eviction. */
export async function markUploaded(sessionId, which) {
  try {
    await _tx('readwrite', (store) => {
      const req = store.get(_key(sessionId, which))
      req.onsuccess = () => {
        const rec = req.result
        if (rec && !rec.uploaded) { rec.uploaded = true; store.put(rec) }
      }
    })
    return true
  } catch (e) {
    console.error('imageStore.markUploaded failed:', e)
    return false
  }
}

/** Remove both frames for a session (e.g. on session delete). */
export async function deleteSessionImages(sessionId) {
  try {
    await _tx('readwrite', (store) => {
      for (const which of ['peak', 'min']) store.delete(_key(sessionId, which))
    })
    return true
  } catch (e) {
    console.error('imageStore.deleteSessionImages failed:', e)
    return false
  }
}

/** Wipe every blob — sign-out shared-device hygiene (cloud copies untouched). */
export async function clearAll() {
  try {
    await _tx('readwrite', (store) => store.clear())
    return true
  } catch (e) {
    console.error('imageStore.clearAll failed:', e)
    return false
  }
}

// ─── Queries ────────────────────────────────────────────────────────────────

function _getAll() {
  return _tx('readonly', (store, done) => {
    const req = store.getAll()
    req.onsuccess = () => done(req.result || [])
  }).then((r) => r || [])
}

/** Records still awaiting upload (the only copy — must not be lost). */
export async function listPending() {
  try {
    const all = await _getAll()
    return all.filter(r => !r.uploaded)
  } catch (e) {
    console.error('imageStore.listPending failed:', e)
    return []
  }
}

/**
 * Cache footprint for the storage gauge.
 * @returns {Promise<{bytes:number,count:number,pendingCount:number}>}
 */
export async function usage() {
  try {
    const all = await _getAll()
    let bytes = 0, pendingCount = 0
    for (const r of all) {
      bytes += r.bytes ?? 0
      if (!r.uploaded) pendingCount++
    }
    return { bytes, count: all.length, pendingCount }
  } catch (e) {
    console.error('imageStore.usage failed:', e)
    return { bytes: 0, count: 0, pendingCount: 0 }
  }
}

/**
 * Evict oldest UPLOADED blobs until the store is under `maxBytes`.
 * Never touches un-uploaded blobs (the only copy). Returns bytes freed.
 *
 * @param {number} [maxBytes=BUDGET_BYTES]
 * @returns {Promise<number>}
 */
export async function enforceBudget(maxBytes = BUDGET_BYTES) {
  try {
    const all = await _getAll()
    let total = all.reduce((s, r) => s + (r.bytes ?? 0), 0)
    if (total <= maxBytes) return 0

    // Oldest uploaded first — recent work stays viewable offline.
    const evictable = all
      .filter(r => r.uploaded)
      .sort((a, b) => (a.capturedAt ?? 0) - (b.capturedAt ?? 0))

    let freed = 0
    const toDelete = []
    for (const rec of evictable) {
      if (total <= maxBytes) break
      toDelete.push(rec.key)
      total -= rec.bytes ?? 0
      freed += rec.bytes ?? 0
    }
    if (toDelete.length) {
      await _tx('readwrite', (store) => { for (const k of toDelete) store.delete(k) })
    }
    return freed
  } catch (e) {
    console.error('imageStore.enforceBudget failed:', e)
    return 0
  }
}

/** Test hook — drop the cached open promise so a fresh DB can be opened. */
export function _resetForTests() {
  _dbPromise = null
}
