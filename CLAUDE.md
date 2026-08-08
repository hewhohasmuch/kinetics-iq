# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # start dev server (HTTPS + LAN-accessible, required for camera on iPhone)
npm run dev:https    # alias — same as dev
npm run build        # vite build
npm test             # run Vitest unit tests (Node environment, no browser needed)
npm run verify:e2e   # drive the real app in Chromium against a fake camera (few minutes)
```

Run a single test file:
```bash
npx vitest run src/core/angle.test.js
```

To run the app in cloud mode locally, copy `.env.example` to `.env.local` and fill in `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. Without those set, the app runs local-only (no login, no sync) — see Accounts & cloud sync below. Apply `supabase/schema.sql` to a fresh project; for a project that predates cloud image sync, apply `supabase/migrations/0001_session_images.sql` instead (adds the `peak/min_frame_path` columns and the private `session-images` Storage bucket + RLS). Snapshot upload silently no-ops until that bucket exists.

`npm run verify:e2e` covers the part unit tests can't reach — camera start, MediaPipe detection, the overlay canvas, snapshot compositing, and what actually lands in localStorage. It builds a fake-camera y4m from a real pose photo (mirrored halfway through so the measured angle moves) and asserts, among other things, that the saved min/max are values the readout actually displayed. See `scripts/e2e/README.md`; add `--headed` to watch it. Headless Chromium runs BlazePose on CPU at ~2Hz rather than the app's 10Hz, so anything sensitive to the real frame rate still needs a device check.

For scripted scenarios the harness doesn't cover — cloud mode with a mock Supabase, login flows, other element ids — see the `verify` skill (`.claude/skills/verify/SKILL.md`).

## Architecture

**KineticsIQ** is a PWA that uses MediaPipe Pose and the phone rear camera to measure joint range of motion (ROM). Supports Knee, Hip, Shoulder, Elbow, and Ankle on left or right side. Primary target is iPhone Safari. HTTPS is mandatory — camera access is silently denied on HTTP.

### View routing (`src/main.js`)

Views are manually swapped by replacing `#app` innerHTML. No router library. Views are plain JS classes with `mount()` / `unmount()` lifecycle methods. The active view is tracked as `currentView`; `unmount()` stops the camera and clears the DOM before the next view mounts.

```
(if Supabase configured) Login → Patients → Measure → History → SessionDetail → (back) History → (back) Measure
                                     ↑___________________________________________________________________|
                                     (Measure's "switch patient" also routes back to Patients)
```

Without Supabase env vars, `boot()` skips Login entirely and the app behaves as it did before accounts existed. With Supabase configured, a cached auth session (persisted by supabase-js in localStorage) skips the login screen on return visits, including offline.

### Signal processing pipeline (`src/core/`, `src/detection/`)

Each detection frame at 10Hz follows this pipeline:

```
PoseDetector.detect(videoElement)   [MediaPipe BlazePose Full, CDN-loaded]
  → getJointPoints3D(markers) ?? getJointPoints(markers)  [prefer 3D world-space landmarks; fall back to 2D pixel points if any marker lacks world data]
  → jointAngle(proximal, joint, distal)  [interior angle at selected joint in degrees; uses x/y/z when present, reduces to 2D math otherwise]
  → toClinicalAngle(interior, joint)     [per-joint mapping to clinical degrees: 0° = neutral]
  → MedianFilter3.push()          [median of last 3 — rejects single-frame landmark glitches]
  → OneEuroFilter.push(v, t)      [adaptive smoothing: calm at rest, responsive when moving]
  → CalibrationManager.apply()    [subtract offset captured at "zero" position; SIGNED]
  → SessionRecorder.record()      [accumulate during active recording]
```

**Per-joint angle convention (`JOINT_ANGLE_CONVENTION` in `angle.js`).** There is no single formula from interior angle to clinical angle. `180 - interior` assumes the joint's neutral is collinear — true for knee/hip/elbow, false elsewhere:

| Joint | Landmarks | Neutral interior | Clinical mapping |
|---|---|---|---|
| Knee / Hip / Elbow | hinge, straight at neutral | 180° | `180 - interior` |
| Shoulder | elbow → shoulder → hip | ~15° (both vectors point *down*) | `interior` (arm elevation) |
| Ankle | shin midpoint → ankle → foot | 90° | `90 - interior` (dorsiflexion +) |

