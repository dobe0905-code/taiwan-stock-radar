// api/quote.js
// 台灣證交所 MIS 即時 API + 歷史資料
// 完全免費，不需要任何 Token

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type } = req.query;

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://mis.twse.com.tw/',
    'Accept': 'application/json',
  };

  try {
    // ── 1. 盤中即時：上市 + 上櫃（批次，最多50檔）──
    if (type === 'realtime') {
      const { stocks, market } = req.query;
      if (!stocks) return res.status(400).json({ error: '缺少 stocks 參數' });
      const ex = market === 'tpex' ? 'otc' : 'tse';
      const param = stocks.split(',').map(s => `${ex}_${s.trim()}.tw`).join('|');
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${param}&json=1&delay=0`;
      const r = await fetch(url, { headers: HEADERS });
      const data = await r.json();
      res.setHeader('Cache-Control', 'no-cache, no-store');
      return res.status(200).json({ data: data.msgArray || [], ts: new Date().toISOString() });
    }

    // ── 2. 全部上市收盤清單（每日更新）──
    if (type === 'twse_list') {
      const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
        { headers: { 'Accept': 'application/json' } });
      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE', ts: new Date().toISOString() });
    }

    // ── 3. 全部上櫃收盤清單（每日更新）──
    if (type === 'tpex_list') {
      const r = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
        { headers: { 'Accept': 'application/json' } });
      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TPEx', ts: new Date().toISOString() });
    }

    // ── 4. 本益比 / 殖利率 / PBR（上市）──
    if (type === 'twse_per') {
      const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
        { headers: { 'Accept': 'application/json' } });
      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE_PER', ts: new Date().toISOString() });
    }

    // ── 5. K 線圖歷史資料（上市，近3個月日K）──
    if (type === 'kline') {
      const { stock_id } = req.query;
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });
      const now = new Date();
      const results = [];
      for (let i = 0; i < 3; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const ym = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}`;
        try {
          const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ym}01&stockNo=${stock_id}&response=json`;
          const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
          const data = await r.json();
          if (data.data) {
            for (const row of data.data) {
              const [y, m, dd] = row[0].replace(/\//g,'-').split('-');
              results.push({
                date: `${parseInt(y)+1911}-${m}-${dd}`,
                open: parseFloat(row[3].replace(/,/g,'')),
                high: parseFloat(row[4].replace(/,/g,'')),
                low:  parseFloat(row[5].replace(/,/g,'')),
                close:parseFloat(row[6].replace(/,/g,'')),
                volume: parseInt(row[1].replace(/,/g,'')),
                change: row[7]
              });
            }
          }
        } catch(e) {}
      }
      results.sort((a,b)=>a.date.localeCompare(b.date));
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.status(200).json({ data: results, stock_id, source: 'TWSE_KLINE' });
    }

    // ── 6. 三大法人（上市）──
    if (type === 'institution') {
      const r = await fetch('https://openapi.twse.com.tw/v1/fund/TWT38U',
        { headers: { 'Accept': 'application/json' } });
      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE_INST', ts: new Date().toISOString() });
    }

    return res.status(400).json({ error: '不支援的 type 參數' });

  } catch (err) {
    return res.status(500).json({ error: '資料取得失敗：' + err.message });
  }
}
