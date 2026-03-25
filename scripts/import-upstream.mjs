#!/usr/bin/env node
/**
 * Import tags from upstream's data/scrape/*.json files (from git).
 * Reads directly from upstream/main branch without checkout.
 *
 * Usage:
 *   node scripts/import-upstream.mjs                    # import all
 *   node scripts/import-upstream.mjs --skip-existing    # skip products already with tags
 */
import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SummariesDB } from "./lib/db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCTS_FILE = join(__dirname, "..", "data", "products.json");

const SKIP_EXISTING = process.argv.includes("--skip-existing");

// Build set of our product IDs to filter
let ourIds = null;
if (existsSync(PRODUCTS_FILE)) {
  const products = JSON.parse(readFileSync(PRODUCTS_FILE, "utf-8"));
  ourIds = new Set(products.map((p) => p.id));
  console.log(`📦 Filtering to our product list: ${ourIds.size} products`);
}

// List all data/scrape/*.json files in upstream/main
console.log("📋 Listing upstream data/scrape/ files...");
let fileList;
try {
  fileList = execSync("git ls-tree --name-only upstream/main data/scrape/", { encoding: "utf-8" })
    .trim().split("\n").filter((f) => f.endsWith(".json"));
} catch {
  console.error("❌ Cannot read upstream/main. Run: git fetch upstream");
  process.exit(1);
}

console.log(`   Found ${fileList.length} files\n`);

const db = new SummariesDB();
const existingTagIds = SKIP_EXISTING ? db.getTaggedIds() : new Set();

let imported = 0, skipped = 0, errors = 0;

for (let i = 0; i < fileList.length; i++) {
  const filePath = fileList[i];
  try {
    const raw = execSync(`git show upstream/main:${filePath}`, { encoding: "utf-8" });
    const entry = JSON.parse(raw);
    const productId = entry.iherb_id;

    if (ourIds && !ourIds.has(productId)) {
      skipped++;
      continue;
    }

    if (SKIP_EXISTING && existingTagIds.has(productId)) {
      skipped++;
      continue;
    }

    const tags = (entry.data?.tags || []).map((t, idx) => ({
      name: t.name,
      count: t.count || 0,
      classification: t.classification ?? 0,
      order: idx,
    }));

    if (tags.length > 0) {
      db.saveTags(productId, tags, entry.last_updated || entry.first_scraped);
      imported++;
    } else {
      skipped++;
    }
  } catch (e) {
    errors++;
  }

  if ((i + 1) % 2000 === 0 || i === fileList.length - 1) {
    console.log(`[${i + 1}/${fileList.length}] Imported: ${imported} | Skipped: ${skipped} | Errors: ${errors}`);
  }
}

const stats = db.stats();
db.close();

console.log(`\n✅ Done!`);
console.log(`   Imported: ${imported} | Skipped: ${skipped} | Errors: ${errors}`);
console.log(`   DB: ${stats.total} total | ${stats.withSummary} summary | ${stats.withTags} tags`);
