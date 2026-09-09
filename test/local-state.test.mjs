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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
  RECORD,
  projectRecordState,
  projectRecordTarget,
  readProjectId,
  stateRootFor,
  stateRootIdentity,
  userStateHome,
} from "../lib/local-state.mjs";
import { IGNORE_RULES, GITIGNORE_BEGIN, GITIGNORE_END, applyIgnoreBlock, blockText, coverage as ignoreCoverage } from "../lib/project-gitignore.mjs";
import { runTransaction } from "../lib/setup-transaction.mjs";

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

/**
 * Real ids. The first version of this file used `1111`, `id` and `abc123`, which is how it managed
 * to pass while `../../escaped` was also accepted: a test whose fixture could never be a traversal
 * cannot notice that traversals are allowed.
 */
const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

/**
 * A real setup transaction over `dir`, with the project record planned.
 *
 * ⚠️ NOT A STUB. The whole point of the corrections these tests hold is that the lease is
 * authenticated by the transaction module and the root it authorises comes from its own plan, so a
 * fake would prove the opposite of what is wanted.
 *
 * ⚠️ `stateRoot` IS PASSED EXPLICITLY, because a transaction that never named one authorises none.
 */
const withTx = (dir, body, { stateRoot, stateMode = STATE_MODE.PROJECT, files = [projectRecordTarget()] } = {}) =>
  runTransaction({ projectRoot: dir, ...(stateRoot ? { stateRoot, stateMode } : {}), files }, body);

/** The state root a project-local transaction over `dir` would authorise. */
const projectStateRoot = (dir) => join(dir, ".pi");

const covered = (dir) => writeFileSync(join(dir, ".gitignore"), blockText("\n", IGNORE_RULES), "utf-8");
const stateDirs = (roots) => [roots.root, roots.sessions, roots.runtime];

/** A complete layout at `root` — a partial one is not a layout and is refused as one. */
const layoutAt = (root, mode = STATE_MODE.USER) => ({ mode, root, within: root, sessions: join(root, "sessions"), runtime: join(root, "runtime") });

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
    () => stateRootFor({ mode: STATE_MODE.USER, projectRoot: "/p", projectId: ID_A, platform: "win32", env: {} }),
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
  // ⚠️ REAL DIRECTORIES, because the derivation now proves the root is outside the project and that
  // is a question about the filesystem. Synthetic paths like `/p` do not exist, so canonicalising
  // them yields their deepest existing ancestor — the drive root — against which everything looks
  // "inside the project". The fixture was asserting path arithmetic; the code answers about places.
  const home = reapLater(mkdtempSync(join(tmpdir(), "kiln-home-")));
  const env = { XDG_STATE_HOME: home };
  const a = stateRootFor({ mode: STATE_MODE.USER, projectRoot: project(), projectId: ID_A, platform: "linux", env });
  const b = stateRootFor({ mode: STATE_MODE.USER, projectRoot: project(), projectId: ID_B, platform: "linux", env });

  assert.notEqual(a.root, b.root);
  assert.equal(a.root, join(home, "kiln", "projects", ID_A));
  assert.equal(b.root, join(home, "kiln", "projects", ID_B));
});

test("⚠️ the external root is keyed by the ID, not by where the project sits", () => {
  // Deriving it from the path would move the state out from under an operator who moved or renamed
  // the project — exactly when it must not move.
  const env = { XDG_STATE_HOME: reapLater(mkdtempSync(join(tmpdir(), "kiln-home-"))) };
  const before = stateRootFor({ mode: STATE_MODE.USER, projectRoot: project(), projectId: ID_A, platform: "linux", env });
  const after = stateRootFor({ mode: STATE_MODE.USER, projectRoot: project(), projectId: ID_A, platform: "linux", env });
  assert.equal(before.root, after.root);
});

test("⚠️ A TRAVERSAL ID NEVER BECOMES A PATH COMPONENT", () => {
  // Reproduced before the fix: `../../escaped` is a non-empty string, and it was joined straight
  // into the external root, putting `sessions/` and `runtime/` outside `<state-home>/kiln/projects`.
  // Checked at the boundary where the id becomes a path, because a caller can supply one directly
  // without ever having gone through the record reader.
  const env = { XDG_STATE_HOME: reapLater(mkdtempSync(join(tmpdir(), "kiln-home-"))) };
  const dir = project();
  const bad = [
    "../../escaped",
    "..",
    "a/b",
    "a\\b",
    "/abs",
    "C:\\win",
    "..\\..\\escaped",
    "A".repeat(32),          // uppercase hex is not the contract
    "a".repeat(31),          // too short
    "a".repeat(33),          // too long
    "",
    "  ",
    "a".repeat(31) + "z",    // not hex
  ];
  for (const projectId of bad)
    assert.throws(
      () => stateRootFor({ mode: STATE_MODE.USER, projectRoot: dir, projectId, platform: "linux", env }),
      (e) => e instanceof LocalStateRefusal && [STATE_REFUSAL.INVALID_PROJECT_ID, STATE_REFUSAL.NO_PROJECT_ID].includes(e.reason),
      JSON.stringify(projectId)
    );

  // And the derived root for a good id really is under projects/, not merely non-throwing.
  const ok = stateRootFor({ mode: STATE_MODE.USER, projectRoot: dir, projectId: ID_A, platform: "linux", env });
  assert.equal(ok.root, join(ok.within, ID_A));
  assert.match(ok.within, /projects$/);
});

