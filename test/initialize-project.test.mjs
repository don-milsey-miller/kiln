/**
 * The content initializer, observed — `lib/project-scaffold.mjs`, `lib/initialize-project.mjs`.
 *
 * ⚠️ **EVERY CLAIM ABOUT THE GENERATED TREE IS READ BACK OFF DISK.** The initializer validates its
 * own output before committing it, so a test that inspected the returned file list would be asking
 * the same code the same question twice. What these read is the directory that ended up in the
 * project — which is the only artifact a user ever sees.
 *
 * ⚠️ **THE ABSENCES ARE ASSERTED AS HARD AS THE PRESENCES.** A scaffold that quietly shipped one
 * attestation, one artifact, or an `.ids.json` would look perfect in a file listing and would be
 * wrong in the way that matters: it would open a gate nobody attested, claim a finding nobody made,
 * or burn an ID nobody allocated. Those are the failures that survive review, so they get their own
 * checks rather than being covered by "the file set matches".
 *
 * ⚠️ **THE LINT IS RUN FOR REAL.** `initialize-project.mjs` cannot call `lintProject` — it must run
 * before `npm install`, and the lint needs Ajv — so its own validation is structural. This file has
 * dependencies available and closes that gap by running the actual project lint over the actual
 * generated content. Without it, "the initializer says the content is valid" would be the only
 * evidence that it is.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { installReaper, reapLater } from "./helpers/reap.mjs";

import {
  GITIGNORE_BEGIN,
  GITIGNORE_END,
  GITIGNORE_RULE,
  GITIGNORE_STATUS,
  SETUP_VERSION,
  ScaffoldError,
  buildScaffold,
  yamlString,
} from "../lib/project-scaffold.mjs";
import { REFUSAL_CLASS, STATUS, applyGitignore, initializeProject, planGitignore } from "../lib/initialize-project.mjs";
import { parseArgs } from "../bin/init-project.mjs";
import { SCHEMA_VERSION, manifestSchemaVersion } from "../lib/content-version.mjs";
import { loadStageDefinitions } from "../lib/stages.mjs";
import { readActivatedTypes } from "../lib/activation.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { createValidators } from "../lib/validate.mjs";
import { lintProject, evaluateStageGate, SEVERITY } from "../lib/lint.mjs";
import { loadStageAttestations } from "../lib/attestations.mjs";
import { toolRoot } from "../lib/content-root.mjs";
import { LockError } from "../lib/lock.mjs";
import { SETUP_LOCK_FILE, runTransaction } from "../lib/setup-transaction.mjs";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFS = loadStageDefinitions(ROOT);
const STAGE_IDS = Object.keys(DEFS).sort();

/**
 * A fresh, empty project directory that the reaper removes when this file finishes.
 *
 * ⚠️ CANONICALISED, because the initializer canonicalises the root it is given and returns THAT. On a
 * platform where the system temp directory is itself a symlink — macOS's `/tmp` -> `/private/tmp` —
 * comparing a returned path against the unresolved one fails for a reason that has nothing to do
 * with the behaviour under test.
 */
function project(name = "kiln-init-") {
  return reapLater(realpathSync(mkdtempSync(join(tmpdir(), name))));
}

/**
 * ⚠️ A `.git` DIRECTORY, NOT `git init`. What the initializer actually tests for is the presence of
 * `.git`, and shelling out would make these tests depend on a binary being on PATH for a behaviour
 * that does not use it. The real `git init` path is covered by the consumer-flow test.
 */
