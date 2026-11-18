# ClassTrack Student Identity & Enrollment Setup

This milestone makes the lecturer-created student roster the source of truth. A student must have a roster row, a matching email address, and a verified Supabase Auth account before QR attendance is accepted.

## 1. Apply the database migration

Open Supabase Dashboard → SQL Editor and run the complete migration:

`supabase/migrations/20261119_student_identity_enrollment_management.sql`

The migration:
- blocks duplicate normalized admission numbers within the same class;
- prevents client-side changes to a linked `students.user_id`;
- requires a confirmed Auth email matching the lecturer-entered roster email;
- only allows a student to link to a pre-existing roster row;
- keeps linked roster email synchronized when the Auth email is changed and confirmed;
- provides an administrator-only enrollment health report.

**Important:** The migration deliberately stops if duplicate admission numbers or duplicate account links already exist. It does not delete records. If it stops, run this diagnostic query, review the duplicates, correct them while preserving attendance history, then rerun the migration:

```sql
SELECT
  class_id,
  public.classtrack_normalize_admission(admission_number) AS normalized_admission,
  array_agg(id) AS student_record_ids,
  array_agg(full_name) AS student_names,
  count(*) AS duplicate_count
FROM public.students
GROUP BY class_id, public.classtrack_normalize_admission(admission_number)
HAVING public.classtrack_normalize_admission(admission_number) <> ''
   AND count(*) > 1
ORDER BY duplicate_count DESC;
```

## 2. Enable verified email

In Supabase Authentication settings, enable email confirmation for the Email provider. Add the production Student Portal URL to the allowed redirect URLs:

`https://classtrack-student-attendance.netlify.app/student.html`

Email confirmation is enforced again inside the database RPCs; the browser UI alone is not trusted.

## 3. Deploy the secure invitation function

The repository includes:

`supabase/functions/invite-student/index.ts`

Deploy it from a terminal with the Supabase CLI:

```bash
supabase login
supabase link --project-ref njvtyrhwjcfnmeicsfwr
supabase secrets set CLASSTRACK_SITE_URL=https://classtrack-student-attendance.netlify.app
supabase functions deploy invite-student
```

Supabase provides the function runtime with its project URL, anon key, and service-role key. Never paste the service-role key into `index.html`, `script.js`, or any browser-visible file.

The function checks the caller's active ClassTrack role and class ownership before sending an invitation. Students receive an invitation email that returns them to the correct class-linking page. If the email already has an account, the function asks the student to sign in and link that existing account instead of creating a duplicate.

For reliable production email delivery, configure a trusted SMTP provider in Supabase Auth. The built-in email sender may have restrictive testing limits.

## 4. Deploy the website

Pushes to the repository should trigger the connected Netlify deployment. Confirm that the latest GitHub commits have deployed before testing the new dashboard and invite buttons.

## 5. Normal enrollment process

1. Lecturer adds the student to the correct class with the student's actual admission number and the email the student will use for ClassTrack.
2. For many students, use **Download CSV template** and **Import CSV**. Required headers are `full_name,admission_number,class_name,email`; `phone` is optional. The class name must match an existing ClassTrack class.
3. Send an individual invitation from the student row, or use **Invite all eligible students** from the System Administrator enrollment panel.
4. Student accepts the invitation, sets up/signs in to their account, and confirms their email.
5. The account is linked to the existing roster row. A student with an existing account can sign in through the Student Portal and use the class registration link to link it.
6. Student scans a fresh lecture QR and enters the admission number.

A missing email, incorrect class, duplicate admission number, unverified account, or account already linked elsewhere is reported with an actionable message. Do not manually populate `students.user_id`; the secure enrollment process owns that link.

## 6. Verification

As System Administrator, open Settings → Student identity & enrollment. Check:
- Total roster records
- Verified accounts linked
- Records awaiting account linking
- Records awaiting email verification
- Records missing email
- The attention list, with an Edit action to correct roster details

Test with one new student before inviting a full class. Confirm that the student can check in only after accepting the invitation and verifying the matching email.
