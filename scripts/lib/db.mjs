/**
 * SQLite helper for iherb_summaries.db — shared output database.
 * Used by scrape.mjs, fetch-tags.mjs, fetch-ratings.mjs, import-jsonl.mjs.
 */
import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = join(__dirname, "..", "..", "data", "iherb_summaries.db");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS review_summaries (
    iherb_id        INTEGER PRIMARY KEY,
    summary_text    TEXT,
    scraped_at      TEXT NOT NULL,
    final_url       TEXT,
    rating_avg      REAL,
    rating_count    INTEGER,
    rating_1star    INTEGER,
    rating_2star    INTEGER,
    rating_3star    INTEGER,
    rating_4star    INTEGER,
    rating_5star    INTEGER,
    error           TEXT
);

CREATE TABLE IF NOT EXISTS review_tags (
    iherb_id       INTEGER NOT NULL,
    tag_name       TEXT NOT NULL,
    tag_count      INTEGER NOT NULL DEFAULT 0,
    tag_class      INTEGER NOT NULL DEFAULT 0,
    tag_order      INTEGER NOT NULL,
    PRIMARY KEY (iherb_id, tag_name),
    FOREIGN KEY (iherb_id) REFERENCES review_summaries(iherb_id)
);

CREATE TABLE IF NOT EXISTS _metadata (
    key   TEXT PRIMARY KEY,
    value TEXT
);
`;

export class SummariesDB {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);

    // Prepared statements
    this._upsertFull = this.db.prepare(`
      INSERT INTO review_summaries
        (iherb_id, summary_text, scraped_at, final_url,
         rating_avg, rating_count, rating_1star, rating_2star, rating_3star, rating_4star, rating_5star,
         error)
      VALUES
        (@iherb_id, @summary_text, @scraped_at, @final_url,
         @rating_avg, @rating_count, @rating_1star, @rating_2star, @rating_3star, @rating_4star, @rating_5star,
         @error)
      ON CONFLICT(iherb_id) DO UPDATE SET
        summary_text = COALESCE(excluded.summary_text, summary_text),
        scraped_at   = excluded.scraped_at,
        final_url    = COALESCE(excluded.final_url, final_url),
        rating_avg   = COALESCE(excluded.rating_avg, rating_avg),
        rating_count = COALESCE(excluded.rating_count, rating_count),
        rating_1star = COALESCE(excluded.rating_1star, rating_1star),
        rating_2star = COALESCE(excluded.rating_2star, rating_2star),
        rating_3star = COALESCE(excluded.rating_3star, rating_3star),
        rating_4star = COALESCE(excluded.rating_4star, rating_4star),
        rating_5star = COALESCE(excluded.rating_5star, rating_5star),
        error        = excluded.error
    `);

    this._upsertSummaryOnly = this.db.prepare(`
      INSERT INTO review_summaries (iherb_id, summary_text, scraped_at, final_url, error)
      VALUES (@iherb_id, @summary_text, @scraped_at, @final_url, @error)
      ON CONFLICT(iherb_id) DO UPDATE SET
        summary_text = COALESCE(excluded.summary_text, summary_text),
        scraped_at   = excluded.scraped_at,
        final_url    = COALESCE(excluded.final_url, final_url),
        error        = excluded.error
    `);

    this._upsertRating = this.db.prepare(`
      INSERT INTO review_summaries
        (iherb_id, scraped_at, rating_avg, rating_count,
         rating_1star, rating_2star, rating_3star, rating_4star, rating_5star)
      VALUES
        (@iherb_id, @scraped_at, @rating_avg, @rating_count,
         @rating_1star, @rating_2star, @rating_3star, @rating_4star, @rating_5star)
      ON CONFLICT(iherb_id) DO UPDATE SET
        rating_avg   = excluded.rating_avg,
        rating_count = excluded.rating_count,
        rating_1star = excluded.rating_1star,
        rating_2star = excluded.rating_2star,
        rating_3star = excluded.rating_3star,
        rating_4star = excluded.rating_4star,
        rating_5star = excluded.rating_5star
    `);

    this._deleteTags = this.db.prepare("DELETE FROM review_tags WHERE iherb_id = ?");
    this._insertTag = this.db.prepare(
      "INSERT OR IGNORE INTO review_tags (iherb_id, tag_name, tag_count, tag_class, tag_order) VALUES (?, ?, ?, ?, ?)"
    );
  }

  /** Save a full scrape result (summary + tags). */
  saveResult(entry) {
    const txn = this.db.transaction(() => {
      this._upsertSummaryOnly.run({
        iherb_id: entry.productId,
        summary_text: entry.summary || null,
        scraped_at: entry.scrapedAt || new Date().toISOString(),
        final_url: entry.url || null,
        error: entry.error || null,
      });
      if (entry.tags && entry.tags.length > 0) {
        this._deleteTags.run(entry.productId);
        for (let i = 0; i < entry.tags.length; i++) {
          const tag = entry.tags[i];
          const name = typeof tag === "string" ? tag : tag.name;
          const count = tag.count ?? 0;
          const cls = tag.classification ?? 0;
          this._insertTag.run(entry.productId, name, count, cls, i);
        }
      }
    });
    txn();
  }

  /** Save tags only (from API fetch). */
  saveTags(productId, tags, scrapedAt) {
    const txn = this.db.transaction(() => {
      // Ensure row exists
      this.db.prepare(
        "INSERT OR IGNORE INTO review_summaries (iherb_id, scraped_at) VALUES (?, ?)"
      ).run(productId, scrapedAt || new Date().toISOString());

      this._deleteTags.run(productId);
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        this._insertTag.run(productId, t.name, t.count ?? 0, t.classification ?? 0, i);
      }
    });
    txn();
  }

  /** Save rating only (from API fetch). */
  saveRating(productId, rating, scrapedAt) {
    this._upsertRating.run({
      iherb_id: productId,
      scraped_at: scrapedAt || new Date().toISOString(),
      rating_avg: rating.averageRating ?? null,
      rating_count: rating.count ?? null,
      rating_1star: rating.distribution?.oneStar ?? rating.oneStar?.count ?? null,
      rating_2star: rating.distribution?.twoStar ?? rating.twoStar?.count ?? null,
      rating_3star: rating.distribution?.threeStar ?? rating.threeStar?.count ?? null,
      rating_4star: rating.distribution?.fourStar ?? rating.fourStar?.count ?? null,
      rating_5star: rating.distribution?.fiveStar ?? rating.fiveStar?.count ?? null,
    });
  }

  /** Save error for a product. */
  saveError(productId, errorMsg) {
    this.db.prepare(
      "INSERT INTO review_summaries (iherb_id, scraped_at, error) VALUES (?, ?, ?) ON CONFLICT(iherb_id) DO UPDATE SET error = excluded.error"
    ).run(productId, new Date().toISOString(), errorMsg);
  }

  /** Return Set of product IDs with successful summary. */
  getScrapedIds() {
    const rows = this.db.prepare(
      "SELECT iherb_id FROM review_summaries WHERE summary_text IS NOT NULL AND error IS NULL"
    ).all();
    return new Set(rows.map((r) => r.iherb_id));
  }

  /** Return Set of product IDs that have tags. */
  getTaggedIds() {
    const rows = this.db.prepare("SELECT DISTINCT iherb_id FROM review_tags").all();
    return new Set(rows.map((r) => r.iherb_id));
  }

  /** Return Set of product IDs that have ratings. */
  getRatedIds() {
    const rows = this.db.prepare(
      "SELECT iherb_id FROM review_summaries WHERE rating_avg IS NOT NULL"
    ).all();
    return new Set(rows.map((r) => r.iherb_id));
  }

  /** Return Set of all product IDs (including errors). */
  getAllIds() {
    const rows = this.db.prepare("SELECT iherb_id FROM review_summaries").all();
    return new Set(rows.map((r) => r.iherb_id));
  }

  /** Return stats. */
  stats() {
    const total = this.db.prepare("SELECT COUNT(*) as n FROM review_summaries").get().n;
    const withSummary = this.db.prepare(
      "SELECT COUNT(*) as n FROM review_summaries WHERE summary_text IS NOT NULL AND error IS NULL"
    ).get().n;
    const withTags = this.db.prepare("SELECT COUNT(DISTINCT iherb_id) as n FROM review_tags").get().n;
    const withRating = this.db.prepare(
      "SELECT COUNT(*) as n FROM review_summaries WHERE rating_avg IS NOT NULL"
    ).get().n;
    const errors = this.db.prepare(
      "SELECT COUNT(*) as n FROM review_summaries WHERE error IS NOT NULL"
    ).get().n;
    return { total, withSummary, withTags, withRating, errors };
  }

  close() {
    this.db.close();
  }
}
