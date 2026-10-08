/**
 * How a payload write ends when it does not simply succeed - #180.
 *
 * The write is create-only through an exclusive hard link, and that link is its commit point. Before it, a
 * cancelled write removes its temporary file and creates no payload. After it, the payload exists and the write is
 * reported as made. A payload that is not valid is refused with a bounded account of why, and a filesystem that
 * refuses is reported with a code and fixed words.
 *
 * ⚠️ **THE FILESYSTEM'S REFUSALS AND THE TIMING OF A CANCELLATION ARE INJECTED.** `node:fs` functions are replaced for
 * the paths under test and restored afterwards. The writer and the atomic create are the real ones.
 * `test/pi-session-payload-write.test.mjs` sends Pi's own abort through a real session.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ATOMIC_WRITE_REFUSAL, AtomicWriteError, TEMP_SUFFIX, atomicCreate } from "../lib/atomic-write.mjs";
import { PAYLOAD_ERRORS_SHOWN, PAYLOAD_POINTER_MAX, PAYLOAD_WRITE_REFUSAL, PayloadExistsError, PayloadValidationError, PayloadWriteError, relativePayloadPath, writePayload } from "../lib/payload-write.mjs";
import register from "../pi-package/extensions/kiln.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REL = "schemas/orders/order.schema.json";

function project() {
  const root = mkdtempSync(join(tmpdir(), "kiln-payload-"));
  writeFileSync(join(root, "project.yaml"), "name: payload outcomes\n");
  const target = join(root, ...REL.split("/"));
  return {
    root,
    target,
    /** Every file under the content root except the manifest: payloads and temporary files alike. */
    files: () => readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && entry.name !== "project.yaml").map((entry) => entry.name),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A valid schema with `defs` definitions, each `depth` objects deep: nested objects and `$defs`, as in the report. */
