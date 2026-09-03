/**
 * The setup transaction — CMP-0022, against ACC-0044 and ACC-0096/0097/0098/0099.
 *
 * ⚠️ **WHAT THIS COMPONENT IS FOR: SETUP TOUCHES MORE THAN ONE FILE.** The content scaffold,
 * `.gitignore`, `.pi/settings.json`, `.pi/kiln.json` and the local state root all move in one
 * command, so a second process interleaving between two of them leaves a project configured by two
 * writers that each believed they held it. One lock, one plan, one journal.
 *
 * ⚠️ **THESE ARE THE PRIMITIVE'S CRITERIA, NOT THE COMMAND'S.** ACC-0043 and ACC-0045 describe
 * `setup` end to end — every file it owns, and an operator actually running the recorded resume
 * command — and they belong to TSK-0060, which composes it. What a test at this level can hold is
 * that the primitive underneath behaves: bytes, containment, refusals, and the journal's lifecycle.
 * Asserting the command's criteria against two synthetic JSON files would be an overclaim.
 *
 * ⚠️ **EVERY ASSERTION IS OVER THE FILESYSTEM, NOT OVER A RETURNED STATUS.** A transaction that
 * reports "no changes" while rewriting identical bytes has still churned the working tree; one that
 * reports a refusal after creating a directory has still changed the project.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import {
  REFUSAL,
  SETUP_LOCK_FILE,
  SetupRefusal,
  planTransaction,
  transactionState,
  removeJournalFile,
  removeOrReport,
  runTransaction,
  runWithTransaction,
} from "../lib/setup-transaction.mjs";
import { createRuntimeValidators, assertValidRecord } from "../lib/runtime-records.mjs";

const validators = createRuntimeValidators();
const validateJournal = (record) => assertValidRecord(validators, "setup-transaction", record, "setup journal");

/** ⚠️ `realpathSync` because macOS puts `/var` behind a symlink: the transaction canonicalises its
 *  roots, so a fixture that did not would be comparing a canonical path against a spelled one. */
function scratch() {
  return realpathSync(mkdtempSync(join(tmpdir(), "kiln-tx-")));
}
function project({ pi = true } = {}) {
  const dir = scratch();
  if (pi) mkdirSync(join(dir, ".pi"), { recursive: true });
  return dir;
}
const read = (root, rel) => readFileSync(join(root, rel), "utf-8");
const settings = (o) => JSON.stringify(o, null, 2) + "\n";
const noop = async () => {};

/** Every path under `dir`, root-relative and sorted — the whole tree, so nothing hides. */
function tree(dir) {
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = join(d, e.name);
      return e.isDirectory() ? [p, ...walk(p)] : [p];
    });
  return walk(dir)
    .map((p) => relative(dir, p).split(sep).join("/"))
    .sort();
}

const DIR_LINK = process.platform === "win32" ? "junction" : "dir";

/**
 * ⚠️ **DIRECTORY LINKS AND FILE LINKS ARE DIFFERENT PRIVILEGES ON WINDOWS.** A junction needs none,
 * which is why the directory case above runs everywhere and is the realistic Windows escape. A file
 * symlink needs Developer Mode or elevation, so an unprivileged process cannot lay the trap in the
 * first place — and cannot exercise the test for it either. Probed rather than assumed from the
 * platform, because a developer-mode machine and CI can differ.
 */
