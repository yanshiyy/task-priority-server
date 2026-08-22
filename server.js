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

function usernameOf(userId) {
  var u = store.getUserById(userId);
  return u ? u.username : String(userId);
}

/** 委派详情序列化（附带对方用户名） */
function serializeDelegation(d, viewerUserId) {
  return {
    id: d.id,
    from: usernameOf(d.fromUserId),
    to: usernameOf(d.toUserId),
    rootFrom: usernameOf(d.rootUserId),
    fromUserId: d.fromUserId,
    toUserId: d.toUserId,
    sourceTitle: d.sourceTitle,
    note: d.note,
    taskSnapshot: d.taskSnapshot,
    status: d.status,
    feedbackStatus: d.feedbackStatus,
    feedbackNote: d.feedbackNote,
    feedbackAt: d.feedbackAt,
    confirmAction: d.confirmAction,
    confirmNote: d.confirmNote,
    confirmedAt: d.confirmedAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    isMine: d.fromUserId === viewerUserId,
    isAssigned: d.toUserId === viewerUserId,
    reDelegatedBy: d.parentId ? usernameOf(d.fromUserId) : null
  };
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
      var pw = body.password && String(body.password).length >= 6 ? String(body.password) : auth.randomPassword(10);
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
    // 委派给我的任务（合成任务对象，用于前端展示与反馈入口）
    var assigned = store.listAssigned(s4.userId).filter(function (d) {
      return d.status === 'active' || d.status === 'rejected';
    }).map(function (d) {
      var snap = d.taskSnapshot || {};
      return {
        id: 'deleg-' + d.id + '-' + (snap.id || d.id),
        delegationId: d.id,
        delegatedFrom: usernameOf(d.rootUserId),
        delegatedBy: usernameOf(d.fromUserId),
        reDelegatedBy: d.parentId ? usernameOf(d.fromUserId) : null,
        title: d.sourceTitle || snap.title || '',
        a: snap.a != null ? snap.a : 5,
        b: snap.b != null ? snap.b : 5,
        cMode: snap.cMode || 'manual',
        due: snap.due || null,
        cManual: snap.cManual != null ? snap.cManual : 10,
        estMin: snap.estMin || 0,
        status: 'todo',
        assignee: '',
        note: d.note || '',
        delegatedNote: d.note || '',
        createdAt: d.createdAt,
        doneAt: null,
        isDelegated: true
      };
    });
    send(res, 200, {
      username: s4.username,
      tasks: data.tasks,
      rev: data.rev,
      delegated: assigned,
      alerts: store.alertsFor(s4.userId)
    });
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

  // ── 任务委派 ──
  // 账户列表（登录用户可用，供委派选择接收人；不含自己）
  if (url === '/api/users' && req.method === 'GET') {
    var su = authUser(req);
    if (!su) { send(res, 401, { error: '未登录' }); return; }
    var others = store.listUsers()
      .filter(function (u) { return u.id !== su.userId; })
      .map(function (u) { return u.username; });
    send(res, 200, { users: others });
    return;
  }

  // GET /api/delegations 我发起的 + 委派给我的 + 角标
  if (url === '/api/delegations' && req.method === 'GET') {
    var sd = authUser(req);
    if (!sd) { send(res, 401, { error: '未登录' }); return; }
    var mine = store.listMine(sd.userId).map(function (d) { return serializeDelegation(d, sd.userId); });
    var assigned = store.listAssigned(sd.userId).map(function (d) { return serializeDelegation(d, sd.userId); });
    send(res, 200, { mine: mine, assigned: assigned, alerts: store.alertsFor(sd.userId) });
    return;
  }

  // POST /api/delegations 发起委派 { taskId, toUsername, note }
  if (url === '/api/delegations' && req.method === 'POST') {
    var sp = authUser(req);
    if (!sp) { send(res, 401, { error: '未登录' }); return; }
    readBody(req, function (body) {
      if (!body || !body.taskId || !body.toUsername) { send(res, 400, { error: '缺少任务或接收人' }); return; }
      var to = store.getUser(body.toUsername);
      if (!to) { send(res, 404, { error: '接收人不存在' }); return; }
      if (to.id === sp.userId) { send(res, 400, { error: '不能委派给自己' }); return; }
      var mine2 = store.getTasks(sp.userId);
      var task = null;
      mine2.tasks.forEach(function (t) { if (t.id === body.taskId) { task = t; } });
      if (!task) { send(res, 404, { error: '任务不存在' }); return; }
      if (task.status === 'done' || task.status === 'blocked' || task.delegated) {
        send(res, 400, { error: '该任务当前状态不可委派' }); return;
      }
      // 创建委派记录（快照）
      var del = store.createDelegation({
        fromUserId: sp.userId,
        toUserId: to.id,
        taskSnapshot: JSON.parse(JSON.stringify(task)),
        sourceTitle: task.title,
        note: (body.note || '').slice(0, 200)
      });
      // 原任务标记"已委派"（rev 校验防并发）
      var newTasks = mine2.tasks.map(function (t) {
        if (t.id !== task.id) { return t; }
        return Object.assign({}, t, { delegated: { delegationId: del.id, to: to.username, status: 'active' } });
      });
      var newRev = store.putTasks(sp.userId, newTasks, body.rev == null ? mine2.rev : body.rev);
      if (newRev === null) { store.deleteDelegation(del.id); send(res, 409, { error: '数据已在别处更新，请刷新后重试' }); return; }
      send(res, 200, { ok: true, rev: newRev, delegation: serializeDelegation(del, sp.userId) });
    });
    return;
  }

  // 委派单条操作：feedback / confirm / redelegate / cancel
  var dm = /^\/api\/delegations\/(\d+)\/(feedback|confirm|redelegate|cancel)$/.exec(url);
  if (dm) {
    var so = authUser(req);
    if (!so) { send(res, 401, { error: '未登录' }); return; }
    var delegationId = Number(dm[1]);
    var action = dm[2];
    var dlg = store.getDelegation(delegationId);
    if (!dlg) { send(res, 404, { error: '委派记录不存在' }); return; }

    // 反馈：仅被委派人，状态 active/rejected → feedback
    if (action === 'feedback') {
      if (dlg.toUserId !== so.userId) { send(res, 403, { error: '仅被委派人可反馈' }); return; }
      readBody(req, function (body) {
        var fst = body && body.status;
        if (['doing', 'blocked', 'done'].indexOf(fst) < 0) { send(res, 400, { error: '反馈状态无效' }); return; }
        var ok = store.applyFeedback(delegationId, fst, (body.note || '').slice(0, 200));
        if (!ok) { send(res, 409, { error: '当前状态不允许反馈（可能已确认/撤回）' }); return; }
        send(res, 200, { ok: true });
      });
      return;
    }

    // 确认/退回：仅委派人（from 或 root 链上），状态 feedback → confirmed/rejected
    if (action === 'confirm') {
      if (dlg.fromUserId !== so.userId && dlg.rootUserId !== so.userId) { send(res, 403, { error: '仅委派人可确认' }); return; }
      readBody(req, function (body) {
        var act = body && body.action;
        if (act !== 'confirm' && act !== 'reject') { send(res, 400, { error: '确认动作无效' }); return; }
        var ok = store.transition(delegationId, 'feedback',
          act === 'confirm' ? 'confirmed' : 'rejected',
          { confirm_action: act, confirm_note: (body.note || '').slice(0, 200), confirmed_at: Date.now() });
        if (!ok) { send(res, 409, { error: '当前状态不允许确认（可能已处理）' }); return; }
        // 确认完成 → 委派人原任务自动完成
        if (act === 'confirm') {
          var owner = dlg.fromUserId;
          var mine3 = store.getTasks(owner);
          var ownerTasks = mine3.tasks.map(function (t) {
            if (t.delegated && t.delegated.delegationId === delegationId) {
              return Object.assign({}, t, {
                status: 'done', doneAt: Date.now(),
                delegated: Object.assign({}, t.delegated, { status: 'confirmed' })
              });
            }
            return t;
          });
          store.putTasks(owner, ownerTasks, mine3.rev); // 服务端权威写入（忽略 rev 冲突由状态机兜底）
        }
        send(res, 200, { ok: true });
      });
      return;
    }

    // 转派：仅被委派人，active/rejected → re-delegated，并新建下级委派
    if (action === 'redelegate') {
      if (dlg.toUserId !== so.userId) { send(res, 403, { error: '仅被委派人可转派' }); return; }
      readBody(req, function (body) {
        var toUsername = body && body.toUsername;
        var to2 = toUsername ? store.getUser(toUsername) : null;
        if (!to2) { send(res, 404, { error: '接收人不存在' }); return; }
        if (to2.id === so.userId) { send(res, 400, { error: '不能转派给自己' }); return; }
        // 防环：目标不能是来源链上已有的人
        var chain = {};
        chain[dlg.rootUserId] = true;
        var cursor = dlg;
        while (cursor && cursor.parentId) {
          chain[cursor.fromUserId] = true;
          cursor = store.getDelegation(cursor.parentId);
        }
        if (chain[to2.id]) { send(res, 400, { error: '不能转派回来源链上的人（防成环）' }); return; }
        var ok = store.markReDelegated(delegationId);
        if (!ok) { send(res, 409, { error: '当前状态不允许转派' }); return; }
        var snap = JSON.parse(JSON.stringify(dlg.taskSnapshot || { title: dlg.sourceTitle }));
        var sub = store.createDelegation({
          fromUserId: so.userId,
          toUserId: to2.id,
          rootUserId: dlg.rootUserId,
          parentId: delegationId,
          taskSnapshot: snap,
          sourceTitle: dlg.sourceTitle,
          note: ((body.note || '') || dlg.note).slice(0, 200)
        });
        send(res, 200, { ok: true, delegation: serializeDelegation(sub, so.userId) });
      });
      return;
    }

    // 撤回：仅委派人，active → cancelled
    if (action === 'cancel') {
      if (dlg.fromUserId !== so.userId && dlg.rootUserId !== so.userId) { send(res, 403, { error: '仅委派人可撤回' }); return; }
      var okc = store.cancelDelegation(delegationId);
      if (!okc) { send(res, 409, { error: '当前状态不允许撤回（对方可能已反馈）' }); return; }
      // 解锁原任务
      var owner2 = dlg.fromUserId;
      var mine4 = store.getTasks(owner2);
      var unlocked = mine4.tasks.map(function (t) {
        if (t.delegated && t.delegated.delegationId === delegationId) {
          var c = Object.assign({}, t);
          delete c.delegated;
          return c;
        }
        return t;
      });
      store.putTasks(owner2, unlocked, mine4.rev);
      send(res, 200, { ok: true });
      return;
    }
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
