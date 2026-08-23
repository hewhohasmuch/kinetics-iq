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
- To make the measured angle *change* mid-video, mirror the image for the second half (`ImageOps.mirror`) — the subject's right knee then maps to the other (straight) leg. Mirroring changes the *pose*; prefer it to a geometric squash, which would deform the subject rather than move a limb. (The note that used to sit here — that squash/stretch cannot work because the app measures from 3D world landmarks — stopped being true in #28, when the angle moved to the 2D image landmarks.)

## Network gotchas (remote sandbox)

- `cdn.jsdelivr.net` is blocked by the gateway. Serve the MediaPipe WASM from `node_modules/@mediapipe/tasks-vision/wasm/` via `page.route('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm/**')`.
- `storage.googleapis.com` is reachable — pre-download `pose_landmarker_full.task` with curl and route-serve it to avoid proxy TLS issues in the browser.
- If using Playwright's `proxy` option, set `bypass: 'localhost,127.0.0.1'` or navigation to the dev server gets ERR_CONNECTION_RESET.

## Driving the app

- Seed `rom_patients` + `rom_settings` (`active_patient_id`) via `addInitScript` to boot straight into MeasureView; recording is blocked without an active patient.
- **`addInitScript` passes exactly ONE argument** to the page function. A second one arrives as `undefined`, and `localStorage.setItem(k, JSON.stringify(undefined))` stores the *string* `"undefined"`, which surfaces far away as `migrateInlineImages failed: SyntaxError: "undefined" is not valid JSON` on boot. Pass a single object.
- To verify anything downstream of a recording (History, SessionDetail), **seed `rom_sessions` directly and skip the camera** — it turns a multi-minute run into a few seconds. Sessions need `id` (a real UUID; `sess_*` ids are treated as legacy and stay local-only), `patient_id`, `date` `'YYYY-MM-DD'`, `timestamp`, `min`/`max`/`rom`, `samples`, `duration_s`, `angleTimeline`, `updated_at`. Omit `angleConvention`/`angleFilter` to make one legacy, or set `calibrated`/`calibrationOffset` to exercise the provenance chips.
- To exercise anything to do with the stored frames or **landmark verification**, the session also needs `landmarkSpace` (`'frame1'`, or `'video1'` for a session stored before frames were cropped — nothing branches on which) and `landmarksRaw: { peak, min }`, each set being `{proximal, joint, distal}` of `{x, y, visibility, kind}` with x/y as **normalized fractions**. Omit `landmarkSpace` to make a session legacy — its stored image is then treated as a baked composite and is never drawn over. Add `verifications: [record]` to start from an already-verified session. **Use a BENT set**: collinear points stay collinear under any affine transform, so they read 0° at every resolution and will make a scale- or aspect-related test pass vacuously.
- Key ids: `#btn-start-camera`, `#angle-display` (readout, `--°` until pose found), `#btn-calibrate` (Set Zero, ~2s sampling), `#btn-record-start/stop`, `#btn-notes-skip`, `#btn-history`, `.session-row`, `#btn-signout`, `#btn-new-patient`, `#pf-name`, `.form-save`, login: `#login-email/password/submit`.
- `#btn-history` sits in the controls row, which is **hidden until the camera starts** — Playwright's `click()` waits for visibility and times out. When skipping the camera, wait for `state: 'attached'` and click it through `page.evaluate(() => document.getElementById('btn-history').click())`.
- Model + first detection takes 30–90s headless; wait on `#angle-display` matching `/^-?\d+°$/` with a generous timeout. The `-?` is required — once Set Zero has been tapped, anything past the zero point in the extension direction renders negative.
- `#btn-calibrate` sampling ends on its own after 20 detection frames, which headless (~2Hz) stretches to ~10–20s. Wait for its label to return to `Set Zero` rather than a fixed timeout, then read `#cal-status`.
- SessionDetail's Chart.js has a 400ms entry animation — screenshot too early and the timeline line renders near zero; wait ~1s after the view mounts.
- The overlay angle label is canvas-drawn; assert it by screenshotting and reading the image, not via DOM. Note it is drawn at *view time* from the saved record now, not burned in at capture — so a frame with no overlay means the landmark set never reached the session, not that the capture failed.

## Landmark verification (the editor)

`scripts/verify-landmark-verification.mjs` drives the whole loop; extend that rather than starting over. Ids: `.btn-verify[data-which="peak"|"min"]`, `#btn-unverify`, and inside the modal `#lm-canvas`, `#lm-loupe`, `#lm-angle`, `#lm-lengths`, `#lm-role`, `#lm-cancel`, `#lm-reset`, `#lm-save`.

