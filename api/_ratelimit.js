// api/_ratelimit.js
// Phase 2.5：Upstash Redis 速率限制（每使用者固定視窗）
// 檔名以底線開頭，Vercel 不會把它當路由端點，僅作共用模組。
//
// 設計重點：
// 1) Fail-open：若未設定 Upstash 環境變數、或 Upstash 異常，一律「放行」，
//    絕不因為限流器壞掉而把整站鎖死（可用性優先；限流只是護欄，不是核心安全）。
// 2) 每使用者限流：以已驗證 JWT 的 sub（使用者 ID）為 key；
//    即使 token 外洩被多個 IP 濫用，也以「同一使用者」彙總計次。取不到 sub 時退回 IP。
// 3) 雙層固定視窗：
//    - 每分鐘視窗（防瞬間爆量）：rl:<user>:<minBucket>
//    - 每日上限（防慢速整批爬取）：rl:<user>:d:<dayBucket>
//    兩層在同一個 pipeline 一次檢查，不增加網路往返。
//    每個視窗自然換 key、舊 key 到期自動消失，避免殘留無 TTL 的 key 造成永久封鎖。
//    每日上限預設 30000：遠高於「認真盯盤」正常使用者一天的用量（約 15k~20k），
//    正常操作碰不到；只擋持續高速的整批爬取。可用環境變數調整。
//
// 需要的環境變數（由使用者自行在 Vercel 設定，Token 為機密，不應出現在前端）：
//   UPSTASH_REDIS_REST_URL   例：https://xxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN （機密）

const URL    = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN;
const LIMIT  = Number(process.env.RATE_LIMIT_MAX || 200); // 每視窗每人最多請求數
const WINDOW = Number(process.env.RATE_LIMIT_WINDOW || 60); // 視窗秒數
const DAILY  = Number(process.env.RATE_LIMIT_DAILY || 30000); // 每人每日上限（防整批爬取）
const DAY_SEC = 86400; // 每日視窗秒數（固定）

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

  const now = Date.now();
  const ukey = userKeyFromReq(req);
  const minBucket = Math.floor(now / (WINDOW * 1000));
  const dayBucket = Math.floor(now / (DAY_SEC * 1000));
  const minKey = `rl:${ukey}:${minBucket}`;
  const dayKey = `rl:${ukey}:d:${dayBucket}`;

  try {
    // 單次 pipeline：分鐘視窗 + 每日視窗各 INCR + EXPIRE（換桶後舊 key 自動消失）
    const r = await fetch(`${URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['INCR', minKey], ['EXPIRE', minKey, WINDOW],
        ['INCR', dayKey], ['EXPIRE', dayKey, DAY_SEC],
      ]),
    });
    if (!r.ok) return true; // Upstash 異常 → fail-open
    const out = await r.json();
    const minCount = Array.isArray(out) ? out[0]?.result : null;
    const dayCount = Array.isArray(out) ? out[2]?.result : null;
    if (typeof minCount !== 'number') return true; // 非預期回應 → fail-open

    res.setHeader('X-RateLimit-Limit', String(LIMIT));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, LIMIT - minCount)));
    if (typeof dayCount === 'number') {
      res.setHeader('X-RateLimit-Daily-Limit', String(DAILY));
      res.setHeader('X-RateLimit-Daily-Remaining', String(Math.max(0, DAILY - dayCount)));
    }

    // 每分鐘視窗超限 → 短暫稍候即可
    if (minCount > LIMIT) {
      res.setHeader('Retry-After', String(WINDOW));
      res.status(429).json({ error: 'rate_limited', message: '請求過於頻繁，請稍候再試' });
      return false;
    }
    // 每日上限超限 → 提示隔日（或調高上限）
    if (typeof dayCount === 'number' && dayCount > DAILY) {
      const retry = DAY_SEC - Math.floor((now / 1000) % DAY_SEC);
      res.setHeader('Retry-After', String(retry));
      res.status(429).json({ error: 'daily_rate_limited', message: '今日請求次數已達上限，請明日再試' });
      return false;
    }
    return true;
  } catch (e) {
    return true; // 網路/其他錯誤 → fail-open
  }
}
