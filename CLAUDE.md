# 台股雷達 (Taiwan Stock Radar) — Claude Code 接續指南

## 專案概覽

**網址**: https://taiwan-stock-radar.vercel.app/  
**GitHub**: https://github.com/dobe0905-code/taiwan-stock-radar  
**技術棧**: 純 HTML/CSS/JS 前端 + Vercel Serverless Functions 後端（無框架）  
**部署**: Vercel（連接 GitHub main branch，push 後自動部署）

---

## 專案結構

```
taiwan-stock-radar/
├── index.html              # 主前端頁面（單檔 SPA，約 1950 行）
├── vercel.json             # Vercel 路由設定
└── api/
    ├── quote_new.js        # 報價 API（TWSE/TPEx/MIS/K線）
    ├── fundamental_new.js  # 基本面 API（TDCC集保/融資券/三大法人）
    └── global.js           # 全球 API（美股/全球指數，Yahoo Finance）
```

> ⚠️ **重要**: `vercel.json` 的 destination **不加 `.js`**，否則 Vercel 會當靜態檔而非 Function

```json
{
  "rewrites": [
    { "source": "/api/quote",       "destination": "/api/quote_new" },
    { "source": "/api/fundamental", "destination": "/api/fundamental_new" },
    { "source": "/api/global",      "destination": "/api/global" }
  ]
}
```

---

## 資料來源（全部免費，無需 Token）

| API 端點 | 資料來源 | 說明 |
|---------|---------|------|
| `TWSE MI_INDEX` | `www.twse.com.tw` | 當日全市場行情（主要）|
| `MIS getStockInfo` | `mis.twse.com.tw` | 盤中即時報價（每3秒輪詢）|
| `MIS getCategory` | `mis.twse.com.tw` | 盤中分類行情（備援）|
| `TWSE STOCK_DAY` | `www.twse.com.tw` | 日K線歷史（4個月）|
| `TWSE MI_MARGN` | `www.twse.com.tw` | 融資融券 |
| `TWSE T86` | `www.twse.com.tw` | 三大法人買賣超 |
| `TDCC OpenAPI` | `openapi.tdcc.com.tw/v1/opendata/1-5` | 集保持股分散 |
| `TPEx daily` | `www.tpex.org.tw` | 上櫃當日行情 |
| `Yahoo Finance v7` | `query1.finance.yahoo.com` | 美股/全球指數 |
| `TradingView Widget` | `s3.tradingview.com` | 嵌入式K線圖（免費）|

---

## 後端 API 端點完整列表

### `/api/quote` (quote_new.js)

| type | 說明 | 關鍵參數 |
|------|------|---------|
| `twse_list` | 上市股票當日行情 | — |
| `tpex_list` | 上櫃股票當日行情 | — |
| `realtime` | 盤中即時報價 | `market=twse/tpex`, `stocks=2330,2317` |
| `twse_per` | 上市本益比/殖利率 | — |
| `twse_institution` | 三大法人整體 | — |
| `kline` | 日K線（4個月）| `stock_id=2327` |
| `margin_detail` | 融資融券當日 | `stock_id=2327` |
| `intraday` | 分時走勢 | `stock_id=2327`, `market=twse/tpex` |
| `institution_detail` | 個股三大法人 | `stock_id=2327` |

### `/api/fundamental` (fundamental_new.js)

| type | 說明 |
|------|------|
| `holders` | TDCC集保持股分散（大戶/散戶）|
| `institution` | 三大法人整體（備援）|
| `margin` | 融資融券（備援）|
| `foreign` | 外資持股比例 |
| `directors` | 董監持股 |

### `/api/global` (global.js)

| type | 說明 |
|------|------|
| `us_list` | 美股熱門50+個股 |
| `global_index` | 全球29個指數（含^TWII, USD/TWD）|
| `us_detail` | 美股個股詳情+4個月K線 |
| `us_search` | 美股搜尋 |