Applying the hinge rule globally **inverted the shoulder scale**: an arm at the side read 165° and an arm raised overhead read ~20°, which the UI then labelled "peak extension". `toInteriorAngle()` is the exact inverse, used by the overlay to draw its arc from the same smoothed value the readout shows.

Once the mapping stopped being one formula, "flexion" stopped being one word. **`JOINT_MOTION_TERMS` / `motionTerms(joint)`** (same file) names the motion in each direction — knee/hip/elbow flexion·extension, shoulder **elevation**·extension, ankle **dorsiflexion**·**plantarflexion** — and every user-facing string goes through it: the readout label, the SessionDetail snapshot captions and image `alt`, and the chart axis. It accepts the legacy combined `'shoulder_left'` form, since detail views look terms up straight off the saved record. The min-frame caption only uses the *negative* term when the value actually crossed zero; an un-zeroed shoulder resting at 24.6° of elevation is "Min elevation", not "Peak extension". Captions keep the signed value the overlay burned into the image — an `abs()` there would put two different numbers on one picture.

**Known limitation — the shoulder neutral is not 0.** `JOINT_ANGLE_CONVENTION.shoulder` declares `neutralInterior: 0`, but the anatomical neutral interior is ~15–25°, so raw shoulder readings sit that much high at rest. Worse, the landmark error is not constant across the range (about +25° at the bottom, about −15° at the top, where the shoulder landmark under-rotates at end range), and `CalibrationManager.apply()` is a single subtraction — so **Set Zero at the side over-corrects the top of the range**. Measured on-device: raw 24.6°→160.7° (true ~0→175); after Set Zero, −1.4°→129.8°. The zeroed reading is *further* from truth than the raw one. Fixing this needs goniometer ground truth and probably a two-point span calibration; do not adjust `neutralInterior` by eye, and bump `CALIBRATION_VERSION` + the `angleConvention` stamp when it is fixed.

**Angles are signed.** Negative means past the calibration zero in the extension direction. `CalibrationManager.apply()` used to clamp at 0, which discarded the entire extension side of the zero point — an extension test read a flat 0° for its whole duration, and because that value also feeds the recorder, the session saved a ROM of 0. Do not reintroduce a floor: extension is the measurement. Anything consuming the angle (readout, chart axes, e2e regexes) must handle a minus sign.

3D world landmarks (meters, relative to the hip midpoint) make the angle immune to camera-perspective foreshortening. Because the 3D switch changes the math, `CalibrationManager` tracks a `calibration_version` in settings and discards a stale offset once on upgrade, prompting the user to re-zero. Bump it for any change that rescales the raw angle — version 2 covers the per-joint convention, without which a shoulder offset captured under the old inverted scale (~165°, the top of the range) would push every later reading far below zero. `isCalibrated` is tracked with an explicit `calibration_captured` flag, not inferred from `offset !== 0`: a captured offset of exactly 0.0 is legitimate.

**One value, everywhere.** The output of this chain feeds the big readout, the overlay label, the peak/min snapshots *and* `SessionRecorder` — deliberately the same number, not parallel streams. `_captureFrameTo()` composites the overlay canvas into the retained extreme-frame canvas, so a divergence would put two contradicting angles inside one patient record with the wrong one burned into the image. Two consequences for anyone changing `_runDetection()`:

- Snapshot capture **must** run after `overlay.draw()` for the current frame. Capturing earlier composites the *previous* frame's label, which at the range extremes means a number from the opposite end of the range.
- Don't reintroduce a display-only filter (the old `DeadZoneFilter` was one). Stabilise the *rendering* — rounding, hysteresis on the text — never the value.

**Snapshot encoding & storage.** The retained full-resolution canvas is encoded only once, at save time, in `_encodeCapture()`: downscaled so the longest edge ≤ `SNAPSHOT_MAX_EDGE` (1100px — the retina-density capture is overkill for a phone-screen snapshot) then `toBlob('image/jpeg', SNAPSHOT_QUALITY=0.78)`. Dimension is the primary lever because low JPEG quality rings around the overlay's thin lines and angle text; net ~1MB retina JPEG → ~120–180KB. The blob goes to **IndexedDB via `imageStore`, never onto the session object** (inline base64 there is what used to overflow localStorage). See Accounts & cloud sync for the upload/eviction lifecycle. A small **storage gauge** on the Measure screen (`_updateStorageGauge`) shows cache usage + upload backlog.

