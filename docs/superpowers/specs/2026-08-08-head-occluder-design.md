# Head occluder — replacing the snapshot face blur

**Date:** 2026-08-08
**Status:** Approved design, not yet implemented
**Supersedes the rendering half of:** `2026-08-05-face-blur-design.md`

## Problem

Face redaction shipped as PR #15 on 2026-08-07. On-device testing the next evening showed
it does not work. Two captures were taken:

- **`tmp/blur1.jpg`** — a live-preview screenshot of a right-knee session. The redaction
  disc is drawn, but it sits roughly one head-radius to the right of the head, and the
  content inside it is legible: hair texture and the edges of a painting are visible where
  `BLUR_RADIUS_FACTOR = 0.35 × r` should have produced featureless mush. The patient's face
  is plainly readable in the screenshot.
- **`tmp/blur2.png`** — a SessionDetail view of a right-shoulder session with two entirely
  unredacted frames. This one is **not a defect**: the caption reads "Face not blurred —
  captured before redaction was added", which is `SessionDetailView.js:184`, the branch for
  a null `faceRedaction`. That session was recorded minutes before the phone picked up the
  new build. It is evidence of nothing except a service worker doing its job.

So the live defect is blur1, and it has two parts.

### Part 1 — the displacement is latency, not a coordinate bug

`DETECTION_HZ = 10` (`MeasureView.js:16`), so the overlay is redrawn every 100 ms, plus
BlazePose inference — call it 130–160 ms end to end. The `<video>` element underneath keeps
playing at 30 fps. The occluder is therefore positioned from where the head was ~150 ms ago
and composited over a video frame showing where it is now. A head crossing frame at walking
pace covers 80–90 px in that time, which is about one head radius. That is the offset in
blur1, and it needs no bug to explain it.

**The stored snapshot does not have this problem.** `_captureFrameTo()` draws the buffered
`frame` and then the overlay canvas over it (`MeasureView.js:1147-1156`) — the same frame
detection ran on. Preview and snapshot diverge here precisely because the preview is the one
surface that is *not* built from the buffer.

It still matters. It is what made the feature look broken, and a preview screenshot is a
real leak path — `blur1.jpg` is one.

### Part 2 — the blur silently failed to land

The exact cause is not established, and cannot be from a JPEG of a moving subject. What is
established is that it *can* fail invisibly. The blur path requires six things to be
simultaneously correct:

1. the source rect mapped from display space back into video space,
2. the scratch canvas sized in device pixels,
3. the blur radius scaled by `dpr`,
4. the opaque pre-fill under the blurred draw,
5. `padding = 2 × blurRadius` keeping the filter's transparent fade outside the clip,
6. Canvas 2D `filter` actually taking effect.

Five of those cannot be verified headless. All six shipped green. And when one fails, the
session still stamps `'blur1'`, the detail view still says "Head redaction active at
capture", and the face is still legible. `overlay.js:248` names this as "the worst failure
mode this feature has". It is what happened.

**This design removes the failure modes rather than debugging them.**

## What this does and does not achieve

Unchanged from the prior spec, and worth restating because nothing here improves it: **this
is not de-identification.** The images stay linked to a named patient and a date of service,
so they remain PHI under 45 CFR 164.514(b)(2) regardless of what covers the head. This is
data minimisation and breach-severity reduction. No documentation, UI copy, or commit
message should describe it as anonymisation.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Redaction mechanism | **Opaque occluder**, no blur | Every failure in blur1 is a sampling or filter failure. An occluder samples no patch and applies no filter, so neither can happen. It also cannot degrade silently: it either drew or it did not, and that is visible at a glance |
| Shape | Ellipse on the shoulders→head axis | Follows head shape; reads as intentional UI rather than as a smudge |
| Fill | One colour averaged from outside the shape, temporally smoothed | Settles into the background instead of punching a hole. A single averaged colour carries no recoverable facial detail |
| Edge | Opaque core to the containment radius, feathered beyond it, thin outline | **The softening lives entirely outside the opaque core**, over background pixels that were never part of the head. Appearance and guarantee are decoupled — which is exactly what the blur gave up |
| Preview drift | Grow the shape by head displacement since the last detection | Covers the swept path rather than a stale point. Zero when the patient is still. Costs no preview smoothness |
| Preview rendering | Keep the live `<video>` at 30 fps | The alternative — drawing `_frameCanvas` to screen each tick — is airtight but drops the preview to 10 fps, which is worse for aiming the camera at a patient |
| Legacy `'blur1'` sessions | Delete them; drop the branch | A day old, all test sessions on the developer, and their redaction is of unknown effectiveness. Carrying an ambiguous claim in a patient record is worse than carrying none |

