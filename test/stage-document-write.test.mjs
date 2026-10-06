/**
 * How a stage-document write ends when it cannot simply succeed - #179.
 *
 * The write is small and local, and an ordinary one takes a fraction of a second. What this file holds is the rest:
 * a content lock somebody else has, a document another program has open, a filesystem that refuses, and a caller
 * that cancels. Each ends in one of four stable codes with the document exactly as it was, or in success once the
 * rename has happened. Nothing is left behind either way: no lock of this writer's, no temporary file.
 *
 * ⚠️ **THE FILESYSTEM'S REFUSALS ARE INJECTED, BECAUSE A REAL ONE CANNOT BE ASKED FOR ON EVERY PLATFORM.** `renameSync`
 * and `writeFileSync` are replaced on `node:fs` for the paths under test and restored afterwards. The lock, the
 * writer and the document module are the real ones. `test/pi-session-stage-write.test.mjs` does the same through
 * Pi, with a real handle on Windows.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ATOMIC_WRITE_REFUSAL, AtomicWriteError, TEMP_SUFFIX, atomicWrite } from "../lib/atomic-write.mjs";
import { LOCK_REFUSAL, LockError, withLock } from "../lib/lock.mjs";
import {
  STAGE_DOCUMENT_REFUSAL,
  StageDocumentRefusal,
  WORKING_NOTES_HEADING,
  WORKING_NOTES_PLACEHOLDER,
  intakeSection,
  readWorkingNotes,
  writeStageDocumentEntry,
  writeWorkingNotes,
} from "../lib/stage-documents.mjs";
import register from "../pi-package/extensions/kiln.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = "09-handoff";
const LOCK = ".planning.lock";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function project() {
  const root = mkdtempSync(join(tmpdir(), "kiln-stage-write-"));
  mkdirSync(join(root, "stages"));
  writeFileSync(join(root, "project.yaml"), "name: stage write\n");
  const doc = join(root, "stages", `${STAGE}.md`);
  writeFileSync(doc, `# Stage 09 - Handoff\n\n${intakeSection()}\n${WORKING_NOTES_HEADING}\n\n${WORKING_NOTES_PLACEHOLDER}\n`);
  const lock = join(root, LOCK);
  return {
    root,
    doc,
    lock,
    bytes: () => readFileSync(doc, "utf-8"),
    temps: () => readdirSync(dirname(doc)).filter((name) => name.includes(TEMP_SUFFIX)),
    /** The content lock, as another live writer holds it. Returns what releases it. */
    hold() {
      const record = JSON.stringify({ pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() });
      writeFileSync(lock, record, { flag: "wx" });
      return { record, release: () => rmSync(lock, { force: true }) };
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

const note = (p, over = {}) => ({ action: "append-working-note", subsection: "blocked", title: "Handoff blocked", content: "The publish target is not reachable.", expectedRevision: readWorkingNotes(p.root, STAGE).revision, ...over });
const append = (p, opts) => writeWorkingNotes(p.root, STAGE, note(p), opts);

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
/** Renames onto the stage document: refused with `code` for the first `times` attempts, real after that. */
const refusingRename = (p, code, times, run) => withFs("renameSync", (_from, to) => to === p.doc, (n, real) => {
  if (n <= times) throw fsError(code, "rename");
  return real();
}, run);

/** What every refusal of the write must be: the code, relative places, fixed words, and nothing of the machine. */
async function refused(p, promise, code, { lockHeld = false } = {}) {
  const before = p.bytes();
  const error = await promise.then(
    (value) => assert.fail(`the write succeeded: ${JSON.stringify(value)}`),
    (e) => e
  );
  assert.ok(error instanceof StageDocumentRefusal, `${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error.details), ["path", "lock", "retry"]);
  assert.equal(error.details.path, `stages/${STAGE}.md`);
  assert.equal(error.details.lock, LOCK);
  assert.ok(error.details.retry.length > 0);
  const said = `${error.message} ${JSON.stringify(error.details)}`;
  for (const absent of [p.root, p.root.replaceAll("\\", "/"), homedir(), hostname(), String(process.pid), "EPERM", "ENOSPC", "EIO", "EEXIST", "Timed out after"])
    assert.ok(!said.includes(absent), `the refusal says ${absent}: ${said}`);
  // ⚠️ EVERY REFUSAL LEAVES THE DOCUMENT AS IT WAS, AND NOTHING OF THIS WRITER'S BEHIND.
  assert.equal(p.bytes(), before, "the document changed");
  assert.deepEqual(p.temps(), [], "a temporary file was left");
  assert.equal(existsSync(p.lock), lockHeld, lockHeld ? "the other writer's lock was removed" : "the content lock was left");
  return error;
}

/* ------------------------------------------------------------------ the lock */

test("⚠️ #179 a content lock held for the whole wait is stage-document-lock-timeout, and the holder's lock is untouched", async () => {
  const p = project();
  try {
    const held = p.hold();
    const started = Date.now();
    await refused(p, append(p, { lock: { maxWaitMs: 300 } }), STAGE_DOCUMENT_REFUSAL.LOCK_TIMEOUT, { lockHeld: true });
    assert.ok(Date.now() - started >= 280 && Date.now() - started < 3_000, "the wait was not the bound it was given");
    assert.equal(readFileSync(p.lock, "utf-8"), held.record);
    // The same for the operator's answer, which goes through the same lock and writer.
    await refused(p, writeStageDocumentEntry(p.root, STAGE, { verbatim: "an answer", interpretation: "a reading" }, { lock: { maxWaitMs: 100 } }), STAGE_DOCUMENT_REFUSAL.LOCK_TIMEOUT, { lockHeld: true });
    held.release();
    assert.equal((await append(p)).subsectionRevision, 1, "the write does not go through once the lock is free");
  } finally {
    p.remove();
  }
});

test("⚠️ #179 one notice after a second of real contention, and none for an ordinary write", async () => {
  const p = project();
  try {
    let notices = 0;
    const onLockWait = () => notices++;
    await append(p, { onLockWait, lock: { waitingAfterMs: 50 } });
    assert.equal(notices, 0, "an uncontended write announced a wait");

    const held = p.hold();
    const waiting = writeWorkingNotes(p.root, STAGE, note(p, { subsection: "second" }), { onLockWait, lock: { waitingAfterMs: 100, maxWaitMs: 5_000 } });
    await sleep(60);
    assert.equal(notices, 0, "the notice came before the wait was long");
    await sleep(400);
    assert.equal(notices, 1, "a contended wait was not announced exactly once");
    held.release();
    assert.equal((await waiting).subsection, "second");
    assert.equal(notices, 1);
    // A notice that throws does not end the wait.
    const again = p.hold();
    const noisy = writeWorkingNotes(p.root, STAGE, note(p, { subsection: "third" }), { onLockWait: () => assert.fail("thrown from the notice"), lock: { waitingAfterMs: 20, maxWaitMs: 5_000 } });
    await sleep(150);
    again.release();
    assert.equal((await noisy).subsection, "third");
    // ⚠️ THE DEFAULT IS ONE SECOND, which is what the tool gets: it passes no threshold of its own.
    const last = p.hold();
    let told = 0;
    const defaulted = withLock(p.lock, () => "taken", { onWaiting: () => told++ });
    await sleep(700);
    assert.equal(told, 0, "the default notice came before a second of contention");
    await sleep(600);
    assert.equal(told, 1, "the default notice did not come after a second of contention");
    last.release();
    assert.equal(await defaulted, "taken");
  } finally {
    rmSync(p.lock, { force: true });
    p.remove();
  }
});

/* ------------------------------------------------------------------ cancellation */

test("⚠️ #179 a caller cancelled before it starts, or while it waits for the lock, writes nothing and takes no lock", async () => {
  const p = project();
  try {
    const already = new AbortController();
    already.abort();
    await refused(p, append(p, { signal: already.signal }), STAGE_DOCUMENT_REFUSAL.WRITE_CANCELLED);

    const held = p.hold();
    const waiting = new AbortController();
    const started = Date.now();
    setTimeout(() => waiting.abort(), 150);
    await refused(p, append(p, { signal: waiting.signal }), STAGE_DOCUMENT_REFUSAL.WRITE_CANCELLED, { lockHeld: true });
    const took = Date.now() - started;
    assert.ok(took >= 140 && took < 2_000, `cancelling a lock wait took ${took} ms against a 10-second bound`);
    assert.equal(readFileSync(p.lock, "utf-8"), held.record);
  } finally {
    rmSync(p.lock, { force: true });
    p.remove();
  }
});

test("⚠️ #179 cancelled after the temporary file is written and before the rename: the file is removed and nothing is committed", async () => {
  const p = project();
  try {
    const controller = new AbortController();
    let renames = 0;
    // The cancellation arrives while the temporary file is being written: synchronous code, so it is delivered
    // only when the writer next lets the event loop turn.
    const run = withFs("writeFileSync", (path) => String(path).endsWith(TEMP_SUFFIX), (_n, real) => {
      const result = real();
      setImmediate(() => controller.abort());
      return result;
    }, () => withFs("renameSync", (_from, to) => to === p.doc, (n, real) => (renames++, real()), () => refused(p, append(p, { signal: controller.signal }), STAGE_DOCUMENT_REFUSAL.WRITE_CANCELLED)));
    await run;
    assert.equal(renames, 0, "the rename was attempted after the cancellation");
  } finally {
    p.remove();
  }
});

test("⚠️ #179 cancelled while the rename is being retried: ended at once, temporary file removed, nothing committed", async () => {
  const p = project();
  try {
    const controller = new AbortController();
    const started = Date.now();
    let cancelledAt = null;
    await refusingRename(p, "EPERM", Infinity, async (calls) => {
      setTimeout(() => ((cancelledAt = Date.now()), controller.abort()), 200);
      await refused(p, append(p, { signal: controller.signal }), STAGE_DOCUMENT_REFUSAL.WRITE_CANCELLED);
      assert.ok(calls.count >= 2, "the rename was not being retried when it was cancelled");
    });
    assert.ok(Date.now() - cancelledAt < 100, `the retry went on for ${Date.now() - cancelledAt} ms after the cancellation`);
    assert.ok(Date.now() - started < 1_500);
  } finally {
    p.remove();
  }
});

test("⚠️ #179 once the rename has happened the write is committed and reported as written, whatever the signal says after", async () => {
  const p = project();
  try {
    const controller = new AbortController();
    // The cancellation lands in the same instant the rename returns: there is no later point to refuse at.
    const written = await withFs("renameSync", (_from, to) => to === p.doc, (_n, real) => {
      const result = real();
      controller.abort();
      return result;
    }, () => append(p, { signal: controller.signal }));
    assert.equal(written.subsection, "blocked");
    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(readWorkingNotes(p.root, STAGE).subsections.map((s) => s.name), ["blocked"]);
    assert.equal(readWorkingNotes(p.root, STAGE).revision, written.revision);
    assert.deepEqual([p.temps(), existsSync(p.lock)], [[], false]);
  } finally {
    p.remove();
  }
});

/* ------------------------------------------------------------------ the rename */

test("⚠️ #179 a rename refused past the old 275 ms budget still commits, inside the stage document's two seconds", async () => {
  const p = project();
  try {
    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
      const started = Date.now();
      // 15 refusals: 5 ms x (1 + ... + 15) = 600 ms of backoff, more than twice the default budget.
      const written = await refusingRename(p, code, 15, () => writeWorkingNotes(p.root, STAGE, note(p, { subsection: `after-${code.toLowerCase()}` })));
      assert.equal(written.subsection, `after-${code.toLowerCase()}`);
      assert.ok(Date.now() - started >= 550, "the refusals were not waited out");
      assert.deepEqual([p.temps(), existsSync(p.lock)], [[], false]);
    }
    assert.equal(readWorkingNotes(p.root, STAGE).subsections.length, 3);
  } finally {
    p.remove();
  }
});

test("⚠️ #179 a document another program holds for the whole budget is stage-document-write-contended, after about two seconds", async () => {
  const p = project();
  try {
    const started = Date.now();
    await refusingRename(p, "EPERM", Infinity, async (calls) => {
      await refused(p, append(p), STAGE_DOCUMENT_REFUSAL.WRITE_CONTENDED);
      assert.equal(calls.count, 29, "the stage document's rename budget is not 28 retries");
    });
    const took = Date.now() - started;
    assert.ok(took >= 1_900 && took < 6_000, `the budget was ${took} ms`);
  } finally {
    p.remove();
  }
});

test("⚠️ #179 a filesystem failure that retrying cannot help is stage-document-write-failed, at once", async () => {
  const p = project();
  try {
    for (const code of ["ENOSPC", "EIO", "EROFS"]) {
      const started = Date.now();
      await refusingRename(p, code, Infinity, async (calls) => {
        await refused(p, append(p), STAGE_DOCUMENT_REFUSAL.WRITE_FAILED);
        assert.equal(calls.count, 1, `${code} was retried`);
      });
      assert.ok(Date.now() - started < 1_000);
    }
    // The temporary file itself could not be written: the same code, and the file is not left half made.
    await withFs("writeFileSync", (path) => String(path).endsWith(TEMP_SUFFIX), (_n, real) => {
      real();
      throw fsError("ENOSPC", "write");
    }, () => refused(p, append(p), STAGE_DOCUMENT_REFUSAL.WRITE_FAILED));
    // And a failure that is not the filesystem's is not renamed into one.
    await assert.rejects(withFs("writeFileSync", (path) => String(path).endsWith(TEMP_SUFFIX), () => {
      throw new TypeError("a defect, not a disk");
    }, () => append(p)), TypeError);
    assert.deepEqual([p.temps(), existsSync(p.lock)], [[], false]);
  } finally {
    p.remove();
  }
});

/* ------------------------------------------------------------------ what was not changed for everyone else */

test("⚠️ #179 the atomic writer's own default budget and the lock's own errors are as they were, with a code added", async () => {
  const p = project();
  try {
    const target = p.doc;
    const before = p.bytes();
    const started = Date.now();
    const error = await refusingRename(p, "EPERM", Infinity, (calls) =>
      atomicWrite(target, "replaced").then(
        () => assert.fail("written"),
        (e) => (assert.equal(calls.count, 11, "the default is no longer ten retries"), e)
      )
    );
    assert.ok(error instanceof AtomicWriteError);
    assert.equal(error.code, ATOMIC_WRITE_REFUSAL.CONTENDED);
    assert.match(error.message, /^Atomic write failed after 11 attempt\(s\): EPERM -> /);
    assert.ok(Date.now() - started < 1_500, "the default budget grew");
    assert.equal((await refusingRename(p, "ENOSPC", Infinity, () => atomicWrite(target, "replaced").catch((e) => e))).code, ATOMIC_WRITE_REFUSAL.FAILED);
    const aborted = new AbortController();
    aborted.abort();
    assert.equal((await atomicWrite(target, "replaced", { signal: aborted.signal }).catch((e) => e)).code, ATOMIC_WRITE_REFUSAL.CANCELLED);
    assert.deepEqual([p.bytes(), p.temps()], [before, []]);
    assert.deepEqual(await atomicWrite(join(p.root, "plain.txt"), "written"), { renameRetries: 0 });

    p.hold();
    const timeout = await withLock(p.lock, () => "taken", { maxWaitMs: 60 }).catch((e) => e);
    assert.ok(timeout instanceof LockError);
    assert.equal(timeout.code, LOCK_REFUSAL.TIMEOUT);
    assert.match(timeout.message, /^Timed out after 60ms waiting for /);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    assert.equal((await withLock(p.lock, () => "taken", { signal: controller.signal }).catch((e) => e)).code, LOCK_REFUSAL.CANCELLED);
    rmSync(p.lock);
    // A lock that is free is taken by a caller with a live signal, and a signal that aborts while `fn` runs is `fn`'s.
    const running = new AbortController();
    assert.equal(await withLock(p.lock, () => (running.abort(), "ran to the end"), { signal: running.signal }), "ran to the end");
    assert.equal(existsSync(p.lock), false);
    assert.equal((await withLock(p.lock, () => withLock(p.lock, () => "nested")).catch((e) => e)).code, null);
  } finally {
    rmSync(p.lock, { force: true });
    p.remove();
  }
});

/* ------------------------------------------------------------------ the tool */

/** The registered tool, run with planning content at `p.root`. */
async function tool(p, params, { signal, onUpdate } = {}) {
  const tools = new Map();
  register({ registerTool: (t) => tools.set(t.name, t), on: () => {} }, { toolRoot: ROOT });
  const saved = process.env.PLANNING_CONTENT_DIR;
  process.env.PLANNING_CONTENT_DIR = p.root;
  try {
    const result = await tools.get("kiln_write_stage_document").execute("call-1", params, signal, onUpdate, {});
    return { result, body: JSON.parse(result.content[0].text) };
  } finally {
    if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved;
  }
}

test("⚠️ #179 the tool returns the stable code, relative path and lock, and retry guidance, and nothing of the machine", async () => {
  const p = project();
  try {
    const updates = [];
    const onUpdate = (update) => updates.push(update);
    const params = { stage: STAGE, ...note(p) };

    // Cancelled: Pi's own signal reaches the writer.
    const cancelled = new AbortController();
    cancelled.abort();
    const first = await tool(p, params, { signal: cancelled.signal, onUpdate });
    assert.deepEqual(first.body, {
      ok: false,
      code: "stage-document-write-cancelled",
      message: "The write was cancelled before it was committed. Nothing was written.",
      path: `stages/${STAGE}.md`,
      lock: LOCK,
      retry: "Retry only if the operator asks for it.",
    });
    assert.deepEqual(first.result.details, first.body);

    // Contended and failed, through the same handler.
    const contended = await refusingRename(p, "EBUSY", Infinity, () => tool(p, params, { signal: new AbortController().signal, onUpdate }));
    assert.deepEqual([contended.body.ok, contended.body.code, contended.body.path, contended.body.lock], [false, "stage-document-write-contended", `stages/${STAGE}.md`, LOCK]);
    const failed = await refusingRename(p, "EIO", Infinity, () => tool(p, { stage: STAGE, verbatim: "an answer", interpretation: "a reading" }, { onUpdate }));
    assert.deepEqual([failed.body.ok, failed.body.code, failed.body.path, failed.body.lock], [false, "stage-document-write-failed", `stages/${STAGE}.md`, LOCK]);

    for (const { result } of [first, contended, failed]) {
      const text = JSON.stringify(result);
      for (const absent of [p.root, p.root.replaceAll("\\", "/"), p.root.replaceAll("\\", "\\\\"), homedir(), hostname(), "EBUSY", "EIO", "<path>"]) assert.ok(!text.includes(absent), `the result says ${absent}`);
    }
    // ⚠️ SILENT UNLESS THE LOCK IS CONTENDED: none of these waited on a lock, and none sent an update.
    const written = await tool(p, params, { signal: new AbortController().signal, onUpdate });
    assert.equal(written.body.ok, true);
    assert.deepEqual(updates, []);
    assert.deepEqual([p.temps(), existsSync(p.lock)], [[], false]);
    // A refusal about the request keeps its own shape: no lock or retry fields are invented for it.
    const stale = await tool(p, params, { onUpdate });
    assert.deepEqual(Object.keys(stale.body), ["ok", "code", "message"]);
    assert.equal(stale.body.code, "stage-document-revision-conflict");
  } finally {
    p.remove();
  }
});
