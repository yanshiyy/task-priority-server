/* reset-password.js — 重置指定账户密码：node reset-password.js <用户名> */
'use strict';
var path = require('path');
var auth = require('./auth.js');
var db = require('./db.js');

var username = process.argv[2];
if (!username) {
  console.error('用法: node reset-password.js <用户名>');
  process.exit(1);
}
var DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
var store = db.open(DATA_DIR);
var u = store.getUser(username);
if (!u) {
  console.error('账户不存在: ' + username);
  process.exit(1);
}
var pw = auth.randomPassword(10);
store.setPassword(u.id, pw);
console.log('已重置账户 ' + username + ' 的密码为: ' + pw);
console.log('请将该密码分发给用户，并提醒其登录后修改。');
