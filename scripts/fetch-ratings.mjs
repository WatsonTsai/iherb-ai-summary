#!/usr/bin/env node
/**
 * Fast API-based fetcher for iHerb review ratings.
 * No auth required — hits open endpoint directly.
 *
 * Endpoint: GET https://www.iherb.com/ugc/api/product/{id}/review/summary/v2
 *
 * Usage:
 *   node scripts/fetch-ratings.mjs                       # all from products.json
 *   node scripts/fetch-ratings.mjs --limit 100
 *   node scripts/fetch-ratings.mjs --delay 1000
 *   node scripts/fetch-ratings.mjs --force
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SummariesDB } from "./lib/db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const PRODUCTS_FILE = join(DATA_DIR, "products.json");
const API_BASE = "https://www.iherb.com/ugc/api";

const MAX_RETRIES = 3;
const BACKOFF_BASE = 10_000;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: 0, force: false, delay: 1000 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) opts.limit = parseInt(args[++i]);
    if (args[i] === "--delay" && args[i + 1]) opts.delay = parseInt(args[++i]);
    if (args[i] === "--force") opts.force = true;
  }
  return opts;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchRating(productId, attempt = 1) {
  const url = `${API_BASE}/product/${productId}/review/summary/v2`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });

  if (resp.status === 403) {
    if (attempt <= MAX_RETRIES) {
      const backoff = BACKOFF_BASE * attempt + Math.random() * 5000;
      console.log(`   ⏳ Rate limited (403). Backing off ${(backoff / 1000).toFixed(0)}s (attempt ${attempt}/${MAX_RETRIES})...`);
      await sleep(backoff);
      return fetchRating(productId, attempt + 1);
    }
    throw new Error(`Rate limited after ${MAX_RETRIES} retries`);
  }

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const text = await resp.text();
  if (text.includes("<!DOCTYPE") || text.includes("Just a moment")) {
    if (attempt <= MAX_RETRIES) {
      const backoff = BACKOFF_BASE * attempt + Math.random() * 5000;
      console.log(`   ⏳ Cloudflare challenge. Backing off ${(backoff / 1000).toFixed(0)}s...`);
      await sleep(backoff);
      return fetchRating(productId, attempt + 1);
    }
    throw new Error("Cloudflare challenge after retries");
  }

  const data = JSON.parse(text);
  return data.rating || null;
}

async function main() {
  const opts = parseArgs();

  let products = JSON.parse(readFileSync(PRODUCTS_FILE, "utf-8"));
  if (opts.limit > 0) products = products.slice(0, opts.limit);

  const db = new SummariesDB();
  const existingStats = db.stats();
  console.log(`📦 Products: ${products.length}`);
  console.log(`📁 DB: ${existingStats.total} total, ${existingStats.withRating} with rating`);
  console.log(`⏱  Delay: ${opts.delay}ms (sequential — Cloudflare protected)`);

  const todo = opts.force
    ? products
    : products.filter((p) => !db.getRatedIds().has(p.id));
  console.log(`🔍 To fetch: ${todo.length}${opts.force ? " (--force)" : ""}`);
  if (todo.length === 0) { console.log("Nothing to do."); db.close(); return; }

  const etaMin = ((todo.length * (opts.delay + 300)) / 60_000).toFixed(1);
  console.log(`⏳ ETA: ~${etaMin} min\n`);

  const startTime = Date.now();
  let fetched = 0, errors = 0;

  for (let i = 0; i < todo.length; i++) {
    try {
      const rating = await fetchRating(todo[i].id);
      if (rating) {
        db.saveRating(todo[i].id, rating);
        fetched++;
      } else {
        fetched++; // No rating available, but not an error
      }
    } catch (e) {
      errors++;
      if (errors > 50 && errors > fetched) {
        console.error(`\n❌ Too many errors (${errors}). Stopping.`);
        break;
      }
    }

    if ((i + 1) % 200 === 0 || i === todo.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = fetched > 0 ? (fetched / (elapsed / 60)).toFixed(0) : "—";
      console.log(`[${i + 1}/${todo.length}] ${fetched} ok, ${errors} err (${elapsed}s, ${rate}/min)`);
    }

    if (i < todo.length - 1) await sleep(opts.delay);
  }

  const finalStats = db.stats();
  console.log(`\n🏁 Done! Fetched: ${fetched} | Errors: ${errors}`);
  console.log(`   DB: ${finalStats.withRating} with rating`);
  db.close();
}

main().catch(console.error);
