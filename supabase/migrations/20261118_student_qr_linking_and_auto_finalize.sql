-- ClassTrack: secure manual-student QR linking and automatic attendance finalization.
-- Apply after the existing student QR attendance and production admin migrations.

alter table public.students
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists email text;

alter table public.attendance_sessions
  add column if not exists is_finalized boolean not null default false,
  add column if not exists finalized_at timestamptz,
  add column if not exists finalization_source text;

create index if not exists attendance_sessions_expiry_finalize_idx
  on public.attendance_sessions(expires_at)
  where is_active = true and is_finalized = false;

-- Case-insensitive, whitespace-insensitive admission number matching.
-- Meaningful characters (including slashes and hyphens) are preserved.
create or replace function public.classtrack_normalize_admission(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(trim(coalesce(p_value, '')), '[[:space:]]+', '', 'g'));
$$;

revoke all on function public.classtrack_normalize_admission(text) from public, anon;
grant execute on function public.classtrack_normalize_admission(text) to authenticated;

-- Let authenticated students claim a manually added roster record only when
-- their verified Supabase email matches the email entered by the lecturer.
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
  v_email text := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
  v_session public.attendance_sessions%rowtype;
  v_student public.students%rowtype;
  v_admission text := public.classtrack_normalize_admission(p_admission_number);
begin
  if v_user_id is null or v_email = '' then
    raise exception 'Please sign in with your student email account first.';
  end if;
  if v_admission = '' then
    raise exception 'Enter your admission number to verify your identity for this lecture.';
  end if;

  select * into v_session
  from public.attendance_sessions s
  where s.session_token = p_session_token
    and s.is_active = true
    and s.is_finalized = false
    and s.expires_at > now()
  limit 1;

  if v_session.id is null then
    raise exception 'This lecture check-in window is closed or invalid.';
  end if;

  select * into v_student
  from public.students s
  where s.class_id = v_session.class_id
    and public.classtrack_normalize_admission(s.admission_number) = v_admission
    and (
      s.user_id = v_user_id
      or (s.user_id is null and lower(trim(coalesce(s.email, ''))) = v_email)
    )
  limit 1
  for update;

  if v_student.id is null then
    raise exception 'No matching student record was found for this class. Check your admission number and sign in with the email registered by your lecturer.';
  end if;

  if v_student.user_id is null then
    update public.students
    set user_id = v_user_id,
        email = v_email
    where id = v_student.id
    returning * into v_student;
  elsif v_student.user_id <> v_user_id then
    raise exception 'This student record is already linked to another account.';
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

-- Registration QR matching uses the same normalization rule.
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
  v_email text := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
  v_class_id uuid;
  v_student_id uuid;
  v_existing_user uuid;
  v_existing_email text;
  v_admission text := public.classtrack_normalize_admission(p_admission_number);
begin
  if v_user_id is null or v_email = '' then
    raise exception 'Please sign in with your student email account first.';
  end if;
  if length(trim(coalesce(p_full_name, ''))) < 2 or v_admission = '' then
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

  select s.id, s.user_id, lower(trim(coalesce(s.email, '')))
    into v_student_id, v_existing_user, v_existing_email
  from public.students s
  where s.class_id = v_class_id
    and public.classtrack_normalize_admission(s.admission_number) = v_admission
  limit 1;

  if v_student_id is not null then
    if v_existing_user is not null and v_existing_user <> v_user_id then
      raise exception 'This admission number is already linked to another student account.';
    end if;
    if v_existing_user is null and v_existing_email <> '' and v_existing_email <> v_email then
      raise exception 'This admission number is registered to a different student email address.';
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
      (v_class_id, v_user_id, v_email, trim(p_full_name), trim(p_admission_number),
       nullif(trim(coalesce(p_phone, '')), ''))
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