test("⚠️ EXTERNAL STATE MUST BE PROVED EXTERNAL, not assumed from the mode's name", async () => {
  // Reproduced before the fix, both ways. `XDG_STATE_HOME=".state"` produced a RELATIVE root, which
  // Pi resolves against its own working directory — the project — so transcripts landed in the
  // repository unignored while the gate reported `covered: true`. An absolute value pointing under
  // the project did the same without even looking unusual. The exemption is a claim about WHERE the
  // root is, and it was never checked.
  const dir = project();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8"); // no coverage at all

  for (const [what, env] of [
    ["a relative XDG_STATE_HOME", { XDG_STATE_HOME: ".state" }],
    ["a relative path with no separator", { XDG_STATE_HOME: "state" }],
    ["an absolute XDG_STATE_HOME under the project", { XDG_STATE_HOME: join(dir, ".state") }],
    ["the project root itself", { XDG_STATE_HOME: dir }],
  ]) {
    assert.throws(
      () => stateRootFor({ mode: STATE_MODE.USER, projectRoot: dir, projectId: ID_A, platform: "linux", env }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NOT_EXTERNAL,
      what
    );
  }

  // Windows takes the same route through a different variable.
  assert.throws(
    () => stateRootFor({ mode: STATE_MODE.USER, projectRoot: dir, projectId: ID_A, platform: "win32", env: { LOCALAPPDATA: "AppData\Local" } }),
    (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NOT_EXTERNAL
  );
});

test("⚠️ the coverage exemption re-proves it, because it is reachable on its own", () => {
  // `stateRootFor` proves this when it derives the root; `coverageState` is exported and can be
  // called directly, and an exemption that is only sound when reached through one caller is not
  // sound. It also refuses to answer at all without the root: whether external state is external is
  // a question about a location, not about a mode name.
  const dir = project();
  const home = reapLater(mkdtempSync(join(tmpdir(), "kiln-home-")));

  assert.throws(
    () => coverageState({ projectRoot: dir, mode: STATE_MODE.USER }),
    (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NOT_EXTERNAL && /without the state root/.test(e.message),
    "no root supplied"
  );
  assert.throws(
    () => coverageState({ projectRoot: dir, mode: STATE_MODE.USER, roots: layoutAt(join(dir, "inside")) }),
    (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NOT_EXTERNAL,
    "a root inside the project"
  );

  const good = coverageState({ projectRoot: dir, mode: STATE_MODE.USER, roots: layoutAt(join(home, "kiln")) });
  assert.equal(good.covered, true);
  assert.match(good.reason, /outside the repository/);
});

test("⚠️ A CHILD JUNCTION CANNOT REVERSE WHAT THE ROOT PROVED", () => {
  // Reproduced before the fix. The root is genuine — absolute, real, outside the project, everything
  // the root check asks — and its `sessions` child is a junction back into the repository. Coverage
  // reported `covered: true` while the canonical write target was inside the project. The root is
  // not where anything is written; the children are, and they redirect independently.
  const dir = project();
  const home = reapLater(mkdtempSync(join(tmpdir(), "kiln-home-")));
  const captured = join(dir, "captured");
  mkdirSync(captured, { recursive: true });

  for (const child of ["sessions", "runtime"]) {
    const root = join(home, `root-${child}`);
    mkdirSync(root, { recursive: true });
    symlinkSync(captured, join(root, child), process.platform === "win32" ? "junction" : "dir");

    assert.throws(
      () => coverageState({ projectRoot: dir, mode: STATE_MODE.USER, roots: layoutAt(root) }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NOT_EXTERNAL && new RegExp(child).test(e.message),
      `a ${child} junction into the project`
    );
  }
});

test("⚠️ a child that leaves its own external root is refused even when it lands nowhere near the project", () => {
  // "Inside the root" and "outside the project" are asked separately because neither implies the
  // other. This is the first without the second: somewhere else entirely, still not the location
  // Kiln checked.
  const dir = project();
  const home = reapLater(mkdtempSync(join(tmpdir(), "kiln-home-")));
  const elsewhere = reapLater(mkdtempSync(join(tmpdir(), "kiln-elsewhere-")));
  const root = join(home, "root");
  mkdirSync(root, { recursive: true });
  symlinkSync(elsewhere, join(root, "sessions"), process.platform === "win32" ? "junction" : "dir");

  assert.throws(
    () => coverageState({ projectRoot: dir, mode: STATE_MODE.USER, roots: layoutAt(root) }),
    (e) => e instanceof LocalStateRefusal && /outside the state root/.test(e.message)
  );
});

test("⚠️ a project the external root would write INTO is caught, which the root check alone cannot see", () => {
  // The case that makes both directions necessary, and it took a correction to state properly: a
  // root at `<home>` with the project at `<home>/proj` is NOT this case — the children are siblings
  // of the project and the code rightly allows it. The hazard is a project sitting exactly where a
  // child would be written. The root satisfies "not inside the project" because it is the project's
  // PARENT, and `sessions` then resolves onto the project itself.
  const home = reapLater(mkdtempSync(join(tmpdir(), "kiln-home-")));
  const dir = join(home, "sessions");
  mkdirSync(join(dir, ".git"), { recursive: true });

  const layout = layoutAt(home);
  assert.equal(layout.sessions, dir, "the fixture is only meaningful if the child IS the project");
  assert.throws(
    () => coverageState({ projectRoot: dir, mode: STATE_MODE.USER, roots: layout }),
    (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NOT_EXTERNAL
  );

  // And the sibling arrangement it is often confused with is genuinely fine.
  const sibling = join(home, "proj");
  mkdirSync(join(sibling, ".git"), { recursive: true });
  assert.equal(coverageState({ projectRoot: sibling, mode: STATE_MODE.USER, roots: layoutAt(home) }).covered, true);
});

test("⚠️ A REDIRECT THAT STAYS INSIDE THE REPOSITORY IS STILL A REDIRECT", () => {
  // Containment was the wrong question. `.pi/sessions` junctioned to `<project>/captured` never
  // leaves the repository and passed it — while the ignore rule that makes the gate meaningful is
  // `.pi/sessions/`, which protects nothing at `captured/`. Coverage proves that SPECIFIC paths are
  // ignored, so the writes have to land on those paths, not merely nearby.
  const dir = project();
  covered(dir);
  mkdirSync(join(dir, "captured"), { recursive: true });
  const roots = stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: dir });
  mkdirSync(roots.root, { recursive: true });
  symlinkSync(join(dir, "captured"), roots.sessions, process.platform === "win32" ? "junction" : "dir");

  assert.throws(
    () => coverageState({ projectRoot: dir, mode: STATE_MODE.PROJECT, roots }),
    (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.ESCAPES_ROOT && /captured/.test(e.message)
  );
});

test("⚠️ a caller-supplied project layout pointing anywhere else in the repository is refused", () => {
  // The same rule reached without a link: the layout simply names a different in-repository
  // directory. `.gitignore` ignores every rule Kiln writes and protects none of this.
  const dir = project();
  covered(dir);
  const real = stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: dir });

  for (const [what, roots] of [
    ["sessions elsewhere", { ...real, sessions: join(dir, "elsewhere") }],
    ["runtime elsewhere", { ...real, runtime: join(dir, "docs") }],
    ["a different state root", { ...real, root: join(dir, "state") }],
  ])
    assert.throws(
      () => coverageState({ projectRoot: dir, mode: STATE_MODE.PROJECT, roots }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.ESCAPES_ROOT,
      what
    );

  assert.equal(coverageState({ projectRoot: dir, mode: STATE_MODE.PROJECT, roots: real }).covered, true, "the real layout still passes");
});

test("⚠️ MATCHING TYPOS PASS THE BINDING AND MUST STILL BE REFUSED", () => {
  // Binding the two values closes a disagreement between them and says nothing about whether either
  // is a mode: the same misspelling in both passed the binding and fell through to the project
  // branch, returning `covered: true` and echoing the unrecognised mode back as though it meant
  // something. The supervisor route happens to be protected because `stateRootFor` refuses first —
  // an exported function is not sound because of where its callers happen to check.
  //
  // This is the third place the vocabulary check was needed, after `createStateRoot`. The shape is
  // what recurs: branches written as "external" and "everything else" answer an unknown mode with
  // the second one.
  const dir = project();
  covered(dir);
  const real = stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: dir });

  for (const typo of ["projcet", "PROJECT", "Project", " project", "user ", "anything", "", null, undefined])
    assert.throws(
      () => coverageState({ projectRoot: dir, mode: typo, roots: { ...real, mode: typo } }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.UNKNOWN_MODE,
      JSON.stringify(typo)
    );

  assert.equal(coverageState({ projectRoot: dir, mode: STATE_MODE.PROJECT, roots: real }).covered, true);
});

test("⚠️ THE COVERAGE MODE AND THE LAYOUT MODE MUST BE THE SAME MODE", () => {
  // Reproduced before the fix: `mode: "user"` with a project-mode layout applied the project
  // containment rule, passed it, and then took the external exemption — reporting the project's own
  // `.pi` directory as "external state is outside the repository". Two modes from two sources, each
  // answering half the question.
  const dir = project();
  covered(dir);
  const home = reapLater(mkdtempSync(join(tmpdir(), "kiln-home-")));
  const projectRoots = stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: dir });

  assert.throws(
    () => coverageState({ projectRoot: dir, mode: STATE_MODE.USER, roots: projectRoots }),
    (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.UNKNOWN_MODE,
    "a project layout checked as external"
  );
  assert.throws(
    () => coverageState({ projectRoot: dir, mode: STATE_MODE.PROJECT, roots: layoutAt(join(home, "kiln")) }),
    (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.UNKNOWN_MODE,
    "an external layout checked as project-local"
  );
});

test("⚠️ PROJECT MODE is proved contained at launch, not only under the setup transaction", () => {
  // The inverse rule. `createStateRoot` proves this when setup creates the directories; nothing
  // re-asked it at start, so a `.pi` junction created afterwards would send transcripts outside the
  // project that the ignore block claims to protect.
  const dir = project();
  const outside = reapLater(mkdtempSync(join(tmpdir(), "kiln-escape-")));
  covered(dir);
  symlinkSync(outside, join(dir, ".pi"), process.platform === "win32" ? "junction" : "dir");

  assert.throws(
    () => coverageState({ projectRoot: dir, mode: STATE_MODE.PROJECT }),
    (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.ESCAPES_ROOT,
    "a fully-ignoring .gitignore does not protect a directory that is not there"
  );
});

test("a layout missing a directory is refused rather than partially proved", () => {
  const dir = project();
  const home = reapLater(mkdtempSync(join(tmpdir(), "kiln-home-")));
  for (const partial of [{ root: home }, { root: home, sessions: join(home, "s") }, {}])
    assert.throws(
      () => coverageState({ projectRoot: dir, mode: STATE_MODE.USER, roots: { mode: STATE_MODE.USER, ...partial } }),
      (e) => e instanceof LocalStateRefusal,
      JSON.stringify(partial)
    );
});

test("⚠️ a link that moves the state root inside the project after setup is caught", () => {
  // Canonical, so the relationship cannot be reversed by a junction created later. A spelling
  // comparison would still read `<home>/kiln` as outside.
  const dir = project();
  const home = reapLater(mkdtempSync(join(tmpdir(), "kiln-home-")));
  const linked = join(home, "redirected");
  mkdirSync(join(dir, "inside-the-project"), { recursive: true });
  symlinkSync(join(dir, "inside-the-project"), linked, process.platform === "win32" ? "junction" : "dir");

  assert.throws(
    () => coverageState({ projectRoot: dir, mode: STATE_MODE.USER, roots: layoutAt(linked) }),
    (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NOT_EXTERNAL
  );
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

  // Deciding creates nothing; only a live lease creates.
  const decided = openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT });
  assert.equal(decided.ok, true);
  assert.equal(decided.roots.root, join(dir, ".pi"));
  for (const d of stateDirs(decided.roots)) assert.equal(existsSync(d), false, `${d} before the lease`);

  const opened = await withTx(
    dir,
    (tx) => openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT, transaction: tx }),
    { stateRoot: projectStateRoot(dir) }
  );
  for (const d of stateDirs(opened.roots)) assert.equal(existsSync(d), true, d);
});

test("⚠️ A LEASE FOR ONE PROJECT CANNOT CREATE STATE IN ANOTHER", async () => {
  // Reproduced before the fix: a live transaction for A created `B/.pi/sessions`. The lease was
  // authenticated against a `projectRoot` the caller passed and the destination came from a `roots`
  // the caller also passed — two claims from one source, agreeing with each other and with nothing.
  // The authorising root now comes out of the transaction's own ledger.
  const a = project();
  const b = project();
  covered(a);
  covered(b);
  const rootsB = stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: b });

  await withTx(a, (tx) => {
    assert.throws(
      () => createStateRoot(rootsB, { transaction: tx }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NO_LEASE
    );
  }, { stateRoot: projectStateRoot(a) });

  for (const d of stateDirs(rootsB)) assert.equal(existsSync(d), false, `${d} in the other project`);
});

