/**
 * measure-silhouette-axis.mjs
 *
 * Measures a joint angle from the LIMB SILHOUETTE in a saved snapshot, with no
 * reference to MediaPipe at all.
 *
 * WHY THIS EXISTS: measure-overlay-dots.mjs reads the angle the landmarks
 * describe. That answers "what did the app compute", not "what was the joint
 * actually doing" — and when the two disagree, only an independent measurement
 * can say which is wrong. This is that measurement. It is how the elbow finding
 * in CLAUDE.md was established: at the extension end the limb was at 10.4°, the
 * drawn landmarks said 0.1°, and the app recorded 13.6°. All three differ, and
 * without this tool there is no way to know which of them to fix.
 *
 * METHOD: for each horizontal scanline across a band of the limb, find the
 * widest run of skin pixels and take its midpoint. Those midpoints trace the
 * limb's medial axis. Fit a least-squares line to a band on each segment; the
 * angle between the two lines is the joint angle as the pixels see it.
 *
 * READ THIS BEFORE TRUSTING A RESULT — two failure modes bit the original
 * investigation, and both produce confident-looking numbers:
 *
 *   1. A LOW RESIDUAL ON THE WRONG STRUCTURE. The fit will happily lock onto a
 *      door frame, a shadow, or the far leg. ALWAYS pass --out and look at the
 *      rendered sample points. A 1.4px residual on a door frame still reads as
 *      a clean fit; that exact mistake produced a 78° error before it was
 *      caught by looking at the picture.
 *
 *   2. OVERLAPPING SEGMENTS. Near end range the two limb segments share
 *      scanlines, and one band silently swallows both. Each band therefore
 *      takes its own x window; keep them disjoint. Where one segment crosses in
 *      FRONT of the other it has no clean silhouette at all and cannot be
 *      measured this way — a real limit, not a tuning problem.
 *
 * The skin rule below is tuned for one subject against a dark shirt. It is not
 * general. Retune it per image and verify with --out.
 *
 * Usage:
 *   node scripts/measure-silhouette-axis.mjs <image> \
 *     --seg1 x0,x1,y0,y1 --seg2 x0,x1,y0,y1 [--view x,y,w,h] [--out check.png]
 *
 * Example — the min-flexion frame of the right-elbow session:
 *   node scripts/measure-silhouette-axis.mjs "tmp/right elbow_not seated.png" \
 *     --seg1 396,448,820,845 --seg2 400,448,866,896 \
 *     --view 390,795,70,130 --out check.png
 *   => seg1 lean 0.2°, seg2 lean 10.6°, flexion 10.4°
 */
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const src  = argv[0]
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name)
  return i === -1 ? def : argv[i + 1]
}
const nums = s => s.split(',').map(Number)

if (!src || !flag('seg1') || !flag('seg2')) {
  console.error('usage: measure-silhouette-axis.mjs <image> --seg1 x0,x1,y0,y1 --seg2 x0,x1,y0,y1 [--view x,y,w,h] [--out f.png]')
  process.exit(1)
}

const S1      = nums(flag('seg1'))
const S2      = nums(flag('seg2'))
const outPath = flag('out')
const view    = flag('view') ? nums(flag('view')) : null
const UP      = 11

const b64 = readFileSync(src).toString('base64')
const browser = await chromium.launch()
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas><canvas id="v"></canvas>')

