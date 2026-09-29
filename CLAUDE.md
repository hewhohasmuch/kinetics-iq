# CLAUDE.md

Guidance for Claude Code (and any coding agent — `AGENTS.md` points here) working in this repository.

## Commands

```bash
npm run dev          # dev server, HTTPS + LAN (camera on iPhone needs HTTPS)
npm run dev:https    # alias of dev
npm run build        # vite build
npm run preview      # serve the production build (installs the service worker; dev never does)
npm test             # Vitest unit tests (Node, no browser)
npx vitest run src/core/angle.test.js   # one file
npm run verify:e2e   # drive the real app in Chromium against a fake camera (few minutes)
npm run check:schema # does the live Supabase `sessions` table have every column this build writes?
```

**`vite.config.mjs` must stay the only Vite config.** Vite resolves `vite.config.js` first, and a stale one once shadowed the real config so the shipped service worker never cached MediaPipe. After touching Workbox, check `dist/sw.js` for `mediapipe-models`.

**Cloud mode:** copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`; without them the app is local-only (no login, no sync). A fresh project gets `supabase/schema.sql`; an existing one needs every file in `supabase/migrations/` (`0001`–`0006`) **applied before deploying**. (`0002_face_redaction.sql` adds a column the app no longer writes — head redaction was removed in #17 — kept as the record of which snapshots were redacted.) PostgREST rejects unknown columns (`PGRST204`/`42703`); `sync.js` treats that as retryable, keeps the ops and shows a `schema_mismatch` state, so a missed migration stalls sync visibly rather than losing data. Snapshot upload no-ops until the `session-images` bucket exists.

**`verify:e2e`** (`scripts/e2e/README.md`, `--headed` to watch) covers what unit tests can't: camera, MediaPipe, overlay, capture and what lands in storage. It builds a fake-camera y4m from a pose photo, mirrored halfway so the angle moves. Headless Chromium runs BlazePose at ~2Hz rather than 10Hz, so frame-rate-sensitive behaviour still needs a device. For other scenarios (mock Supabase, login, seeded sessions, clipboard fallback) see the `verify` skill (`.claude/skills/verify/SKILL.md`).

## Architecture

**KineticsIQ** is a PWA measuring joint range of motion (knee, hip, shoulder, elbow, ankle; left/right) with MediaPipe Pose on the phone's rear camera. Primary target: iPhone Safari. HTTPS is mandatory — camera access is silently denied on HTTP.

### Views (`src/main.js`)

No router: views are classes with `mount()`/`unmount()` that replace `#app`; `unmount()` stops the camera.

```
(if Supabase configured) Login → Patients → Measure → History → SessionDetail
                                     ↑_______________| (Measure's "switch patient")
```

Without Supabase env vars `boot()` skips Login. A cached supabase-js session skips it too, including offline.

### Signal pipeline (`src/core/`, `src/detection/`) — 10Hz

```
PoseDetector.detect(frameCanvas)         MediaPipe BlazePose Full; a canvas, not the live video (below)
  → getJointPoints(markers)              2D video-pixel points
  → jointAngle(proximal, joint, distal)  interior angle, degrees
  → toClinicalAngle(interior, joint)     per-joint mapping, 0° = neutral
  → MedianFilter3.push()                 rejects single-frame glitches
  → OneEuroFilter.push(v, t)             calm at rest, responsive when moving
  → CalibrationManager.apply()           subtract the captured zero; SIGNED
  → SessionRecorder.record()             (src/core/session.js)
```

**One value, everywhere.** The output of this chain feeds the readout, the overlay label, the stored extremes and `SessionRecorder` — one number, never parallel streams. Two contradicting angles in one patient record is the failure to avoid. Stabilise the *rendering* (rounding, hysteresis on text), never the value; don't reintroduce a display-only filter like the old `DeadZoneFilter`.

**Angles are signed.** Negative = past the zero in the extension direction. `CalibrationManager.apply()` once clamped at 0, which made extension tests record a ROM of 0. Never reintroduce a floor; every consumer (readout, chart axes, e2e regexes) must handle a minus sign.