test("⚠️ a transaction that planned NO state root authorises none", async () => {
  // `authorizedRoots` adds `state` only when the spec names one, and says why: there is no default
  // state root, so a spec that never mentions one cannot write to one. Creating directories under
  // such a transaction was that default arriving through a different door.
  const dir = project();
  covered(dir);
  const roots = stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: dir });

  await withTx(dir, (tx) => {
    assert.throws(
      () => createStateRoot(roots, { transaction: tx }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NO_LEASE && /authorises no state root/.test(e.message)
    );
  }); // deliberately no stateRoot

  for (const d of stateDirs(roots)) assert.equal(existsSync(d), false, d);
});

test("⚠️ an EXTERNAL root the transaction did not plan is refused", async () => {
  const dir = project();
  const home = reapLater(mkdtempSync(join(tmpdir(), "kiln-home-")));
  const ext = stateRootFor({
    mode: STATE_MODE.USER, projectRoot: dir, projectId: ID_A, platform: "linux", env: { XDG_STATE_HOME: home },
  });

  // A transaction that planned the PROJECT-local root does not thereby authorise the external one.
  await withTx(dir, (tx) => {
    assert.throws(
      () => createStateRoot(ext, { transaction: tx }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NO_LEASE
    );
  }, { stateRoot: projectStateRoot(dir) });
  assert.equal(existsSync(ext.root), false, "the external root was never created");

  // Planned explicitly, it is created — the binding is to the planned root, not a blanket refusal.
  await withTx(dir, (tx) => createStateRoot(ext, { transaction: tx }), { stateRoot: ext.root, stateMode: STATE_MODE.USER });
  for (const d of stateDirs(ext)) assert.equal(existsSync(d), true, d);
});

test("⚠️ THE MODE CANNOT BE CHANGED BY THE CALLER TO PERMIT AN ESCAPE", async () => {
  // Reproduced before the fix. `<project>/.pi` is a junction pointing outside; the transaction plans
  // that root, so the binding check passes and project mode refuses on containment. Taking the same
  // legitimate roots and changing ONE field — `mode: "project"` to `"user"` — used to turn that
  // refusal into a directory outside the project. The root was authorised the whole time; the rule
  // governing it was the caller's to rewrite, which is half an authorisation.
  const dir = project();
  covered(dir);
  const outside = reapLater(mkdtempSync(join(tmpdir(), "kiln-escape-")));
  const link = join(dir, ".pi");
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");

  const legit = stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: dir });
  const flipped = { ...legit, mode: STATE_MODE.USER };

  await withTx(dir, (tx) => {
    assert.throws(
      () => createStateRoot(legit, { transaction: tx }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.ESCAPES_ROOT,
      "project mode refuses on containment"
    );
    assert.throws(
      () => createStateRoot(flipped, { transaction: tx }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NO_LEASE && /state mode this transaction does not authorise/.test(e.message),
      "and the flipped mode is refused rather than obeyed"
    );
    // ⚠️ NO PLANNED FILES. The default fixture plans `project:.pi/kiln.json`, which through this
    // junction resolves outside the project — so the TRANSACTION refuses at plan time, correctly,
    // and the test would never reach the check it exists for.
  }, { stateRoot: link, stateMode: STATE_MODE.PROJECT, files: [] });

  assert.equal(existsSync(join(outside, "sessions")), false, "nothing was created outside the project");
});

test("⚠️ AN UNKNOWN MODE REFUSES — it does not inherit the permissive one", async () => {
  // The fail-open. Containment ran only when the mode was exactly `project`, so every other value
  // reached the branch that permits a root outside the project: `"projcet"`, `"PROJECT"`,
  // `" project"` — a one-character typo in a spec wrote transcripts outside the repository through a
  // junction. A rule shaped "if it is the strict one, be strict" grants the permissive case to every
  // value nobody thought of, which is the wrong way round for a check guarding an escape.
  //
  // The transaction keeps the value opaque by design, so this layer owns the vocabulary — and owning
  // it means validating it, not assuming the planner did.
  const unknown = ["projcet", "PROJECT", "Project", " project", "project ", "user ", "anything", "local"];

  for (const mode of unknown) {
    const dir = project();
    covered(dir);
    const outside = reapLater(mkdtempSync(join(tmpdir(), "kiln-escape-")));
    const link = join(dir, ".pi");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");

    const roots = { ...stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: dir }), mode };

    await withTx(dir, (tx) => {
      assert.throws(
        () => createStateRoot(roots, { transaction: tx }),
        (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.UNKNOWN_MODE,
        JSON.stringify(mode)
      );
    }, { stateRoot: link, stateMode: mode, files: [] });

    assert.equal(existsSync(join(outside, "sessions")), false, `${JSON.stringify(mode)}: nothing outside the project`);
  }
});

