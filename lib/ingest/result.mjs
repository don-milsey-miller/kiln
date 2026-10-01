export const INGEST_ERROR = Object.freeze({
  UNSUPPORTED_TYPE: "unsupported-type",
  FILE_TOO_LARGE: "file-too-large",
  INVALID_SOURCE: "invalid-source",
  PROCESSOR_UNAVAILABLE: "processor-unavailable",
  PROCESSING_FAILED: "processing-failed",
  EXTERNAL_PROVIDER_REFUSED: "external-provider-refused",
  EXTERNAL_PROVIDER_FAILED: "external-provider-failed",
  LOCAL_CAPABILITY_UNAVAILABLE: "local-capability-unavailable",
  STORAGE_FAILED: "storage-failed",
  NORMALIZATION_FAILED: "normalization-failed",
  SOURCE_NOT_ACTIVATED: "source-not-activated",
});

export const JOB_STATE = Object.freeze({
  QUEUED: "queued",
  INSPECTING: "inspecting",
  PROCESSING: "processing",
  AWAITING_USER: "awaiting-user",
  COMPLETED: "completed",
  FAILED: "failed",
});

export class IngestError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "IngestError";
    this.code = code;
    this.detail = detail;
  }
}

export function publicJob(job) {
  return {
    jobId: job.jobId,
    state: job.state,
    stage: job.stage,
    attempt: job.attempt,
    filename: job.origin?.filename ?? "source",
    sourceId: job.sourceId ?? null,
    processor: job.processor ?? null,
    error: job.error ? { code: job.error.code } : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
