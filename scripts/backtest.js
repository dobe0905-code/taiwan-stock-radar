#!/usr/bin/env node
/**
 * 選股訊號回測框架 v1
 * ------------------------------------------------------------------
 * 目的：用歷史日 K 線，驗證「選股訊號」買進後 5/10/20 個交易日的
 *       勝率與平均報酬，並對照大盤(^TWII)同期報酬算超額報酬。
 *
 * 嚴格無偷看未來(no lookahead)：
 *   - 每個歷史交易日 T 只用「T 當天及之前」的資料計算訊號
 *   - 答案 = 往後 H 個交易日的報酬 (close[T+H]/close[T]-1)
 *
 * 並列比較兩個訊號：
 *   A. calcSig         — 目前前端 index.html 表格用的單日快照訊號
 *                        (歷史 PER/換手率取不到 → 以 null/0 帶入，僅供結構比較)
 *   B. momentum        — 乾淨的多時間框動能/相對強度基準
 *
 * 用法：
 *   node scripts/backtest.js            # 台灣50，2 年
 *   YEARS=1 node scripts/backtest.js    # 改回測年數
 *   LIMIT=10 node scripts/backtest.js   # 只跑前 N 檔（除錯用）
 *
 * 輸出：
 *   - console 報表
 *   - data/backtest/latest.json
 */

const fs = require('fs').promises;
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'backtest');
const YEARS = parseInt(process.env.YEARS) || 2;
const HORIZONS = [5, 10, 20];          // 持有 N 個交易日
const FETCH_GAP_MS = 180;              // Yahoo 限流保護
const BENCHMARK = '^TWII';             // 大盤對照

// 台灣50 成分股（全上市 → Yahoo 後綴 .TW）
const UNIVERSE = [
  '2330','2317','2454','2308','2382','2412','2881','2882','2891','2303',
  '3711','2886','2884','2357','2885','3034','2892','2880','5880','2890',
  '2883','2002','2207','1303','1301','2603','3231','2379','3008','2327',
  '4938','6505','2301','3037','2345','2615','2609','1216','2912','1101',
  '5871','2395','3045','4904','6669','3661','3017','2376','2353','1326'
];

// ── Yahoo v8 日 K ──
async function fetchYahoo(symbol, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error('no result');
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i], o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], v = q.volume?.[i];
    if (c == null || o == null) continue; // 跳過休市/缺值
    const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    out.push({ date: d, open: o, high: h, low: l, close: c, volume: v || 0 });
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 訊號 A：calcSig（從 index.html 原樣複製）──
// 注意：回測時 peV=null, turn=0（歷史值取不到），ff 不用
function calcSig({ open, close, high, low, chgP, peV, turn, ff = 0 }) {
  let sc = 0; const rs = [];
  if (chgP > 3) { sc += 3; rs.push('強勢上漲'); }
  else if (chgP > 1) { sc += 2; }
  else if (chgP > 0) { sc += 1; }
  else if (chgP < -3) { sc -= 3; }
  else if (chgP < -1) { sc -= 2; }
  else if (chgP < 0) { sc -= 1; }
  if (high > low) { const pos = (close - low) / (high - low); if (pos > .8) sc += 1; else if (pos < .2) sc -= 1; }
  if (turn > 1.5) sc += 1;
  if (peV && peV > 0) { if (peV < 12) sc += 1; else if (peV > 40) sc -= 1; }
  const lbl = sc >= 3 ? '買進' : sc >= 1 ? '偏多' : sc <= -3 ? '賣出' : sc <= -1 ? '偏空' : '觀察';
  return { sc, lbl };
}

