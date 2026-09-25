/**
 * LoginView.js
 *
 * Clinician sign-in / sign-up, plus the two halves of password reset:
 * 'forgot' requests the email, 'recovery' sets the new password once the
 * link has landed and main.js has routed here with the recovery guard set
 * (see core/authRedirect.js). Shown at boot when Supabase is configured and
 * no cached auth session exists. After one successful login the cached
 * session lets the PWA boot straight into the app, even offline.
 */

import { signIn, signUp, requestPasswordReset, updatePassword, restoreSession, getSession } from '../core/supabase.js'
import { endRecovery, recoveryTokens, sessionIdOf, collectRecoveryDiagnostics } from '../core/authRedirect.js'
import { saveSettings } from '../core/storage.js'

const MODES = {
  signin:   { heading: 'Sign in',            submit: 'Sign in',           busy: 'Signing in…' },
  signup:   { heading: 'Create account',     submit: 'Sign up',           busy: 'Creating account…' },
  forgot:   { heading: 'Reset password',     submit: 'Send reset link',   busy: 'Sending…' },
  recovery: { heading: 'Set a new password', submit: 'Save new password', busy: 'Saving…' },
  done:     { heading: 'Password saved',     submit: 'Continue',          busy: 'Continuing…' },
}

export class LoginView {
  /**
   * @param {HTMLElement} container - the #app div
   * @param {Function}    onLogin   - called after successful sign-in
   * @param {{mode?: 'signin'|'recovery', error?: string}} [options]
   */
  constructor(container, onLogin, { mode = 'signin', error = null } = {}) {
    this.container     = container
    this.onLogin       = onLogin
    this._mode         = mode   // 'signin' | 'signup' | 'forgot' | 'recovery' | 'done'
    this._initialError = error
  }

  mount() {
    this.container.innerHTML = this._template()
    this._bind()
    this._setMode(this._mode)
    if (this._initialError) this._showError(this._initialError)
  }

  unmount() {
    this.container.innerHTML = ''
  }

  // ─── Behavior ────────────────────────────────────────────────────────

  _bind() {
    this._form     = document.getElementById('login-form')
    this._email    = document.getElementById('login-email')
    this._password = document.getElementById('login-password')
    this._confirm  = document.getElementById('login-confirm')
    this._submit   = document.getElementById('login-submit')
    this._toggle   = document.getElementById('login-toggle')
    this._forgot   = document.getElementById('login-forgot')
    this._note     = document.getElementById('login-note')
    this._error    = document.getElementById('login-error')
    this._info     = document.getElementById('login-info')

    this._form.addEventListener('submit', (e) => {
      e.preventDefault()
      this._handleSubmit()
    })
    this._toggle.addEventListener('click', () => {
      this._setMode(this._mode === 'signin' ? 'signup' : 'signin')
    })
    this._forgot.addEventListener('click', () => this._setMode('forgot'))
  }

  /**
   * Show exactly the fields a mode needs. Hidden inputs are also disabled so
   * their `required` doesn't block submitting the visible ones.
   */
  _setMode(mode) {
    this._mode = mode
    const m = MODES[mode]
    const show = (el, on) => {
      el.style.display = on ? '' : 'none'
      if (el.tagName === 'INPUT') el.disabled = !on
    }

    document.getElementById('login-heading').textContent = m.heading
    this._submit.textContent = m.submit

    const setting = mode === 'recovery' || mode === 'done'
    show(this._email,    !setting)
    show(this._password, mode !== 'forgot' && mode !== 'done')
    show(this._confirm,  mode === 'recovery')
    show(this._forgot,   mode === 'signin')
    // Recovery is a signed-in session with one job: no way out but through
    show(this._toggle,   !setting)
    show(this._note,     setting || mode === 'forgot')

    this._password.autocomplete = mode === 'signin' ? 'current-password' : 'new-password'
    this._password.placeholder  = mode === 'recovery' ? 'New password' : 'Password'
    this._toggle.textContent =
      mode === 'signin' ? 'New here? Create an account'
      : mode === 'forgot' ? 'Back to sign in'
      : 'Already have an account? Sign in'
    this._note.textContent = setting
      ? 'Opened this link on iPhone? It opens in Safari — once saved, use the new password to sign in to the installed app too.'
      : "Enter your account email and we'll send a link to set a new password."

    this._hideMessages()
  }

  async _handleSubmit() {
    const mode = this._mode
    this._hideMessages()

    if (mode === 'recovery' && this._password.value !== this._confirm.value) {
      this._showError("Passwords don't match.")
      return
    }

    this._submit.disabled    = true
    this._submit.textContent = MODES[mode].busy

    try {
      if (mode === 'signin')        await this._doSignIn()
      else if (mode === 'signup')   await this._doSignUp()
      else if (mode === 'forgot')   await this._doForgot()
      else if (mode === 'recovery') await this._doRecovery()
      else if (mode === 'done')     this.onLogin()
    } finally {
      this._submit.disabled    = false
      this._submit.textContent = MODES[this._mode].submit
    }
  }

  async _doSignIn() {
    const email    = this._email.value.trim()
    const password = this._password.value
    if (!email || !password) return
    try {
      await signIn(email, password)
      this.onLogin()
    } catch (err) {
      this._showError(err.message || 'Something went wrong — try again.')
    }
  }

  async _doSignUp() {
    const email    = this._email.value.trim()
    const password = this._password.value
    if (!email || !password) return
    try {
      const session = await signUp(email, password)
      if (session) {
        this.onLogin()
      } else {
        // Project requires email confirmation before first sign-in
        this._setMode('signin')
        this._showInfo('Check your email to confirm your account, then sign in.')
      }
    } catch (err) {
      this._showError(err.message || 'Something went wrong — try again.')
    }
  }

