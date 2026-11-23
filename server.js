const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, DATA_DIR, TMP_DIR, USER_DIR } = require('./src/db');
const auth = require('./src/auth');
const store = require('./src/fsstore');
const dav = require('./src/dav');
const autoFolders = require('./src/auto-folders');
const permissions = require('./src/permissions');
const batches = require('./src/batches');
const trash = require('./src/trash');
const audit = require('./src/audit');
const sms = require('./src/sms');
const vehicleApi = require('./src/vehicle-api');
const searchIndex = require('./src/search');
const thumb = require('./src/thumb');
const temp = require('./src/temp');
const textdoc = require('./src/textdoc');
const settings = require('./src/settings');
const notes = require('./src/notes');
const WordExtractor = require('word-extractor');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_JSON = 1024 * 1024;
const MAX_FILE = store.MAX_FILE_BYTES;
const SESSION_COOKIE = 'cd_session';
const OPEN_API_KEY = process.env.OPEN_API_KEY || '';
const OPEN_MAX_UPLOAD = Number(process.env.OPEN_MAX_UPLOAD || 500 * 1024 * 1024);
const DESCRIBE_PROJECTS = { window: '窗膜', ppf: '车衣', color: '改色', mod: '改装' };
const DESCRIBE_BRANDS = ['威固', '龙膜', 'AX', 'CYS', '圣景', '量子', '强生', '雅龙', '3M'];

const SECRET_FILE = path.join(DATA_DIR, 'secret');
let SECRET = '';
try {
  SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} catch {
  /* create below */
}
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendWorkbuddy(user, ip, origin, payload) {
  const url = settings.getWorkbuddyUrl();
  if (!url) return Promise.resolve();
  return (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const headers = { 'Content-Type': 'application/json' };
      if (origin) headers.Origin = origin;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      audit.add(user, 'workbuddy_send', payload.path, `投递给 WorkBuddy：HTTP ${res.status}`, ip);
    } catch (err) {
      audit.add(user, 'workbuddy_send', payload.path, '投递失败：' + (err.message || err.name || ''), ip);
    }
  })();
}

function buildDescribeText(info) {
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const brands = Array.isArray(info.brands) ? info.brands : [];
  const values = {
    projects: (Array.isArray(info.projects) ? info.projects : []).join('、'),
    brands: brands.join('、'),
    brand_line: brands.length ? `施工品牌：${brands.join('、')}\n` : '',
    model: info.model || '',
    car_name: info.carName || '未记录',
    vin: info.vin || '未记录',
    image_folder: info.folder || '',
    image_count: info.imageCount || 0,
    date: dateStr,
    department: info.department || '',
    username: info.username || '',
  };
  return settings.renderDescribeTemplate(settings.getDescribeTemplate(), values);
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// 增量 CRC32：边读边算，ZIP 打包无需把整个文件读进内存
function crc32Update(c, buf) {
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c;
}

function crc32(buf) {
  return (crc32Update(0xffffffff, buf) ^ 0xffffffff) >>> 0;
}

// —— 漏传统计口径 ——
// 新员工刚注册时不该背注册前的历史欠账：注册/入职当日不计，
// 从注册次日起才算「应上传未上传」。
const STAT_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.FOLDER_TIMEZONE || 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function statDayOf(ms) {
  const n = Number(ms);
  if (!n) return '';
  return STAT_DAY_FMT.format(new Date(n));
}

function statNextDay(day) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// 该账号漏传统计的起始日期（含）：注册次日 与 统计窗口起点 取较晚者
function statFromDay(user, windowFrom) {
  const join = statDayOf(user.created_at);
  const start = join ? statNextDay(join) : '';
  return start > windowFrom ? start : windowFrom;
}

function dosDateTime(ms) {
  const d = new Date(ms);
  const time =
    ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31);
  const date =
    (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

// 分片大小：单次只占 1MB 内存，与文件体积无关
const ZIP_CHUNK = 1024 * 1024;

async function writeAll(handle, buf) {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await handle.write(buf, off, buf.length - off);
    if (!bytesWritten) throw Object.assign(new Error('写入失败'), { status: 500 });
    off += bytesWritten;
  }
}

// 流式写 ZIP：逐块读文件 → 增量 CRC32 → 直接写盘。
// 使用 data descriptor（flag bit 3）让 local header 可以先写占位再回填真实 CRC/大小，
// 因此打包过程中占用的内存恒定在 1MB 左右，与文件大小、并发打包数量无关。
async function writeZip(entries, outAbs) {
  const handle = await fs.promises.open(outAbs, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const e of entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const { time, date } = dosDateTime(e.mtime);
      const flags = 0x0808; // UTF-8 文件名 + data descriptor
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(0, 14); // crc32 待回填（data descriptor）
      local.writeUInt32LE(0, 18); // 压缩后大小待回填
      local.writeUInt32LE(0, 22); // 原始大小待回填
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      await writeAll(handle, local);
      await writeAll(handle, nameBuf);

      let crcState = 0xffffffff;
      let size = 0;
      const rs = fs.createReadStream(e.abs, { highWaterMark: ZIP_CHUNK });
      try {
        for await (const chunk of rs) {
          crcState = crc32Update(crcState, chunk);
          size += chunk.length;
          await writeAll(handle, chunk);
        }
      } catch (err) {
        rs.destroy();
        const wrapped = new Error(`读取文件失败：${e.name}`);
        wrapped.status = 500;
        throw wrapped;
      }
      const crc = (crcState ^ 0xffffffff) >>> 0;

      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc, 4);
      desc.writeUInt32LE(size, 8);
      desc.writeUInt32LE(size, 12);
      await writeAll(handle, desc);

      central.push({ name: nameBuf, crc, size, time, date, offset, flags });
      offset += 30 + nameBuf.length + size + 16;
    }
    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(20, 6);
      head.writeUInt16LE(c.flags, 8);
      head.writeUInt16LE(0, 10);
      head.writeUInt16LE(c.time, 12);
      head.writeUInt16LE(c.date, 14);
      head.writeUInt32LE(c.crc, 16);
      head.writeUInt32LE(c.size, 20);
      head.writeUInt32LE(c.size, 24);
      head.writeUInt16LE(c.name.length, 28);
      head.writeUInt16LE(0, 30);
      head.writeUInt16LE(0, 32);
      head.writeUInt16LE(0, 34);
      head.writeUInt16LE(0, 36);
      head.writeUInt32LE(0, 38);
      head.writeUInt32LE(c.offset, 42);
      await writeAll(handle, head);
      await writeAll(handle, c.name);
      cdSize += 46 + c.name.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    await writeAll(handle, eocd);
  } finally {
    await handle.close();
  }
}

function collectZipEntries(rootAbs, baseName) {
  const entries = [];
  let total = 0;
  const walk = (dir, rel) => {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const it of items) {
      const abs = path.join(dir, it.name);
      const name = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) walk(abs, name);
      else if (it.isFile()) {
        const st = fs.statSync(abs);
        if (st.size > 500 * 1024 * 1024) {
          const err = new Error('文件夹内存在超过 500MB 的文件，请进入文件夹单独下载');
          err.status = 413;
          throw err;
        }
        total += st.size;
        if (total > 1024 * 1024 * 1024) {
          const err = new Error('文件夹总大小超过 1GB，请进入文件夹分批下载');
          err.status = 413;
          throw err;
        }
        entries.push({ abs, name, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(rootAbs, baseName || 'share');
  return { entries, total };
}

async function buildZipFile(rootAbs, baseName, outAbs) {
  const { entries } = collectZipEntries(rootAbs, baseName);
  await writeZip(entries, outAbs);
}

async function buildZipMulti(items, outAbs) {
  const entries = [];
  let total = 0;
  for (const it of items) {
    if (it.isDirectory) {
      const result = collectZipEntries(it.abs, it.name);
      total += result.total;
      entries.push(...result.entries);
    } else {
      const st = fs.statSync(it.abs);
      if (st.size > 500 * 1024 * 1024) {
        const err = new Error('存在超过 500MB 的文件，请单独下载');
        err.status = 413;
        throw err;
      }
      total += st.size;
      if (total > 1024 * 1024 * 1024) {
        const err = new Error('总大小超过 1GB，请分批下载');
        err.status = 413;
        throw err;
      }
      entries.push({ abs: it.abs, name: it.name, size: st.size, mtime: st.mtimeMs });
    }
  }
  await writeZip(entries, outAbs);
}

function fail(res, status, message) {
  sendJson(res, status, { error: message });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON 格式错误'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function readText(req, maxBytes = MAX_JSON) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const SECURE_COOKIE = process.env.SECURE_COOKIE === 'true';
const ALLOW_REGISTER = process.env.ALLOW_REGISTER !== 'false';

function cookieValue(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/;${Number(maxAge) > 0 ? ` Max-Age=${maxAge};` : ''} HttpOnly; SameSite=Lax${
    SECURE_COOKIE ? '; Secure' : ''
  }`;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  res.setHeader('Set-Cookie', cookieValue(SESSION_COOKIE, token, maxAgeSeconds));
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${SECURE_COOKIE ? '; Secure' : ''}`
  );
}

function currentUser(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  return auth.userBySession(cookies[SESSION_COOKIE]);
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) {
    fail(res, 401, '请先登录');
    return null;
  }
  return user;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    quota: user.quota,
    createdAt: user.createdAt || null,
    role: user.role || 'user',
    status: user.status || 'active',
    department: user.department || '',
    phone: sms.maskPhone(user.phone || ''),
  };
}

function guardPath(user, vpath) {
  if (!permissions.canAccess(user.id, vpath)) {
    const err = new Error('无权访问该文件夹');
    err.status = 403;
    throw err;
  }
}

function shareSig(token, password) {
  return crypto.createHmac('sha256', SECRET).update(`${token}:${password || ''}`).digest('hex');
}

function loadShare(token) {
  const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(token);
  if (!share) return null;
  if (share.expires_at && share.expires_at < Date.now()) return null;
  return share;
}

function shareVerified(req, share) {
  if (!share.password) return true;
  const cookies = auth.parseCookies(req.headers.cookie);
  const expected = shareSig(share.token, share.password);
  return cookies[`sv_${share.token}`] === expected;
}

function asciiFilename(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return fallback || 'download';
}

function serveFileRange(req, res, abs, name, inline) {
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    res.writeHead(405);
    return res.end();
  }
  const mime = store.mimeOf(name);
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`);
  res.setHeader('Last-Modified', st.mtime.toUTCString());
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${asciiFilename(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`
  );

  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start;
    let end;
    if (m) {
      if (m[1] === '' && m[2] !== '') {
        start = Math.max(0, st.size - Number(m[2]));
        end = st.size - 1;
      } else {
        start = Number(m[1] || 0);
        end = m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
      }
    }
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < st.size) {
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Content-Length': end - start + 1,
      });
      return fs.createReadStream(abs, { start, end }).pipe(res);
    }
    res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
    return res.end();
  }

  res.writeHead(200, { 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(abs).pipe(res);
}

function isWechat(req) {
  return /MicroMessenger/i.test(req.headers['user-agent'] || '');
}

function isPCWechat(req) {
  const ua = req.headers['user-agent'] || '';
  return /MicroMessenger/i.test(ua) && /(Windows NT|Macintosh)/i.test(ua);
}

function wechatOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || '';
  return proto + '://' + host;
}

