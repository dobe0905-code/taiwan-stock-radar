// api/_auth.js
// Phase 2：Supabase JWT 驗證（API 防護）
// 檔名以底線開頭，Vercel 不會將其視為路由端點，僅作為共用模組。
//
// 驗證方式：呼叫 Supabase GoTrue 的 /auth/v1/user 端點，
// 帶上前端傳來的使用者 access_token（Bearer）+ 專案 publishable key（apikey）。
// 任何能拿到有效 session 的人，必定已通過註冊時的白名單 trigger，
// 因此這裡只要確認 token 有效即可，毋須再查白名單。
//
// 注意：URL 與 publishable key 皆為「公開」資訊（本就出現在前端原始碼），
// 放在此檔不構成祕密外洩；可被 Vercel 環境變數覆寫。

const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://mollhkwtuxxgqtnujnuh.supabase.co';
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'sb_publishable_6xtAJOfaWgo715ZjzRtdYg_ffUo-rma';

// 驗證請求。已驗證 → 回傳 true（呼叫端繼續）；
// 未驗證 → 已寫入 401 回應並回傳 false（呼叫端應立即 return）。
export async function requireAuth(req, res) {
  const raw = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';

  if (!token) {
    res.status(401).json({ error: 'unauthorized', message: '需要登入' });
    return false;
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON,
      },
    });
    if (!r.ok) {
      res.status(401).json({ error: 'unauthorized', message: '登入已失效，請重新登入' });
      return false;
    }
    return true;
  } catch (e) {
    res.status(401).json({ error: 'unauthorized', message: '驗證失敗' });
    return false;
  }
}
