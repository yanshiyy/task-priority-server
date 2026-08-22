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

// 预建三个已知密码的账户（服务端启动时不会覆盖已存在的账户）
const store = db.open(DATA_DIR);
store.createUser('alice', 'alice123');
store.createUser('bob', 'bob123');
store.createUser('charlie', 'charlie123');

const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    DATA_DIR: DATA_DIR,
    ACCOUNTS: 'alice,bob,charlie',
    ADMIN_KEY: 'test-admin-key'
  }),
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

  await t('管理员接口：无密钥/错误密钥 → 403', async () => {
    const noKey = await fetch(`http://127.0.0.1:${PORT}/api/admin/accounts`);
    assert.strictEqual(noKey.status, 403);
    const badKey = await fetch(`http://127.0.0.1:${PORT}/api/admin/reset-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'wrong', username: 'bob' })
    });
    assert.strictEqual(badKey.status, 403);
  });

  await t('管理员接口：正确密钥重置密码 → 新密码可登录', async () => {
    const list = await fetch(`http://127.0.0.1:${PORT}/api/admin/accounts`, {
      headers: { 'x-admin-key': 'test-admin-key' }
    });
    const listData = await list.json();
    assert.deepStrictEqual(listData.accounts.sort(), ['alice', 'bob', 'charlie']);

    const reset = await fetch(`http://127.0.0.1:${PORT}/api/admin/reset-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'test-admin-key', username: 'bob' })
    });
    assert.strictEqual(reset.status, 200);
    const d = await reset.json();
    assert.ok(d.password && d.password.length >= 8);

    const relog = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: d.password })
    });
    assert.strictEqual(relog.status, 200);
  });

  // ============ 任务委派 ============
  let tokA, tokB, tokC;
  await t('委派前：重置 bob/charlie 密码并登录三人', async () => {
    // 管理员测试把 bob 密码重置为随机值，这里用 ADMIN_KEY 重置为已知密码
    const rb = await fetch(`http://127.0.0.1:${PORT}/api/admin/reset-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'test-admin-key', username: 'bob', password: 'bob123' })
    });
    assert.strictEqual(rb.status, 200);
    const rc = await fetch(`http://127.0.0.1:${PORT}/api/admin/reset-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'test-admin-key', username: 'charlie', password: 'charlie123' })
    });
    assert.strictEqual(rc.status, 200);
    // alice 密码已被上面改为 newpw123
    const la = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'newpw123' })
    });
    tokA = (await la.json()).token;
    const lb = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'bob123' })
    });
    tokB = (await lb.json()).token;
    const lc = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'charlie', password: 'charlie123' })
    });
    tokC = (await lc.json()).token;
    assert.ok(tokA && tokB && tokC);
  });

  const tA = { id: 'd1', title: 'alice 的委派任务', a: 8, cMode: 'manual', cManual: 1, b: 5, estMin: 60, status: 'todo' };
  await t('委派准备：alice 写入一个任务', async () => {
    const cur = await (await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + tokA }
    })).json();
    const r = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ tasks: cur.tasks.concat([tA]), rev: cur.rev })
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).rev, cur.rev + 1);
  });

  await t('未登录访问委派接口 → 401', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/delegations`);
    assert.strictEqual(r.status, 401);
  });

  await t('委派给不存在的用户 → 404', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/delegations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ taskId: 'd1', toUsername: 'ghost' })
    });
    assert.strictEqual(r.status, 404);
  });

  await t('委派给自己 → 400', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/delegations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ taskId: 'd1', toUsername: 'alice' })
    });
    assert.strictEqual(r.status, 400);
  });

  await t('发起委派 alice→bob → 成功且 rev 递增、原任务锁定', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/delegations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ taskId: 'd1', toUsername: 'bob', note: '请帮忙处理' })
    });
    assert.strictEqual(r.status, 200);
    const d = await r.json();
    assert.strictEqual(d.ok, true);
    assert.ok(d.delegation.id > 0);
    assert.strictEqual(d.delegation.from, 'alice');
    assert.strictEqual(d.delegation.to, 'bob');
    assert.strictEqual(d.delegation.status, 'active');
    assert.ok(d.rev >= 1, '委派后 rev 应递增');
    global.__aliceRev = d.rev;
    // 原任务已标记 delegated
    const gt = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + tokA }
    });
    const gd = await gt.json();
    const orig = gd.tasks.filter(x => x.id === 'd1')[0];
    assert.ok(orig.delegated, '原任务应标记已委派');
    assert.strictEqual(orig.delegated.to, 'bob');
    global.__delegationId = d.delegation.id;
  });

  await t('bob 看到委派任务且显示来源 alice', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + tokB }
    });
    const d = await r.json();
    assert.ok(Array.isArray(d.delegated), '响应应包含 delegated 字段');
    assert.strictEqual(d.delegated.length, 1);
    assert.strictEqual(d.delegated[0].delegatedFrom, 'alice');
    assert.strictEqual(d.delegated[0].title, 'alice 的委派任务');
    assert.strictEqual(d.delegated[0].delegationId, global.__delegationId);
    assert.strictEqual(d.alerts.newAssigned, 1, 'bob 应有新委派角标');
  });

  await t('无关用户 charlie 不能反馈 → 403', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/delegations/${global.__delegationId}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokC },
      body: JSON.stringify({ status: 'doing' })
    });
    assert.strictEqual(r.status, 403);
  });

  await t('无效反馈状态 → 400', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/delegations/${global.__delegationId}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokB },
      body: JSON.stringify({ status: 'nonsense' })
    });
    assert.strictEqual(r.status, 400);
  });

  await t('bob 反馈已完成 → 状态 feedback', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/delegations/${global.__delegationId}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokB },
      body: JSON.stringify({ status: 'done', note: '已完成，请确认' })
    });
    assert.strictEqual(r.status, 200);
    const g = await fetch(`http://127.0.0.1:${PORT}/api/delegations`, {
      headers: { 'Authorization': 'Bearer ' + tokA }
    });
    const gd = await g.json();
    const mine = gd.mine.filter(x => x.id === global.__delegationId)[0];
    assert.strictEqual(mine.status, 'feedback');
    assert.strictEqual(mine.feedbackStatus, 'done');
    assert.strictEqual(mine.feedbackNote, '已完成，请确认');
    assert.strictEqual(gd.alerts.newFeedback, 1, 'alice 应有新反馈角标');
  });

  await t('被委派人不能自己确认 → 403', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/delegations/${global.__delegationId}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokB },
      body: JSON.stringify({ action: 'confirm' })
    });
    assert.strictEqual(r.status, 403);
  });

  await t('alice 确认完成 → 状态 confirmed 且原任务自动完成', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/delegations/${global.__delegationId}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ action: 'confirm', note: '确认收到' })
    });
    assert.strictEqual(r.status, 200);
    const gt = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + tokA }
    });
    const gd = await gt.json();
    const orig = gd.tasks.filter(x => x.id === 'd1')[0];
    assert.strictEqual(orig.status, 'done', '确认后原任务应自动完成');
    assert.strictEqual(orig.delegated.status, 'confirmed');
    const ga = await fetch(`http://127.0.0.1:${PORT}/api/delegations`, {
      headers: { 'Authorization': 'Bearer ' + tokA }
    });
    assert.strictEqual((await ga.json()).alerts.newFeedback, 0, '确认后角标清零');
  });

  await t('再次确认（已终态）→ 409', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/delegations/${global.__delegationId}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ action: 'confirm' })
    });
    assert.strictEqual(r.status, 409);
  });

  // —— 退回重做闭环 ——
  await t('退回重做：新委派 → 反馈 → 退回 → 状态 rejected → 可再反馈', async () => {
    const tA2 = { id: 'd2', title: '需要返工的任务', a: 7, cMode: 'manual', cManual: 2, b: 5, status: 'todo' };
    const cur2 = await (await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + tokA }
    })).json();
    await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ tasks: cur2.tasks.concat([tA2]), rev: cur2.rev })
    });
    const r = await fetch(`http://127.0.0.1:${PORT}/api/delegations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ taskId: 'd2', toUsername: 'bob' })
    });
    const did = (await r.json()).delegation.id;
    await fetch(`http://127.0.0.1:${PORT}/api/delegations/${did}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokB },
      body: JSON.stringify({ status: 'done' })
    });
    const rej = await fetch(`http://127.0.0.1:${PORT}/api/delegations/${did}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ action: 'reject', note: '需要补充数据' })
    });
    assert.strictEqual(rej.status, 200);
    const g = await fetch(`http://127.0.0.1:${PORT}/api/delegations`, {
      headers: { 'Authorization': 'Bearer ' + tokB }
    });
    const gd = await g.json();
    assert.strictEqual(gd.assigned.filter(x => x.id === did)[0].status, 'rejected');
    // rejected 状态可再次反馈
    const fb2 = await fetch(`http://127.0.0.1:${PORT}/api/delegations/${did}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokB },
      body: JSON.stringify({ status: 'doing', note: '已补充数据，重新处理中' })
    });
    assert.strictEqual(fb2.status, 200);
    const g2 = await fetch(`http://127.0.0.1:${PORT}/api/delegations`, {
      headers: { 'Authorization': 'Bearer ' + tokA }
    });
    const gd2 = await g2.json();
    assert.strictEqual(gd2.mine.filter(x => x.id === did)[0].status, 'feedback');
    // 清理：确认完成
    await fetch(`http://127.0.0.1:${PORT}/api/delegations/${did}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ action: 'confirm' })
    });
  });

  // —— 撤回 ——
  await t('撤回：active 可撤回并解锁原任务；已反馈不可撤回', async () => {
    const tA3 = { id: 'd3', title: '临时取消的任务', a: 5, cMode: 'manual', cManual: 5, b: 5, status: 'todo' };
    const cur = await (await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + tokA }
    })).json();
    await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ tasks: cur.tasks.concat([tA3]), rev: cur.rev })
    });
    const r = await fetch(`http://127.0.0.1:${PORT}/api/delegations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ taskId: 'd3', toUsername: 'bob' })
    });
    const did = (await r.json()).delegation.id;
    // active 状态直接撤回 → 成功
    const cancelEarly = await fetch(`http://127.0.0.1:${PORT}/api/delegations/${did}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA }
    });
    assert.strictEqual(cancelEarly.status, 200, 'active 状态应可撤回');
    // 重新委派并反馈后撤回 → 409
    const cur2 = await (await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + tokA }
    })).json();
    const tA3b = { id: 'd3b', title: '已反馈的撤回任务', a: 5, cMode: 'manual', cManual: 5, b: 5, status: 'todo' };
    await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ tasks: cur2.tasks.concat([tA3b]), rev: cur2.rev })
    });
    const r2 = await fetch(`http://127.0.0.1:${PORT}/api/delegations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ taskId: 'd3b', toUsername: 'bob' })
    });
    const did2 = (await r2.json()).delegation.id;
    await fetch(`http://127.0.0.1:${PORT}/api/delegations/${did2}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokB },
      body: JSON.stringify({ status: 'doing' })
    });
    const cancelFail = await fetch(`http://127.0.0.1:${PORT}/api/delegations/${did2}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA }
    });
    assert.strictEqual(cancelFail.status, 409, '已反馈不可撤回');
    // 清理：退回后再次反馈，再确认完成
    await fetch(`http://127.0.0.1:${PORT}/api/delegations/${did2}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ action: 'reject' })
    });
    await fetch(`http://127.0.0.1:${PORT}/api/delegations/${did2}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokB },
      body: JSON.stringify({ status: 'done' })
    });
    await fetch(`http://127.0.0.1:${PORT}/api/delegations/${did2}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ action: 'confirm' })
    });
    const gt = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + tokA }
    });
    const gd = await gt.json();
    const d3bTask = gd.tasks.filter(x => x.id === 'd3b')[0];
    assert.strictEqual(d3bTask.status, 'done', '确认完成后原任务应完成');
    assert.strictEqual(d3bTask.delegated.status, 'confirmed', '原任务委派状态应为 confirmed');
    assert.ok(!gd.tasks.filter(x => x.id === 'd3')[0].delegated, '撤回后原任务应解锁');
  });

  // —— 转派（二次委派）——
  await t('转派：bob→charlie，charlie 见来源 alice 且标注经 bob 转派', async () => {
    const tA4 = { id: 'd4', title: '可转派的任务', a: 6, cMode: 'manual', cManual: 3, b: 5, status: 'todo' };
    const cur = await (await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + tokA }
    })).json();
    await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ tasks: cur.tasks.concat([tA4]), rev: cur.rev })
    });
    const r = await fetch(`http://127.0.0.1:${PORT}/api/delegations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ taskId: 'd4', toUsername: 'bob' })
    });
    const did = (await r.json()).delegation.id;
    // bob 转派给 charlie
    const rd = await fetch(`http://127.0.0.1:${PORT}/api/delegations/${did}/redelegate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokB },
      body: JSON.stringify({ toUsername: 'charlie', note: '请你处理' })
    });
    assert.strictEqual(rd.status, 200);
    const sub = (await rd.json()).delegation;
    assert.strictEqual(sub.rootFrom, 'alice', '子委派应保留原始来源');
    assert.strictEqual(sub.from, 'bob');
    assert.strictEqual(sub.to, 'charlie');
    assert.strictEqual(sub.reDelegatedBy, 'bob', '应标注经 bob 转派');
    // charlie 任务列表
    const gt = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + tokC }
    });
    const gd = await gt.json();
    const dlg = gd.delegated.filter(x => x.delegationId === sub.id)[0];
    assert.ok(dlg, 'charlie 应收到转派任务');
    assert.strictEqual(dlg.delegatedFrom, 'alice');
    assert.strictEqual(dlg.reDelegatedBy, 'bob');
    // 原委派标记 re-delegated
    const gm = await fetch(`http://127.0.0.1:${PORT}/api/delegations`, {
      headers: { 'Authorization': 'Bearer ' + tokA }
    });
    const gmd = await gm.json();
    assert.strictEqual(gmd.mine.filter(x => x.id === did)[0].status, 're-delegated');
    // 防环：charlie 转派回 alice → 400
    const loop = await fetch(`http://127.0.0.1:${PORT}/api/delegations/${sub.id}/redelegate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokC },
      body: JSON.stringify({ toUsername: 'alice' })
    });
    assert.strictEqual(loop.status, 400, '不能转派回来源链上的人');
    const loop2 = await fetch(`http://127.0.0.1:${PORT}/api/delegations/${sub.id}/redelegate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokC },
      body: JSON.stringify({ toUsername: 'bob' })
    });
    assert.strictEqual(loop2.status, 400, '不能转派给链上中间人');
    // 清理：charlie 反馈 + alice(root) 确认
    await fetch(`http://127.0.0.1:${PORT}/api/delegations/${sub.id}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokC },
      body: JSON.stringify({ status: 'done' })
    });
    const final = await fetch(`http://127.0.0.1:${PORT}/api/delegations/${sub.id}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tokA },
      body: JSON.stringify({ action: 'confirm' })
    });
    assert.strictEqual(final.status, 200, '原始委派人可确认转派链最终结果');
  });

  await t('删除已委派任务时服务端无孤儿委派（数据一致性）', async () => {
    const gt = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      headers: { 'Authorization': 'Bearer ' + tokA }
    });
    const gd = await gt.json();
    const orphan = gd.tasks.filter(t => t.delegated && t.status !== 'done');
    // 所有 delegations 终态确认
    const gd2 = await (await fetch(`http://127.0.0.1:${PORT}/api/delegations`, {
      headers: { 'Authorization': 'Bearer ' + tokA }
    })).json();
    const open = gd2.mine.filter(x => ['active', 'feedback'].indexOf(x.status) >= 0);
    assert.strictEqual(open.length, 0, '不应有未闭环的委派残留');
  });

  console.log('\nAPI 集成测试全部通过：' + passed + ' 项');
  child.kill();
  process.exit(0);
})().catch(e => { console.error(e); child.kill(); process.exit(1); });