**Face redaction.** The patient's head is masked out of the live preview and both snapshots, using one code path for both: `headRegion()` (`src/core/headRegion.js`, pure geometry) locates a head region from the face and shoulder landmarks; `PoseDetector.detect()` returns it as `head`; `Overlay.draw()` draws it into the overlay canvas **before** the landmark dots and before its own no-markers early return; and `_captureFrameTo()` composites that *same* overlay canvas into the retained snapshot. The stored JPEG therefore inherits whatever the preview drew — do not add a second mask at capture or encode time, or the two can disagree.

`detect()` also returns `headResolved`, a boolean gate that exists because `head === null` alone conflates two different states:

- **Pose lost.** MediaPipe drops the pose entirely; `MedianFilter3`/`OneEuroFilter` both replay their last output on a null push, so `displayAngle` holds steady while the overlay drew *no* redaction this frame — the face may be plainly visible. Capturing here leaks it.
- **Head genuinely out of frame.** Fresh landmarks, nothing to redact — safe, and in fact *required*: ankle framing (shin-to-foot, camera low) puts the head off-screen for the entire session, and refusing to capture there would silently save zero snapshots for every ankle patient.

`headResolved = headInputsFinite(lmNorm) && (head !== null || !anyFaceLandmarkInFrame(lmNorm, vw, vh))` — true only when a redaction was actually drawn, or it is provable (not merely assumed) that no face landmark is on screen. Gating capture on `head` alone, rather than `headResolved`, was tried and rejected: besides the ankle regression above, it let the recorded `max`/`min` drift from the captured frame's burned-in angle whenever the ambiguous case landed on an extreme.

Extreme **tracking** (`_maxAngle`/`_minAngle` in `MeasureView._runDetection()`) is deliberately left ungated — it must match `recorder.record()` exactly, every frame, or `session.max`/`min` and the retained snapshot end up describing two different frames. Only **capture** is conditional: `_maxHasFrame`/`_minHasFrame` are `headResolved && this._captureFrameTo(which)`. If the current extreme can't be safely captured, the flag goes `false` and any previously retained frame for that extreme is discarded — an honest gap (no peak snapshot) beats a caption sitting over an image it doesn't depict.

Three constraints in `headRegion.js`/`overlay.js` are load-bearing, not tuning knobs: the region is computed from landmark **position with no visibility threshold** (a confidence gate no-ops in exactly the hard cases — backlit, prone face-down — where the guarantee matters most); the redaction is drawn **fully opaque** (`overlay.js` sets `ctx.globalAlpha = 1` explicitly in every drawing block, since its other helpers leave it dirty and any transparency lets the sharp face through); and a fill-colour sampling failure degrades to a fixed **neutral grey**, never to skipping the draw — a failure there costs the colour, never the redaction.

**The region is an oriented ellipse, not a circle.** `headRegion()` returns `{cx, cy, rAcross, rAlong, ux, uy}`: `(ux, uy)` is the unit shoulders→head axis, `rAlong` the semi-axis along it, `rAcross` the semi-axis across it. A head is taller than it is wide, and an oriented shape tracks that instead of spending margin on a circle that has to cover the tall axis and therefore over-covers the wide one.

**Containment is an invariant, not a hope.** The radius used to come only from heuristics (`max(sFace, sTorso) × HEAD_RADIUS_FACTOR`) and merely *tended* to cover the face; a close-framed profile pose (the side-on knee/hip shot, where `sTorso` takes over while `CRANIUM_NUDGE` pushes the centre up toward the cranium) left the mouth landmarks ~5% of r **outside** the circle. `headRegion()` now seeds the ellipse from the heuristic radius (`ELLIPSE_ACROSS = 1.60`, `ELLIPSE_ALONG = 1.75`) and grows it until every face landmark sits inside: each landmark is projected into the ellipse's local frame to find `t`, the factor by which the seed must grow to contain it, and

```
grow = max(1, t × COVERAGE_MARGIN)      // COVERAGE_MARGIN = 1.60
```

