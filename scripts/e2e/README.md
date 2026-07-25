# End-to-end verification

Drives the real app in Chromium with a fake camera, so the parts that unit tests
can't reach get exercised: camera start, MediaPipe detection, the overlay canvas,
the snapshot compositing, and what actually lands in localStorage.

```bash
npm run verify:e2e                                  # starts its own dev server
npm run verify:e2e -- --headed                      # watch it run
npm run verify:e2e -- --url https://localhost:5173/ # reuse a running server
```

First run takes a few minutes — it downloads the pose image, encodes the
fake-camera video, and MediaPipe fetches a ~7MB model. Later runs reuse the
cached fixture in `.fixtures/` (gitignored).

## How the fake camera works

Chromium's `--use-file-for-fake-video-capture` takes a raw **y4m** file.
`fixture.mjs` builds one from a CC0 photo in the MediaPipe asset bucket — a yoga
warrior pose whose right knee sits at roughly 83° of flexion.

The clip's first half is the photo as-is and its second half is mirrored.
Mirroring maps the subject's bent knee onto the straight leg, swinging the
measured angle across most of its range, so the run records a real ROM instead
of a flat line. Geometric squash/stretch does **not** work here: the app
measures from MediaPipe's 3D world landmarks, which normalise image-space
distortion away.

Chromium decodes the JPEG and Node does the YUV conversion — the ffmpeg bundled
with Playwright can't decode JPEG, and this way there's no Python/PIL dependency.

## What it asserts

- The app boots into MeasureView with a seeded active patient.
- A pose is detected and the readout shows degrees.
- A recording saves exactly one session, with `angleMode: '3d'`.
- The angle moved (guards against a fixture that stopped looping).
- **The saved `min`/`max` are values the readout actually displayed.** The
  extremes in the record must be numbers the clinician saw, not a separately
  filtered stream. Every rendered value is captured losslessly by a
  `MutationObserver` in the page — polling from Node drops values and makes this
  comparison untrustworthy.
- Both extreme snapshots are encoded as JPEG data URLs.
- The session appears in History and SessionDetail renders.
- No console errors.

The screenshot written to `.fixtures/session-detail.png` is worth a look: the
angle burned into each range-of-motion frame should match its caption. A
mismatch there means the snapshot is being composited out of step with the
overlay draw.

## Known environment limits

- Headless Chromium runs BlazePose on **CPU**, landing around 2Hz rather than
  the app's 10Hz target. The run reports the achieved rate instead of asserting
  one. Anything sensitive to the real frame rate — how calm the readout feels,
  the resolution of a fast movement's peak — still needs a device check.
- The dev server uses a self-signed certificate, hence `ignoreHTTPSErrors`.
- Local-only mode: no Supabase, so login is skipped. For cloud mode see the
  `verify` skill in `.claude/skills/verify/`.