**Why these filters.** The old `AngleSmoother(15)` → `DeadZoneFilter(2.0)` lagged ~0.7s and clipped 10–15° off the peak of a sweep. One Euro varies its cutoff with speed and takes `dt` per sample. `minCutoff` (default 1.0Hz) is the knob if the readout feels twitchy — lower is calmer. The old classes remain in `angle.js` only for the regression test pinning their clipping.

#### Per-joint convention (`JOINT_ANGLE_CONVENTION`, `angle.js`)

| Joint | Landmarks (proximal → joint → distal) | Neutral interior | Clinical |
|---|---|---|---|
| Knee | hip → knee → ankle | 180° | `180 - interior` |
| Hip | shoulder → hip → knee | 180° | `180 - interior` |
| Elbow | shoulder → elbow → wrist | 180° | `180 - interior` |
| Shoulder | elbow → shoulder → hip | declared 0° (anatomically ~15–25°) | `interior` (elevation) |
| Ankle | shin midpoint (knee+ankle) → ankle → foot index | 90° | `90 - interior` (dorsiflexion +) |

Applying the hinge rule to everything once inverted the shoulder scale. `toInteriorAngle()` is the exact inverse (the overlay draws its arc from it).

**Motion terms differ per joint** — flexion/extension, shoulder elevation/extension, ankle dorsiflexion/plantarflexion — so every user-facing string goes through `motionTerms(joint)` (`angle.js`, accepts the legacy combined `'shoulder_left'` form). `src/core/labels.js` formats for display and owns `JOINT_NAMES`, `JOINT_POSITIONS`/`POSITION_NAMES`/`positionsFor()`, `jointLabel`/`sideLabel`/`positionLabel`/`motionLabel`, `patientInitials()`, and `formatSessionDate`/`formatSessionTime`/`formatDuration`. Don't re-inline any of these in a view. `formatSessionDate` builds a *local* `Date` from `'YYYY-MM-DD'` on purpose (`new Date('2026-08-12')` is UTC and renders as the 11th west of Greenwich).

- **`extremeLabels(joint, min)`** names a session's two ends, for both stat cards and snapshot captions. The min is the *negative* term only if it actually crossed zero (a min of exactly 0 has not).
- **ROM is reported as the arc**: `romArc(min, max)` → `5° – 120°` leads; `rom` is the secondary "115° total". Two knees with the same total can differ by an extension deficit, which is the finding. The History trend chart plots both extremes, is scoped by joint+side chips, and uses `suggestedMin` rather than `min: 0`.
- **`reportedExtremes()` (`src/core/extremes.js`)** is the single accessor for which numbers a session reports — model extremes, or clinician-verified endpoints (below). Every consumer reads from it; it deliberately has no `min`/`max` keys.

#### The angle is 2D; 3D world landmarks were tried and dropped

3D world landmarks defeat perspective foreshortening but carry monocular **depth error**, which measured larger. Right elbow vs a goniometer, ground truth from `scripts/measure-silhouette-axis.mjs` (fits the limb axis from skin pixels, independent of MediaPipe):

|  | min | peak | ROM |
|---|---|---|---|
| truth (silhouette) | 10.4° | 140° | 129.6° |
| 2D landmarks | 0.1° | 133.8° | 133.7° (+3%) |
| 3D world | 13.6° | 115.4° | 101.8° (−21%) |

Depth error reverses sign across the range, so no single-offset calibration can fix it, and rigid world-space bone lengths drift **7.8% RMS** between frames. Don't reintroduce the 3D path; world landmarks are used only for `segmentTilt()`. Two hypotheses were tested and killed — don't re-derive them: (1) "the forearm was ~38° out of plane" (a ±2px elbow shift swings the inferred tilt 14°); (2) "constrain to fixed bone lengths and solve depth" (collapses to the 2D angle at min flexion). **Bone-length drift is a diagnostic, not a corrector.**

The remaining error is **landmark placement**, concentrated in the proximal point: in the elbow min frame the shoulder→elbow vector leans 11.5° off the humerus, while the forearm is within 0.5°. Landmark 12 sits near the acromion, not the humeral head. One frame, one subject — **don't hardcode a correction**; it needs goniometer data across joints and subjects.

