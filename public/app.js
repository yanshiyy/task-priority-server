/* app.js — 任务优先级决策器（多账户版）：登录鉴权 + 服务端同步 + 渲染交互 */
(function () {
  'use strict';
  var M = window.PriorityModel;
  var API_BASE = (window.API_BASE || '');
  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  var LS_SETTINGS = 'priority-app.settings.v1';
  var LS_TOKEN = 'priority-app.token.v1';

  var state = {
    tasks: [],
    settings: M.mergeSettings({}),
    filter: 'all',        // all | today | week | schedule | drop | done | blocked
    editingId: null,
    username: '',
    rev: 0,
    saveTimer: null
  };

  function token() {
    try { return localStorage.getItem(LS_TOKEN) || ''; } catch (e) { return ''; }
  }
  function setToken(t) {
    try { t ? localStorage.setItem(LS_TOKEN, t) : localStorage.removeItem(LS_TOKEN); } catch (e) {}
  }

  function api(method, path, body) {
    return fetch(API_BASE + path, {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token()
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        return { ok: resp.ok, status: resp.status, data: data };
      });
    });
  }

  /* ---------- 存储（服务端同步） ---------- */
  function loadSettings() {
    try {
      var s = localStorage.getItem(LS_SETTINGS);
      if (s) { state.settings = M.mergeSettings(JSON.parse(s)); }
    } catch (e) { /* 忽略 */ }
  }
  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); } catch (e) {}
  }
  function save() {
    // 防抖：合并短时间内多次改动为一次 PUT
    if (state.saveTimer) { clearTimeout(state.saveTimer); }
    state.saveTimer = setTimeout(function () {
      api('PUT', '/api/tasks', { tasks: state.tasks, rev: state.rev }).then(function (r) {
        if (r.ok) {
          state.rev = r.data.rev;
        } else if (r.status === 409) {
          alert('数据已在其他设备更新，已为你重新加载最新内容。');
          fetchTasks();
        }
      });
    }, 400);
  }
  function fetchTasks() {
    return api('GET', '/api/tasks').then(function (r) {
      if (!r.ok) { return; }
      state.tasks = Array.isArray(r.data.tasks) ? r.data.tasks : [];
      state.rev = r.data.rev || 0;
      state.username = r.data.username || state.username;
      $('#user-tag').textContent = state.username ? ('👤 ' + state.username) : '';
      render();
    });
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function iso(daysOffset) {
    var d = new Date();
    d.setDate(d.getDate() + daysOffset);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /* ---------- 派生 ---------- */
  function evaluated() {
    return M.rankTasks(state.tasks.filter(function (t) {
      return t.status === 'todo' || t.status === 'doing';
    }), state.settings);
  }
  function blockedList() {
    return state.tasks.filter(function (t) { return t.status === 'blocked'; })
      .map(function (t) { return M.evaluate(t, state.settings); })
      .sort(M.compareTasks);
  }
  function doneList() {
    return state.tasks.filter(function (t) { return t.status === 'done'; })
      .map(function (t) { return M.evaluate(t, state.settings); })
      .sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); });
  }
  function byId(id) {
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === id) { return state.tasks[i]; }
    }
    return null;
  }

  /* ---------- 渲染 ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text != null) { n.textContent = text; }
    return n;
  }

  function renderStats(active) {
    var today = active.filter(function (t) { return t.decision === 'today'; });
    var week = active.filter(function (t) { return t.decision === 'week'; });
    var loadMin = today.reduce(function (s, t) { return s + (t.estMin || 0); }, 0);
    $('#stats').hidden = !active.length;
    $('#st-total').textContent = active.length;
    $('#st-today').textContent = today.length;
    $('#st-week').textContent = week.length;
    $('#st-load').textContent = loadMin > 0 ? M.fmtDuration(loadMin) : '0';
  }

  var FILTERS = [
    { key: 'all',      label: '全部' },
    { key: 'today',    label: '今天必做' },
    { key: 'week',     label: '本周安排' },
    { key: 'schedule', label: '排期/委托' },
    { key: 'drop',     label: '不做/删除' },
    { key: 'blocked',  label: '已阻塞' },
    { key: 'done',     label: '已完成' }
  ];

  function renderTabs(active, blocked, done) {
    var counts = {
      all: active.length, today: 0, week: 0, schedule: 0, drop: 0,
      blocked: blocked.length, done: done.length
    };
    active.forEach(function (t) { counts[t.decision]++; });
    var nav = $('#tabs');
    nav.textContent = '';
    FILTERS.forEach(function (f) {
      var b = el('button', 'tab' + (state.filter === f.key ? ' on' : ''));
      b.appendChild(document.createTextNode(f.label));
      if (counts[f.key] > 0) { b.appendChild(el('b', null, counts[f.key])); }
      b.addEventListener('click', function () {
        state.filter = f.key;
        render();
      });
      nav.appendChild(b);
    });
  }

  function decisionMeta(key) {
    return M.DECISIONS[key] || { label: key, color: '#6b7280' };
  }

  function cardActions(t) {
    var box = el('div', 'card-actions');
    if (t.status === 'todo' || t.status === 'doing') {
      var ok = el('button', 'mini-btn ok', '✓ 完成');
      ok.addEventListener('click', function () { completeTask(t.id); });
      box.appendChild(ok);
      if (t.status !== 'blocked') {
        var blk = el('button', 'mini-btn', '阻塞');
        blk.addEventListener('click', function () { setStatus(t.id, 'blocked'); });
        box.appendChild(blk);
      } else {
        var unblk = el('button', 'mini-btn', '解除阻塞');
        unblk.addEventListener('click', function () { setStatus(t.id, 'todo'); });
        box.appendChild(unblk);
      }
    } else if (t.status === 'blocked') {
      var un = el('button', 'mini-btn', '解除阻塞');
      un.addEventListener('click', function () { setStatus(t.id, 'todo'); });
      box.appendChild(un);
      var okB = el('button', 'mini-btn ok', '✓ 完成');
      okB.addEventListener('click', function () { completeTask(t.id); });
      box.appendChild(okB);
    } else if (t.status === 'done') {
      var undo = el('button', 'mini-btn undo', '↩ 恢复待办');
      undo.addEventListener('click', function () {
        var x = byId(t.id);
        if (x) { x.status = 'todo'; x.doneAt = null; save(); render(); }
      });
      box.appendChild(undo);
    }
    var ed = el('button', 'mini-btn', '编辑');
    ed.addEventListener('click', function () { openEdit(t.id); });
    box.appendChild(ed);
    var del = el('button', 'mini-btn warn', '删除');
    del.addEventListener('click', function () { deleteTask(t.id); });
    box.appendChild(del);
    return box;
  }

  function taskCard(t, rank) {
    var meta = decisionMeta(t.decision);
    var card = el('article', 'card' + (t.status === 'done' ? ' done' : ''));
    card.style.setProperty('--dc', meta.color);

    var head = el('div', 'card-head');
    var rk = el('div', 'rank', t.status === 'blocked' ? '⚠' : (t.status === 'done' ? '✓' : String(rank)));
    head.appendChild(rk);

    var main = el('div', 'card-main');
    main.appendChild(el('div', 'card-title', t.title));
    var chips = el('div', 'card-meta');
    chips.appendChild(el('span', 'chip', '重要度 ' + t.a));
    chips.appendChild(el('span', 'chip', '紧急度 ' + t.c));
    chips.appendChild(el('span', 'chip', '难度 ' + t.b));
    if (t.daysLeft !== null && t.daysLeft !== undefined) {
      var dl = t.daysLeft;
      chips.appendChild(el('span', 'chip warn',
        dl < 0 ? ('已逾期 ' + (-dl) + ' 天') : (dl === 0 ? '今天到期' : '剩 ' + dl + ' 天')));
    }
    if (t.easyBoost) { chips.appendChild(el('span', 'chip boost', '⏫ 先易后难')); }
    if (t.estMin > 0) { chips.appendChild(el('span', 'chip', '⏱ ' + M.fmtDuration(t.estMin))); }
    if (t.assignee) { chips.appendChild(el('span', 'chip', '委托：' + t.assignee)); }
    if (t.status === 'doing') { chips.appendChild(el('span', 'chip warn', '进行中')); }
    if (t.status === 'blocked') { chips.appendChild(el('span', 'chip note', '⚠ 等待他人/条件')); }
    if (t.note) { chips.appendChild(el('span', 'chip', '备注：' + t.note)); }
    main.appendChild(chips);
    head.appendChild(main);

    var side = el('div', 'card-side');
    var p = el('div', 'p-score', String(t.P));
    var f = el('div', 'p-formula', 'a' + t.a + ' × c' + t.c);
    side.appendChild(p);
    side.appendChild(f);
    var badge = el('span', 'badge', meta.label);
    badge.style.setProperty('--dc', meta.color);
    side.appendChild(badge);
    head.appendChild(side);

    card.appendChild(head);
    card.appendChild(cardActions(t));
    return card;
  }

  function render() {
    var active = evaluated();
    var blocked = blockedList();
    var done = doneList();
    renderStats(active);
    renderTabs(active, blocked, done);

    var list = $('#list');
    list.textContent = '';
    var shown = [];
    if (state.filter === 'all') { shown = active; }
    else if (state.filter === 'blocked') { shown = blocked; }
    else if (state.filter === 'done') { shown = done; }
    else { shown = active.filter(function (t) { return t.decision === state.filter; }); }

    shown.forEach(function (t, i) {
      list.appendChild(taskCard(t, i + 1));
    });
    var empty = $('#empty');
    if (shown.length > 0) {
      empty.hidden = true;
    } else if (active.length > 0) {
      empty.hidden = false;
      empty.querySelector('p').textContent = '该分类暂无任务';
      empty.querySelector('button').hidden = true;
    } else {
      empty.hidden = false;
      empty.querySelector('p').textContent = '暂无任务';
      empty.querySelector('button').hidden = false;
    }
  }

  /* ---------- 任务操作 ---------- */
  function completeTask(id) {
    var t = byId(id);
    if (!t) { return; }
    t.status = 'done';
    t.doneAt = Date.now();
    save();
    render();
  }
  function setStatus(id, status) {
    var t = byId(id);
    if (!t) { return; }
    t.status = status;
    save();
    render();
  }
  function deleteTask(id) {
    var t = byId(id);
    if (!t || !window.confirm('删除任务「' + t.title + '」？')) { return; }
    state.tasks = state.tasks.filter(function (x) { return x.id !== id; });
    save();
    render();
  }

  /* ---------- 编辑表单 ---------- */
  function fillSelect(sel, items, map, selectedValue) {
    sel.textContent = '';
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = String(it.level);
      o.textContent = it.level + ' · ' + it.label;
      sel.appendChild(o);
    });
    sel.value = String(selectedValue);
    return sel;
  }

  function openEdit(id) {
    state.editingId = id || null;
    var t = id ? byId(id) : null;
    $('#edit-title').textContent = t ? '编辑任务' : '添加任务';
    $('#f-id').value = t ? t.id : '';

    // 重要度
    var aSel = $('#f-a');
    fillSelect(aSel, M.IMPORTANCE_RUBRIC, null, t ? 11 - t.a : 5);
    // 紧急度
    var cmode = t && t.cMode === 'due' ? 'due' : 'manual';
    setCmodeUI(cmode);
    var cSel = $('#f-cmanual');
    fillSelect(cSel, M.URGENCY_RUBRIC, null, t ? 11 - Math.round(t.c) : 10);
    $('#f-due').value = (t && t.cMode === 'due' && t.due) ? t.due : iso(7);
    // 难易度
    $('#f-b').value = t ? t.b : 5;
    // 其他
    $('#f-title').value = t ? t.title : '';
    var estMin = t ? (t.estMin || 0) : 0;
    $('#f-est').value = estMin > 0 ? estMin : '';
    $('#f-est-unit').value = estMin > 0 ? (estMin % 60 === 0 ? '60' : '1') : '60';
    $('#f-status').value = t ? t.status : 'todo';
    $('#f-assignee').value = t ? (t.assignee || '') : '';
    $('#f-note').value = t ? (t.note || '') : '';
    updateBAnchors();
    updatePreview();
    showSheet('mask-edit');
    $('#f-title').focus();
  }

  function setCmodeUI(cmode) {
    $$('#f-cmode button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.cmode === cmode);
    });
    $('#f-due-wrap').hidden = cmode !== 'due';
    $('#f-cmanual').hidden = cmode !== 'manual';
  }

  function updateBAnchors() {
    var wrap = $('#f-b-anchors');
    wrap.textContent = '';
    M.DIFFICULTY_ANCHORS.forEach(function (a) {
      var c = el('span', 'chip' + (String($('#f-b').value) === String(a.value) ? ' on' : ''),
        a.value + '·' + a.label);
      c.addEventListener('click', function () {
        $('#f-b').value = a.value;
        updateBAnchors();
        updatePreview();
      });
      wrap.appendChild(c);
    });
  }

  function currentPreview() {
    var a = M.importanceFromLevel(+$('#f-a').value);
    var c;
    var cmode = $$('#f-cmode button.on')[0].dataset.cmode;
    if (cmode === 'due') {
      var due = $('#f-due').value;
      var d = due ? M.daysUntil(due) : null;
      c = (d === null) ? 0 : M.urgencyFromDays(d, state.settings.tau);
    } else {
      c = M.urgencyFromLevel(+$('#f-cmanual').value);
    }
    var b = +$('#f-b').value;
    return { a: a, c: c, b: b, d: cmode === 'due' ? M.daysUntil($('#f-due').value) : null };
  }

  function updatePreview() {
    var pv = currentPreview();
    $('#f-a-val').textContent = pv.a + ' 分';
    $('#f-b-val').textContent = '第 ' + pv.b + ' 档（越大越容易，不改 P 分数）';
    $('#f-c-val').textContent = pv.c > 0 ? (pv.c + ' 分') : '—';
    var dueHint = $('#f-due-hint');
    if (pv.d !== null && pv.d !== undefined) {
      dueHint.textContent = pv.d < 0 ? ('已逾期 ' + (-pv.d) + ' 天 → 紧急度满分')
        : (pv.d === 0 ? '今天到期 → 紧急度满分' : '剩 ' + pv.d + ' 天 → c≈' + M.urgencyFromDays(pv.d, state.settings.tau));
    } else { dueHint.textContent = ''; }

    var box = $('#f-preview');
    if (pv.c <= 0) { box.hidden = true; return; }
    box.hidden = false;
    var P = M.round1(pv.a * pv.c);
    $('#f-preview-p').textContent = 'P = ' + pv.a + ' × ' + pv.c + ' = ' + P;
    var dec = M.decide(P, pv.a, state.settings);
    var meta = decisionMeta(dec);
    var tag = $('#f-preview-d');
    tag.textContent = meta.label;
    tag.style.background = meta.color;
  }

  function saveForm(e) {
    e.preventDefault();
    var title = $('#f-title').value.trim();
    if (!title) { alert('请填写任务名称'); return; }
    var cmode = $$('#f-cmode button.on')[0].dataset.cmode;
    if (cmode === 'due' && !$('#f-due').value) { alert('请选择截止日期'); return; }

    var id = $('#f-id').value || uid();
    var estUnit = +$('#f-est-unit').value;
    var estRaw = parseFloat($('#f-est').value);
    var t = byId(id) || {};
    t.id = id;
    t.title = title;
    t.a = M.importanceFromLevel(+$('#f-a').value);
    t.cMode = cmode;
    t.due = cmode === 'due' ? $('#f-due').value : null;
    t.cManual = +$('#f-cmanual').value; // 手动档位 1-10（due 模式时作为回退档位）
    t.b = +$('#f-b').value;
    t.estMin = estRaw > 0 ? Math.round(estRaw * estUnit) : 0;
    t.status = $('#f-status').value;
    t.assignee = $('#f-assignee').value.trim();
    t.note = $('#f-note').value.trim();
    if (!t.createdAt) { t.createdAt = Date.now(); }
    if (t.status === 'done') { t.doneAt = t.doneAt || Date.now(); }
    if (t.status !== 'done') { t.doneAt = null; }

    if (!byId(id)) { state.tasks.push(t); }
    save();
    hideSheet('mask-edit');
    render();
  }

  /* ---------- 抽屉 ---------- */
  function showSheet(id) { $('#' + id).hidden = false; document.body.style.overflow = 'hidden'; }
  function hideSheet(id) { $('#' + id).hidden = true; document.body.style.overflow = ''; }
  $$('.sheet-mask').forEach(function (mask) {
    mask.addEventListener('click', function (e) {
      if (e.target === mask) { mask.hidden = true; document.body.style.overflow = ''; }
    });
  });
  $$('[data-close]').forEach(function (b) {
    b.addEventListener('click', function () { hideSheet(b.dataset.close); });
  });

  /* ---------- 设置 ---------- */
  function openSettings() {
    $('#s-tau').value = state.settings.tau;
    $('#s-tau-val').textContent = state.settings.tau;
    $('#s-must').value = state.settings.must;
    $('#s-week').value = state.settings.week;
    $('#s-sched').value = state.settings.schedule;
    $('#s-easy').checked = state.settings.easyFirst;
    $('#n-must').textContent = state.settings.must;
    $('#n-week').textContent = state.settings.week;
    $('#n-sched').textContent = state.settings.schedule;
    showSheet('mask-settings');
  }
  function saveSettingsFromForm() {
    state.settings = M.mergeSettings({
      tau: +$('#s-tau').value || 7,
      must: +$('#s-must').value || 80,
      week: +$('#s-week').value || 50,
      schedule: +$('#s-sched').value || 20,
      easyFirst: $('#s-easy').checked
    });
    $('#s-tau-val').textContent = state.settings.tau;
    $('#n-must').textContent = state.settings.must;
    $('#n-week').textContent = state.settings.week;
    $('#n-sched').textContent = state.settings.schedule;
    saveSettings();
    render();
  }

  function exportData() {
    var data = { app: 'task-priority', version: 1, exportedAt: new Date().toISOString(), settings: state.settings, tasks: state.tasks };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '任务优先级备份-' + iso(0) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.tasks)) { throw new Error('bad'); }
        if (!window.confirm('导入将覆盖当前 ' + state.tasks.length + ' 条任务，继续？')) { return; }
        state.tasks = data.tasks;
        if (data.settings) { state.settings = M.mergeSettings(data.settings); }
        save();
        render();
        alert('导入成功：' + state.tasks.length + ' 条任务');
      } catch (err) {
        alert('导入失败：文件格式不正确');
      }
    };
    reader.readAsText(file);
  }

  function clearData() {
    if (!window.confirm('确定清空全部任务数据？此操作不可恢复（可先导出备份）。')) { return; }
    state.tasks = [];
    save();
    render();
  }

  /* ---------- 示例数据 ---------- */
  function seedDemo() {
    var now = Date.now();
    state.tasks = [
      { id: uid(), title: '向领导汇报重点项目进展（领导在等）', a: 10, cMode: 'due', due: iso(1), cManual: 10, b: 7, estMin: 30, status: 'todo', assignee: '', note: '', createdAt: now - 80000, doneAt: null },
      { id: uid(), title: '总署来电要求的数据核对', a: 9, cMode: 'due', due: iso(3), cManual: 10, b: 4, estMin: 120, status: 'todo', assignee: '', note: '', createdAt: now - 70000, doneAt: null },
      { id: uid(), title: '上级临时抽查整改材料', a: 10, cMode: 'due', due: iso(-2), cManual: 10, b: 5, estMin: 90, status: 'todo', assignee: '', note: '已逾期', createdAt: now - 60000, doneAt: null },
      { id: uid(), title: '撰写季度工作总结', a: 8, cMode: 'due', due: iso(20), cManual: 10, b: 8, estMin: 240, status: 'todo', assignee: '', note: '重要但不急 → 排期', createdAt: now - 50000, doneAt: null },
      { id: uid(), title: '科内例会材料准备', a: 3, cMode: 'manual', due: null, cManual: 2, b: 9, estMin: 60, status: 'todo', assignee: '小王', note: '不重要但急 → 可委托', createdAt: now - 40000, doneAt: null },
      { id: uid(), title: '组织部门文化学习活动', a: 6, cMode: 'due', due: iso(45), cManual: 10, b: 6, estMin: 180, status: 'todo', assignee: '', note: '', createdAt: now - 30000, doneAt: null },
      { id: uid(), title: '帮同事整理历史文档', a: 1, cMode: 'manual', due: null, cManual: 10, b: 10, estMin: 480, status: 'todo', assignee: '', note: '双低 → 不做/删除', createdAt: now - 20000, doneAt: null },
      { id: uid(), title: '新技术调研做原型', a: 7, cMode: 'due', due: iso(10), cManual: 10, b: 2, estMin: 300, status: 'blocked', assignee: '', note: '等供应商开通账号', createdAt: now - 10000, doneAt: null }
    ];
    save();
  }

  /* ---------- 账户 / 登录 ---------- */
  function showLogin() {
    $('#login-view').hidden = false;
    $('#app').hidden = true;
  }
  function showApp() {
    $('#login-view').hidden = true;
    $('#app').hidden = false;
  }
  function onLogin() {
    var u = $('#login-user').value.trim();
    var p = $('#login-pass').value;
    if (!u || !p) { $('#login-error').textContent = '请输入账户名和密码'; $('#login-error').hidden = false; return; }
    $('#login-error').hidden = true;
    fetch(API_BASE + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    }).then(function (resp) { return resp.json().then(function (d) { return { ok: resp.ok, d: d }; }); })
      .then(function (r) {
        if (!r.ok) {
          $('#login-error').textContent = r.d.error || '登录失败';
          $('#login-error').hidden = false;
          return;
        }
        setToken(r.d.token);
        state.username = r.d.username;
        $('#login-pass').value = '';
        showApp();
        fetchTasks();
      });
  }
  function onLogout() {
    api('POST', '/api/logout').then(function () {
      setToken('');
      state.tasks = [];
      state.username = '';
      render();
      showLogin();
    });
  }
  function onChangePassword(e) {
    e.preventDefault();
    var oldPw = $('#pw-old').value;
    var n1 = $('#pw-new').value;
    var n2 = $('#pw-new2').value;
    var err = $('#pw-error');
    if (!oldPw || !n1 || !n2) { err.textContent = '请填写完整'; err.hidden = false; return; }
    if (n1.length < 6) { err.textContent = '新密码至少 6 位'; err.hidden = false; return; }
    if (n1 !== n2) { err.textContent = '两次输入的新密码不一致'; err.hidden = false; return; }
    err.hidden = true;
    api('POST', '/api/change-password', { oldPassword: oldPw, newPassword: n1 }).then(function (r) {
      if (!r.ok) { err.textContent = r.data.error || '修改失败'; err.hidden = false; return; }
      alert(r.data.message || '密码已修改');
      setToken('');
      hideSheet('mask-pw');
      showLogin();
    });
  }

  /* ---------- 初始化 ---------- */
  function bindEvents() {
    $('#btn-login').addEventListener('click', onLogin);
    $('#login-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') { onLogin(); } });
    $('#btn-logout').addEventListener('click', onLogout);
    $('#btn-change-pw').addEventListener('click', function () {
      $('#pw-old').value = ''; $('#pw-new').value = ''; $('#pw-new2').value = '';
      $('#pw-error').hidden = true;
      showSheet('mask-pw');
    });
    $('#form-pw').addEventListener('submit', onChangePassword);

    $('#btn-add').addEventListener('click', function () { openEdit(null); });
    $('#btn-empty-add').addEventListener('click', function () { openEdit(null); });
    $('#btn-settings').addEventListener('click', function () {
      $('#account-info').textContent = '当前账户：' + state.username;
      openSettings();
    });

    $('#form-edit').addEventListener('submit', saveForm);
    $('#f-a').addEventListener('change', updatePreview);
    $('#f-b').addEventListener('input', function () { updateBAnchors(); updatePreview(); });
    $('#f-cmanual').addEventListener('change', updatePreview);
    $('#f-due').addEventListener('change', updatePreview);
    $$('#f-cmode button').forEach(function (b) {
      b.addEventListener('click', function () { setCmodeUI(b.dataset.cmode); updatePreview(); });
    });

    $('#s-tau').addEventListener('input', saveSettingsFromForm);
    $('#s-must').addEventListener('change', saveSettingsFromForm);
    $('#s-week').addEventListener('change', saveSettingsFromForm);
    $('#s-sched').addEventListener('change', saveSettingsFromForm);
    $('#s-easy').addEventListener('change', saveSettingsFromForm);

    $('#btn-export').addEventListener('click', exportData);
    $('#btn-import').addEventListener('click', function () { $('#file-import').click(); });
    $('#file-import').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) { importData(e.target.files[0]); }
      e.target.value = '';
    });
    $('#btn-demo').addEventListener('click', function () {
      if (window.confirm('载入 8 条示例任务（覆盖当前数据）？')) {
        seedDemo();
        render();
        hideSheet('mask-settings');
      }
    });
    $('#btn-clear').addEventListener('click', clearData);

    // 多账户版数据在服务端，关闭离线缓存注册，避免更新时命中旧缓存
  }

  /* ---------- 启动 ---------- */
  loadSettings();
  bindEvents();
  if (token()) {
    api('GET', '/api/me').then(function (r) {
      if (r.ok) { showApp(); fetchTasks(); }
      else { setToken(''); showLogin(); }
    });
  } else {
    showLogin();
  }
})();