---

## 前端架構（index.html）

### 全域變數
```javascript
const API = '/api/quote';
let stocks = [];          // 所有股票物件陣列
let sf = 'all';           // 側欄篩選器
let mkt = 'all';          // 市場標籤（all/twse/tpex/etf/us/global/mktchart）
let qf = new Set();       // 快速篩選 Set
let perMap = {};          // 本益比 Map {code: {per, yld, pbr}}
let liveData = {};        // MIS 即時資料快取
let currentDetId = null;  // 目前開啟的個股面板 ID
let dCharts = {};         // Chart.js 實例快取（p=價格, r=雷達, holders 等）
```

### 股票物件結構
```javascript
{
  id: '2327',         // 股票代號
  name: '國巨*',      // 股票名稱
  sector: '被動元件', // 產業分類
  isETF: false,
  market: 'twse',     // 'twse' or 'tpex'
  open, close, high, low,  // 價格（數字）
  vol: 23466,         // 成交量（張）
  chg: 41.00,         // 漲跌價
  chgP: 5.85,         // 漲跌幅 %
  prev: 701.00,       // 昨收
  peV: 55.2,          // 本益比
  yld: 0.86,          // 殖利率 %
  pbV: 8.64,          // 股價淨值比
  sig: {              // AI訊號
    sc: 3,            // 分數 -5~+5
    st: 4,            // 星數 1~5
    cls: 'sig-buy',   // 'sig-buy'/'sig-sell'/'sig-hold'/'sig-watch'
    lbl: '買進',
    rs: ['強勢上漲']
  },
  _kdata: [],         // K線歷史（載入後快取）
  _kdata2m: [],       // 近兩個月K線
}
```

### 主要函數說明

| 函數 | 說明 |
|------|------|
| `loadData()` | 頁面載入主函數，同時拉 twse/tpex/per 三個 API |
| `processTWSE(data)` | 轉換 TWSE API 資料格式 → stocks 物件 |
| `processTPEx(data)` | 轉換 TPEx API 資料格式 → stocks 物件 |
| `renderTable()` | 渲染主表格（getFiltered 後的結果）|
| `openDet(id)` | 開啟個股詳情側面板，啟動 detPoll |
| `closeDet()` | 關閉面板，停止 detPoll |
| `buildDetHTML(s, live)` | 產生個股面板 HTML 字串 |
| `buildDetCharts(s)` | 載入K線、雷達圖、MA、籌碼等 |
| `startDetPoll(s)` | 盤中每3秒輪詢單股 MIS 更新面板 |
| `loadHoldersData(id)` | 載入TDCC集保分散資料 |
| `loadMarginData(id)` | 載入融資融券資料 |
| `loadInstitutionData(id)` | 載入三大法人資料 |
| `loadIndexBar()` | 載入大盤指數列（Yahoo Finance） |
| `setMkt(m, el)` | 切換市場頁籤 |
| `setSF(f, el)` | 切換側欄篩選器 |
| `switchKLine(id, mode)` | 切換K線圖模式（2m/candle/line/today）|
| `showTVStock(id, interval)` | 嵌入 TradingView 個股圖表 |
| `initTVChart(symbol)` | 嵌入 TradingView 大盤圖表 |
| `renderUSTable()` | 渲染美股表格 |
| `renderGlobalTable()` | 渲染全球指數卡片 |

---

## 頁面佈局

