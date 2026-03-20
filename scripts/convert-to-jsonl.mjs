#!/usr/bin/env node
// One-time migration: convert existing summaries.json to summaries.jsonl

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const JSON_FILE = join(DATA_DIR, "summaries.json");
const JSONL_FILE = join(DATA_DIR, "summaries.jsonl");

if (!existsSync(JSON_FILE)) {
  console.log(`No ${JSON_FILE} found. Nothing to convert.`);
  process.exit(0);
}

if (existsSync(JSONL_FILE)) {
  console.log(`${JSONL_FILE} already exists. Aborting to avoid overwrite.`);
  console.log("Delete it first if you want to re-convert.");
  process.exit(1);
}

const data = JSON.parse(readFileSync(JSON_FILE, "utf-8"));
const entries = Object.values(data);

const lines = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
writeFileSync(JSONL_FILE, lines, "utf-8");

console.log(`Converted ${entries.length} entries from summaries.json to summaries.jsonl`);
