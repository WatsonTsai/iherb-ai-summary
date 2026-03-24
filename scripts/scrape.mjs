import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
chromium.use(stealth());
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SUMMARY_PATTERN, FALLBACK_PATTERN } from "./lib/extract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const RESULTS_FILE = join(DATA_DIR, "summaries.jsonl");
const PRODUCTS_FILE = join(DATA_DIR, "products.json");

const DEBUG = !!process.env.DEBUG;
const FORCE = process.argv.includes("--force");
const DRY_RUN = process.argv.includes("--dry-run");
const HEADLESS = !DEBUG; // Show browser in debug mode

// ── Config ──────────────────────────────────────────────
const BASE_URL = "https://www.iherb.com";
const DELAY_BETWEEN_PAGES = [3000, 6000]; // random delay range (ms)
const PAGE_TIMEOUT = 30_000;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY = 2000;
const PAGE_RECYCLE_INTERVAL = 50;
const CONTEXT_RECYCLE_INTERVAL = 200;
const MIN_SUMMARY_LENGTH = 80;
const CONSECUTIVE_FAIL_THRESHOLD = 3;
const SESSION_REFRESH_PAUSE = 60_000;
const BATCH_PAUSE_INTERVAL = [80, 120]; // pause every N products (random range)
const BATCH_PAUSE_DURATION = [30_000, 90_000]; // pause duration (ms, random range)

// Resource types and URL patterns to block (saves memory & bandwidth)
const BLOCKED_RESOURCE_TYPES = ["image", "media", "font"];
const BLOCKED_URL_PATTERNS = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|css)(\?|$)/i;

// UA pool — rotated on each context creation
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
];

// Canary products — known to have AI summaries, tested before full run
const CANARY_PRODUCTS = [
  { id: 62118, url: "/pr/california-gold-nutrition-omega-3-premium-fish-oil-100-fish-gelatin-softgels-1-100-mg-per-softgel/62118" },
  { id: 64902, url: "/pr/california-gold-nutrition-collagenup-hydrolyzed-marine-collagen-peptides-with-hyaluronic-acid-and-vitamin-c-unflavored-1-02-lb-464-g/64902" },
];

// ── Helpers ─────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min) + min);
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDelay() {
  const [min, max] = DELAY_BETWEEN_PAGES;
  return randomInt(min, max);
}

function isRetryableError(err) {
  const msg = (err.message || "").toLowerCase();
  return /timeout|net::|err_|econnrefused|econnreset|navigation failed|target closed|session closed/.test(msg);
}

function retryDelay(attempt) {
  const base = RETRY_BASE_DELAY * Math.pow(2, attempt); // 2s, 4s, 8s
  const jitter = Math.random() * base * 0.5;
  return base + jitter;
}

function isPageClosed(err) {
  const msg = (err.message || "").toLowerCase();
  return /target closed|session closed/.test(msg);
}

// ── JSONL I/O ───────────────────────────────────────────
function loadScrapedIds() {
  if (!existsSync(RESULTS_FILE)) return new Set();
  const lines = readFileSync(RESULTS_FILE, "utf-8").split("\n").filter(Boolean);
  const ids = new Set();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!entry.error) ids.add(String(entry.productId));
    } catch {}
  }
  return ids;
}

function appendResult(entry) {
  appendFileSync(RESULTS_FILE, JSON.stringify(entry) + "\n", "utf-8");
}

function loadProducts() {
  if (!existsSync(PRODUCTS_FILE)) {
    console.log(`\n⚠ ${PRODUCTS_FILE} not found.`);
    console.log(`Creating sample file. Edit it with your product IDs/URLs.\n`);
    const sample = [
      { id: 62118, url: "/pr/california-gold-nutrition-omega-3-premium-fish-oil-100-fish-gelatin-softgels-1-100-mg-per-softgel/62118" },
      { id: 16035, url: "/pr/now-foods-vitamin-d-3-high-potency-5-000-iu-240-softgels/16035" },
    ];
    writeFileSync(PRODUCTS_FILE, JSON.stringify(sample, null, 2), "utf-8");
    return sample;
  }
  return JSON.parse(readFileSync(PRODUCTS_FILE, "utf-8"));
}

