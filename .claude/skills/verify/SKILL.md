---
name: verify
description: How to run and drive KineticsIQ end-to-end in a headless environment (fake camera, mock Supabase) to verify changes at the real UI surface.
---

# Verifying KineticsIQ end-to-end

## Launch

- Local-only mode (no login): `npx vite --host --port 5174 --strictPort` — HTTPS via basic-ssl, use `ignoreHTTPSErrors: true` in Playwright.
- Cloud mode: set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` as process env vars when launching vite (no `.env.local` needed). A ~100-line Node mock covers everything supabase-js calls: `POST /auth/v1/token` (return a GoTrue session payload with a base64url fake JWT), `POST /auth/v1/logout` (204), `GET|POST /rest/v1/patients` and `/rest/v1/sessions` (upsert = merge by `id`, GET = full array). CORS `*` on everything, 204 on OPTIONS.

## Fake camera with a detectable pose

- Chromium flags: `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<file>.y4m`.
- MediaPipe BlazePose detects a real-person photo fine. A known-good CC0 test image: `https://storage.googleapis.com/mediapipe-assets/pose.jpg` (yoga warrior pose, bent right knee ≈ 83° flexion).
- The bundled Playwright ffmpeg cannot decode JPEG/PPM — write the y4m directly with PIL (`YUV4MPEG2 W640 H480 F10:1 Ip A1:1 C420jpeg\n` header, then `FRAME\n` + Y + subsampled U + V per frame).
- To make the measured angle *change* mid-video, mirror the image for the second half (`ImageOps.mirror`) — the subject's right knee then maps to the other (straight) leg. Geometric squash/stretch does NOT work: the app uses MediaPipe's 3D world landmarks, which normalize away image-space distortion.

## Network gotchas (remote sandbox)

- `cdn.jsdelivr.net` is blocked by the gateway. Serve the MediaPipe WASM from `node_modules/@mediapipe/tasks-vision/wasm/` via `page.route('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm/**')`.
- `storage.googleapis.com` is reachable — pre-download `pose_landmarker_full.task` with curl and route-serve it to avoid proxy TLS issues in the browser.
- If using Playwright's `proxy` option, set `bypass: 'localhost,127.0.0.1'` or navigation to the dev server gets ERR_CONNECTION_RESET.

## Driving the app

- Seed `rom_patients` + `rom_settings` (`active_patient_id`) via `addInitScript` to boot straight into MeasureView; recording is blocked without an active patient.
- Key ids: `#btn-start-camera`, `#angle-display` (readout, `--°` until pose found), `#btn-calibrate` (Set Zero, ~2s sampling), `#btn-record-start/stop`, `#btn-notes-skip`, `#btn-history`, `.session-row`, `#btn-signout`, `#btn-new-patient`, `#pf-name`, `.form-save`, login: `#login-email/password/submit`.
- Model + first detection takes 30–90s headless; wait on `#angle-display` matching `/^-?\d+°$/` with a generous timeout. The `-?` is required — once Set Zero has been tapped, anything past the zero point in the extension direction renders negative.
- `#btn-calibrate` sampling ends on its own after 20 detection frames, which headless (~2Hz) stretches to ~10–20s. Wait for its label to return to `Set Zero` rather than a fixed timeout, then read `#cal-status`.
- SessionDetail's Chart.js has a 400ms entry animation — screenshot too early and the timeline line renders near zero; wait ~1s after the view mounts.
- The overlay angle label is canvas-drawn; assert it by screenshotting and reading the image, not via DOM.
