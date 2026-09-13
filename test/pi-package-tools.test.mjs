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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { createAssertion, createEvidence } from "../lib/tools/evidence-tools.mjs";
import { createValidators } from "../lib/validate.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import register, { SIGNATURE } from "../pi-package/extensions/kiln.js";

/**
 * The declaration as it sits on disk.
 *
 * ⚠️ **READ FROM THE FILE, NOT FROM THE MODULE.** Comparing the tool's answer against the same
 * import the tool returns would be comparing an object with itself. The file is the thing the
 * package ships and a consumer compares against.
 */

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = join(ROOT, "pi-package");
const DECLARATION = JSON.parse(readFileSync(join(PACKAGE_ROOT, "signature.json"), "utf-8"));

/** The tools whose subject is not the project: the package's own declaration, and the public web. */
const PROJECTLESS = new Set([
  "kiln_capability",
  "research_capability",
  "research_search",
  "research_fetch",
  "validation_capability",
  "validation_run",
]);
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
      "kiln_capability",
      "kiln_create_acceptance_criterion",
      "kiln_create_assertion",
      "kiln_create_component",
      "kiln_create_decision",
      "kiln_create_evidence",
      "kiln_create_question",
      "kiln_create_requirement",
      "kiln_create_runbook_step",
      "kiln_create_task",
      "kiln_link_evidence",
      "kiln_link_trace",
      "kiln_lint",
      "kiln_project_status",
      "kiln_read_stage_attestations",
      "kiln_resolve_question",
      "kiln_revise_artifact",
      "kiln_set_lifecycle",
      "kiln_set_review_status",
      "kiln_set_type_activation",
      "kiln_unlink_evidence",
      "kiln_unlink_trace",
      "kiln_write_stage_attestation",
      "research_capability",
      "research_fetch",
      "research_search",
      "validation_capability",
      "validation_run",
    ],
    "every tool this package declares: nine creations, eight mutations, two reads, activation and the two attestations"
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


/* ============================================ the mutation tools =============================== */

const MUTATION_TOOL_NAMES = Object.freeze([
  "kiln_link_evidence",
  "kiln_link_trace",
  "kiln_resolve_question",
  "kiln_revise_artifact",
  "kiln_set_lifecycle",
  "kiln_set_review_status",
  "kiln_unlink_evidence",
  "kiln_unlink_trace",
]);

/** The artifact on disk, read back as the project holds it. */
const artifact = (contentRoot, path) => JSON.parse(readFileSync(join(contentRoot, path.split("/").join(sep)), "utf-8"));

/** A project with the artifacts these operations need, created through the tools themselves. */
async function mutableProject() {
  const made = await project();
  const tools = registered();
  const create = async (name, fields) => (await invoke(tools.get(name), made.contentRoot, { artifact: fields })).details;

  const question = await create("kiln_create_question", MINIMAL.kiln_create_question);
  const decision = await create("kiln_create_decision", MINIMAL.kiln_create_decision);
  const component = await create("kiln_create_component", MINIMAL.kiln_create_component);
  const criterion = await create("kiln_create_acceptance_criterion", MINIMAL.kiln_create_acceptance_criterion);
  // ⚠️ A SECOND COMPONENT, because the criterion already evaluates CMP-0001 and `evaluates` may not be
  // emptied: unlinking the only entry is refused by the schema, correctly, and would test nothing here.
  const other = await create("kiln_create_component", { ...MINIMAL.kiln_create_component, title: "Another component" });
  return { ...made, question, decision, component, criterion, other };
}

