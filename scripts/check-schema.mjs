/**
 * check-schema.mjs
 *
 * Asks the live Supabase project whether the `sessions` table has every column
 * this build writes. Exits non-zero if any is missing.
 *
 * WHY THIS EXISTS: PostgREST rejects a write naming an unknown column, and
 * sync.js used to treat every coded error as permanent and DROP the op — so
 * deploying code ahead of its migration stopped sessions syncing silently
 * rather than loudly. Sessions kept saving locally, the app looked healthy, and
 * the records never reached the cloud.
 *
 * WHAT ACTUALLY PROTECTS YOU IS sync.js, NOT THIS SCRIPT. PGRST204/42703 are
 * now retryable and raise a visible schema-mismatch state, so a mis-ordered
 * deploy is recoverable: the ops are retained and drain once the SQL is
 * applied. This script is the early warning — it tells you before your users'
 * devices do. It is deliberately NOT wired into `npm run build`: Vercel builds
 * every preview from git push, and making the build require database
 * credentials and network reachability would fail deploys for reasons that have
 * nothing to do with the deploy.
 *
 *   npm run check:schema
 *
 * Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from the environment or
 * from .env.local. Skips (exit 0) when unset — a local-only checkout has no
 * schema to check, and failing there would be noise.
 */

import { readFileSync, existsSync } from 'node:fs'

// Every column sessionToRow() names. Keep in step with src/core/sync.js.
const EXPECTED = [
  'id', 'patient_id', 'measured_at', 'date', 'joint', 'side', 'position',
  'min', 'max', 'rom', 'duration_s', 'samples', 'angle_timeline',
  'angle_mode', 'angle_filter', 'angle_convention',
  'calibrated', 'calibration_offset', 'max_segment_tilt',
  'landmark_space', 'model_id', 'model_version', 'landmarks_raw',
  'frame_angle_raw_max', 'frame_angle_raw_min',
  'frame_tilt_max', 'frame_tilt_min', 'verifications',
  'notes', 'app_version', 'peak_frame_path', 'min_frame_path', 'updated_at',
]

function env(name) {
  if (process.env[name]) return process.env[name]
  if (!existsSync('.env.local')) return null
  const line = readFileSync('.env.local', 'utf8')
    .split('\n')
    .find(l => l.trim().startsWith(`${name}=`))
  return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : null
}

const url = env('VITE_SUPABASE_URL')
const key = env('VITE_SUPABASE_ANON_KEY')

if (!url || !key) {
  console.log('check-schema: no Supabase credentials — local-only checkout, nothing to check.')
  process.exit(0)
}

// Ask for every column at once. PostgREST resolves column names before RLS
// filters rows, so an anon key with no rows visible still surfaces a missing
// column — and names it in the error.
const res = await fetch(
  `${url.replace(/\/$/, '')}/rest/v1/sessions?select=${EXPECTED.join(',')}&limit=1`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } }
)

if (res.ok) {
  console.log(`check-schema: OK — all ${EXPECTED.length} columns present on sessions.`)
  process.exit(0)
}

const body = await res.text()
let detail = body
try { detail = JSON.parse(body).message ?? body } catch {}

// 42703 / PGRST204 name the offending column in the message.
console.error('check-schema: FAILED — the database does not match this build.')
console.error(`  ${detail}`)
console.error('')
console.error('  Apply the pending migration(s) in supabase/migrations/ before deploying.')
console.error('  Deploying first is recoverable but noisy: sync retains the ops and shows')
console.error('  a schema-mismatch state until the SQL is applied.')
process.exit(1)
