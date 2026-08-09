# Head Occluder Implementation Plan

> **STATUS: REVERTED — NOT IN THE PRODUCT (2026-08-08).**
> Head redaction was removed from KineticsIQ. The blur shipped in PR #15 measured, on
> device, as displaced by about one head radius with its contents still legible; the
> opaque occluder that replaced it (PR #16, closed unmerged) needed a seed large enough
> to cover the acromion in shoulder framing, and two independent parameter sweeps showed
> **no centred symmetric ellipse can contain wind-blown hair while clearing the shoulder**
> — the ceiling is q ≈ 1.03 against a `FEATHER_EXTENT` of 1.35, and even a degenerate
> collapsed seed reaches only 1.337.
>
> Kept as a record of what was tried and why it was abandoned, so the reasoning does not
> have to be rediscovered. **Do not read it as describing current behaviour.** Anyone
> revisiting head redaction should start from those findings: a real fix needs an
> asymmetric shape (more reach toward the cranium than toward the joint) or a per-joint
> seed. The HIPAA analysis in the 2026-08-05 spec stands regardless of mechanism — this
> was always data minimisation, never de-identification.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the failed snapshot face blur with an opaque, motion-aware head occluder that cannot misregister and cannot silently weaken.

**Architecture:** `headRegion()` (pure, `src/core/`) returns an oriented ellipse instead of a circle and grows it until every face landmark is provably contained. `pose.js` holds the previous region and expands the current one by inter-frame head displacement, absorbing the ~150 ms of detection latency that made the blur trail the head. `overlay.js` draws an opaque ellipse with a feathered rim and a thin outline, filled with a single colour averaged from outside the shape — no patch is sampled and no Canvas 2D `filter` is used, which deletes both failure classes by construction.

**Tech Stack:** Vanilla JS (ES modules), Vite, Vitest (Node environment), Playwright for the e2e harness, MediaPipe Tasks Vision (BlazePose Full).

**Spec:** `docs/superpowers/specs/2026-08-08-head-occluder-design.md`

**Branch:** `feat/head-occluder` already exists with the spec committed. Work on it directly.

## Global Constraints

- **Do not reintroduce a display-only filter on the angle.** The value reaching the readout, the overlay label, the snapshots and `SessionRecorder` is one number. Stabilise rendering, never the value.
- **Angles are signed.** Never clamp at 0 — extension is the measurement.
- **`src/core/` stays DOM-free** except `calibration.js` / `storage.js` (localStorage) and `sync.js` (network). `headRegion.js` must remain pure geometry, testable in Node.
- **Containment is an invariant, not a hope.** Every one of the eleven face landmarks (indices 0–10) must lie inside the returned shape.
- **`MAX_RADIUS_FRACTION` is applied last and wins.** Containment holds only while the shape is uncapped. Do not reorder.
- **No visibility threshold in `headRegion()`.** Position only. A confidence gate no-ops in exactly the hard cases (backlit, prone face-down) where the guarantee matters most.
- **The occluder core must be fully opaque.** All feathering happens strictly outside the containment radius.
- **This is not de-identification.** No comment, UI string, or commit message may describe it as anonymisation or de-identification. It is data minimisation.
- **No angle-pipeline changes.** `CALIBRATION_VERSION`, `angleConvention`, `angleFilter` all stay exactly as they are.
- Run `npm test` from `C:\Projects\kinetics-iq`. Single file: `npx vitest run src/core/angle.test.js`.

---

### Task 1: Oriented-ellipse head region with elliptical containment

**Files:**
- Modify: `src/core/headRegion.js` — `headRegion()` return shape, containment maths, constants
- Test: `src/core/headRegion.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `headRegion(landmarksNorm, videoW, videoH) → {cx, cy, rAcross, rAlong, ux, uy} | null` — video pixel space. `ux, uy` is the unit shoulders→head axis; `rAlong` is the semi-axis along it, `rAcross` the semi-axis perpendicular to it.
  - New exported constants `ELLIPSE_ACROSS = 0.92`, `ELLIPSE_ALONG = 1.14`.
  - `headInputsFinite()` and `anyFaceLandmarkInFrame()` are **unchanged** — do not touch them.

- [ ] **Step 1: Write the failing tests**

Replace the whole `describe('headRegion — face landmark coverage', ...)` block's helper and add the shape assertions. In `src/core/headRegion.test.js`, add this helper below the existing `proneRotatedPose` definition:

```js
/**
 * Elliptical containment metric. Returns q for a landmark: q <= 1 means the
 * point is inside the ellipse, q = 0 is dead centre. This is the elliptical
 * analogue of `dist / r` in the circle version.
 */
function ellipseQ(reg, xPx, yPx) {
  const dx = xPx - reg.cx
  const dy = yPx - reg.cy
  const px = -reg.uy, py = reg.ux              // perpendicular to the head axis
  const across = dx * px + dy * py
  const along  = dx * reg.ux + dy * reg.uy
  return Math.hypot(across / reg.rAcross, along / reg.rAlong)
}

/** Axis-aligned half-extents of the oriented ellipse, for off-frame tests. */
function halfExtents(reg) {
  return {
    hx: Math.hypot(reg.rAcross * reg.uy, reg.rAlong * reg.ux),
    hy: Math.hypot(reg.rAcross * reg.ux, reg.rAlong * reg.uy),
  }
}
```

Now add a new `describe` block at the end of the file:

```js
describe('headRegion — oriented ellipse', () => {
  const FACE_IDX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  it('returns semi-axes and a unit head axis instead of a single radius', () => {
    const reg = headRegion(pose(), W, H)
    expect(reg.rAcross).toBeGreaterThan(0)
    expect(reg.rAlong).toBeGreaterThan(0)
    expect(reg.r).toBeUndefined()
    expect(Math.hypot(reg.ux, reg.uy)).toBeCloseTo(1, 6)
  })

  it('is longer along the head axis than across it', () => {
    // A head is taller than it is wide. Scaling both axes by the SAME
    // containment factor is what preserves this; a mutant that grows them
    // independently flattens the ellipse in profile — the exact
    // under-estimate the circle version existed to avoid.
    const reg = headRegion(pose(), W, H)
    expect(reg.rAlong).toBeGreaterThan(reg.rAcross)
    expect(reg.rAlong / reg.rAcross).toBeCloseTo(ELLIPSE_ALONG / ELLIPSE_ACROSS, 6)
  })

  it('points the head axis away from the shoulders, whatever the body rotation', () => {
    const lm = pose()
    for (const i of [11, 12]) lm[i] = { ...lm[i], x: 0.75, y: 0.25 }
    const reg = headRegion(lm, W, H)
    expect(reg.ux).toBeLessThan(-0.9)       // shoulders right → axis points left
    expect(Math.abs(reg.uy)).toBeLessThan(0.2)
  })

  it('contains every face landmark for frontal, profile, close profile and prone', () => {
    const fixtures = {
      frontal:        pose(),
      profile:        profilePose(),
      'close profile': profilePose({ shDrop: 0.10 }),
      prone:          proneRotatedPose(),
    }
    for (const [label, lm] of Object.entries(fixtures)) {
      const reg = headRegion(lm, W, H)
      expect(reg, `${label}: null region`).not.toBeNull()
      for (const i of FACE_IDX) {
        const q = ellipseQ(reg, lm[i].x * W, lm[i].y * H)
        expect(q, `${label}: landmark ${i} q=${q.toFixed(3)}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('leaves the guaranteed slack the coverage margin promises', () => {
    // Containment grows the ellipse by t * COVERAGE_MARGIN, so the worst
    // landmark ends at q = 1 / COVERAGE_MARGIN. Where the heuristic floor
    // wins outright the worst q is smaller still. Either way this bound holds
    // while the shape is uncapped.
    for (const lm of [pose(), profilePose(), profilePose({ shDrop: 0.10 }), proneRotatedPose()]) {
      const reg = headRegion(lm, W, H)
      const worst = Math.max(...FACE_IDX.map((i) => ellipseQ(reg, lm[i].x * W, lm[i].y * H)))
      expect(worst).toBeLessThanOrEqual(1 / COVERAGE_MARGIN + 1e-9)
    }
  })

  it('does not inflate a region the heuristic already covers', () => {
    // THE MUTANT THIS KILLS: writing the growth factor as
    // `max(1, t) * COVERAGE_MARGIN` instead of `max(1, t * COVERAGE_MARGIN)`.
    // That multiplies EVERY region by 1.60 even when containment is inert,
    // which no containment assertion above would ever catch — every landmark
    // is still inside, just inside a needlessly huge ellipse.
    //
    // The heuristic is recomputed here from the same inputs rather than
    // hardcoded, so this stays a statement about the FORMULA and cannot be
    // silenced by editing a number to match whatever the code now produces.
    const lm = pose()
    const idx = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const xs = idx.map((i) => lm[i].x * W)
    const ys = idx.map((i) => lm[i].y * H)
    const fx = xs.reduce((a, b) => a + b, 0) / xs.length
    const fy = ys.reduce((a, b) => a + b, 0) / ys.length
    const shX = ((lm[11].x + lm[12].x) / 2) * W
    const shY = ((lm[11].y + lm[12].y) / 2) * H
    const sTorso = TORSO_SCALE_COEFF * Math.hypot(fx - shX, fy - shY)
    const sFace  = Math.hypot(Math.max(...xs) - Math.min(...xs),
                              Math.max(...ys) - Math.min(...ys))
    const rHeuristic = HEAD_RADIUS_FACTOR * Math.max(sFace, sTorso)

    // At this framing containment is inert, so the seed must survive untouched.
    const reg = headRegion(lm, W, H)
    expect(reg.rAcross).toBeCloseTo(ELLIPSE_ACROSS * rHeuristic, 6)
    expect(reg.rAlong).toBeCloseTo(ELLIPSE_ALONG * rHeuristic, 6)
  })

  it('caps both semi-axes, and the cap overrides containment', () => {
    const lm  = pose({ hw: 5, hh: 5, shDrop: 8 })
    const reg = headRegion(lm, W, H)
    const cap = MAX_RADIUS_FRACTION * Math.min(W, H)
    expect(reg.rAcross).toBeLessThanOrEqual(cap)
    expect(reg.rAlong).toBeLessThanOrEqual(cap)
    const outside = FACE_IDX.some((i) => ellipseQ(reg, lm[i].x * W, lm[i].y * H) > 1)
    expect(outside).toBe(true)
  })

  it('keeps the heuristic as a floor when the face landmarks give no spread', () => {
    // Guards the heuristic's remaining job. MediaPipe can collapse the face
    // landmarks onto a point (heavy occlusion, subject far from camera);
    // containment alone would then draw an ellipse around nothing.
    const lm = pose()
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      lm[i] = { x: 0.5, y: 0.25, z: 0, visibility: 0.9 }
    }
    const reg = headRegion(lm, W, H)
    expect(reg.rAcross).toBeGreaterThan(100)
  })

  it('rejects a head whose ellipse lies entirely off-frame', () => {
    expect(headRegion(pose({ hx: -1.5, hy: -1.5 }), W, H)).toBeNull()
  })

  it('keeps a head that is only partly off-frame', () => {
    const reg = headRegion(pose({ hx: 0.02, hy: 0.03 }), W, H)
    expect(reg).not.toBeNull()
    const { hx } = halfExtents(reg)
    expect(reg.cx + hx).toBeGreaterThan(0)
  })
})
```

Update the import at the top of the file to pull in the new constants:

```js
import {
  headRegion, occluderGeometry, expandForMotion,
  headInputsFinite, anyFaceLandmarkInFrame,
  MAX_RADIUS_FRACTION, COVERAGE_MARGIN, ELLIPSE_ACROSS, ELLIPSE_ALONG,
  HEAD_RADIUS_FACTOR, TORSO_SCALE_COEFF,
} from './headRegion.js'
```

Then **delete** these now-obsolete tests, which assert the circle shape (`reg.r`) and are wholly superseded by the block above:
- `'covers the whole head, including above the topmost face landmark'`
- `'keeps sFace load-bearing: close framing, ...'`
- `'keeps sTorso load-bearing: does not collapse in profile'`
- `'returns null when the head is entirely off-frame'`
- `'returns a region when the head is only partly off-frame'`
- `'caps the radius so a garbage frame cannot blur the whole image'`
- `'lets the cap OVERRIDE containment — the one documented exception'`
- the entire `describe('headRegion — face landmark coverage', ...)` block
- the entire `describe('redactionGeometry', ...)` block (replaced in Task 3)

**Keep** `'centres above the face centroid, toward the cranium'`, `'pushes the centre away from the shoulders regardless of body rotation'`, `'returns null for missing or empty landmarks'`, `'returns null when landmark coordinates are NaN'`, and the whole `headInputsFinite` and `anyFaceLandmarkInFrame` blocks unchanged.

Re-add the two estimator mutation guards in elliptical form, since they catch mutations nothing else does:

```js
describe('headRegion — scale estimators stay load-bearing', () => {
  it('keeps sFace load-bearing at close framing', () => {
    // shDrop=0.04 puts the shoulders almost at the chin, so sTorso is far too
    // short to set the scale and only the face span can.
    // MUTATION (force scale = sTorso): the ellipse collapses onto the face
    // landmarks themselves and stops covering the cranium.
    const reg = headRegion(pose({ shDrop: 0.04 }), W, H)
    expect(reg.rAcross).toBeGreaterThan(80)
    const eyeY = (0.25 - 0.04 * 0.4) * H
    const { hy } = halfExtents(reg)
    expect(eyeY - (reg.cy - hy)).toBeGreaterThan(90)
  })

  it('keeps sTorso load-bearing: does not collapse in profile', () => {
    // MUTATION (force scale = sFace): the x-only profile squeeze shrinks the
    // face span badly, so the ellipse shrinks with it.
    const frontal = headRegion(pose(), W, H)
    const profile = headRegion(profilePose(), W, H)
    expect(profile.rAcross).toBeGreaterThanOrEqual(0.95 * frontal.rAcross)
    expect(profile.rAcross).toBeGreaterThan(110)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/headRegion.test.js`
Expected: FAIL — `occluderGeometry`/`expandForMotion` are not exported yet (import error), and once that is stubbed, `reg.rAcross` is `undefined`.

- [ ] **Step 3: Implement the ellipse in `src/core/headRegion.js`**

Add the two new constants next to the existing ones:

```js
export const ELLIPSE_ACROSS = 0.92  // seed semi-axis across the head axis, x rHeuristic
export const ELLIPSE_ALONG  = 1.14  // seed semi-axis along it — a head is taller than wide
```

Delete `export const BLUR_RADIUS_FACTOR = 0.35`.

Replace the body of `headRegion()` from `const scale = Math.max(sFace, sTorso)` onward. Rename the local `upX/upY` to `ux/uy` in the block above it. The full replacement from that point:

```js
  const scale = Math.max(sFace, sTorso)
  if (!(scale > 0)) return null

  const maxR = MAX_RADIUS_FRACTION * Math.min(videoW, videoH)

  // The heuristic radius. It places the CENTRE (via CRANIUM_NUDGE), seeds the
  // semi-axes, and acts as the floor on the final size — it is what covers the
  // cranium and hair, which have no landmarks of their own to be contained.
  //
  // Capped HERE as well as at the end, which is what keeps the centre finite
  // and on-frame for a garbage landmark frame.
  const rHeuristic = Math.min(HEAD_RADIUS_FACTOR * scale, maxR)

  const cx = faceX + ux * (CRANIUM_NUDGE * rHeuristic)
  const cy = faceY + uy * (CRANIUM_NUDGE * rHeuristic)

  // Seed the ellipse from the heuristic, then grow it to contain.
  let rAcross = ELLIPSE_ACROSS * rHeuristic
  let rAlong  = ELLIPSE_ALONG  * rHeuristic
  if (!(rAcross > 0) || !(rAlong > 0)) return null

  // Perpendicular to the head axis. (ux, uy) and (px, py) form the ellipse's
  // local frame; both are unit vectors, so the projections below are distances.
  const px = -uy, py = ux

  // CONTAINMENT TERM, elliptical. `t` is the factor by which the seeded
  // ellipse must grow for every face landmark to sit inside it.
  let t = 0
  for (const p of facePts) {
    const dx = p.x - cx
    const dy = p.y - cy
    const across = dx * px + dy * py
    const along  = dx * ux + dy * uy
    const q = Math.hypot(across / rAcross, along / rAlong)
    if (q > t) t = q
  }

  // NOTE THE MARGIN'S PLACEMENT — inside the max(), not outside it. This is
  // the faithful analogue of the circle version's
  //   r = max(rHeuristic, maxDist * COVERAGE_MARGIN)
  // where the heuristic floor wins OUTRIGHT when it already over-covers.
  // Writing `Math.max(1, t) * COVERAGE_MARGIN` would instead scale every
  // region by 1.60 even when containment is inert, inflating the occluder on
  // every normal frame — and no containment assertion would catch it.
  const grow = Math.max(1, t * COVERAGE_MARGIN)
  rAcross *= grow
  rAlong  *= grow

  // The sanity cap is applied LAST to BOTH axes and therefore OVERRIDES
  // containment: a garbage landmark frame must not be able to mask the whole
  // picture. Containment holds only while the shape is uncapped.
  rAcross = Math.min(rAcross, maxR)
  rAlong  = Math.min(rAlong,  maxR)

  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
  if (!Number.isFinite(rAcross) || !Number.isFinite(rAlong)) return null
  if (!Number.isFinite(ux) || !Number.isFinite(uy)) return null

  // Axis-aligned half-extents of the ORIENTED ellipse — the correct bounding
  // box for the off-frame test. Using rAcross/rAlong directly would be wrong
  // for any head axis that is not screen-aligned, i.e. every prone patient.
  const hx = Math.hypot(rAcross * uy, rAlong * ux)
  const hy = Math.hypot(rAcross * ux, rAlong * uy)

  // No head in the picture → nothing to redact.
  if (cx + hx < 0 || cx - hx > videoW || cy + hy < 0 || cy - hy > videoH) return null

  return { cx, cy, rAcross, rAlong, ux, uy }
}
```

Update the JSDoc `@returns` above `headRegion` to describe the ellipse, and update the file-header comment block so it no longer says "circle".

Add temporary stubs so the import resolves (they are implemented properly in Tasks 2 and 3):

```js
export function expandForMotion(region) { return region }
export function occluderGeometry() { return null }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/headRegion.test.js`
Expected: PASS.

If `'does not inflate a region the heuristic already covers'` fails, **do not adjust the expected value** — it is derived from the same inputs, not hardcoded, so a mismatch means the growth factor is genuinely wrong. Check that it reads `Math.max(1, t * COVERAGE_MARGIN)` and not `Math.max(1, t) * COVERAGE_MARGIN`.

- [ ] **Step 5: Commit**

```bash
git add src/core/headRegion.js src/core/headRegion.test.js
git commit -m "Return an oriented ellipse from headRegion with elliptical containment"
```

---

### Task 2: Motion expansion

**Files:**
- Modify: `src/core/headRegion.js` — replace the `expandForMotion` stub
- Test: `src/core/headRegion.test.js`

**Interfaces:**
- Consumes: `headRegion()` from Task 1 and its `{cx, cy, rAcross, rAlong, ux, uy}` shape.
- Produces: `expandForMotion(region, prevRegion, videoW, videoH, gain = MOTION_GAIN) → region | null`. Returns the **same object reference** when there is nothing to expand. Exports `MOTION_GAIN = 1.0`.

- [ ] **Step 1: Write the failing test**

Append to `src/core/headRegion.test.js`:

```js
describe('expandForMotion', () => {
  const base = () => ({ cx: 300, cy: 400, rAcross: 100, rAlong: 120, ux: 0, uy: -1 })

  it('returns the region untouched when there is no previous frame', () => {
    const r = base()
    expect(expandForMotion(r, null, W, H)).toBe(r)
  })

  it('returns the region untouched when the head has not moved', () => {
    const r = base()
    expect(expandForMotion(r, { ...base() }, W, H)).toBe(r)
  })

  it('grows both semi-axes by the displacement since the last detection', () => {
    // The video element runs at 30fps while detection runs at 10Hz plus
    // inference, so the occluder is drawn over a frame ~150ms newer than the
    // landmarks that placed it. Growing by the last displacement covers the
    // swept path instead of a stale point.
    const prev = { ...base(), cx: 260, cy: 400 }     // moved 40px in x
    const out  = expandForMotion(base(), prev, W, H)
    expect(out.rAcross).toBeCloseTo(140, 6)
    expect(out.rAlong).toBeCloseTo(160, 6)
    expect(out.cx).toBe(300)                          // centre is NOT moved
  })

  it('covers where the head was as well as where it is', () => {
    const prev = { ...base(), cx: 260, cy: 400 }
    const out  = expandForMotion(base(), prev, W, H)
    const dist = Math.hypot(prev.cx - out.cx, prev.cy - out.cy)
    expect(dist).toBeLessThanOrEqual(out.rAcross)
  })

  it('stays subject to the radius cap', () => {
    const prev = { ...base(), cx: -5000 }
    const out  = expandForMotion(base(), prev, W, H)
    const cap  = MAX_RADIUS_FRACTION * Math.min(W, H)
    expect(out.rAcross).toBeLessThanOrEqual(cap)
    expect(out.rAlong).toBeLessThanOrEqual(cap)
  })

  it('returns null input unchanged and ignores a non-finite previous centre', () => {
    expect(expandForMotion(null, base(), W, H)).toBeNull()
    const r = base()
    expect(expandForMotion(r, { ...base(), cx: NaN }, W, H)).toBe(r)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/headRegion.test.js -t expandForMotion`
Expected: FAIL — the stub returns the region unchanged, so the two growth tests fail with `expected 100 to be close to 140`.

- [ ] **Step 3: Implement**

Add the constant beside the others in `src/core/headRegion.js`:

```js
export const MOTION_GAIN = 1.0  // occluder growth per pixel of inter-frame head travel
```

Replace the stub:

```js
/**
 * Grow a head region to cover the distance the head travelled since the last
 * detection.
 *
 * WHY THIS EXISTS. Detection runs at 10Hz plus BlazePose inference (~150ms end
 * to end) while the <video> element underneath keeps playing at 30fps, so the
 * overlay is positioned from landmarks that are already stale by the time it is
 * composited over the live preview. At walking pace that is 80-90px — about one
 * head radius, which is exactly the offset seen in tmp/blur1.jpg. Growing the
 * shape by the last displacement covers the swept path instead of a stale
 * point.
 *
 * The CENTRE is deliberately not moved. Extrapolating it forward would guess at
 * a velocity from two samples and can overshoot off the head entirely; growing
 * is strictly conservative — it only ever covers more.
 *
 * The STORED snapshot does not need this (it composites over the same buffered
 * frame the landmarks came from) but gets it anyway, because preview and
 * snapshot come from one draw. Over-covering there is free.
 *
 * @param {{cx:number,cy:number,rAcross:number,rAlong:number,ux:number,uy:number}|null} region
 * @param {object|null} prevRegion - the PREVIOUS frame's UNEXPANDED region
 * @param {number} videoW
 * @param {number} videoH
 * @param {number} [gain]
 * @returns the same reference when there is nothing to expand, else a new region
 */
export function expandForMotion(region, prevRegion, videoW, videoH, gain = MOTION_GAIN) {
  if (!region || !prevRegion) return region
  if (!Number.isFinite(prevRegion.cx) || !Number.isFinite(prevRegion.cy)) return region

  const d = Math.hypot(region.cx - prevRegion.cx, region.cy - prevRegion.cy)
  if (!Number.isFinite(d) || d <= 0) return region

  const maxR = MAX_RADIUS_FRACTION * Math.min(videoW, videoH)
  return {
    ...region,
    rAcross: Math.min(region.rAcross + gain * d, maxR),
    rAlong:  Math.min(region.rAlong  + gain * d, maxR),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/headRegion.test.js`
Expected: PASS (all blocks).

- [ ] **Step 5: Commit**

```bash
git add src/core/headRegion.js src/core/headRegion.test.js
git commit -m "Grow the head region by inter-frame travel to absorb detection latency"
```

---

### Task 3: Occluder geometry replaces blur geometry

**Files:**
- Modify: `src/core/headRegion.js` — replace the `occluderGeometry` stub, delete `redactionGeometry`
- Test: `src/core/headRegion.test.js`

**Interfaces:**
- Consumes: the ellipse shape from Task 1.
- Produces:
  ```js
  occluderGeometry(displayRegion) → {
    cx, cy, rotation,                    // rotation for ctx.rotate(), radians
    core:    { rAcross, rAlong },        // FULLY OPAQUE out to here
    feather: { rAcross, rAlong },        // alpha reaches 0 here
    outline: { rAcross, rAlong },
    innerStop,                           // gradient stop where the core ends: 1 / FEATHER_EXTENT
  } | null
  ```
  Exports `FEATHER_EXTENT = 1.35`, `OUTLINE_AT = 1.04`. `redactionGeometry` and `BLUR_RADIUS_FACTOR` no longer exist.

- [ ] **Step 1: Write the failing test**

Append to `src/core/headRegion.test.js`:

```js
describe('occluderGeometry', () => {
  const disp = { cx: 200, cy: 300, rAcross: 100, rAlong: 120, ux: 0, uy: -1 }

  it('keeps the core exactly at the containment ellipse', () => {
    // THE INVARIANT THE WHOLE DESIGN RESTS ON: softening happens strictly
    // OUTSIDE the shape that provably contains every face landmark. A mutant
    // that shrinks the core to make the feather start earlier trades the
    // guarantee for looks.
    const g = occluderGeometry(disp)
    expect(g.core.rAcross).toBe(100)
    expect(g.core.rAlong).toBe(120)
  })

  it('feathers and outlines outside the core, never inside', () => {
    const g = occluderGeometry(disp)
    expect(g.feather.rAcross).toBeGreaterThan(g.core.rAcross)
    expect(g.feather.rAlong).toBeGreaterThan(g.core.rAlong)
    expect(g.outline.rAcross).toBeGreaterThan(g.core.rAcross)
  })

  it('puts the gradient stop where the opaque core ends', () => {
    // The gradient is drawn in a space scaled to the FEATHER extent, so the
    // core boundary lands at core/feather = 1 / FEATHER_EXTENT. Getting this
    // wrong is how the fade ends up starting at the centre.
    const g = occluderGeometry(disp)
    expect(g.innerStop).toBeCloseTo(1 / FEATHER_EXTENT, 9)
    expect(g.innerStop).toBeCloseTo(g.core.rAcross / g.feather.rAcross, 9)
    expect(g.innerStop).toBeCloseTo(g.core.rAlong / g.feather.rAlong, 9)
  })

  it('rotates so the long axis follows the head axis', () => {
    // ctx.rotate(theta) maps the local y-axis to (-sin, cos); we need that to
    // equal (ux, uy) so radiusY (rAlong) runs along the head.
    for (const u of [{ ux: 0, uy: -1 }, { ux: -1, uy: 0 }, { ux: 0.6, uy: -0.8 }]) {
      const g = occluderGeometry({ ...disp, ...u })
      expect(-Math.sin(g.rotation)).toBeCloseTo(u.ux, 6)
      expect(Math.cos(g.rotation)).toBeCloseTo(u.uy, 6)
    }
  })

  it('returns null for a missing or degenerate region', () => {
    expect(occluderGeometry(null)).toBeNull()
    expect(occluderGeometry({ ...disp, rAcross: 0 })).toBeNull()
    expect(occluderGeometry({ ...disp, rAlong: -1 })).toBeNull()
  })
})
```

Add `FEATHER_EXTENT` to the import list at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/headRegion.test.js -t occluderGeometry`
Expected: FAIL — the stub returns `null`, so `g.core` throws `Cannot read properties of null`.

- [ ] **Step 3: Implement**

Add the constants, and delete `BLUR_RADIUS_FACTOR` if Task 1 left it:

```js
export const FEATHER_EXTENT = 1.35  // alpha reaches 0 here, as a multiple of the core
export const OUTLINE_AT     = 1.04  // outline sits just outside the core
```

Delete `redactionGeometry()` entirely and replace it with:

```js
/**
 * Derive the drawing geometry for a head ellipse already mapped into DISPLAY
 * CSS PIXEL space.
 *
 * WHAT REPLACED WHAT, AND WHY. The blur version of this function returned a
 * `blurRadius` and a `padding = 2 * blurRadius`. That padding existed only
 * because a Canvas 2D blur fades to TRANSPARENT at its source image's edges,
 * so the source square had to overhang the clip circle to keep the rim opaque.
 * With an opaque fill there is no fade to hide and no source to overhang, so
 * both are gone.
 *
 * THE CORE IS THE CONTAINMENT ELLIPSE, UNCHANGED. Every softening term here —
 * the feather, the outline — is strictly OUTSIDE it, over background pixels
 * that were never part of the head. That is what lets the occluder be made to
 * look deliberate without weakening what it guarantees. Do not shrink the core
 * to start the fade earlier.
 *
 * @param {{cx:number,cy:number,rAcross:number,rAlong:number,ux:number,uy:number}|null} displayRegion
 */
export function occluderGeometry(displayRegion) {
  if (!displayRegion) return null
  const { cx, cy, rAcross, rAlong, ux, uy } = displayRegion
  if (!(rAcross > 0) || !(rAlong > 0)) return null
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null

  // ctx.rotate(theta) sends the local y-axis to (-sin theta, cos theta). We
  // need that to be the head axis (ux, uy) so that radiusY = rAlong runs along
  // the head and radiusX = rAcross runs across it.
  const rotation = Math.atan2(-ux, uy)

  return {
    cx, cy, rotation,
    core:    { rAcross, rAlong },
    feather: { rAcross: rAcross * FEATHER_EXTENT, rAlong: rAlong * FEATHER_EXTENT },
    outline: { rAcross: rAcross * OUTLINE_AT,     rAlong: rAlong * OUTLINE_AT },
    innerStop: 1 / FEATHER_EXTENT,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/headRegion.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/headRegion.js src/core/headRegion.test.js
git commit -m "Replace blur geometry with opaque occluder geometry"
```

---

### Task 4: Wire motion expansion into the detector

**Files:**
- Modify: `src/detection/pose.js:84-155` — `detect()`
- Test: `src/detection/pose.test.js`

**Interfaces:**
- Consumes: `headRegion()`, `expandForMotion()` from `../core/headRegion.js`.
- Produces: `detect()` still returns `{ markers, allFound, foundIds, head, headResolved }`. `head` is now the **expanded** ellipse; `headResolved` semantics are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `src/detection/pose.test.js`, inside the existing `describe('PoseDetector', ...)`:

```js
  // Landmarks for a head at (hx, hy) with shoulders below — enough spread for
  // headRegion() to return a region.
  function headLandmarks(hx = 0.5, hy = 0.25) {
    const lm = makeLandmarks()
    const at = (i, x, y) => { lm[i] = { x, y, z: 0, visibility: 0.95 } }
    at(0, hx, hy)
    at(7, hx - 0.06, hy); at(8, hx + 0.06, hy)
    at(9, hx - 0.02, hy + 0.04); at(10, hx + 0.02, hy + 0.04)
    at(11, hx - 0.10, hy + 0.18); at(12, hx + 0.10, hy + 0.18)
    return lm
  }

  it('does not expand the head region on the first detection', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(0.5)] })
    const first = detector.detect(makeVideoEl())
    mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(0.5)] })
    const still = detector.detect(makeVideoEl())
    expect(still.head.rAcross).toBeCloseTo(first.head.rAcross, 6)
  })

  it('expands the head region when the head moves between detections', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(0.30)] })
    const a = detector.detect(makeVideoEl())
    mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(0.50)] })
    const b = detector.detect(makeVideoEl())
    expect(b.head.rAcross).toBeGreaterThan(a.head.rAcross)
  })

  it('does not compound expansion across frames', async () => {
    // THE MUTANT THIS KILLS: storing the EXPANDED region as `_prevHead`. The
    // stored value must be the raw region, or a head moving at constant speed
    // grows the occluder without bound until it hits the cap.
    await detector.init()
    const xs = [0.30, 0.40, 0.50, 0.60]
    const widths = []
    for (const x of xs) {
      mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(x)] })
      widths.push(detector.detect(makeVideoEl()).head.rAcross)
    }
    // Steps 2, 3 and 4 all travel the same distance, so they must all expand
    // by the same amount.
    expect(widths[3]).toBeCloseTo(widths[2], 4)
  })

  it('clears motion state when the pose is lost, so a gap cannot carry a stale jump', async () => {
    await detector.init()
    mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(0.30)] })
    detector.detect(makeVideoEl())
    mockDetectForVideo.mockReturnValue({ landmarks: [] })
    detector.detect(makeVideoEl())                       // pose lost
    mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(0.70)] })
    const after = detector.detect(makeVideoEl())
    mockDetectForVideo.mockReturnValue({ landmarks: [headLandmarks(0.70)] })
    const settled = detector.detect(makeVideoEl())
    expect(after.head.rAcross).toBeCloseTo(settled.head.rAcross, 6)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/detection/pose.test.js -t "expands the head region"`
Expected: FAIL — `expected 126.1 to be greater than 126.1`, because no expansion is applied yet.

- [ ] **Step 3: Implement**

In `src/detection/pose.js`, update the import:

```js
import { headRegion, headInputsFinite, anyFaceLandmarkInFrame, expandForMotion } from '../core/headRegion.js'
```

Add to the constructor:

```js
    // Previous frame's RAW (unexpanded) head region, for motion expansion.
    // Storing the raw one is load-bearing: storing the expanded region instead
    // would compound growth every frame and inflate the occluder to the cap on
    // any sustained movement.
    this._prevHead = null
