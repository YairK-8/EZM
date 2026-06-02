/* ============================================================
   EZM · app.js  –  Full frontend, connected to REST API
   ============================================================ */

"use strict";

const TOKEN_KEY = "ezm_token";

function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || "";
}

function storeToken(token, remember = false) {
  if (remember) {
    localStorage.setItem(TOKEN_KEY, token);
    sessionStorage.removeItem(TOKEN_KEY);
  } else {
    sessionStorage.setItem(TOKEN_KEY, token);
    localStorage.removeItem(TOKEN_KEY);
  }
}

function clearStoredToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

// ── State ─────────────────────────────────────────────────────────────────────
const app = {
  token:        getStoredToken(),
  user:         null,          // current logged-in user object
  branches:     [],            // all branches from API
  users:        [],            // all users from API (managers see all)
  publicBranches: [],
  currentBranch: null,         // selected branch object
  currentWeek:  null,          // full week object (with shifts[])
  weekStart:    todayWeekStart(),
  portalWeekStart: todayWeekStart(),
  requestsBranchId: null,
  selectedShiftId: null,
  openSelectedShiftAfterLoad: false,
  activeView: null,
  refreshTimer: null,
  refreshInFlight: false,
  autoRefreshStarted: false,
  setupRequired: false,
  reinforcementPromptKey: "",
  suppressReinforcementPrompt: false,
};

// ── Date helpers ───────────────────────────────────────────────────────────────
function todayWeekStart() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - day);
  return fmtDate(d);
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function addDays(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

function parseIso(iso) {
  const [y,m,d] = iso.split("-").map(Number);
  return new Date(y, m-1, d);
}

const DAY_LABELS = { sun:"ראשון", mon:"שני", tue:"שלישי", wed:"רביעי", thu:"חמישי", fri:"שישי", sat:"שבת" };
const DAY_KEYS   = ["sun","mon","tue","wed","thu","fri","sat"];
const MONTHS     = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];
const WEEKDAY_OPTIONS = [
  { value: 0, label: "שני" },
  { value: 1, label: "שלישי" },
  { value: 2, label: "רביעי" },
  { value: 3, label: "חמישי" },
  { value: 4, label: "שישי" },
  { value: 5, label: "שבת" },
  { value: 6, label: "ראשון" },
];
// Populated automatically from Hebcal API; fallback entries used if fetch fails
let HOLIDAYS = {
  "2026-05-05":"ל\"ג בעומר",
  "2026-05-21":"ערב שבועות",
  "2026-05-22":"שבועות",
};

