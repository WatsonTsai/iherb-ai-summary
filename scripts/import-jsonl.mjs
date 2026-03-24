#!/usr/bin/env node
/**
 * Import existing summaries.jsonl into SQLite database.
 * Run once to migrate from JSONL to SQLite.
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SummariesDB } from "./lib/db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const JSONL_FILE = join(__dirname, "..", "data", "summaries.jsonl");

if (!existsSync(JSONL_FILE)) {
  console.log("No summaries.jsonl found. Nothing to import.");
  process.exit(0);
}

const lines = readFileSync(JSONL_FILE, "utf-8").split("\n").filter(Boolean);
const entries = lines.map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

console.log(`📥 Importing ${entries.length} entries from summaries.jsonl...`);

const db = new SummariesDB();
let imported = 0;
let skipped = 0;

for (const entry of entries) {
  if (entry.error) {
    skipped++;
    continue;
  }
  db.saveResult({
    productId: entry.productId,
    summary: entry.summary || null,
    scrapedAt: entry.scrapedAt,
    url: entry.url || null,
    tags: (entry.tags || []).map((t) => (typeof t === "string" ? { name: t, count: 0, classification: 0 } : t)),
  });
  imported++;
}

const stats = db.stats();
db.close();

console.log(`✅ Imported: ${imported} | Skipped (errors): ${skipped}`);
console.log(`   DB: ${stats.total} total | ${stats.withSummary} with summary | ${stats.withTags} with tags`);
