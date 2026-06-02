// api/quote.js
// 台灣證交所 + 櫃買中心 免費即時 API
import { promises as fs } from 'fs';
import path from 'path';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, market, stocks, stock_id } = req.query;

  try {

    // ══════════════════════════════════════════════════
    // 0. 全市場短線狀態（GitHub Action 每交易日快照，主表格徽章用）
    //    type=shortterm               → 全市場 map { code:{st,up,d,b60} }
    //    type=shortterm&stock_id=2330 → 單檔
    // ══════════════════════════════════════════════════
    if (type === 'shortterm') {
      try {
        const file = path.join(process.cwd(), 'data', 'prices', 'state-latest.json');
        const snap = JSON.parse(await fs.readFile(file, 'utf8'));
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
        if (stock_id) {
          return res.status(200).json({ stock_id, date: snap.date, data: snap.stocks?.[stock_id] || null, source: 'prices_snapshot' });
        }
        return res.status(200).json({ date: snap.date, updated: snap.updated, count: snap.count, dist: snap.dist, stocks: snap.stocks, source: 'prices_snapshot' });
      } catch (e) {
        return res.status(200).json({ stock_id: stock_id || null, data: null, stocks: {}, error: e.message });
      }
    }

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
            // 修正漲跌符號：row[9] 是 HTML（綠=跌 <p ...color:green>-</p>、紅=漲 ...color:red>+</p>）
            // 舊版用 d.Dir==='-' 比對 HTML 字串永遠 false，導致下跌股 Change 維持正值而被顯示為上漲
            data = data.map(d => {
              const dir = String(d.Dir || '');
              const isDown = /green/i.test(dir) || /<[^>]*>\s*-/.test(dir) || dir.trim() === '-';
              const mag = Math.abs(parseFloat(d.Change) || 0);
              return { ...d, Change: isDown ? String(-mag) : String(mag) };
            });
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

      // 過濾權證/牛熊證/ETN，只保留普通股與 ETF
      // （上櫃股票清單原始含上萬檔權證，會拖慢前端載入並污染漲跌幅排序）
      const isRealStock = (code, name) => {
        if (!code) return false;
        if (/[購售]\d|牛\d|熊\d|購$|售$/.test(name || '')) return false; // 權證/牛熊證
        if (/^\d{4}$/.test(code)) return true;        // 普通股（4 位數字）
        if (/^00\d{2,4}$/.test(code)) return true;    // ETF（00 開頭）
        if (/^\d{4}[A-Z]$/.test(code)) return true;   // 特別股（如 2841A）
        return false;                                  // 其餘（6 位權證等）剔除
      };
      data = (data || []).filter(d => isRealStock(d.SecuritiesCompanyCode, d.CompanyName));

      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TPEx', ts: new Date().toISOString() });
    }

    // ══════════════════════════════════════════════════
    // 2b. 興櫃股票每日行情（TPEx openapi，議價市場無漲跌幅限制）
    // ══════════════════════════════════════════════════
    if (type === 'emerging_list') {
      let data = [];
      try {
        const r = await fetch(
          'https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics',
          { headers: { 'Accept': 'application/json', 'Referer': 'https://www.tpex.org.tw/' } }
        );
        const j = await r.json();
        if (Array.isArray(j)) {
          // 議價市場：LatestPrice=最新成交價(現價)、PreviousAveragePrice=昨日均價(昨收近似)
          // 無 Open；Highest/Lowest=當日高低；Average=均價；TransactionVolume=成交量(股)
          data = j
            .filter(d => d.SecuritiesCompanyCode && /^\d{4}$/.test(d.SecuritiesCompanyCode.trim()))
            .map(d => ({
              SecuritiesCompanyCode: d.SecuritiesCompanyCode.trim(),
              CompanyName: (d.CompanyName || '').trim(),
              Close: d.LatestPrice || d.Average || d.PreviousAveragePrice || '0',
              PrevClose: d.PreviousAveragePrice || '0',
              Open: d.Average || d.LatestPrice || '0',
              High: d.Highest || '0',
              Low: d.Lowest || '0',
              Average: d.Average || '0',
              TradingShares: d.TransactionVolume || '0',
            }));
        }
      } catch (e) { console.log('emerging failed:', e.message); }

      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
      return res.status(200).json({ data, source: 'TPEx_ESB', ts: new Date().toISOString() });
    }

    // ══════════════════════════════════════════════════
    // 2c. 產業別對照表（上市+上櫃公司基本資料，代號→產業中文名）
    //     MI_INDEX 不帶產業別，故另抓公司基本資料補上（每日更新即可）
    // ══════════════════════════════════════════════════
    if (type === 'industry_map') {
      // MOPS 統一產業代碼 → 中文（上市/上櫃共用）
      const IND = {
        '01':'水泥','02':'食品','03':'塑膠','04':'紡織纖維','05':'電機機械','06':'電器電纜',
        '07':'化學','08':'玻璃陶瓷','09':'造紙','10':'鋼鐵','11':'橡膠','12':'汽車',
        '13':'電子','14':'建材營造','15':'航運','16':'觀光餐旅','17':'金融','18':'貿易百貨',
        '19':'綜合','20':'其他','21':'化學','22':'生技醫療','23':'油電燃氣','24':'半導體',
        '25':'電腦週邊','26':'光電','27':'通信網路','28':'電子零組件','29':'電子通路',
        '30':'資訊服務','31':'其他電子','32':'文化創意','33':'農業科技','34':'電子商務',
        '35':'綠能環保','36':'數位雲端','37':'運動休閒','38':'居家生活','80':'管理股票','91':'存託憑證'
      };
      const map = {};
      const settled = await Promise.allSettled([
        fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', { headers: { 'Accept': 'application/json' } }).then(r => r.json()),
        fetch('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O', { headers: { 'Accept': 'application/json' } }).then(r => r.json()),
      ]);
      if (settled[0].status === 'fulfilled' && Array.isArray(settled[0].value)) {
        for (const r of settled[0].value) {
          const code = (r['公司代號'] || '').trim();
          const name = IND[(r['產業別'] || '').trim()];
          if (code && name) map[code] = name;
        }
      }
      if (settled[1].status === 'fulfilled' && Array.isArray(settled[1].value)) {
        for (const r of settled[1].value) {
          const code = (r.SecuritiesCompanyCode || '').trim();
          const name = IND[(r.SecuritiesIndustryCode || '').trim()];
          if (code && name) map[code] = name;
        }
      }
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
      return res.status(200).json({ map, source: 'MOPS_t187ap03', ts: new Date().toISOString() });
    }

    // ══════════════════════════════════════════════════
    // 2d. 處置股（TWSE 處置有價證券 + TPEx 處置資訊），回傳 code→處置資訊 map
    // ══════════════════════════════════════════════════
    if (type === 'disposition') {
      const map = {};
      // 解析 ROC 日期區間字串末端日期 → 是否仍在處置期間
      const rocEndActive = (period) => {
        try {
          const dates = (period || '').match(/(\d{2,3})[\/\.](\d{1,2})[\/\.](\d{1,2})/g) || [];
          if (!dates.length) return true; // 無法解析則保守視為有效
          const last = dates[dates.length - 1].split(/[\/\.]/);
          const end = new Date(1911 + parseInt(last[0]), parseInt(last[1]) - 1, parseInt(last[2]));
          const today = new Date(); today.setHours(0, 0, 0, 0);
          return end >= today;
        } catch (e) { return true; }
      };
      const settled = await Promise.allSettled([
        fetch('https://www.twse.com.tw/rwd/zh/announcement/punish?response=json', { headers: { 'Accept': 'application/json', 'Referer': 'https://www.twse.com.tw/' } }).then(r => r.json()),
        fetch('https://www.tpex.org.tw/openapi/v1/tpex_disposal_information', { headers: { 'Accept': 'application/json' } }).then(r => r.json()),
      ]);
      // TWSE: [編號,公布日期,證券代號,證券名稱,累計,處置條件,處置起迄時間,處置措施,處置內容,備註]
      if (settled[0].status === 'fulfilled') {
        const rows = settled[0].value?.data || settled[0].value?.tables?.[0]?.data || [];
        for (const r of rows) {
          const code = (r[2] || '').trim();
          if (!/^\d{4}$/.test(code)) continue; // 只留普通股，排除權證
          const period = r[6] || '';
          if (!rocEndActive(period)) continue;
          map[code] = { name: (r[3] || '').trim(), period, reason: (r[5] || '').trim(), measure: (r[7] || '').trim(), market: 'twse' };
        }
      }
      // TPEx: {SecuritiesCompanyCode,CompanyName,DispositionPeriod,DispositionReasons,DisposalCondition}
      if (settled[1].status === 'fulfilled' && Array.isArray(settled[1].value)) {
        for (const r of settled[1].value) {
          const code = (r.SecuritiesCompanyCode || '').trim();
          if (!/^\d{4}$/.test(code)) continue;
          const period = r.DispositionPeriod || '';
          if (!rocEndActive(period)) continue;
          map[code] = { name: (r.CompanyName || '').trim(), period, reason: (r.DispositionReasons || r.DisposalCondition || '').trim(), measure: (r.DisposalCondition || '').trim(), market: 'tpex' };
        }
      }
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ map, count: Object.keys(map).length, source: 'TWSE+TPEx', ts: new Date().toISOString() });
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
      let results = [];
      let source = 'EMPTY';

      // ── 主要：Yahoo Finance v8 chart（雲端可用；www.twse 會封鎖 Vercel 機房 IP）──
      //    上市後綴 .TW、上櫃後綴 .TWO；未指定 market 則兩者都試
      async function yahooKline(symbol){
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1y&interval=1d`,
          { headers:{ 'Accept':'application/json', 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }
        );
        if(!r.ok) return [];
        const j = await r.json();
        const res0 = j.chart?.result?.[0];
        if(!res0) return [];
        const ts = res0.timestamp||[];
        const q  = res0.indicators?.quote?.[0]||{};
        const out = [];
        for(let i=0;i<ts.length;i++){
          const c = q.close?.[i];
          if(c==null) continue;
          const d = new Date(ts[i]*1000);
          const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
          out.push({
            date,
            open:   +(q.open?.[i]  ?? c),
            high:   +(q.high?.[i]  ?? c),
            low:    +(q.low?.[i]   ?? c),
            close:  +c,
            volume: Math.round((q.volume?.[i]||0)/1000), // 股→張
          });
        }
        return out;
      }

      const mkt = req.query.market;
      const suffixes = mkt==='tpex' ? ['TWO','TW'] : mkt==='twse' ? ['TW','TWO'] : ['TW','TWO'];
      for(const suf of suffixes){
        try { results = await yahooKline(`${stock_id}.${suf}`); } catch(e) { /* skip */ }
        if(results.length>0){ source = `YAHOO_${suf}`; break; }
      }

      // ── 備援：TWSE 官網 STOCK_DAY（本機可用，Vercel 多被封，留作最後手段）──
      if(results.length===0){
        const today = new Date();
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
        if(results.length>0) source = 'TWSE_KLINE';
      }

      res.setHeader('Cache-Control','s-maxage=1800, stale-while-revalidate');
      return res.status(200).json({ data:results, stock_id, source });
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
      const pi = (v) => parseInt((v||'0').replace(/,/g,'')) || 0;
      // MI_MARGN 欄位（融資融券彙總-股票）：
      //  0代號 1名稱 | 融資: 2買進 3賣出 4現金償還 5前日餘額 6今日餘額 7次一營業日限額
      //             | 融券: 8買進 9賣出 10現券償還 11前日餘額 12今日餘額 13次一營業日限額
      //             | 14資券互抵 15註記
      // 注意：此端點不含「使用率%」欄位，使用率需自行計算＝今日餘額/限額×100
      // 資料在 j.tables 內某張表（非 j.data），且當日盤後可能尚未公布 → 往前找最近交易日
      const fmtDate = (dt) => `${dt.getFullYear()}${String(dt.getMonth()+1).padStart(2,'0')}${String(dt.getDate()).padStart(2,'0')}`;
      const findItem = (j) => {
        const tables = j.tables || [];
        let table = tables.find(t => (t.data||[]).length > 50);
        const rows = table?.data || j.data || [];
        return { item: rows.find(row => (row[0]||'').trim() === stock_id), fields: table?.fields || j.fields || [] };
      };
      try {
        let item = null, fields = [], usedDate = '';
        const base = new Date();
        for (let back = 0; back <= 5 && !item; back++) {
          const dt = new Date(base); dt.setDate(base.getDate() - back);
          const yyyymmdd = fmtDate(dt);
          const r = await fetch(
            `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${yyyymmdd}&selectType=STOCK&response=json`,
            { headers:{'Accept':'application/json','Referer':'https://www.twse.com.tw/zh/'} }
          );
          if (!r.ok) continue;
          const j = await r.json();
          const found = findItem(j);
          if (found.item) { item = found.item; fields = found.fields; usedDate = j.date || yyyymmdd; }
        }
        const marginBalance = item ? pi(item[6])  : 0;   // 融資今日餘額
        const marginLimit   = item ? pi(item[7])  : 0;   // 融資次一營業日限額
        const shortBalance  = item ? pi(item[12]) : 0;   // 融券今日餘額
        const shortLimit    = item ? pi(item[13]) : 0;   // 融券次一營業日限額
        res.setHeader('Cache-Control','s-maxage=1800, stale-while-revalidate');
        return res.status(200).json({
          stock_id, fields,
          data: item ? {
            marginBuy:     pi(item[2]),    // 融資買進（張）
            marginSell:    pi(item[3]),    // 融資賣出（張）
            marginRedeem:  pi(item[4]),    // 現金償還（張）
            marginPrev:    pi(item[5]),    // 融資前日餘額（張）
            marginBalance,                 // 融資今日餘額（張）
            marginLimit,                   // 融資限額（張）
            marginUsage:   marginLimit > 0 ? parseFloat((marginBalance / marginLimit * 100).toFixed(2)) : 0,
            shortBuy:      pi(item[8]),    // 融券買進（張）
            shortSell:     pi(item[9]),    // 融券賣出（張）
            shortReturn:   pi(item[10]),   // 現券償還（張）
            shortPrev:     pi(item[11]),   // 融券前日餘額（張）
            shortBalance,                  // 融券今日餘額（張）
            shortLimit,                    // 融券限額（張）
            shortUsage:    shortLimit > 0 ? parseFloat((shortBalance / shortLimit * 100).toFixed(2)) : 0,
            offset:        pi(item[14]),   // 資券互抵（張）
          } : null,
          source: 'TWSE_MI_MARGN',
          date: usedDate
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
        const yahooSuffix = mkt === 'tpex' ? 'TWO' : 'TW';
        // 並行抓 MIS 即時 + Yahoo 1 分鐘走勢
        const misUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${prefix}_${stock_id}.tw&json=1&delay=0&_=${Date.now()}`;
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${stock_id}.${yahooSuffix}?range=1d&interval=1m`;
        const [misR, yahooR] = await Promise.allSettled([
          fetch(misUrl, { headers: {'Accept':'application/json','User-Agent':'Mozilla/5.0','Referer':'https://mis.twse.com.tw/stock/index.jsp'} }),
          fetch(yahooUrl, { headers: {'Accept':'application/json','User-Agent':'Mozilla/5.0'} })
        ]);
        const item = misR.status==='fulfilled' && misR.value.ok ? ((await misR.value.json()).msgArray||[])[0] : null;
        // 解析 Yahoo 1 分鐘 ticks
        let ticks = [];
        if (yahooR.status==='fulfilled' && yahooR.value.ok) {
          try {
            const yj = await yahooR.value.json();
            const result = yj?.chart?.result?.[0];
            if (result) {
              const ts = result.timestamp || [];
              const closes = result.indicators?.quote?.[0]?.close || [];
              const vols = result.indicators?.quote?.[0]?.volume || [];
              ticks = ts.map((t,i) => ({
                t,                          // unix timestamp (sec)
                price: closes[i] ?? null,
                volume: vols[i] ?? 0
              })).filter(d => d.price != null);
            }
          } catch(e) {}
        }
        res.setHeader('Cache-Control','no-cache,no-store');
        return res.status(200).json({
          stock_id,
          data: item || ticks.length ? {
            price:  parseFloat(item?.z)||parseFloat(item?.y)||(ticks.length?ticks[ticks.length-1].price:0)||0,
            open:   parseFloat(item?.o)||(ticks[0]?.price)||0,
            high:   parseFloat(item?.h)||Math.max(...ticks.map(d=>d.price), 0)||0,
            low:    parseFloat(item?.l)||(ticks.length?Math.min(...ticks.map(d=>d.price)):0)||0,
            prev:   parseFloat(item?.y)||0,
            volume: parseFloat(item?.v)||0,
            time:   item?.t||'',
            ticks   // [{t:unix_sec, price, volume}]
          } : null,
          source: 'TWSE_MIS+Yahoo1m'
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

      // ── 主要：FinMind（免 token，雲端可用）──
      //    TWSE 已自 openapi 移除 T86，且 www.twse 會封鎖 Vercel 機房 IP
      try {
        const end = new Date();
        const start = new Date(end.getTime() - 10*86400000); // 近10天涵蓋最後交易日
        const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const fmUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=${stock_id}&start_date=${fmt(start)}&end_date=${fmt(end)}`;
        const fr = await fetch(fmUrl, { headers:{ 'Accept':'application/json' } });
        const fj = await fr.json();
        const rows = fj.data || [];
        if (rows.length > 0) {
          // 取最後交易日，依投資人類別彙總 buy/sell（單位：股）
          const lastDate = rows.reduce((mx,x)=> x.date>mx ? x.date : mx, rows[0].date);
          const day = rows.filter(x => x.date === lastDate);
          const agg = {};
          for (const x of day) {
            if (!agg[x.name]) agg[x.name] = { buy:0, sell:0 };
            agg[x.name].buy  += x.buy  || 0;
            agg[x.name].sell += x.sell || 0;
          }
          const g = k => agg[k] || { buy:0, sell:0 };
          const lots = n => Math.round((n||0) / 1000); // 股→張
          const fi = g('Foreign_Investor'), fds = g('Foreign_Dealer_Self'); // 外資 + 外資自營
          const it = g('Investment_Trust');                                  // 投信
          const ds = g('Dealer_self'),     dh  = g('Dealer_Hedging');        // 自營(自行+避險)
          const foreignBuy  = lots(fi.buy + fds.buy);
          const foreignSell = lots(fi.sell + fds.sell);
          const foreignNet  = lots((fi.buy + fds.buy) - (fi.sell + fds.sell));
          const trustBuy    = lots(it.buy);
          const trustSell   = lots(it.sell);
          const trustNet    = lots(it.buy - it.sell);
          const dealerNet   = lots((ds.buy + dh.buy) - (ds.sell + dh.sell));
          const totalNet    = lots(
            (fi.buy + fds.buy + it.buy + ds.buy + dh.buy)
          - (fi.sell + fds.sell + it.sell + ds.sell + dh.sell)
          );
          res.setHeader('Cache-Control','s-maxage=1800, stale-while-revalidate');
          return res.status(200).json({
            stock_id,
            data: { foreignBuy, foreignSell, foreignNet, trustBuy, trustSell, trustNet, dealerNet, totalNet },
            source: 'FINMIND',
            date: lastDate.replace(/-/g,'')
          });
        }
      } catch(e) { /* fall through to TWSE */ }

      // ── 備援：TWSE 官網 T86（Vercel 多被封；本機/偶爾可用）──
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

    // ══════════════════════════════════════════════════
    // 11. 櫃買指數 歷史 K 線（TPEx 官方）
    //     POST https://www.tpex.org.tw/www/zh-tw/indexInfo/inx
    //     date=YYYYMMDD (該月任一天 → 回傳整月), response=json
    //     欄位順序: [日期, 開市, 最高, 最低, 收市, 漲/跌]
    // ══════════════════════════════════════════════════
    if (type === 'tpex_index') {
      const months = Math.max(1, Math.min(parseInt(req.query.months) || 4, 12));
      try {
        const today = new Date();
        const pad2 = n => String(n).padStart(2,'0');
        const dates = [];
        for (let i = 0; i < months; i++) {
          const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
          dates.push(`${d.getFullYear()}${pad2(d.getMonth()+1)}01`);
        }

        const results = await Promise.all(dates.map(async d => {
          try {
            const r = await fetch('https://www.tpex.org.tw/www/zh-tw/indexInfo/inx', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'Referer': 'https://www.tpex.org.tw/zh-tw/indices/stock-index/industrial/inxh.html'
              },
              body: `date=${d}&response=json`
            });
            if (!r.ok) return [];
            const j = await r.json();
            const tbl = j.tables?.[0];
            if (!tbl?.data) return [];
            return tbl.data.map(row => ({
              date:   row[0],
              open:   parseFloat((row[1]||'0').replace(/,/g,'')) || 0,
              high:   parseFloat((row[2]||'0').replace(/,/g,'')) || 0,
              low:    parseFloat((row[3]||'0').replace(/,/g,'')) || 0,
              close:  parseFloat((row[4]||'0').replace(/,/g,'')) || 0,
              change: parseFloat((row[5]||'0').replace(/,/g,'')) || 0,
            })).filter(d => d.close > 0);
          } catch { return []; }
        }));

        // 合併 + 去重（依日期）+ 由舊到新排序
        const seen = new Set();
        const merged = [];
        for (const arr of results) {
          for (const it of arr) {
            if (!seen.has(it.date)) { seen.add(it.date); merged.push(it); }
          }
        }
        merged.sort((a,b) => a.date.localeCompare(b.date));

        res.setHeader('Cache-Control','s-maxage=1800, stale-while-revalidate');
        return res.status(200).json({ data: merged, source: 'TPEx_indexInfo', months });
      } catch (e) {
        return res.status(200).json({ data: [], error: e.message });
      }
    }

    // ══════════════════════════════════════════════════
    // 12. 櫃買指數 即時報價（TWSE MIS otc_o00.tw）
    //     回傳當日 OHLC + 現價 + 昨收 + 累計成交量
    // ══════════════════════════════════════════════════
    if (type === 'otc_index_live') {
      try {
        const r = await fetch(
          'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=otc_o00.tw&json=1&delay=0',
          { headers: {
              'Accept': 'application/json',
              'User-Agent': 'Mozilla/5.0',
              'Referer': 'https://mis.twse.com.tw/stock/index.jsp'
          } }
        );
        const j = await r.json();
        const it = j.msgArray?.[0];
        if (!it) return res.status(200).json({ data: null, error: 'no data' });

        const num = v => {
          const n = parseFloat(String(v||'').replace(/,/g,''));
          return Number.isFinite(n) ? n : null;
        };
        const data = {
          name:   it.n || '櫃買指數',
          open:   num(it.o),
          high:   num(it.h),
          low:    num(it.l),
          price:  num(it.z),     // 現價（盤後 = 收盤）
          prev:   num(it.y),     // 昨收
          volume: num(it.v),     // 累計成交量
          time:   it.t || it['%'] || '',
          date:   it.d || '',
          tlong:  parseInt(it.tlong) || null
        };
        if (data.price != null && data.prev != null) {
          data.change  = +(data.price - data.prev).toFixed(2);
          data.changeP = +((data.change / data.prev) * 100).toFixed(2);
        }

        res.setHeader('Cache-Control','s-maxage=3, stale-while-revalidate');
        return res.status(200).json({ data, source: 'TWSE_MIS_OTC' });
      } catch (e) {
        return res.status(200).json({ data: null, error: e.message });
      }
    }

    // ══════════════════════════════════════════════════
    // 13. 櫃買指數 即時走勢（TPEx 官網 mktRT，1 分鐘間隔）
    //     回傳 [{c:指數, s:成交金額(億), t:HHMMSS}]
    // ══════════════════════════════════════════════════
    if (type === 'tpex_index_intraday') {
      try {
        const r = await fetch('https://info.tpex.org.tw/api/mktRT', {
          headers: {
            'Accept': 'application/json',
            'Referer': 'https://www.tpex.org.tw/',
            'User-Agent': 'Mozilla/5.0'
          }
        });
        const j = await r.json();
        // ohlcArray: 逐分鐘行情；t='000000' 是 placeholder，t='999999' 是收盤總和
        const arr = (j.ohlcArray||[])
          .map(x => ({
            t: x.t,
            time: x.t ? `${x.t.slice(0,2)}:${x.t.slice(2,4)}` : '',
            price: parseFloat(x.c) || 0,
            value: parseFloat(x.s) || 0
          }))
          .filter(x => x.price > 0 && x.t !== '000000' && x.t !== '999999');
        // infoArray: 官方總計（v=當日成交金額億元、o/h/l/y=開高低昨收），與 TPEx 官網顯示一致
        const info = j.infoArray || {};
        const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
        const summary = {
          open:  num(info.o),
          high:  num(info.h),
          low:   num(info.l),
          prev:  num(info.y),
          totalValue: num(info.v),   // 成交金額（億元）
          datetime: j.taiex?.datetime || '',
          index:    num(j.taiex?.index),
          diff:     num(j.taiex?.diff),
          percent:  num(j.taiex?.percent),
        };
        res.setHeader('Cache-Control','s-maxage=10, stale-while-revalidate');
        return res.status(200).json({ data: arr, summary, source: 'TPEx_mktRT' });
      } catch (e) {
        return res.status(200).json({ data: [], summary: null, error: e.message });
      }
    }

    // ══════════════════════════════════════════════════
    // 14. 櫃買指數 歷史走勢（TPEx 官網 historical.json）
    //     回傳 {W:[...], M:[...], Q:[...], Y:[...]}
    //     每筆: {date:YYYYMMDD, index:收盤指數, val:成交金額(億)}
    // ══════════════════════════════════════════════════
    if (type === 'tpex_index_historical') {
      try {
        const r = await fetch('https://www.tpex.org.tw/data/home/historical.json', {
          headers: {
            'Accept': 'application/json',
            'Referer': 'https://www.tpex.org.tw/',
            'User-Agent': 'Mozilla/5.0'
          }
        });
        const j = await r.json();
        const ti = j.tpex_index || {};
        const norm = (arr) => (arr?.data||[]).map(d => ({
          date:  d.date,
          dateF: d.date && d.date.length === 8 ? `${d.date.slice(0,4)}/${d.date.slice(4,6)}/${d.date.slice(6,8)}` : d.date,
          price: parseFloat(d.index) || 0,
          value: parseFloat(d.val) || 0
        })).filter(x => x.price > 0);
        const out = {
          W: norm(ti.W),
          M: norm(ti.M),
          Q: norm(ti.Q),
          Y: norm(ti.Y),
        };
        res.setHeader('Cache-Control','s-maxage=1800, stale-while-revalidate');
        return res.status(200).json({ data: out, source: 'TPEx_historical' });
      } catch (e) {
        return res.status(200).json({ data: {W:[],M:[],Q:[],Y:[]}, error: e.message });
      }
    }

    return res.status(400).json({ error: '不支援的 type 參數' });

  } catch (err) {
    return res.status(500).json({ error: '資料取得失敗：' + err.message });
  }
}