// ── 訊號 B：乾淨多時間框動能基準 ──
// 只用 closes[0..i]（含 i）算，i 為「今日」
function momentumSignal(closes, i) {
  if (i < 60) return null;
  const cur = closes[i];
  const avg = (a, b) => { let s = 0; for (let k = a; k <= b; k++) s += closes[k]; return s / (b - a + 1); };
  const ma20 = avg(i - 19, i);
  const ma60 = avg(i - 59, i);
  const ret20 = (cur / closes[i - 20] - 1) * 100;
  let hi60 = -Infinity; for (let k = i - 59; k <= i; k++) if (closes[k] > hi60) hi60 = closes[k];
  const distHi = (cur / hi60 - 1) * 100; // ≤ 0；越接近 0 = 越靠近 60 日高
  let sc = 0;
  if (cur > ma20) sc++;
  if (ma20 > ma60) sc++;
  if (ret20 > 0) sc++;
  if (ret20 > 10) sc++;
  if (distHi > -3) sc++; // 距 60 日高 < 3%
  const lbl = sc >= 4 ? '強動能' : sc >= 2 ? '中性' : '弱動能';
  return { sc, lbl };
}

// ── 統計工具 ──
function stats(arr) {
  if (!arr.length) return { n: 0 };
  const n = arr.length;
  const wins = arr.filter(x => x > 0).length;
  const avg = arr.reduce((a, b) => a + b, 0) / n;
  const sorted = [...arr].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  return { n, winRate: wins / n * 100, avg, median };
}
function statsExcess(arr) {
  if (!arr.length) return { n: 0 };
  const n = arr.length;
  const wins = arr.filter(x => x > 0).length;
  const avg = arr.reduce((a, b) => a + b, 0) / n;
  return { n, winRate: wins / n * 100, avg };
}

