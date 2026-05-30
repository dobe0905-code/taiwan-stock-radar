#!/usr/bin/env node
/**
 * 短線技術面訊號回測 v1
 * ------------------------------------------------------------------
 * 目的：在「把短線狀態做進前端」之前，先用無偷看未來框架驗證
 *       純技術面訊號到底有沒有 forward edge。沒 edge 就不做。
 *
 * 測試的訊號族（皆以 ≤T 的日 K 計算，收盤進場，T→T+h 報酬）：
 *   A. ma_align  均線排列：多頭(MA5>MA10>MA20) / 空頭 / 糾結
 *   B. trend     趨勢強度：多頭排列且站上季線(MA60) / 空頭排列且跌破季線 / 其他
 *   C. breakout  突破：帶量突破20日高 / 無量突破 / 跌破20日低 / 區間內
 *   D. cross     均線交叉：MA5 上穿/下穿 MA20（只取交叉當日）
 *   E. macd      MACD：DIF 上穿/下穿 訊號線（只取交叉當日）
 *
 * 基準：同期 ^TWII，報「超額」= 個股報酬 − 大盤報酬
 * 判讀：某級距「超額平均%」明顯為正且勝率贏過 [全樣本基準]，才算有 edge
 *
 * 用法：node scripts/backtest-shortterm.js
 *       POOL=tw50|midsmall|all   YEARS=2   START/END(視窗)
 * 輸出：console 報表 + data/backtest/shortterm-latest.json
 */

const fs = require('fs').promises;
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'backtest');
const YEARS = parseInt(process.env.YEARS) || 2;
const HORIZONS = [5, 10, 20];
const YH_GAP = 150;
const BENCHMARK = '^TWII';
const START = process.env.START || '';
const END = process.env.END || '';
const useWindow = !!(START && END);
const POOL = (process.env.POOL || 'tw50').toLowerCase();

const TW50 = [
  '2330','2317','2454','2308','2382','2412','2881','2882','2891','2303',
  '3711','2886','2884','2357','2885','3034','2892','2880','5880','2890',
  '2883','2002','2207','1303','1301','2603','3231','2379','3008','2327',
  '4938','6505','2301','3037','2345','2615','2609','1216','2912','1101',
  '5871','2395','3045','4904','6669','3661','3017','2376','2353','1326'
];
const MIDSMALL = [
  '2059','2049','3596','9921','4551','6206','2231','1817','3293','5274',
  '4966','3443','3529','3533','3653','6196','9802','6603','8114','6188',
  '6412','8016','4935','6271','3105','6488','5483','8255','2360','3035',
  '1773','4736','8341','6285','3691','6491','6781','2492','6182','3217',
  '8021','5269','6770','6643','1565'
];
const POOLS = { tw50: TW50, midsmall: MIDSMALL, all: [...TW50, ...MIDSMALL] };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Yahoo v8 日 K（含 high/low/volume）──
async function fetchYahoo(symbol, range) {
  let qs;
  if (useWindow) {
    const p1 = Math.floor(new Date(START + 'T00:00:00Z').getTime() / 1000);
    const p2 = Math.floor(new Date(END + 'T23:59:59Z').getTime() / 1000);
    qs = `period1=${p1}&period2=${p2}&interval=1d`;
  } else {
    qs = `range=${range}&interval=1d`;
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error('no result');
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i], h = q.high?.[i], l = q.low?.[i], v = q.volume?.[i];
    if (c == null || h == null || l == null) continue;
    out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c, high: h, low: l, vol: v || 0 });
  }
  return out;
}
async function fetchYahooAuto(code, range) {
  let k = [];
  try { k = await fetchYahoo(`${code}.TW`, range); } catch (e) { k = []; }
  if (k.length >= 80) return k;
  await sleep(YH_GAP);
  try { const k2 = await fetchYahoo(`${code}.TWO`, range); if (k2.length > k.length) k = k2; } catch (e) {}
  return k;
}

