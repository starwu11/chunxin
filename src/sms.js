const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');

const CODE_TTL = 5 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const DAILY_LIMIT = 10;
const IP_LIMIT = 20;
const PROVIDER = process.env.SMS_PROVIDER || 'debug';

const SECRET_FILE = path.join(DATA_DIR, 'secret');
let SECRET = '';
try {
  SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} catch {
  /* ignore */
}
if (!SECRET) SECRET = 'clouddisk-sms';

function normalizePhone(input) {
  return String(input || '').replace(/[\s-]/g, '');
}

function validatePhone(phone) {
  return /^1[3-9]\d{9}$/.test(phone) ? null : '请输入正确的 11 位手机号';
}

function maskPhone(phone) {
  const p = String(phone || '');
  return p.length === 11 ? `${p.slice(0, 3)}****${p.slice(7)}` : p;
}

function hashCode(phone, purpose, code) {
  return crypto.createHash('sha256').update(`${phone}:${purpose}:${code}:${SECRET}`).digest('hex');
}

async function sendSms(phone, code, purpose) {
  if (PROVIDER === 'debug') {
    const label = { login: '验证码登录', reset: '找回密码', bind: '绑定手机号' }[purpose] || purpose;
    console.log(`[sms] ${label}验证码 ${code} 手机号 ${maskPhone(phone)} 有效期 5 分钟`);
    return { debug: true };
  }
  const err = new Error('短信服务未配置，请联系管理员');
  err.status = 503;
  throw err;
}

async function sendCode(inputPhone, purpose, ip) {
  const phone = normalizePhone(inputPhone);
  const invalid = validatePhone(phone);
  if (invalid) {
    const err = new Error(invalid);
    err.status = 400;
    throw err;
  }
  const now = Date.now();
  const last = db
    .prepare('SELECT created_at FROM sms_codes WHERE phone = ? AND purpose = ? ORDER BY id DESC LIMIT 1')
    .get(phone, purpose);
  if (last && now - last.created_at < RESEND_MS) {
    const err = new Error(`请 ${Math.ceil((RESEND_MS - (now - last.created_at)) / 1000)} 秒后再获取验证码`);
    err.status = 429;
    throw err;
  }
  const today = db
    .prepare('SELECT COUNT(*) AS c FROM sms_codes WHERE phone = ? AND created_at >= ?')
    .get(phone, now - 24 * 3600 * 1000).c;
  if (today >= DAILY_LIMIT) {
    const err = new Error('该手机号今日获取验证码次数已达上限');
    err.status = 429;
    throw err;
  }
  if (ip) {
    const fromIp = db
      .prepare('SELECT COUNT(*) AS c FROM sms_codes WHERE ip = ? AND created_at >= ?')
      .get(ip, now - 3600 * 1000).c;
    if (fromIp >= IP_LIMIT) {
      const err = new Error('当前网络获取验证码过于频繁，请稍后再试');
      err.status = 429;
      throw err;
    }
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare('DELETE FROM sms_codes WHERE phone = ? AND purpose = ?').run(phone, purpose);
  db.prepare(
    'INSERT INTO sms_codes (phone, purpose, code_hash, expires_at, attempts, created_at, ip) VALUES (?, ?, ?, ?, 0, ?, ?)'
  ).run(phone, purpose, hashCode(phone, purpose, code), now + CODE_TTL, now, String(ip || ''));
  const result = await sendSms(phone, code, purpose);
  return {
    ok: true,
    phone: maskPhone(phone),
    ttl: Math.round(CODE_TTL / 1000),
    resendAfter: Math.round(RESEND_MS / 1000),
    debug: !!result.debug,
  };
}

function verifyCode(inputPhone, purpose, inputCode) {
  const phone = normalizePhone(inputPhone);
  const code = String(inputCode || '').trim();
  const row = db
    .prepare('SELECT * FROM sms_codes WHERE phone = ? AND purpose = ? ORDER BY id DESC LIMIT 1')
    .get(phone, purpose);
  if (!row) return { ok: false, reason: '请先获取验证码' };
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sms_codes WHERE id = ?').run(row.id);
    return { ok: false, reason: '验证码已过期，请重新获取' };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    db.prepare('DELETE FROM sms_codes WHERE id = ?').run(row.id);
    return { ok: false, reason: '验证码尝试次数过多，请重新获取' };
  }
  if (hashCode(phone, purpose, code) !== row.code_hash) {
    db.prepare('UPDATE sms_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { ok: false, reason: '验证码错误' };
  }
  db.prepare('DELETE FROM sms_codes WHERE phone = ? AND purpose = ?').run(phone, purpose);
  return { ok: true };
}

function cleanup() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const info = db.prepare('DELETE FROM sms_codes WHERE expires_at < ?').run(cutoff);
  const removed = Number(info.changes || 0);
  if (removed) console.log(`[sms] 已清理 ${removed} 条过期验证码`);
  return removed;
}

module.exports = {
  CODE_TTL,
  RESEND_MS,
  MAX_ATTEMPTS,
  PROVIDER,
  normalizePhone,
  validatePhone,
  maskPhone,
  sendCode,
  verifyCode,
  cleanup,
};