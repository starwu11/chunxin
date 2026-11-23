const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, TMP_DIR } = require('./db');
const store = require('./fsstore');
const permissions = require('./permissions');
const autoFolders = require('./auto-folders');
const vinDecoder = require('./vin');
const audit = require('./audit');
const temp = require('./temp');

const TTL = 30 * 60 * 1000;
const MIN_IMAGES = Number(process.env.BATCH_MIN_IMAGES || 10);
const MAX_IMAGES = Number(process.env.BATCH_MAX_IMAGES || 30);
const VIN_FALLBACK_LIMIT = Math.max(0, Number(process.env.VIN_FALLBACK_LIMIT || 2));
const VIN_FALLBACK_TIMEOUT = Number(process.env.VIN_FALLBACK_TIMEOUT_MS || 25000);
const SERVICE_TYPES = {
  ppf: '车衣',
  window: '窗膜',
  mod: '改装',
};
const batches = new Map();

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function purgeExpired() {
  const now = Date.now();
  for (const [id, batch] of batches) {
    if (now - batch.createdAt > TTL) {
      safeRemove(batch.dir);
      batches.delete(id);
    }
  }
}

function parseTarget(vpath) {
  const normalized = store.normalizeVPath(vpath);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  return { folder: parts[0], date: parts[1], path: normalized };
}

