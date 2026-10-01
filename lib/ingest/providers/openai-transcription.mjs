import { readFileSync } from "node:fs";

import { INGEST_ERROR, IngestError } from "../result.mjs";

export const OPENAI_TRANSCRIPTION_MODEL = "gpt-transcribe";
export const OPENAI_TRANSCRIPTION_LIMIT = 25_000_000;

const MIME_EXTENSIONS = Object.freeze({
  "audio/flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
});

function apiFilename(filename, mediaType) {
  const clean = String(filename ?? "audio").replace(/[\r\n\0"]/g, "").slice(0, 200) || "audio";
  return /\.[A-Za-z0-9]{1,8}$/.test(clean) ? clean : `${clean}${MIME_EXTENSIONS[mediaType] ?? ".audio"}`;
}

function unavailable(reason) {
  return Object.freeze({
    id: "transcription/unavailable",
    async probe() {
      return { available: false, mode: "remote", reason };
    },
    async transcribe() {
      throw new IngestError(INGEST_ERROR.PROCESSOR_UNAVAILABLE, "Remote transcription is not available.");
    },
  });
}

export function createOpenAITranscriptionProvider(options = {}) {
  const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  const authorized = options.authorized === true;
  if (!authorized) return unavailable("remote-processing-not-authorized");
  if (!apiKey) return unavailable("api-key-not-configured");

  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") return unavailable("fetch-unavailable");
  const model = options.model ?? OPENAI_TRANSCRIPTION_MODEL;
  const endpoint = options.endpoint ?? "https://api.openai.com/v1/audio/transcriptions";

  return Object.freeze({
    id: "transcription/openai",
    async probe() {
      return { available: true, mode: "remote", provider: "openai", model, maxBytes: OPENAI_TRANSCRIPTION_LIMIT };
    },
    async transcribe(input, context = {}) {
      const limit = context.maxBytes ?? OPENAI_TRANSCRIPTION_LIMIT;
      if (input.bytes > limit)
        throw new IngestError(INGEST_ERROR.FILE_TOO_LARGE, `Audio transcription is limited to ${limit} bytes.`, { limit });

      const form = new FormData();
      const bytes = readFileSync(input.blobPath);
      form.append("file", new Blob([bytes], { type: input.mediaType }), apiFilename(input.filename, input.mediaType));
      form.append("model", model);
      form.append("response_format", "json");

      let response;
      try {
        response = await fetchFn(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: context.signal,
        });
      } catch (cause) {
        throw new IngestError(INGEST_ERROR.EXTERNAL_PROVIDER_FAILED, "The transcription provider request failed.", {
          cause: cause?.name === "AbortError" || cause?.name === "TimeoutError" ? "timeout" : "network-error",
        });
      }

      if (!response.ok) {
        const code = response.status >= 400 && response.status < 500
          ? INGEST_ERROR.EXTERNAL_PROVIDER_REFUSED
          : INGEST_ERROR.EXTERNAL_PROVIDER_FAILED;
        throw new IngestError(code, "The transcription provider did not accept the request.", { status: response.status });
      }

      let body;
      try {
        body = await response.json();
      } catch {
        throw new IngestError(INGEST_ERROR.EXTERNAL_PROVIDER_FAILED, "The transcription provider returned an invalid response.");
      }
      if (typeof body?.text !== "string" || !body.text.trim())
        throw new IngestError(INGEST_ERROR.EXTERNAL_PROVIDER_FAILED, "The transcription provider returned no transcript.");
      return { text: body.text, provider: "openai", model };
    },
  });
}

export function createOpenAITranscriptionProviderFromEnv(env = process.env, options = {}) {
  return createOpenAITranscriptionProvider({
    ...options,
    apiKey: env.OPENAI_API_KEY,
    authorized: env.KILN_INGEST_REMOTE_PROCESSING === "allow",
    model: env.KILN_OPENAI_TRANSCRIPTION_MODEL || options.model,
  });
}

export const unavailableTranscriptionProvider = unavailable("provider-not-configured");
