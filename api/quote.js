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

    // ── 7. K 線圖：上市個股歷史月資料 ──
    if (type === 'kline') {
      const { stock_id, period } = req.query;
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });

      // 取近12個月的資料
      const months = [];
      const now = new Date();
      for (let i = 0; i < 12; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}`);
      }

      const results = [];
      // 只取最近3個月（避免 Vercel timeout）
      for (const ym of months.slice(0, 3)) {
        try {
          const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ym}01&stockNo=${stock_id}&response=json`;
          const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
          const data = await r.json();
          if (data.data) {
            for (const row of data.data) {
              // row: [日期, 成交量, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌, 筆數]
              const dateStr = row[0].replace(/\//g, '-');
              const [y, m, d] = dateStr.split('-');
              const fullDate = `${parseInt(y)+1911}-${m}-${d}`;
              results.push({
                date:   fullDate,
                open:   parseFloat(row[3].replace(/,/g,'')),
                high:   parseFloat(row[4].replace(/,/g,'')),
                low:    parseFloat(row[5].replace(/,/g,'')),
                close:  parseFloat(row[6].replace(/,/g,'')),
                volume: parseInt(row[1].replace(/,/g,'')),
                change: row[7]
              });
            }
          }
        } catch(e) { /* 略過錯誤月份 */ }
      }

      results.sort((a, b) => a.date.localeCompare(b.date));
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.status(200).json({ data: results, stock_id, source: 'TWSE_KLINE' });
    }

    // ── 8. K 線圖：上市個股歷史週/日資料（近60天）──
    if (type === 'kline_recent') {
      const { stock_id } = req.query;
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });

      const now = new Date();
      const ym = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}`;

      try {
        const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ym}01&stockNo=${stock_id}&response=json`;
        const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
        const data = await r.json();
        const results = [];
        if (data.data) {
          for (const row of data.data) {
            const dateStr = row[0].replace(/\//g, '-');
            const [y, m, d] = dateStr.split('-');
            const fullDate = `${parseInt(y)+1911}-${m}-${d}`;
            results.push({
              date:   fullDate,
              open:   parseFloat(row[3].replace(/,/g,'')),
              high:   parseFloat(row[4].replace(/,/g,'')),
              low:    parseFloat(row[5].replace(/,/g,'')),
              close:  parseFloat(row[6].replace(/,/g,'')),
              volume: parseInt(row[1].replace(/,/g,'')),
            });
          }
        }
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
        return res.status(200).json({ data: results, stock_id, source: 'TWSE_KLINE_RECENT' });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: '不支援的 type 參數' });

  } catch (err) {
    return res.status(500).json({ error: '資料取得失敗：' + err.message });
  }
}
