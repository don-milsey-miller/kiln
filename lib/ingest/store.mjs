import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";

import { atomicWrite, TEMP_SUFFIX } from "../atomic-write.mjs";
import { canonicalPath, isAtOrInside, resolveContentRoot } from "../content-root.mjs";
import { INGEST_ERROR, IngestError } from "./result.mjs";

export const DEFAULT_LIMITS = Object.freeze({
  maxUploadBytes: 100 * 1024 * 1024,
  maxInboxBytes: 100 * 1024 * 1024,
  maxNormalizedBytes: 8 * 1024 * 1024,
  maxRemoteAudioBytes: 25_000_000,
  maxPdfPages: 200,
  processingTimeoutMs: 10 * 60 * 1000,
});

const SHA256 = /^[a-f0-9]{64}$/;
const JOB_ID = /^ing_[0-9a-f-]{36}$/;

function ensureInside(candidate, root, label) {
  const canonicalRoot = canonicalPath(root);
  const canonicalCandidate = canonicalPath(candidate);
  if (!isAtOrInside(canonicalCandidate, canonicalRoot))
    throw new IngestError(INGEST_ERROR.STORAGE_FAILED, `${label} resolves outside the approved ingest storage root.`);
  return canonicalCandidate;
}

export function ingestPaths(opts = {}) {
  const contentRoot = opts.contentRoot ?? resolveContentRoot(opts.env);
  const projectRoot = canonicalPath(dirname(contentRoot));
  const candidate = join(projectRoot, ".pi", "ingest");

  // Check the deepest existing ancestor before creating anything. A linked `.pi` must not cause
  // Kiln to create ingest state outside the project and only discover it afterwards.
  ensureInside(candidate, projectRoot, "The ingest root");
  mkdirSync(candidate, { recursive: true });
  const root = ensureInside(candidate, projectRoot, "The ingest root");

  const paths = {
    projectRoot,
    contentRoot,
    root,
    inbox: join(root, "inbox"),
    blobs: join(root, "blobs"),
    jobs: join(root, "jobs"),
    work: join(root, "work"),
  };
  for (const [label, path] of Object.entries(paths)) {
    if (label === "projectRoot" || label === "contentRoot" || label === "root") continue;
    mkdirSync(path, { recursive: true });
    paths[label] = ensureInside(path, root, `The ingest ${label} directory`);
  }
  return paths;
}

export function resolveInIngestRoot(relPath, opts = {}) {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.includes("\0"))
    throw new IngestError(INGEST_ERROR.STORAGE_FAILED, "An ingest path must be a non-empty relative path.");
  if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath) || /^[\\/]/.test(relPath))
    throw new IngestError(INGEST_ERROR.STORAGE_FAILED, "An ingest path must not be absolute.");
  const { root } = ingestPaths(opts);
  const target = ensureInside(join(root, relPath), root, "The ingest path");
  return target;
}

export function blobPath(sha256, opts = {}) {
  if (!SHA256.test(sha256)) throw new IngestError(INGEST_ERROR.INVALID_SOURCE, "A blob hash must be lowercase SHA-256.");
  return resolveInIngestRoot(`blobs/${sha256}`, opts);
}

async function* chunksOf(source) {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (source && typeof source.getReader === "function") {
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (source && typeof source[Symbol.asyncIterator] === "function") {
    yield* source;
    return;
  }
  throw new IngestError(INGEST_ERROR.INVALID_SOURCE, "The source body is not a byte stream.");
}

export async function storeBlob(source, opts = {}) {
  const paths = ingestPaths(opts);
  const limit = opts.maxBytes ?? DEFAULT_LIMITS.maxUploadBytes;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new IngestError(INGEST_ERROR.INVALID_SOURCE, "The configured source-size limit is invalid.");

  const temp = join(paths.work, `.blob-${process.pid}-${randomUUID()}${TEMP_SUFFIX}`);
  const fd = openSync(temp, "wx");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const value of chunksOf(source)) {
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > limit)
        throw new IngestError(INGEST_ERROR.FILE_TOO_LARGE, `The source exceeds the configured ${limit}-byte limit.`, {
          limit,
        });
      hash.update(chunk);
      writeSync(fd, chunk);
    }
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {}
    throw error;
  }
  closeSync(fd);

  const sha256 = hash.digest("hex");
  const destination = blobPath(sha256, { contentRoot: paths.contentRoot });
  let deduplicated = false;
  try {
    if (existsSync(destination)) {
      const existing = lstatSync(destination);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== bytes)
        throw new IngestError(INGEST_ERROR.STORAGE_FAILED, "The content-addressed blob destination is not the expected regular file.");
      deduplicated = true;
    } else {
      try {
        linkSync(temp, destination);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        deduplicated = true;
      }
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
  return { sha256, bytes, path: destination, deduplicated };
}

export function newJobId() {
  return `ing_${randomUUID()}`;
}

export function jobPath(jobId, opts = {}) {
  if (!JOB_ID.test(jobId)) throw new IngestError(INGEST_ERROR.INVALID_SOURCE, "The ingestion job id is invalid.");
  return resolveInIngestRoot(`jobs/${jobId}.json`, opts);
}

export async function writeJob(job, opts = {}) {
  if (!job || !JOB_ID.test(job.jobId ?? ""))
    throw new IngestError(INGEST_ERROR.INVALID_SOURCE, "The ingestion job record is invalid.");
  const target = jobPath(job.jobId, opts);
  await atomicWrite(target, `${JSON.stringify(job, null, 2)}\n`);
  return job;
}

export function readJob(jobId, opts = {}) {
  const target = jobPath(jobId, opts);
  if (!existsSync(target)) return null;
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new IngestError(INGEST_ERROR.STORAGE_FAILED, "The ingestion job record is not a regular file.");
  try {
    return JSON.parse(readFileSync(target, "utf-8"));
  } catch (error) {
    throw new IngestError(INGEST_ERROR.STORAGE_FAILED, "The ingestion job record is unreadable.", {
      cause: error?.message,
    });
  }
}

export function listJobs(opts = {}) {
  const { jobs } = ingestPaths(opts);
  // `ingestPaths` resolves this fixed runtime directory beneath the project root. The marker keeps
  // Turbopack from treating its run-specific absolute path as build-time application input.
  return readdirSync(/* turbopackIgnore: true */ jobs)
    .filter((name) => /^ing_[0-9a-f-]{36}\.json$/.test(name))
    .map((name) => readJob(name.slice(0, -5), opts))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.jobId.localeCompare(b.jobId));
}

export function safeFilename(value) {
  const name = basename(String(value ?? "source")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (name || "source").slice(0, 255);
}
