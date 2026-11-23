const fs = require('fs');
const path = require('path');
const store = require('./fsstore');
const { verifyBasicAuth } = require('./auth');
const permissions = require('./permissions');
const trash = require('./trash');
const audit = require('./audit');
const searchIndex = require('./search');

const PREFIX = '/dav';

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function hrefFor(vpath, isDir) {
  const encoded = encodeURI(vpath).replace(/[?#]/g, (c) => (c === '?' ? '%3F' : '%23'));
  return PREFIX + (encoded === '/' ? '/' : encoded) + (isDir && encoded !== '/' ? '/' : '');
}

function etagOf(st) {
  return `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

function propstatXml(vpath, name, abs) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return '';
  }
  const isDir = st.isDirectory();
  const parts = [
    `<D:displayname>${escapeXml(name || '根目录')}</D:displayname>`,
    `<D:getlastmodified>${st.mtime.toUTCString()}</D:getlastmodified>`,
    `<D:etag>${etagOf(st)}</D:etag>`,
  ];
  if (isDir) {
    parts.push('<D:resourcetype><D:collection/></D:resourcetype>');
    parts.push('<D:getcontentlength>0</D:getcontentlength>');
  } else {
    parts.push('<D:resourcetype/>');
    parts.push(`<D:getcontentlength>${st.size}</D:getcontentlength>`);
    parts.push(`<D:getcontenttype>${escapeXml(store.mimeOf(name))}</D:getcontenttype>`);
  }
  return `<D:response><D:href>${hrefFor(vpath, isDir)}</D:href><D:propstat><D:prop>${parts.join(
    ''
  )}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function sendXml(res, status, xml) {
  res.writeHead(status, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Length': Buffer.byteLength(xml),
    DAV: '1, 2',
  });
  res.end(xml);
}

function basicRealm(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="CloudDisk WebDAV", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('需要认证');
}

function parseDestination(req) {
  const dest = req.headers.destination;
  if (!dest) return null;
  try {
    const url = new URL(dest, `http://${req.headers.host || 'localhost'}`);
    let p = decodeURIComponent(url.pathname);
    if (!p.startsWith(PREFIX)) return null;
    p = p.slice(PREFIX.length) || '/';
    return store.normalizeVPath(p);
  } catch {
    return null;
  }
}

function depthOf(req) {
  const d = (req.headers.depth || 'infinity').toLowerCase();
  return d === '0' ? 0 : d === '1' ? 1 : Infinity;
}

async function handle(req, res, pathname, rawBodyReader) {
  const user = verifyBasicAuth(req.headers.authorization);
  if (!user) return basicRealm(res);

  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') searchIndex.invalidate();
  let vpath;
  try {
    vpath = store.normalizeVPath(decodeURIComponent(pathname.slice(PREFIX.length) || '/'));
  } catch {
    res.writeHead(400);
    return res.end();
  }

  try {
    if (method === 'OPTIONS') {
      res.writeHead(200, {
        DAV: '1, 2, 3',
        Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK',
        'MS-Author-Via': 'DAV',
        'Content-Length': '0',
      });
      return res.end();
    }

    if (!permissions.canAccess(user.id, vpath)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('无权访问该文件夹');
    }

    if (method === 'PROPFIND') {
      const { abs } = store.resolvePath(user.id, vpath);
      if (!fs.existsSync(abs)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('不存在');
      }
      const depth = depthOf(req);
      const st = fs.statSync(abs);
      const items = [propstatXml(vpath, store.baseName(vpath), abs)];
      if (st.isDirectory() && depth >= 1) {
        let entries = store.listDir(user.id, vpath).entries;
        entries = permissions.filterEntries(user.id, entries, vpath);
        for (const ent of entries) {
          items.push(propstatXml(ent.path, ent.name, path.join(abs, ent.name)));
        }
      }
      const xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${items.join('')}</D:multistatus>`;
      return sendXml(res, 207, xml);
    }

    if (method === 'PROPPATCH') {
      const xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"/>`;
      return sendXml(res, 207, xml);
    }

    if (method === 'GET' || method === 'HEAD') {
      const { abs } = store.resolvePath(user.id, vpath);
      if (!fs.existsSync(abs)) {
        res.writeHead(404);
        return res.end();
      }
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        res.writeHead(405);
        return res.end();
      }
      res.setHeader('Content-Type', store.mimeOf(path.basename(abs)));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', etagOf(st));
      res.setHeader('Last-Modified', st.mtime.toUTCString());
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
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
          if (method === 'HEAD') return res.end();
          return fs.createReadStream(abs, { start, end }).pipe(res);
        }
      }
      res.writeHead(200, { 'Content-Length': st.size });
      if (method === 'HEAD') return res.end();
      return fs.createReadStream(abs).pipe(res);
    }

    if (method === 'PUT') {
      const { abs } = store.resolvePath(user.id, vpath);
      if (vpath === '/') {
        res.writeHead(405);
        return res.end();
      }
      // 写入同样受文件夹权限约束（与 Web / API 一致）
      if (!permissions.canAccess(user.id, vpath)) {
        res.writeHead(403);
        return res.end();
      }
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        res.writeHead(405);
        return res.end();
      }
      // 与 Web 端上传同口径：单文件 4GB + 账号配额
      const contentLength = Number(req.headers['content-length'] || 0);
      if (contentLength > store.MAX_FILE_BYTES) {
        res.writeHead(413);
        return res.end('单个文件超过 4GB 限制');
      }
      const existed = fs.existsSync(abs);
      const prevSize = existed ? fs.statSync(abs).size : 0;
      // 覆盖写只计算净增量，避免把旧文件重复计入
      const baseUsed = Math.max(0, store.usage(user.id) - prevSize);
      if (contentLength > 0 && baseUsed + contentLength > user.quota) {
        res.writeHead(507);
        return res.end('存储空间不足');
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = path.join(require('./db').TMP_DIR, `dav-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const out = fs.createWriteStream(tmp);
      let written = 0;
      let limitHit = '';
      // 手动写入 + 背压控制：避免 pipe 与 end() 竞争，
      // 同时 Content-Length 缺失或被伪造时也能实时拦住
      await new Promise((resolve, reject) => {
        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          err ? reject(err) : resolve();
        };
        req.on('data', (chunk) => {
          if (settled) return;
          written += chunk.length;
          if (!limitHit && written > store.MAX_FILE_BYTES) limitHit = 'size';
          else if (!limitHit && baseUsed + written > user.quota) limitHit = 'quota';
          if (limitHit) {
            out.end(() => done());
            return;
          }
          if (!out.write(chunk)) {
            req.pause();
            out.once('drain', () => req.resume());
          }
        });
        req.on('end', () => {
          if (!limitHit) out.end(() => done());
        });
        req.on('aborted', () => done(new Error('aborted')));
        out.on('error', (err) => done(err));
        req.on('error', (err) => done(err));
      }).catch((err) => {
        // 连接中断 / 写盘失败：不留临时文件
        fs.rmSync(tmp, { force: true });
        if (limitHit) return 'limit';
        throw err;
      });
      if (limitHit) {
        fs.rmSync(tmp, { force: true });
        res.writeHead(limitHit === 'size' ? 413 : 507);
        res.end(limitHit === 'size' ? '单个文件超过 4GB 限制' : '存储空间不足');
        req.destroy();
        return;
      }
      fs.renameSync(tmp, abs);
      store.adjustUsage(user.id, fs.statSync(abs).size - prevSize);
      res.writeHead(existed ? 204 : 201, { 'Content-Length': '0' });
      return res.end();
    }

    if (method === 'MKCOL') {
      const { abs } = store.resolvePath(user.id, vpath);
      if (fs.existsSync(abs)) {
        res.writeHead(405);
        return res.end();
      }
      fs.mkdirSync(abs, { recursive: true });
      res.writeHead(201, { 'Content-Length': '0' });
      return res.end();
    }

    if (method === 'DELETE') {
      if (vpath === '/') {
        res.writeHead(403);
        return res.end();
      }
      const { abs } = store.resolvePath(user.id, vpath);
      if (!fs.existsSync(abs)) {
        res.writeHead(404);
        return res.end();
      }
      try {
        const item = trash.add(user, vpath, user);
        audit.add(
          user,
          'delete',
          vpath,
          `WebDAV 删除${item.isDir ? `文件夹，${item.files} 个文件` : '文件'}`,
          audit.clientIp(req)
        );
      } catch (err) {
        res.writeHead(err.status || 500);
        return res.end(err.message || 'Delete failed');
      }
      res.writeHead(204, { 'Content-Length': '0' });
      return res.end();
    }

    if (method === 'MOVE' || method === 'COPY') {
      const dest = parseDestination(req);
      if (!dest) {
        res.writeHead(400);
        return res.end();
      }
      if (!permissions.canAccess(user.id, dest)) {
        res.writeHead(403);
        return res.end();
      }
      const { abs: srcAbs } = store.resolvePath(user.id, vpath);
      if (!fs.existsSync(srcAbs)) {
        res.writeHead(404);
        return res.end();
      }
      if (vpath === '/' || dest === vpath || dest.startsWith(vpath + '/')) {
        res.writeHead(403);
        return res.end();
      }
      const { abs: destAbs } = store.resolvePath(user.id, dest);
      const overwrite = (req.headers.overwrite || 'T').toUpperCase() !== 'F';
      let prevDestSize = 0;
      if (fs.existsSync(destAbs)) {
        if (!overwrite) {
          res.writeHead(412);
          return res.end();
        }
        const dstStat = fs.statSync(destAbs);
        prevDestSize = dstStat.isDirectory() ? store.dirSize(user.id, dest) : dstStat.size;
        fs.rmSync(destAbs, { recursive: true, force: true });
      }
      // COPY 会复制一份数据，需要配额；MOVE 不改变用量
      if (method === 'COPY') {
        const srcStat = fs.statSync(srcAbs);
        const srcSize = srcStat.isDirectory() ? store.dirSize(user.id, vpath) : srcStat.size;
        const used = Math.max(0, store.usage(user.id) - prevDestSize);
        if (used + srcSize > user.quota) {
          res.writeHead(507);
          return res.end('存储空间不足');
        }
      }
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      if (method === 'MOVE') {
        fs.renameSync(srcAbs, destAbs);
        // 覆盖目标时旧数据已被删掉，只需冲掉这部分
        if (prevDestSize) store.adjustUsage(user.id, -prevDestSize);
      } else {
        const copied = store.statSize(srcAbs);
        fs.cpSync(srcAbs, destAbs, { recursive: true });
        store.adjustUsage(user.id, copied - prevDestSize);
      }
      res.writeHead(201, { 'Content-Length': '0' });
      return res.end();
    }

    if (method === 'LOCK') {
      const token = `opaquelocktoken:${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
      res.setHeader('Lock-Token', `<${token}>`);
      const xml = `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`;
      return sendXml(res, 200, xml);
    }

    if (method === 'UNLOCK') {
      res.writeHead(204, { 'Content-Length': '0' });
      return res.end();
    }

    res.writeHead(405, { Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK' });
    res.end();
  } catch (err) {
    const status = err.status || 500;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(err.message || '服务器错误');
  }
}

module.exports = { handle, PREFIX };