test("the two known modes are exactly the two the session schema names", () => {
  // If a third is ever added, the check above refuses it until this module is taught it — which is
  // the safe direction, and the reason the containment branch is written as "unless it is `user`".
  assert.deepEqual(Object.values(STATE_MODE).sort(), ["project", "user"]);
});

test("⚠️ a state root planned with no mode, or a mode with no root, is refused at PLAN time", async () => {
  // One without the other is a spec that has not decided, and a mode that defaulted would be a
  // policy this code chose rather than the operator — the same defect as a default state root.
  const dir = project();

  await assert.rejects(
    () => runTransaction({ projectRoot: dir, stateRoot: projectStateRoot(dir) }, () => {}),
    (e) => /names no stateMode/.test(String(e.message))
  );
  await assert.rejects(
    () => runTransaction({ projectRoot: dir, stateMode: STATE_MODE.PROJECT }, () => {}),
    (e) => /no stateRoot/.test(String(e.message))
  );
});

test("⚠️ a root that matches but SUBDIRECTORIES that escape are still refused", async () => {
  // The equality check binds `roots.root` to the planned root; it says nothing about `sessions` and
  // `runtime`, which are fields on the same caller-supplied object. Containment against the
  // AUTHENTICATED root is what covers those, and this is the case that proves it: the root is
  // exactly what the transaction planned, so the binding check passes, and only the containment
  // check stands between a caller and a transcript directory outside the project.
  const dir = project();
  covered(dir);
  const outside = reapLater(mkdtempSync(join(tmpdir(), "kiln-escape-")));
  const root = projectStateRoot(dir);

  const forged = {
    mode: STATE_MODE.PROJECT,
    root,                                   // exactly the planned root
    // ⚠️ A `within` THAT GENUINELY CONTAINS BOTH. `resolve("/")` looked permissive and was not: on
    // Windows it is the CWD's drive root, and the temp directory is often on another, so a version
    // consulting `within` would have refused for a reason that had nothing to do with the rule. The
    // common ancestor of the project and the escape is what makes this fixture actually permissive.
    within: tmpdir(),
    sessions: join(outside, "sessions"),    // but these are somewhere else entirely
    runtime: join(outside, "runtime"),
  };

  await withTx(dir, (tx) => {
    assert.throws(
      () => createStateRoot(forged, { transaction: tx }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.ESCAPES_ROOT
    );
  }, { stateRoot: root });

  assert.equal(existsSync(join(outside, "sessions")), false, "nothing was created outside the project");
  assert.equal(existsSync(join(outside, "runtime")), false);
});

test("⚠️ the caller's own `within` no longer authorises anything", async () => {
  // The old check compared the destination against a `within` field on the same caller-supplied
  // object. Widening it to the filesystem root used to authorise everything; now it authorises
  // nothing, because containment is proved against the transaction's root instead.
  const dir = project();
  const other = project();
  covered(dir);
  const forged = { ...stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: other }), within: resolve("/") };

  await withTx(dir, (tx) => {
    assert.throws(
      () => createStateRoot(forged, { transaction: tx }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NO_LEASE
    );
  }, { stateRoot: projectStateRoot(dir) });
  assert.equal(existsSync(join(other, ".pi", "sessions")), false);
});