**The margin sits inside the `max`, not outside it** — the faithful analogue of the old circle's `r = max(rHeuristic, maxDist × MARGIN)`, where the heuristic floor won outright when it already over-covered. Writing `max(1, t) × COVERAGE_MARGIN` instead would scale *every* region by 1.60 even when containment is inert, inflating the occluder on every ordinary frame — and no plain containment assertion catches that difference, since both formulas still keep every landmark inside. Only a test that pins the *exact* worst-landmark position after growth does (`headRegion.test.js`, "leaves the guaranteed slack the coverage margin promises" and "binds and stays contained under a tight close framing").

**The margin — and now the seed — carry the whole skull, which is why they're that large.** MediaPipe's eleven face landmarks bound the *face* — eye line to mouth, ear to ear. The cranium, hairline and the back of the head extend well past them and have **no landmarks of their own**, so containment can never reach them by construction; only the margin and the seed can. Both were tuned by looking at the exported e2e snapshot, not derived: at `COVERAGE_MARGIN = 1.10` the face was covered but hair, ear and the back of the head were left **sharp in the stored image**. Re-tune the same way — `E2E_DIAG=1 npm run verify:e2e`, then open `scripts/e2e/.fixtures/peak-analysed.png` and `min-analysed.png`, and look. **This is not optional decoration:** during this work the numeric uniformity and textured-body checks (see Testing notes below) all passed while hair was still protruding outside the occluder in the exported frame. Hair has no landmarks, so containment can't reach it by construction — only the seed constants can, and only looking caught it.

**Correction to a claim from the blur era — the seed is load-bearing again.** Under the old *circular* region, `COVERAGE_MARGIN = 1.60` made containment out-reach the heuristic in every realistic pose, so `sFace`/`HEAD_RADIUS_FACTOR` didn't decide the final radius — deleting `sFace` left the suite green. That is no longer true. `ELLIPSE_ACROSS`/`ELLIPSE_ALONG` were raised (from 0.92/1.14 to the current 1.60/1.75) specifically to close the hair-coverage gap above, and every realistic fixture in `headRegion.test.js` — frontal, profile, close-profile, prone — is now **inert**: the growth factor computes to exactly 1.0000 (worst landmark `q` measured between 0.39 and 0.60, all comfortably under `1/COVERAGE_MARGIN = 0.625`), so the seed alone decides the final size and `sFace`/`HEAD_RADIUS_FACTOR` are load-bearing again. Only a deliberately tight close framing — tighter than any other fixture in the suite — still binds, kept specifically so `max(1, t × COVERAGE_MARGIN)` still has a test that exercises `growth > 1` at all (`headRegion.test.js`, "binds and stays contained under a tight close framing"). **Consequence:** raising the seed has a *damped* effect on the final size while containment is binding, and only takes its full effect once the seed overtakes containment — which, at current constants, is every fixture except that one deliberately extreme case.

**`MAX_RADIUS_FRACTION = 0.50` is still applied last, to both axes, and still wins**: on a garbage landmark frame the sanity cap overrides containment, so containment holds only while both semi-axes are uncapped. The cap also bounds the heuristic radius that places the centre — without that, a nonsense scale nudges the centre off-screen and the region is discarded as off-frame, i.e. no redaction at all on the frames least worth trusting.

**Off-frame rejection uses the ellipse's axis-aligned half-extents, not its semi-axes directly.** `hx = hypot(rAcross×uy, rAlong×ux)`, `hy = hypot(rAcross×ux, rAlong×uy)` — using `rAcross`/`rAlong` straight against the video rect would only be correct when the head axis is screen-aligned, which excludes every prone patient.

**Motion expansion (`expandForMotion()` in `headRegion.js`, wired into `pose.js`).** Detection runs at `DETECTION_HZ = 10` (`MeasureView.js`) plus BlazePose inference (~150ms end to end), while the `<video>` element underneath keeps playing nearer 30fps (`camera.js` requests `frameRate: { ideal: 30, max: 60 }`) — so the overlay is positioned from landmarks already stale by the time it's composited over the live preview. At walking pace that's roughly one head radius of drift. `expandForMotion()` grows both semi-axes by the head centre's displacement since the last detection (`MOTION_GAIN = 1.0`, one pixel of growth per pixel of travel), capped by the same `MAX_RADIUS_FRACTION`. **The centre is deliberately not moved** — extrapolating it would guess a velocity from two samples and could overshoot off the head entirely; growing is strictly conservative, it only ever covers more. `pose.js` keeps `_prevHead`, the previous frame's **raw** (unexpanded) region, and clears it on both early-return paths (not ready, pose lost) so a detection gap can never be read as one enormous jump.

