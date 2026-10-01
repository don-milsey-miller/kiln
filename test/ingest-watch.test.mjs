import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInboxWatcher } from "../lib/ingest/watch.mjs";
import { ingestPaths } from "../lib/ingest/store.mjs";

const made = [];
process.on("exit", () => made.forEach((path) => rmSync(path, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kiln-ingest-watch-"));
  made.push(root);
  const contentRoot = join(root, "planning-content");
  mkdirSync(contentRoot);
  return { root, contentRoot };
}

test("the inbox waits for a stable file and sends it through the shared ingestion service", async () => {
  const fx = fixture();
  const paths = ingestPaths({ contentRoot: fx.contentRoot });
  const source = join(paths.inbox, "notes.txt");
  writeFileSync(source, "stable notes");
  let handler;
  let options;
  const fakeWatcher = {
    on(event, callback) {
      if (event === "add") handler = callback;
      return this;
    },
    close() {},
  };
  const calls = [];
  const service = {
    async enqueue(input) {
      let text = "";
      for await (const chunk of input.source) text += chunk.toString("utf-8");
      calls.push({ ...input, source: text });
      return { job: { jobId: "ing_test" } };
    },
  };

  await createInboxWatcher(service, {
    contentRoot: fx.contentRoot,
    createWatcher: async (_path, supplied) => {
      options = supplied;
      return fakeWatcher;
    },
  });
  assert.deepEqual(options.awaitWriteFinish, { stabilityThreshold: 1500, pollInterval: 100 });
  assert.equal(options.followSymlinks, false);
  await handler(source);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, "stable notes");
  assert.equal(calls[0].origin, "inbox");
  assert.equal(calls[0].relationship, "project-manager-input");
  assert.equal(calls[0].filename, "notes.txt");
});
