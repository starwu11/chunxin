'use strict';
// 8080 协议分流网关：SSH 握手(SSH- 前缀) → 127.0.0.1:8022；其他(HTTP/WebDAV) → 127.0.0.1:8081
// 同时负责拉起并守护网盘子进程（server.js），崩溃自动重启
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

const LISTEN_PORT = Number(process.env.MUX_PORT || 8080);
const HTTP_PORT = Number(process.env.MUX_HTTP_PORT || 8081);
const SSH_PORT = Number(process.env.MUX_SSH_PORT || 8022);
const APP_DIR = path.join(__dirname, 'app');

// ---- 守护网盘子进程 ----
let child = null;
function startServer() {
  child = spawn(process.execPath,
    ['--no-warnings', '--experimental-sqlite', 'server.js'],
    { cwd: APP_DIR, env: process.env, stdio: 'inherit' });
  child.on('exit', (code, sig) => {
    console.log(`[mux] server exited code=${code} sig=${sig}, restart in 3s`);
    setTimeout(startServer, 3000);
  });
}
startServer();

// ---- 协议分流 ----
const server = net.createServer((client) => {
  let decided = false;
  const timer = setTimeout(() => {
    if (!decided) { decided = true; client.destroy(); }
  }, 8000);
  client.once('data', (chunk) => {
    if (decided) return;
    decided = true;
    clearTimeout(timer);
    client.pause();
    const isSSH = chunk.subarray(0, 4).toString('latin1') === 'SSH-';
    const upstream = net.connect(isSSH ? SSH_PORT : HTTP_PORT, '127.0.0.1');
    upstream.on('connect', () => {
      upstream.write(chunk);
      client.resume();
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on('error', (err) => { console.error(`[mux] upstream ${isSSH ? 'ssh' : 'http'} error:`, err.code); client.destroy(); });
    client.on('error', () => { try { upstream.destroy(); } catch {} });
  });
  client.on('error', () => {});
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[mux] listening ${LISTEN_PORT} -> http:${HTTP_PORT} / ssh:${SSH_PORT}`);
});

process.on('uncaughtException', (err) => {
  console.error('[mux] uncaught:', err.message);
});