The **stored** snapshot never had this problem — `_captureFrameTo()` composites over the same buffered frame detection ran on, so its landmarks and its pixels are never out of sync. It gets the expansion anyway, because the live preview and the stored snapshot are drawn from the one overlay canvas; over-covering there is free.

**One nuance, stated precisely so it isn't overstated:** storing the raw region rather than the already-expanded one is currently **defensive, not load-bearing**. `expandForMotion()` derives displacement only from `prevRegion.cx`/`cy`, and the centre is identical between a region and its expanded form — only `rAcross`/`rAlong` differ — so today the two choices produce identical output. Storing raw is what keeps that from mattering if `expandForMotion()` ever starts reading the previous region's semi-axes too; it's the contract that should hold regardless of what the function currently reads, not a fix for a bug that exists today.

**Rendering (`Overlay._drawRedaction()` in `overlay.js`).** An opaque ellipse out to the containment boundary, a feather from there out to `FEATHER_EXTENT = 1.35×` the core, and a thin outline at `OUTLINE_AT = 1.04×`. **The core stays fully opaque — every softening term is strictly outside it**, over background pixels that were never part of the head; that decoupling of appearance from guarantee is exactly the property the blur gave up trying to hold at once. The fill is one colour, averaged from up to `SAMPLE_GRID² = 64` sample points taken outside the head ellipse (a fixed 8×8 grid regardless of video resolution, out to `SAMPLE_RING = 1.45×` the head) and EMA-smoothed frame to frame (`FILL_SMOOTHING = 0.2`) so it doesn't flicker.

**Nothing is sampled as a patch, and no Canvas 2D `filter` is used.** That's what deletes the whole class of silent failure the blur had — including the old `_filterSupported` branch, which had no automated coverage and could quietly emit a sharp face on an engine without canvas filters. That branch, and the device-dependent `'blur1'`/`'solid1'` split it drove, no longer exist: `Overlay.redactionMode` is now the constant `'mask1'`, because nothing about an opaque fill is device-dependent — a branch there could only ever lie.

