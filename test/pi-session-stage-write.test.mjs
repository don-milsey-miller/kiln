/**
 * `kiln_write_stage_document` through real Pi - #179.
 *
 * `test/stage-document-write.test.mjs` holds every way the write can end, with the filesystem's refusals injected.
 * This file runs the pinned Pi in RPC mode with Kiln's packaged extension and a scripted provider, and reads the
 * outcome from the events Pi emits and from the project on disk: a small Stage 09 note, a document another process
 * is reading or holding, a content lock another process has, and Pi's own abort arriving while the tool runs.
 *
 * ⚠️ **PI WAITS FOR A TOOL TO RETURN.** An abort does not end a running tool; it only sets the signal the tool was
 * given. So a tool that ignores the signal makes the operator wait out whatever it is doing, and may then commit
 * after they cancelled. What is asserted here is that Kiln's writer answers the signal itself, with its own code.
 *
 * ⚠️ **NOT THE DELAY THE ISSUE REPORTED.** That one was measured before the tool starts, while the model is still
 * sending the tool call's arguments. Nothing in Kiln runs during it, and nothing here changes it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { rpcSession, scriptedProvider, sessionFixture, textOf } from "./helpers/pi-session.mjs";
import { TEMP_SUFFIX } from "../lib/atomic-write.mjs";
import { WORKING_NOTES_HEADING, WORKING_NOTES_PLACEHOLDER, intakeSection, readWorkingNotes, writeWorkingNotes } from "../lib/stage-documents.mjs";

const TOOL = "kiln_write_stage_document";
const STAGE = "09-handoff";
const NOTE = "The handoff is blocked: the publish target is not reachable from this machine.\n\n- Owner: operator\n- Next: retry after VPN access is restored.";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const settled = (event) => event.type === "agent_settled";
const writeStart = (event) => event.type === "tool_execution_start" && event.toolName === TOOL && event.args?.action !== "read-working-notes";
const endOf = (start) => (event) => event.type === "tool_execution_end" && event.toolCallId === start.toolCallId;
const updatesOf = (io, start) => io.events().filter((event) => event.type === "tool_execution_update" && event.toolCallId === start.toolCallId);
const bodyOf = (end) => JSON.parse(textOf(end.result.content));

/** A Stage 09 document of about 1.7 KB, as in the report, in a session fixture. */
async function stage09(provider) {
  const fx = await sessionFixture(provider);
  const doc = join(fx.contentRoot, "stages", `${STAGE}.md`);
  writeFileSync(doc, `# Stage 09 - Handoff\n\n${intakeSection()}\n${WORKING_NOTES_HEADING}\n\n${WORKING_NOTES_PLACEHOLDER}\n`);
  await writeWorkingNotes(fx.contentRoot, STAGE, {
    action: "append-working-note",
    subsection: "background",
    title: "Background",
    content: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(22).trim(),
    expectedRevision: readWorkingNotes(fx.contentRoot, STAGE).revision,
  });
  const lock = join(fx.contentRoot, ".planning.lock");
  return {
    fx,
    doc,
    lock,
    bytes: () => readFileSync(doc, "utf-8"),
    temps: () => readdirSync(dirname(doc)).filter((name) => name.includes(TEMP_SUFFIX)),
    notes: () => readWorkingNotes(fx.contentRoot, STAGE).subsections.map((s) => `${s.name}@${s.revision}`),
  };
}

/** The model's side of one write: read the notes, write with the revision that came back, then say so. */
function writeTurn(provider, action = "append-working-note", subsection = "blocked") {
  provider.script.push({ tool: TOOL, arguments: { stage: STAGE, action: "read-working-notes" } });
  provider.script.push((request) => {
    const read = JSON.parse(textOf(request.messages.filter((m) => m.role === "tool").at(-1).content));
    return { tool: TOOL, arguments: { stage: STAGE, action, subsection, title: "Handoff blocked", content: NOTE, expectedRevision: read.revision } };
  });
  provider.script.push({ text: "Recorded." });
}

/** Another process that has the content lock, as a second Kiln writer would. Resolves once the lock is on disk. */
async function lockHolder(s) {
  const child = spawn(
    process.execPath,
    ["-e", `require("fs").writeFileSync(${JSON.stringify(s.lock)}, JSON.stringify({ pid: process.pid, hostname: require("os").hostname(), acquiredAt: new Date().toISOString() }), { flag: "wx" }); setInterval(() => {}, 1000);`],
    { stdio: "ignore" }
  );
  for (let waited = 0; !existsSync(s.lock); waited += 20) {
    if (waited > 10_000) throw new Error("the helper never took the content lock");
    await sleep(20);
  }
  return { record: readFileSync(s.lock, "utf-8"), pid: child.pid, stop: () => (child.kill(), rmSync(s.lock, { force: true })) };
}

