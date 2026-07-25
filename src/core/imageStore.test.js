/**
 * imageStore.test.js
 *
 * Exercises the IndexedDB blob store via `fake-indexeddb`, which installs a
 * spec-compliant in-memory indexedDB onto the global scope. Covers the put/get
 * round-trip, upload marking, usage accounting, and — the load-bearing bit —
 * enforceBudget evicting oldest UPLOADED blobs while sparing un-uploaded ones.
 */

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  putImage, cacheUploaded, getImage, markUploaded,
  deleteSessionImages, clearAll, listPending, usage,
  enforceBudget, _resetForTests,
} from './imageStore.js'

// A Blob of a given byte length (fake-indexeddb structured-clones it fine).
function blobOf(bytes) {
  return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })
}

beforeEach(async () => {
  await clearAll()
  _resetForTests()
  await clearAll()
})

describe('put / get round-trip', () => {
  it('stores and retrieves a blob by session + which', async () => {
    await putImage('s1', 'peak', blobOf(100))
    const back = await getImage('s1', 'peak')
    expect(back).toBeInstanceOf(Blob)
    expect(back.size).toBe(100)
  })

  it('returns null for a missing image', async () => {
    expect(await getImage('nope', 'min')).toBeNull()
  })

  it('keeps peak and min separate for one session', async () => {
    await putImage('s1', 'peak', blobOf(10))
    await putImage('s1', 'min', blobOf(20))
    expect((await getImage('s1', 'peak')).size).toBe(10)
    expect((await getImage('s1', 'min')).size).toBe(20)
  })
})

describe('upload state', () => {
  it('new blobs are pending; markUploaded clears them from the pending list', async () => {
    await putImage('s1', 'peak', blobOf(10))
    await putImage('s1', 'min', blobOf(10))
    expect(await listPending()).toHaveLength(2)

    await markUploaded('s1', 'peak')
    const pending = await listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0].which).toBe('min')
  })

  it('cacheUploaded stores a blob already marked uploaded', async () => {
    await cacheUploaded('s1', 'peak', blobOf(10))
    expect(await listPending()).toHaveLength(0)
    expect((await getImage('s1', 'peak')).size).toBe(10)
  })
})

describe('usage accounting', () => {
  it('sums bytes and counts pending', async () => {
    await putImage('s1', 'peak', blobOf(100))
    await putImage('s2', 'peak', blobOf(200))
    await markUploaded('s2', 'peak')

    const u = await usage()
    expect(u.bytes).toBe(300)
    expect(u.count).toBe(2)
    expect(u.pendingCount).toBe(1)
  })
})

describe('deleteSessionImages', () => {
  it('removes both frames for a session, leaving others', async () => {
    await putImage('s1', 'peak', blobOf(10))
    await putImage('s1', 'min', blobOf(10))
    await putImage('s2', 'peak', blobOf(10))

    await deleteSessionImages('s1')
    expect(await getImage('s1', 'peak')).toBeNull()
    expect(await getImage('s1', 'min')).toBeNull()
    expect(await getImage('s2', 'peak')).not.toBeNull()
  })
})

describe('enforceBudget', () => {
  it('does nothing when under budget', async () => {
    await cacheUploaded('s1', 'peak', blobOf(100))
    const freed = await enforceBudget(1000)
    expect(freed).toBe(0)
    expect((await usage()).count).toBe(1)
  })

  it('evicts oldest uploaded first until under budget', async () => {
    // Three uploaded blobs of 100 bytes, ascending capturedAt.
    let t = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10))
    await cacheUploaded('old', 'peak', blobOf(100))
    await cacheUploaded('mid', 'peak', blobOf(100))
    await cacheUploaded('new', 'peak', blobOf(100))
    Date.now.mockRestore()

    // Budget 250 → must drop one (the oldest) to reach 200.
    const freed = await enforceBudget(250)
    expect(freed).toBe(100)
    expect(await getImage('old', 'peak')).toBeNull()
    expect(await getImage('mid', 'peak')).not.toBeNull()
    expect(await getImage('new', 'peak')).not.toBeNull()
  })

  it('never evicts un-uploaded blobs even when over budget', async () => {
    await putImage('pending1', 'peak', blobOf(100)) // not uploaded
    await putImage('pending2', 'peak', blobOf(100)) // not uploaded

    const freed = await enforceBudget(50) // way over, but nothing evictable
    expect(freed).toBe(0)
    expect(await getImage('pending1', 'peak')).not.toBeNull()
    expect(await getImage('pending2', 'peak')).not.toBeNull()
  })

  it('evicts only enough uploaded blobs to get under budget, sparing pending', async () => {
    let t = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10))
    await cacheUploaded('u_old', 'peak', blobOf(100))
    await cacheUploaded('u_new', 'peak', blobOf(100))
    await putImage('pending', 'peak', blobOf(100)) // only copy
    Date.now.mockRestore()

    // total 300, budget 250 → evict just the oldest uploaded (u_old).
    const freed = await enforceBudget(250)
    expect(freed).toBe(100)
    expect(await getImage('u_old', 'peak')).toBeNull()
    expect(await getImage('u_new', 'peak')).not.toBeNull()
    expect(await getImage('pending', 'peak')).not.toBeNull()
  })
})
