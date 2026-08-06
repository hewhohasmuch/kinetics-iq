# Face Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Blur the patient's head in the live camera preview and in the peak/min session snapshots, so stored images carry less identifying information.

**Architecture:** A new pure module computes a head circle from MediaPipe landmarks. `PoseDetector.detect()` returns it. `Overlay.draw()` blurs that circle into the overlay canvas *before* drawing dots and labels. Because `MeasureView._captureFrameTo()` already composites the overlay over the video frame, the snapshot inherits the redaction from the same code path that produces the live preview — the two cannot diverge.

**Tech Stack:** Vanilla JS (ES modules), MediaPipe Tasks Vision (BlazePose Full), Canvas 2D, Vitest (Node environment), Playwright for e2e, Supabase Postgres + Storage.

**Spec:** `docs/superpowers/specs/2026-08-05-face-blur-design.md`

**Branch:** `feat/face-blur-redaction` (already exists, spec already committed)

## Global Constraints

Every task's requirements implicitly include these. They come from the spec verbatim.

- **Never describe this feature as de-identification or anonymisation** — in code comments, UI copy, commit messages, or docs. It is **data minimisation and breach-severity reduction**. The images remain PHI because they stay linked to a named patient and a date of service.
- **No `visibility` threshold anywhere in the redaction path.** Blur on landmark *position* only. A confidence threshold silently no-ops in exactly the hard cases (backlit, prone face-down, occluded).
- **The redaction must be drawn fully opaque.** `globalAlpha` is set explicitly, never assumed. `overlay.js` helpers leave it dirty (0.85, 0.9, 0.8) and any residual transparency leaks the sharp face through, in the snapshot and the live view alike.
- **Degradation is blur → solid redaction, never blur → nothing.** Where `ctx.filter` is unsupported the code must branch *before* drawing, not draw an unfiltered copy.
- **The redaction is drawn before `Overlay.draw()`'s early return** at `overlay.js:129`. Losing joint landmarks mid-session must not un-blur the preview.
- **Constants are starting values**, to be tuned against the e2e fixture and on-device. They are biased to over-cover: over-blurring costs nothing because the head is never the joint being measured.
- **The `faceRedaction` stamp records what the device actually did**, not what was intended.
- Node 18+, no new runtime dependencies. `src/core/` stays DOM-free.

---

### Task 1: Head region geometry

The only non-trivial maths in the feature, and the only part that is pure. Everything downstream is wiring.

**Files:**
- Create: `src/core/headRegion.js`
- Test: `src/core/headRegion.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `headRegion(landmarksNorm, videoW, videoH) → { cx, cy, r } | null` — video pixel space. Used by Task 2.
  - `redactionGeometry(displayRegion) → { blurRadius, padding, x, y, size } | null` — display CSS pixel space, takes `{ cx, cy, r }`. Used by Task 3.
  - Constants `HEAD_RADIUS_FACTOR`, `TORSO_SCALE_COEFF`, `CRANIUM_NUDGE`, `MAX_RADIUS_FRACTION`, `BLUR_RADIUS_FACTOR`.

- [ ] **Step 1: Write the failing tests**

Create `src/core/headRegion.test.js`. The helper builds a normalised landmark array; only indices 0–12 matter.

```js
import { describe, it, expect } from 'vitest'
import { headRegion, redactionGeometry, MAX_RADIUS_FRACTION } from './headRegion.js'

const W = 720, H = 1280

/**
 * Build a normalised landmark array for a head centred at (hx, hy) with
 * half-width `hw` and half-height `hh` (all normalised 0–1), and shoulders
 * `shDrop` below it.
 *
 * Indices: 0 nose, 1-3 left eye, 4-6 right eye, 7-8 ears, 9-10 mouth,
 *          11-12 shoulders.
 */
function pose({ hx = 0.5, hy = 0.25, hw = 0.06, hh = 0.04, shDrop = 0.18 } = {}) {
  const lm = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }))
  const at = (i, x, y) => { lm[i] = { x, y, z: 0, visibility: 0.9 } }
  at(0,  hx,          hy)              // nose
  at(1,  hx - hw*0.3, hy - hh*0.4)     // left eye inner
  at(2,  hx - hw*0.5, hy - hh*0.4)     // left eye
  at(3,  hx - hw*0.7, hy - hh*0.4)     // left eye outer
  at(4,  hx + hw*0.3, hy - hh*0.4)     // right eye inner
  at(5,  hx + hw*0.5, hy - hh*0.4)     // right eye
  at(6,  hx + hw*0.7, hy - hh*0.4)     // right eye outer
  at(7,  hx - hw,     hy - hh*0.2)     // left ear
  at(8,  hx + hw,     hy - hh*0.2)     // right ear
  at(9,  hx - hw*0.4, hy + hh)         // mouth left
  at(10, hx + hw*0.4, hy + hh)         // mouth right
  at(11, hx - 0.10,   hy + shDrop)     // left shoulder
  at(12, hx + 0.10,   hy + shDrop)     // right shoulder
  return lm
}

/** Same subject rotated to profile: the face box collapses horizontally. */
function profilePose(opts = {}) {
  const lm = pose(opts)
  const hx = opts.hx ?? 0.5
  // Ears, eyes and nose stack up in x when side-on.
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    lm[i] = { ...lm[i], x: hx + (lm[i].x - hx) * 0.15 }
  }
  return lm
}

