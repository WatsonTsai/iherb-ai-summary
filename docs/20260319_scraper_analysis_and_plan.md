# iHerb AI Summary Scraper — 分析與執行計畫

## 目的

記錄 scraper 初次運行的問題分析、修復過程、AI summary 覆蓋率調查結果，以及完成全量爬取的執行計畫。

## 資料夾結構

```
iherb-ai-summary/
├── input/
│   └── iherb.db                    # iHerb 產品 SQLite DB (50,165 筆, not in git)
├── data/
│   ├── products.json               # 待爬取產品清單 (generated)
│   └── summaries.jsonl             # 爬取結果 JSONL (not in git, append-only)
├── scripts/
│   ├── generate-products.mjs       # 從 DB 產生產品清單
│   ├── scrape.mjs                  # Playwright 爬蟲主程式
│   ├── convert-to-jsonl.mjs        # 一次性遷移: summaries.json → .jsonl
│   ├── stats.mjs                   # JSONL 統計摘要
│   └── lib/
│       └── extract.mjs             # 共用 regex patterns + extractSummary()
├── tests/
│   └── extract.test.mjs            # extractSummary 單元測試 (node:test)
├── docs/
│   └── 20260319_scraper_analysis_and_plan.md  # 本文件
└── SETUP.md                        # 環境建置指南
```

## 步驟架構流程圖

```
📁 INPUT: input/iherb.db (50,165 products)
│
├─ Step1: generate-products.mjs
│  ├─ 目的: 從 SQLite 產生待爬取清單
│  ├─ 篩選: stock_status=0, is_available_to_purchase=1, not discontinued
│  ├─ 參數: --limit, --min-reviews, --ids
│  └─ Output: data/products.json
│
├─ Step2: scrape.mjs
│  ├─ 目的: 用 Playwright 爬取 AI summary
│  ├─ 流程: 首頁建立 session → stealth plugin 自動通過 Cloudflare → 逐頁爬取
│  ├─ 資料提取:
│  │  ├─ DOM: ugc-pdp-review shadow DOM → AI summary 文字
│  │  ├─ API 攔截: /tag/ai/{id} → Review Highlights 標籤
│  │  └─ API 攔截: /review/summary → 評分統計
│  ├─ 穩定性機制:
│  │  ├─ Exponential backoff 重試 (3 次, 2/4/8s + jitter)
│  │  ├─ Page 回收 (每 50 筆) + Context 回收 (每 200 筆)
│  │  ├─ 連續失敗偵測 → 自動暫停 + session 重建
│  │  ├─ Route abort (攔截圖片/CSS/字型，減少記憶體)
│  │  └─ Summary 最短長度驗證 (防止誤提取)
│  ├─ Input: data/products.json
│  └─ Output: data/summaries.jsonl (JSONL, append-only)
│
├─ Step3: stats.mjs
│  ├─ 目的: 統計爬取結果
│  └─ 指令: npm run stats
│
└─ 📁 OUTPUT: data/summaries.jsonl
```

## JSONL 輸出架構

每行一筆 JSON（append-only，不重寫整個檔案）：

```jsonl
{"productId":62118,"scrapedAt":"2026-03-19T08:24:37.545Z","url":"https://tw.iherb.com/pr/.../62118","summary":"Customers generally praise this...","tags":["No fishy taste","Easy swallow"],"rating":null}
{"productId":16035,"scrapedAt":"2026-03-19T08:25:12.000Z","url":"https://tw.iherb.com/pr/.../16035","summary":null,"tags":[],"rating":null}
```

欄位說明：
- `productId` — 產品 ID (number)
- `scrapedAt` — 爬取時間 (ISO 8601)
- `url` — 實際 URL (可能被 redirect 到 tw.iherb.com)
- `summary` — AI 摘要文字 | null
- `tags` — Review Highlights 標籤陣列
- `rating` — 評分統計 | null
- `error` — 錯誤訊息（僅在失敗時出現）

