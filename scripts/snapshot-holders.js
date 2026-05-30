#!/usr/bin/env node
/**
 * 集保戶股權分散 週快照（GitHub Action 每週五 22:00 台北時間執行）
 *
 * TDCC OpenAPI 2026 改版後：
 *   - 整包資料一次回傳（67k+ 筆 / ~4000 檔），不需 N 個請求
 *   - 欄位改繁中：證券代號 / 持股分級 / 人數 / 股數 / 占集保庫存數比例% / ﻿資料日期
 *   - StockNo 參數無效（不過濾）
 *   - 代號帶尾隨空白 ("2330  ")
 *
 * 流程：
 *  1. 一次 fetch TDCC 全部資料（~5-10 MB）
 *  2. groupBy 證券代號，計算每檔 5 個聚合指標：
 *     k1   = 千張大戶持股 % (>1000張, 持股分級=16)
 *     h400 = 400張以上持股 % (持股分級 13-16)
 *     h100 = 100張以上持股 % (持股分級 11-16)
 *     r20  = 散戶<20張持股 % (持股分級 1-5)
 *     n1k  = 千張大戶人數 (持股分級=16)
 *  3. 寫入 data/holders_history/<YYYY-WNN>.json
 *  4. 更新 latest.json + index.json
 *  5. 刪除超過 52 週的舊快照
 *
 * 環境變數：
 *   LIMIT=N        只輸出前 N 檔（測試用，已照代號數字排序，會跳過 ETF）
 */

const fs = require('fs').promises;
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'holders_history');
const KEEP_WEEKS = 52;

function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });

  console.log('Fetching TDCC bulk dataset...');
  const t0 = Date.now();
  const r = await fetch('https://openapi.tdcc.com.tw/v1/opendata/1-5', {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
  });
  if (!r.ok) throw new Error(`TDCC HTTP ${r.status}`);
  const all = await r.json();
  console.log(`Got ${all.length} records in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  if (!Array.isArray(all) || all.length === 0) {
    throw new Error('TDCC returned empty dataset');
  }

  // 依股票代號分組
  const groups = new Map();
  let scaDate = '';
  for (const rec of all) {
    const code = (rec['證券代號'] || '').trim();
    if (!code) continue;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(rec);
    if (!scaDate) {
      // 欄位名稱有 BOM 字元（U+FEFF）
      scaDate = rec['﻿資料日期'] || rec['資料日期'] || '';
    }
  }
  console.log(`Grouped into ${groups.size} unique stocks. ScaDate: ${scaDate}`);

  // 聚合每檔
  const stocksMap = {};
  for (const [code, recs] of groups) {
    const ratio = {};     // {level: ratio}
    const people = {};    // {level: people}
    for (const rec of recs) {
      const lv = parseInt(rec['持股分級']) || 0;
      if (lv === 17 || lv === 0) continue; // 跳過合計
      const p  = parseFloat(rec['占集保庫存數比例%']) || 0;
      const ppl= parseInt((rec['人數']||'0').replace(/,/g,'')) || 0;
      ratio[lv]  = (ratio[lv]  || 0) + p;
      people[lv] = (people[lv] || 0) + ppl;
    }
    // TDCC 持股分級：15=1,000,001股以上(千張大戶)、16=差異數調整、17=合計
    //   12=400,001-600,000 / 13=600,001-800,000 / 14=800,001-1,000,000
    //   10=100,001-200,000 / 11=200,001-400,000 / 1-5=1~20,000股(散戶<20張)
    const sumR = (...lvs) => lvs.reduce((s,lv) => s + (ratio[lv]||0), 0);
    const k1   = +sumR(15).toFixed(2);                  // 千張大戶 (>1000張)
    const h400 = +sumR(12,13,14,15).toFixed(2);         // 400張以上
    const h100 = +sumR(10,11,12,13,14,15).toFixed(2);   // 100張以上
    const r20  = +sumR(1,2,3,4,5).toFixed(2);           // 散戶<20張
    const n1k  = people[15] || 0;                       // 千張大戶人數
    // 全 0 的紀錄（沒有實際持股資料）跳過，避免污染快照
    if (k1 === 0 && h400 === 0 && h100 === 0 && r20 === 0 && n1k === 0) continue;
    stocksMap[code] = { k1, h400, h100, r20, n1k };
  }
  console.log(`Aggregated ${Object.keys(stocksMap).length} stocks with real data`);

  // LIMIT（依代號排序後取前 N，跳過 ETF "00" 開頭）
  let finalMap = stocksMap;
  const limit = parseInt(process.env.LIMIT) || 0;
  if (limit > 0) {
    const sortedCodes = Object.keys(stocksMap)
      .filter(c => !c.startsWith('00'))   // 跳過 ETF
      .filter(c => /^\d{4,6}$/.test(c))   // 只要 4-6 位數字（正股）
      .sort();
    finalMap = {};
    for (const c of sortedCodes.slice(0, limit)) finalMap[c] = stocksMap[c];
    console.log(`LIMIT=${limit} applied → ${Object.keys(finalMap).length} stocks`);
  }

  const week = isoWeek(new Date());
  const snapshot = {
    week,
    captured: todayISO(),
    scaDate,
    count: Object.keys(finalMap).length,
    stocks: finalMap
  };

  await fs.writeFile(path.join(DATA_DIR, `${week}.json`), JSON.stringify(snapshot));
  await fs.writeFile(path.join(DATA_DIR, 'latest.json'), JSON.stringify(snapshot));

  // 更新 index.json
  const files = (await fs.readdir(DATA_DIR))
    .filter(f => /^\d{4}-W\d{2}\.json$/.test(f))
    .sort();
  await fs.writeFile(
    path.join(DATA_DIR, 'index.json'),
    JSON.stringify({ weeks: files.map(f => f.replace('.json','')), updated: todayISO() }, null, 2)
  );

  // 刪舊週
  if (files.length > KEEP_WEEKS) {
    for (const f of files.slice(0, files.length - KEEP_WEEKS)) {
      await fs.unlink(path.join(DATA_DIR, f));
      console.log(`Deleted old: ${f}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✓ Snapshot ${week} written — ${snapshot.count} stocks, scaDate=${scaDate}, ${elapsed}s`);

  // 顯示樣本
  console.log('\nSample (台積電 2330):', JSON.stringify(stocksMap['2330'] || 'NOT FOUND'));
  console.log('Sample (鴻海 2317):', JSON.stringify(stocksMap['2317'] || 'NOT FOUND'));
  console.log('Sample (國巨 2327):', JSON.stringify(stocksMap['2327'] || 'NOT FOUND'));
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