async function loadHolidays() {
  const CACHE_KEY = "ezm_holidays_v2";
  const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      HOLIDAYS = cached.data;
      return;
    }
  } catch {}

  const map = {};
  const years = [new Date().getFullYear(), new Date().getFullYear() + 1];
  for (const year of years) {
    try {
      const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=on&nx=off&year=${year}&month=x&i=on&lg=h`;
      const res  = await fetch(url);
      const data = await res.json();
      (data.items || []).forEach(item => {
        if (item.date && item.hebrew && item.category === "holiday") {
          // keep only the first holiday per date (most prominent)
          if (!map[item.date]) map[item.date] = item.hebrew;
        }
      });
    } catch (e) {
      console.warn("Hebcal fetch failed for", year, e);
    }
  }
  if (Object.keys(map).length > 0) {
    HOLIDAYS = map;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: map }));
    } catch {}
  }
}

function weekRangeLabel(weekStart) {
  const s = parseIso(weekStart);
  const e = parseIso(addDays(weekStart, 6));
  if (s.getMonth() === e.getMonth())
    return `${s.getDate()}–${e.getDate()} ב${MONTHS[s.getMonth()]} ${s.getFullYear()}`;
  return `${s.getDate()} ב${MONTHS[s.getMonth()]} – ${e.getDate()} ב${MONTHS[e.getMonth()]} ${e.getFullYear()}`;
}

function dayLabel(weekStart, index) {
  const d = parseIso(addDays(weekStart, index));
  return `${d.getDate()}.${d.getMonth()+1}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function shiftHoursDuration(hours) {
  const parts = String(hours || "").split(/[–-]/).map(x => x.trim());
  if (parts.length !== 2) return 0;
  const toMinutes = t => {
    const [h, m] = t.split(":").map(Number);
    return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : NaN;
  };
  const start = toMinutes(parts[0]);
  let end = toMinutes(parts[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  if (end < start) end += 24 * 60;
  return Math.max(0, (end - start) / 60);
}

function fmtHoursCount(value) {
  const n = Math.round((Number(value) || 0) * 10) / 10;
  return Number.isInteger(n) ? String(n) : String(n).replace(/\.0$/, "");
}

function monthWeekStarts(date = new Date()) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const start = parseIso(fmtDate(first));
  start.setDate(start.getDate() - start.getDay());
  const result = [];
  for (let d = start; d <= last; d.setDate(d.getDate() + 7)) result.push(fmtDate(new Date(d)));
  return result;
}

function holidayFor(iso, dayKey) {
  if (dayKey === "sat") return HOLIDAYS[iso] || "";
  return HOLIDAYS[iso] || "";
}

// ── API ────────────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (app.token) opts.headers.Authorization = `Bearer ${app.token}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "api_error");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  maybeScheduleRefreshAfterMutation(method, path);
  return data;
}

function shouldRefreshAfterMutation(method, path) {
  if (String(method).toUpperCase() === "GET") return false;
  if (!app.user || !path.startsWith("/api/")) return false;
  if (path.startsWith("/api/auth") || path.startsWith("/api/dev") || path.startsWith("/api/setup")) return false;
  if (String(method).toUpperCase() === "POST" && path === "/api/weeks") return false;
  return true;
}

function maybeScheduleRefreshAfterMutation(method, path) {
  if (!shouldRefreshAfterMutation(method, path)) return;
  app.currentWeek = null;
  scheduleActiveViewRefresh(250);
}

function scheduleActiveViewRefresh(delay = 0) {
  if (!app.activeView || app.activeView === "auth") return;
  clearTimeout(app.refreshTimer);
  app.refreshTimer = setTimeout(() => refreshActiveView("mutation"), delay);
}

function modalIsOpen() {
  return !document.getElementById("modalBackdrop")?.hidden;
}

async function refreshActiveView(reason = "auto") {
  if (!app.user || app.refreshInFlight || document.hidden || modalIsOpen()) return;
  app.refreshInFlight = true;
  try {
    await refreshCoreData();
    if (app.activeView === "schedule") {
      app.currentWeek = null;
      await loadWeekView({ ensureWeek: reason !== "poll" });
    } else if (app.activeView === "employees") {
      renderEmployees();
    } else if (app.activeView === "requests") {
      await loadRequests();
    } else if (app.activeView === "reports") {
      await loadReports();
    } else if (app.activeView === "area") {
      await loadAreaView();
    } else if (app.activeView === "network") {
      await loadNetworkView();
    } else if (app.activeView === "employeePortal") {
      app.currentWeek = null;
      await renderPortal();
    } else if (app.activeView === "employeeRequests") {
      await renderPortalRequests();
    } else if (app.activeView === "developer") {
      await loadDevView();
    }
  } catch (e) {
    console.warn("refreshActiveView error", e);
  } finally {
    app.refreshInFlight = false;
  }
}

function startAutoRefresh() {
  if (app.autoRefreshStarted) return;
  app.autoRefreshStarted = true;
  setInterval(() => {
    if (!app.user || app.activeView === "auth" || app.activeView === "developer") return;
    refreshActiveView("poll");
  }, 12000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleActiveViewRefresh(150);
  });
}

// ── Role helpers ───────────────────────────────────────────────────────────────
const ROLE_LABELS = {
  "network-manager": "מנהל רשת",
  "area-manager":    "מנהל אזור",
  "branch-manager":  "מנהל סניף",
  "employee":        "עובד",
};

function roleLabel(r) { return ROLE_LABELS[r] || r; }

const ROLE_LEVELS = {
  "employee": 10,
  "branch-manager": 20,
  "area-manager": 30,
  "network-manager": 40,
  "developer": 50,
};

function roleLevel(role) {
  return ROLE_LEVELS[role] || 0;
}

function canManageUser(target, newRole = target?.role) {
  if (!app.user || !target) return false;
  if (app.user.role === "developer") return true;
  if (app.user.role === "network-manager") return true;
  if (app.user.role === "employee") return false;
  const actorLevel = roleLevel(app.user.role);
  return actorLevel > roleLevel(target.role) && actorLevel > roleLevel(newRole);
}

const ROLE_VIEWS = {
  "network-manager": ["schedule","employees","requests","reports","area","network"],
  "area-manager":    ["schedule","employees","requests","reports","area"],
  "branch-manager":  ["schedule","employees","requests","reports"],
  "employee":        ["employeePortal","employeeRequests"],
  "developer":       ["developer","schedule","employees","requests","reports","area","network"],
};

function allowedViews(role) {
  const views = [...(ROLE_VIEWS[role] || ["auth"])];
  if (role === "employee" && app.user?.isLead && !views.includes("reports")) views.push("reports");
  return views;
}
function defaultView(role) {
  const map = { "network-manager":"network", "area-manager":"area",
                "branch-manager":"schedule", "employee":"employeePortal",
                "developer":"developer" };
  return map[role] || "auth";
}

// ── Navigation ─────────────────────────────────────────────────────────────────
const VIEW_META = {
  schedule:       ["סניף / שבוע",        "סידור שבועי"],
  employees:      ["עובדים",             "ניהול עובדים"],
  requests:       ["בקשות",              "בקשות ושינויים"],
  reports:        ["דוחות",              "דוח סוף יום"],
  area:           ["אזור",               "ניהול אזור"],
  network:        ["רשת",                "ניהול רשת"],
  employeePortal: ["אזור עובד",          "הלוז שלי"],
  employeeRequests: ["אזור עובד",        "הבקשות שלי"],
  auth:           ["EZM",               "כניסה"],
  developer:      ["מפתח",              "Developer Console"],
};

function showView(name) {
  app.activeView = name;
  setMenuOpen(false);
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  const el = document.getElementById(name + "View");
  if (el) el.classList.add("active");
  document.body.classList.toggle("auth-page", name === "auth");
  const viewHash = name === "auth"
    ? `#${document.querySelector(".auth-tab.active")?.dataset.authTab || "login"}`
    : `#${name}`;
  if (window.location.hash !== viewHash) {
    history.replaceState(null, "", viewHash);
  }
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll("#employeeBottomNav [data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  const meta = VIEW_META[name] || ["EZM",""];
  document.getElementById("topbarContext").textContent = meta[0];
  document.getElementById("topbarTitle").textContent = meta[1];
  updateTopbarActions(name);
  if (name === "schedule") loadWeekView();
  if (name === "employees") renderEmployees();
  if (name === "requests")  loadRequests();
  if (name === "reports")   loadReports();
  if (name === "area")      loadAreaView();
  if (name === "network")   loadNetworkView();
  if (name === "employeePortal") renderPortal();
  if (name === "employeeRequests") renderPortalRequests();
  if (name === "developer") loadDevView();
}

function setMenuOpen(open) {
  document.body.classList.toggle("menu-open", !!open);
  const backdrop = document.getElementById("menuBackdrop");
  if (backdrop) backdrop.hidden = !open;
}

function applyRoleAccess() {
  const role = app.user?.role;
  const allowed = role ? allowedViews(role) : [];
  document.querySelectorAll(".nav-item").forEach(b => {
    const v = b.dataset.view;
    b.hidden = (v !== "auth") && !allowed.includes(v);
  });
  document.querySelector('.nav-item[data-view="auth"]').hidden = !!app.user;

  if (app.user) {
    const isDev = app.user.role === "developer";
    document.body.classList.toggle("employee-mode", app.user.role === "employee");
    document.body.classList.toggle("dev-mode", isDev);
    document.getElementById("sidebarUser").hidden = false;
    document.getElementById("employeeBottomNav").hidden = app.user.role !== "employee";
    document.getElementById("userAvatar").textContent = isDev ? "🔧" : (app.user.fullName || "?")[0];
    document.getElementById("userName").textContent = app.user.fullName;
    document.getElementById("userRole").textContent = isDev ? "Developer" : roleLabel(app.user.role);
  } else {
    document.body.classList.remove("employee-mode");
    document.getElementById("sidebarUser").hidden = true;
    document.getElementById("employeeBottomNav").hidden = true;
  }
  document.querySelector('#employeeBottomNav [data-view="reports"]').hidden = !(app.user?.role === "employee" && app.user?.isLead);
}

function exportScheduleCSV() {
  const week = app.currentWeek;
  if (!week) return;
  const branch = app.currentBranch?.name || "";

  // RTL order: Saturday on the left, Sunday on the far right
  const csvDayKeys = [...DAY_KEYS].reverse(); // sat→fri→...→sun

  const getShift = (dk, slot) => week.shifts?.find(s => s.dayKey === dk && s.slot === slot);
  const getWorkerNames = shift => (shift?.assignments || [])
    .map(a => a.userName || app.users.find(u => u.id === a.userId)?.fullName || "")
    .filter(Boolean);

  const dayHeader = dk => {
    const idx = DAY_KEYS.indexOf(dk);
    const dateStr = addDays(week.weekStart, idx);
    const [, m, d] = dateStr.split("-");
    return `${DAY_LABELS[dk]} ${parseInt(d)}/${parseInt(m)}`;
  };

  // Find max worker counts across all days
  const maxMorning = Math.max(1, ...DAY_KEYS.map(dk => getWorkerNames(getShift(dk,"morning")).length));
  const maxEvening = Math.max(1, ...DAY_KEYS.map(dk => getWorkerNames(getShift(dk,"evening")).length));

  const rows = [];

  // Row 1: day headers (RTL: sat...sun)
  rows.push(["", ...csvDayKeys.map(dk => dayHeader(dk))]);

  // Row 2: יעד יומי
  rows.push(["יעד יומי", ...csvDayKeys.map(dk => {
    const m = getShift(dk,"morning"), e = getShift(dk,"evening");
    return Math.max(Number(m?.salesTarget||0), Number(e?.salesTarget||0)) || "";
  })]);

  // Row 3: משמרת בוקר + שעות
  rows.push(["משמרת בוקר", ...csvDayKeys.map(dk => getShift(dk,"morning")?.hours || "")]);

  // Rows: one per morning worker slot
  for (let i = 0; i < maxMorning; i++) {
    rows.push([`עובד ${i+1}`, ...csvDayKeys.map(dk => getWorkerNames(getShift(dk,"morning"))[i] || "")]);
  }

  // Row: משמרת ערב + שעות
  rows.push(["משמרת ערב", ...csvDayKeys.map(dk => getShift(dk,"evening")?.hours || "")]);

  // Rows: one per evening worker slot
  for (let i = 0; i < maxEvening; i++) {
    rows.push([`עובד ${i+1}`, ...csvDayKeys.map(dk => getWorkerNames(getShift(dk,"evening"))[i] || "")]);
  }

  const BOM = "﻿";
  const csv = BOM + rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `לוז_${branch}_${week.weekStart}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function updateTopbarActions(view) {
  const el = document.getElementById("topbarActions");
  el.innerHTML = "";
  if (!app.user) return;

  if (view === "schedule") {
    if (app.currentWeek) {
      const s = app.currentWeek.status;
      const statusColors = { draft:"tag-yellow", published:"tag-green", closed:"tag-muted" };
      const statusLabels = { draft:"טיוטה", published:"פורסם", closed:"נסגר" };
      el.innerHTML = `
        <span class="tag ${statusColors[s]}">${statusLabels[s]}</span>
      `;
      if (app.user.role !== "employee") {
        if (s === "draft") {
          el.innerHTML += `<button class="btn btn-primary btn-sm" id="topPublishBtn">פרסם סידור</button>`;
        } else if (s === "published") {
          el.innerHTML += `<button class="btn btn-ghost btn-sm" id="topPublishBtn">חזור לטיוטה</button>
                           <button class="btn btn-ghost btn-sm" id="topCloseBtn">סגור שבוע</button>`;
        } else if (s === "closed") {
          el.innerHTML += `<button class="btn btn-ghost btn-sm" id="topPublishBtn">פתח לעדכון</button>`;
        }
        el.innerHTML += `<button class="btn btn-ghost btn-sm" id="topExportBtn">📥 יצוא Excel</button>`;
        el.querySelectorAll("#topPublishBtn").forEach(b => b.addEventListener("click", toggleWeekPublish));
        el.querySelector("#topCloseBtn")?.addEventListener("click", closeWeek);
        el.querySelector("#topExportBtn")?.addEventListener("click", exportScheduleCSV);
      }
    }
  }
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function modal({ kicker, title, body, footer = "" }) {
  document.getElementById("modalKicker").textContent = kicker;
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = body;
  document.getElementById("modalFooter").innerHTML = footer;
  document.getElementById("modalBackdrop").hidden = false;
}
function closeModal() {
  document.getElementById("modalBackdrop").hidden = true;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function setAuthNote(msg, type = "") {
  const el = document.getElementById("authNote");
  el.textContent = msg;
  el.className = "auth-note" + (type ? " " + type : "");
}

function setLoginAsEmployeeVisible(visible) {
  const wrap = document.getElementById("loginAsEmployeeWrap");
  const input = document.getElementById("loginAsEmployee");
  if (!wrap || !input) return;
  wrap.hidden = !visible;
  if (!visible) input.checked = false;
}

async function sendCode() {
  const id = document.getElementById("loginId").value.trim();
  if (!id) return setAuthNote("יש להזין מספר תעודת זהות.", "error");
  setLoginAsEmployeeVisible(false);
  document.getElementById("sendCodeBtn").disabled = true;
  try {
    const data = await api("POST", "/api/auth/request-code", { idNumber: id });
    setLoginAsEmployeeVisible(!!data.canLoginAsEmployee);
    setAuthNote("קוד נשלח לכתובת המייל שלך. תקף 10 דקות.", "success");
  } catch (e) {
    if (e.data?.error === "account_suspended")
      setAuthNote("החשבון שלך מושהה. פנה למנהל כדי להפעיל אותו מחדש.", "error");
    else if (e.data?.error === "account_pending")
      setAuthNote("ההרשמה שלך עדיין ממתינה לאישור מנהל.", "error");
    else if (e.data?.error === "branch_blocked")
      setAuthNote("הסניף שלך הושעה ממערכת. פנה למפתח המערכת.", "error");
    else if (e.status === 404)
      setAuthNote("המשתמש לא נמצא.", "error");
    else
      setAuthNote("שליחת המייל נכשלה. בדוק הגדרות SMTP.", "error");
  } finally {
    document.getElementById("sendCodeBtn").disabled = false;
  }
}

async function login() {
  const idNumber = document.getElementById("loginId").value.trim();
  const code     = document.getElementById("otpInput").value.trim();
  if (!idNumber || !code) return setAuthNote("יש למלא ת.ז. וקוד.", "error");
  document.getElementById("loginBtn").disabled = true;
  let data;
  try {
    data = await api("POST", "/api/auth/verify", {
      idNumber,
      code,
      loginAsEmployee: document.getElementById("loginAsEmployee")?.checked || false,
    });
  } catch (e) {
    setAuthNote("קוד שגוי או פג תוקף. בקש קוד חדש.", "error");
    document.getElementById("loginBtn").disabled = false;
    return;
  }

  app.token = data.token;
  app.user  = data.user;
  storeToken(app.token, document.getElementById("rememberMe")?.checked);
  setAuthNote(`ברוך הבא, ${app.user.fullName}!`, "success");

  try {
    await enterApp();
  } catch (e) {
    console.error("enterApp failed", e);
    setAuthNote("הכניסה הצליחה, אבל טעינת המערכת נכשלה. רענן את הדף ונסה שוב.", "error");
  } finally {
    document.getElementById("loginBtn").disabled = false;
  }
}

async function enterApp() {
  await loadInitialData();
  applyRoleAccess();
  showView(defaultView(app.user.role));
  startAutoRefresh();
}

async function logout() {
  app.token = "";
  app.user  = null;
  app.currentWeek = null;
  clearStoredToken();
  applyRoleAccess();
  showView("auth");
}

// ── Developer Auth ────────────────────────────────────────────────────────────
function setDevNote(msg, type = "") {
  const el = document.getElementById("devNote");
  if (!el) return;
  el.textContent = msg;
  el.className = "auth-note" + (type ? " " + type : "");
}

async function devLogin() {
  const pwd = document.getElementById("devPassword")?.value.trim();
  if (!pwd) return setDevNote("הכנס סיסמה.", "error");
  document.getElementById("devLoginBtn").disabled = true;
  try {
    const data = await api("POST", "/api/dev/auth", { password: pwd });
    app.token = data.token;
    app.user  = { fullName: "מפתח", role: "developer", id: 0 };
    storeToken(app.token, false);
    applyRoleAccess();
    showView("developer");
  } catch {
    setDevNote("סיסמה שגויה.", "error");
  } finally {
    document.getElementById("devLoginBtn").disabled = false;
  }
}

// ── Developer Panel ───────────────────────────────────────────────────────────
let _devActiveTable = "users";

async function measureLatency(samples = 4) {
  const times = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    try { await api("GET", "/api/dev/ping"); } catch { break; }
    times.push(performance.now() - t0);
  }
  if (!times.length) return null;
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  return { avg: Math.round(avg), min: Math.round(min), max: Math.round(max) };
}

async function loadDevView() {
  try {
    const [statsData, branchesData] = await Promise.all([
      api("GET", "/api/dev/stats"),
      api("GET", "/api/dev/branches"),
    ]);
    renderDevStats(statsData);
    renderDevBranches(branchesData.branches);
    await loadDevTable(_devActiveTable);
    renderDevDbTabs();
  } catch (e) {
    document.getElementById("devStatsGrid").innerHTML =
      `<div class="empty-state">שגיאה בטעינת נתוני מפתח: ${e.message}</div>`;
  }
}

async function refreshDevConsoleVisibility() {
  const toggle = document.getElementById("devLoginToggle");
  if (!toggle) return;
  try {
    const data = await api("GET", "/api/dev/enabled");
    toggle.hidden = !data.enabled;
  } catch {
    toggle.hidden = true;
  }
}

function fmtUptime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function fmtBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b/1024).toFixed(1) + " KB";
  return (b/1048576).toFixed(2) + " MB";
}

function calcHealth(s) {
  let score = 100;
  const reasons = [];
  if (s.avgMs > 500)      { score -= 30; reasons.push(`זמן תגובה ממוצע ${s.avgMs}ms (-30%)`); }
  else if (s.avgMs > 200) { score -= 15; reasons.push(`זמן תגובה ממוצע ${s.avgMs}ms (-15%)`); }
  else if (s.avgMs > 80)  { score -= 5;  reasons.push(`זמן תגובה ממוצע ${s.avgMs}ms (-5%)`); }
  if (s.errorRate > 20)   { score -= 30; reasons.push(`שגיאות ${s.errorRate}% (-30%)`); }
  else if (s.errorRate > 5) { score -= 15; reasons.push(`שגיאות ${s.errorRate}% (-15%)`); }
  else if (s.errorRate > 1) { score -= 5;  reasons.push(`שגיאות ${s.errorRate}% (-5%)`); }
  if (s.blockedBranches > 0) {
    const p = Math.min(s.blockedBranches * 15, 30);
    score -= p;
    reasons.push(`${s.blockedBranches} סניף חסום (-${p}%)`);
  }
  score = Math.max(0, score);
  const color = score >= 80 ? "#a6e3a1" : score >= 50 ? "#f9e2af" : "#f38ba8";
  const label = score >= 80 ? "תקין" : score >= 50 ? "אזהרה" : "קריטי";
  return { score, color, label, reasons };
}

function renderDevStats(s) {
  const health = calcHealth(s);
  const msColor  = s.avgMs < 80      ? "#a6e3a1" : s.avgMs < 250      ? "#f9e2af" : "#f38ba8";
  const errColor = s.errorRate < 1   ? "#a6e3a1" : s.errorRate < 10   ? "#f9e2af" : "#f38ba8";
  const hBg      = health.score >= 80 ? "rgba(166,227,161,.13)" : health.score >= 50 ? "rgba(249,226,175,.13)" : "rgba(243,139,168,.13)";

  const bigCard = (value, label, sub) => `
    <div class="dv-big-card">
      <div class="dv-big-value">${value}</div>
      <div class="dv-big-label">${label}</div>
      ${sub ? `<div class="dv-big-sub">${sub}</div>` : ""}
    </div>`;

  const metricCard = (value, label, color, title) => `
    <div class="dv-metric-card" ${title ? `title="${title}"` : ""}>
      <div class="dv-metric-value" style="color:${color || "#cdd6f4"}">${value}</div>
      <div class="dv-metric-label">${label}</div>
    </div>`;

  document.getElementById("devStatsGrid").innerHTML = `
    <div class="dv-row dv-row-top">
      ${bigCard(s.requests.toLocaleString(), "סה״כ בקשות", `זמן פעילות: ${fmtUptime(s.uptime)}`)}
      ${bigCard(s.users, "משתמשים רשומים", null)}
      ${bigCard(s.branches, "סניפים", s.blockedBranches > 0 ? `${s.blockedBranches} חסומים` : "כולם פעילים")}
    </div>
    <div class="dv-row dv-row-mid">
      ${metricCard(`${s.avgMs}ms`, "זמן תגובה ממוצע", msColor, `P95: ${s.p95Ms}ms · P99: ${s.p99Ms}ms`)}
      ${metricCard(`${s.p95Ms}ms`, "P95 זמן תגובה", msColor)}
      ${metricCard(`${(s.rps60 * 60).toFixed(1)}`, "בקשות/דקה", "#cdd6f4", `ממוצע 5 דקות: ${(s.rps300 * 60).toFixed(1)} לדקה`)}
      ${metricCard(`${s.errorRate}%`, "שגיאות", errColor, `${s.errors} שגיאות מתוך ${s.requests} בקשות`)}
      <div class="dv-health-card" style="background:${hBg};border-color:${health.color}33"
           title="${health.reasons.join("\n") || "מצב תקין"}">
        <div class="dv-health-score" style="color:${health.color}">${health.score}</div>
        <div class="dv-health-pct" style="color:${health.color}">%</div>
        <div class="dv-health-label" style="color:${health.color}">${health.label}</div>
        <div class="dv-health-sub">דופק המערכת</div>
        <div class="dv-health-sub">נמדד על חלון של 5 דקות</div>
      </div>
    </div>
    <div class="dv-row dv-row-bot">
      ${metricCard(fmtBytes(s.dbSizeBytes), "גודל DB", "#cdd6f4")}
      ${metricCard((s.emailsToday || 0).toLocaleString(), "מיילים היום", "#a6e3a1", `כולל קודי כניסה וסיסמאות זיהוי · ${s.emailsFailedToday || 0} שליחות נכשלו היום`)}
      ${metricCard(`${s.p99Ms}ms`, "P99 זמן תגובה", msColor)}
      ${metricCard(s.errors, "סה״כ שגיאות", s.errors > 0 ? "#f38ba8" : "#a6e3a1")}
      ${metricCard(s.blockedBranches, "סניפים חסומים", s.blockedBranches > 0 ? "#f9e2af" : "#a6e3a1")}
    </div>
  `;
}

function renderDevBranches(branches) {
  const blocked = branches.filter(b => b.isBlocked).length;
  document.getElementById("devBranchSubtitle").textContent =
    `${branches.length} סניפים · ${blocked} חסומים`;
  document.getElementById("devBranchesTable").innerHTML = `
    <table class="dev-table">
      <thead><tr>
        <th>#</th><th>שם</th><th>אזור</th><th>מנהל</th><th>עובדים</th><th>סטטוס</th><th>פעולה</th>
      </tr></thead>
      <tbody>
        ${branches.map(b => `
          <tr>
            <td>${b.id}</td>
            <td>${b.name}${b.number ? ` <span style="color:#9ca3af">(${b.number})</span>` : ""}</td>
            <td>${b.area}</td>
            <td>${b.managerName || "—"}</td>
            <td>${b.employeeCount}</td>
            <td><span class="${b.isBlocked ? "dev-blocked-badge" : "dev-active-badge"}">${b.isBlocked ? "חסום" : "פעיל"}</span></td>
            <td>
              <button class="btn btn-sm ${b.isBlocked ? "btn-primary" : "btn-warning"}"
                onclick="devToggleBranch(${b.id}, ${!b.isBlocked})">
                ${b.isBlocked ? "הסר חסימה" : "חסום"}
              </button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function devToggleBranch(branchId, block) {
  try {
    await api("PUT", `/api/dev/branches/${branchId}`, { blocked: block });
    await loadDevView();
  } catch (e) {
    alert("שגיאה: " + e.message);
  }
}

const DEV_TABLES = ["users","branches","user_branches","weeks","shifts",
  "shift_assignments","shift_availability","day_reports","change_requests","audit_log","email_log"];

function renderDevDbTabs() {
  document.getElementById("devDbTabs").innerHTML = DEV_TABLES.map(t => `
    <button class="dev-tab ${t === _devActiveTable ? "active" : ""}"
      onclick="devSelectTable('${t}')">${t}</button>
  `).join("");
}

async function devSelectTable(table) {
  _devActiveTable = table;
  renderDevDbTabs();
  await loadDevTable(table);
}

async function loadDevTable(table) {
  document.getElementById("devDbContent").innerHTML =
    `<div style="padding:20px;color:#6b7280">טוען ${table}...</div>`;
  try {
    const data = await api("GET", `/api/dev/db/${table}?limit=200`);
    if (!data.rows.length) {
      document.getElementById("devDbContent").innerHTML =
        `<div style="padding:20px;color:#6b7280">אין רשומות ב-${table}</div>`;
      return;
    }
    document.getElementById("devDbContent").innerHTML = `
      <div style="padding:8px 20px;font-size:.78rem;color:#6b7280">
        מציג ${data.rows.length} מתוך ${data.total} רשומות
      </div>
      <table class="dev-table">
        <thead><tr>${data.columns.map(c => `<th>${c}</th>`).join("")}</tr></thead>
        <tbody>
          ${data.rows.map(row =>
            `<tr>${data.columns.map(c => `<td title="${String(row[c] ?? "")}">${row[c] ?? ""}</td>`).join("")}</tr>`
          ).join("")}
        </tbody>
      </table>
    `;
  } catch (e) {
    document.getElementById("devDbContent").innerHTML =
      `<div style="padding:20px;color:#dc2626">שגיאה: ${e.message}</div>`;
  }
}

// ── Registration ─────────────────────────────────────────────────────────────
function setRegNote(msg, type = "") {
  const el = document.getElementById("regNote");
  el.textContent = msg;
  el.className = "auth-note" + (type ? " " + type : "");
}

async function submitRegistration() {
  const fullName   = document.getElementById("regName").value.trim();
  const idNumber   = document.getElementById("regId").value.trim();
  const phone      = document.getElementById("regPhone").value.trim();
  const email      = document.getElementById("regEmail").value.trim();
  const branchId   = Number(document.getElementById("regBranchSelect").value || 0);

  if (!fullName || !idNumber || !email) return setRegNote("יש למלא שם, ת.ז. ומייל.", "error");
  if (!app.setupRequired && !branchId) return setRegNote("יש לבחור סניף מהרשימה.", "error");

  document.getElementById("submitRegBtn").disabled = true;
  try {
    if (app.setupRequired) {
      const data = await api("POST", "/api/setup", { fullName, idNumber, phone, email });
      app.setupRequired = false;
      app.token = data.token;
      app.user = data.user;
      storeToken(app.token);
      setRegNote("מנהל הרשת נוצר בהצלחה.", "success");
      try {
        await enterApp();
      } catch (e) {
        console.error("enterApp failed after setup", e);
        setRegNote("מנהל הרשת נוצר, אבל טעינת המערכת נכשלה. רענן את הדף ונסה שוב.", "error");
      }
    } else {
      await api("POST", "/api/users/register", { fullName, idNumber, phone, email, branchId });
      setRegNote("ההרשמה נקלטה וממתינה לאישור מנהל.", "success");
    }
  } catch (e) {
    setRegNote(e.status === 409 ? "מספר ת.ז. כבר קיים במערכת." : "שגיאה בהרשמה. בדוק שהפרטים תקינים.", "error");
  } finally {
    document.getElementById("submitRegBtn").disabled = false;
  }
}

function renderSetupState() {
  const panel = document.getElementById("registerPanel");
  if (!panel) return;
  const branchField = document.getElementById("regBranchSelect")?.closest(".field");
  if (app.setupRequired) {
    document.querySelector('[data-auth-tab="register"]').textContent = "הקמה ראשונית";
    document.getElementById("submitRegBtn").textContent = "צור מנהל רשת";
    if (branchField) branchField.hidden = true;
    setRegNote("זו הקמה ראשונית. המשתמש שייווצר יהיה מנהל הרשת.");
  } else {
    document.querySelector('[data-auth-tab="register"]').textContent = "הרשמה";
    document.getElementById("submitRegBtn").textContent = "הגש הרשמה";
    if (branchField) branchField.hidden = false;
  }
}

async function loadPublicBranches() {
  try {
    const data = await api("GET", "/api/public/branches");
    app.publicBranches = data.branches || [];
  } catch (e) {
    app.publicBranches = [];
  }
  const sel = document.getElementById("regBranchSelect");
  if (!sel) return;
  sel.innerHTML = app.publicBranches.length
    ? `<option value="">בחר סניף</option>` + app.publicBranches.map(b => `<option value="${b.id}">${b.name}${b.number ? " · " + b.number : ""}</option>`).join("")
    : `<option value="">אין סניפים זמינים</option>`;
}

// ── Initial data load ─────────────────────────────────────────────────────────
async function loadInitialData() {
  if (!app.user) return;
  await refreshCoreData();
}

async function refreshCoreData() {
  if (!app.user) return;
  try {
    const bd = await api("GET", `/api/branches?weekStart=${app.weekStart}`);
    app.branches = bd.branches || [];
    if (app.user.role !== "network-manager" && app.user.role !== "developer" && app.user.branchIds?.length) {
      app.branches = app.branches.filter(b => app.user.branchIds.includes(b.id));
    }
    if (app.currentBranch && !app.branches.some(b => b.id === app.currentBranch.id)) {
      app.currentBranch = null;
    }
    if (app.branches.length === 1 && !app.currentBranch && ["branch-manager","employee"].includes(app.user.role)) {
      app.currentBranch = app.branches[0];
    }
    if (app.user.role !== "employee") {
      const ud = await api("GET", "/api/users");
      app.users = ud.users || [];
      updatePendingBadge();
    }
  } catch (e) {
    console.warn("refreshCoreData error", e);
  }
}

async function ensurePortalWeekForRequests() {
  if (!app.currentBranch) return null;
  const ws = app.portalWeekStart || app.weekStart;
  if (app.currentWeek?.weekStart === ws && app.currentWeek?.branchId === app.currentBranch.id) {
    return app.currentWeek;
  }
  try {
    const res = await api("GET", `/api/weeks?branchId=${app.currentBranch.id}&weekStart=${ws}`);
    app.currentWeek = res.week;
    return app.currentWeek;
  } catch (e) {
    return null;
  }
}

function updatePendingBadge() {
  const badge = document.getElementById("pendingBadge");
  const pendingCount = app.users.filter(u => u.status === "pending").length;
  if (badge && pendingCount) {
    badge.textContent = pendingCount;
    badge.classList.remove("hidden");
  } else if (badge) {
    badge.classList.add("hidden");
  }
  const btn = document.getElementById("pendingEmployeesBtn");
  const count = document.getElementById("pendingEmployeesCount");
  if (btn && count) {
    count.textContent = pendingCount;
    count.hidden = pendingCount === 0;
    btn.classList.toggle("has-pending", pendingCount > 0);
    btn.classList.toggle("active", document.getElementById("statusFilter")?.value === "pending");
  }
}

// ── Schedule View ─────────────────────────────────────────────────────────────
async function loadWeekView(options = {}) {
  const ensureWeek = options.ensureWeek !== false;
  if (shouldPickBranchBeforeSchedule()) {
    renderBranchPickerForSchedule();
    return;
  }
  if (!app.currentBranch) {
    document.getElementById("weekGrid").innerHTML = `<div class="empty-state"><div class="empty-icon">🏪</div><div>אין סניף מוגדר. נא ליצור סניף תחילה.</div></div>`;
    return;
  }
  try {
    // Ensure week exists
    if (ensureWeek) {
      await api("POST", "/api/weeks", { branchId: app.currentBranch.id, weekStart: app.weekStart });
    }
    const data = await api("GET", `/api/weeks?branchId=${app.currentBranch.id}&weekStart=${app.weekStart}`);
    app.currentWeek = data.week;
    renderWeekGrid();
    renderDrawer();
    updateTopbarActions("schedule");
    if (app.openSelectedShiftAfterLoad) {
      const shift = app.currentWeek?.shifts?.find(s => s.id === app.selectedShiftId);
      app.openSelectedShiftAfterLoad = false;
      if (shift && window.matchMedia("(max-width: 900px)").matches) openScheduleShiftModal(shift);
    }
  } catch (e) {
    console.error("loadWeekView", e);
  }
}

function shouldPickBranchBeforeSchedule() {
  if (app.currentBranch) return false;
  if (app.user?.role === "employee") return false;
  return app.branches.length !== 1;
}

function renderBranchPickerForSchedule() {
  app.currentWeek = null;
  document.getElementById("weekRange").textContent = "בחר סניף";
  document.getElementById("scheduleBranchTitle").textContent = "סידור שבועי לפי סניף";
  document.getElementById("scheduleWeekTitle").textContent = "";
  document.getElementById("weekGrid").innerHTML = app.branches.map(b => `
    <button class="branch-card schedule-branch-card" type="button" onclick="openBranchSchedule(${b.id})">
      <h3>${b.name}${b.number ? " · " + b.number : ""}</h3>
      <div class="branch-card-meta">
        <span>אזור: ${b.area}</span>
        <span>מנהל: ${b.managerName || "לא שויך"}</span>
        <span>חוסרים השבוע: ${b.shortageCount || 0}</span>
      </div>
    </button>`).join("") || `<div class="empty-state"><div>אין סניפים. צור סניף במסך ניהול רשת.</div></div>`;
}

window.openBranchSchedule = function(branchId) {
  app.currentBranch = app.branches.find(b => b.id === branchId) || null;
  if (app.currentBranch) loadWeekView();
};

function renderWeekGrid() {
  const week = app.currentWeek;
  if (!week) return;
  document.getElementById("weekRange").textContent = weekRangeLabel(week.weekStart);
  document.getElementById("scheduleBranchTitle").textContent = `${app.currentBranch?.name || ""} · סידור שבועי`;
  document.getElementById("scheduleWeekTitle").textContent = weekRangeLabel(week.weekStart);
  renderScheduleDateStrip(week);

  const grid = document.getElementById("weekGrid");
  grid.innerHTML = "";
  const locked = week.status === "closed";

  DAY_KEYS.forEach((dk, i) => {
    const isoDate = addDays(week.weekStart, i);
    const holiday = holidayFor(isoDate, dk);
    const col = document.createElement("div");
    col.className = "day-col";
    col.id = `schedule-day-${dk}`;

    const morningShift = week.shifts?.find(s => s.dayKey === dk && s.slot === "morning");
    const eveningShift = week.shifts?.find(s => s.dayKey === dk && s.slot === "evening");
    const dayTarget = Math.max(Number(morningShift?.salesTarget || 0), Number(eveningShift?.salesTarget || 0));

    const morningFilled = morningShift && morningShift.staffed;
    const eveningFilled = eveningShift && eveningShift.staffed;
    const bothStaffed   = morningShift && eveningShift && morningFilled && eveningFilled;
    const partialStaffed = !bothStaffed && (morningFilled || eveningFilled);

    col.innerHTML = `
      <div class="day-head${bothStaffed ? " day-head--staffed" : partialStaffed ? " day-head--partial" : ""}">
        <div class="day-head-row">
          <span style="display:flex;align-items:center;gap:6px">
            <strong>${DAY_LABELS[dk]}</strong>
            ${holiday ? `<span class="tag tag-blue">${holiday}</span>` : ""}
          </span>
          <small>${dayLabel(week.weekStart, i)}</small>
        </div>
        <label class="day-sales-target">
          <span>יעד יומי</span>
          <input type="number" min="0" value="${dayTarget}" data-day-key="${dk}" />
        </label>
      </div>
      ${morningShift ? shiftCardHTML(morningShift, locked) : ""}
      ${eveningShift ? shiftCardHTML(eveningShift, locked) : ""}
    `;
    const targetInput = col.querySelector(".day-sales-target input");
    targetInput.disabled = locked || app.user?.role === "employee";
    targetInput.addEventListener("click", e => e.stopPropagation());
    targetInput.addEventListener("change", () => updateDayTarget(dk, Number(targetInput.value || 0)));
    col.querySelectorAll(".shift-card").forEach(card => {
      card.addEventListener("click", () => {
        if (locked) return;
        app.selectedShiftId = Number(card.dataset.shiftId);
        const shift = app.currentWeek?.shifts?.find(s => s.id === app.selectedShiftId);
        if (shift && window.matchMedia("(max-width: 900px)").matches) {
          openScheduleShiftModal(shift);
          return;
        }
        renderWeekGrid();
        renderDrawer();
      });
    });
    grid.appendChild(col);
  });
}

function renderScheduleDateStrip(week) {
  const strip = document.getElementById("scheduleDateStrip");
  if (!strip) return;
  strip.innerHTML = DAY_KEYS.map((dk, i) => {
    const iso = addDays(week.weekStart, i);
    const d = parseIso(iso);
    const shifts = (week.shifts || []).filter(s => s.dayKey === dk);
    const assignedCount = shifts.reduce((sum, s) => sum + shiftWorkerCount(s), 0);
    const hasShortage = shifts.some(s => remainingShortage(s) > 0);
    const isToday = iso === fmtDate(new Date());
    return `
      <button class="schedule-date-pill ${assignedCount ? "has-work" : ""} ${hasShortage ? "has-shortage" : ""} ${isToday ? "today" : ""}" type="button" data-day-key="${dk}">
        <span>${DAY_LABELS[dk]}</span>
        <strong>${d.getDate()}</strong>
      </button>`;
  }).join("");
  const pills = strip.querySelectorAll("[data-day-key]");
  pills.forEach(btn => {
    btn.addEventListener("click", () => {
      const col = document.getElementById(`schedule-day-${btn.dataset.dayKey}`);
      if (!col) return;
      col.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      pills.forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      centerScheduleDatePill(btn);
      requestAnimationFrame(updateScheduleDateStripDepth);
    });
  });
  if (!strip._scheduleDepthBound) {
    let stripRaf = 0;
    strip.addEventListener("scroll", () => {
      if (stripRaf) return;
      stripRaf = requestAnimationFrame(() => {
        stripRaf = 0;
        updateScheduleDateStripDepth();
      });
    }, { passive: true });
    strip._scheduleDepthBound = true;
  }

  // Track which day column is visible — sync active pill + day-col-active class
  requestAnimationFrame(() => {
    const grid = document.getElementById("weekGrid");
    if (!grid) return;
    const cols = grid.querySelectorAll(".day-col");
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        entry.target.classList.toggle("day-col-active", entry.isIntersecting && entry.intersectionRatio >= 0.5);
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          const dk = entry.target.id.replace("schedule-day-", "");
          pills.forEach(p => {
            const active = p.dataset.dayKey === dk;
            p.classList.toggle("active", active);
            if (active) centerScheduleDatePill(p);
          });
          requestAnimationFrame(updateScheduleDateStripDepth);
        }
      });
    }, { root: grid, threshold: 0.5 });
    cols.forEach(col => observer.observe(col));
    updateScheduleDateStripDepth();
  });
}

function centerScheduleDatePill(pill) {
  pill?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
}

function updateScheduleDateStripDepth() {
  const strip = document.getElementById("scheduleDateStrip");
  const pills = Array.from(document.querySelectorAll(".schedule-date-pill"));
  if (!strip || !pills.length) return;
  const stripRect = strip.getBoundingClientRect();
  const center = stripRect.left + stripRect.width / 2;
  const focusRadius = Math.max(stripRect.width * .34, 116);
  pills.forEach(btn => {
    const rect = btn.getBoundingClientRect();
    const btnCenter = rect.left + rect.width / 2;
    const distance = Math.min(Math.abs(btnCenter - center) / focusRadius, 1);
    const focus = 1 - (distance * distance);
    btn.style.setProperty("--schedule-day-scale", (.78 + focus * .28).toFixed(3));
    btn.style.setProperty("--schedule-day-opacity", (.42 + focus * .58).toFixed(3));
    btn.style.setProperty("--schedule-day-y", `${((1 - focus) * 9).toFixed(1)}px`);
  });
}

function availableUsersForShift(shift) {
  const assignedIds = new Set((shift.assignments || []).map(a => a.userId));
  let availUsers = (shift.availability || []).map(av => {
    const u = app.users.find(u => u.id === av.userId);
    return u ? { user: u, note: av.note } : null;
  }).filter(Boolean).filter(x => !assignedIds.has(x.user.id));
  const branchManager = app.currentBranch?.managerId
    ? app.users.find(u => u.id === app.currentBranch.managerId)
    : null;
  if (branchManager && !assignedIds.has(branchManager.id) && !availUsers.some(x => x.user.id === branchManager.id)) {
    availUsers = [{ user: branchManager, note: "מנהל סניף" }, ...availUsers];
  }
  if (app.user?.role === "branch-manager" && app.currentBranch && app.user.branchIds?.includes(app.currentBranch.id)) {
    const self = app.users.find(u => u.id === app.user.id) || app.user;
    if (!assignedIds.has(self.id) && !availUsers.some(x => x.user.id === self.id)) {
      availUsers = [{ user: self, note: "מנהל סניף" }, ...availUsers];
    }
  }
  return availUsers;
}

function canRequestCrossBranchReinforcement() {
  return app.user?.role === "network-manager" || app.user?.role === "area-manager";
}

function shiftInternalCount(shift) {
  return shift.assignments?.length || 0;
}

function shiftExternalCount(shift) {
  return Number(shift.reinforcement || 0);
}

function shiftWorkerCount(shift) {
  return shiftInternalCount(shift) + shiftExternalCount(shift);
}

function shiftWorkerCountLabel(shift) {
  return String(shiftWorkerCount(shift));
}

function shiftWorkerCountTitle(shift) {
  const internal = shiftInternalCount(shift);
  const external = shiftExternalCount(shift);
  return `${internal + external} עובדים${external ? ` (${internal}+כ״א ${external})` : ""}`;
}

async function renderReinforcementCandidates(shift, containerId, locked = false) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const section = container.closest(".drawer-section") || container.closest("section");
  if (!canRequestCrossBranchReinforcement() || !shift.shortage) {
    section?.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  section?.classList.remove("hidden");
  container.innerHTML = `<div class="empty-state" style="padding:12px">טוען עובדים פנויים...</div>`;
  try {
    const data = await api("GET", `/api/shifts/${shift.id}/reinforcement-candidates`);
    const candidates = data.candidates || [];
    if (!candidates.length) {
      container.innerHTML = `<div class="empty-state" style="padding:12px">אין עובדים פנויים מסניפים אחרים.</div>`;
      return;
    }
    const targetCount = Number(shift.shortage?.count || 0);
    container.innerHTML = `
      <div class="bulk-request-bar">
        <span>${targetCount ? `נדרש תגבור: ${targetCount}` : "אפשר לשלוח לכמה עובדים"}</span>
        <button class="btn btn-primary btn-xs" type="button" data-request-selected-reinforcement ${locked ? "disabled" : ""}>שלח למסומנים</button>
      </div>
      ${candidates.map(c => {
      const branches = (c.branches || []).map(b => b.name).join(", ");
      return `
        <div class="person-row">
          <div class="person-info">
            <label class="check-inline">
              <input type="checkbox" value="${c.id}" data-reinforcement-check ${locked || c.pending ? "disabled" : ""} />
              <strong>${c.fullName}</strong>
            </label>
            <small>${branches}${c.rank ? " · " + c.rank : ""}</small>
          </div>
          <button class="btn ${c.pending ? "btn-danger" : "btn-primary"} btn-xs" type="button" ${c.pending ? `data-cancel-reinforcement="${c.pendingRequestId}"` : `data-request-reinforcement="${c.id}"`} ${locked ? "disabled" : ""}>
            ${c.pending ? "בטל בקשה" : "בקש תגבור"}
          </button>
        </div>`;
    }).join("")}`;
    container.querySelectorAll("[data-request-reinforcement]").forEach(btn => {
      btn.addEventListener("click", async () => {
        await requestReinforcement(shift.id, Number(btn.dataset.requestReinforcement));
      });
    });
    container.querySelector("[data-request-selected-reinforcement]")?.addEventListener("click", async () => {
      const ids = [...container.querySelectorAll("[data-reinforcement-check]:checked")].map(x => Number(x.value));
      if (!ids.length) return alert("בחר עובדים לשליחת בקשת תגבור");
      await requestReinforcements(shift.id, ids);
    });
    container.querySelectorAll("[data-cancel-reinforcement]").forEach(btn => {
      btn.addEventListener("click", async () => {
        await cancelReinforcementRequest(Number(btn.dataset.cancelReinforcement), shift.id);
      });
    });
  } catch (e) {
    container.innerHTML = `<div class="empty-state" style="padding:12px">לא ניתן לטעון תגבור כרגע.</div>`;
  }
}

async function cancelReinforcementRequest(requestId, shiftId) {
  try {
    await api("PUT", `/api/requests/${requestId}`, { status: "rejected" });
    await loadWeekView();
    const updated = app.currentWeek?.shifts?.find(s => s.id === shiftId);
    if (updated && window.matchMedia("(max-width: 900px)").matches) openScheduleShiftModal(updated);
  } catch (e) {
    alert("שגיאה בביטול בקשת תגבור");
  }
}

async function requestReinforcement(shiftId, userId) {
  try {
    await api("POST", "/api/requests", {
      type: "reinforcement",
      shiftId,
      requesterId: userId,
      note: `בקשת תגבור עבור ${app.currentBranch?.name || "סניף"}`
    });
    await loadWeekView();
    const updated = app.currentWeek?.shifts?.find(s => s.id === shiftId);
    if (updated && window.matchMedia("(max-width: 900px)").matches) openScheduleShiftModal(updated);
  } catch (e) {
    const msg = e.data?.error === "already_requested" ? "כבר נשלחה בקשת תגבור לעובד הזה."
      : e.data?.error === "not_available" ? "העובד כבר לא פנוי למשמרת הזאת."
      : "שגיאה בשליחת בקשת תגבור.";
    alert(msg);
  }
}

async function requestReinforcements(shiftId, userIds) {
  const uniqueIds = [...new Set(userIds)];
  let sent = 0;
  let skipped = 0;
  for (const userId of uniqueIds) {
    try {
      await api("POST", "/api/requests", {
        type: "reinforcement",
        shiftId,
        requesterId: userId,
        note: `בקשת תגבור עבור ${app.currentBranch?.name || "סניף"}`
      });
      sent += 1;
    } catch (e) {
      skipped += 1;
    }
  }
  await loadWeekView();
  const updated = app.currentWeek?.shifts?.find(s => s.id === shiftId);
  if (updated && window.matchMedia("(max-width: 900px)").matches) openScheduleShiftModal(updated);
  alert(`נשלחו ${sent} בקשות${skipped ? `, ${skipped} לא נשלחו כי כבר קיימת בקשה או העובד לא פנוי` : ""}.`);
}

async function reopenScheduleShiftModal(shiftId) {
  await loadWeekView();
  const updated = app.currentWeek?.shifts?.find(s => s.id === shiftId);
  if (updated && window.matchMedia("(max-width: 900px)").matches) openScheduleShiftModal(updated);
}

async function setShiftStaffed(shift) {
  try {
    await api("PUT", `/api/shifts/${shift.id}`, { ...shift, staffed: !shift.staffed, shortage: shift.staffed ? shift.shortage : null });
    await loadWeekView();
  } catch (e) {
    alert("שגיאה בעדכון סימון מאויש");
  }
}

function openScheduleShiftModal(shift) {
  const locked = app.currentWeek?.status === "closed";
  const label = shift.slot === "morning" ? "בוקר" : "ערב";
  const assigned = shift.assignments || [];
  const workerCountText = shiftWorkerCountTitle(shift);
  const available = availableUsersForShift(shift);
  modal({
    kicker: `${app.currentBranch?.name || ""} · ${shift.hours}`,
    title: `${DAY_LABELS[shift.dayKey]} ${label}`,
    body: `
      <div class="mobile-shift-builder">
        <section>
          <div class="mobile-shift-builder-title">משובצים ${workerCountText}</div>
          <div id="modalAssignedList">
            ${assigned.length ? assigned.map(a => {
              const u = app.users.find(u => u.id === a.userId);
              if (!u) return "";
              const hours = (a.startTime && a.endTime) ? `${a.startTime}-${a.endTime}` : shift.hours;
              return `
                <div class="person-row">
                  <div class="person-info">
                    <strong>${u.fullName}</strong>
                    <small>${hours} · ${u.rank}${u.isLead ? " · אחמ\"ש" : ""}</small>
                  </div>
                  <div class="person-actions">
                    <button class="btn btn-ghost btn-xs" type="button" data-edit-assignment="${a.id}">שעות</button>
                    <button class="btn btn-danger btn-xs" type="button" data-remove-assignment="${a.id}">הסר</button>
                  </div>
                </div>`;
            }).join("") : `<div class="empty-state" style="padding:12px">אין משובצים עדיין.</div>`}
            ${shiftExternalCount(shift) ? `
              <div class="person-row">
                <div class="person-info">
                  <strong>כ״א חיצוני</strong>
                  <small>${shiftExternalCount(shift)} עובדים</small>
                </div>
                <span class="tag tag-blue">נספר במשמרת</span>
              </div>` : ""}
          </div>
        </section>
        <section>
          <div class="mobile-shift-builder-title">זמינים לשיבוץ</div>
          <div id="modalAvailableList">
            ${available.length ? available.map(({ user: u, note }) => `
              <div class="person-row">
                <div class="person-info">
                  <strong>${u.fullName}</strong>
                  <small>${u.rank}${note ? `<span class="avail-note"> · ${note}</span>` : ""}</small>
                </div>
                <button class="btn btn-primary btn-xs" type="button" data-assign-user="${u.id}">שבץ</button>
              </div>`).join("") : `<div class="empty-state" style="padding:12px">אין עובדים זמינים.</div>`}
          </div>
        </section>
        ${canRequestCrossBranchReinforcement() ? `
        <section>
          <div class="mobile-shift-builder-title">תגבור מסניפים אחרים</div>
          <div id="modalReinforcementCandidates"></div>
        </section>` : ""}
      </div>`,
    footer: `<button class="btn btn-primary" id="modalMarkStaffedBtn" type="button">${shift.staffed ? "בטל מאויש" : "סמן מאויש"}</button>
             <button class="btn btn-ghost" id="modalShortageBtn" type="button">${shift.shortage ? "סגור חוסר" : "דווח חוסר"}</button>
             <button class="btn btn-ghost" id="modalReinforcementBtn" type="button">כ״א</button>
             <button class="btn btn-ghost" id="cancelModalBtn">סגור</button>`
  });
  const modalStaffedBtn = document.getElementById("modalMarkStaffedBtn");
  modalStaffedBtn.disabled = locked;
  modalStaffedBtn.addEventListener("click", async () => {
    await setShiftStaffed(shift);
    await reopenScheduleShiftModal(shift.id);
  });
  const modalShortageBtn = document.getElementById("modalShortageBtn");
  modalShortageBtn.disabled = locked;
  modalShortageBtn.addEventListener("click", async () => {
    if (shift.shortage) {
      await api("PUT", `/api/shifts/${shift.id}`, { ...shift, shortage: null });
      await reopenScheduleShiftModal(shift.id);
    } else {
      openShortageModal(shift);
    }
  });
  const modalReinforcementBtn = document.getElementById("modalReinforcementBtn");
  modalReinforcementBtn.disabled = locked;
  modalReinforcementBtn.addEventListener("click", () => openReinforcementModal(shift));
  document.querySelectorAll("[data-assign-user]").forEach(btn => {
    btn.disabled = locked;
    btn.addEventListener("click", async () => {
      await assignEmployee(shift.id, Number(btn.dataset.assignUser), { reopenMobileShiftId: shift.id });
    });
  });
  document.querySelectorAll("[data-remove-assignment]").forEach(btn => {
    btn.disabled = locked;
    btn.addEventListener("click", async () => {
      try {
        await api("DELETE", `/api/assignments/${btn.dataset.removeAssignment}`);
        await reopenScheduleShiftModal(shift.id);
      } catch (e) {
        alert("שגיאה בהסרת שיבוץ");
      }
    });
  });
  document.querySelectorAll("[data-edit-assignment]").forEach(btn => {
    btn.disabled = locked;
    btn.addEventListener("click", () => {
      const assignment = assigned.find(a => a.id === Number(btn.dataset.editAssignment));
      const user = assignment ? app.users.find(u => u.id === assignment.userId) : null;
      if (assignment && user) openEditHoursModal(assignment, user, shift);
    });
  });
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
  renderReinforcementCandidates(shift, "modalReinforcementCandidates", locked);
}

async function updateDayTarget(dayKey, target) {
  const shifts = (app.currentWeek?.shifts || []).filter(s => s.dayKey === dayKey);
  try {
    await Promise.all(shifts.map(s => api("PUT", `/api/shifts/${s.id}`, { ...s, salesTarget: target })));
    await loadWeekView();
  } catch (e) {
    alert("שגיאה בשמירת יעד יומי");
  }
}

function remainingShortage(shift) {
  if (!shift.shortage) return 0;
  return Math.max(0, shift.shortage.count - (shift.approvedReinforcementCount || 0));
}

function shiftCardHTML(shift, locked) {
  const sel = app.selectedShiftId === shift.id ? "selected" : "";
  const rem = remainingShortage(shift);
  const warn = rem > 0 ? "warning" : "";
  const lck  = locked ? "locked" : "";
  const label = shift.slot === "morning" ? "בוקר" : "ערב";
  const icon  = shift.slot === "morning" ? "☀️" : "🌙";
  const countLabel = shiftWorkerCountLabel(shift);
  const countTitle = shiftWorkerCountTitle(shift);
  const assignedWorkers = (shift.assignments || []).map(a => {
    const u = app.users.find(u => u.id === a.userId);
    const isReinf = !!a.isReinforcement;
    const reinfBranch = isReinf
      ? (u?.branchIds || []).map(bid => app.branches.find(b => b.id === bid)?.name).filter(Boolean)
          .filter(name => name !== app.currentBranch?.name)[0] || ""
      : "";
    return {
      name: a.userName || u?.fullName || "עובד",
      rank: u?.rank || "",
      isReinforcement: isReinf,
      reinfBranch,
    };
  }).filter(w => w.name);
  const coworkerHtml = assignedWorkers.length
    ? `<div class="ep-coworker-carousel">
        ${assignedWorkers.map(w => `
          <div class="ep-coworker-item">
            <div class="ep-coworker-avatar${w.isReinforcement ? " ep-coworker-avatar--reinf" : ""}"><span class="ep-avatar-initials">${avatarInitials(w.name)}</span></div>
            <div class="ep-coworker-name">${w.name.split(" ")[0]}</div>
            ${w.isReinforcement && w.reinfBranch
              ? `<div class="ep-coworker-rank" style="color:#7c3aed">${w.reinfBranch}</div>`
              : (w.rank ? `<div class="ep-coworker-rank">${w.rank}</div>` : "")}
          </div>`).join("")}
      </div>`
    : `<div class="shift-empty-crew">אין משובצים</div>`;
  const shortageTag = shift.shortage
    ? (rem > 0
        ? `<span class="tag tag-yellow">חסר ${rem}</span>`
        : `<span class="tag tag-green">חוסר מכוסה ✓</span>`)
    : (shift.staffed ? `<span class="tag tag-green">מאויש</span>` : "");
  const reinforceTag = shift.reinforcement
    ? `<span class="tag tag-blue">כ״א ${shift.reinforcement}</span>` : "";
  return `
    <button class="shift-card ${sel} ${warn} ${lck}" data-shift-id="${shift.id}" type="button">
      <div class="shift-card-top">
        <div class="shift-title-line"><strong>${icon} ${label}</strong><small>${shift.hours}</small></div>
      </div>
      ${coworkerHtml}
      <div class="shift-bottom">
        <div class="shift-tags">${shortageTag}${reinforceTag}</div>
        <span class="shift-count" title="${countTitle}">${countLabel}</span>
      </div>
    </button>`;
}

function renderDrawer() {
  const week = app.currentWeek;
  if (!week) return;
  const shift = app.selectedShiftId
    ? week.shifts?.find(s => s.id === app.selectedShiftId)
    : week.shifts?.[0];
  if (!shift) return;
  if (!app.selectedShiftId) app.selectedShiftId = shift.id;

  const locked = week.status === "closed";
  const dayKey = shift.dayKey;
  const label  = shift.slot === "morning" ? "בוקר" : "ערב";

  document.getElementById("drawerTitle").textContent = `${DAY_LABELS[dayKey]} ${label}`;
  const drawerHours = document.getElementById("drawerHours");
  drawerHours.textContent = shift.hours;
  drawerHours.disabled = locked;
  drawerHours.onclick = locked ? null : () => openDefaultShiftHoursModal(shift);

  const dotEl = document.getElementById("drawerDot");
  const stEl  = document.getElementById("drawerStatusTag");
  const drawerRem = remainingShortage(shift);
  if (shift.shortage && drawerRem > 0) {
    dotEl.className = "dot dot-yellow";
    stEl.className  = "tag tag-yellow";
    stEl.textContent = `חסר ${drawerRem}`;
  } else if (shift.shortage && drawerRem === 0) {
    dotEl.className = "dot dot-green";
    stEl.className  = "tag tag-green";
    stEl.textContent = "חוסר מכוסה ✓";
  } else if (shift.staffed) {
    dotEl.className = "dot dot-green";
    stEl.className  = "tag tag-green";
    stEl.textContent = "מאויש";
  } else {
    dotEl.className = "dot dot-blue";
    stEl.className  = "tag tag-muted";
    stEl.textContent = "לא סומן";
  }

  // Shortage bar
  const shortageBar = document.getElementById("drawerShortage");
  if (shift.shortage) {
    shortageBar.classList.remove("hidden");
    const coveredText = drawerRem === 0 ? " · כוסה על ידי תגבורים" : ` · נותר ${drawerRem}`;
    document.getElementById("shortageText").textContent =
      `חסר ${shift.shortage.count}${coveredText} · ${shift.shortage.level} · ${shift.shortage.status}`;
  } else {
    shortageBar.classList.add("hidden");
  }

  // Toggle shortage btn
  const tBtn = document.getElementById("toggleShortageBtn");
  tBtn.textContent = shift.shortage ? "סגור חוסר" : "דווח חוסר";
  tBtn.disabled = locked;

  const staffedBtn = document.getElementById("markStaffedBtn");
  staffedBtn.textContent = shift.staffed ? "בטל מאויש" : "סמן מאויש";
  staffedBtn.disabled = locked;

  document.getElementById("addReinforcementBtn").disabled = locked;

  // Assigned
  const assignedList = document.getElementById("assignedList");
  assignedList.innerHTML = "";
  document.getElementById("assignedTotal").textContent = shiftWorkerCountTitle(shift);

  (shift.assignments || []).forEach(a => {
    const u = app.users.find(u => u.id === a.userId);
    if (!u) return;
    const hours = (a.startTime && a.endTime) ? `${a.startTime}–${a.endTime}` : shift.hours;
    const reinfBranches = a.isReinforcement
      ? (u.branchIds || []).map(bid => app.branches.find(b => b.id === bid)?.name).filter(Boolean)
          .filter(name => name !== app.currentBranch?.name).join(", ")
      : "";
    const row = document.createElement("div");
    row.className = "person-row";
    row.innerHTML = `
      <div class="person-info">
        <strong>${u.fullName}</strong>
        <small>${hours} · ${u.rank}${u.isLead ? " · אחמ\"ש" : ""}${reinfBranches ? ` · <span class="reinf-branch-tag">מתגבר מ${reinfBranches}</span>` : ""}</small>
      </div>
      <div class="person-actions">
        <button class="btn btn-ghost btn-xs edit-hours-btn" data-aid="${a.id}" data-hours="${hours}" type="button">שעות</button>
        <button class="btn btn-ghost btn-xs remove-btn" data-aid="${a.id}" type="button">הסר</button>
      </div>`;
    row.querySelectorAll("button").forEach(b => b.disabled = locked);
    row.querySelector(".edit-hours-btn").addEventListener("click", () => openEditHoursModal(a, u, shift));
    row.querySelector(".remove-btn").addEventListener("click", () => removeAssignment(a.id));
    assignedList.appendChild(row);
  });
  if (shiftExternalCount(shift)) {
    const row = document.createElement("div");
    row.className = "person-row";
    row.innerHTML = `
      <div class="person-info">
        <strong>כ״א חיצוני</strong>
        <small>${shiftExternalCount(shift)} עובדים</small>
      </div>
      <span class="tag tag-blue">נספר במשמרת</span>`;
    assignedList.appendChild(row);
  }

  // Available
  const availableList = document.getElementById("availableList");
  availableList.innerHTML = "";
  const assignedIds = new Set((shift.assignments || []).map(a => a.userId));
  let availUsers = (shift.availability || []).map(av => {
    const u = app.users.find(u => u.id === av.userId);
    return u ? { user: u, note: av.note } : null;
  }).filter(Boolean).filter(x => !assignedIds.has(x.user.id));
  const branchManager = app.currentBranch?.managerId
    ? app.users.find(u => u.id === app.currentBranch.managerId)
    : null;
  if (branchManager && !assignedIds.has(branchManager.id) && !availUsers.some(x => x.user.id === branchManager.id)) {
    availUsers = [{ user: branchManager, note: "מנהל סניף" }, ...availUsers];
  }
  if (app.user?.role === "branch-manager" && app.currentBranch && app.user.branchIds?.includes(app.currentBranch.id)) {
    const self = app.users.find(u => u.id === app.user.id) || app.user;
    if (!assignedIds.has(self.id) && !availUsers.some(x => x.user.id === self.id)) {
      availUsers = [{ user: self, note: "מנהל סניף" }, ...availUsers];
    }
  }

  if (!availUsers.length) {
    availableList.innerHTML = `<div class="empty-state" style="padding:12px">אין עובדים שהגישו זמינות</div>`;
  } else {
    availUsers.forEach(({ user: u, note }) => {
      const row = document.createElement("div");
      row.className = "person-row";
      row.innerHTML = `
        <div class="person-info">
          <strong>${u.fullName}</strong>
          <small>${u.rank}${note ? `<span class="avail-note"> · ${note}</span>` : ""}</small>
        </div>
        <button class="btn btn-primary btn-xs assign-btn" type="button">שבץ</button>`;
      row.querySelector(".assign-btn").disabled = locked;
      row.querySelector(".assign-btn").addEventListener("click", () => assignEmployee(shift.id, u.id));
      availableList.appendChild(row);
    });
  }
  renderReinforcementCandidates(shift, "reinforcementCandidates", locked);
}

async function assignEmployee(shiftId, userId, options = {}) {
  try {
    await api("POST", "/api/assignments", { shiftId, userId });
    if (options.reopenMobileShiftId && window.matchMedia("(max-width: 900px)").matches) {
      await reopenScheduleShiftModal(options.reopenMobileShiftId);
    } else {
      await loadWeekView();
    }
  } catch (e) {
    if (e.status === 409 && e.data?.error === "taxi_response_required") {
      openTaxiResponseRequiredModal(shiftId, userId, e.data, options);
      return;
    }
    alert("לא ניתן לשבץ: " + (e.data?.error || e.message));
  }
}

function openTaxiResponseRequiredModal(shiftId, userId, data, assignOptions = {}) {
  const rows = (data.requests || []).map(r => {
    const label = r.direction === "arrival" ? "מונית הגעה" : "מונית חזור";
    return `
      <div class="data-row">
        <div class="data-row-main">
          <strong>${label}</strong>
          <small>${r.note || "בקשת מונית שבת ממתינה למענה"}</small>
        </div>
        <button class="btn btn-success btn-xs" data-taxi-answer="${r.id}" data-status="approved">אשר</button>
        <button class="btn btn-danger btn-xs" data-taxi-answer="${r.id}" data-status="rejected">דחה</button>
      </div>`;
  }).join("");
  modal({
    kicker: "נדרש מענה לפני שיבוץ",
    title: data.userName || "בקשת מונית שבת",
    body: `<p class="text-muted">העובד ביקש מונית לשבת. יש לאשר או לדחות את הבקשה לפני השיבוץ.</p>${rows}`,
    footer: `<button class="btn btn-primary" id="retryTaxiAssignBtn">נסה לשבץ שוב</button>
             <button class="btn btn-ghost" id="cancelModalBtn">סגור</button>`
  });
  document.querySelectorAll("[data-taxi-answer]").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await api("PUT", `/api/requests/${btn.dataset.taxiAnswer}`, { status: btn.dataset.status });
      btn.closest(".data-row")?.remove();
    });
  });
  document.getElementById("retryTaxiAssignBtn").addEventListener("click", async () => {
    closeModal();
    await assignEmployee(shiftId, userId, assignOptions);
  });
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
}

async function removeAssignment(assignmentId) {
  try {
    await api("DELETE", `/api/assignments/${assignmentId}`);
    await loadWeekView();
  } catch (e) {
    alert("שגיאה בהסרת שיבוץ");
  }
}

function openEditHoursModal(assignment, user, shift) {
  const [start, end] = (assignment.startTime && assignment.endTime)
    ? [assignment.startTime, assignment.endTime]
    : shift.hours.split("-");
  modal({
    kicker: "שעות משמרת",
    title:  `עדכון שעות · ${user.fullName}`,
    body: `
      <div class="form-grid">
        <div class="field"><label>שעת התחלה</label><input class="time24-input" type="text" id="assignStart" value="${start}" placeholder="08:00" inputmode="numeric" /></div>
        <div class="field"><label>שעת סיום</label><input class="time24-input" type="text" id="assignEnd" value="${end}" placeholder="17:00" inputmode="numeric" /></div>
      </div>`,
    footer: `<button class="btn btn-primary" id="saveAssignHours">שמור</button>
             <button class="btn btn-ghost" id="cancelModalBtn">ביטול</button>`
  });
  document.getElementById("saveAssignHours").addEventListener("click", async () => {
    const s = document.getElementById("assignStart").value;
    const e = document.getElementById("assignEnd").value;
    if (!isValidTime24(s) || !isValidTime24(e)) return alert("השעה צריכה להיות בפורמט 24 שעות, למשל 08:00");
    await api("PUT", `/api/assignments/${assignment.id}`, { startTime: s, endTime: e });
    closeModal();
    await loadWeekView();
  });
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
}

function isValidTime24(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "").trim());
}

function openDefaultShiftHoursModal(shift) {
  const [start, end] = shift.hours.split("-");
  const label = shift.slot === "morning" ? "בוקר" : "ערב";
  modal({
    kicker: "ברירת מחדל",
    title: `שעות ${DAY_LABELS[shift.dayKey]} ${label}`,
    body: `
      <div class="notice notice-info">השינוי יעדכן את המשמרת הזו ואת כל השבועות הפתוחים מאותו שבוע והלאה.</div>
      <div class="form-grid mt-3">
        <div class="field"><label>שעת התחלה</label><input class="time24-input" type="text" id="defaultShiftStart" value="${start}" placeholder="08:00" inputmode="numeric" /></div>
        <div class="field"><label>שעת סיום</label><input class="time24-input" type="text" id="defaultShiftEnd" value="${end}" placeholder="17:00" inputmode="numeric" /></div>
      </div>`,
    footer: `<button class="btn btn-primary" id="saveDefaultShiftHours">שמור כברירת מחדל</button>
             <button class="btn btn-ghost" id="cancelModalBtn">ביטול</button>`
  });
  document.getElementById("saveDefaultShiftHours").addEventListener("click", async () => {
    const s = document.getElementById("defaultShiftStart").value;
    const e = document.getElementById("defaultShiftEnd").value;
    if (!s || !e) return alert("צריך למלא שעת התחלה ושעת סיום");
    if (!isValidTime24(s) || !isValidTime24(e)) return alert("השעה צריכה להיות בפורמט 24 שעות, למשל 08:00");
    try {
      await api("POST", "/api/shift-defaults", {
        shiftId: shift.id,
        branchId: app.currentBranch.id,
        dayKey: shift.dayKey,
        slot: shift.slot,
        hours: `${s}-${e}`,
        effectiveWeekStart: app.currentWeek.weekStart,
      });
      closeModal();
      await loadWeekView();
    } catch (err) {
      alert("שגיאה בשמירת שעות ברירת מחדל: " + (err.data?.error || err.message));
    }
  });
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
}

async function toggleWeekPublish() {
  if (!app.currentWeek) return;
  const s = app.currentWeek.status;
  const next = s === "published" ? "draft" : (s === "closed" ? "published" : "published");
  await api("PUT", `/api/weeks/${app.currentWeek.id}`, { status: next });
  await loadWeekView();
}

async function closeWeek() {
  if (!app.currentWeek) return;
  await api("PUT", `/api/weeks/${app.currentWeek.id}`, { status: "closed" });
  await loadWeekView();
}

function openShortageModal(shift) {
  modal({
    kicker: "דיווח חוסר",
    title:  "פתיחת חוסר למשמרת",
    body: `
      <div class="form-grid">
        <div class="field"><label>כמות חסרה</label><input type="number" id="shortageCount" min="1" value="1" /></div>
        <div class="field"><label>רמה נדרשת</label>
          <select id="shortageLevel"><option>מוכרן</option><option>קופאי</option><option>אחמ"ש</option></select>
        </div>
        <div class="field full"><label>הערה</label><textarea id="shortageNote" placeholder="הערה לחוסר"></textarea></div>
      </div>`,
    footer: `<button class="btn btn-primary" id="saveShortage">דווח חוסר</button>
             <button class="btn btn-ghost" id="cancelModalBtn">ביטול</button>`
  });
  document.getElementById("saveShortage").addEventListener("click", async () => {
    const count = Number(document.getElementById("shortageCount").value);
    const level = document.getElementById("shortageLevel").value;
    const note  = document.getElementById("shortageNote").value;
    await api("PUT", `/api/shifts/${shift.id}`, {
      ...shift,
      staffed: false,
      shortage: { count, level, status: "פתוח", note }
    });
    closeModal();
    await loadWeekView();
  });
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
}

function openReinforcementModal(shift) {
  modal({
    kicker: "כוח אדם",
    title: "סימון עובדי כ״א חיצוניים",
    body: `
      <div class="form-grid">
        <div class="field"><label>כמות כ״א</label><input type="number" id="reinforcementCount" min="0" value="${shift.reinforcement || 1}" /></div>
      </div>`,
    footer: `<button class="btn btn-primary" id="saveReinforcement">שמור</button>
             <button class="btn btn-ghost" id="cancelModalBtn">ביטול</button>`
  });
  document.getElementById("saveReinforcement").addEventListener("click", async () => {
    const count = Number(document.getElementById("reinforcementCount").value);
    await api("PUT", `/api/shifts/${shift.id}`, { ...shift, reinforcement: count });
    closeModal();
    await loadWeekView();
  });
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
}

// ── Employees View ────────────────────────────────────────────────────────────
async function renderEmployees() {
  const search  = document.getElementById("employeeSearch").value.trim().toLowerCase();
  const rank    = document.getElementById("rankFilter").value;
  const status  = document.getElementById("statusFilter").value;

  let users = app.users;
  if (status !== "all") users = users.filter(u => u.status === status);
  else users = users.filter(u => u.status !== "pending");

  if (search) users = users.filter(u =>
    u.fullName.includes(search) || (u.idNumber || "").includes(search)
  );
  if (rank === "managers") users = users.filter(u => u.role !== "employee");
  else if (rank !== "all") users = users.filter(u => u.rank === rank);

  updatePendingBadge();

  const list = document.getElementById("employeeList");
  list.innerHTML = "";

  if (!users.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">👤</div><div>לא נמצאו עובדים</div></div>`;
    return;
  }

  users.forEach(u => {
    const btn = document.createElement("button");
    btn.className = "employee-item";
    btn.type = "button";
    const tagClass = u.status === "pending" ? "tag-yellow" : (u.role !== "employee" ? "tag-green" : (u.isLead ? "tag-blue" : "tag-accent"));
    const tagLabel = u.status === "pending" ? "ממתין" : (u.role !== "employee" ? "מנהל" : (u.isLead ? "אחמ\"ש" : u.rank));
    btn.innerHTML = `
      <div style="flex:1;min-width:0">
        <strong>${u.fullName}</strong>
        <small>${u.idNumber || ""}</small>
      </div>
      <span class="tag ${tagClass}">${tagLabel}</span>`;
    btn.addEventListener("click", () => showEmployeeDetail(u.id));
    list.appendChild(btn);
  });
}

function showEmployeeDetail(userId) {
  // Highlight selected
  document.querySelectorAll(".employee-item").forEach(b => b.classList.remove("active"));
  const u = app.users.find(x => x.id === userId);
  if (!u) return;

  const detail = document.getElementById("employeeDetail");
  const tagClass = u.status === "pending" ? "tag-yellow" : u.status === "inactive" ? "tag-red" : "tag-green";
  const tagLabel = u.status === "pending" ? "ממתין לאישור" : u.status === "inactive" ? "לא פעיל" : "פעיל";

  const isSelf = u.id === app.user?.id;
  const canManage = canManageUser(u);
  const isLastNetworkManager = u.role === "network-manager" && u.status === "active" &&
    app.users.filter(x => x.role === "network-manager" && x.status === "active").length <= 1;
  const branchNames = employeeBranchNames(u);

  detail.innerHTML = `
    <div class="employee-card-header">
      <div class="employee-avatar" style="${u.status === "inactive" ? "opacity:.45;filter:grayscale(1)" : ""}">${(u.fullName||"?")[0]}</div>
      <div>
        <h2>${u.fullName}</h2>
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
          <span class="tag ${tagClass}">${tagLabel}</span>
          <small class="text-muted">${u.role !== "employee" ? "מנהל" : roleLabel(u.role)}</small>
        </div>
      </div>
    </div>
    <div class="profile-grid">
      <div class="field-card"><span>תעודת זהות</span><strong>${u.idNumber || "—"}</strong></div>
      <div class="field-card"><span>טלפון</span><strong>${u.phone || "—"}</strong></div>
      <div class="field-card"><span>מייל</span><strong>${u.email || "—"}</strong></div>
      <div class="field-card"><span>שכר שעתי</span><strong>${u.hourlyWage ? `₪${u.hourlyWage}` : "—"}</strong></div>
      <div class="field-card"><span>דרגה</span><strong>${u.rank || "מוכרן"}</strong></div>
      <div class="field-card"><span>אחמ"ש</span><strong>${u.isLead ? "כן" : "לא"}</strong></div>
      <div class="field-card"><span>סניפים משויכים</span><strong>${branchNames || "—"}</strong></div>
    </div>
    <div class="profile-grid employee-insight-grid" id="employeeInsightGrid" data-user-id="${u.id}">
      <div class="field-card"><span>זמינות השבוע</span><strong>טוען...</strong></div>
      <div class="field-card"><span>שיבוצים השבוע</span><strong>טוען...</strong></div>
      <div class="field-card"><span>בקשות פתוחות</span><strong>טוען...</strong></div>
      <div class="field-card"><span>שעות עבודה</span><strong>טוען...</strong></div>
      <div class="field-card field-card-wide"><span>הערת מנהל פנימית</span><strong>${escapeHtml(u.managerNote || "אין הערה")}</strong></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${canManage && u.status === "pending" ? `<button class="btn btn-success btn-sm" onclick="approveEmployee(${u.id})">✓ אשר הרשמה</button>` : ""}
      ${canManage ? `<button class="btn btn-ghost btn-sm" onclick="openEditEmployeeModal(${u.id})">✏️ עריכה</button>` : ""}
      ${canManage && !isSelf && !isLastNetworkManager && u.status !== "pending" ? `
        <button class="btn ${u.status === "inactive" ? "btn-success" : "btn-warning"} btn-sm"
          onclick="toggleEmployeeStatus(${u.id})">
          ${u.status === "inactive" ? "✓ הפעל חשבון" : "⏸ השהה חשבון"}
        </button>` : ""}
      ${canManage && !isSelf && !isLastNetworkManager ? `<button class="btn btn-danger btn-sm" onclick="deleteEmployee(${u.id})">🗑 מחק עובד</button>` : ""}
    </div>`;
  loadEmployeeInsights(userId);
}

function employeeBranchNames(user) {
  return (user.branchIds || [])
    .map(id => app.branches.find(b => b.id === id))
    .filter(Boolean)
    .map(b => b.number ? `${b.name} · ${b.number}` : b.name)
    .join(", ");
}

function employeeMetricBranches(user) {
  if (user.branchIds?.length) return user.branchIds;
  return user.role === "employee" ? [] : app.branches.map(b => b.id);
}

async function fetchWeekSafe(branchId, weekStart) {
  try {
    const data = await api("GET", `/api/weeks?branchId=${branchId}&weekStart=${weekStart}`);
    return data.week || null;
  } catch {
    return null;
  }
}

function employeeShiftStats(weeks, userId, dateFilter = null) {
  let availability = 0;
  let assignments = 0;
  let hours = 0;
  (weeks || []).filter(Boolean).forEach(week => {
    (week.shifts || []).forEach(shift => {
      if (dateFilter) {
        const dayIndex = DAY_KEYS.indexOf(shift.dayKey);
        const shiftDate = dayIndex >= 0 ? addDays(week.weekStart, dayIndex) : "";
        if (!dateFilter(shiftDate)) return;
      }
      if ((shift.availability || []).some(a => a.userId === userId)) availability += 1;
      if ((shift.assignments || []).some(a => a.userId === userId)) {
        assignments += 1;
        hours += shiftHoursDuration(shift.hours);
      }
    });
  });
  return { availability, assignments, hours };
}

function openRequestTypeSummary(requests) {
  const labels = { hours: "שעות", swap: "חילוף", exit: "יציאה", taxi: "מונית", reinforcement: "תגבור" };
  const counts = {};
  requests.forEach(r => counts[r.type] = (counts[r.type] || 0) + 1);
  return Object.entries(counts)
    .map(([type, count]) => `${labels[type] || type}: ${count}`)
    .join(" · ");
}

async function loadEmployeeInsights(userId) {
  const grid = document.getElementById("employeeInsightGrid");
  if (!grid || Number(grid.dataset.userId) !== userId) return;
  const user = app.users.find(u => u.id === userId);
  if (!user) return;
  const branchIds = employeeMetricBranches(user);
  try {
    const currentWeekStart = app.weekStart || todayWeekStart();
    const weekData = await Promise.all(branchIds.map(id => fetchWeekSafe(id, currentWeekStart)));
    const weekStats = employeeShiftStats(weekData, userId);

    const monthStarts = monthWeekStarts();
    const monthWeeks = await Promise.all(
      branchIds.flatMap(id => monthStarts.map(ws => fetchWeekSafe(id, ws)))
    );
    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-`;
    const monthStats = employeeShiftStats(monthWeeks, userId, shiftDate => shiftDate.startsWith(monthPrefix));

    let openRequests = [];
    try {
      const requestData = await api("GET", "/api/requests");
      openRequests = (requestData.requests || []).filter(r => r.requesterId === userId && r.status === "open");
    } catch {}

    if (!grid || Number(grid.dataset.userId) !== userId) return;
    const requestSummary = openRequests.length ? openRequestTypeSummary(openRequests) : "אין בקשות פתוחות";
    grid.innerHTML = `
      <div class="field-card"><span>זמינות השבוע</span><strong>${weekStats.availability} משמרות</strong></div>
      <div class="field-card"><span>שיבוצים השבוע</span><strong>${weekStats.assignments} משמרות · ${fmtHoursCount(weekStats.hours)} ש׳</strong></div>
      <div class="field-card"><span>בקשות פתוחות</span><strong>${openRequests.length}</strong><small>${escapeHtml(requestSummary)}</small></div>
      <div class="field-card"><span>שעות עבודה</span><strong>${fmtHoursCount(weekStats.hours)} ש׳ השבוע</strong><small>${fmtHoursCount(monthStats.hours)} ש׳ החודש</small></div>
      <div class="field-card field-card-wide"><span>הערת מנהל פנימית</span><strong>${escapeHtml(user.managerNote || "אין הערה")}</strong></div>`;
  } catch (e) {
    if (!grid || Number(grid.dataset.userId) !== userId) return;
    grid.innerHTML = `<div class="field-card field-card-wide"><span>מידע נוסף</span><strong>לא ניתן לטעון כרגע</strong></div>`;
  }
}

window.deleteEmployee = async function(userId) {
  const u = app.users.find(x => x.id === userId);
  if (!u) return;
  if (!confirm(`למחוק את ${u.fullName}? העובד יוסר מהרשימה אך ההיסטוריה שלו תישמר.`)) return;
  try {
    await api("DELETE", `/api/users/${userId}`);
    const ud = await api("GET", "/api/users");
    app.users = ud.users || [];
    document.getElementById("employeeDetail").innerHTML = "";
    renderEmployees();
  } catch(e) {
    if (e.data?.error === "cannot_delete_self") alert("לא ניתן למחוק את עצמך.");
    else if (e.data?.error === "last_network_manager") alert("לא ניתן למחוק את מנהל הרשת היחיד. יש להוסיף מנהל רשת אחר תחילה.");
    else alert("שגיאה במחיקת העובד: " + (e.data?.error || e.message));
  }
};

window.toggleEmployeeStatus = async function(userId) {
  const u = app.users.find(x => x.id === userId);
  if (!u) return;
  const activate = u.status === "inactive";
  const msg = activate
    ? `להפעיל מחדש את חשבון ${u.fullName}? הם יוכלו להתחבר שוב.`
    : `להשהות את חשבון ${u.fullName}? הם לא יוכלו להתחבר כל עוד החשבון מושהה.`;
  if (!confirm(msg)) return;
  try {
    await api("PUT", `/api/users/${userId}`, { status: activate ? "active" : "inactive" });
    const ud = await api("GET", "/api/users");
    app.users = ud.users || [];
    renderEmployees();
    window.showEmployeeDetail?.(userId);
  } catch(e) {
    alert("שגיאה בעדכון סטטוס העובד");
  }
};

window.approveEmployee = async function(userId) {
  try {
    await api("POST", "/api/users/approve", { userId });
    const ud = await api("GET", "/api/users");
    app.users = ud.users || [];
    renderEmployees();
  } catch (e) {
    alert("שגיאה באישור עובד");
  }
};

window.openEditEmployeeModal = function(userId) {
  const u = app.users.find(x => x.id === userId);
  if (!u) return;
  if (!canManageUser(u)) {
    alert("אין לך הרשאה לערוך משתמש בתפקיד הזה.");
    return;
  }
  const roleOptions = ["employee", "branch-manager", "area-manager", "network-manager"]
    .filter(role => canManageUser(u, role) || role === u.role)
    .map(role => `<option value="${role}" ${u.role === role ? "selected" : ""}>${roleLabel(role)}</option>`)
    .join("");
  const branchChecks = app.branches.map(b => `
    <label class="check-row">
      <input type="checkbox" value="${b.id}" ${(u.branchIds || []).includes(b.id) ? "checked" : ""} />
      <span>${b.name}${b.number ? " · " + b.number : ""}</span>
    </label>`).join("") || `<div class="text-muted">אין סניפים לשיוך.</div>`;
  modal({
    kicker: "עובדים",
    title: `עריכת עובד · ${u.fullName}`,
    body: `
      <div class="form-grid">
        <div class="field"><label>שם מלא</label><input id="eu-name" value="${u.fullName}" /></div>
        <div class="field"><label>תעודת זהות</label><input id="eu-id" value="${u.idNumber||""}" /></div>
        <div class="field"><label>טלפון</label><input id="eu-phone" value="${u.phone||""}" /></div>
        <div class="field"><label>מייל</label><input type="email" id="eu-email" value="${u.email}" /></div>
        <div class="field"><label>שכר שעתי (₪)</label><input type="number" id="eu-wage" value="${u.hourlyWage||0}" /></div>
        <div class="field"><label>דרגה</label>
          <select id="eu-rank">
            <option ${u.rank==="מוכרן"?"selected":""}>מוכרן</option>
            <option ${u.rank==="קופאי"?"selected":""}>קופאי</option>
          </select>
        </div>
        <div class="field"><label>תפקיד</label>
          <select id="eu-role">
            ${roleOptions}
          </select>
        </div>
        <div class="field" style="flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" id="eu-lead" ${u.isLead?"checked":""} style="width:auto" />
          <label style="margin:0">מסומן כאחמ"ש</label>
        </div>
        <div class="field full"><label>סניפים משויכים</label><div class="check-list" id="eu-branches">${branchChecks}</div></div>
        <div class="field full"><label>הערת מנהל פנימית</label><textarea id="eu-note" placeholder="מידע פנימי למנהלים בלבד">${escapeHtml(u.managerNote || "")}</textarea></div>
      </div>`,
    footer: `<button class="btn btn-primary" id="saveEU">שמור</button>
             <button class="btn btn-ghost" id="cancelModalBtn">ביטול</button>`
  });
  document.getElementById("saveEU").addEventListener("click", async () => {
    try {
      await api("PUT", `/api/users/${userId}`, {
        fullName:   document.getElementById("eu-name").value,
        idNumber:   document.getElementById("eu-id").value,
        phone:      document.getElementById("eu-phone").value,
        email:      document.getElementById("eu-email").value,
        hourlyWage: Number(document.getElementById("eu-wage").value),
        rank:       document.getElementById("eu-rank").value,
        role:       document.getElementById("eu-role").value,
        isLead:     document.getElementById("eu-lead").checked,
        managerNote: document.getElementById("eu-note").value,
        branchIds:   [...document.querySelectorAll("#eu-branches input:checked")].map(x => Number(x.value)),
      });
      const ud = await api("GET", "/api/users");
      app.users = ud.users || [];
      closeModal();
      renderEmployees();
      showEmployeeDetail(userId);
    } catch (e) {
      if (e.data?.error === "role_hierarchy_forbidden") alert("אין לך הרשאה לערוך משתמש בתפקיד הזה.");
      else alert("שגיאה בשמירה");
    }
  });
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
};

// ── Requests View ─────────────────────────────────────────────────────────────
async function loadRequests() {
  try {
    await refreshCoreData();
    loadNotificationSettings();
    const selectedBranchId = renderRequestsBranchSelect();
    const data = await api("GET", "/api/requests");
    const requests = data.requests || [];
    const badge = document.getElementById("requestsBadge");
    const open = requests.filter(r => r.status === "open");
    if (open.length) {
      badge.textContent = open.length;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
    const visibleRequests = selectedBranchId
      ? requests.filter(r => Number(r.branch?.id || r.branchId || 0) === selectedBranchId)
      : requests;
    renderTimeRequestGroups(visibleRequests.filter(r => r.type === "hours"));
    renderRequestList("swapRequests",  visibleRequests.filter(r => r.type === "swap"));
    renderRequestList("exitRequests",  visibleRequests.filter(r => r.type === "exit"));
    renderRequestList("taxiRequests",  visibleRequests.filter(r => r.type === "taxi"));
    const week = await loadRequestsShortageWeek(selectedBranchId);
    renderShortageRequests(week, selectedBranchId);
  } catch (e) {
    console.warn("loadRequests", e);
  }
}

let currentRequests = [];

function renderRequestsBranchSelect() {
  const sel = document.getElementById("requestsBranchSelect");
  if (!sel) return app.currentBranch?.id || app.branches[0]?.id || null;
  const branches = app.branches || [];
  if (!branches.length) {
    sel.innerHTML = `<option value="">אין סניפים</option>`;
    sel.disabled = true;
    app.requestsBranchId = null;
    return null;
  }
  const previous = Number(sel.value || app.requestsBranchId || app.currentBranch?.id || 0);
  const selected = branches.some(b => b.id === previous) ? previous : branches[0].id;
  app.requestsBranchId = selected;
  sel.innerHTML = branches.map(b => `
    <option value="${b.id}" ${b.id === selected ? "selected" : ""}>${b.name}${b.number ? " · " + b.number : ""}</option>
  `).join("");
  sel.disabled = branches.length === 1;
  sel.closest(".page-header-actions")?.classList.toggle("hidden", branches.length <= 1 && app.user?.role === "branch-manager");
  return selected;
}

async function loadRequestsShortageWeek(branchId) {
  if (!branchId) return null;
  try {
    const data = await api("GET", `/api/weeks?branchId=${branchId}&weekStart=${app.weekStart}`);
    return data.week || null;
  } catch (e) {
    if (e.status !== 404) console.warn("loadRequestsShortageWeek", e);
    return null;
  }
}

function reminderSlotHTML(slot = { day: 1, time: "18:00" }) {
  const options = WEEKDAY_OPTIONS.map(d =>
    `<option value="${d.value}" ${Number(slot.day) === d.value ? "selected" : ""}>${d.label}</option>`
  ).join("");
  return `
    <div class="notification-slot-row">
      <select class="reminder-day">${options}</select>
      <input type="time" class="reminder-time" value="${slot.time || "18:00"}" />
      <button class="btn btn-ghost btn-xs" type="button" data-remove-reminder>הסר</button>
    </div>`;
}

function renderNotificationSettings(settings) {
  document.getElementById("availabilityReminderEnabled").checked = !!settings.availabilityRemindersEnabled;
  document.getElementById("availabilityReminderSlots").innerHTML =
    (settings.availabilityReminderSlots || []).map(reminderSlotHTML).join("") || reminderSlotHTML();
  document.getElementById("managerDigestEnabled").checked = !!settings.managerDigestEnabled;
  document.getElementById("managerDigestTime").value = settings.managerDigestTime || "09:00";
}

async function loadNotificationSettings() {
  const card = document.querySelector("#requestsView .notification-settings-card");
  if (!card || card.dataset.loaded === "1") return;
  try {
    const data = await api("GET", "/api/settings/notifications");
    renderNotificationSettings(data.settings || {});
    card.dataset.loaded = "1";
  } catch (e) {
    document.getElementById("notificationSettingsNote").textContent = "לא ניתן לטעון הגדרות כרגע";
  }
}

async function saveNotificationSettings() {
  const slots = [...document.querySelectorAll("#availabilityReminderSlots .notification-slot-row")].map(row => ({
    day: Number(row.querySelector(".reminder-day").value),
    time: row.querySelector(".reminder-time").value || "18:00",
  }));
  const note = document.getElementById("notificationSettingsNote");
  note.textContent = "שומר...";
  try {
    const data = await api("PUT", "/api/settings/notifications", {
      availabilityRemindersEnabled: document.getElementById("availabilityReminderEnabled").checked,
      availabilityReminderSlots: slots,
      managerDigestEnabled: document.getElementById("managerDigestEnabled").checked,
      managerDigestTime: document.getElementById("managerDigestTime").value || "09:00",
    });
    renderNotificationSettings(data.settings || {});
    document.querySelector("#requestsView .notification-settings-card").dataset.loaded = "1";
    note.textContent = "נשמר";
  } catch (e) {
    note.textContent = "שגיאה בשמירה";
  }
}

function renderTimeRequestGroups(requests) {
  currentRequests = requests;
  const el = document.getElementById("timeRequests");
  if (!requests.length) {
    el.innerHTML = `<div class="empty-state" style="padding:14px">אין בקשות פתוחות.</div>`;
    return;
  }
  const groups = new Map();
  requests.forEach(r => {
    const key = r.requesterId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  el.innerHTML = [...groups.entries()].map(([userId, items]) => {
    const first = items[0];
    const name = first.requesterName || app.users.find(u => u.id === Number(userId))?.fullName || "עובד";
    return `
      <button class="request-row request-summary-row" type="button" onclick="openTimeRequestsModal(${userId})">
        <div class="request-info">
          <strong>${name}</strong>
          <small>${items.length} בקשות שינוי שעות ממתינות</small>
        </div>
        <span class="tag tag-yellow">לצפייה</span>
      </button>`;
  }).join("");
}

window.openTimeRequestsModal = function(userId) {
  const items = currentRequests.filter(r => r.requesterId === userId);
  if (!items.length) return;
  const name = items[0].requesterName || "עובד";
  modal({
    kicker: "שינויי שעות",
    title: name,
    body: items.map(r => {
      const shiftLabel = r.shift ? `${DAY_LABELS[r.shift.dayKey]} ${r.shift.slot === "morning" ? "בוקר" : "ערב"} · ${r.shift.hours}` : "";
      const branchLabel = r.branch?.name ? `${r.branch.name}${r.branch.number ? " · " + r.branch.number : ""}` : "";
      const requested = r.requestedStart ? `${r.requestedStart}-${r.requestedEnd}` : "לא צוינו שעות";
      return `
        <div class="data-row">
          <div class="data-row-main">
            <strong>${requested}</strong>
            <small>${[branchLabel, shiftLabel, r.note].filter(Boolean).join(" · ")}</small>
          </div>
          <button class="btn btn-success btn-xs" onclick="resolveRequest(${r.id}, 'approved')">אשר</button>
          <button class="btn btn-danger btn-xs" onclick="resolveRequest(${r.id}, 'rejected')">דחה</button>
        </div>`;
    }).join(""),
    footer: `<button class="btn btn-primary" id="approveAllTimeRequests">אשר הכל</button>
             <button class="btn btn-ghost" id="cancelModalBtn">סגור</button>`
  });
  document.getElementById("approveAllTimeRequests").addEventListener("click", async () => {
    await Promise.all(items.map(r => api("PUT", `/api/requests/${r.id}`, { status: "approved" })));
    closeModal();
    await loadRequests();
    if (app.currentWeek) await loadWeekView();
  });
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
};

function renderRequestList(containerId, requests) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!requests.length) {
    el.innerHTML = `<div class="empty-state" style="padding:14px">אין בקשות פתוחות.</div>`;
    return;
  }
  el.innerHTML = requests.map(r => {
    const u = app.users.find(x => x.id === r.requesterId);
    const typeLabel = r.type === "hours" ? "שינוי שעות" : r.type === "exit" ? "יציאה" : r.type === "swap" ? "חילוף" : "בקשת תגבור";
    const statusClass = r.status === "open" ? "tag-yellow" : r.status === "approved" ? "tag-green" : "tag-red";
    const statusLabel = r.status === "open" ? "פתוח" : r.status === "approved" ? "מאושר" : "נדחה";
    const requesterName = r.requesterName || u?.fullName || "עובד";
    const shiftLabel = r.shift
      ? `${DAY_LABELS[r.shift.dayKey]} ${r.shift.slot === "morning" ? "בוקר" : "ערב"} · ${r.shift.hours}`
      : "";
    const branchLabel = r.branch?.name ? `${r.branch.name}${r.branch.number ? " · " + r.branch.number : ""}` : "";
    const replacementLabel = r.replacementName ? ` · מחליף: ${r.replacementName}` : "";
    const hoursLabel = r.requestedStart ? ` · מבקש ${r.requestedStart}-${r.requestedEnd}` : "";
    return `
      <div class="request-row">
        <div class="request-info">
          <strong>${requesterName} · ${requestTypeLabel(r, typeLabel)}</strong>
          <small>${[branchLabel, shiftLabel].filter(Boolean).join(" · ")}${hoursLabel}${replacementLabel}${r.note ? " · " + r.note : ""}</small>
        </div>
        <span class="tag ${statusClass}">${statusLabel}</span>
        ${r.status === "open" && r.type !== "reinforcement" ? `
          <div class="request-actions">
            <button class="btn btn-success btn-xs" onclick="resolveRequest(${r.id},'approved')">אשר</button>
            <button class="btn btn-danger btn-xs" onclick="resolveRequest(${r.id},'rejected')">דחה</button>
          </div>` : ""}
        ${r.status === "open" && r.type === "reinforcement" ? `
          <div class="request-actions">
            <button class="btn btn-danger btn-xs" onclick="resolveRequest(${r.id},'rejected')">בטל בקשה</button>
          </div>` : ""}
      </div>`;
  }).join("");
}

function requestTypeLabel(r, fallback) {
  if (r.type !== "taxi") return fallback;
  if (r.requestedStart === "arrival") return "מונית הגעה";
  if (r.requestedStart === "return") return "מונית חזור";
  return "בקשת מונית";
}

window.resolveRequest = async function(id, status) {
  try {
    await api("PUT", `/api/requests/${id}`, { status });
    await loadRequests();
    // Refresh shift view if visible
    if (app.currentWeek) await loadWeekView();
  } catch (e) {
    alert("שגיאה בעדכון בקשה");
  }
};

function renderShortageRequests(week = app.currentWeek, branchId = app.currentBranch?.id) {
  const el = document.getElementById("shortageRequests");
  if (!el) return;
  if (!week) {
    el.innerHTML = `<div class="empty-state" style="padding:14px">אין לוז שבועי פתוח לסניף הזה בשבוע הנבחר.</div>`;
    return;
  }
  const shortages = (week.shifts || []).filter(s => s.shortage);
  if (!shortages.length) {
    el.innerHTML = `<div class="empty-state" style="padding:14px">אין חוסרים פתוחים.</div>`;
    return;
  }
  const branchName = app.branches.find(b => b.id === Number(branchId))?.name || app.currentBranch?.name || "";
  el.innerHTML = shortages.map(s => {
    const label = s.slot === "morning" ? "בוקר" : "ערב";
    return `
      <div class="request-row">
        <div class="request-info">
          <strong>${branchName ? branchName + " · " : ""}${DAY_LABELS[s.dayKey]} ${label}</strong>
          <small>${weekRangeLabel(week.weekStart)} · ${s.hours} · חסר ${s.shortage.count} · ${s.shortage.level}${s.shortage.note ? " · " + s.shortage.note : ""}</small>
        </div>
        <span class="tag tag-yellow">${s.shortage.status}</span>
        <div class="request-actions">
          <button class="btn btn-primary btn-xs" type="button" onclick="openShortageShift(${Number(branchId)}, ${s.id})">טפל בלוז</button>
        </div>
      </div>`;
  }).join("");
}

window.openShortageShift = function(branchId, shiftId) {
  app.currentBranch = app.branches.find(b => b.id === Number(branchId)) || app.currentBranch;
  app.selectedShiftId = Number(shiftId);
  app.openSelectedShiftAfterLoad = true;
  showView("schedule");
};

// ── Reports View ──────────────────────────────────────────────────────────────
async function loadReports() {
  const sel = document.getElementById("reportBranchSelect");
  const previousBranchId = Number(sel.value || app.currentBranch?.id || 0);
  const previousDate = document.getElementById("reportDate").value;
  await refreshCoreData();

  // Populate branch select
  sel.innerHTML = app.branches.map(b =>
    `<option value="${b.id}">${b.name}</option>`
  ).join("");
  if (previousBranchId && app.branches.some(b => b.id === previousBranchId)) {
    sel.value = String(previousBranchId);
  }

  // Default date = today
  const today = fmtDate(new Date());
  document.getElementById("reportDate").value = previousDate || today;
  document.getElementById("saveReportBtn").hidden = app.user?.role === "network-manager";

  if (!app.branches.length) return;
  const branchId = Number(sel.value);
  await updateReportTargetFromSchedule();
  try {
    const data = await api("GET", `/api/reports?branchId=${branchId}`);
    renderReportHistory(data.reports || []);
  } catch (e) { console.warn("loadReports", e); }
}

function weekStartForDate(iso) {
  return fmtDate(parseIso(iso));
}

async function updateReportTargetFromSchedule() {
  const branchId = Number(document.getElementById("reportBranchSelect").value || 0);
  const date = document.getElementById("reportDate").value;
  if (!branchId || !date) return;
  const ws = weekStartForDate(date);
  const dayIndex = Math.round((parseIso(date) - parseIso(ws)) / 86400000);
  const dayKey = DAY_KEYS[dayIndex];
  try {
    const data = await api("GET", `/api/weeks?branchId=${branchId}&weekStart=${ws}`);
    const target = Math.max(...(data.week.shifts || []).filter(s => s.dayKey === dayKey).map(s => Number(s.salesTarget || 0)), 0);
    document.getElementById("salesTarget").value = target || "";
    calcReportKPIs();
  } catch (e) {
    document.getElementById("salesTarget").value = "";
    calcReportKPIs();
  }
}

function calcReportKPIs() {
  const target = Number(document.getElementById("salesTarget").value || 0);
  const actual = Number(document.getElementById("actualSales").value || 0);
  const pct    = target ? Math.round(actual / target * 100) : 0;
  const labor  = actual >= 7000 ? 11.8 : 13.4;
  const ok     = labor <= 12.5;
  document.getElementById("kpiTargetPct").textContent = `${pct}%`;
  document.getElementById("kpiLaborPct").textContent  = `${labor}%`;
  document.getElementById("kpiLaborPct").className = "kpi-value " + (ok ? "" : "");
  document.getElementById("kpiStatus").textContent = ok ? "תקין" : "חריגה";
  document.getElementById("kpiStatus").style.color = ok ? "var(--green)" : "var(--red)";
}

async function saveReport() {
  const branchId      = Number(document.getElementById("reportBranchSelect").value);
  const date          = document.getElementById("reportDate").value;
  const salesTarget   = Number(document.getElementById("salesTarget").value || 0);
  const actualSales   = Number(document.getElementById("actualSales").value || 0);
  const avgTransaction= Number(document.getElementById("avgTransaction").value || 0);
  const avgItems      = Number(document.getElementById("avgItems").value || 0);
  try {
    await api("POST", "/api/reports", { branchId, date, salesTarget, actualSales, avgTransaction, avgItems });
    const data = await api("GET", `/api/reports?branchId=${branchId}`);
    renderReportHistory(data.reports || []);
    const btn = document.getElementById("saveReportBtn");
    btn.textContent = "נשמר ✓";
    setTimeout(() => btn.textContent = "שמור דוח", 1500);
  } catch (e) { alert("שגיאה בשמירת דוח"); }
}

function renderReportHistory(reports) {
  const el = document.getElementById("reportHistory");
  if (!reports.length) {
    el.innerHTML = `<div class="empty-state" style="padding:14px">אין דוחות עדיין.</div>`;
    return;
  }
  const canManage = app.user?.role !== "network-manager";
  el.innerHTML = reports.map(r => `
    <div class="data-row">
      <div class="data-row-main">
        <strong>${r.date} · ₪${r.actualSales.toLocaleString()}</strong>
        <small>ממוצע עסקה ₪${r.avgTransaction} · ${r.avgItems} פריטים</small>
      </div>
      <span class="tag tag-accent">${r.targetPercent}% יעד</span>
      ${canManage ? `
        <div class="data-row-actions">
          <button class="btn btn-ghost btn-xs" type="button" onclick='editReport(${JSON.stringify(r)})'>ערוך</button>
          <button class="btn btn-danger btn-xs" type="button" onclick="deleteReport(${r.id})">מחק</button>
        </div>` : ""}
    </div>`).join("");
}

window.editReport = function(report) {
  document.getElementById("reportBranchSelect").value = String(report.branchId);
  document.getElementById("reportDate").value = report.date;
  document.getElementById("salesTarget").value = report.salesTarget || "";
  document.getElementById("actualSales").value = report.actualSales || "";
  document.getElementById("avgTransaction").value = report.avgTransaction || "";
  document.getElementById("avgItems").value = report.avgItems || "";
  calcReportKPIs();
  const btn = document.getElementById("saveReportBtn");
  btn.textContent = "עדכן דוח";
  btn.hidden = app.user?.role === "network-manager";
};

window.deleteReport = async function(reportId) {
  if (!confirm("למחוק את הדוח היומי?")) return;
  try {
    await api("DELETE", `/api/reports/${reportId}`);
    const branchId = Number(document.getElementById("reportBranchSelect").value);
    const data = await api("GET", `/api/reports?branchId=${branchId}`);
    renderReportHistory(data.reports || []);
  } catch (e) {
    alert("שגיאה במחיקת דוח: " + (e.data?.error || e.message));
  }
};

// ── Area View ─────────────────────────────────────────────────────────────────
async function loadAreaView() {
  await refreshCoreData();
  const el = document.getElementById("areaBranches");
  el.innerHTML = app.branches.map(b => `
    <div class="branch-card">
      <h3>${b.name}</h3>
      <div class="branch-card-meta">
        <span>אזור: ${b.area}</span>
        <span>מנהל: ${b.managerName || "לא שויך"}</span>
        <span>יעד שכר: ${b.laborTarget}%</span>
        <span>חוסרים השבוע: ${b.shortageCount || 0}</span>
      </div>
      <div class="branch-card-footer">
        <span class="tag tag-green">פעיל</span>
        <button class="btn btn-ghost btn-xs" onclick="goToBranchSchedule(${b.id})">לסידור</button>
      </div>
    </div>`).join("") || `<div class="empty-state"><div>אין סניפים</div></div>`;

  await loadAreaShortages();
}

async function loadAreaShortages() {
  const el = document.getElementById("areaShortages");
  if (!el) return;
  el.innerHTML = `<div style="padding:14px;color:var(--text3);font-size:.85rem">טוען...</div>`;

  const ws = todayWeekStart();
  const filter = document.getElementById("shortageFilter")?.value || "all";

  try {
    const weeks = await Promise.all(
      app.branches.map(b =>
        api("GET", `/api/weeks?branchId=${b.id}&weekStart=${ws}`)
          .then(r => ({ branch: b, week: r.week }))
          .catch(() => ({ branch: b, week: null }))
      )
    );

    const allShortages = [];
    weeks.forEach(({ branch, week }) => {
      if (!week) return;
      (week.shifts || []).forEach(s => {
        if (!s.shortage) return;
        const rem     = remainingShortage(s);
        const pending = s.pendingReinforcementCount || 0;
        const approved = s.approvedReinforcementCount || 0;
        if (filter === "open"    && (pending > 0 || approved > 0)) return;
        if (filter === "pending" && pending === 0) return;
        if (filter === "covered" && rem > 0) return;
        allShortages.push({ shift: s, branch, week });
      });
    });

    if (!allShortages.length) {
      el.innerHTML = `<div class="empty-state" style="padding:14px">אין חוסרים פתוחים.</div>`;
      return;
    }

    el.innerHTML = allShortages.map(({ shift: s, branch, week }) => {
      const rem   = remainingShortage(s);
      const label = s.slot === "morning" ? "בוקר" : "ערב";
      const tagClass = rem === 0 ? "tag-green" : "tag-yellow";
      const tagText  = rem === 0 ? "מכוסה ✓" : s.shortage.status;
      return `
        <div class="request-row">
          <div class="request-info">
            <strong>${branch.name} · ${DAY_LABELS[s.dayKey]} ${label}</strong>
            <small>${weekRangeLabel(week.weekStart)} · ${s.hours} · חסר ${s.shortage.count}${rem < s.shortage.count ? ` · נותר ${rem}` : ""} · ${s.shortage.level}${s.shortage.note ? " · " + s.shortage.note : ""}</small>
          </div>
          <span class="tag ${tagClass}">${tagText}</span>
          <div class="request-actions">
            <button class="btn btn-primary btn-xs" type="button" onclick="openShortageShift(${branch.id}, ${s.id})">טפל בלוז</button>
          </div>
        </div>`;
    }).join("");
  } catch(e) {
    el.innerHTML = `<div class="empty-state" style="padding:14px;color:var(--red)">שגיאה בטעינת חוסרים.</div>`;
  }
}

window.goToBranchSchedule = function(branchId) {
  app.currentBranch = app.branches.find(b => b.id === branchId);
  showView("schedule");
};

// ── Network View ──────────────────────────────────────────────────────────────
async function loadNetworkView() {
  const el = document.getElementById("networkBranches");
  if (el) el.innerHTML = `<div style="padding:18px;color:var(--text3);font-size:.85rem">טוען נתונים...</div>`;
  try {
    await refreshCoreData();
  } catch(e) {
    if (el) el.innerHTML = `<div style="padding:18px;color:var(--red);font-size:.85rem">שגיאה בטעינת נתונים. רענן את הדף.</div>`;
    return;
  }
  renderNetworkBranches();
  renderManagerList();
  loadAuditLog();
}

function renderNetworkBranches() {
  const el = document.getElementById("networkBranches");
  if (!app.branches.length) {
    el.innerHTML = `
      <div class="empty-state" style="padding:18px">
        <div class="empty-icon">🏪</div>
        <div>עדיין אין סניפים. צור סניף ראשון כדי לפתוח סידור שבועי, דוחות ושיבוצים.</div>
        <button class="btn btn-primary btn-sm" type="button" onclick="openAddBranchModal()">צור סניף ראשון</button>
      </div>`;
    return;
  }
  el.innerHTML = app.branches.map(b => `
    <div class="data-row">
      <div class="data-row-main">
        <strong>${b.name}${b.number ? " · " + b.number : ""}</strong>
        <small>אזור ${b.area} · מנהל: ${b.managerName || "—"} · יעד שכר ${b.laborTarget}% · חוסרים ${b.shortageCount || 0}</small>
      </div>
      <span class="tag tag-accent">פעיל</span>
      <div class="data-row-actions">
        <button class="btn btn-ghost btn-xs" onclick="openEditBranchModal(${b.id})">עריכה</button>
      </div>
    </div>`).join("");
}

function renderManagerList() {
  const managers = app.users.filter(u => u.role !== "employee" && u.status === "active");
  const el = document.getElementById("managerList");
  el.innerHTML = managers.map(u => `
    <div class="data-row">
      <div class="data-row-main">
        <strong>${u.fullName}</strong>
        <small>${roleLabel(u.role)} · ${u.email}${managerBranchLabel(u)}</small>
      </div>
      <span class="tag tag-green">פעיל</span>
    </div>`).join("") || `<div class="empty-state" style="padding:14px">אין מנהלים.</div>`;
}

function managerBranchLabel(user) {
  const names = (user.branchIds || [])
    .map(id => app.branches.find(b => b.id === id)?.name)
    .filter(Boolean);
  return names.length ? ` · ${names.join(", ")}` : "";
}

async function loadAuditLog() {
  try {
    const data = await api("GET", "/api/audit");
    const el = document.getElementById("auditLog");
    const log = data.log || [];
    el.innerHTML = log.map(entry => {
      const d = new Date(entry.createdAt * 1000);
      const ts = `${d.getDate()}.${d.getMonth()+1} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
      return `
        <div class="data-row">
          <div class="data-row-main">
            <strong>${entry.action}</strong>
            <small>${entry.userName || "מערכת"}</small>
          </div>
          <span class="tag tag-muted">${ts}</span>
        </div>`;
    }).join("") || `<div class="empty-state" style="padding:14px">אין פעילות.</div>`;
  } catch (e) { console.warn("auditLog", e); }
}

window.openEditBranchModal = function(branchId) {
  const b = app.branches.find(x => x.id === branchId);
  if (!b) return;
  const managerOptions = app.users
    .filter(u => u.role === "branch-manager" && u.status === "active")
    .map(u => `<option value="${u.id}" ${u.id === b.managerId ? "selected" : ""}>${u.fullName}</option>`)
    .join("");
  modal({
    kicker: "מנהל רשת",
    title: `עריכת סניף · ${b.name}`,
    body: `
      <div class="form-grid">
        <div class="field"><label>שם סניף</label><input id="eb-name" value="${b.name}" /></div>
        <div class="field"><label>מספר סניף</label><input id="eb-num" value="${b.number||""}" /></div>
        <div class="field"><label>אזור</label>
          <select id="eb-area">
            <option ${b.area==="מרכז"?"selected":""}>מרכז</option>
            <option ${b.area==="צפון"?"selected":""}>צפון</option>
            <option ${b.area==="דרום"?"selected":""}>דרום</option>
          </select>
        </div>
        <div class="field"><label>מנהל סניף</label>
          <select id="eb-manager"><option value="">— ללא —</option>${managerOptions}</select>
        </div>
        <div class="field"><label>יעד שכר עבודה (%)</label><input type="number" id="eb-labor" value="${b.laborTarget}" step="0.1" /></div>
        <div class="field"><label>שעות בוקר</label><input id="eb-morning" value="${b.morningHours}" /></div>
        <div class="field"><label>שעות ערב</label><input id="eb-evening" value="${b.eveningHours}" /></div>
      </div>`,
    footer: `<button class="btn btn-primary" id="saveEB">שמור</button>
             <button class="btn btn-ghost" id="cancelModalBtn">ביטול</button>`
  });
  document.getElementById("saveEB").addEventListener("click", async () => {
    try {
      await api("PUT", `/api/branches/${branchId}`, {
        name:         document.getElementById("eb-name").value,
        number:       document.getElementById("eb-num").value,
        area:         document.getElementById("eb-area").value,
        managerId:    Number(document.getElementById("eb-manager").value) || null,
        laborTarget:  Number(document.getElementById("eb-labor").value),
        morningHours: document.getElementById("eb-morning").value,
        eveningHours: document.getElementById("eb-evening").value,
      });
      const bd = await api("GET", "/api/branches");
      app.branches = bd.branches || [];
      closeModal();
      loadNetworkView();
    } catch (e) { alert("שגיאה בשמירה"); }
  });
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
};

function openAddBranchModal() {
  modal({
    kicker: "מנהל רשת",
    title: "יצירת סניף חדש",
    body: `
      <div class="form-grid">
        <div class="field"><label>שם סניף</label><input id="nb-name" placeholder="דיזנגוף" /></div>
        <div class="field"><label>מספר סניף</label><input id="nb-num" placeholder="014" /></div>
        <div class="field"><label>אזור</label>
          <select id="nb-area"><option>מרכז</option><option>צפון</option><option>דרום</option></select>
        </div>
        <div class="field"><label>יעד שכר עבודה (%)</label><input type="number" id="nb-labor" value="12.4" step="0.1" /></div>
        <div class="field"><label>שעות בוקר</label><input id="nb-morning" value="09:00-15:00" /></div>
        <div class="field"><label>שעות ערב</label><input id="nb-evening" value="15:00-22:00" /></div>
      </div>`,
    footer: `<button class="btn btn-primary" id="saveNB">צור סניף</button>
             <button class="btn btn-ghost" id="cancelModalBtn">ביטול</button>`
  });
  document.getElementById("saveNB").addEventListener("click", async () => {
    try {
      await api("POST", "/api/branches", {
        name:         document.getElementById("nb-name").value,
        number:       document.getElementById("nb-num").value,
        area:         document.getElementById("nb-area").value,
        laborTarget:  Number(document.getElementById("nb-labor").value),
        morningHours: document.getElementById("nb-morning").value,
        eveningHours: document.getElementById("nb-evening").value,
      });
      const bd = await api("GET", "/api/branches");
      app.branches = bd.branches || [];
      if (!app.currentBranch && app.branches.length) app.currentBranch = app.branches[0];
      closeModal();
      loadNetworkView();
    } catch (e) { alert("שגיאה ביצירת סניף: " + (e.data?.error || e.message)); }
  });
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
}

// ── Employee Portal ───────────────────────────────────────────────────────────

// State: which day is selected in the portal (index 0-6, Sun=0)
if (window._portalSelectedDay === undefined) window._portalSelectedDay = null;

function portalTodayDayIndex(weekStart) {
  const today = fmtDate(new Date());
  for (let i = 0; i < 7; i++) {
    if (addDays(weekStart, i) === today) return i;
  }
  return 0;
}

function shiftHoursDecimal(hours, myAssignment) {
  // Use personal assignment hours if available, else shift hours string
  const str = (myAssignment?.startTime && myAssignment?.endTime)
    ? `${myAssignment.startTime}-${myAssignment.endTime}`
    : (hours || "");
  const m = str.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const start = parseInt(m[1]) * 60 + parseInt(m[2]);
  let end   = parseInt(m[3]) * 60 + parseInt(m[4]);
  if (end <= start) end += 24 * 60; // past midnight
  return Math.round((end - start) / 60 * 10) / 10;
}

function avatarInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length-1][0]).toUpperCase()
    : parts[0][0].toUpperCase();
}