/**
 * A handle on the document that does not share delete access, which is what makes Windows refuse a rename over
 * it. Resolves once the handle is open; it closes itself after `holdMs`.
 */
async function exclusiveReader(s, holdMs) {
  const opened = join(s.fx.base, "reader-open");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `$h = [System.IO.File]::Open('${s.doc}', 'Open', 'Read', 'Read'); Set-Content -Path '${opened}' -Value 'open'; Start-Sleep -Milliseconds ${holdMs}; $h.Close()`],
    { stdio: "ignore" }
  );
  for (let waited = 0; !existsSync(opened); waited += 20) {
    if (waited > 30_000) throw new Error("the reader never opened the document");
    await sleep(20);
  }
  return { stop: () => child.kill(), closed: new Promise((done) => child.on("exit", done)) };
}

test("⚠️ #179 a small Stage 09 note is written in well under the seconds the issue asks for, silently, leaving nothing behind", { timeout: 180_000 }, async () => {
  const provider = await scriptedProvider();
  const s = await stage09(provider);
  try {
    assert.ok(Buffer.byteLength(s.bytes()) > 1_600 && Buffer.byteLength(s.bytes()) < 1_900, "the fixture is not the size the report describes");
    const took = [];
    await rpcSession(s.fx, async (io) => {
      for (let i = 0; i < 5; i++) {
        writeTurn(provider, i === 0 ? "append-working-note" : "replace-working-note");
        io.send({ id: `p${i}`, type: "prompt", message: `Record the blocked handoff note (${i}).` });
        const start = await io.waitFor("the write to start", writeStart, { count: i + 1 });
        const end = await io.waitFor("the write to end", endOf(start));
        await io.waitFor("the turn to settle", settled, { count: i + 1 });
        assert.equal(bodyOf(end).ok, true, textOf(end.result.content));
        // ⚠️ NO PROGRESS FOR AN ORDINARY WRITE: nothing was waited for, so nothing is announced.
        assert.deepEqual(updatesOf(io, start), []);
        took.push(end.arrivedAt - start.arrivedAt);
      }
    });
    // Measured at 84-142 ms on Windows. The bound is the issue's "seconds", not a benchmark.
    assert.ok(Math.max(...took) < 5_000, `a write took ${Math.max(...took)} ms: ${took.join(", ")}`);
    assert.deepEqual(s.notes(), ["background@1", "blocked@5"]);
    assert.deepEqual([s.temps(), existsSync(s.lock)], [[], false]);
  } finally {
    await provider.close();
    s.fx.remove();
  }
});

test("⚠️ #179 with another process opening and reading the document every few milliseconds, every write still commits", { timeout: 240_000 }, async () => {
  const provider = await scriptedProvider();
  const s = await stage09(provider);
  // As a renderer or an indexer does, and far more often than either: open, read, close, every 2 ms.
  // ⚠️ NOT A READER THAT NEVER LETS GO. One that reads without pause can hold the document for the whole budget, and
  // the right answer to that is `stage-document-write-contended`, which the held-handle test below asserts.
  const reader = spawn(process.execPath, ["-e", `const fs = require("fs"); setInterval(() => { try { fs.readFileSync(${JSON.stringify(s.doc)}); } catch {} }, 2);`], { stdio: "ignore" });
  try {
    await sleep(300);
    await rpcSession(s.fx, async (io) => {
      for (let i = 0; i < 10; i++) {
        writeTurn(provider, i === 0 ? "append-working-note" : "replace-working-note");
        io.send({ id: `p${i}`, type: "prompt", message: `Record the blocked handoff note (${i}).` });
        const start = await io.waitFor("the write to start", writeStart, { count: i + 1 });
        const end = await io.waitFor("the write to end", endOf(start));
        await io.waitFor("the turn to settle", settled, { count: i + 1 });
        assert.equal(bodyOf(end).ok, true, `write ${i}: ${textOf(end.result.content)}`);
        assert.ok(end.arrivedAt - start.arrivedAt < 5_000, `write ${i} took ${end.arrivedAt - start.arrivedAt} ms`);
      }
    });
    reader.kill();
    assert.deepEqual(s.notes(), ["background@1", "blocked@10"]);
    assert.deepEqual([s.temps(), existsSync(s.lock)], [[], false]);
  } finally {
    reader.kill();
    await provider.close();
    s.fx.remove();
  }
});

