const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const USER_DIR = path.join(DATA_DIR, 'users');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

fs.mkdirSync(USER_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'clouddisk.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE,
  pass_hash  TEXT NOT NULL,
  salt       TEXT NOT NULL,
  quota      INTEGER NOT NULL DEFAULT 5368709120,
  created_at INTEGER NOT NULL,
  last_login INTEGER,
  role       TEXT NOT NULL DEFAULT 'user',
  status     TEXT NOT NULL DEFAULT 'active',
  department TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  name       TEXT NOT NULL,
  is_dir     INTEGER NOT NULL DEFAULT 0,
  password   TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  downloads  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);

CREATE TABLE IF NOT EXISTS folder_grants (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder  TEXT NOT NULL,
  PRIMARY KEY (user_id, folder)
);

CREATE TABLE IF NOT EXISTS upload_batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username    TEXT NOT NULL,
  department  TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  image_count INTEGER NOT NULL DEFAULT 0,
  vin         TEXT NOT NULL DEFAULT '',
  car_name    TEXT NOT NULL DEFAULT '',
  service_type TEXT NOT NULL DEFAULT '',
  copy_path   TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_batches_date ON upload_batches(date);
CREATE INDEX IF NOT EXISTS idx_batches_user ON upload_batches(user_id);

CREATE TABLE IF NOT EXISTS vin_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  username   TEXT NOT NULL,
  date       TEXT NOT NULL,
  success    INTEGER NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vin_date ON vin_attempts(date);
CREATE INDEX IF NOT EXISTS idx_vin_user ON vin_attempts(user_id);

CREATE TABLE IF NOT EXISTS trash (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id        INTEGER NOT NULL,
  owner_name      TEXT NOT NULL,
  path            TEXT NOT NULL,
  name            TEXT NOT NULL,
  is_dir          INTEGER NOT NULL DEFAULT 0,
  size            INTEGER NOT NULL DEFAULT 0,
  files           INTEGER NOT NULL DEFAULT 0,
  deleted_by_id   INTEGER,
  deleted_by_name TEXT NOT NULL DEFAULT '',
  deleted_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trash_owner ON trash(owner_id);
CREATE INDEX IF NOT EXISTS idx_trash_expires ON trash(expires_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  username   TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(username);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

CREATE TABLE IF NOT EXISTS sms_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ip         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sms_phone ON sms_codes(phone, purpose, created_at);
CREATE INDEX IF NOT EXISTS idx_sms_ip ON sms_codes(ip, created_at);

CREATE TABLE IF NOT EXISTS vin_cache (
  vin        TEXT PRIMARY KEY,
  brand      TEXT NOT NULL DEFAULT '',
  series     TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  car_name   TEXT NOT NULL DEFAULT '',
  year       TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  raw        TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vin_cache_time ON vin_cache(created_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS folder_notes (
  path        TEXT PRIMARY KEY,
  note        TEXT NOT NULL DEFAULT '',
  updated_by  INTEGER,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS downloads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  total_bytes     INTEGER NOT NULL DEFAULT 0,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'downloading',
  speed           REAL NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'web',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_downloads_user ON downloads(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
`);

db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
db.prepare('DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now());

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
ensureColumn('users', 'role', "TEXT NOT NULL DEFAULT 'user'");
ensureColumn('users', 'status', "TEXT NOT NULL DEFAULT 'active'");
ensureColumn('users', 'folder_access', "TEXT NOT NULL DEFAULT 'all'");
ensureColumn('users', 'department', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'phone', "TEXT NOT NULL DEFAULT ''");
ensureColumn('upload_batches', 'car_name', "TEXT NOT NULL DEFAULT ''");
ensureColumn('upload_batches', 'vin', "TEXT NOT NULL DEFAULT ''");
ensureColumn('upload_batches', 'copy_path', "TEXT NOT NULL DEFAULT ''");
ensureColumn('upload_batches', 'service_type', "TEXT NOT NULL DEFAULT ''");

db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone <> ''");
db.prepare('DELETE FROM sms_codes WHERE expires_at < ?').run(Date.now());

const hasAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
if (!hasAdmin) {
  const first = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  if (first) {
    db.prepare("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?").run(first.id);
  }
}

module.exports = { db, DATA_DIR, USER_DIR, TMP_DIR };