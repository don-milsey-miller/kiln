import "server-only";

import { resolveContentRoot, resolveProjectRoot } from "../../lib/content-root.mjs";
import { createIngestService } from "../../lib/ingest/service.mjs";
import { createInboxWatcher } from "../../lib/ingest/watch.mjs";
import { createOpenAITranscriptionProviderFromEnv } from "../../lib/ingest/providers/openai-transcription.mjs";
import { createOpenAIExtractionProviderFromEnv } from "../../lib/ingest/providers/openai-extraction.mjs";
import { ingestLimitsFromEnv } from "../../lib/ingest/store.mjs";
import { CREDENTIAL_SERVICE } from "../../lib/connection-services.mjs";
import { runtimeCredentialEnv } from "../../lib/credential-broker.mjs";
import { connectionPermission } from "../../lib/setup-connections.mjs";
import { STATE_MODE } from "../../lib/local-state.mjs";
import { PROJECT_ROOT_ENV, STATE_MODE_ENV } from "../../lib/research/permission.mjs";

let current = null;

async function runtime() {
  const contentRoot = resolveContentRoot();
  if (current?.contentRoot === contentRoot) return current;
  const projectRoot = process.env[PROJECT_ROOT_ENV] ?? resolveProjectRoot();
  const sourcePermission = connectionPermission({
    projectRoot,
    stateMode: process.env[STATE_MODE_ENV] ?? STATE_MODE.PROJECT,
    service: CREDENTIAL_SERVICE.OPENAI_SOURCE,
  });
  const credentialEnv = sourcePermission.permitted
    ? await runtimeCredentialEnv(CREDENTIAL_SERVICE.OPENAI_SOURCE)
    : process.env;
  const sourceEnv = {
    ...credentialEnv,
    KILN_INGEST_REMOTE_PROCESSING: sourcePermission.permitted ? "allow" : "deny",
    ...(sourcePermission.permitted && sourcePermission.choice.extractionModel
      ? { KILN_OPENAI_EXTRACTION_MODEL: sourcePermission.choice.extractionModel }
      : {}),
  };
  const extractionProvider = createOpenAIExtractionProviderFromEnv(sourceEnv);
  const service = createIngestService({
    contentRoot,
    transcriptionProvider: createOpenAITranscriptionProviderFromEnv(sourceEnv),
    extractionProvider,
    limits: ingestLimitsFromEnv(),
  });
  const watcher = createInboxWatcher(service, { contentRoot }).catch(() => null);
  current = { contentRoot, service, watcher };
  return current;
}

/** The browser's complete ingestion write capability: bytes, portable metadata, and no destination. */
export async function enqueueSource(input) {
  return (await runtime()).service.enqueue(input);
}

export async function getIngestJob(jobId) {
  return (await runtime()).service.getJob(jobId);
}

export async function listIngestJobs() {
  return (await runtime()).service.listJobs();
}

export async function ingestUploadLimit() {
  return (await runtime()).service.limits.maxUploadBytes;
}