`faceRedaction` on the session is `'mask1'`; `'blur1'` and `'solid1'` no longer exist. Any surviving `'blur1'` session — or one with no `faceRedaction` at all — falls into the same conservative "not masked" branch in SessionDetail on purpose: the flag can't distinguish "predates the feature" from "masked, but the old blur was measured on-device as displaced and barely effective," and the consequence for a clinician is the same either way. The detail view says `'Head masking active at capture'` or `'Head not masked at capture — these frames may show the patient's face'`.

**The video frame is read once per tick, into a buffer, and everyone shares it.** `MeasureView._runDetection()` used to read the live `<video>` element three separate times — once for `detector.detect()`, once inside `overlay.draw()` for the redaction, once in `_captureFrameTo()` for the stored photo. A live video element can return a different decoded frame on each read; three reads landing on three different frames would position the redaction from one frame's landmarks while sourcing pixels from another, offsetting it from the face in the stored JPEG. `_runDetection()` now blits the video into a persistent `this._frameCanvas` once, at the top of the tick, and passes that canvas — not `videoEl` — to `detect()`, to `overlay.draw()`'s `video` option, and to `_captureFrameTo()`. All three see byte-identical pixels by construction. Do not reintroduce a direct `videoEl` read anywhere in the capture path; if a future consumer needs the current frame, hand it `this._frameCanvas`.

**This is not de-identification.** The images stay linked to a named patient and a date of service, so they remain PHI regardless of redaction. This is data minimisation — it reduces the severity of a leak, it does not remove the record from HIPAA's scope.

**Why these filters.** The chain used to be `AngleSmoother(15)` → `DeadZoneFilter(2.0)`: a 1.5s trailing average with ~0.7s of lag, whose output was recorded. At a movement turnaround the window still held 0.7s of shallower angles, clipping 10–15° off the peak of a dynamic sweep, and the dead zone silently cost up to 2° more. A fixed window can't win — widening it calms the readout and worsens the clipping. One Euro varies its cutoff with speed instead, and takes `dt` per sample so a variable frame rate doesn't quietly change its time constant. `AngleSmoother` and `DeadZoneFilter` still exist in `angle.js`, used only by the regression test that pins the old clipping behaviour.

`OneEuroFilter`'s `minCutoff` (default 1.0Hz) is the knob if the readout feels twitchy on-device; lower is calmer. `beta` barely affects peak recovery — at 10Hz the residual on a very fast sweep is the sample rate, not the filter, since the apex spans about one sample and the median rounds it off.

### MediaPipe Pose loading (`src/detection/pose.js`)

`PoseDetector.init()` loads the BlazePose Full model (~7MB) from Google's CDN on first use. The WASM runtime is loaded from jsDelivr. Both are cached by the Workbox service worker (90-day TTL) so subsequent loads are instant and offline-capable.

`PoseDetector.detect(videoElement)` passes the live video element directly to MediaPipe (no canvas capture needed). MediaPipe returns normalized landmarks (0–1) plus metric world landmarks; the detector multiplies normalized coords by `videoWidth`/`videoHeight` to produce video pixel coordinates for the 2D path, and passes world `{x,y,z}` through for the 3D path.

Landmark roles (proximal → joint → distal) per joint, from `JOINT_CONFIG`:
```
Knee:     hip → knee → ankle
Hip:      shoulder → hip → knee
Shoulder: elbow → shoulder → hip
Elbow:    shoulder → elbow → wrist
Ankle:    shin midpoint (knee+ankle avg) → ankle → foot index
```
A config entry can be a single landmark index or `{ midpoint: [a, b] }` (average of two landmarks; both must clear the visibility threshold, used for ankle's proximal point so a partially out-of-frame knee doesn't cause jumping dots). Indices use MediaPipe's subject-anatomical left/right.

`src/detection/aruco.js` is legacy code from the pre-MediaPipe marker-based approach and is no longer imported anywhere — do not build on it.

### Overlay coordinate math (`src/detection/overlay.js`)

The video uses `object-fit: cover`, which crops and scales the video stream to fill the camera div. The canvas overlay sits on top and must match the *displayed* image, not the raw video pixels. `Overlay.resize()` computes the `object-fit: cover` scale factor and offsets, then `_toDisplay()` maps every landmark coordinate from video-pixel space to display-CSS-pixel space before drawing. This must be called whenever the video starts or the layout changes.

### MeasureView position/joint/side selection (`src/ui/MeasureView.js`)

A collapsible selector drawer lets the clinician pick joint, side, and clinical position. These are passed into `SessionRecorder.setContext(joint, side, position)` before `start()` so they're stamped onto the saved session.

The position row is **rendered from `JOINT_POSITIONS`**, which lists the positions each joint is actually measured in (first entry = default): knee prone/supine/seated, hip supine/prone/seated, shoulder standing/seated, elbow and ankle seated/standing. It used to be a fixed prone/supine/seated row that was merely *hidden* for shoulder/elbow/ankle — but `_position` kept its `'prone'` initial value and was still recorded, so standing shoulder measurements went into the patient record as "Prone". The UI now only offers valid positions, and `setContext()` leaves an absent position `null` rather than defaulting; History and SessionDetail already omit the badge when it's null.

### Accounts & cloud sync (`src/core/supabase.js`, `src/core/sync.js`, `src/core/id.js`)

Optional, gated entirely by `isConfigured()` (whether `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are set):

- **`supabase.js`** — the only module that imports `@supabase/supabase-js`. Wraps auth (sign in/up/out, session, `onAuthChange`) and exposes a lazy singleton client.
- **`sync.js`** — push/pull between `storage.js`'s localStorage cache and Supabase. Views never talk to Supabase directly; they read/write `storage.js` and sync moves data in the background. Push drains an outbox (oldest-first, deduped per entity+type); pull does a full `select` on `patients`/`sessions` (RLS scopes rows to the signed-in clinician) merged in with last-write-wins by `updated_at`. Triggered on login, `online` event, tab visibility change, and every outbox enqueue — no polling. Network errors keep the op for retry; permanent (4xx/RLS) errors drop the op, logging only the id (PHI hygiene — never record contents). Snapshot **images** ride the same outbox as `upload_image` ops: the JPEG bytes never touch the `sessions` row (that's what filled localStorage) — they upload from IndexedDB to the private `session-images` Storage bucket, and only the resulting `peak_frame_path`/`min_frame_path` sync on the row. Deleting a session also removes its bucket objects (PHI hygiene).
- **`imageStore.js`** — the only module that touches **IndexedDB**, the on-device home for snapshot blobs (mirrors how `storage.js` owns localStorage). Offline-safe staging + a bounded local cache: every capture lands here first; sync uploads it and calls `markUploaded()`; over `BUDGET_BYTES` (~45 MB) `enforceBudget()` evicts the **oldest *uploaded*** blobs first (never un-uploaded ones — those are the only copy). Evicted blobs re-download from the cloud on demand in `SessionDetailView`. Node/test-safe: every entry point no-ops when `indexedDB` is absent (unit tests install `fake-indexeddb`).
- **`id.js`** — client-generated v4 UUIDs (`generateId`) so offline-created records upsert into Supabase without id remapping. Legacy pre-sync session ids (`sess_<timestamp>`) fail `isUuid()` and stay local-only forever.
- **`supabase/schema.sql`** — the Postgres schema (patients/sessions tables + RLS policies) plus the private `session-images` Storage bucket and its per-clinician RLS policy, to apply in the Supabase project.

