#!/usr/bin/env node
/**
 * 因子回測 v1 — 法人連續買超 + 月營收 YoY + 黃金組合
 * ------------------------------------------------------------------
 * 沿用 backtest.js 的無偷看未來框架，但訊號改用「籌碼 + 基本面」因子：
 *
 *   C. inst   法人連續買超：三大法人(外資/投信/自營)當日合計淨買超的「連買天數」
 *   D. rev    月營收 YoY：as-of T 已公布(次月10號≤T)的最新月營收年增率
 *   E. combo  黃金組合：法人連買≥3 與 營收 YoY 的交叉
 *
 * 資料來源（FinMind 免 token）：
 *   法人  TaiwanStockInstitutionalInvestorsBuySell（每日，單位:股）
 *   營收  TaiwanStockMonthRevenue（每月）
 *   K線/大盤  Yahoo v8（與 backtest.js 相同）
 *
 * 防偷看未來：
 *   - 法人：只用 date ≤ T 的資料算連買天數
 *   - 營收：某月營收最晚次月10號公布 → 只採 knowableDate(次月10號) ≤ T 的營收
 *
 * 用法：node scripts/backtest-factors.js   (LIMIT=N / YEARS=n 可調)
 * 輸出：console 報表 + data/backtest/factors-latest.json
 */

const fs = require('fs').promises;
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'backtest');
const YEARS = parseInt(process.env.YEARS) || 2;
const HORIZONS = [5, 10, 20];
const YH_GAP = 180, FM_GAP = 350;
const BENCHMARK = '^TWII';

const UNIVERSE = [
  '2330','2317','2454','2308','2382','2412','2881','2882','2891','2303',
  '3711','2886','2884','2357','2885','3034','2892','2880','5880','2890',
  '2883','2002','2207','1303','1301','2603','3231','2379','3008','2327',
  '4938','6505','2301','3037','2345','2615','2609','1216','2912','1101',
  '5871','2395','3045','4904','6669','3661','3017','2376','2353','1326'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    const c = q.close?.[i], o = q.open?.[i];
    if (c == null || o == null) continue;
    out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c });
  }
  return out;
}

// ── FinMind ──
async function fetchFinMind(dataset, dataId, startDate) {
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=${dataset}&data_id=${dataId}&start_date=${startDate}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j.data || [];
}

// ── 法人連買：date → {net, streakBuy, streakSell} ──
function buildInstStreak(rows) {
  // 先把每日各法人別淨買超加總
  const byDate = new Map(); // date → net(股)
  for (const x of rows) {
    const net = (x.buy || 0) - (x.sell || 0);
    byDate.set(x.date, (byDate.get(x.date) || 0) + net);
  }
  const dates = [...byDate.keys()].sort();
  const map = {};
  let sb = 0, ss = 0;
  for (const d of dates) {
    const net = byDate.get(d);
    if (net > 0) { sb++; ss = 0; }
    else if (net < 0) { ss++; sb = 0; }
    else { sb = 0; ss = 0; }
    map[d] = { net, streakBuy: sb, streakSell: ss };
  }
  return { map, dates };
}

