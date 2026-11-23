const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');
const store = require('./fsstore');

const TRASH_DIR = path.join(DATA_DIR, 'trash');
const KEEP_DAYS = Number(process.env.TRASH_KEEP_DAYS || 7);
const DAY_MS = 24 * 3600 * 1000;

fs.mkdirSync(TRASH_DIR, { recursive: true });

function scan(abs) {
  const st = fs.statSync(abs);
  if (!st.isDirectory()) return { size: st.size, files: 1 };
  let size = 0;
  let files = 0;
  const walk = (dir) => {
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) walk(p);
      else if (it.isFile()) {
        try {
          size += fs.statSync(p).size;
          files += 1;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(abs);
  return { size, files };
}

function uniqueAbs(abs) {
  if (!fs.existsSync(abs)) return abs;
  const dir = path.dirname(abs);
  const ext = path.extname(abs);
  const base = path.basename(abs, ext);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function itemDir(id) {
  return path.join(TRASH_DIR, String(id));
}

function payloadOf(id) {
  return path.join(itemDir(id), 'payload');
}

function add(owner, vpath, actor) {
  const { abs, vpath: normalized } = store.resolvePath(owner.id, vpath);
  if (normalized === '/') {
    const err = new Error('不能删除根目录');
    err.status = 400;
    throw err;
  }
  if (!fs.existsSync(abs)) {
    const err = new Error('文件不存在');
    err.status = 404;
    throw err;
  }
  const st = fs.statSync(abs);
  const { size, files } = scan(abs);
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO trash
        (owner_id, owner_name, path, name, is_dir, size, files, deleted_by_id, deleted_by_name, deleted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      owner.id,
      owner.username,
      normalized,
      store.baseName(normalized),
      st.isDirectory() ? 1 : 0,
      size,
      files,
      actor ? actor.id : owner.id,
      actor ? actor.username : owner.username,
      now,
      now + KEEP_DAYS * DAY_MS
    );
  const id = Number(info.lastInsertRowid);
  const dir = itemDir(id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.renameSync(abs, payloadOf(id));
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    db.prepare('DELETE FROM trash WHERE id = ?').run(id);
    const wrapped = new Error('删除失败：' + (err.message || '未知错误'));
    wrapped.status = 500;
    throw wrapped;
  }
  // 文件已移出账号目录（进回收站暂存区），配额立即释放
  store.adjustUsage(owner.id, -size);
  return {
    id,
    ownerId: owner.id,
    ownerName: owner.username,
    path: normalized,
    name: store.baseName(normalized),
    isDir: st.isDirectory(),
    size,
    files,
    deletedBy: actor ? actor.username : owner.username,
    deletedAt: now,
    expiresAt: now + KEEP_DAYS * DAY_MS,
  };
}

function rowToItem(row) {
  const now = Date.now();
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    path: row.path,
    name: row.name,
    isDir: !!row.is_dir,
    size: row.size,
    files: row.files,
    deletedBy: row.deleted_by_name || row.owner_name,
    deletedAt: row.deleted_at,
    expiresAt: row.expires_at,
    daysLeft: Math.max(0, Math.ceil((row.expires_at - now) / DAY_MS)),
  };
}

function listFor(user, opts = {}) {
  const isAdmin = user.role === 'admin';
  const where = [];
  const params = [];
  if (!isAdmin) {
    where.push('owner_id = ?');
    params.push(user.id);
  } else if (opts.ownerId) {
    where.push('owner_id = ?');
    params.push(Number(opts.ownerId));
  }
  let sql = 'SELECT * FROM trash';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY deleted_at DESC LIMIT 1000';
  const items = db.prepare(sql).all(...params).map(rowToItem);
  let owners = [];
  if (isAdmin) {
    owners = db
      .prepare('SELECT DISTINCT owner_id AS id, owner_name AS username FROM trash ORDER BY owner_name')
      .all();
  }
  return { items, keepDays: KEEP_DAYS, isAdmin, owners };
}

function canOperate(user, row) {
  return user.role === 'admin' || row.owner_id === user.id;
}

function restore(user, id) {
  const row = db.prepare('SELECT * FROM trash WHERE id = ?').get(Number(id));
  if (!row) {
    const err = new Error('回收站条目不存在');
    err.status = 404;
    throw err;
  }
  if (!canOperate(user, row)) {
    const err = new Error('无权恢复该文件');
    err.status = 403;
    throw err;
  }
  const payload = payloadOf(row.id);
  if (!fs.existsSync(payload)) {
    db.prepare('DELETE FROM trash WHERE id = ?').run(row.id);
    fs.rmSync(itemDir(row.id), { recursive: true, force: true });
    const err = new Error('文件数据已失效，无法恢复');
    err.status = 404;
    throw err;
  }
  const { abs, root } = store.resolvePath(row.owner_id, row.path);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const target = uniqueAbs(abs);
  const restoredSize = store.statSize(payload);
  fs.renameSync(payload, target);
  const rel = path.relative(root, target).split(path.sep).join('/');
  const nextPath = '/' + rel;
  db.prepare('DELETE FROM trash WHERE id = ?').run(row.id);
  fs.rmSync(itemDir(row.id), { recursive: true, force: true });
  // 从回收站还原回账号目录，用量重新计入
  store.adjustUsage(row.owner_id, restoredSize);
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    path: nextPath,
    name: path.basename(target),
    isDir: !!row.is_dir,
  };
}

function purge(user, id) {
  const row = db.prepare('SELECT * FROM trash WHERE id = ?').get(Number(id));
  if (!row) {
    const err = new Error('回收站条目不存在');
    err.status = 404;
    throw err;
  }
  if (!canOperate(user, row)) {
    const err = new Error('无权删除该文件');
    err.status = 403;
    throw err;
  }
  fs.rmSync(itemDir(row.id), { recursive: true, force: true });
  db.prepare('DELETE FROM trash WHERE id = ?').run(row.id);
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    path: row.path,
    name: row.name,
    isDir: !!row.is_dir,
  };
}

function cleanup() {
  const now = Date.now();
  const rows = db.prepare('SELECT id FROM trash WHERE expires_at <= ?').all(now);
  let removed = 0;
  for (const row of rows) {
    fs.rmSync(itemDir(row.id), { recursive: true, force: true });
    db.prepare('DELETE FROM trash WHERE id = ?').run(row.id);
    removed += 1;
  }
  if (removed) console.log(`[trash] 已清理 ${removed} 个过期条目`);
  return removed;
}

module.exports = {
  TRASH_DIR,
  KEEP_DAYS,
  add,
  listFor,
  restore,
  purge,
  cleanup,
};