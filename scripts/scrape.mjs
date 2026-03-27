import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
chromium.use(stealth());
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SUMMARY_PATTERN, FALLBACK_PATTERN } from "./lib/extract.mjs";
import { SummariesDB } from "./lib/db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const PRODUCTS_FILE = join(DATA_DIR, "products.json");

const DEBUG = !!process.env.DEBUG;
const FORCE = process.argv.includes("--force");
const DRY_RUN = process.argv.includes("--dry-run");
const HEADLESS = !DEBUG;
const NUM_CONTEXTS = parseInt(process.env.CONTEXTS || "2");

// ── Config ──────────────────────────────────────────────
const BASE_URL = "https://www.iherb.com";
const DELAY_BETWEEN_PAGES = [2000, 3000];
const PAGE_TIMEOUT = 30_000;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY = 2000;
const PAGE_RECYCLE_INTERVAL = 50;
const CONTEXT_RECYCLE_INTERVAL = 200;
const MIN_SUMMARY_LENGTH = 80;
const CONSECUTIVE_FAIL_THRESHOLD = 5;
const SESSION_REFRESH_PAUSE = 60_000;
const BATCH_PAUSE_INTERVAL = [150, 200];
const BATCH_PAUSE_DURATION = [15_000, 30_000];

const BLOCKED_RESOURCE_TYPES = ["image", "media", "font"];
const BLOCKED_URL_PATTERNS = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|css)(\?|$)/i;

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
];

const CANARY_PRODUCTS = [
  { id: 62118, url: "/pr/california-gold-nutrition-omega-3-premium-fish-oil-100-fish-gelatin-softgels-1-100-mg-per-softgel/62118" },
  { id: 64902, url: "/pr/california-gold-nutrition-collagenup-hydrolyzed-marine-collagen-peptides-with-hyaluronic-acid-and-vitamin-c-unflavored-1-02-lb-464-g/64902" },
];

// ── Helpers ─────────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min) + min); }
function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomDelay() { return randomInt(DELAY_BETWEEN_PAGES[0], DELAY_BETWEEN_PAGES[1]); }

function isRetryableError(err) {
  const msg = (err.message || "").toLowerCase();
  return /timeout|net::|err_|econnrefused|econnreset|navigation failed|target closed|session closed/.test(msg);
}

function retryDelay(attempt) {
  const base = RETRY_BASE_DELAY * Math.pow(2, attempt);
  return base + Math.random() * base * 0.5;
}

function isPageClosed(err) {
  const msg = (err.message || "").toLowerCase();
  return /target closed|session closed/.test(msg);
}

