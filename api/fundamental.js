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
    // 改用 TDCC OpenData CSV API，避免網頁爬蟲被擋
    if (type === 'holders') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });

      // TDCC 開放資料 API：取最新一期集保分散資料
      // 先取得最新日期清單
      let scaDate = '';
      try {
        const dateRes = await fetch(
          'https://openapi.tdcc.com.tw/v1/opendata/1-5',
          { headers: { 'Accept': 'application/json' } }
        );
        if (dateRes.ok) {
          const dateData = await dateRes.json();
          // 找最新一筆對應股票的資料
          const found = dateData.find(d => d.StockNo === stock_id || d.stock_id === stock_id);
          if (found) scaDate = found.ScaDate || found.sca_date || '';
        }
      } catch(e) { /* ignore, will try without date */ }

      // 使用 TDCC 開放資料 API（JSON格式）
      const apiUrl = `https://openapi.tdcc.com.tw/v1/opendata/1-5?StockNo=${stock_id}`;
      const r = await fetch(apiUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-Radar/1.0)'
        }
      });

      if (!r.ok) throw new Error(`TDCC API 回應 ${r.status}`);
      const data = await r.json();

      if (!data || !Array.isArray(data) || data.length === 0) {
        // fallback: 嘗試舊版網頁解析
        return await holdersFromTDCCWeb(stock_id, res);
      }

      // TDCC OpenData 欄位：
      // StockNo, StockName, ScaDate, HolderCount(持股分級代號),
      // People(人數), Shares(股數), Percent(%)
      const rows = data.map(d => ({
        level: d.HolderCount || d.holder_count || d.Level || '',
        people: parseInt((d.People || d.people || '0').replace(/,/g,'')) || 0,
        shares: parseInt((d.Shares || d.shares || '0').replace(/,/g,'')) || 0,
        ratio: parseFloat(d.Percent || d.percent || 0) || 0
      })).filter(r => r.level && r.people > 0);

      // 大戶門檻：持股 >= 1,000,000 股（即 1000 張 × 1000股/張）
      let bigRatio = 0, smallRatio = 0, bigPeople = 0, smallPeople = 0;
      for (const row of rows) {
        const minShares = parseInt(row.level.replace(/,/g,'').split('-')[0].trim()) || 0;
        if (minShares >= 1000000 || row.level.includes('超過') || row.level.includes('以上')) {
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
        source: 'TDCC_OPENAPI',
        scaDate: data[0]?.ScaDate || data[0]?.sca_date || '',
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

// ── Fallback：從 TDCC 網頁解析（備援）──
async function holdersFromTDCCWeb(stock_id, res) {
  try {
    // 先取 session cookie
    const initRes = await fetch('https://www.tdcc.com.tw/portal/zh/smWeb/qryStock', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' }
    });
    const setCookie = initRes.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';')[0];

    const url = `https://www.tdcc.com.tw/portal/zh/smWeb/qryStock`;
    const body = new URLSearchParams({
      scaDate: '', SqlMethod: 'StockNo',
      StockNo: stock_id, StockName: '', radioStockNo: 'StockNo'
    });
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tdcc.com.tw/portal/zh/smWeb/qryStock',
        'Cookie': cookie
      },
      body: body.toString()
    });
    const html = await r.text();

    const rows = [];
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;
    while ((trMatch = trRegex.exec(html)) !== null) {
      const tds = [];
      const tdReg = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let tdMatch;
      while ((tdMatch = tdReg.exec(trMatch[1])) !== null) {
        tds.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
      }
      if (tds.length >= 5 && tds[0].match(/^\d/)) {
        rows.push({
          level: tds[0],
          people: parseInt(tds[1].replace(/,/g,'')) || 0,
          shares: parseInt(tds[2].replace(/,/g,'')) || 0,
          ratio: parseFloat(tds[4]) || 0
        });
      }
    }

    let bigRatio=0, smallRatio=0, bigPeople=0, smallPeople=0;
    for (const row of rows) {
      const minShares = parseInt(row.level.replace(/,/g,'').split('-')[0].trim()) || 0;
      if (minShares >= 1000000 || row.level.includes('超過')) {
        bigRatio += row.ratio; bigPeople += row.people;
      } else {
        smallRatio += row.ratio; smallPeople += row.people;
      }
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).json({
      stock_id, rows,
      summary: {
        bigHolder: parseFloat(bigRatio.toFixed(2)),
        smallHolder: parseFloat(smallRatio.toFixed(2)),
        bigPeople, smallPeople, totalPeople: bigPeople + smallPeople
      },
      source: 'TDCC_WEB',
      ts: new Date().toISOString()
    });
  } catch(e) {
    return res.status(200).json({
      stock_id, rows: [],
      summary: { bigHolder:0, smallHolder:0, bigPeople:0, smallPeople:0, totalPeople:0 },
      source: 'TDCC_FAIL', error: e.message
    });
  }
}
