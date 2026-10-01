import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIngestService } from "../lib/ingest/service.mjs";
import { createAudioProcessor } from "../lib/ingest/processors/audio.mjs";
import {
  createOpenAITranscriptionProvider,
  createOpenAITranscriptionProviderFromEnv,
} from "../lib/ingest/providers/openai-transcription.mjs";
import { INGEST_ERROR, IngestError } from "../lib/ingest/result.mjs";

const made = [];
process.on("exit", () => made.forEach((path) => rmSync(path, { recursive: true, force: true })));

function wavBytes() {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(0, 40);
  return bytes;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kiln-ingest-audio-"));
  made.push(root);
  const contentRoot = join(root, "planning-content");
  mkdirSync(contentRoot);
  writeFileSync(join(contentRoot, "project.yaml"), "schemaVersion: 2\ncapabilities:\n  artifactTypes:\n    activated: [source]\n");
  return { root, contentRoot };
}

test("remote transcription requires both explicit authorization and a configured key", async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; throw new Error("must not run"); };
  const notAuthorized = createOpenAITranscriptionProvider({ apiKey: "test-key", authorized: false, fetch });
  const noKey = createOpenAITranscriptionProvider({ authorized: true, fetch });

  assert.deepEqual(await notAuthorized.probe(), {
    available: false,
    mode: "remote",
    reason: "remote-processing-not-authorized",
  });
  assert.equal((await noKey.probe()).reason, "api-key-not-configured");
  assert.equal(calls, 0, "capability probes must never make a remote request");
});

test("environment provider recognizes only the documented explicit allow value", async () => {
  assert.equal((await createOpenAITranscriptionProviderFromEnv({ OPENAI_API_KEY: "x" }).probe()).available, false);
  assert.equal((await createOpenAITranscriptionProviderFromEnv({
    OPENAI_API_KEY: "x",
    KILN_INGEST_REMOTE_PROCESSING: "true",
  }).probe()).available, false);
  assert.equal((await createOpenAITranscriptionProviderFromEnv({
    OPENAI_API_KEY: "x",
    KILN_INGEST_REMOTE_PROCESSING: "allow",
  }).probe()).available, true);
});

test("OpenAI provider sends bounded multipart audio and returns only normalized provider facts", async () => {
  const fx = fixture();
  const path = join(fx.root, "speech.wav");
  writeFileSync(path, wavBytes());
  let request;
  const provider = createOpenAITranscriptionProvider({
    apiKey: "test-secret",
    authorized: true,
    fetch: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ text: "  Kiln receives audio.  ", internal: "discard-me" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await provider.transcribe({
    blobPath: path,
    bytes: wavBytes().byteLength,
    mediaType: "audio/wav",
    filename: "speech.wav",
  });

  assert.equal(request.url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer test-secret");
  assert.equal(request.options.body.get("model"), "gpt-transcribe");
  assert.equal(request.options.body.get("response_format"), "json");
  assert.equal(request.options.body.get("file").name, "speech.wav");
  assert.deepEqual(result, { text: "  Kiln receives audio.  ", provider: "openai", model: "gpt-transcribe" });
});

test("provider failures expose stable classifications without response bodies or credentials", async () => {
  const fx = fixture();
  const path = join(fx.root, "speech.wav");
  writeFileSync(path, wavBytes());
  const provider = createOpenAITranscriptionProvider({
    apiKey: "do-not-leak",
    authorized: true,
    fetch: async () => new Response('{"error":"private provider detail"}', { status: 401 }),
  });
  await assert.rejects(
    () => provider.transcribe({ blobPath: path, bytes: 44, mediaType: "audio/wav", filename: "speech.wav" }),
    (error) => error instanceof IngestError &&
      error.code === INGEST_ERROR.EXTERNAL_PROVIDER_REFUSED &&
      JSON.stringify(error).includes("private provider detail") === false &&
      JSON.stringify(error).includes("do-not-leak") === false
  );
});

test("audio moves to awaiting-user when no transcription provider is configured", async () => {
  const fx = fixture();
  const service = createIngestService({ contentRoot: fx.contentRoot });
  const queued = await service.enqueue(
    { source: wavBytes(), filename: "meeting.wav", relationship: "external-reference" },
    { process: false }
  );
  const result = await service.processJob(queued.job.jobId);
  assert.equal(result.state, "awaiting-user");
  assert.equal(result.error.code, "processor-unavailable");
});

test("configured audio provider creates a transcript source without interpreting it", async () => {
  const fx = fixture();
  const provider = {
    id: "transcription/test",
    async probe() { return { available: true, mode: "test", provider: "fixture", model: "fixture-v1" }; },
    async transcribe() { return { text: "Decision mentioned, but not approved.", provider: "fixture", model: "fixture-v1" }; },
  };
  const service = createIngestService({ contentRoot: fx.contentRoot, transcriptionProvider: provider });
  const queued = await service.enqueue(
    { source: wavBytes(), filename: "meeting.wav", relationship: "external-reference" },
    { process: false }
  );
  const result = await service.processJob(queued.job.jobId);
  assert.equal(result.state, "completed");
  const artifact = JSON.parse(readFileSync(join(fx.contentRoot, "data", "sources", `${result.sourceId}.json`), "utf-8"));
  assert.equal(artifact.sourceKind, "audio");
  assert.equal(artifact.relationship, "external-reference");
  assert.deepEqual(artifact.processor, {
    id: "audio/transcription/test",
    provider: "fixture",
    model: "fixture-v1",
  });
  assert.equal(readFileSync(join(fx.contentRoot, artifact.derivedPayload.path), "utf-8"),
    "# Transcript\n\nDecision mentioned, but not approved.\n");
});

test("audio processor rejects oversized remote input before calling a provider", async () => {
  let called = false;
  const processor = createAudioProcessor({
    provider: {
      id: "transcription/test",
      async probe() { return { available: true }; },
      async transcribe() { called = true; return { text: "unexpected" }; },
    },
  });
  await assert.rejects(
    () => processor.process(
      { metadata: { bytes: 11, mediaType: "audio/wav" }, blobPath: "unused", job: { origin: { filename: "x.wav" } } },
      { limits: { maxRemoteAudioBytes: 10, processingTimeoutMs: 1_000 } }
    ),
    (error) => error instanceof IngestError && error.code === INGEST_ERROR.FILE_TOO_LARGE
  );
  assert.equal(called, false);
});
