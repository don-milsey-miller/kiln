/**
 * The role-definition check — TSK-0051 (S12), toward ACC-0072 and ACC-0073.
 *
 * ⚠️ **THE SUITE CALLS THE SAME `run` THE CI STEP CALLS.** A guard that lives only in a workflow step is
 * a guard one YAML edit removes with nothing noticing. These tests import the CLI module and invoke it,
 * so the check a cell performs and the check the suite performs are one code path rather than two
 * spellings of it.
 *
 * ⚠️ **EVERY CASE RUNS AGAINST A COPIED TOOL ROOT.** The repository's own `specialists/` is never
 * written to, and a test that corrupted a definition could not leave the working tree dirty.
 *
 * ⚠️ **`--check` IS ASSERTED TO WRITE NOTHING OVER BYTES AND MODIFICATION TIMES**, not over the absence
 * of a write call. A check that rewrote a file with identical content would still have moved its mtime,
 * and an operator watching a repository would see it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT, parseArguments, run } from "../bin/generate-specialist-roles.mjs";
import { ROLES, contractFor } from "../lib/specialists/contract.mjs";
import { PARSE_REFUSAL, RoleParseRefusal, parseRoleDefinition } from "../lib/specialists/parse.mjs";
import { GENERATED_NOTICE, RENDER_REFUSAL, RoleRenderRefusal, SPECIALISTS_DIR, renderRole } from "../lib/specialists/render.mjs";
import { DRIFT, SYNC_REFUSAL, checkRoleDefinitions, planRoleDefinitions, writeRoleDefinitions } from "../lib/specialists/role-files.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A tool root holding only what the generator reads and writes. */
function toolRoot({ definitions = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "kiln-roles-"));
  for (const dir of ["lib", "bin"]) cpSync(join(REPO, dir), join(base, dir), { recursive: true });
  if (definitions) cpSync(join(REPO, SPECIALISTS_DIR), join(base, SPECIALISTS_DIR), { recursive: true });
  return { base, dir: join(base, SPECIALISTS_DIR), file: (role) => join(base, SPECIALISTS_DIR, `${role}.md`) };
}

const snapshot = (root) => {
  const out = new Map();
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    out.set(name, { bytes: readFileSync(full).toString("base64"), mtimeMs: statSync(full).mtimeMs });
  }
  return out;
};

/** Every refusal code a run reported. */
const codes = (result) => result.refusals.map((r) => r.code).sort();

/* ============================================================ the parser ====================== */

const refusesWith = (text, code) => {
  assert.throws(
    () => parseRoleDefinition(text),
    (e) => e instanceof RoleParseRefusal && e.code === code,
    `expected ${code} for ${JSON.stringify(text.split("\n").slice(0, 3).join("\\n"))}`
  );
};

const valid = () => renderRole("validation");

/** Replace one frontmatter line, by its key. */
const withLine = (text, key, replacement) => text.replace(new RegExp(`^${key}:.*$`, "m"), replacement);

test("⚠️ the parser reads a definition this generator wrote", () => {
  for (const role of ROLES) {
    const read = parseRoleDefinition(renderRole(role));
    assert.equal(read.role, role);
    assert.equal(read.name, `kiln-specialist-${role}`);
    assert.deepEqual(read.tools, [...contractFor(role).tools]);
    assert.ok(read.sections.length === 6);
  }
});

test("⚠️ D43 frontmatter below line one is not frontmatter", () => {
  refusesWith(`<!-- a warning above the block -->\n${valid()}`, PARSE_REFUSAL.NO_FRONTMATTER);
  refusesWith("\n---\n", PARSE_REFUSAL.NO_FRONTMATTER);
  refusesWith("---\nname: \"x\"\n", PARSE_REFUSAL.UNCLOSED);
  refusesWith(valid().replace(GENERATED_NOTICE, "# something else"), PARSE_REFUSAL.NOTICE_MISSING);
});

test("⚠️ ACC-0073 a model-selection key is refused under its own code, not as an unknown key", () => {
  // ⚠️ A ROLE-SHIPPED MODEL WOULD OVERRIDE THE OPERATOR'S PROJECT SELECTION, which is why this reads as
  // its own refusal rather than as "unknown key".
  for (const key of ["provider", "model", "models", "thinking", "thinkingLevel", "reasoning", "reasoningEffort", "apiKey", "baseUrl", "api"])
    refusesWith(valid().replace(GENERATED_NOTICE, `${GENERATED_NOTICE}\n${key}: "anything"`), PARSE_REFUSAL.MODEL_SELECTION);
});