## Architecture

The structural invariants from PR #15 all survive, because none of them was the problem:

- `headRegion()` locates the head from face **and** shoulder landmarks, on **position only**,
  with no visibility threshold.
- Containment is an invariant, not a hope: every face landmark provably inside the shape.
- `MAX_RADIUS_FRACTION` is applied **last** and wins, so a garbage landmark frame cannot
  blank the picture. Containment holds only while uncapped.
- `headResolved` (`pose.js`) gates **capture**, never extreme *tracking* — tracking must
  match `recorder.record()` every frame or `session.max`/`min` and the retained snapshot
  describe different frames.
- One video read per tick into `_frameCanvas`, shared by `detect()`, `overlay.draw()` and
  `_captureFrameTo()`.
- The redaction is drawn into the **overlay canvas**, before the no-markers early return,
  and the snapshot composites that same canvas. One code path, both surfaces.

### Data flow

```
PoseDetector.detect(frameCanvas)
  → headRegion(lmNorm, vw, vh)            [pure: oriented ellipse, video pixel space]
  → expandForMotion(region, prevRegion)   [pure: grow by inter-frame displacement]
  → { head, headResolved }
      ↓
Overlay.draw(markers, angle, { head, video: frameCanvas })
  → _drawRedaction(head, frameCanvas)     [neutral colour sample → opaque ellipse → feather → outline]
  → landmark dots, bones, arc, label
      ↓
MeasureView._captureFrameTo()             [frameCanvas + overlayCanvas → retained extreme]
```

## Component 1 — `src/core/headRegion.js`

`headRegion()` returns an oriented ellipse instead of a circle:

```js
{ cx, cy, rAcross, rAlong, ux, uy }   // centre, semi-axes, unit shoulders→head axis
```

`ux, uy` is the existing `upX/upY`, already computed and already rotation-invariant — which
is what makes this work for a patient lying down with the camera at any rotation.

**Containment becomes elliptical.** The order matters, and is the same order the circle
version used — centre first, because containment is measured *from* it:

1. Compute `scale = max(sFace, sTorso)` and `rHeuristic = min(HEAD_RADIUS_FACTOR × scale, maxR)`
   exactly as today.
2. Place the centre at `face centroid + u × (CRANIUM_NUDGE × rHeuristic)`.
3. Seed the semi-axes from the heuristic: `rAcross = ELLIPSE_ACROSS × rHeuristic`,
   `rAlong = ELLIPSE_ALONG × rHeuristic`.
4. Project each face landmark into the ellipse's local frame (onto `u` and its
   perpendicular) and compute `t = max over landmarks of √((across/rAcross)² + (along/rAlong)²)`.
   This is the factor by which the seeded ellipse must grow to contain every one of them.
5. Scale **both** semi-axes by `max(1, t) × COVERAGE_MARGIN`. Scaling both by the same factor
   is what preserves the head-shaped aspect ratio; scaling them independently would let a
   profile pose flatten the ellipse into the exact under-estimate the circle version was
   designed to avoid.
6. Apply the `MAX_RADIUS_FRACTION` cap **last**, to both axes.

Same invariant, same reason: MediaPipe's eleven face landmarks bound the *face*, while the
cranium, hairline and back of the head have no landmarks of their own, so only the margin can
reach them. And as before, containment is guaranteed only while the cap is not biting.

