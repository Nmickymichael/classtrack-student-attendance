# ClassTrack Global Admin Portal

This update separates the Global Administrator workspace from lecturer teaching workflows.

## Global Admin behavior

- The administrator role is determined by the Supabase `user_roles.role = 'admin'` assignment. The configured administrator login is `michaelmicky796@gmail.com`; do not rely on an email-only frontend check as an authorization mechanism.
- The Take Attendance navigation item and attendance view are hidden for administrators.
- Direct navigation to the attendance view and attempts to start QR sessions are blocked in the frontend.
- Class cards show a View roster shortcut for administrators. Teaching sign-in and sign-out controls are not rendered for administrators.
- The Global Admin workspace starts empty and is rebuilt from Supabase on refresh. It does not aggregate legacy lecturer localStorage workspaces or write institutional records to localStorage.
- Lecturer accounts retain their normal class-scoped teaching and attendance workflows.

## Live lecturer oversight

The administrator overview loads lecturer accounts from `admin_list_accounts`, class ownership from `classes`, attendance from `attendance`, and teaching history from `lecturer_sign_ins`.

The teaching audit displays:
- teaching-now count for the current local day;
- completed teaching sessions today;
- total sign-ins today;
- individual lecturer, unit, topic, venue, sign-in time, live status and sign-out time.

Realtime database events refresh the dashboard, with the existing 10-second cloud refresh as a fallback. A teaching record is considered active while its database status is `Signed In · Teaching`; lecturers should use Sign Out when they finish.

## Institutional reporting

The overview includes:
- monthly attendance summary CSV export, grouped by day and class;
- low-attendance student CSV export using the existing 75% threshold;
- print action for the official monthly attendance register.

Exports use the cloud-synchronized records in the current administrator session.

## Supabase migration

After the existing production admin, lecturer sign-in and attendance migrations have been applied, run:

`supabase/migrations/20261119_global_admin_portal_rbac.sql`

This migration changes the administrator's attendance permissions to read-only, keeps institution-wide SELECT access, prevents administrator INSERT/UPDATE/DELETE actions on attendance, attendance sessions and lecturer teaching logs, and blocks the admin account from manually invoking the lecturer attendance-finalization RPC. The automatic expiry worker remains available to the service role.

The migration does not change lecturer permissions or their class ownership policies.

## Deployment and verification

1. Run the migration in Supabase SQL Editor.
2. Confirm it completes without SQL errors.
3. Confirm the GitHub default branch changes have deployed through Netlify.
4. Sign in as the Global Admin and confirm Take Attendance is absent, class cards have View roster, and the dashboard reports Supabase data.
5. Sign in with a lecturer account and confirm Take Attendance, Sign In to Teach, Sign Out and QR sessions remain available.
6. Have a lecturer sign in and sign out of a class; confirm the admin live teaching audit changes without a manual page reload.
7. Test the monthly CSV, low-attendance CSV and print action.

The GitHub changes and static JavaScript validation do not by themselves prove that the Supabase migration or Netlify deployment has been applied.
