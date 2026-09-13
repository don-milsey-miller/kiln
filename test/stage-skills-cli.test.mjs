/**
 * The stage-skill command — TSK-0046, against ACC-0066.
 *
 * ⚠️ **EVERY CASE RUNS IN A TEMPORARY COPY.** The real `stages/` and the handwritten skill are copied
 * into a temporary tool root, and the command's `main` is pointed at it. The repository's own
 * `pi-package/skills/` is touched by exactly one case, which runs the real program in `--check` mode
 * and proves it changed nothing.
 *
 * ⚠️ **A CHECK THAT WRITES IS NOT A CHECK.** Every `--check` case takes a snapshot of the whole
 * temporary root - every directory entry, every file's bytes and modification time - before and after,
 * and the two must be identical.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { EXIT, main, parseArgs } from "../bin/generate-stage-skills.mjs";
import { checkStageSkills } from "../lib/stage-skills-files.mjs";
import { generateStageSkills } from "../lib/stage-skills.mjs";
import { loadStageDefinitions } from "../lib/stages.mjs";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NINE = Object.freeze([
  "kiln-stage-01-intake",
  "kiln-stage-02-intent-decomposition",
  "kiln-stage-03-discovery",
  "kiln-stage-04-requirement-gaps",
  "kiln-stage-05-solution-design",
  "kiln-stage-06-risk-feasibility",
  "kiln-stage-07-acceptance-criteria",
  "kiln-stage-08-implementation-plan",
  "kiln-stage-09-handoff",
]);

/** A temporary tool root: the real stage definitions, and the handwritten skill, backdated. */
function copy() {
  const root = reapLater(mkdtempSync(join(tmpdir(), "kiln-stage-skills-cli-")));
  cpSync(join(ROOT, "stages"), join(root, "stages"), { recursive: true });
  mkdirSync(join(root, "pi-package", "skills", "kiln-planning"), { recursive: true });
  const planning = join(root, "pi-package", "skills", "kiln-planning", "SKILL.md");
  writeFileSync(planning, readFileSync(join(ROOT, "pi-package", "skills", "kiln-planning", "SKILL.md")));
  backdate(root);
  return root;
}

/** Every file an hour old, so a rewrite with identical bytes still shows as a moved modification time. */
function backdate(root) {
  const past = new Date(Date.now() - 3_600_000);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) utimesSync(full, past, past);
    }
  };
  walk(root);
}

/** Every entry under a root: directories by name, files by bytes and modification time, links as links. */
function snapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const key = relative(root, full).split(sep).join("/");
      if (entry.isSymbolicLink()) out.set(`${key}@`, "link");
      else if (entry.isDirectory()) {
        out.set(`${key}/`, "dir");
        walk(full);
      } else out.set(key, { bytes: readFileSync(full), mtimeMs: statSync(full).mtimeMs });
    }
  };
  walk(root);
  return out;
}

