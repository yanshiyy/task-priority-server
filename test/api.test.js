'use strict';
// 多账户服务端 API 集成测试（node test/api.test.js）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const db = require(path.join(ROOT, 'db.js'));

const PORT = 8799;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-server-'));

// 预建两个已知密码的账户（服务端启动时不会覆盖已存在的账户）
const store = db.open(DATA_DIR);
store.createUser('alice', 'alice123');
store.createUser('bob', 'bob123');

const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: DATA_DIR, ACCOUNTS: 'alice,bob' }),
  stdio: ['ignore', 'pipe', 'pipe']
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/me`);
      if (r.status === 401 || r.status === 200) { return; }
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('server did not start');
}

let passed = 0;
function t(name, fn) { return fn().then(() => { passed++; console.log('  ✓ ' + name); }); }

(async () => {
  await waitReady();

  await t('静态首页可访问', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/`);
    assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).indexOf('登录') >= 0);
  });

  await t('未登录访问任务 → 401', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/tasks`);
    assert.strictEqual(r.status, 401);
  });

  await t('错误密码登录 → 401', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'wrong' })
    });
    assert.strictEqual(r.status, 401);
  });

  let aliceToken;
  await t('alice 正确登录 → 200 + token', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'alice123' })
    });
    assert.strictEqual(r.status, 200);
    const d = await r.json();
    assert.ok(d.token);
    assert.strictEqual(d.username, 'alice');
    aliceToken = d.token;
  });

  await t('alice 初始任务为空 rev=0', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + aliceToken }
    });
    const d = await r.json();
    assert.deepStrictEqual(d.tasks, []);
    assert.strictEqual(d.rev, 0);
  });

  const taskA = { id: 'a1', title: 'alice 的任务', a: 8, cMode: 'manual', cManual: 1, b: 5, status: 'todo' };
  await t('alice 写入任务 → rev=1', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + aliceToken },
      body: JSON.stringify({ tasks: [taskA], rev: 0 })
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).rev, 1);
  });

  await t('alice 回读任务一致', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + aliceToken }
    });
    const d = await r.json();
    assert.strictEqual(d.tasks.length, 1);
    assert.strictEqual(d.tasks[0].title, 'alice 的任务');
    assert.strictEqual(d.rev, 1);
  });

  await t('乐观锁：用过期 rev 写入 → 409', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + aliceToken },
      body: JSON.stringify({ tasks: [taskA], rev: 0 })
    });
    assert.strictEqual(r.status, 409);
  });

  let bobToken;
  await t('bob 登录 → 数据与 alice 完全隔离', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'bob123' })
    });
    const d = await r.json();
    bobToken = d.token;
    const r2 = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + bobToken }
    });
    const d2 = await r2.json();
    assert.deepStrictEqual(d2.tasks, [], 'bob 应看到自己的空列表，而非 alice 的任务');
    assert.strictEqual(d2.rev, 0);
  });

  await t('修改密码：旧密码错 → 400；正确 → 200 并可重登', async () => {
    const bad = await fetch(`http://127.0.0.1:${PORT}/api/change-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + aliceToken },
      body: JSON.stringify({ oldPassword: 'nope', newPassword: 'newpw123' })
    });
    assert.strictEqual(bad.status, 400);

    const ok = await fetch(`http://127.0.0.1:${PORT}/api/change-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + aliceToken },
      body: JSON.stringify({ oldPassword: 'alice123', newPassword: 'newpw123' })
    });
    assert.strictEqual(ok.status, 200);

    const relog = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'newpw123' })
    });
    assert.strictEqual(relog.status, 200);
  });

  await t('退出登录后 token 失效', async () => {
    await fetch(`http://127.0.0.1:${PORT}/api/logout`, {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + aliceToken }
    });
    const r = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + aliceToken }
    });
    assert.strictEqual(r.status, 401);
  });

  console.log('\nAPI 集成测试全部通过：' + passed + ' 项');
  child.kill();
  process.exit(0);
})().catch(e => { console.error(e); child.kill(); process.exit(1); });
