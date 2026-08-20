/** Exports the legacy+un-zeroed session (two stacked caveat bands) and renders
 *  page 1 to PNG, so the layout can be checked by eye — pdf.test.js mocks
 *  jsPDF and proves nothing about where things land on the page. */
import { chromium } from 'playwright'
import { readFileSync, mkdirSync } from 'node:fs'
const OUT='tmp/floor-verify'; mkdirSync(OUT,{recursive:true})
const P='11111111-1111-4111-8111-111111111111'
const s=(id,o)=>({id,patient_id:P,joint:'knee',side:'right',position:'supine',date:'2026-08-11',
  timestamp:new Date(2026,7,11,20,32).getTime(),min:9,max:121.8,rom:112.8,duration_s:12,samples:120,
  angleTimeline:[9,60,121.8,60,9],notes:'Heel slide, self-performed.',angleMode:'3d',angleFilter:'euro1',
  calibrated:false,calibrationOffset:0,peakFramePath:null,minFramePath:null,
  updated_at:new Date().toISOString(),...o})
const seed={patients:[{id:P,name:'Jane Poppins',dob:'1980-04-02',mrn:'MRN-99887',updated_at:new Date().toISOString()}],
  sessions:[s('bbbbbbbb-0000-4000-8000-000000000002',{angleConvention:undefined})],activePatient:P}

const browser=await chromium.launch()
const ctx=await browser.newContext({ignoreHTTPSErrors:true,acceptDownloads:true,viewport:{width:1100,height:1400}})   // must exceed the rendered page, or Playwright captures the part below the fold as transparent
await ctx.addInitScript(d=>{
  localStorage.setItem('rom_patients',JSON.stringify(d.patients))
  localStorage.setItem('rom_sessions',JSON.stringify(d.sessions))
  localStorage.setItem('rom_settings',JSON.stringify({active_patient_id:d.activePatient}))
},seed)
const page=await ctx.newPage()
await page.goto('https://localhost:5174/',{waitUntil:'domcontentloaded'})
await page.waitForSelector('#btn-history',{state:'attached',timeout:30000})
await page.evaluate(()=>document.getElementById('btn-history').click())
await page.waitForSelector('.session-row',{timeout:15000})
await page.evaluate(()=>document.querySelector('.session-row').click())
await page.waitForSelector('#btn-export-pdf',{timeout:15000})
await page.click('#btn-export-pdf')
await page.waitForSelector('.export-confirm',{timeout:10000})
const dl=page.waitForEvent('download',{timeout:60000})
await page.click('#ec-confirm')
const pdf=`${OUT}/two-bands.pdf`; await (await dl).saveAs(pdf)

// render with pdfjs served from a real origin
await page.route('**/pdfjs/**', r=>{
  const n=r.request().url().split('/pdfjs/')[1]
  r.fulfill({body:readFileSync(`node_modules/pdfjs-dist/build/${n}`),
    headers:{'content-type':n.endsWith('.mjs')?'text/javascript':'application/octet-stream'}})
})
await page.goto('https://localhost:5174/',{waitUntil:'domcontentloaded'})
const b64=readFileSync(pdf).toString('base64')
await page.evaluate(async (b64)=>{
  const pdfjs=await import('/pdfjs/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc='/pdfjs/pdf.worker.mjs'
  const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0))
  const doc=await pdfjs.getDocument({data:bytes}).promise
  const p=await doc.getPage(1)
  const vp=p.getViewport({scale:1.6})
  const c=document.createElement('canvas'); c.id='pg'
  c.width=vp.width; c.height=vp.height
  document.body.innerHTML=''; document.body.appendChild(c)
  await p.render({canvasContext:c.getContext('2d'),viewport:vp}).promise
},b64)
await page.locator('#pg').screenshot({path:`${OUT}/two-bands.png`})
await browser.close()
console.log('rendered tmp/floor-verify/two-bands.png')
