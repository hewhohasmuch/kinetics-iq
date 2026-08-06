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

Sessions have separate `joint` (knee/hip/shoulder/elbow/ankle) and `side` (left/right) fields, plus `position` (prone/supine/seated/standing, or null when none was chosen), `angleMode` ('3d', absent = pre-3D/2D-era), `angleFilter` ('euro1', absent = pre-fix), `angleConvention` ('perjoint1', absent = pre-per-joint-convention), and `peakFramePath`/`minFramePath` (Storage object paths, null until the snapshot uploads; image bytes are never stored on the session). Old sessions saved before the joint/side split had `joint: 'knee_right'` (combined) and no `side` field — the UI handles both shapes gracefully. **Sessions without `angleFilter` read systematically low at the extremes** (the old moving average clipped peaks), so their `rom` is not comparable with a `'euro1'` session's — the difference would look like patient progress but is the filter change. **Sessions without `angleConvention` are worse:** their shoulder values are on an inverted scale, their ankle values are offset by 90°, and any of them recorded after a Set Zero had everything below the zero point clamped to 0. Those numbers are **not recoverable** — the calibration offset was never stored on the session, and clamped samples are gone — so they were deliberately left untouched rather than migrated. Stamp a new value on whichever of these fields applies for any future change that alters the measured numbers. Sessions belong to a `patient_id`; `getActivePatientId()`/`setActivePatientId()` in settings track which patient Measure/History currently operate on (switching patient also clears the calibration offset, same rule as switching joint/side).

### Separation of concerns

`src/core/` contains only pure functions and classes with no DOM or browser API dependencies (except `CalibrationManager` and `storage.js`, which read/write `localStorage`, and `sync.js`, which does network I/O but no DOM). These are fully testable in Node via Vitest. DOM manipulation and camera/canvas work lives in `src/ui/` and `src/detection/`; `supabase.js` is the sole boundary to the Supabase SDK.

### Testing notes

`calibration.test.js` mocks `./storage.js` with `vi.mock()` and provides a `global.localStorage` stub. `pose.test.js` mocks `@mediapipe/tasks-vision` using `vi.hoisted()` (required because `vi.mock` is hoisted before variable declarations). `storage.test.js` and `sync.test.js` cover the outbox/merge logic with a `global.localStorage` stub and a mocked `supabase.js` client respectively. `imageStore.test.js` and the migration/wipe tests in `storage.test.js` import `fake-indexeddb/auto` for a real in-memory IndexedDB; `sync.test.js` fakes `client.storage.from().upload/remove` and mocks `imageStore` to cover the `upload_image` op. `enforceBudget` is pinned both ways — it evicts oldest *uploaded* blobs and spares un-uploaded ones. The e2e harness (`scripts/e2e/verify.mjs`) asserts the saved session carries **no** inline image bytes and that two blobs land in IndexedDB, then eyeballs the detail-view frames.

`angle.test.js` ends with a filter regression suite built on a synthetic cosine sweep (a triangle wave would be unfair to any median — its apex is a single sample, indistinguishable from a spike; a real turnaround dwells near the peak because the limb decelerates). It asserts both directions of the trade-off: the peak is recovered to within ~1°, *and* a stationary joint stays under 0.5° of jitter. Keep both — either alone can be satisfied by tuning the filter into uselessness. The old chain's clipping has its own test so the bug can't quietly return.

Note the untested surface: `src/ui/` has no unit tests, so the wiring in `MeasureView._runDetection()` — the order of overlay draw vs snapshot capture, which value reaches the recorder — is only covered end-to-end. Verify changes there by running the app, not by reasoning about the diff.
