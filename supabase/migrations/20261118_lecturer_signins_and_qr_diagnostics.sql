-- ClassTrack: persistent lecturer teaching audit and clearer student QR roster matching.
-- Apply after the 20261118 production admin and student QR migrations.

create table if not exists public.lecturer_sign_ins (
  id uuid primary key default gen_random_uuid(),
  lecturer_id uuid not null references auth.users(id) on delete restrict,
  lecturer_name text not null,
  staff_id text not null default '',
  class_id uuid references public.classes(id) on delete set null,
  class_name text not null,
  class_code text not null default '',
  topic text not null default '',
  venue text not null default '',
  signed_in_at timestamptz not null default now(),
  signed_out_at timestamptz,
  status text not null default 'Signed In · Teaching',
  created_at timestamptz not null default now(),
  constraint lecturer_sign_ins_status_check
    check (status in ('Signed In · Teaching', 'Signed Out · Teaching Ended'))
);

create index if not exists lecturer_sign_ins_signed_in_at_idx
  on public.lecturer_sign_ins(signed_in_at desc);
create index if not exists lecturer_sign_ins_lecturer_id_idx
  on public.lecturer_sign_ins(lecturer_id);
create index if not exists lecturer_sign_ins_class_id_idx
  on public.lecturer_sign_ins(class_id);

alter table public.lecturer_sign_ins enable row level security;

drop policy if exists lecturer_sign_ins_read_own_or_admin on public.lecturer_sign_ins;
create policy lecturer_sign_ins_read_own_or_admin
on public.lecturer_sign_ins for select to authenticated
using (lecturer_id = (select auth.uid()) or (select public.classtrack_is_admin()));

drop policy if exists lecturer_sign_ins_insert_own on public.lecturer_sign_ins;
create policy lecturer_sign_ins_insert_own
on public.lecturer_sign_ins for insert to authenticated
with check (
  lecturer_id = (select auth.uid())
  and (
    (select public.classtrack_is_admin())
    or exists (
      select 1 from public.classes c
      where c.id = class_id and c.owner_id = (select auth.uid())
    )
  )
);

drop policy if exists lecturer_sign_ins_update_own_or_admin on public.lecturer_sign_ins;
create policy lecturer_sign_ins_update_own_or_admin
on public.lecturer_sign_ins for update to authenticated
using (lecturer_id = (select auth.uid()) or (select public.classtrack_is_admin()))
with check (lecturer_id = (select auth.uid()) or (select public.classtrack_is_admin()));

grant select, insert, update on public.lecturer_sign_ins to authenticated;

-- Enable database change events so the administrator audit view can refresh live.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'lecturer_sign_ins'
     ) then
    execute 'alter publication supabase_realtime add table public.lecturer_sign_ins';
  end if;
end;
$$;

-- Resolve the roster row by class + normalized admission number first, then
-- separately validate account ownership/email. This gives accurate failures
-- and avoids disguising a roster mismatch as a generic enrollment/RLS error.
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
  order by s.created_at
  limit 1
  for update;

  if v_student.id is null then
    raise exception 'No roster record matches this admission number in the class attached to this QR session. Check the class assignment and admission number.';
  end if;

  if v_student.user_id is not null and v_student.user_id <> v_user_id then
    raise exception 'This student roster record is already linked to another student account. Ask the lecturer or administrator to verify the account link.';
  end if;

  if v_student.user_id is null
     and lower(trim(coalesce(v_student.email, ''))) = '' then
    raise exception 'The lecturer must add the student login email to this roster record before QR check-in.';
  end if;

  if v_student.user_id is null
     and lower(trim(coalesce(v_student.email, ''))) <> v_email then
    raise exception 'The signed-in email does not match the email registered on this student roster record.';
  end if;

  if v_student.user_id is null then
    update public.students
    set user_id = v_user_id,
        email = v_email
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
    'message', 'Attendance recorded successfully.'
  );
end;
$$;

revoke all on function public.student_check_in(uuid, text) from public, anon;
grant execute on function public.student_check_in(uuid, text) to authenticated;
