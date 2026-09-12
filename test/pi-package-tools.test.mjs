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
import { dirname, join, relative, sep } from "node:path";
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

/**
 * Every spelling a path can reach a JSON result in: as written, JSON-escaped, and forward-slashed.
 *
 * ⚠️ **A CHECK THAT KNOWS ONE SPELLING IS BLIND ON WINDOWS.** `JSON.stringify` doubles a backslash, so
 * `includes("C:\\Users\\...")` never matches a path that is sitting right there in the output. A
 * mutation removing the scrubbing survived exactly this gap.
 */
const spellings = (path) => [path, JSON.stringify(path).slice(1, -1), path.split("\\").join("/")];

/** Whatever a result carries, it must carry none of these. */
const assertNoMachinePath = (serialised, paths, label) => {
  for (const path of paths)
    for (const spelling of spellings(path))
      assert.equal(serialised.includes(spelling), false, `${label}: the result carries ${spelling}`);
  assert.equal(/[A-Za-z]:(\\\\|\/)/.test(serialised), false, `${label}: a drive-lettered path survived: ${serialised.slice(0, 240)}`);
  assert.equal(/\/(home|Users)\//.test(serialised), false, `${label}: a home directory survived`);
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

test("⚠️ ACC-0065 the package registers exactly its declared tools, each with a closed schema", () => {
  const tools = registered();
  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      "kiln_create_acceptance_criterion",
      "kiln_create_assertion",
      "kiln_create_component",
      "kiln_create_decision",
      "kiln_create_evidence",
      "kiln_create_question",
      "kiln_create_requirement",
      "kiln_create_runbook_step",
      "kiln_create_task",
      "kiln_lint",
      "kiln_project_status",
    ],
    "the nine creation tools and the two read tools"
  );

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
    assertNoMachinePath(text, [contentRoot, homedir()], "a read result");
  }
});


/* ============================================ the creation tools =============================== */

/**
 * The minimum each type's schema requires, and nothing more.
 *
 * ⚠️ **NOT A RESTATEMENT OF THE SCHEMAS.** These are inputs a test hands in; what makes them valid or
 * invalid is decided by the validators behind the typed tools, which is exactly the boundary these
 * cases exercise.
 */
const MINIMAL = {
  kiln_create_requirement: { title: "A requirement", statement: "The system shall keep planning artifacts typed." },
  kiln_create_assertion: { title: "A claim", statement: "This holds.", targetEnvironment: { facts: { os: "any" } } },
  kiln_create_evidence: {
    title: "A record",
    kind: "experiment",
    summary: "Observed once.",
    outcome: "success",
    observedAt: "2026-09-11",
    environment: { execution: "host", facts: { os: "any" } },
  },
  kiln_create_runbook_step: {
    title: "A step",
    instruction: "Do the thing.",
    expectedOutcome: "The thing is done.",
    restsOn: ["AST-0001"],
  },
  kiln_create_question: { title: "A question", statement: "Does it hold?", resolution: "unanswered" },
  kiln_create_decision: { title: "A decision", statement: "We will do it this way." },
  kiln_create_component: { title: "A component", responsibility: "Own one thing.", satisfies: ["REQ-0001"] },
  kiln_create_acceptance_criterion: {
    title: "A criterion",
    statement: "It is so.",
    evaluates: ["CMP-0001"],
    verifies: ["REQ-0001"],
    outcome: "not-evaluated",
  },
  kiln_create_task: {
    title: "A task",
    statement: "Build it.",
    role: "platform",
    implements: ["CMP-0001"],
    fulfils: ["REQ-0001"],
  },
};

const CREATED_TYPE = {
  kiln_create_requirement: "requirement",
  kiln_create_assertion: "assertion",
  kiln_create_evidence: "evidence",
  kiln_create_runbook_step: "runbook-step",
  kiln_create_question: "question",
  kiln_create_decision: "decision",
  kiln_create_component: "component",
  kiln_create_acceptance_criterion: "acceptance-criterion",
  kiln_create_task: "task",
};

const creationTools = () => [...registered().keys()].filter((n) => n.startsWith("kiln_create_")).sort();

test("⚠️ ACC-0065 every creation tool creates its own artifact type, through the typed registry", async () => {
  const { contentRoot } = await project();
  assert.deepEqual(creationTools(), Object.keys(CREATED_TYPE).sort(), "all nine are registered, and only those");

  for (const name of creationTools()) {
    const tools = registered();
    const result = await invoke(tools.get(name), contentRoot, { artifact: MINIMAL[name] });
    const created = result.details;

    assert.equal(created.ok, true, `${name}: ${JSON.stringify(created)}`);
    assert.equal(created.type, CREATED_TYPE[name], `${name} must create its own type`);
    assert.match(created.id, /^[A-Z]{3}-\d{4}$/, `${name}: an id was allocated`);

    // ⚠️ THE FILE THE REGISTRY WROTE, at the path the result names, holding the type it claims.
    assert.equal(created.path.startsWith("data/"), true, `${name}: ${created.path} must be relative`);
    const onDisk = JSON.parse(readFileSync(join(contentRoot, created.path.split("/").join(sep)), "utf-8"));
    assert.equal(onDisk.id, created.id);
    assert.equal(onDisk.type, CREATED_TYPE[name]);
    // Fields the tools own, assigned by the registry rather than by the caller or the wrapper.
    assert.equal(onDisk.schemaVersion, 2);
    assert.equal(onDisk.reviewStatus, "draft");
    assert.equal(onDisk.lifecycle, "active");
  }
});

