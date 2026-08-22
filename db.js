/* db.js — SQLite 存储（node:sqlite，Node 22.5+ 内置） */
'use strict';
var fs = require('fs');
var path = require('path');
var auth = require('./auth.js');

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  var dbFile = path.join(dataDir, 'tasks.db');
  var { DatabaseSync } = require('node:sqlite');
  var db = new DatabaseSync(dbFile);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, salt TEXT, hash TEXT, created_at INTEGER)');
  db.exec('CREATE TABLE IF NOT EXISTS tasks (user_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, updated_at INTEGER)');
  db.exec('CREATE TABLE IF NOT EXISTS delegations (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'from_user_id INTEGER NOT NULL, ' +      // 委派人（当前链上的发起方）
    'to_user_id INTEGER NOT NULL, ' +        // 被委派人
    'root_user_id INTEGER NOT NULL, ' +      // 最原始委派人（转派链追溯）
    'parent_id INTEGER, ' +                  // 上一级委派 id（转派时非空；NULL=原始委派）
    'task_snapshot TEXT NOT NULL, ' +        // 委派时刻任务完整快照 JSON
    'source_title TEXT NOT NULL, ' +         // 原任务标题快照
    'note TEXT DEFAULT \'\', ' +             // 委派/转派说明
    'status TEXT NOT NULL DEFAULT \'active\', ' +  // active|feedback|confirmed|rejected|cancelled|re-delegated
    'feedback_status TEXT, ' +               // 最新反馈：doing|blocked|done
    'feedback_note TEXT, ' +
    'feedback_at INTEGER, ' +
    'confirm_action TEXT, ' +                // confirm|reject
    'confirm_note TEXT, ' +
    'confirmed_at INTEGER, ' +
    'created_at INTEGER NOT NULL, ' +
    'updated_at INTEGER NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_deleg_to ON delegations(to_user_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_deleg_from ON delegations(from_user_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_deleg_root ON delegations(root_user_id, status)');

  function getUser(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }
  function getUserById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  function listUsers() {
    return db.prepare('SELECT id, username, created_at FROM users ORDER BY id').all();
  }
  function createUser(username, password) {
    var h = auth.hashPassword(password);
    var r = db.prepare('INSERT INTO users (username, salt, hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username, h.salt, h.hash, Date.now());
    return { id: Number(r.lastInsertRowid), username: username };
  }
  function setPassword(userId, password) {
    var h = auth.hashPassword(password);
    db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(h.salt, h.hash, userId);
  }
  function getTasks(userId) {
    var row = db.prepare('SELECT payload, rev FROM tasks WHERE user_id = ?').get(userId);
    if (!row) { return { tasks: [], rev: 0 }; }
    try { return { tasks: JSON.parse(row.payload), rev: row.rev }; }
    catch (e) { return { tasks: [], rev: row.rev }; }
  }
  // 带乐观锁写入：expectedRev 与库中一致才成功，否则返回 null
  function putTasks(userId, tasks, expectedRev) {
    var cur = db.prepare('SELECT rev FROM tasks WHERE user_id = ?').get(userId);
    var curRev = cur ? cur.rev : 0;
    if (Number(expectedRev) !== curRev) { return null; }
    var payload = JSON.stringify(tasks);
    var newRev = curRev + 1;
    db.prepare('INSERT INTO tasks (user_id, payload, rev, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, rev = excluded.rev, updated_at = excluded.updated_at')
      .run(userId, payload, newRev, Date.now());
    return newRev;
  }

  /* ---------- 任务委派 ---------- */

  function rowToDelegation(row) {
    if (!row) { return null; }
    var d = {
      id: row.id,
      fromUserId: row.from_user_id,
      toUserId: row.to_user_id,
      rootUserId: row.root_user_id,
      parentId: row.parent_id,
      sourceTitle: row.source_title,
      note: row.note || '',
      status: row.status,
      feedbackStatus: row.feedback_status,
      feedbackNote: row.feedback_note || '',
      feedbackAt: row.feedback_at,
      confirmAction: row.confirm_action,
      confirmNote: row.confirm_note || '',
      confirmedAt: row.confirmed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
    try { d.taskSnapshot = JSON.parse(row.task_snapshot); } catch (e) { d.taskSnapshot = null; }
    return d;
  }

  /** 创建委派（快照任务 + 双方信息） */
  function createDelegation(opts) {
    var now = Date.now();
    var r = db.prepare(
      'INSERT INTO delegations (from_user_id, to_user_id, root_user_id, parent_id, task_snapshot, source_title, note, status, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        opts.fromUserId, opts.toUserId,
        opts.rootUserId != null ? opts.rootUserId : opts.fromUserId,
        opts.parentId || null,
        JSON.stringify(opts.taskSnapshot),
        opts.sourceTitle || (opts.taskSnapshot && opts.taskSnapshot.title) || '',
        opts.note || '',
        'active', now, now
      );
    return getDelegation(Number(r.lastInsertRowid));
  }

  /** 按 id 取委派（含快照解析） */
  function getDelegation(id) {
    var row = db.prepare('SELECT * FROM delegations WHERE id = ?').get(id);
    return rowToDelegation(row);
  }

  /** 某用户发起的委派（按更新时间倒序） */
  function listMine(userId) {
    var rows = db.prepare('SELECT * FROM delegations WHERE from_user_id = ? ORDER BY updated_at DESC').all(userId);
    return rows.map(rowToDelegation);
  }
  /** 委派给某用户的委派（按更新时间倒序） */
  function listAssigned(userId) {
    var rows = db.prepare('SELECT * FROM delegations WHERE to_user_id = ? ORDER BY updated_at DESC').all(userId);
    return rows.map(rowToDelegation);
  }

  /**
   * 条件状态更新（状态机）：仅当当前状态符合 expected（字符串或数组）时更新为 next，
   * 返回是否成功（changes > 0）。用于并发安全的反馈/确认/撤回/转派。
   */
  function transition(id, expected, next, patch) {
    patch = patch || {};
    var sets = [];
    var vals = [];
    sets.push('status = ?'); vals.push(next);
    sets.push('updated_at = ?'); vals.push(Date.now());
    ['feedback_status', 'feedback_note', 'feedback_at', 'confirm_action', 'confirm_note', 'confirmed_at', 'note'].forEach(function (k) {
      if (k in patch) { sets.push(k + ' = ?'); vals.push(patch[k]); }
    });
    var where;
    if (Array.isArray(expected)) {
      var marks = expected.map(function () { return '?'; }).join(', ');
      where = 'status IN (' + marks + ') AND id = ?';
      expected.forEach(function (e) { vals.push(e); });
    } else {
      where = 'status = ? AND id = ?';
      vals.push(expected);
    }
    vals.push(id);
    var stmt = db.prepare('UPDATE delegations SET ' + sets.join(', ') + ' WHERE ' + where);
    var r = stmt.run.apply(stmt, vals);
    return r.changes > 0;
  }

  /** 反馈后状态机：active/rejected → feedback */
  function applyFeedback(id, status, note) {
    return transition(id, ['active', 'rejected'], 'feedback', {
      feedback_status: status, feedback_note: note || '', feedback_at: Date.now()
    });
  }

  /** 撤回：仅 active 可撤回 */
  function cancelDelegation(id) {
    return transition(id, 'active', 'cancelled', {});
  }

  /** 转派：原委派标记为 re-delegated（active/rejected → re-delegated） */
  function markReDelegated(id) {
    return transition(id, ['active', 'rejected'], 're-delegated', {});
  }

  /** 删除委派（用于创建原任务锁定失败时回滚） */
  function deleteDelegation(id) {
    db.prepare('DELETE FROM delegations WHERE id = ?').run(id);
  }

  /** 未读角标：新委派给我的 + 新反馈给我的 */
  function alertsFor(userId) {
    var assigned = db.prepare('SELECT COUNT(*) AS c FROM delegations WHERE to_user_id = ? AND status IN (?, ?)')
      .get(userId, 'active', 'rejected');
    var feedback = db.prepare('SELECT COUNT(*) AS c FROM delegations WHERE from_user_id = ? AND status = ?')
      .get(userId, 'feedback');
    return { newAssigned: assigned.c, newFeedback: feedback.c };
  }

  return {
    getUser: getUser,
    getUserById: getUserById,
    listUsers: listUsers,
    createUser: createUser,
    setPassword: setPassword,
    getTasks: getTasks,
    putTasks: putTasks,
    createDelegation: createDelegation,
    getDelegation: getDelegation,
    listMine: listMine,
    listAssigned: listAssigned,
    transition: transition,
    applyFeedback: applyFeedback,
    cancelDelegation: cancelDelegation,
    markReDelegated: markReDelegated,
    deleteDelegation: deleteDelegation,
    alertsFor: alertsFor
  };
}

module.exports = { open: open };
