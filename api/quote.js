// api/quote.js
// 台灣證交所 + 櫃買中心 免費即時 API
// 初始載入：MIS getCategory 取當日行情（含開高低收量）
// 盤中更新：MIS getStockInfo 批次輪詢

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, market, stocks, stock_id } = req.query;

  try {

    // ══════════════════════════════════════════════════
    // 1. 上市股票清單 — 改用 MIS 當日行情（含開高低收量）
    //    非交易時段 fallback 到 TWSE STOCK_DAY_ALL
    // ══════════════════════════════════════════════════
    if (type === 'twse_list' || !type) {
      let data = null;

      // 先嘗試 MIS 全類股批次（上市共 26 個類別代號）
      try {
        const categories = [
          '01','02','03','04','05','06','07','08','09','10',
          '11','12','13','14','15','16','17','18','19','20',
          '21','22','23','24','25','26','27','28','29'
        ];
        const results = [];
        // 每次抓5個類別，避免單次 URL 過長
        for (let i = 0; i < categories.length; i += 5) {
          const batch = categories.slice(i, i + 5);
          const promises = batch.map(cat =>
            fetch(`https://mis.twse.com.tw/stock/api/getCategory.jsp?ex=tse&i=${cat}`, {
              headers: { 'Accept': 'application/json', 'Referer': 'https://mis.twse.com.tw/stock/' }
            }).then(r => r.ok ? r.json() : null).catch(() => null)
          );
          const batchResults = await Promise.all(promises);
          for (const j of batchResults) {
            if (j?.msgArray) results.push(...j.msgArray);
          }
        }
        if (results.length > 100) {
          // 轉成 TWSE-like 格式供前端 processTWSE 使用
          data = results.map(item => ({
            Code:          item.c,
            Name:          item.n || item.nf,
            ClosingPrice:  item.z !== '-' ? item.z : item.y,
            OpeningPrice:  item.o !== '-' ? item.o : '',
            HighestPrice:  item.h !== '-' ? item.h : '',
            LowestPrice:   item.l !== '-' ? item.l : '',
            Change:        (item.z !== '-' && item.y) ? String(parseFloat((parseFloat(item.z) - parseFloat(item.y)).toFixed(2))) : '0',
            TradeVolume:   item.v || '0',
            IndustryCategory: item.i || '',
            _mis: true  // 標記為 MIS 當日資料
          })).filter(d => d.Code && d.ClosingPrice && d.ClosingPrice !== '-' && d.ClosingPrice !== '--');
        }
      } catch(e) { console.log('MIS category fetch failed:', e.message); }

      // Fallback: openapi STOCK_DAY_ALL（前一日資料）
      if (!data || data.length < 100) {
        const r = await fetch(
          'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
          { headers: { 'Accept': 'application/json' } }
        );
        data = await r.json();
      }

      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE', ts: new Date().toISOString() });
    }

    // ══════════════════════════════════════════════════
    // 2. 上櫃股票清單 — 改用 MIS otc getCategory
    // ══════════════════════════════════════════════════
    if (type === 'tpex_list') {
      let data = null;

      try {
        const categories = [
          '01','02','03','04','05','06','07','08','09','10',
          '11','12','13','14','15','16','17','18','19','20',
          '21','22','23','24','25','26'
        ];
        const results = [];
        for (let i = 0; i < categories.length; i += 5) {
          const batch = categories.slice(i, i + 5);
          const promises = batch.map(cat =>
            fetch(`https://mis.twse.com.tw/stock/api/getCategory.jsp?ex=otc&i=${cat}`, {
              headers: { 'Accept': 'application/json', 'Referer': 'https://mis.twse.com.tw/stock/' }
            }).then(r => r.ok ? r.json() : null).catch(() => null)
          );
          const batchResults = await Promise.all(promises);
          for (const j of batchResults) {
            if (j?.msgArray) results.push(...j.msgArray);
          }
        }
        if (results.length > 50) {
          data = results.map(item => ({
            SecuritiesCompanyCode: item.c,
            CompanyName:  item.n || item.nf,
            Close:        item.z !== '-' ? item.z : item.y,
            Open:         item.o !== '-' ? item.o : '',
            High:         item.h !== '-' ? item.h : '',
            Low:          item.l !== '-' ? item.l : '',
            Change:       (item.z !== '-' && item.y) ? String(parseFloat((parseFloat(item.z) - parseFloat(item.y)).toFixed(2))) : '0',
            TradingShares: item.v || '0',
            Industry:     item.i || '',
            _mis: true
          })).filter(d => d.SecuritiesCompanyCode && d.Close && d.Close !== '-' && d.Close !== '--');
        }
      } catch(e) { console.log('MIS otc category failed:', e.message); }

      // Fallback
      if (!data || data.length < 50) {
        const r = await fetch(
          'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
          { headers: { 'Accept': 'application/json' } }
        );
        data = await r.json();
      }

      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TPEx', ts: new Date().toISOString() });
    }

    // ══════════════════════════════════════════════════
    // 3. 盤中即時報價（批次輪詢 + 單股查詢）
    //    type=realtime&market=twse/tpex&stocks=2330,2317,...
    // ══════════════════════════════════════════════════
    if (type === 'realtime' || type === 'twse_realtime' || type === 'tpex_realtime') {
      const stockList = stocks || '';
      if (!stockList) return res.status(400).json({ error: '缺少 stocks 參數' });

      const isTpex = market === 'tpex' || type === 'tpex_realtime';
      const prefix = isTpex ? 'otc' : 'tse';

      const stockParam = stockList.split(',')
        .map(s => s.trim()).filter(Boolean)
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

      // MIS 回傳 { msgArray: [...] }，轉成前端用的 { data: [...] }
      const msgArray = raw.msgArray || [];
      const data = msgArray.map(item => ({
        c:  item.c,   // 代號
        n:  item.n,   // 名稱
        z:  item.z,   // 當盤成交價（'-' = 尚未成交）
        y:  item.y,   // 昨收
        o:  item.o,   // 開盤
        h:  item.h,   // 日高
        l:  item.l,   // 日低
        v:  item.v,   // 累積成交量（張）
        a:  item.a,   // 賣五檔價（_分隔）
        b:  item.b,   // 買五檔價（_分隔）
        f:  item.f,   // 賣五檔量
        g:  item.g,   // 買五檔量
        t:  item.t,   // 最近成交時間
        tv: item.tv,  // 當盤成交量
        u:  item.u,   // 漲停
        w:  item.w,   // 跌停
      }));

      res.setHeader('Cache-Control', 'no-cache, no-store');
      return res.status(200).json({
        data,
        source: isTpex ? 'TPEx_MIS' : 'TWSE_MIS',
        ts: new Date().toISOString()
      });
    }

    // ══════════════════════════════════════════════════
    // 4. 本益比 / 殖利率（上市）
    // ══════════════════════════════════════════════════
    if (type === 'twse_per') {
      const r = await fetch(
        'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
        { headers: { 'Accept': 'application/json' } }
      );
      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE_PER', ts: new Date().toISOString() });
    }

    // ══════════════════════════════════════════════════
    // 5. 三大法人（上市）
    // ══════════════════════════════════════════════════
    if (type === 'twse_institution') {
      const r = await fetch(
        'https://openapi.twse.com.tw/v1/fund/TWT38U',
        { headers: { 'Accept': 'application/json' } }
      );
      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TWSE_INST', ts: new Date().toISOString() });
    }

    // ══════════════════════════════════════════════════
    // 6. 個股日K線（最近3個月）
    // ══════════════════════════════════════════════════
    if (type === 'kline') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });
      const today = new Date();
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
          if (j.data?.length > 0) {
            const rows = j.data.map(row => ({
              date:   row[0].replace(/\//g, '-'),
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
