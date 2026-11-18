import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const siteUrl = (Deno.env.get("CLASSTRACK_SITE_URL") || "https://classtrack-student-attendance.netlify.app").replace(/\/$/, "");
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return json({ error: "The invitation function is missing its Supabase environment configuration." }, 500);
    }

    const authorization = request.headers.get("Authorization");
    if (!authorization) return json({ error: "Sign in before sending a student invitation." }, 401);

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: callerData, error: callerError } = await callerClient.auth.getUser();
    if (callerError || !callerData.user) return json({ error: "Your session is invalid. Sign in again." }, 401);

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: role, error: roleError } = await adminClient
      .from("user_roles")
      .select("role, account_status")
      .eq("user_id", callerData.user.id)
      .maybeSingle();
    if (roleError) throw roleError;
    if (!role || role.account_status !== "active" || !["admin", "lecturer"].includes(role.role)) {
      return json({ error: "Only an active lecturer or System Administrator can invite students." }, 403);
    }

    const body = await request.json();
    const studentId = String(body.student_id || "").trim();
    if (!studentId) return json({ error: "A student record ID is required." }, 400);

    const { data: student, error: studentError } = await adminClient
      .from("students")
      .select("id, class_id, full_name, admission_number, email, user_id")
      .eq("id", studentId)
      .maybeSingle();
    if (studentError) throw studentError;
    if (!student) return json({ error: "Student record not found." }, 404);

    const { data: classRow, error: classError } = await adminClient
      .from("classes")
      .select("id, name, owner_id, enrollment_token")
      .eq("id", student.class_id)
      .maybeSingle();
    if (classError) throw classError;
    if (!classRow) return json({ error: "The student's class record could not be found." }, 404);

    if (role.role !== "admin" && classRow.owner_id !== callerData.user.id) {
      return json({ error: "You can only invite students enrolled in your own classes." }, 403);
    }

    const email = String(student.email || "").trim().toLowerCase();
    if (!email) return json({ error: "Add the student's login email to the roster before sending an invitation." }, 400);

    if (student.user_id) {
      const { data: linked, error: linkedError } = await adminClient.auth.admin.getUserById(student.user_id);
      if (linkedError) throw linkedError;
      if (linked.user?.email_confirmed_at) {
        return json({ success: true, already_linked: true, message: "This student's account is already linked and verified." });
      }
      return json({ success: true, awaiting_verification: true, message: "An account is already linked. The student must confirm the invitation email before checking in." });
    }

    const redirectTo = classRow.enrollment_token
      ? `${siteUrl}/student.html?mode=register&token=${encodeURIComponent(classRow.enrollment_token)}`
      : `${siteUrl}/student.html`;

    const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { full_name: student.full_name, user_type: "student", admission_number: student.admission_number },
      redirectTo,
    });

    if (inviteError) {
      const message = inviteError.message || "Could not send the invitation.";
      if (/already been registered|already registered|user already exists/i.test(message)) {
        return json({
          error: "An account already exists for this email. Ask the student to sign in on the Student Portal using that email, then open the class registration link to link their existing account.",
          code: "USER_ALREADY_EXISTS",
        }, 409);
      }
      throw inviteError;
    }

    if (!inviteData.user?.id) throw new Error("Supabase sent no user ID for the invitation.");

    const { error: linkError } = await adminClient
      .from("students")
      .update({ user_id: inviteData.user.id })
      .eq("id", student.id)
      .is("user_id", null);
    if (linkError) throw linkError;

    return json({
      success: true,
      invited: true,
      message: `Invitation sent to ${email}. The student must accept it and verify the email before QR check-in.`,
    });
  } catch (error) {
    console.error("invite-student error:", error);
    return json({ error: error instanceof Error ? error.message : "Unexpected invitation error." }, 500);
  }
});
