/**
 * authRedirect.test.js
 *
 * The password-reset link lands on the app with a Supabase implicit-flow
 * hash that supabase-js turns into a live session. If boot() doesn't notice
 * it is a *recovery* session, it walks straight into the app and the new
 * password is never set — so the parse and the guard are pinned here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  parseAuthRedirect,
  beginRecovery,
  isRecoveryPending,
  endRecovery,
  recoveryTokens,
  recoveryAgeSeconds,
  readRecoveryTokens,
  isUnfinishedResetSession,
  sessionIdOf,
  formatRecoveryDiagnostics,
} from './authRedirect.js'

describe('parseAuthRedirect', () => {

  it('recognises a recovery link', () => {
    const hash = '#access_token=abc&expires_in=3600&refresh_token=r&token_type=bearer&type=recovery'
    expect(parseAuthRedirect(hash)).toBe('recovery')
  })

  it('recognises recovery regardless of parameter order or extras', () => {
    expect(parseAuthRedirect('#type=recovery&access_token=abc&foo=bar')).toBe('recovery')
  })

  it('accepts a hash without the leading #', () => {
    expect(parseAuthRedirect('type=recovery&access_token=abc')).toBe('recovery')
  })

  it('returns the description of an error link (expired reset)', () => {
    const hash = '#error=access_denied&error_code=otp_expired' +
      '&error_description=Email+link+is+invalid+or+has+expired'
    expect(parseAuthRedirect(hash)).toEqual({
      error: 'Email link is invalid or has expired',
      code: 'otp_expired',
    })
  })

  it('falls back to a generic message when an error has no description', () => {
    const result = parseAuthRedirect('#error=access_denied')
    expect(result.error).toMatch(/invalid or has expired/)
  })

  it('ignores a normal sign-in or signup-confirmation hash', () => {
    expect(parseAuthRedirect('#access_token=abc&type=signup')).toBeNull()
    expect(parseAuthRedirect('#access_token=abc&type=magiclink')).toBeNull()
  })

  it('ignores an empty or missing hash', () => {
    expect(parseAuthRedirect('')).toBeNull()
    expect(parseAuthRedirect('#')).toBeNull()
    expect(parseAuthRedirect(undefined)).toBeNull()
  })
})

describe('recovery guard', () => {

  let store
  beforeEach(() => {
    store = {}
    global.sessionStorage = {
      getItem:    (k) => (k in store ? store[k] : null),
      setItem:    (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
    }
  })
  afterEach(() => { delete global.sessionStorage })

  it('is not pending by default', () => {
    expect(isRecoveryPending()).toBe(false)
  })

  it('stays pending from begin until end', () => {
    beginRecovery()
    expect(isRecoveryPending()).toBe(true)
    // Survives a "reload" — a fresh read of the same storage
    expect(isRecoveryPending()).toBe(true)
    endRecovery()
    expect(isRecoveryPending()).toBe(false)
  })

  it('no-ops without sessionStorage', () => {
    delete global.sessionStorage
    expect(() => beginRecovery()).not.toThrow()
    expect(isRecoveryPending()).toBe(false)
    expect(() => endRecovery()).not.toThrow()
  })

  it('no-ops when sessionStorage throws (blocked site data)', () => {
    global.sessionStorage = {
      getItem()    { throw new Error('SecurityError') },
      setItem()    { throw new Error('SecurityError') },
      removeItem() { throw new Error('SecurityError') },
    }
    expect(() => beginRecovery()).not.toThrow()
    expect(isRecoveryPending()).toBe(false)
    expect(() => endRecovery()).not.toThrow()
  })

  it('keeps the link tokens for the life of the recovery, then drops them', () => {
    beginRecovery({ access_token: 'a', refresh_token: 'r' })
    expect(recoveryTokens()).toEqual({ access_token: 'a', refresh_token: 'r' })
    endRecovery()
    expect(recoveryTokens()).toBeNull()
  })

  it('does not overwrite held tokens when the guard is re-armed without any', () => {
    // PASSWORD_RECOVERY re-arms the guard after boot already stored tokens
    beginRecovery({ access_token: 'a', refresh_token: 'r' })
    beginRecovery()
    expect(recoveryTokens()).toEqual({ access_token: 'a', refresh_token: 'r' })
  })

  it('reports how long the recovery has been in progress', () => {
    const t0 = Date.now()
    beginRecovery()
    expect(recoveryAgeSeconds(t0 + 42_000)).toBe(42)
    endRecovery()
    expect(recoveryAgeSeconds()).toBeNull()
  })
})

describe('readRecoveryTokens', () => {

  it('returns the tokens from a recovery link', () => {
    expect(readRecoveryTokens('#access_token=a.b.c&refresh_token=r1&type=recovery'))
      .toEqual({ access_token: 'a.b.c', refresh_token: 'r1' })
  })

  it('returns null for anything that is not a complete recovery link', () => {
    expect(readRecoveryTokens('#access_token=a&refresh_token=r&type=signup')).toBeNull()
    expect(readRecoveryTokens('#type=recovery&access_token=a')).toBeNull()
    expect(readRecoveryTokens('')).toBeNull()
  })
})

// A session as supabase-js stores it, with a JWT carrying the given claims
const jwt = (claims) => ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.')
const sessionWith = ({ amr, sessionId = 'sess-1', recoverySentAt }) => ({
  access_token: jwt({ session_id: sessionId, amr }),
  user: { recovery_sent_at: recoverySentAt },
})
const SENT = '2026-09-24T23:06:21Z'
const SENT_S = Date.parse(SENT) / 1000

describe('isUnfinishedResetSession', () => {

  it('flags a session signed in from a reset email sent just before it', () => {
    const s = sessionWith({ amr: [{ method: 'otp', timestamp: SENT_S + 127 }], recoverySentAt: SENT })
    expect(isUnfinishedResetSession(s, null)).toBe(true)
  })

  it('stops flagging it once this device finished that reset', () => {
    const s = sessionWith({ amr: [{ method: 'otp', timestamp: SENT_S + 127 }], recoverySentAt: SENT })
    expect(isUnfinishedResetSession(s, 'sess-1')).toBe(false)
    // …but a completion recorded for a different session does not count
    expect(isUnfinishedResetSession(s, 'sess-other')).toBe(true)
  })

  it('ignores a password sign-in, even with a reset email outstanding', () => {
    const s = sessionWith({ amr: [{ method: 'password', timestamp: SENT_S + 60 }], recoverySentAt: SENT })
    expect(isUnfinishedResetSession(s, null)).toBe(false)
  })

  it('ignores an emailed-link sign-in when no reset email was ever sent (signup confirmation)', () => {
    const s = sessionWith({ amr: [{ method: 'otp', timestamp: SENT_S }], recoverySentAt: null })
    expect(isUnfinishedResetSession(s, null)).toBe(false)
  })

  it('ignores an emailed-link sign-in that does not follow the reset email', () => {
    const before = sessionWith({ amr: [{ method: 'otp', timestamp: SENT_S - 5 }], recoverySentAt: SENT })
    const daysLater = sessionWith({ amr: [{ method: 'otp', timestamp: SENT_S + 3 * 86400 }], recoverySentAt: SENT })
    expect(isUnfinishedResetSession(before, null)).toBe(false)
    expect(isUnfinishedResetSession(daysLater, null)).toBe(false)
  })

  it('is false for a missing session or an undecodable token', () => {
    expect(isUnfinishedResetSession(null, null)).toBe(false)
    expect(isUnfinishedResetSession({ access_token: 'not-a-jwt', user: {} }, null)).toBe(false)
  })
})

describe('sessionIdOf', () => {
  it('reads the session_id claim, or null', () => {
    expect(sessionIdOf({ access_token: jwt({ session_id: 'abc' }) })).toBe('abc')
    expect(sessionIdOf({ access_token: 'junk' })).toBeNull()
    expect(sessionIdOf(null)).toBeNull()
  })
})

describe('formatRecoveryDiagnostics', () => {

  it('packs the state at the moment of failure into one short code', () => {
    expect(formatRecoveryDiagnostics({
      storedSession: false, storageWritable: true, hasTokens: true, guard: true,
      navType: 'reload', controlled: true, ageS: 42, events: ['INITIAL_SESSION', 'PASSWORD_RECOVERY'],
    })).toBe('s0 w1 t1 g1 nr c1 a42 e:IP')
  })

  it('marks unknowns rather than guessing them', () => {
    expect(formatRecoveryDiagnostics({})).toBe('s? w? t? g? n? c? a? e:')
  })
})
