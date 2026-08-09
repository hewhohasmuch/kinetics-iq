-- KineticsIQ Supabase schema
--
-- Apply via the Supabase SQL editor (or `supabase db push`).
-- Ownership model: clinicians sign in with Supabase Auth; every row belongs
-- to exactly one clinician and RLS restricts all access to the owner.
-- Patients are records, never auth users.

create table public.patients (
  id            uuid primary key,                      -- client-generated
  clinician_id  uuid not null default auth.uid() references auth.users(id),
  name          text not null,
  dob           date,
  mrn           text,
  diagnosis     text,
  surgery_date  date,
  affected_side text check (affected_side in ('left','right','both') or affected_side is null),
  notes         text default '',
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.sessions (
  id              uuid primary key,                    -- client-generated
  clinician_id    uuid not null default auth.uid() references auth.users(id),
  patient_id      uuid not null references public.patients(id) on delete cascade,
  measured_at     bigint not null,                     -- epoch ms (session.timestamp)
  date            text not null,                       -- 'YYYY-MM-DD' verbatim from client
  joint           text not null,
  side            text not null,
  position        text,
  min             real,
  max             real,
  rom             real,
  duration_s      integer,
  samples         integer,
  angle_timeline  jsonb,                               -- number[], ~3-4 KB per session
  angle_mode      text,                                -- '3d' | absent = pre-3D/2D-era
  angle_filter    text,                                -- 'euro1' | absent = old moving average, peaks clipped
  angle_convention text,                               -- 'perjoint1' | absent = shoulder inverted, ankle offset 90
  -- HISTORICAL — nothing reads or writes this. Head redaction shipped in #15
  -- ('blur1', or 'solid1' where Canvas 2D filters were unsupported) and was
  -- removed in #17 after two on-device failures. Retained, not dropped: it is
  -- the only record of which stored snapshots had any redaction applied, which
  -- is the question an audit of the image store would ask. Sessions outside
  -- that window are NULL and their snapshots show the patient's face.
  face_redaction  text,
  notes           text default '',
  app_version     text,
  peak_frame_path text,                                -- Storage path: max-flexion snapshot
  min_frame_path  text,                                -- Storage path: max-extension snapshot
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index sessions_patient_idx   on public.sessions (patient_id, measured_at desc);
create index patients_clinician_idx on public.patients (clinician_id);

alter table public.patients enable row level security;
alter table public.sessions enable row level security;

create policy "own patients" on public.patients for all
  using (clinician_id = auth.uid()) with check (clinician_id = auth.uid());

create policy "own sessions" on public.sessions for all
  using (clinician_id = auth.uid()) with check (clinician_id = auth.uid());

-- ── Session snapshot images (Supabase Storage) ──────────────────────────────
-- Overlay JPEGs for the two range extremes live in a PRIVATE bucket, one
-- folder per clinician: `${auth.uid()}/${session_id}/{peak,min}.jpg`. The
-- session row stores the object path (peak_frame_path / min_frame_path); the
-- bytes never touch the sessions table. Blobs are staged in the client's
-- IndexedDB and uploaded in the background.
--
-- Create the bucket once (private) — via the dashboard or:
--   insert into storage.buckets (id, name, public)
--   values ('session-images', 'session-images', false)
--   on conflict (id) do nothing;
insert into storage.buckets (id, name, public)
values ('session-images', 'session-images', false)
on conflict (id) do nothing;

-- RLS: a clinician may only touch objects whose first path segment is their
-- own uid. storage.foldername(name)[1] is that leading folder.
create policy "own session images" on storage.objects for all
  to authenticated
  using      (bucket_id = 'session-images' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'session-images' and (storage.foldername(name))[1] = auth.uid()::text);
