// api/quote.js
// 台灣證交所 + 櫃買中心 免費即時 API

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, market, stocks, stock_id } = req.query;

  try {

    // ══════════════════════════════════════════════════
    // 1. 上市股票清單 — 當日行情
    //    主要：www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX（當日全市場）
    //    備援：openapi STOCK_DAY_ALL（前一日，至少有資料）
    // ══════════════════════════════════════════════════
    if (type === 'twse_list' || !type) {
      let data = null;

      // 主要：TWSE 官網 MI_INDEX 當日全市場行情
      try {
        const today = new Date();
        const yyyymmdd = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
        const r = await fetch(
          `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${yyyymmdd}&type=ALLBUT0999&response=json`,
          { headers: { 'Accept': 'application/json', 'Referer': 'https://www.twse.com.tw/' } }
        );
        if (r.ok) {
          const j = await r.json();
          // MI_INDEX tables[8] 或 tables[9] 是個股資料
          // 欄位：證券代號,證券名稱,成交股數,成交筆數,成交金額,開盤價,最高價,最低價,收盤價,漲跌(+/-),漲跌價差
          const tables = j.tables || [];
          let stockTable = tables.find(t => t.title && t.title.includes('個股') && t.data?.length > 100);
          if (!stockTable) stockTable = tables.find(t => t.data?.length > 100);
          if (stockTable?.data?.length > 100) {
            data = stockTable.data.map(row => ({
              Code:          row[0]?.trim(),
              Name:          row[1]?.trim(),
              TradeVolume:   row[2]?.replace(/,/g,''),
              TradeValue:    row[4]?.replace(/,/g,''),   // 成交金額（元）→ 前端均價公式
              OpeningPrice:  row[5]?.replace(/,/g,''),
              HighestPrice:  row[6]?.replace(/,/g,''),
              LowestPrice:   row[7]?.replace(/,/g,''),
              ClosingPrice:  row[8]?.replace(/,/g,''),
              Change:        row[10]?.replace(/,/g,'') || '0',
              Dir:           row[9]?.trim(),  // + or -
              IndustryCategory: '',
              _today: true
            })).filter(d => d.Code && /^\d{4}/.test(d.Code) && d.ClosingPrice && d.ClosingPrice !== '--');
            // 修正漲跌符號
            data = data.map(d => ({
              ...d,
              Change: d.Dir === '-' ? String(-Math.abs(parseFloat(d.Change)||0)) : String(parseFloat(d.Change)||0)
            }));
          }
        }
      } catch(e) { console.log('MI_INDEX failed:', e.message); }

      // 若 MI_INDEX 無資料（盤中），改用 MIS getCategory 取即時（限時內批次抓前5類）
      if (!data || data.length < 100) {
        try {
          // 只抓前10個主要類別（半導體、電子等大類），快速拿到主要股票
          const topCats = ['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15'];
          const results = [];
          const fetches = topCats.map(cat =>
            fetch(`https://mis.twse.com.tw/stock/api/getCategory.jsp?ex=tse&i=${cat}`, {
              headers: { 'Accept': 'application/json', 'Referer': 'https://mis.twse.com.tw/stock/' }
            }).then(r => r.ok ? r.json() : null).catch(() => null)
          );
          const all = await Promise.all(fetches);
          for (const j of all) {
            if (j?.msgArray) results.push(...j.msgArray);
          }
          if (results.length > 50) {
            data = results.map(item => ({
              Code:          item.c,
              Name:          item.n || item.nf,
              ClosingPrice:  item.z !== '-' ? item.z : item.y,
              OpeningPrice:  item.o !== '-' ? item.o : item.y,
              HighestPrice:  item.h !== '-' ? item.h : item.y,
              LowestPrice:   item.l !== '-' ? item.l : item.y,
              Change:        (item.z && item.z !== '-' && item.y)
                               ? String(parseFloat((parseFloat(item.z)-parseFloat(item.y)).toFixed(2)))
                               : '0',
              TradeVolume:   item.v || '0',
              IndustryCategory: '',
              _mis: true
            })).filter(d => d.Code && d.ClosingPrice && d.ClosingPrice !== '-');
          }
        } catch(e) { console.log('MIS category failed:', e.message); }
      }

      // 終極備援：openapi STOCK_DAY_ALL
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
    // 2. 上櫃股票清單 — 當日行情
    // ══════════════════════════════════════════════════
    if (type === 'tpex_list') {
      let data = null;

      // 主要：TPEx 官網當日行情
      try {
        const today = new Date();
        const yy = today.getFullYear() - 1911;
        const mm = String(today.getMonth()+1).padStart(2,'0');
        const dd = String(today.getDate()).padStart(2,'0');
        const r = await fetch(
          `https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_close_download.php?d=${yy}%2F${mm}%2F${dd}&s=0,asc,0&o=json`,
          { headers: { 'Accept': 'application/json', 'Referer': 'https://www.tpex.org.tw/' } }
        );
        if (r.ok) {
          const j = await r.json();
          const rows = j.aaData || j.data || [];
          if (rows.length > 50) {
            data = rows.map(row => ({
              SecuritiesCompanyCode: row[0]?.trim(),
              CompanyName:  row[1]?.trim(),
              Close:        row[2]?.replace(/,/g,''),
              Change:       row[3]?.replace(/,/g,'') || '0',
              Open:         row[5]?.replace(/,/g,''),
              High:         row[6]?.replace(/,/g,''),
              Low:          row[7]?.replace(/,/g,''),
              TradingShares: row[8]?.replace(/,/g,''),
              TradeValue:   row[9]?.replace(/,/g,''),  // 成交金額（元）
              Industry:     '',
              _today: true
            })).filter(d => d.SecuritiesCompanyCode && d.Close && d.Close !== '--');
          }
        }
      } catch(e) { console.log('TPEx daily failed:', e.message); }

      // 備援：openapi
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
    // 3. 盤中即時報價（MIS getStockInfo）
    // ══════════════════════════════════════════════════
    if (type === 'realtime' || type === 'twse_realtime' || type === 'tpex_realtime') {
      const stockList = stocks || '';
      if (!stockList) return res.status(400).json({ error: '缺少 stocks 參數' });
      const isTpex = market === 'tpex' || type === 'tpex_realtime';
      const prefix = isTpex ? 'otc' : 'tse';
      const stockParam = stockList.split(',').map(s=>s.trim()).filter(Boolean)
        .map(s=>`${prefix}_${s}.tw`).join('|');
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(stockParam)}&json=1&delay=0&_=${Date.now()}`;
      const r = await fetch(url, {
        headers: { 'Accept':'application/json','User-Agent':'Mozilla/5.0','Referer':'https://mis.twse.com.tw/stock/index.jsp' }
      });
      const raw = await r.json();
      const data = (raw.msgArray||[]).map(item => ({
        c:item.c, n:item.n, z:item.z, y:item.y, o:item.o,
        h:item.h, l:item.l, v:item.v, a:item.a, b:item.b,
        f:item.f, g:item.g, t:item.t, tv:item.tv, u:item.u, w:item.w
      }));
      res.setHeader('Cache-Control','no-cache, no-store');
      return res.status(200).json({ data, source: isTpex?'TPEx_MIS':'TWSE_MIS', ts: new Date().toISOString() });
    }

    // ══════════════════════════════════════════════════
    // 4. 本益比 / 殖利率
    // ══════════════════════════════════════════════════
    if (type === 'twse_per') {
      const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
        { headers:{'Accept':'application/json'} });
      const data = await r.json();
      res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ data, source:'TWSE_PER', ts: new Date().toISOString() });
    }

    // ══════════════════════════════════════════════════
    // 5. 三大法人
    // ══════════════════════════════════════════════════
    if (type === 'twse_institution') {
      const r = await fetch('https://openapi.twse.com.tw/v1/fund/TWT38U',
        { headers:{'Accept':'application/json'} });
      const data = await r.json();
      res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ data, source:'TWSE_INST', ts: new Date().toISOString() });
    }

    // ══════════════════════════════════════════════════
    // 6. 個股日K線（最近4個月，確保季線60天資料足夠）
    // ══════════════════════════════════════════════════
    if (type === 'kline') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });
      const today = new Date();
      const results = [];
      // 抓4個月，確保足夠計算 MA60（季線）
      for (let m = 0; m < 4; m++) {
        const d = new Date(today.getFullYear(), today.getMonth()-m, 1);
        const ym = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}01`;
        try {
          const r = await fetch(
            `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ym}&stockNo=${stock_id}&response=json`,
            { headers:{'Accept':'application/json','Referer':'https://www.twse.com.tw/'} }
          );
          const j = await r.json();
          if (j.data?.length > 0) {
            results.unshift(...j.data.map(row => ({
              date:  row[0].replace(/\//g,'-'),
              open:  parseFloat(row[3]?.replace(/,/g,''))||0,
              high:  parseFloat(row[4]?.replace(/,/g,''))||0,
              low:   parseFloat(row[5]?.replace(/,/g,''))||0,
              close: parseFloat(row[6]?.replace(/,/g,''))||0,
              volume:Math.round((parseInt(row[1]?.replace(/,/g,''))||0)/1000), // 股→張
            })));
          }
        } catch(e) { /* skip */ }
      }
      res.setHeader('Cache-Control','s-maxage=1800, stale-while-revalidate');
      return res.status(200).json({ data:results, stock_id, source:'TWSE_KLINE' });
    }

    // ══════════════════════════════════════════════════
    // 7. 融資融券（個股，當日）
    //    來源：TWSE 官網 MI_MARGN（與投資資訊中心 IIH2 同源）
    //    欄位: [0]代號 [1]名稱
    //    融資: [2]買進 [3]賣出 [4]現金償還 [5]餘額 [6]限額 [7]使用率%
    //    融券: [8]賣出 [9]買進 [10]現券償還 [11]餘額 [12]限額 [13]使用率%
    //    [14]資券互抵
    // ══════════════════════════════════════════════════
    if (type === 'margin_detail') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });
      const today = new Date();
      const yyyymmdd = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
      const pi = (v) => parseInt((v||'0').replace(/,/g,'')) || 0;
      const pf = (v) => parseFloat((v||'0').replace(/,/g,'')) || 0;
      try {
        const r = await fetch(
          `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${yyyymmdd}&selectType=STOCK&response=json`,
          { headers:{'Accept':'application/json','Referer':'https://www.twse.com.tw/zh/'} }
        );
        const j = await r.json();
        const rows = j.data||[];
        const fields = j.fields||[];
        const item = rows.find(row => row[0]===stock_id);
        res.setHeader('Cache-Control','s-maxage=1800, stale-while-revalidate');
        return res.status(200).json({
          stock_id, fields,
          data: item ? {
            marginBuy:     pi(item[2]),   // 融資買進（張）
            marginSell:    pi(item[3]),   // 融資賣出（張）
            marginRedeem:  pi(item[4]),   // 現金償還（張）
            marginBalance: pi(item[5]),   // 融資餘額（張）
            marginLimit:   pi(item[6]),   // 融資限額（張）
            marginUsage:   pf(item[7]),   // 融資使用率（%）
            shortSell:     pi(item[8]),   // 融券賣出（張）
            shortBuy:      pi(item[9]),   // 融券買進（張）
            shortReturn:   pi(item[10]),  // 現券償還（張）
            shortBalance:  pi(item[11]),  // 融券餘額（張）
            shortLimit:    pi(item[12]),  // 融券限額（張）
            shortUsage:    pf(item[13]),  // 融券使用率（%）
            offset:        pi(item[14]),  // 資券互抵（張）
          } : null,
          source: 'TWSE_MI_MARGN',
          date: yyyymmdd
        });
      } catch(e) {
        return res.status(200).json({ stock_id, data: null, error: e.message });
      }
    }

    // ══════════════════════════════════════════════════
    // 9. 個股當日分時走勢（MIS即時）
    // ══════════════════════════════════════════════════
    if (type === 'intraday') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });
      try {
        const mkt = req.query.market || 'twse';
        const prefix = mkt === 'tpex' ? 'otc' : 'tse';
        const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${prefix}_${stock_id}.tw&json=1&delay=0&_=${Date.now()}`;
        const r = await fetch(url, {
          headers: {'Accept':'application/json','User-Agent':'Mozilla/5.0','Referer':'https://mis.twse.com.tw/stock/index.jsp'}
        });
        const j = await r.json();
        const item = (j.msgArray||[])[0];
        res.setHeader('Cache-Control','no-cache,no-store');
        return res.status(200).json({
          stock_id,
          data: item ? {
            price:  parseFloat(item.z)||parseFloat(item.y)||0,
            open:   parseFloat(item.o)||0,
            high:   parseFloat(item.h)||0,
            low:    parseFloat(item.l)||0,
            prev:   parseFloat(item.y)||0,
            volume: parseFloat(item.v)||0,
            time:   item.t||'',
            // 分時成交序列（最多20筆）
            trades: (item.tv||'').split('_').filter(Boolean).slice(-20).map(v=>parseFloat(v)||0),
            prices: (item.z||'').split('_').filter(Boolean).slice(-20).map(v=>parseFloat(v)||0),
          } : null,
          source: 'TWSE_MIS_INTRADAY'
        });
      } catch(e) {
        return res.status(200).json({ stock_id, data: null, error: e.message });
      }
    }

    // ══════════════════════════════════════════════════
    // 8. 三大法人個股買賣（當日）
    //
    // T86 資料單位是「股」，需 ÷1000 換算成「張」
    // T86 欄位 (fields): 
    //  [0]代號 [1]名稱
    //  外資及陸資(不含外資自營商): [2]買進股數 [3]賣出股數 [4]買賣超股數
    //  外資自營商: [5] [6] [7]
    //  外資及陸資: [8] [9] [10]  (含外資自營商合計)
    //  投信: [11] [12] [13]
    //  自營商(自行買賣): [14] [15] [16]
    //  自營商(避險): [17] [18] [19]
    //  自營商: [20] [21] [22]  (合計)
    //  三大法人: [23]  (合計買賣超股數)
    // ══════════════════════════════════════════════════
    if (type === 'institution_detail') {
      if (!stock_id) return res.status(400).json({ error: '缺少 stock_id' });
      try {
        const today = new Date();
        const yyyymmdd = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;

        const r = await fetch(
          `https://www.twse.com.tw/rwd/zh/fund/T86?date=${yyyymmdd}&selectType=ALLBUT0999&response=json`,
          { headers:{'Accept':'application/json','Referer':'https://www.twse.com.tw/'} }
        );
        const j = await r.json();
        const rows = j.data||[];
        const fields = j.fields||[];
        const item = rows.find(row => row[0]===stock_id);

        // T86 單位為「股」，÷1000 = 張
        const lots = (v) => {
          const n = parseInt((v||'0').replace(/,/g,'').replace(/\+/g,'')) || 0;
          return Math.round(n / 1000);
        };

        // 動態根據 fields 定位正確欄位
        let fBuyIdx=2, fSellIdx=3, fNetIdx=4;
        let tBuyIdx=11, tSellIdx=12, tNetIdx=13;
        let dNetIdx=22, totalIdx=23;
        if(fields.length > 0){
          // 找外資買進欄位
          for(let i=0;i<fields.length;i++){
            if(fields[i]&&fields[i].includes('外資')&&fields[i].includes('買進')&&!fields[i].includes('自營')) { fBuyIdx=i; break; }
          }
          for(let i=0;i<fields.length;i++){
            if(fields[i]&&fields[i].includes('外資')&&fields[i].includes('賣出')&&!fields[i].includes('自營')) { fSellIdx=i; break; }
          }
          for(let i=0;i<fields.length;i++){
            if(fields[i]&&fields[i].includes('外資')&&fields[i].includes('買賣超')&&!fields[i].includes('自營')) { fNetIdx=i; break; }
          }
          for(let i=0;i<fields.length;i++){
            if(fields[i]&&fields[i].includes('投信')&&fields[i].includes('買進')) { tBuyIdx=i; break; }
          }
          for(let i=0;i<fields.length;i++){
            if(fields[i]&&fields[i].includes('投信')&&fields[i].includes('賣出')) { tSellIdx=i; break; }
          }
          for(let i=0;i<fields.length;i++){
            if(fields[i]&&fields[i].includes('投信')&&fields[i].includes('買賣超')) { tNetIdx=i; break; }
          }
          // 自營商合計買賣超（找最後一個含"自營商"且含"買賣超"不含"自行"/"避險"）
          for(let i=fields.length-1;i>=0;i--){
            if(fields[i]&&fields[i].includes('自營商')&&fields[i].includes('買賣超')&&!fields[i].includes('自行')&&!fields[i].includes('避險')) { dNetIdx=i; break; }
          }
          // 三大法人合計買賣超
          for(let i=fields.length-1;i>=0;i--){
            if(fields[i]&&fields[i].includes('三大法人')) { totalIdx=i; break; }
          }
        }

        res.setHeader('Cache-Control','s-maxage=1800, stale-while-revalidate');
        return res.status(200).json({
          stock_id,
          fields,
          data: item ? {
            foreignBuy:  lots(item[fBuyIdx]),   // 外資買進（張）
            foreignSell: lots(item[fSellIdx]),   // 外資賣出（張）
            foreignNet:  lots(item[fNetIdx]),    // 外資買賣超（張）
            trustBuy:    lots(item[tBuyIdx]),    // 投信買進（張）
            trustSell:   lots(item[tSellIdx]),   // 投信賣出（張）
            trustNet:    lots(item[tNetIdx]),    // 投信買賣超（張）
            dealerNet:   lots(item[dNetIdx]),    // 自營商合計買賣超（張）
            totalNet:    lots(item[totalIdx]),   // 三大法人合計（張）
          } : null,
          source: 'TWSE_T86',
          date: yyyymmdd
        });
      } catch(e) {
        return res.status(200).json({ stock_id, data: null, error: e.message });
      }
    }

    return res.status(400).json({ error: '不支援的 type 參數' });

  } catch (err) {
    return res.status(500).json({ error: '資料取得失敗：' + err.message });
  }
}
