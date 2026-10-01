import { test } from "node:test";
import assert from "node:assert/strict";

import { createProcessorRegistry } from "../lib/ingest/registry.mjs";
import { INGEST_ERROR, IngestError } from "../lib/ingest/result.mjs";

const processor = (id, { accepts = true, available = true } = {}) => ({
  id,
  accepts: () => accepts,
  probe: async () => ({ available, reason: available ? undefined : "not-configured" }),
  process: async () => ({ content: id }),
});

test("selection is centralized, ordered, and based on accepts plus probe", async () => {
  const registry = createProcessorRegistry([
    processor("first", { available: false }),
    processor("second", { available: true }),
  ]);
  const selected = await registry.select({ mediaType: "text/plain" });
  assert.equal(selected.processor.id, "second");
  assert.deepEqual(selected.probes.map((probe) => [probe.processor, probe.available]), [["first", false], ["second", true]]);
});

test("unsupported and unavailable capabilities remain structured", async () => {
  await assert.rejects(
    () => createProcessorRegistry([processor("no", { accepts: false })]).select({ mediaType: "application/x-nope" }),
    (error) => error instanceof IngestError && error.code === INGEST_ERROR.UNSUPPORTED_TYPE
  );
  await assert.rejects(
    () => createProcessorRegistry([processor("offline", { available: false })]).select({ mediaType: "audio/wav" }),
    (error) => error instanceof IngestError && error.code === INGEST_ERROR.PROCESSOR_UNAVAILABLE && error.detail.probes.length === 1
  );
});

test("processor contracts and ids are validated when the registry is built", () => {
  assert.throws(() => createProcessorRegistry([{ id: "broken" }]), /accepts/);
  assert.throws(() => createProcessorRegistry([processor("same"), processor("same")]), /unique/);
});