**Out-of-plane guard.** A 2D angle is only right while the limb moves parallel to the image plane. `PoseDetector.segmentTilt()` returns the worse segment's `acos(|seg_xy| / |seg_xyz|)`. It is deliberately coarse, since it divides by the same drifting world lengths. `MeasureView` shows a numberless caution above `PLANE_TILT_WARN_DEG` = 25° with hysteresis on the clear edge only, and saves the bout's worst excursion as `maxSegmentTilt`. The caution sits above the selector drawer: `_openDrawer()` and `_renderPositions()` measure the drawer and set `--plane-warning-bottom`, because the open drawer covered it exactly when the clinician is aiming. Anything else anchored to the bottom of `.camera-stack` has the same collision; check it by driving the app.

#### Known limitations — don't "fix" by eye

**The raw reading floors at neutral.** `jointAngle()` is an `acos` in [0, 180]. Where `neutralInterior` sits at an end of that interval (knee/hip/elbow at 180, shoulder at 0), the whole range folds onto one side of zero. Landmark error at neutral is then *rectified* rather than cancelling, no filter removes it, and a raw hinge session **cannot show hyperextension**. The ankle (90) is unaffected. `rawCannotGoBelowNeutral()` derives this from the convention table.

**Error that reverses sign across the range defeats Set Zero.** `CalibrationManager.apply()` is a single subtraction:
- *Shoulder*: raw 24.6°→160.7° (true ~0→175); after Set Zero at the side, −1.4°→129.8° — further from truth.
- *Supine knee* (measured with `scripts/measure-overlay-dots.mjs` under the old 3D path): recorded angle minus drawn 2D landmarks was +8.2° flat and −5.5° bent.

**Never present Set Zero as the cure for a floored joint**, in the UI or exports (`provenance.test.js` pins this). Fixing either limitation needs goniometer readings at both ends and probably a two-point span calibration. When it happens, bump `CALIBRATION_VERSION` and the `angleConvention` stamp.

**Calibration versioning.** `CalibrationManager` stores `calibration_version` (currently 3) and discards a stale offset once on upgrade, prompting a re-zero. Bump it for any change that rescales the raw angle: v2 = per-joint convention, v3 = 3D→2D. `isCalibrated` uses an explicit `calibration_captured` flag, because an offset of exactly 0.0 is a legitimate capture.

### Frames: one buffer per tick, stored clean and cropped

**Read the video once per tick.** `MeasureView._runDetection()` blits the `<video>` into `this._frameCanvas` and passes that canvas to both `detector.detect()` and `_captureFrameTo()`. Two `drawImage(videoEl)` calls can land on different decoded frames, which would store landmarks that don't describe the stored picture. Never read `videoEl` directly in the capture path. `PoseDetector.detect(source)` therefore accepts a canvas or a video (`videoWidth ?? width`).

**Snapshots are stored clean.** Pixels are stored with no overlay, dpr scaling or display transform, next to the normalized landmarks that produced the angle. The overlay is drawn at *view time* by `src/core/frameRender.js` from the saved record, so the label always matches the record and follows a clinician's verification. Don't reintroduce compositing. It once burned the *previous* frame's label onto an extreme; that constraint is documented at the capture site.

**Cropped to what was on screen.** The video is `object-fit: cover`, so the screen shows a centred crop (barely a third of a landscape buffer on a portrait phone). `src/core/frameCrop.js` owns the geometry. `coverTransform()` is the single cover-maths implementation, used by both `Overlay.resize()` and the capture; `storedFrameRect()` decides what a snapshot contains. A landmark outside the visible region widens the rect rather than being cut off. An unknown crop (layout not settled) stores the whole frame. The rect is snapped to whole pixels. Cropping never changes an angle (pinned on both axes in `landmarks.test.js`).

**Encoding.** `_encodeCapture()` runs once at save time. It downscales to `SNAPSHOT_MAX_EDGE` (1100px longest edge), then encodes JPEG at `SNAPSHOT_QUALITY` 0.78 (~120–180KB). Dimension is the main lever; low quality rings around fine detail. The blob goes to **IndexedDB via `imageStore`, never onto the session** (inline base64 overflowed localStorage). `_updateStorageGauge` shows cache use and upload backlog.