test("⚠️ creating a state root WITHOUT a lease is refused, and creates nothing", async () => {
  // An earlier version created directories with a bare recursive mkdir, outside the one place that
  // owns the project lock. A directory made beside the transaction is made with no exclusion at all.
  const dir = project();
  covered(dir);
  const roots = stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: dir });

  for (const bogus of [undefined, null, {}, { plan: { projectRoot: dir } }])
    assert.throws(
      () => createStateRoot(roots, { transaction: bogus }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NO_LEASE,
      String(bogus)
    );
  for (const d of stateDirs(roots)) assert.equal(existsSync(d), false, d);
});

test("⚠️ a FINISHED transaction is not a held lock, and a transaction on another project is not one either", async () => {
  const dir = project();
  const other = project();
  covered(dir);
  const roots = stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: dir });

  const expired = await withTx(dir, (tx) => tx, { stateRoot: projectStateRoot(dir) });
  assert.throws(
    () => createStateRoot(roots, { transaction: expired }),
    (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NO_LEASE
  );

  await withTx(other, (tx) => {
    assert.throws(
      () => createStateRoot(roots, { transaction: tx }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NO_LEASE
    );
  }, { stateRoot: projectStateRoot(other) });
  for (const d of stateDirs(roots)) assert.equal(existsSync(d), false, d);
});