Sign-out (`clearAllLocalData()` in `storage.js`) wipes all local patient data — including the IndexedDB snapshot blobs — for shared-device hygiene, since cloud data is untouched and re-syncs on next login. Because a wipe destroys any not-yet-uploaded snapshot (its only copy is on the device), `PatientsView`'s sign-out first drains the outbox and **refuses to sign out** while any op is pending or any blob is still un-uploaded (`imageStore.listPending()`), so the user reconnects rather than losing data.

### Persistence (`src/core/storage.js`)

The only module that touches `localStorage` (snapshot blobs live in IndexedDB via `imageStore.js` — see Accounts & cloud sync). Local-first: localStorage is the source of truth on-device; every mutation also enqueues a sync outbox op (a no-op when Supabase isn't configured — sync.js just never drains it).

Keys: `rom_sessions` (Session[]), `rom_settings` (Settings), `rom_patients` (Patient[], cache of the cloud table), `rom_outbox` (pending sync ops, oldest first).

`migrateInlineImages()` runs once on boot to rescue pre-IndexedDB sessions: it converts any inline `peakFrame`/`minFrame` base64 data URL into an `imageStore` blob, queues its upload, and strips the field — immediately relieving a full localStorage and backing up images that were previously local-only.

Sessions have separate `joint` (knee/hip/shoulder/elbow/ankle) and `side` (left/right) fields, plus `position` (prone/supine/seated/standing, or null when none was chosen), `angleMode` ('3d', absent = pre-3D/2D-era), `angleFilter` ('euro1', absent = pre-fix), `angleConvention` ('perjoint1', absent = pre-per-joint-convention), `faceRedaction` ('mask1', absent = pre-redaction or a surviving pre-occluder 'blur1' session, both captured with the face at risk of being unredacted — see Face redaction above), and `peakFramePath`/`minFramePath` (Storage object paths, null until the snapshot uploads; image bytes are never stored on the session). Old sessions saved before the joint/side split had `joint: 'knee_right'` (combined) and no `side` field — the UI handles both shapes gracefully. **Sessions without `angleFilter` read systematically low at the extremes** (the old moving average clipped peaks), so their `rom` is not comparable with a `'euro1'` session's — the difference would look like patient progress but is the filter change. **Sessions without `angleConvention` are worse:** their shoulder values are on an inverted scale, their ankle values are offset by 90°, and any of them recorded after a Set Zero had everything below the zero point clamped to 0. Those numbers are **not recoverable** — the calibration offset was never stored on the session, and clamped samples are gone — so they were deliberately left untouched rather than migrated. Stamp a new value on whichever of these fields applies for any future change that alters the measured numbers. Sessions belong to a `patient_id`; `getActivePatientId()`/`setActivePatientId()` in settings track which patient Measure/History currently operate on (switching patient also clears the calibration offset, same rule as switching joint/side).

### Separation of concerns

`src/core/` contains only pure functions and classes with no DOM or browser API dependencies (except `CalibrationManager` and `storage.js`, which read/write `localStorage`, and `sync.js`, which does network I/O but no DOM). These are fully testable in Node via Vitest. DOM manipulation and camera/canvas work lives in `src/ui/` and `src/detection/`; `supabase.js` is the sole boundary to the Supabase SDK.

### Testing notes

`calibration.test.js` mocks `./storage.js` with `vi.mock()` and provides a `global.localStorage` stub. `pose.test.js` mocks `@mediapipe/tasks-vision` using `vi.hoisted()` (required because `vi.mock` is hoisted before variable declarations). `storage.test.js` and `sync.test.js` cover the outbox/merge logic with a `global.localStorage` stub and a mocked `supabase.js` client respectively. `imageStore.test.js` and the migration/wipe tests in `storage.test.js` import `fake-indexeddb/auto` for a real in-memory IndexedDB; `sync.test.js` fakes `client.storage.from().upload/remove` and mocks `imageStore` to cover the `upload_image` op. `enforceBudget` is pinned both ways — it evicts oldest *uploaded* blobs and spares un-uploaded ones. The e2e harness (`scripts/e2e/verify.mjs`) asserts the saved session carries **no** inline image bytes and that two blobs land in IndexedDB, then eyeballs the detail-view frames.

`angle.test.js` ends with a filter regression suite built on a synthetic cosine sweep (a triangle wave would be unfair to any median — its apex is a single sample, indistinguishable from a spike; a real turnaround dwells near the peak because the limb decelerates). It asserts both directions of the trade-off: the peak is recovered to within ~1°, *and* a stationary joint stays under 0.5° of jitter. Keep both — either alone can be satisfied by tuning the filter into uselessness. The old chain's clipping has its own test so the bug can't quietly return.

`headRegion.test.js` pins **containment** — that every one of the eleven face landmarks lies inside the returned *ellipse* — for frontal, profile, close-framed-profile and prone fixtures, and separately pins the exact growth formula: a deliberately tight close-framed profile fixture (tighter than any other fixture in the suite, chosen because every ordinary one is now inert — see the Face redaction section above) drives the worst landmark to exactly `q = 1 / COVERAGE_MARGIN`, which only holds if `grow = max(1, t × COVERAGE_MARGIN)` and breaks if the margin is moved outside the `max`. That invariant is the module's whole point, and it is the one thing the heuristics alone never guaranteed. Each assertion in that file exists to reject a specific wrong implementation, and several earlier versions passed against code with the feature deleted or weakened; before changing a bound, check what mutation it catches (force `scale = sTorso`, force `scale = sFace`, drop the containment term, drop the heuristic floor, swap the margin's position in the `max`) and confirm the replacement still fails.

