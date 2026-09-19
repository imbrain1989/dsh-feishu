// test/stock.test.js
// 行情解析 / 格式化 / 调度逻辑(纯函数,不联网;真实行情已在线验证)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  marketPrefix,
  parseTencentQuote,
  parseEastmoneyQuote,
  formatQuote,
} from '../plugins/stock-broadcast/quote.js';
import {
  normalizeTime,
  parseTimes,
  isWorkday,
  nowInShanghai,
  createStockScheduler,
} from '../plugins/stock-broadcast/scheduler.js';

// ---- 解析 ----

// 实测抓取的腾讯行情原始串(截取核心字段)
const TENCENT_RAW =
  'v_sz002432="51~九安医疗~002432~66.30~65.60~65.50~15044~7454~7578~66.28~30~66.27~2~66.25~17~66.24~7~66.23~1~66.30~1~66.31~1~66.32~1~66.33~25~66.34~6~~20260826093442~0.70~1.07~66.41~65.06~66.30/15044/99136462~15044~9913~0.36~5.42~~66.41~65.06~2.06~288.95~307.96~2.02~72.16~59.04";';

test('marketPrefix 推断沪/深', () => {
  assert.equal(marketPrefix('002432'), 'sz');
  assert.equal(marketPrefix('600519'), 'sh');
  assert.equal(marketPrefix('688981'), 'sh');
  assert.equal(marketPrefix('300750'), 'sz');
});

test('parseTencentQuote 解析真实字段', () => {
  const q = parseTencentQuote(TENCENT_RAW);
  assert.equal(q.name, '九安医疗');
  assert.equal(q.code, '002432');
  assert.equal(q.price, 66.3);
  assert.equal(q.prevClose, 65.6);
  assert.equal(q.open, 65.5);
  assert.equal(q.high, 66.41);
  assert.equal(q.low, 65.06);
  assert.equal(q.change, 0.7);
  assert.equal(q.changePct, 1.07);
  assert.equal(q.time, '2026-08-26 09:34:42');
});

test('parseEastmoneyQuote 解析东财 JSON', () => {
  const q = parseEastmoneyQuote({
    data: {
      f43: 66.3, f44: 66.41, f45: 65.06, f46: 65.5, f47: 15044,
      f48: 99136462.19, f57: '002432', f58: '九安医疗', f60: 65.6,
      f86: 1787708062, f169: 0.7, f170: 1.07,
    },
  });
  assert.equal(q.name, '九安医疗');
  assert.equal(q.price, 66.3);
  assert.equal(q.changePct, 1.07);
  assert.ok(q.amountWan > 0);
});

test('formatQuote 输出涨跌符号与关键字段', () => {
  const q = parseTencentQuote(TENCENT_RAW);
  const text = formatQuote(q);
  assert.ok(text.includes('九安医疗 (002432)'));
  assert.ok(text.includes('66.30'));
  assert.ok(text.includes('▲ +0.70 (+1.07%)'));
  assert.ok(text.includes('成交量:1.50万手'));
  const down = formatQuote({ ...q, change: -0.5, changePct: -0.76, price: 65.1 });
  assert.ok(down.includes('▼ -0.50 (-0.76%)'));
});

// ---- 时间与工作日 ----

test('normalizeTime / parseTimes 归一化用户输入', () => {
  assert.equal(normalizeTime('11.30'), '11:30');
  assert.equal(normalizeTime('9:5'), '09:05');
  assert.equal(normalizeTime('abc'), null);
  assert.deepEqual(parseTimes('09:35,10:30 11.30;13:00,13:00'), ['09:35', '10:30', '11:30', '13:00']);
});

test('isWorkday / nowInShanghai', () => {
  assert.equal(isWorkday(1), true);
  assert.equal(isWorkday(5), true);
  assert.equal(isWorkday(6), false);
  assert.equal(isWorkday(0), false);
  // 2026-08-26 是周三
  const n = nowInShanghai(new Date('2026-08-26T01:00:00Z'));
  assert.equal(n.weekday, 3);
  assert.ok(n.dateKey.startsWith('2026-08-26'));
  assert.equal(typeof n.hhmm, 'string');
});

// ---- 调度器(注入假时钟与假行情) ----

test('createStockScheduler:命中时间槽且工作日才推送,每槽每天一次', async () => {
  const sent = [];
  const fakeNow = () => ({ dateKey: '2026-08-26', weekday: 3, hhmm: '09:35' });
  const scheduler = createStockScheduler({
    enabled: true,
    times: ['09:35', '10:30'],
    code: '002432',
    intervalMs: 1000,
    now: fakeNow,
    send: async (t) => sent.push(t),
    fetchQuote: async () => ({ name: '九安医疗', code: '002432', price: 66.3, prevClose: 65.6, open: 65.5, high: 66.41, low: 65.06, change: 0.7, changePct: 1.07, volumeHand: 15044, amountWan: 9913, time: '2026-08-26 09:35:00' }),
  });
  try {
    scheduler.start();
    await new Promise((r) => setTimeout(r, 80)); // 等启动后首次 tick 完成
    assert.equal(sent.length, 1);
    await new Promise((r) => setTimeout(r, 2200)); // 再等 2 个周期,同一槽不重复推
    assert.equal(sent.length, 1, '同一时间槽只推一次');
  } finally {
    scheduler.stop();
  }
});

test('createStockScheduler:非工作日不推送', async () => {
  const sent = [];
  const scheduler = createStockScheduler({
    enabled: true,
    times: ['09:35'],
    code: '002432',
    intervalMs: 1000,
    now: () => ({ dateKey: '2026-08-29', weekday: 6, hhmm: '09:35' }),
    send: async (t) => sent.push(t),
    fetchQuote: async () => ({ name: 'x', code: '1', price: 1, prevClose: 1, open: 1, high: 1, low: 1, change: 0, changePct: 0, volumeHand: 0, amountWan: 0, time: '' }),
  });
  try {
    scheduler.start();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sent.length, 0);
  } finally {
    scheduler.stop();
  }
});
