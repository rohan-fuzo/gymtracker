-- ============================================
-- ROHAN'S GYM TRACKER — SUPABASE SETUP SQL
-- Run this entire file in Supabase SQL Editor
-- ============================================

-- 1. WORKOUT SESSIONS
create table if not exists workout_sessions (
  id uuid default gen_random_uuid() primary key,
  date date not null,
  phase int not null,
  day_of_week text not null,
  workout_title text,
  completed_at timestamptz,
  created_at timestamptz default now()
);

-- 2. EXERCISE LOGS (one row per set)
create table if not exists exercise_logs (
  id uuid default gen_random_uuid() primary key,
  session_id uuid references workout_sessions(id) on delete cascade,
  date date not null,
  phase int not null,
  exercise_name text not null,
  exercise_index int not null,
  set_number int not null,
  is_mm_set boolean default false,
  weight_kg numeric(5,2),
  reps int,
  completed boolean default false,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 3. WARMUP LOGS
create table if not exists warmup_logs (
  id uuid default gen_random_uuid() primary key,
  date date not null,
  phase int not null,
  item_key text not null,
  item_label text,
  completed boolean default false,
  created_at timestamptz default now(),
  unique(date, item_key)
);

-- 4. CHECKLIST LOGS (cooldown, sleep, creatine, hydration, mobility)
create table if not exists checklist_logs (
  id uuid default gen_random_uuid() primary key,
  date date not null,
  item_type text not null,
  item_key text not null,
  completed boolean default false,
  created_at timestamptz default now(),
  unique(date, item_key)
);

-- 5. BODY METRICS (weekly weigh-in)
create table if not exists body_metrics (
  id uuid default gen_random_uuid() primary key,
  date date not null unique,
  weight_kg numeric(5,2) not null,
  phase int,
  notes text,
  created_at timestamptz default now()
);

-- 6. HYDRATION LOGS
create table if not exists hydration_logs (
  id uuid default gen_random_uuid() primary key,
  date date not null unique,
  glasses int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================
-- INDEXES for fast queries
-- ============================================
create index if not exists idx_exercise_logs_date on exercise_logs(date);
create index if not exists idx_exercise_logs_name on exercise_logs(exercise_name);
create index if not exists idx_body_metrics_date on body_metrics(date);
create index if not exists idx_warmup_logs_date on warmup_logs(date);
create index if not exists idx_checklist_logs_date on checklist_logs(date);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
alter table workout_sessions enable row level security;
alter table exercise_logs enable row level security;
alter table warmup_logs enable row level security;
alter table checklist_logs enable row level security;
alter table body_metrics enable row level security;
alter table hydration_logs enable row level security;

-- Allow all operations with anon key (personal app — no auth needed)
create policy "Allow all for anon" on workout_sessions for all using (true) with check (true);
create policy "Allow all for anon" on exercise_logs for all using (true) with check (true);
create policy "Allow all for anon" on warmup_logs for all using (true) with check (true);
create policy "Allow all for anon" on checklist_logs for all using (true) with check (true);
create policy "Allow all for anon" on body_metrics for all using (true) with check (true);
create policy "Allow all for anon" on hydration_logs for all using (true) with check (true);

-- ============================================
-- HELPER FUNCTION: upsert exercise log
-- ============================================
create or replace function upsert_exercise_log(
  p_date date,
  p_phase int,
  p_session_id uuid,
  p_exercise_name text,
  p_exercise_index int,
  p_set_number int,
  p_is_mm_set boolean,
  p_weight_kg numeric,
  p_reps int,
  p_completed boolean,
  p_notes text default null
) returns uuid as $$
declare
  v_id uuid;
begin
  select id into v_id from exercise_logs
  where date = p_date and exercise_name = p_exercise_name
    and set_number = p_set_number and is_mm_set = p_is_mm_set;

  if v_id is null then
    insert into exercise_logs (
      session_id, date, phase, exercise_name, exercise_index,
      set_number, is_mm_set, weight_kg, reps, completed, notes
    ) values (
      p_session_id, p_date, p_phase, p_exercise_name, p_exercise_index,
      p_set_number, p_is_mm_set, p_weight_kg, p_reps, p_completed, p_notes
    ) returning id into v_id;
  else
    update exercise_logs set
      weight_kg = p_weight_kg, reps = p_reps,
      completed = p_completed, notes = p_notes,
      updated_at = now()
    where id = v_id;
  end if;
  return v_id;
end;
$$ language plpgsql;

-- Done! All tables and policies created.
-- You can now use the app.

-- ============================================================
-- INBODY LOGS (bi-weekly scans)
-- ============================================================
create table if not exists inbody_logs (
  id uuid default gen_random_uuid() primary key,
  date date not null unique,
  -- Body composition
  weight_kg numeric(5,2),
  body_fat_pct numeric(4,1),
  skeletal_muscle_mass numeric(5,2),
  body_fat_mass numeric(5,2),
  bmi numeric(4,1),
  -- Water
  total_body_water numeric(5,2),
  intracellular_water numeric(5,2),
  extracellular_water numeric(5,2),
  ecw_ratio numeric(5,3),
  -- Metabolic
  bmr int,
  visceral_fat_level int,
  inbody_score int,
  -- Segmental lean mass
  lean_right_arm numeric(4,2),
  lean_left_arm numeric(4,2),
  lean_trunk numeric(4,2),
  lean_right_leg numeric(4,2),
  lean_left_leg numeric(4,2),
  -- Meta
  notes text,
  created_at timestamptz default now()
);

create index if not exists idx_inbody_logs_date on inbody_logs(date);
alter table inbody_logs enable row level security;
create policy "Allow all for anon" on inbody_logs for all using (true) with check (true);
