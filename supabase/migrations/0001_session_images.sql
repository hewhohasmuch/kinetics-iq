-- Migration: session snapshot images → Supabase Storage
--
-- Apply to an EXISTING KineticsIQ project (tables already created from
-- schema.sql). Idempotent — safe to run more than once. Paste into the
-- Supabase SQL editor and Run. New projects can just apply schema.sql, which
-- already includes everything below.
--
-- What it does:
--   1. Adds the snapshot path columns to sessions (bytes never stored here).
--   2. Creates the PRIVATE session-images bucket.
--   3. Scopes bucket objects to their owning clinician via RLS.

-- 1. Path columns (peak_frame_path likely already exists; guarded anyway).
alter table public.sessions add column if not exists peak_frame_path text;
alter table public.sessions add column if not exists min_frame_path  text;

-- 2. Private bucket — one folder per clinician: ${auth.uid()}/${session_id}/{peak,min}.jpg
insert into storage.buckets (id, name, public)
values ('session-images', 'session-images', false)
on conflict (id) do nothing;

-- 3. RLS: a clinician may only touch objects whose first path segment is their
--    own uid. Drop-then-create so re-running the migration doesn't error.
drop policy if exists "own session images" on storage.objects;
create policy "own session images" on storage.objects for all
  to authenticated
  using      (bucket_id = 'session-images' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'session-images' and (storage.foldername(name))[1] = auth.uid()::text);
