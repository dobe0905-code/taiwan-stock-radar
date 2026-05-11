export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const TOKEN = process.env.FINMIND_TOKEN;
  if (!TOKEN) {
    return res.status(500).json({ error: 'Token 未設定，請在 Vercel 環境變數加入 FINMIND_TOKEN' });
  }

  const { dataset, data_id, start_date } = req.query;
  if (!dataset) {
    return res.status(400).json({ error: '缺少 dataset 參數' });
  }

  const FINMIND_BASE = 'https://api.finmindtrade.com/api/v4/data';
  const params = new URLSearchParams({ dataset, token: TOKEN });
  if (data_id) params.append('data_id', data_id);
  if (start_date) params.append('start_date', start_date);

  try {
    const response = await fetch(`${FINMIND_BASE}?${params}`);
    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: '資料取得失敗：' + err.message });
  }
}
