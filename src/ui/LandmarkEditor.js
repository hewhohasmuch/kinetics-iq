/**
 * LandmarkEditor.js
 *
 * A modal for re-placing the three landmarks on ONE stored extreme frame.
 *
 * WHY THIS EXISTS: three separate investigations (CLAUDE.md) converged on the
 * residual angle error being LANDMARK PLACEMENT — the elbow's proximal point
 * sits ~4cm behind the humeral head, the shoulder's error reverses sign across
 * its range, a visibly flat knee reads 9°. Every one is a bias, and
 * CalibrationManager.apply() is a single subtraction, which a sign-reversing
 * bias provably defeats. So the clinician is put in the loop exactly where the
 * model is weak: they place the points on the joint centres they can see.
 *
 * WHAT IT IS NOT. Saving does not correct the session. It records an ENDPOINT
 * OBSERVATION on one stored frame; min/max/rom/angleTimeline are never touched,
 * and a verified peak is not a recomputed timeline maximum. See extremes.js.
 *
 * BONE LENGTH IS ADVISORY, NEVER A LOCK. Constraining a drag to a fixed segment
 * length would pin the point to a circle of the wrong radius about the wrong
 * centre — the proximal distance is acromion-to-elbow rather than a real bone,
 * and it is a 2D projection already shortened by out-of-plane tilt. The length
 * readout turns amber as a prompt to look again, and that is all it does.
 *
 * A separate module because MeasureView (1400+ lines) and SessionDetailView
 * (960+) are already too large to add a pointer-driven surface to.
 */

import {
  ROLES, landmarkKind, denormalizeSet, recomputeAngle, segmentLengths,
} from '../core/landmarks.js'
import { drawPoseOverlay, MARKER_COLORS } from '../detection/overlay.js'
import { motionTerms } from '../core/angle.js'

/** Drag target radius in CSS px — a fingertip is about 44px, a point is not. */
const HIT_RADIUS = 28
/**
 * The overlay is drawn at a FIXED size here rather than scaled to the canvas.
 *
 * A stored frame is landscape and this modal is portrait, so the image fits at
 * roughly 400x225 on a phone — and scaling the overlay to that gave 2px dots,
 * which are not grabbable. Precision comes from the loupe instead, and the dots
 * only have to be findable by a fingertip.
 */
const EDITOR_SCALE = 1
/** Segment-length change past which the readout cautions. Advisory only. */
const LENGTH_CAUTION = 0.15
/**
 * The loupe. Size and zoom trade against each other: the source region it
 * samples is SIZE / (2 * ZOOM), so a bigger circle at slightly lower zoom shows
 * more of the surrounding limb — which is what makes a joint centre findable at
 * all. Placing a point against a magnified patch of skin with no landmarks in
 * view is guesswork.
 */
const LOUPE_ZOOM = 2.8
const LOUPE_SIZE = 150

/**
 * Human label for one draggable point.
 *
 * A DERIVED POINT IS NOT A JOINT CENTRE and must never be labelled as one.
 * `JOINT_CONFIG.ankle` builds its proximal point as the knee/ankle midpoint —
 * a constructed geometric reference with no anatomy behind it — so calling it
 * a joint centre would invite the clinician to place it on one.
 */
function roleLabel(joint, side, role) {
  if (landmarkKind(joint, side, role) === 'derived') return 'Shin direction (not a joint)'
  if (role === 'joint') return 'Joint centre'
  return role === 'proximal' ? 'Proximal point' : 'Distal point'
}

/**
 * Open the editor for one frame.
 *
 * @param {object} opts
 * @param {Blob}   opts.blob   - the CLEAN stored frame
 * @param {object} opts.set    - starting normalized set (verified if present, else raw)
 * @param {object} opts.rawSet - the model's original set, for the length reference
 * @param {string} opts.joint
 * @param {string} opts.side
 * @param {'peak'|'min'} opts.which
 * @param {number} [opts.calibrationOffset]
 * @returns {Promise<{set: object, angle: number}|null>} null when cancelled
 */