// ── Browser context factory ─────────────────────────────
async function createContext(browser) {
  const ua = randomFrom(USER_AGENTS);
  const viewport = { width: randomInt(1280, 1921), height: randomInt(800, 1081) };
  if (DEBUG) console.log(`   [debug] UA: ${ua.substring(0, 60)}... | Viewport: ${viewport.width}x${viewport.height}`);

  const context = await browser.newContext({
    userAgent: ua,
    viewport,
    locale: "en-US",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  // Force English locale via cookies to prevent redirect to tw.iherb.com
  await context.addCookies([
    { name: "iherb.locale", value: "en-US", domain: ".iherb.com", path: "/" },
    { name: "ih-preference", value: "%7B%22country%22%3A%22US%22%2C%22language%22%3A%22en-US%22%2C%22currency%22%3A%22USD%22%7D", domain: ".iherb.com", path: "/" },
  ]);

  // Remove webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  // Block images, fonts, CSS to save memory and bandwidth
  await context.route("**/*", (route) => {
    const req = route.request();
    if (
      BLOCKED_RESOURCE_TYPES.includes(req.resourceType()) ||
      BLOCKED_URL_PATTERNS.test(req.url())
    ) {
      return route.abort();
    }
    return route.continue();
  });

  return context;
}

// ── Session establishment (Cloudflare) ──────────────────
async function establishSession(page) {
  console.log("🌐 Visiting iHerb homepage to establish session...");
  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
    await sleep(3000);

    const title = await page.title();
    if (title.includes("moment") || title.includes("Just a")) {
      console.log("⏳ Cloudflare challenge detected. Waiting for it to resolve...");
      console.log("   (If headless, try running with: npm run scrape:debug)\n");
      await page.waitForURL("**/iherb.com/**", { timeout: 60_000 });
      await sleep(2000);
    }
    console.log(`✅ Session established: ${await page.title()}\n`);
    return true;
  } catch (e) {
    console.error("❌ Failed to establish session:", e.message);
    console.log("   Try running with: npm run scrape:debug (opens visible browser)");
    return false;
  }
}

// ── Extract AI summary from the rendered DOM ────────────
async function extractFromDOM(page) {
  return page.evaluate(async (patterns) => {
    const { summaryPattern, fallbackPattern } = patterns;
    const out = { summary: null, tags: [], productId: null, _shadowTextPreview: null };

    const ugcEl = document.querySelector("ugc-pdp-review");
    out.productId = ugcEl?.getAttribute("product-id") || null;

    // Wait up to 15s for shadow root AND meaningful content to appear
    if (ugcEl) {
      for (let i = 0; i < 30; i++) {
        const sr = ugcEl.shadowRoot;
        if (sr && sr.textContent && sr.textContent.trim().length > 50) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // Collect all text including nested shadow DOMs
    function getDeepText(root) {
      let text = "";
      if (!root) return text;
      for (const node of root.childNodes) {
        if (node.nodeType === 3) { // text node
          text += node.textContent;
        } else if (node.nodeType === 1) { // element
          if (node.shadowRoot) {
            text += getDeepText(node.shadowRoot);
          } else {
            text += getDeepText(node);
          }
        }
      }
      return text;
    }

    // Rebuild regex from pattern strings (cannot pass RegExp across evaluate boundary)
    const SUMMARY_RE = new RegExp(summaryPattern, "i");
    const FALLBACK_RE = new RegExp(fallbackPattern, "i");

    function extractSummary(text) {
      const m = text.match(SUMMARY_RE);
      if (m) return m[0].trim();
      const between = text.match(FALLBACK_RE);
      if (between) return between[1].trim();
      return null;
    }

    // ── Strategy 1: Read from shadow DOM (with nested shadow traversal) ──
    const shadow = ugcEl?.shadowRoot;
    if (shadow) {
      const fullText = getDeepText(shadow);
      out._shadowTextPreview = fullText.substring(0, 300);
      out.summary = extractSummary(fullText);

      // Extract tag names from shadow DOM
      const tagEls = shadow.querySelectorAll(
        "[class*='tag'], [class*='highlight'], [class*='chip']"
      );
      out.tags = Array.from(tagEls)
        .map((el) => el.textContent?.trim())
        .filter((t) => t && t.length > 2 && t.length < 100);
    }

    // ── Strategy 2: Search the full visible page ──
    if (!out.summary) {
      const allElements = document.querySelectorAll("p, div, span, section");
      for (const el of allElements) {
        const text = el.textContent?.trim() || "";
        if (text.length > 80 && text.length < 2000) {
          const found = extractSummary(text);
          if (found) {
            const reviewHighlightsIdx = found.indexOf("Review highlights");
            out.summary = reviewHighlightsIdx > 0
              ? found.substring(0, reviewHighlightsIdx).trim()
              : found;
            break;
          }
        }
      }
    }

    return out;
  }, { summaryPattern: SUMMARY_PATTERN, fallbackPattern: FALLBACK_PATTERN });
}

// ── Intercept API responses for tags + summary ──────────
function setupApiInterceptor(page) {
  const captured = { reviewMeta: null, tags: null, summary: null, _apiUrls: [] };

  // Remove previous listeners to avoid stale data from prior pages
  page.removeAllListeners("response");

  page.on("response", async (response) => {
    const url = response.url();
    try {
      // Track all API calls for debugging
      if (url.includes("api-comms") || url.includes("/api/")) {
        captured._apiUrls.push(url.replace(/\?.*/, ""));
      }

      if (url.includes("/review/summary")) {
        const data = await response.json();
        captured.reviewMeta = {
          rating: data.rating,
          productId: data.productId,
        };
        // Check if summary text is in review/summary response
        if (data.summary || data.aiSummary || data.customerSummary) {
          captured.summary = data.summary || data.aiSummary || data.customerSummary;
        }
      }
      if (url.includes("/tag/ai/")) {
        captured.tags = await response.json();
      }
      // Catch any response containing AI summary text
      if (url.includes("summary") || url.includes("ugc") || url.includes("ai")) {
        const text = await response.text();
        if (text.includes("Customers generally") || text.includes("Customers often") || text.includes("customers praise")) {
          try { captured.summary = JSON.parse(text); } catch { captured.summary = text; }
        }
      }
    } catch {
      // ignore parse errors
    }
  });

  return captured;
}

// ── Progress report ─────────────────────────────────────
function logProgress(i, total, successCount, errorCount, startTime) {
  const elapsed = Date.now() - startTime;
  const avgMs = elapsed / i;
  const remaining = total - i;
  const etaMin = Math.round((remaining * avgMs) / 60_000);
  const heapMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  console.log(`\n📊 Progress: ${i}/${total} (${(i / total * 100).toFixed(1)}%)`);
  console.log(`   Success: ${successCount}, Errors: ${errorCount}, Heap: ${heapMB} MB`);
  console.log(`   ETA: ~${etaMin} min (avg ${(avgMs / 1000).toFixed(1)}s/product)`);
}

// ── Main ────────────────────────────────────────────────
async function main() {
  const products = loadProducts();
  const scrapedIds = loadScrapedIds();

  console.log(`📦 Loaded ${products.length} products`);
  console.log(`📁 Existing results: ${scrapedIds.size}`);

  // --force: truncate existing file
  if (FORCE && existsSync(RESULTS_FILE)) {
    writeFileSync(RESULTS_FILE, "", "utf-8");
  }

  // Filter out already-scraped products (unless --force)
  const todo = FORCE
    ? products
    : products.filter((p) => !scrapedIds.has(String(p.id)));
  console.log(`🔍 To scrape: ${todo.length}${FORCE ? " (--force)" : ""}\n`);

  if (todo.length === 0) {
    console.log("Nothing to do. All products already scraped.");
    console.log("Use --force to re-scrape: node scripts/scrape.mjs --force");
    return;
  }

  // --dry-run: just show counts and exit
  if (DRY_RUN) {
    console.log("(dry run — exiting without scraping)");
    return;
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  let context = await createContext(browser);
  let page = await context.newPage();

  if (!await establishSession(page)) {
    await browser.close();
    return;
  }

  // ── Canary test: verify extraction logic works ──
  console.log("🐤 Running canary test...");
  let canaryPassed = 0;
  for (const canary of CANARY_PRODUCTS) {
    const url = `${BASE_URL}${canary.url}`;
    try {
      const captured = setupApiInterceptor(page);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await sleep(1000);
      await page.evaluate(() => {
        const ugc = document.querySelector("ugc-pdp-review");
        if (ugc) ugc.scrollIntoView({ behavior: "instant", block: "center" });
      });
      try {
        await page.waitForFunction(
          () => document.querySelector("ugc-pdp-review")?.shadowRoot?.textContent?.trim().length > 50,
          { timeout: 15_000 }
        );
      } catch {}
      await sleep(1000);
      const domResult = await extractFromDOM(page);
      const summary = domResult.summary || (typeof captured.summary === "string" ? captured.summary : null);
      if (summary && summary.length >= MIN_SUMMARY_LENGTH) {
        console.log(`   ✅ Canary ${canary.id}: OK`);
        canaryPassed++;
      } else {
        console.log(`   ❌ Canary ${canary.id}: no summary extracted`);
      }
    } catch (e) {
      console.log(`   ❌ Canary ${canary.id}: ${e.message}`);
    }
  }
  if (canaryPassed === 0) {
    console.error("\n❌ All canary tests failed — extraction logic may be broken. Aborting.");
    await browser.close();
    return;
  }
  console.log(`   Canary: ${canaryPassed}/${CANARY_PRODUCTS.length} passed\n`);

  let successCount = 0;
  let errorCount = 0;
  let consecutiveFails = 0;
  const startTime = Date.now();
  let nextBatchPause = randomInt(BATCH_PAUSE_INTERVAL[0], BATCH_PAUSE_INTERVAL[1] + 1);

  // Scrape each product
  for (let i = 0; i < todo.length; i++) {
    const product = todo[i];
    const productId = String(product.id);
    const productUrl = product.url.startsWith("http")
      ? product.url
      : `${BASE_URL}${product.url}`;

    // ── Context recycling (every 200 products) ──
    if (i > 0 && i % CONTEXT_RECYCLE_INTERVAL === 0) {
      logProgress(i, todo.length, successCount, errorCount, startTime);
      console.log(`🔄 Recycling context (after ${i} products)...`);
      await context.close();
      context = await createContext(browser);
      page = await context.newPage();
      await establishSession(page);
    }
    // ── Page recycling (every 50 products, skip if context just recycled) ──
    else if (i > 0 && i % PAGE_RECYCLE_INTERVAL === 0) {
      logProgress(i, todo.length, successCount, errorCount, startTime);
      console.log(`♻️  Recycling page...`);
      await page.close();
      page = await context.newPage();
    }

    console.log(`── [${i + 1}/${todo.length}] Scraping product ${productId} ──`);
    console.log(`   URL: ${productUrl}`);

    // ── Retry loop ──
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      // Set up API response interceptor
      const captured = setupApiInterceptor(page);

      try {
        await page.goto(productUrl, {
          waitUntil: "domcontentloaded",
          timeout: PAGE_TIMEOUT,
        });

        // Wait for possible redirect to settle, then ensure page is stable
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await sleep(1000);

        // Scroll down to trigger lazy-loaded components
        await page.evaluate(() => {
          const ugc = document.querySelector("ugc-pdp-review");
          if (ugc) {
            ugc.scrollIntoView({ behavior: "instant", block: "center" });
          } else {
            // Scroll to bottom half of page to trigger lazy loads
            window.scrollTo(0, document.body.scrollHeight * 0.6);
          }
        });

        // Wait for ugc-pdp-review shadow root to appear (up to 15s), then a short settle
        try {
          await page.waitForFunction(
            () => {
              const el = document.querySelector("ugc-pdp-review");
              return el?.shadowRoot?.textContent?.trim().length > 50;
            },
            { timeout: 15_000 }
          );
        } catch {
          // Component may not exist on this page — continue with extraction anyway
        }
        await sleep(1000);

        // Extract from DOM (primary source for AI summary text)
        const domResult = await extractFromDOM(page);

        // Build clean entry — prefer DOM summary, fallback to API-captured summary
        let summary = domResult.summary || (typeof captured.summary === "string" ? captured.summary : null);
        if (summary && summary.length < MIN_SUMMARY_LENGTH) {
          console.log(`   ⚠ Summary too short (${summary.length} chars), discarding: "${summary}"`);
          summary = null;
        }
        const entry = {
          productId: product.id,
          scrapedAt: new Date().toISOString(),
          url: await page.url(),
          summary,
          tags: [],
          rating: captured.reviewMeta?.rating || null,
        };

        // Tags: prefer intercepted API data, fallback to DOM
        if (captured.tags?.tags && Array.isArray(captured.tags.tags)) {
          entry.tags = captured.tags.tags.map((t) => t.name);
        } else if (domResult.tags.length > 0) {
          entry.tags = domResult.tags;
        }

        if (DEBUG) {
          entry._debug = { domResult, captured };
        }

        appendResult(entry);
        successCount++;

        // ── Consecutive failure detection (empty results = soft fail) ──
        if (!entry.summary && (!entry.tags || entry.tags.length === 0)) {
          consecutiveFails++;
        } else {
          consecutiveFails = 0;
        }

        const status = entry.summary ? "✅" : "⚠️  no summary found";
        console.log(`   ${status}`);
        if (entry.summary) {
          console.log(`   Summary: ${entry.summary.substring(0, 120)}...`);
        }
        if (entry.tags.length > 0) {
          console.log(`   Tags: [${entry.tags.join(", ")}]`);
        }
        if (DEBUG && !entry.summary) {
          console.log(`   [debug] Shadow text: ${JSON.stringify(domResult._shadowTextPreview?.substring(0, 200) || "(none)")}`);
          console.log(`   [debug] API URLs: ${captured._apiUrls?.join(", ") || "(none)"}`);
          console.log(`   [debug] API summary: ${captured.summary ? "found" : "none"}`);
        }

        break; // success — exit retry loop

      } catch (e) {
        const retryable = isRetryableError(e);
        const lastAttempt = attempt >= RETRY_ATTEMPTS - 1;

        if (retryable && !lastAttempt) {
          const delay = retryDelay(attempt);
          console.log(`   ⚠️  Retryable error (attempt ${attempt + 1}/${RETRY_ATTEMPTS}): ${e.message}`);
          console.log(`   ⏳ Retrying in ${Math.round(delay)}ms...`);

          // Rebuild page if it was destroyed
          if (isPageClosed(e)) {
            console.log(`   🔄 Page closed — recreating...`);
            try { await page.close(); } catch {}
            page = await context.newPage();
          }

          await sleep(delay);
          continue;
        }

        // Not retryable or final attempt — log error and move on
        console.error(`   ❌ Error: ${e.message}`);
        appendResult({
          productId: product.id,
          scrapedAt: new Date().toISOString(),
          error: e.message,
        });
        errorCount++;
        consecutiveFails++;

        // Rebuild page if closed
        if (isPageClosed(e)) {
          try { await page.close(); } catch {}
          page = await context.newPage();
        }

        break;
      }
    }

    // ── Session health check: pause & refresh on consecutive failures ──
    if (consecutiveFails >= CONSECUTIVE_FAIL_THRESHOLD) {
      console.log(`\n⚠️  ${consecutiveFails} consecutive empty results — session may be stale`);
      console.log(`   Pausing ${SESSION_REFRESH_PAUSE / 1000}s and recycling context...`);
      await sleep(SESSION_REFRESH_PAUSE);

      // Full context rebuild
      await context.close();
      context = await createContext(browser);
      page = await context.newPage();
      await establishSession(page);
      consecutiveFails = 0;
    }

    // ── Batch pause (every 80-120 products, randomized) ──
    if (i > 0 && i >= nextBatchPause) {
      const pauseMs = randomInt(BATCH_PAUSE_DURATION[0], BATCH_PAUSE_DURATION[1] + 1);
      console.log(`\n☕ Batch pause at product ${i} (${(pauseMs / 1000).toFixed(0)}s)...`);
      await sleep(pauseMs);
      nextBatchPause = i + randomInt(BATCH_PAUSE_INTERVAL[0], BATCH_PAUSE_INTERVAL[1] + 1);
    }

    // Random delay between pages
    if (i < todo.length - 1) {
      const delay = randomDelay();
      console.log(`   ⏳ Waiting ${delay}ms...\n`);
      await sleep(delay);
    }
  }

  // ── Auto summary ──
  const elapsed = Date.now() - startTime;
  const elapsedMin = (elapsed / 60_000).toFixed(1);
  const heapMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  const summaryCount = successCount - errorCount;
  console.log(`\n🏁 Done! Results appended to ${RESULTS_FILE}`);
  console.log(`   Processed: ${todo.length} | Success: ${successCount} | Errors: ${errorCount}`);
  console.log(`   Duration: ${elapsedMin} min | Avg: ${(elapsed / todo.length / 1000).toFixed(1)}s/product`);
  console.log(`   Final heap: ${heapMB} MB`);
  await browser.close();
}

main().catch(console.error);