## 問題分析與修復紀錄

### 問題 1: 大量產品 summary 為 null (初次運行 1/10 成功)

**根因**: 台灣 IP 被 redirect 到 `tw.iherb.com`，`ugc-pdp-review` Web Component 的 shadow DOM 未完全 hydrate，固定 5 秒 sleep 不足以等待。

**修復**:
- 加入 `Accept-Language: en-US` header + locale cookie
- 用 `page.waitForFunction()` 動態等待 shadow DOM 內容出現 (最多 15 秒)
- `extractFromDOM()` 加入 `getDeepText()` 遞迴遍歷巢狀 shadow DOM

**結果**: 成功率提升至 8/10。

### 問題 2: Summary 文字只抓到 "say" 而非完整段落

**根因**: 正則 `Customers?\s+(say|...)` 的 capture group 只抓到關鍵詞 "say"，而非完整匹配 `m[0]`。且 "say" 匹配到標題 "What customers say" 而非 AI 摘要段落。

**修復**:
- 移除正則中的 `say` 關鍵詞，避免匹配標題
- 改用 `m[0]` 取完整匹配文字
- 加入最低長度門檻 (`[\s\S]{80,}`) 確保匹配的是段落

**結果**: 64902 成功抓到完整 summary — "Customers report significant improvements in hair, skin, and nails..."

### 問題 3: API interceptor 殘留上一頁資料

**根因**: `page.on("response")` listener 在頁面間未清除，導致後續頁面讀到前頁的 API 回應。

**修復**: 每次 `setupApiInterceptor()` 前呼叫 `page.removeAllListeners("response")`。

### 問題 4: Navigation race condition

**根因**: `page.goto()` 後立即 `sleep(2000)` 再等 `networkidle`，redirect 過程中 `page.evaluate()` 可能遇到 context destroyed。

**修復**: 改為先等 `networkidle`（最多 15 秒），再加 1 秒 settle。

## AI Summary 覆蓋率分析

### 已知事實

- AI summary 由 `ugc-pdp-review` (Stencil.js Web Component) 渲染
- **有此元素的產品頁** → 有 AI summary + Review Highlights tags
- **沒有此元素的產品頁** → 使用舊版 review 系統 (`/ugc/api/storereview/summary`)，無 AI summary
- 是否有此元素**無法從 DB 欄位預判**，只能實際爬頁面確認
- 覆蓋率與評論數**無直接關聯** (10421 有 258K 評論但無 AI summary)

### DB 產品分布

| 評論數區間 | 產品數 | 佔比 |
|-----------|--------|------|
| 10,000+   | 1,636  | 3.3% |
| 5,000-9,999 | 1,594 | 3.2% |
| 1,000-4,999 | 8,189 | 16.3% |
| 100-999 | 17,348 | 34.6% |
| 10-99 | 15,368 | 30.6% |
| 0-9 | 6,030 | 12.0% |
| **Total** | **50,165** | **100%** |

### 覆蓋率取樣結果 (2026-03-19 完成)

49 筆分層取樣，跨 10+ 品牌、4 個評論數區間、多個類別 (Supplements, Grocery, Bath, Beauty, Baby, Sports)。**0 個錯誤，Cloudflare 全自動通過。**

#### 總覽

| 指標 | 數值 |
|------|------|
| 有 AI Summary | **37/59 (62.7%)** |
| 有 Tags | **41/59 (69.5%)** |
| 有 Rating | **54/59 (91.5%)** |
| 錯誤 | **0** |

#### 覆蓋率 vs 評論數

| 評論數 | 覆蓋率 | DB 中產品數 | 預估有 summary |
|--------|--------|------------|----------------|
| 10,000+ | **89%** (17/19) | 1,636 | ~1,456 |
| 1,000-9,999 | **81%** (13/16) | 9,783 | ~7,924 |
| 100-999 | **50%** (7/14) | 17,348 | ~8,674 |
| 10-99 | **0%** (0/10) | 15,368 | ~0 |
| **Total** | | **44,135** | **~18,054** |

