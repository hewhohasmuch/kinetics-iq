# Face redaction in session snapshots

**Date:** 2026-08-05
**Status:** Approved design, not yet implemented

## Problem

KineticsIQ stores two JPEG snapshots per session — the peak and minimum frames — in
IndexedDB and, when cloud sync is configured, in the private `session-images` bucket.
Those images currently contain the patient's face.

## What this does and does not achieve

**This does not de-identify the record, and does not remove it from HIPAA's scope.**

"Full-face photographic images and any comparable images" is one of the eighteen Safe
Harbor identifiers in 45 CFR 164.514(b)(2). De-identification under Safe Harbor requires
removing *all* eighteen, and it fails outright where the covered entity has actual
knowledge that the information could identify the individual. KineticsIQ snapshots are
stored against a `patient_id` that resolves to a named patient, carry a session date, and
sit under an identified clinician's account. The linkage is the identifier; a faceless
photo in a row labelled with a patient name and a date of service is still PHI.

Compliance is carried by the surrounding controls, not by this feature: a signed BAA with
Supabase, encryption in transit and at rest, access control, audit logging, and breach
procedures. The existing RLS scoping and private bucket are part of that story.

**What this feature is for is data minimisation and breach-severity reduction.** If a
storage object leaks, an anonymous knee is a materially smaller incident than a
recognisable patient. That is the whole of the claim being made here, and no
documentation, UI copy, or commit message should describe it as anonymisation or
de-identification.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scope of redaction | Blur the head region only; keep the photographic frame | Preserves the clinical value of the snapshot — real limb position, body habitus, measurement setup |
| Confidence handling | Blur on landmark **position**, ignore `visibility` | A confidence threshold silently no-ops in exactly the hard cases (backlit, prone face-down, occluded). Over-blurring costs nothing: the head is never the joint being measured |
| Live preview | Blurred as well as the snapshot | Makes the redaction verifiable before recording, rather than discovered in the patient record afterwards |
| Redaction style | Gaussian blur, radius scaled to head size | Equally destructive at any camera distance. A fixed pixel radius under-blurs a close-up head |
| Existing stored images | Out of scope | See [Out of scope](#out-of-scope) |

## Architecture

`MeasureView._captureFrameTo()` builds a snapshot by drawing the raw video frame and then
compositing the overlay canvas on top of it. The redaction is therefore drawn **into the
overlay canvas**: the live preview shows it because the overlay sits over the video
element, and the snapshot inherits it because the snapshot composites that same canvas.

One code path produces both surfaces, so they cannot diverge. This is the pixel-level form
of the "one value, everywhere" rule the codebase already enforces for the angle.

Two alternatives were considered and rejected:

- **Blur separately in the live loop and in `_captureFrameTo()`** — two implementations of
  one guarantee, where a bug in the capture-side copy is invisible during use.
- **Blur once at encode time in `_encodeCapture()`** — cheapest per frame, but provides no
  live verification and requires stashing a head region alongside each retained extreme
  canvas, reintroducing a second source of truth.

### Data flow

```
PoseDetector.detect(videoElement)
  → headRegion(landmarksNorm, videoW, videoH)   [new: pure geometry, video pixel space]
  → detect() returns { markers, allFound, foundIds, head }
  → Overlay.draw(markers, interiorAngle, { joint, labelAngle, head, video })
      → redaction drawn FIRST, immediately after clear()
      → then dots, bones, arc, angle label on top
  → MeasureView._captureFrameTo()  [composites the already-redacted overlay]
```

## Component 1 — `src/core/headRegion.js` (new)

Pure geometry, no DOM. Belongs in `src/core/` under the existing separation-of-concerns
rule and is fully unit-testable in Node.

```js
headRegion(landmarksNorm, videoW, videoH) → { cx, cy, r } | null   // video pixel space
```

`landmarksNorm` is MediaPipe's normalised (0–1) landmark array — the same `lmNorm` that
`PoseDetector.detect()` already holds.

### Why not a padded bounding box

Bounding the face landmarks (0–10: nose, eyes, ears, mouth) and padding has two failure
modes:

1. **Those landmarks cover the face, not the skull.** They span the eye line down to the
   mouth. The cranium and hair sit above the topmost landmark, so a tight box leaves the
   top of the head sharp.
2. **The box collapses in profile.** Turned side-on — common for knee and hip work — the
   ears and nose stack up in x and the box badly under-estimates head size. The radius
   would shrink exactly where someone is still recognisable.

### Algorithm

Let `F` = the eleven face landmarks (indices 0–10) in video pixel space, and `S` = the
midpoint of the shoulder landmarks (11, 12).

1. `faceCentroid` = mean of `F`.
2. `up` = unit vector from `S` toward `faceCentroid` — the shoulders→head axis.
3. Two independent scale estimators, take the larger:
   - `sFace` = diagonal of the bounding box of `F`
   - `sTorso` = `TORSO_SCALE_COEFF × |faceCentroid − S|`
   - `s = max(sFace, sTorso)`
4. `r = clamp(HEAD_RADIUS_FACTOR × s, 0, MAX_RADIUS_FRACTION × min(videoW, videoH))`
5. `centre = faceCentroid + up × (CRANIUM_NUDGE × r)`
6. Return `null` if the circle does not intersect the frame rectangle at all; otherwise
   `{ cx, cy, r }`.

`sTorso` is rotation-invariant — it is a distance, not a projection — so it holds up prone,
supine, seated, or side-on. It is what prevents the profile collapse. Using `up` rather
than screen-up for the cranium nudge is what makes step 5 correct for a patient lying down
with the camera at any rotation.

No `visibility` threshold is applied anywhere in this function. `null` is returned in
exactly one circumstance: there is no head in the picture to redact.

### Constants

Named exports, deliberately tuned to over-cover. **These are starting values** — they are
to be tuned against the e2e fixture and on-device, not treated as derived truth.

| Constant | Value | Meaning |
|---|---|---|
| `HEAD_RADIUS_FACTOR` | `0.85` | Radius as a multiple of `s`. Yields a radius ≈ one head-width, i.e. a diameter of roughly two head-widths over a head ~1.3 head-widths tall |
| `TORSO_SCALE_COEFF` | `0.70` | Chosen so `sTorso` ≈ `sFace` in a frontal view, letting the torso estimator take over as the face box collapses toward profile |
| `CRANIUM_NUDGE` | `0.35` | Centre offset along `up`, as a fraction of `r` |
| `MAX_RADIUS_FRACTION` | `0.50` | Sanity cap against a garbage landmark frame blurring the whole image |

## Component 2 — `src/detection/pose.js`

`detect()` currently discards every landmark except the three joint roles. It gains one
line: call `headRegion(lmNorm, vw, vh)` and return the result as `head` on the existing
return object. `head` is `null` when no pose is detected at all, matching the existing
empty-marker early return.

## Component 3 — `src/detection/overlay.js`

`draw()` accepts `opts.head` and `opts.video`, and draws the redaction **immediately after
`clear()`** — before dots, bones, arc, and label. Overlay graphics therefore sit on top of
the blur, which matters for shoulder measurements where the joint dot is close to the head.

### Draw sequence

1. Map the region's centre and radius through the existing `_toDisplay()` / `_scale`
   transform into display CSS pixel space.
2. Blit a **padded** square of video around the head into a persistent scratch canvas.
   Padding = `2 × blurRadius`.
3. On the overlay context: `save()` → circular `clip()` at the true radius →
   `filter = blur(<blurRadius>px)` → draw the scratch → `filter = 'none'` → `restore()`.

A canvas `blur()` filter fades to transparent at the **source image's** edges. Padding the
scratch by twice the blur radius puts that soft edge outside the clip, so the circle comes
out uniformly opaque and no sharp face pixels leak around its rim.

The scratch canvas is allocated once and reused. A fresh canvas per frame at 10Hz is
needless GC churn.

`BLUR_RADIUS_FACTOR = 0.35`, applied to the display-space radius, so blur strength scales
with head size automatically.

### Three silent-failure risks, each designed against

**`ctx.filter` must be feature-detected.** Safari only gained canvas filter support in
Safari 17. Where it is unsupported, assigning `ctx.filter` silently leaves it `'none'`, so
step 3 would draw a perfectly *sharp* copy of the face and look entirely deliberate.
Detect once at `attach()` by assigning a blur and reading the property back. If
unsupported, branch **before** drawing the scratch and fill the clipped circle with an
opaque colour instead. The degradation is blur → solid redaction, never blur → nothing.

**The redaction must be drawn fully opaque.** The existing helpers in this file set
`globalAlpha` freely (0.85, 0.9, 0.8) and restore it inconsistently. Any residual
transparency leaks the sharp face straight through, in the snapshot and the live view
alike, since both put this canvas over raw video pixels. Set `globalAlpha = 1` explicitly
rather than assuming it.

**`draw()` early-returns when no markers are found** (`overlay.js:129`). The redaction must
happen *before* that return. Otherwise losing the joint landmarks mid-session — patient
shifts, limb leaves frame — un-blurs the live preview at exactly the moment the clinician
is looking at the screen to fix it.

### Accepted limitation

If MediaPipe detects no pose at all, `detect()` bails before any landmarks exist, so there
is no region and the live preview stays sharp. This is tolerable because snapshot capture
requires `allFound` **and** an active recording, so nothing un-redacted can reach storage
in that state. It is a preview-only gap.

## Component 4 — session record

Following the existing `angleMode` / `angleFilter` / `angleConvention` convention, which
stamps sessions whenever a change alters what was recorded so old and new records are never
silently compared.

- **`faceRedaction`** on the session: `'blur1'`, or `'solid1'` where the device fell back
  to the opaque circle. The stamp records what the device **actually did**, not what was
  intended, so a device without `ctx.filter` support is legible in the record rather than
  misfiled as blurred.
- **Absent means not redacted** — every existing session — matching how the other stamps
  degrade.

### Precise meaning of the stamp

The stamp asserts that **the redaction pipeline was active for this session**. It does
**not** assert that a face was blurred in every frame: where the head is out of shot there
is nothing to blur. This distinction is written down because the field is a privacy claim
and will be read as one later.

### Plumbing

| File | Change |
|---|---|
| `src/core/session.js` | Add `faceRedaction` to the session object |
| `src/core/sync.js` | Map `faceRedaction` ↔ `face_redaction` in both directions |
| `supabase/schema.sql` | Add the `face_redaction` column |
| `supabase/migrations/0002_face_redaction.sql` | New — for the existing project, following the `0001_session_images.sql` precedent |
| `src/ui/SessionDetailView.js` | Small indicator on the snapshot figure |
| `src/ui/MeasureView.js` | Pass `head` and the video element into `overlay.draw()`; read the redaction mode actually in use from `Overlay` (blur vs. solid fallback) and pass it into `SessionRecorder.setContext()` so the stamp reflects the device's real behaviour |
| `CLAUDE.md` | Document the redaction path and the stamp |

## Testing

### Unit — `src/core/headRegion.test.js` (new)

The geometry is pure and the interesting cases are cheap to express as landmark fixtures:

- Frontal pose — region covers the full head including cranium.
- **Profile pose — the radius does not collapse.** This is the failure the two-estimator
  `max` exists to prevent, so it is pinned directly: for the same subject at the same
  distance, the profile radius is at least `0.8 ×` the frontal radius.
- Rotated / prone pose — the cranium nudge points away from the shoulders, not up the
  screen.
- Head fully off-frame → `null`.
- Head partially off-frame → non-null.
- Garbage landmarks → radius hits `MAX_RADIUS_FRACTION`.

### Unit — existing suites

- `src/core/session.test.js` — `faceRedaction` default.
- `src/core/sync.test.js` — `face_redaction` round-trips in both mappers.

### End-to-end — `scripts/e2e/verify.mjs`

The harness already drives a real pose photo through a fake camera. After a run it measures
**high-frequency energy** — mean absolute difference between neighbouring pixels — inside
the head region of the saved snapshot versus a control patch elsewhere in the frame. A
genuine blur drops it by roughly an order of magnitude.

This single assertion catches the whole class of silent failures at once: unsupported
`ctx.filter`, an alpha leak, redaction drawn in the wrong order, or a region computed
somewhere daft. The fixture photo is fixed, so the expected head area is hardcoded for that
image.

### Not tested

`src/ui/` has no unit tests, consistent with the rest of the repo. The `MeasureView` and
`Overlay` wiring is covered end-to-end and verified on-device. CLAUDE.md is explicit that
changes to `_runDetection()` are verified by running the app, not by reasoning about the
diff — that applies here, including the per-frame cost of the extra blit and filtered draw.

## Out of scope

- **Retroactively redacting existing stored snapshots.** They were captured without
  redaction, and the session records do not retain the landmarks needed to locate the face
  afterwards. Doing it properly means re-running MediaPipe in IMAGE mode over each stored
  JPEG — a second pipeline with its own failure modes. The `faceRedaction` stamp keeps old
  and new unambiguous in the meantime, so this remains a clean separate decision.
- **Bulk deletion of existing snapshots.** Considered as a cheap alternative to the above;
  deferred with it.
- **Redacting anything other than the head** — tattoos, jewellery, scars, clothing.
- **HIPAA compliance controls generally** — BAA, audit logging, access review. Named here
  only to be clear that this feature does not substitute for them.
