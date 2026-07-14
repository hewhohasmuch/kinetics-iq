/**
 * PatientsView.js
 *
 * Patient roster + intake form. The clinician picks the active patient here
 * before measuring; sessions save against that patient. Create/edit uses an
 * inline form panel in the same view (no routing). Archiving soft-deletes:
 * the record and its sessions survive in the cloud, the patient just leaves
 * the default list.
 */

import {
  loadPatients, getPatient, upsertPatient, archivePatient,
  getActivePatientId, setActivePatientId,
} from '../core/storage.js'
import { isConfigured, signOut } from '../core/supabase.js'
import { syncNow, getStatus, onSyncStatus } from '../core/sync.js'

export class PatientsView {
  /**
   * @param {HTMLElement} container         - the #app div
   * @param {Function}    onBack            - return to MeasureView
   * @param {Function}    onPatientSelected - called after a patient is made active
   */
  constructor(container, onBack, onPatientSelected) {
    this.container         = container
    this.onBack            = onBack
    this.onPatientSelected = onPatientSelected
    this._editingId        = null   // patient id being edited, or null for create
    this._unsubSync        = null
  }

  mount() {
    this.container.innerHTML = this._template()
    this._bind()
    this._renderList()
    if (isConfigured()) {
      // Right after login this view mounts before the initial cloud pull
      // finishes — re-render when a sync pass completes so pulled patients
      // appear without navigating away and back.
      this._unsubSync = onSyncStatus(() => this._renderList())
    }
  }

  unmount() {
    if (this._unsubSync) {
      this._unsubSync()
      this._unsubSync = null
    }
    this.container.innerHTML = ''
  }

  // ─── Binding ─────────────────────────────────────────────────────────

  _bind() {
    this._listEl    = document.getElementById('patient-list')
    this._formPanel = document.getElementById('patient-form-panel')
    this._formTitle = document.getElementById('patient-form-title')
    this._btnArchive = document.getElementById('btn-archive-patient')

    document.getElementById('btn-back').addEventListener('click', () => this.onBack())
    document.getElementById('btn-new-patient').addEventListener('click', () => this._openForm(null))
    document.getElementById('btn-form-cancel').addEventListener('click', () => this._closeForm())
    this._btnArchive.addEventListener('click', () => this._handleArchive())

    document.getElementById('patient-form').addEventListener('submit', (e) => {
      e.preventDefault()
      this._handleSave()
    })

    const btnSignOut = document.getElementById('btn-signout')
    if (isConfigured()) {
      btnSignOut.addEventListener('click', async () => {
        if (!confirm('Sign out? Patient data is removed from this device after it has been backed up to your account.')) return
        try {
          // Sign-out wipes all local data (including the sync outbox), so any
          // change that hasn't reached the cloud yet would be lost forever.
          // Drain the outbox first and refuse to sign out while ops remain.
          await syncNow()
          const { pendingCount } = getStatus()
          if (pendingCount > 0) {
            alert(
              `${pendingCount} change${pendingCount === 1 ? ' hasn’t' : 's haven’t'} ` +
              'been backed up to your account yet. Check your connection and try again — ' +
              'signing out now would lose this data.'
            )
            return
          }
          await signOut()
          // main.js listens for SIGNED_OUT: wipes local data, shows login
        } catch (err) {
          alert(`Could not sign out: ${err.message}`)
        }
      })
    } else {
      btnSignOut.style.display = 'none'
    }
  }

  // ─── List ────────────────────────────────────────────────────────────

