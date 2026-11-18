-- ClassTrack: Student Identity & Enrollment Management
-- Apply after the 20261118 student QR and lecturer diagnostics migrations.
-- This migration intentionally refuses to create unique indexes if legacy duplicate
-- admission numbers exist. Resolve the reported duplicates first; no student data is deleted.

do $$
declare
  v_duplicates text;
begin
  select string_agg(format('%s (%s records)', class_name, duplicate_count), ', ')
    into v_duplicates
  from (
    select c.name as class_name, count(*) as duplicate_count
    from public.students s
    join public.classes c on c.id = s.class_id
    where public.classtrack_normalize_admission(s.admission_number) <> ''
    group by s.class_id, c.name, public.classtrack_normalize_admission(s.admission_number)
    having count(*) > 1
    order by c.name
    limit 10
  ) duplicates;

  if v_duplicates is not null then
    raise exception 'Student identity migration paused: duplicate admission numbers exist within a class: %. Resolve duplicates without deleting attendance history, then rerun this migration.', v_duplicates;
  end if;

  if exists (
    select 1
    from public.students
    where user_id is not null
    group by user_id, class_id
    having count(*) > 1
  ) then
    raise exception 'Student identity migration paused: one Supabase account is attached to multiple student rows in the same class. Review those records before rerunning.';
  end if;
end;
$;

-- One normalized admission number per class, regardless of capitalization or spaces.
create unique index if not exists students_class_normalized_admission_uidx
  on public.students (class_id, public.classtrack_normalize_admission(admission_number))
  where public.classtrack_normalize_admission(admission_number) <> '';

-- A single account cannot be attached to two student rows in the same class.
create unique index if not exists students_user_class_uidx
  on public.students (user_id, class_id)
  where user_id is not null;

-- Student self-registration is an account-linking step, not an unrestricted way
-- to add oneself to a class. The lecturer/admin must create the roster row first.
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
set row_security = off
as $$
declare
  v_user_id uuid := auth.uid();
  v_auth_email text;
  v_email_confirmed_at timestamptz;
  v_class_id uuid;
  v_student public.students%rowtype;
  v_admission text := public.classtrack_normalize_admission(p_admission_number);
begin
  if v_user_id is null then
    raise exception 'Sign in to your personal student account first.';
  end if;

  select lower(trim(coalesce(u.email, ''))), u.email_confirmed_at
    into v_auth_email, v_email_confirmed_at
  from auth.users u
  where u.id = v_user_id;

  if coalesce(v_auth_email, '') = '' or v_email_confirmed_at is null then
    raise exception 'Verify your student email address before completing class enrollment.';
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
    raise exception 'This class registration link is invalid or has been disabled. Ask your lecturer for a new link.';
  end if;

  select * into v_student
  from public.students s
  where s.class_id = v_class_id
    and public.classtrack_normalize_admission(s.admission_number) = v_admission
  limit 1
  for update;

  if v_student.id is null then
    raise exception 'Your admission number is not on this class register yet. Ask your lecturer to add your student record before completing account linking.';
  end if;

  if v_student.user_id is not null and v_student.user_id <> v_user_id then
    raise exception 'This student record is already linked to another account. Contact the administrator.';
  end if;

  if lower(trim(coalesce(v_student.email, ''))) = '' then
    raise exception 'Your student record has no login email. Ask your lecturer to add the email address you verified in ClassTrack.';
  end if;

  if lower(trim(v_student.email)) <> v_auth_email then
    raise exception 'The verified email on your account does not match the email on the class register. Ask your lecturer to correct the register email.';
  end if;

  update public.students
  set user_id = v_user_id,
      email = v_auth_email,
      phone = coalesce(nullif(trim(coalesce(p_phone, '')), ''), phone)
  where id = v_student.id;

  return jsonb_build_object(
    'success', true,
    'student_id', v_student.id,
    'class_id', v_class_id,
    'message', 'Your verified student account is now linked to your class record.'
  );
end;
$$;

revoke all on function public.student_register(uuid, text, text, text) from public, anon;
grant execute on function public.student_register(uuid, text, text, text) to authenticated;

-- Attendance check-in uses the verified email stored by Supabase Auth as the
-- identity authority. A student must already be on the class roster.
create or replace function public.student_check_in(
  p_session_token uuid,
  p_admission_number text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare
  v_user_id uuid := auth.uid();
  v_auth_email text;
  v_email_confirmed_at timestamptz;
  v_session public.attendance_sessions%rowtype;
  v_student public.students%rowtype;
  v_admission text := public.classtrack_normalize_admission(p_admission_number);
begin
  if v_user_id is null then
    raise exception 'Sign in with your personal student account first.';
  end if;

  select lower(trim(coalesce(u.email, ''))), u.email_confirmed_at
    into v_auth_email, v_email_confirmed_at
  from auth.users u
  where u.id = v_user_id;

  if coalesce(v_auth_email, '') = '' or v_email_confirmed_at is null then
    raise exception 'Verify your student email address before checking in.';
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
    raise exception 'This lecture check-in window is closed or invalid. Ask your lecturer to display a fresh QR code.';
  end if;

  select * into v_student
  from public.students s
  where s.class_id = v_session.class_id
    and public.classtrack_normalize_admission(s.admission_number) = v_admission
  limit 1
  for update;

  if v_student.id is null then
    raise exception 'This admission number is not on the register for this class. Ask your lecturer to check your class enrollment.';
  end if;

  if v_student.user_id is not null and v_student.user_id <> v_user_id then
    raise exception 'This student record is already linked to another account. Contact the administrator.';
  end if;

  if lower(trim(coalesce(v_student.email, ''))) = '' then
    raise exception 'Your class record is missing a student login email. Ask your lecturer to add your verified email.';
  end if;

  if lower(trim(v_student.email)) <> v_auth_email then
    raise exception 'Your signed-in email does not match the email on the class register. Ask your lecturer to correct it.';
  end if;

  if v_student.user_id is null then
    update public.students
    set user_id = v_user_id
    where id = v_student.id
    returning * into v_student;
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
    'message', 'Identity verified. Attendance recorded successfully.'
  );