function schema({ defs = 2, props = 4, depth = 2 } = {}) {
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
const compactBytes = (value) => Buffer.byteLength(JSON.stringify(value));
/** The same schema with every third `type` misspelled, which the dialect's own schema refuses each time. */
function spoiled(content) {
  const copy = structuredClone(content);
  let seen = 0;
  (function walk(value) {
    if (value === null || typeof value !== "object") return;
    if (typeof value.type === "string" && seen++ % 3 === 0) value.type = "strnig";
    for (const child of Object.values(value)) walk(child);
  })(copy);
  return copy;
}

/** Replace one synchronous `node:fs` function for the calls `applies` selects, for as long as `run` takes. */
async function withFs(name, applies, replacement, run) {
  const original = fs[name];
  const calls = { count: 0 };
  fs[name] = function (...args) {
    if (!applies(...args)) return original.apply(this, args);
    calls.count++;
    return replacement(calls.count, () => original.apply(this, args));
  };
  syncBuiltinESMExports();
  try {
    return await run(calls);
  } finally {
    fs[name] = original;
    syncBuiltinESMExports();
  }
}
const fsError = (code, syscall) => Object.assign(new Error(`${code}: operation refused, ${syscall} '${join(homedir(), "somewhere")}'`), { code, syscall });
const isTemp = (path) => String(path).endsWith(TEMP_SUFFIX);
const write = (p, opts = {}, content = schema()) => writePayload({ format: "json-schema", path: REL, content }, { contentRoot: p.root, ...opts });
const caught = (promise) => promise.then((value) => assert.fail(`written: ${JSON.stringify(value)}`), (error) => error);

/** A refusal of the write itself: the code, the relative path, fixed words, and nothing of the machine. */
function assertWriteRefusal(p, error, code) {
  assert.ok(error instanceof PayloadWriteError, `${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  assert.equal(error.path, REL);
  assert.ok(error.retry.length > 0);
  const said = `${error.message} ${error.retry} ${error.path}`;
  for (const absent of [p.root, p.root.replaceAll("\\", "/"), homedir(), hostname(), "EPERM", "ENOSPC", "EACCES", "EIO", "link", "Atomic create"]) assert.ok(!said.includes(absent), `the refusal says ${absent}: ${said}`);
  // ⚠️ NO PAYLOAD AND NO TEMPORARY FILE, whatever stopped it.
  assert.deepEqual(p.files(), []);
}

/* ------------------------------------------------------------------ cancellation */

test("⚠️ #180 cancelled before creation: nothing is validated into a file, and no directory is made", async () => {
  const p = project();
  try {
    const already = new AbortController();
    already.abort();
    assertWriteRefusal(p, await caught(write(p, { signal: already.signal })), PAYLOAD_WRITE_REFUSAL.CANCELLED);
    assert.equal(existsSync(join(p.root, "schemas")), false, "a directory was made for a cancelled write");

    // Cancelled while the payload was being validated: seen at the next check, still before any directory.
    let reads = 0;
    const duringValidation = { get aborted() { return ++reads > 1; }, addEventListener() {}, removeEventListener() {} };
    assertWriteRefusal(p, await caught(write(p, { signal: duringValidation })), PAYLOAD_WRITE_REFUSAL.CANCELLED);
    assert.equal(existsSync(join(p.root, "schemas")), false);
    // A payload that is not valid is still told so, even when it is also cancelled later: validation came first.
    assert.ok((await caught(write(p, {}, { type: "strnig" }))) instanceof PayloadValidationError);
  } finally {
    p.remove();
  }
});

test("⚠️ #180 cancelled during the synchronous temporary write: the file is removed, the link is never made, no payload exists", async () => {
  const p = project();
  try {
    const controller = new AbortController();
    let links = 0;
    // The cancellation arrives while the temporary file is being written. That code is synchronous, so it is
    // delivered only when the writer next lets the event loop turn, which it does before its commit point.
    const error = await withFs("writeFileSync", isTemp, (_n, real) => {
      const result = real();
      setImmediate(() => controller.abort());
      return result;
    }, (wrote) => withFs("linkSync", () => true, (_n, real) => (links++, real()), async () => {
      const refused = await caught(write(p, { signal: controller.signal }));
      assert.equal(wrote.count, 1, "the temporary file was never written, so nothing was cancelled part way");
      return refused;
    }));
    assertWriteRefusal(p, error, PAYLOAD_WRITE_REFUSAL.CANCELLED);
    assert.equal(links, 0, "the link was attempted after the cancellation");
    assert.equal(existsSync(p.target), false);
    // The parent directory was made before the cancellation and is left: it holds nothing.
    assert.deepEqual(readdirSync(dirname(p.target)), []);
  } finally {
    p.remove();
  }
});

test("⚠️ #180 cancelled after the link: the payload is committed, whole, and reported as written", async () => {
  const p = project();
  try {
    const controller = new AbortController();
    const content = schema();
    // The cancellation lands in the instant the link returns: there is no later point at which to refuse.
    const written = await withFs("linkSync", () => true, (_n, real) => {
      const result = real();
      controller.abort();
      return result;
    }, () => write(p, { signal: controller.signal }, content));
    assert.equal(controller.signal.aborted, true);
    assert.deepEqual([written.path, written.writeMode], [REL, "create-only"]);
    assert.equal(readFileSync(p.target, "utf-8"), `${JSON.stringify(content, null, 2)}\n`);
    assert.deepEqual(p.files(), ["order.schema.json"]);
  } finally {
    p.remove();
  }
});

/* ------------------------------------------------------------------ the filesystem */

test("⚠️ #180 a filesystem that refuses is payload-write-failed, with no filesystem code or raw error returned", async () => {
  const p = project();
  try {
    for (const code of ["EPERM", "ENOSPC", "EIO"]) {
      const error = await withFs("linkSync", () => true, () => {
        throw fsError(code, "link");
      }, () => caught(write(p)));
      assertWriteRefusal(p, error, PAYLOAD_WRITE_REFUSAL.FAILED);
      // Kept for a developer, never on the message.
      assert.equal(error.cause.cause.code, code);
    }
    // The temporary file could not be filled, and the directory could not be made: the same code.
    assertWriteRefusal(p, await withFs("writeFileSync", isTemp, (_n, real) => {
      real();
      throw fsError("ENOSPC", "write");
    }, () => caught(write(p))), PAYLOAD_WRITE_REFUSAL.FAILED);
    rmSync(join(p.root, "schemas"), { recursive: true });
    assertWriteRefusal(p, await withFs("mkdirSync", () => true, () => {
      throw fsError("EACCES", "mkdir");
    }, () => caught(write(p))), PAYLOAD_WRITE_REFUSAL.FAILED);

    // An existing payload is its own refusal, with the path it was asked for and nothing replaced.
    await write(p);
    const before = readFileSync(p.target, "utf-8");
    const exists = await caught(write(p, {}, schema({ defs: 3 })));
    assert.ok(exists instanceof PayloadExistsError);
    assert.deepEqual([exists.path, exists.message], [REL, `Payload already exists: ${REL}.`]);
    assert.equal(readFileSync(p.target, "utf-8"), before);
    assert.deepEqual(p.files(), ["order.schema.json"]);
  } finally {
    p.remove();
  }
});

test("⚠️ #180 atomicCreate without a signal creates and refuses as it did, and a tidy-up that fails after the link is no longer a failed create", async () => {
  const p = project();
  try {
    const target = join(p.root, "plain.json");
    assert.deepEqual(await atomicCreate(target, "one"), { created: true });
    const duplicate = await caught(atomicCreate(target, "two"));
    assert.ok(duplicate instanceof AtomicWriteError);
    assert.equal(duplicate.cause.code, "EEXIST");
    assert.match(duplicate.message, /^Atomic create failed: EEXIST -> /);
    assert.equal(duplicate.code, ATOMIC_WRITE_REFUSAL.FAILED);
    assert.equal(readFileSync(target, "utf-8"), "one");

    const refused = await withFs("linkSync", () => true, () => {
      throw fsError("EPERM", "link");
    }, () => caught(atomicCreate(join(p.root, "refused.json"), "x")));
    assert.match(refused.message, /^Atomic create failed: EPERM -> /);
    assert.deepEqual(p.files(), ["plain.json"]);

    // The link succeeded and removing the temporary file did not: the file was created, and that is what is said.
    const tidied = join(p.root, "tidied.json");
    assert.deepEqual(await withFs("unlinkSync", isTemp, () => {
      throw fsError("EBUSY", "unlink");
    }, () => atomicCreate(tidied, "kept")), { created: true });
    assert.equal(readFileSync(tidied, "utf-8"), "kept");

    const aborted = new AbortController();
    aborted.abort();
    assert.equal((await caught(atomicCreate(join(p.root, "never.json"), "x", { signal: aborted.signal }))).code, ATOMIC_WRITE_REFUSAL.CANCELLED);
    assert.equal(existsSync(join(p.root, "never.json")), false);
    assert.deepEqual(await atomicCreate(join(p.root, "signalled.json"), "x", { signal: new AbortController().signal }), { created: true });
  } finally {
    p.remove();
  }
});

/* ------------------------------------------------------------------ validation */

test("⚠️ #180 an invalid schema is refused with the first five errors and a count, however many there are", async () => {
  const p = project();
  try {
    const large = schema({ defs: 30, props: 10, depth: 3 });
    assert.ok(compactBytes(large) > 60_000, "the fixture is not a large schema");
    const started = Date.now();
    const error = await caught(write(p, {}, spoiled(large)));
    assert.ok(Date.now() - started < 5_000, "an invalid large schema was not refused quickly");
    assert.ok(error instanceof PayloadValidationError);
    assert.equal(error.path, REL);
    // ⚠️ EVERY ERROR THE VALIDATOR RAISED IS COUNTED, AS RAISED: the same validator, asked directly, says the same number.
    const direct = new Ajv2020({ allErrors: true, strict: false, validateSchema: true });
    assert.equal(direct.validateSchema(spoiled(large)), false);
    assert.equal(error.errorCount, direct.errors.length);
    assert.ok(error.errorCount > 300, `only ${error.errorCount} errors were counted`);
    assert.equal(error.errors.length, PAYLOAD_ERRORS_SHOWN);
    // And the five returned are its first five, in its order.
    assert.deepEqual(error.errors.map((entry) => [entry.instancePath, entry.rule]), direct.errors.slice(0, 5).map((raw) => [raw.instancePath, raw.keyword]));
    for (const entry of error.errors) {
      assert.deepEqual(Object.keys(entry), ["instancePath", "rule", "message"]);
      // ⚠️ A JSON POINTER INTO THE PAYLOAD, INTACT: it is what tells the author where.
      assert.match(entry.instancePath, /^\/(?:\$defs|properties)\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_$]+)*$/);
      assert.match(entry.rule, /^[A-Za-z$]+$/);
      assert.equal(entry.message, `The value here breaks the JSON Schema rule "${entry.rule}".`);
    }
    assert.equal(error.message, `Invalid JSON Schema: ${error.errorCount} errors. The first 5 are in \`errors\`.`);
    // Bounded: a few hundred bytes, for a payload of tens of thousands with hundreds of errors.
    assert.ok(Buffer.byteLength(JSON.stringify({ message: error.message, errors: error.errors })) < 2_000);
    assert.ok(!JSON.stringify(error.errors).includes("strnig"), "the payload's own text is quoted");
    assert.deepEqual(p.files(), []);
    assert.equal(existsSync(join(p.root, "schemas")), false, "a directory was made for an invalid payload");

    // Fewer than five are all returned, and counted as the validator raised them: one mistake, several rules.
    const single = await caught(write(p, {}, { type: "object", properties: { name: { type: "strnig" } } }));
    assert.equal(direct.validateSchema({ type: "object", properties: { name: { type: "strnig" } } }), false);
    assert.equal(single.errorCount, direct.errors.length);
    assert.ok(single.errorCount >= 1 && single.errorCount <= 5 && single.errors.length === single.errorCount);
    assert.ok(single.errors.every((entry) => entry.instancePath === "/properties/name/type"));
    // A location deeper than the bound is cut, with a mark.
    let deep = { type: "strnig" };
    for (let i = 0; i < 40; i++) deep = { type: "object", properties: { nested_property_name: deep } };
    const cut = await caught(write(p, {}, deep));
    assert.ok(cut.errors.every((entry) => entry.instancePath.length === PAYLOAD_POINTER_MAX + 1 && entry.instancePath.endsWith("…")));
    // A dialect the validator does not know is refused in fixed words, not the validator's.
    const unknown = await caught(write(p, {}, { $schema: `https://example.test/${"x".repeat(300)}`, type: "object" }));
    assert.equal(unknown.message, "Invalid JSON Schema: it could not be checked against the dialect its $schema names.");
  } finally {
    p.remove();
  }
});