```
[Header: 台股雷達 logo | 搜尋 | 證交所● | 櫃買中心● | ●報價延遲30秒 | 更新時間]
[Index Bar: 加權指數 | 台指近月 | 台指期(近) | 上市成交(億) | USD/TWD]
[App]
  [Sidebar]                    [Main]
  總覽                          [市場頁籤: 全部/上市/上櫃/ETF/美股/全球指數/大盤K線]
  ├ 全部股票                    [統計欄: 已載入/上市/上櫃/上漲/下跌/買進/賣出]
  ├ ⭐我的自選股                [篩選列: 上漲/下跌/量大/本益比/殖利率/排序]
  市場類型                      [主表格: 代號/名稱/現價/漲跌幅/本益比/殖利率/量/訊號]
  ├ 上市 TWSE                                    ↓點擊行
  ├ 上櫃 TPEx                   [右側詳情面板(440px)]
  ├ ETF                         ├ 個股基本資訊（即時更新）
  ├ 個股產業（展開）             ├ 即時報價（12格：開/現/高/低/昨/均/量/振/漲/跌幅/內盤/外盤）
  買賣訊號                      ├ 均線乖離率（MA5/10/20/60 + 乖離%）
  ├ 買進訊號                    ├ 大盤K線（近兩個月/蠟燭/折線/當日走勢）
  ├ 賣出訊號                    ├ TradingView技術圖表（日/週/月K + MACD/RSI/EMA60/200）
  ├ 觀察中                      ├ 估值指標（PER/PBR/殖利率）
  熱門族群                      ├ 六維雷達圖
  ├ 🤖 AI/伺服器                ├ 籌碼分析（TDCC集保/大戶散戶/圓餅圖）
  ├ 💻 半導體                   ├ 融資融券（含使用率/券資比）
  ├ 🔌 被動元件                 └ 三大法人（外資/投信/自營/合計）
  ├ 🟩 PCB/載板
  ├ 📦 IC設計
  ├ 💾 記憶體
  ├ ⚡ 電動車/儲能
  ├ 🏦 金融/銀行
  └ 📊 熱門ETF
```

---

## 已知問題與注意事項

### 資料問題
- **均價/內外盤** 僅盤中有值（MIS `pz`/`oa`/`ob` 欄位），盤後顯示「—」，這是正常行為
- **TDCC 集保資料** 每週五更新，週末前顯示上週數據
- **三大法人 T86** 資料單位是**股**（不是張），後端已做 ÷1000 換算
- **MI_INDEX** 盤中不提供資料，盤中改用 MIS getCategory（前15類）
- **成交量** MI_INDEX 單位是股（÷1000=張），MIS `v` 已是張

### 技術限制
- `mis.twse.com.tw` 有 CORS，必須透過 Vercel 後端代理，不能從瀏覽器直接 fetch
- Yahoo Finance API 無需 token 但有頻率限制，60秒 cache
- TradingView Widget 需要瀏覽器能連外網（嵌入式 iframe）
- Vercel Serverless Function 有 10 秒 timeout（getCategory 批次限制在前15類）

### Vercel 部署注意
- `vercel.json` destination **不加 `.js`**（`/api/quote_new` ✓，`/api/quote_new.js` ✗）
- 檔案命名：`quote_new.js`、`fundamental_new.js`、`global.js`
- 所有後端檔案使用 `export default async function handler(req, res)` 格式

---

## CSS 設計系統（CSS Variables）

```css
--bg:#070b14          /* 最深背景 */
--bg2:#0c1220         /* 次深背景（面板） */
--bg3:#111828         /* 按鈕/輸入框 */
--accent:#388bfd      /* 主色藍 */
--accent2:#79b8ff     /* 淺藍文字 */
--green2:#7ee787      /* 上漲綠 */
--red2:#ffa198        /* 下跌紅 */
--amber2:#e3b341      /* 警示橘黃 */
--purple:#bc8cff      /* 紫色 */
--text:#e6edf3        /* 主文字 */
--text2:#8b949e       /* 次文字 */
--text3:#484f58       /* 說明文字 */
--mono:'JetBrains Mono',monospace
--sidebar:240px
--header:52px
/* 指數列高度: 32px（fixed，top: 52px）*/
/* #app padding-top: calc(52px + 32px) = 84px */
```

---

## 熱門族群定義（THEME_MAP）