async function renderPortal() {
  if (!app.user) return;
  try {
    renderPortalBranchBar();
  } catch(e) { console.warn("renderPortalBranchBar error", e); }
  try {
    await renderPortalReinforcementAlerts();
  } catch(e) { console.warn("renderPortalReinforcementAlerts error", e); }

  const firstName = (app.user.fullName || "").split(" ")[0];
  const greeting = document.getElementById("portalHeroGreeting");
  if (greeting) greeting.textContent = `היי ${firstName},`;

  if (!app.portalWeekStart) app.portalWeekStart = todayWeekStart();
  const ws = app.portalWeekStart;

  // Default selected day to today (if in this week) or Sunday
  if (window._portalSelectedDay === null || window._portalSelectedDay === undefined) {
    window._portalSelectedDay = portalTodayDayIndex(ws);
  }
  const dayIdx = window._portalSelectedDay;
  const dk     = DAY_KEYS[dayIdx];
  const isoDate = addDays(ws, dayIdx);
  const d = parseIso(isoDate);

  // Update headline
  const headline = document.getElementById("portalDayHeadline");
  const dayNameEl = document.getElementById("portalDayName");
  if (headline) headline.textContent = `${d.getDate()} ב${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (dayNameEl) dayNameEl.textContent = `יום ${DAY_LABELS[dk]}`;

  const grid = document.getElementById("portalGrid");
  grid.innerHTML = "";

  if (!app.currentBranch) {
    grid.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--text3);">אין עדיין סניף פעיל להגשת זמינות.</div>`;
    return;
  }

  let weekData = null;
  try {
    const res = await api("GET", `/api/weeks?branchId=${app.currentBranch.id}&weekStart=${ws}`);
    weekData = res.week;
  } catch (e) { /* week may not exist yet */ }
  app.currentWeek = weekData;

  const taxiRequests = await getPortalTaxiRequests();
  const reinforcementRequests = await getPortalReinforcementRequests();

  // Render the day strip
  renderEpDayStrip(ws, weekData, dayIdx, reinforcementRequests);

  // Render content for selected day
  renderEpDayContent(ws, dk, dayIdx, weekData, reinforcementRequests, taxiRequests);
}

