const fs = require('fs');
const path = require('path');
const JPEG = require('jpeg-js');
const { PNG } = require('pngjs');

function resize(rgba, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const sy = y * yr;
    const y0 = Math.min(sh - 1, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x += 1) {
      const sx = x * xr;
      const x0 = Math.min(sw - 1, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c += 1) {
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

function readOrientation(buf) {
  try {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
    let offset = 2;
    while (offset + 4 <= buf.length) {
      if (buf[offset] !== 0xff) return 1;
      const marker = buf[offset + 1];
      const len = buf.readUInt16BE(offset + 2);
      if (marker === 0xe1) {
        const start = offset + 4;
        if (buf.slice(start, start + 6).toString('latin1') !== 'Exif\u0000\u0000') return 1;
        const tiff = start + 6;
        const le = buf[tiff] === 0x49 && buf[tiff + 1] === 0x49;
        const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
        const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
        if (u16(tiff + 2) !== 42) return 1;
        const ifd = tiff + u32(tiff + 4);
        const count = u16(ifd);
        for (let i = 0; i < count; i += 1) {
          const entry = ifd + 2 + i * 12;
          if (u16(entry) === 0x0112) return u16(entry + 8) || 1;
        }
        return 1;
      }
      offset += 2 + len;
    }
    return 1;
  } catch {
    return 1;
  }
}

function applyOrientation(img, orientation) {
  if (!orientation || orientation === 1) return img;
  const { data, width: w, height: h } = img;
  const swap = orientation >= 5;
  const dw = swap ? h : w;
  const dh = swap ? w : h;
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      let sx = x;
      let sy = y;
      if (orientation === 2) {
        sx = w - 1 - x;
      } else if (orientation === 3) {
        sx = w - 1 - x;
        sy = h - 1 - y;
      } else if (orientation === 4) {
        sy = h - 1 - y;
      } else if (orientation === 5) {
        sx = y;
        sy = x;
      } else if (orientation === 6) {
        sx = y;
        sy = h - 1 - x;
      } else if (orientation === 7) {
        sx = w - 1 - y;
        sy = h - 1 - x;
      } else if (orientation === 8) {
        sx = w - 1 - y;
        sy = x;
      }
      const si = (sy * w + sx) * 4;
      const di = (y * dw + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return { data: out, width: dw, height: dh };
}

function encodeThumb(abs, width, out) {
  const ext = path.extname(abs).toLowerCase();
  const buf = fs.readFileSync(abs);
  let img;
  if (ext === '.png') {
    const png = PNG.sync.read(buf);
    img = { data: png.data, width: png.width, height: png.height };
  } else {
    const raw = JPEG.decode(buf, { useTArray: true });
    img = { data: Buffer.from(raw.data), width: raw.width, height: raw.height };
  }
  img = applyOrientation(img, ext === '.png' ? 1 : readOrientation(buf));
  const w = Math.min(width, img.width);
  const h = Math.max(1, Math.round((img.height * w) / img.width));
  const data = w === img.width ? img.data : resize(img.data, img.width, img.height, w, h);
  const encoded = JPEG.encode({ data, width: w, height: h }, 72);
  fs.writeFileSync(out, encoded.data);
  return { width: w, height: h, bytes: encoded.data.length };
}

module.exports = { encodeThumb };