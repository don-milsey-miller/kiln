/**
 * The package's read tools — TSK-0044, against ACC-0065.
 *
 * ⚠️ **THE HANDLERS RUN AGAINST A REAL CONTENT ROOT.** Each case builds a small project with the
 * typed tools, points the shared resolver at it, and invokes the handler the package registered.
 * What is asserted is the result a model would receive and what the handler left behind.
 *
 * ⚠️ **NON-MUTATION IS ASSERTED OVER BYTES AND MODIFICATION TIMES**, not over the absence of a write
 * call. A read tool that rewrote a file with identical content would still have changed the project's
 * modification times, and an operator watching a repository would see it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { createAssertion, createEvidence } from "../lib/tools/evidence-tools.mjs";
import { createValidators } from "../lib/validate.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import register from "../pi-package/extensions/kiln.js";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const validators = createValidators(SCHEMAS);

/** The tools the package registers, by name, as a session would hold them. */
const registered = () => {
  const tools = new Map();
  register({ registerTool: (tool) => tools.set(tool.name, tool) });
  return tools;
};

/** A small project with one supported assertion, enough for the lint and the handoff gate to read. */
async function project() {
  const base = reapLater(mkdtempSync(join(tmpdir(), "kiln-tools-")));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  const o = { contentRoot, schemasDir: SCHEMAS, validators, schemas };

  const claim = await createAssertion(
    { title: "It holds", statement: "This one holds.", targetEnvironment: { facts: { os: "any" } } },
    o
  );
  const ran = await createEvidence(
    {
      title: "Ran it",
      kind: "experiment",
      summary: "Observed once.",
      environment: { execution: "host", facts: { os: "any" } },
      observedAt: "2026-09-11",
      outcome: "success",
    },
    o
  );
  return { base, contentRoot, ids: { claim: claim.id, evidence: ran.id } };
}

/** Every file under a root, with its bytes and modification time. */
const snapshot = (root) => {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(root, path), { bytes: readFileSync(path), mtimeMs: statSync(path).mtimeMs });
    }
  };
  walk(root);
  return out;
};

const assertUnchanged = (before, after, label) => {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${label}: the set of files changed`);
  for (const [path, was] of before) {
    const now = after.get(path);
    assert.deepEqual(now.bytes, was.bytes, `${label}: ${path} changed`);
    assert.equal(now.mtimeMs, was.mtimeMs, `${label}: ${path} was rewritten or touched`);
  }
};

/** Invoke a handler with the resolver pointed at this project, and restore the environment after. */
async function invoke(tool, contentRoot, params = {}) {
  const saved = process.env.PLANNING_CONTENT_DIR;
  process.env.PLANNING_CONTENT_DIR = contentRoot;
  try {
    return await tool.execute("call-1", params);
  } finally {
    if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved;
  }
}

/* ============================================ what is registered =============================== */

test("⚠️ ACC-0065 the package registers exactly the two read tools, with closed schemas", () => {
  const tools = registered();
  assert.deepEqual([...tools.keys()].sort(), ["kiln_lint", "kiln_project_status"]);

  for (const tool of tools.values()) {
    assert.equal(typeof tool.execute, "function", `${tool.name} has a handler`);
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.parameters.type, "object");
    // ⚠️ CLOSED: a model cannot smuggle a parameter the wrapper never validated.
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} accepts unknown parameters`);
  }
});

/* ============================================ what they return ================================= */

test("⚠️ ACC-0065 kiln_project_status reports readiness, count and blockers, and changes nothing", async () => {
  const { contentRoot } = await project();
  const before = snapshot(contentRoot);

  const result = await invoke(registered().get("kiln_project_status"), contentRoot);
  const status = result.details;

  assert.equal(status.ok, true);
  assert.equal(typeof status.ready, "boolean");
  assert.equal(Number.isInteger(status.artifactCount) && status.artifactCount >= 2, true, "it counted the artifacts it read");
  assert.ok(Array.isArray(status.blockers));
  for (const blocker of status.blockers)
    assert.deepEqual(Object.keys(blocker).sort(), ["detail", "reason", "ruleId"], "each blocker is a closed shape");

  // The rendered half is what a model sees, and it is the same data.
  assert.deepEqual(JSON.parse(result.output), status);
  assertUnchanged(before, snapshot(contentRoot), "kiln_project_status");
});

/**
 * The same project with one artifact whose id does not match the file it sits in.
 *
 * ⚠️ **A FIXTURE WITH NO FINDINGS PROVES NOTHING ABOUT FINDINGS.** The first version of these tests
 * used a clean project, so every assertion about a finding's shape and path looped over an empty
 * list — and passed against a wrapper that returned `null` for every path it was given.
 */