function start(user, vpath, type) {
  purgeExpired();
  const target = parseTarget(vpath);
  if (!target) {
    throw fail('请先进入「门店 / 当天日期」文件夹再上传');
  }
  const today = autoFolders.todayName();
  if (target.date !== today) {
    throw fail(`只能上传到当天日期文件夹（${today}）`);
  }
  if (!permissions.canAccess(user.id, target.path)) {
    throw fail('无权上传到该文件夹', 403);
  }
  const serviceType = SERVICE_TYPES[type] ? type : 'ppf';
  const { abs } = store.resolvePath(user.id, target.path);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw fail('目标文件夹不存在', 404);
  }

  const id = crypto.randomBytes(12).toString('hex');
  const dir = path.join(TMP_DIR, `batch-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  batches.set(id, {
    id,
    userId: user.id,
    username: user.username,
    department: user.department || '',
    targetPath: target.path,
    date: target.date,
    vin: '',
    serviceType,
    dir,
    files: [],
    createdAt: Date.now(),
  });
  return { batchId: id, target: target.path, min: MIN_IMAGES, max: MAX_IMAGES, serviceType, serviceLabel: SERVICE_TYPES[serviceType] };
}

function get(user, batchId) {
  const batch = batches.get(batchId);
  if (!batch || batch.userId !== user.id) throw fail('上传批次不存在或已过期', 404);
  if (Date.now() - batch.createdAt > TTL) {
    cancel(user, batchId);
    throw fail('上传批次已过期，请重新上传', 410);
  }
  return batch;
}

function addFile(user, batchId, index, fileName, req) {
  const batch = get(user, batchId);
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_IMAGES) {
    throw fail(`图片序号无效（单批最多 ${MAX_IMAGES} 张）`);
  }
  if (batch.files.some((f) => f.index === idx)) {
    throw fail('该序号已上传，请勿重复提交', 409);
  }
  const safeName = String(fileName || '').replace(/[\\/:*?"<>|]/g, '_').slice(-120);
  if (!/\.(jpe?g|png|webp|heic|heif|gif)$/i.test(safeName)) {
    throw fail('只允许上传图片文件（jpg/png/webp/heic/gif）');
  }

  const target = path.join(
    batch.dir,
    `${idx}-${crypto.randomBytes(4).toString('hex')}-${safeName || `image-${idx}.jpg`}`
  );
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target);
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        req.destroy(fail('单张图片不能超过 64MB', 413));
      }
    });
    req.pipe(out);
    out.on('finish', () => {
      batch.files.push({ index: idx, name: safeName || `image-${idx}.jpg`, path: target, size });
      resolve({ ok: true, received: batch.files.length, min: MIN_IMAGES, max: MAX_IMAGES });
    });
    out.on('error', reject);
    req.on('error', reject);
  });
}

function recordVin(user, date, success, reason) {
  try {
    db.prepare(
      'INSERT INTO vin_attempts (user_id, username, date, success, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(user.id, user.username, date, success ? 1 : 0, String(reason || '').slice(0, 80), Date.now());
  } catch {
    /* ignore */
  }
}

function maxPhotoSequence(dirAbs, prefix) {
  let max = 0;
  try {
    for (const name of fs.readdirSync(dirAbs)) {
      if (!name.startsWith(prefix + '_')) continue;
      const m = /^(.+)_(\d{3,})(\.[^.]+)$/.exec(name);
      if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
    }
  } catch {
    /* ignore */
  }
  return max;
}

function renamePhotosInDir(dirAbs, newPrefix) {
  if (!dirAbs || !newPrefix) return 0;
  let renamed = 0;
  try {
    if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) return 0;
    const files = fs
      .readdirSync(dirAbs, { withFileTypes: true })
      .filter((entry) => entry.isFile());
    let max = maxPhotoSequence(dirAbs, newPrefix);
    const items = [];
    for (const entry of files) {
      if (entry.name.startsWith(newPrefix + '_')) continue;
      const m = /^(.*)_(\d{3,})(\.[^.]+)$/.exec(entry.name);
      if (!m) continue;
      if (!/\.(jpe?g|png|webp|heic|heif|gif)$/i.test(m[3])) continue;
      items.push({ name: entry.name, seq: Number(m[2]), ext: m[3] });
    }
    items.sort((a, b) => a.seq - b.seq);
    for (const it of items) {
      let seq = it.seq;
      let target = path.join(dirAbs, `${newPrefix}_${String(seq).padStart(3, '0')}${it.ext}`);
      if (fs.existsSync(target)) {
        max += 1;
        seq = max;
        target = path.join(dirAbs, `${newPrefix}_${String(seq).padStart(3, '0')}${it.ext}`);
      } else {
        max = Math.max(max, seq);
      }
      fs.renameSync(path.join(dirAbs, it.name), target);
      renamed += 1;
    }
  } catch (err) {
    console.error('[vin-rename-photo]', dirAbs, err.message);
  }
  return renamed;
}

function updateSharePaths(userId, oldVPath, newVPath) {
  try {
    const rows = db
      .prepare(
        `SELECT token, path FROM shares
         WHERE user_id = ? AND (path = ? OR path LIKE ?)`
      )
      .all(userId, oldVPath, oldVPath + '/%');
    for (const row of rows) {
      const nextPath =
        row.path === oldVPath ? newVPath : newVPath + String(row.path).slice(oldVPath.length);
      db.prepare('UPDATE shares SET path = ? WHERE token = ?').run(nextPath, row.token);
    }
    return rows.length;
  } catch {
    return 0;
  }
}

function userCarFolderName(username, carName) {
  const safeUser = String(username || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 30);
  const safeCar = String(carName || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  return safeUser ? `${safeUser}_${safeCar}` : safeCar;
}

function renameVinFolders(user, vin, newName) {
  if (!vin || !newName) return [];
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT DISTINCT folder_path, car_name FROM upload_batches
         WHERE user_id = ? AND vin = ? AND car_name <> '' AND car_name <> ?`
      )
      .all(user.id, vin, newName);
  } catch {
    return [];
  }
  const updates = [];
  for (const row of rows) {
    const folderPath = store.normalizeVPath(row.folder_path || '/');
    const oldName = String(row.car_name || '');
    if (!oldName || oldName === newName) continue;
    const oldFolder = userCarFolderName(user.username, oldName);
    const newFolder = userCarFolderName(user.username, newName);
    const oldVPath = store.joinVPath(folderPath, oldFolder);
    const newVPath = store.joinVPath(folderPath, newFolder);
    const oldAbs = store.resolvePath(user.id, oldVPath).abs;
    const newAbs = store.resolvePath(user.id, newVPath).abs;
    try {
      if (fs.existsSync(oldAbs) && fs.statSync(oldAbs).isDirectory()) {
        if (!fs.existsSync(newAbs)) {
          fs.renameSync(oldAbs, newAbs);
        } else {
          let next = maxPhotoSequence(newAbs, newName);
          for (const entry of fs.readdirSync(oldAbs, { withFileTypes: true })) {
            const src = path.join(oldAbs, entry.name);
            if (entry.isDirectory()) {
              fs.renameSync(src, store.uniqueAbsPath(path.join(newAbs, entry.name)));
              continue;
            }
            const m = /^(.*)_(\d{3,})(\.[^.]+)$/.exec(entry.name);
            if (m && /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(m[3])) {
              next += 1;
              const dest = path.join(newAbs, `${newName}_${String(next).padStart(3, '0')}${m[3]}`);
              fs.renameSync(src, dest);
            } else {
              fs.renameSync(src, store.uniqueAbsPath(path.join(newAbs, entry.name)));
            }
          }
          fs.rmSync(oldAbs, { recursive: true, force: true });
        }
      }
      if (fs.existsSync(newAbs)) renamePhotosInDir(newAbs, newName);
      db.prepare(
        `UPDATE upload_batches SET car_name = ?
         WHERE user_id = ? AND vin = ? AND folder_path = ? AND car_name = ?`
      ).run(newName, user.id, vin, folderPath, oldName);
      updateSharePaths(user.id, oldVPath, newVPath);
      audit.add(user, 'rename', oldVPath, `识别车型后更新为 ${newName}`, '');
      updates.push({ from: oldVPath, to: newVPath });
      console.log('[vin-rename]', oldVPath, '->', newVPath);
    } catch (err) {
      console.error('[vin-rename]', folderPath, err.message);
    }
  }
  return updates;
}

