/**
 * measure-overlay-dots.mjs
 *
 * Reads the three landmark dots the overlay burned into a saved snapshot and
 * reports the 2D angle they describe.
 *
 * WHY THIS EXISTS: the app records the angle from the 3D world landmarks, but
 * draws the dots from the 2D ones, and composites both into ONE frame ("One
 * value, everywhere" — CLAUDE.md). So a snapshot is a controlled experiment:
 * the dots and the burned-in number come from the same instant, and comparing
 * them isolates the contribution of the monocular depth estimate, which is the
 * only thing the two paths disagree about.
 *
 * That is how the extension floor documented in CLAUDE.md was measured: a
 * supine knee whose dots were collinear to 0.77° recorded 9.0°.
 *
 * The overlay maps landmarks through an object-fit: cover scale + translate,
 * which is uniform — so it preserves angles exactly, and the measurement is
 * valid despite the snapshot being downscaled, JPEG'd and screenshotted.
 *
 * Usage:
 *   node scripts/measure-overlay-dots.mjs <image> <sx> <sy> <sw> <sh>
 *
 * The crop must contain exactly one frame's three dots. Keep it clear of the
 * green caption text beneath the image, which pollutes the green centroid.
 */

import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const src = process.argv[2]
const [SX,SY,SW,SH] = process.argv.slice(3,7).map(Number)
const b64 = readFileSync(src).toString('base64')

const browser = await chromium.launch()
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')
const data = await page.evaluate(async ({b64,SX,SY,SW,SH}) => {
  const img = new Image()
  await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,'+b64 })
  const c = document.getElementById('c')
  c.width = SW; c.height = SH
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, SX, SY, SW, SH, 0, 0, SW, SH)
  const d = ctx.getImageData(0,0,SW,SH).data
  // classify dot colours: blue (proximal), green (joint), pink (distal)
  const acc = { blue:[0,0,0], green:[0,0,0], pink:[0,0,0] }
  for (let y=0;y<SH;y++) for (let x=0;x<SW;x++){
    const i=(y*SW+x)*4, r=d[i], g=d[i+1], b=d[i+2]
    let k=null
    if (b>180 && r<120 && g>120 && g<200) k='blue'
    else if (g>180 && r<130 && b<150) k='green'
    else if (r>200 && b>130 && b<200 && g<150) k='pink'
    if (k){ acc[k][0]+=x; acc[k][1]+=y; acc[k][2]++ }
  }
  const out={}
  for (const k of Object.keys(acc)){
    const [sx,sy,n]=acc[k]
    out[k] = n ? {x:+(sx/n).toFixed(2), y:+(sy/n).toFixed(2), px:n} : null
  }
  return out
}, {b64,SX,SY,SW,SH})
await browser.close()
console.log(JSON.stringify(data,null,2))

const {blue:A, green:B, pink:C} = data
if (A&&B&&C){
  const ba={x:A.x-B.x,y:A.y-B.y}, bc={x:C.x-B.x,y:C.y-B.y}
  const mag=v=>Math.hypot(v.x,v.y)
  const cos=(ba.x*bc.x+ba.y*bc.y)/(mag(ba)*mag(bc))
  const interior=Math.acos(Math.max(-1,Math.min(1,cos)))*180/Math.PI
  // perpendicular distance of B from line A-C
  const num=Math.abs((C.x-A.x)*(A.y-B.y)-(A.x-B.x)*(C.y-A.y))
  const perp=num/Math.hypot(C.x-A.x,C.y-A.y)
  console.log('\n2D interior angle :', interior.toFixed(2)+'\u00b0')
  console.log('2D clinical (180-):', (180-interior).toFixed(2)+'\u00b0')
  console.log('thigh px', mag(ba).toFixed(1), ' shin px', mag(bc).toFixed(1))
  console.log('knee off hip-ankle line:', perp.toFixed(2)+' px')
}
