// 文件夹备注：按规范化虚拟路径共享，记录最后编辑者与更新时间。
// 仅用于「小红书笔记归档」内的子文件夹（范围校验在调用方/前端）。
const { db } = require('./db');

const MAX_NOTE = 2000;

function normalize(vpath) {
  return String(vpath || '').replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

// 批量取一批路径的备注，返回 { [path]: { note, updatedBy, updatedAt } }
function list(paths) {
  const out = {};
  if (!Array.isArray(paths) || !paths.length) return out;
  const uniq = [...new Set(paths.map(normalize))];
  // SQLite 变量上限通常 999，分批查询
  for (let i = 0; i < uniq.length; i += 500) {
    const chunk = uniq.slice(i, i + 500);
    const holes = chunk.map(() => '?').join(',');
    const rows = db.prepare(`SELECT path, note, updated_by, updated_at FROM folder_notes WHERE path IN (${holes})`).all(...chunk);
    for (const r of rows) {
      out[r.path] = { note: r.note, updatedBy: r.updated_by, updatedAt: r.updated_at };
    }
  }
  return out;
}

// 取单个路径的备注（不存在返回空对象）
function get(vpath) {
  const p = normalize(vpath);
  const row = db.prepare('SELECT note, updated_by, updated_at FROM folder_notes WHERE path = ?').get(p);
  return row ? { note: row.note, updatedBy: row.updated_by, updatedAt: row.updated_at } : { note: '', updatedBy: null, updatedAt: null };
}

// 保存备注（note 为空则删除该条记录），返回保存后的备注
function set(vpath, note, userId) {
  const p = normalize(vpath);
  const text = String(note == null ? '' : note).trim().slice(0, MAX_NOTE);
  if (!text) {
    db.prepare('DELETE FROM folder_notes WHERE path = ?').run(p);
    return { note: '', updatedBy: null, updatedAt: null };
  }
  const now = Date.now();
  db.prepare(`
    INSERT INTO folder_notes (path, note, updated_by, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(p, text, userId == null ? null : userId, now);
  return { note: text, updatedBy: userId == null ? null : userId, updatedAt: now };
}

// 删除某个路径及其子路径下的所有备注（文件夹被删除/移动时调用）
function removeTree(vpath) {
  const p = normalize(vpath);
  if (p === '/') return db.prepare('DELETE FROM folder_notes').run().changes;
  db.prepare('DELETE FROM folder_notes WHERE path = ? OR path LIKE ?').run(p, p + '/%');
}

// 文件夹被重命名/移动时，把旧路径前缀迁移到新路径
function moveTree(fromV, toV) {
  const from = normalize(fromV);
  const to = normalize(toV);
  if (from === '/' || from === to) return 0;
  const rows = db.prepare('SELECT path, note, updated_by, updated_at FROM folder_notes WHERE path = ? OR path LIKE ?').all(from, from + '/%');
  if (!rows.length) return 0;
  const tx = db.prepare('INSERT INTO folder_notes (path, note, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET note=excluded.note, updated_by=excluded.updated_by, updated_at=excluded.updated_at');
  const del = db.prepare('DELETE FROM folder_notes WHERE path = ?');
  let n = 0;
  // 先删目标同名路径避免冲突，再写新路径
  for (const r of rows) {
    const suffix = r.path.slice(from.length);
    const newPath = to + suffix;
    del.run(newPath);
    tx.run(newPath, r.note, r.updated_by, r.updated_at);
    del.run(r.path);
    n += 1;
  }
  return n;
}

module.exports = { list, get, set, removeTree, moveTree, MAX_NOTE };