  async _doForgot() {
    const email = this._email.value.trim()
    if (!email) return
    try {
      await requestPasswordReset(email)
      // Same words whether or not the account exists — the form must not
      // reveal which emails have accounts.
      this._showInfo('If an account exists for that email, a reset link is on its way.')
    } catch {
      // Rate limit, delivery or network failure. Never imply a send; the raw
      // error is withheld so the wording stays account-neutral.
      this._showError("We couldn't send a reset link right now — please try again later.")
    }
  }

  async _doRecovery() {
    const password = this._password.value
    let fallbackRef = null
    try {
      await updatePassword(password)
    } catch (err) {
      if (err?.name !== 'AuthSessionMissingError') {
        // Guard stays set and the form stays up — the password is unchanged
        this._showError(err.message || "Couldn't save the new password — try again.")
        return
      }
      // The link's session has vanished from storage (seen on iPhone Safari,
      // cause unknown — see authRedirect.js). Record the device's state, then
      // rebuild the session from the link's own tokens and try once more.
      fallbackRef = collectRecoveryDiagnostics()
      console.warn('[recovery] session missing at save:', fallbackRef)
      const tokens = recoveryTokens()
      try {
        if (!tokens) throw new Error('no link tokens held')
        await restoreSession(tokens)
        await updatePassword(password)
      } catch {
        // Nothing left to set a password on. Release the guard and hand the
        // clinician the one way forward: a fresh link.
        endRecovery()
        this._setMode('forgot')
        this._showError(`This reset session has ended — request a new link. (ref ${fallbackRef})`)
        return
      }
    }

    // Mark this session's reset finished, so boot() doesn't mistake it for
    // one an older cached build left unfinished (isUnfinishedResetSession).
    saveSettings({ recovery_completed_session: sessionIdOf(await getSession()) })
    endRecovery()

    if (fallbackRef) {
      // The save only worked through the fallback. Show the reference before
      // moving on — it is the evidence for why the session vanished.
      this._setMode('done')
      this._showInfo(`New password saved. (ref ${fallbackRef})`)
      return
    }
    this.onLogin()
  }

  _showError(text) {
    this._error.textContent   = text
    this._error.style.display = 'block'
  }

  _showInfo(text) {
    this._info.textContent   = text
    this._info.style.display = 'block'
  }

  _hideMessages() {
    this._error.style.display = 'none'
    this._info.style.display  = 'none'
  }

  // ─── Template ────────────────────────────────────────────────────────

  _template() {
    return `
      <div class="login-view">
        <div class="login-card">
          <div class="login-brand">KineticsIQ</div>
          <div class="login-sub">Range of motion, measured with your camera</div>

          <h1 id="login-heading" class="login-heading">Sign in</h1>
          <p id="login-note" class="login-note" style="display:none"></p>

          <form id="login-form" class="login-form">
            <input id="login-email" class="login-input" type="email"
              placeholder="Email" autocomplete="email" required
              autocapitalize="none" autocorrect="off" />
            <input id="login-password" class="login-input" type="password"
              placeholder="Password" autocomplete="current-password"
              minlength="6" required />
            <input id="login-confirm" class="login-input" type="password"
              placeholder="Confirm new password" autocomplete="new-password"
              minlength="6" required style="display:none" disabled />
            <button id="login-submit" class="btn-primary login-submit" type="submit">Sign in</button>
          </form>

          <div id="login-error" class="login-error" style="display:none"></div>
          <div id="login-info"  class="login-info"  style="display:none"></div>

          <button id="login-forgot" class="login-toggle login-forgot" type="button">
            Forgot password?
          </button>
          <button id="login-toggle" class="login-toggle" type="button">
            New here? Create an account
          </button>
        </div>
      </div>

      <style>
        .login-view {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
          background: #0a0a0a;
          padding: 24px;
        }

        .login-card {
          width: 100%;
          max-width: 340px;
          text-align: center;
        }

        .login-brand {
          font-size: 26px;
          font-weight: 700;
          color: #4ade80;
          letter-spacing: -0.5px;
        }

        .login-sub {
          font-size: 13px;
          color: #666;
          margin: 4px 0 32px;
        }

        .login-heading {
          font-size: 18px;
          font-weight: 600;
          color: #f0f0f0;
          margin-bottom: 16px;
        }

        .login-note {
          font-size: 13px;
          color: #999;
          line-height: 1.4;
          margin: -6px 0 14px;
        }

        .login-form {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .login-input {
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 8px;
          color: #f0f0f0;
          font-size: 15px;
          padding: 12px 14px;
          font-family: -apple-system, sans-serif;
          outline: none;
          -webkit-appearance: none;
        }

        .login-input:focus { border-color: #4ade80; }
        .login-input::placeholder { color: #555; }

        .login-submit {
          padding: 13px;
          font-size: 15px;
          margin-top: 4px;
        }

        .login-error {
          margin-top: 14px;
          padding: 10px 12px;
          background: rgba(248,113,113,0.1);
          border: 1px solid rgba(248,113,113,0.3);
          border-radius: 8px;
          color: #f87171;
          font-size: 13px;
          line-height: 1.4;
        }

        .login-info {
          margin-top: 14px;
          padding: 10px 12px;
          background: rgba(74,222,128,0.08);
          border: 1px solid rgba(74,222,128,0.25);
          border-radius: 8px;
          color: #4ade80;
          font-size: 13px;
          line-height: 1.4;
        }

        .login-toggle {
          margin-top: 18px;
          background: none;
          border: none;
          color: #60a5fa;
          font-size: 13px;
          cursor: pointer;
          padding: 8px;
        }

        .login-forgot {
          display: block;
          margin: 10px auto 0;
          color: #888;
        }
      </style>
    `
  }
}
