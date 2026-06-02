#!/usr/bin/env node
/**
 * 全市場公司基本資料快照（GitHub Action 每月執行；資料幾乎不變）
 * ------------------------------------------------------------------
 * 來源（bulk、免 token、官方）：
 *   上市 https://openapi.twse.com.tw/v1/opendata/t187ap03_L      (中文欄位)
 *   上櫃 https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O   (英文欄位)
 *
 * 產出 data/company/latest.json：
 *   { updated, count, twse, tpex, stocks:{ code:{ name, abbr, market,
 *       chairman, ceo, spokesman, spokesmanTitle, tel, addr,
 *       founded, listed, capital, parValue, shares, web, email } } }
 *
 * 註：本資料集「無主要經營業務」欄位；產業別僅為代碼，前端沿用既有 sector 顯示。
 *     日期統一正規化為 YYYY-MM-DD；金額/股數保留原值（元 / 股），由前端格式化。
 */

const fs = require('fs').promises;
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'company');

// 上市（中文欄位）/ 上櫃（英文欄位）對應
const SOURCES = [
  {
    market: 'twse',
    url: 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
    k: {
      code: '公司代號', name: '公司名稱', abbr: '公司簡稱',
      chairman: '董事長', ceo: '總經理', spokesman: '發言人', spokesmanTitle: '發言人職稱',
      tel: '總機電話', addr: '住址', founded: '成立日期', listed: '上市日期',
      capital: '實收資本額', parValue: '普通股每股面額',
      shares: '已發行普通股數或TDR原股發行股數', web: '網址', email: '電子郵件信箱'
    }
  },
  {
    market: 'tpex',
    url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
    k: {
      code: 'SecuritiesCompanyCode', name: 'CompanyName', abbr: 'CompanyAbbreviation',
      chairman: 'Chairman', ceo: 'GeneralManager', spokesman: 'Spokesman', spokesmanTitle: 'TitleOfSpokesman',
      tel: 'Telephone', addr: 'Address', founded: 'DateOfIncorporation', listed: 'DateOfListing',
      capital: 'Paidin.Capital.NTDollars', parValue: 'ParValueOfCommonStock',
      shares: 'IssueShares', web: 'WebAddress', email: 'EmailAddress'
    }
  }
];

const clean = v => String(v ?? '').trim().replace(/　/g, ' ').trim();
const num = v => {
  const n = parseFloat(String(v ?? '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
// 「19801009」「2002/08/26」「2002-08-26」「1091009(ROC)」→ YYYY-MM-DD
function normDate(s) {
  const d = String(s ?? '').replace(/\D/g, '');
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  if (d.length === 7) { // ROC
    const y = parseInt(d.slice(0, 3)) + 1911;
    return `${y}-${d.slice(3, 5)}-${d.slice(5, 7)}`;
  }
  return '';
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const stocks = {};
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

    const k = src.k;
    for (const rec of arr) {
      const code = clean(rec[k.code]);
      if (!/^\d{4,6}$/.test(code)) continue;
      stocks[code] = {
        name: clean(rec[k.name]),
        abbr: clean(rec[k.abbr]),
        market: src.market,
        chairman: clean(rec[k.chairman]),
        ceo: clean(rec[k.ceo]),
        spokesman: clean(rec[k.spokesman]),
        spokesmanTitle: clean(rec[k.spokesmanTitle]),
        tel: clean(rec[k.tel]),
        addr: clean(rec[k.addr]),
        founded: normDate(rec[k.founded]),
        listed: normDate(rec[k.listed]),
        capital: num(rec[k.capital]),     // 元
        parValue: num(rec[k.parValue]),   // 元
        shares: num(rec[k.shares]),       // 股
        web: clean(rec[k.web]).replace(/^https?:\/\//, ''),
        email: clean(rec[k.email])
      };
      if (src.market === 'twse') twse++; else tpex++;
    }
  }

  const count = Object.keys(stocks).length;
  if (count === 0) throw new Error('No company data collected');

  const snapshot = { updated: todayISO(), count, twse, tpex, stocks };
  await fs.writeFile(path.join(DATA_DIR, 'latest.json'), JSON.stringify(snapshot));

  console.log(`\n✓ Company snapshot 寫入 — 共 ${count} 檔 (上市 ${twse} / 上櫃 ${tpex})`);
  for (const c of ['2330', '3019', '6488']) {
    if (stocks[c]) console.log(`  ${c} ${stocks[c].name}: 上市${stocks[c].listed} 資本額${(stocks[c].capital / 1e8).toFixed(1)}億 董座${stocks[c].chairman}`);
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
