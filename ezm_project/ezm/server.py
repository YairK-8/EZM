from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import queue
import secrets
import smtplib
import socket
import sqlite3
import sys
import threading
import time

from collections import deque
from datetime import datetime, timedelta
from email.message import EmailMessage
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent


def load_env_file() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


load_env_file()

DATA_DIR = Path(os.environ.get("EZM_DATA_DIR", ROOT / "data"))
DB_PATH = Path(os.environ.get("EZM_DB_PATH", DATA_DIR / "ezm.sqlite3"))
TOKEN_SECRET = os.environ.get("EZM_TOKEN_SECRET", "change-me-before-production")
OTP_TTL_SECONDS = int(os.environ.get("EZM_OTP_TTL_SECONDS", "600"))
DEV_PASSWORD = os.environ.get("EZM_DEV_PASSWORD", "").strip()
DEV_ENABLED = bool(DEV_PASSWORD)

_SERVER_START = time.time()
_req_count:   list[int] = [0]
_err_count:   list[int] = [0]
_req_log: deque = deque(maxlen=500)   # (timestamp, duration_ms, is_error: bool)
_event_clients: set[queue.Queue] = set()
_event_lock = threading.Lock()
APP_TZ = ZoneInfo(os.environ.get("EZM_TIMEZONE", "Asia/Jerusalem"))
_scheduler_started = False
SHIFT_SLOTS = ("morning", "middle", "evening")
DEFAULT_SHIFT_SLOTS = ("morning", "evening")
SHIFT_SLOT_LABELS = {"morning": "בוקר", "middle": "אמצע", "evening": "ערב"}


