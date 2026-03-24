#!/usr/bin/env node
// Read iherb_summaries.db and print statistics

import { SummariesDB } from "./lib/db.mjs";

const db = new SummariesDB();
const s = db.stats();

if (s.total === 0) {
  console.log("Database is empty.");
  process.exit(0);
}

console.log(`Total products:  ${s.total}`);
console.log(`With summary:    ${s.withSummary} (${(s.withSummary / s.total * 100).toFixed(1)}%)`);
console.log(`With tags:       ${s.withTags} (${(s.withTags / s.total * 100).toFixed(1)}%)`);
console.log(`With rating:     ${s.withRating} (${(s.withRating / s.total * 100).toFixed(1)}%)`);
console.log(`Errors:          ${s.errors}`);

db.close();
