#!/usr/bin/env node
'use strict';

const auth = require('../src/auth');

const [, , username, password] = process.argv;

if (!username || !password) {
  console.error('用法: node scripts/create-user.js <用户名> <密码>');
  console.error('示例: sudo -u clouddisk env DATA_DIR=/var/lib/clouddisk node /opt/clouddisk/scripts/create-user.js admin 你的密码');
  process.exit(1);
}

const invalid = auth.validateCredentials(username, password);
if (invalid) {
  console.error('参数不合法：' + invalid);
  process.exit(1);
}

const existing = auth.findUserByName(username);
if (existing) {
  console.error(`用户「${username}」已存在`);
  process.exit(1);
}

const id = auth.createUser(username, password);
console.log(`用户创建成功：${username} (id=${id})`);