const CAN_FILE_SYMLINK = (() => {
  const d = mkdtempSync(join(tmpdir(), "kiln-lnk-"));
  try {
    writeFileSync(join(d, "t"), "x");
    symlinkSync(join(d, "t"), join(d, "l"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();

/* ============================================== containment is canonical, not lexical ========== */

test("a junction or symlink on a target's path is a write OUTSIDE the project, and refuses", async () => {
  const root = project({ pi: false });
  const outside = scratch();
  try {
    // ⚠️ THE WHOLE POINT: `.pi/settings.json` spells innocently. `relative()` and `resolve()` see a
    // path one level inside the project; the filesystem sees a path in another directory entirely.
    symlinkSync(outside, join(root, ".pi"), DIR_LINK);

    await assert.rejects(
      () => runTransaction({ projectRoot: root, files: [{ path: ".pi/settings.json" }] }, noop),
      // ⚠️ THE CANONICAL PATH IS ASSERTED, not just the refusal code. A lexical check refuses
      // `../x` with the same code, so a test that only matched the code would still pass against
      // the very implementation this exists to rule out.
      (e) =>
        e instanceof SetupRefusal &&
        e.reason === REFUSAL.PATH_ESCAPE &&
        e.detail.canonical === join(outside, "settings.json"),
      "a linked parent directory must refuse, on the evidence of where it actually resolves"
    );
    assert.deepEqual(tree(outside), [], "nothing may be written through the link — not even a probe");
  } finally {
    rmSync(join(root, ".pi"), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlinked FILE inside a real directory refuses too", async (t) => {
  if (!CAN_FILE_SYMLINK)
    return t.skip("this process cannot create a file symlink, so it cannot lay this trap either");
  const root = project();
  const outside = scratch();
  try {
    const theirs = join(outside, "settings.json");
    writeFileSync(theirs, settings({ theirs: true }));
    symlinkSync(theirs, join(root, ".pi", "settings.json"), "file");

    await assert.rejects(
      () => runTransaction({ projectRoot: root, files: [{ path: ".pi/settings.json" }] }, noop),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.PATH_ESCAPE && e.detail.canonical === theirs
    );
    assert.deepEqual(JSON.parse(readFileSync(theirs, "utf-8")), { theirs: true }, "their file is untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("lexical escapes, unauthorized roots and the lock itself all refuse", async () => {
  const root = project();
  try {
    const refuses = (path, why) =>
      assert.rejects(
        () => runTransaction({ projectRoot: root, files: [{ path }] }, noop),
        (e) => e instanceof SetupRefusal && e.reason === REFUSAL.PATH_ESCAPE,
        why
      );

    await refuses("../escape.json", "a relative escape");
    await refuses(join(tmpdir(), "elsewhere.json"), "an absolute path");
    // ⚠️ NO DEFAULT STATE ROOT. `state:` names a root the caller must have passed; a root that
    // defaulted to somewhere would be a boundary chosen by this module rather than by the caller.
    await refuses("state:runtime/consent.json", "a root that was never authorized");
    // ⚠️ Merging the lock would hand the transaction the file that says who owns the transaction.
    await refuses(SETUP_LOCK_FILE, "the transaction lock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an external state root outside the project is authorized only by being passed", async () => {
  const root = project();
  const stateHome = scratch();
  const stateRoot = join(stateHome, "kiln", "projects", "a".repeat(32));
  try {
    const out = await runTransaction(
      { projectRoot: root, stateRoot, files: [{ path: "state:runtime/consent.json" }] },
      async (tx) => {
        tx.declarePhases(["w"]);
        return tx.phase("w", () => tx.merge("state:runtime/consent.json", () => settings({ recordVersion: 1 })));
      }
    );

    // ⚠️ THE BOUNDARY IS "A ROOT THE CALLER NAMED", NOT "INSIDE THE PROJECT". `--local-state user`
    // puts this under %LOCALAPPDATA% or $XDG_STATE_HOME, so a project-only rule would either refuse
    // a supported mode or be quietly widened until it stopped meaning anything.
    assert.equal(out.changed, true);
    assert.ok(existsSync(join(stateRoot, "runtime", "consent.json")));
    assert.deepEqual(tree(root), [".pi"], "nothing lands in the project when the target is the state root");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
  }
});

/* ============================================== planning is a write, so it is under the lock === */

test("planning refuses unless this process demonstrably holds the lock", () => {
  const root = project();
  try {
    // ⚠️ A STRUCTURAL CHECK, NOT A COMMENT. Planning probes each parent by creating and renaming a
    // real file, so it is a write; two unlocked planners would create and delete the same
    // directories concurrently, and one of them would win the delete.
    assert.throws(
      () => planTransaction({ projectRoot: root, files: [{ path: ".pi/settings.json" }] }),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.LOCK_NOT_HELD
    );
    assert.deepEqual(tree(root), [".pi"], "a refused plan writes nothing");

    // Another process's lock is not this process's lock.
    writeFileSync(join(root, SETUP_LOCK_FILE), JSON.stringify({ pid: process.pid + 1, hostname: "elsewhere" }));
    assert.throws(
      () => planTransaction({ projectRoot: root, files: [{ path: ".pi/settings.json" }] }),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.LOCK_NOT_HELD
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plan that refuses leaves the project exactly as it was found, directories included", async () => {
  const root = project({ pi: false });
  try {
    assert.deepEqual(tree(root), [], "the fixture starts empty, or this proves nothing");

    // The first target probes `.pi/`, which does not exist and must be created to be probed. The
    // second refuses. ⚠️ AN EARLIER VERSION LEFT `.pi/` BEHIND HERE: a refusal that still changed
    // the project is not a refusal.
    await assert.rejects(
      () =>
        runTransaction({ projectRoot: root, files: [{ path: ".pi/settings.json" }, { path: "../escape.json" }] }, noop),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.PATH_ESCAPE
    );

    assert.deepEqual(tree(root), [], "no directory, probe or lock may survive a refused plan");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful run leaves no probe or temp file, and releases the lock", async () => {
  const root = project({ pi: false });
  try {
    await runTransaction({ projectRoot: root, files: [{ path: ".pi/settings.json" }] }, async (tx) => {
      tx.declarePhases(["w"]);
      await tx.phase("w", () => tx.merge(".pi/settings.json", () => settings({ a: 1 })));
    });

    // ⚠️ THE PREFLIGHT PROBE WRITES REAL FILES to prove rename-over works. One left behind is
    // indistinguishable from a crashed writer's temp file to whoever reads the directory next.
    assert.deepEqual(tree(root), [".pi", ".pi/settings.json"], "exactly the planned file, and nothing else");
    assert.equal(existsSync(join(root, SETUP_LOCK_FILE)), false, "the lock must be released");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ============================================== bytes ========================================== */

test("a merge that produces the current bytes writes nothing, and mtimes prove it", async () => {
  const root = project();
  try {
    writeFileSync(join(root, ".pi", "settings.json"), settings({ packages: ["../.planning/pi-package"] }));

    const desired = settings({ packages: ["../.planning/pi-package"], defaultModel: "gpt-5" });
    const run = () =>
      runTransaction(
        { projectRoot: root, files: [{ path: ".pi/settings.json" }, { path: ".pi/kiln.json" }] },
        async (tx) => {
          tx.declarePhases(["merge"]);
          return tx.phase("merge", async () => [
            await tx.merge(".pi/settings.json", () => desired),
            await tx.merge(".pi/kiln.json", () => settings({ recordVersion: 1 })),
          ]);
        }
      );

    const first = await run();
    assert.deepEqual(first.map((r) => r.changed), [true, true], "the first run must write both");

    // ⚠️ MTIME IS THE ASSERTION, not the returned status. A transaction that rewrites identical
    // bytes can still report "unchanged" while churning the working tree and every diff in it.
    const paths = [".pi/settings.json", ".pi/kiln.json"];
    const stamps = paths.map((p) => statSync(join(root, p)).mtimeMs);
    const before = paths.map((p) => read(root, p));

    const second = await run();
    assert.deepEqual(second.map((r) => r.changed), [false, false], "the second run must write nothing");
    assert.deepEqual(paths.map((p) => read(root, p)), before, "bytes must be identical");
    assert.deepEqual(
      paths.map((p) => statSync(join(root, p)).mtimeMs),
      stamps,
      "an unchanged rerun must not touch the files at all"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ============================================== ACC-0044 ======================================= */

test("a file edited between plan and merge refuses, and the edit survives", async () => {
  const root = project();
  try {
    writeFileSync(join(root, ".pi", "settings.json"), settings({ packages: [] }));
    const theirEdit = settings({ packages: [], theirKey: "do not lose this" });
    let planned = false;

    await assert.rejects(
      () =>
        runTransaction({ projectRoot: root, files: [{ path: ".pi/settings.json" }] }, async (tx) => {
          // The operator edits in another window after setup planned and before it merged. Inside
          // the body is the only honest place for it now that planning happens under the lock.
          planned = true;
          writeFileSync(join(root, ".pi", "settings.json"), theirEdit);
          tx.declarePhases(["merge"]);
          await tx.phase("merge", () => tx.merge(".pi/settings.json", () => settings({ packages: ["ours"] })));
        }),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.CONCURRENT_EDIT,
      "a changed identity must refuse"
    );

    assert.ok(planned, "the plan must have been built before the edit, or this proves nothing");
    assert.equal(read(root, ".pi/settings.json"), theirEdit, "the operator's edit must be intact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file that APPEARS between plan and merge refuses too", async () => {
  const root = project();
  try {
    // ⚠️ `absent` IS A RECORDED IDENTITY, not a missing one. Without that, a file created after
    // planning would be silently overwritten — the same loss as an edit, from the other direction.
    await assert.rejects(
      () =>
        runTransaction({ projectRoot: root, files: [{ path: ".pi/kiln.json" }] }, async (tx) => {
          writeFileSync(join(root, ".pi", "kiln.json"), settings({ theirs: true }));
          tx.declarePhases(["merge"]);
          await tx.phase("merge", () => tx.merge(".pi/kiln.json", () => settings({ ours: true })));
        }),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.CONCURRENT_EDIT
    );
    assert.deepEqual(JSON.parse(read(root, ".pi/kiln.json")), { theirs: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed or unknown-version file refuses at PLAN time, before anything is written", async () => {
  const root = project();
  try {
    writeFileSync(join(root, ".pi", "settings.json"), "{ not json");
    let bodyRan = false;

    const validate = (text) => {
      const doc = JSON.parse(text); // throws -> malformed
      if (doc.schemaVersion !== undefined && doc.schemaVersion !== 1)
        throw new SetupRefusal(REFUSAL.UNKNOWN_SCHEMA_VERSION, `unknown schemaVersion ${doc.schemaVersion}`);
    };
    const run = () =>
      runTransaction({ projectRoot: root, files: [{ path: ".pi/settings.json", validate }] }, async (tx) => {
        bodyRan = true;
        tx.declarePhases(["merge"]);
        await tx.phase("merge", () => tx.merge(".pi/settings.json", () => settings({ ours: true })));
      });

    // ⚠️ REFUSED AT PLAN TIME, WHERE IT COSTS NOTHING. The same refusal discovered mid-merge would
    // arrive with half the work done — and the body never running is what proves which one it was.
    await assert.rejects(run, (e) => e instanceof SetupRefusal && e.reason === REFUSAL.MALFORMED);
    assert.equal(bodyRan, false, "no phase may run before the plan is whole");
    assert.equal(read(root, ".pi/settings.json"), "{ not json", "a file setup cannot read must be left alone");

    writeFileSync(join(root, ".pi", "settings.json"), settings({ schemaVersion: 99 }));
    await assert.rejects(run, (e) => e instanceof SetupRefusal && e.reason === REFUSAL.UNKNOWN_SCHEMA_VERSION);
    assert.deepEqual(JSON.parse(read(root, ".pi/settings.json")), { schemaVersion: 99 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a target nobody planned refuses", async () => {
  const root = project();
  try {
    await assert.rejects(
      () =>
        runTransaction({ projectRoot: root, files: [{ path: ".pi/settings.json" }] }, async (tx) => {
          tx.declarePhases(["merge"]);
          // ⚠️ Every writable file is contained, validated and probed. Merging an unplanned one
          // would skip all three, which is exactly how a file gets written that nobody checked.
          await tx.phase("merge", () => tx.merge(".pi/unplanned.json", () => "{}\n"));
        }),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.UNPLANNED_TARGET
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two spellings of one file are one target, and planning both refuses", async () => {
  const root = project();
  try {
    // ⚠️ A CANONICAL LOCATION IS NOT A CANONICAL IDENTITY. Keying the plan on what the caller typed
    // let these two through as separate entries, each recording its own `before` identity — so the
    // second write would be compared against a digest taken before the first one happened.
    await assert.rejects(
      () =>
        runTransaction(
          { projectRoot: root, files: [{ path: ".pi/settings.json" }, { path: ".pi/a/../settings.json" }] },
          noop
        ),
      (e) =>
        e instanceof SetupRefusal &&
        e.reason === REFUSAL.DUPLICATE_TARGET &&
        e.detail.canonical === join(root, ".pi", "settings.json"),
      "an alias is the same file, and the refusal must say which file"
    );

    // The other half of the same rule: one spelling reaches its planned entry however it is written.
    const out = await runTransaction({ projectRoot: root, files: [{ path: ".pi/settings.json" }] }, async (tx) => {
      tx.declarePhases(["w"]);
      return tx.phase("w", () => tx.merge(".pi/a/../settings.json", () => settings({ a: 1 })));
    });
    assert.deepEqual(out, { target: "project:.pi/settings.json", changed: true }, "the key is the resolved path");
    assert.deepEqual(tree(root), [".pi", ".pi/settings.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two overlapping roots reaching one file refuses, which no key check could see", async () => {
  const root = project();
  try {
    // ⚠️ THE DEFAULT ARRANGEMENT, not an exotic one: project-local state lives at `<project>/.pi`,
    // so the two authorized roots overlap by design. These keys differ in every character and name
    // the same file.
    await assert.rejects(
      () =>
        runTransaction(
          {
            projectRoot: root,
            stateRoot: join(root, ".pi"),
            files: [{ path: ".pi/runtime/consent.json" }, { path: "state:runtime/consent.json" }],
          },
          noop
        ),
      (e) =>
        e instanceof SetupRefusal &&
        e.reason === REFUSAL.DUPLICATE_TARGET &&
        e.detail.key === "state:runtime/consent.json" &&
        e.detail.clashesWith === "project:.pi/runtime/consent.json",
      "the refusal must name both entries, since either one may be the mistake"
    );
    assert.deepEqual(tree(root), [".pi"], "and the probes it ran on the way there are gone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ============================================== cleanup failures are reported ================== */

test("removal tolerates absence and reports every other outcome", () => {
  const root = project();
  const at = (n) => join(root, n);
  try {
    // A genuinely absent path is the benign case: the thing it was asked to achieve is already true.
    assert.equal(removeOrReport(at("missing")), null);
    assert.equal(removeOrReport(at("missing"), { dir: true }), null);

    mkdirSync(at("empty"));
    assert.equal(removeOrReport(at("empty"), { dir: true }), null, "an empty directory really goes");
    assert.equal(existsSync(at("empty")), false);

    // A directory where a file was expected, and a file where a directory was: both mean something
    // is still there, so both are reported rather than silently treated as done.
    mkdirSync(at("adir"));
    assert.ok(removeOrReport(at("adir"))?.code, "unlink of a directory must be reported");
    assert.ok(existsSync(at("adir")), "and it must still be there — nothing was destroyed to succeed");

    // ⚠️ THIS CASE IS WHY THE ERROR CODE IS NOT THE ANSWER. Measured on Windows: `rmdirSync`
    // against a file throws **ENOENT** and leaves the file exactly where it was. A rule that
    // treated ENOENT as "already gone" reported a clean cleanup over a probe file still sitting in
    // the operator's project — so absence is confirmed by looking, not by trusting the syscall.
    writeFileSync(at("afile"), "x");
    assert.ok(removeOrReport(at("afile"), { dir: true })?.code, "rmdir of a file must be reported");
    assert.equal(read(root, "afile"), "x", "rmdir must not delete a file to make itself succeed");

    // ⚠️ `rmdir` RATHER THAN A RECURSIVE DELETE, so a directory something else populated between
    // the probe and the cleanup survives and is reported. Removing it would destroy that content
    // to make the cleanup look tidy.
    mkdirSync(join(at("full"), "inner"), { recursive: true });
    const left = removeOrReport(at("full"), { dir: true });
    assert.ok(left?.code, "a populated directory must be reported");
    assert.ok(existsSync(join(at("full"), "inner")), "and its contents must be untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a probe that cannot clean up says so, and keeps the refusal that caused it", async () => {
  const root = project();
  try {
    // A directory standing exactly where the probe's rename TARGET goes. Writing it fails, so the
    // probe refuses; unlinking it fails too, so the cleanup cannot restore the directory either.
    // ⚠️ BOTH FACTS ARE TRUE AT ONCE, which is the case the old `catch {}` erased: it reported the
    // write failure and said nothing about what it had left behind.
    const stuck = join(root, ".pi", `.kiln-probe.${process.pid}.target.vpw-tmp`);
    mkdirSync(stuck);

    await assert.rejects(
      () => runTransaction({ projectRoot: root, files: [{ path: ".pi/settings.json" }] }, noop),
      (e) =>
        e instanceof SetupRefusal &&
        // The original refusal is what setup stopped for, so it is what is thrown...
        e.reason === REFUSAL.NOT_WRITABLE &&
        // ...carrying the leftover beside it, in the detail AND in the message an operator reads.
        e.cleanup?.reason === REFUSAL.PROBE_NOT_REMOVED &&
        e.detail.leftovers.some((l) => l.path === stuck) &&
        e.message.includes(stuck)
    );
    assert.ok(existsSync(stuck), "the leftover is real — the refusal is not describing a hypothetical");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unwritable parent refuses before the first lasting write", async () => {
  const root = project();
  try {
    // A file where a directory must be: the probe cannot create beside it, so setup stops now
    // rather than partway through.
    writeFileSync(join(root, "blocked"), "i am a file\n");
    await assert.rejects(
      () => runTransaction({ projectRoot: root, files: [{ path: "blocked/settings.json" }] }, noop),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.NOT_WRITABLE
    );
    assert.equal(read(root, "blocked"), "i am a file\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ============================================== the journal ==================================== */

const JOURNAL = "state:runtime/setup-transaction.json";
const journalSpec = { path: JOURNAL, validate: validateJournal };

test("an interruption leaves a journal naming the phase and an exact resume command", async () => {
  const root = project();
  const stateRoot = join(root, ".pi");
  const journalPath = join(stateRoot, "runtime", "setup-transaction.json");
  try {
    await assert.rejects(() =>
      runTransaction(
        { projectRoot: root, stateRoot, files: [{ path: ".pi/settings.json" }], journal: journalSpec },
        async (tx) => {
          tx.declarePhases(["initialize", "install", "bind-model"]);
          await tx.beginJournal();
          await tx.setRecovery("node .planning/bin/setup.mjs --project-root . --resume", "interrupted during install");
          await tx.phase("initialize", () => tx.merge(".pi/settings.json", () => settings({ a: 1 })));
          await tx.phase("install", () => {
            throw new Error("network died");
          });
          await tx.phase("bind-model", () => {});
        }
      )
    );

    // ⚠️ THE JOURNAL SURVIVES A FAILURE, and its PRESENCE is the signal — it is removed on success,
    // so a lingering one would make every later start look like a recovery.
    assert.ok(existsSync(journalPath), "the journal must survive the failure");
    const j = JSON.parse(readFileSync(journalPath, "utf-8"));
    validateJournal(j);

    assert.equal(j.lastCompletedPhase, "initialize");
    assert.deepEqual(
      j.phases.map((p) => [p.name, p.status]),
      [
        ["initialize", "complete"],
        ["install", "failed"],
        ["bind-model", "pending"],
      ],
      "the whole plan is recorded, so recovery can see what was next"
    );
    assert.match(j.recovery.command, /--resume/);

    // ⚠️ THE JOURNAL DOES NOT RECORD ITSELF: its own digest changes on every flush, so an entry for
    // it would describe a file that no longer matches by the time the record lands. And each
    // identity names its ROOT, because the two roots need not be nested.
    assert.deepEqual(j.fileIdentities, [
      { root: "project", path: ".pi/settings.json", state: "present", digest: j.fileIdentities[0].digest },
    ]);
    assert.equal(read(root, ".pi/settings.json"), settings({ a: 1 }), "work that succeeded is not undone");
    assert.equal(existsSync(join(root, SETUP_LOCK_FILE)), false, "the lock is released even on failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`running` is persisted BEFORE the work, so a killed phase is distinguishable", async () => {
  const root = project();
  const stateRoot = join(root, ".pi");
  const journalPath = join(stateRoot, "runtime", "setup-transaction.json");
  try {
    let seen = null;
    await assert.rejects(() =>
      runTransaction({ projectRoot: root, stateRoot, journal: journalSpec }, async (tx) => {
        tx.declarePhases(["install"]);
        await tx.beginJournal();
        await tx.phase("install", () => {
          // What a killed process would leave behind: the journal as it stands mid-phase.
          seen = JSON.parse(readFileSync(journalPath, "utf-8"));
          throw new Error("killed");
        });
      })
    );

    // ⚠️ "NEVER STARTED" AND "MAY HAVE HALF-HAPPENED" NEED DIFFERENT RECOVERIES, and a status
    // written only on completion cannot tell them apart.
    assert.equal(seen.phases[0].status, "running", "the phase must be marked running before it runs");
    assert.equal(seen.lastCompletedPhase, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-running after an interruption completes the remaining phases and removes the journal", async () => {
  const root = project();
  const stateRoot = join(root, ".pi");
  const journalPath = join(stateRoot, "runtime", "setup-transaction.json");
  try {
    const spec = {
      projectRoot: root,
      stateRoot,
      files: [{ path: ".pi/settings.json" }, { path: ".pi/kiln.json" }],
      journal: journalSpec,
    };

    await assert.rejects(() =>
      runTransaction(spec, async (tx) => {
        tx.declarePhases(["initialize", "install"]);
        await tx.beginJournal();
        await tx.phase("initialize", () => tx.merge(".pi/settings.json", () => settings({ a: 1 })));
        await tx.phase("install", () => {
          throw new Error("network died");
        });
      })
    );
    assert.equal(JSON.parse(readFileSync(journalPath, "utf-8")).lastCompletedPhase, "initialize");

    // ⚠️ THE SECOND RUN PLANS AFRESH against what is on disk now — which is what lets the completed
    // phase be a no-op rather than a rewrite. Whether `bin/setup.mjs --resume` reads this journal
    // and reconstructs these phases is TSK-0060's to prove; this holds that the primitive allows it.
    const results = await runTransaction(
      spec,
      async (tx) => {
        tx.declarePhases(["initialize", "install"]);
        await tx.beginJournal();
        const a = await tx.phase("initialize", () => tx.merge(".pi/settings.json", () => settings({ a: 1 })));
        const b = await tx.phase("install", () => tx.merge(".pi/kiln.json", () => settings({ recordVersion: 1 })));
        return [a, b];
      },
      { operation: "resume" }
    );

    assert.equal(results[0].changed, false, "the phase that already completed must write nothing");
    assert.equal(results[1].changed, true, "the remaining phase must do its work");
    assert.equal(existsSync(journalPath), false, "the journal is removed on success");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the journal is a planned, contained target — not a path handed in at write time", async () => {
  const root = project();
  try {
    // Outside every authorized root.
    await assert.rejects(
      () => runTransaction({ projectRoot: root, journal: { path: "../elsewhere.json" } }, noop),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.PATH_ESCAPE
    );

    // Named against a root that was never passed.
    await assert.rejects(
      () => runTransaction({ projectRoot: root, journal: journalSpec }, noop),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.PATH_ESCAPE
    );

    // Journalling with no journal planned has nowhere contained to go, and says so rather than
    // falling back to a path of its own choosing.
    await assert.rejects(
      () => runTransaction({ projectRoot: root }, (tx) => tx.beginJournal()),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.UNPLANNED_TARGET
    );

    // And it is not a mergeable file: `merge` is the operator-content path, with its own semantics.
    await assert.rejects(
      () =>
        runTransaction({ projectRoot: root, stateRoot: join(root, ".pi"), journal: journalSpec }, async (tx) => {
          tx.declarePhases(["w"]);
          await tx.phase("w", () => tx.merge(JOURNAL, () => "{}\n"));
        }),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.UNPLANNED_TARGET
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record that would not validate stops the transaction instead of being written", async () => {
  const root = project();
  try {
    await assert.rejects(
      () =>
        runTransaction(
          {
            projectRoot: root,
            stateRoot: join(root, ".pi"),
            journal: {
              path: JOURNAL,
              validate: () => {
                throw new Error("schema says no");
              },
            },
          },
          (tx) => tx.beginJournal()
        ),
      /schema says no/
    );
    // ⚠️ VALIDATED BEFORE THE WRITE, not after. The journal is one of the five runtime contracts,
    // so an invalid one must not exist on disk at all — nor the directory it would have needed.
    assert.deepEqual(tree(root), [".pi"], "nothing lands, and the probe's directory is gone again");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a journal that cannot be deleted is reported, never swallowed", () => {
  const root = project();
  try {
    // ⚠️ THE ONLY BENIGN OUTCOME IS ENOENT — the thing it was asked to achieve is already true.
    removeJournalFile(join(root, "never-existed.json"));

    // Anything else means a successful setup that still LOOKS interrupted, because the journal's
    // presence IS the interruption signal. Suppressing it publishes a lie about the run's own state.
    mkdirSync(join(root, "undeletable"));
    assert.throws(
      () => removeJournalFile(join(root, "undeletable")),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.JOURNAL_NOT_REMOVED
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ============================================== the plan is printable ========================== */

test("every target is canonicalised and printable before anything is written", async () => {
  const root = project();
  const stateHome = scratch();
  const stateRoot = join(stateHome, "kiln");
  try {
    writeFileSync(join(root, ".pi", "settings.json"), settings({ a: 1 }));
    let described = null;

    await runTransaction(
      {
        projectRoot: root,
        stateRoot,
        files: [{ path: ".pi/settings.json" }, { path: ".pi/kiln.json" }],
        journal: journalSpec,
      },
      async (tx) => {
        described = tx.describe();
      }
    );

    // ⚠️ SECTION 13 REQUIRES EVERY PATH PRINTED BEFORE THE FIRST LASTING WRITE — and every target
    // names the root it is relative to, because the two roots need not be nested.
    assert.deepEqual(
      described.files.map((f) => [f.target, f.state, f.kind ?? "file"]),
      [
        ["project:.pi/settings.json", "present", "file"],
        ["project:.pi/kiln.json", "absent", "file"],
        ["state:runtime/setup-transaction.json", "absent", "journal"],
      ]
    );
    assert.match(described.files[0].digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(described.lock, join(root, SETUP_LOCK_FILE));
    assert.deepEqual(described.roots, { project: root, state: stateRoot });
    assert.ok(!described.files.some((f) => f.target.includes("\\")), "targets must not carry platform separators");
    assert.deepEqual(
      described.files.map((f) => f.absolute),
      [join(root, ".pi", "settings.json"), join(root, ".pi", "kiln.json"), join(stateRoot, "runtime", "setup-transaction.json")],
      "the absolute path is printed too — a relative one cannot be checked against the operator's intent"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
  }
});

/* ============================================== the transaction's lifetime ===================== */

/**
 * ⚠️ **A TRANSACTION IS A CAPABILITY, AND A CAPABILITY HAS A LIFETIME.** Three defects lived in the
 * gap between "this object looks right" and "this object is a live lock": an async context that
 * outlived its lock, an object literal accepted as proof of one, and a real transaction that kept
 * working after its lock was gone. Each control below writes through the gap the fix closed.
 */

test("a callback created inside the lock may take that lock later, once it is released", async () => {
  const root = project();
  try {
    // ⚠️ ASYNC ANCESTRY IS PERMANENT; A LOCK IS NOT. This continuation is REGISTERED inside the
    // transaction, so it inherits that async context and still carries it long after the lock is
    // released. Refusing it as "nested" refuses an acquisition with nothing to be nested inside.
    //
    // ⚠️ **THE REGISTRATION IS WHAT MATTERS, NOT THE CLOSURE**, and the first version of this test
    // got that wrong: it stored an arrow function and called it from the test body, which runs in
    // the TEST's context. It passed against the defect. Async context follows execution, so the
    // continuation has to be attached with `.then` from inside the body to descend from it.
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let descendant;

    await runTransaction({ projectRoot: root, files: [{ path: ".pi/a.json" }] }, async (tx) => {
      tx.declarePhases(["w"]);
      await tx.phase("w", () => tx.merge(".pi/a.json", () => settings({ a: 1 })));
      descendant = gate.then(() =>
        runTransaction({ projectRoot: root, files: [{ path: ".pi/b.json" }] }, async (t2) => {
          t2.declarePhases(["w"]);
          return t2.phase("w", () => t2.merge(".pi/b.json", () => settings({ b: 2 })));
        })
      );
    });

    assert.equal(existsSync(join(root, SETUP_LOCK_FILE)), false, "the first lock really is gone");
    release();
    const out = await descendant;
    assert.equal(out.changed, true, "a descendant context must not be refused a lock nobody holds");
    assert.deepEqual(tree(root), [".pi", ".pi/a.json", ".pi/b.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an object that merely looks like a transaction is not one", () => {
  const root = project();
  try {
    // ⚠️ THE FORGERY THAT WORKED: this literal was accepted as proof the lock was held.
    assert.equal(transactionState({ plan: { projectRoot: root } }), null);
    for (const [label, notATransaction] of [
      ["null", null],
      ["undefined", undefined],
      ["a string", "tx"],
      ["a number", 42],
      ["an empty object", {}],
      ["a null-prototype object", Object.create(null)],
      ["a plausible plan", { plan: { projectRoot: root, files: new Map() }, merge: async () => {} }],
    ])
      assert.equal(transactionState(notATransaction), null, `${label} is not a transaction`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transaction is live only inside its body, and the ledger says so", async () => {
  const root = project();
  try {
    let captured = null;
    let insideState = null;

    await runTransaction({ projectRoot: root, files: [{ path: ".pi/settings.json" }] }, async (tx) => {
      captured = tx;
      insideState = transactionState(tx);
    });

    assert.deepEqual(insideState, { projectRoot: root, active: true });
    assert.deepEqual(transactionState(captured), { projectRoot: root, active: false }, "revoked on the way out");

    // ⚠️ A RETAINED HANDLE USED TO STILL WRITE. The lockfile is gone, so this write would have had
    // no exclusion behind it at all.
    await assert.rejects(
      () => captured.merge(".pi/settings.json", () => settings({ sneaked: true })),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.TRANSACTION_REVOKED
    );
    for (const call of [
      () => captured.beginJournal(),
      () => captured.setRecovery("x"),
      () => captured.phase("w", () => {}),
    ])
      await assert.rejects(call, (e) => e.reason === REFUSAL.TRANSACTION_REVOKED, "every write path is revoked");
    assert.throws(() => captured.declarePhases(["w"]), (e) => e.reason === REFUSAL.TRANSACTION_REVOKED);

    assert.deepEqual(tree(root), [".pi"], "and nothing was written after the lock went");
    // Reads still work: reporting on a finished transaction is exactly who needs them.
    assert.equal(captured.describe().projectRoot, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a write the body never awaited is finished under the lock, and the run is reported failed", async () => {
  const root = project();
  try {
    // ⚠️ THE ROUTE REVOCATION CANNOT SEE. This operation starts while the transaction is live, so it
    // is already past the guard; without tracking, it would land after the lock was released.
    await assert.rejects(
      () =>
        runTransaction({ projectRoot: root, files: [{ path: ".pi/settings.json" }] }, async (tx) => {
          tx.merge(".pi/settings.json", () => settings({ unawaited: true })); // no await — the defect
        }),
      (e) =>
        e instanceof SetupRefusal && e.reason === REFUSAL.OPERATION_STILL_RUNNING && e.detail.pending === 1,
      "the run must be reported failed, because nobody waited to learn whether the write happened"
    );

    // It completed INSIDE the lock rather than being abandoned or allowed to cross the boundary.
    assert.equal(existsSync(join(root, SETUP_LOCK_FILE)), false);
    assert.deepEqual(JSON.parse(read(root, ".pi/settings.json")), { unawaited: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a straggler that starts another straggler is drained too", async () => {
  const root = project();
  try {
    // ⚠️ ONE SNAPSHOT IS NOT A DRAIN. The nested operation is registered while `a` is being awaited,
    // so a single `allSettled` over the operations first seen revokes and releases with it still
    // running — the same unprotected write, one level deeper.
    //
    // ⚠️ **THE ASSERTION IS ON THE LOCK'S PRESENCE, NOT ON THE FILE.** The first version of this
    // test only checked that both files existed, and it passed against a single-snapshot drain:
    // `merge` runs synchronously as far as its first `await`, so the nested write landed before
    // release either way. What separates the two is WHEN, so the nested work sleeps first and then
    // looks — with a real drain the lock is still there; without one it is long gone.
    let lockHeldWhenNestedRan = null;
    let nested;

    await assert.rejects(
      () =>
        runTransaction(
          { projectRoot: root, files: [{ path: ".pi/a.json" }, { path: ".pi/b.json" }] },
          async (tx) => {
            nested = tx
              .merge(".pi/a.json", () => settings({ a: 1 }))
              .then(() =>
                runWithTransaction(tx, "nested", async () => {
                  await new Promise((r) => setTimeout(r, 25));
                  lockHeldWhenNestedRan = existsSync(join(root, SETUP_LOCK_FILE));
                  return tx.merge(".pi/b.json", () => settings({ b: 2 }));
                })
              );
          }
        ),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.OPERATION_STILL_RUNNING && e.detail.pending === 1,
      "the count is what was running when the body returned, which is the one thing observable"
    );
    await nested.catch(() => {}); // so a failing variant reports through the assertions, not a crash

    assert.equal(lockHeldWhenNestedRan, true, "nested work must run while the lock is still held");
    assert.deepEqual(tree(root), [".pi", ".pi/a.json", ".pi/b.json"], "and it must have completed");
    assert.equal(existsSync(join(root, SETUP_LOCK_FILE)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work can only be enrolled through a real, live transaction", async () => {
  const root = project();
  try {
    let captured = null;
    let ran = false;

    await runTransaction({ projectRoot: root }, async (tx) => {
      captured = tx;
      assert.equal(await runWithTransaction(tx, "collaborator", () => "ok"), "ok");
    });

    // A forgery cannot enrol, so it cannot borrow the lock by claiming to be inside it.
    await assert.rejects(
      () => runWithTransaction({ plan: { projectRoot: root } }, "collaborator", () => (ran = true)),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.TRANSACTION_NOT_AUTHENTIC
    );
    // Neither can a genuine transaction whose run is over.
    await assert.rejects(
      () => runWithTransaction(captured, "collaborator", () => (ran = true)),
      (e) => e instanceof SetupRefusal && e.reason === REFUSAL.TRANSACTION_REVOKED
    );
    assert.equal(ran, false, "and the work must not have run either way");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
