"use strict";

/* =========================================
   CLASSTRACK v3.4 - SECURE ADMIN PASSWORD + LECTURER CREDENTIAL RECOVERY
   Admin Default PIN: 'admin@2026' (Admin-only change)
   Lecturer Recovery: Admin 'Reset PIN' Action + Self-Service Name/Staff ID Verification
   ========================================= */
/* =========================================
   CLASSTRACK SUPABASE CONNECTION
   ========================================= */
const SUPABASE_URL = "https://njvtyrhwjcfnmeicsfwr.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_olGFCvyGzVdY0FSggCpoeA_UpmoTagj";

// Initialize Supabase client
const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      // Keep lecturer authentication scoped to this browser tab.
      // A new tab starts at the login screen, while a page refresh in
      // the same tab can safely restore the current lecturer session.
      storage: window.sessionStorage,
      storageKey: "classtrack-lecturer-auth",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);

console.log("ClassTrack: Supabase client initialized successfully.");
const LECTURERS_KEY = "classtrack_lecturers_registry";
const LEGACY_STORAGE_KEY = "classtrack_attendance_v1";
const SESSION_AUTH_KEY = "classtrack_auth_session";
const DEFAULT_ADMIN_PIN = "admin@2026";

const $ = (id) => document.getElementById(id);

const today = () => {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("-");
};

const nowTimeFormatted = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const makeId = () => crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const normalizeAdmissionNumber = (value) => String(value || "").trim().toUpperCase().replace(/\s+/g, "");

const isAdminUser = (user) => user?.role === "admin";

const getWorkspaceKey = (staffId) =>
  `classtrack_workspace_${String(staffId || "admin").trim().toLowerCase()}`;

const emptyWorkspace = (lecturer = {}) => ({
  students: [],
  classes: [],
  attendance: [],
  teachingLogs: [],
  settings: {
    institution: "University of Embu TVET Institute",
    department: lecturer.department || "Computing & Informatics Department",
    pin: lecturer.pin || (isAdminUser(lecturer) ? DEFAULT_ADMIN_PIN : "1234"),
    lecturerName: lecturer.name || "Lecturer"
  }
});

let currentLecturer = null;
let data = emptyWorkspace();
let currentReport = [];
let activeQrSession = null;
let sessionTimerInterval = null;
let cloudRefreshInterval = null;
let portalTimerInterval = null;

/* =========================================
   LECTURER REGISTRY & WORKSPACE AGGREGATION
   ========================================= */

function getLecturers() {
  try {
    const raw = localStorage.getItem(LECTURERS_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length) {
        // Ensure admin exists and upgrade legacy '1234' default admin PIN automatically
        const adminEntry = list.find(l => isAdminUser(l));
        if (adminEntry && adminEntry.pin === "1234" && !localStorage.getItem("classtrack_admin_pin_customized")) {
          adminEntry.pin = DEFAULT_ADMIN_PIN;
          localStorage.setItem(LECTURERS_KEY, JSON.stringify(list));
        }
        return list;
      }
    }
  } catch (e) {
    console.error("Failed reading lecturers registry:", e);
  }

  const defaultList = [
    {
      id: "default-admin",
      name: "System Administrator",
      staffId: "admin",
      department: "Academic Administration",
      pin: DEFAULT_ADMIN_PIN
    }
  ];

  try {
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const legacyParsed = JSON.parse(legacyRaw);
      if (Array.isArray(legacyParsed.lecturers)) {
        legacyParsed.lecturers.forEach(lec => {
          if (!defaultList.some(d => d.staffId.toLowerCase() === lec.staffId.toLowerCase())) {
            defaultList.push(lec);
          }
        });
      }
    }
  } catch (_) {}

  localStorage.setItem(LECTURERS_KEY, JSON.stringify(defaultList));
  return defaultList;
}

function saveLecturers(list) {
  localStorage.setItem(LECTURERS_KEY, JSON.stringify(list));
}

function readRawWorkspaceByStaffId(staffId) {
  try {
    const raw = localStorage.getItem(getWorkspaceKey(staffId));
    if (!raw) return emptyWorkspace({ staffId });
    const parsed = JSON.parse(raw);
    return {
      ...emptyWorkspace({ staffId }),
      ...parsed,
      teachingLogs: Array.isArray(parsed.teachingLogs) ? parsed.teachingLogs : []
    };
  } catch (_) {
    return emptyWorkspace({ staffId });
  }
}

function loadGlobalAdminView(adminUser) {
  const lecturers = getLecturers();
  const adminOwn = readRawWorkspaceByStaffId("admin");
  const todayStr = today();

  const combined = {
    students: [],
    classes: [],
    attendance: [],
    teachingLogs: [],
    lecturersSummary: [],
    settings: {
      ...emptyWorkspace(adminUser).settings,
      ...(adminOwn.settings || {}),
      pin: adminUser.pin
    }
  };

  lecturers.forEach(lec => {
    const ws = readRawWorkspaceByStaffId(lec.staffId);
    const lecLabel = isAdminUser(lec) ? "Admin Direct" : `${lec.name} (${lec.staffId})`;

    const lecClasses = (ws.classes || []).map(c => ({
      ...c,
      _ownerStaffId: lec.staffId,
      _ownerName: lecLabel,
      displayName: isAdminUser(lec) ? c.name : `${c.name} — [${lec.name}]`
    }));

    const lecStudents = (ws.students || []).map(s => ({
      ...s,
      _ownerStaffId: lec.staffId,
      _ownerName: lecLabel
    }));

    const lecAttendance = (ws.attendance || []).map(a => ({
      ...a,
      _ownerStaffId: lec.staffId,
      _ownerName: lecLabel
    }));

    const lecLogs = (ws.teachingLogs || []).map(log => ({
      ...log,
      _ownerStaffId: lec.staffId,
      _ownerName: lec.name,
      _ownerStaffLabel: lecLabel
    }));

    combined.classes.push(...lecClasses);
    combined.students.push(...lecStudents);
    combined.attendance.push(...lecAttendance);
    combined.teachingLogs.push(...lecLogs);

    if (!isAdminUser(lec) || lecClasses.length > 0 || lecStudents.length > 0 || lecLogs.length > 0) {
      const totalRecs = lecAttendance.length;
      const presentRecs = lecAttendance.filter(r => r.status === "Present" || r.status === "Late").length;
      const rate = totalRecs ? Math.round((presentRecs / totalRecs) * 100) : null;
      const signedInToday = lecLogs.some(l => l.date === todayStr);

      combined.lecturersSummary.push({
        name: lec.name,
        staffId: lec.staffId,
        department: lec.department || "—",
        isAdmin: isAdminUser(lec),
        classCount: lecClasses.length,
        studentCount: lecStudents.length,
        lessonsSignedIn: lecLogs.length,
        signedInToday,
        attendanceRate: rate
      });
    }
  });

  return combined;
}

function loadWorkspace(lecturer) {
  if (isAdminUser(lecturer)) {
    return loadGlobalAdminView(lecturer);
  }

  const key = getWorkspaceKey(lecturer.staffId);
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...emptyWorkspace(lecturer),
        ...parsed,
        teachingLogs: Array.isArray(parsed.teachingLogs) ? parsed.teachingLogs : [],
        settings: {
          ...emptyWorkspace(lecturer).settings,
          ...(parsed.settings || {})
        }
      };
    }

    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw && !localStorage.getItem(`${LEGACY_STORAGE_KEY}_migrated`)) {
      const legacyParsed = JSON.parse(legacyRaw);
      localStorage.setItem(`${LEGACY_STORAGE_KEY}_migrated`, "true");
      const migrated = {
        ...emptyWorkspace(lecturer),
        students: legacyParsed.students || [],
        classes: legacyParsed.classes || [],
        attendance: legacyParsed.attendance || [],
        teachingLogs: [],
        settings: {
          ...emptyWorkspace(lecturer).settings,
          ...(legacyParsed.settings || {}),
          lecturerName: lecturer.name
        }
      };
      localStorage.setItem(key, JSON.stringify(migrated));
      return migrated;
    }
  } catch (error) {
    console.error("Could not load lecturer workspace:", error);
  }

  const fresh = emptyWorkspace(lecturer);
  localStorage.setItem(key, JSON.stringify(fresh));
  return fresh;
}

function saveData() {
  if (!currentLecturer) return false;

  if (isAdminUser(currentLecturer)) {
    const lecturers = getLecturers();
    lecturers.forEach(lec => {
      const staffId = lec.staffId;
      const existing = readRawWorkspaceByStaffId(staffId);
      const updated = {
        ...existing,
        classes: data.classes
          .filter(c => (c._ownerStaffId || "admin").toLowerCase() === staffId.toLowerCase())
          .map(({ _ownerStaffId, _ownerName, displayName, ...clean }) => clean),
        students: data.students
          .filter(s => (s._ownerStaffId || "admin").toLowerCase() === staffId.toLowerCase())
          .map(({ _ownerStaffId, _ownerName, ...clean }) => clean),
        attendance: data.attendance
          .filter(a => (a._ownerStaffId || "admin").toLowerCase() === staffId.toLowerCase())
          .map(({ _ownerStaffId, _ownerName, ...clean }) => clean),
        teachingLogs: data.teachingLogs
          .filter(l => (l._ownerStaffId || "admin").toLowerCase() === staffId.toLowerCase())
          .map(({ _ownerStaffId, _ownerName, _ownerStaffLabel, ...clean }) => clean),
        settings: isAdminUser(lec) ? data.settings : existing.settings
      };
      localStorage.setItem(getWorkspaceKey(staffId), JSON.stringify(updated));
    });
    return true;
  }

  try {
    const key = getWorkspaceKey(currentLecturer.staffId);
    localStorage.setItem(key, JSON.stringify(data));
    return true;
  } catch (error) {
    console.error("Could not save workspace data:", error);
    toast("Could not save data. Browser storage may be full.");
    return false;
  }
}

/* =========================================
   ADMIN-ASSISTED CREDENTIAL RESET
   ========================================= */

function adminResetLecturerPin(targetStaffId) {
  if (!isAdminUser(currentLecturer)) {
    alert("Unauthorized: Only the System Administrator can reset lecturer credentials.");
    return;
  }
  if (String(targetStaffId).toLowerCase() === "admin") {
    alert("Use Settings & backup to change the Admin password.");
    return;
  }

  const lecturers = getLecturers();
  const lec = lecturers.find(l => l.staffId.toLowerCase() === String(targetStaffId).toLowerCase());
  if (!lec) return;

  const newPin = prompt(
    `Reset Login PIN for:\n${lec.name} (Staff ID: ${lec.staffId})\n\nEnter a new temporary PIN/Password (minimum 4 characters):`,
    "2026"
  );
  if (newPin === null) return;

  const cleanedPin = newPin.trim();
  if (cleanedPin.length < 4) {
    alert("PIN must be at least 4 characters long.");
    return;
  }

  lec.pin = cleanedPin;
  saveLecturers(lecturers);

  const ws = readRawWorkspaceByStaffId(lec.staffId);
  ws.settings = { ...(ws.settings || {}), pin: cleanedPin };
  localStorage.setItem(getWorkspaceKey(lec.staffId), JSON.stringify(ws));

  toast(`✓ PIN reset for ${lec.name} (${lec.staffId}). Share temporary PIN: ${cleanedPin}`);
}

/* =========================================
   LECTURER CLASS SIGN-IN (TEACHING VERIFICATION)
   ========================================= */

async function recordLecturerTeachingSignIn(classId, topic = "", venue = "", silent = false) {
  const cls = data.classes.find(c => c.id === classId);
  if (!cls) throw new Error("The selected class could not be found.");
  if (!currentLecturer?.id) throw new Error("Please sign in again before recording a teaching sign-in.");

  if (!Array.isArray(data.teachingLogs)) data.teachingLogs = [];
  const dateStr = today();
  const ownerId = cls._ownerStaffId || currentLecturer.staffId || "admin";
  const activeToday = data.teachingLogs.find(
    log => log.classId === classId && log.date === dateStr && log.status === "Signed In · Teaching"
  );
  if (activeToday) {
    if (!silent) toast(`You are already signed in to teach ${cls.name}. Sign out before starting another lesson.`);
    return activeToday;
  }

  const cloudClass = await ensureCloudClass(cls);
  const startedAt = new Date().toISOString();
  const payload = {
    lecturer_id: currentLecturer.id,
    lecturer_name: currentLecturer.name || currentLecturer.email || "Lecturer",
    staff_id: currentLecturer.staffId || "",
    class_id: cloudClass.id,
    class_name: cls.name,
    class_code: cls.code || "",
    topic: topic || "Scheduled Lecture / Practical Session",
    venue: venue || "",
    signed_in_at: startedAt,
    status: "Signed In · Teaching"
  };
  const { data: savedLog, error } = await supabaseClient
    .from("lecturer_sign_ins")
    .insert(payload)
    .select("id, lecturer_id, lecturer_name, staff_id, class_id, class_name, class_code, topic, venue, signed_in_at, signed_out_at, status")
    .single();
  if (error) throw error;

  const signedAt = new Date(savedLog.signed_in_at);
  const lessonLog = {
    id: savedLog.id,
    classId: savedLog.class_id,
    className: savedLog.class_name,
    classCode: savedLog.class_code || "",
    date: savedLog.signed_in_at.slice(0, 10),
    time: signedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    topic: savedLog.topic || "",
    venue: savedLog.venue || "",
    status: savedLog.status,
    timestamp: savedLog.signed_in_at,
    _ownerStaffId: savedLog.staff_id || ownerId,
    _ownerName: savedLog.lecturer_name,
    _cloudRecord: true
  };
  data.teachingLogs.push(lessonLog);
  saveData();
  if (!silent) {
    renderClasses();
    renderDashboard();
    toast(`✓ Signed in to teach ${cls.name} at ${lessonLog.time}`);
  }
  return lessonLog;
}