async function projectWithFindings() {
  const made = await project();

  // An id that does not match the file it sits in: an error.
  const stray = join(made.contentRoot, "data", "evidences", "EVD-9999.json");
  mkdirSync(dirname(stray), { recursive: true });
  writeFileSync(
    stray,
    JSON.stringify({ id: "EVD-0404", type: "evidence", schemaVersion: 2, reviewStatus: "draft", lifecycle: "active", title: "Mismatched", kind: "experiment", summary: "x", outcome: "success", observedAt: "2026-09-11" }, null, 2)
  );

  // ⚠️ AND A SECOND SEVERITY, so "the filter narrowed the result" is a claim with something to narrow.
  // A placeholder marker is a warning rather than an error.
  await createAssertion(
    { title: "Unfinished", statement: "TODO: state what this asserts.", targetEnvironment: { facts: { os: "any" } } },
    { contentRoot: made.contentRoot, schemasDir: SCHEMAS, validators, schemas }
  );

  return made;
}

test("⚠️ ACC-0065 kiln_lint reports real findings, each with a relative path", async () => {
  const { contentRoot } = await projectWithFindings();
  const lint = (await invoke(registered().get("kiln_lint"), contentRoot)).details;

  assert.ok(lint.findingCount > 0, "the fixture must actually produce findings, or this proves nothing");
  const withPath = lint.findings.filter((f) => f.path !== null);
  assert.ok(withPath.length > 0, "a finding's path must survive the wrapper");
  for (const finding of withPath) {
    assert.equal(finding.path.startsWith("data/"), true, `a finding path must be relative to the content root: ${finding.path}`);
    assert.equal(finding.path.includes(contentRoot.split("\\").join("/")), false, "and must not carry the project's own location");
  }
  assert.ok(lint.findings.some((f) => f.ruleId !== null && f.severity !== null), "findings carry their rule and severity");
});

test("⚠️ ACC-0065 the severity filter returns only that severity, over a project that has several", async () => {
  const { contentRoot } = await projectWithFindings();
  const all = (await invoke(registered().get("kiln_lint"), contentRoot)).details;
  const severities = new Set(all.findings.map((f) => f.severity));
  assert.ok(severities.size >= 1 && all.findingCount > 0, "the fixture produces findings to filter");

  for (const severity of severities) {
    const filtered = (await invoke(registered().get("kiln_lint"), contentRoot, { severity })).details;
    assert.equal(filtered.findings.every((f) => f.severity === severity), true, `${severity}: only that severity comes back`);
    assert.equal(filtered.findingCount, all.findings.filter((f) => f.severity === severity).length, `${severity}: and all of them do`);
    if (severities.size > 1) assert.ok(filtered.findingCount < all.findingCount, `${severity}: the filter actually narrowed the result`);
  }
});

test("⚠️ ACC-0065 kiln_lint returns findings with relative paths, and changes nothing", async () => {
  const { contentRoot } = await project();
  const before = snapshot(contentRoot);

  const result = await invoke(registered().get("kiln_lint"), contentRoot);
  const lint = result.details;

  assert.equal(lint.ok, true);
  assert.equal(Number.isInteger(lint.artifactCount) && lint.artifactCount >= 2, true);
  assert.equal(lint.findingCount, lint.findings.length, "the count is of what is returned");
  for (const finding of lint.findings) {
    assert.deepEqual(Object.keys(finding).sort(), ["artifactId", "message", "path", "ruleId", "severity"]);
    if (finding.path !== null) {
      assert.equal(finding.path.startsWith("/") || /^[A-Za-z]:/.test(finding.path), false, `absolute path in a result: ${finding.path}`);
      assert.equal(finding.path.includes("\\"), false, `a machine's separators in a result: ${finding.path}`);
    }
  }

  assertUnchanged(before, snapshot(contentRoot), "kiln_lint");
});

test("⚠️ ACC-0065 a severity filter narrows what is returned, and nothing else", async () => {
  const { contentRoot } = await project();
  const all = (await invoke(registered().get("kiln_lint"), contentRoot)).details;
  const errors = (await invoke(registered().get("kiln_lint"), contentRoot, { severity: "error" })).details;

  assert.equal(errors.findings.every((f) => f.severity === "error"), true);
  assert.equal(errors.findingCount <= all.findingCount, true);
  assert.equal(errors.artifactCount, all.artifactCount, "the filter changes what is reported, not what was read");
});