test("⚠️ ACC-0065 the eight mutation tools are registered, each with a closed schema", () => {
  const tools = registered();
  for (const name of MUTATION_TOOL_NAMES) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} is registered`);
    assert.equal(tool.parameters.additionalProperties, false, `${name} accepts unknown parameters`);
    assert.ok(Array.isArray(tool.parameters.required) && tool.parameters.required.length > 0, `${name} requires its inputs`);
  }
});

test("⚠️ ACC-0065 each mutation tool makes exactly its own change, on disk", async () => {
  const made = await mutableProject();
  const { contentRoot } = made;
  const tools = registered();
  const call = (name, params) => invoke(tools.get(name), contentRoot, params);

  // 1. linkEvidence, then unlinkEvidence, on the assertion and evidence the fixture created.
  const claim = artifact(contentRoot, "data/assertions/AST-0001.json");
  const linked = await call("kiln_link_evidence", { assertion: claim.id, evidence: made.ids.evidence, polarity: "support" });
  assert.equal(linked.details.ok, true, JSON.stringify(linked.details));
  assert.deepEqual(
    artifact(contentRoot, "data/assertions/AST-0001.json").supportedBy,
    [made.ids.evidence],
    "the evidence is linked as supporting, and only that"
  );

  const unlinked = await call("kiln_unlink_evidence", { assertion: claim.id, evidence: made.ids.evidence, polarity: "support" });
  assert.equal(unlinked.details.ok, true, JSON.stringify(unlinked.details));
  assert.deepEqual(artifact(contentRoot, "data/assertions/AST-0001.json").supportedBy ?? [], [], "and withdrawing it leaves none");

  // ⚠️ **THE OTHER POLARITY, BECAUSE ONE OF THEM PROVES NOTHING ABOUT THE ARGUMENT.** A wrapper that
  // passed a fixed "support" would satisfy every case above; refuting is where that shows.
  const refuted = await call("kiln_link_evidence", { assertion: claim.id, evidence: made.ids.evidence, polarity: "refute" });
  assert.equal(refuted.details.ok, true, JSON.stringify(refuted.details));
  const contested = artifact(contentRoot, "data/assertions/AST-0001.json");
  assert.deepEqual(contested.refutedBy, [made.ids.evidence], "the evidence is linked as refuting");
  assert.deepEqual(contested.supportedBy ?? [], [], "and not as supporting");

  const unrefuted = await call("kiln_unlink_evidence", { assertion: claim.id, evidence: made.ids.evidence, polarity: "refute" });
  assert.equal(unrefuted.details.ok, true, JSON.stringify(unrefuted.details));
  assert.deepEqual(artifact(contentRoot, "data/assertions/AST-0001.json").refutedBy ?? [], [], "and it can be withdrawn again");

  // 2. reviseArtifact changes the field it was given, and nothing else.
  const before = artifact(contentRoot, made.decision.path);
  const revised = await call("kiln_revise_artifact", { type: "decision", id: made.decision.id, changes: { title: "A revised decision" } });
  assert.equal(revised.details.ok, true, JSON.stringify(revised.details));
  const after = artifact(contentRoot, made.decision.path);
  assert.equal(after.title, "A revised decision");
  assert.deepEqual({ ...after, title: null }, { ...before, title: null }, "nothing else moved");
  assert.deepEqual(revised.details.changedFields, ["title"], "and the result says which field changed");

  // 3. setLifecycle, with the successor it requires.
  const retired = await call("kiln_set_lifecycle", { type: "decision", id: made.decision.id, lifecycle: "retired" });
  assert.equal(retired.details.ok, true, JSON.stringify(retired.details));
  assert.equal(artifact(contentRoot, made.decision.path).lifecycle, "retired");

  // 4. resolveQuestion records what settled it.
  const resolved = await call("kiln_resolve_question", { id: made.question.id, resolution: "answered", answer: "It holds." });
  assert.equal(resolved.details.ok, true, JSON.stringify(resolved.details));
  const question = artifact(contentRoot, made.question.path);
  assert.equal(question.resolution, "answered");
  assert.equal(question.answer, "It holds.");

  // 5. linkTrace and unlinkTrace on a trace field.
  const traced = await call("kiln_link_trace", { type: "acceptance-criterion", id: made.criterion.id, field: "evaluates", targets: [made.other.id] });
  assert.equal(traced.details.ok, true, JSON.stringify(traced.details));
  assert.ok(
    artifact(contentRoot, made.criterion.path).evaluates.includes(made.other.id),
    "the trace target is there"
  );

  const untraced = await call("kiln_unlink_trace", { type: "acceptance-criterion", id: made.criterion.id, field: "evaluates", targets: [made.other.id] });
  assert.equal(untraced.details.ok, true, JSON.stringify(untraced.details));
  assert.equal(
    artifact(contentRoot, made.criterion.path).evaluates.includes(made.other.id),
    false,
    "and withdrawing it removes exactly that one"
  );

  // 6. setReviewStatus moves review, and only review.
  const reviewed = await call("kiln_set_review_status", { type: "component", id: made.component.id, reviewStatus: "in-review" });
  assert.equal(reviewed.details.ok, true, JSON.stringify(reviewed.details));
  assert.equal(artifact(contentRoot, made.component.path).reviewStatus, "in-review");
});

test("⚠️ ACC-0065 a trace field can be changed only by its own operation, never by revising", async () => {
  const made = await mutableProject();
  const tools = registered();
  const before = snapshot(made.contentRoot);

  // ⚠️ THE REGISTRY'S RULE, NOT THE WRAPPER'S: the reviser refuses trace fields, and the wrapper
  // neither smuggles them through nor swallows the refusal.
  const refused = await invoke(tools.get("kiln_revise_artifact"), made.contentRoot, {
    type: "acceptance-criterion",
    id: made.criterion.id,
    changes: { evaluates: [made.component.id] },
  });

  assert.equal(refused.details.ok, false, "revising a trace field must be refused");
  assert.match(refused.details.message, /trace|linkTrace|evaluates/i, refused.details.message);
  assertUnchanged(before, snapshot(made.contentRoot), "a refused trace revision");

  // And the dedicated operation does what the reviser would not.
  const allowed = await invoke(tools.get("kiln_link_trace"), made.contentRoot, {
    type: "acceptance-criterion",
    id: made.criterion.id,
    field: "evaluates",
    targets: [made.component.id],
  });
  assert.equal(allowed.details.ok, true, JSON.stringify(allowed.details));
});

test("⚠️ ACC-0065 every mutation refusal leaves every byte and modification time alone", async () => {
  const made = await mutableProject();
  const { contentRoot } = made;
  const tools = registered();

  const cases = [
    ["an unknown property", "kiln_revise_artifact", { type: "decision", id: made.decision.id, changes: { notAField: 1 } }],
    ["a malformed id", "kiln_revise_artifact", { type: "decision", id: "DEC-1", changes: { title: "x" } }],
    ["an artifact that is not there", "kiln_set_review_status", { type: "decision", id: "DEC-9999", reviewStatus: "approved" }],
    ["an unknown review status", "kiln_set_review_status", { type: "decision", id: made.decision.id, reviewStatus: "blessed" }],
    ["an unknown lifecycle", "kiln_set_lifecycle", { type: "decision", id: made.decision.id, lifecycle: "mothballed" }],
    ["superseding with no successor", "kiln_set_lifecycle", { type: "decision", id: made.decision.id, lifecycle: "superseded" }],
    ["answering with nothing recorded", "kiln_resolve_question", { id: made.question.id, resolution: "answered" }],
    ["reopening a question", "kiln_resolve_question", { id: made.question.id, resolution: "unanswered" }],
    ["a trace field that does not exist", "kiln_link_trace", { type: "decision", id: made.decision.id, field: "inventedField", targets: ["CMP-0001"] }],
    ["linking evidence that is not there", "kiln_link_evidence", { assertion: "AST-0001", evidence: "EVD-9999", polarity: "support" }],
  ];

  for (const [label, name, params] of cases) {
    const before = snapshot(contentRoot);
    const result = await invoke(tools.get(name), contentRoot, params);

    assert.equal(result.details.ok, false, `${label}: ${name} accepted it`);
    assert.ok(result.details.message.length > 0, `${label}: the refusal says something`);
    assertUnchanged(before, snapshot(contentRoot), label);
  }
});

test("⚠️ ACC-0065 a mutation result and a mutation refusal carry no credential and no machine path", async () => {
  const made = await mutableProject();
  const planted = "sk-ant-MUTATE-PLANTED-6f1a";
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = planted;

  let texts;
  try {
    const tools = registered();
    texts = [
      JSON.stringify(await invoke(tools.get("kiln_set_review_status"), made.contentRoot, { type: "component", id: made.component.id, reviewStatus: "in-review" })),
      JSON.stringify(await invoke(tools.get("kiln_revise_artifact"), made.contentRoot, { type: "decision", id: made.decision.id, changes: { notAField: 1 } })),
    ];
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }

  for (const text of texts) {
    assert.equal(text.includes(planted), false, "a planted credential reached a mutation result");
    assertNoMachinePath(text, [made.contentRoot, homedir()], "a mutation result");
  }
});

test("⚠️ ACC-0065 the mutation wire names map to the registry entries they claim, one to one", async () => {
  const { MUTATION_TOOLS } = await import("../lib/tools/registry.mjs");
  const entries = ["linkEvidence", "unlinkEvidence", "reviseArtifact", "setLifecycle", "resolveQuestion", "linkTrace", "unlinkTrace", "setReviewStatus"];

  assert.deepEqual(entries.slice().sort(), Object.keys(MUTATION_TOOLS).sort(), "the eight tools and the registry's operations are the same set");
  assert.deepEqual([...registered().keys()].filter((n) => MUTATION_TOOL_NAMES.includes(n)).sort(), [...MUTATION_TOOL_NAMES]);
});


/* ============================================ activation and attestations ====================== */

/**
 * A project with a manifest, which activation needs and the other tools do not.
 *
 * ⚠️ **THE MANIFEST CARRIES A COMMENT ON PURPOSE.** Activation rewrites one line of it, and a rewrite
 * that discarded the rest would be an edit rather than an approval.
 */
const MANIFEST = (activated) => `name: fixture
capabilities:
  # a comment that must survive an approval
  artifactTypes:
    activated: [${activated.join(", ")}]
  sandboxTiers:
    active:
      - 1
`;

async function projectWithManifest(activated = ["requirement", "decision"]) {
  const made = await project();
  writeFileSync(join(made.contentRoot, "project.yaml"), MANIFEST(activated));
  return made;
}

const manifestOf = (contentRoot) => readFileSync(join(contentRoot, "project.yaml"), "utf-8");

test("⚠️ ACC-0065 activation records the approval, and reports the list the manifest now holds", async () => {
  const { contentRoot } = await projectWithManifest();
  const tools = registered();

  const result = (
    await invoke(tools.get("kiln_set_type_activation"), contentRoot, {
      type: "component",
      action: "activate",
      approvedBy: "the product manager",
      reason: "components are being authored",
    })
  ).details;

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, true);
  assert.equal(result.type, "component");
  assert.equal(result.action, "activate");
  assert.ok(result.activated.includes("component"), "the reported list is the one that was written");
  assert.equal(result.noChangeBecause, null);

  const manifest = manifestOf(contentRoot);
  assert.match(manifest, /approved by the product manager/, "the approver is recorded where the list is");
  assert.match(manifest, /components are being authored/);
  assert.match(manifest, /a comment that must survive an approval/, "and the rest of the manifest is untouched");
});

test("⚠️ ACC-0065 deactivation is offered, and a no-op says so rather than claiming a change", async () => {
  const { contentRoot } = await projectWithManifest(["requirement", "decision"]);
  const tools = registered();
  const activate = (type, action) =>
    invoke(tools.get("kiln_set_type_activation"), contentRoot, { type, action, approvedBy: "pm" });

  const again = (await activate("decision", "activate")).details;
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.changed, false, "an activated type is not activated twice");
  assert.equal(again.noChangeBecause, "already activated");

  const off = (await activate("requirement", "deactivate")).details;
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(off.changed, true);
  assert.equal(off.activated.includes("requirement"), false, "and the manifest no longer lists it");
});

test("⚠️ ACC-0065 activation refusals are the operation's own, and change nothing", async () => {
  const { contentRoot } = await projectWithManifest();
  const tools = registered();
  const call = (params) => invoke(tools.get("kiln_set_type_activation"), contentRoot, params);

  // An artifact of the type exists, so deactivating it would strand it.
  const decision = (await invoke(tools.get("kiln_create_decision"), contentRoot, { artifact: MINIMAL.kiln_create_decision })).details;
  assert.equal(decision.ok, true, JSON.stringify(decision));

  const cases = [
    ["no approver", { type: "component", action: "activate" }, /who approved/i],
    ["a type the catalogue does not have", { type: "sprint", action: "activate", approvedBy: "pm" }, /catalogue/i],
    ["an action that is neither", { type: "component", action: "archive", approvedBy: "pm" }, /activate/i],
    ["deactivating a type whose artifacts exist", { type: "decision", action: "deactivate", approvedBy: "pm" }, /strand/i],
  ];

  for (const [label, params, expected] of cases) {
    const before = snapshot(contentRoot);
    const result = (await call(params)).details;

    assert.equal(result.ok, false, `${label}: it was accepted`);
    // ⚠️ NOT `invalid-artifact`: there is no artifact here to be invalid.
    assert.equal(result.code, "invalid-request", `${label}: ${result.code}`);
    assert.match(result.message, expected, `${label}: ${result.message}`);
    assertUnchanged(before, snapshot(contentRoot), label);
  }
});

test("⚠️ ACC-0065 an attestation is written and read back, one stage at a time", async () => {
  const { contentRoot } = await project();
  const tools = registered();
  const write = (params) => invoke(tools.get("kiln_write_stage_attestation"), contentRoot, params);
  const read = (stage) => invoke(tools.get("kiln_read_stage_attestations"), contentRoot, { stage });

  // Nothing recorded yet is an empty answer, not a refusal.
  const empty = (await read("03-discovery")).details;
  assert.equal(empty.ok, true, JSON.stringify(empty));
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.attestations, []);
  assert.equal(empty.path, "state/stage-attestations/03-discovery.json", "it says where they would live");

  const written = (await write({ stage: "03-discovery", criterion: "unknowns-resolved", result: "satisfied", decidedBy: "the reviewer" })).details;
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.equal(written.result, "satisfied");
  assert.equal(written.decidedBy, "the reviewer");
  assert.equal(written.path, "state/stage-attestations/03-discovery.json");

  // On disk, where the gate reads it.
  const onDisk = JSON.parse(readFileSync(join(contentRoot, "state", "stage-attestations", "03-discovery.json"), "utf-8"));
  assert.equal(onDisk.stageId, "03-discovery");
  assert.deepEqual(onDisk.attestations["unknowns-resolved"], { result: "satisfied", decidedBy: "the reviewer" });

  // A second criterion joins the first rather than replacing it.
  await write({ stage: "03-discovery", criterion: "sources-reconciled", result: "n/a", decidedBy: "the reviewer", reason: "no second source" });
  const both = (await read("03-discovery")).details;
  assert.equal(both.count, 2);
  assert.deepEqual(
    both.attestations.map((a) => [a.criterion, a.result, a.reason]).sort(),
    [
      ["sources-reconciled", "n/a", "no second source"],
      ["unknowns-resolved", "satisfied", null],
    ]
  );

  // And another stage's file is its own.
  const other = (await read("04-requirement-gaps")).details;
  assert.equal(other.count, 0, "one stage's evaluations do not appear under another's");
});

test("⚠️ ACC-0065 every attestation refusal leaves every byte and modification time alone", async () => {
  const { contentRoot } = await project();
  const tools = registered();
  await invoke(tools.get("kiln_write_stage_attestation"), contentRoot, {
    stage: "03-discovery",
    criterion: "unknowns-resolved",
    result: "satisfied",
    decidedBy: "the reviewer",
  });

  const cases = [
    // ⚠️ SEEING A CRITERION IS NOT A VERDICT ON IT. There is deliberately no "acknowledged" result.
    ["a result that is not a verdict", "kiln_write_stage_attestation", { stage: "03-discovery", criterion: "unknowns-resolved", result: "acknowledged", decidedBy: "r" }],
    ["nobody deciding it", "kiln_write_stage_attestation", { stage: "03-discovery", criterion: "unknowns-resolved", result: "satisfied", decidedBy: "" }],
    ["n/a with no reason", "kiln_write_stage_attestation", { stage: "03-discovery", criterion: "unknowns-resolved", result: "n/a", decidedBy: "r" }],
    ["a stage id that is not one", "kiln_write_stage_attestation", { stage: "discovery", criterion: "unknowns-resolved", result: "satisfied", decidedBy: "r" }],
    ["reading a stage id that is not one", "kiln_read_stage_attestations", { stage: "3-discovery" }],
  ];

  for (const [label, name, params] of cases) {
    const before = snapshot(contentRoot);
    const result = (await invoke(tools.get(name), contentRoot, params)).details;

    assert.equal(result.ok, false, `${label}: it was accepted`);
    assert.ok(result.message.length > 0, `${label}: the refusal says something`);
    assertUnchanged(before, snapshot(contentRoot), label);
  }
});

test("⚠️ ACC-0065 a malformed attestations file is refused, with no machine path in the refusal", async () => {
  const { contentRoot } = await project();
  const dir = join(contentRoot, "state", "stage-attestations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "05-solution-design.json"), "{ not json");

  const result = (await invoke(registered().get("kiln_read_stage_attestations"), contentRoot, { stage: "05-solution-design" })).details;

  assert.equal(result.ok, false);
  assertNoMachinePath(JSON.stringify(result), [contentRoot, homedir()], "a malformed attestations refusal");
});

test("⚠️ ACC-0065 an activation result and an attestation result carry no credential and no machine path", async () => {
  const { contentRoot } = await projectWithManifest();
  const planted = "sk-ant-PROJECT-STATE-PLANTED-4c2b";
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = planted;

  let texts;
  try {
    const tools = registered();
    texts = [
      JSON.stringify(await invoke(tools.get("kiln_set_type_activation"), contentRoot, { type: "component", action: "activate", approvedBy: "pm" })),
      JSON.stringify(await invoke(tools.get("kiln_set_type_activation"), contentRoot, { type: "sprint", action: "activate", approvedBy: "pm" })),
      JSON.stringify(await invoke(tools.get("kiln_write_stage_attestation"), contentRoot, { stage: "03-discovery", criterion: "unknowns-resolved", result: "satisfied", decidedBy: "r" })),
      JSON.stringify(await invoke(tools.get("kiln_read_stage_attestations"), contentRoot, { stage: "03-discovery" })),
    ];
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }

  for (const text of texts) {
    assert.equal(text.includes(planted), false, "a planted credential reached a project-state result");
    assertNoMachinePath(text, [contentRoot, homedir()], "a project-state result");
  }
});

test("⚠️ ACC-0065 activation goes through the project registry, not around it", async () => {
  const { PROJECT_TOOLS } = await import("../lib/tools/registry.mjs");

  // ⚠️ THE REGISTRY KEEPS THIS SEPARATE FROM THE MUTATION TOOLS, and so does the wrapper: the manifest
  // is not an artifact, and an operation on it does not belong in a list of operations on artifacts.
  assert.deepEqual(Object.keys(PROJECT_TOOLS), ["setTypeActivation"]);

  const called = [];
  const tools = new Map();
  register(
    { registerTool: (tool) => tools.set(tool.name, tool) },
    {
      PROJECT_TOOLS: {
        setTypeActivation: (type, action, options) => {
          called.push({ type, action, toolRoot: typeof options.toolRoot, approvedBy: options.approvedBy });
          return { type, action, changed: true, activated: [type] };
        },
      },
    }
  );

  const { contentRoot } = await projectWithManifest();
  await invoke(tools.get("kiln_set_type_activation"), contentRoot, { type: "component", action: "activate", approvedBy: "pm" });

  // ⚠️ `toolRoot` IS THE ONE ARGUMENT THE OPERATION CANNOT DO WITHOUT: the stage definitions live under
  // it, and without them activation refuses rather than checking that a stage produces the type.
  assert.deepEqual(called, [{ type: "component", action: "activate", toolRoot: "string", approvedBy: "pm" }]);
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
    // ⚠️ **EVERY TOOL THAT HAS A PROJECT TO RESOLVE.** `kiln_capability` answers a question about the
    // package, and the research tools read the public web; none of them has a content root to fail to
    // find, and a wrapper that demanded one would make a host capability unavailable in a directory
    // that merely lacks planning content. They are asserted below instead.
    for (const tool of registered().values()) {
      if (PROJECTLESS.has(tool.name)) continue;
      const result = await tool.execute("call-1", {});
      assert.equal(result.details.ok, false, `${tool.name} must refuse`);
      assert.equal(result.details.code, "no-content-root");
      assert.equal(result.details.message.includes(homedir()), false, "the refusal names the operator's home");
      assert.equal(/[A-Za-z]:\\\\/.test(result.details.message), false, "the refusal carries a machine path");
    }

    // ⚠️ THE ONE THAT ANSWERS WITH NO PROJECT AT ALL. Its subject is the package, not the project.
    const capability = await registered().get("kiln_capability").execute("call-1", {});
    assert.deepEqual(capability.details, DECLARATION, "the declaration is returned wherever the session stands");
  } finally {
    process.chdir(cwd);
    if (saved !== undefined) process.env.PLANNING_CONTENT_DIR = saved;
    rmSync(empty, { recursive: true, force: true });
  }
});

/* ============================================ the research tools =============================== */

/**
 * A recording stand-in for the three research handlers.
 *
 * ⚠️ **THE SEAM IS HOW THESE ARE TESTED WITHOUT A BACKEND.** The production path builds the real
 * tools over the real adapter, which is asserted separately; what this controls is what a handler
 * returns, so the wrapper's own behaviour - what it passes in and what it hands back - can be seen.
 */
const withResearch = (researchTools) => {
  const tools = new Map();
  register({ registerTool: (tool) => tools.set(tool.name, tool) }, { researchTools });
  return tools;
};

/** Invoke a handler with no project in the environment: research needs none. */
const invokeAnywhere = async (tool, params = {}) => tool.execute("call-1", params);

test("⚠️ ACC-0110 the three research tools register under the contract's names, with its measured schemas", async () => {
  const { RESEARCH_TOOL_SIGNATURES } = await import("../lib/research/tools.mjs");
  const { contractFor } = await import("../lib/specialists/contract.mjs");
  const tools = registered();

  // ⚠️ **THE CONTRACT'S KEYS, NOT A NAMING HABIT.** `verifyChild` checks a child's registry against
  // these exact names; a `kiln_` prefix would break the contract to satisfy a convention.
  assert.deepEqual(contractFor("research").requiredCapabilities, ["research_capability", "research_search", "research_fetch"]);

  for (const name of contractFor("research").requiredCapabilities) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} is not registered`);
    // ⚠️ DEEP EQUALITY AGAINST THE MEASURED SIGNATURE. The wrapper writes the schema out because it
    // cannot import `lib/` at registration; this is what keeps the two statements one.
    assert.deepEqual(tool.parameters, RESEARCH_TOOL_SIGNATURES[name].input, `${name}'s schema is not the measured one`);
    assert.equal(tool.description, RESEARCH_TOOL_SIGNATURES[name].description, `${name}'s description is not the measured one`);
    assert.ok(DECLARATION.tools.includes(name), `${name} is not declared`);
  }
});