**`sFace` and `HEAD_RADIUS_FACTOR` are kept and renamed**, resolving deferred item 2 from
PR #15 honestly. They no longer decide the radius — containment out-reaches them in every
realistic pose — but they still do two real jobs: placing the centre via `CRANIUM_NUDGE`, and
acting as the floor when the face landmarks give no spread at all (occlusion, or the subject
far from camera). The floor case gets its own test so the term stops looking dead.

**New pure helper, same module:**

```js
expandForMotion(region, prevRegion, gain = MOTION_GAIN) → region
```

Grows both semi-axes by `gain × |centre − prevCentre|`. Returns `region` unchanged when
`prevRegion` is null or the displacement is zero. Still subject to `MAX_RADIUS_FRACTION`.

`redactionGeometry()` loses `blurRadius` and `padding` — both existed only to keep a blur's
transparent fade outside the clip circle. It becomes the display-space mapping of the ellipse
plus the feather and outline radii.

### Constants

| Constant | Value | Status |
|---|---|---|
| `HEAD_RADIUS_FACTOR` | 0.85 | kept — centre placement and floor only |
| `TORSO_SCALE_COEFF` | 0.70 | kept |
| `CRANIUM_NUDGE` | 0.35 | kept |
| `MAX_RADIUS_FRACTION` | 0.50 | kept — applied last, still wins |
| `COVERAGE_MARGIN` | 1.60 | kept |
| `ELLIPSE_ACROSS` | 0.92 | new — seed semi-axis across the head axis, as a multiple of `rHeuristic` |
| `ELLIPSE_ALONG` | 1.14 | new — seed semi-axis along it |
| `FEATHER_EXTENT` | 1.35 | new — multiple of the **final** semi-axes; core stays opaque to 1.00 |
| `OUTLINE_AT` | 1.04 | new — multiple of the final semi-axes |
| `MOTION_GAIN` | 1.0 | new |
| `BLUR_RADIUS_FACTOR` | — | **deleted** |

The three ellipse/feather values are starting points taken from a mockup rendered onto a real
stored snapshot, not derived. Re-tune them the same way the coverage margin was tuned:
`E2E_DIAG=1 npm run verify:e2e`, then open `.fixtures/peak-analysed.png` and look.

## Component 2 — `src/detection/pose.js`

`detect()` holds the previous head region on the detector and applies `expandForMotion()`
before returning. Motion state belongs here rather than in `MeasureView` because `src/ui/`
has no unit tests, and this is logic that needs pinning.

`headResolved` is unchanged:

```js
headResolved = headInputsFinite(lmNorm) && (head !== null || !anyFaceLandmarkInFrame(lmNorm, vw, vh))
```

Its two reasons still hold exactly as documented — a dropped pose replays the filters' last
angle while no redaction was drawn (leak), and ankle framing legitimately runs a whole session
with the head off-frame (must stay capturable). The previous region is cleared when the pose
is lost, so motion expansion never carries a stale displacement across a gap.

## Component 3 — `src/detection/overlay.js`

Deleted: `_scratch`, `_getScratch()`, `_detectFilterSupport()`, `_filterSupported`,
`REDACTION_FILL`, and the entire blur/solid branch. The `dpr`/CTM reasoning in the current
`_drawRedaction` docblock goes with them — with no filter in play, the question it agonises
over does not arise.

`_drawRedaction(head, frame)` still takes the frame, but only to compute **one colour**:

- Average the pixels of a ring just outside the ellipse, sampled at a **fixed ≤64 points**
  via a downscaled draw, so cost is constant regardless of video resolution.
- Smooth it across frames (EMA) so the fill does not flicker.
- Fall back to a fixed neutral if the sample is unavailable.

Then draw, in order: opaque ellipse to the containment radius → feather from there to
`FEATHER_EXTENT` → outline at `OUTLINE_AT`.

`ctx.globalAlpha = 1` is still set explicitly before drawing. That reason is unchanged: the
helpers in this file leave `globalAlpha` dirty, and a translucent redaction leaks the sharp
face straight through, in the snapshot and the live view alike.