test("⚠️ ACC-0065 no result carries a credential, an absolute path or a home directory", async () => {
  const { contentRoot } = await project();
  const planted = "sk-ant-TOOL-RESULT-PLANTED-4b7e";
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = planted;

  let outputs;
  try {
    const tools = registered();
    outputs = [
      JSON.stringify(await invoke(tools.get("kiln_project_status"), contentRoot)),
      JSON.stringify(await invoke(tools.get("kiln_lint"), contentRoot)),
    ];
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }

  for (const text of outputs) {
    assert.equal(text.includes(planted), false, "a planted credential reached a result");
    assert.equal(/[A-Za-z]:\\\\|\/home\/|\/Users\//.test(text), false, `an absolute path reached a result: ${text.slice(0, 200)}`);
    assert.equal(text.includes(homedir().split("\\").join("/")), false, "the operator's home reached a result");
    assert.equal(text.includes(contentRoot.split("\\").join("/")), false, "the project's own absolute path reached a result");
  }
});

/* ============================================ the wrapper's own boundary ======================== */

/**
 * The tools with a controlled lint behind them.
 *
 * ⚠️ **THE SEAM EXISTS BECAUSE ACC-0065 PUTS SANITISING ON THE WRAPPER, WHATEVER ITS DEPENDENCY
 * RETURNS.** Today's lint emits relative paths, so a wrapper that passed every path straight through
 * would be indistinguishable from one that reduced them — the mutation proving it survived. What the
 * wrapper owes is an answer for an absolute path too, and this is the only way to hand it one without
 * inventing a lint rule that does not exist. Production passes no second argument.
 */
const withLint = (lintProject) => {
  const tools = new Map();
  register({ registerTool: (tool) => tools.set(tool.name, tool) }, { lintProject });
  return tools;
};

const oneFinding = (finding) => () => ({ findings: [finding], records: [{}] });

test("⚠️ ACC-0065 an absolute path inside the project comes back relative", async () => {
  const { contentRoot } = await project();
  const absolute = join(contentRoot, "data", "assertions", "AST-0001.json");

  const tools = withLint(oneFinding({ ruleId: "storage/identity", severity: "error", message: "Mismatched id.", artifactId: "AST-0001", path: absolute }));
  const lint = (await invoke(tools.get("kiln_lint"), contentRoot)).details;

  assert.equal(lint.findings.length, 1);
  assert.equal(lint.findings[0].path, "data/assertions/AST-0001.json", "the wrapper reduces it to the project's own spelling");
});

test("⚠️ ACC-0065 a path outside the project, and a machine path in a message, reach no result", async () => {
  const { contentRoot } = await project();
  const plantedHome = join(homedir(), "kiln-planted-secret", "notes.json");

  const tools = withLint(
    oneFinding({
      ruleId: "content/placeholder-marker",
      severity: "warning",
      // ⚠️ BOTH ROUTES AT ONCE: the path field, and the same machine path inside the prose.
      message: `Placeholder found while reading ${plantedHome}`,
      artifactId: "AST-0002",
      path: plantedHome,
    })
  );
  const result = await invoke(tools.get("kiln_lint"), contentRoot);
  const serialised = JSON.stringify(result);

  assert.equal(result.details.findings[0].path, null, "a path outside the project is dropped, not reduced");
  for (const spelling of [plantedHome, plantedHome.split("\\").join("/"), homedir(), homedir().split("\\").join("/")])
    assert.equal(serialised.includes(spelling), false, `the result carries ${spelling}`);
  assert.equal(/[A-Za-z]:\\\\|[A-Za-z]:\//.test(serialised), false, `a drive-lettered path survived: ${serialised.slice(0, 300)}`);
  assert.match(result.details.findings[0].message, /placeholder found/i, "and the message still says what was wrong");
});

test("⚠️ ACC-0065 with no seam supplied, the tools use the real lint", async () => {
  const { contentRoot } = await projectWithFindings();

  // ⚠️ THE PRODUCTION PATH, asserted rather than assumed: the findings that come back are the real
  // lint's, carrying a rule id the fixture was built to trigger and which no stub here produces.
  const lint = (await invoke(registered().get("kiln_lint"), contentRoot)).details;

  assert.ok(lint.findingCount > 0);
  assert.ok(
    lint.findings.some((f) => typeof f.ruleId === "string" && f.ruleId.includes("/")),
    "the real lint's rule ids came through"
  );
  assert.ok(lint.findings.some((f) => f.path !== null && f.path.startsWith("data/")), "over the real project's files");
});

test("⚠️ ACC-0065 with no content root to resolve, each tool refuses as data rather than throwing", async () => {
  const saved = process.env.PLANNING_CONTENT_DIR;
  delete process.env.PLANNING_CONTENT_DIR;
  const cwd = process.cwd();
  const empty = reapLater(mkdtempSync(join(tmpdir(), "kiln-no-content-")));
  process.chdir(empty);

  try {
    for (const tool of registered().values()) {
      const result = await tool.execute("call-1", {});
      assert.equal(result.details.ok, false, `${tool.name} must refuse`);
      assert.equal(result.details.code, "no-content-root");
      assert.equal(result.details.message.includes(homedir()), false, "the refusal names the operator's home");
      assert.equal(/[A-Za-z]:\\\\/.test(result.details.message), false, "the refusal carries a machine path");
    }
  } finally {
    process.chdir(cwd);
    if (saved !== undefined) process.env.PLANNING_CONTENT_DIR = saved;
    rmSync(empty, { recursive: true, force: true });
  }
});
