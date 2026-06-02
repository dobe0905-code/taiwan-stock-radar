#!/usr/bin/env node
/**
 * 全市場短線狀態快照（GitHub Action 每交易日收盤後執行）
 * ------------------------------------------------------------------
 * 目的：為主表格「全部股票」預先算好短線趨勢狀態徽章（短多/短空/盤整），
 *       不必逐檔展開個股面板才看得到。判斷邏輯與個股面板「操作策略總覽」一致：
 *         短多 = MA5>MA10>MA20 且 收盤>MA60
 *         短空 = MA5<MA10<MA20 且 收盤<MA60
 *         其餘 = 盤整
 *       並附季線斜率(up)：回測證實 edge 幾乎全來自季線上揚。
 *
 * 設計：滾動收盤價資料庫（closes-only，省空間）
 *   - 全市場單日行情用「日期參數」批次抓（1 個 date = 1 次呼叫整個市場），
 *     首次建庫往回探索約 70 個交易日；之後每日只補當天。
 *   - GitHub Action 機房 IP 不像 Vercel 被 TWSE 封鎖，可直接抓官網。
 *
 * 來源（皆免 token、單次回傳整個市場）：
 *   上市 https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=YYYYMMDD&type=ALLBUT0999&response=json
 *   上櫃 https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_close_download.php?d=YY/MM/DD&o=json
 *
 * 產出：
 *   data/prices/history.json     滾動收盤價庫 { updated, dates:[..], stocks:{ code:{n,m,c:[..],lv} } }
 *   data/prices/state-latest.json 短線狀態圖 { date, count, dist, stocks:{ code:{st,up,d,b60} } }
 */

const fs = require('fs').promises;
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'prices');
const HIST_FILE = path.join(DATA_DIR, 'history.json');
const STATE_FILE = path.join(DATA_DIR, 'state-latest.json');

const KEEP = 70;                                  // 每檔最多保留幾根日線
const MAX_LOOKBACK = parseInt(process.env.MAX_LOOKBACK || '100'); // 建庫往回探索的日曆天上限
const THROTTLE = parseInt(process.env.THROTTLE || '350');         // 每次抓取間隔(ms)，禮貌節流

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const validCode = c => /^\d{4}$/.test(c) || /^00\d{2,4}$/.test(c);

// 回傳形態：{ data:{code:{n,c,v}} } | { blocked:true } | { holiday:true }
const BLOCK = { blocked: true }, HOLIDAY = { holiday: true };

