const fs = require('fs');
const path = require('path');
const { USER_DIR } = require('./db');
const store = require('./fsstore');

const DIR_NAME = '.未归档';
const VROOT = '/未归档';
const META = 'meta.json';

function tempRoot(userId) {
  const root = path.join(USER_DIR, String(userId), DIR_NAME);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function timeStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeName(value, max) {
  return String(value || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, max || 40);
}

function saveBatch(user, targetPath, files, meta = {}) {
  const root = tempRoot(user.id);
  const department = safeName(user.department || meta.department || '未设置', 30);
  const date = safeName(meta.date || '', 10);
  const base = `${department}_${date}_${timeStamp()}`.replace(/_+$/, '');
  let dir = path.join(root, base);
  let i = 1;
  while (fs.existsSync(dir)) {
    dir = path.join(root, `${base}_${i}`);
    i += 1;
  }
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const f of files) {
    const name = path.basename(f.name || f.abs);
    let dest = path.join(dir, name);
    if (fs.existsSync(dest)) dest = store.uniqueAbsPath(dest);
    fs.renameSync(f.abs, dest);
    saved.push(path.basename(dest));
  }
  const batch = path.basename(dir);
  const info = {
    userId: user.id,
    username: user.username,
    department: user.department || '',
    date: meta.date || '',
    targetPath: targetPath || '',
    reason: meta.reason || '',
    createdAt: Date.now(),
    count: saved.length,
    files: saved,
  };
  fs.writeFileSync(path.join(dir, META), JSON.stringify(info, null, 1), 'utf8');
  return { batch, dir, count: saved.length, virtualPath: `${VROOT}/${user.id}/${batch}` };
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8'));
  } catch {
    return {};
  }
}

function listBatches(users) {
  const out = [];
  for (const u of users) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(USER_DIR, String(u.id), DIR_NAME), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(USER_DIR, String(u.id), DIR_NAME, entry.name);
      const meta = readMeta(dir);
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((n) => n !== META);
      } catch {
        continue;
      }
      let size = 0;
      for (const name of files) {
        try {
          size += fs.statSync(path.join(dir, name)).size;
        } catch {
          /* ignore */
        }
      }
      const label = [u.username, meta.department || '', meta.date || '', entry.name.slice(-6)]
        .filter(Boolean)
        .join(' · ');
      out.push({
        name: `${label}（${files.length} 张）`,
        isDir: true,
        path: `${VROOT}/${u.id}/${entry.name}`,
        size: 0,
        totalSize: size,
        mtime: meta.createdAt || 0,
        ownerId: u.id,
        ownerName: u.username,
        temp: true,
        count: files.length,
        batch: entry.name,
        department: meta.department || '',
        date: meta.date || '',
        reason: meta.reason || '',
        targetPath: meta.targetPath || '',
      });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function parseVirtual(vpath) {
  const normalized = store.normalizeVPath(vpath);
  if (normalized === VROOT) return { root: true, vpath: normalized };
  if (!normalized.startsWith(VROOT + '/')) return null;
  const parts = normalized.slice(VROOT.length + 1).split('/').filter(Boolean);
  const ownerId = Number(parts[0]);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return null;
  const batch = parts[1] || '';
  if (batch && (batch.startsWith('.') || batch.includes('..'))) return null;
  const sub = parts.slice(2).join('/');
  if (sub.split('/').some((s) => s === '..' || s.startsWith('.'))) return null;
  return { root: false, ownerId, batch, sub, vpath: normalized };
}

function physicalPath(parsed) {
  let p = '/' + DIR_NAME;
  if (parsed.batch) p += '/' + parsed.batch;
  if (parsed.sub) p += '/' + parsed.sub;
  return p;
}

function listEntries(ownerId, ownerName, parsed) {
  const result = store.listDir(ownerId, physicalPath(parsed));
  const base = `${VROOT}/${ownerId}/${parsed.batch}`;
  result.entries = result.entries
    .filter((e) => e.name !== META)
    .map((e) => ({
      ...e,
      path: base + e.path.slice(physicalPath(parsed).length),
      ownerId,
      ownerName,
      temp: true,
    }));
  return result.entries;
}

function cleanupBatch(ownerId, batch) {
  if (!batch) return;
  const dir = path.join(USER_DIR, String(ownerId), DIR_NAME, batch);
  try {
    const files = fs.readdirSync(dir).filter((n) => n !== META);
    if (files.length) return;
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function countPending() {
  let total = 0;
  let batches = 0;
  try {
    for (const id of fs.readdirSync(USER_DIR)) {
      const root = path.join(USER_DIR, id, DIR_NAME);
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        batches += 1;
        try {
          total += fs.readdirSync(path.join(root, entry.name)).filter((n) => n !== META).length;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { total, batches };
}

module.exports = {
  DIR_NAME,
  VROOT,
  META,
  saveBatch,
  listBatches,
  parseVirtual,
  physicalPath,
  listEntries,
  cleanupBatch,
  countPending,
  tempRoot,
};