**Landmark record (`src/core/landmarks.js`).** `landmarks.js` owns `JOINT_CONFIG` (`pose.js` re-exports it) so the pure layer never imports MediaPipe. A config entry is a landmark index or `{ midpoint: [a, b] }` (both must clear visibility). `landmarkKind()` derives `'anatomical'` vs `'derived'` from the config; the ankle's shin midpoint is derived and must be labelled "shin direction", never "joint centre". Coordinates are fractions of the stored frame (`normalizeSetInRect`), stamped `landmarkSpace: 'frame1'`; the older `'video1'` means fractions of the whole uncropped buffer. Nothing branches on which one, since consumers size from the stored image. **Absent `landmarkSpace` = legacy baked composite**: show it as-is, or the skeleton doubles.

**One renderer.** `drawPoseOverlay()` in `src/detection/overlay.js` serves both the live view and `frameRender`, taking an explicit `ctx` and `scale`. Overlay scale references the frame's **longest** edge (`frameScale`); stored frames are often landscape, where height-based sizing drew it at half size. `frameRender.js` returns the **original blob unchanged** when there is nothing to draw (legacy composite, incomplete set, decode failure), and prefers a clinician's verified set over the raw one. It sits in `core/` because it is Blob in, Blob out.

**Live overlay.** `Overlay.resize()` maps video pixels to display CSS pixels through `coverTransform()`. Call it whenever the video starts or the layout changes. `Overlay.visibleVideoRect()` reports the crop and returns null rather than a stale rect.

### Clinician-verified endpoints (`src/ui/LandmarkEditor.js`)

**Verify landmarks** under either stored frame opens an editor. The clinician drags the three points onto the joint centres they can see, and the angle recomputes live.

- **Annotation, not a rewrite.** `min`, `max`, `rom`, `angleTimeline` and `landmarksRaw` are never written. A verified value is an **endpoint observation on one frame**, not a timeline maximum: only the extremes have frames, so a peak verified downward may leave a higher unverifiable sample. ROM between verified endpoints is a different, possibly narrower quantity, and the note and PDF attribute it (`romAttribution`).
- **`recomputeAngle()` needs the frame's aspect ratio.** Normalized x/y are scaled non-uniformly, and computing in that space is silently >5° wrong on 16:9. Project back to pixel space first. Integer rounding of stored dimensions leaves ~0.1°, pinned as bounded.
- **Drag gain scales with finger speed** (same trade as One Euro): slow movement is precise, fast is 1:1. The point lags the finger during fine work, and the dashed ring and the loupe (which follows the point) make that visible.
- **The image must never move mid-drag.** The stage hugs the canvas, the card is top-anchored, and two lines are reserved for the length advisory. `verify-landmark-verification.mjs` forces the advisory to wrap and asserts the image stays put.
- **Bone length is advisory, never a lock**: a caution appears past `LENGTH_CAUTION` (15%) change.
- **Attribution is not qualification.** `by`/`byMode`/`byDevice` record who and how. There is no role model (`clinician_id` is just `auth.uid()`), so the strongest claim is *clinician-verified observation*. No surface may say **validated**, **corrected** or **accurate** (pinned in `report.test.js`, `pdf.test.js`, `provenance.test.js`). Exports state fact and mode, never an identifier.
- **`verificationSummary()`** is its own model field, beside `calibrationSummary()`. It is shown green in the UI and as a *neutral* band in the PDF, never amber and never in `warnings`.
- **`extensionFloorCaveat()` changes its claim rather than switching off.** Verification removes the rectified noise but not the `acos` bound. A verified min above the bound drops the caveat; one sitting at the bound gets "Cannot show hyperextension".
- **Trend chart provenance** is carried by shape: triangle = legacy, circle = model, diamond = verified. The segment between classes fades, and the tooltip states the source.
- An unsynced verification is an outbox `upsert_session` op, so sign-out's `pendingCount` refusal already covers it. Don't narrow that check to images.

### MeasureView selection (`src/ui/MeasureView.js`)

The selector drawer picks joint, side and position, handed to `SessionRecorder.setContext()` and `setCalibration()` before `start()`. The position row renders from `JOINT_POSITIONS`. **No position is selected until the clinician taps one** (`_position` stays `null`). Both previous designs, a hidden default and auto-selecting the first entry, filed clinical claims nobody made. History/SessionDetail omit the badge for null, and the drawer reads "position not set". Switching joint, side or patient clears the calibration offset.

### Accounts & cloud sync

Optional, gated by `isConfigured()`.