async function getPortalReinforcementRequests() {
  try {
    const data = await api("GET", "/api/requests");
    return (data.requests || []).filter(r => r.type === "reinforcement" && (r.status === "open" || r.status === "approved"));
  } catch(e) {
    console.warn("getPortalReinforcementRequests error", e);
    return [];
  }
}

async function getPortalTaxiRequests() {
  try {
    const data = await api("GET", "/api/requests");
    const latestSubmissionByShift = new Map();
    (data.requests || [])
      .filter(r => r.type === "taxi")
      .forEach(r => {
        const key = String(r.shiftId);
        const ts = Number(r.createdAt || 0);
        if (ts > Number(latestSubmissionByShift.get(key) || 0)) {
          latestSubmissionByShift.set(key, ts);
        }
      });
    const latest = new Map();
    (data.requests || [])
      .filter(r => r.type === "taxi")
      .filter(r => Number(r.createdAt || 0) === Number(latestSubmissionByShift.get(String(r.shiftId)) || 0))
      .forEach(r => {
        const key = `${r.shiftId}:${r.requestedStart}`;
        const prev = latest.get(key);
        if (!prev || Number(r.createdAt || 0) > Number(prev.createdAt || 0) || Number(r.id || 0) > Number(prev.id || 0)) {
          latest.set(key, r);
        }
      });
    return [...latest.values()];
  } catch(e) {
    console.warn("getPortalTaxiRequests error", e);
    return [];
  }
}