describe('headRegion', () => {
  it('covers the whole head, including above the topmost face landmark', () => {
    const reg = headRegion(pose(), W, H)
    expect(reg).not.toBeNull()

    // Topmost face landmark is the eye line; the cranium sits above it.
    const eyeY = (0.25 - 0.04 * 0.4) * H
    expect(reg.cy - reg.r).toBeLessThan(eyeY)

    // And the chin (mouth line) is still inside the circle.
    const mouthY = (0.25 + 0.04) * H
    expect(reg.cy + reg.r).toBeGreaterThan(mouthY)
  })

  it('centres above the face centroid, toward the cranium', () => {
    const reg = headRegion(pose(), W, H)
    const noseY = 0.25 * H
    expect(reg.cy).toBeLessThan(noseY)   // smaller y = further up the frame
  })

  it('does not collapse in profile — the failure the two estimators exist for', () => {
    const frontal = headRegion(pose(), W, H)
    const profile = headRegion(profilePose(), W, H)
    expect(profile).not.toBeNull()
    expect(profile.r).toBeGreaterThanOrEqual(0.8 * frontal.r)
  })

  it('pushes the centre away from the shoulders regardless of body rotation', () => {
    // Patient prone with the camera rotated: shoulders are to the RIGHT of the
    // head, so the cranium nudge must push LEFT, not up the screen.
    const lm = pose()
    for (const i of [11, 12]) lm[i] = { ...lm[i], x: 0.75, y: 0.25 }
    const reg = headRegion(lm, W, H)
    expect(reg.cx).toBeLessThan(0.5 * W)
  })

  it('returns null when the head is entirely off-frame', () => {
    expect(headRegion(pose({ hx: -1.5, hy: -1.5 }), W, H)).toBeNull()
  })

  it('returns a region when the head is only partly off-frame', () => {
    const reg = headRegion(pose({ hx: 0.02, hy: 0.03 }), W, H)
    expect(reg).not.toBeNull()
  })

  it('caps the radius so a garbage frame cannot blur the whole image', () => {
    const reg = headRegion(pose({ hw: 5, hh: 5, shDrop: 8 }), W, H)
    expect(reg.r).toBeLessThanOrEqual(MAX_RADIUS_FRACTION * Math.min(W, H))
  })

  it('returns null for missing or empty landmarks', () => {
    expect(headRegion(null, W, H)).toBeNull()
    expect(headRegion([], W, H)).toBeNull()
    expect(headRegion(pose(), 0, 0)).toBeNull()
  })
})

