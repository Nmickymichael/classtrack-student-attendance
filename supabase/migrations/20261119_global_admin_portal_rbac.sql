-- ClassTrack Global Admin Portal RBAC
-- Admin accounts have institution-wide read-only access to attendance and teaching
-- activity. Lecturers retain their normal class-scoped teaching and attendance actions.

-- Attendance: administrator can inspect institutional records, but cannot create,
-- modify or delete attendance records directly.
drop policy if exists attendance_admin_all on public.attendance;
create policy attendance_admin_read on public.attendance
for select to authenticated
using ((select public.classtrack_is_admin()));

drop policy if exists attendance_admin_no_insert on public.attendance;
create policy attendance_admin_no_insert on public.attendance
as restrictive for insert to authenticated
with check (not (select public.classtrack_is_admin()));

drop policy if exists attendance_admin_no_update on public.attendance;
create policy attendance_admin_no_update on public.attendance
as restrictive for update to authenticated
using (not (select public.classtrack_is_admin()))
with check (not (select public.classtrack_is_admin()));

drop policy if exists attendance_admin_no_delete on public.attendance;
create policy attendance_admin_no_delete on public.attendance
as restrictive for delete to authenticated
using (not (select public.classtrack_is_admin()));

-- QR attendance sessions: administrators can view all sessions but cannot start,
-- edit or manually close a lecturer's live attendance session.
drop policy if exists attendance_sessions_admin_all on public.attendance_sessions;
create policy attendance_sessions_admin_read on public.attendance_sessions
for select to authenticated
using ((select public.classtrack_is_admin()));

drop policy if exists attendance_sessions_admin_no_insert on public.attendance_sessions;
create policy attendance_sessions_admin_no_insert on public.attendance_sessions
as restrictive for insert to authenticated
with check (not (select public.classtrack_is_admin()));

drop policy if exists attendance_sessions_admin_no_update on public.attendance_sessions;
create policy attendance_sessions_admin_no_update on public.attendance_sessions
as restrictive for update to authenticated
using (not (select public.classtrack_is_admin()))
with check (not (select public.classtrack_is_admin()));

drop policy if exists attendance_sessions_admin_no_delete on public.attendance_sessions;
create policy attendance_sessions_admin_no_delete on public.attendance_sessions
as restrictive for delete to authenticated
using (not (select public.classtrack_is_admin()));

-- Lecturer teaching audit: admin remains able to read all logs, but only an
-- authenticated lecturer can create or close their own teaching sign-in.
drop policy if exists lecturer_sign_ins_admin_no_insert on public.lecturer_sign_ins;
create policy lecturer_sign_ins_admin_no_insert on public.lecturer_sign_ins
as restrictive for insert to authenticated
with check (not (select public.classtrack_is_admin()));

drop policy if exists lecturer_sign_ins_admin_no_update on public.lecturer_sign_ins;
create policy lecturer_sign_ins_admin_no_update on public.lecturer_sign_ins
as restrictive for update to authenticated
using (not (select public.classtrack_is_admin()))
with check (not (select public.classtrack_is_admin()));

drop policy if exists lecturer_sign_ins_admin_no_delete on public.lecturer_sign_ins;
create policy lecturer_sign_ins_admin_no_delete on public.lecturer_sign_ins
as restrictive for delete to authenticated
using (not (select public.classtrack_is_admin()));

-- Defense in depth: an administrator cannot invoke the lecturer-facing RPC to
-- finalize a session manually. The scheduled service-role worker remains allowed
-- to finalize expired sessions automatically.
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

  if public.classtrack_is_admin() then
    raise exception 'Live attendance sessions can only be finalized by the lecturer who owns the class or by the automatic expiry worker.';
  end if;

  select c.owner_id into v_owner_id
  from public.attendance_sessions s
  join public.classes c on c.id = s.class_id
  where s.id = p_session_id;

  if v_owner_id is null then
    raise exception 'Attendance session not found.';
  end if;

  if v_owner_id <> auth.uid() then
    raise exception 'You are not allowed to finalize this attendance session.';
  end if;

  return public.classtrack_finalize_attendance_session(p_session_id, 'lecturer');
end;
$$;

revoke all on function public.finalize_attendance_session(uuid) from public, anon;
grant execute on function public.finalize_attendance_session(uuid) to authenticated;

-- Existing admin SELECT policies on attendance and attendance_sessions provide
-- the read-only data required by the Global Admin dashboard and report exports.