(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const range = `${YEARS}y`;
  const limit = parseInt(process.env.LIMIT) || 0;
  const codes = limit > 0 ? UNIVERSE.slice(0, limit) : UNIVERSE;

  console.log(`回測框架 v1 — 台灣50 (${codes.length} 檔), ${YEARS} 年, 持有 ${HORIZONS.join('/')} 交易日`);
  console.log('='.repeat(70));

  // 1) 大盤基準
  console.log(`抓取大盤 ${BENCHMARK} ...`);
  let benchMap = {};
  try {
    const bench = await fetchYahoo(BENCHMARK, range);
    for (const d of bench) benchMap[d.date] = d.close;
    console.log(`  ${bench.length} 根`);
  } catch (e) { console.log(`  大盤抓取失敗：${e.message}（超額報酬將略過）`); }
  await sleep(FETCH_GAP_MS);

  // 2) 逐檔抓 K 線
  const series = {};
  let ok = 0, fail = 0;
  for (const code of codes) {
    try {
      const d = await fetchYahoo(`${code}.TW`, range);
      if (d.length >= 80) { series[code] = d; ok++; }
      else { fail++; }
    } catch (e) { fail++; }
    await sleep(FETCH_GAP_MS);
  }
  console.log(`K 線抓取完成：成功 ${ok} / 失敗 ${fail}\n`);

  // 3) 逐日產生樣本（無偷看未來）
  //    buckets[signal][label][horizon] = { ret:[], excess:[] }
  const maxH = Math.max(...HORIZONS);
  const buckets = { calcSig: {}, momentum: {} };
  const baseline = {}; // 全樣本無條件報酬（對照基準）

  const push = (sig, lbl, h, ret, excess) => {
    buckets[sig][lbl] = buckets[sig][lbl] || {};
    buckets[sig][lbl][h] = buckets[sig][lbl][h] || { ret: [], excess: [] };
    buckets[sig][lbl][h].ret.push(ret);
    if (excess != null) buckets[sig][lbl][h].excess.push(excess);
  };

  for (const code of Object.keys(series)) {
    const d = series[code];
    const closes = d.map(x => x.close);
    for (let i = 60; i < d.length - maxH; i++) {
      const row = d[i];
      const prev = d[i - 1].close;
      const chgP = (row.close - prev) / prev * 100;

      // 訊號 A：calcSig（peV=null, turn=0）
      const a = calcSig({ open: row.open, close: row.close, high: row.high, low: row.low, chgP, peV: null, turn: 0 });
      // 訊號 B：動能
      const b = momentumSignal(closes, i);

      for (const h of HORIZONS) {
        const fwd = (d[i + h].close / row.close - 1) * 100;
        // 大盤同期（用交易日對應的日期字串）
        let excess = null;
        const m0 = benchMap[d[i].date], mH = benchMap[d[i + h].date];
        if (m0 != null && mH != null) excess = fwd - (mH / m0 - 1) * 100;

        // 全樣本基準
        baseline[h] = baseline[h] || { ret: [], excess: [] };
        baseline[h].ret.push(fwd);
        if (excess != null) baseline[h].excess.push(excess);

        push('calcSig', a.lbl, h, fwd, excess);
        if (b) push('momentum', b.lbl, h, fwd, excess);
      }
    }
  }

  // 4) 報表
  const ORDER = { calcSig: ['買進', '偏多', '觀察', '偏空', '賣出'], momentum: ['強動能', '中性', '弱動能'] };
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  const f1 = x => (x >= 0 ? '+' : '') + x.toFixed(1);

  function printSignal(sig, note) {
    console.log(`\n■ 訊號：${sig}${note ? '  ' + note : ''}`);
    for (const h of HORIZONS) {
      console.log(`  ── 持有 ${h} 交易日 ` + '─'.repeat(40));
      console.log('     ' + pad('級距', 8) + padL('樣本', 7) + padL('勝率%', 9) + padL('平均%', 9) + padL('中位%', 9) + padL('超額勝率%', 11) + padL('超額平均%', 11));
      for (const lbl of ORDER[sig]) {
        const cell = buckets[sig]?.[lbl]?.[h];
        if (!cell || !cell.ret.length) { console.log('     ' + pad(lbl, 8) + padL('—', 7)); continue; }
        const s = stats(cell.ret);
        const e = statsExcess(cell.excess);
        console.log('     ' + pad(lbl, 8) + padL(s.n, 7) + padL(s.winRate.toFixed(1), 9) + padL(f1(s.avg), 9) + padL(f1(s.median), 9)
          + padL(e.n ? e.winRate.toFixed(1) : '—', 11) + padL(e.n ? f1(e.avg) : '—', 11));
      }
      // 全樣本基準
      const bs = stats(baseline[h].ret);
      console.log('     ' + pad('[全樣本]', 8) + padL(bs.n, 7) + padL(bs.winRate.toFixed(1), 9) + padL(f1(bs.avg), 9) + padL(f1(bs.median), 9));
    }
  }

  printSignal('calcSig', '(歷史 PER=null, 換手率=0)');
  printSignal('momentum');

  console.log('\n' + '='.repeat(70));
  console.log('判讀：某級距「平均%」「勝率%」要明顯贏過 [全樣本] 基準，且「超額平均%」為正，');
  console.log('      才代表這個訊號真的有 edge；否則只是跟著大盤走。');

  // 5) 輸出 JSON
  const toJSON = (sig) => {
    const o = {};
    for (const lbl of ORDER[sig]) {
      o[lbl] = {};
      for (const h of HORIZONS) {
        const cell = buckets[sig]?.[lbl]?.[h];
        if (!cell) continue;
        const s = stats(cell.ret), e = statsExcess(cell.excess);
        o[lbl][h] = { n: s.n, winRate: +(s.winRate || 0).toFixed(2), avg: +(s.avg || 0).toFixed(3), median: +(s.median || 0).toFixed(3), excessWinRate: e.n ? +e.winRate.toFixed(2) : null, excessAvg: e.n ? +e.avg.toFixed(3) : null };
      }
    }
    return o;
  };
  const baseJSON = {};
  for (const h of HORIZONS) { const s = stats(baseline[h].ret); baseJSON[h] = { n: s.n, winRate: +s.winRate.toFixed(2), avg: +s.avg.toFixed(3), median: +s.median.toFixed(3) }; }

  const out = {
    generated: new Date().toISOString(),
    config: { universe: '台灣50', count: ok, years: YEARS, horizons: HORIZONS, benchmark: BENCHMARK },
    baseline: baseJSON,
    signals: { calcSig: toJSON('calcSig'), momentum: toJSON('momentum') }
  };
  await fs.writeFile(path.join(OUT_DIR, 'latest.json'), JSON.stringify(out, null, 2));
  console.log(`\n✓ 已寫入 data/backtest/latest.json`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
