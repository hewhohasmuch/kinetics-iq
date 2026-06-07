/**
 * build-aruco.mjs
 *
 * Concatenates js-aruco2 source files into a single browser script.
 * No bundler — just raw concatenation with a window.AR assignment at the end.
 *
 * Why not esbuild: js-aruco2 uses `this.AR = AR` at module scope.
 * esbuild wraps each CJS module in a function where `this` = exports,
 * not window. Concatenation lets the files run at true script scope
 * where `this` = window (in non-strict classic scripts).
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root      = resolve(__dirname, '..')

const read = (p) => readFileSync(resolve(root, p), 'utf8')

const cv     = read('node_modules/js-aruco2/src/cv.js')
const aruco  = read('node_modules/js-aruco2/src/aruco.js')
const dict   = read('node_modules/js-aruco2/src/dictionaries/aruco_4x4_1000.js')

// Patch out the require() calls — they're only needed in Node.
// In the browser, cv.js runs first and sets this.CV, so aruco.js
// can read this.CV directly (which it already does as fallback).
const arucoPatchedRequire = aruco
  .replace("var CV = this.CV || require('./cv').CV;", "var CV = this.CV;")

const dict4x4Patched = dict
  .replace("var AR = exports.AR || require('../aruco').AR;", "var AR = this.AR;")

const bundle = `
// KineticsIQ — ArUco browser bundle (concatenated, not bundled)
// Runs as a classic script so 'this' = window at module scope.
// Sets window.AR and window.CV.

(function(global) {

  // ── cv.js ──────────────────────────────────────────────────────────
  ${cv}

  // ── aruco.js ───────────────────────────────────────────────────────
  ${arucoPatchedRequire}

  // ── aruco_4x4_1000.js ─────────────────────────────────────────────
  ${dict4x4Patched}

  // Expose on global (window in browser)
  global.AR = AR;
  global.CV = CV;

}(typeof window !== 'undefined' ? window : this));
`

const outfile = resolve(root, 'public/aruco.js')
writeFileSync(outfile, bundle)

const size = (bundle.length / 1024).toFixed(1)
console.log(`Built public/aruco.js (${size}kb)`)

// Verify by running in Node with a fake window
import { createContext, runInContext } from 'vm'
const ctx = { window: {}, exports: {}, console }
createContext(ctx)
runInContext(bundle.replace("typeof window !== 'undefined' ? window : this", 'window'), ctx)
console.log('window.AR:', typeof ctx.window.AR)
console.log('AR.Detector:', typeof ctx.window.AR?.Detector)
console.log('Dictionaries:', ctx.window.AR ? Object.keys(ctx.window.AR.DICTIONARIES) : 'none')
