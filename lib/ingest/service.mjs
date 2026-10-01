import { readActivatedTypes } from "../activation.mjs";
import { resolveContentRoot } from "../content-root.mjs";
import { inspectFile } from "./inspect.mjs";
import { textProcessor } from "./processors/text.mjs";
import { createProcessorRegistry } from "./registry.mjs";
import { createSourceFromNormalized } from "./source.mjs";
import {
  DEFAULT_LIMITS,
  blobPath,
  listJobs,
  newJobId,
  readJob,
  safeFilename,
  storeBlob,
  writeJob,
} from "./store.mjs";
import { INGEST_ERROR, JOB_STATE, IngestError, publicJob } from "./result.mjs";

const RELATIONSHIPS = new Set(["project-manager-input", "external-reference"]);
const ORIGINS = new Set(["upload", "inbox"]);

function now(clock) {
  return new Date(clock()).toISOString();
}

function diagnostic(error) {
  return String(error?.message ?? error ?? "Unknown ingestion failure").replace(/[\r\n]+/g, " ").slice(0, 2000);
}

function classify(error) {
  if (error instanceof IngestError) return error;
  return new IngestError(INGEST_ERROR.PROCESSING_FAILED, "The processor failed.", { cause: diagnostic(error) });
}

export function createIngestService(opts = {}) {
  const contentRoot = opts.contentRoot ?? resolveContentRoot(opts.env);
  const registry = opts.registry ?? createProcessorRegistry([textProcessor]);
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const clock = opts.clock ?? Date.now;
  const schedule = opts.schedule ?? ((task) => setImmediate(task));

  const jobOptions = { contentRoot };

  async function mutate(job, changes) {
    const updated = { ...job, ...changes, updatedAt: now(clock) };
    await writeJob(updated, jobOptions);
    return updated;
  }

  async function enqueue({ source, filename, relationship, origin = "upload", mediaType = null, maxBytes } = {}, enqueueOpts = {}) {
    if (!RELATIONSHIPS.has(relationship))
      throw new IngestError(INGEST_ERROR.INVALID_SOURCE, "Source relationship must be project-manager-input or external-reference.");
    if (!ORIGINS.has(origin)) throw new IngestError(INGEST_ERROR.INVALID_SOURCE, "Source origin must be upload or inbox.");
    const cleanName = safeFilename(filename);
    const stored = await storeBlob(source, {
      contentRoot,
      maxBytes: maxBytes ?? (origin === "inbox" ? limits.maxInboxBytes : limits.maxUploadBytes),
    });
    const created = now(clock);
    const job = {
      version: 1,
      jobId: newJobId(),
      blob: `sha256:${stored.sha256}`,
      state: JOB_STATE.QUEUED,
      stage: "queued",
      attempt: 0,
      relationship,
      origin: { kind: origin, filename: cleanName },
      intake: { bytes: stored.bytes, claimedMediaType: typeof mediaType === "string" ? mediaType : null },
      createdAt: created,
      updatedAt: created,
    };
    await writeJob(job, jobOptions);
    if (enqueueOpts.process !== false) schedule(() => void processJob(job.jobId));
    return { job: publicJob(job), blob: { sha256: stored.sha256, bytes: stored.bytes, deduplicated: stored.deduplicated } };
  }

  async function processJob(jobId) {
    let job = readJob(jobId, jobOptions);
    if (!job) throw new IngestError(INGEST_ERROR.INVALID_SOURCE, "No such ingestion job.");
    if (job.state === JOB_STATE.COMPLETED) return publicJob(job);
    const sha256 = String(job.blob ?? "").replace(/^sha256:/, "");
    const retained = blobPath(sha256, jobOptions);

    try {
      job = await mutate(job, {
        state: JOB_STATE.INSPECTING,
        stage: "inspecting",
        attempt: (job.attempt ?? 0) + 1,
        error: undefined,
      });
      const metadata = inspectFile(retained, { filename: job.origin.filename });
      job = await mutate(job, {
        metadata: { ...metadata, sha256 },
        stage: "selecting-processor",
      });

      const selected = await registry.select(metadata, { limits, contentRoot, job });
      job = await mutate(job, {
        state: JOB_STATE.PROCESSING,
        stage: "normalizing",
        processor: selected.processor.id,
        capability: selected.probe,
      });
      const normalized = await selected.processor.process(
        { blobPath: retained, metadata, job },
        { limits, contentRoot, job, capability: selected.probe }
      );

      if (!readActivatedTypes(contentRoot).includes("source"))
        throw new IngestError(
          INGEST_ERROR.SOURCE_NOT_ACTIVATED,
          "The source artifact type is not activated for this project. The raw source remains retained locally."
        );

      job = await mutate(job, { stage: "creating-source" });
      const title = job.origin.filename.replace(/\.[^.]+$/, "") || job.origin.filename;
      const created = await createSourceFromNormalized(
        {
          title,
          sourceKind: normalized.sourceKind ?? metadata.sourceKind,
          relationship: job.relationship,
          origin: job.origin,
          integrity: { sha256, bytes: metadata.bytes, mediaType: metadata.mediaType },
          processor: normalized.processor ?? { id: selected.processor.id },
          normalized,
        },
        { contentRoot, schemasDir: opts.schemasDir, limits }
      );
      job = await mutate(job, {
        state: JOB_STATE.COMPLETED,
        stage: "completed",
        sourceId: created.id,
        payload: created.payloadPath,
        error: undefined,
      });
      return publicJob(job);
    } catch (cause) {
      const error = classify(cause);
      const awaiting = error.code === INGEST_ERROR.PROCESSOR_UNAVAILABLE || error.code === INGEST_ERROR.SOURCE_NOT_ACTIVATED;
      job = await mutate(job, {
        state: awaiting ? JOB_STATE.AWAITING_USER : JOB_STATE.FAILED,
        stage: awaiting ? "awaiting-user" : "failed",
        error: {
          code: error.code,
          diagnostic: diagnostic(error),
          ...(error.detail && Object.keys(error.detail).length ? { detail: error.detail } : {}),
        },
      });
      return publicJob(job);
    }
  }

  return Object.freeze({
    enqueue,
    processJob,
    retry: processJob,
    getJob(jobId) {
      const job = readJob(jobId, jobOptions);
      return job ? publicJob(job) : null;
    },
    listJobs() {
      return listJobs(jobOptions).map(publicJob);
    },
    registry,
    limits: Object.freeze(limits),
  });
}