function asGitRepository(dir) {
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

async function init(projectRoot, opts = {}) {
  return initializeProject({
    projectRoot,
    name: "Test Project",
    description: "A project used by the initializer tests.",
    ...opts,
  });
}

/** Every file under `root`, relative and `/`-separated. Directories appear only via their files. */
function filesUnder(root, prefix = "") {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(join(root, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/** Content hashes, so "byte-identical" is a comparison of bytes rather than of a listing. */
function hashTree(root) {
  const out = {};
  for (const rel of filesUnder(root))
    out[rel] = createHash("sha256").update(readFileSync(join(root, ...rel.split("/")))).digest("hex");
  return out;
}

/** The context the lint and the gates need, built the way `bin/lint-plan.mjs` builds it. */
function context(contentRoot) {
  return {
    contentRoot,
    schemas: loadSchemaSet(join(ROOT, "schemas")),
    validators: createValidators(join(ROOT, "schemas")),
    activated: readActivatedTypes(contentRoot),
  };
}

/* ================================================================== the pure generator */

test("the generator returns a deterministic map and writes nothing", () => {
  const a = buildScaffold({ name: "P", stageDefinitions: DEFS, schemaVersion: 2, gitignoreStatus: GITIGNORE_STATUS.ADDED });
  const b = buildScaffold({ name: "P", stageDefinitions: DEFS, schemaVersion: 2, gitignoreStatus: GITIGNORE_STATUS.ADDED });
  assert.deepEqual([...a.keys()], [...b.keys()], "key order must be a property of the content, not of iteration");
  assert.deepEqual([...a.entries()], [...b.entries()], "two calls with the same input must be byte-identical");
});

test("the generator refuses to invent a stage list", () => {
  // #34: stages/ is the one definition set. Generating starters from a hardcoded fallback would make
  // this module a second description of the pipeline, which is the drift the rule exists to prevent.
  assert.throws(
    () => buildScaffold({ name: "P", stageDefinitions: {}, schemaVersion: 2 }),
    (e) => e instanceof ScaffoldError && /stage definitions/i.test(e.message)
  );
});

test("the generator refuses a project with no name", () => {
  for (const name of ["", "   ", undefined, null, 42])
    assert.throws(() => buildScaffold({ name, stageDefinitions: DEFS, schemaVersion: 2 }), ScaffoldError, String(name));
});

test("⚠️ YAML-sensitive text is quoted and escaped rather than interpolated", () => {
  // A name is user input that lands in a structured file. Unquoted, `Migration: phase 2` produces a
  // manifest that parses into something else entirely — which is worse than one that fails to parse.
  assert.equal(yamlString("plain"), '"plain"');
  assert.equal(yamlString("Migration: phase 2"), '"Migration: phase 2"');
  assert.equal(yamlString('say "hi"'), '"say \\"hi\\""');
  assert.equal(yamlString("back\\slash"), '"back\\\\slash"');
  assert.equal(yamlString("two\nlines"), '"two\\nlines"');
  assert.equal(yamlString("tab\there"), '"tab\\there"');
  assert.equal(yamlString("bell"), '"bell\\x07"');
});

/* ================================================================== a first run */

test("a first run creates exactly the documented tree, and nothing else", async () => {
  const dir = project();
  const r = await init(dir);

  assert.equal(r.status, STATUS.CREATED);
  assert.equal(r.validated, true, "success is only reportable for a tree that was read back off disk");

  const content = join(dir, "planning-content");
  assert.deepEqual(filesUnder(content), [
    "README.md",
    "data/.gitkeep",
    "project.yaml",
    "skills-overrides/.gitkeep",
    ...STAGE_IDS.map((id) => `stages/${id}.md`),
    "state/setup.json",
    "state/stage-attestations/.gitkeep",
  ]);

  for (const d of ["data", "stages", "state", "state/stage-attestations", "skills-overrides"])
    assert.ok(statSync(join(content, ...d.split("/"))).isDirectory(), `${d}/ must exist as a directory`);
});

test("the manifest declares the version this tool writes, and activates nothing", async () => {
  const dir = project();
  const content = (await init(dir)).contentRoot;

  const declared = manifestSchemaVersion(content);
  assert.equal(declared.manifest, true, "a generated content root must carry a manifest");
  assert.equal(declared.version, SCHEMA_VERSION, "a fresh project is written against the current content schema");

  // ⚠️ #39: activation is a stage-2 decision the agent proposes and the PM approves. An initializer
  // that pre-activated would be deciding the project's shape before stage 1 had been written — and
  // templates are generated from the activated set, so the guess would become the work.
  assert.deepEqual(readActivatedTypes(content), [], "activation is a stage-2 decision, not a setup default");
});

test("there is one starter document per canonical stage, and no extras", async () => {
  const dir = project();
  const content = (await init(dir)).contentRoot;

  const docs = readdirSync(join(content, "stages")).sort();
  assert.deepEqual(docs, STAGE_IDS.map((id) => `${id}.md`), "the starters are generated from stages/, one for one");

  for (const id of STAGE_IDS) {
    const text = readFileSync(join(content, "stages", `${id}.md`), "utf-8");
    const def = DEFS[id];
    assert.match(text, new RegExp(`\`${id}\``), `${id}: names its stage id`);
    assert.ok(text.includes(def.name), `${id}: names the stage`);
    assert.ok(text.includes(def.decidedBy), `${id}: names its decision owner`);
    for (const c of def.exitCriteria ?? [])
      assert.ok(text.includes(c.id), `${id}: states exit criterion ${c.id} as guidance`);
    assert.ok(!/^\s*- \[[ xX]\]/m.test(text), `${id}: criteria are guidance, not checkboxes to tick`);
  }
});

test("⚠️ the starters carry none of Kiln's own plan", async () => {
  // The tool ships `planning-content/` because it plans itself. Seeding a stranger's project from it
  // would hand them somebody else's decisions under their project's name — and the tell would be
  // prose, not structure, so structure alone cannot catch it.
  const dir = project();
  const content = (await init(dir)).contentRoot;

  for (const id of STAGE_IDS) {
    const generated = readFileSync(join(content, "stages", `${id}.md`), "utf-8");
    const kilns = join(ROOT, "planning-content", "stages", `${id}.md`);
    if (!existsSync(kilns)) continue;
    assert.notEqual(generated, readFileSync(kilns, "utf-8"), `${id}: a fresh project must not receive Kiln's document`);
    assert.ok(!/PM-CORRECTED|notes\.md|transcript/i.test(generated), `${id}: no prose from Kiln's own plan`);
  }
});

test("⚠️ no artifacts, no attestations, no ID counter, no handoff output", async () => {
  const dir = project();
  const content = (await init(dir)).contentRoot;

  // An artifact nobody authored is a claim nobody made.
  assert.deepEqual(readdirSync(join(content, "data")), [".gitkeep"], "data/ holds no artifacts");

  // A missing attestation MEANS unattested. Writing one would open a gate on evidence that does not
  // exist, which is the well-formed false success this whole system is built to prevent.
  assert.deepEqual(readdirSync(join(content, "state", "stage-attestations")), [".gitkeep"]);

  // #83: gaps in the ID sequence are a property of the safety model. A counter written in advance is
  // a high-water mark nothing earned.
  assert.equal(existsSync(join(content, ".ids.json")), false, "the allocator creates the counter on first use");

  // The handoff package is generated only after a handoff succeeds, and it lives beside the content.
  assert.equal(existsSync(join(dir, "docs")), false, "docs/plan/ is published, never scaffolded");
  assert.equal(existsSync(join(content, "docs")), false);
});

test("⚠️ the generated content passes the real project lint", async () => {
  // `initialize-project.mjs` validates structurally because it must run before `npm install`. This is
  // where the claim is actually tested, with Ajv present and the same rules `npm run lint:plan` uses.
  const dir = project();
  const content = (await init(dir)).contentRoot;

  const { findings, records } = lintProject(context(content));
  assert.deepEqual(records, [], "a fresh project has no stored artifacts to lint");
  assert.deepEqual(
    findings.filter((f) => f.severity !== SEVERITY.ADVISORY).map((f) => `${f.ruleId} ${f.path ?? ""} ${f.message}`),
    [],
    "a freshly initialized project must not start life with a finding against it"
  );
});

test("the derived current stage of a fresh project is 01-intake", async () => {
  // Derived on every read and stored nowhere (#16). It is the first stage whose gate is not ready,
  // and on day one that is stage 1 — because nothing has been attested, not because anything failed.
  const dir = project();
  const content = (await init(dir)).contentRoot;
  const ctx = context(content);
  const lint = lintProject(ctx);

  const stages = Object.values(DEFS)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((def) => ({
      id: def.id,
      ready: evaluateStageGate(ctx, def.id, {
        lint,
        stageDefinitions: DEFS,
        attestations: loadStageAttestations(content, def.id),
      }).ready === true,
    }));

  assert.equal(stages.find((s) => !s.ready)?.id, "01-intake");
  assert.deepEqual(stages.filter((s) => s.ready), [], "no gate opens on a project nobody has worked on");
});

test("a name and description full of YAML metacharacters cannot corrupt the manifest", async () => {
  const dir = project();
  const name = 'Migration: "phase 2" — don\'t #panic \\ [x]';
  const description = "First line: it does things.\nSecond line — with: colons, #hashes and \"quotes\".";

  const r = await init(dir, { name, description });
  assert.equal(r.status, STATUS.CREATED);

  const text = readFileSync(join(r.contentRoot, "project.yaml"), "utf-8");
  assert.ok(text.includes(`name: ${yamlString(name)}`), "the name is emitted as one escaped double-quoted scalar");
  assert.ok(text.includes(`description: ${yamlString(description)}`), "and so is the description");

  // ⚠️ THE READERS ARE THE REAL TEST. Both parse `project.yaml` with anchored regexes, so a name that
  // broke out of its quoting would not merely look odd — it would answer one of these questions.
  assert.equal(manifestSchemaVersion(r.contentRoot).version, SCHEMA_VERSION);
  assert.deepEqual(readActivatedTypes(r.contentRoot), []);
  assert.deepEqual(lintProject(context(r.contentRoot)).findings.filter((f) => f.severity === SEVERITY.ERROR), []);
});

/* ================================================================== running it again */

test("⚠️ a second run changes no bytes", async () => {
  const dir = project();
  const first = await init(dir);
  const before = hashTree(dir);

  const second = await init(dir);
  assert.equal(second.status, STATUS.ALREADY_INITIALIZED);
  assert.equal(second.contentRoot, first.contentRoot);
  assert.deepEqual(hashTree(dir), before, "a rerun of a completed initialization must be a no-op on disk");
});

test("⚠️ authored files are never overwritten, and the changes are reported as drift", async () => {
  const dir = asGitRepository(project());
  const content = (await init(dir)).contentRoot;

  const doc = join(content, "stages", "01-intake.md");
  const manifest = join(content, "project.yaml");
  writeFileSync(doc, "# My own intake\n\nEverything Kiln wrote is gone.\n", "utf-8");
  writeFileSync(manifest, readFileSync(manifest, "utf-8").replace(/^name: .*$/m, 'name: "Renamed"'), "utf-8");

  const again = await init(dir);
  assert.equal(again.status, STATUS.ALREADY_INITIALIZED);
  assert.equal(readFileSync(doc, "utf-8"), "# My own intake\n\nEverything Kiln wrote is gone.\n", "not restored");
  assert.match(readFileSync(manifest, "utf-8"), /^name: "Renamed"$/m, "not restored");
  assert.ok(again.drift.modified.includes("stages/01-intake.md"), "the edit is reported rather than repaired");
});

/* ================================================================== structural damage */

/**
 * ⚠️ THE WHOLE POINT OF THIS SECTION IS THAT `state/setup.json` IS NOT ENOUGH TO REPORT SUCCESS.
 * A rerun used to answer `already-initialized` on the strength of that file alone, so a content root
 * whose manifest had been deleted exited 0 — and the next thing anybody does after a setup command
 * succeeds is run the app against it.
 */

test("⚠️ a missing manifest is DAMAGED, not an already-initialized no-op", async () => {
  const dir = project();
  const content = (await init(dir)).contentRoot;
  rmSync(join(content, "project.yaml"));

  const again = await init(dir);
  assert.equal(again.status, STATUS.DAMAGED, "setup.json alone must not certify a project as finished");
  assert.deepEqual(again.structural, [{ kind: "file", path: "project.yaml" }]);
  assert.equal(existsSync(join(content, "project.yaml")), false, "and it is reported, never rewritten");
});

test("⚠️ a missing stage document is DAMAGED", async () => {
  const dir = project();
  const content = (await init(dir)).contentRoot;
  rmSync(join(content, "stages", "05-solution-design.md"));

  const again = await init(dir);
  assert.equal(again.status, STATUS.DAMAGED);
  assert.deepEqual(again.structural, [{ kind: "file", path: "stages/05-solution-design.md" }]);
  assert.equal(existsSync(join(content, "stages", "05-solution-design.md")), false, "reported, not rewritten");
});

test("⚠️ a missing required DIRECTORY is DAMAGED, and a file standing in for one is too", async () => {
  const dir = project();
  const content = (await init(dir)).contentRoot;
  rmSync(join(content, "data"), { recursive: true });
  rmSync(join(content, "skills-overrides"), { recursive: true });
  writeFileSync(join(content, "skills-overrides"), "not a directory\n", "utf-8");

  const again = await init(dir);
  assert.equal(again.status, STATUS.DAMAGED);
  assert.deepEqual(again.structural, [
    { kind: "directory", path: "data" },
    { kind: "directory", path: "skills-overrides" },
  ]);
});

test("⚠️ a deleted .gitkeep is NOT damage — the directory it held open is still there", async () => {
  // A `.gitkeep` exists only to make git track an empty directory. Removing it once `data/` holds
  // artifacts is correct housekeeping, and a project that did so must not report damage forever.
  const dir = project();
  const content = (await init(dir)).contentRoot;
  rmSync(join(content, "data", ".gitkeep"));
  rmSync(join(content, "README.md"));

  const again = await init(dir);
  assert.equal(again.status, STATUS.ALREADY_INITIALIZED, "housekeeping and prose are not structure");
  assert.deepEqual(again.drift.missing, ["README.md", "data/.gitkeep"], "still reported, just not blocking");
});

test("⚠️ a setupVersion this tool does not write is refused rather than acted on", async () => {
  const dir = project();
  const content = (await init(dir)).contentRoot;
  const setupPath = join(content, "state", "setup.json");
  writeFileSync(setupPath, JSON.stringify({ setupVersion: SETUP_VERSION + 1, steps: {} }, null, 2), "utf-8");

  const again = await init(dir);
  assert.equal(again.status, STATUS.REFUSED);
  assert.equal(again.reason, "setup-version-unsupported");
  assert.equal(again.refusalClass, REFUSAL_CLASS.CONFLICT);
  assert.match(again.message, new RegExp(`setupVersion ${SETUP_VERSION + 1}`));
  assert.match(again.message, /update the tool/i, "the content is newer than the tool, so the tool moves");
});

test("⚠️ an unreadable setup record is refused, and is not mistaken for content Kiln never wrote", async () => {
  // The old code returned null for both, so a corrupt marker was reported as "this is somebody
  // else's content" — which sends the user looking for a project that is not theirs.
  for (const body of ["{ not json", '"a string"', "{}", '{"setupVersion": "1"}']) {
    const dir = project();
    const content = (await init(dir)).contentRoot;
    writeFileSync(join(content, "state", "setup.json"), body, "utf-8");

    const again = await init(dir);
    assert.equal(again.status, STATUS.REFUSED, body);
    assert.equal(again.reason, "setup-record-unreadable", body);
    assert.equal(again.refusalClass, REFUSAL_CLASS.CONFLICT, body);
    assert.ok(!/was not written by Kiln/.test(again.message), `${body}: must not blame the user's content`);
  }
});

/* ================================================================== refusals */

test("⚠️ a non-empty content root Kiln did not write is refused, with the conflicts named", async () => {
  const dir = project();
  const content = join(dir, "planning-content");
  mkdirSync(join(content, "stages"), { recursive: true });
  writeFileSync(join(content, "project.yaml"), "name: mine\n", "utf-8");
  writeFileSync(join(content, "stages", "01-intake.md"), "my work\n", "utf-8");

  const r = await init(dir);
  assert.equal(r.status, STATUS.REFUSED);
  assert.equal(r.reason, "content-root-conflict");
  assert.equal(r.refusalClass, REFUSAL_CLASS.CONFLICT, "a conflict is exit 1: the target is real, something is in it");
  assert.deepEqual(r.conflicts, ["project.yaml", "stages"]);

  assert.equal(readFileSync(join(content, "project.yaml"), "utf-8"), "name: mine\n", "nothing was touched");
  assert.deepEqual(filesUnder(dir), ["planning-content/project.yaml", "planning-content/stages/01-intake.md"]);
});

test("an empty planning-content/ directory is not content, and is filled in", async () => {
  const dir = project();
  mkdirSync(join(dir, "planning-content"));
  const r = await init(dir);
  assert.equal(r.status, STATUS.CREATED);
  assert.ok(filesUnder(r.contentRoot).includes("project.yaml"));
});

test("⚠️ initializing inside the tool directory is refused", async () => {
  // The tool directory is a clone that `git pull` overwrites and the project's repository ignores.
  // Content placed in it could never be found either: the one resolution rule is the SIBLING.
  const own = await init(toolRoot());
  assert.equal(own.status, STATUS.REFUSED);
  assert.equal(own.reason, "inside-tool-directory");
  assert.equal(own.refusalClass, REFUSAL_CLASS.INVALID_TARGET);

  const dir = project();
  const nested = join(dir, ".planning", "somewhere");
  mkdirSync(nested, { recursive: true });
  const under = await init(nested);
  assert.equal(under.status, STATUS.REFUSED, "a .planning/ anywhere on the path is refused");
  assert.equal(under.reason, "inside-tool-directory");
  assert.equal(existsSync(join(nested, "planning-content")), false);
});

test("a target that does not exist, or is not a directory, is refused as an invalid target", async () => {
  const dir = project();
  const missing = await init(join(dir, "nope"));
  assert.equal(missing.reason, "project-root-missing");
  assert.equal(missing.refusalClass, REFUSAL_CLASS.INVALID_TARGET);

  writeFileSync(join(dir, "a-file"), "", "utf-8");
  const file = await init(join(dir, "a-file"));
  assert.equal(file.reason, "project-root-not-a-directory");
  assert.equal(file.refusalClass, REFUSAL_CLASS.INVALID_TARGET);

  const unnamed = await init(dir, { name: "   " });
  assert.equal(unnamed.reason, "invalid-name");
});

test("a traversing project root is resolved and canonicalised before anything is written", async () => {
  // `..` is not sanitised away, it is RESOLVED — and then every containment check is made against
  // the real location rather than against the spelling that was typed.
  const dir = project();
  const inner = join(dir, "inner");
  mkdirSync(inner);

  const r = await init(join(inner, "..", "inner", "..", "inner"));
  assert.equal(r.status, STATUS.CREATED);
  assert.equal(r.contentRoot, join(r.projectRoot, "planning-content"));
  assert.equal(resolve(r.projectRoot), resolve(r.contentRoot, ".."), "content lands under the resolved root, once");
  assert.equal(existsSync(join(dir, "planning-content")), false, "and nowhere else");
});

/* ================================================================== failure and concurrency */

test("⚠️ an interrupted initialization leaves no partial tree", async () => {
  const dir = asGitRepository(project());

  await assert.rejects(
    () =>
      init(dir, {
        rename: () => {
          throw Object.assign(new Error("simulated"), { code: "EIO" });
        },
      }),
    /simulated/
  );

  assert.equal(existsSync(join(dir, "planning-content")), false, "nothing visible was left behind");
  const strays = readdirSync(dir).filter((n) => n.startsWith(".planning-content."));
  assert.deepEqual(strays, [], `the staging directory survived: ${strays.join(", ")}`);
  assert.equal(existsSync(join(dir, ".planning-init.lock")), false, "the lock is released even when the work throws");

  // ...and the project is still initializable, which is the property that makes the cleanup matter.
  const retry = await init(dir);
  assert.equal(retry.status, STATUS.CREATED);
});

test("⚠️ two concurrent initializers produce one valid result", async () => {
  // Specialists run in parallel and setup scripts get double-clicked; two processes racing a
  // directory creation is the normal case rather than the edge. #78's lock is what serialises them.
  const dir = project();
  const [a, b] = await Promise.all([init(dir), init(dir)]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [STATUS.ALREADY_INITIALIZED, STATUS.CREATED], `got ${statuses.join(", ")}`);

  const content = join(dir, "planning-content");
  assert.deepEqual(filesUnder(content).filter((f) => f.startsWith("stages/")).length, STAGE_IDS.length);
  assert.deepEqual(lintProject(context(content)).findings.filter((f) => f.severity === SEVERITY.ERROR), []);
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.startsWith(".planning-content.")),
    [],
    "the loser's staging directory is cleaned up too"
  );
});

/* ================================================================== .gitignore */

const block = (eol = "\n") => [GITIGNORE_BEGIN, GITIGNORE_RULE, GITIGNORE_END].join(eol) + eol;
const countBlocks = (text) => text.split(/\r?\n/).filter((l) => l.trim() === GITIGNORE_BEGIN).length;

test("a project that is not a Git repository is told so, and nothing is written", async () => {
  const dir = project();
  const notices = [];
  const r = await init(dir, { log: (e) => e.kind === "notice" && notices.push(e.message) });

  assert.equal(r.git.repository, false);
  assert.equal(r.git.gitignore, GITIGNORE_STATUS.NOT_A_REPOSITORY);
  assert.equal(existsSync(join(dir, ".gitignore")), false, "a .gitignore is not invented for a non-repository");
  assert.equal(JSON.parse(readFileSync(join(r.contentRoot, "state", "setup.json"), "utf-8")).steps.gitignore, "not-a-git-repository");
  assert.match(notices.join("\n"), /not a Git repository/i, "and the operator is told, rather than left to notice");
});

test("in a Git repository the marked block is added, and every existing line survives", async () => {
  const dir = asGitRepository(project());
  const existing = "# mine\nnode_modules/\n*.log\n";
  writeFileSync(join(dir, ".gitignore"), existing, "utf-8");

  const r = await init(dir);
  const text = readFileSync(join(dir, ".gitignore"), "utf-8");

  assert.equal(r.git.gitignore, GITIGNORE_STATUS.ADDED);
  assert.ok(text.startsWith(existing), "the file is APPENDED to; nothing is rewritten");
  assert.ok(text.includes(block()), "and the block is marked at both ends so it can be found again");
  assert.equal(countBlocks(text), 1);
});

test("a repository with no .gitignore gets one containing only the block", async () => {
  const dir = asGitRepository(project());
  await init(dir);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf-8"), block());
});

test("⚠️ an existing rule for .planning/ is OBSERVED, not duplicated", async () => {
  for (const rule of [".planning/", ".planning", "/.planning/", "/.planning"]) {
    const dir = asGitRepository(project());
    const existing = `# already handled\n${rule}\n`;
    writeFileSync(join(dir, ".gitignore"), existing, "utf-8");

    const r = await init(dir);
    assert.equal(r.git.gitignore, GITIGNORE_STATUS.ALREADY_IGNORED, rule);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf-8"), existing, `${rule}: the file is untouched`);
    assert.equal(
      JSON.parse(readFileSync(join(r.contentRoot, "state", "setup.json"), "utf-8")).steps.gitignore,
      "already-ignored",
      `${rule}: the record says Kiln observed the rule rather than adding it`
    );
  }
});

test("⚠️ the write is an APPEND, so an edit made between plan and apply survives", async () => {
  // The plan is made before the content tree is generated. Rebuilding the file from the snapshot the
  // plan is holding — `writeFileSync(path, existing + block)` — destroys every byte written in
  // between, and `.gitignore` is a file people edit by hand and other tools append to. The
  // initializer's lock keeps two Kilns apart; it does not keep an editor's save out.
  const dir = asGitRepository(project());
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");

  const plan = planGitignore(dir);
  assert.equal(plan.action, "append");

  appendFileSync(join(dir, ".gitignore"), "coverage/\n", "utf-8"); // somebody else, in between
  applyGitignore(plan);

  const text = readFileSync(join(dir, ".gitignore"), "utf-8");
  assert.match(text, /^coverage\/$/m, "the edit made between plan and apply was not reverted");
  assert.match(text, /^node_modules\/$/m, "and neither was what was there before");
  assert.equal(countBlocks(text), 1);
});

test("⚠️ a .gitignore created between plan and apply is appended to, never overwritten", async () => {
  // `plan.action` is "create" because the file was absent when the plan was made. An `existsSync`
  // check followed by a write would be the same race with a wider window, and the loser would
  // silently discard whatever the winner wrote.
  const dir = asGitRepository(project());
  const plan = planGitignore(dir);
  assert.equal(plan.action, "create");

  writeFileSync(join(dir, ".gitignore"), "# somebody got there first\n", "utf-8");
  applyGitignore(plan);

  const text = readFileSync(join(dir, ".gitignore"), "utf-8");
  assert.match(text, /somebody got there first/, "the other writer's file survived");
  assert.equal(countBlocks(text), 1);
});

test("applying twice adds nothing the second time", async () => {
  const dir = asGitRepository(project());
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");

  const plan = planGitignore(dir);
  applyGitignore(plan);
  const once = readFileSync(join(dir, ".gitignore"), "utf-8");
  applyGitignore(plan); // the same stale plan, re-applied
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf-8"), once, "the marker is re-read, not assumed absent");
});

test("a CRLF .gitignore stays a CRLF .gitignore", async () => {
  // A checkout configured for CRLF that grew three LF lines is a diff nobody asked for.
  const dir = asGitRepository(project());
  writeFileSync(join(dir, ".gitignore"), "node_modules/\r\n", "utf-8");
  await init(dir);

  const text = readFileSync(join(dir, ".gitignore"), "utf-8");
  assert.ok(text.includes(block("\r\n")), "the appended block uses the line ending already in the file");
  assert.equal(/(?<!\r)\n/.test(text), false, "and introduces no bare LF");
});

test("⚠️ a block the user deleted is not restored by a rerun", async () => {
  // Rerunning a command you expect to do nothing must not overrule a deliberate edit.
  const dir = asGitRepository(project());
  await init(dir);
  writeFileSync(join(dir, ".gitignore"), "# I removed Kiln's block on purpose\n", "utf-8");

  const again = await init(dir);
  assert.equal(again.status, STATUS.ALREADY_INITIALIZED);
  assert.equal(again.gitignore.touched, false);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf-8"), "# I removed Kiln's block on purpose\n");
});

test("⚠️ a crash between appending the block and committing the content recovers without duplicating it", async () => {
  // The append happens BEFORE the swap on purpose: the other order has a window in which the content
  // root exists — so every later run is a no-op — while `.planning/` was never ignored by anything.
  const dir = asGitRepository(project());
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");

  await assert.rejects(() =>
    init(dir, {
      rename: () => {
        throw Object.assign(new Error("crash"), { code: "EIO" });
      },
    })
  );

  const afterCrash = readFileSync(join(dir, ".gitignore"), "utf-8");
  assert.equal(countBlocks(afterCrash), 1, "the block was appended before the crash");
  assert.equal(existsSync(join(dir, "planning-content")), false, "and the content was not");

  const recovered = await init(dir);
  assert.equal(recovered.status, STATUS.CREATED);
  assert.equal(countBlocks(readFileSync(join(dir, ".gitignore"), "utf-8")), 1, "the rerun found its own block");
  assert.equal(
    JSON.parse(readFileSync(join(recovered.contentRoot, "state", "setup.json"), "utf-8")).steps.gitignore,
    "added",
    "and recorded it as Kiln's own work rather than as a pre-existing rule"
  );
});

/* ================================================================== the command line */

/**
 * ⚠️ THE EXIT CODES ARE THE CONTRACT, so they are exercised by RUNNING the command rather than by
 * reading `main`. A setup script needs to tell a harmless second run (0) from something being in the
 * way (1) from a typo in its own arguments (2), and a code that drifted would break that script
 * silently — the command would still print sensible prose either way.
 */
const CLI = join(ROOT, "bin", "init-project.mjs");
const cli = (args, opts = {}) =>
  promisify(execFile)(process.execPath, [CLI, ...args], { maxBuffer: 8 << 20, ...opts }).catch((e) => e);
const code = (r) => r.code ?? 0;
const both = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

test("the CLI parses only what it documents, and an unknown option is an error", () => {
  assert.deepEqual(parseArgs(["--project-root", "p", "--name", "n"]), {
    help: false,
    nonInteractive: false,
    projectRoot: "p",
    name: "n",
  });
  assert.equal(parseArgs(["--name=with=equals"]).name, "with=equals", "only the first = separates flag from value");
  assert.equal(parseArgs(["--non-interactive"]).nonInteractive, true);

  // ⚠️ `--nmae "My Project"` must not be silently discarded. Treated as a positional it would leave
  // the command refusing for a reason that has nothing to do with the actual typo.
  assert.match(parseArgs(["--nmae", "x"]).error, /Unrecognised argument: --nmae/);
  assert.match(parseArgs(["My Project"]).error, /Unrecognised argument/);
  assert.match(parseArgs(["--name"]).error, /--name needs a value/);
});

test("the CLI's exit codes distinguish a no-op, a conflict, and a bad argument", async () => {
  const dir = project();

  assert.equal(code(await cli(["--help"])), 0);
  assert.equal(code(await cli(["--project-root", dir, "--name", "X"])), 0, "created");
  assert.equal(code(await cli(["--project-root", dir, "--name", "X"])), 0, "a verified no-op is a success");

  assert.equal(code(await cli(["--project-root", dir])), 2, "no --name, and no terminal to prompt at");
  assert.equal(code(await cli(["--name", "X"])), 2, "no --project-root");
  assert.equal(code(await cli(["--project-root", dir, "--name", "X", "--wat"])), 2, "unknown option");
  assert.equal(code(await cli(["--project-root", join(dir, "nope"), "--name", "X"])), 2, "invalid target");
  assert.equal(code(await cli(["--project-root", ROOT, "--name", "X"])), 2, "the tool directory itself");

  const busy = project();
  mkdirSync(join(busy, "planning-content"));
  writeFileSync(join(busy, "planning-content", "notes.md"), "mine\n", "utf-8");
  const conflict = await cli(["--project-root", busy, "--name", "X"]);
  assert.equal(code(conflict), 1, "a conflict is not a usage error");
  assert.match(both(conflict), /REFUSED/);
  assert.match(both(conflict), /notes\.md/, "and the command names what is in the way");
});

test("⚠️ the CLI exits 1 on structural damage, and never prints success for it", async () => {
  // The failure this closes: `state/setup.json` alone used to certify a content root, so a project
  // with no manifest exited 0 with a success message — and a success message is the one line a user
  // does not check before running the app against it.
  const dir = project();
  assert.equal(code(await cli(["--project-root", dir, "--name", "X"])), 0);
  rmSync(join(dir, "planning-content", "project.yaml"));

  const damaged = await cli(["--project-root", dir, "--name", "X"]);
  assert.equal(code(damaged), 1, "a broken project is not a verified no-op");
  assert.match(both(damaged), /DAMAGED/);
  assert.match(both(damaged), /project\.yaml/, "and the command names what is gone");
  assert.ok(!/already initialized|created \d+ file/.test(both(damaged)), "no success wording on a damaged root");

  // ...while an ordinary edit stays a success, which is what keeps the distinction useful.
  writeFileSync(join(dir, "planning-content", "project.yaml"), "name: \"X\"\nschemaVersion: 2\n", "utf-8");
  writeFileSync(join(dir, "planning-content", "stages", "01-intake.md"), "# mine\n", "utf-8");
  assert.equal(code(await cli(["--project-root", dir, "--name", "X"])), 0, "an edited document is not damage");
});

test("the CLI prints every absolute directory before it uses one", async () => {
  // A command that creates a directory tree from a relative argument must show where that landed.
  // The failure this prevents is not a crash; it is a run that succeeds against the wrong directory.
  const dir = project();
  const r = await cli(["--project-root", ".", "--name", "X"], { cwd: dir });

  assert.equal(code(r), 0, both(r));
  const text = both(r);
  for (const label of ["tool root:", "project root:", "content root:", "staging in:"])
    assert.ok(text.includes(label), `the run did not report its ${label}\n${text}`);
  assert.ok(text.includes(join(dir, "planning-content")), "and the content root is absolute");
});

test("the setup record carries no timestamp and no machine-specific path", async () => {
  // It is committed to the user's repository. Anything machine-specific in it produces a diff on
  // every machine that runs the initializer and tells a reviewer nothing.
  const dir = asGitRepository(project());
  const content = (await init(dir)).contentRoot;
  const raw = readFileSync(join(content, "state", "setup.json"), "utf-8");

  assert.deepEqual(JSON.parse(raw), {
    setupVersion: SETUP_VERSION,
    steps: { contentScaffold: "complete", gitignore: "added" },
  });
  assert.equal(/\d{4}-\d{2}-\d{2}|[A-Za-z]:\\|\/home\/|\/Users\//.test(raw), false, `setup.json leaked: ${raw}`);
});

/* ================================================================== TSK-0027: held transaction == */

/**
 * ⚠️ **ONE LOCK FOR THE COMMAND.** `setup` holds `<project>/.planning-init.lock` for its whole run
 * and calls the initializer and the ignore owner from inside it. Both must run in the held
 * transaction rather than taking the lock a second time — and "must" here is enforced rather than
 * documented, because the failure mode of forgetting is a ten-second stall reporting contention
 * with this very process.
 */

test("the initializer runs inside a held transaction, and produces the same result as on its own", async () => {
  const alone = asGitRepository(project());
  const inTx = asGitRepository(project());

  const solo = await init(alone);
  const held = await runTransaction({ projectRoot: inTx }, (tx) => init(inTx, { transaction: tx }));

  assert.equal(solo.status, STATUS.CREATED);
  assert.equal(held.status, STATUS.CREATED, "the held path must do the whole job, not a reduced one");

  // ⚠️ THE TREES ARE COMPARED BY CONTENT, not by count. A held transaction that silently skipped a
  // step would still produce a plausible file list, and the point of this task is that nothing
  // about the initializer's behaviour changes except who owns the lock.
  assert.deepEqual(
    hashTree(join(inTx, "planning-content")),
    hashTree(join(alone, "planning-content")),
    "the generated content must be byte-identical either way"
  );

  // The ignore owner ran under the transaction's lock, appending rather than rewriting.
  assert.equal(countBlocks(readFileSync(join(inTx, ".gitignore"), "utf-8")), 1);
  assert.equal(held.git.gitignore, GITIGNORE_STATUS.ADDED);

  // And the transaction released the lock it owned, rather than the initializer removing it early.
  assert.equal(existsSync(join(inTx, SETUP_LOCK_FILE)), false);
});

test("a second run inside a held transaction is still idempotent, and still touches no .gitignore", async () => {
  const dir = asGitRepository(project());
  const existing = "# mine\nnode_modules/\n";
  writeFileSync(join(dir, ".gitignore"), existing, "utf-8");

  await runTransaction({ projectRoot: dir }, (tx) => init(dir, { transaction: tx }));
  const after = readFileSync(join(dir, ".gitignore"), "utf-8");

  const second = await runTransaction({ projectRoot: dir }, (tx) => init(dir, { transaction: tx }));
  assert.equal(second.status, STATUS.ALREADY_INITIALIZED, "the refusal semantics are unchanged by the lock's owner");
  assert.equal(second.gitignore.touched, false);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf-8"), after, "and not one byte moved");
  assert.equal(countBlocks(after), 1, "the block is added at most once, however the lock is held");
});

test("⚠️ forgetting to pass the transaction fails immediately, rather than waiting on itself", async () => {
  const dir = asGitRepository(project());
  const started = Date.now();

  // ⚠️ THE ELAPSED TIME IS PART OF THE ASSERTION. Before this, the nested acquisition spun the whole
  // bounded wait and then reported a timeout "held by pid <self>" — contention with nobody, phrased
  // as contention with someone. The bounded wait here is set to a value the guard must beat.
  await assert.rejects(
    () => runTransaction({ projectRoot: dir }, () => init(dir, { lock: { maxWaitMs: 5_000 } })),
    (e) => e instanceof LockError && /already held further up this call stack/.test(e.message),
    "a nested acquisition must be refused, not waited out"
  );
  assert.ok(Date.now() - started < 2_000, "it must refuse rather than exhaust the wait");
});

test("a transaction holding a DIFFERENT project is not exclusion here", async () => {
  const mine = asGitRepository(project());
  const theirs = project();

  const r = await runTransaction({ projectRoot: theirs }, (tx) => init(mine, { transaction: tx }));

  // ⚠️ A TRANSACTION IS EXCLUSION OVER ONE PROJECT. Accepting any transaction at all would let a
  // second initializer run on `mine` while this one believed it was protected — the guarantee would
  // read as satisfied and be absent.
  assert.equal(r.status, STATUS.REFUSED);
  assert.equal(r.reason, "transaction-project-mismatch");
  assert.equal(r.refusalClass, REFUSAL_CLASS.CONFLICT);
  assert.equal(existsSync(join(mine, "planning-content")), false, "and nothing was written");
});

test("concurrent initializers still serialise — the guard rules out nesting, not concurrency", async () => {
  // ⚠️ THE CONTROL ON THE GUARD ITSELF. A process-wide "already held" set would refuse this pair,
  // breaking the exclusion it exists to protect: these are two independent operations that happen
  // to share a process, which is precisely what the lock is for. Scoping the guard to the async
  // context is what tells them apart from a nested acquisition.
  const dir = project();
  const [a, b] = await Promise.all([init(dir), init(dir)]);
  assert.deepEqual([a.status, b.status].sort(), [STATUS.ALREADY_INITIALIZED, STATUS.CREATED]);
});

test("⚠️ an object shaped like a transaction is not one, and initializes nothing", async () => {
  const dir = asGitRepository(project());

  // ⚠️ THE FORGERY THAT WORKED. This literal used to satisfy the check and the scaffold was built
  // with no lock held at all — the guarantee read as satisfied and was entirely absent. A shape
  // describes data; only the issuing module can establish a capability.
  const r = await init(dir, { transaction: { plan: { projectRoot: dir } } });

  assert.equal(r.status, STATUS.REFUSED);
  assert.equal(r.reason, "transaction-not-authentic");
  assert.equal(r.refusalClass, REFUSAL_CLASS.INVALID_TARGET);
  assert.equal(existsSync(join(dir, "planning-content")), false, "nothing may be created on a forged capability");
  assert.equal(existsSync(join(dir, ".gitignore")), false);
});

test("a real transaction that has already finished is not a held lock", async () => {
  const dir = asGitRepository(project());

  let captured = null;
  await runTransaction({ projectRoot: dir }, async (tx) => {
    captured = tx;
  });

  // ⚠️ HOLDING THE LOCK ONCE IS NOT HOLDING IT NOW. The object is genuine; its lease is over.
  const r = await init(dir, { transaction: captured });
  assert.equal(r.status, STATUS.REFUSED);
  assert.equal(r.reason, "transaction-not-active");
  assert.equal(existsSync(join(dir, "planning-content")), false);

  // ...and the same project initializes normally once a live transaction is supplied, so the
  // refusal above is about the lease rather than about anything wrong with the project.
  const ok = await runTransaction({ projectRoot: dir }, (tx) => init(dir, { transaction: tx }));
  assert.equal(ok.status, STATUS.CREATED);
});

test("⚠️ an initializer the body never awaited still finishes under the lock", async () => {
  const dir = asGitRepository(project());

  // ⚠️ AUTHENTICATED AT THE DOOR IS NOT INSIDE. The initializer used to run outside the
  // transaction's registry, so this returned successfully, released the lock, and left the scaffold
  // being built with no exclusion behind it.
  await assert.rejects(
    () =>
      runTransaction({ projectRoot: dir }, async (tx) => {
        init(dir, { transaction: tx }); // no await — the defect
      }),
    (e) => e.reason === "operation-still-running",
    "a run whose collaborator was still working cannot report itself successful"
  );

  // It completed under the lock rather than after it.
  assert.equal(existsSync(join(dir, SETUP_LOCK_FILE)), false);
  assert.deepEqual(
    lintProject(context(join(dir, "planning-content"))).findings.filter((f) => f.severity === SEVERITY.ERROR),
    [],
    "and what it built is whole, not caught halfway"
  );
});