async function promptLecturerClassSignIn(classId) {
  const cls = data.classes.find(c => c.id === classId);
  if (!cls) return;
  const topicInput = prompt(
    `Confirm Class Sign-In for:\n${cls.name}${cls.code ? ` (${cls.code})` : ""}\n\nEnter lesson topic:`,
    "Lecture Session"
  );
  if (topicInput === null) return;
  const venueInput = prompt("Enter teaching venue / room (optional):", "");
  if (venueInput === null) return;
  try {
    await recordLecturerTeachingSignIn(classId, topicInput.trim() || "Lecture Session", venueInput.trim(), false);
  } catch (error) {
    console.error("Lecturer teaching sign-in failed:", error);
    toast("Could not record teaching sign-in in Supabase: " + (error.message || "Check lecturer_sign_ins permissions."));
  }
}

/* =========================================
   STANDALONE MOBILE QR PORTAL + DEVICE LOCK
   ========================================= */

function lockPortalForm(formEl, message) {
  formEl.querySelectorAll("input, button").forEach(el => {
    el.disabled = true;
  });
  const fb = formEl.querySelector(".kiosk-feedback");
  if (fb) {
    fb.textContent = message;
    fb.className = "kiosk-feedback err";
  }
}

function checkUrlPortalMode() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode");
  if (!mode) return false;

  const lecStaffId = params.get("lec") || "admin";
  const classId = params.get("class") || "";
  const className = params.get("cname") || "Assigned Class";
  const expiresAt = parseInt(params.get("exp") || "0", 10);
  const sessionDate = params.get("date") || today();
  const sessionToken = params.get("token") || `${lecStaffId}_${classId}_${sessionDate}`;

  const lecturers = getLecturers();
  const ownerLec = lecturers.find(l => l.staffId.toLowerCase() === lecStaffId.toLowerCase()) || {
    staffId: lecStaffId,
    name: "Lecturer"
  };
  currentLecturer = ownerLec;
  data = readRawWorkspaceByStaffId(ownerLec.staffId);

  $("loginScreen").style.display = "none";
  $("appShell").style.display = "none";
  $("mobileStudentPortal").style.display = "grid";

  if (mode === "enroll") {
    const enrollLockKey = `classtrack_device_enrolled_${lecStaffId}_${classId}`;
    const alreadyEnrolledAdm = localStorage.getItem(enrollLockKey);

    $("portalEyebrow").textContent = `DAY 1 ONBOARDING · ${ownerLec.name.toUpperCase()}`;
    $("portalTitle").textContent = "Class Self-Registration";
    $("portalSubtitle").textContent = className;
    $("portalTimerBar").style.display = "none";
    const form = $("phoneEnrollForm");
    form.style.display = "grid";

    if (alreadyEnrolledAdm) {
      lockPortalForm(
        form,
        `🔒 Device Locked: This device already registered (${alreadyEnrolledAdm}) for this unit.`
      );
      return true;
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (localStorage.getItem(enrollLockKey)) return;

      const name = $("phoneRegName").value.trim();
      const admission = $("phoneRegAdm").value.trim();
      const phone = $("phoneRegPhone").value.trim();
      const fb = $("phoneEnrollFeedback");

      if (!name || !admission) return;

      const exists = data.students.some(
        s => s.classId === classId && s.admission.toLowerCase() === admission.toLowerCase()
      );
      if (exists) {
        fb.textContent = "This admission number is already registered in this unit.";
        fb.className = "kiosk-feedback err";
        return;
      }

      data.students.push({
        id: makeId(),
        name,
        admission,
        classId,
        phone,
        createdDate: today()
      });
      localStorage.setItem(getWorkspaceKey(ownerLec.staffId), JSON.stringify(data));
      localStorage.setItem(enrollLockKey, admission);

      form.reset();
      lockPortalForm(
        form,
        `✓ Registered ${name} (${admission})! Device is now locked to prevent duplicate entries.`
      );
      fb.className = "kiosk-feedback ok";
    });
    return true;
  }

  if (mode === "checkin") {
    const checkinLockKey = `classtrack_device_checkin_${sessionToken}`;
    const alreadyCheckedAdm = localStorage.getItem(checkinLockKey);

    $("portalEyebrow").textContent = `TIMED CHECK-IN · ${ownerLec.name.toUpperCase()}`;
    $("portalTitle").textContent = "Mark Attendance";
    $("portalSubtitle").textContent = `${className} · ${formatDate(sessionDate)}`;
    const form = $("phoneCheckInForm");
    form.style.display = "grid";

    if (alreadyCheckedAdm) {
      lockPortalForm(
        form,
        `🔒 Device Locked: Attendance already recorded from this device (${alreadyCheckedAdm}).`
      );
    }

    const tickPortal = () => {
      const rem = expiresAt - Date.now();
      if (expiresAt && rem <= 0) {
        clearInterval(portalTimerInterval);
        $("portalCountdown").textContent = "00:00 (EXPIRED)";
        form.style.display = "none";
        $("portalExpiredBox").style.display = "block";
        return;
      }
      if (expiresAt) {
        const sec = Math.ceil(rem / 1000);
        const m = String(Math.floor(sec / 60)).padStart(2, "0");
        const s = String(sec % 60).padStart(2, "0");
        $("portalCountdown").textContent = `${m}:${s}`;
      }
    };

    tickPortal();
    portalTimerInterval = setInterval(tickPortal, 1000);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (localStorage.getItem(checkinLockKey)) return;

      const fb = $("phoneCheckFeedback");
      if (expiresAt && Date.now() >= expiresAt) {
        fb.textContent = "Attendance window has expired.";
        fb.className = "kiosk-feedback err";
        return;
      }

      const adm = $("phoneCheckAdm").value.trim();
      if (!adm) return;

      const matchedStudent = data.students.find(
        s => s.classId === classId && s.admission.toLowerCase() === adm.toLowerCase()
      );

      if (data.students.some(s => s.classId === classId) && !matchedStudent) {
        fb.textContent = "Admission number not enrolled in this unit.";
        fb.className = "kiosk-feedback err";
        return;
      }

      if (matchedStudent) {
        const existingIdx = data.attendance.findIndex(
          r => r.studentId === matchedStudent.id && r.classId === classId && r.date === sessionDate
        );
        const rec = {
          id: existingIdx >= 0 ? data.attendance[existingIdx].id : makeId(),
          studentId: matchedStudent.id,
          classId,
          date: sessionDate,
          status: "Present",
          remarks: "Self check-in via QR scan",
          createdAt: new Date().toISOString()
        };
        if (existingIdx >= 0) data.attendance[existingIdx] = rec;
        else data.attendance.push(rec);
        localStorage.setItem(getWorkspaceKey(ownerLec.staffId), JSON.stringify(data));
      }

      localStorage.setItem(checkinLockKey, adm);

      $("phoneCheckAdm").value = "";
      lockPortalForm(
        form,
        `✓ Present confirmed for ${matchedStudent ? matchedStudent.name : adm}! Device locked for this lesson.`
      );
      fb.className = "kiosk-feedback ok";
    });
    return true;
  }

  return false;
}

/* =========================================
   SUPABASE AUTHENTICATION
   ========================================= */

// Convert Supabase user into the format
// already used by the ClassTrack interface.
async function authUserToLecturer(user) {
  const metadata = user.user_metadata || {};
  const { data: roleRecord, error } = await supabaseClient
    .from("user_roles")
    .select("role, account_status")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    throw new Error("Could not verify your ClassTrack permissions. Apply the production admin migration first. " + error.message);
  }
  if (!roleRecord) {
    throw new Error("Your account has no ClassTrack role. Contact the System Administrator.");
  }
  if (roleRecord.account_status !== "active") {
    const message = roleRecord.account_status === "pending"
      ? "Your lecturer account is awaiting administrator approval."
      : "Your ClassTrack account is suspended. Contact the System Administrator.";
    throw new Error(message);
  }
  if (roleRecord.role === "student") {
    throw new Error("This is a student account. Please use the Student Portal.");
  }

  return {
    id: user.id,
    name: metadata.full_name || user.email,
    staffId: user.email,
    department: metadata.department || "Computing & Informatics Department",
    email: user.email,
    role: roleRecord.role,
    accountStatus: roleRecord.account_status
  };
}

// Restore an existing Supabase login session.
async function checkAuth() {
  try {
    const { data: { session }, error } =
      await supabaseClient.auth.getSession();

    if (error) throw error;

    if (session?.user) {
      unlockApp(await authUserToLecturer(session.user));
    } else {
      $("loginScreen").style.display = "grid";
      $("appShell").style.display = "none";
    }
  } catch (error) {
    console.error("Authentication session error:", error);
    $("loginScreen").style.display = "grid";
    $("appShell").style.display = "none";
    $("loginError").textContent =
      "Could not restore your session. Please sign in again.";
  }
}

function toggleAuthMode(mode) {
  $("loginError").textContent = "";
  $("signUpError").textContent = "";

  $("loginForm").style.display = mode === "signin" ? "grid" : "none";
  $("signUpForm").style.display = mode === "signup" ? "grid" : "none";

  if (mode === "signup") {
    $("authSubtitle").textContent = "Create Private Lecturer Workspace";
  } else {
    $("authSubtitle").textContent = "Lecturer & Administrator Sign In";
  }
}

// Register a lecturer using Supabase Auth.
async function handleSignUp(event) {
  event.preventDefault();

  const name = $("regName").value.trim();
  const email = $("regStaffId").value.trim().toLowerCase();
  const department = $("regDept").value.trim();
  const password = $("regPin").value;

  const errorBox = $("signUpError");
  errorBox.textContent = "";

  if (!name || !email || !department || password.length < 8) {
    errorBox.textContent =
      "Complete all fields. Password must contain at least 8 characters.";
    return;
  }

  const submitButton =
    $("signUpForm").querySelector('button[type="submit"]');

  submitButton.disabled = true;
  submitButton.textContent = "Creating account...";

  try {
    const { data: result, error } =
      await supabaseClient.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: name,
            department: department
          },
          emailRedirectTo:
            window.location.origin + window.location.pathname
        }
      });

    if (error) throw error;

    $("signUpForm").reset();

    if (result.session && result.user) {
      unlockApp(await authUserToLecturer(result.user));
      toast("Welcome to ClassTrack, " + name + "!");
    } else {
      toggleAuthMode("signin");
      $("loginStaffId").value = email;

      $("loginError").textContent =
        "Account created! Check your email and confirm your account before signing in.";
    }

  } catch (error) {
    console.error("Registration error:", error);
    errorBox.textContent = error.message ||
      "Could not create your account. Please try again.";

  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Register & Enter Workspace";
  }
}

// Sign in an existing lecturer.
async function handleLogin(event) {
  event.preventDefault();

  const email = $("loginStaffId").value.trim().toLowerCase();
  const password = $("loginPin").value;

  const errorBox = $("loginError");
  errorBox.textContent = "";

  const submitButton =
    $("loginForm").querySelector('button[type="submit"]');

  submitButton.disabled = true;
  submitButton.textContent = "Signing in...";

  try {
    const { data: result, error } =
      await supabaseClient.auth.signInWithPassword({
        email,
        password
      });

    if (error) throw error;

    $("loginPin").value = "";

    unlockApp(await authUserToLecturer(result.user));

    toast("Welcome back to ClassTrack!");

  } catch (error) {
    console.error("Login error:", error);

    errorBox.textContent =
      error.message || "Unable to sign in. Check your email and password.";

  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Unlock Workspace";
  }
}


// Send a Supabase password-reset email to the entered lecturer email address.
async function handleForgotPassword() {
  const emailInput = $("loginStaffId");
  const email = emailInput.value.trim().toLowerCase();
  const messageBox = $("loginError");
  const forgotButton = $("forgotPasswordBtn");

  messageBox.textContent = "";

  if (!email || !emailInput.checkValidity()) {
    messageBox.textContent = "Please enter a valid email address first.";
    emailInput.focus();
    return;
  }

  forgotButton.disabled = true;
  forgotButton.textContent = "Sending reset email...";

  try {
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    });

    if (error) throw error;

    messageBox.textContent =
      "If an account exists for this email, a password reset link has been sent. Please check your inbox and spam folder.";
    toast("Password reset instructions requested.");

  } catch (error) {
    console.error("Password reset request error:", error);
    messageBox.textContent =
      error.message || "Could not request a password reset. Please try again.";

  } finally {
    forgotButton.disabled = false;
    forgotButton.textContent = "Forgot password?";
  }
}

