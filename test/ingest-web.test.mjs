import { test } from "node:test";
import assert from "node:assert/strict";

import { handleIngestGet, handleIngestPost } from "../app/_ingest/http.js";

const request = ({ body = new Uint8Array([1]), filename = "notes.txt", relationship = "project-manager-input", length = 1, url = "http://kiln.test/api/ingest" } = {}) => ({
  body,
  url,
  headers: new Headers({
    ...(filename === null ? {} : { "x-kiln-filename": filename }),
    ...(relationship === null ? {} : { "x-kiln-relationship": relationship }),
    ...(length === null ? {} : { "content-length": String(length) }),
    "content-type": "text/plain",
  }),
});

test("browser intake passes only bytes and approved metadata to enqueueSource and returns a job id", async () => {
  let received;
  const response = await handleIngestPost(request(), {
    uploadLimit: () => 10,
    enqueueSource: async (input) => {
      received = input;
      return { job: { jobId: "ing_11111111-1111-1111-1111-111111111111", state: "queued" } };
    },
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).job.jobId, "ing_11111111-1111-1111-1111-111111111111");
  assert.deepEqual(Object.keys(received).sort(), ["filename", "maxBytes", "mediaType", "origin", "relationship", "source"]);
  assert.equal(received.filename, "notes.txt");
  assert.equal(received.origin, "upload");
  assert.equal("destination" in received, false);
});

test("oversized or malformed upload requests are refused before the service sees bytes", async () => {
  let calls = 0;
  const deps = { uploadLimit: () => 4, enqueueSource: async () => { calls++; } };
  for (const candidate of [request({ length: 5 }), request({ filename: null }), request({ body: null })]) {
    const response = await handleIngestPost(candidate, deps);
    assert.ok([400, 413].includes(response.status));
  }
  assert.equal(calls, 0);
});

test("job status exposes one job or the bounded list without cache", async () => {
  const job = { jobId: "ing_11111111-1111-1111-1111-111111111111", state: "processing" };
  const deps = { getJob: (id) => id === job.jobId ? job : null, listJobs: () => [job] };
  const one = await handleIngestGet(request({ url: `http://kiln.test/api/ingest?job=${job.jobId}` }), deps);
  assert.deepEqual((await one.json()).job, job);
  assert.equal(one.headers.get("cache-control"), "no-store");
  const many = await handleIngestGet(request(), deps);
  assert.deepEqual((await many.json()).jobs, [job]);
});