**結論：評論數與 AI summary 覆蓋率高度相關。10,000+ 評論的產品有 89% 覆蓋率，100 以下幾乎為零。**

## Cloudflare 處理

- iHerb 使用 Cloudflare managed challenge
- 已整合 `playwright-extra` + `puppeteer-extra-plugin-stealth`
- **Headless 模式可自動通過 Cloudflare**，不需人工介入 (2026-03-19 驗證)
- `cf_clearance` cookie 有效期約 **30-60 分鐘**
- Scraper 每 200 筆自動回收 context 並重建 session（約 50 分鐘），在 cookie 過期前刷新
- 若 stealth 未來失效，退回 `npm run scrape:debug` 人工通過

## 全量爬取執行計畫

### Phase 1: 覆蓋率取樣 ✅ 已完成

49 筆分層取樣，結果如上。

### Phase 2: 全量爬取

兩種策略可選：

**策略 A — 高效率 (建議)**
```bash
node scripts/generate-products.mjs --min-reviews 1000   # ~11,400 筆
node scripts/scrape.mjs                                  # 增量模式
```
- 預期覆蓋率 ~83%，約取得 **~9,400 筆** AI summary
- 每筆 ~15 秒，預計 **~48 小時**
- 可中斷再繼續（增量模式）

**策略 B — 最大範圍**
```bash
node scripts/generate-products.mjs --min-reviews 100    # ~28,700 筆
node scripts/scrape.mjs
```
- 涵蓋更多產品，但 100-999 區間覆蓋率僅 50%
- 預計 **~120 小時**，約一半產品無 summary

### Phase 3: 品質驗證與清理

```bash
npm run stats                    # 統計 summaries.jsonl 的 summary/tags/error 分布
```

## 改進追蹤

### 已完成

| 優先度 | 改進項目 | 狀態 |
|--------|---------|------|
| P0 | Exponential backoff 重試 (3 次, 2/4/8s + jitter) | ✅ 已實作 |
| P0 | Page 回收 (每 50 筆) + Context 回收 (每 200 筆) | ✅ 已實作 |
| P0 | Memory 監控 (heap 用量記錄) | ✅ 已實作 |
| P1 | 儲存格式改 JSONL (append-only) | ✅ 已實作 |
| P1 | 進度追蹤 + ETA 預估 (每 50 筆) | ✅ 已實作 |
| P1 | 圖片/CSS/字型 route abort | ✅ 已實作 |
| P1 | Schema validation (summary 最短長度) | ✅ 已實作 |
| P2 | 連續失敗偵測 + session 自動重建 | ✅ 已實作 |
| — | extractSummary 共用模組 + 單元測試 | ✅ 已實作 |
| — | JSONL 統計腳本 (npm run stats) | ✅ 已實作 |

### 尚未實作

| 優先度 | 改進項目 | 原因 |
|--------|---------|------|
| P2 | 2-3 個 browser context 並行 | 約 2.5x 加速，但複雜度高，建議先確認單線程穩定 |
| P2 | Batch 間長延遲 (每 50-100 筆暫停 15-30 秒) | 打破固定 request pattern，降低被封鎖風險 |

## 注意事項

- **Cloudflare**: stealth plugin 目前可自動通過；若未來失效，改用 `npm run scrape:debug` 人工通過
- **增量模式**: 預設跳過已爬取的產品，使用 `--force` 強制重爬
- **台灣 IP**: 會被 redirect 到 `tw.iherb.com`，不影響功能但 URL 會不同
- **data/summaries.jsonl**: 不進 git (已在 .gitignore)，是 append-only 累積式檔案，勿手動刪除
- **舊格式遷移**: 若有 `data/summaries.json`，用 `npm run convert` 轉為 JSONL
- **低評論產品**: 10-99 則評論的產品覆蓋率為 0%，不建議爬取