function unlockApp(user) {
  currentLecturer = user;
  data = loadWorkspace(user);

  $("institutionName").value = data.settings.institution || "";
  $("departmentName").value = data.settings.department || user.department || "";
  $("settingsPin").value = user.pin || data.settings.pin || "";
  const adminPanel = $("adminSecurityPanel");
  if (adminPanel) adminPanel.style.display = isAdminUser(user) ? "block" : "none";

  $("loginScreen").style.display = "none";
  $("appShell").style.display = "block";
  $("lecturerBadge").textContent = isAdminUser(user)
    ? `★ GLOBAL ADMIN (${user.staffId})`
    : `${user.name} (${user.staffId})`;
  $("userAvatar").textContent = isAdminUser(user) ? "★" : user.name.charAt(0).toUpperCase();

  stopQrSession(true);
  $("registerArea").innerHTML = `<div class="empty-state"><div class="empty-symbol">✓</div><h3>Ready to take attendance?</h3><p>Select a class and date above to load its register.</p></div>`;

  populateClassSelects();
  showView("dashboard");
  startCloudRefresh();
}

// Sign out of Supabase.
async function lockApp() {
  try {
    await stopQrSession(true);
    clearInterval(cloudRefreshInterval);

    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;

    currentLecturer = null;
    data = emptyWorkspace();

    sessionStorage.removeItem(SESSION_AUTH_KEY);

    $("appShell").style.display = "none";
    $("loginScreen").style.display = "grid";

    toggleAuthMode("signin");

    toast("Successfully signed out.");

  } catch (error) {
    console.error("Sign-out error:", error);
    toast("Could not sign out. Please try again.");
  }
}

/* =========================================
   GENERAL HELPER FUNCTIONS
   ========================================= */

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}

function getClassName(id) {
  const cls = data.classes.find(item => item.id === id);
  if (!cls) return "Unassigned";
  return isAdminUser(currentLecturer) && cls.displayName ? cls.displayName : cls.name;
}

function getStudentName(id) {
  return data.students.find(item => item.id === id)?.name || "Deleted student";
}

function getStudentAttendanceStats(studentId) {
  const records = data.attendance.filter(r => r.studentId === studentId);
  const total = records.length;
  if (!total) return { total: 0, attended: 0, rate: null };
  const attended = records.filter(r => r.status === "Present" || r.status === "Late").length;
  const rate = Math.round((attended / total) * 100);
  return { total, attended, rate };
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.classList.remove("show");
  }, 2800);
}

/* =========================================
   NAVIGATION
   ========================================= */

function showView(name) {
  if (isAdminUser(currentLecturer)) {
    data = loadGlobalAdminView(currentLecturer);
  }

  document.querySelectorAll(".view").forEach(view => {
    view.classList.toggle("active", view.id === `view-${name}`);
  });

  document.querySelectorAll(".nav-link[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === name);
  });

  const adminMode = isAdminUser(currentLecturer);
  const pageNames = {
    dashboard: adminMode ? "Institutional Oversight Dashboard" : "Dashboard",
    students: adminMode ? "All Institutional Students" : "Students",
    classes: adminMode ? "All Lecturers' Classes & Units" : "My Classes & Units",
    attendance: "Take attendance",
    reports: adminMode ? "Global Attendance Reports" : "Reports",
    settings: adminMode ? "Admin Security & Settings" : "Settings & backup"
  };

  $("pageName").textContent = pageNames[name] || name;
  $("sidebar").classList.remove("open");

  if (name === "dashboard") renderDashboard();
  if (name === "students") renderStudents();
  if (name === "classes") renderClasses();
  if (name === "reports") renderReports();
  if (name === "settings" && isAdminUser(currentLecturer)) loadAdminSecurityPanel();
}

/* =========================================
   CLASS DROPDOWN LISTS
   ========================================= */

function populateClassSelects() {
  const adminMode = isAdminUser(currentLecturer);
  const options = data.classes
    .map(item => `<option value="${escapeHTML(item.id)}">${escapeHTML(adminMode && item.displayName ? item.displayName : item.name)}</option>`)
    .join("");

  ["studentClass", "attendanceClass"].forEach(id => {
    const element = $(id);
    const previousValue = element.value;
    const placeholder = id === "studentClass" ? "Select class" : "Select a class";
    element.innerHTML = `<option value="">${placeholder}</option>${options}`;
    if (data.classes.some(item => item.id === previousValue)) {
      element.value = previousValue;
    }
  });

  ["studentClassFilter", "reportClass"].forEach(id => {
    const element = $(id);
    const previousValue = element.value;
    element.innerHTML = `<option value="">${adminMode ? "All classes (All lecturers)" : "All my classes"}</option>${options}`;
    if (data.classes.some(item => item.id === previousValue)) {
      element.value = previousValue;
    }
  });
}

/* =========================================
   DASHBOARD, LECTURER TRACKING & AT-RISK ALERTS
   ========================================= */