**The opaque core must remain opaque.** The feather is what makes this look deliberate rather
than brutal, and it is safe only because it lies outside a core that already contains every
face landmark. Do not implement the feather as a gradient that starts at the centre.

## Component 4 — session record and detail view

`SessionRecorder.setContext(..., faceRedaction)` receives `'mask1'`.
`Overlay.redactionMode` becomes a constant `'mask1'` — there is no device-dependent fallback
left to report.

`SessionDetailView._renderRedactionNote()` collapses to two branches:

```
'mask1'  → "Head masked at capture"
anything → "Face not masked — captured before head masking was added"   [.unredacted styling]
```

The `'blur1'` and `'solid1'` branches are removed. Any `'blur1'` session that survives
somewhere therefore falls into the conservative branch, which is the right way for this to be
wrong.

`sync.js` already maps `face_redaction` in both `sessionToRow` and `rowToSession`, so the new
value needs no plumbing. (The separate `angleFilter`/`angleConvention` sync gap is untouched —
see Out of scope.)

## Component 5 — retiring the existing `'blur1'` sessions

A manual step, not a migration. The affected sessions are a day old and were captured on the
developer, not on patients. Delete them through the app's existing SessionDetail **Delete**,
which already removes the Storage objects alongside the row. No code runs against them, and no
automated deletion is written — a migration that deletes patient records is a far larger risk
than the records it would clean up.

## Testing

### Unit — `src/core/headRegion.test.js`

Containment is re-pinned in the elliptical metric for all four existing fixtures — frontal,
profile, close-framed profile, prone. Each assertion in that file exists to reject a specific
wrong implementation; before changing a bound, check what mutation it catches (force
`scale = sTorso`, force `scale = sFace`, drop the containment term, drop the heuristic floor)
and confirm the replacement still fails.

New:

- the heuristic floor holds when face landmarks give no spread at all,
- `MAX_RADIUS_FRACTION` still overrides containment on a garbage frame,
- `expandForMotion` returns the region unchanged when still, and covers both centres when
  moving,
- expansion is still subject to the cap.

### End-to-end — `scripts/e2e/verify.mjs`

The redaction check stops being a heuristic. Today it compares head cells against sharp body
cells — a formulation forced on it because a whole-frame median is dragged to ~0.8 by sky and
ocean, so the only way to satisfy a median-relative ceiling was to blur the sky.

With an opaque fill the assertion becomes a proof: **the core of the head region is a single
uniform colour.** Sample the core (inside the opaque radius, excluding the feather band) and
assert every pixel is within a small threshold of the mean. Nothing about the sky can satisfy
that. The head-cell coordinates stay fixture-specific — re-measure with `E2E_DIAG=1` if the
fixture changes.

### Closed by construction

Deferred item 1 from PR #15 — *"nothing pins that `_drawRedaction` consults `_filterSupported`;
a mutant that always takes the blur branch passes every test and emits a sharp face on Safari
< 17"* — is closed, because the branch no longer exists.

### Still needs a device

- The look of the occluder on a real phone screen.
- The frame-rate cost of the per-tick frame blit (pre-existing, unmeasured).
- That motion expansion actually keeps up during a fast sweep. Verify by screenshotting the
  live preview mid-sweep — the same way this defect was found.

## Out of scope

- **The angle pipeline is untouched.** No measured number changes, so `CALIBRATION_VERSION`,
  `angleConvention` and `angleFilter` all stay where they are. Redaction is drawn on the
  overlay, downstream of everything the ROM value is computed from; the only coupling to
  measurement is the frame blit's cost.
- **`angleFilter`/`angleConvention` are mapped in neither `sessionToRow` nor `rowToSession`**,
  so a cloud pull silently strips them and can downgrade a good session to a broken-looking
  one. Real, pre-existing, and still its own small PR — a privacy change should not absorb an
  unrelated data-integrity fix.
- Measurement accuracy and goniometer validation.
