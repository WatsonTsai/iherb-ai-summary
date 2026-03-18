# iherb-ai-summary

## 這個專案在做什麼？

批量爬取 iHerb 產品頁面上 **AI 生成的評論摘要**，建立一份 `productId → AI summary` 的結構化資料。

## 為什麼要做這個？

iHerb 每個產品頁面都有一個 "What Customers Say" 區塊，裡面包含：

- 一段 AI 根據所有用戶評論生成的**自然語言摘要**（例如：「顧客普遍讚賞這款 Omega-3 的高品質和無魚腥味...」）
- 一組 AI 生成的 **Review Highlights 標籤**（例如：「No fishy taste」「Easy swallow」）

這些資料是 iHerb 用 AI 分析數十萬則用戶評論後產生的精華，具有很高的參考價值。但 iHerb 沒有公開 API 可以直接取得，且受到 Cloudflare 保護，因此需要透過瀏覽器自動化來擷取。

## 技術挑戰

1. **Cloudflare 保護** — iHerb 使用 Cloudflare managed challenge，curl 或普通 HTTP client 會被擋（403）
2. **Web Component 延遲載入** — AI 摘要由 `ugc-pdp-review`（Stencil.js Web Component）渲染，需等待 hydration
3. **API CORS 限制** — `api-comms.iherb.com` 的 API 無法從瀏覽器外部直接呼叫
4. **地區導向** — 從台灣存取會被 redirect 到 `tw.iherb.com`，頁面結構可能略有不同

## 解決方案

使用 **Playwright**（真實 Chromium 瀏覽器）：
- 先訪問首頁建立 session，通過 Cloudflare 驗證
- 逐頁訪問產品頁面，等待 Web Component hydration
- 從渲染後的 DOM 提取 AI 摘要文字
- 攔截網路回應取得 Review Highlights 標籤
- 結果以 JSON 格式儲存

## 資料來源

產品清單來自預先爬取的 `iherb.db`（SQLite，約 25,276 筆產品），存放於內網 NAS：
- `http://leana.local/forge/20260122/iherb.db`

## 輸出格式

`data/summaries.json`：

```json
{
  "62118": {
    "productId": 62118,
    "scrapedAt": "2026-03-18T08:24:37.545Z",
    "url": "https://www.iherb.com/pr/.../62118",
    "summary": "Customers generally praise this Omega-3 supplement for its high quality and lack of fishy taste...",
    "tags": ["No fishy taste", "Noticeable improvement", "Improved mood", ...],
    "rating": { "averageRating": 4.8, "count": 477434, ... }
  }
}
```