```

In `detect()`, both early returns must clear the motion state — a gap in detection must not let a stale position produce a huge spurious jump on the next hit:

```js
  detect(videoElement) {
    if (!this._ready || !videoElement) {
      this._prevHead = null
      return { markers: {}, allFound: false, foundIds: [], head: null, headResolved: false }
    }

    const result = this._landmarker.detectForVideo(videoElement, performance.now())

    if (!result.landmarks || result.landmarks.length === 0) {
      this._prevHead = null
      return { markers: {}, allFound: false, foundIds: [], head: null, headResolved: false }
    }
```

Then replace the `const head = headRegion(lmNorm, vw, vh)` line:

```js
    // Head ellipse for snapshot redaction. Independent of the joint roles — it
    // is computed from the face/shoulder landmarks, not from JOINT_CONFIG, so
    // it is present even when the measured joint is not fully visible.
    const rawHead = headRegion(lmNorm, vw, vh)

    // Grow it to cover the head's travel since the last detection. See
    // expandForMotion() for why: the overlay is composited over a video frame
    // ~150ms newer than the landmarks that placed it.
    const head = expandForMotion(rawHead, this._prevHead, vw, vh)
    this._prevHead = rawHead
```

`headResolved` below is unchanged — `head !== null` is equivalent to `rawHead !== null`, since `expandForMotion` only ever returns null for null input.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/detection/pose.test.js`
Expected: PASS, including the existing `headResolved` tests.

- [ ] **Step 5: Commit**

```bash
git add src/detection/pose.js src/detection/pose.test.js
git commit -m "Expand the head region by inter-frame travel in the detector"
```

---

### Task 5: Draw the opaque occluder

**Files:**
- Modify: `src/detection/overlay.js` — delete the blur machinery, rewrite `_drawRedaction`
- Test: `src/detection/overlay.test.js` (substantial rewrite)

**Interfaces:**
- Consumes: `occluderGeometry()` from Task 3; the ellipse from Task 1.
- Produces: `Overlay.redactionMode` is the constant `'mask1'`. `_drawRedaction(head, frame)` unchanged in signature. `_filterSupported`, `_detectFilterSupport`, `_getScratch`, `_scratch` and `REDACTION_FILL` no longer exist.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `src/detection/overlay.test.js` with:

```js
import { describe, it, expect, afterEach } from 'vitest'
import { Overlay } from './overlay.js'
import { FEATHER_EXTENT, OUTLINE_AT } from '../core/headRegion.js'

/**
 * A canvas 2D context that records every call and every relevant property
 * assignment, in order, so tests can assert both WHICH calls happened and
 * their relative ordering.
 */
function createRecordingCtx() {
  const calls = []
  const stops = []
  const rec = (name) => (...args) => { calls.push({ name, args }) }
  const ctx = {
    save: rec('save'), restore: rec('restore'),
    beginPath: rec('beginPath'), arc: rec('arc'), ellipse: rec('ellipse'),
    clip: rec('clip'), fill: rec('fill'), stroke: rec('stroke'), fillRect: rec('fillRect'),
    drawImage: rec('drawImage'),
    translate: rec('translate'), rotate: rec('rotate'), scale: rec('scale'),
    clearRect: rec('clearRect'), measureText: () => ({ width: 10 }),
    createRadialGradient: (...args) => {
      calls.push({ name: 'createRadialGradient', args })
      return { addColorStop: (o, c) => stops.push({ offset: o, color: c }) }
    },
    // A flat mid-grey frame: every sample outside the head reads the same.
    getImageData: (x, y, w, h) => ({
      data: new Uint8ClampedArray(w * h * 4).fill(128).map((v, i) => (i % 4 === 3 ? 255 : 120)),
    }),
    _filter: 'none', _globalAlpha: undefined, _fillStyle: undefined, _strokeStyle: undefined,
    _lineWidth: undefined, _font: undefined, _textAlign: undefined, _textBaseline: undefined,
  }
  for (const p of ['filter', 'globalAlpha', 'fillStyle', 'strokeStyle', 'lineWidth']) {
    Object.defineProperty(ctx, p, {
      get() { return this[`_${p}`] },
      set(v) { this[`_${p}`] = v; calls.push({ name: `set:${p}`, args: [v] }) },
    })
  }
  return { ctx, calls, stops }
}

/** Stub document.createElement so the neutral-fill sample canvas is recorded. */
function stubDocument() {
  const { ctx, calls } = createRecordingCtx()
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  global.document = { createElement: () => canvas }
  return { sampleCanvas: canvas, sampleCtx: ctx, sampleCalls: calls }
}

function createOverlayCanvas() {
  const { ctx, calls, stops } = createRecordingCtx()
  const canvas = { getContext: () => ctx, clientWidth: 400, clientHeight: 700 }
  return { canvas, ctx, calls, stops }
}

function stubWindow(dpr) { global.window = { devicePixelRatio: dpr } }

const fakeFrame = { width: 1280, height: 720 }
const HEAD = { cx: 100, cy: 100, rAcross: 40, rAlong: 50, ux: 0, uy: -1 }

function makeOverlay(canvas) {
  const overlay = new Overlay()
  overlay.attach(canvas)
  overlay._scale = 1
  overlay._offsetX = 0
  overlay._offsetY = 0
  return overlay
}

afterEach(() => { delete global.document; delete global.window })

describe('Overlay redaction mode', () => {
  it('always reports mask1 — there is no device-dependent fallback left', () => {
    // The blur version reported blur1 or solid1 depending on whether Canvas 2D
    // filters worked. Nothing about an opaque fill is device-dependent, so a
    // branch here would be a lie waiting to be told.
    stubDocument()
    const overlay = new Overlay()
    overlay.attach(createOverlayCanvas().canvas)
    expect(overlay.redactionMode).toBe('mask1')
  })

  it('reports mask1 even with no DOM at all', () => {
    const overlay = new Overlay()
    overlay.attach(createOverlayCanvas().canvas)
    expect(overlay.redactionMode).toBe('mask1')
  })
})

describe('Overlay._drawRedaction', () => {
  it('never samples a patch of the frame into the overlay', () => {
    // THE FAILURE THIS DESIGN EXISTS TO REMOVE. The blur version copied a
    // padded square of video into the circle, which is what misregistered in
    // tmp/blur1.jpg. Nothing may be blitted onto the overlay context.
    stubWindow(3)
    stubDocument()
    const { canvas, calls } = createOverlayCanvas()
    makeOverlay(canvas)._drawRedaction(HEAD, fakeFrame)
    expect(calls.map((c) => c.name)).not.toContain('drawImage')
  })

  it('never sets a Canvas 2D filter', () => {
    // No filter means no dpr/CTM question, no support probe, and no way to
    // land at a fraction of the intended strength while still reporting success.
    stubWindow(3)
    stubDocument()
    const { canvas, calls } = createOverlayCanvas()
    makeOverlay(canvas)._drawRedaction(HEAD, fakeFrame)
    for (const s of calls.filter((c) => c.name === 'set:filter')) {
      expect(s.args[0]).toBe('none')
    }
  })

  it('keeps the core fully opaque and fades only outside it', () => {
    // THE INVARIANT. The gradient must be at full alpha from the centre all
    // the way to innerStop (= 1 / FEATHER_EXTENT), and only then fade. A
    // mutant that fades from offset 0 makes the whole head translucent while
    // still looking softened.
    stubWindow(2)
    stubDocument()
    const { canvas, stops } = createOverlayCanvas()
    makeOverlay(canvas)._drawRedaction(HEAD, fakeFrame)

    expect(stops.length).toBeGreaterThanOrEqual(3)
    const inner = stops.find((s) => Math.abs(s.offset - 1 / FEATHER_EXTENT) < 1e-9)
    expect(inner, 'no gradient stop at the core boundary').toBeTruthy()

    const opaque = (c) => !/rgba\([^)]*,\s*0(\.0+)?\s*\)$/.test(c)
    expect(opaque(stops[0].color), 'centre stop must be opaque').toBe(true)
    expect(opaque(inner.color), 'core-boundary stop must be opaque').toBe(true)
    expect(stops[0].color).toBe(inner.color)
    expect(opaque(stops.at(-1).color), 'outer stop must be transparent').toBe(false)
    expect(stops.at(-1).offset).toBe(1)
  })

  it('sets globalAlpha explicitly to 1', () => {
    // The other helpers in overlay.js leave globalAlpha dirty, and a
    // translucent redaction leaks the sharp face straight through.
    stubWindow(2)
    stubDocument()
    const { canvas, calls } = createOverlayCanvas()
    makeOverlay(canvas)._drawRedaction(HEAD, fakeFrame)
    expect(calls.find((c) => c.name === 'set:globalAlpha').args[0]).toBe(1)
  })

  it('orients and scales the shape to the head ellipse', () => {
    stubWindow(1)
    stubDocument()
    const { canvas, calls } = createOverlayCanvas()
    makeOverlay(canvas)._drawRedaction(HEAD, fakeFrame)

    const translate = calls.find((c) => c.name === 'translate')
    expect(translate.args).toEqual([100, 100])

    // Scaled to the FEATHER extent, because the gradient is built in a unit
    // circle and stretched: 40 * 1.35 across, 50 * 1.35 along.
    const scale = calls.find((c) => c.name === 'scale')
    expect(scale.args[0]).toBeCloseTo(40 * FEATHER_EXTENT, 6)
    expect(scale.args[1]).toBeCloseTo(50 * FEATHER_EXTENT, 6)

    // The outline is stroked as a real ellipse, NOT under the non-uniform
    // scale — a stroke there would come out thicker on one axis.
    const outline = calls.find((c) => c.name === 'ellipse')
    expect(outline.args[2]).toBeCloseTo(40 * OUTLINE_AT, 6)
    expect(outline.args[3]).toBeCloseTo(50 * OUTLINE_AT, 6)
  })

  it('maps video pixel space to display space before drawing', () => {
    stubWindow(1)
    stubDocument()
    const { canvas, calls } = createOverlayCanvas()
    const overlay = makeOverlay(canvas)
    overlay._scale = 2
    overlay._offsetX = 10
    overlay._offsetY = -20
    overlay._drawRedaction(HEAD, fakeFrame)

    expect(calls.find((c) => c.name === 'translate').args).toEqual([210, 180])
    expect(calls.find((c) => c.name === 'scale').args[0]).toBeCloseTo(80 * FEATHER_EXTENT, 6)
  })

  it('draws nothing when there is no head', () => {
    stubWindow(1)
    stubDocument()
    const { canvas, calls } = createOverlayCanvas()
    makeOverlay(canvas)._drawRedaction(null, fakeFrame)
    expect(calls.map((c) => c.name)).not.toContain('fill')
  })

  it('still masks when the frame is unavailable, falling back to a fixed fill', () => {
    // A missing frame costs the colour sample, never the redaction. Returning
    // early here would leave the face sharp on exactly the frames where
    // something already went wrong.
    stubWindow(1)
    stubDocument()
    const { canvas, calls, stops } = createOverlayCanvas()
    makeOverlay(canvas)._drawRedaction(HEAD, null)
    expect(calls.map((c) => c.name)).toContain('fill')
    expect(stops.length).toBeGreaterThanOrEqual(3)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/detection/overlay.test.js`
Expected: FAIL — `expected 'blur1' to be 'mask1'`, and the gradient tests fail because `createRadialGradient` is never called.

- [ ] **Step 3: Implement**

In `src/detection/overlay.js`, change the import and constants:

```js
import { occluderGeometry } from '../core/headRegion.js'
```

Replace `const REDACTION_FILL = '#111827'` with:

```js
// Fill used when no colour could be sampled from the frame. Deliberately a mid
// neutral rather than near-black: it reads as a deliberate mask rather than as
// a hole punched in the picture.
const OCCLUDER_FALLBACK = { r: 107, g: 114, b: 128 }
const OUTLINE_COLOR     = 'rgba(255,255,255,0.30)'
const SAMPLE_GRID       = 8      // 8x8 = 64 samples, regardless of video resolution
const SAMPLE_RING       = 1.45   // sample box extends to this multiple of the head
const FILL_SMOOTHING    = 0.2    // EMA factor, so the fill does not flicker frame to frame
```

In the constructor, delete `this._scratch` and `this._filterSupported`, and add:

```js
    // Reused across frames — a fresh canvas per frame at 10Hz is needless GC churn.
    this._sampleCanvas = null
    // Exponentially smoothed occluder fill, so the colour does not flicker.
    this._fill = null
```

Simplify `attach()` (the filter probe is gone):

```js
  attach(canvasElement) {
    this.canvas = canvasElement
    this.ctx    = canvasElement.getContext('2d')
  }
```

Delete `_detectFilterSupport()` and `_getScratch()` entirely. Replace `get redactionMode()`:

```js
  /**
   * What this device actually did — stamped onto the session record.
   *
   * A constant, unlike the blur version which reported 'blur1' or 'solid1'
   * depending on Canvas 2D filter support. Nothing about an opaque fill is
   * device-dependent, so a branch here would only ever be able to lie.
   */
  get redactionMode() {
    return 'mask1'
  }
```

Replace `_drawRedaction()` wholesale:

```js
  /**
   * Mask the patient's head out of the frame with an opaque occluder.
   *
   * Drawn into the OVERLAY canvas, which is what makes the live preview and the
   * stored snapshot agree by construction: MeasureView._captureFrameTo()
   * composites this same canvas over the video frame, so both surfaces come
   * from this one code path and cannot drift apart.
   *
   * WHY THIS IS NOT A BLUR ANY MORE. The blur version needed six things to be
   * simultaneously correct — a source rect mapped out of display space and back
   * into video space, a scratch canvas sized in device pixels, a blur radius
   * scaled by dpr, an opaque pre-fill, padding to keep the filter's transparent
   * fade outside the clip, and Canvas 2D `filter` actually taking effect. Five
   * of those cannot be verified headless. On-device they produced a mask that
   * was both displaced and barely blurred, while the session still stamped
   * 'blur1' and the detail view still reported success. Nothing here samples a
   * patch and nothing here sets a filter, so neither failure is reachable.
   *
   * WHAT IS DRAWN: an opaque ellipse out to the containment boundary, a feather
   * from there outwards, and a thin outline so it reads as UI rather than as a
   * smudge or a fault. THE CORE STAYS FULLY OPAQUE — all softening is outside
   * it, over background pixels that were never part of the head.
   *
   * @param {{cx,cy,rAcross,rAlong,ux,uy}|null} head - VIDEO pixel space
   * @param {HTMLCanvasElement|null} frame - per-tick frame buffer, for the colour sample only
   */
  _drawRedaction(head, frame) {
    if (!head) return

    const display = {
      cx:      head.cx * this._scale + this._offsetX,
      cy:      head.cy * this._scale + this._offsetY,
      rAcross: head.rAcross * this._scale,
      rAlong:  head.rAlong  * this._scale,
      ux:      head.ux,
      uy:      head.uy,
    }
    const g = occluderGeometry(display)
    if (!g) return

    const c = this._occluderFill(head, frame)
    const solid       = `rgb(${c.r}, ${c.g}, ${c.b})`
    const transparent = `rgba(${c.r}, ${c.g}, ${c.b}, 0)`

    const ctx = this.ctx

    // ── Opaque core + feather ────────────────────────────────────────
    // Built as a unit circle in a space scaled to the FEATHER extent, so the
    // gradient stretches with the ellipse. innerStop is where the opaque core
    // ends; everything before it is at full alpha.
    ctx.save()
    // Set explicitly: the helpers in this file leave globalAlpha dirty, and a
    // translucent redaction leaks the sharp face straight through — in the
    // snapshot and the live view alike, since both sit over raw video pixels.
    ctx.globalAlpha = 1
    ctx.filter = 'none'
    ctx.translate(g.cx, g.cy)
    ctx.rotate(g.rotation)
    ctx.scale(g.feather.rAcross, g.feather.rAlong)

    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
    grad.addColorStop(0, solid)
    grad.addColorStop(g.innerStop, solid)
    grad.addColorStop(1, transparent)
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(0, 0, 1, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    // ── Outline ──────────────────────────────────────────────────────
    // Drawn WITHOUT the non-uniform scale above — a stroke under that scale
    // would come out thicker on one axis than the other.
    ctx.save()
    ctx.globalAlpha = 1
    ctx.translate(g.cx, g.cy)
    ctx.rotate(g.rotation)
    ctx.beginPath()
    ctx.ellipse(0, 0, g.outline.rAcross, g.outline.rAlong, 0, 0, Math.PI * 2)
    ctx.strokeStyle = OUTLINE_COLOR
    ctx.lineWidth   = this._scalePx(2)
    ctx.stroke()
    ctx.restore()
  }

  /**
   * The occluder's fill colour: one average of the frame OUTSIDE the head,
   * smoothed across frames.
   *
   * A single averaged colour carries no recoverable facial detail — this is
   * emphatically not the patch sampling the blur version did. Sampling is
   * bounded to SAMPLE_GRID^2 points regardless of video resolution, so the
   * cost does not scale with the camera.
   *
   * A failure here costs the colour, never the redaction: it falls back to
   * OCCLUDER_FALLBACK rather than returning and leaving the face sharp.
   */
  _occluderFill(head, frame) {
    const sample = this._sampleNeutral(head, frame)
    if (sample) {
      this._fill = this._fill
        ? {
            r: this._fill.r + FILL_SMOOTHING * (sample.r - this._fill.r),
            g: this._fill.g + FILL_SMOOTHING * (sample.g - this._fill.g),
            b: this._fill.b + FILL_SMOOTHING * (sample.b - this._fill.b),
          }
        : sample
    }
    const c = this._fill ?? OCCLUDER_FALLBACK
    return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) }
  }

  /** @returns {{r,g,b}|null} average of frame pixels OUTSIDE the head ellipse */
  _sampleNeutral(head, frame) {
    if (!frame || typeof document === 'undefined') return null
    try {
      // Axis-aligned half-extents of the oriented ellipse.
      const hx = Math.hypot(head.rAcross * head.uy, head.rAlong * head.ux) * SAMPLE_RING
      const hy = Math.hypot(head.rAcross * head.ux, head.rAlong * head.uy) * SAMPLE_RING
      const bx = head.cx - hx, by = head.cy - hy
      const bw = 2 * hx,       bh = 2 * hy
      if (!(bw > 0) || !(bh > 0)) return null

      const N = SAMPLE_GRID
      if (!this._sampleCanvas) this._sampleCanvas = document.createElement('canvas')
      const cv = this._sampleCanvas
      if (cv.width !== N || cv.height !== N) { cv.width = N; cv.height = N }
      const sctx = cv.getContext('2d', { willReadFrequently: true })
      sctx.clearRect(0, 0, N, N)
      sctx.drawImage(frame, bx, by, bw, bh, 0, 0, N, N)
      const { data } = sctx.getImageData(0, 0, N, N)

      const px = -head.uy, py = head.ux
      let r = 0, g = 0, b = 0, n = 0
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          // Centre of this sample cell, back in video pixel space.
          const sx = bx + ((i + 0.5) / N) * bw
          const sy = by + ((j + 0.5) / N) * bh
          const dx = sx - head.cx, dy = sy - head.cy
          const across = dx * px + dy * py
          const along  = dx * head.ux + dy * head.uy
          // Skip anything inside the head — sampling the face would tint the
          // mask toward skin, which is the opposite of blending into the room.
          if (Math.hypot(across / head.rAcross, along / head.rAlong) <= 1) continue
          const k = (j * N + i) * 4
          if (data[k + 3] === 0) continue     // off the edge of the frame
          r += data[k]; g += data[k + 1]; b += data[k + 2]; n++
        }
      }
      return n ? { r: r / n, g: g / n, b: b / n } : null
    } catch (_) {
      return null
    }
  }
```

Finally, update the `draw()` JSDoc: `@param {object|null} [opts.head] - head ellipse in video pixel space, to mask` and `@param {HTMLCanvasElement|null} [opts.video] - frame buffer, for the fill colour sample only`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/detection/overlay.test.js`
Expected: PASS.

Then the whole suite: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/detection/overlay.js src/detection/overlay.test.js
git commit -m "Draw an opaque head occluder instead of a blurred patch"
```

---

### Task 6: Session stamp and detail-view wording

**Files:**
- Modify: `src/ui/SessionDetailView.js:174-186` — `_renderRedactionNote()`
- Modify: `src/core/session.test.js:360-380` — the redaction-stamp tests

**Interfaces:**
- Consumes: `Overlay.redactionMode` → `'mask1'` from Task 5.
- Produces: no new exports. `SessionRecorder`, `sync.js` and `storage.js` are **unchanged** — `face_redaction` already maps both ways in `sessionToRow`/`rowToSession`.

- [ ] **Step 1: Write the failing test**

In `src/core/session.test.js`, replace the three tests around lines 360–380 with:

```js
  it('stamps the redaction mode the device actually used', () => {
    const recorder = new SessionRecorder()
    recorder.setContext('knee', 'right', 'prone', 'mask1')
    recorder.start()
    recorder.record(10)
    expect(recorder.stop().faceRedaction).toBe('mask1')
  })

  it('leaves faceRedaction null when no mode was supplied', () => {
    const recorder = new SessionRecorder()
    recorder.setContext('knee', 'right', 'prone')
    recorder.start()
    recorder.record(10)
    expect(recorder.stop().faceRedaction).toBeNull()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/session.test.js`
Expected: PASS actually — `setContext` is value-agnostic, so this step only re-points the existing coverage. Confirm the two old `'blur1'`/`'solid1'` tests are gone and no test still asserts those strings:

Run: `npx vitest run src/core/session.test.js && grep -rn "blur1\|solid1" src/`
Expected: the grep prints nothing.

- [ ] **Step 3: Implement the detail-view change**

In `src/ui/SessionDetailView.js`, replace `_renderRedactionNote()`'s docblock and body:

```js
  /**
   * State the redaction status of the frames above. Worth saying explicitly
   * because the answer differs between sessions, and nothing in the image
   * itself makes that obvious at a glance.
   *
   * TWO BRANCHES, NOT FOUR. The earlier 'blur1' and 'solid1' branches are gone
   * along with the blur itself. Any surviving 'blur1' session therefore falls
   * into the conservative branch below, which is the right way for this to be
   * wrong: that blur was measured on-device as displaced and barely effective,
   * so claiming it worked would put a false statement in a patient record —
   * exactly what this feature exists to prevent.
   *
   * `faceRedaction` is a session-level pipeline flag, not a per-frame content
   * assertion — it records that the redaction pipeline was active during
   * capture, not that a head was masked in every frame (a session can
   * legitimately run entirely with the head off-frame, e.g. ankle work, and
   * still stamp 'mask1'). Worded around the pipeline rather than the pixels for
   * that reason.
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
    const masked = s.faceRedaction === 'mask1'
    note.textContent = masked
      ? 'Head masking active at capture'
      : 'Head not masked — captured before head masking was added'
    note.classList.toggle('unredacted', !masked)
  }
```

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/SessionDetailView.js src/core/session.test.js
git commit -m "Stamp mask1 and collapse the redaction note to two branches"
```

---

### Task 7: End-to-end uniformity check

**Files:**
- Modify: `scripts/e2e/verify.mjs:304-441` — the redaction checks

**Interfaces:**
- Consumes: `faceRedaction === 'mask1'` from Task 6; the opaque occluder from Task 5.
- Produces: no exports. `gridFor()` is reused unchanged.

- [ ] **Step 1: Replace the redaction checks**

The existing `gridFor()` metric — mean absolute difference between horizontally adjacent pixels — is exactly the right measure for an opaque fill: a solid region reads at JPEG-noise level, near zero. Keep the function; replace what is asserted about it.

Delete the block from the `// Redaction smoke test.` comment through the end of the head-vs-body `if (smooth) { ... }` block (roughly lines 304–423), and replace with:

```js
    // REDACTION CHECK — uniformity, not relative smoothness.
    //
    // This replaces a head-vs-body comparison that the blur forced on us. The
    // obvious formulation ("head is smoother than the frame median") was
    // unsatisfiable: roughly half this fixture is flat sky and ocean, dragging
    // the median to ~0.8, while a genuinely blurred face measured 1.3-3.8. The
    // only way to pass a median-relative ceiling was for the blur to land ON
    // the sky — precisely the bug the check existed to catch.
    //
    // An opaque occluder makes the assertion absolute instead of comparative.
    // A solid fill has NO internal texture, so its cells read at JPEG-noise
    // level. That is a property of the redaction itself, not of how it compares
    // to its surroundings, and nothing about the sky can satisfy it while the
    // body cells stay textured.
    //
    // HEAD CELLS ARE FIXTURE-SPECIFIC. At the stored resolution of 430x644 with
    // a 12x12 grid (cell 35x53px) the head sits at columns 4-6, rows 4-5;
    // column 6 is excluded because it is dominated by the sharp hairline and
    // collar just outside the mask. RE-MEASURE if scripts/e2e/fixture.mjs or
    // the source photo changes: rerun with E2E_DIAG=1, open
    // .fixtures/peak-analysed.png, grid-overlay a candidate block and confirm
    // by eye that it sits on the mask.
    const HEAD_CELL_GX = [4, 5]
    const HEAD_CELL_GY = [4, 5]
    const BODY_CELL_GX = [4, 5, 6, 7]
    const BODY_CELL_GY = [8, 9]        // torso/legs — always sharp, never masked

    // An opaque fill measured through JPEG at quality 0.78. Cells that overlap
    // the feather band or the outline read higher, so the assertion is on the
    // FLATTEST head cell, which is pure core.
    const UNIFORM_MAX  = 1.0
    // Proves the frame is a real photo and not a blank canvas — without this,
    // an all-black snapshot would pass the uniformity test triumphantly.
    const TEXTURED_MIN = 3.0

    if (!smooth) {
      fail('could not read the peak snapshot back for redaction check')
    } else {
      const cellsOf = (gxs, gys) => {
        const out = []
        for (const gy of gys) for (const gx of gxs) out.push(smooth.grid[gy][gx])
        return out
      }
      const headCells = cellsOf(HEAD_CELL_GX, HEAD_CELL_GY)
      const bodyCells = cellsOf(BODY_CELL_GX, BODY_CELL_GY)
      const headMin   = Math.min(...headCells)
      const bodyMean  = bodyCells.reduce((a, b) => a + b, 0) / bodyCells.length

      const dumpGrid = () => info('grid (row=gy, col=gx):\n' +
        smooth.grid.map((row) => row.map((v) => v.toFixed(1).padStart(5)).join(' ')).join('\n'))

      if (headMin < UNIFORM_MAX) {
        pass(`head region is a uniform opaque mask (flattest head cell ${headMin.toFixed(2)}, ` +
             `required < ${UNIFORM_MAX})`)
      } else {
        dumpGrid()
        fail(`head region is NOT masked — flattest head cell (gx ${HEAD_CELL_GX}, ` +
             `gy ${HEAD_CELL_GY}) is ${headMin.toFixed(2)}, required < ${UNIFORM_MAX}. ` +
             `Rerun with E2E_DIAG=1 to dump the grid and export the snapshot.`)
      }

      if (bodyMean > TEXTURED_MIN) {
        pass(`snapshot is a real photograph (sharp body detail ${bodyMean.toFixed(1)})`)
      } else {
        dumpGrid()
        fail(`snapshot has no sharp detail anywhere — body cells mean ${bodyMean.toFixed(1)}, ` +
             `required > ${TEXTURED_MIN}. The uniformity check above is meaningless ` +
             `if the whole frame is flat.`)
      }
    }
```

Then update the stamp assertion (around line 426):

```js
    // Redaction mode reached the record.
    if (s.faceRedaction === 'mask1')
      pass(`session stamped faceRedaction=${s.faceRedaction}`)
    else fail(`session faceRedaction is ${JSON.stringify(s.faceRedaction)}, expected "mask1"`)
```

And the by-eye hint near line 440:

```js
    info('check by eye: the head is fully masked in both frames, opaque core, no sharp rim')
```

- [ ] **Step 2: Run the harness**

Run: `npm run verify:e2e`
Expected: PASS on every check, including the two new ones. Takes a few minutes.

If the head-cell check fails, do **not** widen `UNIFORM_MAX` first — rerun with diagnostics and look at where the mask actually landed:

Run: `E2E_DIAG=1 npm run verify:e2e`
Then open `scripts/e2e/.fixtures/peak-analysed.png` and confirm the mask is on the head. Only re-derive `HEAD_CELL_GX`/`GY` from the dumped grid if the mask is correctly placed and the cells are simply in the wrong spot.

- [ ] **Step 3: Commit**

```bash
git add scripts/e2e/verify.mjs
git commit -m "Assert the head region is a uniform opaque mask end-to-end"
```

---

### Task 8: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — the **Face redaction** section

**Interfaces:**
- Consumes: everything above. Produces: no code.

- [ ] **Step 1: Rewrite the Face redaction section**

The existing section documents the blur in detail — the scratch canvas, the dpr/CTM reasoning, `blur1`/`solid1`, `COVERAGE_MARGIN` tuning against blur, and the e2e's head-vs-body comparison. All of that is now wrong. Rewrite it to describe:

- `headRegion()` returning an **oriented ellipse**; the containment invariant in its elliptical form, and specifically that the growth factor is `max(1, t × COVERAGE_MARGIN)` — with the margin **inside** the `max`, so the heuristic floor still wins outright where it already over-covers.
- `MAX_RADIUS_FRACTION` still applied last to both axes and still overriding containment.
- Motion expansion in `pose.js`: why it exists (10Hz detection + inference vs a 30fps video element ≈ 150 ms ≈ one head radius of drift), that `_prevHead` stores the **raw** region so growth cannot compound, and that it is cleared when the pose is lost.
- The occluder itself: opaque core to the containment boundary, feather and outline strictly outside it, one averaged colour bounded to 64 samples and EMA-smoothed. **No patch is sampled and no Canvas 2D filter is used** — which is what deletes the whole class of silent failures the blur had, including the `_filterSupported` branch that had no automated coverage.
- `faceRedaction` is `'mask1'`; `'blur1'`/`'solid1'` no longer exist and any surviving session falls into the "not masked" branch on purpose.
- The e2e check is now absolute uniformity plus a textured-body sanity check, and **why the old median formulation does not work here** — keep that warning, it is still true and still worth not re-deriving.
- Keep verbatim: the three load-bearing constraints in `headRegion.js` (position with no visibility threshold, fully opaque, degrade to opaque rather than to nothing), the "one value, everywhere" rules, the frame-buffer rule, and **"This is not de-identification."**

Delete: the entire "**The blur is applied on the scratch canvas, not the overlay canvas**" paragraph, the `BLUR_RADIUS_FACTOR` reference, and the claim that `sFace` no longer decides the radius at `COVERAGE_MARGIN = 1.60` — the seeded-ellipse form makes `sFace` load-bearing again through the seed, and Task 1 pins it.

- [ ] **Step 2: Verify the claims**

Run: `npm test`
Expected: PASS. Cross-check each numeric claim you wrote against the constants actually in `src/core/headRegion.js` — the previous version of this section drifted from the code in exactly this way.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Document the head occluder that replaced the face blur"
```

---

## After the plan

**Device verification is required before merge.** Three things have no automated coverage and the last release shipped broken precisely because they were not checked on hardware:

1. The occluder is on the head, opaque, and the feather does not reveal the face — live preview *and* stored snapshot.
2. Motion expansion keeps up during a fast sweep. Screenshot the live preview mid-sweep, the same way this defect was found.
3. Frame-rate cost of the per-tick frame blit (pre-existing, still unmeasured).

**Then delete the old `'blur1'` sessions** through the app's SessionDetail **Delete** button. This is deliberately manual — a migration that deletes patient records is a larger risk than the ambiguous records it would clean up. Deletion already removes the Storage objects alongside the row.

**Still out of scope:** `angleFilter` and `angleConvention` are mapped in neither `sessionToRow` nor `rowToSession` (`src/core/sync.js`), so a cloud pull silently strips them. Real, pre-existing, and still its own PR.
