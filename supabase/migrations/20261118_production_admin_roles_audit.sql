-- ClassTrack production role-based administration
-- Run this migration in Supabase SQL Editor after the existing ClassTrack schema.
-- Admin assignment is intentionally manual and cannot be self-service.
create table if not exists public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'lecturer' check (role in ('admin','lecturer','student')),
  account_status text not null default 'active' check (account_status in ('active','suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_roles_role_status_idx
  on public.user_roles(role, account_status);

alter table public.user_roles enable row level security;

create or replace function public.handle_new_classtrack_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  v_role := case
    when coalesce(new.raw_user_meta_data ->> 'user_type', '') = 'student' then 'student'
    else 'lecturer'
  end;
  insert into public.user_roles(user_id, role, account_status)
  values (new.id, v_role, 'active')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_classtrack_role on auth.users;
create trigger on_auth_user_created_classtrack_role
after insert on auth.users
for each row execute function public.handle_new_classtrack_user();

-- Backfill existing accounts without changing an already assigned role.
insert into public.user_roles(user_id, role, account_status)
select u.id,
       case when coalesce(u.raw_user_meta_data ->> 'user_type', '') = 'student'
            then 'student' else 'lecturer' end,
       'active'
from auth.users u
on conflict (user_id) do nothing;

create or replace function public.classtrack_current_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select ur.role
  from public.user_roles ur
  where ur.user_id = (select auth.uid())
    and ur.account_status = 'active'
  limit 1;
$$;

create or replace function public.classtrack_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = (select auth.uid())
      and ur.role = 'admin'
      and ur.account_status = 'active'
  );
$$;

create or replace function public.classtrack_account_is_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = (select auth.uid())
      and ur.account_status = 'active'
  );
$$;

revoke all on function public.classtrack_current_role() from public, anon;
revoke all on function public.classtrack_is_admin() from public, anon;
revoke all on function public.classtrack_account_is_active() from public, anon;
grant execute on function public.classtrack_current_role() to authenticated;
grant execute on function public.classtrack_is_admin() to authenticated;
grant execute on function public.classtrack_account_is_active() to authenticated;

drop policy if exists user_roles_read_self_or_admin on public.user_roles;
create policy user_roles_read_self_or_admin
on public.user_roles for select to authenticated
using (user_id = (select auth.uid()) or (select public.classtrack_is_admin()));
-- No authenticated INSERT/UPDATE/DELETE policy is created for user_roles.
-- Role assignment is restricted to trusted SQL/service-role operations.

-- Restrictive account-status guards ensure a suspended account cannot continue
-- using an old JWT/session through the Data API.
drop policy if exists classtrack_active_account_guard on public.classes;
create policy classtrack_active_account_guard on public.classes
as restrictive for all to authenticated
using ((select public.classtrack_account_is_active()))
with check ((select public.classtrack_account_is_active()));

drop policy if exists classtrack_active_account_guard on public.students;
create policy classtrack_active_account_guard on public.students
as restrictive for all to authenticated
using ((select public.classtrack_account_is_active()))
with check ((select public.classtrack_account_is_active()));

drop policy if exists classtrack_active_account_guard on public.attendance;
create policy classtrack_active_account_guard on public.attendance
as restrictive for all to authenticated
using ((select public.classtrack_account_is_active()))
with check ((select public.classtrack_account_is_active()));

drop policy if exists classtrack_active_account_guard on public.attendance_sessions;
create policy classtrack_active_account_guard on public.attendance_sessions
as restrictive for all to authenticated
using ((select public.classtrack_account_is_active()))
with check ((select public.classtrack_account_is_active()));

-- Admin access is additive to the existing lecturer/student policies.
drop policy if exists classes_admin_all on public.classes;
create policy classes_admin_all on public.classes
for all to authenticated
using ((select public.classtrack_is_admin()))
with check ((select public.classtrack_is_admin()));

drop policy if exists students_admin_all on public.students;
create policy students_admin_all on public.students
for all to authenticated
using ((select public.classtrack_is_admin()))
with check ((select public.classtrack_is_admin()));

drop policy if exists attendance_admin_all on public.attendance;
create policy attendance_admin_all on public.attendance
for all to authenticated
using ((select public.classtrack_is_admin()))
with check ((select public.classtrack_is_admin()));