- Drag with `page.mouse` (the canvas uses pointer events and `touch-action: none`). Points are at normalized positions, so a point seeded at `(0.5, 0.6)` is at `box.x + box.width*0.5, box.y + box.height*0.6`.
- **The drag gain scales with finger speed**, so a "slow" drag has to be paced with real `waitForTimeout` between moves. Playwright dispatches `{steps: n}` moves back-to-back, which is a *fast* drag no matter how many steps — a fine-control test written that way passes whether or not the feature works.
- The **loupe only exists during a drag**. Screenshot between `mouse.down()` and `mouse.up()` or it is never in frame.
- Asserting the image does not move while text below it changes needs the caption **forced** to wrap (set `#lm-lengths` textContent to something long). At a desktop viewport the real string stays on one line, so a guard that waits for the natural case passes with the layout bug still present.

## "Copy for note" (SessionDetail export)

`verify:e2e` never opens this control and `src/ui/` has no unit tests, so the button — `report.test.js` covers only the text it copies — is verified by driving it. Ids: `#btn-copy-note`, `#copy-fallback` (textarea), `#copy-fallback-hint`.

- Grant `permissions: ['clipboard-read', 'clipboard-write']` on the context, then read the result back with `page.evaluate(() => navigator.clipboard.readText())`. The dev server is HTTPS, so the API is available.
- The label swap to `Copied ✓` happens in a `.then()`, so an immediate `textContent` read races it and can still see `Copy for note`. Wait ~200-300ms. It resets after 2s.
- **Exercise the fallback**, which is the real behaviour on a `http://` LAN address or older iOS, not an edge case: `Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })` inside the `addInitScript`, then assert `#copy-fallback` is visible and fully selected (`selectionEnd - selectionStart === value.length`).
- Worth covering both a current session and one with no `angleConvention` — the legacy one must carry the `⚠` line, and a session with `position: null` must produce no dangling `—` in the heading.

## PDF export (SessionDetail + History multi-select)

Ids: `#btn-export-pdf`, `#btn-share-pdf`, `#btn-select-mode`, `#selection-bar`, `#selection-count`, `#btn-export-selected`, `#btn-select-cancel`, `.session-row .row-check`.

**Every export goes through a confirmation sheet first** — `.export-confirm` (backdrop), `.ec-patient`, `.ec-what`, `#ec-filename` (live preview), `#ec-initials` (checkbox), `#ec-cancel`, `#ec-confirm`. Clicking `#btn-export-pdf` no longer downloads anything on its own; wait for `.export-confirm` then click `#ec-confirm`. Worth pinning that Cancel fires **no** download (attach a `page.on('download')` spy and assert it stayed false) and that the `#ec-initials` choice persists into the next export — it saves to `rom_settings` on change, not on confirm.
- Seed the patient with a `dob` and `mrn` so the export can be asserted to leak neither into the file nor its name.

- Use `acceptDownloads: true` on the context and `page.waitForEvent('download')` *before* clicking; `download.saveAs(path)` then `suggestedFilename()` (which must contain no patient identifier).
- **Seed IndexedDB blobs in `addInitScript`** or every export takes the placeholder path: db `kinetics_images`, store `images` (keyPath `key`, indexes `uploaded`/`capturedAt`), record `{key: '<sessionId>:peak'|':min', sessionId, which, blob, uploaded, capturedAt, bytes}`. Seeding only *some* sessions is useful — it exercises "Saved — photos missing" alongside the normal path.
- Assert the bytes, not just that a file arrived: `%PDF-` header, `/Type /Page` count = session count, `/Subtype /Image` present, and **zero** `(\376\377` matches (a UTF-16 string means the WinAnsi trap fired — see CLAUDE.md).
- To *see* the layout, render with `pdfjs-dist` (`npm install --no-save pdfjs-dist`) into a canvas inside a page and screenshot it. Navigating Chromium to a `file://` PDF fails with "Download is starting" — headless has no PDF viewer. pdf.js must be served from a real origin, so `page.route('**/pdfjs/**')` fulfilled from `node_modules/pdfjs-dist/build/` after a `goto` to the dev server.
- Dev serves deps from `/node_modules/.vite/deps/`, not `/assets/` — a response matcher written for production chunk names silently matches nothing and the assertion passes vacuously.