- **`supabase.js`** is the only importer of `@supabase/supabase-js` (auth wrappers + lazy client).
- **`sync.js`**: views only touch `storage.js`, and sync runs in the background. Push drains an oldest-first outbox, deduped per entity+type. Pull selects `patients`/`sessions` (RLS-scoped) and merges last-write-wins on `updated_at`. It triggers on login, `online`, visibility change and every enqueue; there is no polling. Network and schema-mismatch errors keep the op; other 4xx/RLS errors drop it, logging only the id (PHI). Snapshots ride the outbox as `upload_image` ops to the private `session-images` bucket; only `peak_frame_path`/`min_frame_path` sync on the row. Deleting a session removes its objects. **Every session field must map both ways** — a pull once stripped `angleFilter`/`angleConvention`. `sync.test.js` pins each direction per field, including `maxSegmentTilt` 0 surviving as 0.
- **`imageStore.js`** is the only IndexedDB module (`kinetics_images`/`images`, key `` `${sessionId}:${which}` ``). Every capture lands there first. Past `BUDGET_BYTES` (45MB), `enforceBudget()` evicts the oldest **uploaded** blobs, never un-uploaded ones. Evicted frames re-download on demand. It no-ops without `indexedDB`.
- **`frames.js`** owns the IndexedDB → Storage re-download → re-cache rule for both SessionDetail and the PDF export, and returns a Blob (the caller owns any object URL).
- **`id.js`** generates client v4 UUIDs so offline records upsert without remapping. Legacy `sess_<timestamp>` ids fail `isUuid()` and stay local-only.
- **Sign-out** (`clearAllLocalData()`) wipes local data including blobs. `PatientsView` first drains the outbox and **refuses** while any op is pending or any blob is un-uploaded (`imageStore.listPending()`).

**Password reset (`src/core/authRedirect.js`, `LoginView` `forgot`/`recovery`).** `resetPasswordForEmail` redirects to the current page, which must be on the Supabase **Redirect URLs** allowlist (deployed and LAN dev URLs). The link's hash becomes a live signed-in session, so `boot()` parses the hash *before* creating the client and sets a `sessionStorage` recovery guard. While it is set, nothing calls `enterApp()`. Only a successful `updateUser()` or sign-out clears it. Clear the hash only **after** `await getSession()`, or the link never signs in. The forgot form says the same thing whether or not the account exists, but a failed send (~2 emails/hour on the built-in sender) says so. On iPhone the link opens in Safari, not the installed app.

Two device-only failures are handled:
- *Session vanishes before Save* (`Auth session missing!`, unreproducible elsewhere). The link's tokens are kept in `sessionStorage` (`kiq_recovery_tokens`, dropped by `endRecovery()`). On `AuthSessionMissingError`, `LoginView` calls `setSession()` and retries once, showing a `ref` code from `formatRecoveryDiagnostics()`. **Read that code before changing this flow.**
- *An old cached build spends the link.* `boot()` catches it with `isUnfinishedResetSession()`. JWT `amr` = `otp` alone proves nothing (magic links and signups share it), so the check also requires the session to follow `recovery_sent_at` within the link lifetime and not match `rom_settings.recovery_completed_session`, which `LoginView` writes on every successful save.

`scripts/verify-password-reset.mjs` drives all of this against a mock Supabase whose tokens carry real-shaped `amr`/`session_id`/`recovery_sent_at`. Test service-worker bugs against `vite build` + `vite preview`; `--webkit` runs Safari's engine.

### Persistence (`src/core/storage.js`)

The only localStorage module; local-first, with every mutation also enqueuing an outbox op. Keys: `rom_sessions`, `rom_settings` (calibration, active patient, `export_include_initials` — whose only UI is the export sheet), `rom_patients`, `rom_outbox`. `migrateInlineImages()` moves pre-IndexedDB inline `peakFrame`/`minFrame` data URLs into `imageStore` on boot.

**Session fields.** `joint`, `side`, `position` (null = not chosen). Pre-split sessions have `joint: 'knee_right'` and no `side`, and the UI handles both shapes. Stamp a new value on the relevant field for **any** change that alters measured numbers. **Absence is always a distinct third state — never collapse it to a default.**

