/**
 * The local-state policy, observed — `lib/local-state.mjs` (CMP-0025, REQ-0027, ACC-0049, ACC-0050).
 *
 * ⚠️ **ACC-0049 ASKS FOR AN ABSENCE, AND THAT IS WHAT IS ASSERTED.** "The check is that the paths do
 * not exist after the refusal, not that a warning was printed" — so every refusal test looks at the
 * filesystem afterwards. A test that matched the message would pass against a version that printed
 * the refusal and then wrote the transcript anyway.
 *
 * ⚠️ **BOTH PLATFORMS ARE OBSERVED FROM EITHER ONE.** The derivation takes its platform, environment
 * and home as arguments precisely so the Windows and POSIX answers are both testable wherever this
 * runs; that is a property of the design rather than a convenience for the test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { installReaper, reapLater } from "./helpers/reap.mjs";

import {
  LocalStateRefusal,
  PROJECT_RECORD,
  STATE_MODE,
  STATE_REFUSAL,
  coverageState,
  createStateRoot,
  ensureProjectId,
  openStateRoot,
  readProjectId,
  stateRootFor,
  stateRootIdentity,
  userStateHome,
} from "../lib/local-state.mjs";
import { IGNORE_RULES, GITIGNORE_BEGIN, GITIGNORE_END, blockText } from "../lib/project-gitignore.mjs";

installReaper();

const bytes = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff));
let seed = 0;
/** Deterministic, distinct per call — so "two projects occupy separate roots" is about the id. */
const randomBytes = () => bytes(16).map((b) => (b + seed) & 0xff);

function project({ git = true } = {}) {
  const dir = reapLater(mkdtempSync(join(tmpdir(), "kiln-state-")));
  if (git) mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

const covered = (dir) => writeFileSync(join(dir, ".gitignore"), blockText("\n", IGNORE_RULES), "utf-8");
const stateDirs = (roots) => [roots.root, roots.sessions, roots.runtime];

/* ================================================================== the platform roots */

test("⚠️ the per-user home follows the convention already written down, on both platforms", () => {
  // `setup-transaction.mjs` documents `%LOCALAPPDATA%\Kiln\projects\<id>` and
  // `$XDG_STATE_HOME/kiln/projects/<id>`. A module that invented a third would make that comment
  // wrong on one platform with nothing saying so.
  assert.equal(
    userStateHome({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" } }),
    join("C:\\Users\\x\\AppData\\Local", "Kiln")
  );
  assert.equal(userStateHome({ platform: "linux", env: { XDG_STATE_HOME: "/home/x/.state" } }), join("/home/x/.state", "kiln"));
  assert.equal(userStateHome({ platform: "linux", env: {}, home: "/home/x" }), join("/home/x", ".local", "state", "kiln"));
  assert.equal(userStateHome({ platform: "darwin", env: {}, home: "/Users/x" }), join("/Users/x", ".local", "state", "kiln"));
});

test("⚠️ Windows uses LOCALAPPDATA rather than APPDATA, because state must not roam", () => {
  // APPDATA is copied between machines at logon on a domain profile, which would carry one machine's
  // transcripts and its consent record onto another — the thing consent exists to keep machine-local.
  const env = { APPDATA: "C:\\roaming", LOCALAPPDATA: "C:\\local" };
  assert.match(userStateHome({ platform: "win32", env }), /^C:\\local/);
});

test("a platform that will not say where state belongs is a refusal, not a guess", () => {
  assert.equal(userStateHome({ platform: "win32", env: {} }), null);
  assert.equal(userStateHome({ platform: "linux", env: {}, home: "" }), null);

  assert.throws(
    () => stateRootFor({ mode: STATE_MODE.USER, projectRoot: "/p", projectId: "abc", platform: "win32", env: {} }),
    (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NO_USER_STATE_HOME
  );
});

test("project mode is the project's own .pi/, and its layout is derived in one place", () => {
  // Compared through `resolve` because the module resolves: on Windows a rooted POSIX path gains a
  // drive, and a test that hardcoded the unresolved form would be asserting the platform, not the
  // layout.
  const base = resolve("/p");
  const roots = stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: "/p" });
  assert.equal(roots.mode, STATE_MODE.PROJECT);
  assert.equal(roots.root, join(base, ".pi"));
  assert.equal(roots.sessions, join(base, ".pi", "sessions"));
  assert.equal(roots.runtime, join(base, ".pi", "runtime"));
});

test("⚠️ two projects on one machine occupy separate external roots", () => {
  const env = { XDG_STATE_HOME: "/home/x/.state" };
  const a = stateRootFor({ mode: STATE_MODE.USER, projectRoot: "/a", projectId: "1111", platform: "linux", env });
  const b = stateRootFor({ mode: STATE_MODE.USER, projectRoot: "/b", projectId: "2222", platform: "linux", env });

  assert.notEqual(a.root, b.root);
  assert.equal(a.root, join("/home/x/.state", "kiln", "projects", "1111"));
  assert.equal(b.root, join("/home/x/.state", "kiln", "projects", "2222"));
});

test("⚠️ the external root is keyed by the ID, not by where the project sits", () => {
  // Deriving it from the path would move the state out from under an operator who moved or renamed
  // the project — exactly when it must not move.
  const env = { XDG_STATE_HOME: "/s" };
  const before = stateRootFor({ mode: STATE_MODE.USER, projectRoot: "/old/place", projectId: "id", platform: "linux", env });
  const after = stateRootFor({ mode: STATE_MODE.USER, projectRoot: "/somewhere/else", projectId: "id", platform: "linux", env });
  assert.equal(before.root, after.root);
});

test("external mode without a committed id refuses rather than inventing one", () => {
  assert.throws(
    () => stateRootFor({ mode: STATE_MODE.USER, projectRoot: "/p", platform: "linux", env: { XDG_STATE_HOME: "/s" } }),
    (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NO_PROJECT_ID
  );
});

test("an unknown mode is refused, and the refusal names the two that exist", () => {
  for (const mode of ["external", "project-local", "", null, undefined])
    assert.throws(
      () => stateRootFor({ mode, projectRoot: "/p" }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.UNKNOWN_MODE,
      String(mode)
    );
});

test("⚠️ deriving a root creates nothing, so setup can show both before the operator chooses", () => {
  // A derivation that created directories would leave one of the two behind whichever mode was
  // picked, and an abandoned `.pi/` on a project that then refused setup is a defect already had once.
  const dir = project();
  const roots = stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: dir });
  for (const d of stateDirs(roots)) assert.equal(existsSync(d), false, d);
});

/* ================================================================== coverage before data */

test("⚠️ with no ignore block, project-local state REFUSES and writes nothing", async () => {
  const dir = project();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");

  const result = openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT });

  assert.equal(result.ok, false);
  assert.equal(result.refusal.reason, STATE_REFUSAL.COVERAGE_MISSING);
  assert.deepEqual(result.covers.uncovered, [...IGNORE_RULES]);
  // ⚠️ THE ASSERTION ACC-0049 ASKS FOR: the paths do not exist, not that a message was produced.
  for (const d of stateDirs(result.roots)) assert.equal(existsSync(d), false, `${d} must not exist after a refusal`);
});

