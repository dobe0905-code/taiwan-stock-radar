// api/fundamental.js
// 後端 API：提供三大法人、融資融券、財報、月營收等資料
// Token 完全藏在伺服器端，外部看不到

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TOKEN = process.env.FINMIND_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'Token 未設定' });

  const { type, stock_id, start_date } = req.query;
  if (!type || !stock_id) return res.status(400).json({ error: '缺少參數' });

  const BASE = 'https://api.finmindtrade.com/api/v4/data';

  // 對應不同資料集
  const datasetMap = {
    'institution':  'TaiwanStockInstitutionalInvestorsBuySell', // 三大法人
    'margin':       'TaiwanStockMarginPurchaseShortSale',        // 融資融券
    'revenue':      'TaiwanStockMonthRevenue',                   // 月營收
    'income':       'TaiwanFinancialStatements',                  // 財報損益
    'balance':      'TaiwanBalanceSheet',                         // 資產負債表
    'dividend':     'TaiwanStockDividend',                        // 股利資料
    'eps':          'TaiwanStockEps',                             // EPS
  };

  const dataset = datasetMap[type];
  if (!dataset) return res.status(400).json({ error: '不支援的資料類型: ' + type });

  const sd = start_date || (() => {
    const d = new Date(); d.setFullYear(d.getFullYear() - 2);
    return d.toISOString().split('T')[0];
  })();

  try {
    const params = new URLSearchParams({ dataset, data_id: stock_id, start_date: sd, token: TOKEN });
    const r = await fetch(`${BASE}?${params}`);
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: '資料取得失敗：' + err.message });
  }
}