test("⚠️ ACC-0110 each research tool hands its parameters to the implementation and its answer back unchanged", async () => {
  const seen = [];
  const answer = (name) => async (params) => {
    seen.push({ name, params });
    return { tool: name, ok: true, kind: "discovery", marker: `answered-by-${name}` };
  };
  const tools = withResearch({
    research_capability: answer("research_capability"),
    research_search: answer("research_search"),
    research_fetch: answer("research_fetch"),
  });

  const searched = await invokeAnywhere(tools.get("research_search"), { query: "what holds", maxResults: 3 });
  const fetched = await invokeAnywhere(tools.get("research_fetch"), { url: "https://example.invalid/page" });
  const probed = await invokeAnywhere(tools.get("research_capability"), {});

  // ⚠️ STRAIGHT THROUGH, BOTH WAYS. The wrapper neither reshapes the input nor edits the answer.
  assert.deepEqual(
    seen,
    [
      { name: "research_search", params: { query: "what holds", maxResults: 3 } },
      { name: "research_fetch", params: { url: "https://example.invalid/page" } },
      { name: "research_capability", params: {} },
    ]
  );
  assert.deepEqual(searched.details, { tool: "research_search", ok: true, kind: "discovery", marker: "answered-by-research_search" });
  assert.equal(fetched.details.marker, "answered-by-research_fetch");
  assert.equal(probed.details.marker, "answered-by-research_capability");
});