test("⚠️ the key set is closed, ordered, and every key appears exactly once", () => {
  refusesWith(valid().replace(GENERATED_NOTICE, `${GENERATED_NOTICE}\nowner: "someone"`), PARSE_REFUSAL.UNKNOWN_KEY);
  refusesWith(valid().replace(GENERATED_NOTICE, `${GENERATED_NOTICE}\nname: "kiln-specialist-validation"`), PARSE_REFUSAL.DUPLICATE_KEY);
  refusesWith(valid().replace(/^role: .*$/m, ""), PARSE_REFUSAL.MALFORMED_LINE);
  refusesWith(valid().replace(/^description: .*\n/m, ""), PARSE_REFUSAL.KEY_MISSING);

  // Reordering two keys keeps the set and breaks the order.
  const text = valid();
  const name = /^name: .*$/m.exec(text)[0];
  const role = /^role: .*$/m.exec(text)[0];
  refusesWith(text.replace(name, "<<swap>>").replace(role, name).replace("<<swap>>", role), PARSE_REFUSAL.KEY_ORDER);
});

test("⚠️ D44 a scalar that is not a JSON string is refused", () => {
  for (const bad of ['description: bare prose', "description: 'single quoted'", "description: >-", "description: 12"])
    refusesWith(withLine(valid(), "description", bad), PARSE_REFUSAL.SCALAR_NOT_JSON);
  refusesWith(withLine(valid(), "description", 'description:"no space"'), PARSE_REFUSAL.MALFORMED_LINE);
});

test("⚠️ ACC-0072 a missing, empty, inline or duplicated tool list is refused, each by name", () => {
  const text = valid();
  const list = /tools:\n(?:  - .*\n)+/.exec(text)[0];

  refusesWith(text.replace(list, ""), PARSE_REFUSAL.KEY_MISSING);
  refusesWith(text.replace(list, "tools:\n"), PARSE_REFUSAL.TOOLS_EMPTY);
  refusesWith(text.replace(list, 'tools: ["validation_run"]\n'), PARSE_REFUSAL.TOOLS_NOT_A_LIST);
  refusesWith(text.replace(list, `${list}  - "validation_run"\n`), PARSE_REFUSAL.TOOLS_DUPLICATE);
});

/* ============================================================ the plan ======================== */

test("⚠️ the repository's own definitions are current", () => {
  assert.deepEqual(checkRoleDefinitions(REPO), { status: "clean", drift: [], refusals: [], expected: ROLES.length });
});