function taxiDirectionLabel(direction) {
  if (direction === "both") return "הגעה וחזור";
  return direction === "arrival" ? "הגעה" : direction === "return" ? "חזור" : "מונית";
}

function taxiStatusLabel(status) {
  return ({ open: "ממתינה", approved: "אושרה", rejected: "נדחתה" })[status] || status || "";
}

function taxiStatusClass(status) {
  return ({ open: "pending", approved: "approved", rejected: "rejected" })[status] || "pending";
}

function taxiDirectionIcon(direction) {
  if (direction === "both") {
    return `<span class="ep-taxi-route" aria-hidden="true"><span>🚕</span><span class="ep-route-arrow">↔</span><span>🏢</span></span>`;
  }
  if (direction === "arrival") {
    return `<span class="ep-taxi-route" aria-hidden="true"><span>🚕</span><span class="ep-route-arrow">→</span><span>🏢</span></span>`;
  }
  return `<span class="ep-taxi-route" aria-hidden="true"><span>🏢</span><span class="ep-route-arrow">→</span><span>🚕</span></span>`;
}

function summarizeTaxiRequests(requests) {
  const byDirection = new Map();
  requests.forEach(r => {
    const direction = r.requestedStart;
    if (direction !== "arrival" && direction !== "return") return;
    const prev = byDirection.get(direction);
    if (!prev || Number(r.createdAt || 0) > Number(prev.createdAt || 0) || Number(r.id || 0) > Number(prev.id || 0)) {
      byDirection.set(direction, r);
    }
  });
  const arrival = byDirection.get("arrival");
  const returnRide = byDirection.get("return");
  if (arrival && returnRide && arrival.status === returnRide.status) {
    return [{ direction: "both", status: arrival.status }];
  }
  return [
    arrival ? { direction: "arrival", status: arrival.status } : null,
    returnRide ? { direction: "return", status: returnRide.status } : null,
  ].filter(Boolean);
}

