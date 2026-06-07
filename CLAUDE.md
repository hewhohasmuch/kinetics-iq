# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # start dev server (HTTPS + LAN-accessible, required for camera on iPhone)
npm run dev:https    # alias — same as dev
npm run build        # vite build
npm test             # run Vitest unit tests (Node environment, no browser needed)
```

Run a single test file:
```bash
npx vitest run src/core/angle.test.js
```

## Architecture

**KineticsIQ** is a PWA that uses MediaPipe Pose and the phone rear camera to measure joint range of motion (ROM). Supports Knee, Hip, Shoulder, and Elbow on left or right side. Primary target is iPhone Safari. HTTPS is mandatory — camera access is silently denied on HTTP.

### View routing (`src/main.js`)

Three views are manually swapped by replacing `#app` innerHTML. No router library. Views are plain JS classes with `mount()` / `unmount()` lifecycle methods. The active view is tracked as `currentView`; `unmount()` stops the camera and clears the DOM before the next view mounts.

```
Measure → History → SessionDetail → (back) History → (back) Measure
```

### Signal processing pipeline (`src/core/`, `src/detection/`)

Each detection frame at 10Hz follows this pipeline:

```
PoseDetector.detect(videoElement)   [MediaPipe BlazePose Full, CDN-loaded]
  → jointAngle(proximal, joint, distal)  [interior angle at selected joint in degrees]
  → toFlexionAngle()              [180 - interior = clinical flexion: 0° = straight]
  → AngleSmoother.push()          [moving average window, default 10 frames]
  → DeadZoneFilter.push()         [suppress flicker < 1.5° change]
  → CalibrationManager.apply()    [subtract offset captured at "zero" position]
  → SessionRecorder.record()      [accumulate during active recording]
```

### MediaPipe Pose loading (`src/detection/pose.js`)

`PoseDetector.init()` loads the BlazePose Full model (~7MB) from Google's CDN on first use. The WASM runtime is loaded from jsDelivr. Both are cached by the Workbox service worker (90-day TTL) so subsequent loads are instant and offline-capable.

`PoseDetector.detect(videoElement)` passes the live video element directly to MediaPipe (no canvas capture needed). MediaPipe returns normalized landmarks (0–1); the detector multiplies by `videoWidth`/`videoHeight` to produce video pixel coordinates that the rest of the pipeline expects.

Landmark roles (proximal → joint → distal) per joint:
```
Knee:     hip → knee → ankle
Hip:      shoulder → hip → knee
Shoulder: elbow → shoulder → hip
Elbow:    shoulder → elbow → wrist
```
Indices use MediaPipe's subject-anatomical left/right. See `JOINT_CONFIG` in `pose.js`.

### Overlay coordinate math (`src/detection/overlay.js`)

The video uses `object-fit: cover`, which crops and scales the video stream to fill the camera div. The canvas overlay sits on top and must match the *displayed* image, not the raw video pixels. `Overlay.resize()` computes the `object-fit: cover` scale factor and offsets, then `_toDisplay()` maps every landmark coordinate from video-pixel space to display-CSS-pixel space before drawing. This must be called whenever the video starts or the layout changes.

### Persistence

All data lives in `localStorage` (keys: `rom_sessions`, `rom_settings`). `src/core/storage.js` is the only place that touches localStorage. `CalibrationManager` persists its offset via `saveSettings()`; sessions are saved after the user confirms in the notes panel.

Sessions have separate `joint` (knee/hip/shoulder/elbow) and `side` (left/right) fields. Old sessions saved before this format had `joint: 'knee_right'` (combined) and no `side` field — the UI handles both shapes gracefully.

### Separation of concerns

`src/core/` contains only pure functions and classes with no DOM or browser API dependencies (except `CalibrationManager` which uses `storage.js`). These are fully testable in Node via Vitest. DOM manipulation and camera/canvas work lives in `src/ui/` and `src/detection/`.

### Testing notes

`calibration.test.js` mocks `./storage.js` with `vi.mock()` and provides a `global.localStorage` stub. `pose.test.js` mocks `@mediapipe/tasks-vision` using `vi.hoisted()` (required because `vi.mock` is hoisted before variable declarations). Tests for `storage.js` itself are intentionally absent — the file is thin JSON wrappers; browser manual testing is used instead.