async function commit(user, batchId) {
  const batch = get(user, batchId);
  let vinRecorded = false;
  try {
    const count = batch.files.length;
    if (count < MIN_IMAGES || count > MAX_IMAGES) {
      throw fail(`每批需要上传 ${MIN_IMAGES}-${MAX_IMAGES} 张图片，当前 ${count} 张，本批已取消`);
    }

    const ordered = batch.files.slice().sort((a, b) => a.index - b.index);

    const { abs } = store.resolvePath(user.id, batch.targetPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw fail('目标文件夹已不存在', 404);
    }

    // 1. 先把照片保存到门店/日期目录（保留原文件名）
    const savedFiles = [];
    for (const file of ordered) {
      const target = store.uniqueAbsPath(path.join(abs, file.name));
      fs.renameSync(file.path, target);
      savedFiles.push({ index: file.index, abs: target, name: path.basename(target) });
    }

    // 2. 从已保存的照片中定位车架号照片
    const park = (reason) => {
      try {
        const parked = temp.saveBatch(user, batch.targetPath, savedFiles, { date: batch.date, reason });
        console.log('[temp-park]', user.username, parked.virtualPath, reason);
        return parked;
      } catch (err) {
        console.error('[temp-park]', user.username, err.message);
        return null;
      }
    };
    const parkError = (parked, fallback) =>
      parked
        ? `照片已存入「未归档」临时文件夹（${parked.count} 张），请联系管理员处理`
        : fallback;
    const vinSaved = savedFiles.find((f) => /车架号/i.test(f.name));
    if (!vinSaved) {
      const parked = park('未找到车架号照片');
      recordVin(user, batch.date, 0, '未勾选车架号照片');
      vinRecorded = true;
      throw fail(parkError(parked, '照片已保存，但未找到车架号照片，请勾选一张车架号照片后重新上传'));
    }

    // 3. 识别车架号并解码车型（勾选照片失败时自动扫描同批其他照片）
    let ocr = { vin: '', confidence: '', candidates: [] };
    let markedError = null;
    try {
      ocr = await vinDecoder.recognizeVINFromImage({ name: vinSaved.name, path: vinSaved.abs });
    } catch (err) {
      markedError = err;
      console.error('[vin-marked]', vinSaved.name, err.message);
    }
    let vinSource = 'marked';
    let vinFallbackName = '';
    if (!ocr.vin && VIN_FALLBACK_LIMIT > 0) {
      const others = savedFiles.filter((f) => f !== vinSaved).slice().reverse().slice(0, VIN_FALLBACK_LIMIT);
      for (const f of others) {
        try {
          const retry = await vinDecoder.recognizeVINFromImage(
            { name: f.name, path: f.abs },
            { fast: true, timeout: VIN_FALLBACK_TIMEOUT }
          );
          if (retry.vin) {
            ocr = retry;
            vinSource = 'fallback';
            vinFallbackName = f.name;
            console.log('[vin-fallback]', vinSaved.name, '未识别，已从', f.name, '识别到', retry.vin);
            break;
          }
        } catch (err) {
          console.error('[vin-fallback]', f.name, err.message);
        }
      }
    }
    recordVin(user, batch.date, !!ocr.vin, ocr.vin ? '' : markedError ? markedError.message : '未识别到VIN');
    vinRecorded = true;
    if (!ocr.vin) {
      const parked = park('未识别到VIN');
      throw fail(parkError(parked, '照片已保存，但未能从车架号照片识别 VIN，请上传清晰的车架号照片后重试'));
    }
    batch.vin = ocr.vin;
    const vinConfidence = ocr.confidence || '';

    const decoded = await vinDecoder.decodeVIN(batch.vin);
    const carName = String(decoded.carName || '').trim();
    if (!carName) {
      const parked = park('无法识别车型');
      throw fail(parkError(parked, '照片已保存，但无法识别车型，请联系管理员检查识别服务'));
    }

    // 4. 按车型建文件夹并归档（同一部门不同用户各自单独建文件夹）
    const safeCarName = carName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const renamedFolders = renameVinFolders(user, batch.vin, safeCarName);
    const carFolder = userCarFolderName(user.username, safeCarName);
    const carDir = path.join(abs, carFolder);
    if (!fs.existsSync(carDir)) fs.mkdirSync(carDir, { recursive: true });

    let seq = nextSequence(carDir);
    const saved = [];
    for (const file of savedFiles) {
      const ext = path.extname(file.name).toLowerCase() || '.jpg';
      const newName = `${safeCarName}_${String(seq).padStart(3, '0')}${ext}`;
      const target = store.uniqueAbsPath(path.join(carDir, newName));
      fs.renameSync(file.abs, target);
      saved.push(path.basename(target));
      seq += 1;
    }

    const carVPath = store.joinVPath(batch.targetPath, carFolder);

    db.prepare(
      `INSERT INTO upload_batches
        (user_id, username, department, date, folder_path, image_count, vin, car_name, service_type, copy_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      user.id,
      user.username,
      batch.department || '',
      batch.date,
      batch.targetPath,
      saved.length,
      batch.vin,
      safeCarName,
      batch.serviceType,
      '',
      Date.now()
    );

    batches.delete(batchId);
    safeRemove(batch.dir);
    return {
      ok: true,
      count: saved.length,
      files: saved,
      target: carVPath,
      carName: safeCarName,
      vin: batch.vin,
      vinConfidence,
      vinCandidates: ocr.candidates || [],
      vinCheckDigitOk: !!ocr.checkDigitOk,
      vinSource,
      vinFallbackName,
      brand: decoded.brand || '',
      model: decoded.model || '',
      vinMethod: decoded.method,
      serviceType: batch.serviceType,
      serviceLabel: SERVICE_TYPES[batch.serviceType] || '',
      copy: '',
      copyPath: '',
      copyError: '',
      folder: carVPath,
      renamed: renamedFolders.length,
    };
  } catch (err) {
    if (!vinRecorded) recordVin(user, batch.date, 0, String(err.message || '').slice(0, 80));
    cancel(user, batchId);
    throw err;
  }
}

function cancel(user, batchId) {
  const batch = batches.get(batchId);
  if (!batch) return { ok: true };
  if (user && batch.userId !== user.id) throw fail('无权操作该批次', 403);
  batches.delete(batchId);
  safeRemove(batch.dir);
  return { ok: true };
}

function safeRemove(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function nextSequence(dir) {
  let max = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 1;
  }
  for (const name of names) {
    const m = /_(\d{3,})\.(?:jpe?g|png|webp|heic|heif|gif)$/i.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function timestampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}

module.exports = {
  start,
  addFile,
  commit,
  cancel,
  renameVinFolders,
  renamePhotosInDir,
  MIN_IMAGES,
  MAX_IMAGES,
};