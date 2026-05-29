#!/usr/bin/env node
/**
 * 集保戶股權分散 週快照（GitHub Action 每週五 22:00 台北時間執行）
 *
 * 流程：
 *  1. 從 TWSE / TPEx 取得所有上市櫃股票代號清單
 *  2. 對每檔股票呼叫 TDCC OpenAPI 1-5 端點，計算 5 個聚合指標：
 *     k1   = 千張大戶持股 % (>1000張)
 *     h400 = 400張以上持股 %
 *     h100 = 100張以上持股 %
 *     r20  = 散戶<20張持股 %
 *     n1k  = 千張大戶人數
 *  3. 把全部結果寫入 data/holders_history/<YYYY-WNN>.json
 *  4. 更新 data/holders_history/latest.json 與 index.json
 *  5. 刪除超過 52 週的舊快照
 *
 * 直接執行：node scripts/snapshot-holders.js
 * 環境變數：
 *   LIMIT=N        只跑前 N 檔（測試用）
 *   STOCK_LIST=... 自訂股票清單（逗號分隔），跳過 TWSE/TPEx 抓清單
 */

const fs = require('fs').promises;
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'holders_history');
const KEEP_WEEKS = 52;
const CONCURRENCY = 10;          // 同時抓幾檔（TDCC 沒明確 rate limit，保守一點）
const REQUEST_TIMEOUT_MS = 15000;

// ───────────────────────────────────────────────────────
// utils
// ───────────────────────────────────────────────────────
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
async function fetchWithTimeout(url, opts = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ───────────────────────────────────────────────────────
// 取得全部上市櫃股票清單
// ───────────────────────────────────────────────────────
async function fetchStockList() {
  if (process.env.STOCK_LIST) {
    return process.env.STOCK_LIST.split(',').map(s => s.trim()).filter(Boolean);
  }
  const ids = new Set();

  // TWSE 上市
  try {
    const r = await fetchWithTimeout(
      'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
      { headers: { 'Accept': 'application/json' } }
    );
    if (r.ok) {
      const arr = await r.json();
      for (const x of arr) {
        if (x.Code && /^\d{4,6}$/.test(x.Code)) ids.add(x.Code);
      }
      console.log(`TWSE: ${ids.size} stocks`);
    }
  } catch (e) { console.warn('TWSE list failed:', e.message); }

  // TPEx 上櫃
  try {
    const r = await fetchWithTimeout(
      'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
      { headers: { 'Accept': 'application/json' } }
    );
    if (r.ok) {
      const arr = await r.json();
      const before = ids.size;
      for (const x of arr) {
        if (x.SecuritiesCompanyCode && /^\d{4,6}$/.test(x.SecuritiesCompanyCode)) {
          ids.add(x.SecuritiesCompanyCode);
        }
      }
      console.log(`TPEx: +${ids.size - before} stocks`);
    }
  } catch (e) { console.warn('TPEx list failed:', e.message); }

  return [...ids].sort();
}

// ───────────────────────────────────────────────────────
// TDCC 抓單檔股權分散 + 聚合
// ───────────────────────────────────────────────────────
async function fetchHolders(stockId) {
  const url = `https://openapi.tdcc.com.tw/v1/opendata/1-5?StockNo=${stockId}`;
  const r = await fetchWithTimeout(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
  });
  if (!r.ok) return null;
  const data = await r.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  // 用 HolderNum 直接歸組
  const ratioByLevel = {};
  const peopleByLevel = {};
  for (const d of data) {
    if (d.HolderNum === '17') continue; // 跳過合計
    const lv = parseInt(d.HolderNum) || 0;
    const ratio = parseFloat(d.Percent) || 0;
    const people = parseInt((d.People || '0').replace(/,/g, '')) || 0;
    ratioByLevel[lv]  = (ratioByLevel[lv]  || 0) + ratio;
    peopleByLevel[lv] = (peopleByLevel[lv] || 0) + people;
  }
  const sumR = (...lvs) => lvs.reduce((s, lv) => s + (ratioByLevel[lv] || 0), 0);

  return {
    scaDate: data[0]?.ScaDate || '',
    k1:   +sumR(16).toFixed(2),                  // 千張大戶
    h400: +sumR(13,14,15,16).toFixed(2),         // 400張+
    h100: +sumR(11,12,13,14,15,16).toFixed(2),   // 100張+ (嚴格)
    r20:  +sumR(1,2,3,4,5).toFixed(2),           // 散戶<20張
    n1k:  peopleByLevel[16] || 0,                // 千張大戶人數
  };
}

// ───────────────────────────────────────────────────────
// 並行控制
// ───────────────────────────────────────────────────────
async function mapPool(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ───────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────
(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const stocks = await fetchStockList();
  const limit = parseInt(process.env.LIMIT) || stocks.length;
  const target = stocks.slice(0, limit);
  console.log(`Snapshot target: ${target.length} stocks, concurrency=${CONCURRENCY}`);

  let okCount = 0, failCount = 0;
  const stocksMap = {};
  let scaDate = '';

  const t0 = Date.now();
  await mapPool(target, async (id, i) => {
    if (i > 0 && i % 200 === 0) {
      console.log(`Progress: ${i}/${target.length} (ok=${okCount}, fail=${failCount}) — ${((Date.now()-t0)/1000).toFixed(0)}s`);
    }
    const h = await fetchHolders(id);
    if (h) {
      stocksMap[id] = { k1: h.k1, h400: h.h400, h100: h.h100, r20: h.r20, n1k: h.n1k };
      if (!scaDate && h.scaDate) scaDate = h.scaDate;
      okCount++;
    } else {
      failCount++;
    }
  }, CONCURRENCY);

  const week = isoWeek(new Date());
  const snapshot = {
    week,
    captured: todayISO(),
    scaDate,
    count: okCount,
    stocks: stocksMap
  };

  const weekFile = path.join(DATA_DIR, `${week}.json`);
  await fs.writeFile(weekFile, JSON.stringify(snapshot));
  await fs.writeFile(path.join(DATA_DIR, 'latest.json'), JSON.stringify(snapshot));

  // 更新 index.json
  const files = (await fs.readdir(DATA_DIR))
    .filter(f => /^\d{4}-W\d{2}\.json$/.test(f))
    .sort();
  const indexJson = {
    weeks: files.map(f => f.replace('.json', '')),
    updated: todayISO()
  };
  await fs.writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify(indexJson, null, 2));

  // 刪除超過 KEEP_WEEKS 的舊快照
  if (files.length > KEEP_WEEKS) {
    const toDelete = files.slice(0, files.length - KEEP_WEEKS);
    for (const f of toDelete) {
      await fs.unlink(path.join(DATA_DIR, f));
      console.log(`Deleted old snapshot: ${f}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✓ Snapshot ${week} written — ok=${okCount}, fail=${failCount}, ${elapsed}s`);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
