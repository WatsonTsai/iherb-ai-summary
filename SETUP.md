# Setup Guide

## Prerequisites

- Node.js >= 18
- Local network access to `leana.local` (for downloading iherb.db)

## 1. Install Dependencies

```bash
npm install
npx playwright install chromium
```

## 2. Download iherb.db

iHerb 產品資料庫存放在本地 NAS，需透過內網下載：

```bash
mkdir -p input
curl -o input/iherb.db http://leana.local/forge/20260122/iherb.db
```

> `input/` 目錄已加入 `.gitignore`，不會進入版本控制。

## 3. Generate Product List

從 SQLite 資料庫生成待爬取的產品清單：

```bash
# 全部在庫產品 (~25K)
node scripts/generate-products.mjs

# 依評論數排序，取前 100 筆
node scripts/generate-products.mjs --limit 100

# 只取 5000+ 評論的產品
node scripts/generate-products.mjs --min-reviews 5000

# 指定特定產品 ID
node scripts/generate-products.mjs --ids 62118,103274
```

輸出至 `data/products.json`。

## 4. Run Scraper

```bash
# Headless 模式
node scripts/scrape.mjs

# Debug 模式（開啟瀏覽器視窗，可觀察 Cloudflare 驗證過程）
DEBUG=1 node scripts/scrape.mjs

# 強制重新爬取所有產品
node scripts/scrape.mjs --force
```

結果存放於 `data/summaries.json`。

## Project Structure

```
iherb-ai-summary/
├── input/
│   └── iherb.db              # iHerb 產品資料庫 (SQLite, not in git)
├── data/
│   ├── products.json          # 待爬取產品清單 (generated)
│   └── summaries.json         # 爬取結果 (not in git)
├── scripts/
│   ├── generate-products.mjs  # 從 DB 生成產品清單
│   └── scrape.mjs             # Playwright 爬蟲主程式
├── package.json
└── .gitignore
```
