// api/global.js
// 美股個股 + 全球指數 — Yahoo Finance v8 (免費, 無需 token)
import { requireAuth } from './_auth.js';
import { rateLimit } from './_ratelimit.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!(await requireAuth(req, res))) return;
  if (!(await rateLimit(req, res))) return;

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
      const interval = req.query.interval || '1d';            // 1d=日K；1m/5m/15m=盤中分時
      const isIntraday = interval !== '1d';
      // 盤中：range 預設 1d（當日）；日K：預設 4mo
      const range = req.query.range || (isIntraday ? '1d' : '4mo');
      // Yahoo v7 quote 端點現在需要 crumb 認證會回 401，必須讓它失敗也不影響 chart
      const [quoteSettled, chartSettled] = await Promise.allSettled([
        yqQuote([symbol]),
        fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`,
          { headers: YF_HEADERS }
        ).then(r => r.json()),
      ]);
      const q = (quoteSettled.status==='fulfilled' && quoteSettled.value[0]) || {};
      const chart = chartSettled.status==='fulfilled' ? chartSettled.value?.chart?.result?.[0] : null;
      // chart.meta 有完整即時報價，當 v7 quote 401 時用它做 fallback
      const meta = chart?.meta || {};
      const gmtoff = Number.isFinite(meta.gmtoffset) ? meta.gmtoffset : 28800; // 交易所本地時區（秒）
      const kdata = chart ? (() => {
        const ts = chart.timestamp || [];
        const ohlcv = chart.indicators?.quote?.[0] || {};
        return ts.map((t, i) => {
          // 盤中：以交易所本地時間輸出 HH:MM；日K：輸出 YYYY-MM-DD
          const local = new Date((t + gmtoff) * 1000);
          const time = `${String(local.getUTCHours()).padStart(2,'0')}:${String(local.getUTCMinutes()).padStart(2,'0')}`;
          return {
            date:   new Date(t * 1000).toISOString().slice(0, 10),
            time,
            open:   parseFloat((ohlcv.open?.[i] || 0).toFixed(2)),
            high:   parseFloat((ohlcv.high?.[i] || 0).toFixed(2)),
            low:    parseFloat((ohlcv.low?.[i] || 0).toFixed(2)),
            close:  parseFloat((ohlcv.close?.[i] || 0).toFixed(2)),
            volume: ohlcv.volume?.[i] || 0,
          };
        }).filter(d => d.close > 0);
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
        intraday: isIntraday,
        prevClose: parseFloat((meta.chartPreviousClose ?? prevClose ?? 0).toFixed(2)),  // 昨收，盤中折線基準
        source: 'YAHOO_FINANCE',
        quoteSource: quoteSettled.status==='fulfilled' ? 'v7' : 'chart.meta(v7 401)',
        ts: new Date().toISOString()
      });
    }

    // ══════════════════════════════════════════════════
    // 5. 隔夜美股風向（費半/NASDAQ/S&P/VIX）— 用 v8 chart meta（免認證、穩定）
    // ══════════════════════════════════════════════════
    if (type === 'overnight') {
      const WATCH = [
        { sym: '^SOX',  name: '費城半導體' },
        { sym: '^IXIC', name: 'NASDAQ' },
        { sym: '^GSPC', name: 'S&P 500' },
        { sym: '^VIX',  name: 'VIX 恐慌指數' },
      ];
      const settled = await Promise.allSettled(WATCH.map(w =>
        fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(w.sym)}?range=5d&interval=1d`, { headers: YF_HEADERS })
          .then(r => r.json())
      ));
      const data = WATCH.map((w, i) => {
        const st = settled[i];
        const chart = st.status === 'fulfilled' ? st.value?.chart?.result?.[0] : null;
        const meta = chart?.meta || {};
        const closeArr = (chart?.indicators?.quote?.[0]?.close || []).filter(v => v > 0);
        const lastClose = closeArr.length ? closeArr[closeArr.length - 1] : (meta.regularMarketPrice || 0);
        const price = meta.regularMarketPrice || lastClose;
        // 優先用收盤陣列前一根（真正的「昨收」）；meta.previousClose 對 ^SOX 等指數常為 undefined，
        // 而 chartPreviousClose 在 range=5d 時是 5 天前的錨點，會造成漲跌幅嚴重失真，故放在最後 fallback。
        const prev = (closeArr.length > 1 ? closeArr[closeArr.length - 2] : 0) || meta.previousClose || meta.chartPreviousClose || 0;
        const changeP = prev > 0 ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : 0;
        return {
          symbol: w.sym, name: w.name,
          price: parseFloat((price || 0).toFixed(2)),
          prev: parseFloat((prev || 0).toFixed(2)),
          changeP,
          state: meta.marketState || '',
          ok: !!price,
        };
      });
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.status(200).json({ data, source: 'YAHOO_FINANCE', ts: new Date().toISOString() });
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

    // ══════════════════════════════════════════════════
    // 每日焦點新聞（Google News RSS 代理）
    //   僅取「標題＋來源媒體＋時間＋原文連結」，點擊連回原始新聞，
    //   不轉載全文（RSS 本身也不提供全文），屬新聞聚合的正當用法。
    // ══════════════════════════════════════════════════
    if (type === 'news') {
      const TOPICS = [
        { key: 'market', label: '台股大盤', q: '台股 OR 加權指數 OR 台股盤勢' },
        { key: 'chip',   label: '半導體 / AI', q: '台積電 OR 半導體 OR AI晶片 OR CoWoS OR 輝達' },
        { key: 'hot',    label: '熱門個股', q: '鴻海 OR 聯發科 OR 法人買超 OR 強勢股' },
        { key: 'global', label: '國際 / 美股', q: '美股 OR 聯準會 OR 那斯達克 OR 費城半導體' },
      ];
      const decode = (s) => (s || '')
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
      const parseRss = (xml, limit) => {
        const out = [];
        const blocks = xml.split('<item>').slice(1);
        for (const b of blocks.slice(0, limit)) {
          const grab = (re) => { const m = b.match(re); return m ? decode(m[1]) : ''; };
          let title = grab(/<title>([\s\S]*?)<\/title>/);
          const source = grab(/<source[^>]*>([\s\S]*?)<\/source>/);
          const link = grab(/<link>([\s\S]*?)<\/link>/);
          const pubDate = grab(/<pubDate>([\s\S]*?)<\/pubDate>/);
          // Google News 標題格式常為「標題 - 來源媒體」，去掉尾段來源避免重複
          if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
          if (title) out.push({ title, source, link, pubDate });
        }
        return out;
      };
      const fetchTopic = async (t) => {
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(t.q + ' when:2d')}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
        try {
          const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (!r.ok) return { key: t.key, label: t.label, items: [] };
          const xml = await r.text();
          return { key: t.key, label: t.label, items: parseRss(xml, 6) };
        } catch (e) { return { key: t.key, label: t.label, items: [] }; }
      };
      const groups = await Promise.all(TOPICS.map(fetchTopic));
      res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
      return res.status(200).json({ groups, updated: new Date().toISOString(), source: 'GoogleNews_RSS' });
    }

    return res.status(400).json({ error: '不支援的 type 參數' });

  } catch (err) {
    return res.status(500).json({ error: '資料取得失敗：' + err.message });
  }
}