| Field | Current | Absent / other |
|---|---|---|
| `angleMode` | `'2d2'` | `'3d'` = depth-estimated, flagged; absent = pre-3D 2D era (not flagged) |
| `angleFilter` | `'euro1'` | absent = old moving average, peaks clipped |
| `angleConvention` | `'perjoint1'` | absent = inverted shoulder, ankle +90°, clamped zero — **unrecoverable, left unmigrated** |
| `calibrated` / `calibrationOffset` | `true`/`false` + offset | null = "Calibration not recorded", ≠ `false` (measured raw); migration left rows NULL deliberately |
| `maxSegmentTilt` | degrees | null = never measured, ≠ 0 |
| `landmarkSpace` | `'frame1'` (stamped unconditionally) | `'video1'` = uncropped; absent = legacy composite, not verifiable |
| `landmarksRaw` | `{peak, min}`, **immutable** | either end may be null (landmark below visibility) |
| `verifications` | array (≤1 today) | null/`[]` = never verified |

Also: `modelId`/`modelVersion`; `frameAngleRawMax`/`frameAngleRawMin` (the *unfiltered* angle at each extreme frame); `frameTiltMax`/`frameTiltMin` (per-frame tilt, not recomputable after a drag); `peakFramePath`/`minFramePath`. Calibration is stamped by `SessionRecorder.setCalibration()` at start, which is safe because `_btnCalibrate` is disabled while recording. `captured` is passed explicitly.

**Surfacing provenance (`src/core/provenance.js`).** `sessionProvenance()` returns the worst of three mutually exclusive verdicts: `convention`, then `depth` (`angleMode === '3d'` only), then `filter`. `calibrationSummary()` does the same for calibration. History and SessionDetail show an amber badge; legacy points are *marked* on the trend chart, not dropped. Consumers branch on `level !== 'ok'` and read `label`/`reason`. A new verdict needs a new case only in `report.js`'s `warningTail()`.

### Export (`src/core/report.js`, `pdf.js`, `src/ui/exportPdf.js`)

**`sessionReportModel(session)` is the single source for both renderings**: the **Copy for note** text (`sessionNoteText()`, a plain join) and the PDF. Nothing in the export path recomputes an angle; it reads the saved record through `reportedExtremes()`. The calibration line is **always** emitted. `warnings` is a *list* of data (`{level, label, tail}`) with no glyph, provenance first, because a session can carry several. The note prints one `⚠` line each; the PDF prints one amber band each.

`extensionFloorCaveat()` reads the *measurement*, not stamps, so it fires on current sessions. It fires only on `calibrated === false`, since an arc like `9° – 121.8°` would otherwise claim an extension lag the raw reading cannot see. A zeroed current shoulder session exports with no floor caveat. That gap is the shoulder limitation, not a `report.js` bug; the future `angleConvention` bump will flag those sessions retroactively.

**Copy for note.** No patient name, DOB or MRN (pinned): the iOS clipboard is readable by any app and syncs across devices. Build the string synchronously and call `navigator.clipboard.writeText()` **first** in the handler; any earlier `await` loses Safari's gesture and the write fails silently. The fallback is a selected read-only `<textarea>`. (eClinicalWorks' free FHIR APIs are read-only, hence the clipboard.)

**PDF** (`buildSessionPdf(sessions, imagesBySessionId)`, one Letter page per session, History **Select** mode for several, oldest first). jsPDF is `await import()`ed as a lazy ~390KB chunk; don't pull in its `html2canvas`/`dompurify`. Images are passed in, never fetched by `pdf.js`, and an unresolvable frame prints "image not available".

- **Encoding trap.** Helvetica is WinAnsi. `°` and `–` are fine, but one unrepresentable character (`⚠`, an emoji in a note) makes jsPDF re-encode the **whole string** as UTF-16, which renders as garbage. **Every** string passed to `doc.text()` goes through `winAnsi()` (per code point), and warnings are drawn as bands, not glyphs.
- **`doc.text()` neither wraps nor clips.** The headline once shipped truncated. Qualifiers travel as their own model field (`romAttribution`), never concatenated. The headline goes through `fitFontSize()`. The test stub must model `getTextWidth`.
- **Gesture.** A PDF needs awaits, so the download uses `<a download>` (no gesture needed). `navigator.share()` needs a live gesture, so it is a separate **Share PDF…** button revealed afterwards. Don't fold it into `exportSessionsAsPdf()`; it fails silently on iOS.
- **Identifiers.** The page never names the patient (`buildSessionPdf` isn't given one). The **filename** does, deliberately: a file travels identified only by its name, and identical names risk mis-filing into the wrong chart. `pdfFilename()` always includes a timestamp (the session's own for a single export) plus initials when enabled, e.g. `kineticsiq-jp-right-knee-2026-08-12-1542.pdf`. Initials are omitted when a selection spans several patients.
- **`confirmExport()` runs every time.** It shows the patient's full name on screen, previews the filename and hosts the initials toggle. It is the last chance to catch the wrong patient.