test("⚠️ ACC-0110 a capability refusal reaches the caller as the library's own data, not as the wrapper's", async () => {
  // ⚠️ **THE REAL LIBRARY, WITH NO CREDENTIAL AND NO NETWORK.** Without the key the adapter refuses
  // before it calls anything, so this exercises the production path offline and deterministically.
  const saved = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;

  try {
    const probed = (await invokeAnywhere(registered().get("research_capability"))).details;

    // The library's shape, kept: available/false with a reason a machine can switch on, and the
    // instruction to record a gap rather than answer from memory.
    assert.equal(probed.available, false);
    assert.equal(probed.reason, "no-credential");
    assert.equal(probed.mustRecordGap, true);
    assert.equal(probed.backend, "tavily", "the production path built the real adapter");
    assert.ok(probed.signatures?.research_search, "the library's measured signatures came through");

    // ⚠️ AND THE WRAPPER DID NOT TURN IT INTO ITS OWN REFUSAL: no `code`, and `ok` is not the
    // wrapper's false. A capability that is unavailable and a request that was refused are
    // different facts, and folding them together is what this checks has not happened.
    assert.equal(probed.code, undefined);

    const searched = (await invokeAnywhere(registered().get("research_search"), { query: "anything" })).details;
    assert.equal(searched.ok, false);
    assert.equal(searched.reason, "no-credential");
    assert.match(searched.instruction, /record the gap/i);
  } finally {
    if (saved === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = saved;
  }
});

test("⚠️ ACC-0110 a request the boundary refuses stays a request refusal, and reaches no network", async () => {
  const calls = [];
  const { createResearchTools } = await import("../lib/research/tools.mjs");
  const tools = withResearch(
    createResearchTools(
      { name: "stand-in", envVar: "NONE", probe: async () => ({ ok: true }), search: async () => ({ ok: true, results: [] }) },
      { fetchImpl: async (...args) => { calls.push(args); throw new Error("the boundary let a blocked URL through"); } }
    )
  );

  // ⚠️ A PRIVATE DESTINATION IS REFUSED BEFORE ANYTHING IS SENT, and the refusal says which kind it
  // is: the capability is fine, this one URL was out of bounds.
  const blocked = (await invokeAnywhere(tools.get("research_fetch"), { url: "http://127.0.0.1/secrets" })).details;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.kind, "request-refused", JSON.stringify(blocked));
  assert.equal(blocked.mustRecordGap, false, "a blocked link is not a capability gap");
  assert.deepEqual(calls, [], "the boundary reached the network");
});

