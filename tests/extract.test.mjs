import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractSummary, SUMMARY_RE, FALLBACK_RE } from "../scripts/lib/extract.mjs";

// Helper: generate padding text of a given length
const pad = (n) => "x".repeat(n);

describe("extractSummary", () => {
  it("matches 'Customers generally ...' pattern", () => {
    const text = `Customers generally praise this product for its high quality and effectiveness. ${pad(80)}`;
    const result = extractSummary(text);
    assert.ok(result);
    assert.ok(result.startsWith("Customers generally"));
  });

  it("matches 'Customers often ...' pattern", () => {
    const text = `Customers often recommend this supplement for daily use and report positive results. ${pad(80)}`;
    const result = extractSummary(text);
    assert.ok(result);
    assert.ok(result.startsWith("Customers often"));
  });

  it("matches 'Customers highly ...' pattern", () => {
    const text = `Customers highly recommend this vitamin for its bioavailability and absorption rate in the body. ${pad(80)}`;
    const result = extractSummary(text);
    assert.ok(result);
    assert.ok(result.startsWith("Customers highly"));
  });

  it("matches 'Customers are very satisfied ...' compound pattern", () => {
    const text = `Customers are very satisfied with the taste and texture of this protein powder and recommend it to others. ${pad(80)}`;
    const result = extractSummary(text);
    assert.ok(result);
    assert.ok(result.startsWith("Customers are very"));
  });

  it("matches singular 'Customer' form", () => {
    const text = `Customer generally reports positive outcomes after using this product consistently for several weeks of daily use. ${pad(80)}`;
    const result = extractSummary(text);
    assert.ok(result);
    assert.ok(result.startsWith("Customer generally"));
  });

  it("truncates at 'Review highlights'", () => {
    const body = pad(100);
    const text = `Customers generally love this product. ${body} Review highlights No fishy taste Easy swallow`;
    const result = extractSummary(text);
    assert.ok(result);
    assert.ok(!result.includes("Review highlights"));
    assert.ok(!result.includes("No fishy taste"));
  });

  it("uses fallback 'What customers say' pattern", () => {
    const body = pad(100);
    const text = `What customers say ${body} Review highlights tags here`;
    const result = extractSummary(text);
    assert.ok(result);
    assert.ok(!result.includes("Review highlights"));
  });

  it("returns null when no match", () => {
    const text = "This is a random product description with no customer summary at all.";
    const result = extractSummary(text);
    assert.equal(result, null);
  });

  it("returns null for short matches (< 80 chars)", () => {
    // The SUMMARY_RE requires 80+ chars after the keyword phrase via {80,}
    const text = "Customers generally like it. Short.";
    const result = extractSummary(text);
    assert.equal(result, null);
  });

  it("returns null for null/undefined input", () => {
    assert.equal(extractSummary(null), null);
    assert.equal(extractSummary(undefined), null);
    assert.equal(extractSummary(""), null);
  });

  it("matches 'Customers love ...' pattern", () => {
    const text = `Customers love this product for its amazing taste and the fact that it dissolves easily in water without any clumps. ${pad(80)}`;
    const result = extractSummary(text);
    assert.ok(result);
    assert.ok(result.startsWith("Customers love"));
  });

  it("matches 'Customers appreciate ...' pattern", () => {
    const text = `Customers appreciate the quality ingredients and the value for money that this supplement provides compared to other brands. ${pad(80)}`;
    const result = extractSummary(text);
    assert.ok(result);
    assert.ok(result.startsWith("Customers appreciate"));
  });

  it("accepts custom regex parameters", () => {
    const customSummary = /CUSTOM_START\s+[\s\S]{80,}/i;
    const customFallback = /FALLBACK\s+([\s\S]{80,})/i;
    const text = `CUSTOM_START ${pad(100)}`;
    const result = extractSummary(text, customSummary, customFallback);
    assert.ok(result);
  });
});
