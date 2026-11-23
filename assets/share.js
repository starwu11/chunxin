(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const token = location.pathname.split('/').filter(Boolean).pop();
  let info = null;
  let currentDir = '/';

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

  const ICONS = {
    folder: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h3.6l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" fill="currentColor" opacity=".95"/><path d="M3 8.5h18" stroke="#fff" stroke-opacity=".35" stroke-width="1.4"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 4v10M8 10.5l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 17v2h14v-2" stroke-linecap="round"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2.6 12S6 6.4 12 6.4 21.4 12 21.4 12 18 17.6 12 17.6 2.6 12 2.6 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
  }

  function groupOf(name) {
    const ext = extOf(name);
    for (const [g, list] of Object.entries(GROUPS)) if (list.includes(ext)) return g;
    return 'text';
  }

  function fmtSize(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function fmtDate(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function iconBox(name) {
    const box = el('div', 'ftype ' + groupOf(name));
    box.textContent = (extOf(name).toUpperCase() || 'FILE').slice(0, 4);
    return box;
  }

  function showPassword() {
    $('#loading').hidden = true;
    $('#passwordCard').hidden = false;
    $('#sharePassword').focus();
  }

  function showError(title, desc) {
    $('#loading').hidden = true;
    $('#passwordCard').hidden = true;
    $('#shareCard').hidden = true;
    $('#errorCard').hidden = false;
    $('#errorTitle').textContent = title;
    $('#errorDesc').textContent = desc;
  }

  function fileMeta(extra) {
    const meta = el('div', 'share-file-meta');
    const parts = [];
    if (info.size) parts.push(`<span>${fmtSize(info.size)}</span>`);
    parts.push(`<span>分享者 ${escapeHtml(info.owner || '匿名')}</span>`);
    parts.push(
      `<span>${info.expiresAt ? `有效期至 ${fmtDate(info.expiresAt)}` : '永久有效'}</span>`
    );
    if (extra) parts.push(`<span>${extra}</span>`);
    meta.innerHTML = parts.join('');
    return meta;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isWechat() {
    return /MicroMessenger/i.test(navigator.userAgent || '');
  }

  function wechatDownloadNotice(downloadUrl) {
    const fullUrl = downloadUrl ? location.origin + downloadUrl : '';
    const urlBox = fullUrl
      ? `<p style="margin:8px 0;color:#4b5563">也可复制下方链接，到浏览器地址栏粘贴打开：</p>
         <input id="wxUrl" readonly value="${escapeHtml(fullUrl)}" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #d9dce3;border-radius:8px;font-size:12.5px;margin-top:4px" />
         <button class="btn" id="wxCopy" type="button" style="margin-top:10px">复制下载链接</button>`
      : '';
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px';
    overlay.innerHTML = `<div style="background:#fff;border-radius:14px;padding:22px;max-width:480px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.1)">
      <h3 style="margin:0 0 10px;font-size:17px">微信内无法直接下载</h3>
      <p style="margin:8px 0;color:#4b5563">请按下面两步操作：</p>
      <div style="background:#f0f5ff;border-radius:10px;padding:12px 14px;margin:10px 0;color:#2757c4">1. 点击微信右上角「···」→「在浏览器中打开」</div>
      <div style="background:#f0f5ff;border-radius:10px;padding:12px 14px;margin:10px 0;color:#2757c4">2. 在浏览器中重新打开本页即可下载</div>
      ${urlBox}
      <button class="btn" data-close style="margin-top:14px">知道了</button>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('[data-close]').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const copyBtn = overlay.querySelector('#wxCopy');
    if (copyBtn) {
      copyBtn.onclick = () => {
        const input = overlay.querySelector('#wxUrl');
        input.select();
        try { document.execCommand('copy'); } catch (e) {}
        if (navigator.clipboard) navigator.clipboard.writeText(input.value).catch(() => {});
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制下载链接'; }, 1500);
      };
    }
  }

  function showFile() {
    $('#loading').hidden = true;
    $('#shareCard').hidden = false;
    const head = $('#shareHead');
    head.innerHTML = '';
    const box = iconBox(info.name);
    box.style.width = '62px';
    box.style.height = '62px';
    box.style.flexBasis = '62px';
    box.style.borderRadius = '15px';
    box.style.fontSize = '13px';
    const infoWrap = el('div', 'share-file-info');
    infoWrap.appendChild(el('div', 'share-file-name', info.name));
    infoWrap.appendChild(fileMeta());
    head.append(box, infoWrap);

    const foot = $('#shareFoot');
    foot.innerHTML = '';
    let dl;
    if (isWechat()) {
      dl = el('button', 'btn primary');
      dl.innerHTML = ICONS.download + '<span>下载文件</span>';
      dl.onclick = () => wechatDownloadNotice(`/api/s/${token}/download?path=${encodeURIComponent(info.path || '/' + info.name)}`);
    } else {
      dl = el('a', 'btn primary');
      dl.href = `/api/s/${token}/download?path=${encodeURIComponent(info.path || '/' + info.name)}`;
      dl.innerHTML = ICONS.download + '<span>下载文件</span>';
      dl.setAttribute('download', info.name);
    }
    const pv = el('button', 'btn');
    pv.innerHTML = ICONS.eye + '<span>在线预览</span>';
    pv.onclick = () => openPreview({ name: info.name, path: info.path || '/' + info.name, isDir: false, size: info.size });
    foot.append(dl, pv);
  }

  function showDir() {
    $('#loading').hidden = true;
    $('#shareCard').hidden = false;
    const head = $('#shareHead');
    head.innerHTML = '';
    const box = el('div', 'ftype folder');
    box.innerHTML = ICONS.folder;
    box.style.width = '62px';
    box.style.height = '62px';
    box.style.flexBasis = '62px';
    box.style.borderRadius = '15px';
    const infoWrap = el('div', 'share-file-info');
    infoWrap.appendChild(el('div', 'share-file-name', info.name));
    infoWrap.appendChild(fileMeta('文件夹'));
    head.append(box, infoWrap);
    const foot = $('#shareFoot');
    foot.innerHTML = '';
    let all;
    if (isWechat()) {
      all = el('button', 'btn primary');
      all.innerHTML = ICONS.download + '<span>下载全部（ZIP）</span>';
      all.onclick = () => wechatDownloadNotice(`/api/s/${token}/zip`);
    } else {
      all = el('a', 'btn primary');
      all.href = `/api/s/${token}/zip`;
      all.innerHTML = ICONS.download + '<span>下载全部（ZIP）</span>';
      all.setAttribute('download', `${info.name}.zip`);
    }
    foot.appendChild(all);
    loadDir('/');
  }

  function renderCrumbs() {
    const wrap = $('#shareBody').querySelector('.dir-crumbs');
    wrap.innerHTML = '';
    const root = el('button', 'dir-crumb' + (currentDir === '/' ? ' current' : ''), '全部文件');
    root.onclick = () => loadDir('/');
    wrap.appendChild(root);
    if (currentDir !== '/') {
      const parts = currentDir.slice(1).split('/');
      let acc = '';
      parts.forEach((p, i) => {
        acc += '/' + p;
        wrap.appendChild(el('span', 'dir-sep', '/'));
        const b = el('button', 'dir-crumb' + (i === parts.length - 1 ? ' current' : ''), p);
        if (i < parts.length - 1) b.onclick = () => loadDir(acc);
        wrap.appendChild(b);
      });
    }
  }

  async function loadDir(dirPath) {
    let body = $('#shareBody');
    if (!body.querySelector('.dir-crumbs')) {
      body.innerHTML = '<div class="dir-crumbs"></div><div class="dir-list" id="dirList"></div>';
    }
    currentDir = dirPath;
    renderCrumbs();
    const list = $('#dirList');
    list.innerHTML = '<div class="loading" style="padding:26px"><span class="spinner"></span></div>';
    try {
      const res = await fetch(`/api/s/${token}/list?path=${encodeURIComponent(dirPath)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '加载失败');
      list.innerHTML = '';
      if (!data.entries.length) {
        list.appendChild(el('div', 'loading', '这个文件夹是空的'));
        return;
      }
      data.entries.forEach((entry) => list.appendChild(renderDirRow(entry)));
    } catch (err) {
      list.innerHTML = '';
      list.appendChild(el('div', 'loading', err.message));
    }
  }

  function renderDirRow(entry) {
    const row = el('div', 'dir-row');
    if (entry.isDir) {
      const box = el('div', 'ftype folder');
      box.innerHTML = ICONS.folder;
      box.style.width = '36px';
      box.style.height = '36px';
      box.style.flexBasis = '36px';
      row.appendChild(box);
    } else if (groupOf(entry.name) === 'image') {
      const img = el('img', 'dir-thumb');
      img.src = `/api/s/${token}/preview?path=${encodeURIComponent(entry.path)}`;
      img.alt = entry.name;
      img.loading = 'lazy';
      img.onerror = () => {
        img.replaceWith(iconBox(entry.name));
      };
      row.appendChild(img);
    } else {
      const box = iconBox(entry.name);
      box.style.width = '36px';
      box.style.height = '36px';
      box.style.flexBasis = '36px';
      row.appendChild(box);
    }

    const nameWrap = el('div', 'dir-name');
    nameWrap.textContent = entry.name;
    if (!entry.isDir) {
      const sub = el('div', 'dir-sub', fmtSize(entry.size));
      nameWrap.appendChild(sub);
    }
    row.appendChild(nameWrap);

    const ops = el('div', 'dir-op');
    if (entry.isDir) {
      const open = el('button');
      open.innerHTML = ICONS.chevron;
      open.title = '打开文件夹';
      open.onclick = () => {
        const rel = currentDir === '/' ? `/${entry.name}` : `${currentDir}/${entry.name}`;
        loadDir(rel);
      };
      ops.appendChild(open);
    } else {
      const pv = el('button');
      pv.innerHTML = ICONS.eye;
      pv.title = '预览';
      pv.onclick = () => openPreview(entry);
      let dl;
      if (isWechat()) {
        dl = el('button');
        dl.innerHTML = ICONS.download;
        dl.title = '下载';
        dl.onclick = () => wechatDownloadNotice(`/api/s/${token}/download?path=${encodeURIComponent(entry.path)}`);
      } else {
        dl = el('a');
        dl.innerHTML = ICONS.download;
        dl.title = '下载';
        dl.href = `/api/s/${token}/download?path=${encodeURIComponent(entry.path)}`;
        dl.setAttribute('download', entry.name);
      }
      ops.append(pv, dl);
    }
    row.appendChild(ops);
    return row;
  }

  let currentZoom = null;

  function openPreview(entry) {
    const backdrop = $('#previewBackdrop');
    const body = $('#previewBody');
    $('#previewName').textContent = entry.name;
    body.innerHTML = '';
    backdrop.hidden = false;
    const url = `/api/s/${token}/preview?path=${encodeURIComponent(entry.path)}`;
    const group = groupOf(entry.name);
    if (group === 'image') {
      const wrap = el('div', 'preview-zoom');
      const img = el('img');
      img.src = url;
      wrap.appendChild(img);
      body.appendChild(wrap);
      currentZoom = window.ImageZoom ? window.ImageZoom.enable(wrap, img) : null;
    } else if (group === 'video') {
      const v = el('video');
      v.src = url;
      v.controls = true;
      v.autoplay = true;
      body.appendChild(v);
    } else if (group === 'audio') {
      const a = el('audio');
      a.src = url;
      a.controls = true;
      a.autoplay = true;
      body.appendChild(a);
    } else if (group === 'pdf') {
      const f = el('iframe');
      f.src = url;
      body.appendChild(f);
    } else if (group === 'text' || group === 'code' || group === 'sheet') {
      const pre = el('pre', '', '加载中…');
      body.appendChild(pre);
      fetch(`/api/s/${token}/text?path=${encodeURIComponent(entry.path)}`)
        .then((r) => r.json())
        .then((d) => {
          pre.textContent = d.text || '（空文件）';
        })
        .catch(() => {
          pre.textContent = '无法加载文件内容';
        });
    } else {
      const wrap = el('div', 'preview-fallback');
      wrap.innerHTML = '<p>该类型暂不支持在线预览</p>';
      let a;
      if (isWechat()) {
        a = el('button', '', '下载文件');
        a.style.cssText = 'background:none;border:0;color:#2757c4;cursor:pointer;font-size:14px;padding:0;text-decoration:underline';
        a.onclick = () => wechatDownloadNotice(`/api/s/${token}/download?path=${encodeURIComponent(entry.path)}`);
      } else {
        a = el('a', '', '下载文件');
        a.href = `/api/s/${token}/download?path=${encodeURIComponent(entry.path)}`;
        a.setAttribute('download', entry.name);
      }
      wrap.appendChild(a);
      body.appendChild(wrap);
    }
  }

  function closePreview() {
    currentZoom = null;
    $('#previewBackdrop').hidden = true;
    $('#previewBody').innerHTML = '';
  }

  async function init() {
    if (!token) return showError('链接无效', '请检查分享链接是否完整');
    try {
      const res = await fetch(`/api/s/${token}/info`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return showError('分享不存在', data.error || '链接可能已失效或被分享者取消');
      }
      info = data;
      document.title = `${info.name} · 分享 · 膜登时代`;
      if (info.needPassword && !info.verified) return showPassword();
      if (info.isDir) showDir();
      else showFile();
    } catch {
      showError('加载失败', '网络异常，请稍后重试');
    }
  }

  $('#passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#sharePassword');
    const btn = $('#unlockBtn');
    const err = $('#pwError');
    const pwd = input.value.trim();
    if (!pwd) {
      err.textContent = '请输入提取码';
      return;
    }
    btn.disabled = true;
    btn.textContent = '验证中…';
    err.textContent = '';
    try {
      const res = await fetch(`/api/s/${token}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '验证失败');
      $('#passwordCard').hidden = true;
      info.verified = true;
      if (info.isDir) showDir();
      else showFile();
    } catch (e2) {
      err.textContent = e2.message;
      btn.disabled = false;
      btn.textContent = '访问文件';
      input.select();
    }
  });

  $('#previewClose').onclick = closePreview;
  $('#zoomIn').onclick = () => currentZoom && currentZoom.zoomIn();
  $('#zoomOut').onclick = () => currentZoom && currentZoom.zoomOut();
  $('#zoomReset').onclick = () => currentZoom && currentZoom.reset();
  $('#previewBackdrop').addEventListener('click', (e) => {
    if (e.target.id === 'previewBody') closePreview();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePreview();
  });

  init();
})();