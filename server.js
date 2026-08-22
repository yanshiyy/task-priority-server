/* server.js — 任务优先级决策器 · 多账户服务端
 * 零第三方依赖：Node 内置 http + node:sqlite + crypto。
 * 同时提供前端静态文件与 JSON API。
 */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');
var auth = require('./auth.js');
var db = require('./db.js');

var PORT = Number(process.env.PORT || 8788);
var DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
var ADMIN_KEY = process.env.ADMIN_KEY || '';   // 管理员密钥（环境变量配置；为空则管理接口禁用）
var ACCOUNTS = (process.env.ACCOUNTS || 'user1,user2,user3,user4,user5')
  .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
var PUBLIC_DIR = path.join(__dirname, 'public');

var TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8'
};

var store = db.open(DATA_DIR);
var sessions = auth.createSessionStore();

// ── 初始化 5 个账户（缺失才创建，并输出初始密码一次）──
var newCreds = [];
ACCOUNTS.forEach(function (name) {
  if (!store.getUser(name)) {
    var pw = auth.randomPassword(10);
    store.createUser(name, pw);
    newCreds.push({ username: name, password: pw });
  }
});

function serveStatic(req, res, urlPath) {
  if (urlPath === '/') { urlPath = '/index.html'; }
  var file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req, cb) {
  var chunks = [];
  var size = 0;
  req.on('data', function (c) {
    size += c.length;
    if (size > 2 * 1024 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () {
    try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch (e) { cb(null); }
  });
}

function authUser(req) {
  var h = req.headers['authorization'] || '';
  var token = h.indexOf('Bearer ') === 0 ? h.slice(7) : '';
  return token ? sessions.get(token) : null;
}

function send(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'
  });
  res.end(body);
}

var server = http.createServer(function (req, res) {
  var url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS' }); res.end(); return; }

  // ── API ──
  if ((url === '/api/health' || url === '/health') && req.method === 'GET') {
    send(res, 200, { ok: true, accounts: store.listUsers().length });
    return;
  }

  // 管理员接口（需 ADMIN_KEY 环境变量，否则 403）
  if (url === '/api/admin/accounts' && req.method === 'GET') {
    if (!ADMIN_KEY || (req.headers['x-admin-key'] || '') !== ADMIN_KEY) { send(res, 403, { error: '无权限' }); return; }
    send(res, 200, { accounts: store.listUsers().map(function (u) { return u.username; }) });
    return;
  }

  if (url === '/api/admin/reset-password' && req.method === 'POST') {
    readBody(req, function (body) {
      if (!ADMIN_KEY || !body || body.key !== ADMIN_KEY) { send(res, 403, { error: '无权限' }); return; }
      if (!body.username) { send(res, 400, { error: '缺少用户名' }); return; }
      var u = store.getUser(body.username);
      if (!u) { send(res, 404, { error: '账户不存在' }); return; }
      var pw = auth.randomPassword(10);
      store.setPassword(u.id, pw);
      sessions.removeUser(u.id);
      send(res, 200, { username: u.username, password: pw, message: '密码已重置，请安全分发' });
    });
    return;
  }

  if (url === '/api/login' && req.method === 'POST') {
    readBody(req, function (body) {
      if (!body || !body.username || !body.password) { send(res, 400, { error: '缺少用户名或密码' }); return; }
      var u = store.getUser(body.username);
      if (!u || !auth.verifyPassword(body.password, u.salt, u.hash)) {
        send(res, 401, { error: '用户名或密码错误' }); return;
      }
      var token = sessions.create(u.id, u.username);
      send(res, 200, { token: token, username: u.username });
    });
    return;
  }

  if (url === '/api/change-password' && req.method === 'POST') {
    var s = authUser(req);
    if (!s) { send(res, 401, { error: '未登录' }); return; }
    readBody(req, function (body) {
      if (!body || !body.oldPassword || !body.newPassword) { send(res, 400, { error: '参数不完整' }); return; }
      var u = store.getUserById(s.userId);
      if (!auth.verifyPassword(body.oldPassword, u.salt, u.hash)) { send(res, 400, { error: '原密码错误' }); return; }
      store.setPassword(u.id, body.newPassword);
      sessions.removeUser(u.id);
      send(res, 200, { ok: true, message: '密码已修改，请重新登录' });
    });
    return;
  }

  if (url === '/api/logout' && req.method === 'POST') {
    var s2 = authUser(req);
    if (s2) { sessions.remove(req.headers['authorization'].slice(7)); }
    send(res, 200, { ok: true });
    return;
  }

  if (url === '/api/me' && req.method === 'GET') {
    var s3 = authUser(req);
    send(res, s3 ? 200 : 401, s3 ? { username: s3.username } : { error: '未登录' });
    return;
  }

  if (url === '/api/tasks' && req.method === 'GET') {
    var s4 = authUser(req);
    if (!s4) { send(res, 401, { error: '未登录' }); return; }
    var data = store.getTasks(s4.userId);
    send(res, 200, { username: s4.username, tasks: data.tasks, rev: data.rev });
    return;
  }

  if (url === '/api/tasks' && req.method === 'PUT') {
    var s5 = authUser(req);
    if (!s5) { send(res, 401, { error: '未登录' }); return; }
    readBody(req, function (body) {
      if (!body || !Array.isArray(body.tasks)) { send(res, 400, { error: '任务数据格式错误' }); return; }
      var newRev = store.putTasks(s5.userId, body.tasks, body.rev == null ? 0 : body.rev);
      if (newRev === null) { send(res, 409, { error: '数据已在别处更新，请刷新后重试' }); return; }
      send(res, 200, { rev: newRev });
    });
    return;
  }

  // ── 静态前端 ──
  serveStatic(req, res, url);
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('任务优先级决策器 · 多账户服务端已启动');
  console.log('  本机:  http://localhost:' + PORT);
  console.log('  账户数: ' + ACCOUNTS.length + '（环境变量 ACCOUNTS 可改名，逗号分隔）');
  console.log('');
  if (newCreds.length > 0) {
    console.log('首次创建账户与初始密码（请妥善保存，可登录后修改）:');
    newCreds.forEach(function (c) {
      console.log('  ' + c.username + '  /  ' + c.password);
    });
    var credsFile = path.join(DATA_DIR, '初始密码.txt');
    fs.writeFileSync(credsFile,
      '账户初始密码（首次启动生成，可登录后在页面内修改）\n' +
      newCreds.map(function (c) { return c.username + '  ' + c.password; }).join('\n') + '\n');
    try { fs.chmodSync(credsFile, 0o600); } catch (e) {}
    console.log('');
    console.log('  已写入: ' + credsFile);
  }
});