export function editLandmarks({ blob, set, rawSet, joint, side, which, calibrationOffset = 0 }) {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    host.className = 'lm-editor'
    host.innerHTML = template(joint, which)
    document.body.appendChild(host)

    const canvas   = host.querySelector('#lm-canvas')
    const loupe    = host.querySelector('#lm-loupe')
    const angleEl  = host.querySelector('#lm-angle')
    const lenEl    = host.querySelector('#lm-lengths')
    const roleEl   = host.querySelector('#lm-role')
    const ctx      = canvas.getContext('2d')
    const lctx     = loupe.getContext('2d')

    // Working copy — the caller's set is never mutated, so Cancel is free.
    let working = structuredClone(set)
    let img = null
    let dragging = null          // role currently under the finger
    let dpr = 1

    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => { img = image; layout(); draw() }
    image.onerror = () => close(null)
    image.src = url

    function close(result) {
      URL.revokeObjectURL(url)
      host.remove()
      document.removeEventListener('keydown', onKey)
      resolve(result)
    }
    const onKey = (e) => { if (e.key === 'Escape') close(null) }
    document.addEventListener('keydown', onKey)

    // ── Layout: the canvas takes the image's aspect exactly, so display
    // coordinates map to normalized ones by a single divide — no letterboxing
    // offsets to get wrong.
    //
    // THE STAGE HEIGHT IS PINNED, and that is not cosmetic. The stage was the
    // flex item absorbing leftover space, so every time the length advisory
    // below it grew a line the image TRANSLATED upward — mid-drag, under the
    // finger, while the clinician was placing a point to a fraction of a
    // degree. Reserving space for the advisory helps but cannot be relied on
    // alone: a longer reading or a larger accessibility text size can still
    // take a third line. Pinning makes the image's position independent of
    // everything beneath it.
    function layout() {
      const stage = host.querySelector('#lm-stage')
      // The available box is derived from the VIEWPORT, not from whatever space
      // happens to be left over after the text below is laid out. That is the
      // whole point: the image's size and position must not depend on the
      // length of a caption that changes while the clinician is dragging.
      const availW = stage.getBoundingClientRect().width - 12
      const availH = window.innerHeight * 0.52 - 12

      const scale = Math.min(availW / img.width, availH / img.height)
      const cssW = Math.max(1, Math.floor(img.width * scale))
      const cssH = Math.max(1, Math.floor(img.height * scale))
      dpr = window.devicePixelRatio || 1
      canvas.style.width  = `${cssW}px`
      canvas.style.height = `${cssH}px`
      canvas.width  = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const cssSize = () => ({
      w: canvas.width / dpr,
      h: canvas.height / dpr,
    })

    /** normalized → display CSS px */
    const toDisplay = (p) => {
      const { w, h } = cssSize()
      return { x: p.x * w, y: p.y * h }
    }
    /** display CSS px → normalized, clamped so a point cannot leave the frame */
    const toNormalized = (x, y) => {
      const { w, h } = cssSize()
      return {
        x: Math.min(1, Math.max(0, x / w)),
        y: Math.min(1, Math.max(0, y / h)),
      }
    }

    function draw() {
      if (!img) return
      const { w, h } = cssSize()
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)

      const angle = currentAngle()
      const points = {}
      for (const role of ROLES) points[role] = { ...toDisplay(working[role]), visibility: 1 }

      drawPoseOverlay(ctx, points, {
        interiorAngle: angle === null ? null : 1,   // gate only; the arc uses geometry
        scale: EDITOR_SCALE,
        // Suppressed: the readout below is bigger, live, and does not sit under
        // the finger. Note that leaving labelAngle unset would make the shared
        // renderer fall back to a joint-blind 180-interior, so the label is
        // turned off explicitly rather than starved of a value.
        showLabel: false,
      })

      // A wider ring on the point being dragged, so the finger knows what it has.
      if (dragging) {
        const p = toDisplay(working[dragging])
        ctx.beginPath()
        ctx.arc(p.x, p.y, 22, 0, Math.PI * 2)
        ctx.strokeStyle = MARKER_COLORS[dragging] ?? '#fff'
        ctx.lineWidth = 2
        ctx.setLineDash([4, 4])
        ctx.stroke()
        ctx.setLineDash([])
      }

      angleEl.textContent = angle === null ? '--°' : `${angle}°`
      updateLengths()
      drawLoupe()
    }

    const currentAngle = () =>
      recomputeAngle(working, {
        joint, width: img.width, height: img.height, calibrationOffset,
      })

    function updateLengths() {
      const now = segmentLengths(working, img.width, img.height)
      const was = segmentLengths(rawSet, img.width, img.height)
      if (!now || !was) { lenEl.textContent = ''; return }
      const pct = (a, b) => (b === 0 ? 0 : (a - b) / b)
      const p = pct(now.proximal, was.proximal)
      const d = pct(now.distal, was.distal)
      const fmt = (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`
      const loud = Math.abs(p) > LENGTH_CAUTION || Math.abs(d) > LENGTH_CAUTION
      lenEl.className = loud ? 'lm-lengths caution' : 'lm-lengths'
      // Kept short deliberately: the reserved block is two lines, and the
      // standing explanation below already says what the numbers mean, so
      // repeating it here only risks a third line and a moving image.
      lenEl.textContent = `Segment length ${fmt(p)} / ${fmt(d)} vs model`
        + (loud ? ' — check placement' : '')
    }

    function drawLoupe() {
      if (!dragging || !img) { loupe.style.display = 'none'; return }
      loupe.style.display = 'block'
      const { w, h } = cssSize()
      const p = toDisplay(working[dragging])

      // Sit on the opposite side from the point being dragged. A fixed corner
      // covers the very thing the clinician is trying to place as soon as they
      // work near it — which defeats the loupe's only purpose.
      const onRight = p.x > w * 0.5
      loupe.style.left  = onRight ? '12px' : 'auto'
      loupe.style.right = onRight ? 'auto' : '12px'
      // Source rect in IMAGE pixels, centred on the point.
      const sx = (p.x / w) * img.width
      const sy = (p.y / h) * img.height
      const half = LOUPE_SIZE / (2 * LOUPE_ZOOM) * (img.width / w)

      lctx.setTransform(1, 0, 0, 1, 0, 0)
      lctx.clearRect(0, 0, loupe.width, loupe.height)
      lctx.save()
      lctx.beginPath()
      lctx.arc(LOUPE_SIZE / 2, LOUPE_SIZE / 2, LOUPE_SIZE / 2 - 2, 0, Math.PI * 2)
      lctx.clip()
      lctx.drawImage(img, sx - half, sy - half, half * 2, half * 2, 0, 0, LOUPE_SIZE, LOUPE_SIZE)
      // Crosshair at the exact point being placed.
      lctx.strokeStyle = MARKER_COLORS[dragging] ?? '#fff'
      lctx.lineWidth = 1.5
      lctx.beginPath()
      // Proportional to the loupe, with a gap at the centre so the crosshair
      // marks the spot without covering the pixels being judged.
      const arm = LOUPE_SIZE / 11
      const gap = arm / 3
      const c = LOUPE_SIZE / 2
      lctx.moveTo(c - arm, c); lctx.lineTo(c - gap, c)
      lctx.moveTo(c + gap, c); lctx.lineTo(c + arm, c)
      lctx.moveTo(c, c - arm); lctx.lineTo(c, c - gap)
      lctx.moveTo(c, c + gap); lctx.lineTo(c, c + arm)
      lctx.stroke()
      lctx.restore()
      lctx.beginPath()
      lctx.arc(LOUPE_SIZE / 2, LOUPE_SIZE / 2, LOUPE_SIZE / 2 - 2, 0, Math.PI * 2)
      lctx.strokeStyle = 'rgba(255,255,255,0.6)'
      lctx.lineWidth = 2
      lctx.stroke()
    }

    // ── Pointer handling ─────────────────────────────────────────────
    const localPoint = (e) => {
      const r = canvas.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }

    function nearestRole(pt) {
      let best = null, bestD = Infinity
      for (const role of ROLES) {
        const p = toDisplay(working[role])
        const d = Math.hypot(p.x - pt.x, p.y - pt.y)
        if (d < bestD) { bestD = d; best = role }
      }
      return bestD <= HIT_RADIUS ? best : null
    }

    canvas.addEventListener('pointerdown', (e) => {
      const pt = localPoint(e)
      const role = nearestRole(pt)
      if (!role) return
      dragging = role
      canvas.setPointerCapture(e.pointerId)
      roleEl.textContent = roleLabel(joint, side, role)
      // Do NOT jump the point to the touch: the finger lands near, not on, and
      // snapping would move a landmark the clinician only meant to grab.
      draw()
      e.preventDefault()
    })

    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return
      const pt = localPoint(e)
      working[dragging] = { ...working[dragging], ...toNormalized(pt.x, pt.y) }
      draw()
      e.preventDefault()
    })

    const endDrag = (e) => {
      if (!dragging) return
      dragging = null
      roleEl.textContent = ''
      draw()
      if (e?.pointerId !== undefined && canvas.hasPointerCapture?.(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId)
      }
    }
    canvas.addEventListener('pointerup', endDrag)
    canvas.addEventListener('pointercancel', endDrag)

    window.addEventListener('resize', () => { if (img) { layout(); draw() } })

    // ── Controls ─────────────────────────────────────────────────────
    host.querySelector('#lm-cancel').addEventListener('click', () => close(null))

    host.querySelector('#lm-reset').addEventListener('click', () => {
      working = structuredClone(rawSet)
      draw()
    })

    host.querySelector('#lm-save').addEventListener('click', () => {
      const angle = currentAngle()
      if (angle === null) return close(null)
      close({ set: working, angle })
    })

    host.addEventListener('click', (e) => { if (e.target === host) close(null) })
  })
}

function template(joint, which) {
  const terms = motionTerms(joint)
  const end = which === 'peak' ? `peak ${terms.positive}` : 'minimum'
  return `
    <style>
      .lm-editor {
        position: fixed; inset: 0; z-index: 1100;
        background: rgba(0,0,0,0.82);
        /* Anchored to the TOP, not centred. A centred card is re-centred every
           time its content changes height, so the length advisory growing a
           line shifted the whole card — and the image with it — upward while a
           point was being dragged. Anchoring means growth extends downward
           into the controls instead, and the image never moves. */
        display: flex; align-items: flex-start; justify-content: center;
        padding: 12px;
        /* iOS Safari raises its own text-selection magnifier on a long press,
           and it lands directly over the frame being edited — a second lens
           showing the wrong thing. touch-action on the canvas stops scrolling
           and pinch-zoom but NOT this; only disabling the callout and selection
           does. Nothing in this modal needs to be selectable. */
        -webkit-touch-callout: none;
        -webkit-user-select: none;
        user-select: none;
      }
      .lm-card {
        background: #141414; border-radius: 14px; overflow: hidden;
        width: 100%; max-width: 620px; max-height: 100%;
        display: flex; flex-direction: column;
      }
      .lm-head { padding: 14px 16px 8px; }
      .lm-title { font-size: 1rem; font-weight: 600; color: #f5f5f5; }
      .lm-sub { font-size: 0.78rem; color: #9ca3af; margin-top: 4px; line-height: 1.4; }
      /* Hugs the canvas rather than absorbing leftover space. Absorbing is
         what let the image move: any change in the text below altered how much
         space was left over. Bounded by viewport height so the controls stay
         reachable on a short screen. */
      #lm-stage {
        position: relative; flex: 0 0 auto; max-height: 52vh;
        display: flex; align-items: center; justify-content: center;
        background: #000; padding: 6px;
      }
      #lm-canvas { touch-action: none; display: block; border-radius: 6px; }
      #lm-loupe {
        position: absolute; top: 12px; right: 12px;
        /* Side is set per-drag in drawLoupe(); this is only the initial corner. */
        width: ${LOUPE_SIZE}px; height: ${LOUPE_SIZE}px;
        border-radius: 50%; display: none; pointer-events: none;
      }
      .lm-readout {
        display: flex; align-items: baseline; gap: 10px;
        padding: 10px 16px 2px;
      }
      .lm-angle { font-size: 1.6rem; font-weight: 700; color: #4ade80; }
      .lm-role { font-size: 0.78rem; color: #93c5fd; }
      /* Two lines are reserved whether or not they are used, so the block does
         not change height as the reading changes. Combined with the pinned
         stage above, the image cannot move while a point is being placed. */
      .lm-lengths {
        font-size: 0.72rem; color: #9ca3af; padding: 0 16px 8px;
        line-height: 1.35; min-height: calc(2 * 1.35em + 8px);
      }
      .lm-lengths.caution { color: #facc15; }
      .lm-note { font-size: 0.68rem; color: #6b7280; padding: 0 16px 8px; line-height: 1.4; }
      .lm-actions { display: flex; gap: 8px; padding: 10px 16px 14px; }
      .lm-actions button {
        flex: 1; padding: 12px; border-radius: 9px; border: none;
        font-size: 0.9rem; font-weight: 600;
      }
      #lm-cancel { background: #262626; color: #d4d4d4; }
      #lm-reset  { background: #262626; color: #d4d4d4; }
      #lm-save   { background: #16a34a; color: #fff; }
    </style>
    <div class="lm-card">
      <div class="lm-head">
        <div class="lm-title">Verify landmarks — ${end}</div>
        <div class="lm-sub">
          Drag each point onto the joint centre you can see. This records an
          observation on this frame only; the recording itself is not changed.
        </div>
      </div>
      <div id="lm-stage">
        <canvas id="lm-canvas"></canvas>
        <canvas id="lm-loupe" width="${LOUPE_SIZE}" height="${LOUPE_SIZE}"></canvas>
      </div>
      <div class="lm-readout">
        <span class="lm-angle" id="lm-angle">--°</span>
        <span class="lm-role" id="lm-role"></span>
      </div>
      <div class="lm-lengths" id="lm-lengths"></div>
      <div class="lm-note">
        Segment lengths are a prompt to look again, not a rule — they are 2D
        projections and the proximal point is not a bone end.
      </div>
      <div class="lm-actions">
        <button id="lm-cancel">Cancel</button>
        <button id="lm-reset">Reset</button>
        <button id="lm-save">Save</button>
      </div>
    </div>
  `
}