test("⚠️ a state root that RESOLVES outside its authorising root is refused", async () => {
  // The junction case, expressed as the thing a junction actually does: `.pi` names a place outside
  // the project. `mkdirSync(recursive)` follows it without complaint, which is how `sessions/` and
  // `runtime/` were created outside the project and reported as success.
  const dir = project();
  covered(dir);
  const outside = reapLater(mkdtempSync(join(tmpdir(), "kiln-escape-")));

  // ⚠️ THE ESCAPED ROOT DOES NOT EXIST YET, and that is what makes this a control on the check that
  // runs BEFORE the mkdir. Pointed at a directory that already exists, a version checking only
  // afterwards still throws — on the root, before reaching `sessions` — and looks identical. Pointed
  // at one that does not, a post-hoc check creates it and then complains.
  const escapedRoot = join(outside, "redirected");
  const escaped = { mode: STATE_MODE.PROJECT, root: escapedRoot, within: dir,
                    sessions: join(escapedRoot, "sessions"), runtime: join(escapedRoot, "runtime") };

  // ⚠️ THE TRANSACTION PLANS THE ESCAPED ROOT ITSELF, so this is not the binding check firing by
  // accident. Equality with the planned root is satisfied; what refuses is project-local state
  // resolving outside the transaction's project, which is the junction case stated as a place.
  await withTx(dir, (tx) => {
    assert.throws(
      () => createStateRoot(escaped, { transaction: tx }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.ESCAPES_ROOT
    );
  }, { stateRoot: escapedRoot });
  assert.equal(existsSync(escapedRoot), false, "the escaped root was never created, not created and then refused");
  assert.equal(existsSync(join(escapedRoot, "sessions")), false, "nothing was created outside the project");
});

test("⚠️ the refusal carries the three answers, with the block's actual bytes", async () => {
  // Interactive setup renders these and non-interactive setup fails on the same object, so "offers
  // the block, external state, or stopping" and "refuses" cannot drift apart into two code paths.
  const dir = project();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");

  const { options } = openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT });
  assert.deepEqual(options.map((o) => o.id), ["fix-ignore", "user-state", "stop"]);

  const fix = options[0];
  assert.equal(fix.available, true);
  assert.equal(fix.action, "append");
  assert.equal(fix.replaces, false);
  assert.equal(fix.block, blockText("\n", IGNORE_RULES), "the bytes, not a description of them");
});