end;
$$;

revoke all on function public.student_check_in(uuid, text) from public, anon;
grant execute on function public.student_check_in(uuid, text) to authenticated;


-- Only the verified account-linking RPC may assign a student user_id.
-- Linked email changes are synchronized from Supabase Auth after the new
-- Auth email has been confirmed; lecturers cannot silently redirect an account.
create or replace function public.classtrack_guard_student_identity_link()
returns trigger
language plpgsql
set search_path = ''
as $
begin
  if tg_op = 'INSERT' then
    if new.user_id is not null and current_user not in ('postgres', 'supabase_admin', 'service_role') then
      raise exception 'Student accounts can only be linked through the verified enrollment process.';
    end if;
    return new;
  end if;

  if new.user_id is distinct from old.user_id
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'Student account links can only be changed through the verified enrollment process.';
  end if;

  if old.user_id is not null
     and lower(trim(coalesce(new.email, ''))) <> lower(trim(coalesce(old.email, '')))
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'This student account is already linked. Change the email in Supabase Auth and confirm it; ClassTrack will synchronize the verified email.';
  end if;

  return new;
end;
$;

drop trigger if exists classtrack_guard_student_identity_link on public.students;
create trigger classtrack_guard_student_identity_link
before insert or update of user_id, email on public.students
for each row execute function public.classtrack_guard_student_identity_link();

create or replace function public.classtrack_sync_student_auth_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $
begin
  if new.email is distinct from old.email then
    update public.students
    set email = lower(trim(new.email))
    where user_id = new.id;
  end if;
  return new;
end;
$;

drop trigger if exists classtrack_sync_student_auth_email on auth.users;
create trigger classtrack_sync_student_auth_email
after update of email on auth.users
for each row
when (new.email is distinct from old.email)
execute function public.classtrack_sync_student_auth_email();

-- Admin-only overview of account-linking readiness and records needing attention.
create or replace function public.admin_student_enrollment_report()
returns jsonb
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare
  v_report jsonb;
begin
  if not public.classtrack_is_admin() then
    raise exception 'Only the System Administrator can view the institution-wide student enrollment report.';
  end if;

  select jsonb_build_object(
    'total', count(*),
    'linked', count(*) filter (where s.user_id is not null and u.email_confirmed_at is not null),
    'unlinked', count(*) filter (where s.user_id is null),
    'awaiting_verification', count(*) filter (where s.user_id is not null and u.email_confirmed_at is null),
    'missing_email', count(*) filter (where nullif(trim(coalesce(s.email, '')), '') is null),
    'attention', coalesce((
      select jsonb_agg(item order by item->>'full_name')
      from (
        select jsonb_build_object(
          'student_id', st.id,
          'full_name', st.full_name,
          'admission_number', st.admission_number,
          'class_name', c.name,
          'email', st.email,
          'issue', case
            when nullif(trim(coalesce(st.email, '')), '') is null then 'Missing login email'
            when st.user_id is null then 'Account not linked'
            when linked_user.email_confirmed_at is null then 'Awaiting email verification'
            else 'Needs review'
          end
        ) as item
        from public.students st
        join public.classes c on c.id = st.class_id
        left join auth.users linked_user on linked_user.id = st.user_id
        where st.user_id is null
           or nullif(trim(coalesce(st.email, '')), '') is null
           or linked_user.email_confirmed_at is null
        order by st.full_name
        limit 200
      ) attention_rows
    ), '[]'::jsonb)
  )
  into v_report
  from public.students s
  left join auth.users u on u.id = s.user_id;

  return coalesce(v_report, jsonb_build_object(
    'total', 0, 'linked', 0, 'unlinked', 0, 'awaiting_verification', 0, 'missing_email', 0, 'attention', '[]'::jsonb
  ));
end;
$$;

revoke all on function public.admin_student_enrollment_report() from public, anon;
grant execute on function public.admin_student_enrollment_report() to authenticated;

comment on function public.student_register(uuid, text, text, text) is
  'Links a verified student Auth account to a lecturer-created roster row; it never creates an unapproved roster row.';
comment on function public.student_check_in(uuid, text) is
  'Allows QR attendance only for a verified Auth account matching the email and admission number on the class roster.';
