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
})
