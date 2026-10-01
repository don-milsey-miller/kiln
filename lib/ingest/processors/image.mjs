import { INGEST_ERROR, IngestError } from "../result.mjs";
import { unavailableExtractionProvider } from "../providers/openai-extraction.mjs";

export function createImageProcessor(options = {}) {
  const provider = options.provider ?? unavailableExtractionProvider;
  return Object.freeze({
    id: `image/${provider.id}`,
    accepts(metadata) {
      return metadata.sourceKind === "image";
    },
    async probe(context = {}) {
      const capability = await provider.probe(context);
      return { ...capability, providerId: provider.id };
    },
    async process(input, context = {}) {
      const configuredLimit = context.limits?.maxRemoteMediaBytes;
      const capabilityLimit = context.capability?.maxBytes;
      const maxBytes = Math.min(
        Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : Number.MAX_SAFE_INTEGER,
        Number.isSafeInteger(capabilityLimit) && capabilityLimit > 0 ? capabilityLimit : Number.MAX_SAFE_INTEGER
      );
      if (input.metadata.bytes > maxBytes)
        throw new IngestError(INGEST_ERROR.FILE_TOO_LARGE, `Image extraction is limited to ${maxBytes} bytes.`, { limit: maxBytes });
      const timeoutMs = context.limits?.processingTimeoutMs;
      const extracted = await provider.extract({
        blobPath: input.blobPath,
        bytes: input.metadata.bytes,
        mediaType: input.metadata.mediaType,
        filename: input.job.origin.filename,
        sourceKind: "image",
      }, {
        maxBytes,
        signal: Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      const markdown = extracted.markdown.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
      if (!markdown) throw new IngestError(INGEST_ERROR.NORMALIZATION_FAILED, "The image extraction is empty.");
      return {
        sourceKind: "image",
        format: "markdown",
        filename: "extracted.md",
        content: `# Extracted image content\n\n${markdown}\n`,
        processor: {
          id: `image/${provider.id}`,
          ...(extracted.provider ? { provider: extracted.provider } : {}),
          ...(extracted.model ? { model: extracted.model } : {}),
        },
      };
    },
  });
}
