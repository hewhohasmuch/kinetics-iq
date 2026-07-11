/**
 * LoginView.js
 *
 * Clinician sign-in / sign-up. Shown at boot when Supabase is configured
 * and no cached auth session exists. After one successful login the cached
 * session lets the PWA boot straight into the app, even offline.
 */

import { signIn, signUp } from '../core/supabase.js'

export class LoginView {
  /**
   * @param {HTMLElement} container - the #app div
   * @param {Function}    onLogin   - called after successful sign-in
   */
  constructor(container, onLogin) {
    this.container = container
    this.onLogin   = onLogin
    this._mode     = 'signin'   // 'signin' | 'signup'
  }

  mount() {
    this.container.innerHTML = this._template()
    this._bind()
  }

  unmount() {
    this.container.innerHTML = ''
  }

  // ─── Behavior ────────────────────────────────────────────────────────

  _bind() {
    this._form     = document.getElementById('login-form')
    this._email    = document.getElementById('login-email')
    this._password = document.getElementById('login-password')
    this._submit   = document.getElementById('login-submit')
    this._toggle   = document.getElementById('login-toggle')
    this._error    = document.getElementById('login-error')
    this._info     = document.getElementById('login-info')

    this._form.addEventListener('submit', (e) => {
      e.preventDefault()
      this._handleSubmit()
    })
    this._toggle.addEventListener('click', () => this._toggleMode())
  }

  _toggleMode() {
    this._mode = this._mode === 'signin' ? 'signup' : 'signin'
    const signin = this._mode === 'signin'
    document.getElementById('login-heading').textContent = signin ? 'Sign in' : 'Create account'
    this._submit.textContent = signin ? 'Sign in' : 'Sign up'
    this._toggle.textContent = signin
      ? 'New here? Create an account'
      : 'Already have an account? Sign in'
    this._hideMessages()
  }

  async _handleSubmit() {
    const email    = this._email.value.trim()
    const password = this._password.value
    if (!email || !password) return

    this._hideMessages()
    this._submit.disabled  = true
    this._submit.textContent = this._mode === 'signin' ? 'Signing in…' : 'Creating account…'

    try {
      if (this._mode === 'signin') {
        await signIn(email, password)
        this.onLogin()
      } else {
        const session = await signUp(email, password)
        if (session) {
          this.onLogin()
        } else {
          // Project requires email confirmation before first sign-in
          this._info.textContent   = 'Check your email to confirm your account, then sign in.'
          this._info.style.display = 'block'
          this._toggleMode()
        }
      }
    } catch (err) {
      this._error.textContent   = err.message || 'Something went wrong — try again.'
      this._error.style.display = 'block'
    } finally {
      this._submit.disabled    = false
      this._submit.textContent = this._mode === 'signin' ? 'Sign in' : 'Sign up'
    }
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

          <form id="login-form" class="login-form">
            <input id="login-email" class="login-input" type="email"
              placeholder="Email" autocomplete="email" required
              autocapitalize="none" autocorrect="off" />
            <input id="login-password" class="login-input" type="password"
              placeholder="Password" autocomplete="current-password"
              minlength="6" required />
            <button id="login-submit" class="btn-primary login-submit" type="submit">Sign in</button>
          </form>

          <div id="login-error" class="login-error" style="display:none"></div>
          <div id="login-info"  class="login-info"  style="display:none"></div>

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
      </style>
    `
  }
}
