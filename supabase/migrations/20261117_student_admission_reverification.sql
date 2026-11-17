-- ClassTrack: require a fresh admission-number verification on every QR check-in.
-- Run this patch if the original student_accounts_and_qr_attendance migration
-- was already executed before the admission-verification update.

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
    raise exception 'The admission number does not match your account or you are not registered for this class.';
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
