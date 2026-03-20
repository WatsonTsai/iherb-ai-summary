#!/usr/bin/env node
// Read summaries.jsonl and print statistics

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_FILE = join(__dirname, "..", "data", "summaries.jsonl");

if (!existsSync(RESULTS_FILE)) {
  console.log("No summaries.jsonl found.");
  process.exit(0);
}

const lines = readFileSync(RESULTS_FILE, "utf-8").split("\n").filter(Boolean);
const entries = lines.map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const withSummary = entries.filter((e) => e.summary);
const withTags = entries.filter((e) => e.tags?.length > 0);
const withError = entries.filter((e) => e.error);
const noData = entries.filter((e) => !e.summary && !e.tags?.length && !e.error);

console.log(`Total entries:   ${entries.length}`);
console.log(`With summary:    ${withSummary.length} (${(withSummary.length / entries.length * 100).toFixed(1)}%)`);
console.log(`With tags:       ${withTags.length} (${(withTags.length / entries.length * 100).toFixed(1)}%)`);
console.log(`Errors:          ${withError.length}`);
console.log(`Empty (no data): ${noData.length}`);
