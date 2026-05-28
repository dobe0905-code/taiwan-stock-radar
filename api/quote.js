// api/quote.js
// 台灣證交所 + 櫃買中心 免費即時 API

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, market, stocks, stock_id } = req.query;

  try {

    // ── 1. 上市股票清單（當日收盤）──
    if (type === 'twse_list' || !type) {
      const r = await fetch(
        'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
        { headers: { 'Accept': 'application/json' } }
      );
      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE', ts: new Date().toISOString() });
    }

    // ── 2. 上櫃股票清單（當日收盤）──
    if (type === 'tpex_list') {
      const r = await fetch(
        'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
        { headers: { 'Accept': 'application/json' } }
      );
      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TPEx', ts: new Date().toISOString() });
    }

    // ── 3. 盤中即時報價（前端統一用 type=realtime&market=twse/tpex）──
    //    同時相容舊版 type=twse_realtime / tpex_realtime
    if (type === 'realtime' || type === 'twse_realtime' || type === 'tpex_realtime') {
      const stockList = stocks || '';
      if (!stockList) return res.status(400).json({ error: '缺少 stocks 參數' });

      // 判斷市場：優先用 market 參數，其次從 type 推斷
      const isTpex = market === 'tpex' || type === 'tpex_realtime';
      const prefix = isTpex ? 'otc' : 'tse';

      const stockParam = stockList.split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => `${prefix}_${s}.tw`)
        .join('|');

      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(stockParam)}&json=1&delay=0&_=${Date.now()}`;

      const r = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://mis.twse.com.tw/stock/index.jsp'
        }
      });
      const raw = await r.json();

      // MIS 回傳格式：{ msgArray: [ {c,z,y,o,h,l,v,...}, ... ] }
      // 統一轉成前端期望的 { data: [...] }，保留原始欄位
      const msgArray = raw.msgArray || [];
      const data = msgArray.map(item => ({
        c:  item.c,            // 股票代號
        n:  item.n,            // 股票名稱
        z:  item.z,            // 當盤成交價
        y:  item.y,            // 昨日收盤價
        o:  item.o,            // 開盤價
        h:  item.h,            // 最高價
        l:  item.l,            // 最低價
        v:  item.v,            // 成交量（張）
        a:  item.a,            // 最佳五檔賣出價格
        b:  item.b,            // 最佳五檔買入價格
        f:  item.f,            // 最佳五檔賣出量
        g:  item.g,            // 最佳五檔買入量
        t:  item.t,            // 最新成交時間
        tv: item.tv,           // 當盤成交量
      }));

      res.setHeader('Cache-Control', 'no-cache, no-store');
      return res.status(200).json({
        data,
        msgArray,              // 同時保留原始格式，給其他需求使用
        source: isTpex ? 'TPEx_MIS' : 'TWSE_MIS',
        ts: new Date().toISOString()
      });
    }

    // ── 4. 本益比資料（上市）──
    if (type === 'twse_per') {
      const r = await fetch(
        'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
        { headers: { 'Accept': 'application/json' } }
      );
      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE_PER', ts: new Date().toISOString() });
    }

    // ── 5. 三大法人資料（上市）──
    if (type === 'twse_institution') {
      const r = await fetch(
        'https://openapi.twse.com.tw/v1/fund/TWT38U',
        { headers: { 'Accept': 'application/json' } }
      );
      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE_INST', ts: new Date().toISOString() });
    }

    // ── 6. 個股 K 線歷史資料 ──
    if (type === 'kline') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });
      const today = new Date();
      // 抓最近3個月
      const results = [];
      for (let m = 0; m < 3; m++) {
        const d = new Date(today.getFullYear(), today.getMonth() - m, 1);
        const ym = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}01`;
        try {
          const r = await fetch(
            `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ym}&stockNo=${stock_id}&response=json`,
            { headers: { 'Accept': 'application/json' } }
          );
          const j = await r.json();
          if (j.data && j.data.length > 0) {
            const rows = j.data.map(row => ({
              date:   row[0].replace(/\//g,'-'),
              open:   parseFloat(row[3]?.replace(/,/g,'')) || 0,
              high:   parseFloat(row[4]?.replace(/,/g,'')) || 0,
              low:    parseFloat(row[5]?.replace(/,/g,'')) || 0,
              close:  parseFloat(row[6]?.replace(/,/g,'')) || 0,
              volume: parseInt(row[1]?.replace(/,/g,'')) || 0,
            }));
            results.unshift(...rows);
          }
        } catch(e) { /* 跳過某月 */ }
      }
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
      return res.status(200).json({ data: results, stock_id, source: 'TWSE_KLINE' });
    }

    return res.status(400).json({ error: '不支援的 type 參數' });

  } catch (err) {
    return res.status(500).json({ error: '資料取得失敗：' + err.message });
  }
}