test("⚠️ with the block EDITED, project-local state still refuses", async () => {
  const dir = project();
  writeFileSync(join(dir, ".gitignore"), `${[GITIGNORE_BEGIN, "mine", GITIGNORE_END].join("\n")}\n`, "utf-8");

  const result = openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT });
  assert.equal(result.ok, false);
  assert.equal(result.covers.state, "edited");
  for (const d of stateDirs(result.roots)) assert.equal(existsSync(d), false, d);
});

test("⚠️ partial coverage is not coverage", async () => {
  // `.planning/` ignored and the two runtime paths not is precisely the state an older Kiln leaves,
  // and it is the one a check written as "is there a Kiln block" would pass.
  const dir = project();
  writeFileSync(join(dir, ".gitignore"), ".planning/\n", "utf-8");

  const result = openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT });
  assert.equal(result.ok, false);
  assert.deepEqual(result.covers.uncovered, [".pi/sessions/", ".pi/runtime/"]);
  for (const d of stateDirs(result.roots)) assert.equal(existsSync(d), false, d);
});

test("⚠️ a negated rule is not coverage either", async () => {
  const dir = project();
  writeFileSync(join(dir, ".gitignore"), `${IGNORE_RULES.join("\n")}\n!.pi/runtime/\n`, "utf-8");

  const result = openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT });
  assert.equal(result.ok, false);
  assert.deepEqual(result.covers.uncovered, [".pi/runtime/"]);
});

test("with the block in place, project-local state opens and the directories exist", async () => {
  const dir = project();
  covered(dir);

  const result = openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT });
  assert.equal(result.ok, true);
  assert.equal(result.roots.root, join(dir, ".pi"));
  for (const d of stateDirs(result.roots)) assert.equal(existsSync(d), true, d);
});

test("⚠️ the refusal carries the three answers, with the block's actual bytes", async () => {
  // Interactive setup renders these and non-interactive setup fails on the same object, so "offers
  // the block, external state, or stopping" and "refuses" cannot drift apart into two code paths.
  const dir = project();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");

  const { options } = openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT });
  assert.deepEqual(options.map((o) => o.id), ["add-block", "user-state", "stop"]);

  const add = options[0];
  assert.equal(add.available, true);
  assert.equal(add.block, blockText("\n", IGNORE_RULES), "the bytes, not a description of them");
});

test("⚠️ over an EDITED block, 'add the block' is offered as unavailable rather than silently", async () => {
  // Appending over one would produce the second Kiln block CMP-0023 exists to prevent. The operator
  // has to resolve the edited one first, and the option says so instead of vanishing.
  const dir = project();
  writeFileSync(join(dir, ".gitignore"), `${[GITIGNORE_BEGIN, "mine", GITIGNORE_END].join("\n")}\n`, "utf-8");

  const { options } = openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT });
  const add = options.find((o) => o.id === "add-block");
  assert.equal(add.available, false);
  assert.match(add.unavailableBecause, /edited/);
  assert.equal(options.find((o) => o.id === "user-state").available, true, "external state is still a way out");
});