test("⚠️ a stale byte, a missing file and an orphan are reported, each as itself", async () => {
  const fx = toolRoot();
  try {
    writeFileSync(fx.file("research"), renderRole("research").replace("Retrieve before you answer", "Answer before you retrieve"));
    rmSync(fx.file("planning"));
    writeFileSync(join(fx.dir, "archivist.md"), "# not ours\n");

    const result = checkRoleDefinitions(fx.base);
    assert.equal(result.status, "drift", JSON.stringify(result));
    assert.deepEqual(
      result.drift.map((d) => [d.role, d.kind]).sort(),
      [
        ["archivist", DRIFT.ORPHANED],
        ["planning", DRIFT.MISSING],
        ["research", DRIFT.STALE],
      ]
    );
    assert.equal(result.drift.find((d) => d.kind === DRIFT.ORPHANED).owned, false, "a hand-written file is never ours to remove");

    const { code } = await run(["--check"], fx.base);
    assert.equal(code, EXIT.DRIFT);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0072 a tool list that disagrees with the contract is a refusal naming both lists", () => {
  const fx = toolRoot();
  try {
    const text = renderRole("validation");
    writeFileSync(fx.file("validation"), text.replace('  - "validation_run"\n', ""));

    const result = checkRoleDefinitions(fx.base);
    assert.equal(result.status, "refused");
    assert.ok(codes(result).includes(SYNC_REFUSAL.TOOLS_MISMATCH), JSON.stringify(codes(result)));
    const message = result.refusals.find((r) => r.code === SYNC_REFUSAL.TOOLS_MISMATCH).message;
    assert.ok(message.includes("validation_run"), "the refusal must say which tool is missing");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("⚠️ an identity or a section set that does not match is a refusal of its own", () => {
  const fx = toolRoot();
  try {
    writeFileSync(fx.file("research"), withLine(renderRole("research"), "role", 'role: "planning"'));
    writeFileSync(fx.file("planning"), renderRole("planning").replace("## Exit criteria", "## When to stop"));

    const result = checkRoleDefinitions(fx.base);
    assert.equal(result.status, "refused");
    const found = codes(result);
    assert.ok(found.includes(SYNC_REFUSAL.IDENTITY_MISMATCH), JSON.stringify(found));
    assert.ok(found.includes(SYNC_REFUSAL.SECTIONS_MISMATCH), JSON.stringify(found));
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("⚠️ a link in the directory is reported as a link, wherever it points", (t) => {
  // ⚠️ **THIS TEST SAYS WHEN IT DID NOT RUN.** An earlier version returned silently on a host that
  // cannot create symlinks, so it passed locally while the code it covered was wrong, and all four CI
  // cells failed. A skip is visible; a silent return is a false pass.
  const fx = toolRoot();
  try {
    // Two links: one pointing OUT of the directory, one pointing to a sibling INSIDE it. Both are links
    // and neither may be read or written through, which is why the kind is decided before the path is
    // resolved. Resolving first reported the first as a path escape and the second as an ordinary file.
    const outside = join(fx.base, "elsewhere.md");
    writeFileSync(outside, renderRole("validation"));
    rmSync(fx.file("validation"));
    rmSync(fx.file("research"));
    try {
      symlinkSync(outside, fx.file("validation"), "file");
      symlinkSync(fx.file("planning"), fx.file("research"), "file");
    } catch (error) {
      t.skip(`this host cannot create symlinks (${error?.code ?? "unknown"})`);
      return;
    }

    const result = checkRoleDefinitions(fx.base);
    assert.equal(result.status, "refused", JSON.stringify(result));
    const linked = result.refusals.filter((r) => r.code === SYNC_REFUSAL.LINKED_ENTRY).map((r) => r.role).sort();
    assert.deepEqual(linked, ["research", "validation"], JSON.stringify(result.refusals));
    assert.equal(
      codes(result).includes(SYNC_REFUSAL.PATH_ESCAPE),
      false,
      "a link is reported as a link, not as wherever it happens to lead"
    );
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

/* ============================================================ the CLI ========================= */

test("⚠️ --check writes nothing, proven over bytes and modification times", async () => {
  const fx = toolRoot();
  try {
    writeFileSync(fx.file("research"), renderRole("research").replace("Retrieve before you answer", "Answer before you retrieve"));
    const before = snapshot(fx.dir);

    const { code, output } = await run(["--check"], fx.base);
    assert.equal(code, EXIT.DRIFT);
    assert.match(output, /research\.md is stale/);
    assert.match(output, /roles:generate/, "the operator is told what to run");
    assert.deepEqual(snapshot(fx.dir), before, "--check changed the directory");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("⚠️ the write repairs stale, missing and owned-orphan files, and verifies itself", async () => {
  const fx = toolRoot();
  try {
    writeFileSync(fx.file("research"), renderRole("research").replace("Retrieve before you answer", "Answer before you retrieve"));
    rmSync(fx.file("planning"));
    // An orphan the generator DID write: its notice is inside, so it may be removed.
    writeFileSync(join(fx.dir, "archivist.md"), renderRole("validation"));

    const { code, output } = await run([], fx.base);
    assert.equal(code, EXIT.CLEAN, output);
    assert.match(output, /updated .*research\.md/);
    assert.match(output, /created .*planning\.md/);
    assert.match(output, /removed .*archivist\.md/);

    assert.deepEqual(checkRoleDefinitions(fx.base), { status: "clean", drift: [], refusals: [], expected: ROLES.length });
    assert.equal(existsSync(join(fx.dir, "archivist.md")), false);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("⚠️ the write refuses wholesale rather than removing content it did not produce", async () => {
  const fx = toolRoot();
  try {
    writeFileSync(join(fx.dir, "notes.md"), "# a person's notes\n");
    rmSync(fx.file("planning"));
    const before = snapshot(fx.dir);

    const { code, output } = await run([], fx.base);
    assert.equal(code, EXIT.REFUSED, output);
    assert.match(output, /nothing was written/);
    assert.match(output, /unowned-content/);
    assert.deepEqual(snapshot(fx.dir), before, "a refused write changed the directory");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("⚠️ a missing directory is a refusal in check mode and is created in write mode", async () => {
  const fx = toolRoot({ definitions: false });
  try {
    const checked = await run(["--check"], fx.base);
    assert.equal(checked.code, EXIT.REFUSED, checked.output);
    assert.match(checked.output, /specialists-directory-missing/);
    assert.equal(existsSync(fx.dir), false, "--check created the directory");

    const written = await run([], fx.base);
    assert.equal(written.code, EXIT.CLEAN, written.output);
    assert.equal(readdirSync(fx.dir).sort().join(","), ROLES.map((r) => `${r}.md`).sort().join(","));
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("⚠️ an unrecognised argument refuses rather than falling through to the write", async () => {
  const fx = toolRoot();
  try {
    rmSync(fx.file("planning"));
    const before = snapshot(fx.dir);

    // ⚠️ `--chek` SILENTLY IGNORED WOULD RUN THE WRITE in a step that meant to check.
    for (const argv of [["--chek"], ["--check", "--force"], ["specialists"]]) {
      const { code, output } = await run(argv, fx.base);
      assert.equal(code, EXIT.REFUSED, `${argv.join(" ")}: ${output}`);
      assert.match(output, /Unrecognised argument/);
      assert.deepEqual(snapshot(fx.dir), before, `${argv.join(" ")} wrote something`);
    }

    assert.deepEqual(parseArguments(["--check"]), { mode: "check" });
    assert.deepEqual(parseArguments([]), { mode: "write" });
    assert.deepEqual(parseArguments(["--help"]), { mode: "help" });
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("⚠️ --help prints the usage and exits clean without touching the directory", async () => {
  const fx = toolRoot();
  try {
    const before = snapshot(fx.dir);
    for (const flag of ["--help", "-h"]) {
      const { code, output } = await run([flag], fx.base);
      assert.equal(code, EXIT.CLEAN);
      assert.match(output, /Exit codes:/);
      assert.deepEqual(snapshot(fx.dir), before);
    }
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("⚠️ the check the suite runs is the check CI runs, and it is clean for this repository", async () => {
  // ⚠️ THE SAME ENTRY POINT THE WORKFLOW STEP CALLS. A guard that lived only in the workflow would leave
  // with one YAML edit and nothing would fail.
  const { code, output } = await run(["--check"], REPO);
  assert.equal(code, EXIT.CLEAN, output);
  assert.match(output, new RegExp(`all ${ROLES.length} role definitions match`));
});

/* ======================================== the guards no shipped role can reach ================= */

test("⚠️ ACC-0072 a role whose contract derives no tools is refused, never rendered", () => {
  // ⚠️ REACHED THROUGH A SEAM BECAUSE THE THREE SHIPPED ROLES ALL DERIVE TOOLS. The guard exists for the
  // role somebody adds later with an empty boundary, and a mutation removing it survived until this
  // test was written. A definition with no `tools:` line does not narrow the child; it hands it a shell.
  const real = contractFor("validation");
  assert.throws(
    () => renderRole("validation", { contract: { ...real, tools: [] } }),
    (e) => e instanceof RoleRenderRefusal && e.code === RENDER_REFUSAL.NO_TOOLS
  );
  assert.throws(
    () => renderRole("validation", { contract: { ...real, unimplemented: ["sprint"] } }),
    (e) => e instanceof RoleRenderRefusal && e.code === RENDER_REFUSAL.CONTRACT_UNSOUND
  );
  // The real contract still renders, so the seam has not quietly become the normal path.
  assert.ok(renderRole("validation").includes("kiln_create_evidence"));
});

test("⚠️ a write that leaves the directory stale reports it rather than claiming success", async () => {
  // ⚠️ ALSO UNREACHABLE SINGLE-THREADED: the renderer is deterministic and the write writes what it
  // planned, so only a defect in the write path could leave drift. The seam makes the second plan
  // disagree, which is exactly the shape that defect would take.
  const fx = toolRoot();
  try {
    rmSync(fx.file("planning"));
    let call = 0;
    const plan = (root) => {
      call += 1;
      const real = planRoleDefinitions(root);
      // The first plan is honest; the second pretends the directory is still stale.
      return call === 1 ? real : { ...real, drift: [{ kind: DRIFT.STALE, role: "planning", path: `${SPECIALISTS_DIR}/planning.md` }] };
    };

    const result = await writeRoleDefinitions(fx.base, { plan });
    assert.equal(result.status, "refused", JSON.stringify(result));
    assert.ok(codes(result).includes(SYNC_REFUSAL.UNVERIFIED), JSON.stringify(codes(result)));
    assert.ok(result.changes.some((c) => c.role === "planning"), "the change it did make is still reported");

    // And with an honest plan the same write succeeds, so the seam is not the thing failing.
    assert.equal((await writeRoleDefinitions(fx.base)).status, "written");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});