test("⚠️ ACC-0110 no research result carries the backend credential or a machine path", async () => {
  const planted = "tvly-PLANTED-CREDENTIAL-7c41";
  const { createResearchTools } = await import("../lib/research/tools.mjs");
  const { createTavilyAdapter } = await import("../lib/research/tavily-adapter.mjs");

  // ⚠️ THE KEY IS GIVEN TO THE ADAPTER AND THE BACKEND IS A STAND-IN, so the credential travels the
  // real path - header, failure, message - without a request leaving this machine.
  const adapter = createTavilyAdapter({
    env: { TAVILY_API_KEY: planted },
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => `upstream said ${planted} was bad`, json: async () => ({}) }),
  });
  const tools = withResearch(createResearchTools(adapter, { fetchImpl: async () => ({ ok: false, status: 500 }) }));

  const texts = [
    JSON.stringify(await invokeAnywhere(tools.get("research_capability"))),
    JSON.stringify(await invokeAnywhere(tools.get("research_search"), { query: "q" })),
  ];
  for (const text of texts) {
    assert.equal(text.includes(planted), false, `a planted credential reached a research result: ${text.slice(0, 200)}`);
    assertNoMachinePath(text, [ROOT, homedir()], "a research result");
  }
});

test("⚠️ ACC-0110 the research tools answer where there is no project at all", async () => {
  const saved = process.env.PLANNING_CONTENT_DIR;
  delete process.env.PLANNING_CONTENT_DIR;
  const savedKey = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  const cwd = process.cwd();
  const empty = reapLater(mkdtempSync(join(tmpdir(), "kiln-no-project-")));
  process.chdir(empty);

  try {
    // ⚠️ THE POINT: a host capability must not depend on standing in a project.
    for (const name of ["research_capability", "research_search", "research_fetch"]) {
      const result = await invokeAnywhere(registered().get(name), { query: "q", url: "https://example.invalid/" });
      assert.notEqual(result.details.code, "no-content-root", `${name} demanded a project`);
    }
  } finally {
    process.chdir(cwd);
    if (saved !== undefined) process.env.PLANNING_CONTENT_DIR = saved;
    if (savedKey !== undefined) process.env.TAVILY_API_KEY = savedKey;
    rmSync(empty, { recursive: true, force: true });
  }
});

/**
 * A temporary parent of six backdated sentinels, and a way to run a call with every route a write could
 * take pointed into it: the content-root variable, Pi's agent-directory variable and the working
 * directory. Shared by every "a successful probe persisted nothing" test, so each makes the same claim.
 */
function probeStateParent() {
  const parent = reapLater(mkdtempSync(join(tmpdir(), "kiln-probe-state-")));
  const sentinels = {
    "project/planning-content/data/requirements/REQ-0001.json": '{"id":"REQ-0001"}\n',
    "project/planning-content/project.yaml": "name: sentinel\n",
    "project/.pi/settings.json": '{"packages":["../.planning/pi-package"]}\n',
    "agent/settings.json": '{"defaultProvider":"sentinel"}\n',
    "agent/trust.json": "{}\n",
    "external/state.json": '{"cached":false}\n',
  };
  // ⚠️ BACKDATED, so a rewrite with identical bytes still moves a modification time that can be seen.
  const past = new Date(Date.now() - 3_600_000);
  for (const [path, body] of Object.entries(sentinels)) {
    const full = join(parent, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
    utimesSync(full, past, past);
  }

  /** Every entry under the parent - directories included, so a new empty one is seen too. */
  const tree = () => {
    const out = new Map();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const key = relative(parent, full).split(sep).join("/");
        if (entry.isDirectory()) {
          out.set(`${key}/`, "dir");
          walk(full);
        } else out.set(key, { bytes: readFileSync(full), mtimeMs: statSync(full).mtimeMs });
      }
    };
    walk(parent);
    return out;
  };

  const within = async (call) => {
    const saved = { dir: process.env.PLANNING_CONTENT_DIR, agent: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd() };
    process.env.PLANNING_CONTENT_DIR = join(parent, "project", "planning-content");
    process.env.PI_CODING_AGENT_DIR = join(parent, "agent");
    process.chdir(join(parent, "project"));
    try {
      return await call();
    } finally {
      process.chdir(saved.cwd);
      for (const [name, value] of [["PLANNING_CONTENT_DIR", saved.dir], ["PI_CODING_AGENT_DIR", saved.agent]])
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
  };

  return { parent, tree, within };
}

