// Shared regex patterns and extraction logic for AI review summaries.
// These patterns are the single source of truth — scrape.mjs passes them
// as strings into page.evaluate() and reconstructs RegExp in browser context.

export const SUMMARY_PATTERN = String.raw`Customers?\s+(?:generally|often|frequently|commonly|love|praise|appreciate|highly|report|find|enjoy|rave|recommend|are\s+(?:very|highly|mostly|overall))\b[\s\S]{80,}?(?=Review highlights|$)`;

export const FALLBACK_PATTERN = String.raw`What customers say\s*([\s\S]{80,}?)(?=Review highlights)`;

export const SUMMARY_RE = new RegExp(SUMMARY_PATTERN, "i");
export const FALLBACK_RE = new RegExp(FALLBACK_PATTERN, "i");

/**
 * Extract AI summary text from a block of text.
 * @param {string} text - The text to search
 * @param {RegExp} [summaryRe] - Primary regex
 * @param {RegExp} [fallbackRe] - Fallback regex
 * @returns {string|null}
 */
export function extractSummary(text, summaryRe = SUMMARY_RE, fallbackRe = FALLBACK_RE) {
  if (!text || typeof text !== "string") return null;

  const m = text.match(summaryRe);
  if (m) {
    const result = m[0].trim();
    return result.length >= 80 ? result : null;
  }

  const between = text.match(fallbackRe);
  if (between) {
    const result = between[1].trim();
    return result.length >= 80 ? result : null;
  }

  return null;
}