  _renderList() {
    const patients = loadPatients()
    const activeId = getActivePatientId()

    if (patients.length === 0) {
      this._listEl.innerHTML = `
        <div class="empty-state">
          No patients yet.<br>Tap “+ New patient” to create the first profile.
        </div>`
      return
    }

    this._listEl.innerHTML = patients.map(p => this._patientRow(p, p.id === activeId)).join('')

    this._listEl.querySelectorAll('.patient-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.btn-edit')) return
        setActivePatientId(row.dataset.id)
        this.onPatientSelected()
      })
    })

    this._listEl.querySelectorAll('.btn-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        this._openForm(e.currentTarget.dataset.id)
      })
    })
  }

  _patientRow(patient, isActive) {
    const meta = [
      patient.dob ? `DOB ${patient.dob}` : null,
      patient.mrn ? `MRN ${this._esc(patient.mrn)}` : null,
      patient.diagnosis ? this._esc(patient.diagnosis) : null,
    ].filter(Boolean).join(' · ')

    return `
      <div class="patient-row ${isActive ? 'active' : ''}" data-id="${patient.id}">
        <div class="patient-info">
          <div class="patient-name">
            ${this._esc(patient.name)}
            ${isActive ? '<span class="active-badge">Active</span>' : ''}
          </div>
          ${meta ? `<div class="patient-meta">${meta}</div>` : ''}
        </div>
        <button class="btn-edit" data-id="${patient.id}" aria-label="Edit patient">Edit</button>
      </div>`
  }

  // ─── Form ────────────────────────────────────────────────────────────

  _openForm(patientId) {
    this._editingId = patientId
    const p = patientId ? getPatient(patientId) : null

    this._formTitle.textContent = p ? 'Edit patient' : 'New patient'
    this._btnArchive.style.display = p ? 'block' : 'none'

    document.getElementById('pf-name').value      = p?.name ?? ''
    document.getElementById('pf-dob').value       = p?.dob ?? ''
    document.getElementById('pf-mrn').value       = p?.mrn ?? ''
    document.getElementById('pf-diagnosis').value = p?.diagnosis ?? ''
    document.getElementById('pf-surgery').value   = p?.surgeryDate ?? ''
    document.getElementById('pf-side').value      = p?.affectedSide ?? ''
    document.getElementById('pf-notes').value     = p?.notes ?? ''

    this._formPanel.style.display = 'flex'
    setTimeout(() => document.getElementById('pf-name').focus(), 150)
  }

  _closeForm() {
    this._formPanel.style.display = 'none'
    this._editingId = null
  }

  _handleSave() {
    const name = document.getElementById('pf-name').value.trim()
    if (!name) return

    const existing = this._editingId ? getPatient(this._editingId) : null
    upsertPatient({
      ...(existing ?? {}),
      name,
      dob:          document.getElementById('pf-dob').value || null,
      mrn:          document.getElementById('pf-mrn').value.trim(),
      diagnosis:    document.getElementById('pf-diagnosis').value.trim(),
      surgeryDate:  document.getElementById('pf-surgery').value || null,
      affectedSide: document.getElementById('pf-side').value || null,
      notes:        document.getElementById('pf-notes').value.trim(),
    })

    this._closeForm()
    this._renderList()
  }

  _handleArchive() {
    if (!this._editingId) return
    if (!confirm('Archive this patient? Their sessions are kept, but the patient leaves this list.')) return
    archivePatient(this._editingId)
    this._closeForm()
    this._renderList()
  }

  _esc(text) {
    const div = document.createElement('div')
    div.textContent = text ?? ''
    return div.innerHTML
  }

  // ─── Template ────────────────────────────────────────────────────────

  _template() {
    return `
      <div class="patients-view">

        <div class="patients-header">
          <button id="btn-back" class="btn-ghost btn-back">← Back</button>
          <h1 class="patients-title">Patients</h1>
          <button id="btn-signout" class="btn-ghost btn-signout">Sign out</button>
        </div>

        <div class="patients-actions">
          <button id="btn-new-patient" class="btn-primary btn-new">+ New patient</button>
        </div>

        <div id="patient-list" class="patient-list"></div>

        <!-- Intake form — modal-style overlay panel -->
        <div id="patient-form-panel" class="form-panel" style="display:none">
          <form id="patient-form" class="patient-form">
            <h2 id="patient-form-title" class="form-title">New patient</h2>

            <label class="form-label">Name *
              <input id="pf-name" class="form-input" type="text" maxlength="100"
                required autocomplete="off" autocorrect="off" />
            </label>

            <div class="form-row-2">
              <label class="form-label">Date of birth
                <input id="pf-dob" class="form-input" type="date" />
              </label>
              <label class="form-label">MRN / ID
                <input id="pf-mrn" class="form-input" type="text" maxlength="50" autocomplete="off" />
              </label>
            </div>

            <label class="form-label">Diagnosis
              <input id="pf-diagnosis" class="form-input" type="text" maxlength="200" autocomplete="off" />
            </label>

            <div class="form-row-2">
              <label class="form-label">Surgery date
                <input id="pf-surgery" class="form-input" type="date" />
              </label>
              <label class="form-label">Affected side
                <select id="pf-side" class="form-input">
                  <option value="">—</option>
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                  <option value="both">Both</option>
                </select>
              </label>
            </div>

            <label class="form-label">Notes
              <textarea id="pf-notes" class="form-input form-textarea" maxlength="500" rows="3"></textarea>
            </label>

            <div class="form-buttons">
              <button type="submit" class="btn-primary form-save">Save</button>
              <button type="button" id="btn-form-cancel" class="btn-ghost">Cancel</button>
            </div>
            <button type="button" id="btn-archive-patient" class="btn-archive" style="display:none">
              Archive patient
            </button>
          </form>
        </div>

      </div>

      <style>
        .patients-view {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background: #0a0a0a;
          overflow: hidden;
          position: relative;
        }

        .patients-header {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px 16px 12px;
          background: #111;
          border-bottom: 1px solid #222;
          flex-shrink: 0;
        }

        .patients-title {
          font-size: 18px;
          font-weight: 600;
          color: #f0f0f0;
          flex: 1;
        }

        .btn-back, .btn-signout {
          padding: 8px 14px;
          font-size: 14px;
          flex-shrink: 0;
        }

        .patients-actions {
          padding: 12px 16px 4px;
          flex-shrink: 0;
        }

        .btn-new {
          width: 100%;
          padding: 12px;
          font-size: 15px;
        }

        .patient-list {
          flex: 1;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          padding: 8px 0 24px;
        }

        .patient-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 14px 16px;
          border-bottom: 1px solid #1a1a1a;
          cursor: pointer;
        }

        .patient-row:active { background: #1a1a1a; }

        .patient-row.active {
          background: rgba(74,222,128,0.06);
          border-left: 3px solid #4ade80;
          padding-left: 13px;
        }

        .patient-info { flex: 1; min-width: 0; }

        .patient-name {
          font-size: 15px;
          font-weight: 600;
          color: #f0f0f0;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .active-badge {
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          background: rgba(74,222,128,0.15);
          color: #4ade80;
          border-radius: 4px;
          padding: 2px 6px;
        }

        .patient-meta {
          font-size: 12px;
          color: #666;
          margin-top: 3px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .btn-edit {
          background: none;
          border: 1px solid #333;
          border-radius: 6px;
          color: #888;
          font-size: 13px;
          padding: 7px 12px;
          flex-shrink: 0;
        }

        .btn-edit:active { color: #f0f0f0; background: #222; }

        .empty-state {
          text-align: center;
          color: #666;
          font-size: 14px;
          line-height: 1.6;
          padding: 48px 32px;
        }

        /* ── Intake form overlay ── */

        .form-panel {
          position: absolute;
          inset: 0;
          background: rgba(0,0,0,0.7);
          display: flex;
          align-items: flex-start;
          justify-content: center;
          padding: 24px 16px;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          z-index: 10;
        }

        .patient-form {
          width: 100%;
          max-width: 420px;
          background: #161616;
          border: 1px solid #2a2a2a;
          border-radius: 14px;
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .form-title {
          font-size: 16px;
          font-weight: 600;
          color: #f0f0f0;
        }

        .form-label {
          display: flex;
          flex-direction: column;
          gap: 5px;
          font-size: 12px;
          font-weight: 600;
          color: #888;
        }

        .form-row-2 {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }

        .form-input {
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 8px;
          color: #f0f0f0;
          font-size: 15px;
          padding: 10px 12px;
          font-family: -apple-system, sans-serif;
          font-weight: 400;
          outline: none;
          -webkit-appearance: none;
          width: 100%;
        }

        .form-input:focus { border-color: #4ade80; }

        .form-textarea { resize: vertical; }

        select.form-input {
          background-image: none;
          height: 41px;
        }

        .form-buttons {
          display: flex;
          gap: 8px;
          margin-top: 6px;
        }

        .form-save { flex: 2; padding: 12px; }
        .form-buttons .btn-ghost { flex: 1; padding: 12px; }

        .btn-archive {
          background: none;
          border: none;
          color: #f87171;
          font-size: 13px;
          padding: 10px;
          cursor: pointer;
          margin-top: 2px;
        }
      </style>
    `
  }
}