/** The same entries, no new file or directory, and every file's bytes and modification time identical. */
function assertTreeUnchanged(before, after) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), "the probe created or removed an entry");
  for (const [key, was] of before) {
    if (was === "dir") continue;
    const now = after.get(key);
    assert.deepEqual(now.bytes, was.bytes, `the probe changed ${key}`);
    assert.equal(now.mtimeMs, was.mtimeMs, `the probe rewrote or touched ${key}`);
  }
}

test("⚠️ ACC-0110 a SUCCESSFUL capability probe changes no planning content, configuration or stored state", async () => {
  // ⚠️ **THE REFUSAL CASES CANNOT PROVE THIS.** Without a credential the adapter refuses before it does
  // anything, so "nothing changed" there is true for a reason that has nothing to do with the probe.
  // What ACC-0110 asks is that a probe that RAN and REPORTED AVAILABLE persisted nothing, so this builds
  // the real `createResearchTools` over a backend that answers, and watches everything it could reach.
  const { createResearchTools } = await import("../lib/research/tools.mjs");
  const state = probeStateParent();

  let probes = 0;
  const tools = withResearch(
    createResearchTools({
      name: "stand-in",
      envVar: "NONE",
      probe: async () => {
        probes += 1;
        return { ok: true, quota: { remaining: 999 } };
      },
      search: async () => ({ ok: true, results: [] }),
    })
  );

  const before = state.tree();
  const probed = (await state.within(() => invokeAnywhere(tools.get("research_capability")))).details;
  const after = state.tree();

  // The probe ran, and it succeeded - otherwise the assertion below would prove nothing.
  assert.equal(probes, 1, "the capability probe did not run");
  assert.equal(probed.available, true, JSON.stringify(probed));
  assert.equal(probed.probedLive, true);
  assertTreeUnchanged(before, after);
});

/* ============================================ the validation tools ============================= */

const withValidation = (validationTools) => {
  const tools = new Map();
  register({ registerTool: (tool) => tools.set(tool.name, tool) }, { validationTools });
  return tools;
};

/** A job the controller accepts: tier 1, one argument-array command, bounded, with a capture plan. */
const TIER_1_JOB = Object.freeze({
  tier: 1,
  commands: [["{python}", "-c", "print(1)"]],
  timeoutMs: 20_000,
  maxOutputBytes: 100_000,
  capturePlan: { stdout: true, stderr: true },
  expectedOutputs: [],
});

/**
 * The real controller behind the seam, with every result it returns kept beside a deep copy taken
 * the moment it was returned - so a rendering that edited the controller's object is caught.
 *
 * ⚠️ **NODE STANDS IN FOR THE INTERPRETER, ON PURPOSE.** It is present on every CI cell, it answers
 * `--version` exactly as a probe needs, and it REFUSES `-m venv` - so a successful probe and a real
 * provisioning failure are both deterministic, and no cell depends on an ambient Python.
 */
async function recordingValidation(options) {
  const { createValidationTools } = await import("../lib/validation/tools.mjs");
  const real = createValidationTools(options);
  const originals = [];
  const record = (name) => async (params) => {
    const out = await real[name](params);
    originals.push({ out, copy: structuredClone(out) });
    return out;
  };
  return { tools: { validation_capability: record("validation_capability"), validation_run: record("validation_run") }, originals };
}

/** No workspace, interpreter, home or temporary directory, in any spelling. */
const assertValidationDisclosesNothing = (text, paths, label) => {
  assertNoMachinePath(text, paths, label);
  assert.equal(text.includes("vpw-tier1-"), false, `${label}: a workspace directory name survived: ${text.slice(0, 240)}`);
};

test("⚠️ ACC-0110 the two validation tools register under the contract's names, with its measured schemas", async () => {
  const { VALIDATION_TOOL_SIGNATURES } = await import("../lib/validation/tools.mjs");
  const { contractFor } = await import("../lib/specialists/contract.mjs");
  const tools = registered();

  assert.deepEqual(contractFor("validation").requiredCapabilities, ["validation_capability", "validation_run"]);
  for (const name of contractFor("validation").requiredCapabilities) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} is not registered`);
    assert.deepEqual(tool.parameters, VALIDATION_TOOL_SIGNATURES[name].input, `${name}'s schema is not the measured one`);
    assert.equal(tool.description, VALIDATION_TOOL_SIGNATURES[name].description, `${name}'s description is not the measured one`);
    assert.ok(DECLARATION.tools.includes(name), `${name} is not declared`);
  }
});

test("⚠️ ACC-0110 each validation tool hands its parameters to the controller and its path-free answer back unchanged", async () => {
  const seen = [];
  const answer = (name) => async (params) => {
    seen.push({ name, params });
    return { tool: name, ok: true, phase: "complete", executions: [{ argv: ["{python}", "-c", "print(1)"], exitStatus: 0, stdout: "1\n", stderr: "" }], limits: { executionDeadlineMs: 20_000 } };
  };
  const tools = withValidation({ validation_capability: answer("validation_capability"), validation_run: answer("validation_run") });

  const ran = await invokeAnywhere(tools.get("validation_run"), structuredClone(TIER_1_JOB));
  await invokeAnywhere(tools.get("validation_capability"), {});

  assert.deepEqual(seen, [
    { name: "validation_run", params: structuredClone(TIER_1_JOB) },
    { name: "validation_capability", params: {} },
  ]);
  // ⚠️ NOTHING TO RENDER, SO NOTHING CHANGED: a result with no machine path comes back deep-equal.
  assert.deepEqual(ran.details, { tool: "validation_run", ok: true, phase: "complete", executions: [{ argv: ["{python}", "-c", "print(1)"], exitStatus: 0, stdout: "1\n", stderr: "" }], limits: { executionDeadlineMs: 20_000 } });
});

test("⚠️ ACC-0110 a provisioning failure keeps its meaning and loses its paths, and the controller's record is untouched", async () => {
  const workspaces = [];
  const { tools, originals } = await recordingValidation({
    python: process.execPath,
    io: { remove: (p) => (workspaces.push(p), rmSync(p, { recursive: true, force: true, maxRetries: 3 })), exists: existsSync },
  });

  const rendered = (await invokeAnywhere(withValidation(tools).get("validation_run"), structuredClone(TIER_1_JOB))).details;
  const [{ out, copy }] = originals;
  const [workspace] = workspaces;

  // The route is real: provisioning failed, and the controller's own message named the workspace.
  assert.equal(out.phase, "provision");
  assert.ok(workspace, "no workspace was provisioned");
  assert.ok(out.failure.message.includes(workspace), "the controller's diagnostic no longer names its workspace");

  // ⚠️ THE CONTROLLER'S OBJECT IS EXACTLY AS IT WAS RETURNED.
  assert.deepEqual(out, copy, "rendering edited the controller's result");

  // Rendered: the phase, the failure and the destroy record mean what they meant.
  assert.equal(rendered.ok, false);
  assert.equal(rendered.phase, "provision");
  assert.equal(rendered.destroy.outcome, "destroyed");
  assert.match(rendered.failure.message, /bad option/, rendered.failure.message);
  assert.ok(rendered.failure.message.includes("<workspace>/.venv"), rendered.failure.message);
  assertValidationDisclosesNothing(JSON.stringify(rendered), [workspace, process.execPath, homedir(), tmpdir()], "a provisioning failure");
});

