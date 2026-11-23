const fs = require('fs');
const path = require('path');
const JPEG = require('jpeg-js');
const { PNG } = require('pngjs');

const BRAND_DIR = path.join(__dirname, '..', 'public', 'assets', 'brand');
const LOGO_PATH = path.join(BRAND_DIR, 'logo-white.png');
const TAG_PATHS = {
  ppf: path.join(BRAND_DIR, 'tag-ppf.png'),
  window: path.join(BRAND_DIR, 'tag-window.png'),
  mod: path.join(BRAND_DIR, 'tag-mod.png'),
};
const MAX_EDGE = 1600;
const LOGO_WIDTH_RATIO = 0.18;
const LOGO_MARGIN_RATIO = 0.035;
const LOGO_ALPHA = 0.9;

let logoCache = null;
const tagCache = {};

function getLogo() {
  if (!logoCache) {
    logoCache = PNG.sync.read(fs.readFileSync(LOGO_PATH));
  }
  return logoCache;
}

function getTag(type) {
  if (!TAG_PATHS[type]) return null;
  if (!tagCache[type]) {
    tagCache[type] = PNG.sync.read(fs.readFileSync(TAG_PATHS[type]));
  }
  return tagCache[type];
}

function decodeImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  if (ext === '.png') {
    return PNG.sync.read(buf);
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    const raw = JPEG.decode(buf, { useTArray: true });
    return { width: raw.width, height: raw.height, data: Buffer.from(raw.data) };
  }
  return null;
}

function resize(rgba, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = y * yr;
    const y0 = Math.min(sh - 1, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = x * xr;
      const x0 = Math.min(sw - 1, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = rgba[(y0 * sw + x0) * 4 + c];
        const p10 = rgba[(y0 * sw + x1) * 4 + c];
        const p01 = rgba[(y1 * sw + x0) * 4 + c];
        const p11 = rgba[(y1 * sw + x1) * 4 + c];
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        out[o + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return out;
}

function colorGrade(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    let r = rgba[i];
    let g = rgba[i + 1];
    let b = rgba[i + 2];

    // 轻微提亮 + 对比度
    r = (r - 128) * 1.06 + 128 + 6;
    g = (g - 128) * 1.06 + 128 + 6;
    b = (b - 128) * 1.06 + 128 + 6;

    // 饱和度
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = lum + (r - lum) * 1.12;
    g = lum + (g - lum) * 1.12;
    b = lum + (b - lum) * 1.12;

    // 暖色
    r += 4;
    b -= 3;

    rgba[i] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
    rgba[i + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
    rgba[i + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
  }
}

function compositeLogo(rgba, width, height) {
  const logo = getLogo();
  const targetW = Math.max(120, Math.round(width * LOGO_WIDTH_RATIO));
  const targetH = Math.max(1, Math.round((logo.height / logo.width) * targetW));
  const scaled = resize(Buffer.from(logo.data), logo.width, logo.height, targetW, targetH);
  const margin = Math.round(width * LOGO_MARGIN_RATIO);
  const startX = width - targetW - margin;
  const startY = height - targetH - margin;

  for (let y = 0; y < targetH; y++) {
    const dy = startY + y;
    if (dy < 0 || dy >= height) continue;
    for (let x = 0; x < targetW; x++) {
      const dx = startX + x;
      if (dx < 0 || dx >= width) continue;
      const si = (y * targetW + x) * 4;
      const a = (scaled[si + 3] / 255) * LOGO_ALPHA;
      if (a <= 0.02) continue;
      const di = (dy * width + dx) * 4;
      rgba[di] = Math.round(scaled[si] * a + rgba[di] * (1 - a));
      rgba[di + 1] = Math.round(scaled[si + 1] * a + rgba[di + 1] * (1 - a));
      rgba[di + 2] = Math.round(scaled[si + 2] * a + rgba[di + 2] * (1 - a));
    }
  }
}

function compositeTag(rgba, width, height, type) {
  const tag = getTag(type);
  if (!tag) return;
  const targetW = Math.min(Math.round(width * 0.55), 900);
  const targetH = Math.max(1, Math.round((tag.height / tag.width) * targetW));
  const scaled = resize(Buffer.from(tag.data), tag.width, tag.height, targetW, targetH);
  const margin = Math.round(width * LOGO_MARGIN_RATIO);
  const startX = margin;
  const startY = height - targetH - margin;
  const alphaScale = 0.94;

  for (let y = 0; y < targetH; y++) {
    const dy = startY + y;
    if (dy < 0 || dy >= height) continue;
    for (let x = 0; x < targetW; x++) {
      const dx = startX + x;
      if (dx < 0 || dx >= width) continue;
      const si = (y * targetW + x) * 4;
      const a = (scaled[si + 3] / 255) * alphaScale;
      if (a <= 0.02) continue;
      const di = (dy * width + dx) * 4;
      rgba[di] = Math.round(scaled[si] * a + rgba[di] * (1 - a));
      rgba[di + 1] = Math.round(scaled[si + 1] * a + rgba[di + 1] * (1 - a));
      rgba[di + 2] = Math.round(scaled[si + 2] * a + rgba[di + 2] * (1 - a));
    }
  }
}

function enhanceForOCR(srcPath) {
  const img = decodeImage(srcPath);
  if (!img || !img.width || !img.height) throw new Error('无法解码车架号图片');
  let width = img.width;
  let height = img.height;
  let data = img.data;
  const target = 2200;
  if (Math.max(width, height) < target) {
    const ratio = target / Math.max(width, height);
    const nw = Math.max(1, Math.round(width * ratio));
    const nh = Math.max(1, Math.round(height * ratio));
    data = resize(data, width, height, nw, nh);
    width = nw;
    height = nh;
  }
  for (let i = 0; i < data.length; i += 4) {
    const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const c = Math.max(0, Math.min(255, (g - 128) * 1.55 + 128));
    data[i] = c;
    data[i + 1] = c;
    data[i + 2] = c;
  }
  const encoded = JPEG.encode({ data, width, height }, 92);
  return { base64: encoded.data.toString('base64'), mime: 'image/jpeg', width, height };
}

function createMomentsImage(srcPath, destPath, type) {
  const img = decodeImage(srcPath);
  if (!img || !img.width || !img.height) {
    throw new Error('无法解码图片');
  }

  let width = img.width;
  let height = img.height;
  let data = img.data;

  if (Math.max(width, height) > MAX_EDGE) {
    const ratio = MAX_EDGE / Math.max(width, height);
    const nw = Math.max(1, Math.round(width * ratio));
    const nh = Math.max(1, Math.round(height * ratio));
    data = resize(data, width, height, nw, nh);
    width = nw;
    height = nh;
  }

  colorGrade(data);
  compositeTag(data, width, height, type);
  compositeLogo(data, width, height);

  const encoded = JPEG.encode({ data, width, height }, 85);
  fs.writeFileSync(destPath, encoded.data);
  return { width, height, size: encoded.data.length };
}

module.exports = { createMomentsImage, decodeImage, enhanceForOCR };