test("⚠️ #179 Windows: a document held open by another program for a second is waited out, and the write commits", { timeout: 180_000, skip: process.platform !== "win32" && "the handle that refuses a rename is a Windows one" }, async () => {
  const provider = await scriptedProvider();
  const s = await stage09(provider);
  let reader = null;
  try {
    await rpcSession(s.fx, async (io) => {
      writeTurn(provider);
      // Held for 1.2 s from now: longer than the old budget, shorter than the stage document's two seconds.
      reader = await exclusiveReader(s, 1_200);
      io.send({ id: "p", type: "prompt", message: "Record the blocked handoff note." });
      const start = await io.waitFor("the write to start", writeStart);
      const end = await io.waitFor("the write to end", endOf(start));
      await io.waitFor("the turn to settle", settled);
      assert.equal(bodyOf(end).ok, true, textOf(end.result.content));
      assert.ok(end.arrivedAt - start.arrivedAt >= 300, "the handle was already closed, so nothing was waited out");
      // The wait was for the rename, not for the lock: still nothing to announce.
      assert.deepEqual(updatesOf(io, start), []);
    });
    assert.deepEqual(s.notes(), ["background@1", "blocked@1"]);
    assert.deepEqual([s.temps(), existsSync(s.lock)], [[], false]);
  } finally {
    reader?.stop();
    await provider.close();
    s.fx.remove();
  }
});

test("⚠️ #179 Windows: a document held open past the budget is stage-document-write-contended, and Escape during the retry ends it at once", { timeout: 180_000, skip: process.platform !== "win32" && "the handle that refuses a rename is a Windows one" }, async () => {
  const provider = await scriptedProvider();
  const s = await stage09(provider);
  let reader = null;
  try {
    const before = s.bytes();
    await rpcSession(s.fx, async (io) => {
      // Held for longer than both writes below take together.
      reader = await exclusiveReader(s, 12_000);

      // Left alone, the write gives up when its own budget is spent.
      writeTurn(provider);
      io.send({ id: "p1", type: "prompt", message: "Record the blocked handoff note." });
      const first = await io.waitFor("the write to start", writeStart);
      const gaveUp = await io.waitFor("the write to end", endOf(first));
      await io.waitFor("the turn to settle", settled);
      assert.deepEqual(bodyOf(gaveUp), {
        ok: false,
        code: "stage-document-write-contended",
        message: "Another program had this stage's document open, and it could not be replaced within about two seconds. Nothing was written.",
        path: `stages/${STAGE}.md`,
        lock: ".planning.lock",
        retry: "Read the working notes again, then retry once. If it repeats, ask the operator to close whatever has the document open.",
      });
      const budget = gaveUp.arrivedAt - first.arrivedAt;
      assert.ok(budget >= 1_900 && budget < 6_000, `the write gave up after ${budget} ms`);
      assert.deepEqual([s.bytes(), s.temps(), existsSync(s.lock)], [before, [], false]);

      // ⚠️ ESCAPE WHILE THE RENAME IS BEING RETRIED. The temporary file exists exactly while the writer is there.
      writeTurn(provider);
      io.send({ id: "p2", type: "prompt", message: "Record the blocked handoff note again." });
      const second = await io.waitFor("the second write to start", writeStart, { count: 2 });
      for (let waited = 0; s.temps().length === 0; waited += 2) {
        assert.ok(waited < 5_000, "the writer never reached its rename");
        await sleep(2);
      }
      await sleep(150);
      const abortedAt = Date.now();
      io.send({ id: "a", type: "abort" });
      const cancelled = await io.waitFor("the cancelled write to end", endOf(second));
      await io.waitFor("the turn to settle", settled, { count: 2 });
      assert.equal(bodyOf(cancelled).code, "stage-document-write-cancelled", textOf(cancelled.result.content));
      assert.ok(cancelled.arrivedAt - abortedAt < 1_000, `the write went on for ${cancelled.arrivedAt - abortedAt} ms after the abort`);
    });
    // ⚠️ NEVER PARTIAL: unchanged, with no temporary file and no lock.
    assert.deepEqual([s.bytes(), s.temps(), existsSync(s.lock)], [before, [], false]);
  } finally {
    reader?.stop();
    await provider.close();
    s.fx.remove();
  }
});

