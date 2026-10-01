import { readFileSync } from "node:fs";
import { getDocument, version as pdfjsVersion } from "pdfjs-dist/legacy/build/pdf.mjs";

import { INGEST_ERROR, IngestError } from "../result.mjs";
import { unavailableExtractionProvider } from "../providers/openai-extraction.mjs";

const MIN_USEFUL_CHARACTERS = 32;

function pageText(items) {
  const lines = [];
  let line = "";
  for (const item of items) {
    if (typeof item?.str !== "string") continue;
    const text = item.str.replace(/\u0000/g, "").trim();
    if (text) line += `${line ? " " : ""}${text}`;
    if (item.hasEOL && line) {
      lines.push(line);
      line = "";
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

async function embeddedText(path, maxPages) {
  const loading = getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: true });
  let document;
  try {
    document = await loading.promise;
    if (document.numPages > maxPages)
      throw new IngestError(INGEST_ERROR.FILE_TOO_LARGE, `The PDF exceeds the configured ${maxPages}-page limit.`, { limit: maxPages });
    const pages = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        pages.push(pageText(content.items));
      } finally {
        page.cleanup();
      }
    }
    return { pages, count: document.numPages };
  } catch (cause) {
    if (cause instanceof IngestError) throw cause;
    throw new IngestError(INGEST_ERROR.INVALID_SOURCE, "The retained PDF could not be parsed.");
  } finally {
    await loading.destroy().catch(() => {});
  }
}

function localMarkdown(pages) {
  return `# Extracted document\n\n${pages.map((text, index) => `## Page ${index + 1}\n\n${text}`).join("\n\n")}\n`;
}

function remoteMarkdown(markdown) {
  return `# Extracted document\n\n${markdown.replace(/\r\n?/g, "\n").trim()}\n`;
}

export function createPdfProcessor(options = {}) {
  const fallback = options.fallbackProvider ?? unavailableExtractionProvider;
  return Object.freeze({
    id: "document/pdf",
    accepts(metadata) {
      return metadata.sourceKind === "document" && metadata.mediaType === "application/pdf";
    },
    async probe() {
      return { available: true, mode: "local-deterministic", fallbackProviderId: fallback.id };
    },
    async process(input, context = {}) {
      const maxPages = context.limits?.maxPdfPages ?? 200;
      const extracted = await embeddedText(input.blobPath, maxPages);
      const useful = extracted.pages.join("").replace(/\s/g, "").length;
      if (useful >= MIN_USEFUL_CHARACTERS) {
        return {
          sourceKind: "document",
          format: "markdown",
          filename: "extracted.md",
          content: localMarkdown(extracted.pages),
          processor: { id: "document/pdfjs", provider: "pdfjs", model: pdfjsVersion },
        };
      }

      const capability = await fallback.probe(context);
      if (capability?.available !== true)
        throw new IngestError(INGEST_ERROR.PROCESSOR_UNAVAILABLE, "The PDF has insufficient embedded text and no authorized fallback extractor is available.", {
          reason: capability?.reason ?? "fallback-unavailable",
        });
      const configuredLimit = context.limits?.maxRemoteMediaBytes;
      const maxBytes = Math.min(
        Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : Number.MAX_SAFE_INTEGER,
        Number.isSafeInteger(capability.maxBytes) && capability.maxBytes > 0 ? capability.maxBytes : Number.MAX_SAFE_INTEGER
      );
      const timeoutMs = context.limits?.processingTimeoutMs;
      const remote = await fallback.extract({
        blobPath: input.blobPath,
        bytes: input.metadata.bytes,
        mediaType: input.metadata.mediaType,
        filename: input.job.origin.filename,
        sourceKind: "document",
      }, {
        maxBytes,
        signal: Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      return {
        sourceKind: "document",
        format: "markdown",
        filename: "extracted.md",
        content: remoteMarkdown(remote.markdown),
        processor: {
          id: `document/${fallback.id}`,
          ...(remote.provider ? { provider: remote.provider } : {}),
          ...(remote.model ? { model: remote.model } : {}),
        },
      };
    },
  });
}
