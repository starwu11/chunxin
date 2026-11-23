const fs = require('fs');
const path = require('path');
const { USER_DIR } = require('./db');

const MAX_NAME = 200;
// 单个文件上限，Web / API / WebDAV 三条上传通道共用
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  avif: 'image/avif', heic: 'image/heic',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', m4v: 'video/mp4', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
  ogg: 'audio/ogg', m4a: 'audio/mp4',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8', xml: 'application/xml; charset=utf-8',
  csv: 'text/csv; charset=utf-8', log: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip',
};

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function mimeOf(name) {
  return MIME[extOf(name)] || 'application/octet-stream';
}

function isPreviewable(name) {
  const m = mimeOf(name);
  return /^(image|video|audio)\//.test(m) || m === 'application/pdf' || m.startsWith('text/');
}

function userRoot(userId) {
  const root = path.join(USER_DIR, String(userId));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function normalizeVPath(input) {
  let raw = String(input == null ? '/' : input).replace(/\\/g, '/');
  if (!raw.startsWith('/')) raw = '/' + raw;
  const segments = raw.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.')) {
    const err = new Error('非法路径');
    err.status = 400;
    throw err;
  }
  for (const s of segments) {
    if (s.includes('\0')) {
      const err = new Error('非法路径');
      err.status = 400;
      throw err;
    }
  }
  return '/' + segments.join('/');
}

function resolvePath(userId, vpath) {
  const normalized = normalizeVPath(vpath);
  const root = userRoot(userId);
  const abs = path.resolve(root, '.' + normalized);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    const err = new Error('非法路径');
    err.status = 403;
    throw err;
  }
  return { abs, vpath: normalized, root };
}

function cleanName(name) {
  const n = String(name || '').replace(/[\0/\\]/g, '').trim();
  if (!n || n === '.' || n === '..') return null;
  return n.length > MAX_NAME ? n.slice(0, MAX_NAME) : n;
}

function joinVPath(dir, name) {
  const d = normalizeVPath(dir);
  return d === '/' ? '/' + name : d + '/' + name;
}