The e2e's redaction check is **absolute uniformity**, not a comparison: it requires the flattest cell over the stored snapshot's head region to be texture-free, plus a **textured-body** sanity check on cells that are never masked, so the uniformity claim isn't vacuously satisfied by an all-flat frame. This replaced a head-vs-frame-median comparison forced on us by the old blur, which never really worked: roughly half the fixture is sky and ocean, dragging the median to ~0.8, while a genuinely blurred face measured 1.3–3.8 — so the only way to satisfy a median-relative ceiling was for the blur to land *on the sky*, which is precisely the bug the check exists to catch. An opaque occluder makes the assertion absolute instead, and nothing about the sky can satisfy "texture-free" while the body cells stay sharp. Don't "simplify" it back to a median. The head/body cell coordinates are fixture-specific; re-measure them with `E2E_DIAG=1` and by opening `.fixtures/peak-analysed.png` if the fixture or source photo changes.

Coverage of the head is additionally verified **by eye**, not only by the grid check: after `E2E_DIAG=1 npm run verify:e2e`, open `.fixtures/peak-analysed.png` and `.fixtures/min-analysed.png` and look. This is not optional — during this work the numeric uniformity/textured-body checks all passed while hair was protruding outside the occluder in the exported frame, found only by looking. Hair has no landmarks, so containment cannot reach it by construction; only the seed constants can.

Note the untested surface: `src/ui/` has no unit tests, so the wiring in `MeasureView._runDetection()` — the order of overlay draw vs snapshot capture, which value reaches the recorder — is only covered end-to-end. Verify changes there by running the app, not by reasoning about the diff. Two properties of the redaction have **no automated coverage at all** and need a device check before merge: that the occluder tracks a fast sweep without the feather ever exposing skin — screenshot the live preview mid-sweep, the way the original motion-drift defect was found (see `expandForMotion()` in the Face redaction section) — and the frame-rate cost of the per-tick frame blit, still unmeasured.