-- Private transactional finalizer. It inserts only missing attendance rows,
-- preserving any existing Present/Late/Excused/lecturer-corrected statuses.
create or replace function public.classtrack_finalize_attendance_session(
  p_session_id uuid,
  p_source text default 'automatic'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.attendance_sessions%rowtype;
  v_absent_count integer := 0;
  v_finalized_at timestamptz;
begin
  select * into v_session
  from public.attendance_sessions
  where id = p_session_id
  for update;

  if v_session.id is null then
    raise exception 'Attendance session not found.';
  end if;

  if v_session.is_finalized then
    return jsonb_build_object(
      'success', true,
      'already_finalized', true,
      'absent_count', 0,
      'finalized_at', v_session.finalized_at
    );
  end if;

  if v_session.expires_at > now() and p_source = 'automatic' then
    return jsonb_build_object('success', true, 'not_due', true, 'absent_count', 0);
  end if;

  insert into public.attendance
    (class_id, student_id, attendance_date, status, notes)
  select
    v_session.class_id,
    s.id,
    v_session.attendance_date,
    'Absent',
    'Automatically marked absent when attendance session closed'
  from public.students s
  where s.class_id = v_session.class_id
  on conflict (student_id, class_id, attendance_date) do nothing;

  get diagnostics v_absent_count = row_count;
  v_finalized_at := now();

  update public.attendance_sessions
  set is_active = false,
      is_finalized = true,
      finalized_at = v_finalized_at,
      finalization_source = p_source
  where id = p_session_id;

  return jsonb_build_object(
    'success', true,
    'already_finalized', false,
    'absent_count', v_absent_count,
    'finalized_at', v_finalized_at
  );
end;
$$;

-- Authenticated manual close; verifies class ownership or administrator status.
create or replace function public.finalize_attendance_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in is required.';
  end if;

  select c.owner_id into v_owner_id
  from public.attendance_sessions s
  join public.classes c on c.id = s.class_id
  where s.id = p_session_id;

  if v_owner_id is null then
    raise exception 'Attendance session not found.';
  end if;

  if v_owner_id <> auth.uid() and not public.classtrack_is_admin() then
    raise exception 'You are not allowed to finalize this attendance session.';
  end if;

  return public.classtrack_finalize_attendance_session(p_session_id, 'lecturer_or_admin');
end;
$$;

-- Cron worker: process all due sessions in bounded batches.
create or replace function public.process_expired_attendance_sessions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session record;
  v_processed integer := 0;
begin
  for v_session in
    select id
    from public.attendance_sessions
    where is_active = true
      and is_finalized = false
      and expires_at <= now()
    order by expires_at
    limit 250
  loop
    perform public.classtrack_finalize_attendance_session(v_session.id, 'automatic');
    v_processed := v_processed + 1;
  end loop;
  return v_processed;
end;
$$;

revoke all on function public.classtrack_finalize_attendance_session(uuid, text) from public, anon, authenticated;
revoke all on function public.process_expired_attendance_sessions() from public, anon, authenticated;
revoke all on function public.finalize_attendance_session(uuid) from public, anon;
grant execute on function public.finalize_attendance_session(uuid) to authenticated;
grant execute on function public.process_expired_attendance_sessions() to service_role;

-- Enable pg_cron if the project permits it and schedule a one-minute expiry sweep.
do $$
begin
  begin
    execute 'create extension if not exists pg_cron with schema pg_catalog';
  exception when others then
    raise notice 'pg_cron could not be enabled automatically: %', sqlerrm;
  end;

  if to_regclass('cron.job') is not null then
    if not exists (select 1 from cron.job where jobname = 'classtrack-finalize-expired-attendance') then
      perform cron.schedule(
        'classtrack-finalize-expired-attendance',
        '* * * * *',
        'select public.process_expired_attendance_sessions();'
      );
    end if;
  else
    raise notice 'pg_cron is not enabled. Enable it in Supabase Dashboard > Database > Extensions, then schedule process_expired_attendance_sessions() every minute.';
  end if;
end;
$$;
