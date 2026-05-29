// api/global.js
// 美股個股 + 全球指數 — Yahoo Finance v8 (免費, 無需 token)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, symbols, symbol } = req.query;

  const YF_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // ── 共用：Yahoo Finance v8 quote 批次查詢 ──
  async function yqBatch(syms) {
    const joined = syms.join(',');
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(joined)}&range=1d&interval=1d`;
    const r = await fetch(url, { headers: YF_HEADERS });
    if (!r.ok) throw new Error(`YF spark ${r.status}`);
    return r.json();
  }

  async function yqQuote(syms) {
    const joined = syms.join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(joined)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,regularMarketVolume,regularMarketPreviousClose,marketCap,trailingPE,fiftyTwoWeekHigh,fiftyTwoWeekLow,shortName,longName,currency,marketState`;
    const r = await fetch(url, { headers: YF_HEADERS });
    if (!r.ok) throw new Error(`YF quote ${r.status}`);
    const j = await r.json();
    return j?.quoteResponse?.result || [];
  }

  try {

    // ══════════════════════════════════════════════════
    // 1. 美股熱門清單
    // ══════════════════════════════════════════════════
    if (type === 'us_list') {
      const US_STOCKS = [
        // 科技 Big Tech
        'AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','NFLX','INTC','AMD',
        // 半導體
        'AVGO','QCOM','AMAT','LRCX','KLAC','MU','TXN','ON','MCHP',
        // AI/雲端
        'PLTR','SNOW','CRM','NOW','ADBE','ORCL','IBM','DELL','HPE',
        // 金融
        'JPM','BAC','WFC','GS','MS','V','MA','AXP','BRK-B',
        // 消費/零售
        'WMT','COST','TGT','HD','NKE','SBUX','MCD','DIS',
        // 醫療
        'JNJ','PFE','ABBV','MRK','LLY','UNH','CVS',
        // 能源
        'XOM','CVX','COP','SLB',
        // ETF 指數
        'SPY','QQQ','DIA','IWM','VTI','GLD','TLT',
      ];
      const results = await yqQuote(US_STOCKS);
      const data = results.map(q => ({
        symbol:    q.symbol,
        name:      q.shortName || q.longName || q.symbol,
        price:     q.regularMarketPrice || 0,
        change:    parseFloat((q.regularMarketChange || 0).toFixed(2)),
        changeP:   parseFloat((q.regularMarketChangePercent || 0).toFixed(2)),
        open:      q.regularMarketOpen || 0,
        high:      q.regularMarketDayHigh || 0,
        low:       q.regularMarketDayLow || 0,
        prev:      q.regularMarketPreviousClose || 0,
        volume:    q.regularMarketVolume || 0,
        mktCap:    q.marketCap || 0,
        pe:        q.trailingPE || null,
        wk52High:  q.fiftyTwoWeekHigh || 0,
        wk52Low:   q.fiftyTwoWeekLow || 0,
        currency:  q.currency || 'USD',
        state:     q.marketState || 'CLOSED', // PRE/REGULAR/POST/CLOSED
      }));
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
      return res.status(200).json({ data, source: 'YAHOO_FINANCE', ts: new Date().toISOString() });
    }

    // ══════════════════════════════════════════════════
    // 2. 全球指數
    // ══════════════════════════════════════════════════
    if (type === 'global_index') {
      const INDICES = [
        // 美國
        { sym: '^GSPC',  name: 'S&P 500',         region: '🇺🇸 美國' },
        { sym: '^IXIC',  name: 'NASDAQ',           region: '🇺🇸 美國' },
        { sym: '^DJI',   name: '道瓊工業',          region: '🇺🇸 美國' },
        { sym: '^RUT',   name: '羅素 2000',         region: '🇺🇸 美國' },
        { sym: '^VIX',   name: 'VIX 恐慌指數',      region: '🇺🇸 美國' },
        // 台灣
        { sym: '^TWII',  name: '台灣加權',           region: '🇹🇼 台灣' },
        { sym: '^TWOII', name: '台灣櫃買',           region: '🇹🇼 台灣' },
        // 亞洲
        { sym: '^N225',  name: '日經 225',           region: '🇯🇵 日本' },
        { sym: '^HSI',   name: '恒生指數',            region: '🇭🇰 香港' },
        { sym: '000001.SS', name: '上海綜合',        region: '🇨🇳 中國' },
        { sym: '399001.SZ', name: '深圳成分',        region: '🇨🇳 中國' },
        { sym: '^KS11',  name: '韓國 KOSPI',         region: '🇰🇷 韓國' },
        { sym: '^STI',   name: '新加坡 STI',         region: '🇸🇬 新加坡' },
        { sym: '^AXJO',  name: 'ASX 200',           region: '🇦🇺 澳洲' },
        // 歐洲
        { sym: '^FTSE',  name: '英國富時 100',       region: '🇬🇧 英國' },
        { sym: '^GDAXI', name: '德國 DAX',           region: '🇩🇪 德國' },
        { sym: '^FCHI',  name: '法國 CAC 40',        region: '🇫🇷 法國' },
        { sym: '^STOXX50E', name: '歐洲 STOXX 50',  region: '🇪🇺 歐洲' },
        // 商品
        { sym: 'GC=F',   name: '黃金現貨',           region: '🪙 商品' },
        { sym: 'SI=F',   name: '白銀現貨',           region: '🪙 商品' },
        { sym: 'CL=F',   name: 'WTI 原油',          region: '🛢️ 商品' },
        { sym: 'BTC-USD', name: 'Bitcoin',          region: '₿ 加密' },
        { sym: 'ETH-USD', name: 'Ethereum',         region: '₿ 加密' },
        // 外匯
        { sym: 'USDTWD=X', name: 'USD/TWD',        region: '💱 外匯' },
        { sym: 'EURUSD=X', name: 'EUR/USD',        region: '💱 外匯' },
        { sym: 'USDJPY=X', name: 'USD/JPY',        region: '💱 外匯' },
        { sym: 'DX-Y.NYB', name: '美元指數',         region: '💱 外匯' },
        // 債券
        { sym: '^TNX',   name: '美10年債殖利率',     region: '📊 債券' },
        { sym: '^TYX',   name: '美30年債殖利率',     region: '📊 債券' },
      ];
      const syms = INDICES.map(i => i.sym);
      const results = await yqQuote(syms);
      const nameMap = Object.fromEntries(INDICES.map(i => [i.sym, i]));
      const data = results.map(q => {
        const info = nameMap[q.symbol] || {};
        return {
          symbol:  q.symbol,
          name:    info.name || q.shortName || q.symbol,
          region:  info.region || '',
          price:   q.regularMarketPrice || 0,
          change:  parseFloat((q.regularMarketChange || 0).toFixed(2)),
          changeP: parseFloat((q.regularMarketChangePercent || 0).toFixed(2)),
          prev:    q.regularMarketPreviousClose || 0,
          open:    q.regularMarketOpen || 0,
          high:    q.regularMarketDayHigh || 0,
          low:     q.regularMarketDayLow || 0,
          currency: q.currency || '',
          state:   q.marketState || 'CLOSED',
        };
      });
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
      return res.status(200).json({ data, indices: INDICES, source: 'YAHOO_FINANCE', ts: new Date().toISOString() });
    }

    // ══════════════════════════════════════════════════
    // 3. 單一股票詳細資料 (美股個股面板)
    // ══════════════════════════════════════════════════
    if (type === 'us_detail') {
      if (!symbol) return res.status(400).json({ error: '缺少 symbol' });
      // Yahoo v7 quote 端點現在需要 crumb 認證會回 401，必須讓它失敗也不影響 chart
      const [quoteSettled, chartSettled] = await Promise.allSettled([
        yqQuote([symbol]),
        fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=4mo&interval=1d`,
          { headers: YF_HEADERS }
        ).then(r => r.json()),
      ]);
      const q = (quoteSettled.status==='fulfilled' && quoteSettled.value[0]) || {};
      const chart = chartSettled.status==='fulfilled' ? chartSettled.value?.chart?.result?.[0] : null;
      // chart.meta 有完整即時報價，當 v7 quote 401 時用它做 fallback
      const meta = chart?.meta || {};
      const kdata = chart ? (() => {
        const ts = chart.timestamp || [];
        const ohlcv = chart.indicators?.quote?.[0] || {};
        return ts.map((t, i) => ({
          date:   new Date(t * 1000).toISOString().slice(0, 10),
          open:   parseFloat((ohlcv.open?.[i] || 0).toFixed(2)),
          high:   parseFloat((ohlcv.high?.[i] || 0).toFixed(2)),
          low:    parseFloat((ohlcv.low?.[i] || 0).toFixed(2)),
          close:  parseFloat((ohlcv.close?.[i] || 0).toFixed(2)),
          volume: ohlcv.volume?.[i] || 0,
        })).filter(d => d.close > 0);
      })() : [];
      const lastClose = kdata.length ? kdata[kdata.length-1].close : 0;
      const prevClose = kdata.length>1 ? kdata[kdata.length-2].close : (meta.chartPreviousClose||lastClose);
      const computedChange = lastClose - prevClose;
      const computedChangeP = prevClose>0 ? (computedChange/prevClose*100) : 0;

      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
      return res.status(200).json({
        symbol,
        quote: {
          name:      q.shortName || q.longName || meta.longName || meta.shortName || symbol,
          price:     q.regularMarketPrice || meta.regularMarketPrice || lastClose,
          change:    parseFloat(((q.regularMarketChange ?? computedChange) || 0).toFixed(2)),
          changeP:   parseFloat(((q.regularMarketChangePercent ?? computedChangeP) || 0).toFixed(2)),
          open:      q.regularMarketOpen || meta.regularMarketDayHigh || 0,
          high:      q.regularMarketDayHigh || meta.regularMarketDayHigh || 0,
          low:       q.regularMarketDayLow || meta.regularMarketDayLow || 0,
          prev:      q.regularMarketPreviousClose || meta.chartPreviousClose || prevClose,
          volume:    q.regularMarketVolume || meta.regularMarketVolume || 0,
          mktCap:    q.marketCap || 0,
          pe:        q.trailingPE || null,
          eps:       q.epsTrailingTwelveMonths || null,
          wk52High:  q.fiftyTwoWeekHigh || meta.fiftyTwoWeekHigh || 0,
          wk52Low:   q.fiftyTwoWeekLow || meta.fiftyTwoWeekLow || 0,
          currency:  q.currency || meta.currency || 'USD',
          exchange:  q.fullExchangeName || meta.fullExchangeName || '',
          sector:    q.sector || '',
          industry:  q.industry || '',
          state:     q.marketState || 'CLOSED',
        },
        kdata,
        source: 'YAHOO_FINANCE',
        quoteSource: quoteSettled.status==='fulfilled' ? 'v7' : 'chart.meta(v7 401)',
        ts: new Date().toISOString()
      });
    }

    // ══════════════════════════════════════════════════
    // 4. 美股搜尋
    // ══════════════════════════════════════════════════
    if (type === 'us_search') {
      if (!symbol) return res.status(400).json({ error: '缺少 symbol' });
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&lang=en-US&region=US&quotesCount=8&newsCount=0`;
      const r = await fetch(url, { headers: YF_HEADERS });
      const j = await r.json();
      const quotes = (j?.quotes || []).filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF' || q.quoteType === 'INDEX');
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.status(200).json({ data: quotes, source: 'YAHOO_SEARCH' });
    }

    return res.status(400).json({ error: '不支援的 type 參數' });

  } catch (err) {
    return res.status(500).json({ error: '資料取得失敗：' + err.message });
  }
}
