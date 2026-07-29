# ⚡ PolyEdge - Polymarket 交易員鏈上監控與數據分析 API 引擎

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-v22.22.3-green.svg)](https://nodejs.org/)
[![Chain: Polygon](https://img.shields.io/badge/Chain-Polygon%20PoS-8247E5.svg)](https://polygon.technology/)

`PolyEdge` 是一個專門針對 **Polymarket** 預測市場（特別是 `btc-updown-5m` 比特幣 5 分鐘漲跌合約）所打造的高效能 **鏈上即時監控 (Real-time Monitoring)**、**歷史數據回補 (Historical Backfilling)** 與 **戰績分析 API 服務 (Analytics API Engine)**。

支援透過 **Web 儀表板 UI**、**REST API**、**WebSocket 實時串流** 與 **Node.js Programmatic SDK** 進行全方位監控與二次開發。

---

## 🌟 核心功能特點 (Features)

- **⚡ 實時鏈上買賣監控 (Real-time Logger)**: 2 秒級極速輪購與 Polygon 鏈上 Log 監聽，即時捕獲看漲 (UP)、看跌 (DOWN) 與贖回 (REDEEM) 行為。
- **🏷️ 最近 50 個 By Slug 列表 API**: 自動計算最近 50 個市場（Slug）的 **VOL (交易量)**、**PNL (淨損益)** 與 **ROI (投報率 %)**。
- **🔄 動態地址切換**: 可透過 Web UI、REST API 或 SDK 隨時熱切換監控的目標錢包地址（預設目標: `0x2011550a8fd844aa22b78d0f039bb72befcb71fa`）。
- **📊 戰績與策略分析**: 精算已結算市場勝率 (Win Rate)、資金規模、買入價格分布與 24 小時交易頻率。
- **🌐 零延遲 WebSocket 實時推播**: 新交易發生時即時廣播給所有前端與 API 連線客戶端。

---

## 🚀 快速開始 (Quick Start)

### 1. 安裝依賴 (Prerequisites)
確保環境已安裝 **Node.js (v18+)**:
```bash
git clone <repository-url> polyedge
cd polyedge
npm install
```

### 2. 啟動 Web 服務與 API (Start Server)
預設會監聽 `0.0.0.0:3000`：
```bash
npm start
```
啟動後瀏覽器打開 `http://localhost:3000` 即可進入現代化 Web 儀表板。

### 3. 終端機 CLI 模式 (CLI Usage)
若無需打開網頁，可在 Terminal 中直接使用命令列工具：
```bash
# 1. 啟動即時 Log 串流監控
npm run monitor

# 2. 輸出戰績與勝率分析報告
npm run stats

# 3. 輸出最近 50 個市場 (By Slug) 的 PNL / ROI / VOL 表格
npm run slugs

# 4. 輸出指定 Slug 市場的逐筆交易時間軸紀錄
node cli.js timeline btc-updown-5m-1785282000

# 5. 執行歷史交易數據深度回補 (預設 50 頁)
npm run backfill
```

---

## 📡 REST API 說明 (REST API Documentation)

預設基礎 URL: `http://localhost:3000` (或指定主機 IP)

### 1. 取得系統狀態 (Get System Status)
- **Endpoint**: `GET /api/status`
- **Response**:
```json
{
  "targetAddress": "0x2011550a8fd844aa22b78d0f039bb72befcb71fa",
  "isMonitoring": true,
  "isBackfilling": false,
  "backfillState": { "status": "idle", "progress": 0 },
  "totalTrades": 1536,
  "btc5mTrades": 1536
}
```

---

### 2. 取得最近 50 個 By Slug 列表 (Get Recent Slugs)
- **Endpoint**: `GET /api/slugs?limit=50&address=0x...`
- **Description**: 取得目標地址最近參與的二元期權市場清單，包含 **VOL**、**PNL** 與 **ROI**。
- **Response**:
```json
[
  {
    "slug": "btc-updown-5m-1785282000",
    "title": "Bitcoin Up or Down - July 28, 7:40PM-7:45PM ET",
    "timestamp": 1785282340,
    "dateStr": "2026/7/29 上午7:45:40",
    "vol": 104.45,
    "pnl": 115.55,
    "roi": 110.63,
    "tradeCount": 29
  },
  {
    "slug": "btc-updown-5m-1785281700",
    "title": "Bitcoin Up or Down - July 28, 7:35PM-7:40PM ET",
    "timestamp": 1785282043,
    "dateStr": "2026/7/29 上午7:40:43",
    "vol": 136.78,
    "pnl": 483.17,
    "roi": 353.25,
    "tradeCount": 35
  }
]
```

---

### 3. 取得交易員戰績與策略分析 (Get Analytics)
- **Endpoint**: `GET /api/analytics?address=0x...`
- **Response**:
```json
{
  "wallet": "0x2011550a8fd844aa22b78d0f039bb72befcb71fa",
  "summary": {
    "totalRecords": 1523,
    "totalTrades": 1456,
    "totalRedemptions": 67,
    "totalBuyUsdc": 6558.95,
    "totalRedeemUsdc": 9281.84,
    "btc5mVolumeUsdc": 6558.95,
    "estimatedNetPnL": 2722.89,
    "totalSettledMarkets": 46,
    "totalWinMarkets": 37,
    "winRate": 80.43
  },
  "direction": {
    "Up": { "count": 736, "usdc": 3325.05, "avgPrice": 0.529 },
    "Down": { "count": 720, "usdc": 3233.90, "avgPrice": 0.495 }
  }
}
```

---

### 4. 切換目標監控地址 (Set Target Address)
- **Endpoint**: `POST /api/config`
- **Body**:
```json
{
  "targetAddress": "0x2011550a8fd844aa22b78d0f039bb72befcb71fa"
}
```

---

### 5. 觸發歷史數據回補 (Trigger Backfill)
- **Endpoint**: `POST /api/backfill`
- **Body**:
```json
{
  "maxPages": 50
}
```

---

### 6. 取得指定市場的時間軸紀錄 (Get Market Timeline Log)
- **Endpoint**: `GET /api/timeline?slug=btc-updown-5m-1785282000&address=0x...`
- **Description**: 取得指定市場 (Slug) 依時間排序的格式化文字與交易步驟陣列。
- **Response**:
```json
{
  "slug": "btc-updown-5m-1785282000",
  "title": "Bitcoin Up or Down - July 28, 7:40PM-7:45PM ET",
  "text": "Bitcoin Up or Down - July 28, 7:40PM-7:45PM ET\n\n7月29日 上午07:40:07\n掛單\n買入 1.92 份 Up，價格 $0.48，花費 $0.92\n\n7月29日 上午07:40:08\n掛單\n買入 13.08 份 Up，價格 $0.42，花費 $5.49...",
  "trades": [ ... ]
}
```

---

### 7. 分頁與日期篩選查詢交易明細 (Get Trades List by Date)
- **Endpoint**: `GET /api/trades?date=2026-07-28&page=1&limit=100&btcOnly=true`
- **Description**: 可傳入 `date=YYYY-MM-DD` 篩選指定日期全天所有的逐筆交易紀錄。

---

## 🔌 WebSocket 實時串流 (WebSocket API)

客戶端可建立 WebSocket 連線以獲取即時推播：
- **WebSocket URL**: `ws://localhost:3000`

### 事件訊息範例 (New Trade Broadcast Event):
```json
{
  "type": "new_trade",
  "data": {
    "transactionHash": "0xac7a76613808d94fb9694ea7e7b45a24c0c88ec15b24f2d5581660132dfb41b0",
    "timestamp": 1785282059,
    "side": "BUY",
    "outcome": "Down",
    "price": 0.55,
    "size": 15,
    "usdcSize": 8.25,
    "title": "Bitcoin Up or Down - July 28, 7:40PM-7:45PM ET",
    "slug": "btc-updown-5m-1785282000",
    "isBtc5m": 1
  }
}
```

---

## 💻 程式化調用 SDK (Programmatic Usage)

### Node.js 程式化引用範例
`polyedge` 可直接作為 Node 模組引用：

```javascript
const { getTraderAnalytics, getRecentSlugs, TraderMonitor } = require('./index');

async function main() {
  const address = '0x2011550a8fd844aa22b78d0f039bb72befcb71fa';

  // 1. 取得最近 50 個 By Slug 列表 (含有 PNL, ROI, VOL)
  const slugs = await getRecentSlugs(address, 50);
  console.log('Top Market Slug:', slugs[0]);

  // 2. 取得戰績與勝率分析
  const analytics = await getTraderAnalytics(address);
  console.log('Win Rate:', analytics.summary.winRate + '%');
  console.log('Net PnL: $', analytics.summary.estimatedNetPnL);

  // 3. 實時監控
  const monitor = new TraderMonitor({ targetAddress: address, pollIntervalMs: 2000 });
  monitor.on('trade', (t) => {
    console.log('新交易:', t.side, t.outcome, t.price, t.title);
  });
  await monitor.start();
}

main();
```

---

### Python 客戶端調用範例
在 Python 中直接使用 `requests` 或 `websocket-client` 存取 API：

```python
import requests

BASE_URL = "http://localhost:3000"
ADDRESS = "0x2011550a8fd844aa22b78d0f039bb72befcb71fa"

# 1. 查詢最近 50 個 By Slug 列表 (slug, pnl, roi, vol)
res = requests.get(f"{BASE_URL}/api/slugs?limit=50&address={ADDRESS}")
slugs = res.json()

print("--- 最近 5 個市場 Slugs 戰績 ---")
for s in slugs[:5]:
    print(f"Slug: {s['slug']} | PnL: ${s['pnl']} | ROI: {s['roi']}% | Vol: ${s['vol']}")

# 2. 查詢總戰績分析
analytics = requests.get(f"{BASE_URL}/api/analytics?address={ADDRESS}").json()
summary = analytics['summary']
print(f"\n勝率: {summary['winRate']:.1f}% | 總收益: ${summary['estimatedNetPnL']:.2f} USDC")
```

---

## 🗄️ 資料庫架構 (Database Schema)

系統採用 SQLite 本地資料庫存儲 (`polyedge.db`)：

```sql
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proxy_wallet TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  condition_id TEXT,
  type TEXT NOT NULL,
  side TEXT,
  size REAL,
  usdc_size REAL,
  price REAL,
  asset TEXT,
  outcome TEXT,
  outcome_index INTEGER,
  title TEXT,
  slug TEXT,
  event_slug TEXT,
  transaction_hash TEXT,
  is_btc_5m INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(transaction_hash, condition_id, timestamp, side, size) ON CONFLICT IGNORE
);
```

---

## 🛡️ RPC 與連線異常處理 (RPC & Fault Tolerance)

### 1. 目前使用的 RPC / API 節點
系統採用 **雙重備援架構**：
- **主要 API**: Polymarket Data API (`https://data-api.polymarket.com`)，由 Polymarket 官方直接索引 Polygon 鏈上數據，回應速度最快。
- **備援 Polygon RPC 節點池 (Automatic Failover List)**:
  1. `https://1rpc.io/matic` (1RPC)
  2. `https://polygon.drpc.org` (dRPC)
  3. `https://rpc.ankr.com/polygon` (Ankr)

---

### 2. 連線出錯時的處理機制 (Connection Error Handling)
- **自動容錯與靜默重試 (Automatic Retry)**: 當網路波動、連線逾時 (`ETIMEDOUT`)、斷線 (`ECONNRESET`) 或達到 HTTP 429 速率限制時，`PolyEdge` 的監控模組與 WebSocket **不會崩潰**。系統會在下一個輪詢週期（2 秒後）自動嘗試重連與發送請求。
- **自訂專屬 RPC 節點 (Custom RPC)**:
  若公共 RPC 發生延遲或限制，可以在 `.env` 中設定專屬的 RPC 節點 (如 Alchemy / Infura / QuickNode)：
  ```ini
  POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_API_KEY
  ```

---

## 📜 授權條款 (License)
本專案採用 [MIT License](LICENSE) 釋出。
