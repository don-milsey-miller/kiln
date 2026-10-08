/**
 * `kiln_write_payload` through real Pi - #180.
 *
 * `test/payload-write-outcomes.test.mjs` holds every way the write can end, with the filesystem and the timing
 * injected. This file runs the pinned Pi in RPC mode with a scripted provider and reads the outcome from Pi's events
 * and the project on disk.
 *
 * ⚠️ **THE DELAY THE ISSUE REPORTED IS BEFORE THE TOOL STARTS.** Pi re-parses the whole of a tool call's arguments on
 * every delta it receives, so the wait grows with the square of the payload, and Kiln is handed nothing until it
 * ends. Escape during that wait is Pi's abort of the model's message: the tool never runs and nothing is written.
 * That is asserted here as it is, and nothing in Kiln changes it.
 *
 * ⚠️ **PI WAITS FOR A RUNNING TOOL TO RETURN.** An abort only sets the signal the tool was given. So what Kiln owes is
 * to answer that signal itself: refuse before its commit point, and report the payload as written after it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { rpcSession, scriptedProvider, sessionFixture, textOf } from "./helpers/pi-session.mjs";

const TOOL = "kiln_write_payload";
const REL = "schemas/orders/order.schema.json";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const settled = (event) => event.type === "agent_settled";
const started = (event) => event.type === "tool_execution_start" && event.toolName === TOOL;
const endOf = (start) => (event) => event.type === "tool_execution_end" && event.toolCallId === start.toolCallId;
const bodyOf = (end) => JSON.parse(textOf(end.result.content));
const filesUnder = (root) => (existsSync(join(root, "schemas")) ? readdirSync(join(root, "schemas"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name) : []);

/** A valid schema with nested objects and `$defs`, sized by its three numbers. */
function schema({ defs, props, depth }) {
  const object = (level, seed) => {
    const properties = {};
    for (let i = 0; i < props; i++)
      properties[`field${seed}_${i}`] = level > 1 && i === 0 ? object(level - 1, seed * 7 + 1) : i === 1 ? { $ref: `#/$defs/def${(seed + i) % defs}` } : { type: "string", description: `Field ${i}: a short label.`, maxLength: 200 };
    return { type: "object", properties, required: Object.keys(properties).slice(0, 2), additionalProperties: false };
  };
  const $defs = {};
  for (let d = 0; d < defs; d++) $defs[`def${d}`] = object(depth, d + 1);
  return { $schema: "https://json-schema.org/draft/2020-12/schema", title: "Order", ...object(depth, 1000), $defs };
}
const SMALL = schema({ defs: 1, props: 4, depth: 1 });
const LARGE = schema({ defs: 30, props: 10, depth: 3 });
const call = (content, path = REL, streaming = {}) => ({ tool: TOOL, arguments: { format: "json-schema", path, content }, ...streaming });

/**
 * Kiln's extension with the payload's create held at one point until Pi's signal has aborted, so a real abort can
 * be made to arrive on either side of the commit point.
 *
 * ⚠️ **THE SAME `register` AND THE SAME WRITER.** Only `createFile`, which the writer already takes, is supplied: it
 * calls the real `atomicCreate` with the signal the writer passed it, before or after waiting for that signal.
 */
const HELD = (when) => ({ tool }) => `
import register from ${JSON.stringify(pathToFileURL(join(tool, "pi-package", "extensions", "kiln.js")).href)};
import * as writer from ${JSON.stringify(pathToFileURL(join(tool, "lib", "payload-write.mjs")).href)};
import { atomicCreate } from ${JSON.stringify(pathToFileURL(join(tool, "lib", "atomic-write.mjs")).href)};
const aborted = (signal) => new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true })));
export default function (pi) {
  register(pi, {
    payloadWriter: {
      writePayload: (params, opts) =>
        writer.writePayload(params, {
          ...opts,
          createFile: async (target, text, options) => {
            ${when === "before-link" ? "await aborted(options.signal); return atomicCreate(target, text, options);" : "const made = await atomicCreate(target, text, options); await aborted(options.signal); return made;"}
          },
        }),
    },
  });
}
`;

test("⚠️ #180 a small schema and one well above the 32 KiB guidance are both written, promptly once Pi hands them over", { timeout: 180_000 }, async () => {
  const provider = await scriptedProvider();
  const fx = await sessionFixture(provider);
  try {
    const large = "schemas/orders/large.schema.json";
    assert.ok(Buffer.byteLength(JSON.stringify(LARGE)) > 2 * 32 * 1024);
    provider.script.push(call(SMALL), { text: "Written." }, call(LARGE, large), { text: "Written." });
    await rpcSession(fx, async (io) => {
      for (const [i, [path, content]] of [[REL, SMALL], [large, LARGE]].entries()) {
        io.send({ id: `p${i}`, type: "prompt", message: `Write schema ${i}.` });
        const start = await io.waitFor("the write to start", started, { count: i + 1 });
        const end = await io.waitFor("the write to end", endOf(start));
        await io.waitFor("the turn to settle", settled, { count: i + 1 });
        assert.deepEqual(bodyOf(end), { ok: true, format: "json-schema", path, reference: { format: "json-schema", path }, writeMode: "create-only" });
        // Measured at 92-152 ms for payloads from 1 KB to 800 KB. The bound is "seconds", not a benchmark.
        assert.ok(end.arrivedAt - start.arrivedAt < 5_000, `the write of ${path} took ${end.arrivedAt - start.arrivedAt} ms`);
        assert.equal(readFileSync(join(fx.contentRoot, ...path.split("/")), "utf-8"), `${JSON.stringify(content, null, 2)}\n`);
      }
    });
    assert.deepEqual(filesUnder(fx.contentRoot).sort(), ["large.schema.json", "order.schema.json"]);
  } finally {
    await provider.close();
    fx.remove();
  }
});

