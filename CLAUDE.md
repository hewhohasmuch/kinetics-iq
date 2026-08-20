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

To run the app in cloud mode locally, copy `.env.example` to `.env.local` and fill in `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. Without those set, the app runs local-only (no login, no sync) — see Accounts & cloud sync below. Apply `supabase/schema.sql` to a fresh project; for a project that predates cloud image sync, apply `supabase/migrations/0001_session_images.sql` instead (adds the `peak/min_frame_path` columns and the private `session-images` Storage bucket + RLS). Snapshot upload silently no-ops until that bucket exists. An existing project also needs `0002_face_redaction.sql` (a column the app no longer uses — head redaction was removed in #17 — kept as the only record of which stored snapshots had any redaction applied), `0003_angle_metadata.sql` (`angle_filter`, `angle_convention`) and `0004_calibration_provenance.sql` (`calibrated`, `calibration_offset`). **Apply both before deploying**, because PostgREST 4xxs an insert naming an unknown column and `sync.js` drops permanent errors, so sessions would stop syncing silently rather than fail loudly.

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
PoseDetector.detect(frameCanvas)    [MediaPipe BlazePose Full, CDN-loaded; canvas, not the live video — see below]
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

Once the mapping stopped being one formula, "flexion" stopped being one word. **`JOINT_MOTION_TERMS` / `motionTerms(joint)`** (same file) names the motion in each direction — knee/hip/elbow flexion·extension, shoulder **elevation**·extension, ankle **dorsiflexion**·**plantarflexion** — and every user-facing string goes through it: the readout label, the SessionDetail snapshot captions and image `alt`, and the chart axis. It accepts the legacy combined `'shoulder_left'` form, since detail views look terms up straight off the saved record. Captions keep the signed value the overlay burned into the image — an `abs()` there would put two different numbers on one picture.

**`src/core/labels.js` formats those terms for display; `angle.js` stays the source of truth for the terms themselves.** It also owns `JOINT_NAMES`, `JOINT_POSITIONS`/`POSITION_NAMES`/`positionsFor()` (moved out of `MeasureView`), and `jointLabel`/`sideLabel`/`positionLabel`/`motionLabel`. The `{ knee: 'Knee', … }` map used to be written out in three views with side capitalisation inlined at each site and the position badges bypassing `POSITION_NAMES` entirely — four copies of one intent, which drift. It now also owns `formatSessionDate`/`formatSessionTime`/`formatDuration`, which existed verbatim in both `HistoryView` and `SessionDetailView` (differing only in the weekday) until `report.js` needed a third copy. `formatSessionDate` splits `'YYYY-MM-DD'` and builds a local `Date` on purpose — `new Date('2026-08-12')` is UTC midnight, which renders as the 11th anywhere west of Greenwich.

**`extremeLabels(joint, min)` is the one rule for naming a session's two ends**, used by both the SessionDetail stat cards and the snapshot captions beneath them so the card and the picture cannot disagree about the same number. The min is only the *negative* term when the value actually crossed zero: an un-zeroed shoulder resting at 24.6° of elevation is "Min elevation", not "Peak extension".

**ROM is reported as the arc, not the subtraction.** `romArc(min, max)` → `5° – 120°` leads in History rows and the SessionDetail ROM card, with `rom` (max − min) demoted to a secondary "115° total". A knee lacking 5° of extension and one with full extension subtract to the same total, and the deficit is the finding — that is also how goniometry is documented. The History trend chart plots the two extremes as separate lines for the same reason, and is scoped by joint+side chips because it previously drew every joint the patient had on one "progress" line. Its y axis is `suggestedMin`, not `min: 0`; angles are signed and a hard floor clipped the extension side off the chart.

**Known limitation — the shoulder neutral is not 0.** `JOINT_ANGLE_CONVENTION.shoulder` declares `neutralInterior: 0`, but the anatomical neutral interior is ~15–25°, so raw shoulder readings sit that much high at rest. Worse, the landmark error is not constant across the range (about +25° at the bottom, about −15° at the top, where the shoulder landmark under-rotates at end range), and `CalibrationManager.apply()` is a single subtraction — so **Set Zero at the side over-corrects the top of the range**. Measured on-device: raw 24.6°→160.7° (true ~0→175); after Set Zero, −1.4°→129.8°. The zeroed reading is *further* from truth than the raw one. Fixing this needs goniometer ground truth and probably a two-point span calibration; do not adjust `neutralInterior` by eye, and bump `CALIBRATION_VERSION` + the `angleConvention` stamp when it is fixed.

**Known limitation — the raw reading floors at neutral, and the shoulder is only the loudest case.** `jointAngle()` is an `acos`, so the interior angle is confined to [0, 180]. Where a joint's `neutralInterior` sits at an **end** of that interval, the clinical mapping folds the entire range onto one side of zero and the raw reading can never go below neutral:

| `neutralInterior` | Joints | Raw clinical range | Floored at neutral? |
|---|---|---|---|
| 180 | knee, hip, elbow | 0 … +180 | **yes** |
| 0 | shoulder | 0 … +180 | **yes** — the limitation above |
| 90 | ankle | −90 … +90 | no — errors are two-sided and cancel |

For the floored joints, every landmark error at neutral is **rectified**: a kink is a kink whichever way the joint point is displaced, so error accumulates in one direction instead of cancelling, and no filter removes it (`MedianFilter3` rejects spikes, `OneEuroFilter` trades lag against noise; neither touches a bias). `rawCannotGoBelowNeutral()` in `angle.js` is that predicate, derived from the convention table so a joint added there gets the right behaviour for free. A raw hinge session therefore **cannot report hyperextension at all** — a normal knee's 0 to −5° is structurally invisible until a zero is captured.

**Measured on the supine right knee**, from a device screenshot of SessionDetail. `scripts/measure-overlay-dots.mjs` is the tool: it finds the three overlay dot centroids by colour and reports the 2D angle they describe, so the finding can be re-derived from any exported snapshot (the screenshot itself is deliberately not committed — it shows a person). Because the overlay dots and the burned-in label are composited from one frame — "One value, everywhere" — the drawn 2D landmark geometry and the recorded 3D angle can be compared *within a single frame*:

| | drawn 2D landmarks | recorded 3D angle | gap |
|---|---|---|---|
| flat leg | 0.77° (knee dot 0.5px off the hip–ankle line) | 9.0° | **+8.2°** |
| bent leg | 127.32° | 121.8° | **−5.5°** |

Two conclusions, and the second is the important one. First, the knee landmarks are placed *well* in the image plane — the floor is not an anatomical offset between MediaPipe's knee point and the epicondyle, it is almost entirely the **monocular depth estimate**, which carries almost no real signal for a limb lying in the image plane but feeds straight into the rectified error via `BAz`/`BCz`. The 3D path was adopted to defeat foreshortening; in this pose it *adds* error the 2D path would not have. Second, **the gap reverses sign across the range**, exactly like the shoulder's — so `CalibrationManager.apply()`, a single subtraction, cannot correct it. Zeroing this knee at full extension would fix the minimum and drag the peak from 121.8° to ~112.8° against a 2D reading of 127.3°. **Do not present Set Zero as the cure for a floored joint**, in the UI or in exported wording; `provenance.test.js` pins that the caveat does not.

Neither 2D nor 3D is ground truth here — 2D is a projection, which is what 3D exists to fix. What is established is that the two disagree in a range-dependent way. Resolving it needs goniometer readings at both ends (see `project_measurement_validation_queued`), and probably a two-point span calibration rather than an offset; the same "do not adjust by eye" rule and the same `angleConvention`/`CALIBRATION_VERSION` bump apply.

**Angles are signed.** Negative means past the calibration zero in the extension direction. `CalibrationManager.apply()` used to clamp at 0, which discarded the entire extension side of the zero point — an extension test read a flat 0° for its whole duration, and because that value also feeds the recorder, the session saved a ROM of 0. Do not reintroduce a floor: extension is the measurement. Anything consuming the angle (readout, chart axes, e2e regexes) must handle a minus sign.

3D world landmarks (meters, relative to the hip midpoint) make the angle immune to camera-perspective foreshortening — but **not to depth error**, and the two trade off: for a limb lying in the image plane the foreshortening it corrects is near zero while the depth noise it admits is not, which is the mechanism behind the floor documented above. Read that limitation before treating 3D as strictly better than 2D. Because the 3D switch changes the math, `CalibrationManager` tracks a `calibration_version` in settings and discards a stale offset once on upgrade, prompting the user to re-zero. Bump it for any change that rescales the raw angle — version 2 covers the per-joint convention, without which a shoulder offset captured under the old inverted scale (~165°, the top of the range) would push every later reading far below zero. `isCalibrated` is tracked with an explicit `calibration_captured` flag, not inferred from `offset !== 0`: a captured offset of exactly 0.0 is legitimate.

**One value, everywhere.** The output of this chain feeds the big readout, the overlay label, the peak/min snapshots *and* `SessionRecorder` — deliberately the same number, not parallel streams. `_captureFrameTo()` composites the overlay canvas into the retained extreme-frame canvas, so a divergence would put two contradicting angles inside one patient record with the wrong one burned into the image. Two consequences for anyone changing `_runDetection()`:

- Snapshot capture **must** run after `overlay.draw()` for the current frame. Capturing earlier composites the *previous* frame's label, which at the range extremes means a number from the opposite end of the range.
- Don't reintroduce a display-only filter (the old `DeadZoneFilter` was one). Stabilise the *rendering* — rounding, hysteresis on the text — never the value.

**The video frame is read once per tick, into a buffer, and everyone shares it.** `MeasureView._runDetection()` blits the live `<video>` into a persistent `this._frameCanvas` at the top of the tick and passes that canvas — not `videoEl` — to `detector.detect()` and to `_captureFrameTo()`. A live video element can return a different decoded frame on each read, so two separate `drawImage(videoEl, …)` calls in one tick can land on two different frames; the angle is computed from the landmarks detection saw, and if the snapshot pixels come from a later frame, the number burned into the stored image describes a frame it doesn't depict. One buffer makes analysis and stored photo the same pixels by construction. Don't reintroduce a direct `videoEl` read in the capture path — if a future consumer needs the current frame, hand it `this._frameCanvas`. (`PoseDetector.detect()` therefore accepts a canvas as well as a video element, reading `videoWidth ?? width`.)

**Snapshot encoding & storage.** The retained full-resolution canvas is encoded only once, at save time, in `_encodeCapture()`: downscaled so the longest edge ≤ `SNAPSHOT_MAX_EDGE` (1100px — the retina-density capture is overkill for a phone-screen snapshot) then `toBlob('image/jpeg', SNAPSHOT_QUALITY=0.78)`. Dimension is the primary lever because low JPEG quality rings around the overlay's thin lines and angle text; net ~1MB retina JPEG → ~120–180KB. The blob goes to **IndexedDB via `imageStore`, never onto the session object** (inline base64 there is what used to overflow localStorage). See Accounts & cloud sync for the upload/eviction lifecycle. A small **storage gauge** on the Measure screen (`_updateStorageGauge`) shows cache usage + upload backlog.

**Why these filters.** The chain used to be `AngleSmoother(15)` → `DeadZoneFilter(2.0)`: a 1.5s trailing average with ~0.7s of lag, whose output was recorded. At a movement turnaround the window still held 0.7s of shallower angles, clipping 10–15° off the peak of a dynamic sweep, and the dead zone silently cost up to 2° more. A fixed window can't win — widening it calms the readout and worsens the clipping. One Euro varies its cutoff with speed instead, and takes `dt` per sample so a variable frame rate doesn't quietly change its time constant. `AngleSmoother` and `DeadZoneFilter` still exist in `angle.js`, used only by the regression test that pins the old clipping behaviour.

`OneEuroFilter`'s `minCutoff` (default 1.0Hz) is the knob if the readout feels twitchy on-device; lower is calmer. `beta` barely affects peak recovery — at 10Hz the residual on a very fast sweep is the sample rate, not the filter, since the apex spans about one sample and the median rounds it off.

### MediaPipe Pose loading (`src/detection/pose.js`)

`PoseDetector.init()` loads the BlazePose Full model (~7MB) from Google's CDN on first use. The WASM runtime is loaded from jsDelivr. Both are cached by the Workbox service worker (90-day TTL) so subsequent loads are instant and offline-capable.

`PoseDetector.detect()` accepts **either** a video element or a canvas — `detectForVideo` takes any `TexImageSource`. In the app it is always given `MeasureView`'s per-tick frame-buffer canvas, never the live `<video>`, so that detection and the stored snapshot read identical pixels (see "The video frame is read once per tick" above). It therefore reads `videoWidth ?? width` / `videoHeight ?? height` rather than assuming a video element, and its parameter is named `source` for the same reason. MediaPipe returns normalized landmarks (0–1) plus metric world landmarks; the detector multiplies normalized coords by those dimensions to produce video pixel coordinates for the 2D path, and passes world `{x,y,z}` through for the 3D path.

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

The position row is **rendered from `JOINT_POSITIONS`** (in `src/core/labels.js`), which lists the positions each joint is actually measured in (first entry = default): knee prone/supine/seated, hip supine/prone/seated, shoulder standing/seated, elbow and ankle seated/standing. It used to be a fixed prone/supine/seated row that was merely *hidden* for shoulder/elbow/ankle — but `_position` kept its `'prone'` initial value and was still recorded, so standing shoulder measurements went into the patient record as "Prone". The UI now only offers valid positions, and `setContext()` leaves an absent position `null` rather than defaulting; History and SessionDetail already omit the badge when it's null.

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

Keys: `rom_sessions` (Session[]), `rom_settings` (Settings), `rom_patients` (Patient[], cache of the cloud table), `rom_outbox` (pending sync ops, oldest first). `rom_settings` is otherwise internal (calibration offset, active patient) — `export_include_initials` is the one user-facing preference in it, and it has no settings screen: the export confirmation sheet is its only home.

`migrateInlineImages()` runs once on boot to rescue pre-IndexedDB sessions: it converts any inline `peakFrame`/`minFrame` base64 data URL into an `imageStore` blob, queues its upload, and strips the field — immediately relieving a full localStorage and backing up images that were previously local-only.

Sessions have separate `joint` (knee/hip/shoulder/elbow/ankle) and `side` (left/right) fields, plus `position` (prone/supine/seated/standing, or null when none was chosen), `angleMode` ('3d', absent = pre-3D/2D-era), `angleFilter` ('euro1', absent = pre-fix), `angleConvention` ('perjoint1', absent = pre-per-joint-convention), `calibrated`/`calibrationOffset` (see below; absent = the session never recorded its calibration state), and `peakFramePath`/`minFramePath` (Storage object paths, null until the snapshot uploads; image bytes are never stored on the session). Old sessions saved before the joint/side split had `joint: 'knee_right'` (combined) and no `side` field — the UI handles both shapes gracefully. **Sessions without `angleFilter` read systematically low at the extremes** (the old moving average clipped peaks), so their `rom` is not comparable with a `'euro1'` session's — the difference would look like patient progress but is the filter change. **Sessions without `angleConvention` are worse:** their shoulder values are on an inverted scale, their ankle values are offset by 90°, and any of them recorded after a Set Zero had everything below the zero point clamped to 0. Those numbers are **not recoverable** — no calibration offset was stored on the session back then (it is now, see Calibration provenance below, but that does not reach backwards), and clamped samples are gone — so they were deliberately left untouched rather than migrated. Stamp a new value on whichever of these fields applies for any future change that alters the measured numbers. **All three angle stamps map both ways in `sync.js`** — they didn't originally, and a cloud pull silently stripped `angleFilter`/`angleConvention`, turning a trustworthy session into one that reads as unrecoverable. `sync.test.js` pins each direction separately, because a half-fix still loses the stamp. Sessions belong to a `patient_id`; `getActivePatientId()`/`setActivePatientId()` in settings track which patient Measure/History currently operate on (switching patient also clears the calibration offset, same rule as switching joint/side).

**Calibration provenance (`calibrated`, `calibrationOffset`).** Stamped by `SessionRecorder.setCalibration()`, which `MeasureView._startRecording()` calls alongside `setContext()` — safe to read at start because `_btnCalibrate` is disabled for the whole recording, so the offset cannot move mid-session. Before this, the offset lived only in `rom_settings`, which is global to the device and cleared on every joint/side/patient switch, so a saved session could not say whether its numbers were raw or re-based on a captured neutral. Those are different measurements: the same shoulder reads roughly 24.6°→160.7° raw and −1.4°→129.8° zeroed. **Absence is a third state.** `undefined`/null means the session never recorded its calibration state; `false` is the positive claim that it was measured raw. `calibrationSummary()` reports the first as "Calibration not recorded" and must never collapse it to "Not zeroed" — the migration deliberately leaves existing rows NULL rather than defaulting them to `false`, which would manufacture that claim for sessions that were carefully zeroed. `captured` is passed explicitly rather than inferred from a non-zero offset, for the same reason `CalibrationManager` tracks its own flag: an offset of exactly 0.0 is a legitimate capture.

**Surfacing provenance (`src/core/provenance.js`).** `sessionProvenance()` turns the angle stamps into a badge; `calibrationSummary()` does the same for the calibration fields. All of this was stored and synced for a while but never shown, which is the dangerous direction — an old session sitting next to a current one in the same list looks like patient progress when the only thing that changed was the filter. History rows and SessionDetail now carry an amber badge, and legacy sessions are *marked* in the trend chart rather than dropped from it.

### Getting a measurement out (`src/core/report.js`)

`sessionNoteText(session)` renders a session as a paste-ready block for the EHR note, behind a **"Copy for note"** button on SessionDetail. Before it there was no export of any kind, so the numbers were read off the screen and retyped, dropping the snapshots and every provenance stamp on the way. (eClinicalWorks' free FHIR APIs are read-only; write-back needs a paid partner track and a per-practice authorization, so a clipboard block is what works today against any EHR.)

Every clinical string is reused, not reimplemented: `romArc` leads and `rom` is the parenthetical total, `extremeLabels` names both ends, `calibrationSummary().text` is **always** emitted (raw and zeroed are different measurements — a note that omits which is claiming neither), and a session whose `sessionProvenance().level !== 'ok'` carries a `⚠` line. That warning is the point of the module: the only thing worse than not exporting a number is exporting a known-bad one into a permanent medical record with no caveat.

**Patient name, DOB and MRN are deliberately absent**, pinned by a test. The clipboard is a promiscuous surface — on iOS any app can read it on paste and Universal Clipboard syncs it to the user's other devices — and the clinician is already inside that patient's chart when they paste, so an identifier adds exposure and no information.

The button builds the string synchronously and calls `navigator.clipboard.writeText()` as the first thing in the gesture handler: any `await` before the write loses the user-gesture context in Safari and the write fails silently. When the API is missing (non-secure context, older iOS) or rejects, it reveals a read-only `<textarea>` with the text selected for long-press → Copy.

**The `⚠` lines come from two different kinds of knowledge, and that distinction is the point.** `sessionProvenance()` reads *stamps* — `angleConvention`/`angleFilter`, facts about which build produced the record. `extensionFloorCaveat()` reads the *measurement*, and so fires on sessions whose stamps are all current. It had to: a session recorded by today's build exports clean, and `romArc` leads the note with the arc, whose lower end is exactly the floored number. A knee exported as `9° – 121.8°` is claiming a 9° extension lag — a real, treatment-driving finding — when the raw reading cannot go below 0 at all. It fires only on `calibrated === false`, the positive claim; absence stays "Calibration not recorded", which carries its own uncertainty, and asserting the mechanism there would manufacture a claim (same discipline as `calibrationSummary()`).

Stamps still cannot see everything. A *current* shoulder session that **was** zeroed exports with no floor caveat, even though this file documents Set Zero as over-correcting the top of its range. That gap is the shoulder limitation reaching a new surface, not a bug in `report.js`. When it is fixed, the `angleConvention` bump makes today's shoulder sessions legacy and the provenance warning fires on them retroactively, which is the correct outcome.

**Nothing in this path recomputes an angle.** `sessionNoteText()` reads the saved record only. It is the same "one value, everywhere" rule the capture path follows: the readout, the overlay, the burned-in snapshot label, the recorder — and now the exported note — are one number, never parallel derivations of it.

**`sessionReportModel(session)` is the shared source of every rendering.** There are two now — the clipboard note and the PDF — so `sessionNoteText()` is a plain-text join over the model and composes nothing itself. A second renderer formatting its own clinical strings is exactly the drift this prevents; `report.test.js` pins that every field the model produces reaches the note. The `warnings` field is a **list** of *data* (`{level, label, tail}`), carrying no glyph, because the two media mark them differently — see the encoding trap below. It is a list because a session can carry more than one caveat at once (legacy scale *and* an un-zeroed minimum); it was a single field, which silently dropped whichever came second. The note emits one `⚠` line each, the PDF one band each, provenance first — it invalidates every number on the page, where the floor caveat qualifies one of them.

### The PDF export (`src/core/pdf.js`, `src/ui/exportPdf.js`, `src/core/frames.js`)

"Copy for note" reaches the note field and nothing else — the two annotated snapshots, the most persuasive part of the record, could not travel at all. eClinicalWorks, WebPT and Prompt all attach outside documents through an upload module built around PDF, so `buildSessionPdf(sessions, imagesBySessionId)` renders one Letter page per session: heading, ROM arc, both named extremes, duration, the calibration line, the warning band, notes, and both frames. Reached from **Export PDF** on SessionDetail and from History's **Select** mode for several sessions at once (pages ordered oldest first). jsPDF is `await import()`ed so it is a lazy ~390KB chunk, precached by the existing Workbox glob — verified to load only on tap, and not to drag in jsPDF's `html2canvas`/`dompurify` (those are for its unused `.html()` method).

**Images are passed in, never fetched by `pdf.js`.** `frames.js` owns the IndexedDB → Storage-redownload → re-cache rule, extracted from `SessionDetailView._resolveFrameUrl` so the view and the export cannot drift on when an evicted snapshot is re-fetched. It returns a Blob, not an object URL — only the caller knows whether it needs pixels or a URL, and only the caller can revoke one. An unresolvable frame prints "image not available" rather than vanishing: a silently absent picture looks like a session that never captured one, which is a different fact.

**The encoding trap — the thing that will silently ship broken.** jsPDF's built-in Helvetica is WinAnsi. `°` (0xB0) and the en dash `–` (0x96) *are* in WinAnsi and render correctly, which matters because `romArc` puts both on the headline. But a character WinAnsi cannot represent does **not** drop itself — jsPDF re-encodes the **entire string** as UTF-16, which the base font renders as garbage. One `⚠`, or one emoji typed into a note on a phone keyboard, corrupts its whole line. So the note's `⚠` prefix must never reach `pdf.js` (the warning is drawn as a filled amber band instead) and **every** string reaching `doc.text()` goes through `winAnsi()`, which replaces by code *point* so an emoji degrades to one `?` rather than two. Verified by inspecting the emitted content stream, not assumed; `pdf.test.js` pins that no drawn string survives a `winAnsi()` round-trip unchanged.

**The Safari gesture rule comes out the opposite way from `_handleCopy`.** Building a PDF means awaiting IndexedDB, possibly a Storage download, and jsPDF — the user gesture is unavoidably gone by the time a file exists, so there is no ordering that preserves it. The download therefore goes through an `<a download>`, which needs no gesture and lands in Files on iOS; `navigator.share()` *does* need a live gesture, so it is offered as a separate **Share PDF…** button revealed after generation, with its own tap. Do not move the share inside `exportSessionsAsPdf()` to save a tap — it fails silently on the one platform this app targets.

**No patient identifier in the document. The filename is a deliberate exception.** The page never names anyone — `buildSessionPdf` is not even *given* a patient record, so that rule is a property of the module boundary rather than of anyone's memory, and `pdf.test.js` pins it on the drawn text.

The filename went the other way, and the reversal is the interesting part. The original no-identifier rule was inherited from the clipboard, where the clinician is already inside the chart when they paste. **A file is not so lucky**: it travels phone → Files → cloud → desktop → EHR upload identified by nothing but its name, and two right-knee sessions exported on the same day produced *byte-identical* filenames. The risk there is not exposure, it is **mis-filing** — attaching one patient's ROM to another's chart, which is its own incident and the worse of the two. So the filename carries a **timestamp always** (the session's own time for a single export, which also makes re-exporting idempotent) and the patient's **initials** when the clinician leaves the setting on: `kineticsiq-jp-right-knee-2026-08-12-1542.pdf`. Both live only in the name, so the identifier exists exactly during the transit window and is gone once the EHR files the document under its own naming. `patientInitials()` lives in `labels.js`; `pdfFilename()` takes the derived string, never a patient.

**The export confirms first, every time** (`confirmExport()` in `exportPdf.js`). It shows the patient's full name *on screen*, previews the exact filename, and is where the initials toggle lives — there is no settings screen in this app, and the moment before the file exists is the only one at which the choice means anything. It is also the last point at which a clinician can catch that they are building a document for the wrong patient, which is why it is not conditional on the export being multi-session: the single export done in a hurry between two patients is precisely the risky one. `exportSessionsAsPdf()` resolves the patient from the sessions' `patient_id` and **omits initials entirely when a selection spans more than one patient**, rather than labelling a mixed file with one of them.

The `⚠`-line caveat above applies here identically, and the PDF raises the stakes — it is a document filed in a chart rather than text in a note. Each entry in `warnings` gets its own band, because a session can be on the legacy scale **and** report an un-zeroed minimum, and a document printing only the first is the failure this module exists to prevent. A zeroed shoulder session still exports with no floor caveat, for the reason given above.

### Separation of concerns

`src/core/` contains only pure functions and classes with no DOM or browser API dependencies (except `CalibrationManager` and `storage.js`, which read/write `localStorage`, and `sync.js` and `frames.js`, which do network I/O but no DOM). These are fully testable in Node via Vitest. DOM manipulation and camera/canvas work lives in `src/ui/` and `src/detection/`; `supabase.js` is the sole boundary to the Supabase SDK. `pdf.js` sits in core because it takes image blobs as arguments and returns a Blob — the download and share, which are DOM and platform work, live in `src/ui/exportPdf.js`.

### Testing notes

`calibration.test.js` mocks `./storage.js` with `vi.mock()` and provides a `global.localStorage` stub. `pose.test.js` mocks `@mediapipe/tasks-vision` using `vi.hoisted()` (required because `vi.mock` is hoisted before variable declarations). `storage.test.js` and `sync.test.js` cover the outbox/merge logic with a `global.localStorage` stub and a mocked `supabase.js` client respectively. `imageStore.test.js` and the migration/wipe tests in `storage.test.js` import `fake-indexeddb/auto` for a real in-memory IndexedDB; `sync.test.js` fakes `client.storage.from().upload/remove` and mocks `imageStore` to cover the `upload_image` op. `enforceBudget` is pinned both ways — it evicts oldest *uploaded* blobs and spares un-uploaded ones. The e2e harness (`scripts/e2e/verify.mjs`) asserts the saved session carries **no** inline image bytes and that two blobs land in IndexedDB, then eyeballs the detail-view frames. It never taps Set Zero, so it also pins that an un-zeroed session records `calibrated: false` — explicitly false, not absent, since absence means something different.

`scripts/verify-floor-caveat.mjs` drives the extension-floor caveat at the surfaces that have no unit tests — the History badge, the SessionDetail chip, the copied note and the exported PDF — by seeding `rom_sessions` and skipping the camera; `scripts/verify-floor-pdf-render.mjs` renders the two-band case to PNG. Give the Playwright context a viewport **taller than the rendered page** or the element screenshot captures everything below the fold as transparent, which reads as a half-painted PDF that is actually fine.

`labels.test.js`, `provenance.test.js` and `report.test.js` cover the wording the clinician actually reads — the last of these guards text that ends up in a permanent medical record, so it pins both what must appear (the arc, the legacy warning, the calibration line) and what must not (any patient identifier). Both are worth more than they look: `extremeLabels()` decides whether a frame is captioned "Peak extension" or "Min flexion", which are claims about different motions, and `calibrationSummary()` must keep "never recorded" distinct from "measured raw". Each is pinned on both sides of the boundary, including exactly 0 — a captured offset of 0.0 is legitimate, and a min of exactly 0 has not crossed neutral.

`angle.test.js` ends with a filter regression suite built on a synthetic cosine sweep (a triangle wave would be unfair to any median — its apex is a single sample, indistinguishable from a spike; a real turnaround dwells near the peak because the limb decelerates). It asserts both directions of the trade-off: the peak is recovered to within ~1°, *and* a stationary joint stays under 0.5° of jitter. Keep both — either alone can be satisfied by tuning the filter into uselessness. The old chain's clipping has its own test so the bug can't quietly return.

Note the untested surface: `src/ui/` has no unit tests, so the wiring in `MeasureView._runDetection()` — the order of overlay draw vs snapshot capture, which value reaches the recorder — is only covered end-to-end. Verify changes there by running the app, not by reasoning about the diff.

**"Copy for note" has no automated coverage at all** — `report.test.js` pins the *text*, but the button, the Safari-gesture ordering, the "Copied ✓" flash and the no-clipboard fallback are in `SessionDetailView`, and `verify:e2e` never opens that control. Changing any of it means driving the app; the `verify` skill has the recipe, including how to skip the camera by seeding `rom_sessions` and how to exercise the fallback path.

`pdf.test.js` covers the PDF with jsPDF **mocked** — it captures every `text()`/`addImage()` call and asserts what the document is told to draw, which is the part carrying clinical meaning. That deliberately proves nothing about the bytes, so the export is also driven end-to-end: seed `rom_sessions` plus IndexedDB blobs (schema `kinetics_images` / `images`, key `` `${sessionId}:${which}` ``), tap the buttons, capture the Playwright download and assert the `%PDF-` header, the page count, embedded image objects and **zero UTF-16 string markers** (`(\376\377` in the content stream — the encoding trap firing). Rendering the result to PNG with `pdfjs-dist` (`npm install --no-save`) is the only way to check layout, glyphs and image aspect by eye; headless Chromium downloads a PDF rather than displaying it, so navigating to the file does not work.
