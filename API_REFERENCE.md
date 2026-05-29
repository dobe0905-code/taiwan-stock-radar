# API 參考文件

## 後端 API 呼叫範例

### 取得上市股票清單
```
GET /api/quote?type=twse_list
回傳: { data: [{Code, Name, ClosingPrice, OpeningPrice, HighestPrice, LowestPrice, Change, TradeVolume, ...}], source, ts }
```

### 取得盤中即時報價
```
GET /api/quote?type=realtime&market=twse&stocks=2330,2327,2317
回傳: { data: [{c, n, z, y, o, h, l, v, pz, oa, ob, t, u, w}], source, ts }

MIS 欄位說明:
  c  = 股票代號
  n  = 股票名稱
  z  = 當盤成交價
  y  = 昨日收盤價
  o  = 開盤價
  h  = 最高價
  l  = 最低價
  v  = 累積成交量（張）
  pz = 加權均價
  oa = 外盤量（買方主動）
  ob = 內盤量（賣方主動）
  t  = 最近成交時間 HH:MM:SS
  u  = 漲停價
  w  = 跌停價
```

### 取得K線資料
```
GET /api/quote?type=kline&stock_id=2327
回傳: { data: [{date, open, high, low, close, volume}], stock_id, source }
備註: volume 單位為「張」，date 格式 YYYY-MM-DD，最近4個月
```

### 取得融資融券
```
GET /api/quote?type=margin_detail&stock_id=2327
回傳: {
  data: {
    marginBuy, marginSell, marginRedeem, marginBalance, marginLimit, marginUsage,
    shortSell, shortBuy, shortReturn, shortBalance, shortLimit, shortUsage,
    offset
  }
}
備註: 所有量單位為「張」，Usage 為百分比
```

### 取得三大法人
```
GET /api/quote?type=institution_detail&stock_id=2327
回傳: {
  data: {
    foreignBuy, foreignSell, foreignNet,   // 外資
    trustBuy, trustSell, trustNet,         // 投信
    dealerNet,                              // 自營商合計
    totalNet                               // 三大合計
  }
}
備註: 單位為「張」（T86原始資料是股數，後端已÷1000）
```

### 取得集保持股分散
```
GET /api/fundamental?type=holders&stock_id=2327
回傳: {
  rows: [{level, holderNum, lots, people, shares, ratio}],
  summary: { bigHolder, smallHolder, bigPeople, smallPeople, totalPeople },
  scaDate,  // 資料日期
  source    // TDCC_OPENAPI / TDCC_WEB
}
備註: bigHolder = 1000張以上持股比例，每週五更新
```

### 取得全球指數
```
GET /api/global?type=global_index
回傳: { data: [{symbol, name, region, price, change, changeP, prev, open, high, low, currency, state}] }

重要 symbols:
  ^TWII    = 台灣加權指數
  ^TWOII   = 台灣櫃買指數
  ^N225    = 日經225
  ^HSI     = 恒生指數
  ^GSPC    = S&P 500
  ^IXIC    = NASDAQ
  ^DJI     = 道瓊工業
  USDTWD=X = 美元/台幣
  ^VIX     = 恐慌指數
  GC=F     = 黃金
  BTC-USD  = 比特幣
```

### 取得美股清單
```
GET /api/global?type=us_list
回傳: { data: [{symbol, name, price, change, changeP, open, high, low, prev, volume, mktCap, pe, wk52High, wk52Low, currency, state}] }

state 值:
  REGULAR = 盤中
  PRE     = 盤前
  POST    = 盤後
  CLOSED  = 收盤
```

---

## TradingView Widget 使用

### 大盤K線（initTVChart）
```javascript
initTVChart('TWSE:TAIEX')   // 加權指數
initTVChart('TWSE:CABK')    // 櫃買指數
initTVChart('CAPITALFUTURES:TX1!') // 台指近月
initTVChart('CBOT:YM1!')    // 道瓊期貨
initTVChart('NASDAQ:NDX')   // 那斯達克100
initTVChart('NASDAQ:PHLX')  // 費城半導體
```

### 個股K線（showTVStock）
```javascript
showTVStock('2327', 'D')  // 日K（上市自動用 TWSE:2327）
showTVStock('6547', 'W')  // 週K（上櫃自動用 TPEX:6547）
showTVStock('2330', 'M')  // 月K
// 內建指標: MACD(12/26/9), RSI(14), EMA60, EMA200, Volume
```

---

## 資料流向

```
瀏覽器
  │
  ├─ 載入時 ──→ /api/quote?type=twse_list ──→ TWSE MI_INDEX（當日）
  │              /api/quote?type=tpex_list ──→ TPEx 官網（當日）
  │              /api/quote?type=twse_per  ──→ TWSE openapi BWIBBU_ALL
  │
  ├─ 盤中每5秒 → /api/quote?type=realtime ──→ mis.twse.com.tw getStockInfo
  │
  ├─ 個股面板 ──→ /api/quote?type=kline    ──→ TWSE STOCK_DAY（4個月）
  │              /api/quote?type=margin_detail ──→ TWSE MI_MARGN
  │              /api/quote?type=institution_detail ──→ TWSE T86
  │              /api/fundamental?type=holders ──→ TDCC openapi.tdcc.com.tw
  │
  ├─ 指數列(每分) → /api/global?type=global_index ──→ Yahoo Finance v7
  │
  ├─ 美股頁籤 ──→ /api/global?type=us_list ──→ Yahoo Finance v7
  │
  └─ TradingView ──→ 直接嵌入 iframe（不經後端）
```
