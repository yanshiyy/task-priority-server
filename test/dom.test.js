'use strict';
// 多账户版前端 DOM 冒烟测试（jsdom + fetch 模拟后端）
// 运行：npm i jsdom && NODE_PATH=<jsdom路径> node test/dom.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const APP = path.resolve(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');

// —— 内存后端 ——
const users = { alice: 'alice123', bob: 'bob123' };
const tasks = { alice: { list: [], rev: 0 }, bob: { list: [], rev: 0 } };
const tokens = {}; // token -> username

function resp(ok, status, data) {
  return { ok: ok, status: status, json: () => Promise.resolve(data || {}), text: () => Promise.resolve(JSON.stringify(data || {})) };
}
function authUser(headers) {
  const h = headers && headers.Authorization || headers && headers.authorization || '';
  return h.indexOf('Bearer ') === 0 ? tokens[h.slice(7)] : null;
}
global.fetch = function (url, opts) {
  opts = opts || {};
  const p = url.replace('', '');
  if (p === '/api/login') {
    const b = JSON.parse(opts.body);
    if (users[b.username] && users[b.username] === b.password) {
      const t = 'tok-' + b.username + '-' + Math.random();
      tokens[t] = b.username;
      return Promise.resolve(resp(true, 200, { token: t, username: b.username }));
    }
    return Promise.resolve(resp(false, 401, { error: '用户名或密码错误' }));
  }
  if (p === '/api/me') {
    const u = authUser(opts.headers);
    return Promise.resolve(u ? resp(true, 200, { username: u }) : resp(false, 401, { error: '未登录' }));
  }
  if (p === '/api/tasks' && (opts.method || 'GET') === 'GET') {
    const u = authUser(opts.headers);
    if (!u) { return Promise.resolve(resp(false, 401, { error: '未登录' })); }
    return Promise.resolve(resp(true, 200, { username: u, tasks: tasks[u].list, rev: tasks[u].rev }));
  }
  if (p === '/api/tasks' && opts.method === 'PUT') {
    const u = authUser(opts.headers);
    if (!u) { return Promise.resolve(resp(false, 401, { error: '未登录' })); }
    const b = JSON.parse(opts.body);
    if (b.rev !== tasks[u].rev) { return Promise.resolve(resp(false, 409, { error: '冲突' })); }
    tasks[u].list = b.tasks;
    tasks[u].rev = tasks[u].rev + 1;
    return Promise.resolve(resp(true, 200, { rev: tasks[u].rev }));
  }
  if (p === '/api/logout') { return Promise.resolve(resp(true, 200, { ok: true })); }
  return Promise.resolve(resp(false, 404, { error: 'not found' }));
};

const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
const win = dom.window;
win.alert = function (m) { console.log('  [alert] ' + m); };
win.confirm = function () { return true; };
win.fetch = global.fetch;  // 页面上下文的 fetch 指向模拟后端
const doc = win.document;

win.eval(fs.readFileSync(path.join(APP, 'scoring.js'), 'utf8'));
win.eval('window.API_BASE = "";');
win.eval(fs.readFileSync(path.join(APP, 'app.js'), 'utf8'));

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

(async () => {
  await t('未登录：显示登录界面、隐藏应用', () => {
    assert.strictEqual(doc.querySelector('#login-view').hidden, false);
    assert.strictEqual(doc.querySelector('#app').hidden, true);
  });

  await t('登录 alice → 应用可见并加载其任务', async () => {
    doc.querySelector('#login-user').value = 'alice';
    doc.querySelector('#login-pass').value = 'alice123';
    doc.querySelector('#btn-login').click();
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(doc.querySelector('#app').hidden, false);
    assert.strictEqual(doc.querySelector('#user-tag').textContent.indexOf('alice') >= 0, true);
  });

  await t('添加任务 → 写入服务端（alice）', async () => {
    doc.querySelector('#btn-add').click();
    doc.querySelector('#f-title').value = '多账户测试任务';
    doc.querySelector('#f-a').value = '1';
    const btns = doc.querySelectorAll('#f-cmode button');
    btns.forEach(b => { if (b.dataset.cmode === 'manual') b.click(); });
    doc.querySelector('#f-cmanual').value = '1';
    doc.querySelector('#f-b').value = '10';
    doc.querySelector('#form-edit').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 600));  // 等待防抖保存
    assert.strictEqual(tasks.alice.list.length, 1);
    assert.strictEqual(tasks.alice.list[0].title, '多账户测试任务');
    assert.strictEqual(tasks.alice.rev, 1);
    assert.strictEqual(tasks.bob.list.length, 0, 'bob 数据不受影响');
  });

  await t('登出 → 回到登录界面', async () => {
    doc.querySelector('#btn-logout').click();
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(doc.querySelector('#login-view').hidden, false);
    assert.strictEqual(doc.querySelector('#app').hidden, true);
  });

  console.log('\n多账户版 DOM 冒烟测试全部通过：' + passed + ' 项');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