function renderEpDayStrip(ws, weekData, activeDayIdx, reinforcementRequests = []) {
  // Pills strip — kept as quick-nav above the carousel
  const strip = document.getElementById("portalDateStrip");
  if (!strip) return;
  const stripPublished = weekData?.status === "published" || weekData?.status === "closed";
  strip.innerHTML = DAY_KEYS.map((dk, i) => {
    const iso = addDays(ws, i);
    const d   = parseIso(iso);
    let hrsLabel = "";
    (weekData?.shifts || []).filter(s => s.dayKey === dk).forEach(s => {
      const myA = s.assignments?.find(a => a.userId === app.user.id);
      const isReinf = s.slot === "morning"
        ? reinforcementRequests?.find(r => r.shift?.dayKey === dk && r.shift?.slot === "morning" && r.status === "approved")
        : reinforcementRequests?.find(r => r.shift?.dayKey === dk && r.shift?.slot === "evening" && r.status === "approved");
      if ((myA && stripPublished) || isReinf) {
        const dec = shiftHoursDecimal(isReinf?.shift?.hours || s.hours, myA);
        if (dec) hrsLabel = dec.toString();
      }
    });
    // Check if user has any visible assignment this day
    let isAssignedDay = false;
    (weekData?.shifts || []).filter(s => s.dayKey === dk).forEach(s => {
      const myA = s.assignments?.find(a => a.userId === app.user.id);
      const isReinf = reinforcementRequests?.find(r =>
        r.shift?.dayKey === dk && r.shift?.slot === s.slot && r.status === "approved");
      if ((myA && stripPublished) || isReinf) isAssignedDay = true;
    });
    const isActive = i === activeDayIdx;
    return `<button class="ep-day-pill${isActive ? " active" : ""}${hrsLabel ? " has-work" : ""}${isAssignedDay ? " assigned" : ""}" type="button" data-day-idx="${i}">
      <span class="ep-pill-name">${DAY_LABELS[dk]}</span>
      <strong class="ep-pill-num">${d.getDate()}</strong>
      ${hrsLabel ? `<span class="ep-pill-hrs">${hrsLabel}</span>` : ""}
      ${isAssignedDay ? `<span class="ep-pill-dot"></span>` : ""}
    </button>`;
  }).join("");
  strip.querySelectorAll("[data-day-idx]").forEach(btn => {
    btn.addEventListener("click", () => {
      setPortalActiveDay(ws, parseInt(btn.dataset.dayIdx), true);
    });
  });
  if (!strip._epDayStripScrollBound) {
    let stripRaf = 0;
    strip.addEventListener("scroll", () => {
      if (stripRaf) return;
      stripRaf = requestAnimationFrame(() => {
        stripRaf = 0;
        updateEpDayStripDepth();
      });
    }, { passive: true });
    strip._epDayStripScrollBound = true;
  }
  requestAnimationFrame(() => {
    strip.querySelector(`.ep-day-pill[data-day-idx="${activeDayIdx}"]`)?.scrollIntoView({
      behavior: "auto",
      inline: "center",
      block: "nearest",
    });
    updateEpDayStripDepth();
  });
}

function setPortalActiveDay(ws, idx, shouldScroll = true) {
  window._portalSelectedDay = idx;
  document.querySelectorAll(".ep-day-pill").forEach((p, pi) => {
    p.classList.toggle("active", pi === idx);
  });
  document.querySelectorAll(".ep-day-slide").forEach(slide => {
    slide.classList.toggle("ep-slide-active", Number(slide.dataset.dayIdx) === idx);
  });
  const d2  = parseIso(addDays(ws, idx));
  const dk2 = DAY_KEYS[idx];
  const h   = document.getElementById("portalDayHeadline");
  const n   = document.getElementById("portalDayName");
  if (h) h.textContent = `${d2.getDate()} ב${MONTHS[d2.getMonth()]} ${d2.getFullYear()}`;
  if (n) n.textContent = `יום ${DAY_LABELS[dk2]}`;

  centerPortalDayPill(idx, shouldScroll ? "smooth" : "auto");
  if (shouldScroll) centerPortalDaySlide(idx, "smooth");
  requestAnimationFrame(() => updateEpDayStripDepth());
}

function centerPortalDayPill(idx, behavior = "smooth") {
  document.querySelector(`.ep-day-pill[data-day-idx="${idx}"]`)?.scrollIntoView({
    behavior,
    inline: "center",
    block: "nearest",
  });
}

function centerPortalDaySlide(idx, behavior = "smooth") {
  document.getElementById("epDaysCarousel")
    ?.querySelector(`[data-day-idx="${idx}"]`)
    ?.scrollIntoView({
      behavior,
      inline: "center",
      block: "nearest",
    });
}

function closestPortalSlideIndex(carousel) {
  const slides = Array.from(carousel.querySelectorAll(".ep-day-slide"));
  if (!slides.length) return window._portalSelectedDay ?? 0;
  const carouselRect = carousel.getBoundingClientRect();
  const center = carouselRect.left + carouselRect.width / 2;
  let bestIdx = Number(slides[0].dataset.dayIdx);
  let bestDistance = Infinity;
  slides.forEach(slide => {
    const rect = slide.getBoundingClientRect();
    const slideCenter = rect.left + rect.width / 2;
    const distance = Math.abs(slideCenter - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIdx = Number(slide.dataset.dayIdx);
    }
  });
  return bestIdx;
}

function updateEpDayStripDepth() {
  const strip = document.getElementById("portalDateStrip");
  const pills = Array.from(document.querySelectorAll(".ep-day-pill"));
  if (!strip || !pills.length) return;

  const stripRect = strip.getBoundingClientRect();
  const center = stripRect.left + stripRect.width / 2;
  const focusRadius = Math.max(stripRect.width * .36, 118);

  pills.forEach(btn => {
    const rect = btn.getBoundingClientRect();
    const btnCenter = rect.left + rect.width / 2;
    const distance = Math.min(Math.abs(btnCenter - center) / focusRadius, 1);
    const focus = 1 - (distance * distance);
    const scale = .76 + (focus * .34);
    const opacity = .36 + (focus * .64);
    const y = (1 - focus) * 10;
    btn.style.setProperty("--day-scale", scale.toFixed(3));
    btn.style.setProperty("--day-opacity", opacity.toFixed(3));
    btn.style.setProperty("--day-y", `${y.toFixed(1)}px`);
  });
}

function renderEpDayContent(ws, dk, dayIdx, weekData, reinforcementRequests, taxiRequests = []) {
  const grid = document.getElementById("portalGrid");
  grid.innerHTML = "";

  // Build 7 day-cards into a swipeable carousel
  const carousel = document.createElement("div");
  carousel.className = "ep-days-carousel";
  carousel.id = "epDaysCarousel";

  DAY_KEYS.forEach((dkI, i) => {
    const isoI    = addDays(ws, i);
    const dI      = parseIso(isoI);
    const holidayI = holidayFor(isoI, dkI);

    const morningShift = weekData?.shifts?.find(s => s.dayKey === dkI && s.slot === "morning");
    const eveningShift = weekData?.shifts?.find(s => s.dayKey === dkI && s.slot === "evening");
    const myMorningAssign = morningShift?.assignments?.find(a => a.userId === app.user.id);
    const myEveningAssign = eveningShift?.assignments?.find(a => a.userId === app.user.id);
    const myMorningAvail  = morningShift?.availability?.find(a => a.userId === app.user.id);
    const myEveningAvail  = eveningShift?.availability?.find(a => a.userId === app.user.id);
    const morningReinf = reinforcementRequests.find(r =>
      r.shift?.weekStart === ws && r.shift?.dayKey === dkI && r.shift?.slot === "morning");
    const eveningReinf = reinforcementRequests.find(r =>
      r.shift?.weekStart === ws && r.shift?.dayKey === dkI && r.shift?.slot === "evening");

    const isPublished     = weekData?.status === "published" || weekData?.status === "closed";
    const isAssignedMorning = (!!myMorningAssign && isPublished) || morningReinf?.status === "approved";
    const isAssignedEvening = (!!myEveningAssign && isPublished) || eveningReinf?.status === "approved";
    const hasAnyAssignment  = isAssignedMorning || isAssignedEvening;

    const slide = document.createElement("div");
    slide.className = "ep-day-slide";
    slide.dataset.dayIdx = i;

    if (hasAnyAssignment || isPublished) {
      buildModeB(slide, ws, dkI, dI, holidayI, morningShift, eveningShift,
        myMorningAssign, myEveningAssign, morningReinf, eveningReinf,
        isAssignedMorning, isAssignedEvening, weekData, taxiRequests);
    } else {
      buildModeA(slide, ws, dkI, dI, holidayI, morningShift, eveningShift,
        myMorningAvail, myEveningAvail);
    }

    carousel.appendChild(slide);
  });

  grid.appendChild(carousel);

  // Scroll to active day (instant, no animation on load)
  requestAnimationFrame(() => {
    const activeSlide = carousel.querySelector(`[data-day-idx="${dayIdx}"]`);
    if (activeSlide) {
      carousel.scrollTo({ left: activeSlide.offsetLeft - carousel.offsetLeft, behavior: "instant" });
      activeSlide.classList.add("ep-slide-active");
      centerPortalDayPill(dayIdx, "auto");
      updateEpDayStripDepth();
    }
    let carouselRaf = 0;
    carousel.addEventListener("scroll", () => {
      if (carouselRaf) return;
      carouselRaf = requestAnimationFrame(() => {
        carouselRaf = 0;
        const idx = closestPortalSlideIndex(carousel);
        if (idx !== window._portalSelectedDay) {
          setPortalActiveDay(ws, idx, false);
        }
      });
    }, { passive: true });
  });
}


function sameShiftRef(shift, request) {
  return !!shift && !!request && Number(shift.id) === Number(request.shiftId);
}

function reinforcementDisplayShift(request, slot) {
  if (!request) return null;
  return {
    id: request.shiftId,
    dayKey: request.shift?.dayKey,
    slot: request.shift?.slot || slot,
    hours: request.shift?.hours || "",
    assignments: [],
    availability: [],
    branchName: request.branch?.name || "",
    isReinforcementOnly: true,
  };
}

function buildModeB(slide, ws, dk, d, holiday, morningShift, eveningShift,
  myMorningAssign, myEveningAssign, morningReinf, eveningReinf,
  isAssignedMorning, isAssignedEvening, weekData, taxiRequests = []) {

  const canPull = weekData?.status === "draft";
  const isClosedWeek = weekData?.status === "closed";

  const card = document.createElement("div");
  card.className = "ep-day-card";

  const hasStatus = isAssignedMorning || isAssignedEvening;
  const dayTarget = Math.max(Number(morningShift?.salesTarget || 0), Number(eveningShift?.salesTarget || 0));
  card.innerHTML = `
    <div class="ep-day-card-header ${hasStatus ? "ep-day-card-header--assigned" : "ep-day-card-header--free"}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div class="ep-day-card-title">יום ${DAY_LABELS[dk]}</div>
          <div class="ep-day-card-date">${d.getDate()} ב${MONTHS[d.getMonth()]} ${d.getFullYear()}${holiday ? ` · ${holiday}` : ""}</div>
        </div>
        ${dayTarget ? `<div class="ep-day-target"><span class="ep-day-target-label">יעד יומי</span><span class="ep-day-target-value">₪${dayTarget.toLocaleString()}</span></div>` : ""}
      </div>
      ${hasStatus ? `<div class="ep-day-status">הזנה הושלמה</div>` : ""}
    </div>`;

  [["morning", morningShift, myMorningAssign, morningReinf, isAssignedMorning],
   ["evening", eveningShift, myEveningAssign, eveningReinf, isAssignedEvening]].forEach(
    ([slot, shift, myAssign, reinf, isAssigned]) => {
      if (!shift && !reinf) return;

      const isCrossBranchReinf = !!reinf && !sameShiftRef(shift, reinf);
      const displayShift = isCrossBranchReinf ? reinforcementDisplayShift(reinf, slot) : shift;
      const displayAssign = isCrossBranchReinf && reinf.status === "approved"
        ? { userId: app.user.id, userName: app.user.fullName, startTime: null, endTime: null }
        : myAssign;
      const displayBranchName = isCrossBranchReinf
        ? (reinf.branch?.name || "")
        : (app.currentBranch?.name || "");

      const label   = slot === "morning" ? "משמרת בוקר" : "משמרת ערב";
      const icon    = slot === "morning" ? "☀️" : "🌙";
      const myHours = (displayAssign?.startTime && displayAssign?.endTime)
        ? `${displayAssign.startTime}–${displayAssign.endTime}`
        : (displayShift?.hours || reinf?.shift?.hours || "");
      const myRank  = app.user.rank || "";

      // Coworker carousel
      const sourceAssignments = isCrossBranchReinf && reinf.status === "approved"
        ? [{ userId: app.user.id, userName: app.user.fullName, isReinforcement: false }]
        : (displayShift?.assignments || []);
      const allWorkers = sourceAssignments.map(a => {
        const u = app.users?.find(u => u.id === a.userId);
        const isReinf = !!a.isReinforcement;
        const reinfBranch = isReinf
          ? (u?.branchIds || []).map(bid => app.branches.find(b => b.id === bid)?.name).filter(Boolean)
              .filter(name => name !== app.currentBranch?.name)[0] || ""
          : "";
        return {
          name: a.userName || u?.fullName || "עובד",
          rank: u?.rank || "",
          isMe: a.userId === app.user.id,
          isReinforcement: isReinf,
          reinfBranch,
        };
      });
      const coworkerHtml = allWorkers.length ? `
        <div class="ep-coworkers-label">
          <span class="ep-meta-icon">👥</span>עובדים במשמרת (${allWorkers.length})
        </div>
        <div class="ep-coworker-carousel">
          ${allWorkers.map(w => `
            <div class="ep-coworker-item">
              <div class="ep-coworker-avatar${w.isMe ? " me" : (w.isReinforcement ? " ep-coworker-avatar--reinf" : "")}"><span class="ep-avatar-initials">${avatarInitials(w.name)}</span></div>
              <div class="ep-coworker-name">${w.name.split(" ")[0]}</div>
              ${w.isReinforcement && w.reinfBranch
                ? `<div class="ep-coworker-rank" style="color:#7c3aed">${w.reinfBranch}</div>`
                : (w.rank ? `<div class="ep-coworker-rank">${w.rank}</div>` : "")}
            </div>`).join("")}
        </div>` : "";

      let badgesHtml = "";
      if (reinf?.status === "approved")
        badgesHtml += `<div class="ep-reinforcement-badge">🔵 תגבור ב${reinf.branch?.name || "סניף אחר"}</div>`;
      const other = isCrossBranchReinf ? null : displayShift?.myOtherCommitment;
      if (other)
        badgesHtml += `<div class="ep-other-badge">✓ ${other.type === "assignment" ? "משובץ" : "זמין"} ב${other.branchName} · ${other.hours}</div>`;
      const shiftTaxiRequests = isAssigned && displayShift?.id
        ? taxiRequests.filter(r => Number(r.shiftId) === Number(displayShift.id))
        : [];
      const approvedTaxiItems = summarizeTaxiRequests(shiftTaxiRequests).filter(item => item.status === "approved");
      const taxiIndicatorHtml = approvedTaxiItems.length ? `<div class="ep-taxi-badges">
        ${approvedTaxiItems.map(item => `
          <span class="ep-taxi-badge approved">
            ${taxiDirectionIcon(item.direction)}
            <span class="ep-taxi-text">מונית ${taxiDirectionLabel(item.direction)} אושרה</span>
          </span>`).join("")}
      </div>` : "";

      // Check if user already submitted availability for this shift
      const myAvail = displayShift?.availability?.find(a => a.userId === app.user.id);

      let actionHtml = "";
      if (isClosedWeek && isAssigned) {
        actionHtml = `<div class="ep-shift-action-row">
          <div class="ep-shift-action-main">
            <button class="ep-req-btn" type="button" data-open-requests>📋 בקשות</button>
          </div>
          ${taxiIndicatorHtml}
        </div>`;
      } else if (isClosedWeek) {
        actionHtml = "";
      } else if (isAssigned) {
        actionHtml = `<div class="ep-shift-action-row">
          <div class="ep-shift-action-main">
            <button class="ep-req-btn" type="button" data-open-requests>📋 בקשות</button>
            ${reinf?.status === "approved" ? `<button class="ep-req-btn" style="margin-right:6px;color:var(--red);border-color:rgba(220,38,38,.3)" type="button" data-cancel-reinf>בטל תגבור</button>` : ""}
          </div>
          ${taxiIndicatorHtml}
        </div>`;
      } else if (reinf?.status === "open") {
        actionHtml = `<div class="ep-shift-action-row" style="display:flex;gap:8px;margin-top:10px">
          <button class="ep-req-btn" style="color:var(--green);border-color:rgba(22,163,74,.3)" type="button" data-answer-approved>✓ מאשר</button>
          <button class="ep-req-btn" style="color:var(--red);border-color:rgba(220,38,38,.3)" type="button" data-answer-rejected>✕ מסרב</button>
        </div>`;
      } else if (displayShift && !displayShift.isReinforcementOnly && !isAssigned) {
        // Published but not assigned to this shift — show availability checkbox
        const checked = !!myAvail;
        actionHtml = `<div class="ep-avail-toggle${checked ? " checked" : ""}" data-avail-toggle>
          <div class="ep-checkbox-mark">${checked ? "✓" : ""}</div>
          <span>${checked ? "זמינות נשלחה" : "הגש זמינות"}</span>
        </div>`;
      }

      const shiftDiv = document.createElement("div");
      shiftDiv.className = "ep-shift-card";
      shiftDiv.innerHTML = `
        <div class="ep-shift-top">
          <div class="ep-shift-title-block">
            <div class="ep-shift-name">${label}${isAssigned ? ' <span class="ep-shift-assigned-badge">משובץ ✓</span>' : ""}</div>
            <div class="ep-shift-meta">
              <div class="ep-shift-meta-row"><span class="ep-meta-icon">🕐</span>${myHours}</div>
              ${myRank ? `<div class="ep-shift-meta-row"><span class="ep-meta-icon">🏷</span>${displayBranchName} · ${myRank}</div>` : ""}
            </div>
            ${displayAssign?.startTime ? `<div class="ep-arrival-time"><span class="ep-meta-icon">📍</span>הגעת ${displayAssign.startTime}</div>` : ""}
            ${badgesHtml}
          </div>
          <div class="ep-shift-icon ${slot}">${icon}</div>
        </div>
        ${coworkerHtml}
        ${actionHtml}`;

      const rs = displayShift || (reinf ? {
        id: reinf.shiftId, dayKey: reinf.shift?.dayKey,
        slot: reinf.shift?.slot, hours: reinf.shift?.hours,
      } : null);
      shiftDiv.querySelector("[data-open-requests]")?.addEventListener("click", () => openShiftRequestMenu(rs, canPull && !!displayShift && !displayShift.isReinforcementOnly, isClosedWeek));
      shiftDiv.querySelector("[data-cancel-reinf]")?.addEventListener("click", () => answerReinforcementRequest(reinf.id, "rejected"));
      shiftDiv.querySelector("[data-answer-approved]")?.addEventListener("click", () => answerReinforcementRequest(reinf.id, "approved"));
      shiftDiv.querySelector("[data-answer-rejected]")?.addEventListener("click", () => answerReinforcementRequest(reinf.id, "rejected"));
      shiftDiv.querySelector("[data-avail-toggle]")?.addEventListener("click", async function() {
        const isChecked = this.classList.contains("checked");
        try {
          let taxiDirections = [];
          if (!isChecked && displayShift?.dayKey === "sat") {
            taxiDirections = await askSaturdayTaxiDirections();
            if (taxiDirections === null) return;
          }
          await api("POST", "/api/availability", { shiftId: displayShift.id, note: "", taxiDirections });
          this.classList.toggle("checked", !isChecked);
          const mark = this.querySelector(".ep-checkbox-mark");
          mark.textContent = !isChecked ? "✓" : "";
          const label = this.querySelector("span");
          if (label) label.textContent = !isChecked ? "זמינות נשלחה" : "הגש זמינות";
        } catch(e) {
          if (e.status === 409 && e.data?.error === "availability_conflict") {
            alert("יש כבר זמינות או שיבוץ בסניף אחר באותו זמן");
          } else if (e.status === 409 && e.data?.error === "week_locked") {
            alert("השבוע נסגר ולכן לא ניתן לשנות זמינות.");
          } else {
            alert("שגיאה בהגשת זמינות");
          }
        }
      });

      card.appendChild(shiftDiv);
    });

  slide.appendChild(card);
}

