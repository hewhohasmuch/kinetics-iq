-- Migration: face-redaction stamp on sessions
--
-- Apply to an EXISTING KineticsIQ project (tables already created from
-- schema.sql). Idempotent — safe to run more than once. Paste into the
-- Supabase SQL editor and Run. New projects can just apply schema.sql, which
-- already includes everything below.
--
-- What it does:
--   Adds face_redaction to sessions: which head-redaction generation was
--   applied to that session's snapshots ('blur1', 'solid1'), or NULL for
--   sessions captured with the face visible.
--
-- NOTE: this stamp is not a de-identification claim. Snapshots stay linked to
-- a named patient and a date of service, so they remain PHI regardless.

alter table public.sessions add column if not exists face_redaction text;