describe('redactionGeometry', () => {
  it('pads the source square by twice the blur radius', () => {
    const g = redactionGeometry({ cx: 200, cy: 300, r: 100 })
    expect(g.padding).toBeCloseTo(2 * g.blurRadius)
    expect(g.size).toBeCloseTo(2 * (100 + g.padding))
    expect(g.x).toBeCloseTo(200 - g.size / 2)
    expect(g.y).toBeCloseTo(300 - g.size / 2)
  })

  it('scales blur strength with head size, so a close-up is not under-blurred', () => {
    const near = redactionGeometry({ cx: 0, cy: 0, r: 200 })
    const far  = redactionGeometry({ cx: 0, cy: 0, r: 50 })
    expect(near.blurRadius).toBeGreaterThan(far.blurRadius * 3)
  })

  it('returns null for a missing or degenerate region', () => {
    expect(redactionGeometry(null)).toBeNull()
    expect(redactionGeometry({ cx: 1, cy: 1, r: 0 })).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/headRegion.test.js`
Expected: FAIL — `Failed to resolve import "./headRegion.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/core/headRegion.js`:

```js
/**
 * headRegion.js
 *
 * Locates the patient's head in a MediaPipe pose result so it can be blurred
 * out of the session snapshots.
 *
 * PURE GEOMETRY — no DOM, no canvas. Fully testable in Node.
 *
 * WHAT THIS IS FOR: data minimisation. Removing the face does NOT de-identify
 * the record — the images stay linked to a named patient and a date of service,
 * so they remain PHI. This reduces the severity of a leak, nothing more.
 *
 * WHY NOT A PADDED BOUNDING BOX of the face landmarks:
 *
 *   1. Landmarks 0–10 cover the FACE, not the skull. They span the eye line
 *      down to the mouth; the cranium and hair sit above the topmost one, so a
 *      tight box leaves the top of the head sharp.
 *   2. The box COLLAPSES IN PROFILE. Turned side-on — common for knee and hip
 *      work — the ears and nose stack up in x and the box badly under-estimates
 *      head size. The radius would shrink exactly where someone is still
 *      recognisable.
 *
 * So the scale comes from two independent estimators, whichever is larger:
 * the face-landmark span, and a torso-relative distance that is rotation-
 * invariant (a distance, not a projection) and therefore survives profile,
 * prone, supine and seated alike.
 *
 * NO VISIBILITY THRESHOLD IS APPLIED. Position only. A confidence threshold
 * silently no-ops in precisely the hard cases — backlit, face-down on a table,
 * occluded by a pillow — which is when a clinician most needs the guarantee to
 * hold. Over-blurring is free: the head is never the joint being measured.
 */

// Starting values, biased to over-cover. Tune against the e2e fixture and
// on-device; do not treat as derived truth.
export const HEAD_RADIUS_FACTOR  = 0.85  // radius as a multiple of the scale estimate
export const TORSO_SCALE_COEFF   = 0.70  // makes the torso estimate ≈ the face estimate frontally
export const CRANIUM_NUDGE       = 0.35  // centre offset along the shoulders→head axis, as a fraction of r
export const MAX_RADIUS_FRACTION = 0.50  // sanity cap against a garbage landmark frame
export const BLUR_RADIUS_FACTOR  = 0.35  // blur radius as a fraction of the display radius

const FACE_LANDMARKS  = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const LEFT_SHOULDER   = 11
const RIGHT_SHOULDER  = 12

/**
 * @param {Array<{x:number,y:number}>|null} landmarksNorm - MediaPipe normalised (0–1) landmarks
 * @param {number} videoW - intrinsic video width in pixels
 * @param {number} videoH - intrinsic video height in pixels
 * @returns {{cx:number, cy:number, r:number}|null} circle in VIDEO PIXEL space,
 *          or null when there is no head in the picture to redact
 */
export function headRegion(landmarksNorm, videoW, videoH) {
  if (!landmarksNorm || landmarksNorm.length <= RIGHT_SHOULDER) return null
  if (!videoW || !videoH) return null

  // Face landmarks → video pixel space, collecting centroid and bounding box.
  let sumX = 0, sumY = 0, count = 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const i of FACE_LANDMARKS) {
    const lm = landmarksNorm[i]
    if (!lm) continue
    const x = lm.x * videoW
    const y = lm.y * videoH
    sumX += x; sumY += y; count++
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (count === 0) return null

  const faceX = sumX / count
  const faceY = sumY / count
  const sFace = Math.hypot(maxX - minX, maxY - minY)

  // Torso-relative scale + the shoulders→head axis. Both are rotation-
  // invariant, which is what makes this work for a patient lying down with
  // the camera at any rotation.
  let sTorso = 0
  let upX = 0, upY = -1          // fallback: screen-up, if shoulders are absent
  const ls = landmarksNorm[LEFT_SHOULDER]
  const rs = landmarksNorm[RIGHT_SHOULDER]
  if (ls && rs) {
    const shX = ((ls.x + rs.x) / 2) * videoW
    const shY = ((ls.y + rs.y) / 2) * videoH
    const dx  = faceX - shX
    const dy  = faceY - shY
    const d   = Math.hypot(dx, dy)
    sTorso = TORSO_SCALE_COEFF * d
    if (d > 1e-6) { upX = dx / d; upY = dy / d }
  }

  const scale = Math.max(sFace, sTorso)
  if (!(scale > 0)) return null

  const maxR = MAX_RADIUS_FRACTION * Math.min(videoW, videoH)
  const r    = Math.min(HEAD_RADIUS_FACTOR * scale, maxR)

  const cx = faceX + upX * (CRANIUM_NUDGE * r)
  const cy = faceY + upY * (CRANIUM_NUDGE * r)

  // No head in the picture → nothing to redact.
  if (cx + r < 0 || cx - r > videoW || cy + r < 0 || cy - r > videoH) return null

  return { cx, cy, r }
}

/**
 * Derive the blur strength and the padded source square for a head circle
 * already mapped into DISPLAY CSS PIXEL space.
 *
 * A canvas blur() filter fades to transparent at the SOURCE IMAGE's edges.
 * Padding the source square by twice the blur radius puts that soft edge
 * outside the clip circle, so the circle comes out uniformly opaque and no
 * sharp face pixels leak around its rim.
 *
 * @param {{cx:number, cy:number, r:number}|null} displayRegion
 * @returns {{blurRadius:number, padding:number, x:number, y:number, size:number}|null}
 */
export function redactionGeometry(displayRegion) {
  if (!displayRegion || !(displayRegion.r > 0)) return null
  const { cx, cy, r } = displayRegion

  const blurRadius = Math.max(1, BLUR_RADIUS_FACTOR * r)
  const padding    = 2 * blurRadius
  const half       = r + padding

  return {
    blurRadius,
    padding,
    x:    cx - half,
    y:    cy - half,
    size: 2 * half,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/headRegion.test.js`
Expected: PASS, 11 tests.

If the profile test fails, `TORSO_SCALE_COEFF` is too low — that constant exists precisely to carry the estimate when the face box collapses. Raise it rather than weakening the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/core/headRegion.js src/core/headRegion.test.js
git commit -m "Add head-region geometry for snapshot redaction"
```

---

### Task 2: Expose the head region from the detector

**Files:**
- Modify: `src/detection/pose.js` (imports; `detect()` at lines 68–110)
- Test: `src/detection/pose.test.js`

**Interfaces:**
- Consumes: `headRegion()` from Task 1.
- Produces: `PoseDetector.detect()` return gains `head: {cx, cy, r} | null`. Used by Task 6.

`detect()` currently discards every landmark except the three joint roles. It keeps `lmNorm`, `vw` and `vh` locally, so this is a one-line computation plus the return field.

- [ ] **Step 1: Write the failing test**

Add to `src/detection/pose.test.js`, inside the existing `describe('PoseDetector', ...)` block so it picks up the `detector` from `beforeEach`. It reuses the file's existing `makeLandmarks()`, `makeVideoEl()` and `mockDetectForVideo` helpers.

Note `makeVideoEl()` defaults to **1280×720** (width×height), and `makeLandmarks()` places every un-overridden landmark at (0.5, 0.5) — so all eleven face landmarks must be overridden, or the centroid is dragged to the middle of the frame.

```js
  // Face clustered near the top of the frame, shoulders below it.
  const HEAD_POSE = {
    0:  { x: 0.50, y: 0.20 },                                            // nose
    1:  { x: 0.48, y: 0.19 }, 2:  { x: 0.47, y: 0.19 }, 3: { x: 0.46, y: 0.19 },
    4:  { x: 0.52, y: 0.19 }, 5:  { x: 0.53, y: 0.19 }, 6: { x: 0.54, y: 0.19 },
    7:  { x: 0.44, y: 0.20 }, 8:  { x: 0.56, y: 0.20 },                  // ears
    9:  { x: 0.48, y: 0.22 }, 10: { x: 0.52, y: 0.22 },                  // mouth
    11: { x: 0.40, y: 0.40 }, 12: { x: 0.60, y: 0.40 },                  // shoulders
  }

  it('returns a head region alongside the joint markers', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [makeLandmarks(HEAD_POSE)] })

    const result = detector.detect(makeVideoEl())

    expect(result.head).not.toBeNull()
    expect(result.head.r).toBeGreaterThan(0)
    // Centre is nudged up from the face centroid, toward the cranium.
    expect(result.head.cy).toBeLessThan(0.20 * 720)
  })

  it('returns head: null when no pose is detected', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [] })
    expect(detector.detect(makeVideoEl()).head).toBeNull()
  })

  it('returns head: null before init()', () => {
    expect(detector.detect(makeVideoEl()).head).toBeNull()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/detection/pose.test.js`
Expected: FAIL — `expected undefined not to be null`.

- [ ] **Step 3: Implement**

In `src/detection/pose.js`, add the import below the existing one:

```js
import { headRegion } from '../core/headRegion.js'
```

In `detect()`, both early returns gain `head: null`:

```js
    if (!this._ready || !videoElement) {
      return { markers: {}, allFound: false, foundIds: [], head: null }
    }

    const result = this._landmarker.detectForVideo(videoElement, performance.now())

    if (!result.landmarks || result.landmarks.length === 0) {
      return { markers: {}, allFound: false, foundIds: [], head: null }
    }
```

And the main return gains the computed region (place the call just after `vh` is assigned):

```js
    return {
      markers,
      allFound: allFound && Object.keys(markers).length === 3,
      foundIds: Object.keys(markers),
      // Head circle for snapshot redaction. Independent of the joint roles —
      // it is computed from the face/shoulder landmarks, not from JOINT_CONFIG,
      // so it is present even when the measured joint is not fully visible.
      head: headRegion(lmNorm, vw, vh),
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/detection/pose.test.js`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/detection/pose.js src/detection/pose.test.js
git commit -m "Return the head region from PoseDetector.detect()"
```

---

### Task 3: Draw the redaction into the overlay

**Files:**
- Modify: `src/detection/overlay.js` (constructor lines 38–47; `attach()` lines 49–52; `draw()` lines 124–183)
- Create: `src/detection/overlay.test.js`

**Interfaces:**
- Consumes: `redactionGeometry()` and `BLUR_RADIUS_FACTOR` from Task 1; the `head` object from Task 2.
- Produces:
  - `Overlay.draw(markers, interiorAngle, opts)` now honours `opts.head` and `opts.video`.
  - `Overlay.redactionMode` getter → `'blur1' | 'solid1'`. Used by Task 6.

**Test scope.** `overlay.js` has no test file today, though `src/detection/` does have test infrastructure (`pose.test.js`). The canvas drawing itself needs real pixels and is covered by the e2e assertion in Task 7 plus the on-device pass — a call-order mock would pass while the image still leaked. But the **blur-vs-solid fallback decision** is a load-bearing safety property (Global Constraint: *degradation is blur → solid, never blur → nothing*), it is pure logic, and it is testable in Node by stubbing `global.document` — the same pattern `calibration.test.js` uses for `global.localStorage`. So that branch gets a real test; the drawing does not.

- [ ] **Step 1: Add the import and the constructor state**

At the top of `src/detection/overlay.js`, below the existing constants:

```js
import { redactionGeometry } from '../core/headRegion.js'

const REDACTION_FILL = '#111827'   // opaque fallback where ctx.filter is unsupported
```

In the constructor, alongside the existing fields:

```js
    // Reused across frames — a fresh canvas per frame at 10Hz is needless GC churn.
    this._scratch          = null
    this._filterSupported  = false
```

- [ ] **Step 2: Feature-detect `ctx.filter` in `attach()`**

Safari only gained Canvas 2D `filter` support in Safari 17. Where it is unsupported, assigning `ctx.filter` silently leaves it `'none'` — so an unguarded implementation would draw a perfectly *sharp* copy of the face and look entirely deliberate. That is the worst possible failure for this feature, so it is detected explicitly.

```js
  attach(canvasElement) {
    this.canvas    = canvasElement
    this.ctx       = canvasElement.getContext('2d')
    this._filterSupported = this._detectFilterSupport()
  }

  /**
   * Canvas 2D filter support, probed rather than assumed. Where it is missing,
   * assigning ctx.filter is a silent no-op and a blur draw would emit a SHARP
   * face. The redaction degrades to an opaque fill instead — blur → solid,
   * never blur → nothing.
   */
  _detectFilterSupport() {
    try {
      const probe = document.createElement('canvas').getContext('2d')
      probe.filter = 'blur(2px)'
      return probe.filter === 'blur(2px)'
    } catch (_) {
      return false
    }
  }

  /** What this device actually does — stamped onto the session record. */
  get redactionMode() {
    return this._filterSupported ? 'blur1' : 'solid1'
  }
```

- [ ] **Step 3: Add the redaction drawing method**

Add alongside the other private drawing helpers:

```js
  /**
   * Blur the patient's head out of the frame.
   *
   * Drawn into the OVERLAY canvas, which is what makes the live preview and the
   * stored snapshot agree by construction: MeasureView._captureFrameTo()
   * composites this same canvas over the video frame, so both surfaces come
   * from this one code path and cannot drift apart.
   *
   * @param {{cx:number,cy:number,r:number}|null} head - VIDEO pixel space
   * @param {HTMLVideoElement|null} video
   */
  _drawRedaction(head, video) {
    if (!head || !video) return

    const ctx = this.ctx
    const display = {
      cx: head.cx * this._scale + this._offsetX,
      cy: head.cy * this._scale + this._offsetY,
      r:  head.r  * this._scale,
    }
    const g = redactionGeometry(display)
    if (!g) return

    ctx.save()
    // Set explicitly: the helpers in this file leave globalAlpha dirty, and a
    // translucent redaction leaks the sharp face straight through — in the
    // snapshot and the live view alike, since both sit over raw video pixels.
    ctx.globalAlpha = 1

    ctx.beginPath()
    ctx.arc(display.cx, display.cy, display.r, 0, Math.PI * 2)
    ctx.clip()

    if (this._filterSupported) {
      // Padded source square, back in video pixel space.
      const sx = (g.x - this._offsetX) / this._scale
      const sy = (g.y - this._offsetY) / this._scale
      const ss = g.size / this._scale

      const size    = Math.max(1, Math.ceil(g.size))
      const scratch = this._getScratch(size, size)
      const sctx    = scratch.getContext('2d')

      // Fill opaque BEFORE blitting. Where the head sits near a frame edge the
      // padded square runs off the video, leaving transparent scratch pixels —
      // blurring toward transparent inside the clip would let the video show
      // through. Blurring toward a solid colour cannot.
      sctx.fillStyle = REDACTION_FILL
      sctx.fillRect(0, 0, size, size)
      sctx.drawImage(video, sx, sy, ss, ss, 0, 0, size, size)

      ctx.filter = `blur(${g.blurRadius}px)`
      ctx.drawImage(scratch, g.x, g.y, g.size, g.size)
      ctx.filter = 'none'
    } else {
      ctx.fillStyle = REDACTION_FILL
      ctx.fillRect(g.x, g.y, g.size, g.size)
    }

    ctx.restore()
  }

  _getScratch(w, h) {
    if (!this._scratch) this._scratch = document.createElement('canvas')
    if (this._scratch.width !== w || this._scratch.height !== h) {
      this._scratch.width  = w
      this._scratch.height = h
    }
    return this._scratch
  }
```

- [ ] **Step 4: Call it from `draw()`, before the early return**

In `draw()`, immediately after `this.clear()` and **before** the `roles.length === 0` early return at line 129:

```js
  draw(markers, interiorAngle, opts = {}) {
    if (!this.ctx) return
    this.clear()

    // BEFORE the no-markers early return below. Losing the joint landmarks
    // mid-session — patient shifts, limb leaves frame — must not un-blur the
    // preview at exactly the moment the clinician looks at the screen to fix it.
    this._drawRedaction(opts.head ?? null, opts.video ?? null)

    const roles = Object.keys(markers)
    if (roles.length === 0) {
```

Everything else in `draw()` is unchanged. The redaction is drawn first, so the dots, bones, arc and angle label all land on top of it — which matters for shoulder measurements, where the joint dot sits close to the head.

Also extend the `draw()` JSDoc:

```js
 * @param {object}      opts
 * @param {string}      [opts.joint]      - joint name, for setup hints
 * @param {number|null} [opts.labelAngle] - clinical angle to print; must be the
 *                        same value the readout shows. Falls back to the hinge
 *                        convention when absent.
 * @param {object|null} [opts.head]  - head circle in video pixel space, to redact
 * @param {HTMLVideoElement|null} [opts.video] - source for the blurred patch
```

- [ ] **Step 5: Test the fallback decision**

Create `src/detection/overlay.test.js`. Tests run in Node with no DOM, so `document` is stubbed. The key case is the **silent no-op**: where Canvas 2D filters are unsupported, assigning `ctx.filter` leaves the property at `'none'` rather than throwing — which is exactly why this must be probed rather than assumed.

```js
import { describe, it, expect, afterEach } from 'vitest'
import { Overlay } from './overlay.js'

/**
 * Stub `document.createElement('canvas').getContext('2d')` with a context whose
 * `filter` setter either sticks or silently no-ops, mimicking a browser with
 * and without Canvas 2D filter support.
 */
function stubDocument({ filterSupported }) {
  global.document = {
    createElement: () => ({
      getContext: () => {
        const ctx = { _filter: 'none' }
        Object.defineProperty(ctx, 'filter', {
          get() { return this._filter },
          set(v) { if (filterSupported) this._filter = v },
        })
        return ctx
      },
    }),
  }
}

const fakeCanvas = { getContext: () => ({}) }

afterEach(() => { delete global.document })

describe('Overlay redaction mode', () => {
  it('reports blur1 where Canvas 2D filters are supported', () => {
    stubDocument({ filterSupported: true })
    const overlay = new Overlay()
    overlay.attach(fakeCanvas)
    expect(overlay.redactionMode).toBe('blur1')
  })

  it('falls back to solid1 when assigning ctx.filter silently no-ops', () => {
    // Safari before 17. The assignment does not throw — it just does nothing,
    // which is why an unguarded blur draw would emit a SHARP face.
    stubDocument({ filterSupported: false })
    const overlay = new Overlay()
    overlay.attach(fakeCanvas)
    expect(overlay.redactionMode).toBe('solid1')
  })

  it('falls back to solid1 when there is no DOM at all', () => {
    const overlay = new Overlay()
    overlay.attach(fakeCanvas)
    expect(overlay.redactionMode).toBe('solid1')
  })

  it('never reports a mode implying no redaction', () => {
    for (const filterSupported of [true, false]) {
      stubDocument({ filterSupported })
      const overlay = new Overlay()
      overlay.attach(fakeCanvas)
      expect(['blur1', 'solid1']).toContain(overlay.redactionMode)
    }
  })
})
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/detection/overlay.test.js`
Expected: PASS, 4 tests.

If `_detectFilterSupport()` throws rather than returning `false` when `document` is undefined, the third test catches it — the `try/catch` in Step 2 is what makes that case return `solid1` instead of exploding.

- [ ] **Step 7: Commit**

```bash
git add src/detection/overlay.js src/detection/overlay.test.js
git commit -m "Blur the head region into the overlay canvas"
```

---

### Task 4: Stamp the session record

**Files:**
- Modify: `src/core/session.js` (constructor lines 26–33; `setContext()` lines 42–46; `stop()` return lines 93–128)
- Test: `src/core/session.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `SessionRecorder.setContext(joint, side, position, faceRedaction)` — fourth parameter, defaults `null`. Sessions gain `faceRedaction: 'blur1' | 'solid1' | null`. Used by Tasks 5 and 6.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/session.test.js`:

```js
  it('stamps the face redaction mode the device actually used', () => {
    recorder.setContext('knee', 'right', 'prone', 'blur1')
    recorder.start()
    recorder.record(10); recorder.record(20); recorder.record(30)
    expect(recorder.stop().faceRedaction).toBe('blur1')
  })

  it('records the solid fallback rather than claiming a blur', () => {
    recorder.setContext('knee', 'right', 'prone', 'solid1')
    recorder.start()
    recorder.record(10); recorder.record(20); recorder.record(30)
    expect(recorder.stop().faceRedaction).toBe('solid1')
  })

  it('leaves faceRedaction null when no mode was supplied', () => {
    recorder.setContext('knee', 'right', 'prone')
    recorder.start()
    recorder.record(10); recorder.record(20); recorder.record(30)
    expect(recorder.stop().faceRedaction).toBeNull()
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/session.test.js`
Expected: FAIL — `expected undefined to be 'blur1'`.

- [ ] **Step 3: Implement**

Constructor — add alongside `this._position`:

```js
    this._faceRedaction = null
```

`setContext()` — add the fourth parameter and a note on what the stamp means:

```js
  // Set the joint, side, position and face-redaction mode before start() so they
  // appear in the saved session.
  //
  // An absent position stays null rather than defaulting to 'prone'. That default
  // is what stamped "Prone" onto standing shoulder measurements: the UI hid the
  // position row for joints it considered position-less, but the recorder filled
  // one in anyway and it was written to the patient record. A position nobody
  // chose is not data — the views already omit the badge when it is null.
  //
  // faceRedaction is what the DEVICE ACTUALLY DID ('blur1', or 'solid1' where
  // Canvas 2D filters were unavailable), not what was intended — so a device
  // that fell back is legible in the record instead of misfiled as blurred.
  setContext(joint, side, position, faceRedaction = null) {
    this._joint         = joint
    this._side          = side
    this._position      = position ?? null
    this._faceRedaction = faceRedaction ?? null
  }
```

`stop()` return — add after `angleConvention`:

```js
      angleConvention: 'perjoint1',
      // Head-redaction generation applied to this session's snapshots. Absent
      // (or null) means the images were captured with the face visible.
      //
      // This asserts that THE REDACTION PIPELINE WAS ACTIVE for the session. It
      // does NOT assert a face was blurred in every frame — where the head is
      // out of shot there is nothing to blur. It is also NOT de-identification:
      // the images stay linked to a named patient and a date of service, so they
      // remain PHI. It reduces the severity of a leak, nothing more.
      faceRedaction: this._faceRedaction,
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/core/session.test.js`
Expected: PASS, including the pre-existing `setContext` tests (the new parameter is optional, so the two-argument call at line 82 still works).

- [ ] **Step 5: Commit**

```bash
git add src/core/session.js src/core/session.test.js
git commit -m "Stamp the face-redaction mode onto saved sessions"
```

---

### Task 5: Sync the stamp to the cloud

**Files:**
- Modify: `src/core/sync.js` (`sessionToRow` lines 225–245; `rowToSession` lines 247–269)
- Modify: `supabase/schema.sql` (sessions table, near `angle_mode` at line 38)
- Create: `supabase/migrations/0002_face_redaction.sql`
- Test: `src/core/sync.test.js`

**Interfaces:**
- Consumes: `faceRedaction` on sessions, from Task 4.
- Produces: `face_redaction` column round-trips through both mappers.

The stamp must survive a cloud round-trip. `rowToSession()` rebuilds the local session object wholesale during a pull merge, so a field the mappers don't know about is **erased** from a session that syncs down — which for a privacy claim is unacceptable.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/sync.test.js`, following the existing `sessionToRow`/`rowToSession` test style:

```js
  it('pushes the face-redaction stamp', () => {
    const row = sessionToRow({ ...makeSession(), faceRedaction: 'blur1' })
    expect(row.face_redaction).toBe('blur1')
  })

  it('pushes null when a session predates redaction', () => {
    const row = sessionToRow(makeSession())
    expect(row.face_redaction).toBeNull()
  })

  it('round-trips the stamp so a pull cannot erase it', () => {
    const original = { ...makeSession(), faceRedaction: 'solid1' }
    const back     = rowToSession(sessionToRow(original))
    expect(back.faceRedaction).toBe('solid1')
  })
```

`makeSession(overrides = {})` is the existing fixture factory at `src/core/sync.test.js:65`; it does not set `faceRedaction`, so the second test exercises the absent case as written.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/sync.test.js`
Expected: FAIL — `expected undefined to be 'blur1'`.

- [ ] **Step 3: Implement the mappers**

In `sessionToRow`, after `angle_mode`:

```js
    angle_mode:     s.angleMode ?? null,
    face_redaction: s.faceRedaction ?? null,
```

In `rowToSession`, after `angleMode`:

```js
    angleMode:     row.angle_mode ?? undefined,
    faceRedaction: row.face_redaction ?? null,
```

- [ ] **Step 4: Add the column to the schema**

In `supabase/schema.sql`, in the sessions table beside `angle_mode text,`:

```sql
  angle_mode      text,
  face_redaction  text,
```

- [ ] **Step 5: Write the migration**

Create `supabase/migrations/0002_face_redaction.sql`, following the `0001` house style:

```sql
-- Migration: face-redaction stamp on sessions
--
-- Apply to an EXISTING KineticsIQ project (tables already created from
-- schema.sql). Idempotent — safe to run more than once. Paste into the
-- Supabase SQL editor and Run. New projects can just apply schema.sql, which
-- already includes everything below.
--
-- What it does:
--   Adds face_redaction to sessions: which head-redaction generation was
--   applied to that session's snapshots ('blur1', 'solid1'), or NULL for
--   sessions captured with the face visible.
--
-- NOTE: this stamp is not a de-identification claim. Snapshots stay linked to
-- a named patient and a date of service, so they remain PHI regardless.

alter table public.sessions add column if not exists face_redaction text;
```

- [ ] **Step 6: Run to verify the tests pass**

Run: `npx vitest run src/core/sync.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/sync.js src/core/sync.test.js supabase/schema.sql supabase/migrations/0002_face_redaction.sql
git commit -m "Sync the face-redaction stamp"
```

---

### Task 6: Wire it into the app

**Files:**
- Modify: `src/ui/MeasureView.js` (`setContext` call at line 832; `_runDetection()` detect destructure at line 961; `overlay.draw()` at lines 1013–1016)
- Modify: `src/ui/SessionDetailView.js` (`_renderFrames()` lines 106–146; inline `<style>` block near line 533)

**Interfaces:**
- Consumes: `head` from Task 2; `Overlay.redactionMode` from Task 3; `setContext(..., faceRedaction)` from Task 4.
- Produces: the working feature.

- [ ] **Step 1: Pass the head region into the overlay**

In `_runDetection()`, extend the destructure at line 961:

```js
    const { markers, allFound, head } = this.detector.detect(videoEl)
```

And extend the `overlay.draw()` options at line 1013:

```js
    this.overlay.draw(markers, toInteriorAngle(displayAngle, this._joint), {
      joint:      this._joint,
      labelAngle: displayAngle,
      // Head redaction is drawn into the overlay, so the snapshot composited
      // below inherits it from this same call — one code path, both surfaces.
      head,
      video:      videoEl,
    })
```

Nothing else in `_runDetection()` moves. The snapshot capture at lines 1023–1034 already runs after `overlay.draw()`, which is what makes the stored frame carry the redaction.

- [ ] **Step 2: Stamp the recorder with what the device actually does**

At line 832:

```js
    this.recorder.setContext(this._joint, this._side, this._position, this.overlay.redactionMode)
```

- [ ] **Step 3: Show the redaction state in SessionDetail**

At the end of `_renderFrames()` in `src/ui/SessionDetailView.js`, replacing the final two lines:

```js
    if (shown === 1) framesEl.querySelector('.rom-frames').classList.add('single')
    if (shown > 0) {
      framesEl.style.display = 'block'
      this._renderRedactionNote(framesEl, s)
    }
  }

  /**
   * State the redaction status of the frames above. Worth saying explicitly
   * because the answer differs between sessions: anything captured before this
   * feature shipped has the patient's face visible, and nothing in the image
   * itself makes that obvious at a glance.
   *
   * Deliberately not worded as anonymisation — the images stay linked to a
   * named patient, so they remain PHI either way.
   */
  _renderRedactionNote(framesEl, s) {
    let note = framesEl.querySelector('.frame-redaction-note')
    if (!note) {
      note = document.createElement('div')
      note.className = 'frame-redaction-note'
      framesEl.appendChild(note)
    }
    note.textContent = s.faceRedaction
      ? 'Face blurred at capture'
      : 'Face not blurred — captured before redaction was added'
    note.classList.toggle('unredacted', !s.faceRedaction)
  }
```

- [ ] **Step 4: Style the note**

In the inline `<style>` block in `SessionDetailView.js`, beside `.peak-frame-caption` (around line 533):

```css
        .frame-redaction-note {
          margin-top: 8px;
          font-size: 12px;
          opacity: 0.6;
          text-align: center;
        }
        .frame-redaction-note.unredacted {
          opacity: 0.85;
          color: #facc15;
        }
```

`#facc15` is the amber already used elsewhere in this app for advisory text.

- [ ] **Step 5: Run the full unit suite**

Run: `npm test`
Expected: PASS. No UI unit tests exist, so this only confirms nothing upstream regressed.

- [ ] **Step 6: Commit**

```bash
git add src/ui/MeasureView.js src/ui/SessionDetailView.js
git commit -m "Redact the head in the preview and the saved snapshots"
```

---

### Task 7: End-to-end check and documentation

**Files:**
- Modify: `scripts/e2e/verify.mjs` (after the IndexedDB blob assertions at lines 197–220)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing further.

- [ ] **Step 1: Add the smoothness assertion to the e2e harness**

Insert after the blob-presence loop that ends at line 220. The imageStore record shape is `{ key, sessionId, which, blob, uploaded, capturedAt, bytes }`.

```js
    // Redaction smoke test. A blurred head leaves one distinctly smooth patch in
    // an otherwise detailed photo, so grid the snapshot and compare the smoothest
    // cell against the median cell. This catches the whole class of silent
    // failures in one check — unsupported ctx.filter, an alpha leak, redaction
    // drawn in the wrong order, a region computed somewhere daft.
    //
    // It is a SMOKE TEST, not proof: a large flat background would also read as
    // smooth. The geometry itself is pinned by src/core/headRegion.test.js, and
    // the screenshot below is still checked by eye.
    const smooth = await page.evaluate(async (sid) => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('kinetics_images', 1)
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
      })
      const all = await new Promise((res, rej) => {
        const req = db.transaction('images', 'readonly').objectStore('images').getAll()
        req.onsuccess = () => res(req.result || []); req.onerror = () => rej(req.error)
      })
      const rec = all.find((r) => r.sessionId === sid && r.which === 'peak')
      if (!rec || !rec.blob) return null

      const bmp = await createImageBitmap(rec.blob)
      const cv  = document.createElement('canvas')
      cv.width = bmp.width; cv.height = bmp.height
      const cx = cv.getContext('2d')
      cx.drawImage(bmp, 0, 0)
      const { data } = cx.getImageData(0, 0, cv.width, cv.height)

      // High-frequency energy per grid cell: mean absolute difference between
      // horizontally adjacent pixels (red channel is enough).
      const N = 12
      const cw = Math.floor(cv.width / N)
      const ch = Math.floor(cv.height / N)
      if (cw < 2 || ch < 2) return null

      const cells = []
      for (let gy = 0; gy < N; gy++) {
        for (let gx = 0; gx < N; gx++) {
          let sum = 0, n = 0
          for (let y = gy * ch; y < (gy + 1) * ch; y++) {
            for (let x = gx * cw; x < (gx + 1) * cw - 1; x++) {
              const i = (y * cv.width + x) * 4
              sum += Math.abs(data[i] - data[i + 4])
              n++
            }
          }
          cells.push(n ? sum / n : 0)
        }
      }
      cells.sort((a, b) => a - b)
      return { min: cells[0], median: cells[Math.floor(cells.length / 2)] }
    }, s.id)

    if (!smooth) {
      fail('could not read the peak snapshot back for redaction check')
    } else if (smooth.median > 0 && smooth.min < 0.25 * smooth.median) {
      pass(`snapshot contains a smooth region (min ${smooth.min.toFixed(1)} vs median ${smooth.median.toFixed(1)})`)
    } else {
      fail(`no blurred region found — min cell ${smooth.min.toFixed(1)}, median ${smooth.median.toFixed(1)}`)
    }

    // Redaction mode reached the record.
    if (s.faceRedaction === 'blur1' || s.faceRedaction === 'solid1')
      pass(`session stamped faceRedaction=${s.faceRedaction}`)
    else fail(`session faceRedaction is ${JSON.stringify(s.faceRedaction)}`)
```

- [ ] **Step 2: Extend the eyeball prompt**

At line 231, replace the single `info(...)` call:

```js
    info('check by eye: the angle burned into each frame should match its caption')
    info('check by eye: the head is blurred in both frames, fully covered, no sharp rim')
```

- [ ] **Step 3: Run the e2e harness**

Run: `npm run verify:e2e`
Expected: PASS, with the two new checks. Takes a few minutes.

The fixture photo drives a real BlazePose detection, so if the smooth-region check fails, open the screenshot it writes and look at where the blur actually landed before touching the assertion. Constants live in `src/core/headRegion.js`.

- [ ] **Step 4: Document it in CLAUDE.md**

In the **Signal processing pipeline** section, after the "Snapshot encoding & storage" paragraph, add:

```markdown
**Face redaction.** The patient's head is blurred out of the live preview and both
snapshots. `headRegion()` (`src/core/headRegion.js`, pure) returns a head circle from
the face and shoulder landmarks; `PoseDetector.detect()` returns it as `head`; and
`Overlay.draw()` blurs it into the overlay canvas **before** the landmark dots and
before its own no-markers early return. Because `_captureFrameTo()` composites that
same overlay, the stored JPEG inherits the redaction from the code path that draws the
preview — do not add a second blur at capture or encode time, or the two can disagree.

Three constraints that are load-bearing: the region is computed from landmark
**position with no visibility threshold** (a confidence gate no-ops in exactly the hard
cases — backlit, prone face-down); the redaction is drawn **fully opaque** (the helpers
in `overlay.js` leave `globalAlpha` dirty, and any transparency leaks the sharp face);
and where Canvas 2D `filter` is unsupported it degrades to an **opaque fill**, never to
nothing. The scale comes from `max(face-landmark span, torso-relative distance)` — the
second estimator exists because the face bounding box collapses in profile, which is a
common knee/hip framing.

`faceRedaction` on the session records what the device actually did (`'blur1'`, or
`'solid1'` for the fill fallback). It asserts the **pipeline was active**, not that a
face was blurred in every frame — when the head is out of shot there is nothing to
blur. **It is not de-identification:** snapshots stay linked to a named patient and a
date of service, so they remain PHI. This is data minimisation, which reduces the
severity of a leak. Sessions without the field were captured with the face visible.
```

In the **Persistence** section, add `faceRedaction` to the sentence listing session fields, alongside `angleMode` / `angleFilter` / `angleConvention`.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e/verify.mjs CLAUDE.md
git commit -m "Verify and document the face redaction"
```

---

## On-device verification

CLAUDE.md is explicit that `_runDetection()` wiring is verified by running the app, not by reasoning about the diff. Headless Chromium runs BlazePose at ~2Hz rather than the app's 10Hz, so the e2e harness cannot speak to frame-rate-sensitive behaviour.

Before opening the PR, check on an iPhone:

1. The blur tracks the head through a full sweep, at both ends of the range.
2. It holds up in **profile** — the framing where the face bounding box collapses.
3. It holds up **prone**, with the head turned to one side.
4. Frame rate has not dropped. The extra work is one blit plus one filtered draw per frame; if the readout feels laggier than before, that is the cause.
5. Both saved snapshots in SessionDetail show a fully covered head with no sharp rim.

Tune the constants in `src/core/headRegion.js` from what you see, then re-run `npm test` and `npm run verify:e2e`.

## Notes for the implementer

- **Accepted limitation, by design:** when MediaPipe detects no pose at all, `detect()` returns before any landmarks exist, so `head` is `null` and the live preview stays sharp. This is tolerable because snapshot capture requires `allFound` **and** an active recording (`MeasureView.js:1023`), so nothing un-redacted can reach storage in that state. It is a preview-only gap — do not "fix" it by capturing snapshots more eagerly.
- **Pre-existing gap, deliberately not fixed here:** `angleFilter` and `angleConvention` are stamped onto sessions but mapped in *neither* `sessionToRow` nor `rowToSession`, so a session that round-trips through the cloud loses them. Task 5 maps `face_redaction` in both directions specifically so this feature does not inherit that bug. Fixing the other two is a separate change.
- **Out of scope** (from the spec): retroactively redacting existing snapshots, bulk deletion of existing snapshots, redacting anything other than the head, and HIPAA compliance controls generally.
