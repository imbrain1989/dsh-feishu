// plugins/stock-broadcast/quote.js
// A 股实时行情:腾讯行情(qt.gtimg.cn)为主,东方财富(push2.eastmoney.com)兜底。
// 免费数据源,无需 Key;数据仅供个人参考,实时性约 3~5 秒。

const TENCNET_BASE = 'https://qt.gtimg.cn/q=';
const EASTMONEY_BASE = 'https://push2.eastmoney.com/api/qt/stock/get';

/** 由 6 位代码推断市场前缀:6/9/5 开头为沪(sh),其余为深(sz)。 */
export function marketPrefix(code) {
  return /^[695]/.test(code) ? 'sh' : 'sz';
}

/** 解析腾讯行情文本(v_sz002432="...") */
export function parseTencentQuote(raw) {
  const m = String(raw).match(/"([^"]+)"/);
  if (!m) throw new Error('腾讯行情响应格式异常');
  const f = m[1].split('~');
  if (f.length < 40) throw new Error(`腾讯行情字段不足(${f.length})`);
  const num = (i) => parseFloat(f[i]) || 0;
  const rawTime = f[30] ?? '';
  const time =
    rawTime.length >= 14
      ? `${rawTime.slice(0, 4)}-${rawTime.slice(4, 6)}-${rawTime.slice(6, 8)} ${rawTime.slice(8, 10)}:${rawTime.slice(10, 12)}:${rawTime.slice(12, 14)}`
      : rawTime;
  return {
    source: 'tencent',
    name: f[1],
    code: f[2],
    price: num(3),
    prevClose: num(4),
    open: num(5),
    high: num(33),
    low: num(34),
    change: num(31),
    changePct: num(32),
    volumeHand: num(36),
    amountWan: num(37),
    turnoverPct: num(38),
    floatMarketCapYi: num(44),
    totalMarketCapYi: num(45),
    time,
  };
}

/** 解析东方财富 JSON(fltt=2 已是原始数值) */
export function parseEastmoneyQuote(json) {
  const d = json?.data;
  if (!d) throw new Error('东财行情响应无 data');
  const num = (v) => parseFloat(v) || 0;
  return {
    source: 'eastmoney',
    name: d.f58 ?? '',
    code: d.f57 ?? '',
    price: num(d.f43),
    prevClose: num(d.f60),
    open: num(d.f46),
    high: num(d.f44),
    low: num(d.f45),
    change: num(d.f169),
    changePct: num(d.f170),
    volumeHand: num(d.f47),
    amountWan: num(d.f48) / 10000,
    time: d.f86 ? new Date(d.f86 * 1000).toISOString().slice(0, 19).replace('T', ' ') : '',
  };
}

/** 获取实时行情(腾讯 → 东财兜底) */
export async function getStockQuote(code) {
  const prefix = marketPrefix(code);
  try {
    const res = await fetch(`${TENCNET_BASE}${prefix}${code}`, { signal: AbortSignal.timeout(10000) });
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    return parseTencentQuote(text);
  } catch (err) {
    const res = await fetch(
      `${EASTMONEY_BASE}?secid=${prefix === 'sh' ? 1 : 0}.${code}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f169,f170&fltt=2&invt=2`,
      { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    return parseEastmoneyQuote(await res.json());
  }
}

/** 格式化行情为飞书文本(涨跌色标:▲ 红涨 / ▼ 绿跌,符合A股习惯) */
export function formatQuote(q) {
  const up = q.change >= 0;
  const arrow = up ? '▲' : '▼';
  const sign = up ? '+' : '';
  const amount = q.amountWan >= 10000 ? `${(q.amountWan / 10000).toFixed(2)}亿` : `${q.amountWan.toFixed(0)}万`;
  const volume = q.volumeHand >= 10000 ? `${(q.volumeHand / 10000).toFixed(2)}万手` : `${q.volumeHand.toFixed(0)}手`;
  return [
    `📈 ${q.name} (${q.code})  ${q.time}`,
    `现价:${q.price.toFixed(2)}  ${arrow} ${sign}${q.change.toFixed(2)} (${sign}${q.changePct.toFixed(2)}%)`,
    `今开:${q.open.toFixed(2)}  昨收:${q.prevClose.toFixed(2)}`,
    `最高:${q.high.toFixed(2)}  最低:${q.low.toFixed(2)}`,
    `成交量:${volume}  成交额:${amount}`,
  ].join('\n');
}
