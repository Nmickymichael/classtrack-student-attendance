-- ClassTrack student accounts and secure QR attendance
-- Run this migration in Supabase SQL Editor AFTER the original ClassTrack schema.

alter table public.students
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists email text;

create index if not exists students_user_id_idx
  on public.students(user_id)
  where user_id is not null;

create unique index if not exists classes_enrollment_token_unique
  on public.classes(enrollment_token);

-- A student may attend multiple classes on the same date.
alter table public.attendance
  drop constraint if exists attendance_student_id_attendance_date_key;
alter table public.attendance
  add constraint attendance_student_class_date_key
  unique (student_id, class_id, attendance_date);

create table if not exists public.attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  session_token uuid not null unique default gen_random_uuid(),
  attendance_date date not null default current_date,
  expires_at timestamptz not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists attendance_sessions_class_active_idx
  on public.attendance_sessions(class_id, is_active, expires_at);

alter table public.attendance_sessions enable row level security;

drop policy if exists attendance_sessions_owner_select on public.attendance_sessions;
create policy attendance_sessions_owner_select
on public.attendance_sessions for select to authenticated
using (exists (
  select 1 from public.classes c
  where c.id = attendance_sessions.class_id
    and c.owner_id = (select auth.uid())
));

drop policy if exists attendance_sessions_owner_insert on public.attendance_sessions;
create policy attendance_sessions_owner_insert
on public.attendance_sessions for insert to authenticated
with check (
  created_by = (select auth.uid())
  and exists (
    select 1 from public.classes c
    where c.id = attendance_sessions.class_id
      and c.owner_id = (select auth.uid())
  )
);

drop policy if exists attendance_sessions_owner_update on public.attendance_sessions;
create policy attendance_sessions_owner_update
on public.attendance_sessions for update to authenticated
using (exists (
  select 1 from public.classes c
  where c.id = attendance_sessions.class_id
    and c.owner_id = (select auth.uid())
))
with check (exists (
  select 1 from public.classes c
  where c.id = attendance_sessions.class_id
    and c.owner_id = (select auth.uid())
));

drop policy if exists students_student_select on public.students;
create policy students_student_select
on public.students for select to authenticated
using (user_id = (select auth.uid()));

-- A student can register against a class QR token only after authenticating.
create or replace function public.student_register(
  p_enrollment_token uuid,
  p_full_name text,
  p_admission_number text,
  p_phone text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text := auth.jwt() ->> 'email';
  v_class_id uuid;
  v_student_id uuid;
  v_existing_user uuid;
begin
  if v_user_id is null or coalesce(v_email, '') = '' then
    raise exception 'Please sign in with your student email account first.';
  end if;

  if length(trim(coalesce(p_full_name, ''))) < 2
     or length(trim(coalesce(p_admission_number, ''))) < 2 then
    raise exception 'Enter your full name and admission number.';
  end if;

  select c.id into v_class_id
  from public.classes c
  where c.enrollment_token = p_enrollment_token
    and c.enrollment_enabled = true
  limit 1;

  if v_class_id is null then
    raise exception 'This registration QR code is invalid or has been disabled.';
  end if;

  select s.id, s.user_id into v_student_id, v_existing_user
  from public.students s
  where s.class_id = v_class_id
    and lower(s.admission_number) = lower(trim(p_admission_number))
  limit 1;

  if v_student_id is not null then
    if v_existing_user is not null and v_existing_user <> v_user_id then
      raise exception 'This admission number is already linked to another student account.';
    end if;

    update public.students
    set user_id = v_user_id,
        email = v_email,
        full_name = trim(p_full_name),
        phone = nullif(trim(coalesce(p_phone, '')), '')
    where id = v_student_id;
  else
    insert into public.students
      (class_id, user_id, email, full_name, admission_number, phone)
    values
      (v_class_id, v_user_id, v_email, trim(p_full_name),
       trim(p_admission_number), nullif(trim(coalesce(p_phone, '')), ''))
    returning id into v_student_id;
  end if;

  return jsonb_build_object(
    'success', true,
    'student_id', v_student_id,
    'class_id', v_class_id,
    'message', 'Your student registration is complete.'
  );
end;
$$;

revoke all on function public.student_register(uuid, text, text, text) from public, anon;
grant execute on function public.student_register(uuid, text, text, text) to authenticated;

-- Students can mark themselves present only for an active, unexpired session
-- belonging to a class in which their authenticated account is enrolled.
drop function if exists public.student_check_in(uuid);

create or replace function public.student_check_in(
  p_session_token uuid,
  p_admission_number text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.attendance_sessions%rowtype;
  v_student public.students%rowtype;
  v_admission_number text := lower(trim(coalesce(p_admission_number, '')));
begin
  if v_user_id is null then
    raise exception 'Please sign in to your student account first.';
  end if;
  if v_admission_number = '' then
    raise exception 'Enter your admission number to verify your identity for this lecture.';
  end if;

  select * into v_session
  from public.attendance_sessions s
  where s.session_token = p_session_token
    and s.is_active = true
    and s.expires_at > now()
  limit 1;

  if v_session.id is null then
    raise exception 'This lecture check-in window is closed or invalid.';
  end if;

  select * into v_student
  from public.students s
  where s.class_id = v_session.class_id
    and s.user_id = v_user_id
    and lower(trim(s.admission_number)) = v_admission_number
  limit 1;

  if v_student.id is null then
    raise exception 'Your account is not registered for this class. Scan the class registration QR code first.';
  end if;

  insert into public.attendance
    (class_id, student_id, attendance_date, status, notes)
  values
    (v_session.class_id, v_student.id, v_session.attendance_date, 'Present', 'Student QR self check-in')
  on conflict (student_id, class_id, attendance_date)
  do update set
    status = 'Present',
    notes = 'Student QR self check-in';

  return jsonb_build_object(
    'success', true,
    'student_name', v_student.full_name,
    'admission_number', v_student.admission_number,
    'attendance_date', v_session.attendance_date,
    'message', 'Attendance recorded successfully.'
  );
end;
$$;

revoke all on function public.student_check_in(uuid, text) from public, anon;
grant execute on function public.student_check_in(uuid, text) to authenticated;

grant select, insert, update on public.attendance_sessions to authenticated;
grant select on public.students to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'attendance_sessions'
  ) then
    alter publication supabase_realtime add table public.attendance_sessions;
  end if;
end $$;
