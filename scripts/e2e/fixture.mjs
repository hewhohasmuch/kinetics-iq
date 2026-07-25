/**
 * fixture.mjs — builds the fake-camera video the E2E run feeds to Chromium.
 *
 * Chromium's --use-file-for-fake-video-capture takes a raw y4m file. We need
 * one containing a pose MediaPipe can actually detect, and the measured angle
 * has to CHANGE during the clip — otherwise the recorded ROM is ~0 and the run
 * proves nothing.
 *
 * So: first half of the clip is a real photo as-is, second half is the same
 * photo mirrored. Mirroring maps the subject's bent knee onto the straight leg,
 * which swings the measured angle across most of its range. Geometric
 * squash/stretch does NOT work — the app measures from MediaPipe's 3D world
 * landmarks, which normalise image-space distortion away.
 *
 * Encoding note: the bundled Playwright ffmpeg can't decode JPEG, and PIL isn't
 * assumed to be present, so Chromium decodes the JPEG (it is a browser) and the
 * YUV conversion happens here in Node.
 */
import { chromium } from 'playwright'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE     = dirname(fileURLToPath(import.meta.url))
export const FIXTURE_DIR = join(HERE, '.fixtures')

// CC0 test image from the MediaPipe asset bucket — yoga warrior pose, the
// subject's right knee bent to roughly 83° of flexion.
const POSE_URL = 'https://storage.googleapis.com/mediapipe-assets/pose.jpg'

const W = 640, H = 480, FPS = 10
const HALF_FRAMES = 25   // 25 normal + 25 mirrored = 5s; Chromium loops the file

/** RGBA -> YUV420 planar (BT.601), laid out as y4m wants it. */
function toYuv420(rgba) {
  const y = Buffer.alloc(W * H)
  const u = Buffer.alloc((W / 2) * (H / 2))
  const v = Buffer.alloc((W / 2) * (H / 2))
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)))

  for (let i = 0; i < W * H; i++) {
    const p = i * 4
    y[i] = clamp(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2])
  }

  // Chroma is subsampled 2x1 in both directions — average each 2x2 block
  for (let j = 0; j < H / 2; j++) {
    for (let i = 0; i < W / 2; i++) {
      let r = 0, g = 0, b = 0
      for (const [dy, dx] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        const p = ((j * 2 + dy) * W + (i * 2 + dx)) * 4
        r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2]
      }
      r /= 4; g /= 4; b /= 4
      const idx = j * (W / 2) + i
      u[idx] = clamp(-0.169 * r - 0.331 * g + 0.5 * b + 128)
      v[idx] = clamp(0.5 * r - 0.419 * g - 0.081 * b + 128)
    }
  }
  return Buffer.concat([y, u, v])
}

/**
 * Ensure the y4m exists, building it if needed. Cached on disk — the file is
 * ~23MB and deterministic, so it is generated once and gitignored.
 *
 * @returns {Promise<string>} absolute path to the y4m
 */
export async function ensureFixture({ force = false } = {}) {
  if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true })

  const jpegPath = join(FIXTURE_DIR, 'pose.jpg')
  const y4mPath  = join(FIXTURE_DIR, 'pose.y4m')

  if (existsSync(y4mPath) && !force) return y4mPath

  if (!existsSync(jpegPath)) {
    const res = await fetch(POSE_URL)
    if (!res.ok) throw new Error(`Could not download ${POSE_URL}: HTTP ${res.status}`)
    writeFileSync(jpegPath, Buffer.from(await res.arrayBuffer()))
  }

  const jpegB64 = readFileSync(jpegPath).toString('base64')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const frames = await page.evaluate(async ({ jpegB64, W, H }) => {
      const img = new Image()
      img.src = 'data:image/jpeg;base64,' + jpegB64
      await img.decode()

      const grab = (mirror) => {
        const c = document.createElement('canvas')
        c.width = W; c.height = H
        const ctx = c.getContext('2d')
        // Cover-fit, the way the app's own video element crops the stream
        const scale = Math.max(W / img.width, H / img.height)
        const dw = img.width * scale, dh = img.height * scale
        if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1) }
        ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh)
        return Array.from(ctx.getImageData(0, 0, W, H).data)
      }

      return { normal: grab(false), mirrored: grab(true) }
    }, { jpegB64, W, H })

    const normal   = toYuv420(frames.normal)
    const mirrored = toYuv420(frames.mirrored)

    const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`)]
    const FRAME = Buffer.from('FRAME\n')
    for (let i = 0; i < HALF_FRAMES; i++) parts.push(FRAME, normal)
    for (let i = 0; i < HALF_FRAMES; i++) parts.push(FRAME, mirrored)

    writeFileSync(y4mPath, Buffer.concat(parts))
    return y4mPath
  } finally {
    await browser.close()
  }
}

// Runnable standalone: node scripts/e2e/fixture.mjs
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const path = await ensureFixture({ force: process.argv.includes('--force') })
  console.log(`fixture ready: ${path}`)
}