test("⚠️ ACC-0110 a retained workspace is still reported as retained, at <workspace>", async () => {
  const workspaces = [];
  // Removal is suppressed and the workspace reported present, so the controller records a retained one.
  const { tools, originals } = await recordingValidation({
    python: process.execPath,
    io: { remove: (p) => workspaces.push(p), exists: () => true },
  });

  try {
    const rendered = (await invokeAnywhere(withValidation(tools).get("validation_run"), structuredClone(TIER_1_JOB))).details;
    const [{ out, copy }] = originals;
    const [workspace] = workspaces;

    assert.equal(out.destroy.retainedPath, workspace, "the controller no longer keeps the exact retained path");
    assert.deepEqual(out, copy, "rendering edited the controller's result");

    // ⚠️ THE FACT SURVIVES; THE LOCATION DOES NOT.
    assert.equal(rendered.destroy.outcome, "retained");
    assert.equal(rendered.destroy.retainedPath, "<workspace>");
    assert.equal(rendered.destroy.evidencePreserved, true);
    assert.equal(rendered.destroy.reason, "Removal reported success and the workspace is still present.");
    const omission = rendered.environment.omissions.find((o) => o.fact === "workspace-destroyed");
    assert.equal(omission.state, "unavailable");
    assert.equal(omission.reason, "Cleanup did not complete: Removal reported success and the workspace is still present. The environment is retained at <workspace>.");
    assertValidationDisclosesNothing(JSON.stringify(rendered), [workspace, process.execPath, homedir(), tmpdir()], "a retained workspace");
  } finally {
    for (const p of workspaces) rmSync(p, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0110 a retained workspace outside the default location is still rendered by its exact root", async () => {
  // ⚠️ **THE EXACT ROOT, NOT THE PATTERN.** Under the default location the controller's `vpw-tier1-`
  // workspace sits directly in the temporary directory, and a pattern for that finds it. A controller
  // given another `baseDir` puts it somewhere no pattern anticipates; the retained path the controller
  // reports is then the only exact statement of the root, and without it the name would collapse to
  // `<path>` and lose what followed it.
  const base = reapLater(mkdtempSync(join(tmpdir(), "kiln-custom-base-")));
  const nested = join(base, "nested", "validation");
  mkdirSync(nested, { recursive: true });

  const workspaces = [];
  const { tools, originals } = await recordingValidation({
    python: process.execPath,
    baseDir: nested,
    io: { remove: (p) => workspaces.push(p), exists: () => true },
  });

  try {
    const rendered = (await invokeAnywhere(withValidation(tools).get("validation_run"), structuredClone(TIER_1_JOB))).details;
    const [{ out, copy }] = originals;
    const [workspace] = workspaces;

    assert.ok(workspace.startsWith(nested), "the controller did not honour the base directory");
    assert.deepEqual(out, copy, "rendering edited the controller's result");
    assert.equal(rendered.destroy.retainedPath, "<workspace>");
    assert.ok(rendered.failure.message.includes("<workspace>/.venv"), rendered.failure.message);
    const omission = rendered.environment.omissions.find((o) => o.fact === "workspace-destroyed");
    assert.equal(omission.reason, "Cleanup did not complete: Removal reported success and the workspace is still present. The environment is retained at <workspace>.");
    assertValidationDisclosesNothing(JSON.stringify(rendered), [workspace, base, process.execPath, homedir(), tmpdir()], "a retained workspace under another base");
  } finally {
    for (const p of workspaces) rmSync(p, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0110 a job's own output keeps its relative context through every spelling and every level of nesting", async () => {
  // ⚠️ THE ROUTE A PYTHON TRACEBACK TAKES, measured locally with a real interpreter: the controller
  // records a failing script's stderr as it was written, and it names the script by its absolute path.
  // CI has no ambient Python, so the shape is reproduced here with the same workspace root.
  const workspace = join(tmpdir(), "vpw-tier1-Ab3dEf");
  const original = {
    tool: "validation_run",
    ok: true,
    phase: "complete",
    executions: [
      {
        argv: ["{python}", "check.py"],
        exitStatus: 1,
        stdout: `wrote ${join(workspace, "sub", "dir", "out.txt")}\n`,
        stderr: `Traceback (most recent call last):\r\n  File "${join(workspace, "check.py")}", line 1, in <module>\r\nFileNotFoundError: [Errno 2] No such file or directory: 'missing.txt'\r\n`,
      },
    ],
    environment: {
      facts: {
        nested: [{ deeper: { repr: `the workspace is ${JSON.stringify(workspace).slice(1, -1)}\\\\inputs` } }],
        forward: workspace.split("\\").join("/") + "/inputs/data.json",
        elsewhere: `home is ${homedir()}, node is ${process.execPath}`,
      },
    },
  };
  const copy = structuredClone(original);

  const rendered = (await invokeAnywhere(withValidation({ validation_run: async () => original }).get("validation_run"), structuredClone(TIER_1_JOB))).details;

  assert.deepEqual(original, copy, "rendering edited the controller's result");

  const [execution] = rendered.executions;
  assert.equal(execution.exitStatus, 1);
  assert.equal(execution.stdout, "wrote <workspace>/sub/dir/out.txt\n");
  assert.ok(execution.stderr.includes('File "<workspace>/check.py", line 1, in <module>'), execution.stderr);
  assert.ok(execution.stderr.includes("FileNotFoundError: [Errno 2] No such file or directory: 'missing.txt'"), execution.stderr);
  assert.equal(rendered.environment.facts.nested[0].deeper.repr, "the workspace is <workspace>/inputs");
  assert.equal(rendered.environment.facts.forward, "<workspace>/inputs/data.json");
  assert.equal(rendered.environment.facts.elsewhere, "home is <path>, node is <path>");
  assertValidationDisclosesNothing(JSON.stringify(rendered), [workspace, process.execPath, homedir(), tmpdir()], "a job's output");
});

test("⚠️ ACC-0110 an unusable interpreter and an over-ceiling job stay the controller's own refusals", async () => {
  const missing = join(tmpdir(), "kiln-no-interpreter", "python.exe");
  const unusable = await recordingValidation({ python: missing });
  const probed = (await invokeAnywhere(withValidation(unusable.tools).get("validation_capability"))).details;

  assert.equal(probed.available, false);
  assert.equal(probed.reason, "not-configured");
  assert.equal(probed.mustRecordGap, true);
  assert.match(probed.detail, /No usable Python interpreter \(<path>\)/, probed.detail);
  assert.equal(probed.code, undefined, "the wrapper added a refusal code of its own");
  assertValidationDisclosesNothing(JSON.stringify(probed), [missing, homedir(), tmpdir()], "an unusable interpreter");

  const usable = await recordingValidation({ python: process.execPath });
  const refused = (await invokeAnywhere(withValidation(usable.tools).get("validation_run"), { ...structuredClone(TIER_1_JOB), tier: 2 })).details;
  assert.equal(refused.phase, "refused");
  assert.equal(refused.reason, "above-approved-ceiling");
  assert.equal(refused.destroy.outcome, "nothing-to-destroy");
  assert.equal(refused.code, undefined);
});

test("⚠️ ACC-0110 a credential planted in the host environment reaches no validation result", async () => {
  const planted = "sk-ant-VALIDATION-PLANTED-5e2a";
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = planted;

  try {
    // ⚠️ KEPT OUT UPSTREAM: the controller supplies every job an allowlisted environment, and this
    // entry point may not read the environment at all. So the claim is asserted on the real paths.
    const { tools, originals } = await recordingValidation({ python: process.execPath });
    const wrapped = withValidation(tools);
    const texts = [
      JSON.stringify(await invokeAnywhere(wrapped.get("validation_capability"))),
      JSON.stringify(await invokeAnywhere(wrapped.get("validation_run"), structuredClone(TIER_1_JOB))),
    ];
    for (const text of texts) {
      assert.equal(text.includes(planted), false, "a planted credential reached a rendered result");
      assert.equal(text.includes(`Bearer ${planted}`), false);
    }
    for (const { out } of originals) assert.equal(JSON.stringify(out).includes(planted), false, "the controller carried the credential");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("⚠️ ACC-0110 the production path builds the real controller, with no project and no Python to find", async () => {
  // ⚠️ **OFFLINE AND DETERMINISTIC WITHOUT DEPENDING ON THIS HOST.** The production tools run `python`
  // from PATH. Pointing PATH at an empty directory, from an empty working directory, makes it
  // unresolvable on every cell - so the answer is the real controller's own not-configured refusal
  // whether or not the host has Python.
  const empty = reapLater(mkdtempSync(join(tmpdir(), "kiln-no-python-")));
  const saved = { PATH: process.env.PATH, dir: process.env.PLANNING_CONTENT_DIR, cwd: process.cwd() };
  process.env.PATH = empty;
  delete process.env.PLANNING_CONTENT_DIR;
  process.chdir(empty);

  try {
    const probed = (await invokeAnywhere(registered().get("validation_capability"))).details;
    assert.equal(probed.available, false, JSON.stringify(probed));
    assert.equal(probed.reason, "not-configured");
    assert.match(probed.detail, /No usable Python interpreter \(python\)/);
    assert.ok(probed.signatures?.validation_run, "the controller's measured signatures came through");
    assert.notEqual(probed.code, "no-content-root", "validation demanded a project");

    const ran = (await invokeAnywhere(registered().get("validation_run"), structuredClone(TIER_1_JOB))).details;
    assert.equal(ran.phase, "refused");
    assert.equal(ran.reason, "not-configured");
    assert.equal(ran.destroy.outcome, "nothing-to-destroy");
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.dir !== undefined) process.env.PLANNING_CONTENT_DIR = saved.dir;
    process.chdir(saved.cwd);
    rmSync(empty, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0110 a SUCCESSFUL validation probe changes no planning content, configuration or stored state", async () => {
  // ⚠️ THE SAME CLAIM AS THE RESEARCH PROBE, over the real controller: node answers `--version`, so the
  // probe genuinely runs an interpreter and genuinely reports available.
  const { createValidationTools } = await import("../lib/validation/tools.mjs");
  const state = probeStateParent();
  const tools = withValidation(createValidationTools({ python: process.execPath }));

  const before = state.tree();
  const probed = (await state.within(() => invokeAnywhere(tools.get("validation_capability")))).details;
  const after = state.tree();

  assert.equal(probed.available, true, JSON.stringify(probed));
  assert.equal(probed.probedLive, true);
  assert.equal(probed.interpreter, process.version, "the probe did not run the interpreter it was given");
  assertTreeUnchanged(before, after);
});

/* ============================================ the capability tool ============================== */

test("⚠️ ACC-0109 kiln_capability returns the package's declaration, field for field", async () => {
  const result = await invoke(registered().get("kiln_capability"), (await project()).contentRoot);

  // ⚠️ **DEEP EQUALITY AGAINST THE FILE, NOT AGAINST A DESCRIPTION OF IT.** A consumer's whole use for
  // this tool is comparing what a session reports against what the package ships; an assertion that
  // checked shape rather than content would pass for a declaration that had been rebuilt wrongly.
  assert.deepEqual(result.details, DECLARATION);
  assert.equal(result.details.signatureVersion, 1, "adding a tool changes content, not schema");
  assert.deepEqual(result.details.extensions, DECLARATION.extensions);
  assert.deepEqual(result.details.skills, DECLARATION.skills);
  assert.deepEqual(result.details.prompts, DECLARATION.prompts);
  assert.deepEqual(result.details.tools, DECLARATION.tools);
  assert.ok(DECLARATION.tools.includes("kiln_capability"), "the tool declares itself");

  // ⚠️ NOTHING ADDED AROUND IT EITHER: the result IS the declaration, not a declaration inside an
  // envelope, because an envelope is something to unwrap and unwrapping is where a field goes missing.
  assert.deepEqual(Object.keys(result.details).sort(), Object.keys(DECLARATION).sort());

  // And it is the frozen export itself, handed back rather than rebuilt.
  assert.equal(result.details, SIGNATURE);
  assert.equal(Object.isFrozen(result.details), true, "a consumer could edit the declaration it was handed");
});

test("⚠️ ACC-0109 calling it changes no byte and no modification time", async () => {
  const { contentRoot } = await project();
  const before = snapshot(contentRoot);
  const packageBefore = snapshot(PACKAGE_ROOT);

  await invoke(registered().get("kiln_capability"), contentRoot);
  await invoke(registered().get("kiln_capability"), contentRoot);

  assertUnchanged(before, snapshot(contentRoot), "a capability call");
  // ⚠️ AND NOT THE PACKAGE EITHER. The declaration is a file on disk; a tool that rewrote it while
  // reporting it would agree with itself forever.
  assertUnchanged(packageBefore, snapshot(PACKAGE_ROOT), "the package the declaration lives in");
});

test("⚠️ ACC-0109 the declaration it returns carries no credential and no machine path", async () => {
  const planted = "sk-ant-CAPABILITY-PLANTED-9d3e";
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = planted;

  let text;
  try {
    text = JSON.stringify(await invoke(registered().get("kiln_capability"), (await project()).contentRoot));
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }

  assert.equal(text.includes(planted), false);
  assertNoMachinePath(text, [ROOT, homedir()], "a capability result");
});