test("⚠️ external mode is exempt because it is OUTSIDE the repository, not because it is safe", async () => {
  const dir = project();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8"); // no coverage at all
  const home = reapLater(mkdtempSync(join(tmpdir(), "kiln-home-")));

  const result = openStateRoot({
    projectRoot: dir,
    mode: STATE_MODE.USER,
    projectId: "abc123",
    platform: "linux",
    env: { XDG_STATE_HOME: home },
  });

  assert.equal(result.ok, true);
  assert.equal(result.covers.covered, true);
  assert.match(result.covers.reason, /outside the repository/);
  assert.equal(result.roots.root, join(home, "kiln", "projects", "abc123"));
  for (const d of stateDirs(result.roots)) assert.equal(existsSync(d), true, d);
  assert.equal(existsSync(join(dir, ".pi", "sessions")), false, "and nothing was created in the project");
});

test("a project that is not a Git repository is covered, because nothing there is tracked", async () => {
  // The one exemption that could be mistaken for a loophole. Git publishes nothing until `git init`,
  // and refusing here would block the offline case the initializer already supports.
  const dir = project({ git: false });
  const result = openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT });

  assert.equal(result.ok, true);
  assert.match(result.covers.reason, /not a Git repository/);
});

test("⚠️ coverage is asked of the FILE, not of the setup record", async () => {
  // `state/setup.json` says what Kiln did once. REQ-0027 is about what is true at the moment data is
  // written, and the two differ exactly when it matters: the operator deleted the block afterwards.
  const dir = project();
  covered(dir);
  assert.equal(openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT, create: false }).ok, true);

  writeFileSync(join(dir, ".gitignore"), "# I removed it\n", "utf-8");
  const after = openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT, recorded: "added" });
  assert.equal(after.ok, false, "a record saying `added` does not make a deleted block present");
});

/* ================================================================== the project id */

test("⚠️ the project id is minted once and never regenerated", async () => {
  const dir = project();
  const first = await ensureProjectId({ projectRoot: dir, randomBytes });
  assert.equal(first.created, true);
  assert.match(first.projectId, /^[0-9a-f]{32}$/);

  seed = 99; // a different generator answer, to prove the second call does not use it
  const second = await ensureProjectId({ projectRoot: dir, randomBytes });
  assert.equal(second.created, false);
  assert.equal(second.projectId, first.projectId, "regenerating would orphan every transcript keyed on it");
  seed = 0;
});

test("the id lands in the committed record, and the record is valid JSON with a version", async () => {
  const dir = project();
  const { projectId } = await ensureProjectId({ projectRoot: dir, randomBytes });

  const record = JSON.parse(readFileSync(join(dir, ...PROJECT_RECORD.split("/")), "utf-8"));
  assert.equal(record.projectId, projectId);
  assert.equal(Number.isInteger(record.recordVersion), true);
  assert.equal(readProjectId(dir), projectId);
});

test("⚠️ NO COMMITTED FILE HOLDS AN ABSOLUTE USER PATH", async () => {
  // ACC-0050's third clause, and it is a property of what is NOT written. The external root is
  // recomputed from the platform and the id on every run, so a clone derives its own.
  const dir = project();
  await ensureProjectId({ projectRoot: dir, randomBytes });
  const raw = readFileSync(join(dir, ...PROJECT_RECORD.split("/")), "utf-8");

  assert.equal(/[A-Za-z]:\\|\/home\/|\/Users\/|AppData|XDG_STATE_HOME/.test(raw), false, `leaked: ${raw}`);
  assert.equal(raw.includes(dir), false, "not even the project's own path");
});

test("⚠️ a damaged project record is a recovery decision, not a second identity", async () => {
  const dir = project();
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ...PROJECT_RECORD.split("/")), "{ not json", "utf-8");

  assert.throws(
    () => readProjectId(dir),
    (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.RECORD_UNREADABLE
  );
  await assert.rejects(
    () => ensureProjectId({ projectRoot: dir, randomBytes }),
    (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.RECORD_UNREADABLE
  );
});

test("a project with no record has no id, which is not an error", () => {
  assert.equal(readProjectId(project()), null);
});

test("minting an id preserves any other key the record already held", async () => {
  const dir = project();
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(
    join(dir, ...PROJECT_RECORD.split("/")),
    JSON.stringify({ recordVersion: 1, research: { provider: "tavily" } }, null, 2) + "\n",
    "utf-8"
  );

  await ensureProjectId({ projectRoot: dir, randomBytes });
  const record = JSON.parse(readFileSync(join(dir, ...PROJECT_RECORD.split("/")), "utf-8"));
  assert.deepEqual(record.research, { provider: "tavily" }, "the committed research choice survived");
  assert.match(record.projectId, /^[0-9a-f]{32}$/);
});

/* ================================================================== identity */

test("two spellings of one state root have one identity", () => {
  const dir = project();
  const roots = createStateRoot(stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: dir }));
  assert.equal(stateRootIdentity(roots.root), stateRootIdentity(join(dir, ".pi", "x", "..")));
});
