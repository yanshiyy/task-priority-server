/*
 * scoring.js — 任务优先级决策模型（纯逻辑，无 DOM 依赖，可在 Node 中单测）
 *
 * 模型说明（依据优化后的方案）：
 *   1. 任务按三维打分：(a) 重要度 1-10、(b) 难易度 1-10（1=最难，10=最易，数值即档位）、(c) 紧急度 1-10
 *   2. 核心优先度 P = a × c（1-100，乘积型，贴合四象限）
 *   3. 难度不参与加分，只用于并列修正与"先易后难"微调
 *   4. 紧急度支持两种输入：
 *      - 截止日期模式：c = 1 + 9·e^(-d/τ)（d=距截止天数，τ 默认 7 天；逾期 d<0 时 c=10）
 *      - 手动档位模式：按 10 档词表映射 c = 11 - 档位
 *   5. 处置决策阈值：P≥80 今天必做 / 50-79 本周安排 / 20-49 排期或委托 /
 *      P<20 且 a≥7 → 排期（重要但不急），否则 → 不做或删除
 *   6. 并列规则链：P 相同 → c 大先 → a 大先 → 更容易先 → 先登记先做(FIFO)
 *   7. "先易后难"修正（可选）：相邻两任务 P 相差 ≤10 分时，更容易的排前
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (root) { root.PriorityModel = api; }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var DEFAULT_SETTINGS = {
    tau: 7,                    // 紧急度衰减时间常数（天）
    must: 80,                  // P ≥ must → 今天必做
    week: 50,                  // P ≥ week → 本周安排
    schedule: 20,              // P ≥ schedule → 排期/委托
    importantFloor: 7,         // a ≥ 该值视为"重要"（用于 P<20 时的兜底）
    easyFirst: true,           // 相邻 10 分内先易后难
    easyFirstBand: 10
  };

  // 重要度词表（档位 1=最重要 → a=10）
  var IMPORTANCE_RUBRIC = [
    { level: 1,  label: '关领导的布置及时工作' },
    { level: 2,  label: '总署的电话或邮件工作' },
    { level: 3,  label: '处领导布置的及时工作' },
    { level: 4,  label: '关领导有批示/会议上布置' },
    { level: 5,  label: '总署文件工作' },
    { level: 6,  label: '关内其它部门的工作' },
    { level: 7,  label: '处内安排的工作' },
    { level: 8,  label: '科内安排的日常工作' },
    { level: 9,  label: '基层的请求' },
    { level: 10, label: '帮助其它同事工作' }
  ];

  // 紧急度手动档位词表（档位 1=最急 → c=10）
  var URGENCY_RUBRIC = [
    { level: 1,  label: '现在立刻、马上（领导在等）' },
    { level: 2,  label: '今天下班前完成' },
    { level: 3,  label: '本周内完成' },
    { level: 4,  label: '规定时间内完成' },
    { level: 5,  label: '本月内完成' },
    { level: 6,  label: '按计划做' },
    { level: 7,  label: '本季度内完成' },
    { level: 8,  label: '上半年完成' },
    { level: 9,  label: '年底前完成' },
    { level: 10, label: '可推迟' }
  ];

  // 难易度条件词表（档位 1=最难 … 10=最易；value 即档位，数值越大越容易）
  var DIFFICULTY_ANCHORS = [
    { value: 1,  label: '没有思路，没参考，没人会，没帮助，没资料（工具）' },
    { value: 2,  label: '有一点思路，没参考，没人会，没帮助，没资料（工具）' },
    { value: 3,  label: '有明确思路，没参考，没人会，没帮助，没资料（工具）' },
    { value: 4,  label: '没思路，有参考，没人会，没帮助，没资料（工具）' },
    { value: 5,  label: '没思路，没参考，有人会，没帮助，没资料（工具）' },
    { value: 6,  label: '没思路，没参考，没人会，有帮助，没资料（工具）' },
    { value: 7,  label: '有思路，没参考，没人会，有帮助，没资料（工具）' },
    { value: 8,  label: '没思路，没参考，没人会，没帮助，有资料（工具）' },
    { value: 9,  label: '有思路，没参考，没人会，没帮助，有资料（工具）' },
    { value: 10, label: '有思路，没参考，没人会，有帮助，有资料（工具）' }
  ];

  // 处置决策类型
  var DECISIONS = {
    today:    { key: 'today',    label: '今天必做',   color: '#dc2626', order: 0 },
    week:     { key: 'week',     label: '本周安排',   color: '#ea580c', order: 1 },
    schedule: { key: 'schedule', label: '排期/委托',  color: '#2563eb', order: 2 },
    drop:     { key: 'drop',     label: '不做/删除',  color: '#6b7280', order: 3 },
    done:     { key: 'done',     label: '已完成',     color: '#16a34a', order: 4 },
    blocked:  { key: 'blocked',  label: '已阻塞',     color: '#a16207', order: 5 }
  };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function round1(v) { return Math.round(v * 10) / 10; }

  /** 距截止天数 -> 紧急度（连续衰减曲线） */
  function urgencyFromDays(days, tau) {
    tau = tau > 0 ? tau : 7;
    if (days <= 0) { return 10; }               // 已到期/逾期 → 满分
    return round1(clamp(1 + 9 * Math.exp(-days / tau), 1, 10));
  }

  /** 手动档位 -> 紧急度（1=最急 → 10） */
  function urgencyFromLevel(level) { return clamp(11 - level, 1, 10); }
  /** 重要度档位 -> a 分（1=最重要 → 10） */
  function importanceFromLevel(level) { return clamp(11 - level, 1, 10); }
  /** 难度档位 -> 容易度（档位越大越容易，用于并列/先易后难） */
  function easeFromDifficulty(d) { return d; }

  /** 距截止日天数：due 为 'YYYY-MM-DD'，按本地零点计算 */
  function daysUntil(due, today) {
    if (!due) { return null; }
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
    if (!m) { return null; }
    var t = today || new Date();
    var zero = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return Math.round((d - zero) / 86400000);
  }

  /** 计算任务派生字段：c、ease、P、decision；返回新的任务对象 */
  function evaluate(task, settings) {
    var s = mergeSettings(settings);
    var c;
    if (task.cMode === 'due' && task.due) {
      var d = daysUntil(task.due);
      c = (d === null) ? 10 : urgencyFromDays(d, s.tau);
    } else {
      c = urgencyFromLevel(task.cManual || 10);
    }
    var a = clamp(Math.round(task.a) || 1, 1, 10);
    var b = clamp(Math.round(task.b) || 5, 1, 10);
    c = clamp(c, 1, 10);
    var ease = easeFromDifficulty(b);
    var P = round1(a * c);
    var d = task.cMode === 'due' && task.due ? daysUntil(task.due) : null;
    return Object.assign({}, task, {
      a: a, b: b, c: c, ease: ease, P: P,
      decision: decide(P, a, s), daysLeft: d
    });
  }

  /** 处置决策 */
  function decide(P, a, settings) {
    var s = mergeSettings(settings);
    if (P >= s.must) { return 'today'; }
    if (P >= s.week) { return 'week'; }
    if (P >= s.schedule) { return 'schedule'; }
    // P < schedule：重要但不急 → 排期；否则 → 不做/删除
    return a >= s.importantFloor ? 'schedule' : 'drop';
  }

  /** 并列规则链比较器：先 P 降序，再 c 降序、a 降序、ease 降序、FIFO */
  function compareTasks(x, y) {
    if (y.P !== x.P) { return y.P - x.P; }
    if (y.c !== x.c) { return y.c - x.c; }
    if (y.a !== x.a) { return y.a - x.a; }
    if (y.ease !== x.ease) { return y.ease - x.ease; }
    return (x.createdAt || 0) - (y.createdAt || 0);
  }

  /**
   * "先易后难"修正：相邻两任务 P 相差 ≤ band 分时，更容易的排前。
   * 冒泡至稳定，保证确定性。
   */
  function applyEasyFirst(sorted, band) {
    var list = sorted.slice();
    var swapped = true;
    while (swapped) {
      swapped = false;
      for (var i = 0; i < list.length - 1; i++) {
        var x = list[i], y = list[i + 1];
        if (Math.abs(x.P - y.P) <= band && y.ease > x.ease) {
          list[i] = y; list[i + 1] = x; swapped = true;
        }
      }
    }
    return list;
  }

  /** 对任务数组打分并按并列规则链排序（不筛选状态，由调用方决定范围） */
  function rankTasks(tasks, settings) {
    var s = mergeSettings(settings);
    var out = tasks.map(function (t) { return evaluate(t, s); });
    out.sort(compareTasks);
    // 记录"先易后难"前的基础顺序，用于标记被提前的任务
    var baseOrder = out.map(function (t) { return t.id; });
    if (s.easyFirst) { out = applyEasyFirst(out, s.easyFirstBand); }
    out.forEach(function (t, i) {
      var j = baseOrder.indexOf(t.id);
      if (i < j) { t.easyBoost = true; }   // 因"先易后难"被提前
    });
    return out;
  }

  function mergeSettings(settings) {
    var s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    // 阈值合法性保护
    if (!(s.must > s.week && s.week > s.schedule && s.schedule > 0)) {
      s.must = 80; s.week = 50; s.schedule = 20;
    }
    if (!(s.tau > 0)) { s.tau = 7; }
    return s;
  }

  /** 预计耗时文本（分钟 -> 可读） */
  function fmtDuration(min) {
    if (!min || min <= 0) { return ''; }
    if (min < 60) { return min + '分钟'; }
    if (min % 60 === 0) { return (min / 60) + '小时'; }
    return Math.floor(min / 60) + '小时' + (min % 60) + '分';
  }

  return {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    IMPORTANCE_RUBRIC: IMPORTANCE_RUBRIC,
    URGENCY_RUBRIC: URGENCY_RUBRIC,
    DIFFICULTY_ANCHORS: DIFFICULTY_ANCHORS,
    DECISIONS: DECISIONS,
    clamp: clamp,
    round1: round1,
    urgencyFromDays: urgencyFromDays,
    urgencyFromLevel: urgencyFromLevel,
    importanceFromLevel: importanceFromLevel,
    easeFromDifficulty: easeFromDifficulty,
    daysUntil: daysUntil,
    evaluate: evaluate,
    decide: decide,
    compareTasks: compareTasks,
    applyEasyFirst: applyEasyFirst,
    rankTasks: rankTasks,
    mergeSettings: mergeSettings,
    fmtDuration: fmtDuration
  };
});
