import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
chromium.use(stealth());
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const RESULTS_FILE = join(DATA_DIR, "summaries.json");
const PRODUCTS_FILE = join(DATA_DIR, "products.json");

const DEBUG = !!process.env.DEBUG;
const FORCE = process.argv.includes("--force");
const HEADLESS = !DEBUG; // Show browser in debug mode

// ── Config ──────────────────────────────────────────────
const BASE_URL = "https://www.iherb.com";
const DELAY_BETWEEN_PAGES = [3000, 6000]; // random delay range (ms)
const PAGE_TIMEOUT = 30_000;

// ── Helpers ─────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay() {
  const [min, max] = DELAY_BETWEEN_PAGES;
  return Math.floor(Math.random() * (max - min) + min);
}

function loadResults() {
  if (existsSync(RESULTS_FILE)) {
    return JSON.parse(readFileSync(RESULTS_FILE, "utf-8"));
  }
  return {};
}

function saveResults(results) {
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), "utf-8");
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

// ── Extract AI summary from the rendered DOM ────────────
async function extractFromDOM(page) {
  return page.evaluate(async () => {
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

    // Summary must be a substantial paragraph (>80 chars), not just a heading
    const SUMMARY_RE = /Customers?\s+(?:generally|often|frequently|commonly|love|praise|appreciate|highly|report|find|enjoy|rave|recommend|are\s+(?:very|highly|mostly|overall))\b[\s\S]{80,}?(?=Review highlights|$)/i;

    function extractSummary(text) {
      const m = text.match(SUMMARY_RE);
      if (m) return m[0].trim();
      // Fallback: look for text between "What customers say" and "Review highlights"
      const between = text.match(/What customers say\s*([\s\S]{80,}?)(?=Review highlights)/i);
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
  });
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

// ── Main ────────────────────────────────────────────────
async function main() {
  const products = loadProducts();
  const results = loadResults();

  console.log(`📦 Loaded ${products.length} products`);
  console.log(`📁 Existing results: ${Object.keys(results).length}`);

  // Filter out already-scraped products (unless --force)
  const todo = FORCE
    ? products
    : products.filter((p) => !results[String(p.id)]);
  console.log(`🔍 To scrape: ${todo.length}${FORCE ? " (--force)" : ""}\n`);

  if (todo.length === 0) {
    console.log("Nothing to do. All products already scraped.");
    console.log("Use --force to re-scrape: node scripts/scrape.mjs --force");
    return;
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
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

  const page = await context.newPage();

  // First visit: go to homepage to get cookies / pass Cloudflare
  console.log("🌐 Visiting iHerb homepage to establish session...");
  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
    await sleep(3000);

    // Check if we hit Cloudflare challenge
    const title = await page.title();
    if (title.includes("moment") || title.includes("Just a")) {
      console.log("⏳ Cloudflare challenge detected. Waiting for it to resolve...");
      console.log("   (If headless, try running with: npm run scrape:debug)\n");
      await page.waitForURL("**/iherb.com/**", { timeout: 60_000 });
      await sleep(2000);
    }
    console.log(`✅ Session established: ${await page.title()}\n`);
  } catch (e) {
    console.error("❌ Failed to establish session:", e.message);
    console.log("   Try running with: npm run scrape:debug (opens visible browser)");
    await browser.close();
    return;
  }

  // Scrape each product
  for (const product of todo) {
    const productId = String(product.id);
    const productUrl = product.url.startsWith("http")
      ? product.url
      : `${BASE_URL}${product.url}`;

    console.log(`── Scraping product ${productId} ──`);
    console.log(`   URL: ${productUrl}`);

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
      const summary = domResult.summary || (typeof captured.summary === "string" ? captured.summary : null);
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

      results[productId] = entry;
      saveResults(results);

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
    } catch (e) {
      console.error(`   ❌ Error: ${e.message}`);
      results[productId] = {
        productId: product.id,
        scrapedAt: new Date().toISOString(),
        error: e.message,
      };
      saveResults(results);
    }

    // Random delay between pages
    if (todo.indexOf(product) < todo.length - 1) {
      const delay = randomDelay();
      console.log(`   ⏳ Waiting ${delay}ms...\n`);
      await sleep(delay);
    }
  }

  console.log(`\n🏁 Done! Results saved to ${RESULTS_FILE}`);
  console.log(`   Total entries: ${Object.keys(results).length}`);
  await browser.close();
}

main().catch(console.error);
