/* auth.js — 密码散列与登录会话（Node 内置 crypto，无第三方依赖） */
'use strict';
var crypto = require('crypto');

var PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function hashPassword(password) {
  var salt = crypto.randomBytes(16).toString('hex');
  var hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt: salt, hash: hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) { return false; }
  try {
    var candidate = crypto.scryptSync(String(password), salt, 64).toString('hex');
    var a = Buffer.from(candidate, 'hex');
    var b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

function randomPassword(len) {
  len = len || 10;
  var out = '';
  var bytes = crypto.randomBytes(len);
  for (var i = 0; i < len; i++) {
    out += PASSWORD_CHARS[bytes[i] % PASSWORD_CHARS.length];
  }
  return out;
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 会话表：token -> { userId, username, expires }
function createSessionStore(ttlMs) {
  var sessions = new Map();
  ttlMs = ttlMs || 7 * 24 * 3600 * 1000;
  function sweep() {
    var now = Date.now();
    sessions.forEach(function (v, k) {
      if (v.expires <= now) { sessions.delete(k); }
    });
  }
  setInterval(sweep, 60 * 60 * 1000).unref();
  return {
    create: function (userId, username) {
      var token = randomToken();
      sessions.set(token, { userId: userId, username: username, expires: Date.now() + ttlMs });
      return token;
    },
    get: function (token) {
      var s = sessions.get(token);
      if (!s) { return null; }
      if (s.expires <= Date.now()) { sessions.delete(token); return null; }
      return s;
    },
    remove: function (token) { sessions.delete(token); },
    removeUser: function (userId) {
      sessions.forEach(function (v, k) { if (v.userId === userId) { sessions.delete(k); } });
    }
  };
}

module.exports = {
  hashPassword: hashPassword,
  verifyPassword: verifyPassword,
  randomPassword: randomPassword,
  randomToken: randomToken,
  createSessionStore: createSessionStore
};