function buildModeA(slide, ws, dk, d, holiday, morningShift, eveningShift, myMorningAvail, myEveningAvail) {
  const dayName = DAY_LABELS[dk];

  const card = document.createElement("div");
  card.className = "ep-avail-card";

  const hasMorning = !!morningShift;
  const hasEvening = !!eveningShift;
  const morningSelected = !!myMorningAvail;
  const eveningSelected = !!myEveningAvail;

  const selectedCount = (morningSelected ? 1 : 0) + (eveningSelected ? 1 : 0);

  card.innerHTML = `
    <div class="ep-empty-state">
      <div class="ep-empty-icon">📅</div>
      <div class="ep-empty-title">${selectedCount ? "זמינות נשלחה ליום זה" : "טרם הוגשה זמינות ליום זה"}</div>
      <div class="ep-empty-sub">${selectedCount ? "המשמרות הירוקות כבר נשלחו למנהל" : "בחר/י את המשמרות שבהן את/ה זמין/ה לעבוד"}</div>
    </div>
    <div class="ep-shifts-section">
      <div class="ep-shifts-label">
        <span>משמרות ביום זה</span>
        <span class="ep-selected-count" id="epSelectedCount">${selectedCount} נבחרו</span>
      </div>
      <div id="epShiftCheckboxes">
        ${hasMorning ? `
        <div class="ep-shift-checkbox${morningSelected ? " selected submitted" : ""}" data-slot="morning">
          <div class="ep-shift-checkbox-left">
            <div class="ep-shift-checkbox-icon morning">☀️</div>
            <div class="ep-shift-checkbox-info">
              <div class="ep-shift-checkbox-name">משמרת בוקר</div>
              <div class="ep-shift-checkbox-hours"><span>🕐</span>${morningShift.hours || ""}</div>
            </div>
          </div>
          <span class="ep-submitted-label">נשלחה</span>
          <div class="ep-checkbox-mark">${morningSelected ? "✓" : ""}</div>
        </div>` : ""}
        ${hasEvening ? `
        <div class="ep-shift-checkbox${eveningSelected ? " selected submitted" : ""}" data-slot="evening">
          <div class="ep-shift-checkbox-left">
            <div class="ep-shift-checkbox-icon evening">🌙</div>
            <div class="ep-shift-checkbox-info">
              <div class="ep-shift-checkbox-name">משמרת ערב</div>
              <div class="ep-shift-checkbox-hours"><span>🕐</span>${eveningShift.hours || ""}</div>
            </div>
          </div>
          <span class="ep-submitted-label">נשלחה</span>
          <div class="ep-checkbox-mark">${eveningSelected ? "✓" : ""}</div>
        </div>` : ""}
        ${!hasMorning && !hasEvening ? `<div style="text-align:center;padding:20px;color:var(--text3);font-size:.8rem;">אין משמרות מוגדרות ליום זה עדיין.</div>` : ""}
      </div>
    </div>
    <div class="ep-note-field">
      <textarea id="epAvailNote" placeholder="הוסף הערה למנהל (לא חובה)..." rows="2"></textarea>
    </div>
    <div class="ep-avail-info">ℹ️ הזמינות שלך תישאר עד בניית הלוז</div>
    <button class="ep-send-btn" id="epSendAvailBtn" ${selectedCount === 0 && !morningSelected && !eveningSelected ? "disabled" : ""}>
      ✈️ שלח זמינות
    </button>`;

  slide.appendChild(card);

  // Pre-fill note from existing availability
  const existingNote = myMorningAvail?.note || myEveningAvail?.note || "";
  const noteEl = card.querySelector("#epAvailNote");
  if (noteEl && existingNote) noteEl.value = existingNote;

  // Checkboxes — visual toggle only (submission happens on send button)
  let selections = { morning: morningSelected, evening: eveningSelected };
  const hadMorning = morningSelected;
  const hadEvening = eveningSelected;

  function refreshSendBtn() {
    const cnt = (selections.morning ? 1 : 0) + (selections.evening ? 1 : 0);
    const hasToCancel = (hadMorning && !selections.morning) || (hadEvening && !selections.evening);
    const sendBtn = card.querySelector("#epSendAvailBtn");
    if (sendBtn) sendBtn.disabled = cnt === 0 && !hasToCancel;
    const countEl = card.querySelector("#epSelectedCount");
    if (countEl) countEl.textContent = `${cnt} נבחרו`;
  }

  card.querySelectorAll(".ep-shift-checkbox").forEach(box => {
    box.addEventListener("click", () => {
      const slot = box.dataset.slot;
      selections[slot] = !selections[slot];
      box.classList.toggle("selected", selections[slot]);
      box.classList.toggle("submitted", (slot === "morning" ? hadMorning : hadEvening) && selections[slot]);
      box.querySelector(".ep-checkbox-mark").textContent = selections[slot] ? "✓" : "";
      refreshSendBtn();
    });
  });

  card.querySelector("#epSendAvailBtn")?.addEventListener("click", async () => {
    const note = card.querySelector("#epAvailNote")?.value.trim() || "";
    const btn = card.querySelector("#epSendAvailBtn");
    if (btn) btn.disabled = true;
    try {
      let taxiDirections = [];
      const selectedSatShift =
        (selections.morning && morningShift?.dayKey === "sat") ||
        (selections.evening && eveningShift?.dayKey === "sat");
      if (selectedSatShift) {
        taxiDirections = await askSaturdayTaxiDirections();
        if (taxiDirections === null) {
          if (btn) btn.disabled = false;
          return;
        }
      }
      for (const slot of ["morning", "evening"]) {
        const shift  = slot === "morning" ? morningShift : eveningShift;
        if (!shift) continue;
        const myAvail    = slot === "morning" ? myMorningAvail : myEveningAvail;
        const wasSelected = !!myAvail;
        const isSelected  = selections[slot];
        const prevNote    = myAvail?.note || "";

        if (isSelected && !wasSelected) {
          // New selection → create with note
          const payload = { shiftId: shift.id, note, taxiDirections: shift.dayKey === "sat" ? taxiDirections : [] };
          await api("POST", "/api/availability", payload);
        } else if (!isSelected && wasSelected) {
          // Deselection → toggle-delete
          await api("POST", "/api/availability", { shiftId: shift.id, note: "" });
        } else if (isSelected && wasSelected && shift.dayKey === "sat") {
          // Resubmission on Saturday resets taxi state and rebuilds it from the latest answer.
          await api("POST", "/api/availability", {
            shiftId: shift.id,
            note,
            taxiDirections,
            mode: "resubmit",
          });
        } else if (isSelected && wasSelected && note !== prevNote) {
          // Note changed → delete then re-create with new note
          await api("POST", "/api/availability", { shiftId: shift.id, note: "" });
          await api("POST", "/api/availability", { shiftId: shift.id, note });
        }
      }
      renderPortal();
    } catch (e) {
      if (btn) btn.disabled = false;
      if (e.status === 409 && e.data?.error === "availability_conflict") {
        const branch = e.data.branchName || "סניף אחר";
        alert(`יש כבר ${e.data.type === "assignment" ? "שיבוץ" : "זמינות"} באותו זמן ב${branch}`);
      } else {
        alert("שגיאה בהגשת זמינות: " + (e.data?.error || e.message));
      }
    }
  });
}

function updateEmployeeRequestsBadge(count) {
  const badge = document.getElementById("employeeRequestsBadge");
  if (!badge) return;
  badge.textContent = count;
  badge.hidden = !count;
}

function askSaturdayTaxiDirections() {
  return new Promise(resolve => {
    let needsTaxi = false;
    modal({
      kicker: "זמינות שבת",
      title: "האם ההגעה והחזרה מסודרות?",
      body: `
        <div class="taxi-availability-modal">
          <p class="text-muted">אם ההגעה והחזרה מסודרות, נמשיך כרגיל. אם נדרשת מונית, בחר/י איזה כיוון צריך אישור.</p>
          <div class="taxi-choice-actions">
            <button class="btn btn-success" type="button" id="taxiAllSetBtn">כן, הכל מסודר</button>
            <button class="btn btn-warning" type="button" id="taxiNeedBtn">לא, צריך מונית</button>
          </div>
          <div id="taxiDirectionArea" class="taxi-direction-area hidden">
            <label class="taxi-check"><input type="checkbox" value="arrival"> צריך מונית הגעה</label>
            <label class="taxi-check"><input type="checkbox" value="return"> צריך מונית חזור</label>
            <div class="auth-note error hidden" id="taxiModalError">יש לבחור לפחות כיוון אחד.</div>
          </div>
        </div>`,
      footer: `<button class="btn btn-primary hidden" id="taxiConfirmBtn">שלח זמינות ובקשת מונית</button>
               <button class="btn btn-ghost" id="taxiCancelBtn">ביטול</button>`
    });
    const finish = value => { closeModal(); resolve(value); };
    document.getElementById("taxiAllSetBtn").addEventListener("click", () => finish([]));
    document.getElementById("taxiNeedBtn").addEventListener("click", () => {
      needsTaxi = true;
      document.getElementById("taxiDirectionArea").classList.remove("hidden");
      document.getElementById("taxiConfirmBtn").classList.remove("hidden");
    });
    document.getElementById("taxiConfirmBtn").addEventListener("click", () => {
      const dirs = [...document.querySelectorAll("#taxiDirectionArea input:checked")].map(i => i.value);
      if (needsTaxi && !dirs.length) {
        document.getElementById("taxiModalError").classList.remove("hidden");
        return;
      }
      finish(dirs);
    });
    document.getElementById("taxiCancelBtn").addEventListener("click", () => finish(null));
  });
}

