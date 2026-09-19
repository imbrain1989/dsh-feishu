// plugins/stock-broadcast/scheduler.js
// 定时股价播报调度逻辑(纯函数 + 调度器,便于离线测试)

import { getStockQuote, formatQuote } from './quote.js';

/** 归一化时间 "11.30" / "9:5" → "11:30" / "09:05";非法返回 null */
export function normalizeTime(t) {
  const m = String(t).replace(/\./g, ':').match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  return `${String(parseInt(m[1], 10)).padStart(2, '0')}:${String(parseInt(m[2], 10)).padStart(2, '0')}`;
}

/** 解析 "09:35,10:30 11.30" → 排序去重后的 ['09:35','10:30','11:30'] */
export function parseTimes(str) {
  return [...new Set(String(str).split(/[,，;；\s]+/).map(normalizeTime).filter(Boolean))].sort();
}

/** 取指定时刻的上海时区信息(工作日判断与触发以北京时间为准) */
export function nowInShanghai(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: weekdayMap[parts.weekday] ?? 0,
    hhmm: `${parts.hour}:${parts.minute}`,
  };
}

/** 是否为工作日(周一~周五;法定节假日调休未处理,如需精确可接节假日 API) */
export function isWorkday(weekday) {
  return weekday >= 1 && weekday <= 5;
}

/**
 * 创建定时股价播报调度器:工作日且当前 HH:MM 命中时间槽时,拉取行情并推送(每个时间槽每天只推一次)。
 * @param {object} opts { enabled, times, code, intervalMs, now, send, fetchQuote }
 */
export function createStockScheduler({
  enabled = true,
  times = [],
  code,
  intervalMs = 20000,
  now = nowInShanghai,
  send = null,
  fetchQuote = getStockQuote,
} = {}) {
  const sent = new Set();
  let timer = null;
  let lastDateKey = '';

  async function tick() {
    const n = now();
    if (n.dateKey !== lastDateKey) {
      sent.clear();
      lastDateKey = n.dateKey;
    }
    if (!enabled || !isWorkday(n.weekday) || !times.includes(n.hhmm)) return;
    const key = `${n.dateKey} ${n.hhmm}`;
    if (sent.has(key)) return;
    sent.add(key);
    try {
      const quote = await fetchQuote(code);
      const text = formatQuote(quote);
      console.log(`📈 定时股价(${n.hhmm}):\n${text}`);
      if (send) await send(text);
    } catch (err) {
      console.error('❌ 股价推送失败:', err.message);
    }
  }

  return {
    start() {
      if (!timer) {
        timer = setInterval(tick, intervalMs);
        tick(); // 启动即检查一次(命中当前时间槽则立即推送)
      }
      return this;
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      return this;
    },
  };
}