### Separation of concerns

`src/core/` is pure and Node-testable. The exceptions: `CalibrationManager`/`storage.js` (localStorage), `imageStore.js` (IndexedDB), `sync.js`/`frames.js` (network, no DOM), and `pdf.js`/`frameRender.js` (Blob in, Blob out; `frameRender` imports overlay primitives on purpose — one renderer beats a clean layer boundary). `landmarks.js` and `frameCrop.js` are pure so anatomy and crop questions never need MediaPipe or a DOM; `detection/overlay.js` imports `frameCrop`, not the reverse. DOM, camera and canvas work lives in `src/ui/` and `src/detection/`. `src/detection/aruco.js` is dead pre-MediaPipe code; don't build on it.

### MediaPipe loading (`src/detection/pose.js`)

`PoseDetector.init()` loads BlazePose Full (~7MB) from Google's CDN and the WASM from jsDelivr. The production service worker caches both (`mediapipe-models`/`mediapipe-wasm`, CacheFirst, 90 days). Landmark indices use MediaPipe's subject-anatomical left/right.

## Testing

**`src/ui/` has no unit tests.** Wiring in `MeasureView._runDetection()`, the copy button, the drawer and the editor are only covered by driving the app, so verify changes there by running it, not by reading the diff.

Unit-test notes:
- `calibration.test.js` mocks `./storage.js` and stubs `global.localStorage`.
- `pose.test.js` mocks `@mediapipe/tasks-vision` via `vi.hoisted()`.
- `imageStore.test.js` and parts of `storage.test.js` use `fake-indexeddb/auto`.
- `sync.test.js` mocks the Supabase client, including `storage.from().upload/remove`.
- `angle.test.js` filter suite uses a cosine sweep (a triangle apex is indistinguishable from a spike). It asserts **both** peak recovery within ~1° and stationary jitter under 0.5°; keep both, since either alone can be met by a useless filter.
- `overlay.test.js` and `pdf.test.js` pin the *sequence of draw calls*, not pixels. Layout bugs are invisible there — render the PDF with `pdfjs-dist` (`npm install --no-save`) to look.
- Wording tests (`labels`, `provenance`, `report`, `pdf`) pin both sides of each boundary, including exactly 0, plus what must never appear (identifiers, "validated").

E2E and scripts (camera-free ones seed `rom_sessions`, plus IndexedDB blobs where frames matter):
- `scripts/e2e/verify.mjs` checks no inline image bytes, two IndexedDB blobs, `calibrated: false` (never taps Set Zero), landmark stamps, fractions within 0..1 with a `kind` per point, unfiltered frame angles, and **stored frame aspect = camera stack, not the video stream** (the only proof the crop reaches the snapshot).
- `verify-landmark-verification.mjs` covers the whole verify → save → revert loop at the real UI, asserting the raw record is untouched.
- `verify-floor-caveat.mjs` covers the History badge, chip, note and PDF. `verify-floor-pdf-render.mjs` renders to PNG; the viewport must be taller than the page or the capture is half transparent.
- PDF bytes, driven end-to-end: check the `%PDF-` header, page count, image objects and **zero `(\376\377` UTF-16 markers**. Headless Chromium downloads PDFs rather than displaying them.
- `measure-silhouette-axis.mjs` is the only tool that judges the app independently of MediaPipe (reproduces 10.4° with `--seg1 396,448,820,845 --seg2 400,448,866,896`). **Always pass `--out` and look at the samples.** A low residual can sit on the wrong structure (a door frame, 78° off), and overlapping segments need separate x windows. `measure-overlay-dots.mjs` only reads what the landmarks describe.
- Photos of people used in investigations are deliberately not committed.