const r = await page.evaluate(async ({ b64, S1, S2, view, UP, wantPng }) => {
  const img = new Image()
  await new Promise(res => { img.onload = res; img.src = 'data:image/png;base64,' + b64 })
  const c = document.getElementById('c')
  c.width = img.width; c.height = img.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  const D = ctx.getImageData(0, 0, c.width, c.height).data
  const at = (x, y) => { const i = (y * c.width + x) * 4; return [D[i], D[i + 1], D[i + 2]] }

  // Skin is warm and saturated: roughly (180,130,100). The exclusions are the
  // overlay graphics this app burns into its snapshots — the three joint dots
  // and the arc — which would otherwise split or bias a scanline's run.
  const isSkin = (r, g, b) =>
    r > 100 && r < 235 && r - b > 45 && g - b > 12 && b < 165 && g < 195 &&
    !(g > 170 && b < 150 && r < 150) &&   // green joint dot
    !(r > 200 && b > 130 && g < 150) &&   // pink distal dot
    !(b > 175 && r < 130) &&              // blue proximal dot
    !(r > 200 && g > 170 && b < 110)      // yellow arc

  const band = ([xlo, xhi, ylo, yhi]) => {
    const pts = []
    for (let y = ylo; y <= yhi; y++) {
      let best = null, cur = null
      for (let x = xlo; x <= xhi; x++) {
        if (isSkin(...at(x, y))) { cur = cur ?? x }
        else { if (cur !== null && (!best || x - cur > best[1] - best[0])) best = [cur, x]; cur = null }
      }
      if (cur !== null && (!best || xhi + 1 - cur > best[1] - best[0])) best = [cur, xhi + 1]
      if (best && best[1] - best[0] >= 5) pts.push({ y, x: (best[0] + best[1] - 1) / 2 })
    }
    return pts
  }
  const P = band(S1), Q = band(S2)

  let png = null
  if (wantPng && view) {
    const [vx, vy, vw, vh] = view
    const v = document.getElementById('v')
    v.width = vw * UP; v.height = vh * UP
    const vc = v.getContext('2d'); vc.imageSmoothingEnabled = false
    vc.drawImage(c, vx, vy, vw, vh, 0, 0, v.width, v.height)
    for (const [pts, col] of [[P, '#00ff00'], [Q, '#00ccff']]) {
      vc.fillStyle = col
      for (const p of pts) {
        vc.beginPath(); vc.arc((p.x - vx) * UP, (p.y - vy) * UP, 4, 0, 7); vc.fill()
      }
    }
    png = v.toDataURL('image/png').split(',')[1]
  }
  return { P, Q, png }
}, { b64, S1, S2, view, UP, wantPng: !!outPath })

await browser.close()

const fit = (pts, name) => {
  if (pts.length < 4) {
    console.error(`${name}: only ${pts.length} scanlines found — widen the band or retune the skin rule`)
    process.exit(1)
  }
  const n  = pts.length
  const my = pts.reduce((s, p) => s + p.y, 0) / n
  const mx = pts.reduce((s, p) => s + p.x, 0) / n
  const a  = pts.reduce((s, p) => s + (p.y - my) * (p.x - mx), 0) /
             pts.reduce((s, p) => s + (p.y - my) ** 2, 0)
  const rms = Math.sqrt(pts.reduce((s, p) => s + (p.x - (mx + a * (p.y - my))) ** 2, 0) / n)
  return { a, n, rms }
}

const P = fit(r.P, 'seg1'), Q = fit(r.Q, 'seg2')
const deg = x => Math.atan(x) * 180 / Math.PI
// Proximal vector points back along the proximal segment, distal points away
// along the distal one — the same construction jointAngle() uses, so the result
// is directly comparable with the number the app recorded.
const up = { x: -P.a, y: -1 }, fw = { x: Q.a, y: 1 }
const interior = Math.acos((up.x * fw.x + up.y * fw.y) /
  (Math.hypot(up.x, up.y) * Math.hypot(fw.x, fw.y))) * 180 / Math.PI

console.log(`seg1 (proximal)  n=${P.n}  residual ${P.rms.toFixed(2)}px  lean ${deg(P.a).toFixed(1)}° from vertical`)
console.log(`seg2 (distal)    n=${Q.n}  residual ${Q.rms.toFixed(2)}px  lean ${deg(Q.a).toFixed(1)}°`)
console.log(`interior ${interior.toFixed(1)}°   ->   flexion ${(180 - interior).toFixed(1)}°`)

if (P.rms > 3 || Q.rms > 3) {
  console.log('\n!! residual over 3px on at least one band. The fit is probably tracking')
  console.log('   something other than the limb. Render with --out and look before using it.')
}
if (outPath && r.png) {
  writeFileSync(outPath, Buffer.from(r.png, 'base64'))
  console.log(`\nwrote ${outPath} — CHECK THE SAMPLE POINTS SIT ON THE LIMB before trusting the number`)
}