test("⚠️ ACC-0065 every creation tool refuses an unknown field through the existing validation boundary", async () => {
  const { contentRoot } = await project();

  for (const name of creationTools()) {
    const before = readdirSync(join(contentRoot, "data"), { recursive: true }).length;
    const result = await invoke(registered().get(name), contentRoot, {
      artifact: { ...MINIMAL[name], id: "REQ-9999", lifecycle: "retired", somethingInvented: true },
    });

    assert.equal(result.details.ok, false, `${name} accepted fields the tools own`);
    assert.equal(result.details.code, "invalid-artifact", `${name}: ${JSON.stringify(result.details)}`);
    assert.match(result.details.message, /cannot be supplied by the caller|somethingInvented|id/i, name);
    assert.equal(
      readdirSync(join(contentRoot, "data"), { recursive: true }).length,
      before,
      `${name}: a refusal must create nothing`
    );
  }
});

test("⚠️ ACC-0065 every creation tool refuses an invalid value, and says which field", async () => {
  const { contentRoot } = await project();
  const INVALID = {
    kiln_create_requirement: { title: "x", statement: 42 },
    kiln_create_assertion: { title: "x", statement: "x", targetEnvironment: "not an object" },
    kiln_create_evidence: { title: "x", kind: "not-a-kind", summary: "x" },
    kiln_create_runbook_step: { title: "x", instruction: "Do it.", expectedOutcome: "Done.", restsOn: [] },
    kiln_create_question: { title: "x", statement: "x", resolution: "whenever" },
    kiln_create_decision: { title: "x", statement: [] },
    kiln_create_component: { title: "x", responsibility: "x", satisfies: "not a list" },
    kiln_create_acceptance_criterion: { title: "x", statement: "x", evaluates: ["CMP-0001"], verifies: ["REQ-0001"], outcome: "maybe" },
    kiln_create_task: { title: "x", statement: "x", role: 7, implements: ["CMP-0001"], fulfils: ["REQ-0001"] },
  };

  for (const name of creationTools()) {
    const result = await invoke(registered().get(name), contentRoot, { artifact: INVALID[name] });
    assert.equal(result.details.ok, false, `${name} accepted an invalid value`);
    assert.equal(result.details.code, "invalid-artifact", `${name}: ${JSON.stringify(result.details)}`);
    assert.ok(result.details.message.length > 0, `${name}: the refusal says something`);
  }
});

test("⚠️ ACC-0065 a creation result and a creation refusal carry no credential and no machine path", async () => {
  const { contentRoot } = await project();
  const planted = "sk-ant-CREATE-PLANTED-8d2c";
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = planted;

  let texts;
  try {
    const tools = registered();
    texts = [
      JSON.stringify(await invoke(tools.get("kiln_create_decision"), contentRoot, { artifact: MINIMAL.kiln_create_decision })),
      JSON.stringify(await invoke(tools.get("kiln_create_decision"), contentRoot, { artifact: { statement: 5 } })),
    ];
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }

  for (const text of texts) {
    assert.equal(text.includes(planted), false, "a planted credential reached a creation result");
    assertNoMachinePath(text, [contentRoot, homedir()], "a creation result");
  }
});

test("⚠️ ACC-0065 a refusal from the registry is scrubbed before it reaches a result", async () => {
  const { contentRoot } = await project();
  const plantedPath = join(contentRoot, "data", "decisions", "DEC-0001.json");
  const plantedHome = join(homedir(), "kiln-planted", "trace.log");

  // ⚠️ THE SEAM AGAIN, AND FOR THE SAME REASON AS THE LINT'S. The typed tools' own messages name
  // fields rather than paths, so a wrapper that forwarded them unchanged would look identical to one
  // that scrubbed them. What the wrapper owes is an answer for a message that DOES carry a path.
  const tools = new Map();
  register(
    { registerTool: (tool) => tools.set(tool.name, tool) },
    {
      TYPED_TOOLS: {
        decision: async () => {
          throw new Error(`could not write ${plantedPath}; see ${plantedHome}`);
        },
      },
    }
  );

  const result = await invoke(tools.get("kiln_create_decision"), contentRoot, { artifact: MINIMAL.kiln_create_decision });
  const serialised = JSON.stringify(result);

  assert.equal(result.details.ok, false);
  assertNoMachinePath(serialised, [plantedPath, plantedHome, homedir()], "an injected refusal");
  assert.match(result.details.message, /could not write/, "and it still says what went wrong");
});

test("⚠️ ACC-0065 the wire names map to the registry entries they claim, one to one", async () => {
  const { TYPED_TOOLS } = await import("../lib/tools/registry.mjs");

  // ⚠️ EVERY TYPE THE REGISTRY IMPLEMENTS HAS A TOOL, and every tool names a type it implements.
  assert.deepEqual(
    Object.values(CREATED_TYPE).sort(),
    Object.keys(TYPED_TOOLS).sort(),
    "the nine tools and the registry's types are the same set"
  );
  assert.equal(new Set(Object.values(CREATED_TYPE)).size, 9, "and no two tools claim the same type");
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
  assertNoMachinePath(serialised, [plantedHome, homedir()], "a lint result");
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
