import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIngestService } from "../lib/ingest/service.mjs";
import { createOpenAIExtractionProvider, createOpenAIExtractionProviderFromEnv } from "../lib/ingest/providers/openai-extraction.mjs";
import { INGEST_ERROR, IngestError } from "../lib/ingest/result.mjs";

const made = [];
process.on("exit", () => made.forEach((path) => rmSync(path, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kiln-ingest-media-"));
  made.push(root);
  const contentRoot = join(root, "planning-content");
  mkdirSync(contentRoot);
  writeFileSync(join(contentRoot, "project.yaml"), "schemaVersion: 2\ncapabilities:\n  artifactTypes:\n    activated: [source]\n");
  return { root, contentRoot };
}

function pdf(strings = [""]) {
  const pageCount = strings.length;
  const fontId = 3 + pageCount * 2;
  const objects = new Map();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const kids = strings.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  objects.set(2, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  strings.forEach((text, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const escaped = text.replace(/([\\()])/g, "\\$1");
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET` : "q Q";
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  objects.set(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id <= fontId; id += 1) {
    offsets[id] = Buffer.byteLength(body);
    body += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= fontId; id += 1) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function provider(markdown = "Observed text") {
  return {
    id: "extraction/test",
    async probe() { return { available: true, mode: "test", maxBytes: 1_000_000 }; },
    async extract(input) { return { markdown, provider: "fixture", model: `fixture-${input.sourceKind}` }; },
  };
}

test("text PDFs use deterministic embedded extraction without calling a remote fallback", async () => {
  const fx = fixture();
  let calls = 0;
  const fallback = provider();
  fallback.extract = async () => { calls += 1; throw new Error("must not run"); };
  const service = createIngestService({ contentRoot: fx.contentRoot, extractionProvider: fallback });
  const queued = await service.enqueue({
    source: pdf(["Kiln preserves embedded PDF text deterministically for planning."]),
    filename: "brief.pdf",
    relationship: "project-manager-input",
  }, { process: false });
  const result = await service.processJob(queued.job.jobId);
  assert.equal(result.state, "completed");
  assert.equal(calls, 0);
  const artifact = JSON.parse(readFileSync(join(fx.contentRoot, "data", "sources", `${result.sourceId}.json`), "utf8"));
  assert.equal(artifact.sourceKind, "document");
  assert.equal(artifact.processor.id, "document/pdfjs");
  assert.match(readFileSync(join(fx.contentRoot, artifact.derivedPayload.path), "utf8"), /## Page 1\n\nKiln preserves embedded PDF text/);
});

test("scanned PDFs use an authorized fallback and otherwise remain retryable", async () => {
  const unavailable = fixture();
  const waitingService = createIngestService({ contentRoot: unavailable.contentRoot });
  const waiting = await waitingService.enqueue({
    source: pdf(), filename: "scan.pdf", relationship: "external-reference",
  }, { process: false });
  const waitingResult = await waitingService.processJob(waiting.job.jobId);
  assert.equal(waitingResult.state, "awaiting-user");
  assert.equal(waitingResult.error.code, "processor-unavailable");

  const resumed = createIngestService({
    contentRoot: unavailable.contentRoot,
    extractionProvider: provider("Recovered after configuration"),
  });
  const recovered = await resumed.retry(waiting.job.jobId);
  assert.equal(recovered.state, "completed");
  assert.equal(recovered.attempt, 2);
  assert.equal(resumed.getJob(waiting.job.jobId).sourceId, "SRC-0001");

  const fx = fixture();
  const service = createIngestService({ contentRoot: fx.contentRoot, extractionProvider: provider("Visible label: Alpha") });
  const queued = await service.enqueue({
    source: pdf(), filename: "scan.pdf", relationship: "external-reference",
  }, { process: false });
  const result = await service.processJob(queued.job.jobId);
  assert.equal(result.state, "completed");
  const artifact = JSON.parse(readFileSync(join(fx.contentRoot, "data", "sources", `${result.sourceId}.json`), "utf8"));
  assert.deepEqual(artifact.processor, {
    id: "document/extraction/test",
    provider: "fixture",
    model: "fixture-document",
  });
  assert.equal(readFileSync(join(fx.contentRoot, artifact.derivedPayload.path), "utf8"),
    "# Extracted document\n\nVisible label: Alpha\n");
});

test("PDF page limits are enforced before fallback extraction", async () => {
  const fx = fixture();
  const service = createIngestService({ contentRoot: fx.contentRoot, extractionProvider: provider(), limits: { maxPdfPages: 1 } });
  const queued = await service.enqueue({
    source: pdf(["Page one has sufficient embedded content for the test.", "Page two exceeds the limit."]),
    filename: "long.pdf",
    relationship: "external-reference",
  }, { process: false });
  const result = await service.processJob(queued.job.jobId);
  assert.equal(result.state, "failed");
  assert.equal(result.error.code, "file-too-large");
});

test("images normalize provider extraction into an external source without promoting its claims", async () => {
  const fx = fixture();
  const service = createIngestService({ contentRoot: fx.contentRoot, extractionProvider: provider("A sign reads **Approved**.") });
  const queued = await service.enqueue({
    source: PNG, filename: "sign.png", relationship: "external-reference",
  }, { process: false });
  const result = await service.processJob(queued.job.jobId);
  assert.equal(result.state, "completed");
  const artifact = JSON.parse(readFileSync(join(fx.contentRoot, "data", "sources", `${result.sourceId}.json`), "utf8"));
  assert.equal(artifact.sourceKind, "image");
  assert.equal(artifact.relationship, "external-reference");
  assert.equal(artifact.reviewStatus, "draft");
  assert.equal(readFileSync(join(fx.contentRoot, artifact.derivedPayload.path), "utf8"),
    "# Extracted image content\n\nA sign reads **Approved**.\n");
});

test("OpenAI extraction requires authorization, key, and an explicitly selected model", async () => {
  assert.equal((await createOpenAIExtractionProviderFromEnv({
    OPENAI_API_KEY: "x", KILN_OPENAI_EXTRACTION_MODEL: "vision-model",
  }).probe()).reason, "remote-processing-not-authorized");
  assert.equal((await createOpenAIExtractionProviderFromEnv({
    KILN_INGEST_REMOTE_PROCESSING: "allow", KILN_OPENAI_EXTRACTION_MODEL: "vision-model",
  }).probe()).reason, "api-key-not-configured");
  assert.equal((await createOpenAIExtractionProviderFromEnv({
    OPENAI_API_KEY: "x", KILN_INGEST_REMOTE_PROCESSING: "allow",
  }).probe()).reason, "model-not-configured");
});

test("OpenAI extraction sends bounded non-stored file and image requests", async () => {
  const fx = fixture();
  const pdfPath = join(fx.root, "scan.pdf");
  const imagePath = join(fx.root, "image.png");
  writeFileSync(pdfPath, pdf());
  writeFileSync(imagePath, PNG);
  const requests = [];
  const extraction = createOpenAIExtractionProvider({
    apiKey: "test-secret",
    authorized: true,
    model: "vision-model",
    fetch: async (_url, options) => {
      requests.push({ ...options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "Faithful extraction" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const document = await extraction.extract({
    blobPath: pdfPath, bytes: readFileSync(pdfPath).byteLength, mediaType: "application/pdf", filename: "scan.pdf", sourceKind: "document",
  });
  const image = await extraction.extract({
    blobPath: imagePath, bytes: PNG.byteLength, mediaType: "image/png", filename: "image.png", sourceKind: "image",
  });
  assert.equal(document.markdown, "Faithful extraction");
  assert.equal(image.markdown, "Faithful extraction");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.headers.Authorization, "Bearer test-secret");
    assert.equal(request.body.store, false);
    assert.equal(request.body.model, "vision-model");
    assert.match(request.body.input[0].content[1].text, /Do not summarize, infer requirements, make decisions, approve anything/);
  }
  assert.equal(requests[0].body.input[0].content[0].type, "input_file");
  assert.equal(requests[0].body.input[0].content[0].detail, "low");
  assert.equal(requests[1].body.input[0].content[0].type, "input_image");
  assert.equal(requests[1].body.input[0].content[0].detail, "high");
});

test("OpenAI extraction failures do not expose credentials or response bodies", async () => {
  const fx = fixture();
  const path = join(fx.root, "image.png");
  writeFileSync(path, PNG);
  const extraction = createOpenAIExtractionProvider({
    apiKey: "do-not-leak",
    authorized: true,
    model: "vision-model",
    fetch: async () => new Response('{"error":"private remote detail"}', { status: 429 }),
  });
  await assert.rejects(
    () => extraction.extract({ blobPath: path, bytes: PNG.byteLength, mediaType: "image/png", filename: "x.png", sourceKind: "image" }),
    (error) => error instanceof IngestError && error.code === INGEST_ERROR.EXTERNAL_PROVIDER_REFUSED &&
      !JSON.stringify(error).includes("do-not-leak") && !JSON.stringify(error).includes("private remote detail")
  );
});
