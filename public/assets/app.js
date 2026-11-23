(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    user: null,
    usage: 0,
    view: 'files',
    path: '/',
    entries: [],
    sort: 'name',
    dir: 1,
    layout: localStorage.getItem('cd-layout-v2') || 'grid',
    keyword: '',
    ctxTarget: null,
    selectMode: false,
    selected: new Set(),
    trashItems: [],
    trashSelected: new Set(),
    trashIsAdmin: false,
    searchItems: [],
    searchQuery: '',
    modalClosable: true,
    logPage: 1,
    logsReady: false,
    previewImages: null,
  };

  const isMobile = () => window.matchMedia('(max-width: 820px)').matches;

  /* ---------------- 基础工具 ---------------- */
  async function api(url, options = {}) {
    const opts = { ...options };
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, opts);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      if (res.status === 401) {
        location.href = '/login';
        throw new Error('未登录');
      }
      if (res.status === 403 && data && data.needPhone) {
        location.href = '/login.html';
        throw new Error('请先补充手机号');
      }
      const err = new Error((data && data.error) || `请求失败 (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function fmtSize(n) {
    if (n === 0) return '0 B';
    if (!n && n !== 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (sameDay) return `今天 ${hm}`;
    if (d.toDateString() === yest.toDateString()) return `昨天 ${hm}`;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
  }

  const GROUPS = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'],
    video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'ogv'],
    audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'],
    pdf: ['pdf'],
    doc: ['doc', 'docx', 'rtf', 'odt'],
    sheet: ['xls', 'xlsx', 'csv', 'ods'],
    slide: ['ppt', 'pptx', 'odp'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
    code: ['js', 'ts', 'jsx', 'tsx', 'json', 'html', 'css', 'py', 'java', 'go', 'c', 'cpp', 'h', 'sh', 'yml', 'yaml', 'xml', 'sql'],
    text: ['txt', 'md', 'log'],
  };

  function groupOf(entry) {
    if (entry.isDir) return 'folder';
    const ext = extOf(entry.name);
    for (const [g, list] of Object.entries(GROUPS)) if (list.includes(ext)) return g;
    return 'text';
  }

  function isImage(entry) {
    return groupOf(entry) === 'image';
  }

  function isWechat() {
    return /MicroMessenger/i.test(navigator.userAgent || '');
  }

  function isPCWechat() {
    return isWechat() && /(Windows NT|Macintosh)/i.test(navigator.userAgent || '');
  }

  function isApp() {
    return /CloudDiskApp/i.test(navigator.userAgent || '');
  }

  async function appDownload(url) {
    const fullUrl = url.startsWith('http') ? url : location.origin + url;
    if (isApp()) {
      let path = '';
      let name = '';
      try {
        const u = new URL(fullUrl, location.origin);
        path = u.searchParams.get('path') || '';
      } catch {}
      if (path) name = path.split('/').filter(Boolean).pop() || 'download';
      let rec = null;
      try {
        const startRec = await api('/api/downloads', { method: 'POST', body: { path, name, totalBytes: 0, source: 'app' } });
        rec = startRec.download;
        dlState.records.set(rec.id, rec);
        renderDownloads();
        updateDlBadge();
      } catch {
        rec = null;
      }
      const recId = rec ? rec.id : 0;
      if (rec) {
        rec.lastActiveAt = Date.now();
        dlState.records.set(rec.id, rec);
      }
      // 看门狗：按活跃度判定，而非固定超时。
      // 文件夹下载时服务端要先打包完整个目录才响应（可能几十秒），期间无任何进度，
      // 固定 15 秒判定会把正常打包误判为失败。规则：
      // - 从未收到进度（打包/排队中）→ 宽限 90 秒
      // - 收到过进度后停滞 → 45 秒判失败
      const timeoutCheck = () => {
        if (!rec) return;
        const timer = setInterval(() => {
          const r = dlState.records.get(rec.id);
          if (!r || r.status !== 'downloading') {
            clearInterval(timer);
            return;
          }
          const idle = Date.now() - (r.lastActiveAt || 0);
          const limit = r.downloadedBytes > 0 || r.totalBytes > 0 ? 45000 : 90000;
          if (idle > limit) {
            clearInterval(timer);
            window.onAppDownloadComplete(rec.id, false);
            toast('下载无响应，请重试', 'error');
          }
        }, 5000);
      };
      timeoutCheck();

      // 机制 1: prompt 同步调用（最可靠，所有 WebView 都支持 onJsPrompt）
      let result = null;
      try {
        result = prompt('clouddisk_dl:' + fullUrl + '#' + recId);
      } catch {}
      if (result && result.startsWith('ok:')) {
        toast('已开始下载: ' + result.slice(3), 'success');
        return;
      }
      if (result && result.startsWith('error:')) {
        toast(result, 'error');
        if (rec) {
          try { await api('/api/downloads/' + rec.id, { method: 'POST', body: { action: 'fail' } }); } catch {}
          dlState.records.delete(rec.id);
        }
        return;
      }

      // 机制 2: iOS WKScriptMessageHandler 桥接（window.webkit.messageHandlers）
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.CloudDisk) {
        try {
          window.webkit.messageHandlers.CloudDisk.postMessage({ url: fullUrl, id: recId });
          toast('已发起下载: ' + (name || '文件'), 'success');
          return;
        } catch (err) {
          result = null;
        }
      }

      // 机制 3: addJavascriptInterface 桥接（Android）
      if (window.CloudDisk && typeof window.CloudDisk.download === 'function') {
        try {
          result = window.CloudDisk.download(fullUrl, String(recId));
        } catch (err) {
          result = null;
        }
        if (result && result.startsWith('ok:')) {
          toast('已开始下载: ' + result.slice(3), 'success');
          return;
        }
        if (result && result.startsWith('error:')) {
          toast(result, 'error');
          if (rec) {
            try { await api('/api/downloads/' + rec.id, { method: 'POST', body: { action: 'fail' } }); } catch {}
            dlState.records.delete(rec.id);
          }
          return;
        }
      }

      // 机制 3: clouddisk:// 自定义协议（shouldOverrideUrlLoading 拦截）
      const dlUrl = `clouddisk://download?url=${encodeURIComponent(fullUrl)}&id=${recId}`;
      const a = document.createElement('a');
      a.href = dlUrl;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();

      // 机制 4: shouldInterceptRequest 拦截（img 标签加载 clouddisk://）
      const img = document.createElement('img');
      img.src = dlUrl;
      img.style.display = 'none';
      img.style.width = '1px';
      img.style.height = '1px';
      document.body.appendChild(img);
      setTimeout(() => { img.remove(); }, 2000);

      // 机制 5: window.location 导航
      try { window.location = dlUrl; } catch {}

      toast('已发起下载: ' + (name || '文件'), 'success');
      timeoutCheck();
      return;
    }
    downloadWithProgress(fullUrl);
  }

  /* ---------------- Web 流式下载 + 进度上报 ---------------- */
  const dlState = { records: new Map(), timer: null, filter: 'all' };

  function fmtSpeed(bytesPerSec) {
    if (bytesPerSec >= 1024 * 1024) return (bytesPerSec / 1024 / 1024).toFixed(1) + ' MB/s';
    if (bytesPerSec >= 1024) return Math.round(bytesPerSec / 1024) + ' KB/s';
    return Math.round(bytesPerSec) + ' B/s';
  }

  async function downloadWithProgress(url, opts = {}) {
    let path = opts.path || '';
    let name = opts.name || '';
    if (!path) {
      try {
        const u = new URL(url, location.origin);
        path = u.searchParams.get('path') || '';
      } catch {}
    }
    if (!name && path) name = path.split('/').filter(Boolean).pop() || 'download';
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('下载失败 (HTTP ' + res.status + ')');
      const total = Number(res.headers.get('Content-Length')) || 0;
      const startRec = await api('/api/downloads', {
        method: 'POST',
        body: { path, name, totalBytes: total, source: 'web' },
      });
      const rec = startRec.download;
      dlState.records.set(rec.id, rec);
      renderDownloads();
      updateDlBadge();
      const reader = res.body.getReader();
      const chunks = [];
      let downloaded = 0;
      let lastTime = performance.now();
      let lastBytes = 0;
      const ts = Date.now();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        downloaded += value.length;
        const now = performance.now();
        const dt = (now - lastTime) / 1000;
        const speed = dt > 0 ? (downloaded - lastBytes) / dt : 0;
        lastTime = now;
        lastBytes = downloaded;
        const rec2 = { ...rec, downloadedBytes: downloaded, speed, progress: total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : 0 };
        dlState.records.set(rec.id, rec2);
        if (state.view === 'downloads') renderDownloads();
        if (now - ts > 800) {
          try {
            await api('/api/downloads/' + rec.id, { method: 'PUT', body: { downloadedBytes: downloaded, speed } });
          } catch {}
        }
      }
      const blob = new Blob(chunks);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      await api('/api/downloads/' + rec.id, { method: 'POST', body: { action: 'complete' } });
      const doneRec = { ...rec, downloadedBytes: downloaded, status: 'completed', progress: 100, completedAt: Date.now() };
      dlState.records.set(rec.id, doneRec);
      if (state.view === 'downloads') renderDownloads();
      updateDlBadge();
      toast('已下载: ' + (name || '文件'), 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- App 下载进度回调（原生 evaluateJavascript 调用） ---------------- */
  window.onAppDownloadProgress = function (id, downloaded, total) {
    const rec = dlState.records.get(id);
    const progress = total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : 0;
    const rec2 = { ...(rec || {}), id, downloadedBytes: downloaded, totalBytes: total, status: 'downloading', progress, lastActiveAt: Date.now() };
    dlState.records.set(id, rec2);
    if (state.view === 'downloads') renderDownloads();
    updateDlBadge();
  };
  window.onAppDownloadComplete = function (id, success) {
    const rec = dlState.records.get(id);
    const rec2 = { ...(rec || {}), id, status: success ? 'completed' : 'failed', progress: success ? 100 : (rec ? rec.progress : 0), completedAt: Date.now() };
    dlState.records.set(id, rec2);
    if (state.view === 'downloads') renderDownloads();
    updateDlBadge();
    try {
      api('/api/downloads/' + id, { method: 'POST', body: { action: success ? 'complete' : 'fail' } }).catch(() => {});
    } catch {}
  };

  function updateDlBadge() {
    const active = Array.from(dlState.records.values()).filter((r) => r.status === 'downloading').length;
    const badge = $('#dlBadge');
    if (!badge) return;
    badge.hidden = active === 0;
    badge.textContent = active;
  }

  function updateDlBatchDelete() {
    const checks = document.querySelectorAll('.dl-row-check:checked');
    const btn = $('#dlBatchDelete');
    if (btn) btn.disabled = checks.length === 0;
    const headCheck = $('#dlHeadCheck');
    if (headCheck) {
      const allChecks = document.querySelectorAll('.dl-row-check');
      if (allChecks.length === 0) { headCheck.checked = false; headCheck.indeterminate = false; }
      else if (checks.length === allChecks.length) { headCheck.checked = true; headCheck.indeterminate = false; }
      else if (checks.length > 0) { headCheck.checked = false; headCheck.indeterminate = true; }
      else { headCheck.checked = false; headCheck.indeterminate = false; }
    }
  }

  async function dlBatchDelete() {
    const checks = document.querySelectorAll('.dl-row-check:checked');
    if (!checks.length) return;
    const ids = Array.from(checks).map((c) => Number(c.dataset.id));
    if (!confirm(`确定删除选中的 ${ids.length} 条下载记录？`)) return;
    for (const id of ids) {
      try { await api('/api/downloads/' + id, { method: 'DELETE' }); dlState.records.delete(id); } catch {}
    }
    renderDownloads();
    updateDlBadge();
    toast(`已删除 ${ids.length} 条记录`, 'success');
  }

  function wechatDownloadNotice(downloadUrl) {
    const fullUrl = downloadUrl ? location.origin + downloadUrl : '';
    const urlBox = fullUrl
      ? `<p class="modal-desc">也可复制下方链接，到浏览器地址栏粘贴打开：</p>
         <input id="wxUrl" readonly value="${escapeHtml(fullUrl)}" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #d9dce3;border-radius:8px;font-size:12.5px;margin-top:4px" />
         <button class="btn" id="wxCopy" type="button" style="margin-top:8px">复制下载链接</button>`
      : '';
    openModal(
      `<h3>微信内无法直接下载</h3>
       <p class="modal-desc">请按下面两步操作：</p>
       <div style="background:#f0f5ff;border-radius:10px;padding:12px 14px;margin:10px 0;color:#2757c4">1. 点击微信右上角「···」→「在浏览器中打开」</div>
       <div style="background:#f0f5ff;border-radius:10px;padding:12px 14px;margin:10px 0;color:#2757c4">2. 在浏览器中重新打开本页即可下载</div>
       ${urlBox}
       <div class="modal-actions"><button class="btn" data-close>知道了</button></div>`,
      (box) => {
        const closeBtn = box.querySelector('[data-close]');
        if (closeBtn) closeBtn.onclick = closeModal;
        const copyBtn = box.querySelector('#wxCopy');
        if (copyBtn) {
          copyBtn.onclick = () => {
            const input = box.querySelector('#wxUrl');
            input.select();
            try { document.execCommand('copy'); } catch (e) {}
            if (navigator.clipboard) navigator.clipboard.writeText(input.value).catch(() => {});
            toast('已复制，请到浏览器粘贴打开');
          };
        }
      }
    );
  }

  const ICONS = {
    folder: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h3.6l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" fill="currentColor" opacity=".95"/><path d="M3 8.5h18" stroke="#fff" stroke-opacity=".35" stroke-width="1.4"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 4v10M8 10.5l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 17v2h14v-2" stroke-linecap="round"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="17.5" cy="6.5" r="2.4"/><circle cx="6.5" cy="12" r="2.4"/><circle cx="17.5" cy="17.5" r="2.4"/><path d="M9 10.9l6-3.1M9 13.1l6 3.1" stroke-linecap="round"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>',
    preview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2.6 12S6 6.4 12 6.4 21.4 12 21.4 12 18 17.6 12 17.6 2.6 12 2.6 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7V5.5A1.5 1.5 0 0 1 5.5 4H7M17 4h1.5A1.5 1.5 0 0 1 20 5.5V7M20 17v1.5a1.5 1.5 0 0 1-1.5 1.5H17M7 20H5.5A1.5 1.5 0 0 1 4 18.5V17" stroke-linecap="round"/><path d="M9 12h6M12 9v6" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M6.5 7l.8 12.1A2 2 0 0 0 9.3 21h5.4a2 2 0 0 0 2-1.9L17.5 7" stroke-linecap="round"/><path d="M10 11v6M14 11v6" stroke-linecap="round"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" stroke-linecap="round"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m5 12.5 4.5 4.5L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 4h11l3 3v13H5z" stroke-linejoin="round"/><path d="M8 10h8M8 14h8M8 18h5" stroke-linecap="round"/></svg>',
  };

  // 文件夹备注：仅「小红书笔记归档」目录下的直接子文件夹可加备注
  const NOTE_ROOT = '/小红书笔记归档';
  // 备注编辑白名单：管理员 + 指定账号（与后端 server.js 保持一致）
  const NOTE_EDITORS = ['叶子馨'];
  function isNoteEntry(entry) {
    if (!entry || !entry.isDir || entry.temp) return false;
    if (state.path !== NOTE_ROOT) return false;
    const p = String(entry.path || '');
    return p.startsWith(NOTE_ROOT + '/') && p.slice(NOTE_ROOT.length + 1).indexOf('/') === -1;
  }
  function canEditNote() {
    if (!state.user) return false;
    return state.user.role === 'admin' || NOTE_EDITORS.includes(state.user.username);
  }
  // 生成文件夹名下方的备注元素：备注文本所有人可见；编辑入口仅白名单可见
  function makeNoteEl(entry) {
    if (!isNoteEntry(entry)) return null;
    const editable = canEditNote();
    if (!editable && !entry.note) return null;
    const el = document.createElement(editable ? 'button' : 'div');
    el.className = 'dir-note' + (entry.note ? ' has-note' : ' note-empty') + (editable ? '' : ' note-readonly');
    if (editable) {
      el.type = 'button';
      el.title = entry.note ? '点击编辑备注' : '点击添加备注';
      el.textContent = entry.note ? entry.note : '＋ 添加备注';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        openNoteModal(entry);
      });
    } else {
      el.textContent = entry.note;
    }
    return el;
  }

  function fileIcon(entry) {
    const div = document.createElement('div');
    div.className = `ftype ${groupOf(entry)}`;
    if (entry.isDir) div.innerHTML = ICONS.folder;
    else {
      const ext = extOf(entry.name).toUpperCase();
      div.textContent = (ext || 'FILE').slice(0, 4);
    }
    return div;
  }

  function iconBtn(act, title, svg) {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.dataset.act = act;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = svg;
    return b;
  }

  /* ---------------- 用户与容量 ---------------- */
  function paintUser() {
    const u = state.user;
    if (!u) return;
    $('#userName').textContent = u.username;
    $('#avatar').textContent = (u.username || '?').slice(0, 1).toUpperCase();
    const quota = u.quota || 0;
    const pct = quota ? Math.min(100, (state.usage / quota) * 100) : 0;
    $('#storageText').textContent = `${fmtSize(state.usage)} / ${fmtSize(quota)}`;
    $('#storageBar').style.width = `${Math.max(pct, state.usage > 0 ? 1.5 : 0)}%`;
    const tip = $('#storageTip');
    if (pct >= 92) tip.textContent = '空间即将用尽';
    else if (pct >= 70) tip.textContent = '空间使用较多';
    else tip.textContent = '空间充足';
    const phoneEl = $('#userPhone');
    if (phoneEl) phoneEl.textContent = u.phone ? `已绑定 ${u.phone}` : '个人空间';
  }

  async function refreshUsage() {
    try {
      const data = await api('/api/me');
      state.usage = data.usage;
      state.user = data.user;
      paintUser();
    } catch {
      /* ignore */
    }
  }

  /* ---------------- 面包屑与标题 ---------------- */
  function renderCrumbs() {
    const wrap = $('#crumbs');
    wrap.innerHTML = '';
    const rootBtn = document.createElement('button');
    rootBtn.className = 'crumb' + (state.path === '/' ? ' current' : '');
    rootBtn.textContent = '全部文件';
    rootBtn.onclick = () => navigate('/');
    wrap.appendChild(rootBtn);

    if (state.path !== '/') {
      const parts = state.path.slice(1).split('/');
      let acc = '';
      parts.forEach((part, i) => {
        acc += '/' + part;
        const target = acc;
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '/';
        wrap.appendChild(sep);
        const b = document.createElement('button');
        const isLast = i === parts.length - 1;
        b.className = 'crumb' + (isLast ? ' current' : '');
        b.textContent = part;
        if (!isLast) b.onclick = () => navigate(target);
        wrap.appendChild(b);
      });
    }
  }

  /* ---------------- 文件列表 ---------------- */
  function sortedEntries(list) {
    const arr = list.slice();
    const dir = state.dir;
    arr.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let r = 0;
      if (state.sort === 'name') r = a.name.localeCompare(b.name, 'zh');
      else if (state.sort === 'size') r = (a.size || 0) - (b.size || 0);
      else r = (a.mtime || 0) - (b.mtime || 0);
      return r * dir;
    });
    return arr;
  }

  function currentList() {
    let list = state.entries;
    if (state.keyword) {
      const k = state.keyword.toLowerCase();
      list = list.filter((e) => e.name.toLowerCase().includes(k));
    }
    return sortedEntries(list);
  }

  function renderFiles() {
    const box = $('#fileView');
    const empty = $('#emptyState');
    const fullList = currentList();
    const PAGE = 120;
    if (!state.renderLimit) state.renderLimit = PAGE;
    const list = fullList.slice(0, state.renderLimit);
    box.innerHTML = '';
    box.className = 'file-view ' + state.layout;

    if (!fullList.length) {
      empty.hidden = false;
      $('#emptyTitle').textContent = state.keyword ? '没有找到匹配的文件' : '这里还是空的';
      $('#emptyDesc').textContent = state.keyword
        ? '换个关键词试试'
        : '拖拽文件到此处，或点击右上角「上传文件」';
      return;
    }
    empty.hidden = true;

    if (state.layout === 'list') {
      const head = document.createElement('div');
      head.className = 'file-head';
      head.innerHTML = '<div>名称</div><div>大小</div><div>修改时间</div><div style="text-align:right">操作</div>';
      box.appendChild(head);
      list.forEach((e) => box.appendChild(renderRow(e, false)));
    } else {
      const folders = list.filter((e) => e.isDir);
      const files = list.filter((e) => !e.isDir);
      if (folders.length) {
        const folderList = document.createElement('div');
        folderList.className = 'folder-list';
        folders.forEach((e) => folderList.appendChild(renderRow(e, false)));
        box.appendChild(folderList);
      }
      if (files.length) {
        const grid = document.createElement('div');
        grid.className = 'file-grid';
        files.forEach((e) => grid.appendChild(renderCard(e)));
        box.appendChild(grid);
      }
    }

    if (fullList.length > list.length) {
      const more = document.createElement('div');
      more.className = 'load-more';
      more.textContent = `已显示 ${list.length} / ${fullList.length} 项 · 上滑加载更多`;
      box.appendChild(more);
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((en) => en.isIntersecting)) {
            io.disconnect();
            state.renderLimit += PAGE;
            renderFiles();
          }
        },
        { rootMargin: '240px' }
      );
      io.observe(more);
    }
  }

  function renderRow(entry, showPath) {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.dataset.path = entry.path;

    const nameCell = document.createElement('div');
    nameCell.className = 'col-name';
    if (state.selectMode) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'row-check';
      cb.checked = state.selected.has(entry.path);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => toggleSelect(entry.path));
      nameCell.appendChild(cb);
    }
    nameCell.appendChild(fileIcon(entry));
    const nameWrap = document.createElement('div');
    nameWrap.className = 'name-wrap';
    const nm = document.createElement('div');
    nm.className = 'fname';
    nm.textContent = entry.name;
    nameWrap.appendChild(nm);
    if (showPath) {
      const p = document.createElement('div');
      p.className = 'fpath';
      p.textContent = entry.path;
      nameWrap.appendChild(p);
    }
    if (entry.ownerName && !entry.isDir) {
      const owner = document.createElement('div');
      owner.className = 'fowner';
      owner.textContent = `上传：${entry.ownerName}`;
      nameWrap.appendChild(owner);
    }
    const noteEl = makeNoteEl(entry);
    if (noteEl) nameWrap.appendChild(noteEl);
    nameCell.appendChild(nameWrap);

    const size = document.createElement('div');
    size.className = 'col-size';
    size.textContent = entry.isDir
      ? entry.temp && entry.count != null
        ? `${entry.count} 张`
        : entry.size
        ? fmtSize(entry.size)
        : '文件夹'
      : fmtSize(entry.size);

    const time = document.createElement('div');
    time.className = 'col-time';
    time.textContent = fmtTime(entry.mtime);

    const ops = document.createElement('div');
    ops.className = 'col-ops';
    if (!entry.isDir) ops.appendChild(iconBtn('download', '下载', ICONS.download));
    if (!entry.temp) ops.appendChild(iconBtn('share', '分享', ICONS.share));
    ops.appendChild(iconBtn('more', '更多', ICONS.more));

    row.append(nameCell, size, time, ops);
    return row;
  }

  function renderCard(entry) {
    const card = document.createElement('div');
    card.className = 'file-card';
    card.dataset.path = entry.path;
    if (state.selectMode) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'card-check';
      cb.checked = state.selected.has(entry.path);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => toggleSelect(entry.path));
      card.appendChild(cb);
    }

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (isImage(entry)) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      const previewSrc = `/api/preview?path=${encodeURIComponent(entry.path)}`;
      img.src = `/api/thumb?path=${encodeURIComponent(entry.path)}&w=360`;
      img.alt = entry.name;
      img.onerror = () => {
        if (img.dataset.fallback === '1') {
          thumb.innerHTML = '';
          thumb.appendChild(fileIcon(entry));
          return;
        }
        img.dataset.fallback = '1';
        img.src = previewSrc;
      };
      thumb.appendChild(img);
    } else {
      thumb.appendChild(fileIcon(entry));
    }

    const nm = document.createElement('div');
    nm.className = 'card-name';
    nm.textContent = entry.name;
    nm.title = entry.name;

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.textContent = entry.isDir
      ? `文件夹${entry.size ? ` · ${fmtSize(entry.size)}` : ''}`
      : `${fmtSize(entry.size)} · ${fmtTime(entry.mtime)}${entry.ownerName ? ` · ${entry.ownerName}` : ''}`;

    const noteEl = makeNoteEl(entry);
    if (noteEl) card.appendChild(noteEl);

    const ops = document.createElement('div');
    ops.className = 'card-ops';
    if (!entry.isDir) ops.appendChild(iconBtn('download', '下载', ICONS.download));
    if (!entry.temp) ops.appendChild(iconBtn('share', '分享', ICONS.share));
    ops.appendChild(iconBtn('more', '更多', ICONS.more));

    card.append(thumb, nm, meta, ops);
    return card;
  }

  function entryByPath(p) {
    return state.entries.find((e) => e.path === p) || null;
  }

  function selectRow(el) {
    $$('.file-row.selected, .file-card.selected').forEach((x) => x.classList.remove('selected'));
    if (el) el.classList.add('selected');
  }

  function filesUrl(pathname) {
    return pathname && pathname !== '/' ? `/?path=${encodeURIComponent(pathname)}` : '/';
  }

  function currentUrl() {
    return location.pathname + location.search;
  }

  function pushFilesHistory(pathname) {
    const url = filesUrl(pathname);
    if (currentUrl() === url) return;
    history.pushState({ view: 'files', path: pathname || '/' }, '', url);
  }

  function replaceFilesHistory(pathname) {
    history.replaceState({ view: 'files', path: pathname || '/' }, '', filesUrl(pathname));
  }

  function viewUrl(view, pathname) {
    if (view === 'files') return filesUrl(pathname || state.path);
    return `/?view=${encodeURIComponent(view)}`;
  }

  function pushViewHistory(view) {
    const url = viewUrl(view);
    if (currentUrl() === url) return;
    history.pushState({ view, path: view === 'files' ? state.path : null }, '', url);
  }

  function goView(view) {
    if (view !== 'search') {
      const input = $('#searchInput');
      if (input) input.value = '';
      state.keyword = '';
      state.searchQuery = '';
    }
    const stayInFiles = state.view === 'files' && state.entries.length > 0;
    switchView(view);
    if (view === 'files') loadFiles(state.path, { silent: stayInFiles });
    pushViewHistory(view);
  }

  async function loadFiles(pathname = state.path, opts = {}) {
    const box = $('#fileView');
    const empty = $('#emptyState');
    if (!opts.silent) {
      empty.hidden = true;
      box.className = 'file-view list';
      box.innerHTML = Array.from({ length: 5 })
        .map(() => '<div class="skeleton-row"></div>')
        .join('');
    }
    try {
      let data = null;
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          data = await api(`/api/list?path=${encodeURIComponent(pathname)}`);
          break;
        } catch (err) {
          lastError = err;
          const retryable = !err.status || err.status >= 500;
          if (!retryable || attempt === 2) throw err;
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      if (!data) throw lastError || new Error('加载失败');
      state.path = data.path;
      state.entries = data.entries;
      state.keyword = '';
      state.renderLimit = 120;
      $('#searchInput').value = '';
      renderCrumbs();
      renderFiles();
      renderQuickAccess();
      const title = state.path === '/' ? '我的文件' : state.path.slice(state.path.lastIndexOf('/') + 1);
      $('#pageTitle').textContent = title;
      $('#pageDesc').textContent = state.path === '/' ? '安全存放你的每一个文件' : `位于 ${state.path}`;
      if (opts.replaceHistory) replaceFilesHistory(state.path);
      else if (opts.pushHistory) pushFilesHistory(state.path);
    } catch (err) {
      if (err.status === 404) {
        toast('目录不存在', 'error');
        navigate('/', { replace: true });
      } else {
        toast(err.message, 'error');
      }
    }
  }

  function navigate(pathname, opts = {}) {
    if (state.view !== 'files') switchView('files');
    loadFiles(pathname, {
      silent: !!opts.silent,
      replaceHistory: !!opts.replace,
      pushHistory: !opts.replace,
    });
  }

  /* ---------------- 首页快捷入口 ---------------- */
  const QUICK_TZ = 'Asia/Shanghai';

  async function renderQuickAccess() {
    const box = $('#quickCards');
    if (!box) return;
    if (state.path !== '/') {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: QUICK_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const stores = state.entries.filter((e) => e.isDir);
    if (!stores.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const askedPath = state.path;
    const cards = await Promise.all(
      stores.map(async (d) => {
        try {
          const sub = await api(`/api/list?path=${encodeURIComponent(d.path)}`);
          const hasToday = sub.entries.some((e) => e.name === today && e.isDir);
          return { name: d.name, path: hasToday ? `${d.path}/${today}` : d.path, today: hasToday };
        } catch {
          return null; // 无权限的门店目录自动跳过
        }
      })
    );
    if (state.path !== askedPath || state.view !== 'files') return;
    const ok = cards.filter(Boolean);
    if (!ok.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.innerHTML = ok
      .map(
        (c, i) => `
      <button class="qc-card${c.today ? ' has-today' : ''}" data-qc="${i}">
        <span class="qc-store">${escapeHtml(c.name)}</span>
        <span class="qc-sub">${c.today ? `今日 · ${today.slice(5).replace('-', '/')}` : '打开文件夹'}</span>
      </button>`
      )
      .join('');
    box.querySelectorAll('.qc-card').forEach((btn, i) => {
      btn.onclick = () => navigate(ok[i].path);
    });
  }

  /* ---------------- 视图切换 ---------------- */
  function switchView(view) {
    if (view === 'logs' && (!state.user || state.user.role !== 'admin')) return;
    state.view = view;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    const MORE_VIEWS = ['shares', 'trash', 'downloads', 'admin', 'logs'];
    $$('.tabbar .tab-item').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === (MORE_VIEWS.includes(view) ? 'more' : view))
    );
    $$('.view').forEach((v) => (v.hidden = v.id !== `view-${view}`));
    closeSidebar();
    if (view === 'recent') loadRecent();
    if (view === 'shares') loadShares();
    if (view === 'trash') loadTrash();
    if (view === 'logs') loadLogs(1);
    if (view === 'stats') {
      if (!$('#statFrom').value && !$('#statTo').value) setRangeDates($('#statRange').value || 'today');
      loadStats();
    }
    if (view === 'admin') loadAdmin();
    if (view === 'downloads') loadDownloads();
  }

  /* ---------------- 下载记录视图 ---------------- */
  function dlIcon(status) {
    if (status === 'completed') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.5 2.5 2.5 4.5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    if (status === 'failed') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 16.2v.2" stroke-linecap="round"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v11M8 11l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke-linecap="round"/></svg>';
  }

  function renderDownloads() {
    const box = $('#downloadView');
    const empty = $('#downloadEmpty');
    if (!box) return;
    let items = Array.from(dlState.records.values());
    if (dlState.filter !== 'all') items = items.filter((r) => r.status === dlState.filter);
    items.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    if (!items.length) {
      box.innerHTML = '';
      if (empty) empty.hidden = false;
      updateDlBatchDelete();
      return;
    }
    if (empty) empty.hidden = true;
    const head = document.createElement('div');
    head.className = 'file-head dl-head';
    head.innerHTML = '<div class="col-check"><input type="checkbox" id="dlHeadCheck" /></div><div>文件</div><div>状态</div><div>进度</div><div style="text-align:right">操作</div>';
    box.innerHTML = '';
    box.appendChild(head);
    items.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'dl-row' + (r.status === 'completed' ? ' done' : r.status === 'failed' ? ' err' : '');
      row.dataset.id = r.id;
      const pct = r.progress || 0;
      const statusText = r.statusText || { downloading: '下载中', completed: '已完成', failed: '失败', canceled: '已取消' }[r.status] || r.status;
      const sizeText = fmtSize(r.downloadedBytes || 0) + (r.totalBytes ? ' / ' + fmtSize(r.totalBytes) : '');
      const speedText = r.status === 'downloading' && r.speed ? fmtSpeed(r.speed) : '';
      row.innerHTML = `
        <div class="col-check"><input type="checkbox" class="dl-row-check" data-id="${r.id}" /></div>
        <div class="col-name">
          <span class="dl-ic">${dlIcon(r.status)}</span>
          <span class="name-wrap"><span class="fname">${escapeHtml(r.fileName || r.filePath || '文件')}</span>
          <span class="fpath">${sizeText}${speedText ? ' · ' + speedText : ''}</span></span>
        </div>
        <div class="col-status"><span class="dl-status st-${r.status}">${statusText}</span></div>
        <div class="col-prog"><div class="dl-bar"><span style="width:${pct}%"></span></div><span class="dl-pct">${pct}%</span></div>
        <div class="col-ops">
          ${r.status === 'completed' ? `<button class="icon-btn dl-reopen" title="重新下载" data-id="${r.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v11M8 11l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke-linecap="round"/></svg></button>` : ''}
          <button class="icon-btn dl-del" title="删除记录" data-id="${r.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M6.5 7l.8 12.1A2 2 0 0 0 9.3 21h5.4a2 2 0 0 0 2-1.9L17.5 7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>`;
      box.appendChild(row);
    });
    updateDlBatchDelete();
    const headCheck = $('#dlHeadCheck');
    if (headCheck) {
      headCheck.checked = false;
      headCheck.indeterminate = false;
    }
  }

  async function loadDownloads() {
    const box = $('#downloadView');
    const empty = $('#downloadEmpty');
    if (box) {
      box.innerHTML = Array.from({ length: 4 }).map(() => '<div class="skeleton-row"></div>').join('');
      if (empty) empty.hidden = true;
    }
    try {
      const data = await api('/api/downloads');
      data.downloads.forEach((r) => dlState.records.set(r.id, r));
      renderDownloads();
      updateDlBadge();
      if (!dlState.timer) {
        dlState.timer = setInterval(async () => {
          try {
            const data2 = await api('/api/downloads');
            data2.downloads.forEach((r) => {
              const old = dlState.records.get(r.id);
              if (old && old.status === 'downloading' && r.status !== 'downloading') {
                if (r.status === 'completed') toast('已下载: ' + r.fileName, 'success');
              }
              dlState.records.set(r.id, r);
            });
            if (state.view === 'downloads') renderDownloads();
            updateDlBadge();
          } catch {}
        }, 3000);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function loadRecent() {
    const box = $('#recentView');
    box.innerHTML = Array.from({ length: 4 })
      .map(() => '<div class="skeleton-row"></div>')
      .join('');
    $('#recentEmpty').hidden = true;
    try {
      const data = await api('/api/recent');
      state.recentEntries = data.entries;
      box.innerHTML = '';
      if (!data.entries.length) {
        $('#recentEmpty').hidden = false;
        return;
      }
      const head = document.createElement('div');
      head.className = 'file-head';
      head.innerHTML = '<div>名称</div><div>大小</div><div>修改时间</div><div style="text-align:right">操作</div>';
      box.appendChild(head);
      data.entries.forEach((e) => box.appendChild(renderRow(e, true)));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function loadShares() {
    const box = $('#shareList');
    box.innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row"></div>';
    $('#shareEmpty').hidden = true;
    try {
      const data = await api('/api/shares');
      box.innerHTML = '';
      if (!data.shares.length) {
        $('#shareEmpty').hidden = false;
        return;
      }
      data.shares.forEach((s) => box.appendChild(renderShareItem(s)));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderShareItem(s) {
    const item = document.createElement('div');
    item.className = 'share-item';

    const icon = document.createElement('div');
    icon.className = 'ftype ' + (s.isDir ? 'folder' : groupOf({ name: s.name, isDir: s.isDir }));
    icon.textContent = s.isDir ? '' : (extOf(s.name).toUpperCase() || 'FILE').slice(0, 4);
    if (s.isDir) icon.innerHTML = ICONS.folder;

    const info = document.createElement('div');
    info.className = 'share-info';
    const name = document.createElement('div');
    name.className = 'share-name';
    name.textContent = s.name;
    if (s.hasPassword) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '提取码';
      name.appendChild(tag);
    }
    const meta = document.createElement('div');
    meta.className = 'share-meta';
    const exp = s.expiresAt ? `有效期至 ${new Date(s.expiresAt).toLocaleDateString('zh-CN')}` : '永久有效';
    meta.innerHTML = `<span>创建于 ${fmtTime(s.createdAt)}</span><span>${exp}</span><span>下载 ${s.downloads} 次</span>`;
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'share-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn small';
    copyBtn.textContent = '复制链接';
    copyBtn.onclick = () => copyText(shareUrl(s.token), '链接已复制');
    const openBtn = document.createElement('button');
    openBtn.className = 'btn small';
    openBtn.textContent = '打开';
    openBtn.onclick = () => window.open(shareUrl(s.token), '_blank');
    const delBtn = document.createElement('button');
    delBtn.className = 'btn small danger';
    delBtn.textContent = '取消分享';
    delBtn.onclick = async () => {
      try {
        await api('/api/share/delete', { method: 'POST', body: { token: s.token } });
        toast('已取消分享');
        loadShares();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    actions.append(copyBtn, openBtn, delBtn);
    item.append(icon, info, actions);
    return item;
  }

  function shareUrl(token) {
    return `${location.origin}/s/${token}`;
  }

  /* ---------------- 文件操作 ---------------- */
  function downloadEntry(entry) {
    if (isApp()) {
      appDownload(`/api/download?path=${encodeURIComponent(entry.path)}${entry.isDir ? '&isDir=1' : ''}`);
      return;
    }
    if (isWechat()) {
      wechatDownloadNotice(`/api/download?path=${encodeURIComponent(entry.path)}`);
      return;
    }
    const a = document.createElement('a');
    a.href = `/api/download?path=${encodeURIComponent(entry.path)}`;
    a.download = entry.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function openEntry(entry) {
    if (!entry) return;
    if (entry.isDir) navigate(entry.path);
    else openPreview(entry);
  }

  function handleAction(act, entry, el) {
    if (!entry) return;
    if (act === 'download') return downloadEntry(entry);
    if (act === 'share') return openShareModal(entry);
    if (act === 'preview') return openPreview(entry);
    if (act === 'rename') return openRenameModal(entry);
    if (act === 'note') return openNoteModal(entry);
    if (act === 'move') return openMoveModal(entry.path);
    if (act === 'copy') return openCopyModal(entry.path);
    if (act === 'delete') return openDeleteModal(entry);
    if (act === 'more') return showContextMenu(el, entry);
  }

  /* ---------------- 右键菜单 ---------------- */
  function showContextMenu(anchor, entry) {
    const menu = $('#contextMenu');
    state.ctxTarget = entry;
    menu.innerHTML = '';
    const items = [];
    if (!entry.isDir) items.push({ act: 'preview', label: '预览', icon: ICONS.preview });
    if (!entry.isDir) items.push({ act: 'download', label: '下载', icon: ICONS.download });
    if (!entry.temp) items.push({ act: 'share', label: '创建分享', icon: ICONS.share });
    items.push({ sep: true });
    const canModify = !entry.ownerId || entry.ownerId === state.user.id || state.user.role === 'admin';
    if (isNoteEntry(entry) && canEditNote()) items.push({ act: 'note', label: entry.note ? '编辑备注' : '添加备注', icon: ICONS.note });
    if (canModify) items.push({ act: 'rename', label: '重命名', icon: ICONS.rename });
    if (canModify) items.push({ act: 'copy', label: '复制到…', icon: ICONS.copy });
    if (canModify) items.push({ act: 'move', label: '移动到…', icon: ICONS.folder });
    if (canModify) {
      items.push({ act: 'delete', label: entry.temp ? '永久删除' : '删除', icon: ICONS.trash, danger: true });
    }

    items.forEach((it) => {
      if (it.sep) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
        return;
      }
      const b = document.createElement('button');
      b.className = 'ctx-item' + (it.danger ? ' danger' : '');
      b.innerHTML = it.icon;
      const span = document.createElement('span');
      span.textContent = it.label;
      b.appendChild(span);
      b.onclick = () => {
        hideContextMenu();
        handleAction(it.act, entry);
      };
      menu.appendChild(b);
    });

    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      menu.hidden = false;
      const mw = menu.offsetWidth;
      const mh = menu.offsetHeight;
      let x = r.right - mw;
      let y = r.bottom + 6;
      if (y + mh > window.innerHeight - 8) y = r.top - mh - 6;
      x = Math.max(8, Math.min(x, window.innerWidth - mw - 8));
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
    }
  }

  function hideContextMenu() {
    $('#contextMenu').hidden = true;
    state.ctxTarget = null;
  }

  function openDescribeModal(result) {
    const folder = result && result.folder ? result.folder : '';
    if (!folder) return;
    const carName = result.carName || '';
    const vin = result.vin || '';
    const projectOptions = [
      ['window', '窗膜'],
      ['ppf', '车衣'],
      ['color', '改色'],
      ['mod', '改装'],
    ];
    const brandOptions = ['威固', '龙膜', 'AX', 'CYS', '圣景', '量子', '强生', '雅龙', '3M'];
    openModal(
      `<h3>填写施工信息</h3>
       <p class="modal-desc">照片已归档到「${escapeHtml(
         carName
       )}」，填写后会在该文件夹生成小红书创作说明。</p>
       <div class="describe-block">
         <div class="describe-label">施工项目 <em>必选，可多选</em></div>
         <div class="choice-group" id="projGroup">
           ${projectOptions
             .map(
               ([value, label]) =>
                 `<label class="choice"><input type="checkbox" value="${value}" /><span>${label}</span></label>`
             )
             .join('')}
         </div>
       </div>
       <div class="describe-block" id="brandBlock" hidden>
         <div class="describe-label">施工品牌 <em>可多选</em></div>
         <div class="choice-group" id="brandGroup">
           ${brandOptions
             .map(
               (brand) =>
                 `<label class="choice"><input type="checkbox" value="${brand}" /><span>${brand}</span></label>`
             )
             .join('')}
         </div>
       </div>
       <div class="describe-block">
         <div class="describe-label">产品型号</div>
         <textarea class="select describe-textarea" id="describeModel" rows="3" placeholder="例如：前挡威固V70，侧后威固K15"></textarea>
         <div class="describe-hint">填写窗膜施工部位对应型号；如果是改装，需填写改装项目，需要填全</div>
       </div>
       <div class="modal-error" id="describeError"></div>
       <div class="modal-actions">
         <button class="btn primary" id="describeSave">提交并生成说明</button>
       </div>`,
      (box) => {
        const syncBrand = () => {
          const checked = $$('#projGroup input:checked', box).map((cb) => cb.value);
          const needBrand = checked.some((value) => value !== 'mod');
          $('#brandBlock', box).hidden = !needBrand;
          if (!needBrand) {
            $$('#brandGroup input', box).forEach((cb) => {
              cb.checked = false;
            });
          }
        };
        $$('#projGroup input', box).forEach((cb) =>
          cb.addEventListener('change', syncBrand)
        );
        const save = async () => {
          const projects = $$('#projGroup input:checked', box).map((cb) => cb.value);
          const brands = $('#brandBlock', box).hidden
            ? []
            : $$('#brandGroup input:checked', box).map((cb) => cb.value);
          const model = $('#describeModel', box).value.trim();
          const err = $('#describeError', box);
          if (!projects.length) {
            err.textContent = '请选择施工项目';
            return;
          }
          if (!$('#brandBlock', box).hidden && !brands.length) {
            err.textContent = '请选择施工品牌';
            return;
          }
          if (model.length < 2) {
            err.textContent = '请填写产品型号或改装项目，需要填全';
            return;
          }
          const btn = $('#describeSave', box);
          btn.disabled = true;
          btn.textContent = '保存中…';
          try {
            await api('/api/batch/describe', {
              method: 'POST',
              body: { folder, projects, brands, model, vin },
            });
            closeModal();
            toast('创作说明已生成，可在图片文件夹查看');
            loadFiles(state.path, { silent: true });
          } catch (e2) {
            err.textContent = e2.message;
            btn.disabled = false;
            btn.textContent = '提交并生成说明';
          }
        };
        $('#describeSave', box).onclick = save;
      },
      { closable: false }
    );
  }

  /* ---------------- 模态 ---------------- */
  function openModal(html, onMount, opts = {}) {
    const box = $('#modalBox');
    state.modalClosable = opts.closable !== false;
    box.innerHTML = html;
    $('#modalBackdrop').hidden = false;
    if (onMount) onMount(box);
    const firstInput = box.querySelector('input, select');
    if (firstInput && !isMobile()) setTimeout(() => firstInput.focus(), 60);
  }

  function closeModal() {
    state.modalClosable = true;
    $('#modalBackdrop').hidden = true;
    $('#modalBox').innerHTML = '';
  }

  function openNewFolderModal() {
    openModal(
      `<h3>新建文件夹</h3>
       <p class="modal-desc">将在当前目录创建</p>
       <input class="input" id="folderName" placeholder="文件夹名称" maxlength="200" />
       <div class="modal-error" id="folderError"></div>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn primary" id="folderOk">创建</button>
       </div>`,
      (box) => {
        const input = $('#folderName', box);
        const error = $('#folderError', box);
        const submit = async () => {
          const name = input.value.trim();
          if (!name) {
            error.textContent = '请输入文件夹名称';
            return;
          }
          try {
            await api('/api/mkdir', { method: 'POST', body: { parent: state.path, name } });
            closeModal();
            toast('文件夹已创建');
            loadFiles(state.path, { silent: true });
          } catch (err) {
            error.textContent = err.message;
          }
        };
        $('#folderOk', box).onclick = submit;
        input.onkeydown = (e) => {
          if (e.key === 'Enter') submit();
        };
        box.querySelector('[data-close]').onclick = closeModal;
      }
    );
  }

  function openNoteModal(entry) {
    if (!canEditNote()) {
      toast('只有管理员和叶子馨可以编辑备注', 'error');
      return;
    }
    const noteData = entry.note || '';
    openModal(
      `<h3>文件夹备注</h3>
       <p class="modal-desc">为「${escapeHtml(entry.name)}」添加备注，会显示在该文件夹名称下方，其他人可见</p>
       <textarea class="input note-input" id="noteInput" maxlength="2000" rows="5" placeholder="例如：2026款 贴了威固V100 前挡+侧后，客户微信已加"></textarea>
       <div class="note-count" id="noteCount"></div>
       <div class="modal-error" id="noteError"></div>
       <div class="modal-actions">
         ${noteData ? '<button class="btn danger" id="noteClear">清除备注</button>' : ''}
         <button class="btn" data-close>取消</button>
         <button class="btn primary" id="noteOk">保存</button>
       </div>`,
      (box) => {
        const input = $('#noteInput', box);
        const counter = $('#noteCount', box);
        const errorEl = $('#noteError', box);
        input.value = noteData;
        const updateCount = () => { counter.textContent = `${input.value.length} / 2000`; };
        updateCount();
        input.oninput = updateCount;
        setTimeout(() => input.focus(), 60);

        const submit = async (text) => {
          errorEl.textContent = '';
          try {
            await api('/api/folder-note', { method: 'POST', body: { path: entry.path, note: text } });
            closeModal();
            toast(text.trim() ? '备注已保存' : '备注已清除');
            // 更新本地条目并重渲染，无需整页刷新
            const target = state.entries.find((e) => e.path === entry.path);
            if (target) {
              target.note = text.trim();
              target.noteUpdatedAt = Date.now();
            }
            renderFiles();
          } catch (err) {
            errorEl.textContent = err.message;
          }
        };
        $('#noteOk', box).onclick = () => submit(input.value);
        const clearBtn = $('#noteClear', box);
        if (clearBtn) clearBtn.onclick = () => submit('');
        input.onkeydown = (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit(input.value);
        };
      }
    );
  }

  function openRenameModal(entry) {
    openModal(
      `<h3>重命名</h3>
       <p class="modal-desc">为「${escapeHtml(entry.name)}」设置新名称</p>
       <input class="input" id="renameInput" maxlength="200" />
       <div class="modal-error" id="renameError"></div>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn primary" id="renameOk">保存</button>
       </div>`,
      (box) => {
        const input = $('#renameInput', box);
        input.value = entry.name;
        const dot = entry.isDir ? -1 : entry.name.lastIndexOf('.');
        setTimeout(() => {
          input.focus();
          if (dot > 0) input.setSelectionRange(0, dot);
          else input.select();
        }, 60);
        const error = $('#renameError', box);
        const submit = async () => {
          const name = input.value.trim();
          if (!name || name === entry.name) return closeModal();
          try {
            await api('/api/rename', { method: 'POST', body: { path: entry.path, name } });
            closeModal();
            toast('已重命名');
            refreshAfterChange(entry.path);
          } catch (err) {
            error.textContent = err.message;
          }
        };
        $('#renameOk', box).onclick = submit;
        input.onkeydown = (e) => {
          if (e.key === 'Enter') submit();
        };
        box.querySelector('[data-close]').onclick = closeModal;
      }
    );
  }

  function openMoveModal(paths) {
    const list = Array.isArray(paths) ? paths.slice() : [paths];
    const first = currentList().find((e) => e.path === list[0]) || {};
    const ownerId = first.ownerId || (state.user && state.user.id) || 0;
    const selfPath = String(first.path || '').replace(/^\/@\d+/, '');
    const parentPath = selfPath.slice(0, selfPath.lastIndexOf('/')) || '/';
    let cur = '/';
    openModal(
      `<h3>移动到</h3>
       <p class="modal-desc">为选中的 ${list.length} 项选择目标文件夹</p>
       <div class="move-toolbar">
         <button class="btn small" id="moveUp">上一级</button>
         <span class="move-path" id="movePath">/</span>
       </div>
       <div class="move-list" id="moveList"></div>
       <div class="modal-error" id="moveError"></div>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn primary" id="moveOk">移动到这里</button>
       </div>`,
      (box) => {
        const listEl = $('#moveList', box);
        const pathEl = $('#movePath', box);
        const error = $('#moveError', box);
        const okBtn = $('#moveOk', box);
        const upBtn = $('#moveUp', box);
        const blocked = () => {
          if (list.length !== 1) return '';
          if (cur === parentPath) return '已经在当前文件夹';
          if (first.isDir && (cur === selfPath || cur.startsWith(selfPath + '/'))) {
            return '不能移动到自身或其子文件夹';
          }
          return '';
        };
        const render = async () => {
          pathEl.textContent = cur;
          upBtn.disabled = cur === '/';
          const reason = blocked();
          okBtn.disabled = !!reason;
          error.textContent = reason;
          listEl.innerHTML = '<div class="move-loading">加载中…</div>';
          try {
            const data = await api(`/api/list?ownerId=${ownerId}&path=${encodeURIComponent(cur)}`);
            const dirs = (data.entries || []).filter((e) => e.isDir);
            listEl.innerHTML = '';
            if (!dirs.length) {
              listEl.innerHTML = '<div class="move-loading">这里没有子文件夹</div>';
              return;
            }
            dirs.forEach((d) => {
              const b = document.createElement('button');
              b.className = 'move-item';
              b.innerHTML = ICONS.folder;
              const span = document.createElement('span');
              span.textContent = d.name;
              b.appendChild(span);
              b.onclick = () => {
                cur = d.path;
                render();
              };
              listEl.appendChild(b);
            });
          } catch (err) {
            listEl.innerHTML = '';
            error.textContent = err.message;
          }
        };
        upBtn.onclick = () => {
          if (cur === '/') return;
          cur = cur.slice(0, cur.lastIndexOf('/')) || '/';
          render();
        };
        okBtn.onclick = async () => {
          if (blocked()) return;
          try {
            const result = await api('/api/move-batch', {
              method: 'POST',
              body: { paths: list, to: cur },
            });
            closeModal();
            toast(
              `已移动 ${result.moved} 项` +
                (result.errors && result.errors.length ? `，${result.errors.length} 项失败` : '')
            );
            if (first.temp) {
              const cut = state.path.lastIndexOf('/');
              const parent = cut > 0 ? state.path.slice(0, cut) : '/未归档';
              navigate(parent.startsWith('/未归档') ? parent : '/未归档');
            } else {
              refreshAfterChange(list[0]);
            }
          } catch (err) {
            error.textContent = err.message;
          }
        };
        box.querySelector('[data-close]').onclick = closeModal;
        render();
      }
    );
  }

  function moveSelected() {
    const paths = Array.from(state.selected);
    if (!paths.length) return toast('请先选择要移动的文件', 'error');
    openMoveModal(paths);
  }

  /* 「复制到…」：与移动共用文件夹浏览交互；
     管理员可切换目标账号（跨账号归档），普通用户固定在自己空间 */
  function openCopyModal(paths) {
    const list = Array.isArray(paths) ? paths.slice() : [paths];
    const first = currentList().find((e) => e.path === list[0]) || {};
    const srcOwnerId = first.ownerId || (state.user && state.user.id) || 0;
    const selfPath = String(first.path || '').replace(/^\/@\d+/, '');
    const isAdmin = !!(state.user && state.user.role === 'admin');
    let destOwnerId = srcOwnerId;
    let cur = '/';
    openModal(
      `<h3>复制到</h3>
       <p class="modal-desc">为选中的 ${list.length} 项选择目标文件夹${
         isAdmin ? '（可切换目标账号）' : ''
       }</p>
       <div class="move-toolbar">
         ${isAdmin ? '<select class="move-owner" id="copyOwner"></select>' : ''}
         <button class="btn small" id="copyUp">上一级</button>
         <span class="move-path" id="copyPath">/</span>
       </div>
       <div class="move-list" id="copyList"></div>
       <div class="modal-error" id="copyError"></div>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn primary" id="copyOk">复制到这里</button>
       </div>`,
      (box) => {
        const listEl = $('#copyList', box);
        const pathEl = $('#copyPath', box);
        const error = $('#copyError', box);
        const okBtn = $('#copyOk', box);
        const upBtn = $('#copyUp', box);
        const ownerSel = $('#copyOwner', box);
        const blocked = () => {
          if (destOwnerId !== srcOwnerId) return '';
          if (!first.isDir) return '';
          if (cur === selfPath || cur.startsWith(selfPath + '/')) {
            return '不能复制到自身或其子文件夹';
          }
          return '';
        };
        const render = async () => {
          pathEl.textContent = cur;
          upBtn.disabled = cur === '/';
          const reason = blocked();
          okBtn.disabled = !!reason;
          error.textContent = reason;
          listEl.innerHTML = '<div class="move-loading">加载中…</div>';
          try {
            const q =
              destOwnerId === (state.user && state.user.id)
                ? `path=${encodeURIComponent(cur)}`
                : `ownerId=${destOwnerId}&path=${encodeURIComponent(cur)}`;
            const data = await api(`/api/list?${q}`);
            const dirs = (data.entries || []).filter((e) => e.isDir && !e.temp);
            listEl.innerHTML = '';
            if (!dirs.length) {
              listEl.innerHTML = '<div class="move-loading">这里没有子文件夹</div>';
              return;
            }
            dirs.forEach((d) => {
              const b = document.createElement('button');
              b.className = 'move-item';
              b.innerHTML = ICONS.folder;
              const span = document.createElement('span');
              span.textContent = d.name;
              b.appendChild(span);
              b.onclick = () => {
                cur = String(d.path).replace(/^\/@\d+/, '');
                render();
              };
              listEl.appendChild(b);
            });
          } catch (err) {
            listEl.innerHTML = '';
            error.textContent = err.message;
          }
        };
        if (ownerSel) {
          api('/api/admin/users')
            .then((data) => {
              const users = (data.users || []).filter((u) => u.status !== 'disabled');
              ownerSel.innerHTML = '';
              users.forEach((u) => {
                const opt = document.createElement('option');
                opt.value = String(u.id);
                opt.textContent = u.username + (u.id === srcOwnerId ? '（源）' : '');
                ownerSel.appendChild(opt);
              });
              ownerSel.value = String(destOwnerId);
            })
            .catch(() => {
              ownerSel.innerHTML = '<option value="' + destOwnerId + '">当前账号</option>';
            });
          ownerSel.onchange = () => {
            destOwnerId = Number(ownerSel.value) || srcOwnerId;
            cur = '/';
            render();
          };
        }
        upBtn.onclick = () => {
          if (cur === '/') return;
          cur = cur.slice(0, cur.lastIndexOf('/')) || '/';
          render();
        };
        okBtn.onclick = async () => {
          if (blocked()) return;
          okBtn.disabled = true;
          const dest = destOwnerId === srcOwnerId ? cur : '/@' + destOwnerId + cur;
          let done = 0;
          let firstErr = '';
          for (const p of list) {
            try {
              await api('/api/copy', { method: 'POST', body: { from: p, to: dest } });
              done += 1;
            } catch (err) {
              if (!firstErr) firstErr = err.message;
            }
          }
          if (!done) {
            okBtn.disabled = false;
            error.textContent = firstErr || '复制失败';
            return;
          }
          closeModal();
          toast(`已复制 ${done} 项` + (done < list.length ? `，${list.length - done} 项失败：${firstErr}` : ''));
          refreshAfterChange(list[0]);
        };
        box.querySelector('[data-close]').onclick = closeModal;
        render();
      }
    );
  }

  function copySelected() {
    const paths = Array.from(state.selected);
    if (!paths.length) return toast('请先选择要复制的文件', 'error');
    openCopyModal(paths);
  }

  async function downloadSelected() {
    const paths = Array.from(state.selected);
    if (!paths.length) return toast('请先选择要下载的文件', 'error');
    if (isApp()) {
      paths.forEach((p) => appDownload(`/api/download?path=${encodeURIComponent(p)}`));
      return;
    }
    if (isWechat()) {
      wechatDownloadNotice('');
      return;
    }
    try {
      // 用 form POST 走浏览器原生下载（流式保存，不占内存）；
      // 之前 fetch+blob 会把整个 zip 读进内存，大文件夹会卡死页面
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/api/download-batch';
      form.style.display = 'none';
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'paths';
      input.value = JSON.stringify(paths);
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
      setTimeout(() => form.remove(), 5000);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function openDeleteModal(entry) {
    const isTemp = !!entry.temp;
    openModal(
      `<h3>${isTemp ? '永久删除' : '移入回收站'}</h3>
       <p class="modal-desc">${
         isTemp
           ? `确定永久删除「${escapeHtml(entry.name)}」吗？临时文件夹中的内容删除后无法恢复。`
           : `确定将「${escapeHtml(entry.name)}」移入回收站吗？${
               entry.isDir ? '文件夹内的全部内容会一并移入，' : ''
             }可在 7 天内恢复。`
       }</p>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn danger" id="deleteOk">${isTemp ? '永久删除' : '移入回收站'}</button>
       </div>`,
      (box) => {
        box.querySelector('[data-close]').onclick = closeModal;
        $('#deleteOk', box).onclick = async () => {
          try {
            const result = await api('/api/delete', { method: 'POST', body: { path: entry.path } });
            closeModal();
            toast(isTemp ? '已永久删除' : `已移入回收站，可在 ${result.keepDays || 7} 天内恢复`);
            if (state.view === 'recent') loadRecent();
            else loadFiles(state.path, { silent: true });
            refreshUsage();
          } catch (err) {
            toast(err.message, 'error');
          }
        };
      }
    );
  }

  function refreshAfterChange(oldPath) {
    if (state.view === 'recent') loadRecent();
    else loadFiles(state.path, { silent: true });
    refreshUsage();
  }

  function openShareModal(entry) {
    const isDir = !!entry.isDir;
    openModal(
      `<h3>创建分享</h3>
       <p class="modal-desc">${
         isDir
           ? '文件夹分享链接固定 1 天有效，访问者必须输入提取码，进入后可浏览并下载'
           : '生成一个可对外访问的链接'
       }</p>
       <div class="modal-file">
         <div class="ftype ${groupOf(entry)}">${
        isDir ? ICONS.folder : (extOf(entry.name).toUpperCase() || 'FILE').slice(0, 4)
      }</div>
         <div>
           <div class="fname">${escapeHtml(entry.name)}</div>
           <div class="fpath">${isDir ? '文件夹 · 有效期 1 天' : fmtSize(entry.size)}</div>
         </div>
       </div>
       <label class="field-label">提取码${isDir ? '（必填）' : '（留空则无需提取码）'}</label>
       <input class="input" id="sharePwd" maxlength="16" placeholder="${
         isDir ? '请设置提取码' : '例如 8k2m'
       }" style="margin-top:8px" />
       ${
         isDir
           ? '<input type="hidden" id="shareExpire" value="1" />'
           : `<label class="field-label">有效期</label>
              <select class="select" id="shareExpire">
                <option value="7">7 天</option>
                <option value="1">1 天</option>
                <option value="30">30 天</option>
                <option value="0">永久有效</option>
              </select>`
       }
       <div class="modal-error" id="shareError"></div>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn primary" id="shareOk">生成链接</button>
       </div>`,
      (box) => {
        box.querySelector('[data-close]').onclick = closeModal;
        const error = $('#shareError', box);
        $('#shareOk', box).onclick = async () => {
          const btn = $('#shareOk', box);
          const password = $('#sharePwd', box).value.trim();
          if (isDir && !password) {
            error.textContent = '文件夹分享必须设置提取码';
            return;
          }
          const expiresDays = isDir ? 1 : Number($('#shareExpire', box).value);
          error.textContent = '';
          btn.disabled = true;
          btn.textContent = '生成中…';
          try {
            const data = await api('/api/share', {
              method: 'POST',
              body: { path: entry.path, password, expiresDays },
            });
            showShareResult(box, data.share, password);
            if (state.view === 'shares') loadShares();
          } catch (err) {
            error.textContent = err.message;
            btn.disabled = false;
            btn.textContent = '生成链接';
          }
        };
      }
    );
  }

  function showShareResult(box, share, password) {
    const url = shareUrl(share.token);
    box.innerHTML = `<h3>分享已创建</h3>
      <p class="modal-desc">${password ? '访问者需要输入提取码才能查看' : '任何拿到链接的人都可以访问'}</p>
      <div class="share-result-tip">${ICONS.check}<span>链接生成成功，有效期${
        share.expiresAt ? `至 ${new Date(share.expiresAt).toLocaleDateString('zh-CN')}` : '为永久'
      }</span></div>
      <div class="share-qr" id="shareQr" hidden>
        <div class="share-qr-img" id="shareQrImg"></div>
        <div class="share-qr-tip">微信扫一扫即可打开 · 长按二维码可保存/转发给客户</div>
      </div>
      <label class="field-label">分享链接</label>
      <div class="share-link-box">
        <input id="shareUrlInput" readonly value="${escapeHtml(url)}" />
        <button class="btn primary" id="copyShare">复制</button>
      </div>
      ${
        password
          ? `<label class="field-label">提取码</label>
             <div class="share-link-box"><input readonly value="${escapeHtml(password)}" /><button class="btn" id="copyPwd">复制</button></div>`
          : ''
      }
      <div class="modal-actions">
        <button class="btn" id="shareOpen">打开链接</button>
        <button class="btn primary" data-close>完成</button>
      </div>`;
    renderShareQr($('#shareQr', box), url);
    $('#copyShare', box).onclick = () => copyText(url, '链接已复制');
    if (password) $('#copyPwd', box).onclick = () => copyText(password, '提取码已复制');
    $('#shareOpen', box).onclick = () => window.open(url, '_blank');
    box.querySelector('[data-close]').onclick = closeModal;
  }

  // 二维码组件按需加载（本地托管，MIT，断网也能用）
  let qrLibPromise = null;
  function ensureQrLib() {
    if (window.qrcode) return Promise.resolve();
    if (!qrLibPromise) {
      qrLibPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/assets/vendor/qrcode.js';
        script.async = true;
        script.onload = () => (window.qrcode ? resolve() : reject(new Error('二维码组件不可用')));
        script.onerror = () => {
          qrLibPromise = null;
          reject(new Error('二维码组件加载失败'));
        };
        document.head.appendChild(script);
      });
    }
    return qrLibPromise;
  }

  function qrPngDataUrl(text, target) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text, 'Byte');
    qr.make();
    const count = qr.getModuleCount();
    const quiet = 2;
    const cell = Math.max(3, Math.round(target / (count + quiet * 2)));
    const dim = cell * (count + quiet * 2);
    const canvas = document.createElement('canvas');
    canvas.width = dim;
    canvas.height = dim;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = '#111111';
    for (let r = 0; r < count; r += 1) {
      for (let c = 0; c < count; c += 1) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
      }
    }
    return canvas.toDataURL('image/png');
  }

  function renderShareQr(wrap, url) {
    if (!wrap) return;
    ensureQrLib()
      .then(() => {
        const img = document.createElement('img');
        img.alt = '分享链接二维码';
        img.src = qrPngDataUrl(url, 260);
        const holder = $('#shareQrImg', wrap);
        if (!holder) return;
        holder.innerHTML = '';
        holder.appendChild(img);
        wrap.hidden = false;
      })
      .catch(() => {
        wrap.hidden = true;
      });
  }

  function copyText(text, okMsg) {
    const done = () => toast(okMsg || '已复制');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch {
      toast('复制失败，请手动复制', 'error');
    }
    ta.remove();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ---------------- 预览 ---------------- */
  let currentZoom = null;

  function fallbackCopyText(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function copyToClipboard(text) {
    return new Promise((resolve) => {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard
          .writeText(text)
          .then(() => resolve(true))
          .catch(() => resolve(fallbackCopyText(text)));
        return;
      }
      resolve(fallbackCopyText(text));
    });
  }

  function textPreviewBox(initial, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'preview-text-wrap';
    const bar = document.createElement('div');
    bar.className = 'preview-text-bar';
    const status = document.createElement('span');
    status.className = 'preview-save-status';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'preview-copy';
    copy.textContent = '复制全文';
    const area = document.createElement('textarea');
    area.className = 'preview-text preview-editor';
    area.spellcheck = false;
    area.value = initial;
    area.readOnly = !opts.editable;
    copy.onclick = async () => {
      const text = area.value || '';
      if (!text) return;
      const ok = await copyToClipboard(text);
      toast(ok ? '已复制全文' : '复制失败，请手动选中复制', ok ? undefined : 'error');
    };
    bar.appendChild(status);
    bar.appendChild(copy);
    if (opts.editable) {
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'preview-copy preview-save';
      save.textContent = '保存';
      save.onclick = async () => {
        if (!opts.path) return;
        save.disabled = true;
        status.textContent = '保存中…';
        try {
          const result = await api('/api/save', {
            method: 'POST',
            body: { path: opts.path, text: area.value },
          });
          state.previewDirty = false;
          status.textContent = '已保存';
          const backupTip = result.backupName ? `，旧版已备份为 ${result.backupName}` : '';
          toast(
            result.converted
              ? `已保存为 ${result.name}，原 .doc 已备份为 ${result.backupName}`
              : `已保存${backupTip}`
          );
          if (result.converted) {
            setTimeout(() => {
              closePreview();
              loadFiles(state.path, { silent: true });
            }, 900);
          }
        } catch (err) {
          status.textContent = '保存失败';
          toast(err.message, 'error');
        } finally {
          save.disabled = false;
        }
      };
      area.addEventListener('input', () => {
        state.previewDirty = true;
        status.textContent = '未保存';
      });
      bar.appendChild(save);
    }
    wrap.append(bar, area);
    return wrap;
  }

  function setPreviewDownload(entry) {
    const dl = $('#previewDownload');
    if (isApp()) {
      // App 内（含鸿蒙 ArkWeb）：调原生 CloudDisk.download，不依赖 WebView 导航拦截
      dl.removeAttribute('download');
      dl.href = '#';
      dl.onclick = (e) => {
        e.preventDefault();
        appDownload(`/api/download?path=${encodeURIComponent(entry.path)}`);
      };
    } else if (isPCWechat()) {
      // 电脑桌面微信内置浏览器为 Chromium 内核，可直接下载
      dl.href = `/api/download?path=${encodeURIComponent(entry.path)}`;
      dl.setAttribute('download', entry.name);
      dl.onclick = null;
    } else if (isWechat() && isImage(entry)) {
      // 手机微信图片：inline 长按保存（直接下载）
      dl.removeAttribute('download');
      dl.href = `/api/download?path=${encodeURIComponent(entry.path)}`;
      dl.onclick = null;
    } else if (isWechat()) {
      // 手机微信非图片：微信内无法直接下载
      dl.removeAttribute('download');
      dl.href = '#';
      dl.onclick = (e) => {
        e.preventDefault();
        wechatDownloadNotice(`/api/download?path=${encodeURIComponent(entry.path)}`);
      };
    } else {
      dl.href = `/api/download?path=${encodeURIComponent(entry.path)}`;
      dl.setAttribute('download', entry.name);
      dl.onclick = null;
    }
  }

  function previewImageList(entry) {
    if (!state.entries || state.entries.length < 2) return null;
    const images = sortedEntries(state.entries.filter((e) => !e.isDir && groupOf(e) === 'image'));
    if (images.length < 2) return null;
    const idx = images.findIndex((e) => e.path === entry.path);
    if (idx < 0) return null;
    return { images, idx };
  }

  function renderPreviewImageBody(entry) {
    const body = $('#previewBody');
    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'preview-zoom';
    const img = document.createElement('img');
    img.src = `/api/preview?path=${encodeURIComponent(entry.path)}`;
    img.alt = entry.name;
    wrap.appendChild(img);
    body.appendChild(wrap);
    $('#previewName').textContent = entry.name;
    currentZoom = window.ImageZoom ? window.ImageZoom.enable(wrap, img) : null;
  }

  function switchPreviewImage(delta) {
    const list = state.previewImages;
    if (!list) return;
    const n = list.images.length;
    if (n < 2) return;
    const newIdx = (list.idx + delta + n) % n;
    const entry = list.images[newIdx];
    state.previewImages = { images: list.images, idx: newIdx };
    setPreviewDownload(entry);
    renderPreviewImageBody(entry);
  }

  async function openPreview(entry) {
    const backdrop = $('#previewBackdrop');
    const body = $('#previewBody');
    const nameEl = $('#previewName');
    nameEl.textContent = entry.name;
    body.innerHTML = '';
    state.previewDirty = false;
    const url = `/api/preview?path=${encodeURIComponent(entry.path)}`;
    setPreviewDownload(entry);
    backdrop.hidden = false;

    const group = groupOf(entry);
    if (group === 'image') {
      state.previewImages = previewImageList(entry);
      renderPreviewImageBody(entry);
    } else if (group === 'video') {
      const v = document.createElement('video');
      v.src = url;
      v.controls = true;
      v.autoplay = true;
      body.appendChild(v);
    } else if (group === 'audio') {
      const a = document.createElement('audio');
      a.src = url;
      a.controls = true;
      a.autoplay = true;
      body.appendChild(a);
    } else if (group === 'pdf') {
      const f = document.createElement('iframe');
      f.src = url;
      body.appendChild(f);
    } else if (group === 'text' || group === 'code' || group === 'sheet') {
      const wrap = textPreviewBox('', { path: entry.path, editable: true });
      body.appendChild(wrap);
      const area = wrap.querySelector('textarea');
      area.placeholder = '（空文件，可直接输入内容）';
      try {
        const data = await api(`/api/text?path=${encodeURIComponent(entry.path)}`);
        area.value = data.text || '';
        state.previewDirty = false;
      } catch (err) {
        body.innerHTML = '';
        body.appendChild(fallbackPreview(entry, err.message, url));
      }
    } else if (group === 'doc') {
      const ext = extOf(entry.name);
      if (ext !== 'doc' && ext !== 'docx') {
        body.appendChild(fallbackPreview(entry, '该格式暂不支持在线预览', url));
        return;
      }
      const wrap = textPreviewBox('', { path: entry.path, editable: true });
      body.appendChild(wrap);
      const area = wrap.querySelector('textarea');
      area.placeholder = '（空文档，可直接输入内容）';
      try {
        const data = await api(`/api/doc?path=${encodeURIComponent(entry.path)}`);
        area.value = data.text || '';
        state.previewDirty = false;
      } catch (err) {
        body.innerHTML = '';
        body.appendChild(fallbackPreview(entry, err.message, url));
      }
    } else {
      body.appendChild(fallbackPreview(entry, '该类型暂不支持在线预览', url));
    }
  }

  function fallbackPreview(entry, msg, url) {
    const wrap = document.createElement('div');
    wrap.className = 'preview-fallback';
    wrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M7 3.5h7L19 8.5V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1.5-1.5Z" stroke-linejoin="round"/><path d="M14 3.5V9h5" stroke-linejoin="round"/></svg>';
    const p = document.createElement('p');
    p.textContent = msg;
    let a;
    if (isApp()) {
      a = document.createElement('button');
      a.textContent = '下载文件';
      a.style.cssText = 'background:none;border:0;color:#2757c4;cursor:pointer;font-size:14px;padding:0;text-decoration:underline';
      a.onclick = () => appDownload(`/api/download?path=${encodeURIComponent(entry.path)}`);
    } else if (isWechat()) {
      a = document.createElement('button');
      a.textContent = '下载文件';
      a.style.cssText = 'background:none;border:0;color:#2757c4;cursor:pointer;font-size:14px;padding:0;text-decoration:underline';
      a.onclick = () => wechatDownloadNotice(`/api/download?path=${encodeURIComponent(entry.path)}`);
    } else {
      a = document.createElement('a');
      a.href = `/api/download?path=${encodeURIComponent(entry.path)}`;
      a.setAttribute('download', entry.name);
      a.textContent = '下载文件';
    }
    wrap.append(p, a);
    return wrap;
  }

  function closePreview() {
    if (state.previewDirty && !window.confirm('有未保存的修改，确定关闭吗？')) return;
    state.previewDirty = false;
    state.previewImages = null;
    currentZoom = null;
    $('#previewBackdrop').hidden = true;
    $('#previewBody').innerHTML = '';
  }

  function openLocalPreview(item) {
    const backdrop = $('#previewBackdrop');
    const body = $('#previewBody');
    $('#previewName').textContent = item.name;
    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'preview-zoom';
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = item.name;
    wrap.appendChild(img);
    body.appendChild(wrap);
    const dl = $('#previewDownload');
    dl.href = item.url;
    dl.setAttribute('download', item.name);
    dl.onclick = null;
    backdrop.hidden = false;
    currentZoom = window.ImageZoom ? window.ImageZoom.enable(wrap, img) : null;
  }

  /* ---------------- 上传 ---------------- */
  const uploadState = { queue: [], active: 0, total: 0, done: 0, failed: 0, basePath: '/', tasks: {}, pendingRetries: 0 };
  const MAX_CONCURRENT = 2;
  const MAX_UPLOAD_ATTEMPTS = 2;

  function showDock() {
    $('#uploadDock').hidden = false;
  }

  function hideDockSoon() {
    if (uploadState.active > 0 || uploadState.queue.length > 0) return;
    if (uploadState.pendingRetries > 0) return; // 自动重试等待中
    if (uploadState.failed > 0) return; // 有失败项时保持面板打开，方便重传
    setTimeout(() => {
      if (uploadState.active === 0 && uploadState.queue.length === 0) {
        $('#uploadDock').hidden = true;
        $('#uploadDock').innerHTML = '';
      }
    }, 2600);
  }

  function renderDock() {
    const dock = $('#uploadDock');
    const total = uploadState.total;
    const finished = uploadState.done + uploadState.failed;
    const percent = total ? Math.round((finished / total) * 100) : 0;
    if (!dock.innerHTML) {
      dock.innerHTML = `<div class="dock-head">
          <div><div class="dock-title">上传队列</div><div class="dock-sub" id="dockSub"></div></div>
          <button class="icon-btn" id="dockClose" title="收起"></button>
        </div>
        <div class="dock-body" id="dockBody"></div>
        <div class="dock-footer"><button class="btn small" id="dockRetryAll" hidden></button></div>`;
      $('#dockClose').innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>';
      $('#dockClose').onclick = () => {
        if (uploadState.active > 0) return toast('还有文件正在上传');
        $('#uploadDock').hidden = true;
        $('#uploadDock').innerHTML = '';
      };
      $('#dockRetryAll').onclick = retryAllFailed;
    }
    const sub = $('#dockSub');
    if (sub) {
      sub.textContent =
        finished === total
          ? `${total} 个文件 · ${uploadState.failed ? `${uploadState.failed} 个失败` : '全部完成'} · ${percent}%`
          : `${finished}/${total} · ${percent}%`;
    }
    const retryAll = $('#dockRetryAll');
    if (retryAll) {
      retryAll.hidden = !uploadState.failed;
      retryAll.textContent = `一键重传失败项 (${uploadState.failed})`;
    }
    return $('#dockBody');
  }

  function dockItem(task) {
    const body = renderDock();
    let el = body.querySelector(`[data-task="${task.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'dock-item';
      el.dataset.task = task.id;
      el.innerHTML = `<div class="dock-item-top"><span class="dock-item-name"></span><span class="dock-item-pct"></span></div><div class="dock-bar"><span></span></div>`;
      body.appendChild(el);
    }
    el.querySelector('.dock-item-name').textContent = task.relativeName || task.file.name;
    const pct = el.querySelector('.dock-item-pct');
    const bar = el.querySelector('.dock-bar span');
    if (task.status === 'done') {
      el.classList.add('done');
      pct.textContent = '完成';
      bar.style.width = '100%';
    } else if (task.status === 'error') {
      el.classList.add('error');
      pct.textContent = '失败';
      bar.style.width = '100%';
      let retryBtn = el.querySelector('.dock-retry');
      if (!retryBtn) {
        retryBtn = document.createElement('button');
        retryBtn.className = 'icon-btn dock-retry';
        retryBtn.title = '重试';
        retryBtn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>';
        retryBtn.onclick = () => retryUpload(task);
        el.appendChild(retryBtn);
      }
    } else if (task.status === 'retry') {
      pct.textContent = `重试中 (${task.attempts}/${MAX_UPLOAD_ATTEMPTS})`;
      bar.style.width = `${task.progress}%`;
    } else {
      pct.textContent = `${task.progress}%`;
      bar.style.width = `${task.progress}%`;
    }
    return el;
  }

  function enqueueUploads(items, basePath) {
    if (!items.length) return;
    uploadState.basePath = basePath;
    uploadState.total += items.length;
    items.forEach((it) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const task = {
        id,
        file: it.file,
        relativeName: it.relative,
        basePath,
        progress: 0,
        status: 'wait',
        attempts: 0,
      };
      uploadState.tasks[id] = task;
      uploadState.queue.push(task);
    });
    showDock();
    renderDock();
    pumpUploads();
  }

  function retryUpload(task) {
    if (task.status !== 'error' || uploadState.queue.includes(task)) return;
    task.attempts = 0;
    task.progress = 0;
    task.status = 'wait';
    uploadState.failed = Math.max(0, uploadState.failed - 1);
    uploadState.queue.push(task);
    showDock();
    renderDock();
    pumpUploads();
  }

  function retryAllFailed() {
    const failed = Object.values(uploadState.tasks).filter((t) => t.status === 'error');
    if (!failed.length) return;
    failed.forEach((t) => {
      t.attempts = 0;
      t.progress = 0;
      t.status = 'wait';
    });
    uploadState.failed = 0;
    uploadState.queue.push(...failed);
    showDock();
    renderDock();
    pumpUploads();
    toast(`已重新排队 ${failed.length} 个文件`, 'success');
  }

  function pumpUploads() {
    while (uploadState.active < MAX_CONCURRENT && uploadState.queue.length) {
      const task = uploadState.queue.shift();
      uploadState.active++;
      uploadOne(task).finally(() => {
        uploadState.active--;
        if (uploadState.queue.length === 0 && uploadState.active === 0) {
          hideDockSoon();
          refreshUsage();
          if (state.view === 'files' && state.path === task.basePath) {
            loadFiles(state.path, { silent: true });
          }
        }
        pumpUploads();
      });
    }
  }

  async function ensureDir(basePath, relative) {
    const parts = relative.split('/').filter(Boolean);
    parts.pop();
    if (!parts.length) return;
    let current = basePath;
    for (const part of parts) {
      current = current === '/' ? `/${part}` : `${current}/${part}`;
      try {
        await api('/api/mkdir', { method: 'POST', body: { parent: current.slice(0, current.lastIndexOf('/')) || '/', name: part } });
      } catch (err) {
        if (err.status !== 409) throw err;
      }
    }
  }

  function uploadOne(task) {
    return new Promise((resolve) => {
      dockItem(task);
      (async () => {
        try {
          if (task.relativeName.includes('/')) await ensureDir(task.basePath, task.relativeName);
          const target =
            task.basePath === '/'
              ? `/${task.relativeName}`
              : `${task.basePath}/${task.relativeName}`;
          const xhr = new XMLHttpRequest();
          task.xhr = xhr;
          xhr.open('PUT', `/api/upload?path=${encodeURIComponent(target)}`);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              task.progress = Math.min(99, Math.round((e.loaded / e.total) * 100));
              dockItem(task);
              renderDock();
            }
          };
          const failTask = (msg, retryable) => {
            if (retryable && task.attempts < MAX_UPLOAD_ATTEMPTS) {
              task.attempts += 1;
              task.status = 'retry';
              uploadState.pendingRetries += 1;
              showDock();
              dockItem(task);
              renderDock();
              toast(`${msg}，自动重试中…`, 'error');
              setTimeout(() => {
                uploadState.pendingRetries = Math.max(0, uploadState.pendingRetries - 1);
                task.status = 'wait';
                task.progress = 0;
                uploadState.queue.push(task);
                showDock();
                pumpUploads();
              }, 1200 * task.attempts);
            } else {
              task.status = 'error';
              uploadState.failed++;
              toast(msg, 'error');
              showDock();
              dockItem(task);
              renderDock();
            }
            resolve();
          };
          xhr.onload = () => {
            let data = {};
            try {
              data = JSON.parse(xhr.responseText);
            } catch {
              /* ignore */
            }
            if (xhr.status >= 200 && xhr.status < 300) {
              task.status = 'done';
              task.progress = 100;
              uploadState.done++;
              dockItem(task);
              renderDock();
              resolve();
            } else {
              failTask(
                data.error || `「${task.file.name}」上传失败`,
                xhr.status >= 500 || xhr.status === 429
              );
            }
          };
          xhr.onerror = () => failTask(`「${task.file.name}」网络异常`, true);
          xhr.send(task.file);
        } catch (err) {
          task.status = 'error';
          uploadState.failed++;
          dockItem(task);
          renderDock();
          toast(err.message, 'error');
          resolve();
        }
      })();
    });
  }

  async function collectDropped(items) {
    const out = [];
    const walkEntry = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        out.push({ file, relative: prefix + entry.name });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = () =>
          new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        let batch;
        do {
          batch = await readAll();
          for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`);
        } while (batch.length);
      }
    };
    for (const item of items) {
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if (entry) await walkEntry(entry, '');
      else {
        const file = item.getAsFile && item.getAsFile();
        if (file) out.push({ file, relative: file.name });
      }
    }
    return out;
  }

  /* ---------------- 批量选择与删除 ---------------- */
  function toggleSelect(path) {
    if (state.selected.has(path)) state.selected.delete(path);
    else state.selected.add(path);
    updateSelectBar();
    renderFiles();
  }

  function updateSelectBar() {
    const n = state.selected.size;
    const info = $('#selectInfo');
    if (info) info.textContent = `已选 ${n} 项`;
    const btn = $('#selectDelete');
    if (btn) btn.disabled = n === 0;
    const moveBtn = $('#selectMove');
    if (moveBtn) moveBtn.disabled = n === 0;
    const dlBtn = $('#selectDownload');
    if (dlBtn) dlBtn.disabled = n === 0;
    const allBtn = $('#selectAll');
    const list = currentList();
    if (allBtn) {
      allBtn.textContent = list.length > 0 && n >= list.length ? '取消全选' : '全选';
      allBtn.disabled = list.length === 0;
    }
  }

  function toggleSelectAll() {
    const list = currentList();
    if (!list.length) return;
    if (state.selected.size >= list.length) {
      state.selected.clear();
    } else {
      state.selected = new Set(list.map((e) => e.path));
    }
    updateSelectBar();
    renderFiles();
  }

  function setSelectMode(on) {
    state.selectMode = on;
    state.selected.clear();
    const modeBtn = $('#selectModeBtn');
    if (modeBtn) modeBtn.classList.toggle('active', on);
    const bar = $('#selectBar');
    if (bar) bar.hidden = !on;
    updateSelectBar();
    renderFiles();
  }

  function deleteSelected() {
    const paths = Array.from(state.selected);
    if (!paths.length) return toast('请先选择要删除的文件', 'error');
    openModal(
      `<h3>批量移入回收站</h3>
       <p class="modal-desc">确定将选中的 ${paths.length} 项移入回收站吗？可在 7 天内恢复。</p>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn danger" id="batchDelOk">移入回收站</button>
       </div>`,
      (box) => {
        box.querySelector('[data-close]').onclick = closeModal;
        $('#batchDelOk', box).onclick = async () => {
          try {
            const result = await api('/api/delete-batch', { method: 'POST', body: { paths } });
            closeModal();
            toast(`已移入回收站 ${result.deleted} 项`);
            setSelectMode(false);
            loadFiles(state.path, { silent: true });
            refreshUsage();
          } catch (err) {
            toast(err.message, 'error');
          }
        };
      }
    );
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    $$('.nav-item').forEach((btn) => {
      btn.onclick = () => goView(btn.dataset.view);
    });

    const isMobileUpload = () =>
      window.matchMedia('(max-width: 820px)').matches || 'ontouchstart' in window;

    // 触发文件选择 input 的兼容 helper：
    // 1) iOS（含 PWA 独立模式、微信内置浏览器）必须移除 capture 属性，
    //    否则 tap 无反应（WebKit bug）；移除后系统选择器自带「拍照/照片图库」
    // 2) 统一入口，保证调用发生在用户手势的同步调用栈内
    const isIOSDevice = () =>
      /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    function triggerFileInput(input) {
      if (!input) return;
      const standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        navigator.standalone === true;
      if ((isIOSDevice() || standalone) && input.getAttribute('capture')) {
        input.removeAttribute('capture');
      }
      input.click();
    }

    const pendingBatch = { path: '', items: [], busy: false };

    function photoName(file) {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(
        d.getHours()
      )}${p(d.getMinutes())}${p(d.getSeconds())}`;
      let ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!/^(jpe?g|png|webp|heic|heif|gif)$/.test(ext)) {
        ext = file.type && file.type.includes('png') ? 'png' : 'jpg';
      }
      return `照片_${stamp}.${ext}`;
    }

    function openUploadSheet() {
      $('#uploadSheet').hidden = false;
    }
    function closeUploadSheet() {
      $('#uploadSheet').hidden = true;
    }

    function canBatchUploadHere() {
      const parts = state.path.split('/').filter(Boolean);
      if (parts.length !== 2) {
        toast('请先进入「门店 / 当天日期」文件夹再上传', 'error');
        return false;
      }
      return true;
    }

    function isImageFile(file) {
      return /^image\//.test(file.type) || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(file.name);
    }

    function resetBatch() {
      pendingBatch.items.forEach((it) => URL.revokeObjectURL(it.url));
      pendingBatch.items = [];
      pendingBatch.path = '';
      pendingBatch.busy = false;
      renderBatch();
    }

    function renderBatch() {
      const dock = $('#batchDock');
      if (!pendingBatch.items.length) {
        dock.hidden = true;
        return;
      }
      dock.hidden = false;
      const n = pendingBatch.items.length;
      $('#batchSub').textContent = `${n} / 10-30 · ${pendingBatch.path}`;
      $('#batchSubmit').disabled =
        n < 10 || n > 30 || pendingBatch.busy || !pendingBatch.items.some((it) => it.isVin);
      const vinItem = pendingBatch.items.find((it) => it.isVin);
      const vinPreview = $('#batchVinPreview');
      if (vinItem) {
        $('#batchVinImg').src = vinItem.url;
        vinPreview.hidden = false;
      } else {
        vinPreview.hidden = true;
      }
      const box = $('#batchThumbs');
      box.innerHTML = '';
      pendingBatch.items.forEach((it) => {
        const cell = document.createElement('div');
        cell.className = 'batch-item';
        const img = document.createElement('img');
        img.src = it.url;
        img.alt = it.name;
        const label = document.createElement('label');
        label.className = 'vinmark';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'vinPick';
        radio.checked = !!it.isVin;
        radio.onchange = () => {
          pendingBatch.items.forEach((x) => (x.isVin = false));
          it.isVin = true;
          renderBatch();
        };
        label.append(radio, document.createTextNode('车架号'));
        cell.append(img, label);
        box.appendChild(cell);
      });
    }

    const PHOTO_HASH_KEY = 'cd-photo-hashes-v1';
    const PHOTO_SIMILAR_DISTANCE = 8;

    function photoHashHistory() {
      try {
        const list = JSON.parse(localStorage.getItem(PHOTO_HASH_KEY) || '[]');
        const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
        return Array.isArray(list) ? list.filter((x) => x && x.hash && x.ts >= cutoff) : [];
      } catch {
        return [];
      }
    }

    function rememberPhotoHash(hash, name) {
      try {
        const list = photoHashHistory();
        list.push({ hash, name, ts: Date.now() });
        localStorage.setItem(PHOTO_HASH_KEY, JSON.stringify(list.slice(-500)));
      } catch {
        /* ignore */
      }
    }

    function hashDistance(a, b) {
      if (!a || !b || a.length !== b.length) return 999;
      let d = 0;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) d += 1;
      return d;
    }

    async function fileDHash(file) {
      let bitmap = null;
      try {
        bitmap = await createImageBitmap(file);
      } catch {
        /* fallback below */
      }
      const canvas = document.createElement('canvas');
      canvas.width = 9;
      canvas.height = 8;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return '';
      try {
        if (bitmap) {
          ctx.drawImage(bitmap, 0, 0, 9, 8);
        } else {
          const url = URL.createObjectURL(file);
          try {
            const img = await new Promise((resolve, reject) => {
              const im = new Image();
              im.onload = () => resolve(im);
              im.onerror = () => reject(new Error('decode'));
              im.src = url;
            });
            ctx.drawImage(img, 0, 0, 9, 8);
          } finally {
            URL.revokeObjectURL(url);
          }
        }
      } catch {
        return '';
      } finally {
        if (bitmap && bitmap.close) bitmap.close();
      }
      let px;
      try {
        px = ctx.getImageData(0, 0, 9, 8).data;
      } catch {
        return '';
      }
      let bits = '';
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          const i = (y * 9 + x) * 4;
          const j = (y * 9 + x + 1) * 4;
          const a = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
          const b = px[j] * 0.299 + px[j + 1] * 0.587 + px[j + 2] * 0.114;
          bits += a > b ? '1' : '0';
        }
      }
      return bits;
    }

    function getImageRatio(file) {
      return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve(img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 0);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          resolve(0);
        };
        img.src = url;
      });
    }

    function isPortrait(ratio) {
      return ratio > 0 && ratio < 1;
    }

    function showUploadNotice(onConfirm) {
      openModal(
        `<h3>上传前请确认</h3>
         <ul class="upload-rules">
           <li>车架号照片必须要拍</li>
           <li>照片必须为竖屏（高度大于宽度）</li>
           <li>上传照片不能少于 10 张</li>
           <li>上传时间预计 30 秒左右，期间不要关闭会话窗口</li>
         </ul>
         <div class="modal-actions">
           <button class="btn" data-close>取消</button>
           <button class="btn primary" id="uploadNoticeOk">我知道了，开始上传</button>
         </div>`,
        (box) => {
          box.querySelector('[data-close]').onclick = closeModal;
          $('#uploadNoticeOk', box).onclick = () => {
            closeModal();
            onConfirm();
          };
        }
      );
    }

    async function addToBatch(files, fromCamera) {
      if (!files.length) return;
      if (!canBatchUploadHere()) return;
      if (pendingBatch.path && pendingBatch.path !== state.path) resetBatch();
      pendingBatch.path = state.path;
      const history = photoHashHistory();
      for (const file of files) {
        if (pendingBatch.items.length >= 30) {
          toast('每批最多 30 张图片，多余文件已忽略', 'error');
          break;
        }
        if (!isImageFile(file)) {
          toast(`「${file.name}」不是图片，已忽略`, 'error');
          continue;
        }
        const ratio = await getImageRatio(file);
        if (!isPortrait(ratio)) {
          toast(`「${file.name}」不是竖屏照片，已忽略`, 'error');
          continue;
        }
        const hash = await fileDHash(file);
        if (hash) {
          const queued = pendingBatch.items.find(
            (it) => it.hash && hashDistance(hash, it.hash) <= PHOTO_SIMILAR_DISTANCE
          );
          const recent = queued
            ? null
            : history.find((x) => hashDistance(hash, x.hash) <= PHOTO_SIMILAR_DISTANCE);
          if (queued || recent) {
            const same = queued ? `已选照片「${queued.name}」` : `最近上传的「${recent.name}」`;
            toast(`「${file.name}」与${same}过于相似，请重新选择`, 'error');
            continue;
          }
        }
        pendingBatch.items.push({
          file,
          name: fromCamera ? photoName(file) : file.name,
          url: URL.createObjectURL(file),
          isVin: false,
          hash,
        });
      }
      renderBatch();
    }

    function putFile(url, file, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', url);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) return resolve();
          let msg = '上传失败';
          try {
            msg = JSON.parse(xhr.responseText).error || msg;
          } catch {
            /* ignore */
          }
          reject(new Error(msg));
        };
        xhr.onerror = () => reject(new Error('网络异常，上传失败'));
        xhr.send(file);
      });
    }

    async function submitBatch() {
      if (pendingBatch.busy) return;
      const count = pendingBatch.items.length;
      if (count < 10 || count > 30) return toast('每批需要 10-30 张图片', 'error');
      for (const item of pendingBatch.items) {
        const ratio = await getImageRatio(item.file);
        if (!isPortrait(ratio)) {
          return toast(`「${item.name}」不是竖屏照片，请重新拍摄`, 'error');
        }
      }
      if (pendingBatch.path !== state.path) return toast('请回到上传时的文件夹再提交', 'error');
      if (!pendingBatch.items.some((it) => it.isVin)) {
        return toast('请勾选一张车架号照片，系统会自动识别 VIN', 'error');
      }
      pendingBatch.busy = true;
      renderBatch();
      const sub = $('#batchSub');
      try {
        const start = await api('/api/batch/start', {
          method: 'POST',
          body: { path: pendingBatch.path },
        });
        const batchId = start.batchId;
        for (let i = 0; i < count; i++) {
          const it = pendingBatch.items[i];
          const uploadName = it.isVin && !/车架号/.test(it.name) ? `车架号_${it.name}` : it.name;
          sub.textContent = `正在上传 ${i + 1} / ${count}`;
          await putFile(
            `/api/batch/file?batchId=${encodeURIComponent(batchId)}&index=${i}&name=${encodeURIComponent(uploadName)}`,
            it.file,
            (pct) => {
              sub.textContent = `正在上传 ${i + 1}/${count} · ${pct}%`;
            }
          );
        }
        sub.textContent = '正在识别车架号、车型并归档…';
        const result = await api('/api/batch/commit', { method: 'POST', body: { batchId } });
        const extra = result.folder ? ` · 已归档到「${result.carName || '车型'}」` : '';
        const renamed = result.renamed ? ` · 已更新 ${result.renamed} 个历史文件夹名称` : '';
        toast(`上传成功：${result.count} 张 · ${result.carName || ''}${extra}${renamed}`.trim());
        if (result.vinSource === 'fallback') {
          toast(
            `勾选的车架号照片未识别到 VIN，已自动从「${result.vinFallbackName || '其他照片'}」识别到 ${result.vin || 'VIN'}，下次请勾选正确的车架号照片`,
            'error'
          );
        }
        for (const it of pendingBatch.items) {
          if (it.hash) rememberPhotoHash(it.hash, it.name);
        }
        resetBatch();
        loadFiles(state.path, { silent: true });
        refreshUsage();
        openDescribeModal(result);
      } catch (err) {
        toast(err.message || '上传失败，本批已取消', 'error');
        resetBatch();
      } finally {
        pendingBatch.busy = false;
      }
    }

    const adminUpload = () => !!(state.user && state.user.role === 'admin');

    $('#uploadBtn').onclick = () => {
      if (adminUpload()) {
        if (isMobileUpload()) openUploadSheet();
        else triggerFileInput($('#fileInput'));
        return;
      }
      showUploadNotice(() => {
        if (isMobileUpload()) openUploadSheet();
        else triggerFileInput($('#fileInput'));
      });
    };
    $('#cameraBtn').onclick = () => {
      if (adminUpload()) {
        triggerFileInput($('#cameraInput'));
        return;
      }
      showUploadNotice(() => triggerFileInput($('#cameraInput')));
    };

    $('#fileInput').onchange = () => {
      const files = Array.from($('#fileInput').files);
      $('#fileInput').value = '';
      if (!files.length) return;
      if (adminUpload()) {
        enqueueUploads(files.map((file) => ({ file, relative: file.name })), state.path);
        return;
      }
      addToBatch(files, false);
    };

    $('#albumInput').onchange = () => {
      const files = Array.from($('#albumInput').files);
      $('#albumInput').value = '';
      if (!files.length) return;
      if (adminUpload()) {
        enqueueUploads(files.map((file) => ({ file, relative: file.name })), state.path);
        return;
      }
      addToBatch(files, false);
    };

    $('#cameraInput').onchange = () => {
      const file = $('#cameraInput').files[0];
      $('#cameraInput').value = '';
      if (!file) return;
      if (adminUpload()) {
        enqueueUploads([{ file, relative: file.name }], state.path);
        return;
      }
      addToBatch([file], true);
    };

    $$('#uploadSheet [data-sheet-close]').forEach((el) => {
      el.onclick = closeUploadSheet;
    });
    $$('#uploadSheet [data-upload]').forEach((btn) => {
      btn.onclick = () => {
        const source = btn.dataset.upload;
        closeUploadSheet();
        if (source === 'camera') triggerFileInput($('#cameraInput'));
        else if (source === 'album') triggerFileInput($('#albumInput'));
        else triggerFileInput($('#fileInput'));
      };
    });

    $('#batchClear').innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>';
    $('#batchClear').onclick = resetBatch;
    $('#batchAddMore').onclick = () => triggerFileInput($('#fileInput'));
    $('#batchSubmit').onclick = submitBatch;
    $('#batchVinZoom').onclick = () => {
      const it = pendingBatch.items.find((x) => x.isVin);
      if (it) openLocalPreview(it);
    };
    $('#statRange').onchange = () => {
      setRangeDates($('#statRange').value);
      loadStats();
    };
    ['statFrom', 'statTo'].forEach((id) => {
      $('#' + id).onchange = () => {
        $('#statRange').value = 'custom';
        loadStats();
      };
    });
    $('#exportStats').onclick = exportStatsCsv;

    $('#tmplSave').onclick = async () => {
      const editor = $('#tmplEditor');
      if (!editor) return;
      const status = $('#tmplStatus');
      status.textContent = '保存中…';
      try {
        await api('/api/admin/describe-template', {
          method: 'POST',
          body: { template: editor.value },
        });
        status.textContent = '已保存';
        toast('模板已保存，新的创作说明将使用此模板');
      } catch (err) {
        status.textContent = '保存失败';
        toast(err.message, 'error');
      }
    };
    $('#tmplReset').onclick = () => {
      const editor = $('#tmplEditor');
      if (!editor || !state.templateDefault) return;
      if (!window.confirm('恢复为默认模板？恢复后需点击「保存模板」才会生效。')) return;
      editor.value = state.templateDefault;
      $('#tmplStatus').textContent = '未保存';
    };
    $('#tmplEditor').addEventListener('input', () => {
      $('#tmplStatus').textContent = '未保存';
    });
    $('#wbSave').onclick = async () => {
      const input = $('#wbUrl');
      const status = $('#wbStatus');
      status.textContent = '保存中…';
      try {
        const value = (input.value || '').trim();
        await api('/api/admin/workbuddy', { method: 'POST', body: { url: value } });
        status.textContent = value ? '已保存' : '已清空';
        toast(value ? '投递地址已保存' : '已清空投递地址');
      } catch (err) {
        status.textContent = '保存失败';
        toast(err.message, 'error');
      }
    };

    $('#newFolderBtn').onclick = openNewFolderModal;

    const fileView = $('#fileView');
    fileView.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) {
        const path = act.closest('[data-path]')?.dataset.path;
        const entry = entryByPath(path);
        if (entry) handleAction(act.dataset.act, entry, act);
        return;
      }
      const el = e.target.closest('[data-path]');
      if (!el) return;
      const entry = entryByPath(el.dataset.path);
      if (!entry) return;
      if (state.selectMode) {
        toggleSelect(entry.path);
        return;
      }
      if (state.layout === 'grid') {
        if (entry.isDir) navigate(entry.path);
        else openPreview(entry);
        return;
      }
      if (isMobile()) openEntry(entry);
      else selectRow(el);
    });

    fileView.addEventListener('dblclick', (e) => {
      if (state.selectMode) return;
      if (e.target.closest('[data-act]')) return;
      const el = e.target.closest('[data-path]');
      if (!el) return;
      const entry = entryByPath(el.dataset.path);
      if (entry) openEntry(entry);
    });

    fileView.addEventListener('contextmenu', (e) => {
      const el = e.target.closest('[data-path]');
      if (!el) return;
      e.preventDefault();
      const entry = entryByPath(el.dataset.path);
      if (entry) {
        selectRow(el);
        showContextMenu(el, entry);
      }
    });

    const recentView = $('#recentView');
    recentView.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      const el = e.target.closest('[data-path]');
      if (!el) return;
      const entry = state.recentEntries?.find((x) => x.path === el.dataset.path);
      if (act && entry) return handleAction(act.dataset.act, entry, act);
      if (entry && isMobile()) openEntry(entry);
    });
    recentView.addEventListener('dblclick', (e) => {
      const el = e.target.closest('[data-path]');
      if (!el) return;
      const entry = state.recentEntries?.find((x) => x.path === el.dataset.path);
      if (entry) openEntry(entry);
    });
    recentView.addEventListener('contextmenu', (e) => {
      const el = e.target.closest('[data-path]');
      if (!el) return;
      e.preventDefault();
      const entry = state.recentEntries?.find((x) => x.path === el.dataset.path);
      if (entry) showContextMenu(el, entry);
    });

    $$('.chip[data-sort]').forEach((chip) => {
      chip.onclick = () => {
        const s = chip.dataset.sort;
        if (state.sort === s) state.dir *= -1;
        else {
          state.sort = s;
          state.dir = 1;
        }
        $$('.chip[data-sort]').forEach((c) => c.classList.toggle('active', c === chip));
        $('#sortDir').classList.toggle('asc', state.dir === -1);
        renderFiles();
      };
    });
    $('#sortDir').onclick = () => {
      state.dir *= -1;
      $('#sortDir').classList.toggle('asc', state.dir === -1);
      renderFiles();
    };

    $$('#viewToggle button').forEach((btn) => {
      btn.onclick = () => {
        state.layout = btn.dataset.layout;
        localStorage.setItem('cd-layout-v2', state.layout);
        $$('#viewToggle button').forEach((b) => b.classList.toggle('active', b === btn));
        renderFiles();
      };
    });

    let searchTimer = null;
    $('#searchInput').addEventListener('input', (e) => {
      const q = e.target.value.trim();
      state.keyword = q;
      clearTimeout(searchTimer);
      if (!q) {
        if (state.view === 'search') {
          switchView('files');
          loadFiles(state.path, { silent: true });
          pushViewHistory('files');
        }
        return;
      }
      searchTimer = setTimeout(() => runSearch(q), 280);
    });

    $('#searchInput').addEventListener('blur', () => {
      if (isMobile()) $('.search').classList.remove('open');
    });
    $('.search').addEventListener('click', () => {
      if (isMobile()) {
        $('.search').classList.add('open');
        $('#searchInput').focus();
      }
    });

    $('#themeBtn').onclick = () => {
      const dark = document.documentElement.dataset.theme !== 'dark';
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      localStorage.setItem('cd-theme', dark ? 'dark' : 'light');
    };

    $('#accountBtn').onclick = openPasswordModal;
    $('#logoutBtn').onclick = async () => {
      try {
        await api('/api/logout', { method: 'POST' });
      } catch {
        /* ignore */
      }
      location.href = '/login';
    };

    $('#modalBackdrop').addEventListener('click', (e) => {
      if (e.target.id === 'modalBackdrop' && state.modalClosable !== false) closeModal();
    });

    $('#previewClose').onclick = closePreview;
    $('#zoomIn').onclick = () => currentZoom && currentZoom.zoomIn();
    $('#zoomOut').onclick = () => currentZoom && currentZoom.zoomOut();
    $('#zoomReset').onclick = () => currentZoom && currentZoom.reset();
    $('#previewBackdrop').addEventListener('click', (e) => {
      if (e.target.closest('img')) return;
      if (e.target.closest('button, a, textarea, video, audio, iframe, input')) return;
      if (e.target.closest('#previewBody') || e.target.closest('#previewHead')) closePreview();
    });

    let touchStartX = 0, touchStartY = 0, touchStartScale = 1;
    $('#previewBackdrop').addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartScale = currentZoom && currentZoom.getScale ? currentZoom.getScale() : 1;
    }, { passive: true });
    $('#previewBackdrop').addEventListener('touchend', (e) => {
      if (e.changedTouches.length !== 1) return;
      if (!state.previewImages || touchStartScale > 1) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      switchPreviewImage(dx < 0 ? 1 : -1);
    }, { passive: true });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#contextMenu') && !e.target.closest('[data-act="more"]')) hideContextMenu();
    });
    document.addEventListener('scroll', hideContextMenu, true);
    window.addEventListener('resize', hideContextMenu);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#previewBackdrop').hidden) closePreview();
        else if (!$('#modalBackdrop').hidden && state.modalClosable !== false) closeModal();
        else hideContextMenu();
      }
    });

    $$('.dl-filter .chip').forEach((chip) => {
      chip.onclick = () => {
        dlState.filter = chip.dataset.dlFilter || 'all';
        $$('.dl-filter .chip').forEach((c) => c.classList.toggle('active', c === chip));
        renderDownloads();
      };
    });
    document.addEventListener('click', (e) => {
      const del = e.target.closest('.dl-del');
      if (del) {
        const id = Number(del.dataset.id);
        api('/api/downloads/' + id, { method: 'DELETE' }).then(() => {
          dlState.records.delete(id);
          renderDownloads();
          updateDlBadge();
        }).catch((err) => toast(err.message, 'error'));
        return;
      }
      const reopen = e.target.closest('.dl-reopen');
      if (reopen) {
        const id = Number(reopen.dataset.id);
        const r = dlState.records.get(id);
        if (r && r.filePath) {
          const entry = { path: r.filePath, name: r.fileName };
          if (isApp()) appDownload(`/api/download?path=${encodeURIComponent(r.filePath)}`);
          else downloadWithProgress(location.origin + `/api/download?path=${encodeURIComponent(r.filePath)}`, { path: r.filePath, name: r.fileName });
        }
      }
    });

    document.addEventListener('change', (e) => {
      if (e.target.id === 'dlHeadCheck') {
        const checked = e.target.checked;
        document.querySelectorAll('.dl-row-check').forEach((c) => { c.checked = checked; });
        updateDlBatchDelete();
      }
      if (e.target.classList.contains('dl-row-check')) {
        updateDlBatchDelete();
      }
    });

    const dlBatchBtn = $('#dlBatchDelete');
    if (dlBatchBtn) dlBatchBtn.onclick = dlBatchDelete;

    const dropzone = $('#dropzone');
    let dragDepth = 0;
    ['dragenter', 'dragover'].forEach((ev) => {
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        if (ev === 'dragenter') dragDepth++;
        dropzone.classList.add('dragover');
      });
    });
    dropzone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropzone.classList.remove('dragover');
    });
    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      dropzone.classList.remove('dragover');
      if (state.view !== 'files') return;
      const files = Array.from(e.dataTransfer.files || []);
      if (!files.length) return;
      if (state.user && state.user.role === 'admin') {
        enqueueUploads(files.map((file) => ({ file, relative: file.name })), state.path);
        return;
      }
      addToBatch(files, false);
    });

    $('#menuBtn').onclick = () => {
      $('#sidebar').classList.add('open');
      $('#sidebarMask').classList.add('show');
    };
    $('#sidebarMask').onclick = closeSidebar;

    $$('.tabbar .tab-item').forEach((btn) => {
      btn.onclick = () => {
        const tab = btn.dataset.tab;
        if (tab === 'upload') {
          openUploadSheet();
        } else if (tab === 'more') {
          $('#sidebar').classList.add('open');
          $('#sidebarMask').classList.add('show');
        } else {
          goView(tab);
        }
      };
    });

    $('#selectModeBtn').onclick = () => setSelectMode(!state.selectMode);
    $('#selectAll').onclick = toggleSelectAll;
    $('#selectCancel').onclick = () => setSelectMode(false);
    $('#selectDelete').onclick = deleteSelected;
    $('#selectMove').onclick = moveSelected;
    $('#selectCopy').onclick = copySelected;
    $('#selectDownload').onclick = downloadSelected;

    $('#trashRefresh').onclick = () => loadTrash();
    $('#trashUser').onchange = () => loadTrash();
    $('#trashSelectAll').onchange = (e) => setAllTrashSelected(e.target.checked);
    $('#trashRestoreSel').onclick = restoreSelectedTrash;
    $('#trashPurgeSel').onclick = purgeSelectedTrash;
    $('#logQuery').onclick = () => loadLogs(1);
    $('#logReset').onclick = () => {
      $('#logFrom').value = '';
      $('#logTo').value = '';
      $('#logUser').value = '';
      $('#logAction').value = '';
      loadLogs(1);
    };
    $('#logUser').onkeydown = (e) => {
      if (e.key === 'Enter') loadLogs(1);
    };
    $('#logFrom').onchange = () => loadLogs(1);
    $('#logTo').onchange = () => loadLogs(1);
    $('#logAction').onchange = () => loadLogs(1);
    $('#logPrev').onclick = () => {
      const p = Number($('#logPager').dataset.page) || 1;
      if (p > 1) loadLogs(p - 1);
    };
    $('#logNext').onclick = () => {
      const p = Number($('#logPager').dataset.page) || 1;
      const pages = Number($('#logPager').dataset.pages) || 1;
      if (p < pages) loadLogs(p + 1);
    };

    if (state.layout === 'grid') {
      $$('#viewToggle button').forEach((b) => b.classList.toggle('active', b.dataset.layout === 'grid'));
    }
  }

  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    $('#sidebarMask').classList.remove('show');
  }

  function toast(msg, type) {
    const wrap = $('#toastWrap');
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    el.innerHTML = type === 'error'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 16.2v.2" stroke-linecap="round"/></svg>'
      : ICONS.check;
    const span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(span);
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 260);
    }, 2400);
  }

  /* ---------------- 用户管理 ---------------- */
  const STATUS_TEXT = { pending: '待审核', active: '正常', rejected: '已拒绝', disabled: '已停用' };

  function setupAdminUI() {
    const isAdmin = state.user && state.user.role === 'admin';
    $('#adminNav').hidden = !isAdmin;
    $('#logsNav').hidden = !isAdmin;
    if (isAdmin) refreshAdminBadge();
  }

  async function refreshAdminBadge() {
    try {
      const s = await api('/api/admin/summary');
      const badge = $('#pendingBadge');
      if (s.pending > 0) {
        badge.hidden = false;
        badge.textContent = s.pending > 99 ? '99+' : String(s.pending);
      } else {
        badge.hidden = true;
      }
    } catch {
      /* ignore */
    }
  }

  async function loadAdmin() {
    const statsBox = $('#adminStats');
    const pendingBox = $('#pendingList');
    const listBox = $('#adminList');
    statsBox.innerHTML = '<div class="skeleton-row"></div>';
    pendingBox.innerHTML = '<div class="skeleton-row"></div>';
    listBox.innerHTML = '<div class="skeleton-row"></div>';
    try {
      const [summary, data] = await Promise.all([
        api('/api/admin/summary'),
        api('/api/admin/users'),
      ]);
      const stats = [
        { key: 'pending', label: '待审核' },
        { key: 'active', label: '正常' },
        { key: 'rejected', label: '已拒绝' },
        { key: 'disabled', label: '已停用' },
      ];
      statsBox.innerHTML = '';
      stats.forEach((s) => {
        const card = document.createElement('div');
        card.className = 'stat-card';
        const num = document.createElement('div');
        num.className = 'stat-num';
        num.textContent = summary[s.key] || 0;
        const label = document.createElement('div');
        label.className = 'stat-label';
        label.textContent = s.label;
        card.append(num, label);
        statsBox.appendChild(card);
      });

      const pending = data.users.filter((u) => u.status === 'pending');
      pendingBox.innerHTML = '';
      $('#pendingEmpty').hidden = pending.length > 0;
      $('#pendingCount').textContent = pending.length;
      pending.forEach((u) => pendingBox.appendChild(renderAdminUser(u, true)));
      listBox.innerHTML = '';
      data.users.forEach((u) => listBox.appendChild(renderAdminUser(u, false)));

      const badge = $('#pendingBadge');
      if (pending.length > 0) {
        badge.hidden = false;
        badge.textContent = pending.length > 99 ? '99+' : String(pending.length);
      } else {
        badge.hidden = true;
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    loadDescribeTemplate();
    loadWorkbuddyUrl();
  }

  async function loadWorkbuddyUrl() {
    const input = $('#wbUrl');
    if (!input) return;
    try {
      const data = await api('/api/admin/workbuddy');
      input.value = data.url || '';
      $('#wbStatus').textContent = '';
    } catch (err) {
      $('#wbStatus').textContent = '加载失败';
    }
  }

  async function loadDescribeTemplate() {
    const editor = $('#tmplEditor');
    if (!editor) return;
    try {
      const data = await api('/api/admin/describe-template');
      editor.value = data.template || '';
      state.templateDefault = data.defaultTemplate || '';
      $('#tmplStatus').textContent = '';
      renderTemplatePlaceholders(data.placeholders || []);
    } catch (err) {
      const status = $('#tmplStatus');
      if (status) status.textContent = '模板加载失败';
    }
  }

  function renderTemplatePlaceholders(list) {
    const box = $('#tmplPlaceholders');
    if (!box) return;
    box.innerHTML = '';
    list.forEach((p) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tmpl-chip';
      chip.textContent = `{{${p.key}}} · ${p.label}`;
      chip.onclick = () => {
        const editor = $('#tmplEditor');
        if (!editor) return;
        const start = editor.selectionStart || 0;
        const end = editor.selectionEnd || 0;
        const token = `{{${p.key}}}`;
        editor.value = editor.value.slice(0, start) + token + editor.value.slice(end);
        editor.selectionStart = editor.selectionEnd = start + token.length;
        editor.focus();
        $('#tmplStatus').textContent = '未保存';
      };
      box.appendChild(chip);
    });
  }

  function renderAdminUser(u, pendingMode) {
    const row = document.createElement('div');
    row.className = 'admin-user';

    const avatar = document.createElement('div');
    avatar.className = 'admin-avatar';
    avatar.textContent = (u.username || '?').slice(0, 1).toUpperCase();

    const info = document.createElement('div');
    info.className = 'admin-info';
    const name = document.createElement('div');
    name.className = 'admin-name';
    const nameText = document.createElement('span');
    nameText.textContent = u.username;
    name.appendChild(nameText);
    if (u.role === 'admin') {
      const role = document.createElement('span');
      role.className = 'role-tag';
      role.textContent = '管理员';
      name.appendChild(role);
    }
    const st = document.createElement('span');
    st.className = 'status-tag ' + u.status;
    st.textContent = STATUS_TEXT[u.status] || u.status;
    name.appendChild(st);

    const meta = document.createElement('div');
    meta.className = 'admin-meta';
    const reg = `注册于 ${fmtTime(u.createdAt)}`;
    const last = u.lastLogin ? ` · 最近登录 ${fmtTime(u.lastLogin)}` : '';
    const perm =
      u.role === 'admin'
        ? ' · 全部文件夹'
        : u.folderAccess === 'custom'
        ? ` · 仅 ${u.folderCount} 个文件夹`
        : ' · 全部文件夹';
    const dept = u.department ? ` · ${u.department}` : ' · 未设置部门';
    const phone = u.phone ? ` · ${u.phone}` : ' · 未绑定手机号';
    meta.textContent = dept + phone + ' · ' + reg + last + perm;

    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'admin-actions';
    const btn = (label, action, cls) => {
      const b = document.createElement('button');
      b.className = 'btn small' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.onclick = () => adminReview(u, action);
      return b;
    };
    const deptBtn = document.createElement('button');
    deptBtn.className = 'btn small';
    deptBtn.textContent = '部门';
    deptBtn.onclick = () => openDepartmentModal(u);
    actions.appendChild(deptBtn);
    const phoneBtn = document.createElement('button');
    phoneBtn.className = 'btn small';
    phoneBtn.textContent = '手机号';
    phoneBtn.onclick = () => openPhoneModal(u);
    actions.appendChild(phoneBtn);
    const pwdBtn = document.createElement('button');
    pwdBtn.className = 'btn small';
    pwdBtn.textContent = '密码';
    pwdBtn.onclick = () => {
      if (state.user && u.id === state.user.id) openPasswordModal();
      else openAdminPasswordModal(u);
    };
    actions.appendChild(pwdBtn);
    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn small';
    renameBtn.textContent = '改名';
    renameBtn.onclick = () => openUsernameModal(u);
    actions.appendChild(renameBtn);
    if (u.role !== 'admin') {
      const permBtn = document.createElement('button');
      permBtn.className = 'btn small';
      permBtn.textContent = '权限';
      permBtn.onclick = () => openFolderAccessModal(u);
      actions.appendChild(permBtn);
    }
    if (u.status === 'pending') {
      actions.append(btn('通过', 'approve', 'primary'), btn('拒绝', 'reject'));
    } else if (u.status === 'active') {
      if (!pendingMode) actions.append(btn('停用', 'disable'));
    } else if (u.status === 'disabled') {
      actions.append(btn('启用', 'enable', 'primary'));
    } else {
      actions.append(btn('重新审核', 'approve', 'primary'));
    }

    if (!state.user || u.id !== state.user.id) {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn small danger-text';
      delBtn.textContent = '删除';
      delBtn.onclick = () => openDeleteUserModal(u);
      actions.appendChild(delBtn);
    }

    row.append(avatar, info, actions);
    return row;
  }

  async function adminReview(u, action) {
    const labels = { approve: '通过', reject: '拒绝', disable: '停用', enable: '启用' };
    try {
      await api('/api/admin/review', { method: 'POST', body: { userId: u.id, action } });
      toast(`已${labels[action] || '操作'}用户「${u.username}」`);
      loadAdmin();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function openDepartmentModal(u) {
    openModal(
      `<h3>所属部门</h3>
       <p class="modal-desc">修改「${escapeHtml(u.username)}」的部门</p>
       <select class="select" id="deptSelect" style="margin-top:16px">
         <option value="">未设置</option>
         <option value="江宁店">江宁店</option>
         <option value="大明路店">大明路店</option>
         <option value="金城店">金城店</option>
         <option value="仙林圣景旗舰店">仙林圣景旗舰店</option>
       </select>
       <div class="modal-error" id="deptError"></div>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn primary" id="deptSave">保存</button>
       </div>`,
      (box) => {
        $('#deptSelect', box).value = u.department || '';
        box.querySelector('[data-close]').onclick = closeModal;
        $('#deptSave', box).onclick = async () => {
          try {
            await api('/api/admin/department', {
              method: 'POST',
              body: { userId: u.id, department: $('#deptSelect', box).value },
            });
            closeModal();
            toast('部门已更新');
            loadAdmin();
          } catch (err) {
            $('#deptError', box).textContent = err.message;
          }
        };
      }
    );
  }

  function openDeleteUserModal(u) {
    openModal(
      `<h3>删除账号</h3>
       <p class="modal-desc">账号：${escapeHtml(u.username)}${
        u.department ? ' · ' + escapeHtml(u.department) : ''
      }</p>
       <div class="delete-warning">此操作将永久删除该账号，以及其网盘内所有文件、分享链接和回收站内容，删除后无法恢复。</div>
       <input class="select" id="deleteConfirm" placeholder="请输入完整用户名确认" autocomplete="off" />
       <div class="modal-error" id="deleteUserError"></div>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn danger" id="deleteUserOk" disabled>永久删除</button>
       </div>`,
      (box) => {
        const input = $('#deleteConfirm', box);
        const ok = $('#deleteUserOk', box);
        const sync = () => {
          ok.disabled = input.value.trim() !== u.username;
        };
        input.addEventListener('input', sync);
        box.querySelector('[data-close]').onclick = closeModal;
        ok.onclick = async () => {
          if (input.value.trim() !== u.username) return;
          ok.disabled = true;
          ok.textContent = '删除中…';
          try {
            const data = await api('/api/admin/delete-user', {
              method: 'POST',
              body: { userId: u.id, confirm: input.value.trim() },
            });
            closeModal();
            toast(data.warning || `已删除账号「${u.username}」`, data.warning ? 'error' : undefined);
            loadAdmin();
          } catch (err) {
            $('#deleteUserError', box).textContent = err.message;
            ok.disabled = false;
            ok.textContent = '永久删除';
          }
        };
        input.focus();
      }
    );
  }

  function openAdminPasswordModal(u) {
    openModal(
      `<h3>重置登录密码</h3>
       <p class="modal-desc">为「${escapeHtml(
         u.username
       )}」设置新的登录密码；保存后该账号所有登录会失效</p>
       <input class="select" id="adminPwd1" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password" />
       <input class="select" id="adminPwd2" type="password" placeholder="再次输入新密码" autocomplete="new-password" />
       <div class="modal-error" id="adminPwdError"></div>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn primary" id="adminPwdSave">保存</button>
       </div>`,
      (box) => {
        box.querySelector('[data-close]').onclick = closeModal;
        const save = async () => {
          const p1 = $('#adminPwd1', box).value;
          const p2 = $('#adminPwd2', box).value;
          const err = $('#adminPwdError', box);
          if (p1.length < 6) {
            err.textContent = '密码至少需要 6 位字符';
            return;
          }
          if (p1 !== p2) {
            err.textContent = '两次输入的密码不一致';
            return;
          }
          try {
            await api('/api/admin/password', {
              method: 'POST',
              body: { userId: u.id, password: p1 },
            });
            closeModal();
            toast(`已重置「${u.username}」的登录密码`);
          } catch (e2) {
            err.textContent = e2.message;
          }
        };
        $('#adminPwdSave', box).onclick = save;
        $('#adminPwd2', box).onkeydown = (e) => {
          if (e.key === 'Enter') save();
        };
        $('#adminPwd1', box).focus();
      }
    );
  }

  function openPhoneModal(u) {
    openModal(
      `<h3>绑定手机号</h3>
       <p class="modal-desc">为「${escapeHtml(
         u.username
       )}」绑定或修改手机号，用于验证码登录和找回密码</p>
       <input class="select" id="phoneInput" maxlength="11" inputmode="numeric" value="${escapeHtml(
         u.phone || ''
       )}" placeholder="请输入 11 位手机号" />
       <div class="modal-error" id="phoneError"></div>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn primary" id="phoneSave">保存</button>
       </div>`,
      (box) => {
        const input = $('#phoneInput', box);
        box.querySelector('[data-close]').onclick = closeModal;
        const save = async () => {
          const phone = input.value.trim();
          if (!/^1[3-9]\d{9}$/.test(phone)) {
            $('#phoneError', box).textContent = '请输入正确的 11 位手机号';
            return;
          }
          try {
            await api('/api/admin/phone', { method: 'POST', body: { userId: u.id, phone } });
            closeModal();
            toast('手机号已更新');
            loadAdmin();
          } catch (err) {
            $('#phoneError', box).textContent = err.message;
          }
        };
        $('#phoneSave', box).onclick = save;
        input.onkeydown = (e) => {
          if (e.key === 'Enter') save();
        };
        input.focus();
      }
    );
  }

  function openPasswordModal() {
    openModal(
      `<h3>修改密码</h3>
       <p class="modal-desc">修改后其他设备上的登录会失效，当前设备保持登录</p>
       <input class="select" id="oldPassword" type="password" placeholder="当前密码" autocomplete="current-password" />
       <input class="select" id="newPassword1" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password" />
       <input class="select" id="newPassword2" type="password" placeholder="再次输入新密码" autocomplete="new-password" />
       <div class="modal-error" id="pwdError"></div>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn primary" id="pwdSave">保存</button>
       </div>`,
      (box) => {
        box.querySelector('[data-close]').onclick = closeModal;
        const save = async () => {
          const oldPassword = $('#oldPassword', box).value;
          const newPassword = $('#newPassword1', box).value;
          const confirm = $('#newPassword2', box).value;
          const err = $('#pwdError', box);
          if (!oldPassword) {
            err.textContent = '请输入当前密码';
            return;
          }
          if (newPassword.length < 6) {
            err.textContent = '新密码至少需要 6 位字符';
            return;
          }
          if (newPassword !== confirm) {
            err.textContent = '两次输入的新密码不一致';
            return;
          }
          try {
            await api('/api/account/password', {
              method: 'POST',
              body: { oldPassword, newPassword },
            });
            closeModal();
            toast('密码已修改');
          } catch (e2) {
            err.textContent = e2.message;
          }
        };
        $('#pwdSave', box).onclick = save;
        $('#newPassword2', box).onkeydown = (e) => {
          if (e.key === 'Enter') save();
        };
        $('#oldPassword', box).focus();
      }
    );
  }

  function openUsernameModal(u) {
    openModal(
      `<h3>修改用户名</h3>
       <p class="modal-desc">修改「${escapeHtml(u.username)}」的登录名，历史上传统计会一并更新。</p>
       <input class="select" id="nameInput" maxlength="32" value="${escapeHtml(u.username)}" />
       <div class="modal-error" id="nameError"></div>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn primary" id="nameSave">保存</button>
       </div>`,
      (box) => {
        const input = $('#nameInput', box);
        box.querySelector('[data-close]').onclick = closeModal;
        const save = async () => {
          const username = input.value.trim();
          if (!username) {
            $('#nameError', box).textContent = '请输入用户名';
            return;
          }
          if (username === u.username) {
            closeModal();
            return;
          }
          try {
            const data = await api('/api/admin/username', {
              method: 'POST',
              body: { userId: u.id, username },
            });
            closeModal();
            toast(`用户名已改为「${data.username}」`);
            if (data.isSelf && state.user) {
              state.user.username = data.username;
              paintUser();
            }
            loadAdmin();
          } catch (err) {
            $('#nameError', box).textContent = err.message;
          }
        };
        $('#nameSave', box).onclick = save;
        input.onkeydown = (e) => {
          if (e.key === 'Enter') save();
        };
        input.focus();
        input.select();
      }
    );
  }

  function dateStr(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function setRangeDates(range) {
    if (range === 'custom') return;
    const now = new Date();
    let from = '';
    let to = '';
    if (range === 'today') {
      from = to = dateStr(now);
    } else if (range === '7') {
      from = dateStr(addDays(now, -6));
      to = dateStr(now);
    } else if (range === '30') {
      from = dateStr(addDays(now, -29));
      to = dateStr(now);
    } else if (range === 'month') {
      from = dateStr(new Date(now.getFullYear(), now.getMonth(), 1));
      to = dateStr(now);
    } else if (range === 'lastMonth') {
      from = dateStr(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      to = dateStr(new Date(now.getFullYear(), now.getMonth(), 0));
    }
    $('#statFrom').value = from;
    $('#statTo').value = to;
  }

  const STAT_ICONS = {
    batch:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15.5V5"/><path d="m7.5 9.5 4.5-4 4.5 4"/><path d="M4 17.5V18a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-.5"/></svg>',
    image:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="3"/><circle cx="8.5" cy="10" r="1.6"/><path d="m3.8 17 4.6-4.6 3.6 3.6 2.6-2.6L20 18"/></svg>',
    vinOk:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 5.5 5.8v5.9c0 3.9 2.7 6.5 6.5 8.3 3.8-1.8 6.5-4.4 6.5-8.3V5.8L12 3Z"/><path d="m9.2 11.8 2.1 2.1 4-4.3"/></svg>',
    vinFail:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 5.5 5.8v5.9c0 3.9 2.7 6.5 6.5 8.3 3.8-1.8 6.5-4.4 6.5-8.3V5.8L12 3Z"/><path d="M12 8v4.2"/><path d="M12 15.3v.2"/></svg>',
    miss:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.8"/><path d="M3.5 9.7h17"/><path d="M8 3.2v3.6"/><path d="M16 3.2v3.6"/><path d="M12 13v3.4"/><path d="M12 19v.2"/></svg>',
  };

  function animateStatNumber(el, value) {
    const target = Number(value) || 0;
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || target === 0) {
      el.textContent = String(target);
      return;
    }
    const start = performance.now();
    const duration = 520;
    const step = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  async function loadStats() {
    const from = $('#statFrom').value;
    const to = $('#statTo').value;
    let query = '';
    if (from || to) {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      query = '?' + params.toString();
    }

    const cards = $('#statCards');
    const table = $('#statTable');
    const empty = $('#statEmpty');
    cards.innerHTML = Array.from({ length: 5 }, (_, i) =>
      `<div class="stat-card stat-skeleton${i === 0 ? ' is-primary' : ''}"><div class="sk-line sk-hint"></div><div class="sk-line sk-num"></div><div class="sk-line sk-label"></div></div>`
    ).join('');
    table.innerHTML =
      '<div class="sk-table">' + '<div class="sk-table-row"></div>'.repeat(6) + '</div>';
    empty.hidden = true;

    try {
      const data = await api('/api/stats/uploads' + query);
      const rows = data.rows || [];
      state.statsRows = rows;
      state.statsDepartments = data.departments || [];
      state.statsMissing = data.missing || [];
      const monthly = data.monthly || {};
      const cardData = [
        { num: monthly.batches || 0, label: '本月上传批次', hint: '本月累计', icon: 'batch', primary: true },
        { num: monthly.images || 0, label: '本月上传图片', hint: '本月', icon: 'image' },
        { num: monthly.vinSuccess || 0, label: '车架号识别成功', hint: '本月', icon: 'vinOk' },
        { num: monthly.vinFail || 0, label: '车架号识别失败', hint: '本月', icon: 'vinFail' },
        { num: monthly.missedTotal || 0, label: '本月漏传总次数', hint: '本月', icon: 'miss', danger: true },
      ];
      cards.innerHTML = '';
      cardData.forEach((c) => {
        const card = document.createElement('div');
        card.className = 'stat-card' + (c.primary ? ' is-primary' : '') + (c.danger ? ' is-danger' : '');
        card.innerHTML =
          `<div class="stat-card-head"><span class="stat-icon">${STAT_ICONS[c.icon]}</span><span class="stat-hint">${c.hint}</span></div>` +
          '<div class="stat-num"></div><div class="stat-label"></div>';
        card.querySelector('.stat-label').textContent = c.label;
        cards.appendChild(card);
        animateStatNumber(card.querySelector('.stat-num'), c.num);
      });

      const deptTable = $('#deptTable');
      deptTable.innerHTML = '';
      const depts = data.departments || [];
      if (depts.length) {
        const dhead = document.createElement('div');
        dhead.className = 'dept-row dept-head';
        dhead.setAttribute('role', 'row');
        dhead.innerHTML =
          '<span role="columnheader">部门</span><span role="columnheader">批次</span><span role="columnheader">图片</span><span role="columnheader">车架号成功</span><span role="columnheader">车架号失败</span><span role="columnheader">漏传次数</span>';
        deptTable.appendChild(dhead);
        depts.forEach((d) => {
          const drow = document.createElement('div');
          drow.className = 'dept-row';
          drow.setAttribute('role', 'row');
          const nameCell = document.createElement('span');
          nameCell.className = 'dept-name-cell';
          const badge = document.createElement('span');
          badge.className = 'dept-badge';
          badge.textContent = d.department || '未设置';
          nameCell.appendChild(badge);
          drow.appendChild(nameCell);
          [
            d.batches || 0,
            d.images || 0,
            d.vinSuccess || 0,
            d.vinFail || 0,
            d.missed || 0,
          ].forEach((value, i) => {
            const span = document.createElement('span');
            span.className = 'stat-num-cell';
            span.textContent = String(value);
            if (i === 4 && value > 0) span.classList.add('is-miss');
            drow.appendChild(span);
          });
          deptTable.appendChild(drow);
        });
      }

      const missingBox = $('#missingBlock');
      if (missingBox) missingBox.innerHTML = '';
      const missing = data.missing || [];

      const userMap = new Map();
      for (const r of rows) {
        const key = r.username;
        const u = userMap.get(key) || {
          username: r.username,
          department: r.department || '未设置',
          batches: 0,
          images: 0,
          vinSuccess: 0,
          vinFail: 0,
          lastAt: 0,
          missedDates: [],
        };
        if ((!u.department || u.department === '未设置') && r.department) u.department = r.department;
        u.batches += r.batches || 0;
        u.images += r.images || 0;
        u.vinSuccess += r.vinSuccess || 0;
        u.vinFail += r.vinFail || 0;
        u.lastAt = Math.max(u.lastAt, r.lastAt || 0);
        userMap.set(key, u);
      }
      for (const m of missing) {
        const key = m.username;
        const u = userMap.get(key) || {
          username: m.username,
          department: m.department || '未设置',
          batches: 0,
          images: 0,
          vinSuccess: 0,
          vinFail: 0,
          lastAt: 0,
          missedDates: [],
        };
        u.department = m.department || u.department;
        u.missedDates = m.dates.slice();
        userMap.set(key, u);
      }
      const users = Array.from(userMap.values()).sort(
        (a, b) =>
          b.missedDates.length - a.missedDates.length || a.username.localeCompare(b.username, 'zh')
      );

      table.innerHTML = '';
      if (!users.length) {
        empty.hidden = false;
        return;
      }
      const head = document.createElement('div');
      head.className = 'stat-row stat-head';
      head.setAttribute('role', 'row');
      head.innerHTML =
        '<span role="columnheader">账号</span><span role="columnheader">部门</span><span role="columnheader">批次</span><span role="columnheader">图片</span><span role="columnheader">车架号成功</span><span role="columnheader">车架号失败</span><span role="columnheader">漏传次数</span><span role="columnheader">漏传日期</span><span role="columnheader">最近上传</span>';
      table.appendChild(head);

      const FOLD = 4;
      users.forEach((u, idx) => {
        const row = document.createElement('div');
        row.className = 'stat-row';
        row.setAttribute('role', 'row');
        row.style.setProperty('--i', String(Math.min(idx, 14)));

        const userCell = document.createElement('span');
        userCell.className = 'stat-user-cell';
        userCell.dataset.label = '账号';
        const avatar = document.createElement('span');
        avatar.className = 'stat-avatar';
        avatar.textContent = (u.username || '?').slice(0, 1).toUpperCase();
        const name = document.createElement('span');
        name.className = 'stat-username';
        name.textContent = u.username;
        const miniDept = document.createElement('span');
        miniDept.className = 'user-dept-mini';
        miniDept.textContent = u.department || '未设置';
        userCell.append(avatar, name, miniDept);

        const deptCell = document.createElement('span');
        deptCell.className = 'stat-dept-cell';
        deptCell.dataset.label = '部门';
        const deptBadge = document.createElement('span');
        deptBadge.className = 'dept-badge';
        deptBadge.textContent = u.department || '未设置';
        deptCell.appendChild(deptBadge);

        row.append(userCell, deptCell);

        [
          [u.batches || 0, '批次'],
          [u.images || 0, '图片'],
          [u.vinSuccess || 0, '车架号成功'],
          [u.vinFail || 0, '车架号失败'],
        ].forEach(([value, label]) => {
          const span = document.createElement('span');
          span.className = 'stat-num-cell';
          span.dataset.label = label;
          span.textContent = String(value);
          row.appendChild(span);
        });

        const missCount = document.createElement('span');
        missCount.className = 'stat-num-cell stat-miss-cell';
        missCount.dataset.label = '漏传次数';
        missCount.textContent = String(u.missedDates.length || 0);
        if (u.missedDates.length) missCount.classList.add('is-miss');
        row.appendChild(missCount);

        const missCell = document.createElement('div');
        missCell.className = 'miss-cell';
        missCell.dataset.label = '漏传日期';
        if (u.missedDates.length) {
          const list = document.createElement('div');
          list.className = 'miss-list';
          u.missedDates.forEach((d, i) => {
            const tag = document.createElement('span');
            tag.className = 'miss-date';
            if (i >= FOLD) tag.classList.add('is-extra');
            tag.textContent = d;
            list.appendChild(tag);
          });
          missCell.appendChild(list);
          if (u.missedDates.length > FOLD) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'miss-toggle';
            btn.setAttribute('aria-expanded', 'false');
            btn.textContent = '+' + (u.missedDates.length - FOLD);
            btn.addEventListener('click', () => {
              const open = btn.getAttribute('aria-expanded') === 'true';
              btn.setAttribute('aria-expanded', String(!open));
              list.classList.toggle('is-open', !open);
              btn.textContent = open ? '+' + (u.missedDates.length - FOLD) : '收起';
            });
            missCell.appendChild(btn);
          }
        } else {
          const none = document.createElement('span');
          none.className = 'miss-none';
          none.textContent = '—';
          missCell.appendChild(none);
        }
        row.appendChild(missCell);

        const last = document.createElement('span');
        last.className = 'stat-last-cell';
        last.dataset.label = '最近上传';
        last.textContent = u.lastAt ? fmtTime(u.lastAt) : '—';
        row.appendChild(last);

        table.appendChild(row);
      });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function fmtFullTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ---------------- 全局搜索 ---------------- */
  async function runSearch(keyword) {
    const q = String(keyword || '').trim();
    if (!q) return;
    state.searchQuery = q;
    const list = $('#searchList');
    const empty = $('#searchEmpty');
    list.innerHTML =
      '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>';
    empty.hidden = true;
    const url = `/?view=search&q=${encodeURIComponent(q)}`;
    if (state.view !== 'search') {
      switchView('search');
      history.pushState({ view: 'search', q }, '', url);
    } else {
      history.replaceState({ view: 'search', q }, '', url);
    }
    try {
      const data = await api('/api/search?q=' + encodeURIComponent(q));
      if (state.searchQuery !== q) return;
      state.searchItems = data.items || [];
      $('#searchDesc').textContent = data.total
        ? `找到 ${data.total} 个结果${
            data.total > state.searchItems.length ? `，显示前 ${state.searchItems.length} 个` : ''
          }`
        : `没有找到与「${q}」相关的内容`;
      renderSearch();
    } catch (err) {
      list.innerHTML = '';
      empty.hidden = false;
      toast(err.message, 'error');
    }
  }

  function renderSearch() {
    const list = $('#searchList');
    const empty = $('#searchEmpty');
    const items = state.searchItems || [];
    list.innerHTML = '';
    if (!items.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'search-row';
      const icon = document.createElement('div');
      icon.className = 'search-icon' + (item.isDir ? ' folder' : '');
      if (item.isDir) icon.innerHTML = ICONS.folder;
      else icon.textContent = (item.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
      const info = document.createElement('div');
      info.className = 'search-info';
      const name = document.createElement('div');
      name.className = 'search-name';
      name.textContent = item.name;
      const meta = document.createElement('div');
      meta.className = 'search-meta';
      const parent = item.path.includes('/')
        ? item.path.slice(0, item.path.lastIndexOf('/')) || '/'
        : '/';
      const count = item.isDir
        ? item.fileCount
          ? `${item.fileCount} 个文件`
          : item.dirCount
          ? `${item.dirCount} 个子文件夹`
          : '空文件夹'
        : fmtSize(item.size);
      const owners = item.owners && item.owners.length ? ` · ${item.owners.join('、')}` : '';
      meta.textContent = `${item.isDir ? parent : item.path} · ${count}${owners}`;
      info.append(name, meta);
      row.append(icon, info);
      if (item.isDir) {
        const chevron = document.createElement('span');
        chevron.className = 'search-chevron';
        chevron.textContent = '›';
        row.appendChild(chevron);
      }
      row.onclick = () => {
        $('#searchInput').value = '';
        state.keyword = '';
        if (item.isDir) navigate(item.path);
        else openPreview(item);
      };
      list.appendChild(row);
    });
  }

  /* ---------------- 回收站 ---------------- */
  async function loadTrash() {
    const list = $('#trashList');
    const empty = $('#trashEmpty');
    const filter = $('#trashUser');
    state.trashSelected.clear();
    list.innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row"></div>';
    empty.hidden = true;
    $('#trashSelBar').hidden = true;
    try {
      const userId = filter && !filter.hidden ? filter.value : '';
      const data = await api('/api/trash' + (userId ? '?userId=' + encodeURIComponent(userId) : ''));
      state.trashItems = data.items || [];
      $('#trashDesc').textContent = `删除的文件保留 ${data.keepDays || 7} 天，到期后自动清除`;
      if (data.isAdmin) {
        const cur = filter.value;
        filter.hidden = false;
        filter.innerHTML =
          '<option value="">全部账号</option>' +
          (data.owners || [])
            .map((o) => `<option value="${o.id}">${escapeHtml(o.username)}</option>`)
            .join('');
        filter.value = cur;
      } else {
        filter.hidden = true;
      }
      state.trashIsAdmin = !!data.isAdmin;
      renderTrash(data.isAdmin);
    } catch (err) {
      list.innerHTML = '';
      empty.hidden = false;
      toast(err.message, 'error');
    }
  }

  function renderTrash(isAdmin) {
    const list = $('#trashList');
    const empty = $('#trashEmpty');
    const items = state.trashItems || [];
    list.innerHTML = '';
    if (!items.length) {
      empty.hidden = false;
      $('#trashSelBar').hidden = true;
      updateTrashSelection();
      return;
    }
    empty.hidden = true;
    $('#trashSelBar').hidden = false;
    items.forEach((it) => {
      const card = document.createElement('div');
      card.className = 'trash-item';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'trash-check';
      check.checked = state.trashSelected.has(it.id);
      card.classList.toggle('is-selected', check.checked);
      check.onchange = () => {
        if (check.checked) state.trashSelected.add(it.id);
        else state.trashSelected.delete(it.id);
        card.classList.toggle('is-selected', check.checked);
        updateTrashSelection();
      };
      const icon = document.createElement('div');
      icon.className = 'trash-icon' + (it.isDir ? ' folder' : '');
      if (it.isDir) icon.innerHTML = ICONS.folder;
      else icon.textContent = (it.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();

      const info = document.createElement('div');
      info.className = 'trash-info';
      const name = document.createElement('div');
      name.className = 'trash-name';
      name.textContent = it.name;
      const meta = document.createElement('div');
      meta.className = 'trash-meta';
      meta.textContent = `${it.path} · ${
        it.isDir ? `${it.files} 个文件` : fmtSize(it.size)
      } · ${fmtFullTime(it.deletedAt)}`;
      info.append(name, meta);
      if (isAdmin) {
        const sub = document.createElement('div');
        sub.className = 'trash-sub';
        sub.textContent = `所属账号 ${it.ownerName} · 删除者 ${it.deletedBy}`;
        info.appendChild(sub);
      }

      const days = document.createElement('span');
      days.className = 'trash-days' + (it.daysLeft <= 1 ? ' urgent' : '');
      days.textContent = it.daysLeft <= 0 ? '即将清除' : `${it.daysLeft} 天后清除`;

      const btns = document.createElement('div');
      btns.className = 'trash-btns';
      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'btn small';
      restoreBtn.textContent = '恢复';
      restoreBtn.onclick = () => restoreTrashItem(it);
      const purgeBtn = document.createElement('button');
      purgeBtn.className = 'btn small danger-text';
      purgeBtn.textContent = '彻底删除';
      purgeBtn.onclick = () => purgeTrashItem(it);
      btns.append(restoreBtn, purgeBtn);

      card.append(check, icon, info, days, btns);
      list.appendChild(card);
    });
    updateTrashSelection();
  }

  function updateTrashSelection() {
    const total = (state.trashItems || []).length;
    const count = state.trashSelected.size;
    const all = $('#trashSelectAll');
    if (all) {
      all.checked = total > 0 && count === total;
      all.indeterminate = count > 0 && count < total;
    }
    const label = $('#trashSelectedCount');
    if (label) label.textContent = `已选 ${count} 项`;
    const restoreBtn = $('#trashRestoreSel');
    const purgeBtn = $('#trashPurgeSel');
    if (restoreBtn) restoreBtn.disabled = count === 0;
    if (purgeBtn) purgeBtn.disabled = count === 0;
  }

  function setAllTrashSelected(on) {
    state.trashSelected.clear();
    if (on) {
      (state.trashItems || []).forEach((it) => state.trashSelected.add(it.id));
    }
    renderTrash(state.trashIsAdmin);
  }

  async function restoreSelectedTrash() {
    const ids = Array.from(state.trashSelected);
    if (!ids.length) return;
    const btn = $('#trashRestoreSel');
    btn.disabled = true;
    btn.textContent = '恢复中…';
    let restored = 0;
    const errors = [];
    try {
      for (let i = 0; i < ids.length; i += 50) {
        const data = await api('/api/trash/restore', {
          method: 'POST',
          body: { ids: ids.slice(i, i + 50) },
        });
        restored += data.restored || 0;
        if (data.errors) errors.push(...data.errors);
      }
      toast(`已恢复 ${restored} 项${errors.length ? `，${errors.length} 项失败` : ''}`);
      state.trashSelected.clear();
      loadTrash();
      refreshUsage();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = state.trashSelected.size === 0;
      btn.textContent = '恢复所选';
    }
  }

  function purgeSelectedTrash() {
    const ids = Array.from(state.trashSelected);
    if (!ids.length) return;
    openModal(
      `<h3>彻底删除</h3>
       <p class="modal-desc">选中的 ${ids.length} 项将被永久删除，无法恢复。</p>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn danger" id="trashPurgeAllOk">彻底删除</button>
       </div>`,
      (box) => {
        box.querySelector('[data-close]').onclick = closeModal;
        $('#trashPurgeAllOk', box).onclick = async () => {
          const btn = $('#trashPurgeAllOk', box);
          btn.disabled = true;
          btn.textContent = '删除中…';
          let purged = 0;
          const errors = [];
          try {
            for (let i = 0; i < ids.length; i += 50) {
              const data = await api('/api/trash/purge', {
                method: 'POST',
                body: { ids: ids.slice(i, i + 50) },
              });
              purged += data.purged || 0;
              if (data.errors) errors.push(...data.errors);
            }
            closeModal();
            toast(`已彻底删除 ${purged} 项${errors.length ? `，${errors.length} 项失败` : ''}`);
            state.trashSelected.clear();
            loadTrash();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = '彻底删除';
            toast(err.message, 'error');
          }
        };
      }
    );
  }

  async function restoreTrashItem(it) {
    try {
      const data = await api('/api/trash/restore', { method: 'POST', body: { ids: [it.id] } });
      if (data.restored) {
        const item = (data.items || [])[0];
        toast(item ? `已恢复「${item.name}」` : '已恢复');
        loadTrash();
        refreshUsage();
      } else if (data.errors && data.errors.length) {
        toast(data.errors[0].error || '恢复失败', 'error');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function purgeTrashItem(it) {
    openModal(
      `<h3>彻底删除</h3>
       <p class="modal-desc">「${escapeHtml(it.name)}」将被永久删除，无法恢复。</p>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn danger" id="purgeOk">彻底删除</button>
       </div>`,
      (box) => {
        box.querySelector('[data-close]').onclick = closeModal;
        $('#purgeOk', box).onclick = async () => {
          try {
            await api('/api/trash/purge', { method: 'POST', body: { ids: [it.id] } });
            closeModal();
            toast('已彻底删除');
            loadTrash();
          } catch (err) {
            toast(err.message, 'error');
          }
        };
      }
    );
  }

  /* ---------------- 操作日志 ---------------- */
  function setDefaultLogDates() {
    if ($('#logFrom').value && $('#logTo').value) return;
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
    const p = (n) => String(n).padStart(2, '0');
    const str = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    $('#logFrom').value = str(from);
    $('#logTo').value = str(now);
  }

  async function loadLogs(page = 1) {
    setDefaultLogDates();
    const table = $('#logTable');
    const empty = $('#logEmpty');
    table.innerHTML =
      '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>';
    empty.hidden = true;
    try {
      const params = new URLSearchParams();
      if ($('#logFrom').value) params.set('from', $('#logFrom').value);
      if ($('#logTo').value) params.set('to', $('#logTo').value);
      const uname = $('#logUser').value.trim();
      if (uname) params.set('username', uname);
      if ($('#logAction').value) params.set('action', $('#logAction').value);
      params.set('page', String(page));
      params.set('pageSize', '50');
      const data = await api('/api/admin/logs?' + params.toString());
      const select = $('#logAction');
      const cur = select.value;
      if (!state.logsReady) {
        select.innerHTML =
          '<option value="">全部操作</option>' +
          (data.actions || [])
            .map((a) => `<option value="${a.key}">${escapeHtml(a.label)}</option>`)
            .join('');
        select.value = cur;
        state.logsReady = true;
      }
      renderLogs(data);
    } catch (err) {
      table.innerHTML = '';
      empty.hidden = false;
      toast(err.message, 'error');
    }
  }

  function logTone(action) {
    if (/delete|purge|login_fail/.test(action)) return 'danger';
    if (/upload|restore/.test(action)) return 'ok';
    if (/^admin_/.test(action)) return 'warn';
    return 'info';
  }

  function renderLogs(data) {
    const table = $('#logTable');
    const empty = $('#logEmpty');
    const pager = $('#logPager');
    const items = data.items || [];
    table.innerHTML = '';
    if (!items.length) {
      empty.hidden = false;
      pager.hidden = true;
      return;
    }
    empty.hidden = true;
    const head = document.createElement('div');
    head.className = 'log-row log-head';
    head.innerHTML =
      '<span>时间</span><span>账号</span><span>操作</span><span>对象</span><span>详情</span><span>IP</span>';
    table.appendChild(head);
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'log-row';
      row.style.setProperty('--i', String(Math.min(i, 14)));
      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = fmtFullTime(it.createdAt);
      const user = document.createElement('span');
      user.className = 'log-user';
      user.textContent = it.username || '—';
      const action = document.createElement('span');
      action.className = 'log-action';
      const badge = document.createElement('span');
      badge.className = 'log-badge is-' + logTone(it.action);
      badge.textContent = it.actionLabel || it.action;
      action.appendChild(badge);
      const target = document.createElement('span');
      target.className = 'log-object';
      target.textContent = it.target || '—';
      target.title = it.target || '';
      const detail = document.createElement('span');
      detail.className = 'log-detail';
      detail.textContent = it.detail || '—';
      detail.title = it.detail || '';
      const ip = document.createElement('span');
      ip.className = 'log-ip';
      ip.textContent = it.ip || '—';
      row.append(time, user, action, target, detail, ip);
      table.appendChild(row);
    });
    pager.hidden = false;
    $('#logTotal').textContent = `共 ${data.total} 条记录 · 保留 ${data.keepMonths || 6} 个月`;
    $('#logPage').textContent = `第 ${data.page} / ${data.pages} 页`;
    $('#logPrev').disabled = data.page <= 1;
    $('#logNext').disabled = data.page >= data.pages;
    pager.dataset.page = String(data.page);
    pager.dataset.pages = String(data.pages);
  }

  function exportStatsCsv() {
    const rows = state.statsRows || [];
    if (!rows.length) return toast('暂无可导出的数据', 'error');
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['日期', '账号', '部门', '上传批次', '上传图片', '车架号成功', '车架号失败', '最近上传'];
    const lines = [];
    const depts = state.statsDepartments || [];
    if (depts.length) {
      lines.push('部门统计');
      lines.push(['部门', '上传批次', '上传图片', '车架号成功', '车架号失败', '漏传次数'].join(','));
      depts.forEach((d) => {
        lines.push(
          [d.department, d.batches || 0, d.images || 0, d.vinSuccess || 0, d.vinFail || 0, d.missed || 0]
            .map(esc)
            .join(',')
        );
      });
      lines.push('');
    }

    const missing = state.statsMissing || [];
    const missMap = new Map(missing.map((m) => [m.username, Array.isArray(m.dates) ? m.dates : []]));
    const userMap = new Map();
    rows.forEach((r) => {
      const cur =
        userMap.get(r.username) || {
          username: r.username,
          department: r.department || '',
          batches: 0,
          images: 0,
          vinSuccess: 0,
          vinFail: 0,
          lastAt: 0,
        };
      cur.batches += r.batches || 0;
      cur.images += r.images || 0;
      cur.vinSuccess += r.vinSuccess || 0;
      cur.vinFail += r.vinFail || 0;
      cur.lastAt = Math.max(cur.lastAt, r.lastAt || 0);
      if (!cur.department && r.department) cur.department = r.department;
      userMap.set(r.username, cur);
    });
    missing.forEach((m) => {
      if (userMap.has(m.username)) return;
      userMap.set(m.username, {
        username: m.username,
        department: m.department || '',
        batches: 0,
        images: 0,
        vinSuccess: 0,
        vinFail: 0,
        lastAt: 0,
      });
    });
    const people = Array.from(userMap.values()).sort(
      (a, b) =>
        ((missMap.get(b.username) || []).length - (missMap.get(a.username) || []).length) ||
        a.username.localeCompare(b.username, 'zh')
    );
    if (people.length) {
      lines.push('人员明细');
      lines.push(
        ['账号', '部门', '上传批次', '上传图片', '车架号成功', '车架号失败', '漏传次数', '漏传日期'].join(',')
      );
      people.forEach((u) => {
        const dates = missMap.get(u.username) || [];
        lines.push(
          [
            u.username,
            u.department || '',
            u.batches || 0,
            u.images || 0,
            u.vinSuccess || 0,
            u.vinFail || 0,
            dates.length,
            dates.join('、'),
          ]
            .map(esc)
            .join(',')
        );
      });
      lines.push('');
    }

    lines.push('日期明细');
    lines.push(header.join(','));
    rows.forEach((r) => {
      lines.push(
        [
          r.date,
          r.username,
          r.department || '',
          r.batches || 0,
          r.images || 0,
          r.vinSuccess || 0,
          r.vinFail || 0,
          r.lastAt ? new Date(r.lastAt).toLocaleString('zh-CN') : '',
        ]
          .map(esc)
          .join(',')
      );
    });
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `上传统计_${dateStr(new Date())}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function openFolderAccessModal(u) {
    let data;
    try {
      data = await api(`/api/admin/folders?userId=${u.id}`);
    } catch (err) {
      return toast(err.message, 'error');
    }
    const isCustom = data.mode === 'custom';
    const folderHtml = data.folders.length
      ? data.folders
          .map(
            (f) =>
              `<label class="perm-folder"><input type="checkbox" value="${escapeHtml(f)}" ${
                data.granted.includes(f) ? 'checked' : ''
              } /><span>${escapeHtml(f)}</span></label>`
          )
          .join('')
      : '<div class="perm-empty">网盘根目录下还没有文件夹</div>';

    openModal(
      `<h3>文件夹权限</h3>
       <p class="modal-desc">控制「${escapeHtml(u.username)}」能看到和访问的文件夹</p>
       <div class="perm-mode">
         <label class="perm-option"><input type="radio" name="permMode" value="all" ${
           isCustom ? '' : 'checked'
         } /><span>全部文件夹（不受限制）</span></label>
         <label class="perm-option"><input type="radio" name="permMode" value="custom" ${
           isCustom ? 'checked' : ''
         } /><span>只允许指定文件夹</span></label>
       </div>
       <div class="perm-folders" id="permFolders">${folderHtml}</div>
       <div class="modal-error" id="permError"></div>
       <div class="modal-actions">
         <button class="btn" data-close>取消</button>
         <button class="btn primary" id="permSave">保存</button>
       </div>`,
      (box) => {
        const boxes = () => Array.from(box.querySelectorAll('#permFolders input'));
        const sync = () => {
          const custom = box.querySelector('input[name="permMode"]:checked').value === 'custom';
          $('#permFolders', box).classList.toggle('readonly', !custom);
          boxes().forEach((i) => (i.disabled = !custom));
        };
        box.querySelectorAll('input[name="permMode"]').forEach((r) => (r.onchange = sync));
        sync();
        box.querySelector('[data-close]').onclick = closeModal;
        $('#permSave', box).onclick = async () => {
          const mode = box.querySelector('input[name="permMode"]:checked').value;
          const folders = boxes()
            .filter((i) => i.checked)
            .map((i) => i.value);
          try {
            await api('/api/admin/folder-access', {
              method: 'POST',
              body: { userId: u.id, mode, folders },
            });
            closeModal();
            toast('文件夹权限已保存');
            loadAdmin();
          } catch (err) {
            $('#permError', box).textContent = err.message;
          }
        };
      }
    );
  }

  /* ---------------- 初始化 ---------------- */
  async function init() {
    const savedTheme = localStorage.getItem('cd-theme');
    document.documentElement.dataset.theme =
      savedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

    bindEvents();

    try {
      const me = await api('/api/me');
      if (!me || !me.user) {
        location.href = '/login';
        return;
      }
      state.user = me.user;
      state.usage = me.usage;
      if (me.needPhone) {
        location.href = '/login.html';
        return;
      }
      paintUser();
      setupAdminUI();
    } catch {
      return;
    }

    $('#tabbar').hidden = false; // 登录成功后显示底部 Tab（仅移动端可见，见 CSS）

    const params = new URLSearchParams(location.search);
    const initialView = params.get('view') || 'files';
    const initialPath = params.get('path') || '/';
    if (initialView === 'files') {
      await loadFiles(initialPath, { replaceHistory: true });
    } else if (initialView === 'search') {
      const q = params.get('q') || '';
      if (q) {
        $('#searchInput').value = q;
        state.keyword = q;
        switchView('search');
        await runSearch(q);
        history.replaceState({ view: 'search', q }, '', `/?view=search&q=${encodeURIComponent(q)}`);
      } else {
        await loadFiles('/', { replaceHistory: true });
      }
    } else if (initialView === 'logs' && (!state.user || state.user.role !== 'admin')) {
      await loadFiles('/', { replaceHistory: true });
    } else {
      switchView(initialView);
      history.replaceState({ view: initialView, path: null }, '', viewUrl(initialView));
    }
  }

  window.addEventListener('popstate', (event) => {
    const st = event.state || {};
    const view = st.view || 'files';
    const pathname = st.path || '/';
    if (view === 'search') {
      const q = st.q || '';
      $('#searchInput').value = q;
      state.keyword = q;
      if (!q) {
        switchView('files');
        loadFiles(state.path, { silent: true });
      } else {
        switchView('search');
        runSearch(q);
      }
    } else if (view === 'files') {
      if (state.view !== 'files') switchView('files');
      loadFiles(pathname, { silent: true });
    } else {
      switchView(view);
    }
  });

  init();
})();