// ── 抓某日上市全市場收盤 ──
async function fetchTWSE(dateStr) {
  let r;
  try {
    r = await fetch(
      `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${dateStr}&type=ALLBUT0999&response=json`,
      { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' } }
    );
  } catch (e) { return BLOCK; }                 // 連線層錯誤當作被擋
  // 安全性封鎖：307 轉址 + HTML「因為安全性考量」頁
  if (r.status === 307 || r.status === 403 || r.status === 429) return BLOCK;
  const txt = await r.text();
  if (/^\s*</.test(txt) || txt.includes('安全性')) return BLOCK;
  let j;
  try { j = JSON.parse(txt); } catch { return BLOCK; }
  const tables = j.tables || [];
  let t = tables.find(x => x.title && x.title.includes('個股') && x.data?.length > 100);
  if (!t) t = tables.find(x => x.data?.length > 100);
  if (!t?.data?.length) return HOLIDAY;          // 有效 JSON 但無個股表 = 非交易日
  const out = {};
  for (const row of t.data) {
    const code = (row[0] || '').trim();
    if (!validCode(code)) continue;
    const c = num(row[8]);                       // 收盤價
    if (c == null) continue;
    out[code] = { n: (row[1] || '').trim(), c, v: Math.round((num(row[2]) || 0) / 1000) }; // v: 張
  }
  return Object.keys(out).length > 100 ? { data: out } : HOLIDAY;
}

// ── 抓某日上櫃全市場收盤 ──
async function fetchTPEx(date) {
  const yy = date.getFullYear() - 1911;
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  let r;
  try {
    r = await fetch(
      `https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_close_download.php?d=${yy}%2F${mm}%2F${dd}&s=0,asc,0&o=json`,
      { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tpex.org.tw/' } }
    );
  } catch (e) { return null; }                   // 上櫃失敗不致命（仍可只用上市）
  if (!r.ok) return null;
  let j;
  try { j = await r.json(); } catch { return null; }
  const rows = j.aaData || j.data || [];
  if (rows.length < 50) return null;
  const out = {};
  for (const row of rows) {
    const code = (row[0] || '').trim();
    if (!validCode(code)) continue;
    const c = num(row[2]);                       // 收盤
    if (c == null) continue;
    out[code] = { n: (row[1] || '').trim(), c, v: Math.round((num(row[8]) || 0) / 1000) };
  }
  return Object.keys(out).length > 30 ? out : null;
}

const mean = (a, n) => a.slice(-n).reduce((x, y) => x + y, 0) / n;

// ── 異常值清洗：台股單日漲跌幅上限 ±10%，跨日跳動 >15% 一律視為錯誤資料剔除 ──
// （例如抓到非個股表的當日，某些代號會塞進不相干數字）
function sanitize(c) {
  let prev = null;
  return c.map(v => {
    if (v == null || v <= 0) return null;
    if (prev != null && Math.abs(v / prev - 1) > 0.15) return null; // 超過漲跌幅合理範圍 → 剔除
    prev = v;
    return v;
  });
}

// ── 從收盤序列算短線狀態 ──
function calcState(closes) {
  const c = closes.filter(v => v != null);
  const d = c.length;
  if (d < 60) return { st: 'na', up: 0, d, b60: null };
  const ma5 = mean(c, 5), ma10 = mean(c, 10), ma20 = mean(c, 20), ma60 = mean(c, 60);
  const cur = c[c.length - 1];
  let st = 'range';
  if (ma5 > ma10 && ma10 > ma20 && cur > ma60) st = 'long';
  else if (ma5 < ma10 && ma10 < ma20 && cur < ma60) st = 'short';
  // 季線斜率：今日 MA60 vs 5 日前 MA60
  let up = 0;
  if (d >= 65) { const ma60p = mean(c.slice(0, -5), 60); up = ma60 > ma60p ? 1 : 0; }
  const b60 = ma60 > 0 ? +((cur - ma60) / ma60 * 100).toFixed(1) : null;
  return { st, up, d, b60 };
}

(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });

  // 載入現有滾動庫
  let hist = { updated: '', dates: [], stocks: {} };
  try { hist = JSON.parse(await fs.readFile(HIST_FILE, 'utf8')); } catch { console.log('無現有 history，將建庫'); }
  if (!Array.isArray(hist.dates)) hist.dates = [];
  if (!hist.stocks) hist.stocks = {};

  const have = new Set(hist.dates);
  const lastDate = hist.dates.length ? hist.dates[hist.dates.length - 1] : null;

  // 決定要抓的候選日期（升序，週末跳過）
  const today = new Date();
  const candidates = [];
  for (let i = MAX_LOOKBACK; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) continue;          // 跳過六日
    const ds = ymd(d);
    if (have.has(ds)) continue;                  // 已收錄
    if (lastDate && ds <= lastDate) continue;    // 增量模式只補 lastDate 之後
    candidates.push({ ds, d });
  }
  const mode = lastDate ? '增量' : '建庫';
  console.log(`模式：${mode}，現有 ${hist.dates.length} 個交易日，候選抓取 ${candidates.length} 天`);

  const BACKOFFS = [20000, 45000, 90000];        // 被擋時的退避秒數
  let added = 0, stopped = false;
  for (const { ds, d } of candidates) {
    // 抓上市（含被擋退避重試）
    let tw = await fetchTWSE(ds);
    let attempt = 0;
    while (tw.blocked && attempt < BACKOFFS.length) {
      console.log(`  ${ds} ⚠ 被 TWSE 安全性封鎖，退避 ${BACKOFFS[attempt] / 1000}s 後重試…`);
      await sleep(BACKOFFS[attempt]); attempt++;
      tw = await fetchTWSE(ds);
    }
    if (tw.blocked) {
      console.log(`  ${ds} ✗ 仍被封鎖，保存已抓進度，下次排程續抓`);
      stopped = true; break;                     // 自癒：存檔離開，下個排程繼續
    }
    if (tw.holiday) { await sleep(THROTTLE); console.log(`  ${ds} 非交易日，略過`); continue; }

    const otc = await fetchTPEx(d);
    await sleep(THROTTLE);
    const day = {};
    Object.assign(day, tw.data);
    if (otc) for (const code in otc) day[code] = { ...otc[code], _tpex: true };
    const n = Object.keys(day).length;
    if (n < 100) { console.log(`  ${ds} 資料不足(${n})，略過`); continue; }

    // 先把這天加入時間軸
    hist.dates.push(ds);
    // 每檔 append（沒交易的補 null 以對齊時間軸）
    const idx = hist.dates.length - 1;
    for (const code in day) {
      const rec = day[code];
      let s = hist.stocks[code];
      if (!s) { s = hist.stocks[code] = { n: rec.n, m: rec._tpex ? 'tpex' : 'twse', c: [] }; }
      // 對齊：補齊到 idx 長度
      while (s.c.length < idx) s.c.push(null);
      s.c.push(rec.c);
      s.lv = rec.v;
      if (rec.n) s.n = rec.n;
    }
    // 沒出現在今天的股票也要補 null 對齊
    for (const code in hist.stocks) {
      const s = hist.stocks[code];
      while (s.c.length < hist.dates.length) s.c.push(null);
    }
    added++;
    console.log(`  ${ds} ✓ ${n} 檔（上市+上櫃）`);
  }

  if (added === 0 && hist.dates.length === 0) throw new Error('未取得任何交易日資料');

  // 清洗異常收盤（跨日跳動 >15%），存檔即持久化乾淨資料
  for (const code in hist.stocks) hist.stocks[code].c = sanitize(hist.stocks[code].c);

  // 修剪到最後 KEEP 天
  if (hist.dates.length > KEEP) {
    const cut = hist.dates.length - KEEP;
    hist.dates = hist.dates.slice(cut);
    for (const code in hist.stocks) hist.stocks[code].c = hist.stocks[code].c.slice(cut);
  }
  // 移除完全沒資料的殭屍檔
  for (const code in hist.stocks) {
    if (!hist.stocks[code].c.some(v => v != null)) delete hist.stocks[code];
  }

  const latestDate = hist.dates[hist.dates.length - 1] || '';
  hist.updated = new Date().toISOString();
  await fs.writeFile(HIST_FILE, JSON.stringify(hist));

  // 算狀態圖
  const stocks = {};
  const dist = { long: 0, short: 0, range: 0, na: 0 };
  let upLong = 0;
  for (const code in hist.stocks) {
    const st = calcState(hist.stocks[code].c);
    stocks[code] = st;
    dist[st.st] = (dist[st.st] || 0) + 1;
    if (st.st === 'long' && st.up) upLong++;
  }
  const count = Object.keys(stocks).length;
  await fs.writeFile(STATE_FILE, JSON.stringify({ date: latestDate, updated: hist.updated, count, dist, stocks }));

  console.log(`\n✓ 短線狀態快照 — 最新交易日 ${latestDate}，共 ${count} 檔（新增 ${added} 天）`);
  console.log(`  分布：短多 ${dist.long}（其中季線上揚 ${upLong}）/ 短空 ${dist.short} / 盤整 ${dist.range} / 資料不足 ${dist.na}`);
  for (const c of ['2330', '2317', '2454', '6488']) {
    if (stocks[c]) console.log(`  ${c} ${hist.stocks[c]?.n || ''}: ${stocks[c].st} up=${stocks[c].up} d=${stocks[c].d} 季線乖離=${stocks[c].b60}%`);
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
