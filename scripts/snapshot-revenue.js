#!/usr/bin/env node
/**
 * 全市場月營收 YoY 快照（GitHub Action 每月 11 號 台北時間執行）
 * ------------------------------------------------------------------
 * 背景：回測證實「月營收 YoY」是台股目前唯一驗證有效的選股因子
 *   - 高成長(>20%) 20日對大盤超額 +1.3%、勝率 61%
 *   - 衰退(<0%)   穩定跑輸大盤 -3.3%
 *
 * 來源（bulk、免 token、官方已算好 YoY）：
 *   上市 https://openapi.twse.com.tw/v1/opendata/t187ap05_L (~1078 檔)
 *   上櫃 https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O (~887 檔)
 *
 * 欄位：
 *   公司代號 / 公司名稱 / 產業別 / 資料年月(ROC) /
 *   營業收入-當月營收(千元) / 營業收入-去年同月增減(%)=YoY /
 *   營業收入-上月比較增減(%)=MoM / 累計營業收入-前期比較增減(%)=累計YoY
 *
 * 產出 data/revenue/latest.json：
 *   { month:"2025-04", updated, count, stocks:{ code:{name,ind,yoy,mom,accYoY,rev,tier} } }
 *
 * tier 分級（依回測）：高成長(yoy>20) / 成長(0<yoy≤20) / 衰退(yoy≤0)
 */

const fs = require('fs').promises;
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'revenue');

const SOURCES = [
  { market: 'twse', url: 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L' },
  { market: 'tpex', url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O' }
];

function rocToYM(s) {
  // "11504" → "2025-04"
  s = String(s || '').trim();
  if (s.length < 5) return '';
  const y = parseInt(s.slice(0, 3)) + 1911;
  const m = s.slice(3).padStart(2, '0');
  return `${y}-${m}`;
}
const num = v => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
function tierOf(yoy) {
  if (yoy == null) return null;
  if (yoy > 20) return '高成長';
  if (yoy > 0) return '成長';
  return '衰退';
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const stocks = {};
  let month = '';
  let twse = 0, tpex = 0;

  for (const src of SOURCES) {
    console.log(`Fetching ${src.market} ${src.url} ...`);
    const t0 = Date.now();
    let arr;
    try {
      const r = await fetch(src.url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      arr = await r.json();
    } catch (e) {
      console.error(`  ${src.market} 失敗：${e.message}`);
      continue;
    }
    if (!Array.isArray(arr)) { console.error(`  ${src.market} 非陣列`); continue; }
    console.log(`  ${arr.length} 筆 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

    for (const rec of arr) {
      const code = String(rec['公司代號'] || '').trim();
      if (!/^\d{4,6}$/.test(code)) continue;
      const yoy = num(rec['營業收入-去年同月增減(%)']);
      const rev = num(rec['營業收入-當月營收']);
      if (rev == null) continue;
      const ym = rocToYM(rec['資料年月']);
      if (!month && ym) month = ym;
      stocks[code] = {
        name: String(rec['公司名稱'] || '').trim(),
        ind: String(rec['產業別'] || '').trim(),
        market: src.market,
        yoy: yoy != null ? +yoy.toFixed(2) : null,
        mom: (n => n != null ? +n.toFixed(2) : null)(num(rec['營業收入-上月比較增減(%)'])),
        accYoY: (n => n != null ? +n.toFixed(2) : null)(num(rec['累計營業收入-前期比較增減(%)'])),
        rev,                            // 千元
        ym,
        tier: tierOf(yoy)
      };
      if (src.market === 'twse') twse++; else tpex++;
    }
  }

  const count = Object.keys(stocks).length;
  if (count === 0) throw new Error('No revenue data collected');

  // 統計分布（log 用）
  const dist = { 高成長: 0, 成長: 0, 衰退: 0, 無: 0 };
  for (const c in stocks) dist[stocks[c].tier || '無']++;

  const snapshot = { month, updated: todayISO(), count, twse, tpex, dist, stocks };
  await fs.writeFile(path.join(DATA_DIR, 'latest.json'), JSON.stringify(snapshot));

  console.log(`\n✓ Revenue snapshot 寫入 — 月份 ${month}, 共 ${count} 檔 (上市 ${twse} / 上櫃 ${tpex})`);
  console.log(`  分布：高成長 ${dist.高成長} / 成長 ${dist.成長} / 衰退 ${dist.衰退} / 無 ${dist.無}`);
  // 樣本
  for (const c of ['2330', '2317', '2454', '2357']) {
    if (stocks[c]) console.log(`  ${c} ${stocks[c].name}: YoY ${stocks[c].yoy}% (${stocks[c].tier}), MoM ${stocks[c].mom}%`);
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
