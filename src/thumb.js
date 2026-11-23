const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { Worker } = require('worker_threads');
const { DATA_DIR } = require('./db');

const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const MAX_SOURCE = 40 * 1024 * 1024;
const POOL_SIZE = Math.max(1, Math.min(2, (os.cpus() || []).length || 1));
const WORKER_FILE = path.join(__dirname, 'thumb-worker.js');

fs.mkdirSync(THUMB_DIR, { recursive: true });

const queue = [];
const inflight = new Map();
const workers = [];
let seq = 1;

function spawnWorker() {
  const worker = new Worker(WORKER_FILE);
  worker.busy = false;
  worker.task = null;
  worker.on('message', (msg) => {
    const task = worker.task;
    worker.task = null;
    worker.busy = false;
    if (task) {
      inflight.delete(task.key);
      if (msg.ok) {
        task.resolve({
          file: task.out,
          type: 'image/jpeg',
          cached: false,
          width: msg.width,
          height: msg.height,
        });
      } else {
        task.resolve(null);
      }
    }
    pump();
  });
  worker.on('error', (err) => {
    const task = worker.task;
    worker.task = null;
    worker.busy = false;
    if (task) {
      inflight.delete(task.key);
      task.resolve(null);
    }
    console.error('[thumb-worker]', err.message);
    const idx = workers.indexOf(worker);
    if (idx >= 0) workers.splice(idx, 1);
    spawnWorker();
    pump();
  });
  worker.unref();
  workers.push(worker);
  return worker;
}

function pump() {
  if (!workers.length) {
    for (let i = 0; i < POOL_SIZE; i += 1) spawnWorker();
  }
  for (const worker of workers) {
    if (worker.busy) continue;
    const task = queue.shift();
    if (!task) break;
    worker.busy = true;
    worker.task = task;
    worker.postMessage({ id: task.id, abs: task.abs, width: task.width, out: task.out });
  }
}

function prepare(abs, width) {
  const ext = path.extname(abs).toLowerCase();
  if (!['.jpg', '.jpeg', '.png'].includes(ext)) return null;
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_SOURCE) return null;
  const key = crypto
    .createHash('sha1')
    .update(`${abs}:${st.size}:${st.mtimeMs}:${width}`)
    .digest('hex');
  return { out: path.join(THUMB_DIR, `${key}.jpg`), key, outWidth: width };
}

function getThumbAsync(abs, width = 360) {
  const info = prepare(abs, width);
  if (!info) return Promise.resolve(null);
  if (fs.existsSync(info.out)) {
    return Promise.resolve({ file: info.out, type: 'image/jpeg', cached: true });
  }
  const existing = inflight.get(info.key);
  if (existing) return existing;
  const promise = new Promise((resolve) => {
    queue.push({
      id: seq,
      abs,
      width: info.outWidth,
      out: info.out,
      key: info.key,
      resolve,
    });
    seq += 1;
    pump();
  });
  inflight.set(info.key, promise);
  promise.finally(() => {
    if (inflight.get(info.key) === promise) inflight.delete(info.key);
  });
  return promise;
}

module.exports = { getThumbAsync, THUMB_DIR };