function parentOf(vpath) {
  const p = normalizeVPath(vpath);
  if (p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

function baseName(vpath) {
  const p = normalizeVPath(vpath);
  return p === '/' ? '' : p.slice(p.lastIndexOf('/') + 1);
}

function exists(userId, vpath) {
  try {
    fs.statSync(resolvePath(userId, vpath).abs);
    return true;
  } catch {
    return false;
  }
}

function entryOf(abs, vpath, name) {
  const st = fs.statSync(abs);
  return {
    name,
    path: vpath,
    isDir: st.isDirectory(),
    size: st.isDirectory() ? 0 : st.size,
    mtime: st.mtimeMs,
    mime: st.isDirectory() ? 'folder' : mimeOf(name),
    previewable: !st.isDirectory() && isPreviewable(name),
  };
}

function listDir(userId, vpath) {
  const { abs, vpath: normalized } = resolvePath(userId, vpath);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    const err = new Error('目录不存在');
    err.status = 404;
    throw err;
  }
  if (!st.isDirectory()) {
    const err = new Error('不是目录');
    err.status = 400;
    throw err;
  }
  const entries = fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((d) => !d.name.startsWith('.'))
    .map((d) => {
      try {
        const childV = joinVPath(normalized, d.name);
        return entryOf(path.join(abs, d.name), childV, d.name);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh') : a.isDir ? -1 : 1));
  return { path: normalized, entries };
}

function parseOwnerPath(vpath) {
  const normalized = normalizeVPath(vpath);
  const match = /^\/@(\d+)(\/.*|$)/.exec(normalized);
  if (!match) return { ownerId: null, path: normalized };
  return { ownerId: Number(match[1]), path: match[2] || '/' };
}

function dirSize(userId, vpath) {
  let abs;
  try {
    abs = resolvePath(userId, vpath).abs;
  } catch {
    return 0;
  }
  let total = 0;
  const walk = (dir) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.name.startsWith('.')) continue;
      const p = path.join(dir, it.name);
      if (it.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(abs);
  return total;
}

// 统计任意绝对路径（文件或目录）占用的字节数
function statSize(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return st.size;
  } catch {
    return 0;
  }
  let total = 0;
  const walk = (dir) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(abs);
  return total;
}

function listMerged(users, vpath) {
  const normalized = normalizeVPath(vpath);
  const folders = new Map();
  const files = new Map();
  for (const u of users) {
    let result;
    try {
      result = listDir(u.id, normalized);
    } catch {
      continue;
    }
    for (const entry of result.entries) {
      if (entry.isDir) {
        if (!folders.has(entry.name)) {
          folders.set(entry.name, { ...entry, path: joinVPath(normalized, entry.name) });
        }
      } else {
        const full = '/@' + u.id + entry.path;
        files.set(full, {
          ...entry,
          path: full,
          ownerId: u.id,
          ownerName: u.username,
        });
      }
    }
  }
  return [...folders.values(), ...files.values()];
}

function uniqueAbsPath(abs) {
  if (!fs.existsSync(abs)) return abs;
  const dir = path.dirname(abs);
  const ext = path.extname(abs);
  const stem = path.basename(abs, ext);
  for (let i = 1; i < 10000; i++) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

function mkdir(userId, parentV, name) {
  const clean = cleanName(name);
  if (!clean) {
    const err = new Error('文件夹名称无效');
    err.status = 400;
    throw err;
  }
  const { abs, vpath } = resolvePath(userId, joinVPath(parentV, clean));
  if (fs.existsSync(abs)) {
    const err = new Error('同名文件或文件夹已存在');
    err.status = 409;
    throw err;
  }
  fs.mkdirSync(abs, { recursive: false });
  return entryOf(abs, vpath, clean);
}

function remove(userId, vpath) {
  const { abs, vpath: normalized } = resolvePath(userId, vpath);
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
  const freed = sizeOfPath(userId, normalized);
  fs.rmSync(abs, { recursive: true, force: true });
  adjustUsage(userId, -freed);
}

function rename(userId, vpath, newName) {
  const clean = cleanName(newName);
  if (!clean) {
    const err = new Error('名称无效');
    err.status = 400;
    throw err;
  }
  const { abs, vpath: normalized } = resolvePath(userId, vpath);
  if (normalized === '/') {
    const err = new Error('不能重命名根目录');
    err.status = 400;
    throw err;
  }
  const target = path.join(path.dirname(abs), clean);
  if (fs.existsSync(target)) {
    const err = new Error('同名文件或文件夹已存在');
    err.status = 409;
    throw err;
  }
  fs.renameSync(abs, target);
  return parentOf(normalized) + (parentOf(normalized) === '/' ? '' : '/') + clean;
}

function move(userId, fromV, toDirV) {
  const from = resolvePath(userId, fromV);
  const toDir = resolvePath(userId, toDirV);
  if (from.vpath === '/') {
    const err = new Error('不能移动根目录');
    err.status = 400;
    throw err;
  }
  if (toDir.vpath === from.vpath || toDir.vpath.startsWith(from.vpath + '/')) {
    const err = new Error('不能移动到自身或其子目录');
    err.status = 400;
    throw err;
  }
  if (!fs.existsSync(from.abs)) {
    const err = new Error('文件不存在');
    err.status = 404;
    throw err;
  }
  if (!fs.statSync(toDir.abs).isDirectory()) {
    const err = new Error('目标不是目录');
    err.status = 400;
    throw err;
  }
  const target = uniqueAbsPath(path.join(toDir.abs, path.basename(from.abs)));
  fs.renameSync(from.abs, target);
  return joinVPath(toDir.vpath, path.basename(target));
}

function copyTree(src, dst) {
  fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false });
}

// 跨账号复制：源与目标可以分属不同账号（管理员归档他人文件时需要）。
// 同一账号内复制时，额外禁止复制到自身或其子目录。
function copyAcross(fromUserId, fromV, toUserId, toDirV, newName) {
  const from = resolvePath(fromUserId, fromV);
  const toDir = resolvePath(toUserId, toDirV);
  if (!fs.existsSync(from.abs)) {
    const err = new Error('文件不存在');
    err.status = 404;
    throw err;
  }
  const sameOwner = from.root === toDir.root;
  if (
    from.vpath === '/' ||
    (sameOwner &&
      (toDir.vpath === from.vpath || toDir.vpath.startsWith(from.vpath + '/')))
  ) {
    const err = new Error('不能复制到自身或其子目录');
    err.status = 400;
    throw err;
  }
  const name = cleanName(newName) || path.basename(from.abs);
  const target = uniqueAbsPath(path.join(toDir.abs, name));
  const copiedBytes = statSize(from.abs);
  copyTree(from.abs, target);
  adjustUsage(toUserId, copiedBytes);
  return joinVPath(toDir.vpath, path.basename(target));
}

function copy(userId, fromV, toDirV, newName) {
  return copyAcross(userId, fromV, userId, toDirV, newName);
}

function recentFiles(userId, limit = 60) {
  const root = userRoot(userId);
  const out = [];
  const walk = (dir, vdir) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.name.startsWith('.')) continue;
      const abs = path.join(dir, it.name);
      const vpath = joinVPath(vdir, it.name);
      if (it.isDirectory()) walk(abs, vpath);
      else {
        try {
          out.push(entryOf(abs, vpath, it.name));
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root, '/');
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

// —— 用量记账 ——
// 早期实现每次上传都遍历整棵目录树统计，文件一多就拖慢。改为：
//   1) 全量扫描结果做缓存（默认 2 分钟校验一次，防止外部改动造成漂移）
//   2) 上传/删除/复制/回收站等写操作走增量记账，命中缓存时立即生效
// 这样配额判断不再依赖每次 O(文件数) 的磁盘遍历。
const USAGE_TTL_MS = Number(process.env.USAGE_TTL_MS || 120000);
const usageCache = new Map(); // userId -> { bytes, verifiedAt }

function scanUsage(userId) {
  const root = userRoot(userId);
  let total = 0;
  const walk = (dir) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root);
  return total;
}

function usage(userId) {
  const key = String(userId);
  const hit = usageCache.get(key);
  const now = Date.now();
  if (hit && now - hit.verifiedAt < USAGE_TTL_MS) return hit.bytes;
  const bytes = scanUsage(userId);
  usageCache.set(key, { bytes, verifiedAt: now });
  return bytes;
}

// 增量记账：仅在缓存已建立时生效（未建立时下次全量扫描自然准确）
function adjustUsage(userId, delta) {
  const d = Number(delta) || 0;
  if (!d) return;
  const hit = usageCache.get(String(userId));
  if (!hit) return;
  hit.bytes = Math.max(0, hit.bytes + d);
}

function invalidateUsage(userId) {
  if (userId == null) usageCache.clear();
  else usageCache.delete(String(userId));
}

// 统计某个路径当前占用的字节数（文件或目录），用于删除前记账
function sizeOfPath(userId, vpath) {
  try {
    return statSize(resolvePath(userId, vpath).abs);
  } catch {
    return 0;
  }
}

module.exports = {
  mimeOf,
  extOf,
  isPreviewable,
  userRoot,
  normalizeVPath,
  resolvePath,
  cleanName,
  joinVPath,
  parentOf,
  baseName,
  exists,
  entryOf,
  listDir,
  listMerged,
  dirSize,
  parseOwnerPath,
  uniqueAbsPath,
  mkdir,
  remove,
  rename,
  move,
  copy,
  copyAcross,
  recentFiles,
  usage,
  adjustUsage,
  invalidateUsage,
  sizeOfPath,
  statSize,
  MAX_NAME,
  MAX_FILE_BYTES,
};