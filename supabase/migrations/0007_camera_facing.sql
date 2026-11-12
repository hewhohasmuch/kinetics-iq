-- Migration: which camera took a session
--
-- Apply to an EXISTING KineticsIQ project (tables already created from
-- schema.sql). Idempotent — safe to run more than once. Paste into the
-- Supabase SQL editor and Run. New projects can just apply schema.sql, which
-- already includes everything below.
--
-- APPLY THIS BEFORE DEPLOYING the code change that maps this column.
-- PostgREST rejects a write naming an unknown column. sync.js keeps those ops
-- and shows a schema_mismatch state, so nothing is lost, but no session
-- syncs until this has run.
--
-- What it does:
--   Adds camera_facing to sessions: 'user' (front camera), 'environment'
--   (rear camera) or 'unknown' (the device did not report which camera the
--   stream came from).
--
-- Why it matters:
--   The app can now switch to the front camera so the person being measured
--   can see the screen. The front camera is a different lens, and which one
--   took a session cannot be reconstructed afterwards.
--
-- ABSENCE SEMANTICS — nullable, with NO default:
--   NULL means the session was saved before the camera was recorded, when the
--   rear camera was the only one the app requested. The app shows those as
--   "Not applicable". A default would stamp every earlier row with a value
--   nobody observed. 'unknown' is a different claim: a session saved by a
--   build that records the camera, on a device that did not say which it was.
--
-- The check constraint keeps any other value out, so a bad write cannot pass
-- for an ordinary older session. NULL passes a check constraint.

alter table public.sessions add column if not exists camera_facing text;

alter table public.sessions drop constraint if exists sessions_camera_facing_check;
alter table public.sessions add constraint sessions_camera_facing_check
  check (camera_facing in ('user', 'environment', 'unknown'));
