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
│   └── summaries.json              # 爬取結果 (not in git)
├── scripts/
│   ├── generate-products.mjs       # 從 DB 產生產品清單
│   └── scrape.mjs                  # Playwright 爬蟲主程式
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
│  ├─ 流程: 首頁建立 session → 人工通過 Cloudflare → 逐頁爬取
│  ├─ 資料提取:
│  │  ├─ DOM: ugc-pdp-review shadow DOM → AI summary 文字
│  │  ├─ API 攔截: /tag/ai/{id} → Review Highlights 標籤
│  │  └─ API 攔截: /review/summary → 評分統計
│  ├─ Input: data/products.json
│  └─ Output: data/summaries.json (增量寫入)
│
└─ 📁 OUTPUT: data/summaries.json
```

## JSON 輸出架構

```json
{
  "62118": {
    "productId": 62118,
    "scrapedAt": "2026-03-19T08:24:37.545Z",
    "url": "https://tw.iherb.com/pr/.../62118",       // 實際 URL (可能被 redirect)
    "summary": "Customers generally praise this...",    // AI 摘要文字 | null
    "tags": ["No fishy taste", "Easy swallow"],         // Review Highlights 標籤
    "rating": {                                         // 評分統計 | null
      "averageRating": 4.8,
      "count": 477434
    }
  }
}
```

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

### 覆蓋率取樣 (待執行)

已準備 49 筆分層取樣產品 (`data/products.json`)：
- 跨 10+ 品牌 (NOW Foods, Swanson, CGN, Solaray, Nature's Way, Frontier Co-op, etc.)
- 跨 4 個評論數區間 (10+, 100+, 1000+, 10000+)
- 跨多個類別 (Supplements, Grocery, Bath, Beauty, Baby, Sports)

執行後可估算真實覆蓋率。

## Cloudflare 限制

- iHerb 使用 Cloudflare managed challenge
- **每次啟動 scraper 需人工介入通過驗證** (debug 模式下手動 click)
- Headless 模式無法自動通過
- `cf_clearance` cookie 有效期約 **30-60 分鐘**
- 建議每 45 分鐘（約 150-200 筆產品）重新建立 session
- 可考慮將 cookies 持久化到磁碟，重啟時嘗試復用以減少人工介入

## 全量爬取執行計畫

### Phase 1: 覆蓋率取樣 (49 筆)

```bash
# 取樣清單已就緒
DEBUG=1 node scripts/scrape.mjs --force
# 人工通過 Cloudflare 後等待完成
# 預計耗時: ~15 分鐘
```

分析結果後決定目標範圍。

### Phase 2: 全量爬取

```bash
# 依覆蓋率結果選擇範圍，例如 1000+ 評論 (~9,800 筆)
node scripts/generate-products.mjs --min-reviews 1000
node scripts/scrape.mjs   # 增量模式，可中斷再繼續
```

- 每筆約 15-20 秒（含等待 + delay）
- 9,800 筆約需 **40-55 小時**，需分批執行
- 增量模式：已爬的自動跳過，中斷後 re-run 即可接續

### Phase 3: 品質驗證與清理

爬完後驗證資料品質：
```bash
node -e "
const d = JSON.parse(require('fs').readFileSync('data/summaries.json'));
const total = Object.keys(d).length;
const withSummary = Object.values(d).filter(v => v.summary).length;
const withTags = Object.values(d).filter(v => v.tags?.length > 0).length;
const errors = Object.values(d).filter(v => v.error).length;
console.log('Total:', total);
console.log('With summary:', withSummary, '(' + (withSummary/total*100).toFixed(1) + '%)');
console.log('With tags:', withTags, '(' + (withTags/total*100).toFixed(1) + '%)');
console.log('Errors:', errors);
"
```

## 建議的後續改進

依優先度排列：

| 優先度 | 改進項目 | 原因 |
|--------|---------|------|
| P0 | Exponential backoff 重試 (3 次, 2/4/8s + jitter) | 減少暫時性失敗損失，業界標準做法 |
| P0 | 每 100 頁回收 page 物件，每 500 頁回收 context | 防止長時間運行 memory leak |
| P0 | Memory 監控 (每 50 筆記錄 heap 用量) | 及早發現 leak，>500MB 時告警 |
| P1 | 儲存格式改 JSONL (append-only) 或 SQLite | 目前每次寫入重寫整個 JSON，50K 筆時 I/O 瓶頸嚴重 |
| P1 | 進度追蹤 progress.json (每 50 筆存檔) | 支援中斷恢復 + 預估完成時間 |
| P1 | 圖片/CSS route abort | 減少 ~20-30% 記憶體用量 |
| P1 | Schema validation (summary 長度、URL 格式) | 及早發現系統性抓取問題 |
| P2 | 2-3 個 browser context 並行 (非 browser instance) | 約 2.5x 加速，共享記憶體 |
| P2 | cf_clearance 45 分鐘自動換 context + cookie 持久化 | 避免 session 過期，減少人工介入 |
| P2 | Circuit breaker (連續 5 個 429 暫停 5 分鐘) | 避免被永久封鎖 |
| P2 | Batch 間長延遲 (每 50-100 筆暫停 15-30 秒) | 打破固定 request pattern |

## 注意事項

- **Cloudflare**: 每次啟動需人工介入，建議用 `npm run scrape:debug` 開瀏覽器視窗
- **增量模式**: 預設跳過已爬取的產品，使用 `--force` 強制重爬
- **台灣 IP**: 會被 redirect 到 `tw.iherb.com`，目前不影響功能但 URL 會不同
- **data/summaries.json**: 不進 git (已在 .gitignore)，是累積式檔案，勿手動刪除