```javascript
const THEME_MAP = {
  'ai':      // AI/伺服器: 台積電、鴻海、廣達、緯穎、英業達...
  'chip':    // 半導體: 台積電、聯電、聯發科、日月光...
  'passive': // 被動元件: 國巨、凱美、興勤、立隆電、大毅...
  'pcb':     // PCB/載板: 欣興、景碩、南電、燿華...
  'ic':      // IC設計: 聯發科、瑞昱、聯詠...
  'storage': // 記憶體: 旺宏、群聯、南亞科...
  'ev':      // 電動車/儲能: 和大、台達電、貿聯-KY...
  'fin':     // 金融/銀行: 國泰金、富邦金、中信金...
  'etf':     // 熱門ETF: 0050、0056、00878、00919...
}
```

---

## 待改進項目（已識別但尚未實作）

1. **真實分時走勢** — 目前「當日走勢」只顯示開/高/低/收四點，應實作每分鐘 tick 歷史
2. **上櫃 K 線** — `STOCK_DAY` API 目前只支援上市，上櫃需改用 TPEx API
3. **台指期真實資料** — 目前用 `^TWII` 近似，真實台指期需 TAIFEX API（需申請）
4. **集保大戶連買/連賣** — 目前只顯示當週快照，未實作趨勢分析
5. **法人逐日買賣超** — 目前只顯示當日，可加入近10日累計
6. **美股盤前/盤後** — Yahoo Finance 有 `preMarketPrice`/`postMarketPrice` 欄位，可顯示
7. **行動裝置響應式** — 目前針對桌面優化，手機版需要額外 CSS

---

## 常見 Debug 指引

### 載入失敗（API 404）
1. 確認 `vercel.json` destination 不含 `.js`
2. 確認 `api/quote_new.js`、`api/fundamental_new.js`、`api/global.js` 都在 GitHub

### 載入失敗（非 JSON）
1. 直接開 `https://taiwan-stock-radar.vercel.app/api/quote?type=twse_list` 看回應
2. 若回傳 HTML：Vercel routing 問題，檢查 vercel.json
3. 若回傳錯誤 JSON：後端 catch 有捕捉到，看 `error` 欄位

### 資料數字不正確
- 成交量過大：檢查是否沒有 ÷1000（MI_INDEX 是股數）
- 三大法人過大：T86 是股數，需 ÷1000 換算張數
- 漲跌幅計算：用 `chg / (close - chg)` 而非 `chg / open`

### MIS 即時不更新
- 確認 `isTradingNow()` 返回 true（09:00~13:30 台灣時間）
- 確認 `detPollTimer` 有在 `closeDet()` 時清除

---

## 本次對話完成的主要功能（時間序）

1. 移除「盤中即時」badge
2. 修正 TDCC 集保 API（改用 OpenAPI，正確欄位 HolderNum）
3. 修正 quote API（type routing、MIS msgArray 格式轉換）
4. 修正 vercel.json（移除 `/(.*)`萬用路由）
5. 成交量單位修正（MI_INDEX 股數÷1000=張）
6. 漲跌幅公式修正（用昨收計算）
7. 加入個股即時輪詢（startDetPoll，每3秒）
8. 加入即時報價欄位（昨收/均價/內外盤）
9. 季線乖離率（BIAS = (現價-MA60)/MA60×100%）
10. 融資融券升級（使用率/券資比）
11. 三大法人（T86，股數÷1000換算）
12. 美股頁籤（Yahoo Finance v7，50+個股）
13. 全球指數頁籤（29個市場卡片）
14. 大盤指數列（header 下方 fixed bar）
15. 熱門族群側欄（9個族群）
16. 報價延遲30秒標示
17. 大盤K線圖（TradingView Widget 6個市場）
18. 個股 TradingView 技術圖（MACD/RSI/EMA60/EMA200）
19. 全面 null-safe DOM 操作（防止 textContent crash）
20. Firebase 程式碼移除