test("⚠️ #179 a content lock another process holds: one notice after a second, and Escape ends the wait with the tool's own code", { timeout: 180_000 }, async () => {
  const provider = await scriptedProvider();
  const s = await stage09(provider);
  let holder = null;
  try {
    const before = s.bytes();
    holder = await lockHolder(s);
    await rpcSession(s.fx, async (io) => {
      writeTurn(provider);
      io.send({ id: "p", type: "prompt", message: "Record the blocked handoff note." });
      const start = await io.waitFor("the write to start", writeStart);
      // ⚠️ PROGRESS ONLY ONCE THE LOCK HAS REALLY BEEN CONTENDED FOR A SECOND.
      const update = await io.waitFor("the lock-wait notice", (event) => event.type === "tool_execution_update" && event.toolCallId === start.toolCallId, { timeoutMs: 8_000 });
      const noticedAfter = update.arrivedAt - start.arrivedAt;
      assert.ok(noticedAfter >= 900 && noticedAfter < 4_000, `the notice came after ${noticedAfter} ms`);
      assert.equal(textOf(update.partialResult.content), "Waiting for another Kiln write to this project to finish (up to 10 seconds).");

      await sleep(500);
      const abortedAt = Date.now();
      io.send({ id: "a", type: "abort" });
      const end = await io.waitFor("the write to end", endOf(start));
      await io.waitFor("the turn to settle", settled);
      assert.deepEqual(bodyOf(end), {
        ok: false,
        code: "stage-document-write-cancelled",
        message: "The write was cancelled before it was committed. Nothing was written.",
        path: `stages/${STAGE}.md`,
        lock: ".planning.lock",
        retry: "Retry only if the operator asks for it.",
      });
      // Before #179 this returned 9 s later, at the lock's own bound.
      assert.ok(end.arrivedAt - abortedAt < 1_000, `the lock wait went on for ${end.arrivedAt - abortedAt} ms after the abort`);
      assert.equal(updatesOf(io, start).length, 1, "the wait was announced more than once");
    });
    // The other writer's lock is exactly as it was, and nothing of this one's exists.
    assert.equal(readFileSync(s.lock, "utf-8"), holder.record);
    assert.deepEqual([s.bytes(), s.temps()], [before, []]);
  } finally {
    holder?.stop();
    await provider.close();
    s.fx.remove();
  }
});

test("⚠️ #179 a content lock held for the whole ten seconds is stage-document-lock-timeout, with no process id, host or path", { timeout: 180_000 }, async () => {
  const provider = await scriptedProvider();
  const s = await stage09(provider);
  let holder = null;
  try {
    const before = s.bytes();
    holder = await lockHolder(s);
    await rpcSession(s.fx, async (io) => {
      writeTurn(provider);
      io.send({ id: "p", type: "prompt", message: "Record the blocked handoff note." });
      const start = await io.waitFor("the write to start", writeStart);
      const end = await io.waitFor("the write to end", endOf(start), { timeoutMs: 30_000 });
      await io.waitFor("the turn to settle", settled);
      assert.deepEqual(bodyOf(end), {
        ok: false,
        code: "stage-document-lock-timeout",
        message: "Another Kiln write held this project's content lock for the whole 10-second wait. Nothing was written.",
        path: `stages/${STAGE}.md`,
        lock: ".planning.lock",
        retry: "Retry once. If it times out again, tell the operator that another Kiln process may be writing to this project.",
      });
      const waited = end.arrivedAt - start.arrivedAt;
      assert.ok(waited >= 9_500 && waited < 15_000, `the lock bound was ${waited} ms`);
      assert.equal(updatesOf(io, start).length, 1);
      const result = JSON.stringify(end.result);
      for (const absent of [String(holder.pid), hostname(), s.fx.contentRoot, s.fx.contentRoot.replaceAll("\\", "/"), s.fx.contentRoot.replaceAll("\\", "\\\\"), "Timed out after"]) assert.ok(!result.includes(absent), `the result says ${absent}`);
    });
    assert.equal(readFileSync(s.lock, "utf-8"), holder.record);
    assert.deepEqual([s.bytes(), s.temps()], [before, []]);
  } finally {
    holder?.stop();
    await provider.close();
    s.fx.remove();
  }
});