function assertSame(before, after, label) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${label}: an entry was created or removed`);
  for (const [key, was] of before) {
    if (typeof was === "string") continue;
    const now = after.get(key);
    assert.deepEqual(now.bytes, was.bytes, `${label}: ${key} changed`);
    assert.equal(now.mtimeMs, was.mtimeMs, `${label}: ${key} was rewritten or touched`);
  }
}

/** The command against a root, with its output captured line by line. */
async function run(root, argv) {
  const out = [];
  const err = [];
  const code = await main(argv, { toolRoot: root, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err, all: [...out, ...err].join("\n") };
}

/** A check must leave every entry, byte and modification time where it found them. */
async function check(root) {
  const before = snapshot(root);
  const result = await run(root, ["--check"]);
  assertSame(before, snapshot(root), "--check");
  return result;
}

const skillFile = (root, name) => join(root, "pi-package", "skills", name, "SKILL.md");

/** No machine path, in any spelling, in anything the command printed. */
function assertNoMachinePath(text, root) {
  for (const path of [root, ROOT, homedir(), tmpdir()])
    for (const spelling of [path, path.split("\\").join("/"), JSON.stringify(path).slice(1, -1)])
      assert.equal(text.includes(spelling), false, `the output carries ${spelling}:\n${text}`);
  assert.equal(/[A-Za-z]:[\\/]/.test(text), false, `a drive-lettered path reached the output:\n${text}`);
  assert.equal(/\/(home|Users)\//.test(text), false, `a home directory reached the output:\n${text}`);
}

/** The lines naming drift, reduced to [kind, skill]. */
const driftOf = (result) =>
  result.out
    .map((line) => line.match(/^\[stage-skills\] (stale|missing|orphaned)\s+(\S+)/))
    .filter(Boolean)
    .map(([, kind, skill]) => [kind, skill]);

/* ------------------------------------------------------------------------------ arguments */

test("⚠️ ACC-0066 only the write mode, --check and --help exist, and every other argument is refused", async () => {
  assert.deepEqual(parseArgs([]), { mode: "write" });
  assert.deepEqual(parseArgs(["--check"]), { mode: "check" });
  assert.deepEqual(parseArgs(["--help"]), { mode: "help" });
  assert.deepEqual(parseArgs(["-h"]), { mode: "help" });

  // ⚠️ A TYPO MUST NOT FALL THROUGH TO WRITING. `--chek` in a CI step that meant to check would
  // otherwise rewrite the files it was guarding and report success.
  for (const bad of ["--chek", "check", "--check=true", "--write", "-c", "--dry-run", "stages/"]) {
    assert.match(parseArgs([bad]).error ?? "", /^Unrecognised argument: /, bad);
    assert.match(parseArgs(["--check", bad]).error ?? "", /^Unrecognised argument: /, `--check ${bad}`);

    const root = copy();
    const before = snapshot(root);
    const result = await run(root, ["--check", bad].slice(bad === "--check" ? 1 : 0));
    assert.equal(result.code, EXIT.REFUSED, `${bad}: ${result.all}`);
    assert.ok(result.err.some((l) => l.includes(`Unrecognised argument: ${bad}`)), result.all);
    assertSame(before, snapshot(root), `the unknown argument ${bad}`);
  }

  const help = await run(copy(), ["--help"]);
  assert.equal(help.code, EXIT.CLEAN);
  assert.match(help.out.join("\n"), /Exit codes:/);
});

/* ------------------------------------------------------------------------------ write and clean */

test("⚠️ ACC-0066 write mode creates exactly the nine generated skills, from the same generator the check uses", async () => {
  const root = copy();
  const planning = snapshot(join(root, "pi-package", "skills", "kiln-planning"));

  const written = await run(root, []);
  assert.equal(written.code, EXIT.CLEAN, written.all);
  assert.deepEqual(driftOf(written), NINE.map((name) => ["missing", name]), "each created skill named, in order");

  const expected = generateStageSkills(loadStageDefinitions(root));
  assert.deepEqual(
    readdirSync(join(root, "pi-package", "skills")).sort(),
    ["kiln-planning", ...NINE].sort(),
    "the nine and the handwritten skill, and nothing else"
  );
  for (const skill of expected) {
    assert.deepEqual(readFileSync(join(root, "pi-package", ...skill.path.split("/"))), Buffer.from(skill.content, "utf8"), `${skill.name}: bytes`);
    assert.deepEqual(readdirSync(join(root, "pi-package", "skills", skill.name)), ["SKILL.md"], `${skill.name}: only its SKILL.md`);
  }
  assertSame(planning, snapshot(join(root, "pi-package", "skills", "kiln-planning")), "kiln-planning during a write");

  const clean = await check(root);
  assert.equal(clean.code, EXIT.CLEAN, clean.all);
  assert.match(clean.out.join("\n"), /clean: all 9 generated skills match stages\//);

  const again = await run(root, []);
  assert.equal(again.code, EXIT.CLEAN);
  assert.match(again.out.join("\n"), /nothing to change/);
});

/* ------------------------------------------------------------------------------ drift */

test("⚠️ ACC-0066 a missing skill fails the check by name, whether its directory or only its SKILL.md is gone", async () => {
  const root = copy();
  await run(root, []);
  backdate(root);

  rmSync(join(root, "pi-package", "skills", "kiln-stage-04-requirement-gaps"), { recursive: true });
  unlinkSync(skillFile(root, "kiln-stage-07-acceptance-criteria"));

  const result = await check(root);
  assert.equal(result.code, EXIT.DRIFT, result.all);
  assert.deepEqual(driftOf(result), [
    ["missing", "kiln-stage-04-requirement-gaps"],
    ["missing", "kiln-stage-07-acceptance-criteria"],
  ]);

  assert.equal((await run(root, [])).code, EXIT.CLEAN);
  assert.equal((await check(root)).code, EXIT.CLEAN);
});

test("⚠️ ACC-0066 editing a stage definition without regenerating fails the check, naming the stale skill", async () => {
  const root = copy();
  await run(root, []);
  backdate(root);

  // ⚠️ THE CRITERION'S OWN SCENARIO: the definition moves, the packaged skill does not.
  const file = join(root, "stages", "03-discovery.json");
  const definition = JSON.parse(readFileSync(file, "utf8"));
  definition.exitCriteria[0].describe = `${definition.exitCriteria[0].describe} Edited.`;
  writeFileSync(file, `${JSON.stringify(definition, null, 2)}\n`);

  // And a packaged skill edited by hand is stale too.
  writeFileSync(skillFile(root, "kiln-stage-08-implementation-plan"), `${readFileSync(skillFile(root, "kiln-stage-08-implementation-plan"), "utf8")}\nhand edit\n`);

  // ⚠️ SO IS ONE WHOSE ONLY DIFFERENCE IS LINE ENDINGS. A Windows checkout with autocrlf produces exactly
  // this, and a comparison that normalised it would pass a file whose bytes differ from what CI generates.
  writeFileSync(skillFile(root, "kiln-stage-05-solution-design"), readFileSync(skillFile(root, "kiln-stage-05-solution-design"), "utf8").replace(/\n/g, "\r\n"));
  backdate(root);

  const result = await check(root);
  assert.equal(result.code, EXIT.DRIFT, result.all);
  assert.deepEqual(driftOf(result), [
    ["stale", "kiln-stage-03-discovery"],
    ["stale", "kiln-stage-05-solution-design"],
    ["stale", "kiln-stage-08-implementation-plan"],
  ]);

  const fixed = await run(root, []);
  assert.equal(fixed.code, EXIT.CLEAN, fixed.all);
  assert.deepEqual(driftOf(fixed), [
    ["stale", "kiln-stage-03-discovery"],
    ["stale", "kiln-stage-05-solution-design"],
    ["stale", "kiln-stage-08-implementation-plan"],
  ]);
  assert.equal(readFileSync(skillFile(root, "kiln-stage-05-solution-design"), "utf8").includes("\r"), false, "the CRLF skill was not rewritten with LF");
  assert.ok(readFileSync(skillFile(root, "kiln-stage-03-discovery"), "utf8").includes("Edited."));
  assert.equal((await check(root)).code, EXIT.CLEAN);
});

test("⚠️ ACC-0066 a generated skill whose definition is gone is orphaned, and write mode removes only what it wrote", async () => {
  const root = copy();
  await run(root, []);
  backdate(root);

  // A definition removed after generation...
  rmSync(join(root, "stages", "09-handoff.json"));
  // ...and a generated-looking skill for a stage that never existed.
  const handoff = readFileSync(skillFile(root, "kiln-stage-09-handoff"), "utf8");
  mkdirSync(join(root, "pi-package", "skills", "kiln-stage-10-extra"));
  writeFileSync(skillFile(root, "kiln-stage-10-extra"), handoff.replace('name: "kiln-stage-09-handoff"', 'name: "kiln-stage-10-extra"'));

  const result = await check(root);
  assert.equal(result.code, EXIT.DRIFT, result.all);
  assert.deepEqual(driftOf(result), [
    ["orphaned", "kiln-stage-09-handoff"],
    ["orphaned", "kiln-stage-10-extra"],
  ]);

  const planning = snapshot(join(root, "pi-package", "skills", "kiln-planning"));
  const removed = await run(root, []);
  assert.equal(removed.code, EXIT.CLEAN, removed.all);
  assert.deepEqual(readdirSync(join(root, "pi-package", "skills")).sort(), ["kiln-planning", ...NINE.slice(0, 8)].sort());
  assertSame(planning, snapshot(join(root, "pi-package", "skills", "kiln-planning")), "kiln-planning while orphans were removed");
  assert.equal((await check(root)).code, EXIT.CLEAN);
});

test("⚠️ ACC-0066 an orphan holding content the generator did not write is reported, and write mode refuses and writes nothing", async () => {
  const root = copy();
  await run(root, []);
  backdate(root);

  const orphan = join(root, "pi-package", "skills", "kiln-stage-10-notes");
  mkdirSync(orphan);
  writeFileSync(join(orphan, "SKILL.md"), readFileSync(skillFile(root, "kiln-stage-01-intake"), "utf8").replace('name: "kiln-stage-01-intake"', 'name: "kiln-stage-10-notes"'));
  writeFileSync(join(orphan, "notes.md"), "somebody's own notes\n");
  // A stale skill as well, so a partial write would be visible.
  writeFileSync(skillFile(root, "kiln-stage-02-intent-decomposition"), "stale\n");
  backdate(root);

  const checked = await check(root);
  assert.equal(checked.code, EXIT.DRIFT, checked.all);
  assert.deepEqual(driftOf(checked), [
    ["stale", "kiln-stage-02-intent-decomposition"],
    ["orphaned", "kiln-stage-10-notes"],
  ]);
  assert.ok(checked.out.some((l) => l.includes("kiln-stage-10-notes") && l.includes("write mode will refuse")), checked.all);

  // ⚠️ REFUSED AS A WHOLE: not the orphan, and not the stale skill beside it either.
  const before = snapshot(root);
  const written = await run(root, []);
  assert.equal(written.code, EXIT.REFUSED, written.all);
  assert.ok(written.err.some((l) => l.includes("unowned-content") && l.includes("kiln-stage-10-notes")), written.all);
  assertSame(before, snapshot(root), "a refused write");

  // A generated name holding something that is not its generated SKILL.md is refused the same way.
  const handwritten = copy();
  mkdirSync(join(handwritten, "pi-package", "skills", "kiln-stage-10-byhand"));
  writeFileSync(skillFile(handwritten, "kiln-stage-10-byhand"), '---\nname: "kiln-stage-10-byhand"\n---\n\nWritten by a person.\n');
  const handBefore = snapshot(handwritten);
  assert.equal((await run(handwritten, [])).code, EXIT.REFUSED);
  assertSame(handBefore, snapshot(handwritten), "a refused write over a handwritten kiln-stage-* skill");
});

test("⚠️ ACC-0066 every affected skill is named, in skill-name order, whatever kind of drift it is", async () => {
  const root = copy();
  await run(root, []);
  backdate(root);

  rmSync(join(root, "pi-package", "skills", "kiln-stage-06-risk-feasibility"), { recursive: true });
  writeFileSync(skillFile(root, "kiln-stage-02-intent-decomposition"), "stale\n");
  mkdirSync(join(root, "pi-package", "skills", "kiln-stage-00-before"));
  writeFileSync(
    skillFile(root, "kiln-stage-00-before"),
    readFileSync(skillFile(root, "kiln-stage-01-intake"), "utf8").replace('name: "kiln-stage-01-intake"', 'name: "kiln-stage-00-before"')
  );
  writeFileSync(skillFile(root, "kiln-stage-09-handoff"), "stale\n");

  const expected = [
    ["orphaned", "kiln-stage-00-before"],
    ["stale", "kiln-stage-02-intent-decomposition"],
    ["missing", "kiln-stage-06-risk-feasibility"],
    ["stale", "kiln-stage-09-handoff"],
  ];
  const first = await check(root);
  assert.equal(first.code, EXIT.DRIFT);
  assert.deepEqual(driftOf(first), expected);
  assert.deepEqual(driftOf(await check(root)), expected, "a second check names them identically");
  assert.match(first.out.at(-1), /4 generated skills are out of date/);
});

/* ------------------------------------------------------------------------------ refusals */

test("⚠️ ACC-0066 malformed or missing definitions, and a missing skills directory, exit 2 in both modes and write nothing", async () => {
  const cases = [
    ["a stage file that is not JSON", (root) => writeFileSync(join(root, "stages", "03-discovery.json"), "{ not json"), /stage-definitions-malformed: a file under stages\/ is not valid JSON/],
    [
      "a definition missing its decision owner",
      (root) => {
        const file = join(root, "stages", "05-solution-design.json");
        const def = JSON.parse(readFileSync(file, "utf8"));
        delete def.decidedBy;
        writeFileSync(file, JSON.stringify(def));
      },
      /stage-definitions-malformed: stages\/05-solution-design: decidedBy: /,
    ],
    ["no stage definitions at all", (root) => rmSync(join(root, "stages"), { recursive: true }), /stage-definitions-missing/],
    ["no skills directory", (root) => rmSync(join(root, "pi-package", "skills"), { recursive: true }), /skills-directory-missing: pi-package\/skills\/ does not exist/],
  ];

  for (const [label, breakIt, expected] of cases) {
    for (const argv of [["--check"], []]) {
      const root = copy();
      breakIt(root);
      backdate(root);
      const before = snapshot(root);
      const result = await run(root, argv);
      assert.equal(result.code, EXIT.REFUSED, `${label} ${argv.join(" ") || "(write)"}: ${result.all}`);
      assert.match(result.err.join("\n"), expected, `${label}: ${result.all}`);
      assertSame(before, snapshot(root), `${label} ${argv.join(" ") || "(write)"}`);
      assertNoMachinePath(result.all, root);
    }
  }
});

test("⚠️ ACC-0066 a generated name that is a link, or not a directory, or holds extra files, is refused rather than followed", async () => {
  // A link where a generated skill belongs, pointing outside the skills directory.
  const linked = copy();
  const outside = join(linked, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "SKILL.md"), "outside the package\n");
  symlinkSync(outside, join(linked, "pi-package", "skills", "kiln-stage-01-intake"), process.platform === "win32" ? "junction" : "dir");
  backdate(linked);

  for (const argv of [["--check"], []]) {
    const before = snapshot(linked);
    const outsideBefore = snapshot(outside);
    const result = await run(linked, argv);
    assert.equal(result.code, EXIT.REFUSED, result.all);
    assert.match(result.err.join("\n"), /linked-entry: pi-package\/skills\/kiln-stage-01-intake is a link/);
    assertSame(before, snapshot(linked), `a link, ${argv.join(" ") || "write"}`);
    assertSame(outsideBefore, snapshot(outside), "the link's target");
    assertNoMachinePath(result.all, linked);
  }

  // A file where a generated skill directory belongs.
  const file = copy();
  writeFileSync(join(file, "pi-package", "skills", "kiln-stage-02-intent-decomposition"), "a file, not a skill\n");
  backdate(file);
  const fileBefore = snapshot(file);
  const fileResult = await run(file, []);
  assert.equal(fileResult.code, EXIT.REFUSED, fileResult.all);
  assert.match(fileResult.err.join("\n"), /not-a-generated-skill: pi-package\/skills\/kiln-stage-02-intent-decomposition is not a directory/);
  assertSame(fileBefore, snapshot(file), "a file at a generated name");

  // Extra files beside a generated SKILL.md.
  const extra = copy();
  await run(extra, []);
  writeFileSync(join(extra, "pi-package", "skills", "kiln-stage-03-discovery", "reference.md"), "added by hand\n");
  backdate(extra);
  for (const argv of [["--check"], []]) {
    const before = snapshot(extra);
    const result = await run(extra, argv);
    assert.equal(result.code, EXIT.REFUSED, result.all);
    assert.match(result.err.join("\n"), /unowned-content: pi-package\/skills\/kiln-stage-03-discovery holds files the generator does not own: reference\.md/);
    assertSame(before, snapshot(extra), `extra files, ${argv.join(" ") || "write"}`);
  }
});

/* ------------------------------------------------------------------------------ the handwritten boundary */

test("⚠️ ACC-0066 kiln-planning and every other skill the generator does not own are never read, reported, changed or removed", async () => {
  const root = copy();
  const skills = join(root, "pi-package", "skills");
  // A consumer-style skill, a name that only looks like the prefix, and the handwritten one.
  mkdirSync(join(skills, "my-own-skill"));
  writeFileSync(join(skills, "my-own-skill", "SKILL.md"), "---\nname: my-own-skill\n---\n");
  mkdirSync(join(skills, "kiln-stage"));
  writeFileSync(join(skills, "kiln-stage", "SKILL.md"), "not a generated name\n");
  mkdirSync(join(skills, "kiln-stage-intake"));
  writeFileSync(join(skills, "kiln-stage-intake", "notes.md"), "not a generated name either\n");
  backdate(root);

  const untouched = () =>
    new Map([...snapshot(skills)].filter(([key]) => ["kiln-planning", "my-own-skill", "kiln-stage/", "kiln-stage-intake"].some((n) => key.startsWith(n))));
  const before = untouched();

  const outputs = [];
  for (const argv of [["--check"], [], ["--check"]]) {
    const result = await run(root, argv);
    assert.notEqual(result.code, EXIT.REFUSED, result.all);
    outputs.push(result.all);
  }
  assertSame(before, untouched(), "the skills the generator does not own");

  for (const text of outputs)
    for (const name of ["kiln-planning", "my-own-skill", "kiln-stage-intake"])
      assert.equal(text.includes(name), false, `${name} was reported:\n${text}`);
  assert.equal(/kiln-stage\b(?!-)/.test(outputs.join("\n")), false, "the bare kiln-stage directory was reported");
});

/* ------------------------------------------------------------------------------ the real program */

test("⚠️ ACC-0066 the program itself, run as a process, reports what the plan reports and changes nothing", () => {
  // ⚠️ **A COPY OF THE TOOL, NEVER THE REPOSITORY.** The program resolves its tool root from its own
  // location, so running the repository's copy would point it at the repository's own
  // `pi-package/skills/`. A defect in it - or a mutation introduced to test these tests - would then
  // write there. That happened once: a mutated binary that wrote in --check mode generated nine skills
  // into the working tree. So the bin and lib/ are copied beside a temporary tool root and run from
  // there, and nothing in this file runs anything against the repository.
  const tool = copy();
  mkdirSync(join(tool, "bin"));
  cpSync(join(ROOT, "bin", "generate-stage-skills.mjs"), join(tool, "bin", "generate-stage-skills.mjs"));
  cpSync(join(ROOT, "lib"), join(tool, "lib"), { recursive: true });
  const program = join(tool, "bin", "generate-stage-skills.mjs");

  // Some drift, so the agreement being checked is not the trivial agreement of two empty reports.
  mkdirSync(join(tool, "pi-package", "skills", "kiln-stage-01-intake"));
  writeFileSync(skillFile(tool, "kiln-stage-01-intake"), "stale\n");
  backdate(tool);

  const skills = join(tool, "pi-package", "skills");
  const before = snapshot(skills);
  const plan = checkStageSkills(tool);
  assert.equal(plan.status, "drift", "the fixture should have drift to report");

  const r = spawnSync(process.execPath, [program, "--check"], { cwd: tool, encoding: "utf-8" });
  const printed = `${r.stdout}${r.stderr}`;

  assertSame(before, snapshot(skills), "the copy's skills under a --check run as a process");
  assertNoMachinePath(printed, tool);

  assert.equal(r.status, EXIT.DRIFT, printed);
  const reported = r.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\[stage-skills\] (stale|missing|orphaned)\s+(\S+)/))
    .filter(Boolean)
    .map(([, kind, skill]) => [kind, skill]);
  assert.deepEqual(reported, plan.drift.map((d) => [d.kind, d.skill]), "the process and the in-process plan disagree");

  const unknown = spawnSync(process.execPath, [program, "--chek"], { cwd: tool, encoding: "utf-8" });
  assert.equal(unknown.status, EXIT.REFUSED, `${unknown.stdout}${unknown.stderr}`);
  assert.match(unknown.stderr, /Unrecognised argument: --chek/);
  assertSame(before, snapshot(skills), "the copy's skills after a refused argument");
});
