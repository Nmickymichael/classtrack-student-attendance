"use strict";

const STUDENT_SUPABASE_URL = "https://njvtyrhwjcfnmeicsfwr.supabase.co";
const STUDENT_SUPABASE_KEY = "sb_publishable_olGFCvyGzVdY0FSggCpoeA_UpmoTagj";
const studentSupabase = window.supabase.createClient(STUDENT_SUPABASE_URL, STUDENT_SUPABASE_KEY);
const studentParams = new URLSearchParams(window.location.search);
const studentMode = studentParams.get("mode") || "register";
const enrollmentToken = studentParams.get("token");
const attendanceToken = studentParams.get("session");

const byId = id => document.getElementById(id);
const loginForm = byId("studentLoginForm");
const signupForm = byId("studentSignupForm");
const registrationForm = byId("studentRegistrationForm");
const checkinPanel = byId("studentCheckinPanel");
const checkinForm = byId("studentCheckinForm");
const message = byId("studentMessage");
let activeStudentUser = null;

function studentMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}
function showStudentPanel(panel) {
  [loginForm, signupForm, registrationForm, checkinPanel].forEach(item => item.classList.add("student-hidden"));
  if (panel) panel.classList.remove("student-hidden");
}
function setStudentHeading() {
  byId("studentTitle").textContent = studentMode === "checkin" ? "Lecture check-in" : "Class registration";
  byId("studentSubtitle").textContent = studentMode === "checkin"
    ? "Sign in with your student account to record attendance."
    : "Create your student account once, then register for this class.";
}
function setSignedInUI(user) {
  activeStudentUser = user;
  byId("studentModeToggle").classList.add("student-hidden");
  if (studentMode === "checkin") {
    byId("studentCheckinAdmission").value = "";
    showStudentPanel(checkinPanel);
  } else if (studentMode === "register" && enrollmentToken) {
    showStudentPanel(registrationForm);
    byId("studentFullName").value = user.user_metadata?.full_name || "";
  } else {
    showStudentPanel(checkinPanel);
    byId("studentTitle").textContent = "You're signed in";
    byId("studentSubtitle").textContent = "Scan a class registration QR code to join a class, or sign out when finished.";
    byId("studentCheckinButton").disabled = true;
    byId("studentCheckinButton").textContent = "Scan a lecture QR to check in";
  }
}
async function submitStudentRegistration(event) {
  event.preventDefault();
  if (!activeStudentUser || !enrollmentToken) return;
  const button = registrationForm.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "Saving registration...";
  try {
    const { data, error } = await studentSupabase.rpc("student_register", {
      p_enrollment_token: enrollmentToken,
      p_full_name: byId("studentFullName").value.trim(),
      p_admission_number: byId("studentAdmission").value.trim(),
      p_phone: byId("studentPhone").value.trim()
    });
    if (error) throw error;
    studentMessage(data?.message || "Registration saved. You can now use your student account for future check-ins.");
    registrationForm.reset();
    byId("studentTitle").textContent = "Registration complete!";
    byId("studentSubtitle").textContent = "Your details are saved. Use your email and password for future lectures.";
    showStudentPanel(null);
  } catch (error) {
    console.error("Student registration error:", error);
    studentMessage(error.message || "Could not complete registration.", true);
  } finally {
    button.disabled = false;
    button.textContent = "Complete class registration";
  }
}
async function submitStudentCheckin(event) {
  event.preventDefault();
  if (!activeStudentUser || !attendanceToken) {
    studentMessage("This QR code is missing a valid lecture session.", true);
    return;
  }
  const button = byId("studentCheckinButton");
  const admissionNumber = byId("studentCheckinAdmission").value.trim().toLowerCase();
  if (!admissionNumber) {
    studentMessage("Enter your admission number to continue.", true);
    return;
  }
  button.disabled = true;
  button.textContent = "Verifying admission number...";
  try {
    const { data, error } = await studentSupabase.rpc("student_check_in", {
      p_session_token: attendanceToken,
      p_admission_number: admissionNumber
    });
    if (error) throw error;
    studentMessage(data?.message || "Attendance recorded successfully.");
    button.textContent = "✓ Attendance recorded";
    byId("studentCheckinAdmission").disabled = true;
  } catch (error) {
    console.error("Student check-in error:", error);
    const rawMessage = String(error.message || "");
    const normalizedError = rawMessage.toLowerCase();
    let friendlyMessage = rawMessage || "Could not record attendance.";
    if (normalizedError.includes("already linked") || normalizedError.includes("different student account")) {
      friendlyMessage = "This admission number is already linked to another student account.";
    } else if (normalizedError.includes("not enrolled") || normalizedError.includes("not registered for this class")) {
      friendlyMessage = "You are not enrolled in this class.";
    } else if (normalizedError.includes("admission number") && (normalizedError.includes("does not match") || normalizedError.includes("mismatch"))) {
      friendlyMessage = "The admission number entered does not match your student account.";
    }
    studentMessage(friendlyMessage, true);
    button.disabled = false;
    button.textContent = "✓ Verify and check in";
  }
}
loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = loginForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const { data, error } = await studentSupabase.auth.signInWithPassword({
      email: byId("studentLoginEmail").value.trim().toLowerCase(),
      password: byId("studentLoginPassword").value
    });
    if (error) throw error;
    studentMessage("Signed in successfully.");
    setSignedInUI(data.user);
  } catch (error) {
    studentMessage(error.message || "Unable to sign in.", true);
  } finally {
    button.disabled = false;
  }
});
signupForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = signupForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const fullName = byId("studentSignupName").value.trim();
    const email = byId("studentSignupEmail").value.trim().toLowerCase();
    const password = byId("studentSignupPassword").value;
    const { data, error } = await studentSupabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName, user_type: "student" },
        emailRedirectTo: window.location.origin + window.location.pathname + window.location.search
      }
    });
    if (error) throw error;
    if (data.session && data.user) {
      studentMessage("Student account created. Complete your class registration below.");
      setSignedInUI(data.user);
    } else {
      studentMessage("Account created. Check your email to confirm it, then sign in here to finish registration.");
      byId("studentLoginEmail").value = email;
      showStudentPanel(loginForm);
    }
  } catch (error) {
    studentMessage(error.message || "Could not create your account.", true);
  } finally {
    button.disabled = false;
  }
});
registrationForm.addEventListener("submit", submitStudentRegistration);
checkinForm.addEventListener("submit", submitStudentCheckin);
byId("studentModeToggle").addEventListener("click", () => {
  const showingSignup = !signupForm.classList.contains("student-hidden");
  showStudentPanel(showingSignup ? loginForm : signupForm);
  byId("studentModeToggle").textContent = showingSignup
    ? "New student? Create an account"
    : "Already registered? Sign in";
  studentMessage("");
});
async function initStudentPortal() {
  setStudentHeading();
  if (studentMode === "register" && !enrollmentToken) {
    studentMessage("The registration QR code is missing its class token. Ask your lecturer for a new QR code.", true);
  }
  if (studentMode === "checkin" && !attendanceToken) {
    studentMessage("The lecture QR code is missing its session token. Ask your lecturer to display a new code.", true);
  }
  const { data, error } = await studentSupabase.auth.getSession();
  if (error) {
    studentMessage(error.message, true);
    showStudentPanel(loginForm);
    return;
  }
  if (data.session?.user) setSignedInUI(data.session.user);
  else showStudentPanel(loginForm);
}
initStudentPortal();
