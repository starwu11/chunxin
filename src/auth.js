const crypto = require('crypto');
const { db } = require('./db');

const SESSION_TTL_DAYS = Math.max(1, Number(process.env.SESSION_TTL_DAYS) || 30);
const SESSION_TTL = SESSION_TTL_DAYS * 24 * 3600 * 1000;
const MAX_USERNAME = 32;
const MIN_PASSWORD = 6;

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, s, 64).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, hash) {
  const test = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (test.length !== expected.length) return false;
  return crypto.timingSafeEqual(test, expected);
}

function validateUsername(username) {
  if (!username || !/^[a-zA-Z0-9_\u4e00-\u9fa5.-]{2,32}$/.test(username)) {
    return '用户名需为 2-32 位字母、数字、中文、下划线或点';
  }
  return null;
}

function validateCredentials(username, password) {
  const nameError = validateUsername(username);
  if (nameError) return nameError;
  if (!password || password.length < MIN_PASSWORD || password.length > 128) {
    return `密码长度需为 ${MIN_PASSWORD}-128 位`;
  }
  return null;
}

function createUser(username, password, department, phone) {
  const { salt, hash } = hashPassword(password);
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const isFirst = count === 0;
  const role = isFirst ? 'admin' : 'user';
  const status = isFirst ? 'active' : 'pending';
  const info = db
    .prepare(
      'INSERT INTO users (username, pass_hash, salt, created_at, role, status, department, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(username, hash, salt, Date.now(), role, status, department || '', phone || '');
  return Number(info.lastInsertRowid);
}

const DEPARTMENTS = ['江宁店', '大明路店', '金城店', '仙林圣景旗舰店'];

function validateDepartment(department) {
  if (!department || !DEPARTMENTS.includes(department)) {
    return `请选择部门（${DEPARTMENTS.join(' / ')}）`;
  }
  return null;
}

function findUserByName(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function findUserByPhone(phone) {
  return db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
}

function findUserById(id) {
  return db
    .prepare(
      'SELECT id, username, quota, created_at, last_login, role, status, department, phone FROM users WHERE id = ?'
    )
    .get(id);
}

function updatePassword(userId, password) {
  const { salt, hash } = hashPassword(password);
  db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hash, salt, userId);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, now + SESSION_TTL);
  return { token, expiresAt: now + SESSION_TTL };
}

function userBySession(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.quota, u.created_at, u.role, u.status, u.department, u.phone, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at < Date.now() || row.status !== 'active') {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    quota: row.quota,
    createdAt: row.created_at,
    role: row.role,
    status: row.status,
    department: row.department || '',
    phone: row.phone || '',
  };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function verifyBasicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  const username = decoded.slice(0, idx);
  const password = decoded.slice(idx + 1);
  const user = findUserByName(username);
  if (!user) return null;
  if (user.status !== 'active') return null;
  if (!verifyPassword(password, user.salt, user.pass_hash)) return null;
  return {
    id: user.id,
    username: user.username,
    quota: user.quota,
    role: user.role,
    status: user.status,
    department: user.department || '',
  };
}

function sessionTtlSeconds() {
  return Math.round(SESSION_TTL / 1000);
}

module.exports = {
  hashPassword,
  verifyPassword,
  validateCredentials,
  validateUsername,
  validateDepartment,
  DEPARTMENTS,
  createUser,
  findUserByName,
  findUserByPhone,
  findUserById,
  updatePassword,
  createSession,
  userBySession,
  destroySession,
  parseCookies,
  verifyBasicAuth,
  sessionTtlSeconds,
  SESSION_TTL,
  MAX_USERNAME,
};