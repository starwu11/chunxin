const fs = require('fs');
const path = require('path');
const { USER_DIR } = require('./db');

const CACHE_TTL = 30 * 1000;
let cache = null;
let cacheAt = 0;

function invalidate() {
  cache = null;
  cacheAt = 0;
}

function ensureNode(map, vpath, ownerName) {
  let node = map.get(vpath);
  if (!node) {
    node = {
      path: vpath,
      name: vpath === '/' ? '全部文件' : path.posix.basename(vpath),
      children: new Set(),
      files: [],
      owners: new Set(),
    };
    map.set(vpath, node);
  }
  if (ownerName) node.owners.add(ownerName);
  return node;
}

function walk(map, absDir, vpath, ownerName) {
  const node = ensureNode(map, vpath, ownerName);
  let entries = [];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childAbs = path.join(absDir, entry.name);
    const childV = path.posix.join(vpath, entry.name);
    if (entry.isDirectory()) {
      node.children.add(childV);
      walk(map, childAbs, childV, ownerName);
    } else if (entry.isFile()) {
      let size = 0;
      let mtime = 0;
      try {
        const st = fs.statSync(childAbs);
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        /* ignore */
      }
      node.files.push({ name: entry.name, path: childV, size, mtime, ownerName });
    }
  }
}

function build(users) {
  const map = new Map();
  ensureNode(map, '/', '');
  for (const user of users || []) {
    const root = path.join(USER_DIR, String(user.id));
    if (!fs.existsSync(root)) continue;
    walk(map, root, '/', user.username);
  }
  cache = map;
  cacheAt = Date.now();
  return map;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s\-_·.,，、/\\()（）[\]【】]/g, '');
}

function splitTerms(keyword) {
  return String(keyword || '')
    .split(/\s+/)
    .map((term) => normalizeText(term))
    .filter(Boolean);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

function fuzzyWindowDistance(text, term, maxDist) {
  if (!term || term.length < 2) return Infinity;
  const span = term.length;
  if (span === 2) {
    if (text.length < 2 || text[0] !== term[0]) return Infinity;
    return levenshtein(term, text.slice(0, 2));
  }
  let best = Infinity;
  for (let i = 0; i <= text.length - span; i += 1) {
    const dist = levenshtein(term, text.slice(i, i + span));
    if (dist < best) best = dist;
    if (best === 0) return 0;
  }
  return best;
}

function termScore(text, term) {
  if (!term) return 0;
  if (/[0-9]/.test(term)) {
    const idx = text.indexOf(term);
    return idx >= 0 ? 120 - Math.min(20, idx) : 0;
  }
  if (text.startsWith(term)) return 140;
  const idx = text.indexOf(term);
  if (idx >= 0) return 120 - Math.min(20, idx);

  let pos = 0;
  let gap = 0;
  let last = -1;
  let subsequence = true;
  for (const ch of term) {
    const found = text.indexOf(ch, pos);
    if (found < 0) {
      subsequence = false;
      break;
    }
    if (last >= 0) gap += found - last - 1;
    last = found;
    pos = found + 1;
  }
  if (subsequence) return 80 - Math.min(20, gap);

  const maxDist = term.length <= 4 ? 1 : 2;
  if (term.length > 10) return 0;
  const dist = fuzzyWindowDistance(text, term, maxDist);
  if (dist <= maxDist) return 60 - dist * 10;
  return 0;
}

function matchScore(name, terms) {
  const text = normalizeText(name);
  let total = 0;
  for (const term of terms) {
    const score = termScore(text, term);
    if (!score) return 0;
    total += score;
  }
  return total;
}

function query(keyword, users, limit = 200) {
  const terms = splitTerms(keyword);
  if (!terms.length) return { items: [], total: 0, keyword: '' };
  const map = cache && Date.now() - cacheAt < CACHE_TTL ? cache : build(users);
  const picked = new Map();

  const addDir = (node, score) => {
    if (!node) return;
    const existing = picked.get(node.path);
    if (!existing || score > existing.score) {
      picked.set(node.path, {
        path: node.path,
        name: node.name,
        isDir: true,
        fileCount: node.files.length,
        dirCount: node.children.size,
        owners: Array.from(node.owners),
        score,
      });
    }
  };

  for (const node of map.values()) {
    if (node.path === '/') continue;
    const ownScore = matchScore(node.name, terms);
    if (ownScore) {
      if (node.children.size) {
        for (const childPath of node.children) addDir(map.get(childPath), ownScore);
      } else {
        addDir(node, ownScore);
      }
    }
    for (const file of node.files) {
      const fileScore = matchScore(file.name, terms);
      if (!fileScore) continue;
      if (node.children.size) {
        for (const childPath of node.children) addDir(map.get(childPath), fileScore);
      } else {
        addDir(node, Math.max(ownScore, fileScore));
      }
    }
  }

  const items = Array.from(picked.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.path.localeCompare(b.path, 'zh');
  });
  return { items: items.slice(0, limit), total: items.length, keyword: String(keyword).trim() };
}

module.exports = { query, invalidate, build };