async function renderPortalRequests() {
  const el = document.getElementById("portalRequestsList");
  if (!el) return;
  const firstName = (app.user?.fullName || "").split(" ")[0];
  const titleEl = document.getElementById("reqViewTitle");
  const subEl   = document.getElementById("reqViewSub");
  if (titleEl) titleEl.textContent = firstName ? `הבקשות של ${firstName}` : "הבקשות שלי";
  if (subEl)   subEl.textContent   = firstName ? `היי ${firstName}, כאן תוכל לראות את סטטוס הבקשות שלך` : "סטטוס בקשות שעות, היעדרות וחילוף";
  try {
    const data = await api("GET", "/api/requests");
    const requests = data.requests || [];
    updateEmployeeRequestsBadge(requests.filter(r => r.type === "reinforcement" && r.status === "open").length);
    if (!requests.length) {
      el.innerHTML = `<div class="portal-mini-empty">אין בקשות עדיין.</div>`;
      return;
    }
    const typeLabels = { hours: "שינוי שעות", exit: "לא יכול להגיע", swap: "חילוף", reinforcement: "בקשת תגבור", taxi: "בקשת מונית" };
    const statusLabels = { open: "פתוח", approved: "אושר", rejected: "נדחה" };
    const statusClasses = { open: "tag-yellow", approved: "tag-green", rejected: "tag-red" };

    const rowHTML = r => {
      const shiftLabel = r.shift ? `${DAY_LABELS[r.shift.dayKey]} ${r.shift.slot === "morning" ? "בוקר" : "ערב"} · ${r.shift.hours}` : "";
      const branchLabel = r.branch?.name || "";
      const taxiLabel = r.type === "taxi" ? (r.requestedStart === "arrival" ? "מונית הגעה" : "מונית חזור") : "";
      const requested = r.type === "taxi" ? "" : (r.requestedStart ? ` · ${r.requestedStart}-${r.requestedEnd}` : "");
      const replacement = r.replacementName ? ` · מחליף: ${r.replacementName}` : "";
      const canEdit = r.status === "open" && r.type !== "reinforcement";
      return `
        <div class="portal-request-row" id="req-row-${r.id}">
          <div class="req-row-main">
            <div class="req-row-info">
              <strong>${taxiLabel || typeLabels[r.type] || r.type}${requested}</strong>
              <small>${[branchLabel, shiftLabel].filter(Boolean).join(" · ")}${replacement}${r.note ? " · " + r.note : ""}</small>
            </div>
            <div class="req-row-end">
              <span class="tag ${statusClasses[r.status] || "tag-muted"}">${statusLabels[r.status] || r.status}</span>
              ${canEdit ? `
                <div class="request-edit-actions">
                  <button class="btn btn-xs btn-outline" type="button" onclick="editRequest(${r.id})">ערוך</button>
                  <button class="btn btn-xs btn-danger" type="button" onclick="deleteRequest(${r.id})">מחק</button>
                </div>` : ""}
              ${r.type === "reinforcement" && (r.status === "open" || r.status === "approved") ? `
                <div class="request-actions">
                  ${r.status === "open" ? `<button class="btn btn-success btn-xs" type="button" onclick="answerReinforcementRequest(${r.id}, 'approved')">מאשר</button>` : ""}
                  <button class="btn btn-danger btn-xs" type="button" onclick="answerReinforcementRequest(${r.id}, 'rejected')">${r.status === "open" ? "מסרב" : "בטל"}</button>
                </div>` : ""}
            </div>
          </div>
          ${canEdit ? `
            <div class="request-edit-form hidden" id="edit-form-${r.id}">
              ${r.type === "hours" ? `
                <div class="edit-form-times">
                  <label>משעה <input type="time" id="edit-start-${r.id}" value="${r.requestedStart || ""}"></label>
                  <label>עד שעה <input type="time" id="edit-end-${r.id}" value="${r.requestedEnd || ""}"></label>
                </div>` : ""}
              <textarea id="edit-note-${r.id}" placeholder="הערה...">${r.note || ""}</textarea>
              <div class="edit-form-btns">
                <button class="btn btn-primary btn-xs" type="button" onclick="saveRequest(${r.id}, '${r.type}')">שמור</button>
                <button class="btn btn-xs btn-outline" type="button" onclick="cancelEditRequest(${r.id})">ביטול</button>
              </div>
            </div>` : ""}
        </div>`;
    };

    const reinforcementOpen = requests.filter(r => r.type === "reinforcement" && r.status === "open");
    const open   = requests.filter(r => r.status === "open");
    const closed = requests.filter(r => r.status !== "open");
    let html = "";
    if (reinforcementOpen.length) {
      html += `
        <div class="portal-reinforcement-card portal-requests-reinforcement">
          <div>
            <strong>${reinforcementOpen.length === 1 ? "\u05d1\u05e7\u05e9\u05ea \u05ea\u05d2\u05d1\u05d5\u05e8 \u05de\u05de\u05ea\u05d9\u05e0\u05d4 \u05dc\u05d0\u05d9\u05e9\u05d5\u05e8\u05da" : `${reinforcementOpen.length} \u05d1\u05e7\u05e9\u05d5\u05ea \u05ea\u05d2\u05d1\u05d5\u05e8 \u05de\u05de\u05ea\u05d9\u05e0\u05d5\u05ea \u05dc\u05d0\u05d9\u05e9\u05d5\u05e8\u05da`}</strong>
            <small>\u05d0\u05dc\u05d5 \u05d1\u05e7\u05e9\u05d5\u05ea \u05d3\u05d7\u05d5\u05e4\u05d5\u05ea \u05de\u05e1\u05e0\u05d9\u05e4\u05d9\u05dd \u05d0\u05d7\u05e8\u05d9\u05dd. \u05d0\u05e4\u05e9\u05e8 \u05dc\u05e2\u05e0\u05d5\u05ea \u05e2\u05dc\u05d9\u05d4\u05df \u05de\u05db\u05d0\u05df.</small>
          </div>
          <button class="btn btn-primary btn-sm" type="button" onclick="openReinforcementAlertsModalByIds('${reinforcementOpen.map(r => r.id).join(",")}')">\u05e4\u05ea\u05d7 \u05d7\u05dc\u05d5\u05e0\u05d9\u05ea</button>
        </div>`;
    }
    if (open.length) {
      html += `<div class="req-section-header">ממתינות לטיפול</div>` + open.map(rowHTML).join("");
    }
    if (closed.length) {
      html += `<div class="req-section-header req-section-closed">טופלו</div>` + closed.slice(0, 20).map(rowHTML).join("");
    }
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<div class="portal-mini-empty">לא ניתן לטעון בקשות כרגע.</div>`;
  }
}

window.editRequest = function(id) {
  document.querySelectorAll(".request-edit-form").forEach(f => f.classList.add("hidden"));
  const form = document.getElementById(`edit-form-${id}`);
  if (form) form.classList.remove("hidden");
};

window.cancelEditRequest = function(id) {
  document.getElementById(`edit-form-${id}`)?.classList.add("hidden");
};

window.deleteRequest = async function(id) {
  if (!confirm("למחוק את הבקשה?")) return;
  try {
    await api("DELETE", `/api/requests/${id}`);
    await renderPortalRequests();
  } catch(e) {
    if (e.status === 409) alert("הבקשה כבר טופלה ולא ניתן למחוק אותה.");
    else alert("שגיאה במחיקת הבקשה: " + (e.data?.error || e.message));
  }
};

window.saveRequest = async function(id, type) {
  const note = document.getElementById(`edit-note-${id}`)?.value.trim() ?? "";
  const payload = { note };
  if (type === "hours") {
    payload.requestedStart = document.getElementById(`edit-start-${id}`)?.value || null;
    payload.requestedEnd   = document.getElementById(`edit-end-${id}`)?.value || null;
  }
  try {
    await api("PUT", `/api/requests/${id}`, payload);
    await renderPortalRequests();
  } catch(e) {
    if (e.status === 409) alert("הבקשה כבר טופלה ולא ניתן לערוך אותה.");
    else alert("שגיאה בשמירת הבקשה: " + (e.data?.error || e.message));
  }
};

function reinfAlertRowHTML(r) {
  const shiftLabel = r.shift
    ? `${DAY_LABELS[r.shift.dayKey]} ${r.shift.slot === "morning" ? "בוקר" : "ערב"} · ${r.shift.hours}`
    : "";
  const branchLabel = r.branch?.name || "";
  return `
    <div class="reinf-alert">
      <div class="reinf-alert-text">
        <strong>בקשת תגבור</strong>
        <span>${[branchLabel, shiftLabel].filter(Boolean).join(" · ")}</span>
      </div>
      <div class="reinf-alert-btns">
        <button class="btn btn-success btn-xs" type="button" onclick="answerReinforcementRequest(${r.id},'approved')">אני מגיע ✓</button>
        <button class="btn btn-xs btn-outline" type="button" onclick="answerReinforcementRequest(${r.id},'rejected')">לא יכול</button>
      </div>
    </div>`;
}

function reinforcementAlertsKey(alerts) {
  return alerts.map(r => r.id).sort((a, b) => a - b).join(",");
}

async function renderPortalReinforcementAlerts() {
  const el    = document.getElementById("portalReinforcementAlerts");
  const bell  = document.getElementById("portalBellBtn");
  const badge = document.getElementById("portalBellBadge");
  if (!el) return;
  try {
    const data   = await api("GET", "/api/requests");
    const alerts = (data.requests || []).filter(r => r.type === "reinforcement" && r.status === "open");

    if (!alerts.length) {
      el.classList.add("hidden");
      bell?.classList.add("hidden");
      app.reinforcementPromptKey = "";
      return;
    }

    bell?.classList.add("hidden");
    if (badge) badge.textContent = "";
    updateEmployeeRequestsBadge(alerts.length);

    el.classList.remove("hidden");
    el.innerHTML = `
      <div class="portal-reinforcement-card portal-reinforcement-summary">
        <div>
          <strong>${alerts.length === 1 ? "\u05d9\u05e9 \u05dc\u05da \u05d1\u05e7\u05e9\u05ea \u05ea\u05d2\u05d1\u05d5\u05e8 \u05d7\u05d3\u05e9\u05d4" : `\u05d9\u05e9 \u05dc\u05da ${alerts.length} \u05d1\u05e7\u05e9\u05d5\u05ea \u05ea\u05d2\u05d1\u05d5\u05e8`}</strong>
          <small>\u05d0\u05e4\u05e9\u05e8 \u05dc\u05d0\u05e9\u05e8 \u05d0\u05d5 \u05dc\u05e1\u05e8\u05d1 \u05db\u05d0\u05df, \u05d5\u05d2\u05dd \u05de\u05de\u05e1\u05da \u05d4\u05d1\u05e7\u05e9\u05d5\u05ea \u05e9\u05dc\u05d9.</small>
        </div>
        <button class="btn btn-primary btn-sm" type="button" id="openReinfRequestsBtn">\u05e4\u05ea\u05d7 \u05d1\u05e7\u05e9\u05d5\u05ea</button>
      </div>`;
    document.getElementById("openReinfRequestsBtn")?.addEventListener("click", () => openReinforcementAlertsModal(alerts));

    const key = reinforcementAlertsKey(alerts);
    if (!app.suppressReinforcementPrompt && app.reinforcementPromptKey !== key) {
      app.reinforcementPromptKey = key;
      setTimeout(() => openReinforcementAlertsModal(alerts), 120);
    }
    return;

    if (!alerts.length) {
      el.classList.add("hidden");
      bell?.classList.add("hidden");
      return;
    }

    if (alerts.length === 1) {
      // Single alert — show inline, hide bell
      bell?.classList.add("hidden");
      el.classList.remove("hidden");
      el.innerHTML = reinfAlertRowHTML(alerts[0]);
    } else {
      // Multiple alerts — show bell with count, hide inline list
      el.classList.add("hidden");
      if (bell) {
        bell.classList.remove("hidden");
        if (badge) badge.textContent = alerts.length;
        bell.onclick = () => openReinforcementAlertsModal(alerts);
      }
    }
  } catch(e) {
    el.classList.add("hidden");
    bell?.classList.add("hidden");
  }
}

function openReinforcementAlertsModal(alerts) {
  document.getElementById("reinfModal")?.remove();
  const modal = document.createElement("div");
  modal.id = "reinfModal";
  modal.className = "reinf-modal-overlay";
  modal.innerHTML = `
    <div class="reinf-modal">
      <div class="reinf-modal-header">
        <h3>בקשות תגבור (${alerts.length})</h3>
        <button class="reinf-modal-close" type="button" onclick="document.getElementById('reinfModal').remove()">×</button>
      </div>
      <div class="reinf-modal-body">
        ${alerts.map(reinfAlertRowHTML).join("")}
      </div>
    </div>`;
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

window.openReinforcementAlertsModalByIds = async function(ids) {
  const wanted = String(ids || "").split(",").map(Number).filter(Boolean);
  try {
    const data = await api("GET", "/api/requests");
    const alerts = (data.requests || []).filter(r => wanted.includes(r.id));
    if (alerts.length) openReinforcementAlertsModal(alerts);
  } catch(e) {
    alert("לא ניתן לטעון בקשות תגבור כרגע.");
  }
};

window.answerReinforcementRequest = async function(id, status) {
  try {
    await api("PUT", `/api/requests/${id}`, { status });
  } catch (e) {
    if (e.status === 409 && e.data?.error === "assignment_conflict") {
      alert(`כבר יש לך ${e.data.type === "assignment" ? "שיבוץ" : "זמינות"} באותו זמן ב${e.data.branchName || "סניף אחר"}`);
      return;
    }
    if (e.status === 409 && e.data?.error === "week_locked") {
      alert("לא ניתן לבטל תגבור אחרי שהלוז פורסם.");
      return;
    }
    alert("שגיאה בעדכון בקשת תגבור");
    return;
  }
  document.getElementById("reinfModal")?.remove();
  app.suppressReinforcementPrompt = true;
  try {
    await renderPortalRequests();
    await renderPortalReinforcementAlerts();
    app.currentWeek = null;
    await renderPortal();
  } finally {
    app.suppressReinforcementPrompt = false;
  }
};

function renderPortalBranchBar() {
  const el = document.getElementById("portalBranchBar");
  if (!el) return;
  if (!app.branches.length) {
    el.innerHTML = "";
    return;
  }
  if (!app.currentBranch) app.currentBranch = app.branches[0];
  if (app.branches.length === 1) {
    const b = app.currentBranch;
    el.innerHTML = `<span class="portal-branch-chip">${b.name}</span>`;
    return;
  }
  el.innerHTML = `
    <label class="portal-branch-select">
      <span>סניף</span>
      <select id="portalBranchSelect">
        ${app.branches.map(b => `<option value="${b.id}" ${app.currentBranch?.id === b.id ? "selected" : ""}>${b.name}</option>`).join("")}
      </select>
    </label>`;
  document.getElementById("portalBranchSelect").addEventListener("change", e => {
    app.currentBranch = app.branches.find(b => b.id === Number(e.target.value)) || app.currentBranch;
    app.currentWeek = null;
    renderPortal();
  });
}

function openShiftRequestMenu(shift, canPullAvailability, hoursOnly = false) {
  const label = shift.slot === "morning" ? "בוקר" : "ערב";
  modal({
    kicker: "בקשות",
    title: `${DAY_LABELS[shift.dayKey]} ${label}`,
    body: `
      <div class="portal-request-menu">
        <button class="btn btn-ghost" type="button" data-request-type="hours">עדכון שעות</button>
        ${hoursOnly ? "" : `
        <button class="btn btn-ghost" type="button" data-request-type="exit">לא יכול להגיע</button>
        <button class="btn btn-ghost" type="button" data-request-type="swap">מצאתי מחליף</button>
        ${canPullAvailability ? `<button class="btn btn-danger" type="button" data-pull-availability>בטל זמינות</button>` : ""}`}
      </div>`,
    footer: `<button class="btn btn-ghost" id="cancelModalBtn">סגור</button>`
  });
  document.querySelectorAll("#modalBody [data-request-type]").forEach(btn => {
    btn.addEventListener("click", () => {
      closeModal();
      openEmployeeRequestModal(btn.dataset.requestType, shift.id, shift);
    });
  });
  document.querySelector("#modalBody [data-pull-availability]")?.addEventListener("click", async () => {
    await api("POST", "/api/availability/pull", { shiftId: shift.id });
    closeModal();
    await renderPortal();
  });
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
}

// ── Employee change requests (portal) ─────────────────────────────────────────
async function openEmployeeRequestModal(type, preferredShiftId = null, preferredShift = null) {
  const week = await ensurePortalWeekForRequests();
  if (!week && !preferredShift) {
    alert("אין עדיין סידור שבועי פתוח לבקשות. אפשר להגיש זמינות, וברגע שתשובץ תוכל לשלוח בקשות שינוי."); return;
  }
  let myShifts = (app.currentWeek?.shifts || [])
    .filter(s => s.assignments?.some(a => a.userId === app.user.id));
  if (preferredShift && !myShifts.some(s => s.id === preferredShift.id)) {
    myShifts = [preferredShift, ...myShifts];
  }
  if (!myShifts.length) {
    alert("אין משמרות משובצות השבוע."); return;
  }
  const shiftOptions = myShifts.map(s =>
    `<option value="${s.id}" ${s.id === preferredShiftId ? "selected" : ""}>${s.branchName ? s.branchName + " · " : ""}${DAY_LABELS[s.dayKey]} ${s.slot==="morning"?"בוקר":"ערב"} · ${s.hours}</option>`
  ).join("");

  const typeLabel = type === "hours" ? "עדכון שעות" : type === "exit" ? "לא יכול להגיע" : "מצאתי מחליף";
  let extraFields = "";
  if (type === "hours") {
    extraFields = `
      <div class="field"><label>שעת כניסה</label><input type="time" id="reqStart" /></div>
      <div class="field"><label>שעת יציאה</label><input type="time" id="reqEnd" /></div>`;
  }
  if (type === "swap") {
    extraFields = `
      <div class="field full"><label>מחליף</label>
        <select id="reqReplacement"></select>
        <small class="text-muted" id="reqReplacementNote"></small>
      </div>`;
  }

  modal({
    kicker: "אזור עובד",
    title: typeLabel,
    body: `
      <div class="form-grid">
        <div class="field full"><label>משמרת</label><select id="reqShift">${shiftOptions}</select></div>
        ${extraFields}
        <div class="field full"><label>הערה</label><textarea id="reqNote" placeholder="לא חובה"></textarea></div>
      </div>`,
    footer: `<button class="btn btn-primary" id="submitReq">שלח בקשה</button>
             <button class="btn btn-ghost" id="cancelModalBtn">ביטול</button>`
  });
  const refreshReplacementOptions = async () => {
    if (type !== "swap") return;
    const shiftId = Number(document.getElementById("reqShift").value);
    const replacementSelect = document.getElementById("reqReplacement");
    const noteEl = document.getElementById("reqReplacementNote");
    replacementSelect.innerHTML = "";
    replacementSelect.disabled = true;
    noteEl.textContent = "טוען מחליפים זמינים...";
    try {
      const data = await api("GET", `/api/shifts/${shiftId}/replacement-candidates`);
      const candidates = data.candidates || [];
      replacementSelect.innerHTML = candidates.map(u => `<option value="${u.id}">${u.fullName}${u.rank ? " · " + u.rank : ""}</option>`).join("");
      replacementSelect.disabled = !candidates.length;
      noteEl.textContent = candidates.length ? "" : "אין עובדים זמינים שלא שובצו למשמרת הזאת.";
    } catch (e) {
      noteEl.textContent = "לא ניתן לטעון מחליפים כרגע.";
    }
  };
  document.getElementById("reqShift").addEventListener("change", () => refreshReplacementOptions());
  refreshReplacementOptions();
  document.getElementById("submitReq").addEventListener("click", async () => {
    const shiftId = Number(document.getElementById("reqShift").value);
    const note    = document.getElementById("reqNote").value;
    const body = { type, shiftId, note };
    if (type === "hours") {
      body.requestedStart = document.getElementById("reqStart").value;
      body.requestedEnd   = document.getElementById("reqEnd").value;
    }
    if (type === "swap") {
      if (!document.getElementById("reqReplacement").value) return alert("אין מחליף זמין לבחירה במשמרת הזאת");
      body.replacementId = Number(document.getElementById("reqReplacement").value);
    }
    try {
      await api("POST", "/api/requests", body);
      closeModal();
    } catch (e) {
      if (e.status === 409 && e.data?.error === "week_locked") {
        alert("השבוע נסגר. ניתן לשלוח רק בקשת עדכון שעות.");
      } else {
        alert("שגיאה בשליחת בקשה");
      }
    }
  });
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  loadHolidays(); // fire-and-forget; HOLIDAYS updated in background

  document.getElementById("menuToggle").addEventListener("click", () => {
    setMenuOpen(!document.body.classList.contains("menu-open"));
  });
  document.getElementById("menuBackdrop").addEventListener("click", () => setMenuOpen(false));
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") setMenuOpen(false);
  });

  // Bind nav
  document.querySelectorAll(".nav-item").forEach(b => {
    b.addEventListener("click", () => {
      if (b.dataset.view === "schedule" && app.user?.role !== "employee" && app.branches.length > 1) {
        app.currentBranch = null;
        app.currentWeek = null;
      }
      showView(b.dataset.view);
    });
  });
  document.querySelectorAll("#employeeBottomNav [data-view]").forEach(b => {
    b.addEventListener("click", () => showView(b.dataset.view));
  });

  // Auth tabs
  document.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("loginPanel").hidden    = tab.dataset.authTab !== "login";
      document.getElementById("registerPanel").hidden = tab.dataset.authTab !== "register";
      if (tab.dataset.authTab !== "login") setLoginAsEmployeeVisible(false);
      if (tab.dataset.authTab === "register") loadPublicBranches();
      history.replaceState(null, "", tab.dataset.authTab === "register" ? "#register" : "#login");
    });
  });

  // Auth actions
  document.getElementById("sendCodeBtn").addEventListener("click", sendCode);
  document.getElementById("loginBtn").addEventListener("click", login);
  document.getElementById("submitRegBtn").addEventListener("click", submitRegistration);
  document.getElementById("logoutBtn").addEventListener("click", logout);

  // Dev login toggle
  document.getElementById("devLoginToggle").addEventListener("click", () => {
    const panel = document.getElementById("devLoginPanel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) document.getElementById("devPassword").focus();
  });
  document.getElementById("devLoginBtn").addEventListener("click", devLogin);
  document.getElementById("devPassword").addEventListener("keydown", e => {
    if (e.key === "Enter") devLogin();
  });
  document.getElementById("devRefreshBtn")?.addEventListener("click", loadDevView);
  document.getElementById("devLogoutBtn")?.addEventListener("click", logout);

  // Modal close
  document.getElementById("closeModal").addEventListener("click", closeModal);
  document.getElementById("modalBackdrop").addEventListener("click", e => {
    if (e.target.id === "modalBackdrop") closeModal();
  });

  // Schedule week nav
  document.getElementById("prevWeek").addEventListener("click", () => {
    app.weekStart = addDays(app.weekStart, -7);
    loadWeekView();
  });
  document.getElementById("nextWeek").addEventListener("click", () => {
    app.weekStart = addDays(app.weekStart, 7);
    loadWeekView();
  });

  // Drawer buttons
  document.getElementById("toggleShortageBtn").addEventListener("click", () => {
    if (!app.currentWeek) return;
    const shift = app.currentWeek.shifts?.find(s => s.id === app.selectedShiftId);
    if (!shift) return;
    if (shift.shortage) {
      api("PUT", `/api/shifts/${shift.id}`, { ...shift, shortage: null }).then(loadWeekView);
    } else {
      openShortageModal(shift);
    }
  });
  document.getElementById("markStaffedBtn").addEventListener("click", () => {
    if (!app.currentWeek) return;
    const shift = app.currentWeek.shifts?.find(s => s.id === app.selectedShiftId);
    if (shift) setShiftStaffed(shift);
  });
  document.getElementById("addReinforcementBtn").addEventListener("click", () => {
    const shift = app.currentWeek?.shifts?.find(s => s.id === app.selectedShiftId);
    if (shift) openReinforcementModal(shift);
  });

  // Employees filters
  document.getElementById("employeeSearch").addEventListener("input", renderEmployees);
  document.getElementById("rankFilter").addEventListener("change", renderEmployees);
  document.getElementById("statusFilter").addEventListener("change", renderEmployees);
  document.getElementById("pendingEmployeesBtn").addEventListener("click", () => {
    document.getElementById("statusFilter").value = "pending";
    renderEmployees();
  });

  // Add employee (manager can manually add)
  document.getElementById("addEmployeeBtn").addEventListener("click", () => {
    window.openEditEmployeeModal = undefined; // prevent confusion
    const branchOptions = app.branches.map(b => `<option value="${b.id}" ${app.currentBranch?.id === b.id ? "selected" : ""}>${b.name}${b.number ? " · " + b.number : ""}</option>`).join("");
    modal({
      kicker: "עובדים",
      title: "הוספת עובד ידנית",
      body: `
        <div class="form-grid">
          <div class="field"><label>שם מלא</label><input id="na-name" /></div>
          <div class="field"><label>תעודת זהות</label><input id="na-id" /></div>
          <div class="field"><label>טלפון</label><input id="na-phone" /></div>
          <div class="field"><label>מייל</label><input type="email" id="na-email" /></div>
          <div class="field"><label>שכר שעתי (₪)</label><input type="number" id="na-wage" value="38" /></div>
          <div class="field"><label>דרגה</label><select id="na-rank"><option>מוכרן</option><option>קופאי</option></select></div>
          <div class="field full"><label>סניף</label><select id="na-branch">${branchOptions}</select></div>
        </div>`,
      footer: `<button class="btn btn-primary" id="saveNA">הוסף</button>
               <button class="btn btn-ghost" id="cancelModalBtn">ביטול</button>`
    });
    document.getElementById("saveNA").addEventListener("click", async () => {
      try {
        const selectedBranchId = Number(document.getElementById("na-branch").value || 0);
        await api("POST", "/api/users/register", {
          fullName: document.getElementById("na-name").value,
          idNumber: document.getElementById("na-id").value,
          phone:    document.getElementById("na-phone").value,
          email:    document.getElementById("na-email").value,
          hourlyWage: Number(document.getElementById("na-wage").value),
          branchId: selectedBranchId,
        });
        // Auto-approve
        const ud = await api("GET", "/api/users?status=pending");
        const pending = ud.users.find(u => u.idNumber === document.getElementById("na-id").value);
        if (pending) {
          await api("POST", "/api/users/approve", { userId: pending.id });
          await api("PUT", `/api/users/${pending.id}`, {
            ...pending,
            status: "active",
            branchIds: selectedBranchId ? [selectedBranchId] : [],
          });
        }
        const ud2 = await api("GET", "/api/users");
        app.users = ud2.users || [];
        closeModal();
        renderEmployees();
      } catch (e) { alert("שגיאה בהוספת עובד: " + (e.data?.error || e.message)); }
    });
    document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
  });

  // Reports
  document.getElementById("salesTarget").addEventListener("input", calcReportKPIs);
  document.getElementById("actualSales").addEventListener("input", calcReportKPIs);
  document.getElementById("saveReportBtn").addEventListener("click", saveReport);
  document.getElementById("reportBranchSelect").addEventListener("change", loadReports);
  document.getElementById("reportDate").addEventListener("change", updateReportTargetFromSchedule);

  // Area
  document.getElementById("shortageFilter").addEventListener("change", loadAreaShortages);
  document.getElementById("requestsBranchSelect").addEventListener("change", e => {
    app.requestsBranchId = Number(e.target.value || 0) || null;
    loadRequests();
  });
  document.getElementById("addReminderSlotBtn")?.addEventListener("click", () => {
    document.getElementById("availabilityReminderSlots").insertAdjacentHTML("beforeend", reminderSlotHTML());
  });
  document.getElementById("availabilityReminderSlots")?.addEventListener("click", e => {
    const removeBtn = e.target.closest("[data-remove-reminder]");
    if (!removeBtn) return;
    removeBtn.closest(".notification-slot-row")?.remove();
    const slots = document.getElementById("availabilityReminderSlots");
    if (!slots.querySelector(".notification-slot-row")) slots.innerHTML = reminderSlotHTML();
  });
  document.getElementById("saveNotificationSettingsBtn")?.addEventListener("click", saveNotificationSettings);

  // Network
  document.getElementById("addBranchBtn").addEventListener("click", openAddBranchModal);
  document.getElementById("addManagerBtn").addEventListener("click", () => {
    const branchChecks = app.branches.map(b => `
      <label class="check-row">
        <input type="checkbox" value="${b.id}" />
        <span>${b.name}${b.number ? " · " + b.number : ""}</span>
      </label>`).join("") || `<div class="text-muted">אין סניפים לשיוך. צור סניף קודם.</div>`;
    // Open a simplified "add manager" modal – registers then promotes
    modal({
      kicker: "מנהלים",
      title: "הוספת מנהל",
      body: `
        <div class="form-grid">
          <div class="field"><label>שם מלא</label><input id="nm-name" /></div>
          <div class="field"><label>תעודת זהות</label><input id="nm-id" /></div>
          <div class="field"><label>מייל</label><input type="email" id="nm-email" /></div>
          <div class="field"><label>טלפון</label><input id="nm-phone" /></div>
          <div class="field full"><label>תפקיד</label>
            <select id="nm-role">
              <option value="branch-manager">מנהל סניף</option>
              <option value="area-manager">מנהל אזור</option>
              <option value="network-manager">מנהל רשת</option>
            </select>
          </div>
          <div class="field full"><label>סניפים משויכים</label><div class="check-list" id="nm-branches">${branchChecks}</div></div>
        </div>`,
      footer: `<button class="btn btn-primary" id="saveNM">צור מנהל</button>
               <button class="btn btn-ghost" id="cancelModalBtn">ביטול</button>`
    });
    document.getElementById("saveNM").addEventListener("click", async () => {
      try {
        const regRes = await api("POST", "/api/users/register", {
          fullName: document.getElementById("nm-name").value,
          idNumber: document.getElementById("nm-id").value,
          email:    document.getElementById("nm-email").value,
          phone:    document.getElementById("nm-phone").value,
        });
        const userId = regRes.user.id;
        await api("POST", "/api/users/approve", { userId });
        const branchIds = [...document.querySelectorAll("#nm-branches input:checked")].map(x => Number(x.value));
        await api("PUT", `/api/users/${userId}`, {
          role: document.getElementById("nm-role").value,
          branchIds,
        });
        const ud = await api("GET", "/api/users");
        app.users = ud.users || [];
        closeModal();
        loadNetworkView();
      } catch (e) { alert("שגיאה ביצירת מנהל: " + (e.data?.error || e.message)); }
    });
    document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
  });

  // Portal week navigation
  document.getElementById("portalPrevWeek").addEventListener("click", () => {
    app.portalWeekStart = addDays(app.portalWeekStart || todayWeekStart(), -7);
    window._portalSelectedDay = portalTodayDayIndex(app.portalWeekStart);
    renderPortal();
  });
  document.getElementById("portalNextWeek").addEventListener("click", () => {
    app.portalWeekStart = addDays(app.portalWeekStart || todayWeekStart(), 7);
    window._portalSelectedDay = portalTodayDayIndex(app.portalWeekStart);
    renderPortal();
  });

  // Portal actions
  document.getElementById("portalLogoutBtn").addEventListener("click", logout);

  // Check setup + auth
  await refreshDevConsoleVisibility();
  try {
    const setup = await api("GET", "/api/setup-required");
    app.setupRequired = setup.required;
    await loadPublicBranches();
    if (app.setupRequired) {
      // Switch to register tab for first-run
      document.querySelector('[data-auth-tab="register"]').click();
    }
    renderSetupState();
    if (!app.setupRequired && window.location.hash === "#register") {
      document.querySelector('[data-auth-tab="register"]').click();
    } else if (window.location.hash === "#login") {
      document.querySelector('[data-auth-tab="login"]').click();
    }
  } catch (e) { console.warn("setup check failed", e); }

  // Try to restore session
  if (app.token) {
    try {
      const me = await api("GET", "/api/me");
      app.user = me.user;
      await loadInitialData();
      applyRoleAccess();
      showView(defaultView(app.user.role));
      startAutoRefresh();
    } catch (e) {
      app.token = "";
      clearStoredToken();
      applyRoleAccess();
      showView("auth");
    }
  } else {
    applyRoleAccess();
    showView("auth");
  }

  document.getElementById("loadingOverlay").hidden = true;
}

bootstrap();


