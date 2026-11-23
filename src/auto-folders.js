const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const store = require('./fsstore');

const FOLDERS = (process.env.STORE_FOLDERS || '江宁店,大明路店,金城店,仙林圣景旗舰店')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TIMEZONE = process.env.FOLDER_TIMEZONE || 'Asia/Shanghai';
const MATERIAL_FOLDER = (process.env.MATERIAL_FOLDER || '朋友圈素材').trim();

let lastDate = '';
let timer = null;

function todayName() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function ensureForUser(userId) {
  const date = todayName();
  const root = store.userRoot(userId);
  for (const name of FOLDERS) {
    if (!store.cleanName(name)) continue;
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, date), { recursive: true });
  }
  return date;
}

function ensureAll() {
  const date = todayName();
  const users = db.prepare("SELECT id FROM users WHERE status = 'active'").all();
  for (const u of users) {
    try {
      ensureForUser(u.id);
    } catch (err) {
      console.error('[auto-folders]', u.id, err.message);
    }
  }
  lastDate = date;
  return date;
}

function start() {
  if (!FOLDERS.length) return;
  ensureAll();
  timer = setInterval(() => {
    try {
      const date = todayName();
      if (date !== lastDate) {
        ensureAll();
        console.log(`[auto-folders] 日期变更，已创建当天文件夹: ${date}`);
      }
    } catch (err) {
      console.error('[auto-folders]', err.message);
    }
  }, 60 * 1000);
  if (timer.unref) timer.unref();
  console.log(`[auto-folders] 门店目录: ${FOLDERS.join('、')} · 当日文件夹: ${lastDate}`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, ensureAll, ensureForUser, todayName, FOLDERS, MATERIAL_FOLDER };