def db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db() -> None:
    with db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              full_name TEXT NOT NULL,
              id_number TEXT NOT NULL UNIQUE,
              phone TEXT,
              email TEXT NOT NULL,
              role TEXT NOT NULL CHECK(role IN ('network-manager','area-manager','branch-manager','employee')),
              status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','pending','inactive')),
              hourly_wage REAL,
              rank TEXT DEFAULT 'מוכרן',
              is_lead INTEGER NOT NULL DEFAULT 0,
              manager_note TEXT,
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS branches (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE,
              number TEXT,
              area TEXT NOT NULL DEFAULT 'מרכז',
              manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
              labor_target REAL NOT NULL DEFAULT 12.4,
              morning_hours TEXT NOT NULL DEFAULT '09:00-15:00',
              evening_hours TEXT NOT NULL DEFAULT '15:00-22:00',
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS user_branches (
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
              PRIMARY KEY (user_id, branch_id)
            );

            CREATE TABLE IF NOT EXISTS weeks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
              week_start TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','closed')),
              created_at INTEGER NOT NULL,
              UNIQUE(branch_id, week_start)
            );

            CREATE TABLE IF NOT EXISTS shifts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
              day_key TEXT NOT NULL,
              slot TEXT NOT NULL CHECK(slot IN ('morning','middle','evening')),
              hours TEXT NOT NULL,
              sales_target INTEGER NOT NULL DEFAULT 0,
              reinforcement INTEGER NOT NULL DEFAULT 0,
              staffed INTEGER NOT NULL DEFAULT 0,
              max_employees INTEGER,
              shortage_count INTEGER,
              shortage_level TEXT,
              shortage_status TEXT,
              shortage_note TEXT,
              created_at INTEGER NOT NULL,
              UNIQUE(week_id, day_key, slot)
            );

            CREATE TABLE IF NOT EXISTS branch_shift_defaults (
              branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
              day_key TEXT NOT NULL,
              slot TEXT NOT NULL CHECK(slot IN ('morning','middle','evening')),
              hours TEXT NOT NULL,
              max_employees INTEGER,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (branch_id, day_key, slot)
            );

            CREATE TABLE IF NOT EXISTS shift_assignments (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              start_time TEXT,
              end_time TEXT,
              created_at INTEGER NOT NULL,
              UNIQUE(shift_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS shift_availability (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              note TEXT,
              created_at INTEGER NOT NULL,
              UNIQUE(shift_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS day_reports (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
              report_date TEXT NOT NULL,
              sales_target INTEGER NOT NULL DEFAULT 0,
              actual_sales INTEGER NOT NULL DEFAULT 0,
              avg_transaction REAL NOT NULL DEFAULT 0,
              avg_items REAL NOT NULL DEFAULT 0,
              created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
              created_at INTEGER NOT NULL,
              UNIQUE(branch_id, report_date)
            );

            CREATE TABLE IF NOT EXISTS change_requests (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              type TEXT NOT NULL CHECK(type IN ('hours','exit','swap','reinforcement','taxi')),
              shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
              requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              replacement_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
              requested_start TEXT,
              requested_end TEXT,
              note TEXT,
              status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','approved','rejected')),
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS otp_codes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              code_hash TEXT NOT NULL,
              expires_at INTEGER NOT NULL,
              used_at INTEGER,
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS audit_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
              action TEXT NOT NULL,
              entity_type TEXT,
              entity_id INTEGER,
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS notification_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              kind TEXT NOT NULL,
              recipient TEXT NOT NULL,
              entity_key TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              UNIQUE(kind, recipient, entity_key)
            );

            CREATE TABLE IF NOT EXISTS email_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              kind TEXT NOT NULL,
              recipient TEXT NOT NULL,
              subject TEXT,
              status TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
        """)
        migrate_shift_slot_checks(conn)
        shift_columns = {r["name"] for r in conn.execute("PRAGMA table_info(shifts)").fetchall()}
        if "staffed" not in shift_columns:
            conn.execute("ALTER TABLE shifts ADD COLUMN staffed INTEGER NOT NULL DEFAULT 0")
        if "max_employees" not in shift_columns:
            conn.execute("ALTER TABLE shifts ADD COLUMN max_employees INTEGER")
        default_columns = {r["name"] for r in conn.execute("PRAGMA table_info(branch_shift_defaults)").fetchall()}
        if "max_employees" not in default_columns:
            conn.execute("ALTER TABLE branch_shift_defaults ADD COLUMN max_employees INTEGER")
        user_columns = {r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
        if "manager_note" not in user_columns:
            conn.execute("ALTER TABLE users ADD COLUMN manager_note TEXT")
        branch_columns = {r["name"] for r in conn.execute("PRAGMA table_info(branches)").fetchall()}
        if "is_blocked" not in branch_columns:
            conn.execute("ALTER TABLE branches ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0")
        request_sql = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='change_requests'").fetchone()
        if request_sql and "reinforcement" not in (request_sql["sql"] or ""):
            conn.executescript("""
                ALTER TABLE change_requests RENAME TO change_requests_old;
                CREATE TABLE change_requests (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  type TEXT NOT NULL CHECK(type IN ('hours','exit','swap','reinforcement')),
                  shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
                  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                  replacement_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                  requested_start TEXT,
                  requested_end TEXT,
                  note TEXT,
                  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','approved','rejected')),
                  created_at INTEGER NOT NULL
                );
                INSERT INTO change_requests(id,type,shift_id,requester_id,replacement_id,requested_start,requested_end,note,status,created_at)
                SELECT id,type,shift_id,requester_id,replacement_id,requested_start,requested_end,note,status,created_at
                FROM change_requests_old;
                DROP TABLE change_requests_old;
            """)
        request_sql = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='change_requests'").fetchone()
        if request_sql and "taxi" not in (request_sql["sql"] or ""):
            conn.executescript("""
                ALTER TABLE change_requests RENAME TO change_requests_old;
                CREATE TABLE change_requests (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  type TEXT NOT NULL CHECK(type IN ('hours','exit','swap','reinforcement','taxi')),
                  shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
                  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                  replacement_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                  requested_start TEXT,
                  requested_end TEXT,
                  note TEXT,
                  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','approved','rejected')),
                  created_at INTEGER NOT NULL
                );
                INSERT INTO change_requests(id,type,shift_id,requester_id,replacement_id,requested_start,requested_end,note,status,created_at)
                SELECT id,type,shift_id,requester_id,replacement_id,requested_start,requested_end,note,status,created_at
                FROM change_requests_old;
                DROP TABLE change_requests_old;
            """)
        conn.executescript("""
            DELETE FROM change_requests
            WHERE type='taxi'
              AND created_at < (
                SELECT MAX(latest.created_at)
                FROM change_requests latest
                WHERE latest.type='taxi'
                  AND latest.shift_id=change_requests.shift_id
                  AND latest.requester_id=change_requests.requester_id
              );
            DELETE FROM change_requests
            WHERE type='taxi'
              AND id NOT IN (
                SELECT MAX(id)
                FROM change_requests
                WHERE type='taxi'
                GROUP BY shift_id, requester_id, requested_start
              );
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_taxi_request_direction
            ON change_requests(shift_id, requester_id, requested_start)
            WHERE type='taxi';
        """)


def migrate_shift_slot_checks(conn: sqlite3.Connection) -> None:
    shifts_sql = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='shifts'").fetchone()
    defaults_sql = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='branch_shift_defaults'").fetchone()
    needs_shifts = shifts_sql and "middle" not in (shifts_sql["sql"] or "")
    needs_defaults = defaults_sql and "middle" not in (defaults_sql["sql"] or "")
    if not needs_shifts and not needs_defaults:
        return

    conn.execute("PRAGMA foreign_keys=OFF")
    if needs_shifts:
        old_cols = {r["name"] for r in conn.execute("PRAGMA table_info(shifts)").fetchall()}
        def old_col(name: str, fallback: str) -> str:
            return name if name in old_cols else fallback
        conn.executescript("""
            ALTER TABLE shifts RENAME TO shifts_old;
            CREATE TABLE shifts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
              day_key TEXT NOT NULL,
              slot TEXT NOT NULL CHECK(slot IN ('morning','middle','evening')),
              hours TEXT NOT NULL,
              sales_target INTEGER NOT NULL DEFAULT 0,
              reinforcement INTEGER NOT NULL DEFAULT 0,
              staffed INTEGER NOT NULL DEFAULT 0,
              max_employees INTEGER,
              shortage_count INTEGER,
              shortage_level TEXT,
              shortage_status TEXT,
              shortage_note TEXT,
              created_at INTEGER NOT NULL,
              UNIQUE(week_id, day_key, slot)
            );
        """)
        conn.execute(f"""
            INSERT INTO shifts(id,week_id,day_key,slot,hours,sales_target,reinforcement,staffed,max_employees,shortage_count,shortage_level,shortage_status,shortage_note,created_at)
            SELECT id,week_id,day_key,slot,hours,
                   {old_col('sales_target', '0')},
                   {old_col('reinforcement', '0')},
                   {old_col('staffed', '0')},
                   {old_col('max_employees', 'NULL')},
                   {old_col('shortage_count', 'NULL')},
                   {old_col('shortage_level', 'NULL')},
                   {old_col('shortage_status', 'NULL')},
                   {old_col('shortage_note', 'NULL')},
                   created_at
            FROM shifts_old
        """)
        conn.execute("DROP TABLE shifts_old")
        rebuild_shift_child_tables(conn)
    if needs_defaults:
        conn.executescript("""
            ALTER TABLE branch_shift_defaults RENAME TO branch_shift_defaults_old;
            CREATE TABLE branch_shift_defaults (
              branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
              day_key TEXT NOT NULL,
              slot TEXT NOT NULL CHECK(slot IN ('morning','middle','evening')),
              hours TEXT NOT NULL,
              max_employees INTEGER,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (branch_id, day_key, slot)
            );
            INSERT INTO branch_shift_defaults(branch_id, day_key, slot, hours, max_employees, updated_at)
            SELECT branch_id, day_key, slot, hours, NULL, updated_at
            FROM branch_shift_defaults_old;
            DROP TABLE branch_shift_defaults_old;
        """)
    conn.execute("PRAGMA foreign_keys=ON")


def rebuild_shift_child_tables(conn: sqlite3.Connection) -> None:
    if conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='shift_assignments'").fetchone():
        conn.executescript("""
            ALTER TABLE shift_assignments RENAME TO shift_assignments_old;
            CREATE TABLE shift_assignments (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              start_time TEXT,
              end_time TEXT,
              created_at INTEGER NOT NULL,
              UNIQUE(shift_id, user_id)
            );
            INSERT OR IGNORE INTO shift_assignments(id,shift_id,user_id,start_time,end_time,created_at)
            SELECT id,shift_id,user_id,start_time,end_time,created_at FROM shift_assignments_old;
            DROP TABLE shift_assignments_old;
        """)
    if conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='shift_availability'").fetchone():
        conn.executescript("""
            ALTER TABLE shift_availability RENAME TO shift_availability_old;
            CREATE TABLE shift_availability (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              note TEXT,
              created_at INTEGER NOT NULL,
              UNIQUE(shift_id, user_id)
            );
            INSERT OR IGNORE INTO shift_availability(id,shift_id,user_id,note,created_at)
            SELECT id,shift_id,user_id,note,created_at FROM shift_availability_old;
            DROP TABLE shift_availability_old;
        """)
    if conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='change_requests'").fetchone():
        conn.executescript("""
            ALTER TABLE change_requests RENAME TO change_requests_old;
            CREATE TABLE change_requests (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              type TEXT NOT NULL CHECK(type IN ('hours','exit','swap','reinforcement','taxi')),
              shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
              requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              replacement_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
              requested_start TEXT,
              requested_end TEXT,
              note TEXT,
              status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','approved','rejected')),
              created_at INTEGER NOT NULL
            );
            INSERT INTO change_requests(id,type,shift_id,requester_id,replacement_id,requested_start,requested_end,note,status,created_at)
            SELECT id,type,shift_id,requester_id,replacement_id,requested_start,requested_end,note,status,created_at
            FROM change_requests_old;
            DROP TABLE change_requests_old;
        """)


def default_shift_hours(conn: sqlite3.Connection, branch: sqlite3.Row | None, day_key: str, slot: str) -> str:
    branch_id = branch["id"] if branch else None
    if branch_id:
        custom = conn.execute(
            "SELECT hours FROM branch_shift_defaults WHERE branch_id=? AND day_key=? AND slot=?",
            (branch_id, day_key, slot)
        ).fetchone()
        if custom:
            return custom["hours"]

    morning_h = branch["morning_hours"] if branch else "09:00-15:00"
    evening_h = branch["evening_hours"] if branch else "15:00-22:00"
    middle_h = "12:00-18:00"
    if day_key == "fri":
        return {"morning": "08:00-14:00", "middle": "11:00-17:00", "evening": "14:00-20:00"}.get(slot, evening_h)
    if day_key == "sat":
        return {"morning": "10:00-16:00", "middle": "13:00-19:00", "evening": "16:00-22:00"}.get(slot, evening_h)
    return {"morning": morning_h, "middle": middle_h, "evening": evening_h}.get(slot, evening_h)


def default_shift_max_employees(conn: sqlite3.Connection, branch_id: int | None, day_key: str, slot: str) -> int | None:
    if not branch_id:
        return None
    ensure_shift_defaults_table(conn)
    row = conn.execute(
        "SELECT max_employees FROM branch_shift_defaults WHERE branch_id=? AND day_key=? AND slot=?",
        (branch_id, day_key, slot)
    ).fetchone()
    if not row or row["max_employees"] in (None, ""):
        return None
    return int(row["max_employees"])


def ensure_shift_defaults_table(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS branch_shift_defaults (
          branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
          day_key TEXT NOT NULL,
          slot TEXT NOT NULL CHECK(slot IN ('morning','middle','evening')),
          hours TEXT NOT NULL,
          max_employees INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (branch_id, day_key, slot)
        )
    """)
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(branch_shift_defaults)").fetchall()}
    if "max_employees" not in columns:
        conn.execute("ALTER TABLE branch_shift_defaults ADD COLUMN max_employees INTEGER")


def ensure_week(conn: sqlite3.Connection, branch_id: int, week_start: str, now: int) -> sqlite3.Row:
    existing = conn.execute(
        "SELECT * FROM weeks WHERE branch_id=? AND week_start=?",
        (branch_id, week_start)
    ).fetchone()
    if existing:
        return existing

    cur = conn.execute(
        "INSERT INTO weeks(branch_id,week_start,status,created_at) VALUES(?,?,?,?)",
        (branch_id, week_start, "draft", now)
    )
    week_id = cur.lastrowid
    day_keys = ["sun","mon","tue","wed","thu","fri","sat"]
    branch = conn.execute("SELECT * FROM branches WHERE id=?", (branch_id,)).fetchone()
    for dk in day_keys:
        for slot in DEFAULT_SHIFT_SLOTS:
            h = default_shift_hours(conn, branch, dk, slot)
            max_employees = default_shift_max_employees(conn, branch_id, dk, slot)
            conn.execute(
                "INSERT INTO shifts(week_id,day_key,slot,hours,max_employees,created_at) VALUES(?,?,?,?,?,?)",
                (week_id, dk, slot, h, max_employees, now)
            )
    return conn.execute("SELECT * FROM weeks WHERE id=?", (week_id,)).fetchone()


# ── Auth helpers ──────────────────────────────────────────────────────────────

def hash_code(code: str) -> str:
    return hmac.new(TOKEN_SECRET.encode(), code.encode(), hashlib.sha256).hexdigest()


def make_token(user: sqlite3.Row, role_override: str | None = None) -> str:
    effective_role = role_override or user["role"]
    payload = {"uid": user["id"], "role": effective_role, "actualRole": user["role"], "exp": int(time.time()) + 86400 * 7}
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    sig = base64.urlsafe_b64encode(
        hmac.new(TOKEN_SECRET.encode(), encoded.encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    return f"{encoded}.{sig}"


def verify_token(token: str | None) -> dict | None:
    if not token or "." not in token:
        return None
    encoded, sig = token.split(".", 1)
    expected = base64.urlsafe_b64encode(
        hmac.new(TOKEN_SECRET.encode(), encoded.encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    if not hmac.compare_digest(sig, expected):
        return None
    padded = encoded + "=" * (-len(encoded) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
    if payload.get("exp", 0) < int(time.time()):
        return None
    return payload


def auth_payload(handler: SimpleHTTPRequestHandler) -> dict | None:
    header = handler.headers.get("Authorization", "")
    token = header.removeprefix("Bearer ").strip() if header.startswith("Bearer ") else None
    return verify_token(token)


def require_auth(handler: SimpleHTTPRequestHandler, *allowed_roles):
    payload = auth_payload(handler)
    if not payload:
        json_response(handler, 401, {"error": "unauthorized"})
        return None
    if allowed_roles and payload.get("role") not in allowed_roles and payload.get("role") != "developer":
        json_response(handler, 403, {"error": "forbidden"})
        return None
    return payload


def make_dev_token() -> str:
    if not DEV_ENABLED:
        raise PermissionError("developer_console_disabled")
    payload = {"uid": 0, "role": "developer", "exp": int(time.time()) + 86400 * 30}
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    sig = base64.urlsafe_b64encode(
        hmac.new(TOKEN_SECRET.encode(), encoded.encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    return f"{encoded}.{sig}"


def require_dev(handler: SimpleHTTPRequestHandler) -> bool:
    if not DEV_ENABLED:
        json_response(handler, 404, {"error": "not_found"})
        return False
    payload = auth_payload(handler)
    if not payload or payload.get("role") != "developer":
        json_response(handler, 403, {"error": "developer_only"})
        return False
    return True


def accessible_branch_ids(conn: sqlite3.Connection, auth: dict) -> list[int] | None:
    if auth["role"] in ("network-manager", "developer"):
        return None
    rows = conn.execute("SELECT branch_id FROM user_branches WHERE user_id=?", (auth["uid"],)).fetchall()
    return [r["branch_id"] for r in rows]


def can_access_branch(conn: sqlite3.Connection, auth: dict, branch_id: int) -> bool:
    allowed = accessible_branch_ids(conn, auth)
    return allowed is None or branch_id in allowed


ROLE_LEVELS = {
    "employee": 10,
    "branch-manager": 20,
    "area-manager": 30,
    "network-manager": 40,
    "developer": 50,
}


def role_level(role: str | None) -> int:
    return ROLE_LEVELS.get(role or "", 0)


def user_branch_ids(conn: sqlite3.Connection, user_id: int) -> list[int]:
    return [r["branch_id"] for r in conn.execute(
        "SELECT branch_id FROM user_branches WHERE user_id=?",
        (user_id,)
    ).fetchall()]


def can_manage_user(conn: sqlite3.Connection, auth: dict, target_user: sqlite3.Row, new_role: str | None = None) -> bool:
    auth_role = auth.get("role")
    if auth_role == "developer":
        return True
    if auth_role == "network-manager":
        return True
    if auth_role == "employee":
        return False

    current_level = role_level(target_user["role"])
    requested_level = role_level(new_role or target_user["role"])
    actor_level = role_level(auth_role)
    if actor_level <= current_level or actor_level <= requested_level:
        return False

    allowed = accessible_branch_ids(conn, auth)
    if allowed is None:
        return True
    target_branches = user_branch_ids(conn, target_user["id"])
    return bool(set(allowed) & set(target_branches))


def branch_ids_allowed_for_actor(conn: sqlite3.Connection, auth: dict, branch_ids: list[int]) -> bool:
    allowed = accessible_branch_ids(conn, auth)
    return allowed is None or set(branch_ids).issubset(set(allowed))


def shift_conflict(conn: sqlite3.Connection, user_id: int, shift_id: int) -> sqlite3.Row | None:
    shift = conn.execute("""
        SELECT s.id, s.day_key, s.slot, w.week_start
        FROM shifts s JOIN weeks w ON w.id=s.week_id
        WHERE s.id=?
    """, (shift_id,)).fetchone()
    if not shift:
        return None
    return conn.execute("""
        SELECT b.name, b.number, 'assignment' AS kind
        FROM shift_assignments sa
        JOIN shifts s ON s.id=sa.shift_id
        JOIN weeks w ON w.id=s.week_id
        JOIN branches b ON b.id=w.branch_id
        WHERE sa.user_id=? AND w.week_start=? AND s.day_key=? AND s.slot=? AND sa.shift_id != ?
        UNION ALL
        SELECT b.name, b.number, 'availability' AS kind
        FROM shift_availability av
        JOIN shifts s ON s.id=av.shift_id
        JOIN weeks w ON w.id=s.week_id
        JOIN branches b ON b.id=w.branch_id
        WHERE av.user_id=? AND w.week_start=? AND s.day_key=? AND s.slot=? AND av.shift_id != ?
        LIMIT 1
    """, (user_id, shift["week_start"], shift["day_key"], shift["slot"], shift_id,
          user_id, shift["week_start"], shift["day_key"], shift["slot"], shift_id)).fetchone()


def reinforcement_candidates(conn: sqlite3.Connection, auth: dict, shift_id: int) -> list[dict]:
    target = conn.execute("""
        SELECT s.id, s.day_key, s.slot, w.branch_id, w.week_start, s.shortage_count
        FROM shifts s JOIN weeks w ON w.id=s.week_id
        WHERE s.id=?
    """, (shift_id,)).fetchone()
    if not target or not can_access_branch(conn, auth, target["branch_id"]):
        return []
    shortage_count = int(target["shortage_count"] or 0)
    if shortage_count <= 0:
        return []
    approved_count = conn.execute("""
        SELECT COUNT(*) AS c
        FROM change_requests
        WHERE shift_id=? AND type='reinforcement' AND status='approved'
    """, (shift_id,)).fetchone()["c"]
    if approved_count >= shortage_count:
        return []
    allowed = accessible_branch_ids(conn, auth)
    rows = conn.execute("""
        SELECT DISTINCT u.id, u.full_name, u.rank, u.role,
               source_w.branch_id, b.name AS branch_name
        FROM shift_availability av
        JOIN shifts source_s ON source_s.id=av.shift_id
        JOIN weeks source_w ON source_w.id=source_s.week_id
        JOIN branches b ON b.id=source_w.branch_id
        JOIN users u ON u.id=av.user_id
        WHERE u.status='active'
          AND u.role='employee'
          AND source_w.week_start=?
          AND source_s.day_key=?
          AND source_s.slot=?
          AND source_w.branch_id != ?
          AND NOT EXISTS (
            SELECT 1
            FROM shift_assignments sa
            JOIN shifts assigned_s ON assigned_s.id=sa.shift_id
            JOIN weeks assigned_w ON assigned_w.id=assigned_s.week_id
            WHERE sa.user_id=u.id
              AND assigned_w.week_start=source_w.week_start
              AND assigned_s.day_key=source_s.day_key
              AND assigned_s.slot=source_s.slot
          )
        ORDER BY u.full_name, b.name
    """, (target["week_start"], target["day_key"], target["slot"], target["branch_id"])).fetchall()
    grouped: dict[int, dict] = {}
    for r in rows:
        if allowed is not None and r["branch_id"] not in allowed:
            continue
        item = grouped.setdefault(r["id"], {
            "id": r["id"],
            "fullName": r["full_name"],
            "rank": r["rank"],
            "role": r["role"],
            "branches": [],
        })
        item["branches"].append({"id": r["branch_id"], "name": r["branch_name"]})
    assigned = {r["user_id"] for r in conn.execute("SELECT user_id FROM shift_assignments WHERE shift_id=?", (shift_id,)).fetchall()}
    pending = {r["requester_id"]: r["id"] for r in conn.execute(
        "SELECT id, requester_id FROM change_requests WHERE shift_id=? AND type='reinforcement' AND status='open'",
        (shift_id,)
    ).fetchall()}
    result = []
    for user_id, item in grouped.items():
        if user_id in assigned:
            continue
        item["pending"] = user_id in pending
        item["pendingRequestId"] = pending.get(user_id)
        result.append(item)
    return result


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def json_response(handler: SimpleHTTPRequestHandler, status: int, payload: dict) -> None:
    handler._response_status = status
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)
    if status >= 400:
        _err_count[0] += 1
    # record duration if measured by do_* handler
    t0 = getattr(handler, "_req_start", None)
    if t0 is not None:
        _req_log.append((t0, round((time.time() - t0) * 1000), status >= 400))
        handler._req_start = None


def broadcast_data_change(kind: str = "data") -> None:
    payload = {"kind": kind, "ts": int(time.time())}
    dead: list[queue.Queue] = []
    with _event_lock:
        clients = list(_event_clients)
    for client in clients:
        try:
            client.put_nowait(payload)
        except queue.Full:
            dead.append(client)
    if dead:
        with _event_lock:
            for client in dead:
                _event_clients.discard(client)


def read_json(handler: SimpleHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    if not length:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


# ── Serializers ───────────────────────────────────────────────────────────────

def ser_user(row: sqlite3.Row, branch_ids: list[int] | None = None, effective_role: str | None = None) -> dict:
    data = {
        "id": row["id"],
        "fullName": row["full_name"],
        "idNumber": row["id_number"],
        "phone": row["phone"],
        "email": row["email"],
        "role": effective_role or row["role"],
        "actualRole": row["role"],
        "status": row["status"],
        "hourlyWage": row["hourly_wage"],
        "rank": row["rank"],
        "isLead": bool(row["is_lead"]) or row["role"] == "branch-manager",
        "managerNote": row["manager_note"] if "manager_note" in row.keys() else "",
    }
    if branch_ids is not None:
        data["branchIds"] = branch_ids
    return data


def ser_branch(row: sqlite3.Row, manager_name: str | None = None) -> dict:
    data = {
        "id": row["id"],
        "name": row["name"],
        "number": row["number"],
        "area": row["area"],
        "managerId": row["manager_id"],
        "managerName": manager_name,
        "laborTarget": row["labor_target"],
        "morningHours": row["morning_hours"],
        "eveningHours": row["evening_hours"],
        "isBlocked": bool(row["is_blocked"]) if "is_blocked" in row.keys() else False,
    }
    if "shortage_count" in row.keys():
        data["shortageCount"] = row["shortage_count"] or 0
    if "overstaffed_count" in row.keys():
        data["overstaffedCount"] = row["overstaffed_count"] or 0
    return data


def ser_week(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "branchId": row["branch_id"],
        "weekStart": row["week_start"],
        "status": row["status"],
    }


def ser_shift(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "weekId": row["week_id"],
        "dayKey": row["day_key"],
        "slot": row["slot"],
        "hours": row["hours"],
        "salesTarget": row["sales_target"],
        "reinforcement": row["reinforcement"],
        "maxEmployees": row["max_employees"] if "max_employees" in row.keys() else None,
        "staffed": bool(row["staffed"]) if "staffed" in row.keys() else False,
        "shortage": {
            "count": row["shortage_count"],
            "level": row["shortage_level"],
            "status": row["shortage_status"],
            "note": row["shortage_note"],
        } if row["shortage_count"] else None,
    }


def ser_assignment(row: sqlite3.Row) -> dict:
    data = {
        "id": row["id"],
        "shiftId": row["shift_id"],
        "userId": row["user_id"],
        "startTime": row["start_time"],
        "endTime": row["end_time"],
        "isReinforcement": bool(row["is_reinforcement"]) if "is_reinforcement" in row.keys() else False,
    }
    if "full_name" in row.keys():
        data["userName"] = row["full_name"]
    return data


def ser_availability(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "shiftId": row["shift_id"],
        "userId": row["user_id"],
        "note": row["note"],
    }


def ser_report(row: sqlite3.Row) -> dict:
    t = row["sales_target"]
    a = row["actual_sales"]
    pct = round(a / t * 100) if t else 0
    labor = round(row["avg_transaction"] / a * 100, 1) if a else 0
    return {
        "id": row["id"],
        "branchId": row["branch_id"],
        "date": row["report_date"],
        "salesTarget": t,
        "actualSales": a,
        "avgTransaction": row["avg_transaction"],
        "avgItems": row["avg_items"],
        "targetPercent": pct,
    }


def ser_request(row: sqlite3.Row) -> dict:
    data = {
        "id": row["id"],
        "type": row["type"],
        "shiftId": row["shift_id"],
        "requesterId": row["requester_id"],
        "replacementId": row["replacement_id"],
        "requestedStart": row["requested_start"],
        "requestedEnd": row["requested_end"],
        "note": row["note"],
        "status": row["status"],
        "createdAt": row["created_at"],
    }
    keys = row.keys()
    if "requester_name" in keys:
        data["requesterName"] = row["requester_name"]
    if "replacement_name" in keys:
        data["replacementName"] = row["replacement_name"]
    if "day_key" in keys:
        data["shift"] = {
            "dayKey": row["day_key"],
            "slot": row["slot"],
            "hours": row["hours"],
            "weekStart": row["week_start"],
        }
    if "branch_name" in keys:
        data["branch"] = {
            "id": row["branch_id"],
            "name": row["branch_name"],
            "number": row["branch_number"],
        }
    return data


# ── Email ──────────────────────────────────────────────────────────────────────

def sync_taxi_requests(conn: sqlite3.Connection, shift_id: int, requester_id: int, note: str, taxi_directions: list[str], now: int) -> None:
    taxi_directions = [d for d in taxi_directions if d in ("arrival", "return")]
    conn.execute("""
        DELETE FROM change_requests
        WHERE type='taxi' AND shift_id=? AND requester_id=?
    """, (shift_id, requester_id))
    for direction in taxi_directions:
        conn.execute("""
            INSERT INTO change_requests(type,shift_id,requester_id,requested_start,note,status,created_at)
            VALUES('taxi', ?, ?, ?, ?, 'open', ?)
        """, (shift_id, requester_id, direction, note, now))


def env_flag(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def log_email_event(kind: str, recipient: str, subject: str, status: str) -> None:
    try:
        with db() as conn:
            conn.execute(
                "INSERT INTO email_log(kind,recipient,subject,status,created_at) VALUES(?,?,?,?,?)",
                (kind, recipient or "", subject or "", status, int(time.time()))
            )
    except Exception as e:
        print("Email log failed:", e)


def send_otp_email(to_email: str, code: str) -> None:
    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", "587"))
    username = os.environ.get("SMTP_USERNAME")
    password = os.environ.get("SMTP_PASSWORD")
    sender = os.environ.get("SMTP_FROM") or username
    use_ssl = env_flag("SMTP_USE_SSL", "1" if port == 465 else "0")
    use_tls = False if use_ssl else env_flag("SMTP_USE_TLS", "1")
    timeout = int(os.environ.get("SMTP_TIMEOUT", "20"))
    if not host or not sender:
        raise RuntimeError("SMTP is not configured. Set SMTP_HOST and SMTP_FROM or SMTP_USERNAME.")
    msg = EmailMessage()
    msg["Subject"] = "קוד כניסה למערכת EZM"
    msg["From"] = sender
    msg["To"] = to_email
    msg.set_content(f"קוד הכניסה החד פעמי שלך: {code}\nתקף ל-{OTP_TTL_SECONDS // 60} דקות.")
    try:
        smtp_cls = smtplib.SMTP_SSL if use_ssl else smtplib.SMTP
        with smtp_cls(host, port, timeout=timeout) as smtp:
            if use_tls:
                smtp.starttls()
            if username and password:
                smtp.login(username, password)
            smtp.send_message(msg)
        log_email_event("otp", to_email, msg["Subject"], "sent")
    except Exception:
        log_email_event("otp", to_email, msg["Subject"], "failed")
        raise


def send_plain_email(to_email: str, subject: str, body: str) -> bool:
    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", "587"))
    username = os.environ.get("SMTP_USERNAME")
    password = os.environ.get("SMTP_PASSWORD")
    sender = os.environ.get("SMTP_FROM") or username
    use_ssl = env_flag("SMTP_USE_SSL", "1" if port == 465 else "0")
    use_tls = False if use_ssl else env_flag("SMTP_USE_TLS", "1")
    timeout = int(os.environ.get("SMTP_TIMEOUT", "20"))
    if not host or not sender or not to_email:
        return False
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = to_email
    msg.set_content(body)
    try:
        smtp_cls = smtplib.SMTP_SSL if use_ssl else smtplib.SMTP
        with smtp_cls(host, port, timeout=timeout) as smtp:
            if use_tls:
                smtp.starttls()
            if username and password:
                smtp.login(username, password)
            smtp.send_message(msg)
        log_email_event("plain", to_email, subject, "sent")
        return True
    except Exception as e:
        print("Email send failed:", e)
        log_email_event("plain", to_email, subject, "failed")
        return False


REQUEST_TYPE_LABELS = {
    "exit": "יציאה ממשמרת",
    "swap": "חילוף משמרת",
    "reinforcement": "תגבור",
    "taxi": "מונית",
}


def shift_slot_label(slot: str | None) -> str:
    return SHIFT_SLOT_LABELS.get(slot or "", "משמרת")


def request_status_label(status: str) -> str:
    return "אושרה" if status == "approved" else "נדחתה"


def request_info(conn: sqlite3.Connection, request_id: int) -> sqlite3.Row | None:
    return conn.execute("""
        SELECT cr.*, u.email, u.full_name, s.slot, s.hours, s.day_key,
               w.week_start, b.name AS branch_name, b.number AS branch_number,
               repl.email AS replacement_email, repl.full_name AS replacement_name
        FROM change_requests cr
        JOIN users u ON u.id=cr.requester_id
        JOIN shifts s ON s.id=cr.shift_id
        JOIN weeks w ON w.id=s.week_id
        JOIN branches b ON b.id=w.branch_id
        LEFT JOIN users repl ON repl.id=cr.replacement_id
        WHERE cr.id=?
    """, (request_id,)).fetchone()


def notify_request_status(conn: sqlite3.Connection, request_id: int, new_status: str) -> None:
    info = request_info(conn, request_id)
    if not info:
        return
    req_type = info["type"]
    if req_type not in ("exit", "swap", "reinforcement", "taxi"):
        return
    if req_type == "taxi":
        req_label = "מונית הגעה" if info["requested_start"] == "arrival" else "מונית חזור"
    else:
        req_label = REQUEST_TYPE_LABELS.get(req_type, "בקשה")
    status_label = request_status_label(new_status)
    branch_num = f" · {info['branch_number']}" if info["branch_number"] else ""
    shift_line = f"{info['branch_name']}{branch_num} · {shift_slot_label(info['slot'])} · {info['hours']} · שבוע {info['week_start']}"
    send_plain_email(
        info["email"],
        f"עדכון בקשת {req_label} ב-EZM",
        f"היי {info['full_name']},\n\n"
        f"בקשת {req_label} שלך {status_label}.\n"
        f"משמרת: {shift_line}.\n\n"
        "אפשר לראות את הסטטוס גם באזור הבקשות שלך."
    )
    if req_type == "swap" and new_status == "approved" and info["replacement_email"]:
        send_plain_email(
            info["replacement_email"],
            "חילוף משמרת אושר ב-EZM",
            f"היי {info['replacement_name']},\n\n"
            f"חילוף משמרת אושר ושובצת במקום {info['full_name']}.\n"
            f"משמרת: {shift_line}.\n\n"
            "אפשר לראות את השיבוץ באזור העובד שלך."
        )


def iso_today() -> str:
    return time.strftime("%Y-%m-%d", time.localtime())


def current_week_start() -> str:
    now = time.localtime()
    # Python Monday=0; EZM week starts Sunday.
    days_since_sunday = (now.tm_wday + 1) % 7
    return time.strftime("%Y-%m-%d", time.localtime(time.time() - days_since_sunday * 86400))


def planning_week_start() -> str:
    return time.strftime("%Y-%m-%d", time.localtime(time.mktime(time.strptime(current_week_start(), "%Y-%m-%d")) + 7 * 86400))


def shift_date_from_week(week_start: str, day_key: str) -> datetime.date | None:
    try:
        day_index = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].index(day_key)
        return (datetime.strptime(week_start, "%Y-%m-%d") + timedelta(days=day_index)).date()
    except Exception:
        return None


def can_change_handled_taxi_request(week_start: str, day_key: str) -> bool:
    shift_date = shift_date_from_week(week_start, day_key)
    if not shift_date:
        return False
    today = datetime.now(APP_TZ).date()
    return (shift_date - today).days >= 2


def shift_has_passed(week_start: str, day_key: str, hours: str) -> bool:
    shift_date = shift_date_from_week(week_start, day_key)
    if not shift_date:
        return False
    now_dt = datetime.now(APP_TZ)
    try:
        end_part = (hours or "").split("-", 1)[1].strip()
        end_hour, end_minute = [int(part) for part in end_part.split(":", 1)]
        end_dt = datetime.combine(shift_date, datetime.min.time(), APP_TZ).replace(hour=end_hour, minute=end_minute)
        return end_dt < now_dt
    except Exception:
        return shift_date < now_dt.date()


def delete_expired_open_requests(conn: sqlite3.Connection) -> None:
    rows = conn.execute("""
        SELECT cr.id, w.week_start, s.day_key, s.hours
        FROM change_requests cr
        JOIN shifts s ON s.id=cr.shift_id
        JOIN weeks w ON w.id=s.week_id
        WHERE cr.status='open'
    """).fetchall()
    expired_ids = [
        row["id"]
        for row in rows
        if shift_has_passed(row["week_start"], row["day_key"], row["hours"])
    ]
    if expired_ids:
        conn.executemany("DELETE FROM change_requests WHERE id=?", [(rid,) for rid in expired_ids])


def mark_notification_once(conn: sqlite3.Connection, kind: str, recipient: str, entity_key: str) -> bool:
    try:
        conn.execute(
            "INSERT INTO notification_log(kind,recipient,entity_key,created_at) VALUES(?,?,?,?)",
            (kind, recipient, entity_key, int(time.time()))
        )
        return True
    except sqlite3.IntegrityError:
        return False


DEFAULT_NOTIFICATION_SETTINGS = {
    "availabilityRemindersEnabled": True,
    "availabilityReminderSlots": [
        {"day": 1, "time": "18:00"},
        {"day": 2, "time": "12:00"},
    ],
    "managerDigestEnabled": True,
    "managerDigestTime": "09:00",
}


def sanitize_time(value: str, fallback: str = "09:00") -> str:
    value = str(value or "").strip()
    try:
        hour, minute = value.split(":", 1)
        hour_n = int(hour)
        minute_n = int(minute)
        if 0 <= hour_n <= 23 and 0 <= minute_n <= 59:
            return f"{hour_n:02d}:{minute_n:02d}"
    except Exception:
        pass
    return fallback


def normalize_notification_settings(raw: dict | None) -> dict:
    raw = raw or {}
    slots = []
    for item in raw.get("availabilityReminderSlots", []):
        try:
            day = int(item.get("day"))
        except Exception:
            continue
        if day < 0 or day > 6:
            continue
        slots.append({"day": day, "time": sanitize_time(item.get("time"), "18:00")})
    if not slots:
        slots = DEFAULT_NOTIFICATION_SETTINGS["availabilityReminderSlots"]
    return {
        "availabilityRemindersEnabled": bool(raw.get("availabilityRemindersEnabled", DEFAULT_NOTIFICATION_SETTINGS["availabilityRemindersEnabled"])),
        "availabilityReminderSlots": slots[:7],
        "managerDigestEnabled": bool(raw.get("managerDigestEnabled", DEFAULT_NOTIFICATION_SETTINGS["managerDigestEnabled"])),
        "managerDigestTime": sanitize_time(raw.get("managerDigestTime"), DEFAULT_NOTIFICATION_SETTINGS["managerDigestTime"]),
    }


def get_notification_settings(conn: sqlite3.Connection) -> dict:
    row = conn.execute("SELECT value FROM app_settings WHERE key='notification_settings'").fetchone()
    if not row:
        return normalize_notification_settings(DEFAULT_NOTIFICATION_SETTINGS)
    try:
        return normalize_notification_settings(json.loads(row["value"]))
    except Exception:
        return normalize_notification_settings(DEFAULT_NOTIFICATION_SETTINGS)


def save_notification_settings(conn: sqlite3.Connection, settings: dict) -> dict:
    normalized = normalize_notification_settings(settings)
    conn.execute("""
        INSERT INTO app_settings(key,value,updated_at) VALUES('notification_settings', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    """, (json.dumps(normalized, ensure_ascii=False), int(time.time())))
    return normalized


MAX_AUDIT_ROWS = 500

def audit(conn: sqlite3.Connection, user_id: int | None, action: str, entity_type: str | None = None, entity_id: int | None = None):
    conn.execute(
        "INSERT INTO audit_log(user_id,action,entity_type,entity_id,created_at) VALUES(?,?,?,?,?)",
        (user_id, action, entity_type, entity_id, int(time.time()))
    )
    conn.execute(
        "DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT ?)",
        (MAX_AUDIT_ROWS,)
    )


# ── Handler ───────────────────────────────────────────────────────────────────

def send_availability_reminders(week_start: str | None = None, reminder_key: str | None = None) -> int:
    week_start = week_start or planning_week_start()
    reminder_key = reminder_key or "manual"
    sent = 0
    with db() as conn:
        employees = conn.execute("""
            SELECT u.id, u.full_name, u.email, GROUP_CONCAT(ub.branch_id) AS branch_ids
            FROM users u
            JOIN user_branches ub ON ub.user_id=u.id
            WHERE u.status='active' AND u.role='employee'
            GROUP BY u.id
        """).fetchall()
        for user in employees:
            branch_ids = [int(x) for x in (user["branch_ids"] or "").split(",") if x]
            if not branch_ids:
                continue
            placeholders = ",".join("?" * len(branch_ids))
            week_count = conn.execute(
                f"SELECT COUNT(*) AS c FROM weeks WHERE week_start=? AND branch_id IN ({placeholders})",
                [week_start, *branch_ids]
            ).fetchone()["c"]
            if week_count == 0:
                continue
            availability_count = conn.execute(f"""
                SELECT COUNT(*) AS c
                FROM shift_availability av
                JOIN shifts s ON s.id=av.shift_id
                JOIN weeks w ON w.id=s.week_id
                WHERE av.user_id=? AND w.week_start=? AND w.branch_id IN ({placeholders})
            """, [user["id"], week_start, *branch_ids]).fetchone()["c"]
            if availability_count:
                continue
            if not mark_notification_once(conn, "availability_reminder", user["email"], f"{user['id']}:{week_start}:{reminder_key}"):
                continue
            if send_plain_email(
                user["email"],
                "תזכורת להגשת זמינות ב-EZM",
                f"היי {user['full_name']},\n\n"
                f"עדיין לא הגשת זמינות לשבוע שמתחיל ב-{week_start}.\n"
                "כדאי להיכנס לאזור העובד ולהגיש זמינות כדי שנוכל לשבץ אותך בזמן.\n\n"
                "תודה."
            ):
                sent += 1
    return sent


def send_manager_request_digest() -> int:
    today = iso_today()
    sent = 0
    with db() as conn:
        managers = conn.execute("""
            SELECT * FROM users
            WHERE status='active' AND role IN ('network-manager','area-manager','branch-manager')
        """).fetchall()
        for manager in managers:
            branch_ids = user_branch_ids(conn, manager["id"])
            params: list = []
            branch_filter = ""
            if manager["role"] != "network-manager":
                if not branch_ids:
                    continue
                branch_filter = f" AND w.branch_id IN ({','.join('?' * len(branch_ids))})"
                params.extend(branch_ids)
            rows = conn.execute(f"""
                SELECT cr.type, COUNT(*) AS c
                FROM change_requests cr
                JOIN shifts s ON s.id=cr.shift_id
                JOIN weeks w ON w.id=s.week_id
                WHERE cr.status='open' {branch_filter}
                GROUP BY cr.type
            """, params).fetchall()
            total = sum(int(r["c"] or 0) for r in rows)
            if total == 0:
                continue
            if not mark_notification_once(conn, "manager_request_digest", manager["email"], f"{manager['id']}:{today}"):
                continue
            lines = []
            for r in rows:
                label = REQUEST_TYPE_LABELS.get(r["type"], "שינוי שעות" if r["type"] == "hours" else r["type"])
                lines.append(f"- {label}: {r['c']}")
            if send_plain_email(
                manager["email"],
                "תקציר בקשות פתוחות ב-EZM",
                f"היי {manager['full_name']},\n\n"
                f"יש כרגע {total} בקשות פתוחות שממתינות לטיפול:\n"
                + "\n".join(lines)
                + "\n\nאפשר לטפל בהן באזור הבקשות במערכת."
            ):
                sent += 1
    return sent


class EZMHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".css": "text/css",
    }

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        clean = parsed.path.lstrip("/") or "index.html"
        return str(ROOT / clean)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            _req_count[0] += 1; self._req_start = time.time()
            self.route_get(parsed.path, parse_qs(parsed.query))
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            _req_count[0] += 1; self._req_start = time.time()
            self.route_post(parsed.path)
            self.broadcast_after_mutation(parsed.path)
            return
        json_response(self, 404, {"error": "not_found"})

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            _req_count[0] += 1; self._req_start = time.time()
            self.route_put(parsed.path)
            self.broadcast_after_mutation(parsed.path)
            return
        json_response(self, 404, {"error": "not_found"})

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            _req_count[0] += 1; self._req_start = time.time()
            self.route_delete(parsed.path)
            self.broadcast_after_mutation(parsed.path)
            return
        json_response(self, 404, {"error": "not_found"})

    def log_message(self, fmt, *args):
        pass  # silence default access log

    def broadcast_after_mutation(self, path: str) -> None:
        status = getattr(self, "_response_status", None)
        if status is None or status >= 400:
            return
        if path.startswith("/api/auth") or path.startswith("/api/dev"):
            return
        if path == "/api/weeks" and status != 201:
            return
        broadcast_data_change("mutation")

    def stream_events(self, auth: dict) -> None:
        client: queue.Queue = queue.Queue(maxsize=20)
        with _event_lock:
            _event_clients.add(client)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    payload = client.get(timeout=25)
                    data = json.dumps(payload, ensure_ascii=False)
                    self.wfile.write(f"event: change\ndata: {data}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionError, OSError):
            pass
        finally:
            with _event_lock:
                _event_clients.discard(client)

    # ── Routing ───────────────────────────────────────────────────────────────

    def route_get(self, path: str, qs: dict) -> None:
        if path == "/api/events":
            auth = verify_token(qs.get("token", [""])[0])
            if not auth:
                json_response(self, 401, {"error": "unauthorized"})
                return
            self.stream_events(auth)
            return

        # Setup check (public)
        if path == "/api/setup-required":
            with db() as conn:
                c = conn.execute("SELECT COUNT(*) AS c FROM users WHERE role='network-manager' AND status='active'").fetchone()["c"]
            json_response(self, 200, {"required": c == 0})
            return

        if path == "/api/public/branches":
            with db() as conn:
                rows = conn.execute("SELECT id,name,number,area FROM branches ORDER BY name").fetchall()
            json_response(self, 200, {"branches": [dict(r) for r in rows]})
            return

        # Auth
        if path == "/api/me":
            auth = require_auth(self)
            if not auth: return
            if auth.get("role") == "developer":
                json_response(self, 200, {"user": {"id": 0, "fullName": "מפתח", "role": "developer",
                                                   "status": "active", "branchIds": [], "isLead": False,
                                                   "rank": "", "phone": ""}})
                return
            with db() as conn:
                user = conn.execute("SELECT * FROM users WHERE id=?", (auth["uid"],)).fetchone()
                branch_ids = [r["branch_id"] for r in conn.execute("SELECT branch_id FROM user_branches WHERE user_id=?", (auth["uid"],)).fetchall()]
            json_response(self, 200, {"user": ser_user(user, branch_ids, auth.get("role"))})
            return

        # Users
        if path == "/api/users":
            auth = require_auth(self)
            if not auth: return
            status_filter = qs.get("status", [None])[0]
            with db() as conn:
                where = []
                params = []
                if status_filter:
                    where.append("status=?")
                    params.append(status_filter)
                sql = "SELECT * FROM users"
                if where:
                    sql += " WHERE " + " AND ".join(where)
                sql += " ORDER BY full_name"
                rows = conn.execute(sql, params).fetchall()
                branch_rows = conn.execute("SELECT user_id, branch_id FROM user_branches").fetchall()
                by_user: dict[int, list[int]] = {}
                for br in branch_rows:
                    by_user.setdefault(br["user_id"], []).append(br["branch_id"])
                allowed = accessible_branch_ids(conn, auth)
                if allowed is not None:
                    allowed_set = set(allowed)
                    rows = [
                        r for r in rows
                        if r["id"] == auth["uid"] or bool(allowed_set.intersection(by_user.get(r["id"], [])))
                    ]
            json_response(self, 200, {"users": [ser_user(r, by_user.get(r["id"], [])) for r in rows]})
            return

        # Branches
        if path == "/api/branches":
            auth = require_auth(self)
            if not auth: return
            week_start = qs.get("weekStart", [None])[0]
            with db() as conn:
                params = []
                branch_filter = ""
                if auth["role"] in ("area-manager", "branch-manager", "employee"):
                    branch_filter = "WHERE b.id IN (SELECT branch_id FROM user_branches WHERE user_id=?)"
                    params.append(auth["uid"])
                shortage_join = ""
                shortage_select = "0 AS shortage_count, 0 AS overstaffed_count"
                if week_start:
                    shortage_join = """
                    LEFT JOIN weeks w ON w.branch_id = b.id AND w.week_start = ?
                    LEFT JOIN shifts s ON s.week_id = w.id
                    LEFT JOIN (
                      SELECT shift_id, COUNT(*) AS assignment_count
                      FROM shift_assignments
                      GROUP BY shift_id
                    ) ac ON ac.shift_id = s.id
                    """
                    shortage_select = """
                      COALESCE(SUM(s.shortage_count), 0) AS shortage_count,
                      COALESCE(SUM(CASE
                        WHEN s.max_employees IS NOT NULL
                         AND s.max_employees > 0
                         AND (COALESCE(ac.assignment_count, 0) + COALESCE(s.reinforcement, 0)) > s.max_employees
                        THEN 1 ELSE 0 END), 0) AS overstaffed_count
                    """
                    params.insert(0, week_start)
                rows = conn.execute(f"""
                    SELECT b.*, u.full_name as manager_name, {shortage_select}
                    FROM branches b
                    LEFT JOIN users u ON b.manager_id = u.id
                    {shortage_join}
                    {branch_filter}
                    GROUP BY b.id
                    ORDER BY b.name
                """, params).fetchall()
            json_response(self, 200, {"branches": [ser_branch(r, r["manager_name"]) for r in rows]})
            return

        # Week
        if path.startswith("/api/weeks"):
            auth = require_auth(self)
            if not auth: return
            branch_id = qs.get("branchId", [None])[0]
            week_start = qs.get("weekStart", [None])[0]
            with db() as conn:
                if branch_id and not can_access_branch(conn, auth, int(branch_id)):
                    json_response(self, 403, {"error": "forbidden"})
                    return
                if branch_id and week_start:
                    row = conn.execute("SELECT * FROM weeks WHERE branch_id=? AND week_start=?", (branch_id, week_start)).fetchone()
                    if not row:
                        json_response(self, 404, {"error": "week_not_found"})
                        return
                    week = ser_week(row)
                    week_id = row["id"]
                    shifts = conn.execute("""
                        SELECT * FROM shifts
                        WHERE week_id=?
                        ORDER BY day_key,
                          CASE slot WHEN 'morning' THEN 1 WHEN 'middle' THEN 2 WHEN 'evening' THEN 3 ELSE 9 END
                    """, (week_id,)).fetchall()
                    shift_list = [ser_shift(s) for s in shifts]
                    for shift_data in shift_list:
                        sid = shift_data["id"]
                        assignments = conn.execute("""
                            SELECT sa.*, u.full_name,
                                CASE WHEN cr.id IS NOT NULL THEN 1 ELSE 0 END AS is_reinforcement
                            FROM shift_assignments sa
                            JOIN users u ON u.id = sa.user_id
                            LEFT JOIN change_requests cr
                                ON cr.shift_id = sa.shift_id
                                AND cr.requester_id = sa.user_id
                                AND cr.type = 'reinforcement'
                                AND cr.status = 'approved'
                            WHERE sa.shift_id = ?
                        """, (sid,)).fetchall()
                        shift_data["assignments"] = [ser_assignment(a) for a in assignments]
                        avail = conn.execute(
                            "SELECT * FROM shift_availability WHERE shift_id=?", (sid,)
                        ).fetchall()
                        shift_data["availability"] = [ser_availability(a) for a in avail]
                        approved_reinf = conn.execute(
                            "SELECT COUNT(*) AS c FROM change_requests WHERE shift_id=? AND type='reinforcement' AND status='approved'",
                            (sid,)
                        ).fetchone()["c"]
                        shift_data["approvedReinforcementCount"] = approved_reinf
                        pending_reinf = conn.execute(
                            "SELECT COUNT(*) AS c FROM change_requests WHERE shift_id=? AND type='reinforcement' AND status='open'",
                            (sid,)
                        ).fetchone()["c"]
                        shift_data["pendingReinforcementCount"] = pending_reinf
                        if auth["role"] == "employee":
                            other = conn.execute("""
                                SELECT 'assignment' AS kind, b.name AS branch_name, b.number AS branch_number,
                                       s.hours, sa.start_time, sa.end_time
                                FROM shift_assignments sa
                                JOIN shifts s ON s.id=sa.shift_id
                                JOIN weeks w ON w.id=s.week_id
                                JOIN branches b ON b.id=w.branch_id
                                WHERE sa.user_id=? AND w.week_start=? AND s.day_key=? AND s.slot=? AND b.id != ?
                                UNION ALL
                                SELECT 'availability' AS kind, b.name AS branch_name, b.number AS branch_number,
                                       s.hours, NULL AS start_time, NULL AS end_time
                                FROM shift_availability av
                                JOIN shifts s ON s.id=av.shift_id
                                JOIN weeks w ON w.id=s.week_id
                                JOIN branches b ON b.id=w.branch_id
                                WHERE av.user_id=? AND w.week_start=? AND s.day_key=? AND s.slot=? AND b.id != ?
                                LIMIT 1
                            """, (auth["uid"], week_start, shift_data["dayKey"], shift_data["slot"], int(branch_id),
                                  auth["uid"], week_start, shift_data["dayKey"], shift_data["slot"], int(branch_id))).fetchone()
                            if other:
                                shift_data["myOtherCommitment"] = {
                                    "type": other["kind"],
                                    "branchName": other["branch_name"],
                                    "branchNumber": other["branch_number"],
                                    "hours": f"{other['start_time']}-{other['end_time']}" if other["start_time"] and other["end_time"] else other["hours"],
                                }
                    week["shifts"] = shift_list
                    json_response(self, 200, {"week": week})
                    return
                elif branch_id:
                    rows = conn.execute("SELECT * FROM weeks WHERE branch_id=? ORDER BY week_start DESC", (branch_id,)).fetchall()
                    json_response(self, 200, {"weeks": [ser_week(r) for r in rows]})
                    return
            json_response(self, 400, {"error": "branchId required"})
            return

        # Reinforcement candidates for a shift
        if path.startswith("/api/shifts/") and path.endswith("/reinforcement-candidates"):
            auth = require_auth(self, "network-manager", "area-manager")
            if not auth: return
            try:
                shift_id = int(path.split("/")[-2])
            except (ValueError, IndexError):
                json_response(self, 400, {"error": "invalid_shift"})
                return
            with db() as conn:
                candidates = reinforcement_candidates(conn, auth, shift_id)
            json_response(self, 200, {"candidates": candidates})
            return

        # Replacement candidates for an assigned shift
        if path.startswith("/api/shifts/") and path.endswith("/replacement-candidates"):
            auth = require_auth(self)
            if not auth: return
            try:
                shift_id = int(path.split("/")[-2])
            except (ValueError, IndexError):
                json_response(self, 400, {"error": "invalid_shift"})
                return
            with db() as conn:
                branch = conn.execute("""
                    SELECT w.branch_id
                    FROM shifts s JOIN weeks w ON w.id=s.week_id
                    WHERE s.id=?
                """, (shift_id,)).fetchone()
                assigned_to_shift = conn.execute(
                    "SELECT 1 FROM shift_assignments WHERE shift_id=? AND user_id=?",
                    (shift_id, auth["uid"])
                ).fetchone()
                if not branch or not (can_access_branch(conn, auth, branch["branch_id"]) or assigned_to_shift):
                    json_response(self, 403, {"error": "forbidden"})
                    return
                rows = conn.execute("""
                    SELECT u.id, u.full_name, u.rank
                    FROM shift_availability av
                    JOIN users u ON u.id=av.user_id
                    WHERE av.shift_id=?
                      AND u.status='active'
                      AND u.id != ?
                      AND NOT EXISTS (
                        SELECT 1 FROM shift_assignments sa
                        WHERE sa.shift_id=av.shift_id AND sa.user_id=av.user_id
                      )
                    ORDER BY u.full_name
                """, (shift_id, auth["uid"])).fetchall()
            json_response(self, 200, {"candidates": [
                {"id": r["id"], "fullName": r["full_name"], "rank": r["rank"]} for r in rows
            ]})
            return

        # Reports
        if path == "/api/reports":
            auth = require_auth(self)
            if not auth: return
            branch_id = qs.get("branchId", [None])[0]
            with db() as conn:
                auth_user = conn.execute("SELECT * FROM users WHERE id=?", (auth["uid"],)).fetchone()
                if auth["role"] == "employee" and not auth_user["is_lead"]:
                    json_response(self, 403, {"error": "forbidden"})
                    return
                if branch_id:
                    if not can_access_branch(conn, auth, int(branch_id)):
                        json_response(self, 403, {"error": "forbidden"})
                        return
                    rows = conn.execute("SELECT * FROM day_reports WHERE branch_id=? ORDER BY report_date DESC", (branch_id,)).fetchall()
                else:
                    allowed = accessible_branch_ids(conn, auth)
                    if allowed is None:
                        rows = conn.execute("SELECT * FROM day_reports ORDER BY report_date DESC LIMIT 50").fetchall()
                    elif allowed:
                        placeholders = ",".join("?" for _ in allowed)
                        rows = conn.execute(f"SELECT * FROM day_reports WHERE branch_id IN ({placeholders}) ORDER BY report_date DESC LIMIT 50", allowed).fetchall()
                    else:
                        rows = []
            json_response(self, 200, {"reports": [ser_report(r) for r in rows]})
            return

        # Change requests
        if path == "/api/requests":
            auth = require_auth(self)
            if not auth: return
            base_request_sql = """
                SELECT cr.*, s.day_key, s.slot, s.hours, w.week_start, w.branch_id,
                       b.name AS branch_name, b.number AS branch_number,
                       req.full_name AS requester_name,
                       repl.full_name AS replacement_name
                FROM change_requests cr
                JOIN shifts s ON s.id=cr.shift_id
                JOIN weeks w ON w.id=s.week_id
                JOIN branches b ON b.id=w.branch_id
                JOIN users req ON req.id=cr.requester_id
                LEFT JOIN users repl ON repl.id=cr.replacement_id
            """
            with db() as conn:
                delete_expired_open_requests(conn)
                if auth["role"] == "employee":
                    rows = conn.execute(base_request_sql + " WHERE cr.requester_id=? ORDER BY cr.created_at DESC", (auth["uid"],)).fetchall()
                else:
                    taxi_week_filter = (current_week_start(), planning_week_start())
                    manager_request_filter = "((cr.type<>'taxi' AND cr.status='open') OR (cr.type='taxi' AND w.week_start IN (?, ?)))"
                    allowed = accessible_branch_ids(conn, auth)
                    if allowed is None:
                        rows = conn.execute(base_request_sql + f" WHERE {manager_request_filter} ORDER BY cr.created_at DESC", taxi_week_filter).fetchall()
                    elif allowed:
                        placeholders = ",".join("?" for _ in allowed)
                        rows = conn.execute(
                            base_request_sql + f" WHERE {manager_request_filter} AND w.branch_id IN ({placeholders}) ORDER BY cr.created_at DESC",
                            (*taxi_week_filter, *allowed),
                        ).fetchall()
                    else:
                        rows = []
            json_response(self, 200, {"requests": [ser_request(r) for r in rows]})
            return

        if path == "/api/settings/notifications":
            auth = require_auth(self, "network-manager", "area-manager", "branch-manager")
            if not auth: return
            with db() as conn:
                settings = get_notification_settings(conn)
            json_response(self, 200, {"settings": settings})
            return

        # Audit log
        if path == "/api/audit":
            auth = require_auth(self, "network-manager")
            if not auth: return
            with db() as conn:
                rows = conn.execute("""
                    SELECT al.*, u.full_name FROM audit_log al
                    LEFT JOIN users u ON al.user_id = u.id
                    ORDER BY al.created_at DESC LIMIT 100
                """).fetchall()
            log = [{"id": r["id"], "action": r["action"], "entityType": r["entity_type"],
                    "entityId": r["entity_id"], "userName": r["full_name"], "createdAt": r["created_at"]} for r in rows]
            json_response(self, 200, {"log": log})
            return

        # ── Dev endpoints ─────────────────────────────────────────────────────

        if path == "/api/dev/enabled":
            json_response(self, 200, {"enabled": DEV_ENABLED})
            return

        if path == "/api/dev/ping":
            if not require_dev(self): return
            json_response(self, 200, {"ok": True, "ts": time.time()})
            return

        if path == "/api/dev/stats":
            if not require_dev(self): return
            now = time.time()
            uptime_sec = int(now - _SERVER_START)
            with db() as conn:
                users_count    = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
                branches_count = conn.execute("SELECT COUNT(*) AS c FROM branches").fetchone()["c"]
                weeks_count    = conn.execute("SELECT COUNT(*) AS c FROM weeks").fetchone()["c"]
                blocked_count  = conn.execute("SELECT COUNT(*) AS c FROM branches WHERE is_blocked=1").fetchone()["c"]
                today_start = int(time.mktime(time.strptime(iso_today(), "%Y-%m-%d")))
                emails_today = conn.execute(
                    "SELECT COUNT(*) AS c FROM email_log WHERE status='sent' AND created_at>=?",
                    (today_start,)
                ).fetchone()["c"]
                emails_failed_today = conn.execute(
                    "SELECT COUNT(*) AS c FROM email_log WHERE status='failed' AND created_at>=?",
                    (today_start,)
                ).fetchone()["c"]
                db_size = DB_PATH.stat().st_size if DB_PATH.exists() else 0
            # performance metrics from request log
            recent_all  = list(_req_log)
            recent_60s  = [r for r in recent_all if now - r[0] <= 60]
            recent_300s = [r for r in recent_all if now - r[0] <= 300]
            durations   = [r[1] for r in recent_all] or [0]
            durations.sort()
            n = len(durations)
            avg_ms  = round(sum(durations) / n)
            p95_ms  = durations[int(n * 0.95)]
            p99_ms  = durations[int(n * 0.99)]
            err_rate = round(_err_count[0] / max(_req_count[0], 1) * 100, 1)
            rps_60  = round(len(recent_60s) / 60, 2)
            rps_300 = round(len(recent_300s) / 300, 2)
            json_response(self, 200, {
                "uptime": uptime_sec,
                "requests": _req_count[0],
                "errors": _err_count[0],
                "errorRate": err_rate,
                "avgMs": avg_ms,
                "p95Ms": p95_ms,
                "p99Ms": p99_ms,
                "rps60": rps_60,
                "rps300": rps_300,
                "users": users_count,
                "branches": branches_count,
                "weeks": weeks_count,
                "blockedBranches": blocked_count,
                "emailsToday": emails_today,
                "emailsFailedToday": emails_failed_today,
                "dbSizeBytes": db_size,
            })
            return

        if path == "/api/dev/branches":
            if not require_dev(self): return
            with db() as conn:
                rows = conn.execute("""
                    SELECT b.*, u.full_name AS manager_name,
                           COUNT(DISTINCT ub.user_id) AS employee_count
                    FROM branches b
                    LEFT JOIN users u ON b.manager_id = u.id
                    LEFT JOIN user_branches ub ON ub.branch_id = b.id
                    GROUP BY b.id
                    ORDER BY b.name
                """).fetchall()
            branches = []
            for r in rows:
                d = ser_branch(r, r["manager_name"])
                d["employeeCount"] = r["employee_count"]
                branches.append(d)
            json_response(self, 200, {"branches": branches})
            return

        ALLOWED_DEV_TABLES = {
            "users", "branches", "user_branches", "weeks", "shifts",
            "shift_assignments", "shift_availability", "day_reports",
            "change_requests", "audit_log", "otp_codes", "notification_log", "app_settings",
        }
        if path.startswith("/api/dev/db/"):
            if not require_dev(self): return
            table = path.split("/api/dev/db/")[-1].strip("/").split("?")[0]
            if table not in ALLOWED_DEV_TABLES:
                json_response(self, 400, {"error": "invalid_table"}); return
            limit = int(qs.get("limit", ["100"])[0])
            offset = int(qs.get("offset", ["0"])[0])
            with db() as conn:
                rows = conn.execute(f"SELECT * FROM {table} LIMIT ? OFFSET ?", (limit, offset)).fetchall()
                total = conn.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"]
            json_response(self, 200, {
                "table": table,
                "total": total,
                "rows": [dict(r) for r in rows],
                "columns": list(rows[0].keys()) if rows else [],
            })
            return

        json_response(self, 404, {"error": "not_found"})

    def route_post(self, path: str) -> None:
        body = read_json(self)
        now = int(time.time())

        # First run setup
        if path == "/api/setup":
            with db() as conn:
                count = conn.execute("SELECT COUNT(*) AS c FROM users WHERE role='network-manager'").fetchone()["c"]
                if count:
                    json_response(self, 409, {"error": "setup_already_completed"})
                    return
                cur = conn.execute(
                    "INSERT INTO users(full_name,id_number,phone,email,role,status,created_at) VALUES(?,?,?,?,?,?,?)",
                    (body.get("fullName","").strip(), body.get("idNumber","").strip(),
                     body.get("phone","").strip(), body.get("email","").strip(),
                     "network-manager", "active", now)
                )
                user = conn.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
                audit(conn, user["id"], "הקמת מנהל רשת ראשון", "user", user["id"])
            json_response(self, 201, {"ok": True, "token": make_token(user), "user": ser_user(user)})
            return

        # Request OTP
        if path == "/api/auth/request-code":
            id_number = body.get("idNumber", "").strip()
            with db() as conn:
                user = conn.execute("SELECT * FROM users WHERE id_number=?", (id_number,)).fetchone()
                if not user:
                    json_response(self, 404, {"error": "user_not_found"})
                    return
                if user["status"] == "inactive":
                    json_response(self, 403, {"error": "account_suspended"})
                    return
                if user["status"] == "pending":
                    json_response(self, 403, {"error": "account_pending"})
                    return
                branch_ids = [r["branch_id"] for r in conn.execute(
                    "SELECT branch_id FROM user_branches WHERE user_id=?", (user["id"],)
                ).fetchall()]
                if branch_ids:
                    blocked = conn.execute(
                        f"SELECT COUNT(*) AS c FROM branches WHERE id IN ({','.join('?'*len(branch_ids))}) AND is_blocked=1",
                        branch_ids
                    ).fetchone()["c"]
                    if blocked == len(branch_ids):
                        json_response(self, 403, {"error": "branch_blocked"})
                        return
            code = f"{secrets.randbelow(900000) + 100000:06d}"
            try:
                send_otp_email(user["email"], code)
            except Exception as exc:
                json_response(self, 502, {"error": "email_failed", "message": str(exc)})
                return
            with db() as conn:
                conn.execute("INSERT INTO otp_codes(user_id,code_hash,expires_at,created_at) VALUES(?,?,?,?)",
                             (user["id"], hash_code(code), now + OTP_TTL_SECONDS, now))
            json_response(self, 200, {"ok": True, "canLoginAsEmployee": user["role"] != "employee"})
            return

        # Verify OTP
        if path == "/api/auth/verify":
            id_number = body.get("idNumber", "").strip()
            code = body.get("code", "").strip()
            login_as_employee = bool(body.get("loginAsEmployee"))
            with db() as conn:
                user = conn.execute("SELECT * FROM users WHERE id_number=?", (id_number,)).fetchone()
                if not user:
                    json_response(self, 401, {"error": "invalid_login"})
                    return
                if user["status"] == "inactive":
                    json_response(self, 403, {"error": "account_suspended"})
                    return
                otp = conn.execute(
                    "SELECT * FROM otp_codes WHERE user_id=? AND used_at IS NULL AND expires_at>=? ORDER BY id DESC LIMIT 1",
                    (user["id"], now)
                ).fetchone()
                if not otp or not hmac.compare_digest(otp["code_hash"], hash_code(code)):
                    json_response(self, 401, {"error": "invalid_code"})
                    return
                conn.execute("UPDATE otp_codes SET used_at=? WHERE id=?", (now, otp["id"]))
                audit(conn, user["id"], "כניסה למערכת", "user", user["id"])
                branch_ids = [r["branch_id"] for r in conn.execute("SELECT branch_id FROM user_branches WHERE user_id=?", (user["id"],)).fetchall()]
            effective_role = "employee" if login_as_employee and user["role"] != "employee" else user["role"]
            json_response(self, 200, {"token": make_token(user, effective_role), "user": ser_user(user, branch_ids, effective_role)})
            return

        # Register employee (public)
        if path == "/api/users/register":
            with db() as conn:
                try:
                    branch_id = int(body.get("branchId") or 0)
                    cur = conn.execute(
                        "INSERT INTO users(full_name,id_number,phone,email,role,status,hourly_wage,created_at) VALUES(?,?,?,?,?,?,?,?)",
                        (body.get("fullName","").strip(), body.get("idNumber","").strip(),
                         body.get("phone","").strip(), body.get("email","").strip(),
                         "employee", "pending", body.get("hourlyWage"), now)
                    )
                    if branch_id:
                        conn.execute("INSERT OR IGNORE INTO user_branches(user_id,branch_id) VALUES(?,?)", (cur.lastrowid, branch_id))
                    user = conn.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
                except sqlite3.IntegrityError:
                    json_response(self, 409, {"error": "id_number_exists"})
                    return
            json_response(self, 201, {"ok": True, "user": ser_user(user, [branch_id] if branch_id else [])})
            return

        # Approve user (managers)
        if path == "/api/users/approve":
            auth = require_auth(self, "network-manager", "area-manager", "branch-manager")
            if not auth: return
            user_id = int(body.get("userId") or 0)
            with db() as conn:
                user = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
                if not user:
                    json_response(self, 404, {"error": "not_found"})
                    return
                if not can_manage_user(conn, auth, user, user["role"]):
                    json_response(self, 403, {"error": "role_hierarchy_forbidden"})
                    return
                conn.execute("UPDATE users SET status='active' WHERE id=? AND status='pending'", (user_id,))
                audit(conn, auth["uid"], f"אישר הרשמת עובד", "user", user_id)
            json_response(self, 200, {"ok": True, "user": ser_user(user)})
            return

        # Create branch
        if path == "/api/branches":
            auth = require_auth(self, "network-manager")
            if not auth: return
            with db() as conn:
                try:
                    cur = conn.execute(
                        "INSERT INTO branches(name,number,area,manager_id,labor_target,morning_hours,evening_hours,created_at) VALUES(?,?,?,?,?,?,?,?)",
                        (body.get("name","").strip(), body.get("number","").strip() or None,
                         body.get("area","מרכז"), body.get("managerId") or None,
                         body.get("laborTarget", 12.4),
                         body.get("morningHours","09:00-15:00"),
                         body.get("eveningHours","15:00-22:00"), now)
                    )
                    branch = conn.execute("SELECT * FROM branches WHERE id=?", (cur.lastrowid,)).fetchone()
                    audit(conn, auth["uid"], f"יצר סניף {branch['name']}", "branch", branch["id"])
                except sqlite3.IntegrityError:
                    json_response(self, 409, {"error": "branch_name_exists"})
                    return
            json_response(self, 201, {"ok": True, "branch": ser_branch(branch)})
            return

        # Create/get week
        if path == "/api/weeks":
            auth = require_auth(self, "network-manager", "area-manager", "branch-manager")
            if not auth: return
            branch_id = int(body.get("branchId") or 0)
            week_start = body.get("weekStart", "").strip()
            with db() as conn:
                if not can_access_branch(conn, auth, branch_id):
                    json_response(self, 403, {"error": "forbidden"})
                    return
                existing = conn.execute("SELECT * FROM weeks WHERE branch_id=? AND week_start=?", (branch_id, week_start)).fetchone()
                if existing:
                    json_response(self, 200, {"week": ser_week(existing), "created": False})
                    return
                cur = conn.execute("INSERT INTO weeks(branch_id,week_start,status,created_at) VALUES(?,?,?,?)",
                                   (branch_id, week_start, "draft", now))
                week_id = cur.lastrowid
                # Create default shifts
                day_keys = ["sun","mon","tue","wed","thu","fri","sat"]
                branch = conn.execute("SELECT * FROM branches WHERE id=?", (branch_id,)).fetchone()
                for dk in day_keys:
                    for slot in DEFAULT_SHIFT_SLOTS:
                        h = default_shift_hours(conn, branch, dk, slot)
                        max_employees = default_shift_max_employees(conn, branch_id, dk, slot)
                        conn.execute(
                            "INSERT INTO shifts(week_id,day_key,slot,hours,max_employees,created_at) VALUES(?,?,?,?,?,?)",
                            (week_id, dk, slot, h, max_employees, now)
                        )
                week = conn.execute("SELECT * FROM weeks WHERE id=?", (week_id,)).fetchone()
                audit(conn, auth["uid"], f"פתח שבוע {week_start}", "week", week_id)
            json_response(self, 201, {"week": ser_week(week), "created": True})
            return

        # Persist default hours for a branch/day/slot and update open weeks from the effective week onward.
        if path == "/api/shift-defaults":
            auth = require_auth(self, "network-manager", "area-manager", "branch-manager")
            if not auth: return
            shift_id = int(body.get("shiftId") or 0)
            branch_id = int(body.get("branchId") or 0)
            day_key = body.get("dayKey", "").strip()
            slot = body.get("slot", "").strip()
            hours = body.get("hours", "").strip()
            effective_week_start = body.get("effectiveWeekStart", "").strip()
            if not hours or "-" not in hours:
                json_response(self, 400, {"error": "invalid_hours"})
                return
            with db() as conn:
                if shift_id:
                    shift_row = conn.execute("""
                        SELECT s.id, s.day_key, s.slot, w.branch_id, w.week_start
                        FROM shifts s
                        JOIN weeks w ON w.id=s.week_id
                        WHERE s.id=?
                    """, (shift_id,)).fetchone()
                    if not shift_row:
                        json_response(self, 404, {"error": "shift_not_found"})
                        return
                    branch_id = shift_row["branch_id"]
                    day_key = shift_row["day_key"]
                    slot = shift_row["slot"]
                    effective_week_start = effective_week_start or shift_row["week_start"]
                if day_key not in ("sun","mon","tue","wed","thu","fri","sat") or slot not in SHIFT_SLOTS:
                    json_response(self, 400, {"error": "invalid_shift"})
                    return
                ensure_shift_defaults_table(conn)
                if not can_access_branch(conn, auth, branch_id):
                    json_response(self, 403, {"error": "forbidden"})
                    return
                conn.execute("""
                    INSERT INTO branch_shift_defaults(branch_id, day_key, slot, hours, updated_at)
                    VALUES(?,?,?,?,?)
                    ON CONFLICT(branch_id, day_key, slot)
                    DO UPDATE SET hours=excluded.hours, updated_at=excluded.updated_at
                """, (branch_id, day_key, slot, hours, now))
                params = [hours, branch_id, day_key, slot]
                week_filter = ""
                if effective_week_start:
                    week_filter = " AND w.week_start >= ?"
                    params.append(effective_week_start)
                conn.execute(f"""
                    UPDATE shifts
                    SET hours=?
                    WHERE id IN (
                      SELECT s.id
                      FROM shifts s
                      JOIN weeks w ON w.id=s.week_id
                      WHERE w.branch_id=? AND s.day_key=? AND s.slot=? AND w.status != 'closed'{week_filter}
                    )
                """, params)
                audit(conn, auth["uid"], f"עדכן שעות ברירת מחדל {day_key}/{slot} ל-{hours}", "branch", branch_id)
            json_response(self, 200, {"ok": True})
            return

        # Create optional middle shift for a specific day.
        if path == "/api/shifts":
            auth = require_auth(self, "network-manager", "area-manager", "branch-manager")
            if not auth: return
            week_id = int(body.get("weekId") or 0)
            day_key = body.get("dayKey", "").strip()
            slot = body.get("slot", "middle").strip()
            hours = body.get("hours", "").strip()
            if day_key not in ("sun","mon","tue","wed","thu","fri","sat") or slot != "middle" or not hours or "-" not in hours:
                json_response(self, 400, {"error": "invalid_shift"})
                return
            with db() as conn:
                week = conn.execute("SELECT * FROM weeks WHERE id=?", (week_id,)).fetchone()
                if not week or not can_access_branch(conn, auth, week["branch_id"]):
                    json_response(self, 403, {"error": "forbidden"})
                    return
                if week["status"] == "closed":
                    json_response(self, 409, {"error": "week_locked"})
                    return
                try:
                    max_employees = default_shift_max_employees(conn, week["branch_id"], day_key, slot)
                    cur = conn.execute(
                        "INSERT INTO shifts(week_id,day_key,slot,hours,max_employees,created_at) VALUES(?,?,?,?,?,?)",
                        (week_id, day_key, slot, hours, max_employees, now)
                    )
                except sqlite3.IntegrityError:
                    json_response(self, 409, {"error": "shift_exists"})
                    return
                shift = conn.execute("SELECT * FROM shifts WHERE id=?", (cur.lastrowid,)).fetchone()
                audit(conn, auth["uid"], f"פתח משמרת אמצע {day_key} {hours}", "shift", shift["id"])
            json_response(self, 201, {"ok": True, "shift": ser_shift(shift)})
            return

        # Assign employee to shift
        if path == "/api/assignments":
            auth = require_auth(self, "network-manager", "area-manager", "branch-manager")
            if not auth: return
            shift_id = int(body.get("shiftId") or 0)
            user_id = int(body.get("userId") or 0)
            with db() as conn:
                branch = conn.execute("""
                    SELECT w.branch_id FROM shifts s JOIN weeks w ON w.id=s.week_id WHERE s.id=?
                """, (shift_id,)).fetchone()
                if not branch or not can_access_branch(conn, auth, branch["branch_id"]):
                    json_response(self, 403, {"error": "forbidden"})
                    return
                pending_taxi = conn.execute("""
                    SELECT cr.id, cr.requested_start, cr.note, u.full_name
                    FROM change_requests cr
                    JOIN users u ON u.id=cr.requester_id
                    WHERE cr.shift_id=? AND cr.requester_id=? AND cr.type='taxi' AND cr.status='open'
                    ORDER BY cr.requested_start
                """, (shift_id, user_id)).fetchall()
                if pending_taxi:
                    json_response(self, 409, {
                        "error": "taxi_response_required",
                        "userName": pending_taxi[0]["full_name"],
                        "requests": [
                            {"id": r["id"], "direction": r["requested_start"], "note": r["note"]}
                            for r in pending_taxi
                        ],
                    })
                    return
                try:
                    cur = conn.execute(
                        "INSERT INTO shift_assignments(shift_id,user_id,created_at) VALUES(?,?,?)",
                        (shift_id, user_id, now)
                    )
                    audit(conn, auth["uid"], "שיבוץ עובד למשמרת", "shift", shift_id)
                except sqlite3.IntegrityError:
                    json_response(self, 409, {"error": "already_assigned"})
                    return
                staffed_row = conn.execute("""
                    SELECT s.max_employees,
                           (SELECT COUNT(*) FROM shift_assignments WHERE shift_id=s.id) + COALESCE(s.reinforcement, 0) AS staffed_count
                    FROM shifts s
                    WHERE s.id=?
                """, (shift_id,)).fetchone()
                max_employees = staffed_row["max_employees"] if staffed_row else None
                staffed_count = int(staffed_row["staffed_count"] or 0) if staffed_row else None
                overstaffed = bool(max_employees and staffed_count and staffed_count > int(max_employees))
            json_response(self, 201, {
                "ok": True,
                "id": cur.lastrowid,
                "overstaffed": overstaffed,
                "staffedCount": staffed_count,
                "maxEmployees": int(max_employees) if max_employees is not None else None,
            })
            return

        # Submit availability
        if path == "/api/availability":
            auth = require_auth(self)
            if not auth: return
            shift_id = int(body.get("shiftId") or 0)
            branch_id = int(body.get("branchId") or 0)
            week_start = body.get("weekStart", "").strip()
            day_key = body.get("dayKey", "").strip()
            slot = body.get("slot", "").strip()
            note = body.get("note", "")
            mode = body.get("mode", "").strip()
            taxi_directions = body.get("taxiDirections") or []
            if not isinstance(taxi_directions, list):
                taxi_directions = []
            taxi_directions = [d for d in taxi_directions if d in ("arrival", "return")]
            with db() as conn:
                if not shift_id:
                    if not week_start:
                        json_response(self, 400, {"error": "week_start_required"})
                        return
                    if day_key not in ("sun","mon","tue","wed","thu","fri","sat") or slot not in SHIFT_SLOTS:
                        json_response(self, 400, {"error": "invalid_shift"})
                        return
                    branch = conn.execute("SELECT id FROM branches WHERE id=?", (branch_id,)).fetchone()
                    if not branch:
                        json_response(self, 400, {"error": "branch_required"})
                        return
                    week = ensure_week(conn, branch_id, week_start, now)
                    shift = conn.execute(
                        "SELECT id FROM shifts WHERE week_id=? AND day_key=? AND slot=?",
                        (week["id"], day_key, slot)
                    ).fetchone()
                    if not shift:
                        json_response(self, 404, {"error": "shift_not_found"})
                        return
                    shift_id = shift["id"]
                else:
                    branch = conn.execute("""
                        SELECT w.branch_id FROM shifts s JOIN weeks w ON w.id=s.week_id WHERE s.id=?
                    """, (shift_id,)).fetchone()
                    if not branch or not can_access_branch(conn, auth, branch["branch_id"]):
                        json_response(self, 403, {"error": "forbidden"})
                        return
                cur_shift = conn.execute("""
                    SELECT s.id, s.day_key, s.slot, w.week_start, w.branch_id, w.status AS week_status
                    FROM shifts s JOIN weeks w ON w.id=s.week_id
                    WHERE s.id=?
                """, (shift_id,)).fetchone()
                if not cur_shift:
                    json_response(self, 404, {"error": "shift_not_found"})
                    return
                if cur_shift["week_status"] == "closed":
                    json_response(self, 409, {"error": "week_locked"})
                    return
                existing = conn.execute("SELECT id FROM shift_availability WHERE shift_id=? AND user_id=?", (shift_id, auth["uid"])).fetchone()
                if existing:
                    if mode == "resubmit":
                        conn.execute(
                            "UPDATE shift_availability SET note=? WHERE shift_id=? AND user_id=?",
                            (note, shift_id, auth["uid"])
                        )
                        if cur_shift["day_key"] == "sat":
                            sync_taxi_requests(conn, shift_id, auth["uid"], note, taxi_directions, now)
                        json_response(self, 200, {"ok": True, "removed": False, "resubmitted": True})
                        return
                    conn.execute("DELETE FROM shift_availability WHERE shift_id=? AND user_id=?", (shift_id, auth["uid"]))
                    conn.execute("""
                        DELETE FROM change_requests
                        WHERE shift_id=? AND requester_id=? AND type='taxi'
                    """, (shift_id, auth["uid"]))
                    week_status = conn.execute(
                        "SELECT w.status FROM shifts s JOIN weeks w ON w.id=s.week_id WHERE s.id=?", (shift_id,)
                    ).fetchone()
                    if week_status and week_status["status"] not in ("published", "closed"):
                        conn.execute("DELETE FROM shift_assignments WHERE shift_id=? AND user_id=?", (shift_id, auth["uid"]))
                    json_response(self, 200, {"ok": True, "removed": True})
                else:
                    conflict = conn.execute("""
                        SELECT b.name, b.number, 'assignment' AS kind
                        FROM shift_assignments sa
                        JOIN shifts s ON s.id=sa.shift_id
                        JOIN weeks w ON w.id=s.week_id
                        JOIN branches b ON b.id=w.branch_id
                        WHERE sa.user_id=? AND w.week_start=? AND s.day_key=? AND s.slot=? AND sa.shift_id != ?
                        UNION ALL
                        SELECT b.name, b.number, 'availability' AS kind
                        FROM shift_availability av
                        JOIN shifts s ON s.id=av.shift_id
                        JOIN weeks w ON w.id=s.week_id
                        JOIN branches b ON b.id=w.branch_id
                        WHERE av.user_id=? AND w.week_start=? AND s.day_key=? AND s.slot=? AND av.shift_id != ?
                        LIMIT 1
                    """, (auth["uid"], cur_shift["week_start"], cur_shift["day_key"], cur_shift["slot"], shift_id,
                          auth["uid"], cur_shift["week_start"], cur_shift["day_key"], cur_shift["slot"], shift_id)).fetchone()
                    if conflict:
                        json_response(self, 409, {
                            "error": "availability_conflict",
                            "branchName": conflict["name"],
                            "branchNumber": conflict["number"],
                            "type": conflict["kind"],
                        })
                        return
                    conn.execute("INSERT INTO shift_availability(shift_id,user_id,note,created_at) VALUES(?,?,?,?)",
                                 (shift_id, auth["uid"], note, now))
                    if cur_shift["day_key"] == "sat":
                        sync_taxi_requests(conn, shift_id, auth["uid"], note, taxi_directions, now)
                    json_response(self, 201, {"ok": True, "removed": False})
            return

        if path == "/api/availability/pull":
            auth = require_auth(self)
            if not auth: return
            shift_id = int(body.get("shiftId") or 0)
            with db() as conn:
                shift = conn.execute("""
                    SELECT s.*, w.status AS week_status, w.branch_id
                    FROM shifts s JOIN weeks w ON w.id=s.week_id
                    WHERE s.id=?
                """, (shift_id,)).fetchone()
                if not shift or not can_access_branch(conn, auth, shift["branch_id"]):
                    json_response(self, 403, {"error": "forbidden"})
                    return
                if shift["week_status"] in ("published", "closed"):
                    json_response(self, 409, {"error": "week_locked"})
                    return
                conn.execute("DELETE FROM shift_assignments WHERE shift_id=? AND user_id=?", (shift_id, auth["uid"]))
                conn.execute("DELETE FROM shift_availability WHERE shift_id=? AND user_id=?", (shift_id, auth["uid"]))
                conn.execute("DELETE FROM change_requests WHERE shift_id=? AND requester_id=? AND type='taxi'", (shift_id, auth["uid"]))
            json_response(self, 200, {"ok": True})
            return

        # Save day report
        if path == "/api/reports":
            auth = require_auth(self)
            if not auth: return
            branch_id = int(body.get("branchId") or 0)
            report_date = body.get("date","").strip()
            with db() as conn:
                auth_user = conn.execute("SELECT * FROM users WHERE id=?", (auth["uid"],)).fetchone()
                can_write_report = auth["role"] in ("area-manager", "branch-manager") or bool(auth_user["is_lead"])
                if auth["role"] == "network-manager" or not can_write_report or not can_access_branch(conn, auth, branch_id):
                    json_response(self, 403, {"error": "forbidden"})
                    return
                conn.execute("""
                    INSERT INTO day_reports(branch_id,report_date,sales_target,actual_sales,avg_transaction,avg_items,created_by,created_at)
                    VALUES(?,?,?,?,?,?,?,?)
                    ON CONFLICT(branch_id,report_date) DO UPDATE SET
                      sales_target=excluded.sales_target, actual_sales=excluded.actual_sales,
                      avg_transaction=excluded.avg_transaction, avg_items=excluded.avg_items
                """, (branch_id, report_date,
                      int(body.get("salesTarget",0)), int(body.get("actualSales",0)),
                      float(body.get("avgTransaction",0)), float(body.get("avgItems",0)),
                      auth["uid"], now))
                row = conn.execute("SELECT * FROM day_reports WHERE branch_id=? AND report_date=?", (branch_id, report_date)).fetchone()
                audit(conn, auth["uid"], f"שמר דוח {report_date}", "report", row["id"])
            json_response(self, 200, {"ok": True, "report": ser_report(row)})
            return

        # Submit change request
        if path == "/api/requests":
            auth = require_auth(self)
            if not auth: return
            cur_type = body.get("type","")
            if cur_type not in ("hours", "exit", "swap", "reinforcement", "taxi"):
                json_response(self, 400, {"error": "invalid_type"})
                return
            if cur_type == "exit":
                json_response(self, 410, {"error": "exit_requests_disabled"})
                return
            with db() as conn:
                shift_id = int(body.get("shiftId",0))
                branch = conn.execute("""
                    SELECT w.branch_id, w.status AS week_status FROM shifts s JOIN weeks w ON w.id=s.week_id WHERE s.id=?
                """, (shift_id,)).fetchone()
                assigned_to_shift = conn.execute(
                    "SELECT 1 FROM shift_assignments WHERE shift_id=? AND user_id=?",
                    (shift_id, auth["uid"])
                ).fetchone()
                if not branch or not (can_access_branch(conn, auth, branch["branch_id"]) or assigned_to_shift):
                    json_response(self, 403, {"error": "forbidden"})
                    return
                if branch["week_status"] == "closed" and cur_type != "hours":
                    json_response(self, 409, {"error": "week_locked"})
                    return
                requester_id = auth["uid"]
                if cur_type == "reinforcement":
                    if auth["role"] not in ("network-manager", "area-manager"):
                        json_response(self, 403, {"error": "forbidden"})
                        return
                    requester_id = int(body.get("requesterId") or 0)
                    target = conn.execute("SELECT * FROM users WHERE id=? AND status='active'", (requester_id,)).fetchone()
                    if not target:
                        json_response(self, 404, {"error": "user_not_found"})
                        return
                    candidates = reinforcement_candidates(conn, auth, shift_id)
                    candidate = next((c for c in candidates if c["id"] == requester_id), None)
                    if not candidate:
                        json_response(self, 409, {"error": "not_available"})
                        return
                    if candidate.get("pending"):
                        json_response(self, 409, {"error": "already_requested"})
                        return
                cur = conn.execute("""
                    INSERT INTO change_requests(type,shift_id,requester_id,replacement_id,requested_start,requested_end,note,status,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?)
                """, (cur_type, shift_id, requester_id,
                      body.get("replacementId") or None,
                      body.get("requestedStart") or None, body.get("requestedEnd") or None,
                      body.get("note",""), "open", now))
            json_response(self, 201, {"ok": True, "id": cur.lastrowid})
            return

        # Dev login (no OTP)
        if path == "/api/dev/auth":
            if not DEV_ENABLED:
                json_response(self, 404, {"error": "not_found"})
                return
            password = body.get("password", "").strip()
            if not hmac.compare_digest(password, DEV_PASSWORD):
                json_response(self, 401, {"error": "invalid_dev_password"})
                return
            json_response(self, 200, {"token": make_dev_token(), "role": "developer"})
            return

        json_response(self, 404, {"error": "not_found"})

    def route_put(self, path: str) -> None:
        body = read_json(self)
        now = int(time.time())

        if path == "/api/settings/notifications":
            auth = require_auth(self, "network-manager", "area-manager", "branch-manager")
            if not auth: return
            with db() as conn:
                settings = save_notification_settings(conn, body)
                audit(conn, auth["uid"], "עדכן הגדרות התראות מייל", "settings", None)
            json_response(self, 200, {"ok": True, "settings": settings})
            return

        # Update user
        if path.startswith("/api/users/"):
            uid = int(path.split("/")[-1])
            auth = require_auth(self, "network-manager", "area-manager", "branch-manager")
            if not auth: return
            with db() as conn:
                user = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
                if not user:
                    json_response(self, 404, {"error": "not_found"}); return
                new_role = body.get("role", user["role"])
                if new_role not in ("network-manager", "area-manager", "branch-manager", "employee"):
                    json_response(self, 400, {"error": "invalid_role"}); return
                if not can_manage_user(conn, auth, user, new_role):
                    json_response(self, 403, {"error": "role_hierarchy_forbidden"}); return
                if "branchIds" in body and not branch_ids_allowed_for_actor(conn, auth, [int(bid) for bid in body["branchIds"]]):
                    json_response(self, 403, {"error": "branch_forbidden"}); return
                conn.execute("""
                    UPDATE users SET full_name=?, phone=?, email=?, role=?, status=?,
                    hourly_wage=?, rank=?, is_lead=?, manager_note=? WHERE id=?
                """, (body.get("fullName", user["full_name"]),
                      body.get("phone", user["phone"]),
                      body.get("email", user["email"]),
                      new_role,
                      body.get("status", user["status"]),
                      body.get("hourlyWage", user["hourly_wage"]),
                      body.get("rank", user["rank"]),
                      1 if (new_role == "branch-manager" or body.get("isLead", bool(user["is_lead"]))) else 0,
                      body.get("managerNote", user["manager_note"] if "manager_note" in user.keys() else None),
                      uid))
                if "branchIds" in body:
                    conn.execute("DELETE FROM user_branches WHERE user_id=?", (uid,))
                    for bid in body["branchIds"]:
                        conn.execute("INSERT OR IGNORE INTO user_branches(user_id,branch_id) VALUES(?,?)", (uid, bid))
                    if new_role == "branch-manager":
                        manager_branch = next(iter(body["branchIds"]), None)
                        if manager_branch:
                            conn.execute("UPDATE branches SET manager_id=? WHERE id=?", (uid, manager_branch))
                user = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
                branch_ids = [r["branch_id"] for r in conn.execute("SELECT branch_id FROM user_branches WHERE user_id=?", (uid,)).fetchall()]
                audit(conn, auth["uid"], f"עדכן משתמש {user['full_name']}", "user", uid)
            json_response(self, 200, {"ok": True, "user": ser_user(user, branch_ids)})
            return

        # Update branch
        if path.startswith("/api/branches/"):
            bid = int(path.split("/")[-1])
            auth = require_auth(self, "network-manager")
            if not auth: return
            with db() as conn:
                branch = conn.execute("SELECT * FROM branches WHERE id=?", (bid,)).fetchone()
                if not branch:
                    json_response(self, 404, {"error": "not_found"}); return
                conn.execute("""
                    UPDATE branches SET name=?, number=?, area=?, manager_id=?,
                    labor_target=?, morning_hours=?, evening_hours=? WHERE id=?
                """, (body.get("name", branch["name"]),
                      body.get("number", branch["number"]),
                      body.get("area", branch["area"]),
                      body.get("managerId", branch["manager_id"]),
                      body.get("laborTarget", branch["labor_target"]),
                      body.get("morningHours", branch["morning_hours"]),
                      body.get("eveningHours", branch["evening_hours"]),
                      bid))
                branch = conn.execute("SELECT b.*, u.full_name AS manager_name FROM branches b LEFT JOIN users u ON b.manager_id=u.id WHERE b.id=?", (bid,)).fetchone()
                audit(conn, auth["uid"], f"עדכן סניף {branch['name']}", "branch", bid)
            json_response(self, 200, {"ok": True, "branch": ser_branch(branch, branch["manager_name"])})
            return

        # Update week status
        if path.startswith("/api/weeks/"):
            wid = int(path.split("/")[-1])
            auth = require_auth(self, "network-manager", "area-manager", "branch-manager")
            if not auth: return
            new_status = body.get("status","")
            if new_status not in ("draft","published","closed"):
                json_response(self, 400, {"error": "invalid_status"}); return
            with db() as conn:
                existing_week = conn.execute("SELECT * FROM weeks WHERE id=?", (wid,)).fetchone()
                if not existing_week or not can_access_branch(conn, auth, existing_week["branch_id"]):
                    json_response(self, 403, {"error": "forbidden"}); return
                conn.execute("UPDATE weeks SET status=? WHERE id=?", (new_status, wid))
                week = conn.execute("SELECT * FROM weeks WHERE id=?", (wid,)).fetchone()
                audit(conn, auth["uid"], f"עדכן סטטוס שבוע ל-{new_status}", "week", wid)
            json_response(self, 200, {"ok": True, "week": ser_week(week)})
            return

        # Update shift (hours, target, shortage, reinforcement)
        if path.startswith("/api/reports/"):
            report_id = int(path.split("/")[-1])
            auth = require_auth(self)
            if not auth: return
            with db() as conn:
                report = conn.execute("SELECT * FROM day_reports WHERE id=?", (report_id,)).fetchone()
                if not report:
                    json_response(self, 404, {"error": "not_found"}); return
                auth_user = conn.execute("SELECT * FROM users WHERE id=?", (auth["uid"],)).fetchone()
                can_write_report = auth["role"] in ("area-manager", "branch-manager") or bool(auth_user["is_lead"])
                if auth["role"] == "network-manager" or not can_write_report or not can_access_branch(conn, auth, report["branch_id"]):
                    json_response(self, 403, {"error": "forbidden"}); return
                conn.execute("""
                    UPDATE day_reports
                    SET sales_target=?, actual_sales=?, avg_transaction=?, avg_items=?
                    WHERE id=?
                """, (int(body.get("salesTarget", report["sales_target"])),
                      int(body.get("actualSales", report["actual_sales"])),
                      float(body.get("avgTransaction", report["avg_transaction"])),
                      float(body.get("avgItems", report["avg_items"])),
                      report_id))
                row = conn.execute("SELECT * FROM day_reports WHERE id=?", (report_id,)).fetchone()
                audit(conn, auth["uid"], f"עדכן דוח {row['report_date']}", "report", report_id)
            json_response(self, 200, {"ok": True, "report": ser_report(row)})
            return

        # Update shift (hours, target, shortage, reinforcement)
        if path.startswith("/api/shifts/"):
            sid = int(path.split("/")[-1])
            auth = require_auth(self, "network-manager", "area-manager", "branch-manager")
            if not auth: return
            with db() as conn:
                shift = conn.execute("SELECT * FROM shifts WHERE id=?", (sid,)).fetchone()
                if not shift:
                    json_response(self, 404, {"error": "not_found"}); return
                week_row = conn.execute("SELECT branch_id, week_start FROM weeks WHERE id=?", (shift["week_id"],)).fetchone()
                if not week_row or not can_access_branch(conn, auth, week_row["branch_id"]):
                    json_response(self, 403, {"error": "forbidden"}); return
                shortage = body.get("shortage")
                max_employees = shift["max_employees"] if "max_employees" in shift.keys() else None
                max_employees_changed = False
                if "maxEmployees" in body:
                    raw_max = body.get("maxEmployees")
                    requested_max = None if raw_max in (None, "", 0, "0") else max(1, int(raw_max))
                    current_max = int(max_employees) if max_employees is not None else None
                    if auth["role"] == "branch-manager" and requested_max != current_max:
                        json_response(self, 403, {"error": "max_employees_forbidden"}); return
                    max_employees_changed = requested_max != current_max
                    max_employees = requested_max
                new_hours = body.get("hours", shift["hours"])
                conn.execute("""
                    UPDATE shifts SET hours=?, sales_target=?, reinforcement=?, staffed=?,
                    max_employees=?, shortage_count=?, shortage_level=?, shortage_status=?, shortage_note=?
                    WHERE id=?
                """, (new_hours,
                      body.get("salesTarget", shift["sales_target"]),
                      body.get("reinforcement", shift["reinforcement"]),
                      1 if body.get("staffed", shift["staffed"]) else 0,
                      max_employees,
                      shortage["count"] if shortage else None,
                      shortage["level"] if shortage else None,
                      shortage["status"] if shortage else None,
                      shortage["note"] if shortage else None,
                      sid))
                if "maxEmployees" in body and max_employees_changed:
                    ensure_shift_defaults_table(conn)
                    conn.execute("""
                        INSERT INTO branch_shift_defaults(branch_id, day_key, slot, hours, max_employees, updated_at)
                        VALUES(?,?,?,?,?,?)
                        ON CONFLICT(branch_id, day_key, slot)
                        DO UPDATE SET max_employees=excluded.max_employees, updated_at=excluded.updated_at
                    """, (week_row["branch_id"], shift["day_key"], shift["slot"], new_hours, max_employees, now))
                    conn.execute("""
                        UPDATE shifts
                        SET max_employees=?
                        WHERE id IN (
                          SELECT s.id
                          FROM shifts s
                          JOIN weeks w ON w.id=s.week_id
                          WHERE w.branch_id=?
                            AND s.day_key=?
                            AND s.slot=?
                            AND w.week_start >= ?
                            AND w.status != 'closed'
                        )
                    """, (max_employees, week_row["branch_id"], shift["day_key"], shift["slot"], week_row["week_start"]))
                    audit(conn, auth["uid"], f"×¢×“×›×Ÿ ×ª×§×Ÿ ×¢×•×‘×“×™× {shift['day_key']}/{shift['slot']} ×œ-{max_employees or '×œ×œ× ×ª×§×Ÿ'}", "branch", week_row["branch_id"])
                shift = conn.execute("SELECT * FROM shifts WHERE id=?", (sid,)).fetchone()
            json_response(self, 200, {"ok": True, "shift": ser_shift(shift)})
            return

        # Update assignment hours
        if path.startswith("/api/assignments/"):
            aid = int(path.split("/")[-1])
            auth = require_auth(self, "network-manager", "area-manager", "branch-manager")
            if not auth: return
            with db() as conn:
                conn.execute("UPDATE shift_assignments SET start_time=?, end_time=? WHERE id=?",
                             (body.get("startTime"), body.get("endTime"), aid))
            json_response(self, 200, {"ok": True})
            return

        # Edit change request fields (by requester, open only)
        if path.startswith("/api/requests/") and "status" not in body:
            rid = int(path.split("/")[-1])
            auth = require_auth(self)
            if not auth: return
            with db() as conn:
                req = conn.execute("SELECT * FROM change_requests WHERE id=?", (rid,)).fetchone()
                if not req:
                    json_response(self, 404, {"error": "not_found"}); return
                old_status = req["status"]
                if req["requester_id"] != auth["uid"]:
                    json_response(self, 403, {"error": "forbidden"}); return
                if req["status"] != "open":
                    json_response(self, 409, {"error": "already_processed"}); return
                conn.execute(
                    "UPDATE change_requests SET note=?, requested_start=?, requested_end=? WHERE id=?",
                    (body.get("note", req["note"]),
                     body.get("requestedStart", req["requested_start"]),
                     body.get("requestedEnd", req["requested_end"]),
                     rid)
                )
                audit(conn, auth["uid"], f"ערך בקשה #{rid}", "request", rid)
            json_response(self, 200, {"ok": True})
            return

        # Update change request status
        if path.startswith("/api/requests/"):
            rid = int(path.split("/")[-1])
            auth = require_auth(self)
            if not auth: return
            new_status = body.get("status","")
            if new_status not in ("approved","rejected"):
                json_response(self, 400, {"error": "invalid_status"}); return
            with db() as conn:
                req = conn.execute("SELECT * FROM change_requests WHERE id=?", (rid,)).fetchone()
                if not req:
                    json_response(self, 404, {"error": "not_found"}); return
                old_status = req["status"]
                branch = conn.execute("""
                    SELECT w.branch_id, w.status AS week_status, w.week_start, s.day_key
                    FROM shifts s JOIN weeks w ON w.id=s.week_id
                    WHERE s.id=?
                """, (req["shift_id"],)).fetchone()
                employee_reinforcement = auth["role"] == "employee" and req["type"] == "reinforcement" and req["requester_id"] == auth["uid"]
                manager_can_handle = auth["role"] in ("network-manager", "area-manager", "branch-manager") and branch and can_access_branch(conn, auth, branch["branch_id"])
                if not branch or not (employee_reinforcement or manager_can_handle):
                    json_response(self, 403, {"error": "forbidden"}); return
                if req["type"] == "reinforcement" and new_status == "approved" and not employee_reinforcement:
                    json_response(self, 403, {"error": "employee_approval_required"}); return
                if (
                    req["type"] == "taxi"
                    and old_status == "approved"
                    and new_status == "rejected"
                    and not can_change_handled_taxi_request(branch["week_start"], branch["day_key"])
                ):
                    json_response(self, 409, {"error": "taxi_change_deadline_passed"}); return
                if req["type"] == "reinforcement" and employee_reinforcement and new_status == "rejected":
                    if req["status"] == "approved" and branch["week_status"] != "draft":
                        json_response(self, 409, {"error": "week_locked"}); return
                    conn.execute("DELETE FROM shift_assignments WHERE shift_id=? AND user_id=?",
                                 (req["shift_id"], req["requester_id"]))
                conn.execute("UPDATE change_requests SET status=? WHERE id=?", (new_status, rid))
                # If hours approved, update assignment
                if new_status == "approved" and req["type"] == "hours":
                    conn.execute("""
                        UPDATE shift_assignments SET start_time=?, end_time=?
                        WHERE shift_id=? AND user_id=?
                    """, (req["requested_start"], req["requested_end"], req["shift_id"], req["requester_id"]))
                # If exit/swap approved, remove from shift
                if new_status == "approved" and req["type"] in ("exit","swap"):
                    conn.execute("DELETE FROM shift_assignments WHERE shift_id=? AND user_id=?",
                                 (req["shift_id"], req["requester_id"]))
                    if req["type"] == "swap" and req["replacement_id"]:
                        conn.execute("INSERT OR IGNORE INTO shift_assignments(shift_id,user_id,created_at) VALUES(?,?,?)",
                                     (req["shift_id"], req["replacement_id"], int(time.time())))
                        conn.execute("DELETE FROM shift_availability WHERE shift_id=? AND user_id=?",
                                     (req["shift_id"], req["replacement_id"]))
                if new_status == "approved" and req["type"] == "reinforcement":
                    conflict = conn.execute("""
                        SELECT b.name, b.number, 'assignment' AS kind
                        FROM shift_assignments sa
                        JOIN shifts s ON s.id=sa.shift_id
                        JOIN weeks w ON w.id=s.week_id
                        JOIN branches b ON b.id=w.branch_id
                        JOIN shifts target_s ON target_s.id=?
                        JOIN weeks target_w ON target_w.id=target_s.week_id
                        WHERE sa.user_id=? AND w.week_start=target_w.week_start
                          AND s.day_key=target_s.day_key AND s.slot=target_s.slot
                          AND sa.shift_id != ?
                        LIMIT 1
                    """, (req["shift_id"], req["requester_id"], req["shift_id"])).fetchone()
                    if conflict:
                        conn.execute("UPDATE change_requests SET status='open' WHERE id=?", (rid,))
                        json_response(self, 409, {
                            "error": "assignment_conflict",
                            "branchName": conflict["name"],
                            "branchNumber": conflict["number"],
                            "type": conflict["kind"],
                        })
                        return
                    conn.execute("""
                        DELETE FROM shift_availability
                        WHERE user_id=? AND shift_id IN (
                            SELECT av.shift_id
                            FROM shift_availability av
                            JOIN shifts s ON s.id=av.shift_id
                            JOIN weeks w ON w.id=s.week_id
                            JOIN shifts target_s ON target_s.id=?
                            JOIN weeks target_w ON target_w.id=target_s.week_id
                            WHERE av.user_id=?
                              AND w.week_start=target_w.week_start
                              AND s.day_key=target_s.day_key
                              AND s.slot=target_s.slot
                              AND av.shift_id != ?
                        )
                    """, (req["requester_id"], req["shift_id"], req["requester_id"], req["shift_id"]))
                    conn.execute("INSERT OR IGNORE INTO shift_assignments(shift_id,user_id,created_at) VALUES(?,?,?)",
                                 (req["shift_id"], req["requester_id"], int(time.time())))
                    shortage = conn.execute("SELECT shortage_count FROM shifts WHERE id=?", (req["shift_id"],)).fetchone()
                    shortage_count = int(shortage["shortage_count"] or 0) if shortage else 0
                    if shortage_count > 0:
                        approved_count = conn.execute("""
                            SELECT COUNT(*) AS c
                            FROM change_requests
                            WHERE shift_id=? AND type='reinforcement' AND status='approved'
                        """, (req["shift_id"],)).fetchone()["c"]
                        if approved_count >= shortage_count:
                            conn.execute("""
                                UPDATE change_requests
                                SET status='rejected'
                                WHERE shift_id=? AND type='reinforcement' AND status='open'
                            """, (req["shift_id"],))
                if old_status != new_status:
                    notify_request_status(conn, rid, new_status)
                audit(conn, auth["uid"], f"עדכן בקשה #{rid} ל-{new_status}", "request", rid)
            json_response(self, 200, {"ok": True})
            return

        # Dev: block / unblock branch
        if path.startswith("/api/dev/branches/"):
            if not require_dev(self): return
            bid = int(path.split("/")[-1])
            blocked = 1 if body.get("blocked") else 0
            with db() as conn:
                conn.execute("UPDATE branches SET is_blocked=? WHERE id=?", (blocked, bid))
                branch = conn.execute(
                    "SELECT b.*, u.full_name AS manager_name FROM branches b LEFT JOIN users u ON b.manager_id=u.id WHERE b.id=?",
                    (bid,)
                ).fetchone()
                if not branch:
                    json_response(self, 404, {"error": "not_found"}); return
            json_response(self, 200, {"ok": True, "branch": ser_branch(branch, branch["manager_name"])})
            return

        json_response(self, 404, {"error": "not_found"})

    def route_delete(self, path: str) -> None:
        # Delete optional middle shift if no employee is assigned to it.
        if path.startswith("/api/shifts/"):
            sid = int(path.split("/")[-1])
            auth = require_auth(self, "network-manager", "area-manager", "branch-manager")
            if not auth: return
            with db() as conn:
                shift = conn.execute("""
                    SELECT s.*, w.branch_id, w.status AS week_status
                    FROM shifts s
                    JOIN weeks w ON w.id=s.week_id
                    WHERE s.id=?
                """, (sid,)).fetchone()
                if not shift:
                    json_response(self, 404, {"error": "not_found"}); return
                if shift["slot"] != "middle":
                    json_response(self, 403, {"error": "only_middle_shift"}); return
                if shift["week_status"] == "closed":
                    json_response(self, 409, {"error": "week_locked"}); return
                if not can_access_branch(conn, auth, shift["branch_id"]):
                    json_response(self, 403, {"error": "forbidden"}); return
                assigned = conn.execute(
                    "SELECT COUNT(*) AS c FROM shift_assignments WHERE shift_id=?",
                    (sid,)
                ).fetchone()["c"]
                if assigned:
                    json_response(self, 409, {"error": "shift_has_assignments"}); return
                conn.execute("DELETE FROM shifts WHERE id=?", (sid,))
                audit(conn, auth["uid"], "delete_middle_shift", "shift", sid)
            json_response(self, 200, {"ok": True})
            return

        # Delete change request (by requester, open only)
        if path.startswith("/api/requests/"):
            rid = int(path.split("/")[-1])
            auth = require_auth(self)
            if not auth: return
            with db() as conn:
                req = conn.execute("SELECT * FROM change_requests WHERE id=?", (rid,)).fetchone()
                if not req:
                    json_response(self, 404, {"error": "not_found"}); return
                if req["requester_id"] != auth["uid"]:
                    json_response(self, 403, {"error": "forbidden"}); return
                if req["status"] != "open":
                    json_response(self, 409, {"error": "already_processed"}); return
                conn.execute("DELETE FROM change_requests WHERE id=?", (rid,))
                audit(conn, auth["uid"], f"מחק בקשה #{rid}", "request", rid)
            json_response(self, 200, {"ok": True})
            return

        # Delete day report
        if path.startswith("/api/reports/"):
            report_id = int(path.split("/")[-1])
            auth = require_auth(self)
            if not auth: return
            with db() as conn:
                report = conn.execute("SELECT * FROM day_reports WHERE id=?", (report_id,)).fetchone()
                if not report:
                    json_response(self, 404, {"error": "not_found"})
                    return
                auth_user = conn.execute("SELECT * FROM users WHERE id=?", (auth["uid"],)).fetchone()
                can_write_report = auth["role"] in ("area-manager", "branch-manager") or bool(auth_user["is_lead"])
                if auth["role"] == "network-manager" or not can_write_report or not can_access_branch(conn, auth, report["branch_id"]):
                    json_response(self, 403, {"error": "forbidden"})
                    return
                conn.execute("DELETE FROM day_reports WHERE id=?", (report_id,))
                audit(conn, auth["uid"], f"מחק דוח {report['report_date']}", "report", report_id)
            json_response(self, 200, {"ok": True})
            return

        # Delete user
        if path.startswith("/api/users/"):
            uid = int(path.split("/")[-1])
            auth = require_auth(self, "network-manager", "area-manager", "branch-manager")
            if not auth: return
            if uid == auth["uid"]:
                json_response(self, 403, {"error": "cannot_delete_self"}); return
            with db() as conn:
                user = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
                if not user:
                    json_response(self, 404, {"error": "not_found"}); return
                if not can_manage_user(conn, auth, user, user["role"]):
                    json_response(self, 403, {"error": "role_hierarchy_forbidden"}); return
                if user["role"] == "network-manager":
                    count = conn.execute(
                        "SELECT COUNT(*) AS c FROM users WHERE role='network-manager' AND status='active' AND id != ?", (uid,)
                    ).fetchone()["c"]
                    if count == 0:
                        json_response(self, 409, {"error": "last_network_manager"}); return
                conn.execute("DELETE FROM users WHERE id=?", (uid,))
                audit(conn, auth["uid"], f"מחק עובד {user['full_name']}", "user", uid)
            json_response(self, 200, {"ok": True})
            return

        # Remove assignment
        if path.startswith("/api/assignments/"):
            aid = int(path.split("/")[-1])
            auth = require_auth(self, "network-manager", "area-manager", "branch-manager")
            if not auth: return
            with db() as conn:
                assignment = conn.execute("SELECT * FROM shift_assignments WHERE id=?", (aid,)).fetchone()
                if assignment:
                    conn.execute("""
                        UPDATE change_requests SET status='rejected'
                        WHERE shift_id=? AND requester_id=? AND type='reinforcement' AND status='approved'
                    """, (assignment["shift_id"], assignment["user_id"]))
                conn.execute("DELETE FROM shift_assignments WHERE id=?", (aid,))
                audit(conn, auth["uid"], "הסיר שיבוץ", "assignment", aid)
            json_response(self, 200, {"ok": True})
            return

        json_response(self, 404, {"error": "not_found"})


# ── Cleanup ───────────────────────────────────────────────────────────────────

WEEKS_RETENTION_DAYS      = int(os.environ.get("EZM_WEEKS_RETENTION_DAYS", "90"))
AUDIT_RETENTION_DAYS      = int(os.environ.get("EZM_AUDIT_RETENTION_DAYS",  "60"))
OTP_RETENTION_DAYS        = int(os.environ.get("EZM_OTP_RETENTION_DAYS",    "60"))
DAY_REPORTS_RETENTION_DAYS= int(os.environ.get("EZM_REPORTS_RETENTION_DAYS","90"))

def cleanup_old_data() -> None:
    now = int(time.time())
    with db() as conn:
        # weeks (by date string)
        week_cutoff = time.strftime("%Y-%m-%d", time.localtime(now - WEEKS_RETENTION_DAYS * 86400))
        w = conn.execute("DELETE FROM weeks WHERE week_start < ?", (week_cutoff,)).rowcount
        # audit_log (by unix timestamp)
        audit_cutoff = now - AUDIT_RETENTION_DAYS * 86400
        a = conn.execute("DELETE FROM audit_log WHERE created_at < ?", (audit_cutoff,)).rowcount
        # otp_codes (by unix timestamp)
        otp_cutoff = now - OTP_RETENTION_DAYS * 86400
        o = conn.execute("DELETE FROM otp_codes WHERE created_at < ?", (otp_cutoff,)).rowcount
        # day_reports (by date string)
        rep_cutoff = time.strftime("%Y-%m-%d", time.localtime(now - DAY_REPORTS_RETENTION_DAYS * 86400))
        r = conn.execute("DELETE FROM day_reports WHERE report_date < ?", (rep_cutoff,)).rowcount
    parts = []
    if w: parts.append(f"{w} weeks")
    if a: parts.append(f"{a} audit_log")
    if o: parts.append(f"{o} otp_codes")
    if r: parts.append(f"{r} day_reports")
    if parts:
        print(f"Cleanup: removed {', '.join(parts)}.")


# ── Main ──────────────────────────────────────────────────────────────────────

def scheduler_loop() -> None:
    last_run: set[str] = set()
    while True:
        try:
            now = datetime.now(APP_TZ)
            minute_key = now.strftime("%Y-%m-%d %H:%M")
            if minute_key not in last_run:
                with db() as conn:
                    settings = get_notification_settings(conn)
                current_time = now.strftime("%H:%M")
                reminder_due = settings["availabilityRemindersEnabled"] and any(
                    int(slot["day"]) == now.weekday() and slot["time"] == current_time
                    for slot in settings["availabilityReminderSlots"]
                )
                digest_due = settings["managerDigestEnabled"] and settings["managerDigestTime"] == current_time
                if reminder_due:
                    sent = send_availability_reminders(reminder_key=f"{now.weekday()}-{current_time}")
                    print(f"[scheduler] availability reminders sent: {sent}")
                    last_run.add(minute_key)
                if digest_due:
                    sent = send_manager_request_digest()
                    print(f"[scheduler] manager digests sent: {sent}")
                    last_run.add(minute_key)
                if len(last_run) > 500:
                    last_run = set(sorted(last_run)[-200:])
        except Exception as exc:
            print(f"[scheduler] error: {exc}")
        time.sleep(30)


def start_scheduler() -> None:
    global _scheduler_started
    if _scheduler_started or env_flag("EZM_DISABLE_SCHEDULER", "0"):
        return
    _scheduler_started = True
    threading.Thread(target=scheduler_loop, name="ezm-email-scheduler", daemon=True).start()


def main() -> None:
    init_db()
    cleanup_old_data()
    if "--send-availability-reminders" in sys.argv:
        sent = send_availability_reminders()
        print(f"Availability reminders sent: {sent}")
        return
    if "--send-manager-digest" in sys.argv:
        sent = send_manager_request_digest()
        print(f"Manager digests sent: {sent}")
        return
    preferred_port = int(os.environ.get("PORT", "5050"))
    candidate_ports = [preferred_port] + [p for p in range(5051, 5070) if p != preferred_port]
    server = None
    selected_port = None
    for port in candidate_ports:
        try:
            server = ThreadingHTTPServer(("0.0.0.0", port), EZMHandler)
            selected_port = port
            break
        except OSError:
            pass
    if not server:
        raise RuntimeError("Could not start EZM server")
    if selected_port != preferred_port:
        print(f"Port {preferred_port} unavailable, using {selected_port}.")
    start_scheduler()
    lan_ip = get_lan_ip()
    print(f"EZM v4 -> http://localhost:{selected_port}")
    print()
    print("* Serving EZM app 'server'")
    print("* Debug mode: off")
    print("* Running on all addresses (0.0.0.0)")
    print(f"* Running on http://127.0.0.1:{selected_port}")
    if lan_ip:
        print(f"* Running on http://{lan_ip}:{selected_port}")
    print("Press CTRL+C to quit")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        print(f"[EZM] Server error: {exc}. Restarting...")
        server.server_close()
        main()


def get_lan_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        try:
            host = socket.gethostbyname(socket.gethostname())
            return host if not host.startswith("127.") else None
        except OSError:
            return None


if __name__ == "__main__":
    main()