function renderDashboard() {
  const adminMode = isAdminUser(currentLecturer);
  const date = today();
  const todaysRecords = data.attendance.filter(record => record.date === date);

  const counts = { Present: 0, Absent: 0, Late: 0, Excused: 0 };
  todaysRecords.forEach(record => {
    if (counts[record.status] !== undefined) counts[record.status]++;
  });

  const atRiskStudents = data.students
    .map(student => ({ student, stats: getStudentAttendanceStats(student.id) }))
    .filter(item => item.stats.total > 0 && item.stats.rate < 75)
    .sort((a, b) => a.stats.rate - b.stats.rate);

  $("statStudents").textContent = data.students.length;
  $("statClasses").textContent = data.classes.length;
  $("statPresent").textContent = counts.Present + counts.Late;
  $("statAtRisk").textContent = atRiskStudents.length;
  $("presentSub").textContent = `${counts.Present} present · ${counts.Late} late`;
  $("dashboardDate").textContent = formatDate(date);

  $("legendPresent").textContent = counts.Present;
  $("legendAbsent").textContent = counts.Absent;
  $("legendLate").textContent = counts.Late;
  $("legendExcused").textContent = counts.Excused;

  const total = todaysRecords.length;
  const rate = total ? Math.round(((counts.Present + counts.Late) / total) * 100) : 0;
  $("attendanceRate").textContent = `${rate}%`;

  const denominator = total || 1;
  const presentPercentage = (counts.Present / denominator) * 100;
  const absentPercentage = (counts.Absent / denominator) * 100;
  const latePercentage = (counts.Late / denominator) * 100;

  $("attendanceDonut").style.background = `
    conic-gradient(
      #19a878 0% ${presentPercentage}%,
      #e16a70 ${presentPercentage}% ${presentPercentage + absentPercentage}%,
      #e5a13b ${presentPercentage + absentPercentage}% ${presentPercentage + absentPercentage + latePercentage}%,
      #8195b8 ${presentPercentage + absentPercentage + latePercentage}% 100%
    )
  `;

  $("dashboardEmpty").style.display = total ? "none" : "block";

  $("atRiskBadge").textContent = `${atRiskStudents.length} Flagged`;
  $("atRiskList").innerHTML = atRiskStudents.length
    ? atRiskStudents.map(({ student, stats }) => `
        <div class="risk-item">
          <div>
            <strong>${escapeHTML(student.name)}</strong>
            <small>${escapeHTML(student.admission)} · ${escapeHTML(getClassName(student.classId))}</small>
          </div>
          <span class="risk-rate">${stats.rate}% (${stats.attended}/${stats.total})</span>
        </div>
      `).join("")
    : `<div class="empty-inline">${adminMode
        ? "No students across any lecturer's classes are currently below 75%."
        : "All active students in your units meet the 75% threshold."}</div>`;

  let adminTrackerPanel = $("adminLecturerTrackerPanel");
  let adminTeachingLogPanel = $("adminTeachingLogPanel");

  if (adminMode) {
    const recentTablePanel = $("recentAttendance").closest(".panel");

    if (!adminTrackerPanel) {
      adminTrackerPanel = document.createElement("section");
      adminTrackerPanel.id = "adminLecturerTrackerPanel";
      adminTrackerPanel.className = "panel";
      adminTrackerPanel.style.marginBottom = "18px";
      recentTablePanel.parentNode.insertBefore(adminTrackerPanel, recentTablePanel);
    }

    if (!adminTeachingLogPanel) {
      adminTeachingLogPanel = document.createElement("section");
      adminTeachingLogPanel.id = "adminTeachingLogPanel";
      adminTeachingLogPanel.className = "panel";
      adminTeachingLogPanel.style.marginBottom = "18px";
      recentTablePanel.parentNode.insertBefore(adminTeachingLogPanel, recentTablePanel);
    }

    const summaries = data.lecturersSummary || [];
    adminTrackerPanel.style.display = "block";
    adminTrackerPanel.innerHTML = `
      <div class="panel-header">
        <div>
          <h3>Lecturer Performance, Teaching Audit & Credential Support (Admin Only)</h3>
          <p>Verify lecturer class sign-ins, attendance rates, or reset a lecturer's forgotten PIN</p>
        </div>
        <span class="date-chip">${summaries.length} Lecturer${summaries.length === 1 ? "" : "s"}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Lecturer</th>
              <th>Staff ID</th>
              <th>Department</th>
              <th>Units</th>
              <th>Lessons Signed In</th>
              <th>Teaching Status</th>
              <th>Attendance</th>
              <th>Account Assistance</th>
            </tr>
          </thead>
          <tbody>
            ${summaries.length
              ? summaries.map(l => {
                  let statusPill = `<span class="rate-pill rate-neutral">No Classes Yet</span>`;
                  if (l.signedInToday) {
                    statusPill = `<span class="rate-pill rate-good">✓ Teaching Today</span>`;
                  } else if (l.lessonsSignedIn > 0) {
                    statusPill = `<span class="rate-pill rate-good">✓ Active (${l.lessonsSignedIn})</span>`;
                  } else if (l.classCount > 0) {
                    statusPill = `<span class="rate-pill rate-low">Pending Sign-In</span>`;
                  }

                  const assistBtn = l.isAdmin
                    ? `<small style="color:#8c98aa;">Admin Account</small>`
                    : `<button type="button" class="action-btn" data-reset-lec-pin="${escapeHTML(l.staffId)}">🔑 Reset PIN</button>`;

                  return `
                    <tr>
                      <td><strong>${escapeHTML(l.name)}</strong></td>
                      <td>${escapeHTML(l.staffId)}</td>
                      <td>${escapeHTML(l.department)}</td>
                      <td>${l.classCount}</td>
                      <td><strong>${l.lessonsSignedIn}</strong></td>
                      <td>${statusPill}</td>
                      <td>${l.attendanceRate === null
                        ? `<span class="rate-pill rate-neutral">No sessions</span>`
                        : `<span class="rate-pill ${l.attendanceRate >= 75 ? "rate-good" : "rate-low"}">${l.attendanceRate}%</span>`
                      }</td>
                      <td>${assistBtn}</td>
                    </tr>
                  `;
                }).join("")
              : `<tr><td colspan="8" class="table-empty">No lecturers registered yet.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    `;

    adminTrackerPanel.querySelectorAll("[data-reset-lec-pin]").forEach(btn => {
      btn.addEventListener("click", () => adminResetLecturerPin(btn.dataset.resetLecPin));
    });

    const sortedLogs = [...(data.teachingLogs || [])]
      .sort((a, b) => (b.timestamp || b.date).localeCompare(a.timestamp || a.date))
      .slice(0, 12);

    adminTeachingLogPanel.style.display = "block";
    adminTeachingLogPanel.innerHTML = `
      <div class="panel-header">
        <div>
          <h3>Lecturer Class Sign-In Log (Live Teaching Audit)</h3>
          <p>Chronological record of lecturers entering class and signing in to teach specific units</p>
        </div>
        <span class="date-chip">${(data.teachingLogs || []).length} Total Sign-Ins</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date & Time</th>
              <th>Lecturer</th>
              <th>Unit / Class Taught</th>
              <th>Lesson Topic / Venue</th>
              <th>Verification</th>
            </tr>
          </thead>
          <tbody>
            ${sortedLogs.length
              ? sortedLogs.map(log => `
                  <tr>
                    <td>${formatDate(log.date)} · <strong>${escapeHTML(log.time || "")}</strong></td>
                    <td><strong>${escapeHTML(log._ownerName || log._ownerStaffId)}</strong> <small style="color:#6c7a93">(${escapeHTML(log._ownerStaffId)})</small></td>
                    <td>${escapeHTML(log.className)}${log.classCode ? ` (${escapeHTML(log.classCode)})` : ""}</td>
                    <td>${escapeHTML(log.topic || "Lecture Session")}${log.venue ? ` · ${escapeHTML(log.venue)}` : ""}</td>
                    <td><span class="status-pill status-Present">${escapeHTML(log.status || "Signed In · Teaching")}</span></td>
                  </tr>
                `).join("")
              : `<tr><td colspan="5" class="table-empty">No lecturer class sign-ins recorded yet.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    `;
  } else {
    if (adminTrackerPanel) adminTrackerPanel.style.display = "none";
    if (adminTeachingLogPanel) adminTeachingLogPanel.style.display = "none";
  }

  const recent = [...data.attendance]
    .sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt))
    .slice(0, 8);

  $("recentAttendance").innerHTML = recent.length
    ? recent.map(record => {
        const student = data.students.find(item => item.id === record.studentId);
        return `
          <tr>
            <td>${formatDate(record.date)}</td>
            <td>${escapeHTML(getStudentName(record.studentId))}</td>
            <td>${escapeHTML(student?.admission || "—")}</td>
            <td>${escapeHTML(getClassName(record.classId))}</td>
            <td><span class="status-pill status-${record.status}">${record.status}</span></td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="5" class="table-empty">No attendance records yet.</td></tr>`;
}

/* =========================================
   STUDENT MANAGEMENT
   ========================================= */

function renderStudents() {
  populateClassSelects();

  const query = $("studentSearch").value.trim().toLowerCase();
  const classFilter = $("studentClassFilter").value;

  const students = data.students
    .filter(student => {
      const matchesClass = !classFilter || student.classId === classFilter;
      const matchesSearch = !query || `${student.name} ${student.admission} ${student._ownerName || ""}`.toLowerCase().includes(query);
      return matchesClass && matchesSearch;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  $("studentCount").textContent = `${students.length} student${students.length === 1 ? "" : "s"}`;

  $("studentsTable").innerHTML = students.length
    ? students.map(student => {
        const initials = student.name.split(/\s+/).map(p => p[0]).slice(0, 2).join("").toUpperCase();
        const stats = getStudentAttendanceStats(student.id);
        let rateHTML = `<span class="rate-pill rate-neutral">No sessions</span>`;
        if (stats.total > 0) {
          const cls = stats.rate >= 75 ? "rate-good" : "rate-low";
          rateHTML = `<span class="rate-pill ${cls}">${stats.rate}% (${stats.attended}/${stats.total})</span>`;
        }

        return `
          <tr>
            <td>
              <div class="student-name-cell">
                <span class="mini-avatar">${escapeHTML(initials)}</span>
                <strong>${escapeHTML(student.name)}</strong>
              </div>
            </td>
            <td>${escapeHTML(student.admission)}</td>
            <td>${escapeHTML(getClassName(student.classId))}</td>
            <td>${escapeHTML(student.phone || "—")}</td>
            <td>${rateHTML}</td>
            <td>
              <button class="action-btn" data-edit-student="${escapeHTML(student.id)}">Edit</button>
              <button class="action-btn delete" data-delete-student="${escapeHTML(student.id)}">Delete</button>
            </td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="6" class="table-empty">${data.students.length ? "No students match your search." : "No students registered yet."}</td></tr>`;
}

function openStudent(id = "") {
  if (!data.classes.length) {
    alert("Create a class/unit first before adding students.");
    return;
  }
  $("studentForm").reset();
  $("studentId").value = id;
  populateClassSelects();

  const student = data.students.find(item => item.id === id);
  $("studentDialogTitle").textContent = student ? "Edit student" : "Add student";

  if (student) {
    $("studentName").value = student.name;
    $("studentAdmission").value = student.admission;
    $("studentClass").value = student.classId;
    $("studentPhone").value = student.phone || "";
    $("studentEmail").value = student.email || "";
  }

  $("studentDialog").showModal();
}

async function saveStudent(event) {
  event.preventDefault();
  const id = $("studentId").value;
  const name = $("studentName").value.trim();
  const admission = $("studentAdmission").value.trim();
  const classId = $("studentClass").value;
  const phone = $("studentPhone").value.trim();
  const email = $("studentEmail").value.trim().toLowerCase();

  if (!name || !admission || !classId || !email) {
    toast("Please complete all required fields.");
    return;
  }

  const duplicate = data.students.find(
    student => student.classId === classId && normalizeAdmissionNumber(student.admission) === normalizeAdmissionNumber(admission) && student.id !== id
  );
  if (duplicate) {
    alert("That admission number is already registered in this unit.");
    return;
  }

  const targetClass = data.classes.find(c => c.id === classId);
  const ownerStaffId = targetClass?._ownerStaffId || currentLecturer?.staffId || "admin";
  const student = id
    ? data.students.find(item => item.id === id)
    : { id: makeId(), createdDate: today() };

  if (!student) {
    toast("Could not find the student you are trying to update.");
    return;
  }

  const updatedStudent = {
    ...student, name, admission: admission.trim(), classId, phone, email,
    _ownerStaffId: ownerStaffId
  };
  const submitButton = $("studentForm").querySelector('button[type="submit"]');
  if (submitButton) { submitButton.disabled = true; submitButton.textContent = "Saving to cloud..."; }

  try {
    const cloudStudent = await saveStudentToCloud(updatedStudent);
    const index = data.students.findIndex(item => item.id === updatedStudent.id);
    if (index >= 0) data.students[index] = cloudStudent;
    else data.students.push(cloudStudent);

    saveData();
    $("studentDialog").close();
    renderStudents();
    renderDashboard();
    toast(id ? "Student updated and synced to Supabase." : "Student registered and synced to Supabase.");
  } catch (error) {
    console.error("Supabase student save failed:", error);
    toast("Student was not saved to the cloud: " + (error.message || "Check Supabase RLS policies."));
  } finally {
    if (submitButton) { submitButton.disabled = false; submitButton.textContent = "Save Student"; }
  }
}

async function handleStudentActions(event) {
  const editButton = event.target.closest("[data-edit-student]");
  const deleteButton = event.target.closest("[data-delete-student]");

  if (editButton) openStudent(editButton.dataset.editStudent);

  if (deleteButton) {
    const id = deleteButton.dataset.deleteStudent;
    const student = data.students.find(item => item.id === id);
    if (!confirm(`Delete ${student?.name || "this student"}? Their attendance history will also be deleted.`)) return;

    try {
      const { error: attendanceError } = await supabaseClient
        .from("attendance").delete().eq("student_id", id);
      if (attendanceError) throw attendanceError;
      const { error: studentError } = await supabaseClient
        .from("students").delete().eq("id", id);
      if (studentError) throw studentError;

      data.students = data.students.filter(item => item.id !== id);
      data.attendance = data.attendance.filter(record => record.studentId !== id);
      saveData();
      renderStudents();
      renderDashboard();
      renderReports();
      toast("Student and related cloud attendance records deleted.");
    } catch (error) {
      console.error("Supabase student deletion failed:", error);
      toast("Could not delete student from the cloud: " + (error.message || "Check Supabase RLS policies."));
    }
  }
}

/* =========================================
   CLASS MANAGEMENT (UNLIMITED UNITS) + SIGN IN TO TEACH + DAY 1 QR
   ========================================= */

function renderClasses() {
  populateClassSelects();
  const adminMode = isAdminUser(currentLecturer);
  const todayStr = today();

  $("classGrid").innerHTML = data.classes.length
    ? data.classes
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(classItem => {
          const count = data.students.filter(student => student.classId === classItem.id).length;
          const classLogs = (data.teachingLogs || []).filter(l => l.classId === classItem.id);
          const todaysLogs = classLogs.filter(log => log.date === todayStr)
            .sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
          const activeLesson = todaysLogs.find(log => log.status === "Signed In · Teaching");
          const latestEndedLesson = [...todaysLogs].reverse().find(log => log.status !== "Signed In · Teaching");
          const signedInToday = Boolean(activeLesson);

          const ownerBadge = adminMode && classItem._ownerName
            ? `<div style="font-size:11px;color:#2f6fed;font-weight:600;margin-top:4px;">Lecturer: ${escapeHTML(classItem._ownerName)}</div>`
            : "";

          const teachingStatusBadge = activeLesson
            ? `<div style="font-size:11px;color:#11835c;font-weight:600;margin-top:4px;">✓ Signed in to teach today · ${classLogs.length} total lessons</div>`
            : latestEndedLesson
              ? `<div style="font-size:11px;color:#6c7a93;font-weight:600;margin-top:4px;">Class ended at ${escapeHTML(latestEndedLesson.signOutTime || latestEndedLesson.endTime || "—")} · Lessons taught: ${classLogs.length}</div>`
              : `<div style="font-size:11px;color:#6c7a93;margin-top:4px;">Lessons taught: ${classLogs.length}</div>`;

          return `
            <article class="class-card">
              <div class="class-card-top">
                <span class="class-symbol">▤</span>
                <div class="class-actions" style="flex-wrap:wrap;justify-content:flex-end;">
                  ${signedInToday
                    ? `<span class="action-btn" style="background:#e9f8f2;color:#11835c;border-color:#bfe8d8;font-weight:600;">✓ Signed In</span><button class="action-btn delete" data-end-teach-class="${escapeHTML(classItem.id)}">Sign Out</button>`
                    : `<button class="action-btn" style="background:#e9f8f2;color:#11835c;border-color:#bfe8d8;font-weight:600;" data-teach-class="${escapeHTML(classItem.id)}">✓ Sign In to Teach</button>`}
                  <button class="action-btn enroll" data-enroll-class="${escapeHTML(classItem.id)}">⊞ Student Registration QR</button>
                  <button class="action-btn" data-edit-class="${escapeHTML(classItem.id)}">Edit</button>
                  <button class="action-btn delete" data-delete-class="${escapeHTML(classItem.id)}">Delete</button>
                </div>
              </div>
              <h3>${escapeHTML(classItem.name)}</h3>
              <p>${escapeHTML(classItem.code || "No unit code")}</p>
              ${ownerBadge}
              ${teachingStatusBadge}
              <div class="class-meta">
                <span>Enrolled students</span>
                <strong>${count}</strong>
              </div>
            </article>
          `;
        }).join("")
    : `<div class="panel empty-state" style="grid-column:1/-1"><div class="empty-symbol">▤</div><h3>No classes created yet</h3><p>Add as many classes or units as needed, sign in when teaching, and share each unit's Day 1 Enroll QR.</p></div>`;
}


async function openEnrollModal(classId) {
  const classItem = data.classes.find(item => item.id === classId);
  if (!classItem) return;
  $("selfEnrollForm").reset();
  $("enrollTargetClassId").value = classId;
  $("enrollModalClassName").textContent = classItem.name + " — Student Registration";
  $("selfEnrollFeedback").textContent = "Preparing secure student registration QR...";
  $("selfEnrollFeedback").className = "kiosk-feedback";
  try {
    const cloudClass = await ensureCloudClass(classItem);
    const baseUrl = window.location.href.split("?")[0];
    const enrollUrl = baseUrl + "student.html?mode=register&token=" + encodeURIComponent(cloudClass.enrollment_token);
    $("enrollShareLink").value = enrollUrl;
    const qrBox = $("enrollQrBox"); qrBox.innerHTML = "";
    if (typeof QRCode !== "undefined") new QRCode(qrBox, {
      text: enrollUrl, width: 115, height: 115, colorDark: "#15233d", colorLight: "#ffffff"
    });
    $("selfEnrollFeedback").textContent = "Students scan this code to open the separate Student Portal, create an account and register.";
    $("selfEnrollFeedback").className = "kiosk-feedback ok";
    $("enrollQrDialog").showModal();
  } catch (error) {
    console.error("Could not prepare student registration QR:", error);
    $("selfEnrollFeedback").textContent = error.message || "Could not create registration QR. Check Supabase.";
    $("selfEnrollFeedback").className = "kiosk-feedback err";
    $("enrollQrDialog").showModal();
  }
}

async function handleSelfEnrollSubmit(event) {
  event.preventDefault();
  const classId = $("enrollTargetClassId").value;
  const name = $("selfRegName").value.trim();
  const admission = $("selfRegAdm").value.trim();
  const phone = $("selfRegPhone").value.trim();
  const fb = $("selfEnrollFeedback");

  if (!name || !admission || !classId) return;

  const duplicate = data.students.find(
    s => s.classId === classId && s.admission.toLowerCase() === admission.toLowerCase()
  );
  if (duplicate) {
    fb.textContent = `Admission number ${admission} is already enrolled in this unit.`;
    fb.className = "kiosk-feedback err";
    return;
  }

  const targetClass = data.classes.find(c => c.id === classId);
  const student = {
    id: makeId(), name, admission, classId, phone,
    createdDate: today(),
    _ownerStaffId: targetClass?._ownerStaffId || currentLecturer?.staffId || "admin"
  };

  fb.textContent = "Saving student to Supabase...";
  fb.className = "kiosk-feedback";
  try {
    const cloudStudent = await saveStudentToCloud(student);
    data.students.push(cloudStudent);
    saveData();
    renderClasses();
    renderStudents();
    renderDashboard();
    fb.textContent = `✓ ${name} (${admission}) enrolled and synced to Supabase!`;
    fb.className = "kiosk-feedback ok";
    $("selfRegName").value = "";
    $("selfRegAdm").value = "";
    $("selfRegPhone").value = "";
    toast(`${name} self-registered!`);
  } catch (error) {
    console.error("Supabase self-enrollment failed:", error);
    fb.textContent = "Could not save registration: " + (error.message || "Check Supabase RLS policies.");
    fb.className = "kiosk-feedback err";
  }
}

/* SUPABASE CLASS, STUDENT & ATTENDANCE SYNC */
async function ensureCloudClass(classItem) {
  if (!currentLecturer?.id || !classItem?.id) throw new Error("Please sign in to your lecturer account first.");
  const { data: cloudClass, error } = await supabaseClient.from("classes").upsert({
    id: classItem.id, owner_id: classItem._ownerId || currentLecturer.id, name: classItem.name,
    code: classItem.code || "", department: classItem.department || currentLecturer.department || "", enrollment_enabled: classItem.enrollmentEnabled !== false
  }, { onConflict: "id" }).select("id, enrollment_token").single();
  if (error) throw error;
  return cloudClass;
}
/* Save a student directly to Supabase.
   The class is ensured in the cloud first so the student foreign key is valid. */
async function saveStudentToCloud(student) {
  const classItem = data.classes.find(item => item.id === student.classId);
  if (!classItem) throw new Error("The selected class could not be found.");
  const cloudClass = await ensureCloudClass(classItem);
  const payload = {
    id: student.id,
    class_id: cloudClass.id,
    full_name: student.name,
    admission_number: student.admission,
    phone: student.phone || "",
    email: student.email ? student.email.trim().toLowerCase() : null
  };
  const { data: savedStudent, error } = await supabaseClient
    .from("students")
    .upsert(payload, { onConflict: "id" })
    .select("id, class_id, full_name, admission_number, phone, email, created_at")
    .single();
  if (error) throw error;
  return {
    id: savedStudent.id,
    classId: savedStudent.class_id,
    name: savedStudent.full_name,
    admission: savedStudent.admission_number,
    phone: savedStudent.phone || "",
    email: savedStudent.email || "",
    createdDate: savedStudent.created_at ? savedStudent.created_at.slice(0, 10) : today(),
    _cloudRecord: true,
    _ownerStaffId: currentLecturer.staffId
  };
}

/* Save an attendance record directly to Supabase. */
async function saveAttendanceToCloud(record) {
  const classItem = data.classes.find(item => item.id === record.classId);
  const student = data.students.find(item => item.id === record.studentId);
  if (!classItem || !student) throw new Error("Class or student is missing for this attendance record.");
  const cloudClass = await ensureCloudClass(classItem);
  await saveStudentToCloud({ ...student, classId: cloudClass.id });
  const payload = {
    id: record.id,
    class_id: cloudClass.id,
    student_id: student.id,
    attendance_date: record.date,
    status: record.status,
    notes: record.remarks || ""
  };
  const { data: savedRecord, error } = await supabaseClient
    .from("attendance")
    .upsert(payload, { onConflict: "id" })
    .select("id, class_id, student_id, attendance_date, status, notes, created_at")
    .single();
  if (error) throw error;
  return {
    id: savedRecord.id,
    classId: savedRecord.class_id,
    studentId: savedRecord.student_id,
    date: savedRecord.attendance_date,
    status: savedRecord.status,
    remarks: savedRecord.notes || "",
    createdAt: savedRecord.created_at,
    _cloudRecord: true,
    _ownerStaffId: currentLecturer.staffId
  };
}

/* Persist a batch of attendance changes before updating the local cache. */
async function saveAttendanceBatchToCloud(records) {
  const saved = [];
  for (const record of records) saved.push(await saveAttendanceToCloud(record));
  return saved;
}

function setCloudStatus(active, detail = "") {
  const note = document.querySelector(".storage-note");
  if (!note) return;
  const heading = note.querySelector("strong");
  const description = note.querySelector("small");
  const dot = note.querySelector(".status-dot");
  if (heading) heading.textContent = active ? "Cloud sync active" : "Cloud sync unavailable";
  if (description) description.textContent = active
    ? "Synced with Supabase"
    : (detail || "Could not reach Supabase");
  if (dot) {
    dot.style.backgroundColor = active ? "#16a34a" : "#dc2626";
    dot.style.boxShadow = active ? "0 0 0 3px rgba(22,163,74,.12)" : "0 0 0 3px rgba(220,38,38,.12)";
  }
}

async function refreshCloudClassData(showErrors = false) {
  if (!currentLecturer?.id) {
    setCloudStatus(false, "Sign in to connect");
    return;
  }

  try {
    // Classes are the starting point. Fetch them by the authenticated lecturer's
    // Supabase user ID so a fresh browser can rebuild its workspace from cloud data.
    const adminMode = isAdminUser(currentLecturer);
    let classQuery = supabaseClient.from("classes")
      .select("id, owner_id, name, code, department, enrollment_enabled, enrollment_token, created_at");
    if (!adminMode) classQuery = classQuery.eq("owner_id", currentLecturer.id);
    const { data: cloudClasses, error: classError } = await classQuery;
    if (classError) throw classError;

    let ownerAccounts = [];
    if (adminMode) {
      const { data: accounts, error: accountsError } = await supabaseClient.rpc("admin_list_accounts");
      if (accountsError) throw accountsError;
      ownerAccounts = accounts || [];
    }
    const ownerById = new Map(ownerAccounts.map(account => [account.user_id, account]));
    const ownerByClassId = new Map((cloudClasses || []).map(cls => [cls.id, cls.owner_id]));
    const remoteClasses = (cloudClasses || []).map(cls => {
      const owner = ownerById.get(cls.owner_id);
      const ownerLabel = owner?.full_name || owner?.email || "Lecturer";
      return {
        id: cls.id,
        name: cls.name,
        code: cls.code || "",
        department: cls.department || "",
        enrollmentEnabled: cls.enrollment_enabled !== false,
        enrollmentToken: cls.enrollment_token || "",
        createdDate: cls.created_at ? cls.created_at.slice(0, 10) : today(),
        _cloudRecord: true,
        _ownerId: cls.owner_id,
        _ownerStaffId: adminMode ? cls.owner_id : currentLecturer.staffId,
        _ownerName: adminMode ? ownerLabel : "",
        displayName: adminMode ? `${cls.name} — [${ownerLabel}]` : cls.name
      };
    });
    const classIds = remoteClasses.map(cls => cls.id);
    const previousClassIds = new Set(adminMode
      ? data.classes.map(cls => cls.id)
      : data.classes.filter(cls => (cls._ownerStaffId || currentLecturer.staffId) === currentLecturer.staffId).map(cls => cls.id));

    // Admin sees the institution-wide cloud list; lecturers see only their own.
    data.classes = adminMode ? remoteClasses : data.classes.filter(cls =>
      (cls._ownerStaffId || currentLecturer.staffId) !== currentLecturer.staffId
    ).concat(remoteClasses);

    if (classIds.length) {
      const { data: cloudStudents, error: studentError } = await supabaseClient
        .from("students")
        .select("id, class_id, full_name, admission_number, phone, email, created_at")
        .in("class_id", classIds);
      if (studentError) throw studentError;

      const remoteStudents = (cloudStudents || []).map(student => ({
        id: student.id,
        classId: student.class_id,
        name: student.full_name,
        admission: student.admission_number,
        phone: student.phone || "",
        email: student.email || "",
        createdDate: student.created_at ? student.created_at.slice(0, 10) : today(),
        _cloudRecord: true,
        _ownerStaffId: adminMode ? ownerByClassId.get(student.class_id) : currentLecturer.staffId,
        _ownerName: adminMode ? (ownerById.get(ownerByClassId.get(student.class_id))?.email || "Lecturer") : ""
      }));

      const cloudByAdmission = new Map(remoteStudents.map(student => [
        student.classId + "|" + String(student.admission || "").toLowerCase(), student
      ]));
      const replacedStudentIds = new Map();
      const retainedStudents = adminMode ? [] : data.students.filter(student => {
        if (!classIds.includes(student.classId)) return true;
        const match = cloudByAdmission.get(student.classId + "|" + String(student.admission || "").toLowerCase());
        if (match && student.id !== match.id) replacedStudentIds.set(student.id, match.id);
        return !student._cloudRecord && !match;
      });
      data.students = retainedStudents.concat(remoteStudents);

      if (replacedStudentIds.size) {
        data.attendance.forEach(record => {
          if (replacedStudentIds.has(record.studentId)) record.studentId = replacedStudentIds.get(record.studentId);
        });
      }

      const { data: cloudAttendance, error: attendanceError } = await supabaseClient
        .from("attendance")
        .select("id, class_id, student_id, attendance_date, status, notes, created_at")
        .in("class_id", classIds);
      if (attendanceError) throw attendanceError;

      const remoteAttendance = (cloudAttendance || []).map(record => ({
        id: record.id,
        classId: record.class_id,
        studentId: record.student_id,
        date: record.attendance_date,
        status: record.status,
        remarks: record.notes || "",
        createdAt: record.created_at,
        _cloudRecord: true,
        _ownerStaffId: adminMode ? ownerByClassId.get(record.class_id) : currentLecturer.staffId,
        _ownerName: adminMode ? (ownerById.get(ownerByClassId.get(record.class_id))?.email || "Lecturer") : ""
      }));
      const remoteAttendanceIds = new Set(remoteAttendance.map(record => record.id));
      data.attendance = adminMode ? remoteAttendance : data.attendance.filter(record =>
        !classIds.includes(record.classId) || (!record._cloudRecord && !remoteAttendanceIds.has(record.id))
      ).concat(remoteAttendance);
    } else {
      // A lecturer with no cloud classes should not keep showing stale cloud-linked
      // students or attendance from a class that no longer belongs to the account.
      data.students = data.students.filter(student => !previousClassIds.has(student.classId));
      data.attendance = data.attendance.filter(record => !previousClassIds.has(record.classId));
    }

    const { data: cloudTeachingLogs, error: teachingLogError } = await supabaseClient
      .from("lecturer_sign_ins")
      .select("id, lecturer_id, lecturer_name, staff_id, class_id, class_name, class_code, topic, venue, signed_in_at, signed_out_at, status")
      .order("signed_in_at", { ascending: false })
      .limit(500);
    if (teachingLogError) throw teachingLogError;
    data.teachingLogs = (cloudTeachingLogs || []).map(log => {
      const signedAt = new Date(log.signed_in_at);
      return {
        id: log.id,
        classId: log.class_id,
        className: log.class_name,
        classCode: log.class_code || "",
        date: log.signed_in_at.slice(0, 10),
        time: signedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        topic: log.topic || "",
        venue: log.venue || "",
        status: log.status || "Signed In · Teaching",
        timestamp: log.signed_in_at,
        signOutTime: log.signed_out_at ? new Date(log.signed_out_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
        _ownerStaffId: log.staff_id || log.lecturer_id,
        _ownerName: log.lecturer_name || "Lecturer",
        _cloudRecord: true
      };
    });

    saveData();
    setCloudStatus(true, "Synced with Supabase");
    populateClassSelects();
    if ($("view-students").classList.contains("active") &&
        document.activeElement !== $("studentSearch")) renderStudents();
    if ($("view-classes").classList.contains("active")) renderClasses();
    if ($("view-dashboard").classList.contains("active")) renderDashboard();
    if ($("view-attendance").classList.contains("active") &&
        !$("registerArea").contains(document.activeElement) &&
        $("attendanceClass").value) renderRegister();
  } catch (error) {
    console.error("ClassTrack cloud refresh failed:", error);
    setCloudStatus(false, error.message || "Supabase request failed");
    if (showErrors) toast("Cloud refresh failed: " + (error.message || "Check Supabase RLS policies and table columns."));
  }
}
function startCloudRefresh() {
  clearInterval(cloudRefreshInterval);
  refreshCloudClassData();
  cloudRefreshInterval = setInterval(() => {
    if (document.visibilityState === "visible") refreshCloudClassData();
  }, 10000);
}
async function closeCloudAttendanceSession(sessionId) {
  if (!sessionId) return;
  const { error } = await supabaseClient.from("attendance_sessions").update({ is_active: false }).eq("id", sessionId);
  if (error) console.error("Could not close cloud attendance session:", error);
}
async function endTeachingClass(classId) {
  const cls = data.classes.find(item => item.id === classId);
  if (!cls) return;
  const log = (data.teachingLogs || []).find(item =>
    item.classId === classId && item.date === today() && item.status === "Signed In · Teaching"
  );
  if (!log) { toast("You are not currently signed in to teach this class."); return; }
  if (!confirm("End this lecture and sign out of teaching for " + cls.name + "?")) return;

  const signedOutAt = new Date();
  log.status = "Signed Out · Teaching Ended";
  log.signOutTime = signedOutAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  log.endTime = log.signOutTime;
  log.endedAt = signedOutAt.toISOString();

  if (log._cloudRecord && log.id) {
    const { error } = await supabaseClient.from("lecturer_sign_ins")
      .update({ signed_out_at: signedOutAt.toISOString(), status: log.status })
      .eq("id", log.id)
      .eq("lecturer_id", currentLecturer.id);
    if (error) {
      console.error("Could not close lecturer sign-in audit record:", error);
      toast("Lecture ended locally, but the audit sign-out could not sync: " + error.message);
    }
  }
  if (activeQrSession?.classId === classId) await stopQrSession(true);
  saveData();
  renderClasses();
  renderDashboard();
  toast("Lecture ended at " + log.signOutTime + ". You have signed out of " + cls.name + ".");
}

function openClass(id = "") {
  $("classForm").reset();
  $("classId").value = id;

  const classItem = data.classes.find(item => item.id === id);
  $("classDialogTitle").textContent = classItem ? "Edit class" : "Add class";

  if (classItem) {
    $("className").value = classItem.name || "";
    $("classCode").value = classItem.code || "";
  }

  $("classDialog").showModal();
}

async function saveClass(event) {
  event.preventDefault();
  const id = $("classId").value;
  const name = $("className").value.trim();
  const code = $("classCode").value.trim();
  if (!name) return;

  const duplicate = data.classes.find(
    classItem => classItem.name.toLowerCase() === name.toLowerCase() && classItem.id !== id
  );
  if (duplicate) {
    alert("A class with that name already exists.");
    return;
  }
  if (!currentLecturer?.id) {
    toast("Please sign in again before saving a class.");
    return;
  }

  const saveButton = $("classForm").querySelector('button[type="submit"]');
  const originalButtonText = saveButton?.textContent || "Save class";
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Saving to cloud...";
  }

  try {
    let savedClass;
    if (id) {
      const existing = data.classes.find(item => item.id === id);
      if (!existing) throw new Error("The class you are editing could not be found.");
      let classUpdate = supabaseClient.from("classes")
        .update({ name, code, department: currentLecturer.department || existing.department || "" })
        .eq("id", id);
      if (!isAdminUser(currentLecturer)) classUpdate = classUpdate.eq("owner_id", currentLecturer.id);
      const { data: updated, error } = await classUpdate
        .select("id, owner_id, name, code, department, enrollment_enabled, enrollment_token, created_at")
        .single();
      if (error) throw error;
      savedClass = updated;
    } else {
      const { data: inserted, error } = await supabaseClient
        .from("classes")
        .insert({
          id: makeId(),
          owner_id: currentLecturer.id,
          name,
          code,
          department: currentLecturer.department || "",
          enrollment_enabled: true
        })
        .select("id, owner_id, name, code, department, enrollment_enabled, enrollment_token, created_at")
        .single();
      if (error) throw error;
      savedClass = inserted;
    }

    const priorClass = data.classes.find(item => item.id === savedClass.id);
    const mappedClass = {
      id: savedClass.id,
      name: savedClass.name,
      code: savedClass.code || "",
      department: savedClass.department || "",
      enrollmentEnabled: savedClass.enrollment_enabled !== false,
      enrollmentToken: savedClass.enrollment_token || "",
      createdDate: savedClass.created_at ? savedClass.created_at.slice(0, 10) : today(),
      _cloudRecord: true,
      _ownerId: savedClass.owner_id,
      _ownerStaffId: isAdminUser(currentLecturer) ? savedClass.owner_id : currentLecturer.staffId,
      _ownerName: priorClass?._ownerName || "",
      displayName: isAdminUser(currentLecturer) ? `${savedClass.name} — [${priorClass?._ownerName || "Lecturer"}]` : savedClass.name
    };
    const existingIndex = data.classes.findIndex(item => item.id === mappedClass.id);
    if (existingIndex >= 0) data.classes[existingIndex] = mappedClass;
    else data.classes.push(mappedClass);

    saveData();
    setCloudStatus(true, "Synced with Supabase");
    $("classDialog").close();
    populateClassSelects();
    renderClasses();
    renderStudents();
    renderDashboard();
    toast(id ? "Class updated and synced to Supabase." : "Class created and saved to Supabase.");
  } catch (error) {
    console.error("Supabase class save failed:", error);
    const message = error.message || error.details || "Unknown Supabase error";
    setCloudStatus(false, message);
    toast("Class was not saved to Supabase: " + message);
    alert("Could not save this class to Supabase.\n\n" + message +
      (error.code ? "\nError code: " + error.code : "") +
      "\n\nCheck the classes table columns and its INSERT/UPDATE RLS policies.");
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = originalButtonText;
    }
  }
}
async function handleClassActions(event) {
  const teachButton = event.target.closest("[data-teach-class]");
  const enrollButton = event.target.closest("[data-enroll-class]");
  const editButton = event.target.closest("[data-edit-class]");
  const deleteButton = event.target.closest("[data-delete-class]");

  if (teachButton) await promptLecturerClassSignIn(teachButton.dataset.teachClass);
  const endTeachButton = event.target.closest("[data-end-teach-class]");
  if (endTeachButton) endTeachingClass(endTeachButton.dataset.endTeachClass);
  if (enrollButton) openEnrollModal(enrollButton.dataset.enrollClass);
  if (editButton) openClass(editButton.dataset.editClass);

  if (deleteButton) {
    const id = deleteButton.dataset.deleteClass;
    if (data.students.some(student => student.classId === id)) {
      alert("This class has students assigned to it. Reassign or delete those students before deleting the class.");
      return;
    }
    if (confirm("Delete this class, its teaching logs, and its attendance records?")) {
      try {
        let deletion = supabaseClient.from("classes").delete().eq("id", id);
        if (!isAdminUser(currentLecturer)) deletion = deletion.eq("owner_id", currentLecturer.id);
        const { error } = await deletion;
        if (error) throw error;
        data.classes = data.classes.filter(item => item.id !== id);
        data.attendance = data.attendance.filter(record => record.classId !== id);
        data.students = data.students.filter(student => student.classId !== id);
        data.teachingLogs = (data.teachingLogs || []).filter(log => log.classId !== id);
        saveData();
        renderClasses();
        renderDashboard();
        toast("Class deleted from Supabase.");
      } catch (error) {
        console.error("Class deletion failed:", error);
        toast("Could not delete class: " + (error.message || "Check permissions."));
      }
    }
  }
}

/* =========================================
   TIMED QR CODE & LESSON STUDENT CHECK-IN
   ========================================= */


async function startQrSession() {
  const classId = $("attendanceClass").value, date = $("attendanceDate").value;
  const minutes = parseInt($("sessionDuration").value, 10) || 5;
  if (!classId || !date) { toast("Please select a Class and Date below first."); return; }
  const targetClass = data.classes.find(item => item.id === classId);
  if (!targetClass) return;
  const button = $("startQrSessionBtn");
  button.disabled = true; button.textContent = "Opening secure session...";
  try {
    const cloudClass = await ensureCloudClass(targetClass);
    await refreshCloudClassData();
    if (!data.students.some(student => student.classId === classId)) {
      toast("No students are registered yet. Share the Student Registration QR first."); return;
    }
    await recordLecturerTeachingSignIn(classId, "Live QR Attendance Session", "", true);
    renderRegister();
    // Finalize any earlier live session before opening a replacement QR.
    const { data: staleSessions, error: staleSessionReadError } = await supabaseClient
      .from("attendance_sessions")
      .select("id")
      .eq("class_id", cloudClass.id)
      .eq("is_active", true)
      .eq("is_finalized", false);
    if (staleSessionReadError) throw staleSessionReadError;
    for (const staleSession of (staleSessions || [])) {
      const { error: staleFinalizeError } = await supabaseClient.rpc("finalize_attendance_session", {
        p_session_id: staleSession.id
      });
      if (staleFinalizeError) throw staleFinalizeError;
    }

    const expiry = Date.now() + minutes * 60 * 1000;
    const { data: cloudSession, error } = await supabaseClient.from("attendance_sessions").insert({
      class_id: cloudClass.id, created_by: currentLecturer.id, attendance_date: date,
      expires_at: new Date(expiry).toISOString(), is_active: true
    }).select("id, session_token, expires_at").single();
    if (error) throw error;
    activeQrSession = {
      cloudSessionId: cloudSession.id, token: cloudSession.session_token, classId,
      className: targetClass.name || getClassName(classId), date,
      expiresAt: new Date(cloudSession.expires_at).getTime(), ownerId: currentLecturer.staffId
    };
    const baseUrl = window.location.href.split("?")[0];
    const shareUrl = baseUrl + "student.html?mode=checkin&session=" + encodeURIComponent(cloudSession.session_token);
    $("sessionClassLabel").textContent = activeQrSession.className + " (" + formatDate(date) + ")";
    $("sessionShareLink").value = shareUrl;
    $("activeSessionBox").style.display = "flex";
    $("startQrSessionBtn").style.display = "none";
    $("stopQrSessionBtn").style.display = "inline-flex";
    const qrContainer = $("qrcodeContainer"); qrContainer.innerHTML = "";
    if (typeof QRCode !== "undefined") new QRCode(qrContainer, {
      text: shareUrl, width: 120, height: 120, colorDark: "#15233d", colorLight: "#ffffff"
    });
    clearInterval(sessionTimerInterval); updateSessionCountdown();
    sessionTimerInterval = setInterval(updateSessionCountdown, 1000);
    toast("Secure student check-in opened for " + minutes + " minutes.");
  } catch (error) {
    console.error("Could not start cloud attendance session:", error);
    toast(error.message || "Could not start attendance. Check Supabase configuration.");
  } finally {
    button.disabled = false; button.textContent = "Launch Timed Check-In";
  }
}

async function finalizeQrSessionAttendance(session, options = {}) {
  if (!session?.cloudSessionId) return 0;
  if (session.finalizing) return 0;
  session.finalizing = true;

  try {
    // Database transaction is authoritative and can run without this browser.
    const { data: result, error } = await supabaseClient.rpc("finalize_attendance_session", {
      p_session_id: session.cloudSessionId
    });
    if (error) throw error;

    await refreshCloudClassData();
    renderDashboard();
    if ($("attendanceClass")?.value === session.classId &&
        $("attendanceDate")?.value === session.date) renderRegister();
    return Number(result?.absent_count || 0);
  } catch (error) {
    console.error("Could not finalize session attendance:", error);
    throw error;
  } finally {
    session.finalizing = false;
  }
}

function updateSessionCountdown() {
  if (!activeQrSession) return;
  const remainingMs = activeQrSession.expiresAt - Date.now();
  const badge = $("sessionTimerBadge");
  const kioskTimer = $("kioskCountdown");

  if (remainingMs <= 0) {
    clearInterval(sessionTimerInterval);
    badge.textContent = "Session Expired";
    badge.className = "timer-pill expired";
    if (kioskTimer) kioskTimer.textContent = "00:00 (EXPIRED)";
    $("kioskActiveBody").style.display = "none";
    $("kioskExpiredBody").style.display = "block";
    activeQrSession.expired = true;

    const expiredSession = activeQrSession;
    (async () => {
      try {
        const absentCount = await finalizeQrSessionAttendance(expiredSession);
        await closeCloudAttendanceSession(expiredSession.cloudSessionId);
        toast(`Check-in window expired. ${absentCount} unmarked student(s) automatically marked Absent.`);
      } catch (error) {
        toast("The session expired, but attendance finalization failed: " + (error.message || "Check Supabase permissions."));
      }
    })();
    return;
  }

  const totalSec = Math.ceil(remainingMs / 1000);
  const mins = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const secs = String(totalSec % 60).padStart(2, "0");
  const formatted = `${mins}:${secs}`;

  badge.textContent = `Open · ${formatted} left`;
  badge.className = "timer-pill live";
  if (kioskTimer) kioskTimer.textContent = formatted;
}


async function stopQrSession(silent = false) {
  clearInterval(sessionTimerInterval);
  const session = activeQrSession;
  const sessionId = session?.cloudSessionId;
  if (session) {
    try {
      const absentCount = await finalizeQrSessionAttendance(session);
      if (!silent) toast(`Check-in window closed. ${absentCount} unmarked student(s) automatically marked Absent.`);
    } catch (error) {
      console.error("Attendance finalization failed while closing session:", error);
      toast("Could not finalize attendance: " + (error.message || "Check Supabase permissions."));
      return;
    }
  }
  activeQrSession = null;
  if (sessionId) {
    try { await closeCloudAttendanceSession(sessionId); } catch (error) { console.error(error); }
  }
  if ($("activeSessionBox")) $("activeSessionBox").style.display = "none";
  if ($("startQrSessionBtn")) $("startQrSessionBtn").style.display = "inline-flex";
  if ($("stopQrSessionBtn")) $("stopQrSessionBtn").style.display = "none";
  if ($("sessionTimerBadge")) {
    $("sessionTimerBadge").textContent = "No active session";
    $("sessionTimerBadge").className = "timer-pill";
  }
}

function openStudentKiosk() {
  if (!activeQrSession) return;
  $("kioskClassName").textContent = activeQrSession.className;
  $("kioskFeedback").textContent = "";
  $("kioskFeedback").className = "kiosk-feedback";
  $("kioskAdmissionInput").value = "";

  if (activeQrSession.expired || Date.now() >= activeQrSession.expiresAt) {
    $("kioskActiveBody").style.display = "none";
    $("kioskExpiredBody").style.display = "block";
  } else {
    $("kioskActiveBody").style.display = "block";
    $("kioskExpiredBody").style.display = "none";
  }
  $("studentKioskDialog").showModal();
}

async function handleStudentSelfCheckIn(event) {
  event.preventDefault();
  const feedback = $("kioskFeedback");

  if (!activeQrSession || activeQrSession.expired || Date.now() >= activeQrSession.expiresAt) {
    feedback.textContent = "Sorry, the attendance window has expired.";
    feedback.className = "kiosk-feedback err";
    return;
  }

  const admInput = $("kioskAdmissionInput").value.trim().toLowerCase();
  const student = data.students.find(
    s => s.classId === activeQrSession.classId && s.admission.toLowerCase() === admInput
  );

  if (!student) {
    feedback.textContent = "Not enrolled in this unit. Complete Day 1 registration first.";
    feedback.className = "kiosk-feedback err";
    return;
  }

  const existingIndex = data.attendance.findIndex(
    r => r.studentId === student.id && r.classId === activeQrSession.classId && r.date === activeQrSession.date
  );
  const record = {
    id: existingIndex >= 0 ? data.attendance[existingIndex].id : makeId(),
    studentId: student.id,
    classId: activeQrSession.classId,
    date: activeQrSession.date,
    status: "Present",
    remarks: "Self check-in via QR/Link",
    createdAt: new Date().toISOString(),
    _ownerStaffId: activeQrSession.ownerId
  };

  feedback.textContent = "Recording attendance in Supabase...";
  feedback.className = "kiosk-feedback";
  try {
    const cloudRecord = await saveAttendanceToCloud(record);
    if (existingIndex >= 0) data.attendance[existingIndex] = cloudRecord;
    else data.attendance.push(cloudRecord);
    saveData();
    renderRegister();
    renderDashboard();
    feedback.textContent = `✓ Checked in: ${student.name} (${student.admission})`;
    feedback.className = "kiosk-feedback ok";
    $("kioskAdmissionInput").value = "";
    toast(`${student.name} checked in via QR portal!`);
  } catch (error) {
    console.error("Supabase QR attendance save failed:", error);
    feedback.textContent = "Attendance could not be saved: " + (error.message || "Check Supabase RLS policies.");
    feedback.className = "kiosk-feedback err";
  }
}

/* =========================================
   ATTENDANCE REGISTER & BULK ACTIONS
   ========================================= */

function updateRegisterProgress() {
  const rows = [...($("registerArea")?.querySelectorAll("[data-register-row]") || [])];
  if (!rows.length) return;

  const classId = $("attendanceClass").value;
  const date = $("attendanceDate").value;
  const savedIds = new Set(
    data.attendance
      .filter(record => record.classId === classId && record.date === date)
      .map(record => record.studentId)
  );
  const selectedCount = rows.filter(row =>
    Boolean(row.querySelector(".status-option.selected"))
  ).length;
  const savedCount = rows.filter(row => savedIds.has(row.dataset.registerRow)).length;
  const unmarkedCount = rows.length - selectedCount;
  const progress = $("registerProgress");
  if (progress) {
    progress.textContent = `${savedCount} of ${rows.length} records saved · ${unmarkedCount} unmarked`;
  }
}

function renderRegister() {
  const classId = $("attendanceClass").value;
  const date = $("attendanceDate").value;
  const area = $("registerArea");

  if (!classId || !date) {
    area.innerHTML = `<div class="empty-state"><div class="empty-symbol">✓</div><h3>Select a class and date</h3><p>Choose both fields above, then load the register.</p></div>`;
    return;
  }

  const students = data.students
    .filter(student => student.classId === classId)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!students.length) {
    area.innerHTML = `<div class="empty-state"><div class="empty-symbol">♙</div><h3>No students enrolled in this unit</h3><p>Go to Classes and share the Day 1 Enroll QR code with your students first.</p></div>`;
    return;
  }

  const existingRecords = data.attendance.filter(record => record.classId === classId && record.date === date);
  const existingMap = new Map(existingRecords.map(record => [record.studentId, record]));
  const statuses = ["Present", "Absent", "Late", "Excused"];

  area.innerHTML = `
    <div class="register-heading">
      <div>
        <h3>${escapeHTML(getClassName(classId))}</h3>
        <p>${formatDate(date)} · ${students.length} enrolled students</p>
      </div>
      <div class="bulk-actions">
        <button type="button" class="btn btn-light btn-small" id="markAllPresentBtn">✓ Mark All Present</button>
        <button type="button" class="btn btn-light btn-small" id="markAllAbsentBtn">! Mark All Absent</button>
        <span class="date-chip">${existingRecords.length ? "Saved register" : "Unsaved"}</span>
      </div>
    </div>

    <div class="register-row" style="background:#fafbfd">
      <strong style="font-size:9px;color:#8c98aa">STUDENT</strong>
      <strong style="font-size:9px;color:#8c98aa">STATUS</strong>
      <strong style="font-size:9px;color:#8c98aa">REMARKS (OPTIONAL)</strong>
    </div>

    ${students.map(student => {
      const record = existingMap.get(student.id);
      const currentStatus = record?.status || "";
      const initials = student.name.split(/\\s+/).map(p => p[0]).slice(0, 2).join("").toUpperCase();

      return `
        <div class="register-row" data-register-row="${escapeHTML(student.id)}">
          <div class="register-student">
            <span class="mini-avatar">${escapeHTML(initials)}</span>
            <div>
              <strong>${escapeHTML(student.name)}</strong>
              <small>${escapeHTML(student.admission)}</small>
            </div>
          </div>

          <div class="status-options">
            ${statuses.map(status => `
              <button type="button" class="status-option ${currentStatus === status ? "selected" : ""}" data-status="${status}">
                ${status}
              </button>
            `).join("")}
          </div>

          <input class="remarks-input" data-remarks="${escapeHTML(student.id)}" maxlength="160" placeholder="Add a note..." value="${escapeHTML(record?.remarks || "")}">
        </div>
      `;
    }).join("")}

    <div class="register-footer">
      <small id="registerProgress"></small>
      <button class="btn btn-primary" id="saveRegisterBtn">Save attendance register</button>
    </div>
  `;

  area.querySelectorAll(".status-option").forEach(button => {
    button.addEventListener("click", () => {
      const row = button.closest(".register-row");
      row.querySelectorAll(".status-option").forEach(item => item.classList.remove("selected"));
      button.classList.add("selected");
      updateRegisterProgress();
    });
  });

  $("markAllPresentBtn").addEventListener("click", () => setBulkStatus("Present"));
  $("markAllAbsentBtn").addEventListener("click", () => setBulkStatus("Absent"));
  $("saveRegisterBtn").addEventListener("click", saveRegister);
  updateRegisterProgress();
}

function setBulkStatus(targetStatus) {
  $("registerArea").querySelectorAll("[data-register-row]").forEach(row => {
    row.querySelectorAll(".status-option").forEach(btn => {
      btn.classList.toggle("selected", btn.dataset.status === targetStatus);
    });
  });
  updateRegisterProgress();
  toast(`All students marked ${targetStatus}. Click Save to confirm.`);
}

async function saveRegister() {
  const classId = $("attendanceClass").value;
  const date = $("attendanceDate").value;
  if (!classId || !date) {
    toast("Select a class and date first.");
    return;
  }

  const rows = [...$("registerArea").querySelectorAll("[data-register-row]")];
  if (!rows.length) {
    toast("There are no students to record.");
    return;
  }

  const unmarkedCount = rows.filter(row =>
    !row.querySelector(".status-option.selected")
  ).length;

  const targetClass = data.classes.find(c => c.id === classId);
  const ownerStaffId = targetClass?._ownerStaffId || currentLecturer?.staffId || "admin";
  const pendingRecords = rows.map(row => {
    const studentId = row.dataset.registerRow;
    const status = row.querySelector(".status-option.selected")?.dataset.status || "Absent";
    const remarks = row.querySelector("[data-remarks]")?.value.trim() || "";
    const existing = data.attendance.find(
      record => record.studentId === studentId && record.classId === classId && record.date === date
    );
    return {
      id: existing?.id || makeId(), studentId, classId, date, status, remarks,
      createdAt: existing?.createdAt || new Date().toISOString(),
      _ownerStaffId: ownerStaffId
    };
  });

  const saveButton = $("saveRegisterBtn");
  if (saveButton) { saveButton.disabled = true; saveButton.textContent = "Saving to cloud..."; }
  try {
    const cloudRecords = await saveAttendanceBatchToCloud(pendingRecords);
    cloudRecords.forEach(cloudRecord => {
      const index = data.attendance.findIndex(record => record.id === cloudRecord.id);
      if (index >= 0) data.attendance[index] = cloudRecord;
      else data.attendance.push(cloudRecord);
    });
    saveData();
    if (unmarkedCount > 0) {
      toast(`Attendance register saved. ${unmarkedCount} unmarked student(s) automatically marked Absent.`);
    } else {
      toast("Attendance register saved and synced to Supabase.");
    }
    renderRegister();
    renderDashboard();
  } catch (error) {
    console.error("Supabase attendance save failed:", error);
    toast("Attendance was not saved to the cloud: " + (error.message || "Check Supabase RLS policies."));
  } finally {
    if (saveButton) { saveButton.disabled = false; saveButton.textContent = "Save attendance register"; }
  }
}

/* =========================================
   REPORTS & OFFICIAL PRINT SHEET
   ========================================= */

function getReportDateBounds() {
  const period = $("reportPeriod")?.value || "all";
  if (period === "day") {
    const day = $("reportDay").value;
    return { from: day, to: day, label: day ? formatDate(day) : "Select a day" };
  }
  if (period === "month") {
    const month = $("reportMonth").value;
    if (!month) return { from: "", to: "", label: "Select a month" };
    const [year, monthNumber] = month.split("-").map(Number);
    const lastDay = new Date(year, monthNumber, 0).getDate();
    return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}`, label: new Date(year, monthNumber - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
  }
  if (period === "custom") {
    const from = $("reportFrom").value;
    const to = $("reportTo").value;
    return { from, to, label: `${from ? formatDate(from) : "Beginning"} – ${to ? formatDate(to) : "Today"}` };
  }
  return { from: "", to: "", label: "All Time (Since Day 1)" };
}

function getFilteredReports() {
  const { from, to } = getReportDateBounds();
  const classId = $("reportClass").value;
  const status = $("reportStatus").value;

  return data.attendance
    .filter(record => (
      (!from || record.date >= from) &&
      (!to || record.date <= to) &&
      (!classId || record.classId === classId) &&
      (!status || record.status === status)
    ))
    .sort((a, b) =>
      b.date.localeCompare(a.date) ||
      getStudentName(a.studentId).localeCompare(getStudentName(b.studentId))
    );
}

function updateReportPeriodControls() {
  const period = $("reportPeriod").value;
  $("reportDayWrap").style.display = period === "day" ? "" : "none";
  $("reportMonthWrap").style.display = period === "month" ? "" : "none";
  $("reportFromWrap").style.display = period === "custom" ? "" : "none";
  $("reportToWrap").style.display = period === "custom" ? "" : "none";
}

function renderCumulativeAttendanceSummary() {
  const { from, to, label } = getReportDateBounds();
  const classFilter = $("reportClass").value;
  const classes = data.classes.filter(cls => !classFilter || cls.id === classFilter);
  const logs = (data.teachingLogs || []).filter(log =>
    (!classFilter || log.classId === classFilter) &&
    (!from || (log.date || "").slice(0, 10) >= from) &&
    (!to || (log.date || "").slice(0, 10) <= to)
  );
  const records = data.attendance.filter(record =>
    (!classFilter || record.classId === classFilter) &&
    (!from || record.date >= from) &&
    (!to || record.date <= to)
  );

  $("cumulativeSummaryDescription").textContent =
    `${label} · ${logs.length} lesson sign-in record${logs.length === 1 ? "" : "s"} across ${classes.length} class${classes.length === 1 ? "" : "es"}`;

  const rows = [];
  classes.forEach(cls => {
    const classLogs = logs.filter(log => log.classId === cls.id);
    const classRecords = records.filter(record => record.classId === cls.id);
    const students = data.students.filter(student => student.classId === cls.id);

    students.forEach(student => {
      const studentRecords = classRecords.filter(record => record.studentId === student.id);
      const attended = studentRecords.filter(record => record.status === "Present" || record.status === "Late").length;
      const missed = studentRecords.filter(record => record.status === "Absent").length;
      const excused = studentRecords.filter(record => record.status === "Excused").length;
      const lessonsTaught = classLogs.length;
      const percentage = lessonsTaught ? Math.min(100, Math.round((attended / lessonsTaught) * 100)) : 0;

      rows.push(`<tr>
        <td>${escapeHTML(getClassName(cls.id))}</td>
        <td>${escapeHTML(student.name)}</td>
        <td>${escapeHTML(student.admission || "—")}</td>
        <td>${lessonsTaught}</td>
        <td>${attended}</td>
        <td>${missed}</td>
        <td><strong>${lessonsTaught ? percentage + "%" : "—"}</strong></td>
      </tr>`);
    });
  });

  $("cumulativeAttendanceTable").innerHTML = rows.length
    ? rows.join("")
    : `<tr><td colspan="7" class="table-empty">No enrolled students found for this selection.</td></tr>`;
}

function renderReports() {
  populateClassSelects();
  updateReportPeriodControls();
  currentReport = getFilteredReports();

  const total = currentReport.length;
  const present = currentReport.filter(record => record.status === "Present" || record.status === "Late").length;
  const absent = currentReport.filter(record => record.status === "Absent").length;
  const rate = total ? Math.round((present / total) * 100) : 0;

  $("reportTotal").textContent = total;
  $("reportPresent").textContent = present;
  $("reportAbsent").textContent = absent;
  $("reportRate").textContent = `${rate}%`;
  $("reportDescription").textContent = `${total} matching record${total === 1 ? "" : "s"}`;

  $("reportsTable").innerHTML = total
    ? currentReport.map(record => {
        const student = data.students.find(item => item.id === record.studentId);
        return `
          <tr>
            <td>${formatDate(record.date)}</td>
            <td>${escapeHTML(getStudentName(record.studentId))}</td>
            <td>${escapeHTML(student?.admission || "—")}</td>
            <td>${escapeHTML(getClassName(record.classId))}</td>
            <td><span class="status-pill status-${record.status}">${record.status}</span></td>
            <td>${escapeHTML(record.remarks || "—")}</td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="6" class="table-empty">No matching attendance records.</td></tr>`;

  renderCumulativeAttendanceSummary();
}

function printOfficialRegister() {
  renderReports();
  $("printInstitutionTitle").textContent = data.settings.institution || "TVET INSTITUTION ATTENDANCE REGISTER";
  $("printDepartmentTitle").textContent = `${data.settings.department || "Academic Department"} — Official Attendance Sheet`;

  const selectedClass = $("reportClass").value ? getClassName($("reportClass").value) : "All Classes";
  $("printFilterSummary").textContent = `Generated by: ${currentLecturer?.name || "Lecturer"} · Scope: ${selectedClass} · Records: ${currentReport.length}`;
  $("printGeneratedDate").textContent = `Printed on: ${formatDate(today())}`;
  $("printLecturerSign").textContent = `${currentLecturer?.name || "Lecturer"} (${currentLecturer?.staffId || ""}) · Date: ${formatDate(today())}`;

  window.print();
}

/* =========================================
   CSV EXPORT & BACKUP / RESTORE
   ========================================= */

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportReport() {
  currentReport = getFilteredReports();
  const headers = ["Date", "Student Name", "Admission Number", "Class / Lecturer", "Status", "Remarks"];
  const rows = currentReport.map(record => {
    const student = data.students.find(item => item.id === record.studentId);
    return [
      record.date,
      getStudentName(record.studentId),
      student?.admission || "",
      getClassName(record.classId),
      record.status,
      record.remarks || ""
    ];
  });

  const csv = [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
  const slug = (currentLecturer?.staffId || "lecturer").replace(/[^a-z0-9]/gi, "_");
  downloadFile(`attendance-${slug}-${today()}.csv`, "\uFEFF" + csv, "text/csv;charset=utf-8");
  toast("CSV report downloaded.");
}

function backupData() {
  const backup = {
    lecturer: currentLecturer?.staffId,
    isGlobalAdminBackup: isAdminUser(currentLecturer),
    ...data,
    backupCreatedAt: new Date().toISOString()
  };
  const slug = (currentLecturer?.staffId || "lecturer").replace(/[^a-z0-9]/gi, "_");
  downloadFile(`classtrack-backup-${slug}-${today()}.json`, JSON.stringify(backup, null, 2), "application/json");
  toast("Backup downloaded.");
}

function restoreData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const incoming = JSON.parse(reader.result);
      if (!incoming || !Array.isArray(incoming.students) || !Array.isArray(incoming.classes) || !Array.isArray(incoming.attendance)) {
        throw new Error("Invalid backup structure");
      }
      if (!confirm("Restore this backup? Current records in this view will be replaced.")) return;

      data = {
        ...emptyWorkspace(currentLecturer),
        ...incoming,
        teachingLogs: Array.isArray(incoming.teachingLogs) ? incoming.teachingLogs : [],
        settings: { ...emptyWorkspace(currentLecturer).settings, ...(incoming.settings || {}) }
      };

      if (saveData()) {
        if (isAdminUser(currentLecturer)) data = loadGlobalAdminView(currentLecturer);
        populateClassSelects();
        renderDashboard();
        renderStudents();
        renderClasses();
        renderReports();
        $("institutionName").value = data.settings.institution || "";
        $("departmentName").value = data.settings.department || "";
        $("settingsPin").value = data.settings.pin || "";
        toast("Backup restored.");
      }
    } catch (error) {
      console.error(error);
      alert("Could not restore backup. Please select a valid ClassTrack JSON backup.");
    }
    $("restoreInput").value = "";
  };
  reader.readAsText(file);
}

/* =========================================
   SECURE ADMIN ACCOUNT DIRECTORY & AUDIT REVIEW
   ========================================= */
async function loadAdminSecurityPanel() {
  if (!isAdminUser(currentLecturer)) return;
  const accountsBody = $("adminAccountsTable");
  const auditBody = $("adminAuditTable");
  if (accountsBody) accountsBody.innerHTML = '<tr><td colspan="5" class="table-empty">Loading accounts...</td></tr>';
  if (auditBody) auditBody.innerHTML = '<tr><td colspan="5" class="table-empty">Loading audit records...</td></tr>';

  try {
    const [{ data: accounts, error: accountError }, { data: logs, error: auditError }] = await Promise.all([
      supabaseClient.rpc("admin_list_accounts"),
      supabaseClient.from("audit_logs")
        .select("id, actor_id, action, table_name, record_id, created_at")
        .order("created_at", { ascending: false })
        .limit(50)
    ]);
    if (accountError) throw accountError;
    if (auditError) throw auditError;

    const accountList = accounts || [];
    const byId = new Map(accountList.map(account => [account.user_id, account]));
    if (accountsBody) {
      const lecturers = accountList.filter(account => account.role === "lecturer");
      accountsBody.innerHTML = lecturers.length ? lecturers.map(account => {
        const status = account.account_status;
        const statusLabel = status === "pending" ? "Pending approval" : status === "suspended" ? "Suspended" : "Active";
        const nextStatus = status === "active" ? "suspended" : "active";
        const actionLabel = status === "pending" ? "Approve" : status === "suspended" ? "Reactivate" : "Suspend";
        return `<tr>
          <td>${escapeHTML(account.full_name || "Lecturer")}</td>
          <td>${escapeHTML(account.email || "—")}</td>
          <td>${escapeHTML(account.department || "—")}</td>
          <td><span class="status-pill status-${status === "active" ? "Present" : "Absent"}">${statusLabel}</span></td>
          <td><button class="action-btn ${status === "active" ? "delete" : ""}" data-admin-account-status="${escapeHTML(account.user_id)}" data-next-status="${nextStatus}">${actionLabel}</button></td>
        </tr>`;
      }).join("") : '<tr><td colspan="5" class="table-empty">No lecturer accounts found.</td></tr>';
    }

    if (auditBody) {
      auditBody.innerHTML = (logs || []).length ? logs.map(log => {
        const actor = byId.get(log.actor_id);
        return `<tr>
          <td>${escapeHTML(new Date(log.created_at).toLocaleString())}</td>
          <td>${escapeHTML(actor?.email || (log.actor_id ? log.actor_id.slice(0, 8) : "System"))}</td>
          <td>${escapeHTML(log.action)}</td>
          <td>${escapeHTML(log.table_name)}</td>
          <td>${escapeHTML(log.record_id || "—")}</td>
        </tr>`;
      }).join("") : '<tr><td colspan="5" class="table-empty">No audit activity recorded yet.</td></tr>';
    }
  } catch (error) {
    console.error("Admin security panel failed:", error);
    if (accountsBody) accountsBody.innerHTML = `<tr><td colspan="5" class="table-empty">${escapeHTML(error.message || "Could not load accounts.")}</td></tr>`;
    if (auditBody) auditBody.innerHTML = `<tr><td colspan="5" class="table-empty">${escapeHTML(error.message || "Could not load audit records.")}</td></tr>`;
  }
}

async function handleAdminSecurityActions(event) {
  const button = event.target.closest("[data-admin-account-status]");
  if (!button || !isAdminUser(currentLecturer)) return;
  const userId = button.dataset.adminAccountStatus;
  const nextStatus = button.dataset.nextStatus;
  const label = nextStatus === "suspended" ? "suspend" : "reactivate";
  if (!confirm(`Are you sure you want to ${label} this lecturer account?`)) return;

  button.disabled = true;
  try {
    const { error } = await supabaseClient.rpc("admin_set_account_status", {
      p_user_id: userId,
      p_status: nextStatus
    });
    if (error) throw error;
    toast(`Lecturer account ${nextStatus}.`);
    await loadAdminSecurityPanel();
  } catch (error) {
    console.error("Lecturer status update failed:", error);
    toast("Could not update lecturer account: " + (error.message || "Unknown error"));
    button.disabled = false;
  }
}

/* =========================================
   SETTINGS (ADMIN-ONLY ADMIN PASSWORD PROTECTION)
   ========================================= */

function saveSettings() {
  data.settings.institution = $("institutionName").value.trim();
  data.settings.department = $("departmentName").value.trim();
  const newPin = $("settingsPin").value.trim();

  if (newPin && currentLecturer) {
    if (newPin.length < 4) {
      toast("PIN/Password must be at least 4 characters.");
      return;
    }

    if (isAdminUser(currentLecturer)) {
      if (newPin !== currentLecturer.pin) {
        if (!confirm("Confirm changing the System Administrator password? Only you will know this new password.")) {
          return;
        }
        localStorage.setItem("classtrack_admin_pin_customized", "true");
      }
    }

    data.settings.pin = newPin;
    currentLecturer.pin = newPin;
    currentLecturer.department = data.settings.department;
    sessionStorage.setItem(SESSION_AUTH_KEY, JSON.stringify(currentLecturer));

    const lecturers = getLecturers();
    const idx = lecturers.findIndex(l => l.staffId.toLowerCase() === currentLecturer.staffId.toLowerCase());
    if (idx >= 0) {
      lecturers[idx].pin = newPin;
      lecturers[idx].department = data.settings.department;
      saveLecturers(lecturers);
    }
  }

  if (saveData()) toast(isAdminUser(currentLecturer) ? "Admin security password & settings updated." : "Settings & PIN saved.");
}

function clearAllData() {
  const confirmed = confirm(isAdminUser(currentLecturer)
    ? "Clear Admin's own direct records? (Other lecturers' workspaces remain intact unless cleared individually)."
    : `Permanently delete all students, classes, teaching logs, and attendance inside ${currentLecturer?.name}'s workspace?`);
  if (!confirmed) return;

  if (isAdminUser(currentLecturer)) {
    localStorage.setItem(getWorkspaceKey("admin"), JSON.stringify(emptyWorkspace(currentLecturer)));
    data = loadGlobalAdminView(currentLecturer);
  } else {
    data = emptyWorkspace(currentLecturer);
    saveData();
  }

  populateClassSelects();
  renderDashboard();
  renderStudents();
  renderClasses();
  renderReports();
  $("registerArea").innerHTML = `<div class="empty-state"><div class="empty-symbol">✓</div><h3>Ready to take attendance?</h3><p>Select a class and date above to load its student register.</p></div>`;
  toast("Workspace cleared.");
}

/* =========================================
   EVENT LISTENERS & INIT
   ========================================= */

function bindEvents() {
  $("loginForm").addEventListener("submit", handleLogin);
  $("forgotPasswordBtn").addEventListener("click", handleForgotPassword);
  $("signUpForm").addEventListener("submit", handleSignUp);
  $("showSignUpBtn").addEventListener("click", () => toggleAuthMode("signup"));
  $("showSignInBtn").addEventListener("click", () => toggleAuthMode("signin"));
  $("logoutBtn").addEventListener("click", lockApp);

  document.querySelectorAll("[data-view]").forEach(btn => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });
  document.querySelectorAll("[data-go]").forEach(btn => {
    btn.addEventListener("click", () => showView(btn.dataset.go));
  });
  $("mobileMenu").addEventListener("click", () => $("sidebar").classList.toggle("open"));

  $("addStudentBtn").addEventListener("click", () => openStudent());
  $("studentForm").addEventListener("submit", saveStudent);
  $("studentsTable").addEventListener("click", handleStudentActions);
  $("studentSearch").addEventListener("input", renderStudents);
  $("studentClassFilter").addEventListener("change", renderStudents);

  $("addClassBtn").addEventListener("click", () => openClass());
  $("classForm").addEventListener("submit", saveClass);
  $("classGrid").addEventListener("click", handleClassActions);
  $("selfEnrollForm").addEventListener("submit", handleSelfEnrollSubmit);
  $("copyEnrollLinkBtn").addEventListener("click", () => {
    navigator.clipboard?.writeText($("enrollShareLink").value);
    toast("Day 1 enrollment link copied.");
  });

  document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", () => $(btn.dataset.close).close());
  });

  $("startQrSessionBtn").addEventListener("click", startQrSession);
  $("stopQrSessionBtn").addEventListener("click", () => stopQrSession(false));
  $("studentCheckInForm").addEventListener("submit", handleStudentSelfCheckIn);
  $("copySessionLinkBtn").addEventListener("click", () => {
    navigator.clipboard?.writeText($("sessionShareLink").value);
    toast("Check-in link copied to clipboard.");
  });

  $("loadRegisterBtn").addEventListener("click", renderRegister);
  $("attendanceClass").addEventListener("change", renderRegister);
  $("attendanceDate").addEventListener("change", renderRegister);

  $("reportPeriod").addEventListener("change", () => {
    updateReportPeriodControls();
    renderReports();
  });
  ["reportDay", "reportMonth", "reportFrom", "reportTo", "reportClass", "reportStatus"].forEach(id => {
    $(id).addEventListener("change", renderReports);
  });
  $("filterReportsBtn").addEventListener("click", renderReports);
  $("exportReportBtn").addEventListener("click", exportReport);
  $("printReportBtn").addEventListener("click", printOfficialRegister);

  $("backupBtn").addEventListener("click", backupData);
  $("restoreInput").addEventListener("change", e => {
    if (e.target.files[0]) restoreData(e.target.files[0]);
  });
  $("saveSettingsBtn").addEventListener("click", saveSettings);
  $("refreshAdminPanelBtn")?.addEventListener("click", loadAdminSecurityPanel);
  $("adminAccountsTable")?.addEventListener("click", handleAdminSecurityActions);
  $("clearDataBtn").addEventListener("click", clearAllData);
}

function init() {
  const now = new Date();
  $("todayLabel").textContent = now.toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short", year: "numeric"
  });
  $("attendanceDate").value = today();

  if (checkUrlPortalMode()) return;

  bindEvents();
  checkAuth();
}

init();