function wechatDownloadGuide(res, downloadUrl) {
  const urlHtml = downloadUrl
    ? `<p class="wx-tip">也可复制下方链接，到浏览器地址栏粘贴打开：</p>
       <input class="wx-url" id="wxUrl" value="${downloadUrl.replace(/"/g, '&quot;').replace(/</g, '&lt;')}" readonly />
       <button class="wx-btn" id="wxCopy">复制下载链接</button>`
    : '';
  const script = downloadUrl
    ? `<script>
      document.getElementById('wxCopy').onclick=function(){var u=document.getElementById('wxUrl');u.select();try{document.execCommand('copy');}catch(e){}if(navigator.clipboard)navigator.clipboard.writeText(u.value);alert('已复制，请到浏览器粘贴打开');};
      <\/script>`
    : '';
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>在浏览器中打开下载</title>
<style>
body{margin:0;padding:24px;background:#f5f6f8;color:#1d2129;font:15px/1.7 system-ui,-apple-system,"PingFang SC",sans-serif}
.card{max-width:520px;margin:40px auto;background:#fff;border-radius:14px;padding:22px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
h2{margin:0 0 12px;font-size:17px}
p{margin:8px 0;color:#4b5563}
.step{background:#f0f5ff;border-radius:10px;padding:12px 14px;margin:12px 0;color:#2757c4}
.wx-url{width:100%;box-sizing:border-box;padding:11px;border:1px solid #d9dce3;border-radius:9px;font-size:12.5px;margin-top:6px}
.wx-btn{width:100%;margin-top:12px;padding:12px;border:0;border-radius:9px;background:#2757c4;color:#fff;font-size:15px;cursor:pointer}
</style></head><body>
<div class="card">
<h2>微信内置浏览器无法直接下载文件</h2>
<p>请按下面两步操作：</p>
<div class="step">1. 点击微信右上角「···」→「在浏览器中打开」</div>
<div class="step">2. 在浏览器中重新打开本页即可下载</div>
${urlHtml}
</div>
${script}
</body></html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

async function handleUpload(req, res, user, url) {
  let vpath;
  try {
    vpath = store.normalizeVPath(url.searchParams.get('path'));
  } catch (err) {
    return fail(res, 400, err.message);
  }
  if (vpath === '/') return fail(res, 400, '缺少文件名');
  if (!permissions.canAccess(user.id, vpath)) return fail(res, 403, '无权访问该文件夹');

  const name = store.baseName(vpath);
  if (!name || name.length > store.MAX_NAME) return fail(res, 400, '文件名无效');

  const { abs } = store.resolvePath(user.id, vpath);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return fail(res, 409, '同名文件夹已存在');
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_FILE) return fail(res, 413, '单个文件超过 4GB 限制');

  const used = store.usage(user.id);
  if (contentLength > 0 && used + contentLength > user.quota) {
    return fail(res, 413, '存储空间不足');
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(TMP_DIR, `up-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
  let written = 0;
  let quotaError = false;

  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      req.on('data', (chunk) => {
        written += chunk.length;
        if (written > MAX_FILE || used + written > user.quota) {
          quotaError = true;
          req.destroy(new Error('quota'));
        }
      });
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      req.on('error', reject);
    });
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (quotaError) return fail(res, 413, '存储空间不足');
    return fail(res, 400, '上传中断');
  }

  const finalAbs = store.uniqueAbsPath(abs);
  fs.renameSync(tmp, finalAbs);
  const finalName = path.basename(finalAbs);
  const finalVPath = store.joinVPath(store.parentOf(vpath), finalName);
  const finalSize = fs.statSync(finalAbs).size;
  store.adjustUsage(user.id, finalSize);
  audit.add(user, 'upload', finalVPath, `文件上传，${fmtBytes(finalSize)}`, audit.clientIp(req));

  return sendJson(res, 200, {
    ok: true,
    path: finalVPath,
    name: finalName,
    size: finalSize,
    renamed: finalName !== name,
  });
}

async function handleShareApi(req, res, url, token, action) {
  const share = loadShare(token);
  if (!share) return fail(res, 404, '分享不存在或已过期');
  const owner = auth.findUserById(share.user_id);

  if (action === 'info') {
    let size = 0;
    try {
      const { abs } = store.resolvePath(share.user_id, share.path);
      const st = fs.statSync(abs);
      size = st.isDirectory() ? 0 : st.size;
    } catch {
      /* ignore */
    }
    return sendJson(res, 200, {
      name: share.name,
      path: share.path,
      size,
      isDir: !!share.is_dir,
      needPassword: !!share.password,
      verified: shareVerified(req, share),
      expiresAt: share.expires_at || null,
      createdAt: share.created_at,
      owner: owner ? owner.username : '未知',
    });
  }

  if (action === 'verify') {
    if (req.method !== 'POST') return fail(res, 405, '方法不允许');
    const body = await readJson(req);
    if (!share.password) return sendJson(res, 200, { ok: true });
    if (String(body.password || '') !== share.password) {
      return fail(res, 403, '提取码错误');
    }
    res.setHeader(
      'Set-Cookie',
      cookieValue(`sv_${share.token}`, shareSig(share.token, share.password), 12 * 3600)
    );
    return sendJson(res, 200, { ok: true });
  }

  if (!shareVerified(req, share)) return fail(res, 403, '需要提取码');

  if (action === 'zip') {
    if (isWechat(req)) return wechatDownloadGuide(res, wechatOrigin(req) + req.url);
    if (!share.is_dir) return fail(res, 400, '不是文件夹');
    if (!permissions.canAccess(share.user_id, share.path)) return fail(res, 403, '该分享已失效');
    const { abs } = store.resolvePath(share.user_id, share.path);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return fail(res, 404, '文件夹不存在');
    const zipPath = path.join(TMP_DIR, `share-${token}-${Date.now()}.zip`);
    try {
      await buildZipFile(abs, store.baseName(share.path) || share.name, zipPath);
    } catch (err) {
      fs.rmSync(zipPath, { force: true });
      return fail(res, err.status || 500, err.message || '打包失败');
    }
    db.prepare('UPDATE shares SET downloads = downloads + 1 WHERE token = ?').run(token);
    const zipStat = fs.statSync(zipPath);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': zipStat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(
        (share.name || 'share') + '.zip'
      )}`,
      'Cache-Control': 'no-store',
    });
    const cleanup = () => fs.rmSync(zipPath, { force: true });
    const stream = fs.createReadStream(zipPath);
    stream.on('close', cleanup);
    stream.on('error', cleanup);
    res.on('close', cleanup);
    stream.pipe(res);
    return;
  }

  if (action === 'list') {
    if (!share.is_dir) return fail(res, 400, '不是文件夹');
    const sub = url.searchParams.get('path') || '/';
    let vpath;
    try {
      vpath = store.normalizeVPath(sub);
    } catch (err) {
      return fail(res, 400, err.message);
    }
    const base = store.normalizeVPath(share.path);
    const full = base === '/' ? vpath : base + (vpath === '/' ? '' : vpath);
    if (!permissions.canAccess(share.user_id, full)) return fail(res, 403, '该分享已失效');
    try {
      const result = store.listDir(share.user_id, full);
      return sendJson(res, 200, {
        ...result,
        name: share.name,
        root: true,
        relative: vpath,
      });
    } catch (err) {
      return fail(res, err.status || 500, err.message);
    }
  }

  let vpath;
  try {
    vpath = store.normalizeVPath(url.searchParams.get('path') || share.path);
  } catch (err) {
    return fail(res, 400, err.message);
  }
  const base = store.normalizeVPath(share.path);
  if (share.is_dir) {
    if (!(vpath === base || vpath.startsWith(base + '/'))) return fail(res, 403, '无权访问该路径');
  } else if (vpath !== base) {
    return fail(res, 403, '无权访问该路径');
  }

  const { abs } = store.resolvePath(share.user_id, vpath);
  if (!permissions.canAccess(share.user_id, vpath)) return fail(res, 403, '该分享已失效');
  if (!fs.existsSync(abs)) return fail(res, 404, '文件不存在');
  const st = fs.statSync(abs);
  if (st.isDirectory()) return fail(res, 400, '不能直接下载文件夹');

  if (action === 'download') {
    db.prepare('UPDATE shares SET downloads = downloads + 1 WHERE token = ?').run(token);
    const isImage = /^image\//i.test(store.mimeOf(store.baseName(vpath)));
    if (isWechat(req) && !isImage) return wechatDownloadGuide(res, wechatOrigin(req) + req.url);
    return serveFileRange(req, res, abs, store.baseName(vpath), isWechat(req));
  }
  if (action === 'preview') {
    return serveFileRange(req, res, abs, store.baseName(vpath), true);
  }
  if (action === 'text') {
    if (st.size > 2 * 1024 * 1024) return fail(res, 413, '文件过大，无法在线查看');
    const text = fs.readFileSync(abs, 'utf8');
    return sendJson(res, 200, { text, name: store.baseName(vpath) });
  }
  return fail(res, 404, '接口不存在');
}

function openUploadTarget(url) {
  const dirParam = url.searchParams.get('dir');
  const nameParam = url.searchParams.get('name');
  const pathParam = url.searchParams.get('path');
  let dir = '/';
  let name = '';
  if (dirParam !== null) {
    dir = store.normalizeVPath(dirParam || '/');
    name = String(nameParam || '');
  } else {
    const raw = String(pathParam || '');
    if (!raw || raw.endsWith('/')) {
      if (!nameParam) {
        const err = new Error('缺少文件名，请用 path 指定完整路径，或传 name');
        err.status = 400;
        throw err;
      }
      dir = store.normalizeVPath(raw || '/');
      name = String(nameParam);
    } else {
      const full = store.normalizeVPath(raw);
      if (full === '/') {
        const err = new Error('缺少文件名');
        err.status = 400;
        throw err;
      }
      dir = store.parentOf(full);
      name = store.baseName(full);
    }
  }
  const clean = store.cleanName(name);
  if (!clean) {
    const err = new Error('文件名无效');
    err.status = 400;
    throw err;
  }
  return { vpath: store.joinVPath(dir, clean), name: clean };
}

async function handleOpenApi(req, res, url) {
  const key =
    req.headers['x-api-key'] ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    url.searchParams.get('key') ||
    '';
  if (!OPEN_API_KEY) return fail(res, 503, '开放接口未启用');
  if (key !== OPEN_API_KEY) return fail(res, 401, 'API Key 无效');
  const openMethod = String(req.method || '').toUpperCase();
  if (openMethod !== 'GET' && openMethod !== 'HEAD') searchIndex.invalidate();

  const p = url.pathname;
  if (p === '/api/open/users') {
    const rows = db
      .prepare("SELECT id, username, department, role, status FROM users WHERE status = 'active' ORDER BY id")
      .all();
    return sendJson(res, 200, { users: rows });
  }

  let bodyCache = null;
  if (p === '/api/open/delete' && (req.method === 'POST' || req.method === 'DELETE')) {
    try {
      bodyCache = await readJson(req);
    } catch (err) {
      return fail(res, err.status || 400, err.message || '请求体无效');
    }
  }
  const rawUser =
    url.searchParams.get('user') ||
    (bodyCache && bodyCache.user != null ? String(bodyCache.user) : '') ||
    req.headers['x-clouddisk-user'] ||
    '';
  const username = String(rawUser).trim();
  if (!username) return fail(res, 400, '未指定 user 参数');
  const target = auth.findUserByName(username);
  if (!target) return fail(res, 404, '用户不存在');
  if (target.status !== 'active') return fail(res, 403, '该账号未启用');

  if (p === '/api/open/upload') {
    if (req.method !== 'PUT' && req.method !== 'POST') return fail(res, 405, '请使用 PUT 上传');
    let info;
    try {
      info = openUploadTarget(url);
    } catch (err) {
      return fail(res, err.status || 400, err.message);
    }
    if (!permissions.canAccess(target.id, info.vpath)) return fail(res, 403, '该账号无权写入此目录');
    const maxMb = Math.round(OPEN_MAX_UPLOAD / 1024 / 1024);
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > OPEN_MAX_UPLOAD) return fail(res, 413, `单个文件不能超过 ${maxMb}MB`);
    const used = store.usage(target.id);
    if (contentLength > 0 && used + contentLength > target.quota) return fail(res, 413, '存储空间不足');
    const { abs } = store.resolvePath(target.id, info.vpath);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return fail(res, 409, '同名文件夹已存在');
    const tmp = path.join(TMP_DIR, `open-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
    let written = 0;
    let limitError = '';
    let stopped = false;
    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        const stop = (msg) => {
          if (stopped) return;
          stopped = true;
          limitError = msg;
          req.unpipe(out);
          req.resume();
          out.destroy();
          reject(new Error(msg));
        };
        req.on('data', (chunk) => {
          written += chunk.length;
          if (written > OPEN_MAX_UPLOAD) stop(`单个文件不能超过 ${maxMb}MB`);
          else if (used + written > target.quota) stop('存储空间不足');
        });
        req.pipe(out);
        out.on('finish', resolve);
        out.on('error', (err) => {
          if (!stopped) reject(err);
        });
        req.on('error', reject);
      });
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      return fail(res, 413, limitError || '上传中断');
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const finalAbs = store.uniqueAbsPath(abs);
      fs.renameSync(tmp, finalAbs);
      const finalName = path.basename(finalAbs);
      const finalVPath = store.joinVPath(store.parentOf(info.vpath), finalName);
      const size = fs.statSync(finalAbs).size;
      store.adjustUsage(target.id, size);
      audit.add(
        target,
        'upload',
        finalVPath,
        `开放接口上传，${fmtBytes(size)}`,
        audit.clientIp(req)
      );
      return sendJson(res, 201, {
        ok: true,
        user: target.username,
        path: finalVPath,
        name: finalName,
        size,
        renamed: finalName !== info.name,
      });
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      return fail(res, err.status || 500, err.message || '保存失败');
    }
  }

  if (p === '/api/open/delete') {
    if (process.env.OPEN_ALLOW_DELETE === '0') return fail(res, 403, '开放接口删除已关闭');
    if (req.method !== 'POST' && req.method !== 'DELETE') return fail(res, 405, '请使用 POST 删除');
    const body = bodyCache || {};
    const list = Array.isArray(body.paths) ? body.paths : body.path ? [body.path] : [];
    if (!list.length) return fail(res, 400, '请指定 path 或 paths');
    if (list.length > 100) return fail(res, 400, '一次最多删除 100 项');
    const items = [];
    const errors = [];
    for (const raw of list) {
      try {
        const vpath = store.normalizeVPath(raw);
        if (vpath === '/') {
          const err = new Error('不能删除根目录');
          err.status = 400;
          throw err;
        }
        if (!permissions.canAccess(target.id, vpath)) {
          const err = new Error('该账号无权删除此路径');
          err.status = 403;
          throw err;
        }
        const { abs } = store.resolvePath(target.id, vpath);
        if (!fs.existsSync(abs)) {
          const err = new Error('文件或文件夹不存在');
          err.status = 404;
          throw err;
        }
        items.push(trash.add(target, vpath, target));
      } catch (err) {
        errors.push({ path: String(raw), error: err.message || '删除失败', status: err.status || 500 });
      }
    }
    const ip = audit.clientIp(req);
    for (const it of items) {
      audit.add(
        target,
        'delete',
        it.path,
        `开放接口删除${it.isDir ? `文件夹，${it.files} 个文件` : '文件'}`,
        ip
      );
    }
    if (!items.length) {
      const first = errors[0] || { error: '删除失败', status: 400 };
      return sendJson(res, first.status || 400, { error: first.error, errors });
    }
    return sendJson(res, 200, {
      ok: true,
      user: target.username,
      deleted: items.length,
      keepDays: trash.KEEP_DAYS,
      items: items.map((it) => ({
        name: it.name,
        path: it.path,
        isDir: it.isDir,
        size: it.size,
        files: it.files,
        deletedAt: it.deletedAt,
        expiresAt: it.expiresAt,
      })),
      errors,
    });
  }

  if (p === '/api/open/list') {
    try {
      const result = store.listDir(target.id, url.searchParams.get('path') || '/');
      result.entries = permissions.filterEntries(target.id, result.entries, result.path);
      return sendJson(res, 200, { user: username, ...result });
    } catch (err) {
      return fail(res, err.status || 500, err.message);
    }
  }

  if (p === '/api/open/file') {
    const vpath = store.normalizeVPath(url.searchParams.get('path'));
    if (!permissions.canAccess(target.id, vpath)) return fail(res, 403, '无权访问');
    const { abs } = store.resolvePath(target.id, vpath);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return fail(res, 404, '文件不存在');
    return serveFileRange(req, res, abs, store.baseName(vpath), false);
  }

  if (p === '/api/open/text') {
    const vpath = store.normalizeVPath(url.searchParams.get('path'));
    if (!permissions.canAccess(target.id, vpath)) return fail(res, 403, '无权访问');
    const { abs } = store.resolvePath(target.id, vpath);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return fail(res, 404, '文件不存在');
    const st = fs.statSync(abs);
    if (st.size > 2 * 1024 * 1024) return fail(res, 413, '文件超过 2MB');
    return sendJson(res, 200, { text: fs.readFileSync(abs, 'utf8'), name: store.baseName(vpath) });
  }

  if (p === '/api/open/search') {
    const kw = (url.searchParams.get('keyword') || '').toLowerCase();
    const entries = store
      .recentFiles(target.id, 2000)
      .filter((e) => !kw || e.name.toLowerCase().includes(kw));
    return sendJson(res, 200, { entries: entries.slice(0, 200) });
  }

  return fail(res, 404, '接口不存在');
}

function activeUsers() {
  return db.prepare("SELECT id, username FROM users WHERE status = 'active' ORDER BY id").all();
}

function targetOf(user, vpath) {
  const normalized = store.normalizeVPath(vpath);
  if (normalized === temp.VROOT || normalized.startsWith(temp.VROOT + '/')) {
    if (!user || user.role !== 'admin') return { ownerId: null, target: null, path: normalized, virtual: true };
    const parsed = temp.parseVirtual(normalized);
    if (!parsed || !parsed.batch) return { ownerId: null, target: null, path: normalized, virtual: true };
    const target = auth.findUserById(parsed.ownerId);
    return {
      ownerId: parsed.ownerId,
      target,
      path: temp.physicalPath(parsed),
      virtual: true,
      batch: parsed.batch,
    };
  }
  const parsed = store.parseOwnerPath(normalized);
  const ownerId = parsed.ownerId || user.id;
  const target = ownerId === user.id ? user : auth.findUserById(ownerId);
  return { ownerId, target, path: parsed.path };
}

function deleteVirtual(user, vpath) {
  if (!user || user.role !== 'admin') return [];
  const parsed = temp.parseVirtual(vpath);
  if (!parsed || !parsed.batch) return [];
  const owner = auth.findUserById(parsed.ownerId);
  if (!owner) return [];
  const { abs } = store.resolvePath(owner.id, temp.physicalPath(parsed));
  if (!fs.existsSync(abs)) return [];
  const st = fs.statSync(abs);
  const freed = store.statSize(abs);
  fs.rmSync(abs, { recursive: true, force: true });
  store.adjustUsage(owner.id, -freed);
  temp.cleanupBatch(owner.id, parsed.batch);
  return [
    {
      name: store.baseName(parsed.vpath),
      path: parsed.vpath,
      isDir: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      files: 0,
      deletedAt: Date.now(),
      expiresAt: 0,
      ownerId: owner.id,
      ownerName: owner.username,
    },
  ];
}

function canModify(user, ownerId) {
  return ownerId === user.id || user.role === 'admin';
}

// 备注作用范围：仅「小红书笔记归档」目录内的直接子文件夹
const NOTE_ROOT = '/小红书笔记归档';
// 备注编辑白名单：管理员始终允许，其余按账号名匹配
const NOTE_EDITORS = ['叶子馨'];
function canEditNoteUser(user) {
  return !!user && (user.role === 'admin' || NOTE_EDITORS.includes(user.username));
}
function isNoteTarget(entry, vpath) {
  if (!entry || !entry.isDir || entry.temp) return false;
  if (store.normalizeVPath(vpath) !== NOTE_ROOT) return false;
  // 只认该目录下的直接子文件夹（path 形如 /小红书笔记归档/xxx）
  const p = store.normalizeVPath(entry.path);
  return p.startsWith(NOTE_ROOT + '/') && p.slice(NOTE_ROOT.length + 1).indexOf('/') === -1;
}

// 给列表条目附加备注字段（仅归档内子文件夹，其他条目不带）
function attachNotes(entries, vpath) {
  if (!Array.isArray(entries) || store.normalizeVPath(vpath) !== NOTE_ROOT) return entries;
  const targets = entries.filter((e) => isNoteTarget(e, vpath));
  if (!targets.length) return entries;
  const map = notes.list(targets.map((e) => e.path));
  for (const e of targets) {
    const n = map[e.path];
    e.note = n ? n.note : '';
    e.noteUpdatedAt = n ? n.updatedAt : null;
  }
  return entries;
}

function trashVirtual(user, vpath) {
  const parsed = store.parseOwnerPath(vpath);
  if (parsed.path === '/') return [];
  const items = [];
  if (parsed.ownerId) {
    if (!canModify(user, parsed.ownerId)) return [];
    const owner = auth.findUserById(parsed.ownerId);
    if (!owner) return [];
    try {
      items.push(trash.add(owner, parsed.path, user));
    } catch (err) {
      if (err.status && err.status !== 404) throw err;
    }
    return items;
  }
  const targets = [auth.findUserById(user.id)];
  if (user.role === 'admin') {
    for (const u of activeUsers()) {
      if (u.id === user.id) continue;
      targets.push(auth.findUserById(u.id));
    }
  }
  for (const owner of targets) {
    if (!owner) continue;
    try {
      if (!fs.existsSync(store.resolvePath(owner.id, parsed.path).abs)) continue;
      items.push(trash.add(owner, parsed.path, user));
    } catch (err) {
      if (err.status && err.status >= 500) throw err;
    }
  }
  return items;
}

function logTrashItems(actor, action, items, ip) {
  for (const it of items) {
    const target = it.ownerId === actor.id ? it.path : '/@' + it.ownerId + it.path;
    const kind = it.isDir ? `文件夹，${it.files || 0} 个文件` : '文件';
    const ownerNote = it.ownerId !== actor.id ? `，所属账号 ${it.ownerName}` : '';
    audit.add(actor, action, target, kind + ownerNote, ip);
  }
}

/* ---------------- 下载记录 ---------------- */
function dlStatusText(s) {
  return { downloading: '下载中', completed: '已完成', failed: '失败', canceled: '已取消' }[s] || s;
}

function dlRow(r) {
  return {
    id: r.id,
    filePath: r.file_path,
    fileName: r.file_name,
    totalBytes: r.total_bytes,
    downloadedBytes: r.downloaded_bytes,
    status: r.status,
    statusText: dlStatusText(r.status),
    speed: r.speed,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    progress: r.total_bytes > 0 ? Math.min(100, Math.round(r.downloaded_bytes / r.total_bytes * 100)) : 0,
  };
}

async function handleDownloads(req, res, user, p, m) {
  const parts = p.split('/');
  // /api/downloads  (list / start)
  if (p === '/api/downloads') {
    if (m === 'GET') {
      const rows = db.prepare(
        'SELECT * FROM downloads WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
      ).all(user.id);
      return sendJson(res, 200, { downloads: rows.map(dlRow) });
    }
    if (m === 'POST') {
      const body = await readJson(req);
      const filePath = String(body.path || '');
      const fileName = String(body.name || '');
      const totalBytes = Math.max(0, Number(body.totalBytes) || 0);
      const source = ['web', 'app'].includes(body.source) ? body.source : 'web';
      if (!filePath) return fail(res, 400, '缺少文件路径');
      const now = Date.now();
      const info = db.prepare(
        'INSERT INTO downloads (user_id, file_path, file_name, total_bytes, downloaded_bytes, status, speed, source, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?, ?)'
      ).run(user.id, filePath, fileName, totalBytes, 'downloading', source, now, now);
      const row = db.prepare('SELECT * FROM downloads WHERE id = ?').get(info.lastInsertRowid);
      return sendJson(res, 201, { download: dlRow(row) });
    }
  }
  // /api/downloads/:id  (progress / complete / fail / delete)
  const idMatch = /^\/api\/downloads\/(\d+)$/.exec(p);
  if (idMatch) {
    const id = Number(idMatch[1]);
    const row = db.prepare('SELECT * FROM downloads WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!row) return fail(res, 404, '下载记录不存在');
    if (m === 'PUT') {
      const body = await readJson(req);
      const downloadedBytes = Math.max(0, Number(body.downloadedBytes) || 0);
      const speed = Math.max(0, Number(body.speed) || 0);
      const status = body.status || (downloadedBytes >= row.total_bytes ? 'completed' : 'downloading');
      db.prepare(
        'UPDATE downloads SET downloaded_bytes = ?, speed = ?, status = ?, updated_at = ? WHERE id = ?'
      ).run(downloadedBytes, speed, status, Date.now(), id);
      const upd = db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
      return sendJson(res, 200, { download: dlRow(upd) });
    }
    if (m === 'POST') {
      const body = await readJson(req);
      const action = String(body.action || '');
      if (action === 'complete') {
        const total = row.total_bytes > 0 ? row.total_bytes : row.downloaded_bytes;
        db.prepare(
          'UPDATE downloads SET status = ?, downloaded_bytes = ?, completed_at = ?, updated_at = ? WHERE id = ?'
        ).run('completed', total, Date.now(), Date.now(), id);
      } else if (action === 'fail') {
        db.prepare('UPDATE downloads SET status = ?, updated_at = ? WHERE id = ?').run('failed', Date.now(), id);
      } else if (action === 'cancel') {
        db.prepare('UPDATE downloads SET status = ?, updated_at = ? WHERE id = ?').run('canceled', Date.now(), id);
      }
      const upd = db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
      return sendJson(res, 200, { download: dlRow(upd) });
    }
    if (m === 'DELETE') {
      db.prepare('DELETE FROM downloads WHERE id = ? AND user_id = ?').run(id, user.id);
      return sendJson(res, 200, { ok: true });
    }
  }
  return fail(res, 404, '未知下载接口');
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') searchIndex.invalidate();

  const shareMatch = /^\/api\/s\/([A-Za-z0-9]+)\/(info|verify|list|download|preview|text|zip)$/.exec(p);
  if (shareMatch) {
    try {
      return await handleShareApi(req, res, url, shareMatch[1], shareMatch[2]);
    } catch (err) {
      return fail(res, err.status || 500, err.message || '服务器错误');
    }
  }

  if (p === '/api/register' && m === 'POST') {
    if (!ALLOW_REGISTER) return fail(res, 403, '管理员已关闭公开注册');
    const body = await readJson(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const department = String(body.department || '').trim();
    const phone = sms.normalizePhone(body.phone);
    const invalid = auth.validateCredentials(username, password);
    if (invalid) return fail(res, 400, invalid);
    const deptError = auth.validateDepartment(department);
    if (deptError) return fail(res, 400, deptError);
    const phoneError = sms.validatePhone(phone);
    if (phoneError) return fail(res, 400, phoneError);
    if (auth.findUserByName(username)) return fail(res, 409, '用户名已被占用');
    if (auth.findUserByPhone(phone)) return fail(res, 409, '该手机号已被绑定');
    const userId = auth.createUser(username, password, department, phone);
    const user = auth.findUserById(userId);
    audit.addRaw(
      username,
      'register',
      '',
      `部门：${department}，手机号：${sms.maskPhone(phone)}${
        user.status === 'active' ? '，自动通过' : '，待审核'
      }`,
      audit.clientIp(req),
      userId
    );
    if (user.status === 'active') {
      const session = auth.createSession(userId);
      setSessionCookie(res, session.token, 7 * 24 * 3600);
      autoFolders.ensureForUser(userId);
      return sendJson(res, 201, { user: publicUser(user), usage: 0 });
    }
    return sendJson(res, 201, {
      pending: true,
      user: publicUser(user),
      message: '注册成功，请等待管理员审核通过后再登录',
    });
  }

  if (p === '/api/sms/send' && m === 'POST') {
    const body = await readJson(req);
    const phone = sms.normalizePhone(body.phone);
    const purpose = body.purpose === 'reset' ? 'reset' : body.purpose === 'bind' ? 'bind' : 'login';
    const invalid = sms.validatePhone(phone);
    if (invalid) return fail(res, 400, invalid);
    if (purpose === 'bind') {
      const me = currentUser(req);
      if (!me) return fail(res, 401, '请先登录');
      if (me.phone) return fail(res, 400, '当前账号已绑定手机号');
      if (auth.findUserByPhone(phone)) return fail(res, 409, '该手机号已被其他账号绑定');
      try {
        return sendJson(res, 200, await sms.sendCode(phone, 'bind', audit.clientIp(req)));
      } catch (err) {
        return fail(res, err.status || 500, err.message || '验证码发送失败');
      }
    }
    const target = auth.findUserByPhone(phone);
    if (!target) return fail(res, 404, '该手机号未绑定账号，请联系管理员');
    if (target.status !== 'active') return fail(res, 403, '该账号未启用，请联系管理员');
    try {
      return sendJson(res, 200, await sms.sendCode(phone, purpose, audit.clientIp(req)));
    } catch (err) {
      return fail(res, err.status || 500, err.message || '验证码发送失败');
    }
  }

  if (p === '/api/sms/login' && m === 'POST') {
    const body = await readJson(req);
    const phone = sms.normalizePhone(body.phone);
    const check = sms.verifyCode(phone, 'login', body.code);
    if (!check.ok) return fail(res, 400, check.reason);
    const target = auth.findUserByPhone(phone);
    if (!target) return fail(res, 404, '该手机号未绑定账号');
    if (target.status !== 'active') return fail(res, 403, '该账号未启用，请联系管理员');
    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), target.id);
    const session = auth.createSession(target.id);
    const rememberSms = body.remember !== false;
    setSessionCookie(res, session.token, rememberSms ? auth.sessionTtlSeconds() : 0);
    audit.add(target, 'sms_login', '', `手机验证码登录（${sms.maskPhone(phone)}）`, audit.clientIp(req));
    return sendJson(res, 200, {
      user: publicUser(auth.findUserById(target.id)),
      usage: store.usage(target.id),
    });
  }

  if (p === '/api/sms/reset' && m === 'POST') {
    const body = await readJson(req);
    const phone = sms.normalizePhone(body.phone);
    const password = String(body.password || '');
    const invalid = sms.validatePhone(phone);
    if (invalid) return fail(res, 400, invalid);
    if (!password || password.length < 6 || password.length > 128) {
      return fail(res, 400, '密码长度需为 6-128 位');
    }
    const target = auth.findUserByPhone(phone);
    if (!target) return fail(res, 404, '该手机号未绑定账号');
    if (target.status !== 'active') return fail(res, 403, '该账号未启用，请联系管理员');
    const check = sms.verifyCode(phone, 'reset', body.code);
    if (!check.ok) return fail(res, 400, check.reason);
    auth.updatePassword(target.id, password);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    audit.add(target, 'reset_password', '', '通过手机验证码重置密码', audit.clientIp(req));
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/login' && m === 'POST') {
    const body = await readJson(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return fail(res, 400, '请输入账号和密码');
    let user = auth.findUserByName(username);
    if (!user && /^1[3-9]\d{9}$/.test(username)) user = auth.findUserByPhone(username);
    if (!user || !auth.verifyPassword(password, user.salt, user.pass_hash)) {
      const logName = /^1[3-9]\d{9}$/.test(username) ? sms.maskPhone(username) : username;
      audit.addRaw(logName, 'login_fail', '', user ? '密码错误' : '账号不存在', audit.clientIp(req));
      return fail(res, 401, '账号或密码错误');
    }
    if (user.status === 'pending') {
      return fail(res, 403, '账号正在等待管理员审核，审核通过后才能登录');
    }
    if (user.status === 'rejected') {
      return fail(res, 403, '注册申请未通过审核');
    }
    if (user.status === 'disabled') {
      return fail(res, 403, '账号已被停用，请联系管理员');
    }
    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id);
    const session = auth.createSession(user.id);
    const remember = body.remember !== false;
    setSessionCookie(res, session.token, remember ? auth.sessionTtlSeconds() : 0);
    autoFolders.ensureForUser(user.id);
    audit.add(user, 'login', '', '登录成功', audit.clientIp(req));
    return sendJson(res, 200, {
      user: publicUser(user),
      usage: store.usage(user.id),
      needPhone: !user.phone,
    });
  }

  if (p === '/api/logout' && m === 'POST') {
    const cookies = auth.parseCookies(req.headers.cookie);
    const me = auth.userBySession(cookies[SESSION_COOKIE]);
    auth.destroySession(cookies[SESSION_COOKIE]);
    clearSessionCookie(res);
    if (me) audit.add(me, 'logout', '', '退出登录', audit.clientIp(req));
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/me' && m === 'GET') {
    const me = currentUser(req);
    if (!me) return sendJson(res, 200, { user: null, usage: 0 });
    return sendJson(res, 200, {
      user: publicUser(me),
      usage: store.usage(me.id),
      needPhone: !me.phone,
    });
  }

  const user = requireUser(req, res);
  if (!user) return;

  if (!user.phone && p !== '/api/account/bind-phone') {
    return sendJson(res, 403, { error: '请先补充手机号', needPhone: true });
  }

  try {
    if (p === '/api/account/bind-phone' && m === 'POST') {
      const body = await readJson(req);
      if (user.phone) return fail(res, 400, '当前账号已绑定手机号');
      const phone = sms.normalizePhone(body.phone);
      const invalid = sms.validatePhone(phone);
      if (invalid) return fail(res, 400, invalid);
      const exists = auth.findUserByPhone(phone);
      if (exists && exists.id !== user.id) return fail(res, 409, '该手机号已被其他账号绑定');
      db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, user.id);
      audit.add(user, 'bind_phone', '', `绑定手机号 ${sms.maskPhone(phone)}`, audit.clientIp(req));
      return sendJson(res, 200, { ok: true, user: publicUser(auth.findUserById(user.id)) });
    }

    if (p === '/api/account/password' && m === 'POST') {
      const body = await readJson(req);
      const oldPassword = String(body.oldPassword || '');
      const newPassword = String(body.newPassword || '');
      const full = auth.findUserByName(user.username);
      if (!full || !auth.verifyPassword(oldPassword, full.salt, full.pass_hash)) {
        return fail(res, 400, '当前密码错误');
      }
      if (!newPassword || newPassword.length < 6 || newPassword.length > 128) {
        return fail(res, 400, '新密码长度需为 6-128 位');
      }
      if (newPassword === oldPassword) return fail(res, 400, '新密码不能与当前密码相同');
      auth.updatePassword(user.id, newPassword);
      const cookies = auth.parseCookies(req.headers.cookie);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(
        user.id,
        cookies[SESSION_COOKIE] || ''
      );
      audit.add(user, 'change_password', '', '登录后修改密码', audit.clientIp(req));
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/search' && m === 'GET') {
      const keyword = url.searchParams.get('q') || '';
      if (!keyword.trim()) return sendJson(res, 200, { items: [], total: 0, keyword: '' });
      const result = searchIndex.query(keyword, activeUsers());
      const items = result.items.filter((it) => permissions.canAccess(user.id, it.path));
      return sendJson(res, 200, { ...result, items });
    }

    if (p === '/api/list' && m === 'GET') {
      const vpath = store.normalizeVPath(url.searchParams.get('path') || '/');
      if (vpath === temp.VROOT || vpath.startsWith(temp.VROOT + '/')) {
        if (user.role !== 'admin') return fail(res, 403, '无权访问');
        if (vpath === temp.VROOT) {
          return sendJson(res, 200, { path: vpath, entries: temp.listBatches(activeUsers()) });
        }
        const parsed = temp.parseVirtual(vpath);
        const owner = parsed && auth.findUserById(parsed.ownerId);
        if (!owner) return fail(res, 404, '临时文件夹不存在');
        if (!parsed.batch) {
          return sendJson(res, 200, { path: vpath, entries: temp.listBatches([owner]) });
        }
        return sendJson(res, 200, {
          path: vpath,
          entries: temp.listEntries(owner.id, owner.username, parsed),
        });
      }
      const ownerParam = Number(url.searchParams.get('ownerId') || 0);
      if (ownerParam) {
        const owner = auth.findUserById(ownerParam);
        if (!owner) return fail(res, 404, '账号不存在');
        if (!canModify(user, ownerParam)) return fail(res, 403, '无权访问该账号文件夹');
        const result = store.listDir(ownerParam, vpath);
        result.entries = permissions.filterEntries(ownerParam, result.entries, result.path);
        return sendJson(res, 200, { path: result.path, entries: attachNotes(result.entries, result.path), ownerId: ownerParam });
      }
      const entries = attachNotes(permissions.filterEntries(user.id, store.listMerged(activeUsers(), vpath), vpath), vpath);
      if (vpath === '/' && user.role === 'admin') {
        const pending = temp.countPending();
        if (pending.batches > 0) {
          entries.push({
            name: '未归档',
            isDir: true,
            path: temp.VROOT,
            size: 0,
            mtime: Date.now(),
            temp: true,
            count: pending.total,
            batches: pending.batches,
          });
        }
      }
      return sendJson(res, 200, { path: vpath, entries });
    }

    if (p === '/api/download-batch' && m === 'POST') {
      if (isWechat(req)) return wechatDownloadGuide(res, '');
      const ctype = String(req.headers['content-type'] || '');
      let paths = [];
      if (ctype.includes('urlencoded')) {
        // 表单提交（浏览器原生下载通道，form POST 流式保存）
        const params = new URLSearchParams(await readText(req));
        try { paths = JSON.parse(params.get('paths') || '[]'); } catch { paths = []; }
      } else {
        const body = await readJson(req);
        paths = Array.isArray(body.paths) ? body.paths : [];
      }
      if (!Array.isArray(paths)) paths = [];
      paths = paths.map(String).slice(0, 100);
      if (!paths.length) return fail(res, 400, '请选择要下载的文件');
      const items = [];
      const usedNames = new Set();
      for (const raw of paths) {
        const info = targetOf(user, String(raw));
        if (!info.target) return fail(res, 404, '文件所属账号不存在');
        if (!permissions.canAccess(user.id, info.path)) return fail(res, 403, '无权下载该文件');
        const { abs } = store.resolvePath(info.ownerId, info.path);
        if (!fs.existsSync(abs)) return fail(res, 404, '文件不存在');
        const isDir = fs.statSync(abs).isDirectory();
        let name = store.baseName(info.path);
        if (usedNames.has(name.toLowerCase())) {
          const ext = isDir ? '' : path.extname(name);
          const base = isDir ? name : name.slice(0, name.length - ext.length);
          let i = 1;
          while (usedNames.has(`${base} (${i})${ext}`.toLowerCase())) i += 1;
          name = `${base} (${i})${ext}`;
        }
        usedNames.add(name.toLowerCase());
        items.push({ abs, name, isDirectory: isDir });
      }
      const zipPath = path.join(TMP_DIR, `batch-${user.id}-${Date.now()}.zip`);
      try {
        await buildZipMulti(items, zipPath);
      } catch (err) {
        fs.rmSync(zipPath, { force: true });
        return fail(res, err.status || 500, err.message || '打包失败');
      }
      const zipStat = fs.statSync(zipPath);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': zipStat.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('批量下载.zip')}`,
        'Cache-Control': 'no-store',
      });
      const cleanup = () => fs.rmSync(zipPath, { force: true });
      const stream = fs.createReadStream(zipPath);
      stream.on('close', cleanup);
      stream.on('error', cleanup);
      res.on('close', cleanup);
      stream.pipe(res);
      return;
    }

    if (p === '/api/recent' && m === 'GET') {
      const entries = [];
      for (const u of activeUsers()) {
        for (const e of store.recentFiles(u.id, 100)) {
          entries.push({ ...e, path: '/@' + u.id + e.path, ownerId: u.id, ownerName: u.username });
        }
      }
      const filtered = permissions.filterRecent(user.id, entries);
      filtered.sort((a, b) => b.mtime - a.mtime);
      return sendJson(res, 200, { entries: filtered.slice(0, 80) });
    }

    if (p === '/api/mkdir' && m === 'POST') {
      const body = await readJson(req);
      const entry = store.mkdir(user.id, body.parent || '/', body.name);
      audit.add(user, 'mkdir', entry.path, '', audit.clientIp(req));
      return sendJson(res, 201, { entry });
    }

    // 保存/清除文件夹备注（仅「小红书笔记归档」内的子文件夹）
    if (p === '/api/folder-note' && m === 'POST') {
      const body = await readJson(req);
      const vpath = store.normalizeVPath(body.path || '');
      if (vpath === '/' || vpath === NOTE_ROOT) return fail(res, 400, '只能给归档内的子文件夹添加备注');
      // 编辑权限：管理员 + 备注白名单账号（如叶子馨），不受文件夹归属限制
      if (!canEditNoteUser(user)) return fail(res, 403, '只有管理员和叶子馨可以编辑备注');
      const parsed = store.parseOwnerPath(vpath);
      const dirV = parsed.path;
      if (dirV === NOTE_ROOT || !dirV.startsWith(NOTE_ROOT + '/') || dirV.slice(NOTE_ROOT.length + 1).indexOf('/') !== -1) {
        return fail(res, 400, '只能给归档内的子文件夹添加备注');
      }
      if (!permissions.canAccess(user.id, dirV)) return fail(res, 403, '无权访问该文件夹');
      // 合并视图下文件夹 path 不带 ownerId，且归档文件夹通常归管理员所有。
      // 在「路径显式指定的账号 → 当前账号 → 所有活跃账号」中查找真实存在的该目录，
      // 找到即视为有效（备注按 path 共享，谁编辑都写到同一条）。
      let abs = null;
      const candidates = [];
      if (parsed.ownerId) candidates.push(parsed.ownerId);
      candidates.push(user.id);
      for (const u of activeUsers()) if (!candidates.includes(u.id)) candidates.push(u.id);
      for (const oid of candidates) {
        if (!auth.findUserById(oid)) continue;
        const resolved = store.resolvePath(oid, dirV);
        if (fs.existsSync(resolved.abs) && fs.statSync(resolved.abs).isDirectory()) {
          abs = resolved.abs;
          break;
        }
      }
      if (!abs) return fail(res, 404, '文件夹不存在');
      const noteText = body.note == null ? '' : String(body.note);
      if (noteText.length > notes.MAX_NOTE) return fail(res, 413, `备注不能超过 ${notes.MAX_NOTE} 字`);
      const saved = notes.set(dirV, noteText, user.id);
      audit.add(user, 'folder_note', dirV, saved.note ? `设置备注：${saved.note.slice(0, 60)}` : '清除备注', audit.clientIp(req));
      return sendJson(res, 200, { path: dirV, ...saved });
    }

    if (p === '/api/upload' && (m === 'PUT' || m === 'POST')) {
      return await handleUpload(req, res, user, url);
    }

    if (p.startsWith('/api/downloads')) {
      return handleDownloads(req, res, user, p, m);
    }

    if (p === '/api/download' && (m === 'GET' || m === 'HEAD')) {
      const vpath = store.normalizeVPath(url.searchParams.get('path'));
      const info = targetOf(user, vpath);
      if (!info.target) return fail(res, 404, '文件所属账号不存在');
      if (!permissions.canAccess(user.id, info.path)) return fail(res, 403, '无权访问该文件');
      const { abs } = store.resolvePath(info.ownerId, info.path);
      if (!fs.existsSync(abs)) return fail(res, 404, '文件不存在');
      if (fs.statSync(abs).isDirectory()) {
        const zipPath = path.join(TMP_DIR, `dl-${user.id}-${Date.now()}.zip`);
        try {
          await buildZipFile(abs, store.baseName(info.path) || 'download', zipPath);
        } catch (err) {
          fs.rmSync(zipPath, { force: true });
          return fail(res, err.status || 500, err.message || '打包失败');
        }
        const zipStat = fs.statSync(zipPath);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': zipStat.size,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(
            (store.baseName(info.path) || 'download') + '.zip'
          )}`,
          'Cache-Control': 'no-store',
        });
        const cleanup = () => fs.rmSync(zipPath, { force: true });
        const stream = fs.createReadStream(zipPath);
        stream.on('close', cleanup);
        stream.on('error', cleanup);
        res.on('close', cleanup);
        stream.pipe(res);
        return;
      }
      const isImage = /^image\//i.test(store.mimeOf(store.baseName(vpath)));
      if (isPCWechat(req)) {
        return serveFileRange(req, res, abs, store.baseName(info.path), false);
      }
      if (isWechat(req) && !isImage) {
        return wechatDownloadGuide(res, wechatOrigin(req) + req.url);
      }
      return serveFileRange(req, res, abs, store.baseName(info.path), isWechat(req));
    }

    if (p === '/api/thumb' && m === 'GET') {
      const vpath = store.normalizeVPath(url.searchParams.get('path'));
      const info = targetOf(user, vpath);
      if (!info.target) return fail(res, 404, '文件所属账号不存在');
      if (!permissions.canAccess(user.id, info.path)) return fail(res, 403, '无权访问该文件');
      const { abs } = store.resolvePath(info.ownerId, info.path);
      if (!fs.existsSync(abs)) return fail(res, 404, '文件不存在');
      if (fs.statSync(abs).isDirectory()) return fail(res, 400, '不是文件');
      const width = Math.min(720, Math.max(120, Number(url.searchParams.get('w') || 360)));
      const item = await thumb.getThumbAsync(abs, width);
      if (!item) return fail(res, 415, '该格式不支持缩略图');
      const data = fs.readFileSync(item.file);
      res.writeHead(200, {
        'Content-Type': item.type,
        'Content-Length': data.length,
        'Cache-Control': 'private, max-age=86400',
      });
      return res.end(data);
    }

    if (p === '/api/preview' && (m === 'GET' || m === 'HEAD')) {
      const vpath = store.normalizeVPath(url.searchParams.get('path'));
      const info = targetOf(user, vpath);
      if (!info.target) return fail(res, 404, '文件所属账号不存在');
      if (!permissions.canAccess(user.id, info.path)) return fail(res, 403, '无权访问该文件');
      const { abs } = store.resolvePath(info.ownerId, info.path);
      if (!fs.existsSync(abs)) return fail(res, 404, '文件不存在');
      if (fs.statSync(abs).isDirectory()) return fail(res, 400, '不是文件');
      return serveFileRange(req, res, abs, store.baseName(info.path), true);
    }

    if (p === '/api/doc' && m === 'GET') {
      const vpath = store.normalizeVPath(url.searchParams.get('path'));
      const info = targetOf(user, vpath);
      if (!info.target) return fail(res, 404, '文件所属账号不存在');
      if (!permissions.canAccess(user.id, info.path)) return fail(res, 403, '无权访问该文件');
      const { abs } = store.resolvePath(info.ownerId, info.path);
      if (!fs.existsSync(abs)) return fail(res, 404, '文件不存在');
      const st = fs.statSync(abs);
      if (st.isDirectory()) return fail(res, 400, '不是文件');
      const ext = path.extname(abs).toLowerCase();
      if (ext !== '.doc' && ext !== '.docx') return fail(res, 400, '不是 Word 文档');
      if (st.size > 30 * 1024 * 1024) return fail(res, 413, '文档超过 30MB，无法在线预览');
      try {
        const extractor = new WordExtractor();
        const doc = await extractor.extract(abs);
        let text = String(doc.getBody() || '')
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n');
        if (text.length > 2000000) text = text.slice(0, 2000000);
        return sendJson(res, 200, { name: path.basename(abs), text, chars: text.length });
      } catch (err) {
        return fail(res, 415, `无法解析该文档：${String(err.message || '').slice(0, 120)}`);
      }
    }

    if (p === '/api/text' && m === 'GET') {
      const vpath = store.normalizeVPath(url.searchParams.get('path'));
      const info = targetOf(user, vpath);
      if (!info.target) return fail(res, 404, '文件所属账号不存在');
      if (!permissions.canAccess(user.id, info.path)) return fail(res, 403, '无权访问该文件');
      const { abs } = store.resolvePath(info.ownerId, info.path);
      if (!fs.existsSync(abs)) return fail(res, 404, '文件不存在');
      const st = fs.statSync(abs);
      if (st.isDirectory()) return fail(res, 400, '不是文件');
      if (st.size > 2 * 1024 * 1024) return fail(res, 413, '文件超过 2MB，无法在线查看');
      return sendJson(res, 200, { text: fs.readFileSync(abs, 'utf8'), name: store.baseName(info.path) });
    }

    if (p === '/api/save' && m === 'POST') {
      const body = await readJson(req);
      const info = targetOf(user, body.path);
      if (!info.target) return fail(res, 404, '文件所属账号不存在');
      if (!canModify(user, info.ownerId)) return fail(res, 403, '只能编辑自己上传的文件');
      try {
        const result = await textdoc.save(info.ownerId, info.path, body.text);
        searchIndex.invalidate();
        audit.add(
          user,
          'edit',
          info.path,
          `在线编辑保存${result.backupName ? '，旧版备份为 ' + result.backupName : ''}` +
            (result.converted ? '，已转换为 .docx' : ''),
          audit.clientIp(req)
        );
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        return fail(res, err.status || 500, err.message || '保存失败');
      }
    }

    if (p === '/api/delete' && m === 'POST') {
      const body = await readJson(req);
      const rawPath = String(body.path || '');
      if (rawPath === temp.VROOT || rawPath.startsWith(temp.VROOT + '/')) {
        const items = deleteVirtual(user, rawPath);
        if (!items.length) return fail(res, 404, '文件或文件夹不存在，或无权删除');
        logTrashItems(user, 'delete', items, audit.clientIp(req));
        return sendJson(res, 200, {
          ok: true,
          deleted: items.length,
          trash: false,
          keepDays: 0,
          usage: store.usage(user.id),
        });
      }
      let items;
      try {
        items = trashVirtual(user, body.path);
      } catch (err) {
        return fail(res, err.status || 500, err.message || '删除失败');
      }
      if (!items.length) return fail(res, 404, '文件或文件夹不存在，或无权删除');
      logTrashItems(user, 'delete', items, audit.clientIp(req));
      return sendJson(res, 200, {
        ok: true,
        deleted: items.length,
        trash: true,
        keepDays: trash.KEEP_DAYS,
        usage: store.usage(user.id),
      });
    }

    if (p === '/api/delete-batch' && m === 'POST') {
      const body = await readJson(req);
      const paths = Array.isArray(body.paths) ? body.paths : [];
      if (!paths.length) return fail(res, 400, '请选择要删除的文件');
      if (paths.length > 100) return fail(res, 400, '一次最多删除 100 项');
      const items = [];
      for (const item of paths) {
        try {
          if (String(item) === temp.VROOT || String(item).startsWith(temp.VROOT + '/')) {
            items.push(...deleteVirtual(user, item));
          } else {
            items.push(...trashVirtual(user, item));
          }
        } catch {
          /* skip */
        }
      }
      if (!items.length) return fail(res, 404, '所选文件不存在，或无权删除');
      logTrashItems(user, 'delete', items, audit.clientIp(req));
      return sendJson(res, 200, {
        ok: true,
        deleted: items.length,
        trash: true,
        keepDays: trash.KEEP_DAYS,
        usage: store.usage(user.id),
      });
    }

    if (p === '/api/trash' && m === 'GET') {
      const ownerId = Number(url.searchParams.get('userId') || 0) || null;
      return sendJson(res, 200, trash.listFor(user, { ownerId }));
    }

    if (p === '/api/trash/restore' && m === 'POST') {
      const body = await readJson(req);
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 50) : [];
      if (!ids.length) return fail(res, 400, '请选择要恢复的文件');
      const ip = audit.clientIp(req);
      const restored = [];
      const errors = [];
      for (const id of ids) {
        try {
          const it = trash.restore(user, id);
          const target = it.ownerId === user.id ? it.path : '/@' + it.ownerId + it.path;
          audit.add(user, 'restore', target, it.ownerId !== user.id ? '所属账号 ' + it.ownerName : '', ip);
          restored.push(it);
        } catch (err) {
          errors.push({ id, error: err.message || '恢复失败' });
        }
      }
      return sendJson(res, 200, {
        ok: true,
        restored: restored.length,
        errors,
        items: restored,
        usage: store.usage(user.id),
      });
    }

    if (p === '/api/trash/purge' && m === 'POST') {
      const body = await readJson(req);
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 50) : [];
      if (!ids.length) return fail(res, 400, '请选择要删除的文件');
      const ip = audit.clientIp(req);
      const purged = [];
      const errors = [];
      for (const id of ids) {
        try {
          const it = trash.purge(user, id);
          const target = it.ownerId === user.id ? it.path : '/@' + it.ownerId + it.path;
          audit.add(user, 'purge', target, it.ownerId !== user.id ? '所属账号 ' + it.ownerName : '', ip);
          purged.push(it);
        } catch (err) {
          errors.push({ id, error: err.message || '删除失败' });
        }
      }
      return sendJson(res, 200, { ok: true, purged: purged.length, errors, usage: store.usage(user.id) });
    }

    if (p === '/api/rename' && m === 'POST') {
      const body = await readJson(req);
      const info = targetOf(user, body.path);
      if (!info.target) return fail(res, 404, '文件所属账号不存在');
      if (!canModify(user, info.ownerId)) return fail(res, 403, '只能修改自己上传的文件');
      const nextPath = store.rename(info.ownerId, info.path, body.name);
      // 文件夹备注随重命名迁移（仅归档路径）
      if (!info.virtual && info.path !== nextPath) notes.moveTree(info.path, nextPath);
      audit.add(user, 'rename', info.path, '重命名为 ' + String(body.name || ''), audit.clientIp(req));
      return sendJson(res, 200, {
        ok: true,
        path: info.ownerId === user.id ? nextPath : '/@' + info.ownerId + nextPath,
      });
    }

    if (p === '/api/move' && m === 'POST') {
      const body = await readJson(req);
      const from = targetOf(user, body.from);
      if (!from.target || !canModify(user, from.ownerId)) return fail(res, 403, '只能移动自己上传的文件');
      const toPath = store.normalizeVPath(body.to);
      const toInfo = store.resolvePath(from.ownerId, toPath);
      if (!fs.existsSync(toInfo.abs) || !fs.statSync(toInfo.abs).isDirectory()) {
        return fail(res, 404, '目标文件夹不存在');
      }
      if (!permissions.canAccess(from.ownerId, toPath)) return fail(res, 403, '无权移动到该文件夹');
      const nextPath = store.move(from.ownerId, from.path, toPath);
      // 文件夹备注随移动迁移（moveTree 内部会删旧路径，勿先 removeTree）
      if (!from.virtual && from.path !== nextPath) notes.moveTree(from.path, nextPath);
      if (from.virtual && from.batch) temp.cleanupBatch(from.ownerId, from.batch);
      audit.add(user, 'move', from.path, '移动到 ' + toPath, audit.clientIp(req));
      return sendJson(res, 200, {
        ok: true,
        path: from.ownerId === user.id ? nextPath : '/@' + from.ownerId + nextPath,
        to: toPath,
      });
    }

    if (p === '/api/move-batch' && m === 'POST') {
      const body = await readJson(req);
      const paths = Array.isArray(body.paths) ? body.paths.slice(0, 100) : [];
      const toPath = store.normalizeVPath(body.to || '');
      if (!paths.length) return fail(res, 400, '请选择要移动的文件');
      if (!toPath) return fail(res, 400, '请选择目标文件夹');
      const moved = [];
      const errors = [];
      for (const raw of paths) {
        const info = targetOf(user, String(raw));
        if (!info.target || !canModify(user, info.ownerId)) {
          errors.push(`${raw}：无权移动`);
          continue;
        }
        const toInfo = store.resolvePath(info.ownerId, toPath);
        if (!fs.existsSync(toInfo.abs) || !fs.statSync(toInfo.abs).isDirectory()) {
          errors.push(`${raw}：目标文件夹不存在`);
          break;
        }
        if (!permissions.canAccess(info.ownerId, toPath)) {
          errors.push(`${raw}：无权移动到该文件夹`);
          break;
        }
        try {
          const nextPath = store.move(info.ownerId, info.path, toPath);
          if (info.virtual && info.batch) temp.cleanupBatch(info.ownerId, info.batch);
          audit.add(user, 'move', info.path, '批量移动到 ' + toPath, audit.clientIp(req));
          moved.push(info.ownerId === user.id ? nextPath : '/@' + info.ownerId + nextPath);
        } catch (err) {
          errors.push(`${raw}：${err.message}`);
        }
      }
      if (!moved.length) return fail(res, 400, errors[0] || '移动失败');
      return sendJson(res, 200, { ok: true, moved: moved.length, errors, usage: store.usage(user.id) });
    }

    if (p === '/api/copy' && m === 'POST') {
      const body = await readJson(req);
      const from = targetOf(user, body.from);
      if (!from.target) return fail(res, 404, '文件所属账号不存在');
      if (from.virtual) return fail(res, 400, '临时文件夹不支持复制');
      // 读权限：按请求者判断（与 preview / download / thumb 一致），管理员恒通过
      if (!permissions.canAccess(user.id, from.path)) return fail(res, 403, '无权访问该文件');
      // 源空间写权限：本人或管理员
      if (!canModify(user, from.ownerId)) return fail(res, 403, '只能复制自己空间内的文件');

      // 目标空间：支持 /@账号ID/目录 跨账号指定（管理员归档他人文件用），
      // 未指定时默认落在源文件所属账号，保持原有行为
      const rawTo = store.normalizeVPath(body.to);
      const toOwnerParsed = store.parseOwnerPath(rawTo);
      const destOwnerId = toOwnerParsed.ownerId || from.ownerId;
      const destPath = toOwnerParsed.path;
      const destOwner = auth.findUserById(destOwnerId);
      if (!destOwner) return fail(res, 404, '目标账号不存在');
      if (!canModify(user, destOwnerId)) return fail(res, 403, '只能复制到自己有写权限的空间');
      const toInfo = store.resolvePath(destOwnerId, destPath);
      if (!fs.existsSync(toInfo.abs) || !fs.statSync(toInfo.abs).isDirectory()) {
        return fail(res, 404, '目标文件夹不存在');
      }
      // 目标文件夹权限：管理员不受文件夹授权限制；普通用户按自己的授权判断
      if (user.role !== 'admin' && !permissions.canAccess(destOwnerId, destPath)) {
        return fail(res, 403, '无权复制到该文件夹');
      }

      const srcAbs = store.resolvePath(from.ownerId, from.path).abs;
      if (!fs.existsSync(srcAbs)) return fail(res, 404, '文件不存在');
      // 配额：副本占用「目标账号」的空间，目录按全树大小、文件按实际大小
      const srcStat = fs.statSync(srcAbs);
      const size = srcStat.isDirectory()
        ? store.dirSize(from.ownerId, from.path)
        : srcStat.size;
      const used = store.usage(destOwnerId);
      if (used + size > destOwner.quota) return fail(res, 413, '存储空间不足');

      const nextPath = store.copyAcross(from.ownerId, from.path, destOwnerId, destPath, body.name);
      const seenFrom = from.ownerId === user.id ? from.path : '/@' + from.ownerId + from.path;
      const seenTo = destOwnerId === user.id ? destPath : '/@' + destOwnerId + destPath;
      audit.add(user, 'copy', seenFrom, '复制到 ' + seenTo, audit.clientIp(req));
      return sendJson(res, 200, {
        ok: true,
        path: destOwnerId === user.id ? nextPath : '/@' + destOwnerId + nextPath,
        usage: store.usage(destOwnerId),
      });
    }

    if (p === '/api/share' && m === 'POST') {
      const body = await readJson(req);
      const info = targetOf(user, body.path);
      if (!info.target) return fail(res, 404, '文件所属账号不存在');
      if (info.virtual) return fail(res, 400, '临时文件夹不支持创建分享');
      if (info.path === '/') return fail(res, 400, '不能分享根目录');
      const { abs } = store.resolvePath(info.ownerId, info.path);
      if (!fs.existsSync(abs)) return fail(res, 404, '文件不存在');
      const st = fs.statSync(abs);
      const isDir = st.isDirectory();
      const password = body.password ? String(body.password).slice(0, 16) : null;
      let days = Number(body.expiresDays || 0);
      if (isDir) {
        if (!password) return fail(res, 400, '文件夹分享必须设置提取码');
        days = 1;
      }
      const expiresAt = days > 0 ? Date.now() + Math.min(days, 365) * 24 * 3600 * 1000 : null;
      const token = crypto.randomBytes(7).toString('hex');
      db.prepare(
        'INSERT INTO shares (token, user_id, path, name, is_dir, password, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(token, info.ownerId, info.path, store.baseName(info.path), isDir ? 1 : 0, password, expiresAt, Date.now());
      audit.add(
        user,
        'share',
        info.path,
        `创建分享${password ? '（有提取码）' : ''}${expiresAt ? '，有效期至 ' + new Date(expiresAt).toLocaleDateString('zh-CN') : ''}`,
        audit.clientIp(req)
      );
      return sendJson(res, 201, {
        share: { token, path: info.path, name: store.baseName(info.path), isDir: st.isDirectory(), password: !!password, expiresAt },
      });
    }

    if (p === '/api/shares' && m === 'GET') {
      const rows = db
        .prepare('SELECT * FROM shares WHERE user_id = ? ORDER BY created_at DESC')
        .all(user.id)
        .filter((r) => !r.expires_at || r.expires_at > Date.now())
        .map((r) => ({
          token: r.token,
          path: r.path,
          name: r.name,
          isDir: !!r.is_dir,
          hasPassword: !!r.password,
          expiresAt: r.expires_at,
          createdAt: r.created_at,
          downloads: r.downloads,
        }));
      return sendJson(res, 200, { shares: rows });
    }

    if (p === '/api/share/delete' && m === 'POST') {
      const body = await readJson(req);
      const token = String(body.token || '');
      const row = db.prepare('SELECT name, path FROM shares WHERE token = ? AND user_id = ?').get(token, user.id);
      db.prepare('DELETE FROM shares WHERE token = ? AND user_id = ?').run(token, user.id);
      if (row) audit.add(user, 'share_delete', row.path, '取消分享 ' + row.name, audit.clientIp(req));
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/batch/start' && m === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 201, batches.start(user, body.path, body.type));
    }

    if (p === '/api/batch/file' && m === 'PUT') {
      const batchId = url.searchParams.get('batchId') || '';
      const index = url.searchParams.get('index');
      const name = url.searchParams.get('name') || 'image.jpg';
      const result = await batches.addFile(user, batchId, index, name, req);
      return sendJson(res, 200, result);
    }

    if (p === '/api/batch/describe' && m === 'POST') {
      const body = await readJson(req);
      const folder = store.normalizeVPath(body.folder || '');
      if (!folder || folder === '/') return fail(res, 400, '缺少图片文件夹');
      const projects = (Array.isArray(body.projects) ? body.projects : []).filter(
        (x) => DESCRIBE_PROJECTS[x]
      );
      if (!projects.length) return fail(res, 400, '请选择施工项目');
      const needsBrand = projects.some((x) => x !== 'mod');
      const brands = (Array.isArray(body.brands) ? body.brands : []).filter((x) =>
        DESCRIBE_BRANDS.includes(x)
      );
      if (needsBrand && !brands.length) return fail(res, 400, '请选择施工品牌');
      const model = String(body.model || '').trim();
      if (!model || model.length < 2) return fail(res, 400, '请填写产品型号或改装项目');
      if (model.length > 1000) return fail(res, 400, '产品型号内容过长');
      const { abs } = store.resolvePath(user.id, folder);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        return fail(res, 404, '图片文件夹不存在');
      }
      const vin = String(body.vin || '')
        .trim()
        .toUpperCase();
      if (vin && !/^[A-Z0-9]{17}$/.test(vin)) return fail(res, 400, '车架号格式不正确');
      const carName = store.baseName(folder);
      let imageCount = 0;
      try {
        imageCount = fs.readdirSync(abs).filter((n) => /\.(jpe?g|png|webp|heic)$/i.test(n)).length;
      } catch {
        /* ignore */
      }
      const text = buildDescribeText({
        projects: projects.map((x) => DESCRIBE_PROJECTS[x]),
        brands,
        model,
        carName,
        vin,
        department: user.department || '',
        username: user.username,
        folder,
        imageCount,
      });
      const now = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}_${p2(
        now.getHours()
      )}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
      const target = store.uniqueAbsPath(
        path.join(abs, `小红书创作说明_${stamp}.txt`)
      );
      fs.writeFileSync(target, '\ufeff' + text, 'utf8');
      store.adjustUsage(user.id, Buffer.byteLength('\ufeff' + text));
      const vpath = store.joinVPath(folder, path.basename(target));
      audit.add(user, 'describe', vpath, '生成小红书创作说明', audit.clientIp(req));
      const host = req.headers.host || '';
      const wbOrigin = host ? (/^https?:\/\//i.test(host) ? host : 'http://' + host) : '';
      void sendWorkbuddy(user, audit.clientIp(req), wbOrigin, {
        path: vpath,
        name: path.basename(target),
        folder,
        imageCount,
        carName,
        vin,
        department: user.department || '',
        username: user.username,
        text,
      });
      return sendJson(res, 201, { ok: true, path: vpath, name: path.basename(target) });
    }

    if (p === '/api/batch/commit' && m === 'POST') {
      const body = await readJson(req);
      const result = await batches.commit(user, body.batchId);
      audit.add(
        user,
        'upload',
        result.folder || '',
        `批次上传 ${result.count} 张，车型 ${result.carName || '未识别'}`,
        audit.clientIp(req)
      );
      return sendJson(res, 200, result);
    }

    if (p === '/api/batch/cancel' && m === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 200, batches.cancel(user, body.batchId));
    }

    if (p === '/api/stats/uploads' && m === 'GET') {
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';
      const department = url.searchParams.get('department') || '';

      const bWhere = ['1 = 1'];
      const bParams = [];
      if (from) { bWhere.push('date >= ?'); bParams.push(from); }
      if (to) { bWhere.push('date <= ?'); bParams.push(to); }
      if (department) { bWhere.push('department = ?'); bParams.push(department); }
      const batchRows = db.prepare(
        `SELECT user_id, username, department, date, COUNT(*) AS batches, SUM(image_count) AS images, MAX(created_at) AS last_at
         FROM upload_batches WHERE ${bWhere.join(' AND ')} GROUP BY user_id, date`
      ).all(...bParams);

      const vWhere = ['1 = 1'];
      const vParams = [];
      if (from) { vWhere.push('date >= ?'); vParams.push(from); }
      if (to) { vWhere.push('date <= ?'); vParams.push(to); }
      const vinRows = db.prepare(
        `SELECT username, date, SUM(success) AS vin_success,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS vin_fail
         FROM vin_attempts WHERE ${vWhere.join(' AND ')} GROUP BY user_id, date`
      ).all(...vParams);

      const map = new Map();
      for (const r of batchRows) {
        map.set(r.username + '|' + r.date, {
          username: r.username,
          department: r.department || '',
          date: r.date,
          batches: r.batches,
          images: r.images || 0,
          vinSuccess: 0,
          vinFail: 0,
          lastAt: r.last_at || 0,
        });
      }
      for (const v of vinRows) {
        const key = v.username + '|' + v.date;
        const row =
          map.get(key) || {
            username: v.username,
            department: '',
            date: v.date,
            batches: 0,
            images: 0,
            vinSuccess: 0,
            vinFail: 0,
            lastAt: 0,
          };
        row.vinSuccess = v.vin_success || 0;
        row.vinFail = v.vin_fail || 0;
        map.set(key, row);
      }
      const rows = Array.from(map.values()).sort((a, b) =>
        a.date === b.date ? a.username.localeCompare(b.username, 'zh') : b.date.localeCompare(a.date)
      );

      const deptRows = db.prepare(
        `SELECT COALESCE(NULLIF(department, ''), '未设置') AS department,
                COUNT(*) AS batches, COALESCE(SUM(image_count), 0) AS images
         FROM upload_batches WHERE ${bWhere.join(' AND ')}
         GROUP BY department`
      ).all(...bParams);
      const vWhereV = vWhere.map((w) => w.replace(/\bdate\b/g, 'v.date'));
      const deptVin = db.prepare(
        `SELECT COALESCE(NULLIF(u.department, ''), '未设置') AS department,
                COALESCE(SUM(v.success), 0) AS vin_success,
                COALESCE(SUM(CASE WHEN v.success = 0 THEN 1 ELSE 0 END), 0) AS vin_fail
         FROM vin_attempts v LEFT JOIN users u ON u.id = v.user_id
         WHERE ${vWhereV.join(' AND ')}
         GROUP BY u.department`
      ).all(...vParams);
      const deptMap = new Map();
      for (const d of deptRows) {
        deptMap.set(d.department, {
          department: d.department,
          batches: d.batches || 0,
          images: d.images || 0,
          vinSuccess: 0,
          vinFail: 0,
        });
      }
      for (const d of deptVin) {
        const key = d.department || '未设置';
        const row =
          deptMap.get(key) || { department: key, batches: 0, images: 0, vinSuccess: 0, vinFail: 0 };
        row.vinSuccess = d.vin_success || 0;
        row.vinFail = d.vin_fail || 0;
        deptMap.set(key, row);
      }
      const departments = Array.from(deptMap.values()).sort((a, b) =>
        a.department.localeCompare(b.department, 'zh')
      );

      const today = autoFolders.todayName();
      const monthStart = today.slice(0, 7) + '-01';
      const todayStat = db
        .prepare('SELECT COUNT(*) AS batches, COALESCE(SUM(image_count), 0) AS images FROM upload_batches WHERE date = ?')
        .get(today);
      const monthStat = db
        .prepare('SELECT COUNT(*) AS batches, COALESCE(SUM(image_count), 0) AS images FROM upload_batches WHERE date >= ?')
        .get(monthStart);
      const monthVin = db
        .prepare(
          `SELECT COALESCE(SUM(success), 0) AS success, COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS fail
           FROM vin_attempts WHERE date >= ?`
        )
        .get(monthStart);

      let rangeTo = to || today;
      let rangeFrom = from;
      if (!rangeFrom) {
        const d = new Date(rangeTo + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() - 29);
        rangeFrom = d.toISOString().slice(0, 10);
      }
      if (rangeFrom > rangeTo) {
        const tmp = rangeFrom;
        rangeFrom = rangeTo;
        rangeTo = tmp;
      }
      const allDates = [];
      const startD = new Date(rangeFrom + 'T00:00:00Z');
      const endD = new Date(rangeTo + 'T00:00:00Z');
      for (let d = new Date(startD); d <= endD; d.setUTCDate(d.getUTCDate() + 1)) {
        allDates.push(d.toISOString().slice(0, 10));
      }
      const activeList = db
        .prepare("SELECT id, username, department, created_at FROM users WHERE status = 'active'")
        .all();
      const recordRows = db.prepare(
        `SELECT user_id, date FROM upload_batches WHERE date >= ? AND date <= ?
         UNION
         SELECT user_id, date FROM vin_attempts WHERE date >= ? AND date <= ?`
      ).all(rangeFrom, rangeTo, rangeFrom, rangeTo);
      const recordMap = new Map();
      for (const r of recordRows) {
        if (!recordMap.has(r.user_id)) recordMap.set(r.user_id, new Set());
        recordMap.get(r.user_id).add(r.date);
      }
      const missing = [];
      for (const u of activeList) {
        const set = recordMap.get(u.id) || new Set();
        const from = statFromDay(u, rangeFrom);
        const dates = allDates.filter((d) => d >= from && !set.has(d));
        if (dates.length) {
          missing.push({ username: u.username, department: u.department || '未设置', dates });
        }
      }

      const deptMissed = new Map();
      for (const m of missing) {
        deptMissed.set(m.department, (deptMissed.get(m.department) || 0) + m.dates.length);
      }
      const knownDepts = new Set(departments.map((d) => d.department));
      for (const u of activeList) {
        const dep = u.department || '未设置';
        if (!knownDepts.has(dep)) {
          departments.push({ department: dep, batches: 0, images: 0, vinSuccess: 0, vinFail: 0 });
          knownDepts.add(dep);
        }
      }
      for (const d of departments) {
        d.missed = deptMissed.get(d.department) || 0;
      }

      const monthDates = [];
      const monthStartDate = new Date(monthStart + 'T00:00:00Z');
      const monthEndDate = new Date(today + 'T00:00:00Z');
      for (let d = new Date(monthStartDate); d <= monthEndDate; d.setUTCDate(d.getUTCDate() + 1)) {
        monthDates.push(d.toISOString().slice(0, 10));
      }
      const monthRecords = db.prepare(
        `SELECT user_id, date FROM upload_batches WHERE date >= ? AND date <= ?
         UNION
         SELECT user_id, date FROM vin_attempts WHERE date >= ? AND date <= ?`
      ).all(monthStart, today, monthStart, today);
      const monthSet = new Map();
      for (const r of monthRecords) {
        if (!monthSet.has(r.user_id)) monthSet.set(r.user_id, new Set());
        monthSet.get(r.user_id).add(r.date);
      }
      let missedTotal = 0;
      for (const u of activeList) {
        const set = monthSet.get(u.id) || new Set();
        const from = statFromDay(u, monthStart);
        missedTotal += monthDates.filter((d) => d >= from && !set.has(d)).length;
      }

      return sendJson(res, 200, {
        rows,
        departments,
        missing,
        today: { date: today, batches: todayStat.batches || 0, images: todayStat.images || 0 },
        monthly: {
          month: today.slice(0, 7),
          batches: monthStat.batches || 0,
          images: monthStat.images || 0,
          vinSuccess: monthVin.success || 0,
          vinFail: monthVin.fail || 0,
          missedTotal,
        },
      });
    }

    if (p.startsWith('/api/admin/')) {
      if (user.role !== 'admin') return fail(res, 403, '需要管理员权限');

      if (p === '/api/admin/logs' && m === 'GET') {
        return sendJson(
          res,
          200,
          audit.query({
            from: url.searchParams.get('from') || '',
            to: url.searchParams.get('to') || '',
            username: url.searchParams.get('username') || '',
            action: url.searchParams.get('action') || '',
            page: url.searchParams.get('page') || 1,
            pageSize: url.searchParams.get('pageSize') || 50,
          })
        );
      }

      if (p === '/api/admin/users' && m === 'GET') {
        const status = url.searchParams.get('status');
        let sql =
          'SELECT id, username, role, status, quota, created_at, last_login, department, phone FROM users';
        const params = [];
        if (status) {
          sql += ' WHERE status = ?';
          params.push(status);
        }
        sql += ' ORDER BY created_at DESC';
        const rows = db.prepare(sql).all(...params);
        return sendJson(res, 200, {
          users: rows.map((r) => {
            const access = permissions.getUserAccess(r.id);
            return {
              id: r.id,
              username: r.username,
              role: r.role,
              status: r.status,
              quota: r.quota,
              createdAt: r.created_at,
              lastLogin: r.last_login,
              department: r.department || '',
              phone: r.phone || '',
              folderAccess: access.mode,
              folderCount: access.folders.length,
            };
          }),
        });
      }

      if (p === '/api/admin/describe-template' && m === 'GET') {
        return sendJson(res, 200, {
          template: settings.getDescribeTemplate(),
          defaultTemplate: settings.DEFAULT_TEMPLATE,
          placeholders: settings.PLACEHOLDERS,
          maxLength: settings.MAX_LENGTH,
        });
      }

      if (p === '/api/admin/describe-template' && m === 'POST') {
        const body = await readJson(req);
        try {
          const template = settings.setDescribeTemplate(body.template);
          audit.add(user, 'admin_template', '创作说明模板', '更新模板内容', audit.clientIp(req));
          return sendJson(res, 200, { ok: true, template });
        } catch (err) {
          return fail(res, err.status || 500, err.message || '保存失败');
        }
      }

      if (p === '/api/admin/workbuddy' && m === 'GET') {
        return sendJson(res, 200, { url: settings.getWorkbuddyUrl() });
      }

      if (p === '/api/admin/workbuddy' && m === 'POST') {
        const body = await readJson(req);
        try {
          const url = settings.setWorkbuddyUrl(body.url);
          audit.add(
            user,
            'workbuddy_config',
            'WorkBuddy 投递地址',
            url ? '已设置投递地址' : '已清空投递地址',
            audit.clientIp(req)
          );
          return sendJson(res, 200, { ok: true, url });
        } catch (err) {
          return fail(res, err.status || 500, err.message || '保存失败');
        }
      }

      if (p === '/api/admin/summary' && m === 'GET') {
        const rows = db.prepare('SELECT status, COUNT(*) AS c FROM users GROUP BY status').all();
        const summary = { pending: 0, active: 0, rejected: 0, disabled: 0 };
        rows.forEach((r) => {
          summary[r.status] = r.c;
        });
        return sendJson(res, 200, summary);
      }

      if (p === '/api/admin/folders' && m === 'GET') {
        const target = auth.findUserById(Number(url.searchParams.get('userId')));
        if (!target) return fail(res, 404, '用户不存在');
        const rootNames = store
          .listMerged(activeUsers(), '/')
          .filter((e) => e.isDir)
          .map((e) => e.name);
        const access = permissions.getUserAccess(target.id);
        return sendJson(res, 200, {
          role: target.role,
          mode: access.mode,
          granted: access.folders,
          folders: Array.from(new Set(rootNames)).sort(),
        });
      }

      if (p === '/api/admin/folder-access' && m === 'POST') {
        const body = await readJson(req);
        const target = auth.findUserById(Number(body.userId));
        if (!target) return fail(res, 404, '用户不存在');
        if (target.role === 'admin') return fail(res, 400, '管理员默认拥有全部文件夹权限');
        const mode = body.mode === 'custom' ? 'custom' : 'all';
        const folders = Array.isArray(body.folders) ? body.folders : [];
        const access = permissions.setUserAccess(target.id, mode, folders);
        audit.add(
          user,
          'admin_access',
          target.username,
          `文件夹权限：${mode === 'custom' ? '自定义 ' + folders.length + ' 个' : '全部'}`,
          audit.clientIp(req)
        );
        return sendJson(res, 200, { ok: true, mode: access.mode, granted: access.folders });
      }

      if (p === '/api/admin/username' && m === 'POST') {
        const body = await readJson(req);
        const target = auth.findUserById(Number(body.userId));
        if (!target) return fail(res, 404, '用户不存在');
        const username = String(body.username || '').trim();
        const invalid = auth.validateUsername(username);
        if (invalid) return fail(res, 400, invalid);
        if (username === target.username) {
          return sendJson(res, 200, {
            ok: true,
            userId: target.id,
            username,
            isSelf: target.id === user.id,
          });
        }
        if (auth.findUserByName(username)) return fail(res, 409, '用户名已被占用');
        db.exec('BEGIN');
        try {
          db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, target.id);
          db.prepare('UPDATE upload_batches SET username = ? WHERE user_id = ?').run(username, target.id);
          db.prepare('UPDATE vin_attempts SET username = ? WHERE user_id = ?').run(username, target.id);
          db.prepare('UPDATE trash SET owner_name = ? WHERE owner_id = ?').run(username, target.id);
          db.prepare('UPDATE trash SET deleted_by_name = ? WHERE deleted_by_id = ?').run(username, target.id);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        audit.add(
          user,
          'admin_username',
          target.username,
          `用户名 ${target.username} → ${username}`,
          audit.clientIp(req)
        );
        return sendJson(res, 200, {
          ok: true,
          userId: target.id,
          username,
          isSelf: target.id === user.id,
        });
      }

      if (p === '/api/admin/phone' && m === 'POST') {
        const body = await readJson(req);
        const target = auth.findUserById(Number(body.userId));
        if (!target) return fail(res, 404, '用户不存在');
        const phone = sms.normalizePhone(body.phone);
        const invalid = sms.validatePhone(phone);
        if (invalid) return fail(res, 400, invalid);
        const other = auth.findUserByPhone(phone);
        if (other && other.id !== target.id) return fail(res, 409, '该手机号已被其他账号绑定');
        db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, target.id);
        audit.add(
          user,
          'admin_phone',
          target.username,
          `手机号 ${target.phone ? sms.maskPhone(target.phone) + ' → ' : ''}${sms.maskPhone(phone)}`,
          audit.clientIp(req)
        );
        return sendJson(res, 200, { ok: true, phone });
      }

      if (p === '/api/admin/delete-user' && m === 'POST') {
        const body = await readJson(req);
        const target = auth.findUserById(Number(body.userId));
        if (!target) return fail(res, 404, '用户不存在');
        if (target.id === user.id) return fail(res, 400, '不能删除当前登录账号');
        if (String(body.confirm || '').trim() !== target.username) {
          return fail(res, 400, '请输入完整用户名确认删除');
        }
        if (target.role === 'admin') {
          const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
          if (admins <= 1) return fail(res, 400, '至少需要保留一个管理员账号');
        }
        const usage = store.usage(target.id);
        const trashIds = db
          .prepare('SELECT id FROM trash WHERE owner_id = ?')
          .all(target.id)
          .map((row) => row.id);
        db.exec('BEGIN');
        try {
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
          db.prepare('DELETE FROM shares WHERE user_id = ?').run(target.id);
          db.prepare('DELETE FROM folder_grants WHERE user_id = ?').run(target.id);
          db.prepare('DELETE FROM trash WHERE owner_id = ?').run(target.id);
          db.prepare('DELETE FROM upload_batches WHERE user_id = ?').run(target.id);
          db.prepare('DELETE FROM vin_attempts WHERE user_id = ?').run(target.id);
          db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        let warning = '';
        const userDir = path.join(USER_DIR, String(target.id));
        try {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
              if (fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true });
              break;
            } catch (err) {
              if (attempt === 3) throw err;
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
            }
          }
        } catch (err) {
          warning = '账号已删除，但文件目录暂时被占用，未能完全清理，请稍后手动清理';
          console.error('[delete-user]', err.message);
        }
        store.invalidateUsage(target.id);
        for (const id of trashIds) {
          try {
            fs.rmSync(path.join(trash.TRASH_DIR, String(id)), { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
        audit.add(
          user,
          'admin_delete_user',
          target.username,
          `删除账号，容量 ${fmtBytes(usage)}${warning ? '（文件清理失败）' : ''}`,
          audit.clientIp(req)
        );
        return sendJson(res, 200, { ok: true, warning });
      }

      if (p === '/api/admin/password' && m === 'POST') {
        const body = await readJson(req);
        const target = auth.findUserById(Number(body.userId));
        if (!target) return fail(res, 404, '用户不存在');
        if (target.id === user.id) {
          return fail(res, 400, '请使用「修改密码」功能修改自己的密码');
        }
        const password = String(body.password || '');
        if (!password || password.length < 6 || password.length > 128) {
          return fail(res, 400, '密码长度需为 6-128 位');
        }
        auth.updatePassword(target.id, password);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
        audit.add(user, 'admin_password', target.username, '管理员重置登录密码', audit.clientIp(req));
        return sendJson(res, 200, { ok: true });
      }

      if (p === '/api/admin/department' && m === 'POST') {
        const body = await readJson(req);
        const target = auth.findUserById(Number(body.userId));
        if (!target) return fail(res, 404, '用户不存在');
        const department = String(body.department || '').trim();
        const deptError = auth.validateDepartment(department);
        if (deptError) return fail(res, 400, deptError);
        db.prepare('UPDATE users SET department = ? WHERE id = ?').run(department, target.id);
        audit.add(
          user,
          'admin_department',
          target.username,
          `部门 ${target.department || '未设置'} → ${department || '未设置'}`,
          audit.clientIp(req)
        );
        return sendJson(res, 200, { ok: true, department });
      }

      if (p === '/api/admin/review' && m === 'POST') {
        const body = await readJson(req);
        const target = auth.findUserById(Number(body.userId));
        if (!target) return fail(res, 404, '用户不存在');
        if (target.id === user.id) return fail(res, 400, '不能操作自己的账号');
        const map = { approve: 'active', reject: 'rejected', disable: 'disabled', enable: 'active' };
        const action = String(body.action || '');
        if (!map[action]) return fail(res, 400, '操作无效');
        if (target.role === 'admin' && map[action] !== 'active') {
          const activeAdmins = db
            .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active'")
            .get().c;
          if (activeAdmins <= 1) return fail(res, 400, '至少需要保留一个可用的管理员');
        }
        const actionText = { approve: '通过审核', reject: '拒绝', disable: '停用', enable: '启用' }[action];
        audit.add(
          user,
          'admin_review',
          target.username,
          `${actionText}（${target.status} → ${map[action]}）`,
          audit.clientIp(req)
        );
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run(map[action], target.id);
        if (map[action] === 'active') {
          autoFolders.ensureForUser(target.id);
        } else {
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
        }
        return sendJson(res, 200, { ok: true, status: map[action] });
      }

      return fail(res, 404, '接口不存在');
    }

    return fail(res, 404, '接口不存在');
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message);
    console.error('[api]', err);
    return fail(res, 500, '服务器错误');
  }
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(res, pathname) {
  let rel = pathname;
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/login') rel = '/login.html';
  if (!path.extname(rel)) rel += '.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('页面不存在');
    }
    const type = STATIC_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad Request');
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  if (pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
  }

  if (pathname === dav.PREFIX || pathname.startsWith(dav.PREFIX + '/')) {
    return dav.handle(req, res, pathname);
  }

  if (pathname.startsWith('/api/open/')) {
    handleOpenApi(req, res, url).catch((err) => {
      console.error('[open-api]', err);
      if (!res.headersSent) fail(res, 500, '服务器错误');
      else res.end();
    });
    return;
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error('[api-fatal]', err);
      if (!res.headersSent) fail(res, 500, '服务器错误');
      else res.end();
    });
    return;
  }

  if (/^\/s\/[A-Za-z0-9]+$/.test(pathname)) {
    return serveStatic(res, '/share.html');
  }

  if (pathname.startsWith('/assets/')) {
    return serveStatic(res, pathname);
  }

  return serveStatic(res, pathname);
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.timeout = 0;

server.listen(PORT, HOST, () => {
  console.log(`CloudDisk 已启动: http://${HOST}:${PORT}`);
  console.log(`WebDAV 地址: http://<服务器IP>:${PORT}${dav.PREFIX}`);
  console.log(`数据目录: ${DATA_DIR}`);
  autoFolders.start();
  console.log(
    vehicleApi.isConfigured()
      ? '[vehicle] 车型 API 已启用'
      : '[vehicle] 车型 API 未配置，使用模型识别'
  );
  trash.cleanup();
  audit.cleanup();
  sms.cleanup();
  setInterval(() => trash.cleanup(), 30 * 60 * 1000).unref();
  setInterval(() => audit.cleanup(), 6 * 3600 * 1000).unref();
  setInterval(() => sms.cleanup(), 60 * 60 * 1000).unref();
});

process.on('uncaughtException', (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));