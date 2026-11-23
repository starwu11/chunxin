const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const store = require('./fsstore');
const autoFolders = require('./auto-folders');

function getUserAccess(userId) {
  const u = db.prepare('SELECT role, folder_access FROM users WHERE id = ?').get(userId);
  if (!u) return { mode: 'custom', folders: [] };
  if (u.role === 'admin') return { mode: 'all', folders: [] };
  if (u.folder_access !== 'custom') return { mode: 'all', folders: [] };
  const folders = db
    .prepare('SELECT folder FROM folder_grants WHERE user_id = ?')
    .all(userId)
    .map((r) => r.folder);
  return { mode: 'custom', folders };
}

function isAdmin(userId) {
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  return !!(u && u.role === 'admin');
}

function latestMaterialDate(userId) {
  const dir = path.join(store.userRoot(userId), autoFolders.MATERIAL_FOLDER);
  try {
    const dates = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    return dates[dates.length - 1] || '';
  } catch {
    return '';
  }
}

function topFolder(vpath) {
  const normalized = store.normalizeVPath(vpath);
  const parts = normalized.split('/').filter(Boolean);
  return parts.length ? parts[0] : null;
}

function isFolderAtRoot(userId, name) {
  try {
    const { abs, vpath } = store.resolvePath(userId, '/' + name);
    if (vpath !== '/' + name) return false;
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function canAccess(userId, vpath) {
  const normalized = store.normalizeVPath(vpath);
  const parts = normalized.split('/').filter(Boolean);
  const top = parts[0] || null;

  if ((parts.includes('.未归档') || top === '未归档') && !isAdmin(userId)) return false;

  const access = getUserAccess(userId);
  if (access.mode === 'all') return true;
  if (!top) return true;
  if (top === autoFolders.MATERIAL_FOLDER) return true;
  return access.folders.includes(top);
}

function filterEntries(userId, entries, vpath) {
  const normalized = store.normalizeVPath(vpath);
  let list = entries;

  if (normalized === '/' + autoFolders.MATERIAL_FOLDER && !isAdmin(userId)) {
    const dirs = list.filter((e) => e.isDir).map((e) => e.name).sort();
    const latest = dirs[dirs.length - 1];
    list = list.filter((e) => !e.isDir || e.name === latest);
  }

  const access = getUserAccess(userId);
  if (access.mode === 'all') return list;
  if (normalized !== '/') return list;
  return list.filter(
    (e) => !e.isDir || e.name === autoFolders.MATERIAL_FOLDER || access.folders.includes(e.name)
  );
}

function filterRecent(userId, entries) {
  const access = getUserAccess(userId);
  const admin = isAdmin(userId);
  const latest = admin ? '' : latestMaterialDate(userId);
  return entries.filter((e) => {
    const parts = e.path.split('/').filter(Boolean);
    if (parts[0] === autoFolders.MATERIAL_FOLDER && parts.length >= 2 && !admin && parts[1] !== latest) {
      return false;
    }
    if (access.mode === 'all') return true;
    const top = parts[0];
    return (
      !top ||
      top === autoFolders.MATERIAL_FOLDER ||
      access.folders.includes(top)
    );
  });
}

function setUserAccess(userId, mode, folders) {
  const normalizedMode = mode === 'custom' ? 'custom' : 'all';
  db.prepare('UPDATE users SET folder_access = ? WHERE id = ?').run(normalizedMode, userId);
  db.prepare('DELETE FROM folder_grants WHERE user_id = ?').run(userId);
  if (normalizedMode === 'custom') {
    const unique = Array.from(new Set((folders || []).map((f) => String(f).trim()).filter(Boolean)));
    for (const name of unique) {
      db.prepare('INSERT OR IGNORE INTO folder_grants (user_id, folder) VALUES (?, ?)').run(userId, name);
    }
  }
  return getUserAccess(userId);
}

module.exports = {
  getUserAccess,
  canAccess,
  filterEntries,
  filterRecent,
  setUserAccess,
  topFolder,
  isAdmin,
  latestMaterialDate,
};