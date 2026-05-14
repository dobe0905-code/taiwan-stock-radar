// api/realtime.js
// 從 Firebase Realtime Database 讀取凱基即時報價
// Token 藏在 Vercel 環境變數，外部看不到

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const FIREBASE_URL = process.env.FIREBASE_URL;
  const FIREBASE_SECRET = process.env.FIREBASE_SECRET;

  if (!FIREBASE_URL) {
    return res.status(500).json({ error: 'FIREBASE_URL not set' });
  }

  const { stock_id } = req.query;

  try {
    // 讀取單一股票或全部
    const path = stock_id ? `stocks/${stock_id}` : 'stocks';
    const url = `${FIREBASE_URL}/${path}.json${FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : ''}`;

    const r = await fetch(url);
    const data = await r.json();

    res.setHeader('Cache-Control', 'no-cache, no-store');
    return res.status(200).json({ data, ts: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
