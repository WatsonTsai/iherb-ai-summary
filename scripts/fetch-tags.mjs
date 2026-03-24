#!/usr/bin/env node
/**
 * Fast API-based fetcher for iHerb AI review tags.
 * Uses ih-experiment cookie (A/B test flag, doesn't expire).
 *
 * Endpoint: GET https://tw.iherb.com/ugc/api/tag/ai/{id}?lc=en-US&count=10
 *
 * Usage:
 *   node scripts/fetch-tags.mjs                          # all from products.json
 *   node scripts/fetch-tags.mjs --limit 100
 *   node scripts/fetch-tags.mjs --concurrency 3 --delay 500
 *   node scripts/fetch-tags.mjs --force                  # re-fetch all
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SummariesDB } from "./lib/db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const PRODUCTS_FILE = join(DATA_DIR, "products.json");
const API_BASE = "https://tw.iherb.com/ugc/api";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: 0, force: false, delay: 500, concurrency: 2 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) opts.limit = parseInt(args[++i]);
    if (args[i] === "--delay" && args[i + 1]) opts.delay = parseInt(args[++i]);
    if (args[i] === "--concurrency" && args[i + 1]) opts.concurrency = parseInt(args[++i]);
    if (args[i] === "--force") opts.force = true;
  }
  return opts;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function loadExperimentCookie() {
  if (process.env.IH_EXPERIMENT) return `ih-experiment=${process.env.IH_EXPERIMENT}`;
  const envPath = join(__dirname, "..", ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^IH_EXPERIMENT=(.+)$/);
      if (m) return `ih-experiment=${m[1].trim()}`;
    }
  }
  console.error("❌ Missing ih-experiment cookie. Set IH_EXPERIMENT in .env or env var.");
  console.error("   See .env.example for instructions.");
  process.exit(1);
}

async function fetchTags(productId, cookie) {
  const url = `${API_BASE}/tag/ai/${productId}?lc=en-US&count=10`;
  const resp = await fetch(url, {
    headers: {
      Cookie: cookie,
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (text.includes("Just a moment") || resp.status === 403) throw new Error("BLOCKED");
    throw new Error(`HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return (data.tags || []).map((t, i) => ({
    name: t.name,
    count: t.count || 0,
    classification: t.classification ?? 0,
    order: i,
  }));
}

async function main() {
  const opts = parseArgs();
  const cookie = loadExperimentCookie();

  let products = JSON.parse(readFileSync(PRODUCTS_FILE, "utf-8"));
  if (opts.limit > 0) products = products.slice(0, opts.limit);

  const db = new SummariesDB();
  const existingStats = db.stats();
  console.log(`📦 Products: ${products.length}`);
  console.log(`📁 DB: ${existingStats.total} total, ${existingStats.withTags} with tags`);
  console.log(`⏱  Delay: ${opts.delay}ms | Concurrency: ${opts.concurrency}`);

  // Quick test
  console.log("🔍 Testing endpoint...");
  try {
    const test = await fetchTags(products[0].id, cookie);
    console.log(`✅ Works! Product ${products[0].id}: ${test.length} tags\n`);
  } catch (e) {
    console.error(`❌ Test failed: ${e.message}`);
    process.exit(1);
  }

  const todo = opts.force
    ? products
    : products.filter((p) => !db.getTaggedIds().has(p.id));
  console.log(`🔍 To fetch: ${todo.length}${opts.force ? " (--force)" : ""}`);
  if (todo.length === 0) { console.log("Nothing to do."); db.close(); return; }

  const etaMin = ((todo.length / opts.concurrency) * (opts.delay + 200) / 60_000).toFixed(1);
  console.log(`⏳ ETA: ~${etaMin} min\n`);

  const startTime = Date.now();
  let fetched = 0, errors = 0, blocked = 0;

  for (let i = 0; i < todo.length; i += opts.concurrency) {
    const batch = todo.slice(i, i + opts.concurrency);
    const results = await Promise.all(
      batch.map(async (p) => {
        try {
          const tags = await fetchTags(p.id, cookie);
          return { id: p.id, tags, error: null };
        } catch (e) {
          return { id: p.id, tags: [], error: e.message };
        }
      })
    );

    for (const r of results) {
      if (r.error === "BLOCKED") {
        blocked++;
        if (blocked >= 5) {
          console.error(`\n❌ Rate limited. ${fetched} saved. Re-run to continue.`);
          db.close(); return;
        }
        console.log(`   ⏳ Blocked, backing off 30s...`);
        await sleep(30_000);
        continue;
      }
      if (r.error) { errors++; continue; }
      db.saveTags(r.id, r.tags);
      fetched++;
    }

    const idx = Math.min(i + opts.concurrency, todo.length);
    if (idx % 200 === 0 || idx === todo.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = fetched > 0 ? (fetched / (elapsed / 60)).toFixed(0) : "—";
      console.log(`[${idx}/${todo.length}] ${fetched} ok, ${errors} err (${elapsed}s, ${rate}/min)`);
    }

    if (i + opts.concurrency < todo.length) await sleep(opts.delay);
  }

  const finalStats = db.stats();
  console.log(`\n🏁 Done! Fetched: ${fetched} | Errors: ${errors}`);
  console.log(`   DB: ${finalStats.withTags} with tags`);
  db.close();
}

main().catch(console.error);