// ── 指標 ──
function smaSeries(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
function emaSeries(arr, n) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    prev = prev == null ? arr[i] : arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function rsiSeries(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let avgG = 0, avgL = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    if (i <= n) { avgG += g / n; avgL += l / n; if (i === n) out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL); }
    else { avgG = (avgG * (n - 1) + g) / n; avgL = (avgL * (n - 1) + l) / n; out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL); }
  }
  return out;
}
// 滾動最高/最低（不含當日，prior n 日）
function rollExtreme(arr, n, fn) {
  const out = new Array(arr.length).fill(null);
  for (let i = 0; i < arr.length; i++) {
    if (i < n) continue;
    let v = arr[i - 1];
    for (let j = i - n; j < i; j++) v = fn(v, arr[j]);
    out[i] = v;
  }
  return out;
}

function buildIndicators(k) {
  const closes = k.map(d => d.close), highs = k.map(d => d.high), lows = k.map(d => d.low), vols = k.map(d => d.vol);
  const ma5 = smaSeries(closes, 5), ma10 = smaSeries(closes, 10), ma20 = smaSeries(closes, 20), ma60 = smaSeries(closes, 60);
  const vol20 = smaSeries(vols, 20);
  const high20 = rollExtreme(highs, 20, Math.max);
  const low20 = rollExtreme(lows, 20, Math.min);
  const rsi = rsiSeries(closes, 14);
  const ema12 = emaSeries(closes, 12), ema26 = emaSeries(closes, 26);
  const dif = closes.map((_, i) => ema12[i] - ema26[i]);
  const dem = emaSeries(dif, 9); // 訊號線
  return { closes, highs, lows, vols, ma5, ma10, ma20, ma60, vol20, high20, low20, rsi, dif, dem };
}

// ── 統計 ──
function stats(arr) {
  if (!arr.length) return { n: 0 };
  const n = arr.length, wins = arr.filter(x => x > 0).length;
  const avg = arr.reduce((a, b) => a + b, 0) / n;
  const sorted = [...arr].sort((a, b) => a - b);
  return { n, winRate: wins / n * 100, avg, median: sorted[Math.floor(n / 2)] };
}
function statsExcess(arr) {
  if (!arr.length) return { n: 0 };
  const n = arr.length, wins = arr.filter(x => x > 0).length;
  return { n, winRate: wins / n * 100, avg: arr.reduce((a, b) => a + b, 0) / n };
}

