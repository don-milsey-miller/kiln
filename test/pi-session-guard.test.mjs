/**
 * Kiln's guard inside Pi: what it decides, what it answers, and how it stops a session that is not the one
 * Kiln recorded — ACC-0103, F128.
 *
 * Nothing here starts Pi. What the pinned Pi does around this — that `session_start` fires before any input or
 * provider request, and that an uncaught throw from a microtask restores the terminal and exits — was measured
 * against the real thing and is recorded with the slice's evidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { GUARD_CODE, GUARD_ENV, GUARD_OUTCOME, createGuardFile, createSessionGuard } from "../lib/pi-session-guard.mjs";
import { GUARD_STOP_MESSAGE, checkBoundSession } from "../lib/pi-session-guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixedBytes = (n) => Buffer.alloc(n, 0x5a);

/** A recorded session: a transcript on disk, and the expectation Kiln would have written for it. */
function recorded({ id = "kept0000-0000-4000-8000-000000000001", text = "a transcript" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-guard-ext-"));
  const runtimeDir = join(root, "runtime");
  mkdirSync(runtimeDir);
  const file = join(root, "session.jsonl");
  writeFileSync(file, text);
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  const guard = createGuardFile({ runtimeDir, expected: { sessionId: id, file, digest }, randomBytes: fixedBytes });
  return { root, id, file, digest, guard, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** Runs the guard the way Pi does: one `session_start`, with whatever session Pi says it bound. */
async function guardRun(fixture, bound, { env } = {}) {
  const stopped = [];
  const handlers = {};
  createSessionGuard({ env: env ?? { [GUARD_ENV]: fixture.guard.path }, stop: (code) => stopped.push(code) })({
    on: (event, handler) => (handlers[event] = handler),
  });
  await handlers.session_start({ reason: "startup" }, { sessionManager: { getSessionId: () => bound.id, getSessionFile: () => bound.file } });
  return { stopped, verdict: fixture.guard.readResult() };
}

test("⚠️ F128 the session Pi bound is the recorded one: the guard says so and lets it run", async () => {
  const f = recorded();
  try {
    const { stopped, verdict } = await guardRun(f, { id: f.id, file: f.file });
    assert.deepEqual(stopped, [], "nothing is stopped");
    assert.deepEqual(verdict, { ok: true, outcome: GUARD_OUTCOME.ACCEPTED, code: null });
    assert.equal(readFileSync(f.file, "utf-8"), "a transcript", "and the transcript is untouched");
  } finally {
    f.done();
  }
});

test("⚠️ F128 every way Pi can bind the wrong session stops it, and says which", async () => {
  for (const [label, bind, code] of [
    ["another id", (f) => ({ id: "other000-0000-4000-8000-000000000002", file: f.file }), GUARD_CODE.SESSION_ID_MISMATCH],
    ["a file that is not there", (f) => ({ id: f.id, file: join(f.root, "gone.jsonl") }), GUARD_CODE.SESSION_FILE_MISSING],
    ["no file at all", (f) => ({ id: f.id, file: null }), GUARD_CODE.SESSION_FILE_MISSING],
    [
      "another file",
      (f) => {
        const other = join(f.root, "another.jsonl");
        writeFileSync(other, "a transcript");
        return { id: f.id, file: other };
      },
      GUARD_CODE.SESSION_FILE_MISMATCH,
    ],
    [
      "the right file, changed since",
      (f) => {
        writeFileSync(f.file, "a transcript, and one line more");
        return { id: f.id, file: f.file };
      },
      GUARD_CODE.TRANSCRIPT_CHANGED,
    ],
  ]) {
    const f = recorded();
    try {
      const { stopped, verdict } = await guardRun(f, bind(f));
      assert.deepEqual(stopped, [code], `${label}: stopped, with the code`);
      assert.deepEqual(verdict, { ok: true, outcome: GUARD_OUTCOME.REFUSED, code }, label);
    } finally {
      f.done();
    }
  }
});

test("⚠️ F128 a guard with no expectation stops the session rather than assuming it is fine", async () => {
  const f = recorded();
  try {
    // Nothing names a guard file: the run cannot be proved, so it does not continue.
    const { stopped } = await guardRun(f, { id: f.id, file: f.file }, { env: {} });
    assert.deepEqual(stopped, [GUARD_CODE.EXPECTATION_UNAVAILABLE]);
    assert.equal(f.guard.readResult().ok, false, "and no answer is invented for it");
  } finally {
    f.done();
  }
});

test("⚠️ F128 the expectation is taken as the guard loads, so nothing Pi starts inherits it", async () => {
  const f = recorded();
  try {
    const env = { [GUARD_ENV]: f.guard.path, KEPT: "yes" };
    createSessionGuard({ env, stop: () => {} })({ on: () => {} });
    assert.equal(GUARD_ENV in env, false, "the variable is gone before any session starts");
    assert.equal(env.KEPT, "yes");
    assert.equal(existsSync(f.guard.path), false, "and so is the file it named");
  } finally {
    f.done();
  }
});

test("⚠️ F128 what the guard compares is the id, the file, and the bytes", () => {
  const expected = { sessionId: "a", file: process.execPath, digest: "0".repeat(64) };
  assert.equal(checkBoundSession(expected, { sessionId: "b", file: process.execPath }), GUARD_CODE.SESSION_ID_MISMATCH);
  assert.equal(checkBoundSession(expected, { sessionId: "a", file: process.execPath }), GUARD_CODE.TRANSCRIPT_CHANGED);
});

test("⚠️ F128 the stop is an uncaught throw carrying a message and no path", () => {
  // ⚠️ IN A CHILD, BECAUSE THE REAL STOP ENDS THE PROCESS. Pi's own crash handler is what turns this into a
  // clean exit with the terminal restored; here the point is what it throws, and that nothing else leaks.
  const script = [
    `const { createSessionGuard } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "lib", "pi-session-guard.mjs")).href)});`,
    "const handlers = {};",
    "createSessionGuard({ env: {} })({ on: (event, handler) => (handlers[event] = handler) });",
    "await handlers.session_start({}, { sessionManager: { getSessionId: () => 'x', getSessionFile: () => null } });",
    "await new Promise((r) => setTimeout(r, 50));",
  ].join("\n");

  let failed = false;
  let stderr = "";
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    failed = true;
    stderr = e.stderr ?? "";
  }

  assert.equal(failed, true, "the session is stopped");
  assert.ok(stderr.includes(GUARD_STOP_MESSAGE), stderr.slice(0, 200));
  assert.equal(stderr.includes("pi-session-guard.mjs"), false, "and no stack trace naming a file");
});
