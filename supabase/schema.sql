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
  angle_mode      text,
  notes           text default '',
  app_version     text,
  peak_frame_path text,                                -- Supabase Storage path (future)
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
