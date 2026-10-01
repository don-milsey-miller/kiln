import "server-only";

import { resolveContentRoot } from "../../lib/content-root.mjs";
import { createIngestService } from "../../lib/ingest/service.mjs";
import { createInboxWatcher } from "../../lib/ingest/watch.mjs";
import { createOpenAITranscriptionProviderFromEnv } from "../../lib/ingest/providers/openai-transcription.mjs";
import { createOpenAIExtractionProviderFromEnv } from "../../lib/ingest/providers/openai-extraction.mjs";
import { ingestLimitsFromEnv } from "../../lib/ingest/store.mjs";

let current = null;

function runtime() {
  const contentRoot = resolveContentRoot();
  if (current?.contentRoot === contentRoot) return current;
  const extractionProvider = createOpenAIExtractionProviderFromEnv();
  const service = createIngestService({
    contentRoot,
    transcriptionProvider: createOpenAITranscriptionProviderFromEnv(),
    extractionProvider,
    limits: ingestLimitsFromEnv(),
  });
  const watcher = createInboxWatcher(service, { contentRoot }).catch(() => null);
  current = { contentRoot, service, watcher };
  return current;
}

/** The browser's complete ingestion write capability: bytes, portable metadata, and no destination. */
export async function enqueueSource(input) {
  return runtime().service.enqueue(input);
}

export function getIngestJob(jobId) {
  return runtime().service.getJob(jobId);
}

export function listIngestJobs() {
  return runtime().service.listJobs();
}

export function ingestUploadLimit() {
  return runtime().service.limits.maxUploadBytes;
}
