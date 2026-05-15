// api/quote.js
// 台灣證交所 + 櫃買中心 免費即時 API
// 不需要任何 Token，完全免費

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type } = req.query;

  try {
    // ── 1. 取得全部上市股票清單 + 當日收盤資料 ──
    if (type === 'twse_list' || !type) {
      const r = await fetch(
        'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
        { headers: { 'Accept': 'application/json' } }
      );
      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE', ts: new Date().toISOString() });
    }

    // ── 2. 取得全部上櫃股票清單 + 當日收盤資料 ──
    if (type === 'tpex_list') {
      const r = await fetch(
        'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
        { headers: { 'Accept': 'application/json' } }
      );
      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TPEx', ts: new Date().toISOString() });
    }

    // ── 3. 取得上市即時報價（盤中，多檔） ──
    if (type === 'twse_realtime') {
      const { stocks } = req.query;
      if (!stocks) return res.status(400).json({ error: '缺少 stocks 參數' });
      // 格式：tse_2330.tw|tse_2317.tw
      const stockParam = stocks.split(',')
        .map(s => `tse_${s}.tw`)
        .join('|');
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${stockParam}&json=1&delay=0`;
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      const data = await r.json();
      res.setHeader('Cache-Control', 'no-cache');
      return res.status(200).json({ data, source: 'TWSE_MIS', ts: new Date().toISOString() });
    }

    // ── 4. 取得上櫃即時報價（盤中，多檔） ──
    if (type === 'tpex_realtime') {
      const { stocks } = req.query;
      if (!stocks) return res.status(400).json({ error: '缺少 stocks 參數' });
      const stockParam = stocks.split(',')
        .map(s => `otc_${s}.tw`)
        .join('|');
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${stockParam}&json=1&delay=0`;
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      const data = await r.json();
      res.setHeader('Cache-Control', 'no-cache');
      return res.status(200).json({ data, source: 'TPEx_MIS', ts: new Date().toISOString() });
    }

    // ── 5. 取得本益比資料（上市） ──
    if (type === 'twse_per') {
      const r = await fetch(
        'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
        { headers: { 'Accept': 'application/json' } }
      );
      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE_PER', ts: new Date().toISOString() });
    }

    // ── 6. 取得三大法人資料（上市） ──
    if (type === 'twse_institution') {
      const r = await fetch(
        'https://openapi.twse.com.tw/v1/fund/TWT38U',
        { headers: { 'Accept': 'application/json' } }
      );
      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE_INST', ts: new Date().toISOString() });
    }

    return res.status(400).json({ error: '不支援的 type 參數' });

  } catch (err) {
    return res.status(500).json({ error: '資料取得失敗：' + err.message });
  }
}
