-- Migration: landmark evidence + clinician-verified endpoint observations
--
-- Apply to an EXISTING KineticsIQ project (tables already created from
-- schema.sql). Idempotent — safe to run more than once. Paste into the
-- Supabase SQL editor and Run. New projects can just apply schema.sql, which
-- already includes everything below.
--
-- APPLY THIS BEFORE DEPLOYING the code change that maps these columns.
-- PostgREST rejects an insert naming an unknown column with a 4xx, and
-- sync.js has historically treated permanent errors as unretryable and
-- DROPPED the op — so deploying first would silently stop sessions syncing
-- rather than fail loudly. Same hazard as 0003, 0004 and 0005.
--
-- (The code shipping alongside this migration narrows that specific hole:
--  PGRST204/42703 are now retryable and raise a visible schema-mismatch
--  state instead of dropping the op. The ordering is still not optional —
--  the guard makes a mis-ordered deploy loud and recoverable, not correct.)
--
-- What it does:
--   Adds the immutable raw landmark evidence captured with each extreme
--   frame, and one jsonb column holding clinician-verified endpoint
--   observations.
--
-- Why it matters:
--   Three separate investigations (see CLAUDE.md) converged on the same
--   conclusion: the residual angle error is LANDMARK PLACEMENT, and no
--   filter or calibration removes it. The goniometer-checked elbow put the
--   humerus landmark 11.5 degrees off the true humerus axis; the shoulder's
--   error reverses sign across its range; a visibly flat supine knee reads
--   9 degrees. Every one is a bias, and CalibrationManager.apply() is a
--   single subtraction — a bias that reverses sign is provably beyond it.
--
--   So the clinician is put in the loop where the model is weak: they place
--   the three points on the joint centres they can see, and the result is
--   stored HERE as an annotation. It is not a rewrite of the measurement.
--
-- WHAT THIS IS NOT:
--   verifications does NOT correct the session. min, max, rom and
--   angle_timeline are never written by it. A verified peak is an ENDPOINT
--   OBSERVATION on one stored frame, not a recomputed timeline maximum —
--   if a peak is verified downward, some other frame in angle_timeline may
--   hold a higher value, and that frame has no snapshot to verify. ROM
--   between verified endpoints is a different quantity from ROM across the
--   raw timeline and can legitimately be narrower.
--
-- ABSENCE SEMANTICS — every column nullable, no defaults:
--   landmark_space NULL  = recorded before landmark capture existed. NOT
--     verifiable, and its stored image is the legacy composite with the
--     overlay already burned in.
--   landmarks_raw is IMMUTABLE once written. It is the baseline the research
--     delta (verified - frame_angle_raw_*) is measured against, forever.
--   frame_angle_raw_* is the UNFILTERED angle recomputed from those raw
--     landmarks — deliberately not the same number as min/max, which are
--     filtered and calibrated. The delta must compare like with like.
--   frame_tilt_* is the per-frame out-of-plane tilt AT EACH EXTREME.
--     max_segment_tilt is the session-level worst and cannot answer whether
--     the verified frame in particular was off-axis. NULL = never measured;
--     0 is the positive claim that the limb was measured and found in plane.
--   verifications NULL or '[]' = NEVER VERIFIED. This is not the same claim
--     as "verified and found unchanged", and no consumer may collapse the
--     two. Same rule as `calibrated` in 0004.
--
-- VERIFICATIONS SHAPE (array; today it holds at most ONE element — the
-- array exists so full history is a later change inside jsonb rather than a
-- migration. "Append-ready" is not permission to append now; storage.js
-- asserts the single-element invariant):
--   [{ id, at, by, by_mode, by_device, landmarks, angles,
--      model_id, model_version }]
--
--   by         = auth uid, or NULL when no account exists on the device.
--   by_mode    = 'account' | 'device'. Explicit, never inferred from `by`.
--   by_device  = pseudonymous per-browser-profile uuid, present in BOTH
--                modes. It is what lets a verification made offline be
--                attributed once that device later signs in.
--
--   ATTRIBUTION IS NOT QUALIFICATION. This application has no role model —
--   clinician_id is just auth.uid() and nothing records a licence. An
--   account proves signup, not competence to measure. These fields say WHO
--   and IN WHAT MODE, never that the verifier was qualified. No surface may
--   strengthen "clinician-verified observation" into "validated",
--   "corrected" or "accurate".

alter table public.sessions add column if not exists landmark_space      text;
alter table public.sessions add column if not exists model_id            text;
alter table public.sessions add column if not exists model_version       text;
alter table public.sessions add column if not exists landmarks_raw       jsonb;
alter table public.sessions add column if not exists frame_angle_raw_max real;
alter table public.sessions add column if not exists frame_angle_raw_min real;
alter table public.sessions add column if not exists frame_tilt_max      real;
alter table public.sessions add column if not exists frame_tilt_min      real;
alter table public.sessions add column if not exists verifications       jsonb;