function loadProducts() {
  if (!existsSync(PRODUCTS_FILE)) {
    console.log(`\n⚠ ${PRODUCTS_FILE} not found.`);
    console.log(`Run: node scripts/generate-products.mjs --min-reviews 1000\n`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(PRODUCTS_FILE, "utf-8"));
}

// ── Browser context factory ─────────────────────────────
async function createContext(browser) {
  const ua = randomFrom(USER_AGENTS);
  const viewport = { width: randomInt(1280, 1921), height: randomInt(800, 1081) };
  if (DEBUG) console.log(`   [debug] UA: ${ua.substring(0, 60)}... | Viewport: ${viewport.width}x${viewport.height}`);

  const context = await browser.newContext({
    userAgent: ua, viewport, locale: "en-US",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  await context.addCookies([
    { name: "iherb.locale", value: "en-US", domain: ".iherb.com", path: "/" },
    { name: "ih-preference", value: "%7B%22country%22%3A%22US%22%2C%22language%22%3A%22en-US%22%2C%22currency%22%3A%22USD%22%7D", domain: ".iherb.com", path: "/" },
  ]);

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  await context.route("**/*", (route) => {
    const req = route.request();
    if (BLOCKED_RESOURCE_TYPES.includes(req.resourceType()) || BLOCKED_URL_PATTERNS.test(req.url())) {
      return route.abort();
    }
    return route.continue();
  });

  return context;
}

async function establishSession(page, label = "") {
  const prefix = label ? `[${label}] ` : "";
  console.log(`${prefix}🌐 Establishing session...`);
  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
    await sleep(3000);
    const title = await page.title();
    if (title.includes("moment") || title.includes("Just a")) {
      console.log(`${prefix}⏳ Cloudflare challenge detected...`);
      await page.waitForURL("**/iherb.com/**", { timeout: 60_000 });
      await sleep(2000);
    }
    console.log(`${prefix}✅ Session: ${await page.title()}`);
    return true;
  } catch (e) {
    console.error(`${prefix}❌ Session failed: ${e.message}`);
    return false;
  }
}

// ── Extract AI summary from the rendered DOM ────────────
async function extractFromDOM(page) {
  return page.evaluate(async (patterns) => {
    const { summaryPattern, fallbackPattern } = patterns;
    const out = { summary: null, tags: [], productId: null };

    const ugcEl = document.querySelector("ugc-pdp-review");
    out.productId = ugcEl?.getAttribute("product-id") || null;
    if (!ugcEl) return out;

    // Wait for component to hydrate (light DOM or shadow DOM)
    for (let i = 0; i < 30; i++) {
      const hasContent = ugcEl.textContent && ugcEl.textContent.trim().length > 50;
      const hasShadow = ugcEl.shadowRoot?.textContent?.trim().length > 50;
      if (hasContent || hasShadow) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const SUMMARY_RE = new RegExp(summaryPattern, "i");
    const FALLBACK_RE = new RegExp(fallbackPattern, "i");

    function extractSummary(text) {
      const m = text.match(SUMMARY_RE);
      if (m) return m[0].trim();
      const between = text.match(FALLBACK_RE);
      if (between) return between[1].trim();
      return null;
    }

    // ── Strategy 1: Light DOM text (current iHerb layout) ──
    const fullText = ugcEl.textContent || "";
    out.summary = extractSummary(fullText);
    if (out.summary) {
      const idx = out.summary.indexOf("Review highlights");
      if (idx > 0) out.summary = out.summary.substring(0, idx).trim();
    }

    // ── Strategy 3: Shadow DOM (legacy layout) ──
    if (!out.summary && ugcEl.shadowRoot) {
      function getDeepText(root) {
        let text = "";
        if (!root) return text;
        for (const node of root.childNodes) {
          if (node.nodeType === 3) text += node.textContent;
          else if (node.nodeType === 1) text += node.shadowRoot ? getDeepText(node.shadowRoot) : getDeepText(node);
        }
        return text;
      }
      const shadowText = getDeepText(ugcEl.shadowRoot);
      out.summary = extractSummary(shadowText);
      if (out.summary) {
        const idx = out.summary.indexOf("Review highlights");
        if (idx > 0) out.summary = out.summary.substring(0, idx).trim();
      }
    }

    // ── Tags: try both layouts ──
    const tagEls = ugcEl.querySelectorAll("[class*='tag'], [class*='highlight'], [class*='chip']");
    if (tagEls.length > 0) {
      out.tags = Array.from(tagEls).map((el) => el.textContent?.trim()).filter((t) => t && t.length > 2 && t.length < 100);
    } else if (ugcEl.shadowRoot) {
      const shadowTags = ugcEl.shadowRoot.querySelectorAll("[class*='tag'], [class*='highlight'], [class*='chip']");
      out.tags = Array.from(shadowTags).map((el) => el.textContent?.trim()).filter((t) => t && t.length > 2 && t.length < 100);
    }

    return out;
  }, { summaryPattern: SUMMARY_PATTERN, fallbackPattern: FALLBACK_PATTERN });
}

// ── Single worker: scrape a queue of products ───────────
async function scrapeQueue(browser, queue, db, label) {
  let context = await createContext(browser);
  let page = await context.newPage();

  if (!await establishSession(page, label)) {
    await context.close();
    return { success: 0, errors: 0 };
  }

  let successCount = 0, errorCount = 0, consecutiveFails = 0;
  let nextBatchPause = randomInt(BATCH_PAUSE_INTERVAL[0], BATCH_PAUSE_INTERVAL[1] + 1);

  for (let i = 0; i < queue.length; i++) {
    const product = queue[i];
    const productId = String(product.id);
    const productUrl = product.url.startsWith("http") ? product.url : `${BASE_URL}${product.url}`;

    // Context recycling
    if (i > 0 && i % CONTEXT_RECYCLE_INTERVAL === 0) {
      const heapMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
      console.log(`[${label}] 🔄 Recycling context (${i}/${queue.length}). Heap: ${heapMB} MB`);
      await context.close();
      context = await createContext(browser);
      page = await context.newPage();
      await establishSession(page, label);
    } else if (i > 0 && i % PAGE_RECYCLE_INTERVAL === 0) {
      console.log(`[${label}] ♻️  Recycling page (${i}/${queue.length})`);
      await page.close();
      page = await context.newPage();
    }

    // Progress log
    if (i > 0 && i % 50 === 0) {
      const heapMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
      console.log(`[${label}] 📊 ${i}/${queue.length} | ✅ ${successCount} | ❌ ${errorCount} | Heap: ${heapMB} MB`);
    }

    // Retry loop
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      try {
        await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await sleep(500);

        await page.evaluate(() => {
          const ugc = document.querySelector("ugc-pdp-review");
          if (ugc) ugc.scrollIntoView({ behavior: "instant", block: "center" });
          else window.scrollTo(0, document.body.scrollHeight * 0.6);
        });

        try {
          await page.waitForFunction(
            () => {
              const el = document.querySelector("ugc-pdp-review");
              if (!el) return false;
              const lightText = el.textContent?.trim().length > 50;
              const shadowText = el.shadowRoot?.textContent?.trim().length > 50;
              return lightText || shadowText;
            },
            { timeout: 15_000 }
          );
        } catch {}
        await sleep(500);

        const domResult = await extractFromDOM(page);

        let summary = domResult.summary;
        if (summary && summary.length < MIN_SUMMARY_LENGTH) {
          summary = null;
        }

        db.saveResult({
          productId: product.id,
          summary,
          scrapedAt: new Date().toISOString(),
          url: await page.url(),
          tags: domResult.tags.map((t) => (typeof t === "string" ? { name: t } : t)),
        });
        successCount++;
        consecutiveFails = 0; // successful page load = session is fine

        if (summary) {
          console.log(`[${label}] ✅ ${productId}: ${summary.substring(0, 80)}...`);
        }

        break;

      } catch (e) {
        if (isRetryableError(e) && attempt < RETRY_ATTEMPTS - 1) {
          const delay = retryDelay(attempt);
          if (isPageClosed(e)) {
            try { await page.close(); } catch {}
            page = await context.newPage();
          }
          await sleep(delay);
          continue;
        }

        console.error(`[${label}] ❌ ${productId}: ${e.message}`);
        db.saveError(product.id, e.message);
        errorCount++;
        consecutiveFails++;

        if (isPageClosed(e)) {
          try { await page.close(); } catch {}
          page = await context.newPage();
        }
        break;
      }
    }

    // Session health check
    if (consecutiveFails >= CONSECUTIVE_FAIL_THRESHOLD) {
      console.log(`[${label}] ⚠️  ${consecutiveFails} consecutive fails — refreshing session...`);
      await sleep(SESSION_REFRESH_PAUSE);
      await context.close();
      context = await createContext(browser);
      page = await context.newPage();
      await establishSession(page, label);
      consecutiveFails = 0;
    }

    // Batch pause
    if (i > 0 && i >= nextBatchPause) {
      const pauseMs = randomInt(BATCH_PAUSE_DURATION[0], BATCH_PAUSE_DURATION[1] + 1);
      console.log(`[${label}] ☕ Batch pause (${(pauseMs / 1000).toFixed(0)}s)...`);
      await sleep(pauseMs);
      nextBatchPause = i + randomInt(BATCH_PAUSE_INTERVAL[0], BATCH_PAUSE_INTERVAL[1] + 1);
    }

    // Random delay
    if (i < queue.length - 1) {
      await sleep(randomDelay());
    }
  }

  await context.close();
  return { success: successCount, errors: errorCount };
}

// ── Main ────────────────────────────────────────────────
async function main() {
  const products = loadProducts();
  const db = new SummariesDB();
  const scrapedIds = db.getScrapedIds();

  console.log(`📦 Loaded ${products.length} products`);
  console.log(`📁 Already scraped (with summary): ${scrapedIds.size}`);

  const todo = FORCE
    ? products
    : products.filter((p) => !scrapedIds.has(p.id));
  console.log(`🔍 To scrape: ${todo.length}${FORCE ? " (--force)" : ""}`);
  console.log(`🔀 Parallel contexts: ${NUM_CONTEXTS}\n`);

  if (todo.length === 0) {
    console.log("Nothing to do.");
    db.close();
    return;
  }

  if (DRY_RUN) {
    console.log("(dry run — exiting without scraping)");
    db.close();
    return;
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  // Canary test with first context
  console.log("🐤 Running canary test...");
  let canaryCtx = await createContext(browser);
  let canaryPage = await canaryCtx.newPage();
  if (!await establishSession(canaryPage, "canary")) {
    await browser.close(); db.close(); return;
  }

  let canaryPassed = 0;
  for (const c of CANARY_PRODUCTS) {
    try {
      await canaryPage.goto(`${BASE_URL}${c.url}`, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
      await canaryPage.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await sleep(500);
      await canaryPage.evaluate(() => {
        const ugc = document.querySelector("ugc-pdp-review");
        if (ugc) ugc.scrollIntoView({ behavior: "instant", block: "center" });
      });
      try {
        await canaryPage.waitForFunction(
          () => document.querySelector("ugc-pdp-review")?.shadowRoot?.textContent?.trim().length > 50,
          { timeout: 15_000 }
        );
      } catch {}
      await sleep(500);
      const result = await extractFromDOM(canaryPage);
      if (result.summary && result.summary.length >= MIN_SUMMARY_LENGTH) {
        console.log(`   ✅ Canary ${c.id}: OK`);
        canaryPassed++;
      } else {
        console.log(`   ❌ Canary ${c.id}: no summary`);
      }
    } catch (e) {
      console.log(`   ❌ Canary ${c.id}: ${e.message}`);
    }
  }
  await canaryCtx.close();

  if (canaryPassed === 0) {
    console.error("\n❌ All canary tests failed. Aborting.");
    await browser.close(); db.close(); return;
  }
  console.log(`   Canary: ${canaryPassed}/${CANARY_PRODUCTS.length} passed\n`);

  // Split work across parallel contexts
  const startTime = Date.now();
  const queues = Array.from({ length: NUM_CONTEXTS }, () => []);
  for (let i = 0; i < todo.length; i++) {
    queues[i % NUM_CONTEXTS].push(todo[i]);
  }

  console.log(`🚀 Starting ${NUM_CONTEXTS} parallel workers...`);
  for (let i = 0; i < NUM_CONTEXTS; i++) {
    console.log(`   Worker ${i + 1}: ${queues[i].length} products`);
  }
  console.log();

  const results = await Promise.all(
    queues.map((q, i) => scrapeQueue(browser, q, db, `W${i + 1}`))
  );

  const totalSuccess = results.reduce((s, r) => s + r.success, 0);
  const totalErrors = results.reduce((s, r) => s + r.errors, 0);
  const elapsed = ((Date.now() - startTime) / 60_000).toFixed(1);
  const heapMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  const finalStats = db.stats();

  console.log(`\n🏁 Done in ${elapsed} min`);
  console.log(`   Processed: ${todo.length} | Success: ${totalSuccess} | Errors: ${totalErrors}`);
  console.log(`   Avg: ${(((Date.now() - startTime) / todo.length) / 1000).toFixed(1)}s/product`);
  console.log(`   Heap: ${heapMB} MB`);
  console.log(`   DB: ${finalStats.total} total | ${finalStats.withSummary} summary | ${finalStats.withTags} tags | ${finalStats.withRating} rating`);

  await browser.close();
  db.close();
}

main().catch(console.error);
