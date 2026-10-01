import { readFileSync } from "node:fs";

import { DEFAULT_LIMITS } from "../store.mjs";
import { INGEST_ERROR, IngestError } from "../result.mjs";

function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").replace(/\s+$/, "") + "\n";
}

function fenced(label, text) {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return `${fence}${label}\n${text}\n${fence}\n`;
}

export const textProcessor = Object.freeze({
  id: "text/deterministic",
  accepts(metadata) {
    return metadata.sourceKind === "text";
  },
  async probe() {
    return { available: true, mode: "local-deterministic" };
  },
  async process(input, context = {}) {
    const maxBytes = context.limits?.maxNormalizedBytes ?? DEFAULT_LIMITS.maxNormalizedBytes;
    const raw = readFileSync(input.blobPath);
    if (raw.byteLength > maxBytes)
      throw new IngestError(INGEST_ERROR.NORMALIZATION_FAILED, `Normalized text exceeds the configured ${maxBytes}-byte limit.`);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new IngestError(INGEST_ERROR.INVALID_SOURCE, "The retained source is not valid UTF-8 text.");
    }

    const format = input.metadata.textFormat ?? "plain";
    let content;
    if (format === "markdown") content = normalizeNewlines(text);
    else if (format === "json") {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new IngestError(INGEST_ERROR.INVALID_SOURCE, "The source was identified as JSON but does not parse as JSON.");
      }
      content = fenced("json", JSON.stringify(parsed, null, 2));
    } else if (["yaml", "csv", "tsv", "html"].includes(format)) content = fenced(format, normalizeNewlines(text).trimEnd());
    else content = normalizeNewlines(text);

    return {
      sourceKind: "text",
      format: "markdown",
      filename: "content.md",
      content,
      processor: { id: "text/deterministic" },
    };
  },
});
