# Playwright Google 自動截圖工具

自動查詢 Google 搜尋結果，當一般自然搜尋結果、AI 摘要（AI Overview）、AI Mode 出現指定品牌關鍵字時，自動截圖並輸出 `result.csv`。

---

## 安裝方式

### 前置需求
- Node.js 18 以上

### 步驟

```bash
# 1. 安裝套件
npm install

# 2. 安裝 Playwright 瀏覽器（只需執行一次）
npx playwright install chromium
```

---

## 執行方式

```bash
node index.js
```

執行後會：
1. 讀取 `keywords.json`（搜尋關鍵字）
2. 讀取 `targets.json`（目標品牌規則）
3. 依序搜尋每個關鍵字，截圖存至 `screenshots/`
4. 輸出 `result.csv`（含所有命中、排除、未命中紀錄）

---

## keywords.json — 新增搜尋關鍵字

格式為 JSON 陣列，每個字串為一個搜尋關鍵字：

```json
[
  "賣房子",
  "買房子",
  "房屋仲介推薦",
  "台北買房"
]
```

直接新增字串到陣列即可，程式會逐一搜尋。

---

## targets.json — 新增目標品牌

格式為 JSON 陣列，每個物件代表一個品牌：

```json
[
  {
    "name": "品牌名稱",
    "matchKeywords": ["品牌網域關鍵字", "品牌中文名"],
    "excludeKeywords": ["新聞", "news"],
    "excludeDomains": ["udn", "ettoday", "yahoo"]
  }
]
```

### 欄位說明

| 欄位 | 說明 |
|------|------|
| `name` | 品牌名稱（用於截圖檔名與 CSV） |
| `matchKeywords` | 只要標題、網址、摘要、AI 摘要中包含任一關鍵字，就視為命中（不區分大小寫） |
| `excludeKeywords` | 若比對文字包含任一排除關鍵字，則排除（不截圖，但寫入 CSV） |
| `excludeDomains` | 若結果網址的 hostname 包含任一字串，則排除 |

### 新增品牌範例

```json
{
  "name": "信義",
  "matchKeywords": ["sinyi", "信義房屋"],
  "excludeKeywords": ["新聞", "news"],
  "excludeDomains": ["udn", "ettoday", "chinatimes", "ltn", "yahoo"]
}
```

新增後重新執行 `node index.js` 即可。

---

## result.csv — 欄位說明

| 欄位 | 說明 |
|------|------|
| 查詢時間 | 格式 YYYYMMDD_HHMM |
| 關鍵字 | 搜尋的關鍵字 |
| sourceType | `google_top10` / `ai_overview` / `ai_mode` |
| 命中品牌 | 命中的品牌 name |
| 命中關鍵字 | 實際命中的 matchKeyword |
| 是否命中 | Y / N |
| 是否排除 | Y / N |
| 排除原因excludeKeyword | 若因 excludeKeywords 排除，顯示命中的關鍵字 |
| 排除網域excludeDomain | 若因 excludeDomains 排除，顯示命中的網域字串 |
| 排名 | 自然搜尋結果的排名（1–10），AI 區塊無排名 |
| 標題title | 搜尋結果標題 |
| 網址url | 搜尋結果網址 |
| 摘要snippet | 搜尋結果摘要文字 |
| 截圖檔名screenshotFile | 截圖的相對路徑，空白表示未截圖 |
| 備註note | 錯誤訊息、未出現說明等 |

---

## screenshots/ 資料夾

截圖存放於 `screenshots/`，檔名格式：

```
YYYYMMDD_HHMM_關鍵字_結果來源_品牌名稱.png
```

範例：
```
20260514_1030_賣房子_google_top10_住商.png
20260514_1031_賣房子_ai_overview_中信.png
20260514_1032_買房子_ai_mode_大家.png
```

- 截圖為 `fullPage`（完整頁面）
- AI Overview 截圖若能定位元素，則只截 AI 區塊；否則截可見畫面
- 同一關鍵字 + 同一品牌只截一次（避免重複大量截圖）

---

## 常見問題

### Q: 程式跑到一半出現「偵測到 CAPTCHA 驗證碼，跳過」

Google 偵測到自動化行為，顯示驗證碼。

**解法：**
- 關鍵字之間的等待時間已內建 3–6 秒隨機延遲
- 若頻繁發生，可將 `index.js` 中的 delay 調高（例如 8000–15000ms）
- 在高流量時段（台灣白天）可能更容易觸發，建議在離峰時執行
- 可將 `headless: true` 改為 `headless: false` 觀察瀏覽器狀態

### Q: AI Overview 未出現

- 並非所有搜尋關鍵字都會顯示 AI Overview，屬於正常現象
- `result.csv` 的 `sourceType=ai_overview` 列中備註欄會顯示「AI Overview 未出現」
- Google 的 AI Overview 仍在持續推出中，非所有地區、帳號都會看到

### Q: AI Mode 入口未出現

- AI Mode 為 Google 實驗功能，不一定對所有使用者開放
- 程式不會因為找不到 AI Mode 入口而報錯，會直接略過並記錄在 CSV

### Q: 自然搜尋結果為 0 筆

- Google 的 HTML 結構可能因版本更新而改變
- 可將 `headless: false` 觀察實際頁面結構，並調整 `extractOrganicResults` 中的 CSS selector

### Q: 截圖是空白或不完整

- 某些頁面有 lazy-loading，截圖前可在 `index.js` 中增加 `waitForTimeout`
- `fullPage: true` 模式下，部分動態內容可能未載入完成

### Q: result.csv 在 Excel 開啟後中文亂碼

- 程式已在 CSV 開頭寫入 UTF-8 BOM（`﻿`），Excel 應能正確開啟
- 若仍亂碼，請用「資料 > 從文字/CSV」匯入，並選擇 UTF-8 編碼

---

## 注意事項

- 本工具使用無痕模式（每個關鍵字建立全新 browser context），不登入 Google 帳號
- 搜尋結果因地區、時間、個人化設定不同而有差異，本工具加入 `pws=0`（關閉個人化）和 `nfpr=1` 參數以盡量取得一致結果
- 品牌規則完全由 `targets.json` 控制，新增品牌只需修改該檔案
