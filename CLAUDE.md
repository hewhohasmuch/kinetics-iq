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

To run the app in cloud mode locally, copy `.env.example` to `.env.local` and fill in `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. Without those set, the app runs local-only (no login, no sync) — see Accounts & cloud sync below.

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
  → toFlexionAngle()              [180 - interior = clinical flexion: 0° = straight]
  → MedianFilter3.push()          [median of last 3 — rejects single-frame landmark glitches]
  → OneEuroFilter.push(v, t)      [adaptive smoothing: calm at rest, responsive when moving]
  → CalibrationManager.apply()    [subtract offset captured at "zero" position]
  → SessionRecorder.record()      [accumulate during active recording]
```

3D world landmarks (meters, relative to the hip midpoint) make the angle immune to camera-perspective foreshortening. Because the 3D switch changes the math, `CalibrationManager` tracks a `calibration_version` in settings and discards a stale (2D-era) offset once on upgrade, prompting the user to re-zero.

**One value, everywhere.** The output of this chain feeds the big readout, the overlay label, the peak/min snapshots *and* `SessionRecorder` — deliberately the same number, not parallel streams. `_captureFrameTo()` composites the overlay canvas into the saved JPEG, so a divergence would put two contradicting angles inside one patient record with the wrong one burned into the image. Two consequences for anyone changing `_runDetection()`:

- Snapshot capture **must** run after `overlay.draw()` for the current frame. Capturing earlier composites the *previous* frame's label, which at the range extremes means a number from the opposite end of the range.
- Don't reintroduce a display-only filter (the old `DeadZoneFilter` was one). Stabilise the *rendering* — rounding, hysteresis on the text — never the value.

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

A collapsible selector drawer lets the clinician pick joint, side, and clinical position (prone/supine/seated — defaults reset to the clinically typical position per joint). These are passed into `SessionRecorder.setContext(joint, side, position)` before `start()` so they're stamped onto the saved session.

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

Sessions have separate `joint` (knee/hip/shoulder/elbow/ankle) and `side` (left/right) fields, plus `position` (prone/supine/seated), `angleMode` ('3d', absent = pre-3D/2D-era), `angleFilter` ('euro1', absent = pre-fix), and `peakFramePath`/`minFramePath` (Storage object paths, null until the snapshot uploads; image bytes are never stored on the session). Old sessions saved before the joint/side split had `joint: 'knee_right'` (combined) and no `side` field — the UI handles both shapes gracefully. **Sessions without `angleFilter` read systematically low at the extremes** (the old moving average clipped peaks), so their `rom` is not comparable with a `'euro1'` session's — the difference would look like patient progress but is the filter change. Stamp a new value on this field for any future change that alters the measured numbers. Sessions belong to a `patient_id`; `getActivePatientId()`/`setActivePatientId()` in settings track which patient Measure/History currently operate on (switching patient also clears the calibration offset, same rule as switching joint/side).

### Separation of concerns

`src/core/` contains only pure functions and classes with no DOM or browser API dependencies (except `CalibrationManager` and `storage.js`, which read/write `localStorage`, and `sync.js`, which does network I/O but no DOM). These are fully testable in Node via Vitest. DOM manipulation and camera/canvas work lives in `src/ui/` and `src/detection/`; `supabase.js` is the sole boundary to the Supabase SDK.

### Testing notes

`calibration.test.js` mocks `./storage.js` with `vi.mock()` and provides a `global.localStorage` stub. `pose.test.js` mocks `@mediapipe/tasks-vision` using `vi.hoisted()` (required because `vi.mock` is hoisted before variable declarations). `storage.test.js` and `sync.test.js` cover the outbox/merge logic with a `global.localStorage` stub and a mocked `supabase.js` client respectively.

`angle.test.js` ends with a filter regression suite built on a synthetic cosine sweep (a triangle wave would be unfair to any median — its apex is a single sample, indistinguishable from a spike; a real turnaround dwells near the peak because the limb decelerates). It asserts both directions of the trade-off: the peak is recovered to within ~1°, *and* a stationary joint stays under 0.5° of jitter. Keep both — either alone can be satisfied by tuning the filter into uselessness. The old chain's clipping has its own test so the bug can't quietly return.

Note the untested surface: `src/ui/` has no unit tests, so the wiring in `MeasureView._runDetection()` — the order of overlay draw vs snapshot capture, which value reaches the recorder — is only covered end-to-end. Verify changes there by running the app, not by reasoning about the diff.
