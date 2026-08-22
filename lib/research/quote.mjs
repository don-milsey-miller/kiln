/**
 * Is this sentence actually on that page?
 *
 * ⚠️ **The single most valuable check in the research capability.** A citation for text that is not
 * on the page is worse than no citation: it is #67's plausible prose with a URL attached, and the URL
 * makes it *more* convincing than the prose was. Everything else here — the probe, the boundary, the
 * refusals — protects the process; this protects the CONTENT.
 *
 * ⚠️ **Deliberately crude, and it says so rather than pretending.** Tags are stripped, entities are
 * partially decoded, whitespace is flattened. It is enough to confirm a quote appears; it is not an
 * HTML parser and must not be described as one. What it can produce is a false NEGATIVE on an
 * awkwardly-marked-up page — which fails safe, by refusing to record.
 */

/** Strip markup crudely. Script and style content is removed, not flattened: it is not page text. */
export function visibleText(html) {
  return String(html ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export const flatten = (t) => String(t ?? "").replace(/\s+/g, " ").trim();

/**
 * Whitespace-insensitive containment. HTML wraps lines wherever it likes, and a quote failing only
 * because the page had a newline in it would push a user toward pasting less exact text — which
 * defeats the check by making it annoying.
 */
export function quoteIsPresent(html, quote) {
  const needle = flatten(quote);
  if (!needle) return false;
  return flatten(visibleText(html)).includes(needle);
}

export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ""));
  return m ? flatten(m[1]) : null;
}
