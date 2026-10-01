import { INGEST_ERROR, IngestError } from "../result.mjs";
import { unavailableTranscriptionProvider } from "../providers/openai-transcription.mjs";

function normalizeTranscript(text) {
  const body = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  if (!body) throw new IngestError(INGEST_ERROR.NORMALIZATION_FAILED, "The transcript is empty.");
  return `# Transcript\n\n${body}\n`;
}

export function createAudioProcessor(options = {}) {
  const provider = options.provider ?? unavailableTranscriptionProvider;
  return Object.freeze({
    id: `audio/${provider.id}`,
    accepts(metadata) {
      return metadata.sourceKind === "audio";
    },
    async probe(context = {}) {
      const capability = await provider.probe(context);
      return { ...capability, providerId: provider.id };
    },
    async process(input, context = {}) {
      const configuredLimit = context.limits?.maxRemoteAudioBytes;
      const capabilityLimit = context.capability?.maxBytes;
      const maxBytes = Math.min(
        Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : Number.MAX_SAFE_INTEGER,
        Number.isSafeInteger(capabilityLimit) && capabilityLimit > 0 ? capabilityLimit : Number.MAX_SAFE_INTEGER
      );
      if (input.metadata.bytes > maxBytes)
        throw new IngestError(INGEST_ERROR.FILE_TOO_LARGE, `Audio transcription is limited to ${maxBytes} bytes.`, { limit: maxBytes });
      const timeoutMs = context.limits?.processingTimeoutMs;
      const signal = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const transcript = await provider.transcribe(
        {
          blobPath: input.blobPath,
          bytes: input.metadata.bytes,
          mediaType: input.metadata.mediaType,
          filename: input.job.origin.filename,
        },
        { maxBytes, signal }
      );
      return {
        sourceKind: "audio",
        format: "markdown",
        filename: "transcript.md",
        content: normalizeTranscript(transcript.text),
        processor: {
          id: `audio/${provider.id}`,
          ...(transcript.provider ? { provider: transcript.provider } : {}),
          ...(transcript.model ? { model: transcript.model } : {}),
        },
      };
    },
  });
}