drop policy if exists attendance_sessions_admin_all on public.attendance_sessions;
create policy attendance_sessions_admin_all on public.attendance_sessions
for all to authenticated
using ((select public.classtrack_is_admin()))
with check ((select public.classtrack_is_admin()));

grant select on public.user_roles to authenticated;
grant select, insert, update, delete on public.classes to authenticated;
grant select, insert, update, delete on public.students to authenticated;
grant select, insert, update, delete on public.attendance to authenticated;
grant select, insert, update, delete on public.attendance_sessions to authenticated;

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  table_name text not null,
  record_id text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_at_idx on public.audit_logs(created_at desc);
create index if not exists audit_logs_actor_id_idx on public.audit_logs(actor_id);
alter table public.audit_logs enable row level security;

drop policy if exists audit_logs_admin_read on public.audit_logs;
create policy audit_logs_admin_read on public.audit_logs
for select to authenticated
using ((select public.classtrack_is_admin()));

create or replace function public.classtrack_write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_record_id text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_record_id := coalesce(v_new ->> 'id', v_new ->> 'user_id');
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_record_id := coalesce(v_new ->> 'id', v_new ->> 'user_id');
  else
    v_old := to_jsonb(old);
    v_record_id := coalesce(v_old ->> 'id', v_old ->> 'user_id');
  end if;

  insert into public.audit_logs(actor_id, action, table_name, record_id, old_data, new_data)
  values (auth.uid(), tg_op, tg_table_name, v_record_id, v_old, v_new);

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists classtrack_audit_classes on public.classes;
create trigger classtrack_audit_classes
after insert or update or delete on public.classes
for each row execute function public.classtrack_write_audit_log();

drop trigger if exists classtrack_audit_students on public.students;
create trigger classtrack_audit_students
after insert or update or delete on public.students
for each row execute function public.classtrack_write_audit_log();

drop trigger if exists classtrack_audit_attendance on public.attendance;
create trigger classtrack_audit_attendance
after insert or update or delete on public.attendance
for each row execute function public.classtrack_write_audit_log();

drop trigger if exists classtrack_audit_attendance_sessions on public.attendance_sessions;
create trigger classtrack_audit_attendance_sessions
after insert or update or delete on public.attendance_sessions
for each row execute function public.classtrack_write_audit_log();

-- Secure admin account directory; does not expose passwords or auth tokens.
create or replace function public.admin_list_accounts()
returns table (
  user_id uuid,
  email text,
  full_name text,
  department text,
  role text,
  account_status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.classtrack_is_admin() then
    raise exception 'Administrator access required.';
  end if;
  return query
  select u.id, u.email::text,
         coalesce(u.raw_user_meta_data ->> 'full_name', ''),
         coalesce(u.raw_user_meta_data ->> 'department', ''),
         ur.role, ur.account_status, u.created_at
  from auth.users u
  join public.user_roles ur on ur.user_id = u.id
  order by u.created_at desc;
end;
$$;

create or replace function public.admin_set_account_status(
  p_user_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.classtrack_is_admin() then
    raise exception 'Administrator access required.';
  end if;
  if p_status not in ('active', 'suspended') then
    raise exception 'Invalid account status.';
  end if;
  if p_user_id = (select auth.uid()) then
    raise exception 'You cannot suspend your own administrator account.';
  end if;
  update public.user_roles
  set account_status = p_status, updated_at = now()
  where user_id = p_user_id and role = 'lecturer';
  if not found then
    raise exception 'Lecturer account not found.';
  end if;
end;
$$;

revoke all on function public.admin_list_accounts() from public, anon;
revoke all on function public.admin_set_account_status(uuid, text) from public, anon;
grant execute on function public.admin_list_accounts() to authenticated;
grant execute on function public.admin_set_account_status(uuid, text) to authenticated;

-- BOOTSTRAP THE FIRST ADMIN (run separately after this migration):
-- Replace the email below with the email address of YOUR existing ClassTrack login,
-- then execute this statement in Supabase SQL Editor. Do not use browser metadata.
-- insert into public.user_roles(user_id, role, account_status)
-- select id, 'admin', 'active' from auth.users
-- where lower(email) = lower('YOUR_LOGIN_EMAIL')
-- on conflict (user_id) do update set role = 'admin', account_status = 'active', updated_at = now();
