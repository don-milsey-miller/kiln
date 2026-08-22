/**
 * The quote check — the guard that protects the CONTENT rather than the process.
 *
 * ⚠️ It exists because a citation for a sentence that is not on the page is worse than no citation:
 * the URL makes the invented claim *more* convincing, not less. Every test here is a way that could
 * go wrong.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteIsPresent, visibleText, extractTitle, flatten } from "../lib/research/quote.mjs";

const PAGE = `<!doctype html><html><head><title>  Pricing
  and limits </title></head><body>
  <p>The free plan includes
     1,000 API credits per month.</p>
  <script>var hidden = "credits are unlimited";</script>
  <style>.x { content: "also not page text"; }</style>
  <p>Rate limits &amp; quotas apply.</p>
</body></html>`;

test("a quote that is on the page is found, across line wrapping", () => {
  assert.equal(quoteIsPresent(PAGE, "The free plan includes 1,000 API credits per month."), true);
  assert.equal(quoteIsPresent(PAGE, "free plan includes\n1,000 API credits"), true, "the user's own wrapping must not matter");
});

test("a quote that is NOT on the page is refused", () => {
  assert.equal(quoteIsPresent(PAGE, "The free plan includes 5,000 API credits per month."), false);
  assert.equal(quoteIsPresent(PAGE, "anything at all"), false);
});

test("script and style content is not page text", () => {
  // ⚠️ The sharp case: a page could be cited for a sentence that only exists in a script string.
  assert.equal(quoteIsPresent(PAGE, "credits are unlimited"), false);
  assert.equal(quoteIsPresent(PAGE, "also not page text"), false);
});

test("entities are decoded, so a visible sentence is quotable as it reads", () => {
  assert.equal(quoteIsPresent(PAGE, "Rate limits & quotas apply."), true);
});

test("an empty or whitespace quote is refused rather than trivially satisfied", () => {
  // `"".includes()` is true for every string: without this, omitting the quote would pass the check.
  assert.equal(quoteIsPresent(PAGE, ""), false);
  assert.equal(quoteIsPresent(PAGE, "   \n  "), false);
  assert.equal(quoteIsPresent(PAGE, undefined), false);
});

test("markup between words does not break a real quote", () => {
  const html = "<p>The <em>free</em> plan <b>stops</b> at the limit.</p>";
  assert.equal(quoteIsPresent(html, "The free plan stops at the limit."), true);
});

test("visibleText and extractTitle do the small jobs they claim", () => {
  assert.equal(flatten(visibleText("<p>a</p>\n<p>b</p>")), "a b");
  assert.equal(extractTitle(PAGE), "Pricing and limits");
  assert.equal(extractTitle("<html><body>no title</body></html>"), null);
});
