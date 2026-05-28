// api/fundamental.js
// 基本面資料：三大法人、集保持股分散、董監持股、融資融券

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, stock_id } = req.query;

  try {
    // ── 1. 集保持股分散（大戶/散戶比例）──
    if (type === 'holders') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });

      // 集保結算所 API
      const url = `https://www.tdcc.com.tw/portal/zh/smWeb/qryStock?scaDate=&SqlMethod=StockNo&StockNo=${stock_id}&StockName=&radioStockNo=StockNo`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Referer': 'https://www.tdcc.com.tw/portal/zh/smWeb/qryStock'
        }
      });
      const html = await r.text();

      // 解析持股分散資料
      const rows = [];
      const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let trMatch;
      while ((trMatch = trRegex.exec(html)) !== null) {
        const tds = [];
        let tdMatch;
        const tdReg = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        while ((tdMatch = tdReg.exec(trMatch[1])) !== null) {
          tds.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
        }
        if (tds.length >= 5 && tds[0].match(/^\d+/)) {
          rows.push({
            level: tds[0],      // 持股分級
            people: parseInt(tds[1].replace(/,/g, '')) || 0,  // 人數
            shares: parseInt(tds[2].replace(/,/g, '')) || 0,  // 股數
            ratio: parseFloat(tds[4]) || 0   // 持股比例
          });
        }
      }

      // 計算大戶（1000張以上）vs 散戶（999張以下）
      let bigRatio = 0, smallRatio = 0, bigPeople = 0, smallPeople = 0;
      for (const row of rows) {
        const level = row.level;
        // 1000張以上為大戶
        if (level.includes('1,000,001') || level.includes('超過')) {
          bigRatio += row.ratio;
          bigPeople += row.people;
        } else if (parseInt(level.replace(/,/g,'')) >= 1000000) {
          bigRatio += row.ratio;
          bigPeople += row.people;
        } else {
          smallRatio += row.ratio;
          smallPeople += row.people;
        }
      }

      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json({
        stock_id,
        rows,
        summary: {
          bigHolder: parseFloat(bigRatio.toFixed(2)),
          smallHolder: parseFloat(smallRatio.toFixed(2)),
          bigPeople,
          smallPeople,
          totalPeople: bigPeople + smallPeople
        },
        source: 'TDCC',
        ts: new Date().toISOString()
      });
    }

    // ── 2. 三大法人買賣（上市）──
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

    // ── 3. 融資融券（上市）──
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

    // ── 4. 外資持股比例（上市）──
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

    // ── 5. 董監持股（上市）──
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