test("⚠️ over an exact LEGACY block the option is a MIGRATION, and applying it leaves one block", async () => {
  // The defect: always offering "add the block" with freshly composed bytes. For a legacy block that
  // is the wrong operation twice over — it needs its markers replaced in place, and appending beside
  // it produces the duplicate CMP-0023 exists to prevent. The option carries the owner's own plan, so
  // integration performs the operation the owner decided on rather than re-deriving one.
  const dir = project();
  const legacy = [GITIGNORE_BEGIN, ".planning/", GITIGNORE_END].join("\n") + "\n";
  writeFileSync(join(dir, ".gitignore"), `head\n${legacy}tail\n`, "utf-8");

  const { options } = openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT });
  const fix = options[0];
  assert.equal(fix.action, "migrate", "not an append");
  assert.equal(fix.replaces, true);
  assert.equal(fix.available, true);

  const applied = await applyIgnoreBlock(fix.plan);
  assert.equal(applied.changed, true);
  const text = readFileSync(join(dir, ".gitignore"), "utf-8");
  assert.equal(text.split(/\r?\n/).filter((l) => l.trim() === GITIGNORE_BEGIN).length, 1, "exactly one block");
  assert.deepEqual(ignoreCoverage(text).uncovered, []);
  assert.equal(openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT }).ok, true, "and the gate now opens");
});

test("⚠️ over an EDITED block, 'add the block' is offered as unavailable rather than silently", async () => {
  // Appending over one would produce the second Kiln block CMP-0023 exists to prevent. The operator
  // has to resolve the edited one first, and the option says so instead of vanishing.
  const dir = project();
  writeFileSync(join(dir, ".gitignore"), `${[GITIGNORE_BEGIN, "mine", GITIGNORE_END].join("\n")}\n`, "utf-8");

  const { options } = openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT });
  const fix = options.find((o) => o.id === "fix-ignore");
  assert.equal(fix.available, false);
  assert.equal(fix.action, "report");
  assert.equal(fix.requiresChoice, true, "CMP-0023 requires the operator to decide about their block");
  assert.deepEqual(fix.choices, ["keep", "rewrite"]);
  assert.match(fix.unavailableBecause, /edited/);
  assert.equal(options.find((o) => o.id === "user-state").available, true, "external state is still a way out");
});

test("⚠️ external mode is exempt because it is OUTSIDE the repository, not because it is safe", async () => {
  const dir = project();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8"); // no coverage at all
  const home = reapLater(mkdtempSync(join(tmpdir(), "kiln-home-")));

  const external = stateRootFor({
    mode: STATE_MODE.USER, projectRoot: dir, projectId: ID_A, platform: "linux", env: { XDG_STATE_HOME: home },
  });
  const result = await withTx(
    dir,
    (tx) =>
      openStateRoot({
        projectRoot: dir,
        mode: STATE_MODE.USER,
        projectId: ID_A,
        platform: "linux",
        env: { XDG_STATE_HOME: home },
        transaction: tx,
      }),
    { stateRoot: external.root, stateMode: STATE_MODE.USER }
  );

  assert.equal(result.ok, true);
  assert.equal(result.covers.covered, true);
  assert.match(result.covers.reason, /outside the repository/);
  assert.equal(result.roots.root, join(home, "kiln", "projects", ID_A));
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
  assert.equal(openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT }).ok, true);

  writeFileSync(join(dir, ".gitignore"), "# I removed it\n", "utf-8");
  const after = openStateRoot({ projectRoot: dir, mode: STATE_MODE.PROJECT, recorded: "added" });
  assert.equal(after.ok, false, "a record saying `added` does not make a deleted block present");
});

/* ================================================================== the project record */

test("⚠️ the project id is minted once, and only through a live lease", async () => {
  const dir = project();

  const first = await withTx(dir, (tx) => ensureProjectId({ transaction: tx, randomBytes }));
  assert.equal(first.created, true);
  assert.match(first.projectId, /^[0-9a-f]{32}$/);

  seed = 99; // a different generator answer, to prove the second call does not reach for it
  const second = await withTx(dir, (tx) => ensureProjectId({ transaction: tx, randomBytes }));
  assert.equal(second.created, false);
  assert.equal(second.changed, false, "and nothing was rewritten");
  assert.equal(second.projectId, first.projectId, "regenerating would orphan every transcript keyed on it");
  seed = 0;
});

test("⚠️ minting an id WITHOUT a lease is refused, and writes nothing", async () => {
  // The bare `atomicWrite` this replaces claimed in a comment to re-read "under the caller's lock".
  // The API could not establish that: nothing in it took a lock or a lease.
  const dir = project();
  for (const bogus of [undefined, null, {}, { plan: { projectRoot: dir } }])
    await assert.rejects(
      () => ensureProjectId({ transaction: bogus, randomBytes }),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.NO_LEASE,
      String(bogus)
    );
  assert.equal(existsSync(join(dir, ...PROJECT_RECORD.split("/"))), false, "no record was written");
});

