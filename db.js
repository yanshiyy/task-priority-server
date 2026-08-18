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

  return {
    getUser: getUser,
    getUserById: getUserById,
    listUsers: listUsers,
    createUser: createUser,
    setPassword: setPassword,
    getTasks: getTasks,
    putTasks: putTasks
  };
}

module.exports = { open: open };
