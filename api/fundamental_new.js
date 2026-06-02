// api/fundamental.js
// 基本面資料：集保持股分散、三大法人、融資融券、外資、董監
import { promises as fs } from 'fs';
import path from 'path';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, stock_id } = req.query;

  try {

    // ══════════════════════════════════════════════════
    // 集保歷史趨勢（GitHub Action 每週累積的 holders_history）
    //   回傳該股票每週的 5 個聚合指標時序
    // ══════════════════════════════════════════════════
    if (type === 'holders_history') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });
      try {
        const dir = path.join(process.cwd(), 'data', 'holders_history');
        // 讀 index.json 取週次清單
        const indexPath = path.join(dir, 'index.json');
        let weeks = [];
        try {
          const idx = JSON.parse(await fs.readFile(indexPath, 'utf8'));
          weeks = (idx.weeks || []).sort();
        } catch {
          // 若還沒有 index.json，掃描目錄
          try {
            const files = await fs.readdir(dir);
            weeks = files.filter(f => /^\d{4}-W\d{2}\.json$/.test(f))
                         .map(f => f.replace('.json',''))
                         .sort();
          } catch { weeks = []; }
        }

        // 讀每週快照、抽取該股票
        const series = [];
        for (const w of weeks) {
          try {
            const snap = JSON.parse(await fs.readFile(path.join(dir, `${w}.json`), 'utf8'));
            const s = snap.stocks?.[stock_id];
            if (s) {
              series.push({
                week: w,
                date: snap.scaDate || snap.captured || '',
                k1:   s.k1,
                h400: s.h400,
                h100: s.h100,
                r20:  s.r20,
                n1k:  s.n1k
              });
            }
          } catch {}
        }

        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
        return res.status(200).json({
          stock_id,
          weeks: weeks.length,
          series,
          source: 'holders_history'
        });
      } catch (e) {
        return res.status(200).json({ stock_id, series: [], error: e.message });
      }
    }

    // ══════════════════════════════════════════════════
    // 月營收 YoY（GitHub Action 每月快照，回測驗證的選股因子）
    //   type=revenue&stock_id=2330 → 單檔
    //   type=revenue               → 全市場 map（主表格標籤用）
    // ══════════════════════════════════════════════════
    if (type === 'revenue') {
      try {
        const file = path.join(process.cwd(), 'data', 'revenue', 'latest.json');
        const snap = JSON.parse(await fs.readFile(file, 'utf8'));
        res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate');
        if (stock_id) {
          const s = snap.stocks?.[stock_id] || null;
          return res.status(200).json({ stock_id, month: snap.month, data: s, source: 'mops_openapi' });
        }
        // 全市場：精簡欄位降低體積
        const map = {};
        for (const c in snap.stocks) {
          const x = snap.stocks[c];
          map[c] = { yoy: x.yoy, mom: x.mom, tier: x.tier };
        }
        return res.status(200).json({ month: snap.month, updated: snap.updated, count: snap.count, dist: snap.dist, stocks: map, source: 'mops_openapi' });
      } catch (e) {
        return res.status(200).json({ stock_id: stock_id || null, data: null, stocks: {}, error: e.message });
      }
    }

    // ══════════════════════════════════════════════════
    // 公司基本資料（GitHub Action 月快照，TWSE/TPEx 官方 OpenAPI）
    //   type=company&stock_id=2330 → 單檔基本資料
    // ══════════════════════════════════════════════════
    if (type === 'company') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });
      try {
        const file = path.join(process.cwd(), 'data', 'company', 'latest.json');
        const snap = JSON.parse(await fs.readFile(file, 'utf8'));
        const s = snap.stocks?.[stock_id] || null;
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
        return res.status(200).json({ stock_id, updated: snap.updated, data: s, source: 'twse_tpex_openapi' });
      } catch (e) {
        return res.status(200).json({ stock_id, data: null, error: e.message });
      }
    }

    // ══════════════════════════════════════════════════
    // 近五年年營收（FinMind 逐檔即時抓 → 彙總月營收為年營收）
    //   type=revenue_annual&stock_id=2330
    //   免費版逐檔可用；隨點隨抓 + s-maxage 快取，避免全市場批次（需付費）
    // ══════════════════════════════════════════════════
    if (type === 'revenue_annual') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });
      try {
        // 抓 6 個完整年度的月營收（含當年 YTD）；起點往前 6 年的 1 月
        const startYear = new Date().getFullYear() - 6;
        const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMonthRevenue&data_id=${encodeURIComponent(stock_id)}&start_date=${startYear}-01-01`;
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const j = await r.json();
        if (j.status !== 200 || !Array.isArray(j.data)) {
          return res.status(200).json({ stock_id, years: [], error: j.msg || 'finmind_error', source: 'finmind' });
        }
        // 依「營收所屬年月」彙總（revenue_year/revenue_month 才是歸屬期；date 是公布日）
        const byYear = {};   // year → { sum, months:Set }
        for (const row of j.data) {
          const y = row.revenue_year, m = row.revenue_month;
          const rev = Number(row.revenue);
          if (!y || !Number.isFinite(rev)) continue;
          (byYear[y] = byYear[y] || { sum: 0, months: new Set() });
          byYear[y].sum += rev;
          byYear[y].months.add(m);
        }
        const curYear = new Date().getFullYear();
        let years = Object.keys(byYear).map(Number).sort((a, b) => a - b).map(y => ({
          year: y,
          revenue: byYear[y].sum,            // 元（全年加總；當年為 YTD）
          months: byYear[y].months.size,     // 已含幾個月（判斷是否完整年度）
          partial: byYear[y].months.size < 12 || y >= curYear
        }));
        // YoY（以完整年度為主；當年 YTD 不算嚴謹 YoY，前端標註）
        years = years.map((o, i) => {
          const prev = years[i - 1];
          o.yoy = prev && prev.revenue ? +(((o.revenue - prev.revenue) / prev.revenue) * 100).toFixed(1) : null;
          return o;
        });
        // 只保留最近 6 個年度
        years = years.slice(-6);
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');
        return res.status(200).json({ stock_id, years, source: 'finmind' });
      } catch (e) {
        return res.status(200).json({ stock_id, years: [], error: e.message, source: 'finmind' });
      }
    }

    // ══════════════════════════════════════════════════
    // 公司延伸資料：主要經營業務（MOPS）＋ 近年股利/除權息（FinMind）
    //   type=company_extra&stock_id=2330
    //   兩來源平行抓、互不影響；隨點隨抓 + 快取
    // ══════════════════════════════════════════════════
    if (type === 'company_extra') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });
      const out = { stock_id, business: '', dividends: [], latestEx: '', source: 'mops+finmind' };

      const pBiz = (async () => {
        try {
          const body = `co_id=${encodeURIComponent(stock_id)}&queryName=co_id&inpuType=co_id&TYPEK=all&step=1&firstin=1`;
          const r = await fetch('https://mopsov.twse.com.tw/mops/web/ajax_t05st03', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
            body
          });
          const t = await r.text();
          const m = t.match(/主要經營業務<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/);
          if (m) out.business = m[1].replace(/<br\s*\/?>/gi, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, '').trim();
        } catch (e) { /* 留空 */ }
      })();

      const pDiv = (async () => {
        try {
          const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockDividend&data_id=${encodeURIComponent(stock_id)}&start_date=2019-01-01`;
          const j = await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
          if (j.status === 200 && Array.isArray(j.data)) {
            const rows = j.data.map(r => {
              const roc = parseInt(String(r.year).replace(/\D/g, ''));
              return {
                year: Number.isFinite(roc) ? roc + 1911 : null,   // 盈餘所屬年度（西元）
                cash: +(((r.CashEarningsDistribution || 0) + (r.CashStatutorySurplus || 0))).toFixed(2),
                stock: +(((r.StockEarningsDistribution || 0) + (r.StockStatutorySurplus || 0))).toFixed(2),
                exCash: r.CashExDividendTradingDate || '',
                exStock: r.StockExDividendTradingDate || '',
                pay: r.CashDividendPaymentDate || ''
              };
            }).filter(x => x.year).sort((a, b) => a.year - b.year);
            out.dividends = rows.slice(-3);
            const dates = rows.flatMap(r => [r.exCash, r.exStock]).filter(Boolean).sort();
            out.latestEx = dates.length ? dates[dates.length - 1] : '';
          }
        } catch (e) { /* 留空 */ }
      })();

      await Promise.allSettled([pBiz, pDiv]);
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');
      return res.status(200).json(out);
    }

    // ══════════════════════════════════════════════════
    // 季財報三圖：資產負債走勢 / 獲利能力 / 經營能力
    //   type=financials&stock_id=2330
    //   來源：FinMind（per-stock 免費）
    //     TaiwanStockBalanceSheet        （資產負債：時點值）
    //     TaiwanStockFinancialStatements （綜合損益：年度累計值 → 差分為單季）
    //   所有比率皆由公開財報自行計算（前端標註「依公開財報計算」）
    // ══════════════════════════════════════════════════
    if (type === 'financials') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });
      try {
        const startY = new Date().getFullYear() - 4;          // 約 16 季，足夠算 YoY
        const enc = encodeURIComponent(stock_id);
        const fetchDS = async (ds) => {
          const url = `https://api.finmindtrade.com/api/v4/data?dataset=${ds}&data_id=${enc}&start_date=${startY}-01-01`;
          const j = await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
          return (j.status === 200 && Array.isArray(j.data)) ? j.data : [];
        };
        const [bsRows, isRows] = await Promise.all([
          fetchDS('TaiwanStockBalanceSheet'),
          fetchDS('TaiwanStockFinancialStatements')
        ]);
        if (!bsRows.length && !isRows.length) {
          return res.status(200).json({ stock_id, quarters: [], error: 'no_data', source: 'finmind' });
        }

        // 整理成 date → {type: value}
        const pivot = (rows) => {
          const m = {};
          for (const r of rows) {
            const d = r.date; if (!d) continue;
            (m[d] = m[d] || {});
            // 同一 type 可能有 value 與 _per，只取主值（非 _per）
            if (!String(r.type).endsWith('_per')) m[d][r.type] = Number(r.value);
          }
          return m;
        };
        const BS = pivot(bsRows);   // 時點值
        const IS = pivot(isRows);   // 累計值

        const qOf = (date) => {     // '2024-06-30' → {y:2024, q:2}
          const [y, mo] = date.split('-').map(Number);
          return { y, q: Math.round(mo / 3) };
        };
        // FinMind TaiwanStockFinancialStatements 已是「單季」值（非累計），直接取用
        const singleQ = {};         // `${y}-${q}` → { date, rev, gross, op, net, cogs }
        for (const d of Object.keys(IS).sort()) {
          const { y, q } = qOf(d);
          const v = IS[d];
          const g = (f) => (Number.isFinite(v[f]) ? v[f] : null);
          singleQ[`${y}-${q}`] = {
            date: d, rev: g('Revenue'), gross: g('GrossProfit'),
            op: g('OperatingIncome'), net: g('IncomeAfterTaxes'), cogs: g('CostOfGoodsSold')
          };
        }

        const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0) ? +((a / b) * 100).toFixed(2) : null;
        const rat = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0) ? +(a / b).toFixed(3) : null;

        // 以資產負債表的季別為主軸（時點值最完整），對齊損益單季
        const out = [];
        for (const d of Object.keys(BS).sort()) {
          const { y, q } = qOf(d);
          const key = `${y}-${q}`;
          const bs = BS[d];
          const sq = singleQ[key] || {};
          const prevYearSq = singleQ[`${y - 1}-${q}`] || null;   // 去年同季單季營收
          const assets = bs.TotalAssets, liab = bs.Liabilities, equity = bs.Equity;
          out.push({
            label: `${String(y).slice(2)}Q${q}`,
            date: d,
            // 資產負債（億元，前端再轉）
            assets: Number.isFinite(assets) ? assets : null,
            liabilities: Number.isFinite(liab) ? liab : null,
            equity: Number.isFinite(equity) ? equity : null,
            // 獲利能力（%）
            grossMargin: pct(sq.gross, sq.rev),
            opMargin: pct(sq.op, sq.rev),
            netMargin: pct(sq.net, sq.rev),
            roe: pct(sq.net, equity),
            roa: pct(sq.net, assets),
            // 經營能力
            revYoY: (prevYearSq && Number.isFinite(sq.rev) && Number.isFinite(prevYearSq.rev) && prevYearSq.rev !== 0)
              ? +(((sq.rev - prevYearSq.rev) / Math.abs(prevYearSq.rev)) * 100).toFixed(1) : null,
            assetTurnover: rat(sq.rev, assets),                 // 次/季
            invTurnover: rat(sq.cogs, bs.Inventories),          // 次/季
            arTurnover: rat(sq.rev, bs.AccountsReceivableNet),  // 次/季
            currentRatio: pct(bs.CurrentAssets, bs.CurrentLiabilities),
            quickRatio: (Number.isFinite(bs.CurrentAssets) && Number.isFinite(bs.CurrentLiabilities) && bs.CurrentLiabilities !== 0)
              ? +(((bs.CurrentAssets - (bs.Inventories || 0)) / bs.CurrentLiabilities) * 100).toFixed(2) : null
          });
        }
        const quarters = out.slice(-12);   // 最近 12 季
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');
        return res.status(200).json({ stock_id, quarters, source: 'finmind' });
      } catch (e) {
        return res.status(200).json({ stock_id, quarters: [], error: e.message, source: 'finmind' });
      }
    }

    // ══════════════════════════════════════════════════
    // 1. 集保持股分散（大戶/散戶）
    //    策略：TDCC OpenAPI → TDCC 政府開放平台 → TDCC 網頁POST（備援）
    // ══════════════════════════════════════════════════
    if (type === 'holders') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });

      // ── 策略 A：TDCC OpenAPI (openapi.tdcc.com.tw/v1/opendata/1-5) ──
      // 2026 改版後：欄位改繁中、StockNo 參數不再過濾（整包回傳）、代號有尾隨空白
      try {
        const url = `https://openapi.tdcc.com.tw/v1/opendata/1-5?StockNo=${stock_id}`;
        const r = await fetch(url, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (r.ok) {
          let all = await r.json();
          // 在伺服器端自行 filter（StockNo 參數無效）
          if (Array.isArray(all)) {
            all = all.filter(d => (d['證券代號']||d.StockNo||'').trim() === stock_id);
          }
          // 統一翻譯成英文欄位（向後相容下方既有邏輯）
          const data = (Array.isArray(all) ? all : []).map(d => ({
            StockNo:   (d['證券代號']||d.StockNo||'').trim(),
            HolderNum: (d['持股分級']||d.HolderNum||'').toString().trim(),
            People:    (d['人數']||d.People||'0').toString().trim(),
            Shares:    (d['股數']||d.Shares||'0').toString().trim(),
            Percent:   (d['占集保庫存數比例%']||d.Percent||'0').toString().trim(),
            ScaDate:   (d['﻿資料日期']||d['資料日期']||d.ScaDate||'').toString().trim(),
          }));
          if (data.length > 0) {
            // 實際欄位：ScaDate, StockNo, StockName, HolderNum(分級代號),
            //           People(人數), Shares(股數), Percent(%)
            // HolderNum: 1=1-999股, 2=1,000-5,000, ... 17=超過 (每個等級對應股數範圍)
            // TDCC 等級代號對應張數範圍（1張=1000股）
            // TDCC OpenAPI 1-5 正確分級（1張=1000股）
            const levelMap = {
              '1':  { label:'1-999股(未滿1張)',       lots:0 },
              '2':  { label:'1,000-5,000股(1-5張)',   lots:1 },
              '3':  { label:'5,001-10,000股(5-10張)', lots:5 },
              '4':  { label:'10,001-15,000股(10-15張)', lots:10 },
              '5':  { label:'15,001-20,000股(15-20張)', lots:15 },
              '6':  { label:'20,001-30,000股(20-30張)', lots:20 },
              '7':  { label:'30,001-40,000股(30-40張)', lots:30 },
              '8':  { label:'40,001-50,000股(40-50張)', lots:40 },
              '9':  { label:'50,001-100,000股(50-100張)', lots:50 },
              '10': { label:'100,001-200,000股(100-200張)', lots:100 },
              '11': { label:'200,001-400,000股(200-400張)', lots:200 },
              '12': { label:'400,001-600,000股(400-600張)', lots:400 },
              '13': { label:'600,001-800,000股(600-800張)', lots:600 },
              '14': { label:'800,001-1,000,000股(800-1000張)', lots:800 },
              '15': { label:'1,000,001股以上(1000張以上)', lots:1000 },
              '16': { label:'差異數調整',             lots:-1 },
              '17': { label:'合計',                   lots:-1 }
            };

            const rows = data
              .filter(d => d.HolderNum !== '17' && d.HolderNum !== '16') // 排除合計列與差異數調整
              .map(d => {
                const info = levelMap[d.HolderNum] || { label: d.HolderNum, lots: 0 };
                return {
                  level: info.label,
                  holderNum: d.HolderNum,
                  lots: info.lots,
                  people: parseInt((d.People||'0').replace(/,/g,'')) || 0,
                  shares: parseInt((d.Shares||'0').replace(/,/g,'')) || 0,
                  ratio: parseFloat(d.Percent || 0) || 0
                };
              });

            // 用 HolderNum 直接歸組（避開 levelMap 的 lots 欄位 bug）
            // TDCC OpenAPI 編號：1=零股、2-5≤20張、6-9=20-100張、
            //                    10-12=100-400張、13-15=400張+、16=>1000張
            const ratioByLevel = {};
            const peopleByLevel = {};
            for (const row of rows) {
              const lv = parseInt(row.holderNum) || 0;
              ratioByLevel[lv]  = (ratioByLevel[lv]||0)  + row.ratio;
              peopleByLevel[lv] = (peopleByLevel[lv]||0) + row.people;
            }
            const sumR = (...lvs) => lvs.reduce((s,lv)=>s+(ratioByLevel[lv]||0), 0);
            const sumP = (...lvs) => lvs.reduce((s,lv)=>s+(peopleByLevel[lv]||0), 0);

            // 5 個聚合指標（百分比 0~100）
            // TDCC 持股分級：15=1,000,001股以上(千張大戶)、16=差異數調整、17=合計
            //   12=400,001-600,000 / 13=600,001-800,000 / 14=800,001-1,000,000
            //   10=100,001-200,000 / 11=200,001-400,000 / 1-5=1~20,000股(散戶<20張)
            const k1   = sumR(15);                      // 千張大戶 (>1000張)
            const h400 = sumR(12,13,14,15);             // 400張以上
            const h100strict = sumR(10,11,12,13,14,15); // 100張以上
            const r20  = sumR(1,2,3,4,5);               // 散戶<20張
            const n1k  = sumP(15);                      // 千張大戶人數
            const r20People = sumP(1,2,3,4,5);          // 散戶<20張 人數

            // 大/散戶（既有定義：1000張）
            let bigRatio=0, smallRatio=0, bigPeople=0, smallPeople=0;
            for (const row of rows) {
              if (row.lots >= 1000) {
                bigRatio += row.ratio; bigPeople += row.people;
              } else {
                smallRatio += row.ratio; smallPeople += row.people;
              }
            }

            const scaDate = data[0]?.ScaDate || '';
            res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
            return res.status(200).json({
              stock_id, rows, scaDate,
              summary: {
                // 既有（向後相容）
                bigHolder:   parseFloat(bigRatio.toFixed(2)),
                smallHolder: parseFloat(smallRatio.toFixed(2)),
                bigPeople,
                smallPeople: r20People,            // 散戶<20張 人數（前端用）
                totalPeople: bigPeople + smallPeople, // 真實總人數
                // 新聚合
                k1:   parseFloat(k1.toFixed(2)),         // 千張大戶 %
                h400: parseFloat(h400.toFixed(2)),       // 400張+ %
                h100: parseFloat(h100strict.toFixed(2)), // 100張+ %
                r20:  parseFloat(r20.toFixed(2)),        // 散戶<20張 %
                n1k                                        // 千張大戶人數
              },
              source: 'TDCC_OPENAPI'
            });
          }
        }
      } catch(e) { console.log('TDCC OpenAPI failed:', e.message); }

      // ── 策略 B：政府資料開放平台 data.gov.tw ──
      try {
        const url = `https://data.gov.tw/api/v2/rest/datastore/search?resource_id=a151db5e-0944-4afc-ba8a-69c3c3dc33a8&filters[StockNo]=${stock_id}&limit=20`;
        const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (r.ok) {
          const j = await r.json();
          const records = j?.result?.records || [];
          if (records.length > 0) {
            const rows = records.map(d => ({
              level: d.HolderNum || d.Level || '',
              people: parseInt((d.People||'0').replace(/,/g,'')) || 0,
              shares: parseInt((d.Shares||'0').replace(/,/g,'')) || 0,
              ratio: parseFloat(d.Percent || 0) || 0,
              lots: 0
            }));
            // 簡化大戶計算（最後幾筆為大戶）
            const total = rows.length;
            const bigRows = rows.slice(-3);
            const smallRows = rows.slice(0, -3);
            const bigRatio = bigRows.reduce((s,r)=>s+r.ratio,0);
            const smallRatio = smallRows.reduce((s,r)=>s+r.ratio,0);
            res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
            return res.status(200).json({
              stock_id, rows,
              summary: {
                bigHolder: parseFloat(bigRatio.toFixed(2)),
                smallHolder: parseFloat(smallRatio.toFixed(2)),
                bigPeople: bigRows.reduce((s,r)=>s+r.people,0),
                smallPeople: smallRows.reduce((s,r)=>s+r.people,0),
                totalPeople: rows.reduce((s,r)=>s+r.people,0)
              },
              source: 'DATA_GOV_TW'
            });
          }
        }
      } catch(e) { console.log('data.gov.tw failed:', e.message); }

      // ── 策略 C：TDCC 網頁 POST（終極備援）──
      return await holdersFromTDCCWeb(stock_id, res);
    }

    // ══════════════════════════════════════════════════
    // 2. 三大法人買賣（上市）
    // ══════════════════════════════════════════════════
    if (type === 'institution') {
      const r = await fetch(
        'https://openapi.twse.com.tw/v1/fund/TWT38U',
        { headers: { 'Accept': 'application/json' } }
      );
      const data = await r.json();
      if (stock_id) {
        const item = data.find(d => d.Code === stock_id);
        return res.status(200).json({ data: item || null, source: 'TWSE_INST' });
      }
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE_INST' });
    }

    // ══════════════════════════════════════════════════
    // 3. 融資融券（上市）
    // ══════════════════════════════════════════════════
    if (type === 'margin') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });
      const today = new Date();
      const ym = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
      const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ym}&selectType=STOCK&response=json`;
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      const data = await r.json();
      const rows = data.data || [];
      const item = rows.find(row => row[0] === stock_id);
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
      return res.status(200).json({
        stock_id,
        data: item ? {
          marginBuy:   parseInt(item[2]?.replace(/,/g,'')) || 0,
          marginSell:  parseInt(item[3]?.replace(/,/g,'')) || 0,
          marginTotal: parseInt(item[4]?.replace(/,/g,'')) || 0,
          shortBuy:    parseInt(item[8]?.replace(/,/g,'')) || 0,
          shortSell:   parseInt(item[9]?.replace(/,/g,'')) || 0,
          shortTotal:  parseInt(item[10]?.replace(/,/g,'')) || 0,
        } : null,
        source: 'TWSE_MARGIN'
      });
    }

    // ══════════════════════════════════════════════════
    // 4. 外資持股比例（上市）
    // ══════════════════════════════════════════════════
    if (type === 'foreign') {
      const r = await fetch(
        'https://openapi.twse.com.tw/v1/fund/MI_QFIIS',
        { headers: { 'Accept': 'application/json' } }
      );
      const data = await r.json();
      if (stock_id) {
        const item = data.find(d => d.Code === stock_id);
        return res.status(200).json({ data: item || null, source: 'TWSE_FOREIGN' });
      }
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE_FOREIGN' });
    }

    // ══════════════════════════════════════════════════
    // 5. 董監持股（上市）
    // ══════════════════════════════════════════════════
    if (type === 'directors') {
      const r = await fetch(
        'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
        { headers: { 'Accept': 'application/json' } }
      );
      const data = await r.json();
      if (stock_id) {
        const items = data.filter(d => d['公司代號'] === stock_id);
        return res.status(200).json({ data: items, source: 'TWSE_DIRECTORS' });
      }
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE_DIRECTORS' });
    }

    return res.status(400).json({ error: '不支援的 type 參數' });

  } catch (err) {
    return res.status(500).json({ error: '資料取得失敗：' + err.message });
  }
}

// ══════════════════════════════════════════════════
// TDCC 網頁備援（策略C）
// ══════════════════════════════════════════════════
async function holdersFromTDCCWeb(stock_id, res) {
  try {
    // 第一步：取得 session + CSRF token
    const initRes = await fetch('https://www.tdcc.com.tw/portal/zh/smWeb/qryStock', {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-TW,zh;q=0.9',
      }
    });

    const rawCookie = initRes.headers.get('set-cookie') || '';
    // 取出 JSESSIONID 或第一個 cookie
    const cookie = rawCookie.split(',').map(c=>c.split(';')[0].trim()).filter(Boolean).join('; ');
    const initHtml = await initRes.text();

    // 抓 CSRF token（Spring Security）
    const csrfMatch = initHtml.match(/name="_csrf"\s+value="([^"]+)"/);
    const csrf = csrfMatch ? csrfMatch[1] : '';

    // 第二步：POST 查詢
    const body = new URLSearchParams({
      scaDate: '',
      SqlMethod: 'StockNo',
      StockNo: stock_id,
      StockName: '',
      radioStockNo: 'StockNo',
      ...(csrf ? { _csrf: csrf } : {})
    });

    const r = await fetch('https://www.tdcc.com.tw/portal/zh/smWeb/qryStock', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tdcc.com.tw/portal/zh/smWeb/qryStock',
        'Accept': 'text/html,application/xhtml+xml',
        ...(cookie ? { 'Cookie': cookie } : {})
      },
      body: body.toString()
    });

    const html = await r.text();

    // 解析 <table> 中的持股分散資料
    const rows = [];
    const trReg = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;
    while ((trMatch = trReg.exec(html)) !== null) {
      const tds = [];
      const tdReg = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let tdMatch;
      while ((tdMatch = tdReg.exec(trMatch[1])) !== null) {
        tds.push(tdMatch[1].replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').trim());
      }
      // 有效資料行：第一欄以數字開頭（持股分級）
      if (tds.length >= 4 && /^\d/.test(tds[0])) {
        rows.push({
          level: tds[0],
          people: parseInt((tds[1]||'0').replace(/,/g,'')) || 0,
          shares: parseInt((tds[2]||'0').replace(/,/g,'')) || 0,
          ratio: parseFloat(tds[4] || tds[3]) || 0,
          lots: 0
        });
      }
    }

    // 計算大戶（1000張 = 1,000,000股）
    let bigRatio=0, smallRatio=0, bigPeople=0, smallPeople=0;
    for (const row of rows) {
      // level 格式如 "1,000,001以上" 或 "超過1,000,000"
      const numStr = row.level.replace(/,/g,'').match(/\d+/)?.[0] || '0';
      const minShares = parseInt(numStr) || 0;
      if (minShares >= 1000000 || row.level.includes('超過') || row.level.includes('1,000,001')) {
        bigRatio += row.ratio; bigPeople += row.people;
      } else {
        smallRatio += row.ratio; smallPeople += row.people;
      }
    }

    // 抓資料日期
    const dateMatch = html.match(/資料日期[：:]\s*([\d\/]+)/);
    const scaDate = dateMatch ? dateMatch[1] : '';

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).json({
      stock_id, rows, scaDate,
      summary: {
        bigHolder: parseFloat(bigRatio.toFixed(2)),
        smallHolder: parseFloat(smallRatio.toFixed(2)),
        bigPeople, smallPeople,
        totalPeople: bigPeople + smallPeople
      },
      source: 'TDCC_WEB'
    });

  } catch(e) {
    return res.status(200).json({
      stock_id, rows: [],
      summary: { bigHolder:0, smallHolder:0, bigPeople:0, smallPeople:0, totalPeople:0 },
      source: 'TDCC_FAIL', error: e.message
    });
  }
}