test("the id lands in the committed record, and the record is exactly what the schema permits", async () => {
  const dir = project();
  const { projectId } = await withTx(dir, (tx) => ensureProjectId({ transaction: tx, randomBytes }));

  const record = JSON.parse(readFileSync(join(dir, ...PROJECT_RECORD.split("/")), "utf-8"));
  assert.deepEqual(Object.keys(record).sort(), ["projectId", "recordVersion"], "nothing else is invented");
  assert.equal(record.projectId, projectId);
  assert.equal(Number.isInteger(record.recordVersion), true);
  assert.equal(readProjectId(dir), projectId);
  assert.equal(projectRecordState(dir).kind, RECORD.VALID);
});

test("⚠️ NO COMMITTED FILE HOLDS AN ABSOLUTE USER PATH", async () => {
  // ACC-0050's third clause, and it is a property of what is NOT written. The external root is
  // recomputed from the platform and the id on every run, so a clone derives its own.
  const dir = project();
  await withTx(dir, (tx) => ensureProjectId({ transaction: tx, randomBytes }));
  const raw = readFileSync(join(dir, ...PROJECT_RECORD.split("/")), "utf-8");

  assert.equal(/[A-Za-z]:\\|\/home\/|\/Users\/|AppData|XDG_STATE_HOME/.test(raw), false, `leaked: ${raw}`);
  assert.equal(raw.includes(dir), false, "not even the project's own path");
});

test("⚠️ an INVALID record is a recovery decision — never repaired, never a second identity", async () => {
  // Reading only `projectId` accepted a record with a missing id, a missing version, or an unknown
  // property, and the writer then generated an id INTO it and preserved whatever else it held. A
  // `token` field went straight back into the committed record.
  const broken = {
    "missing the id": { recordVersion: 1 },
    "an unknown property": { recordVersion: 1, projectId: "a".repeat(32), token: "sk-SECRET" },
    "an id that is not one": { recordVersion: 1, projectId: "../../escaped" },
    "an id of the wrong shape": { recordVersion: 1, projectId: "ABCDEF" },
    "no version": { projectId: "a".repeat(32) },
  };

  for (const [what, record] of Object.entries(broken)) {
    const dir = project();
    mkdirSync(join(dir, ".pi"), { recursive: true });
    const path = join(dir, ...PROJECT_RECORD.split("/"));
    const before = JSON.stringify(record, null, 2) + "\n";
    writeFileSync(path, before, "utf-8");

    assert.equal(projectRecordState(dir).kind, RECORD.INVALID, what);
    assert.throws(
      () => readProjectId(dir),
      (e) => e instanceof LocalStateRefusal && e.reason === STATE_REFUSAL.RECORD_INVALID,
      what
    );
    // ⚠️ THE TRANSACTION REFUSES AT PLAN TIME, WHICH IS STRONGER THAN REFUSING AT THE MERGE. The
    // planned target validates the record, so the run stops before anything lasting is written and
    // the refusal arrives wrapped as the transaction's own. Asserting `instanceof LocalStateRefusal`
    // here would have been asserting the weaker of the two outcomes.
    await assert.rejects(
      () => withTx(dir, (tx) => ensureProjectId({ transaction: tx, randomBytes })),
      (e) => /kiln\.json/.test(String(e.message)) && /recovery decision/.test(String(e.message)),
      what
    );
    assert.equal(readFileSync(path, "utf-8"), before, `${what}: not one byte was repaired`);
  }
});

test("⚠️ an unreadable record is invalid, not absent", async () => {
  // `absent` invites minting an id, and this file holds an identity other things already key on.
  const dir = project();
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ...PROJECT_RECORD.split("/")), "{ not json", "utf-8");

  const state = projectRecordState(dir);
  assert.equal(state.kind, RECORD.INVALID);
  assert.match(state.detail, /not JSON/);
});

test("a project with no record has no id, which is not an error", () => {
  const dir = project();
  assert.equal(projectRecordState(dir).kind, RECORD.ABSENT);
  assert.equal(readProjectId(dir), null);
});

test("⚠️ the planned target validates the record, so a transaction over a broken one refuses at PLAN time", async () => {
  // Before anything lasting is written, rather than at the merge that would have written it.
  const dir = project();
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ...PROJECT_RECORD.split("/")), JSON.stringify({ recordVersion: 1 }), "utf-8");

  await assert.rejects(() => withTx(dir, () => {}), (e) => /projectId|kiln\.json/.test(String(e.message)));
});


/* ================================================================== identity */

test("two spellings of one state root have one identity", async () => {
  const dir = project();
  covered(dir);
  const roots = await withTx(
    dir,
    (tx) => createStateRoot(stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: dir }), { transaction: tx }),
    { stateRoot: projectStateRoot(dir) }
  );
  assert.equal(stateRootIdentity(roots.root), stateRootIdentity(join(dir, ".pi", "x", "..")));
});
