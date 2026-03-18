/**
 * Generate products.json from iherb.db
 *
 * Usage:
 *   node scripts/generate-products.mjs                  # all in-stock products
 *   node scripts/generate-products.mjs --limit 100      # first 100
 *   node scripts/generate-products.mjs --min-reviews 1000  # 1000+ reviews only
 *   node scripts/generate-products.mjs --ids 62118,103274  # specific IDs only
 */
import Database from "better-sqlite3";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "input", "iherb.db");
const OUTPUT = join(__dirname, "..", "data", "products.json");

// ── Parse CLI args ──
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: 0, minReviews: 0, ids: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) opts.limit = parseInt(args[++i]);
    if (args[i] === "--min-reviews" && args[i + 1]) opts.minReviews = parseInt(args[++i]);
    if (args[i] === "--ids" && args[i + 1]) opts.ids = args[++i].split(",").map(Number);
  }
  return opts;
}

const opts = parseArgs();
const db = new Database(DB_PATH, { readonly: true });

let query = `
  SELECT iherb_id, url_name
  FROM IHerbProducts
  WHERE stock_status = 0
    AND is_available_to_purchase = 1
    AND is_discontinued = 0
    AND url_name IS NOT NULL
`;
const params = [];

if (opts.ids) {
  query += ` AND iherb_id IN (${opts.ids.map(() => "?").join(",")})`;
  params.push(...opts.ids);
}

if (opts.minReviews > 0) {
  query += " AND total_rating_count >= ?";
  params.push(opts.minReviews);
}

query += " ORDER BY total_rating_count DESC";

if (opts.limit > 0) {
  query += " LIMIT ?";
  params.push(opts.limit);
}

const rows = db.prepare(query).all(...params);
db.close();

const products = rows.map((r) => ({
  id: r.iherb_id,
  url: `/pr/${r.url_name}/${r.iherb_id}`,
}));

writeFileSync(OUTPUT, JSON.stringify(products, null, 2), "utf-8");
console.log(`✅ Generated ${products.length} products → ${OUTPUT}`);
if (products.length > 0) {
  console.log(`   First: ${products[0].id} | Last: ${products[products.length - 1].id}`);
}
