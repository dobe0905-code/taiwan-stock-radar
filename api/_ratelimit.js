// api/_ratelimit.js
// Phase 2.5：Upstash Redis 速率限制（每使用者固定視窗）
// 檔名以底線開頭，Vercel 不會把它當路由端點，僅作共用模組。
//
// 設計重點：
// 1) Fail-open：若未設定 Upstash 環境變數、或 Upstash 異常，一律「放行」，
//    絕不因為限流器壞掉而把整站鎖死（可用性優先；限流只是護欄，不是核心安全）。
// 2) 每使用者限流：以已驗證 JWT 的 sub（使用者 ID）為 key；
//    即使 token 外洩被多個 IP 濫用，也以「同一使用者」彙總計次。取不到 sub 時退回 IP。
// 3) 固定視窗：用「時間桶」當 key 一部分（rl:u:<sub>:<bucket>），
//    每個視窗自然換 key、舊 key 到期自動消失，避免殘留無 TTL 的 key 造成永久封鎖。
//
// 需要的環境變數（由使用者自行在 Vercel 設定，Token 為機密，不應出現在前端）：
//   UPSTASH_REDIS_REST_URL   例：https://xxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN （機密）

const URL    = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN;
const LIMIT  = Number(process.env.RATE_LIMIT_MAX || 200); // 每視窗每人最多請求數
const WINDOW = Number(process.env.RATE_LIMIT_WINDOW || 60); // 視窗秒數

// 從 Authorization 取出 token 並解出 sub（不驗章；此時 requireAuth 已先驗過）
function userKeyFromReq(req) {
  try {
    const raw = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
    if (token) {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      if (payload && payload.sub) return `u:${payload.sub}`;
    }
  } catch (e) { /* 解析失敗則退回 IP */ }
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  return `ip:${ip}`;
}

// 已通過限流 → 回傳 true（呼叫端繼續）；
// 超過額度 → 已寫入 429 回應並回傳 false（呼叫端應立即 return）。
export async function rateLimit(req, res) {
  if (!URL || !TOKEN) return true; // 未設定 → 不啟用（fail-open）

  const bucket = Math.floor(Date.now() / (WINDOW * 1000));
  const key = `rl:${userKeyFromReq(req)}:${bucket}`;

  try {
    // 單次 pipeline：INCR 計次 + EXPIRE 設定本桶 TTL（換桶後舊 key 自動消失）
    const r = await fetch(`${URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['INCR', key], ['EXPIRE', key, WINDOW]]),
    });
    if (!r.ok) return true; // Upstash 異常 → fail-open
    const out = await r.json();
    const count = Array.isArray(out) ? out[0]?.result : null;
    if (typeof count !== 'number') return true; // 非預期回應 → fail-open

    res.setHeader('X-RateLimit-Limit', String(LIMIT));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, LIMIT - count)));
    if (count > LIMIT) {
      res.setHeader('Retry-After', String(WINDOW));
      res.status(429).json({ error: 'rate_limited', message: '請求過於頻繁，請稍候再試' });
      return false;
    }
    return true;
  } catch (e) {
    return true; // 網路/其他錯誤 → fail-open
  }
}
