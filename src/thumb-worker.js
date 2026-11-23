const { parentPort } = require('worker_threads');
const { encodeThumb } = require('./thumb-codec');

parentPort.on('message', (msg) => {
  try {
    const result = encodeThumb(msg.abs, msg.width, msg.out);
    parentPort.postMessage({ id: msg.id, ok: true, ...result });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: err.message });
  }
});