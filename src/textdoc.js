const fs = require('fs');
const path = require('path');
const store = require('./fsstore');

const TEXT_EXT = new Set(['txt', 'md', 'csv', 'log', 'json', 'xml', 'html', 'css', 'js']);
const DOC_EXT = new Set(['doc', 'docx']);
const MAX_CHARS = 2 * 1024 * 1024;

let docxLib = null;

function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i > 0 ? String(name).slice(i + 1).toLowerCase() : '';
}

function canEdit(name) {
  const ext = extOf(name);
  return TEXT_EXT.has(ext) || DOC_EXT.has(ext);
}

function getDocx() {
  if (!docxLib) {
    try {
      docxLib = require('docx');
    } catch {
      const err = new Error('服务器缺少 Word 生成组件，请管理员安装依赖后重试');
      err.status = 500;
      throw err;
    }
  }
  return docxLib;
}

async function buildDocx(text) {
  const { Document, Packer, Paragraph, TextRun } = getDocx();
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const children = lines.map((line) =>
    line ? new Paragraph({ children: [new TextRun(line)] }) : new Paragraph({ children: [] })
  );
  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}

async function save(ownerId, vpath, text) {
  const { abs, vpath: normalized } = store.resolvePath(ownerId, vpath);
  if (!fs.existsSync(abs)) {
    const err = new Error('文件不存在');
    err.status = 404;
    throw err;
  }
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    const err = new Error('不是文件');
    err.status = 400;
    throw err;
  }
  const ext = extOf(abs);
  if (!TEXT_EXT.has(ext) && !DOC_EXT.has(ext)) {
    const err = new Error('该文件类型不支持在线编辑');
    err.status = 400;
    throw err;
  }
  const content = String(text == null ? '' : text);
  if (content.length > MAX_CHARS) {
    const err = new Error('内容超过 2MB，无法保存');
    err.status = 413;
    throw err;
  }

  const backupAbs = abs + '.bak';
  fs.copyFileSync(abs, backupAbs);

  let finalPath = normalized;
  let converted = false;
  if (TEXT_EXT.has(ext)) {
    let hasBom = false;
    if (st.size >= 3) {
      const head = Buffer.alloc(3);
      const fd = fs.openSync(abs, 'r');
      try {
        fs.readSync(fd, head, 0, 3, 0);
      } finally {
        fs.closeSync(fd);
      }
      hasBom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
    }
    fs.writeFileSync(abs, (hasBom ? '\uFEFF' : '') + content, 'utf8');
  } else {
    const buffer = await buildDocx(content);
    if (ext === 'docx') {
      fs.writeFileSync(abs, buffer);
    } else {
      const docxPath = abs.slice(0, -4) + '.docx';
      if (fs.existsSync(docxPath)) {
        const err = new Error('同目录已存在同名 .docx，请先重命名后再保存');
        err.status = 409;
        throw err;
      }
      fs.writeFileSync(docxPath, buffer);
      fs.rmSync(abs, { force: true });
      finalPath = normalized.slice(0, -4) + '.docx';
      converted = true;
    }
  }

  return {
    path: finalPath,
    name: path.posix.basename(finalPath),
    backupName: path.basename(backupAbs),
    converted,
  };
}

module.exports = {
  TEXT_EXT,
  DOC_EXT,
  MAX_CHARS,
  extOf,
  canEdit,
  save,
};