(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const range = `${YEARS}y`;
  const limit = parseInt(process.env.LIMIT) || 0;
  const universe = POOLS[POOL] || TW50;
  const codes = limit > 0 ? universe.slice(0, limit) : universe;
  const poolLabel = POOL === 'midsmall' ? '中小型股' : POOL === 'all' ? '台灣50+中小型' : '台灣50';
  const periodLabel = useWindow ? `${START} ~ ${END}` : `近 ${YEARS} 年`;

  console.log(`短線技術回測 v1 — ${poolLabel} (${codes.length} 檔), ${periodLabel}, 持有 ${HORIZONS.join('/')} 交易日`);
  console.log('='.repeat(78));

  let benchMap = {};
  try {
    const bench = await fetchYahoo(BENCHMARK, range);
    for (const d of bench) benchMap[d.date] = d.close;
    console.log(`大盤 ${BENCHMARK}: ${bench.length} 根`);
  } catch (e) { console.log(`大盤抓取失敗：${e.message}`); }
  await sleep(YH_GAP);

  const data = {};
  let ok = 0, fail = 0;
  for (const code of codes) {
    try {
      const k = await fetchYahooAuto(code, range);
      if (k.length < 90) { fail++; await sleep(YH_GAP); continue; }
      data[code] = { k, ind: buildIndicators(k) };
      ok++;
    } catch (e) { fail++; }
    await sleep(YH_GAP);
  }
  console.log(`抓取完成：${ok} 檔（失敗/不足 ${fail}）\n`);

  const maxH = Math.max(...HORIZONS);
  const buckets = {}; // sig → lbl → h → {ret,excess}
  const baseline = {};
  const push = (sig, lbl, h, ret, excess) => {
    buckets[sig] = buckets[sig] || {};
    buckets[sig][lbl] = buckets[sig][lbl] || {};
    buckets[sig][lbl][h] = buckets[sig][lbl][h] || { ret: [], excess: [] };
    buckets[sig][lbl][h].ret.push(ret);
    if (excess != null) buckets[sig][lbl][h].excess.push(excess);
  };

  for (const code of Object.keys(data)) {
    const { k, ind } = data[code];
    for (let i = 60; i < k.length - maxH; i++) {
      const { ma5, ma10, ma20, ma60, vol20, high20, low20, vols, closes } = ind;
      if (ma60[i] == null) continue;
      const c = closes[i];

      // A. 均線排列
      let aLbl;
      if (ma5[i] > ma10[i] && ma10[i] > ma20[i]) aLbl = '多頭排列';
      else if (ma5[i] < ma10[i] && ma10[i] < ma20[i]) aLbl = '空頭排列';
      else aLbl = '糾結';

      // B. 趨勢強度（含季線）
      let bLbl;
      if (aLbl === '多頭排列' && c > ma60[i]) bLbl = '強多(排列+站季線)';
      else if (aLbl === '空頭排列' && c < ma60[i]) bLbl = '強空(排列+破季線)';
      else bLbl = '中性';

      // C. 突破
      let cLbl;
      const volRatio = vol20[i] ? vols[i] / vol20[i] : 0;
      if (high20[i] != null && c > high20[i]) cLbl = volRatio >= 1.5 ? '帶量突破20日高' : '無量突破20日高';
      else if (low20[i] != null && c < low20[i]) cLbl = '跌破20日低';
      else cLbl = '區間內';

      // D. 均線交叉（只取交叉當日）
      let dLbl = null;
      if (ma5[i - 1] != null && ma20[i - 1] != null) {
        const prevDiff = ma5[i - 1] - ma20[i - 1], curDiff = ma5[i] - ma20[i];
        if (prevDiff <= 0 && curDiff > 0) dLbl = 'MA5上穿MA20(黃金)';
        else if (prevDiff >= 0 && curDiff < 0) dLbl = 'MA5下穿MA20(死亡)';
      }

      // E. MACD 交叉（只取交叉當日）
      let eLbl = null;
      const { dif, dem } = ind;
      if (dif[i - 1] != null && dem[i - 1] != null) {
        const prevD = dif[i - 1] - dem[i - 1], curD = dif[i] - dem[i];
        if (prevD <= 0 && curD > 0) eLbl = 'DIF上穿(MACD金叉)';
        else if (prevD >= 0 && curD < 0) eLbl = 'DIF下穿(MACD死叉)';
      }

      for (const h of HORIZONS) {
        const fwd = (closes[i + h] / c - 1) * 100;
        let excess = null;
        const m0 = benchMap[k[i].date], mH = benchMap[k[i + h].date];
        if (m0 != null && mH != null) excess = fwd - (mH / m0 - 1) * 100;
        baseline[h] = baseline[h] || { ret: [] };
        baseline[h].ret.push(fwd);
        push('ma_align', aLbl, h, fwd, excess);
        push('trend', bLbl, h, fwd, excess);
        push('breakout', cLbl, h, fwd, excess);
        if (dLbl) push('cross', dLbl, h, fwd, excess);
        if (eLbl) push('macd', eLbl, h, fwd, excess);
      }
    }
  }

  const ORDER = {
    ma_align: ['多頭排列', '糾結', '空頭排列'],
    trend: ['強多(排列+站季線)', '中性', '強空(排列+破季線)'],
    breakout: ['帶量突破20日高', '無量突破20日高', '區間內', '跌破20日低'],
    cross: ['MA5上穿MA20(黃金)', 'MA5下穿MA20(死亡)'],
    macd: ['DIF上穿(MACD金叉)', 'DIF下穿(MACD死叉)']
  };
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  const f1 = x => (x >= 0 ? '+' : '') + x.toFixed(1);

  function printSignal(sig, title) {
    console.log(`\n■ ${title}`);
    for (const h of HORIZONS) {
      console.log(`  ── 持有 ${h} 交易日 ` + '─'.repeat(46));
      console.log('     ' + pad('級距', 22) + padL('樣本', 7) + padL('勝率%', 8) + padL('平均%', 8) + padL('中位%', 8) + padL('超額勝率%', 11) + padL('超額平均%', 11));
      for (const lbl of ORDER[sig]) {
        const cell = buckets[sig]?.[lbl]?.[h];
        if (!cell || !cell.ret.length) { console.log('     ' + pad(lbl, 22) + padL('—', 7)); continue; }
        const s = stats(cell.ret), e = statsExcess(cell.excess);
        console.log('     ' + pad(lbl, 22) + padL(s.n, 7) + padL(s.winRate.toFixed(1), 8) + padL(f1(s.avg), 8) + padL(f1(s.median), 8)
          + padL(e.n ? e.winRate.toFixed(1) : '—', 11) + padL(e.n ? f1(e.avg) : '—', 11));
      }
      const bs = stats(baseline[h].ret);
      console.log('     ' + pad('[全樣本基準]', 22) + padL(bs.n, 7) + padL(bs.winRate.toFixed(1), 8) + padL(f1(bs.avg), 8) + padL(f1(bs.median), 8));
    }
  }

  printSignal('ma_align', '訊號 A：均線排列');
  printSignal('trend', '訊號 B：趨勢強度（排列＋季線）');
  printSignal('breakout', '訊號 C：突破/跌破');
  printSignal('cross', '訊號 D：均線交叉（事件型）');
  printSignal('macd', '訊號 E：MACD 交叉（事件型）');

  console.log('\n' + '='.repeat(78));
  console.log('判讀：級距「超額平均%」明顯為正且勝率贏過 [全樣本基準]，才代表該短線狀態有 edge。');

  const toJSON = (sig) => {
    const o = {};
    for (const lbl of ORDER[sig]) {
      const obj = {};
      for (const h of HORIZONS) {
        const cell = buckets[sig]?.[lbl]?.[h];
        if (!cell) continue;
        const s = stats(cell.ret), e = statsExcess(cell.excess);
        obj[h] = { n: s.n, winRate: +s.winRate.toFixed(2), avg: +s.avg.toFixed(3), median: +s.median.toFixed(3), excessWinRate: e.n ? +e.winRate.toFixed(2) : null, excessAvg: e.n ? +e.avg.toFixed(3) : null };
      }
      o[lbl] = obj;
    }
    return o;
  };
  const baseJSON = {};
  for (const h of HORIZONS) { const s = stats(baseline[h].ret); baseJSON[h] = { n: s.n, winRate: +s.winRate.toFixed(2), avg: +s.avg.toFixed(3), median: +s.median.toFixed(3) }; }

  let outName = 'shortterm-latest.json';
  if (POOL !== 'tw50') outName = `shortterm-${POOL}.json`;
  if (useWindow) outName = `shortterm-window-${START}_${END}.json`;
  await fs.writeFile(path.join(OUT_DIR, outName), JSON.stringify({
    generated: new Date().toISOString(),
    config: { universe: poolLabel, pool: POOL, count: ok, window: useWindow ? { start: START, end: END } : null, years: useWindow ? null : YEARS, horizons: HORIZONS, benchmark: BENCHMARK },
    baseline: baseJSON,
    signals: { ma_align: toJSON('ma_align'), trend: toJSON('trend'), breakout: toJSON('breakout'), cross: toJSON('cross'), macd: toJSON('macd') }
  }, null, 2));
  console.log(`\n✓ 已寫入 data/backtest/${outName}`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