test("#180 a path is repeated only when it is content-relative", () => {
  assert.equal(relativePayloadPath("schemas\\orders\\order.schema.json"), "schemas/orders/order.schema.json");
  assert.equal(relativePayloadPath(REL), REL);
  for (const refused of ["../outside.schema.json", "schemas/../../outside.schema.json", "/etc/x.schema.json", "C:\\x.schema.json", "C:/x.schema.json", "\\\\server\\share\\x.schema.json", "", 7, null, `${"a/".repeat(300)}x.schema.json`]) assert.equal(relativePayloadPath(refused), null, String(refused).slice(0, 40));
});

/* ------------------------------------------------------------------ the tool */

async function tool(p, params, { signal } = {}) {
  const tools = new Map();
  register({ registerTool: (t) => tools.set(t.name, t), on: () => {} }, { toolRoot: ROOT });
  const registered = tools.get("kiln_write_payload");
  const saved = process.env.PLANNING_CONTENT_DIR;
  process.env.PLANNING_CONTENT_DIR = p.root;
  try {
    const result = await registered.execute("call-1", params, signal, undefined, {});
    return { result, body: JSON.parse(result.content[0].text), description: registered.description };
  } finally {
    if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved;
  }
}

test("⚠️ #180 the tool returns structured, bounded refusals: the relative path as a field, pointers intact, nothing of the machine", async () => {
  const p = project();
  try {
    const params = { format: "json-schema", path: REL, content: schema() };

    const cancelled = new AbortController();
    cancelled.abort();
    const first = await tool(p, params, { signal: cancelled.signal });
    assert.deepEqual(first.body, { ok: false, code: "payload-write-cancelled", message: "The write was cancelled before the payload was created. Nothing was written.", path: REL, retry: "Retry only if the operator asks for it." });

    const failed = await withFs("linkSync", () => true, () => {
      throw fsError("EPERM", "link");
    }, () => tool(p, params));
    assert.deepEqual(failed.body, { ok: false, code: "payload-write-failed", message: "The payload file could not be created. Nothing was written.", path: REL, retry: "Tell the operator. Do not retry in a loop." });

    const large = spoiled(schema({ defs: 30, props: 10, depth: 3 }));
    const invalid = await tool(p, { ...params, content: large });
    assert.deepEqual(Object.keys(invalid.body), ["ok", "code", "message", "path", "errorCount", "errors"]);
    assert.deepEqual([invalid.body.code, invalid.body.path, invalid.body.errors.length], ["invalid-payload", REL, 5]);
    assert.ok(invalid.body.errors.every((entry) => entry.instancePath.startsWith("/")), "a JSON pointer was rewritten");
    // Before #180 this result was 53 KB, for a payload of this size with this many errors.
    assert.ok(Buffer.byteLength(JSON.stringify(invalid.result)) < 6_000, `the refusal is ${Buffer.byteLength(JSON.stringify(invalid.result))} bytes`);

    const written = await tool(p, params);
    assert.deepEqual(written.body, { ok: true, format: "json-schema", path: REL, reference: { format: "json-schema", path: REL }, writeMode: "create-only" });
    const exists = await tool(p, params);
    assert.deepEqual(exists.body, { ok: false, code: "payload-exists", message: `Payload already exists: ${REL}.`, path: REL });

    for (const { result } of [first, failed, invalid, exists]) {
      const text = JSON.stringify(result);
      for (const absent of [p.root, p.root.replaceAll("\\", "/"), p.root.replaceAll("\\", "\\\\"), homedir(), hostname(), "EPERM", "<path>", "Atomic create"]) assert.ok(!text.includes(absent), `the result says ${absent}`);
    }
    // A path outside the content root is refused as before, and is not repeated as a field.
    const outside = await tool(p, { ...params, path: "../outside.schema.json" });
    assert.deepEqual([outside.body.code, "path" in outside.body], ["payload-path-outside-content-root", false]);
    assert.deepEqual(p.files(), ["order.schema.json"]);
  } finally {
    p.remove();
  }
});

test("⚠️ #180 32 KiB is guidance the model reads before it writes, not a limit: a larger valid schema is still written", async () => {
  const p = project();
  try {
    const large = schema({ defs: 30, props: 10, depth: 3 });
    assert.ok(compactBytes(large) > 2 * 32 * 1024, "the fixture is not well above the guidance");
    const written = await tool(p, { format: "json-schema", path: REL, content: large });
    assert.equal(written.body.ok, true, JSON.stringify(written.body));
    assert.equal(readFileSync(p.target, "utf-8"), `${JSON.stringify(large, null, 2)}\n`);
    // ⚠️ WHERE A SIZE CAN HELP. Kiln is handed the payload only after Pi has received all of it, so a refusal here
    // would come after the wait it was meant to prevent. The description is read before the payload is written.
    assert.ok(written.description.includes("Keep one payload under about 32 KiB of compact JSON."));
    assert.ok(written.description.includes("A larger one is still accepted"));
    assert.ok(written.description.includes("Split a larger schema into several valid files that refer to each other with relative $ref."));
  } finally {
    p.remove();
  }
});