// ── 月營收 YoY：回傳 sorted [{knowable, yoy}] ──
function buildRevenueYoY(rows) {
  const revByKey = {}; // "Y-M" → revenue
  for (const x of rows) revByKey[`${x.revenue_year}-${x.revenue_month}`] = x.revenue;
  const recs = [];
  for (const x of rows) {
    const base = revByKey[`${x.revenue_year - 1}-${x.revenue_month}`];
    if (!base || base <= 0) continue;
    const yoy = (x.revenue / base - 1) * 100;
    // 某月營收(revenue_month=M, 1-index) 最晚次月10號公布
    // new Date(year, M, 10) 因 JS 月份 0-index 剛好是「次月10號」
    const knowable = new Date(x.revenue_year, x.revenue_month, 10).toISOString().slice(0, 10);
    recs.push({ knowable, yoy });
  }
  recs.sort((a, b) => a.knowable < b.knowable ? -1 : 1);
  return recs;
}
// as-of T：最新 knowable ≤ T 的 yoy
function yoyAsOf(recs, T) {
  let v = null;
  for (const r of recs) { if (r.knowable <= T) v = r.yoy; else break; }
  return v;
}
// 找最近的 ≤ T 法人 streak
function instAsOf(map, dates, T) {
  let d = null;
  for (const x of dates) { if (x <= T) d = x; else break; }
  return d ? map[d] : null;
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
  const codes = limit > 0 ? UNIVERSE.slice(0, limit) : UNIVERSE;
  const instStart = `${new Date().getFullYear() - YEARS}-01-01`;
  const revStart = `${new Date().getFullYear() - YEARS - 1}-01-01`; // YoY 需多一年基期

  console.log(`因子回測 v1 — 台灣50 (${codes.length} 檔), ${YEARS} 年, 持有 ${HORIZONS.join('/')} 交易日`);
  console.log('='.repeat(74));

  // 大盤
  let benchMap = {};
  try {
    const bench = await fetchYahoo(BENCHMARK, range);
    for (const d of bench) benchMap[d.date] = d.close;
    console.log(`大盤 ${BENCHMARK}: ${bench.length} 根`);
  } catch (e) { console.log(`大盤抓取失敗：${e.message}`); }
  await sleep(YH_GAP);

  // 逐檔抓 K線 + 法人 + 營收
  const data = {};
  let ok = 0, fail = 0, instFail = 0, revFail = 0;
  for (const code of codes) {
    const rec = {};
    try {
      rec.k = await fetchYahoo(`${code}.TW`, range);
      if (rec.k.length < 80) { fail++; continue; }
    } catch (e) { fail++; continue; }
    await sleep(YH_GAP);
    try { rec.inst = buildInstStreak(await fetchFinMind('TaiwanStockInstitutionalInvestorsBuySell', code, instStart)); }
    catch (e) { rec.inst = null; instFail++; }
    await sleep(FM_GAP);
    try { rec.rev = buildRevenueYoY(await fetchFinMind('TaiwanStockMonthRevenue', code, revStart)); }
    catch (e) { rec.rev = null; revFail++; }
    await sleep(FM_GAP);
    data[code] = rec; ok++;
  }
  console.log(`抓取完成：K線 ${ok} 檔（失敗 ${fail}）, 法人缺 ${instFail}, 營收缺 ${revFail}\n`);

  // 逐日產生樣本
  const maxH = Math.max(...HORIZONS);
  const buckets = { inst: {}, rev: {}, combo: {} };
  const baseline = {};
  const push = (sig, lbl, h, ret, excess) => {
    buckets[sig][lbl] = buckets[sig][lbl] || {};
    buckets[sig][lbl][h] = buckets[sig][lbl][h] || { ret: [], excess: [] };
    buckets[sig][lbl][h].ret.push(ret);
    if (excess != null) buckets[sig][lbl][h].excess.push(excess);
  };

  for (const code of Object.keys(data)) {
    const { k, inst, rev } = data[code];
    for (let i = 60; i < k.length - maxH; i++) {
      const T = k[i].date;

      // 因子 C：法人連買
      let instLbl = null;
      if (inst) {
        const s = instAsOf(inst.map, inst.dates, T);
        if (s) {
          if (s.streakBuy >= 5) instLbl = '連買≥5';
          else if (s.streakBuy >= 3) instLbl = '連買3-4';
          else if (s.streakBuy >= 1) instLbl = '連買1-2';
          else if (s.streakSell >= 3) instLbl = '連賣≥3';
          else instLbl = '其他';
        }
      }
      // 因子 D：營收 YoY
      let revLbl = null, yoy = null;
      if (rev) {
        yoy = yoyAsOf(rev, T);
        if (yoy != null) revLbl = yoy > 20 ? '高成長>20%' : yoy > 0 ? '成長0~20%' : '衰退<0%';
      }
      // 因子 E：黃金組合
      let comboLbl = null;
      if (inst && rev && yoy != null) {
        const s = instAsOf(inst.map, inst.dates, T);
        const buy3 = s && s.streakBuy >= 3;
        if (buy3 && yoy > 0) comboLbl = '連買≥3&營收增';
        else if (buy3 && yoy <= 0) comboLbl = '連買≥3&營收減';
        else if (!buy3 && yoy > 0) comboLbl = '無連買&營收增';
        else comboLbl = '其他';
      }

      for (const h of HORIZONS) {
        const fwd = (k[i + h].close / k[i].close - 1) * 100;
        let excess = null;
        const m0 = benchMap[k[i].date], mH = benchMap[k[i + h].date];
        if (m0 != null && mH != null) excess = fwd - (mH / m0 - 1) * 100;

        baseline[h] = baseline[h] || { ret: [] };
        baseline[h].ret.push(fwd);

        if (instLbl) push('inst', instLbl, h, fwd, excess);
        if (revLbl) push('rev', revLbl, h, fwd, excess);
        if (comboLbl) push('combo', comboLbl, h, fwd, excess);
      }
    }
  }

  // 報表
  const ORDER = {
    inst: ['連買≥5', '連買3-4', '連買1-2', '其他', '連賣≥3'],
    rev: ['高成長>20%', '成長0~20%', '衰退<0%'],
    combo: ['連買≥3&營收增', '連買≥3&營收減', '無連買&營收增', '其他']
  };
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  const f1 = x => (x >= 0 ? '+' : '') + x.toFixed(1);

  function printSignal(sig, title) {
    console.log(`\n■ ${title}`);
    for (const h of HORIZONS) {
      console.log(`  ── 持有 ${h} 交易日 ` + '─'.repeat(42));
      console.log('     ' + pad('級距', 16) + padL('樣本', 7) + padL('勝率%', 8) + padL('平均%', 8) + padL('中位%', 8) + padL('超額勝率%', 11) + padL('超額平均%', 11));
      for (const lbl of ORDER[sig]) {
        const cell = buckets[sig]?.[lbl]?.[h];
        if (!cell || !cell.ret.length) { console.log('     ' + pad(lbl, 16) + padL('—', 7)); continue; }
        const s = stats(cell.ret), e = statsExcess(cell.excess);
        console.log('     ' + pad(lbl, 16) + padL(s.n, 7) + padL(s.winRate.toFixed(1), 8) + padL(f1(s.avg), 8) + padL(f1(s.median), 8)
          + padL(e.n ? e.winRate.toFixed(1) : '—', 11) + padL(e.n ? f1(e.avg) : '—', 11));
      }
      const bs = stats(baseline[h].ret);
      console.log('     ' + pad('[全樣本基準]', 16) + padL(bs.n, 7) + padL(bs.winRate.toFixed(1), 8) + padL(f1(bs.avg), 8) + padL(f1(bs.median), 8));
    }
  }

  printSignal('inst', '因子 C：法人連續買超');
  printSignal('rev', '因子 D：月營收 YoY');
  printSignal('combo', '因子 E：黃金組合（法人連買 × 營收）');

  console.log('\n' + '='.repeat(74));
  console.log('判讀：級距「超額平均%」明顯為正且勝率贏過 [全樣本基準]，才代表該因子有 edge。');

  // JSON
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
  await fs.writeFile(path.join(OUT_DIR, 'factors-latest.json'), JSON.stringify({
    generated: new Date().toISOString(),
    config: { universe: '台灣50', count: ok, years: YEARS, horizons: HORIZONS, benchmark: BENCHMARK },
    baseline: baseJSON,
    signals: { inst: toJSON('inst'), rev: toJSON('rev'), combo: toJSON('combo') }
  }, null, 2));
  console.log('\n✓ 已寫入 data/backtest/factors-latest.json');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