test("⚠️ #180 Escape while the arguments are still streaming: the tool never starts, and no payload or directory is made", { timeout: 180_000 }, async () => {
  const provider = await scriptedProvider();
  const fx = await sessionFixture(provider);
  try {
    // 200 deltas, 50 ms apart: ten seconds of streaming if nobody stops it.
    provider.script.push(call(SMALL, REL, { pieces: 200, everyMs: 50 }), { text: "Written." });
    await rpcSession(fx, async (io) => {
      io.send({ id: "p", type: "prompt", message: "Write the order schema." });
      await io.waitFor("the tool call to begin streaming", (event) => event.type === "message_update" && event.assistantMessageEvent?.type === "toolcall_delta", { count: 5 });
      const abortedAt = Date.now();
      io.send({ id: "a", type: "abort" });
      const done = await io.waitFor("the turn to settle", settled);
      assert.ok(done.arrivedAt - abortedAt < 2_000, `the abort took ${done.arrivedAt - abortedAt} ms`);
      // ⚠️ THE BOUNDARY: this is Pi ending the model's message. Kiln's tool was never called.
      assert.equal(io.events().filter((event) => event.type.startsWith("tool_execution")).length, 0, "the tool ran on arguments that were never finished");
      const last = io.events().filter((event) => event.type === "message_end" && event.message?.role === "assistant").at(-1).message;
      assert.equal(last.stopReason, "aborted");
      assert.deepEqual(last.content.map((part) => part.type), ["toolCall"]);
    });
    assert.equal(existsSync(join(fx.contentRoot, "schemas")), false);
  } finally {
    await provider.close();
    fx.remove();
  }
});

test("⚠️ #180 Pi's abort before the link: payload-write-cancelled, no payload, no temporary file", { timeout: 180_000 }, async () => {
  const provider = await scriptedProvider();
  const fx = await sessionFixture(provider, { packaged: false, extensions: { "kiln-held.js": HELD("before-link") } });
  try {
    provider.script.push(call(SMALL), { text: "Written." });
    await rpcSession(fx, async (io) => {
      io.send({ id: "p", type: "prompt", message: "Write the order schema." });
      const start = await io.waitFor("the write to start", started);
      await sleep(500);
      assert.equal(io.events().some(endOf(start)), false, "the write did not wait at its create");
      const abortedAt = Date.now();
      io.send({ id: "a", type: "abort" });
      const end = await io.waitFor("the write to end", endOf(start));
      await io.waitFor("the turn to settle", settled);
      assert.deepEqual(bodyOf(end), { ok: false, code: "payload-write-cancelled", message: "The write was cancelled before the payload was created. Nothing was written.", path: REL, retry: "Retry only if the operator asks for it." });
      assert.ok(end.arrivedAt - abortedAt < 2_000, `the write went on for ${end.arrivedAt - abortedAt} ms after the abort`);
    });
    assert.deepEqual(filesUnder(fx.contentRoot), []);
  } finally {
    await provider.close();
    fx.remove();
  }
});

test("⚠️ #180 Pi's abort after the link: the payload is there, whole, and the tool says it was written", { timeout: 180_000 }, async () => {
  const provider = await scriptedProvider();
  const fx = await sessionFixture(provider, { packaged: false, extensions: { "kiln-held.js": HELD("after-link") } });
  try {
    provider.script.push(call(SMALL), { text: "Written." });
    const target = join(fx.contentRoot, ...REL.split("/"));
    await rpcSession(fx, async (io) => {
      io.send({ id: "p", type: "prompt", message: "Write the order schema." });
      const start = await io.waitFor("the write to start", started);
      for (let waited = 0; !existsSync(target); waited += 20) {
        assert.ok(waited < 10_000, "the payload was never linked");
        await sleep(20);
      }
      assert.equal(io.events().some(endOf(start)), false, "the write did not wait after its link");
      io.send({ id: "a", type: "abort" });
      const end = await io.waitFor("the write to end", endOf(start));
      await io.waitFor("the turn to settle", settled);
      // ⚠️ COMMITTED IS COMMITTED. Reporting a cancellation here would tell the model nothing was written.
      assert.deepEqual(bodyOf(end), { ok: true, format: "json-schema", path: REL, reference: { format: "json-schema", path: REL }, writeMode: "create-only" });
    });
    assert.equal(readFileSync(target, "utf-8"), `${JSON.stringify(SMALL, null, 2)}\n`);
    assert.deepEqual(filesUnder(fx.contentRoot), ["order.schema.json"]);
  } finally {
    await provider.close();
    fx.remove();
  }
});
