/**
 * storage.js
 *
 * Thin wrapper around localStorage for session persistence.
 *
 * WHY A WRAPPER:
 * - Centralises the storage key names (change once, works everywhere)
 * - Handles JSON parse/stringify in one place
 * - Makes it easy to swap to IndexedDB later if data grows beyond ~5MB
 * - Provides safe error handling (localStorage can throw in private browsing)
 *
 * STORAGE KEYS:
 *   'rom_sessions'  — array of Session objects
 *   'rom_settings'  — app settings object
 *
 * DATA SIZE NOTE:
 * Each session stores min/max/rom/metadata but NOT the raw angle array.
 * A typical session object is ~200 bytes. localStorage has a ~5MB limit.
 * That's roughly 25,000 sessions before you'd need to worry about space.
 * For an MVP this is completely fine.
 */

const KEYS = {
  SESSIONS: 'rom_sessions',
  SETTINGS: 'rom_settings',
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

/**
 * Load all saved sessions, sorted newest first.
 * Returns empty array if none exist or on any error.
 *
 * @returns {Session[]}
 */
export function loadSessions() {
  try {
    const raw = localStorage.getItem(KEYS.SESSIONS)
    if (!raw) return []
    const sessions = JSON.parse(raw)
    // Sort newest first for display
    return sessions.sort((a, b) => b.timestamp - a.timestamp)
  } catch (e) {
    console.error('Failed to load sessions:', e)
    return []
  }
}

/**
 * Save a new session. Appends to existing sessions.
 * Silently fails if localStorage is unavailable (e.g. private browsing).
 *
 * @param {Session} session - from SessionRecorder.stop()
 * @returns {boolean} true if saved successfully
 */
export function saveSession(session) {
  try {
    const existing = loadSessions()
    // Prepend so newest is first in the array too (consistent with loadSessions sort)
    const updated = [session, ...existing]
    localStorage.setItem(KEYS.SESSIONS, JSON.stringify(updated))
    return true
  } catch (e) {
    console.error('Failed to save session:', e)
    return false
  }
}

/**
 * Delete a session by ID.
 *
 * @param {string} sessionId - session.id from the session object
 * @returns {boolean} true if deleted
 */
export function deleteSession(sessionId) {
  try {
    const sessions = loadSessions()
    const filtered = sessions.filter(s => s.id !== sessionId)
    localStorage.setItem(KEYS.SESSIONS, JSON.stringify(filtered))
    return true
  } catch (e) {
    console.error('Failed to delete session:', e)
    return false
  }
}

/**
 * Clear ALL sessions. Used for testing / reset.
 */
export function clearSessions() {
  try {
    localStorage.removeItem(KEYS.SESSIONS)
    return true
  } catch (e) {
    return false
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  calibration_offset: 0,
  smoothing_window:   5,
  sample_rate_hz:     10,
  marker_ids: {
    proximal: 0,
    joint:    1,
    distal:   2,
  },
  patient_label: 'Patient A',
}

/**
 * Load app settings, merging with defaults for any missing keys.
 * Safe to call even if no settings have been saved yet.
 *
 * @returns {Settings}
 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEYS.SETTINGS)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch (e) {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * Save settings. Merges with existing settings (partial update safe).
 *
 * @param {Partial<Settings>} updates
 */
export function saveSettings(updates) {
  try {
    const current = loadSettings()
    const merged  = { ...current, ...updates }
    localStorage.setItem(KEYS.SETTINGS, JSON.stringify(merged))
    return true
  } catch (e) {
    console.error('Failed to save settings:', e)
    return false
  }
}
