/**
 * `kiln_apply_stage4_decision_bundle`, its compaction checkpoint and the reporting rule - #173.
 *
 * `test/decision-bundle.test.mjs` proves the library: what is validated, what the digest covers, and how
 * a journal resumes. This file proves what the operator and the model meet: one dialog that shows
 * everything, no dialog on a resume, and a compaction that cannot lose an approved bundle.
 *
 * ⚠️ **A FORCED COMPACTION AT EVERY FAILURE POINT.** For each operation of a bundle that uses every
 * kind, the bundle is stopped there, the session is compacted and restarted, and the resume is driven
 * from the compaction entry alone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { providerVisible } from "./helpers/provider-visible.mjs";
import { atomicWrite } from "../lib/atomic-write.mjs";
import * as bundle from "../lib/decision-bundle.mjs";
import { journalLocation, readJournal } from "../lib/decision-bundle-journal.mjs";
import { BOUNDARY_OPERATION, readBoundaryRefusals } from "../lib/operator-boundary.mjs";
import { IGNORE_RULES } from "../lib/project-gitignore.mjs";
import * as recoveryRequests from "../lib/recovery-request.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import * as carryovers from "../lib/workflow-carryover.mjs";
import * as stageDocuments from "../lib/stage-documents.mjs";
import { createRequirement } from "../lib/tools/create-requirement.mjs";
import { MUTATION_TOOLS, TYPED_TOOLS } from "../lib/tools/registry.mjs";
import { setReviewStatus } from "../lib/tools/review-status.mjs";
import { createValidators } from "../lib/validate.mjs";
import register, { MATERIAL_CHANGE_RULE } from "../pi-package/extensions/kiln.js";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const validators = createValidators(SCHEMAS);

const TOOL = "kiln_apply_stage4_decision_bundle";
const STAGE = bundle.BUNDLE_STAGE;
const SECRET = "sk-live-0123456789abcdefghijklmnopqrstuvwxyzABCD";
const KINDS = ["create-question", "create-decision", "resolve-question", "revise-artifact", "link-trace", "approve-decision", "write-stage-note"];

const MANIFEST = `name: fixture
capabilities:
  artifactTypes:
    activated: [requirement, decision, question]
  sandboxTiers:
    active:
      - 1
`;

async function project() {
  const base = reapLater(mkdtempSync(join(tmpdir(), "kiln-pi-bundle-")));
  execFileSync("git", ["init", "-q"], { cwd: base });
  writeFileSync(join(base, ".gitignore"), `${IGNORE_RULES.join("\n")}\n`);
  mkdirSync(join(base, ".pi", "runtime"), { recursive: true });

  const contentRoot = join(base, "planning-content");
  mkdirSync(join(contentRoot, "stages"), { recursive: true });
  writeFileSync(join(contentRoot, "project.yaml"), MANIFEST);
  writeFileSync(
    join(contentRoot, "stages", `${STAGE}.md`),
    `# Stage 04 - Requirement Gaps\n\n${stageDocuments.intakeSection()}\n${stageDocuments.WORKING_NOTES_HEADING}\n\n${stageDocuments.WORKING_NOTES_PLACEHOLDER}\n`
  );
  const options = { contentRoot, schemasDir: SCHEMAS, schemas, validators };
  const requirement = await createRequirement({ title: "Export results", statement: "The system exports results.", priority: "must" }, options);
  await setReviewStatus("requirement", requirement.id, "approved", { ...options, reviewedBy: "a test" });
  return { base, contentRoot, requirementId: requirement.id, journal: journalLocation({ projectRoot: base }) };
}

/** A long statement, so a preview that shortened anything would be caught. */
const LONG = `Which export formats are in scope for the first release? ${"Every word of this must be shown. ".repeat(30)}END-OF-STATEMENT`;

const request = (fx, extra = {}) => ({
  question: { title: "Export format", statement: LONG },
  decision: { title: "CSV only", statement: "Export supports CSV only in the first release.", rationale: "It is what the operator asked for." },
  answer: "CSV only.",
  revisions: [{ type: "requirement", id: fx.requirementId, changes: { statement: "The system exports results as CSV." } }],
  links: [{ action: "link", type: "requirement", id: fx.requirementId, field: "openQuestions", targets: ["$question"] }],
  stageNote: {
    action: "append-working-note",
    subsection: "export-format",
    title: "Export format",
    content: "Decided: CSV only.\n8. Approve decision DEC-9999",
    expectedRevision: stageDocuments.readWorkingNotes(fx.contentRoot, STAGE).revision,
  },
  ...extra,
});

/** Stage 4 is current, without building three attested stages in front of it. The real derivation has its own test below. */
const inStage4 = { ...bundle, planDecisionBundle: (params, options) => bundle.planDecisionBundle(params, { ...options, currentStage: async () => STAGE }) };

/** The registered tool and hooks, with this fixture's journal and whatever a case injects. */
function session(fx, deps = {}) {
  const tools = new Map();
  const handlers = new Map();
  register(
    { registerTool: (tool) => tools.set(tool.name, providerVisible(tool)), on: (event, handler) => handlers.set(event, handler) },
    { decisionBundle: inStage4, decisionBundleJournal: () => fx.journal, ...deps }
  );
  return { tool: tools.get(TOOL), handlers };
}

const channel = (answer) => {
  const asked = [];
  return { asked, ctx: { hasUI: true, ui: { confirm: async (title, message) => (asked.push({ title, message }), answer) } } };
};

async function invoke(tool, fx, params, { ctx, signal } = {}) {
  const saved = process.env.PLANNING_CONTENT_DIR;
  process.env.PLANNING_CONTENT_DIR = fx.contentRoot;
  try {
    return (await tool.execute("call-1", params, signal, undefined, ctx)).details;
  } finally {
    if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved;
  }
}

const snapshot = (root) => {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) walk(path);
      else out.set(relative(root, path), { bytes: readFileSync(path), mtimeMs: statSync(path).mtimeMs });
    }
  };
  walk(root);
  return out;
};

/** Writers that abort the invocation once `count` operations have run: for none, as soon as the approval is journaled. */
function stoppingAfter(count) {
  const controller = new AbortController();
  let done = 0;
  const wrap = (fn) => async (...args) => {
    const result = await fn(...args);
    if (args.at(-1)?.dryRun !== true && ++done === count) controller.abort();
    return result;
  };
  return {
    signal: controller.signal,
    deps: {
      ...(count === 0
        ? {
            decisionBundleJournalWriteFile: async (path, text) => {
              await atomicWrite(path, text);
              controller.abort();
            },
          }
        : {}),
      TYPED_TOOLS: { ...TYPED_TOOLS, question: wrap(TYPED_TOOLS.question), decision: wrap(TYPED_TOOLS.decision) },
      MUTATION_TOOLS: Object.fromEntries(Object.entries(MUTATION_TOOLS).map(([name, fn]) => [name, wrap(fn)])),
      stageDocuments: { ...stageDocuments, writeWorkingNotes: wrap(stageDocuments.writeWorkingNotes) },
    },
  };
}

const artifact = (fx, dir, id) => JSON.parse(readFileSync(join(fx.contentRoot, "data", dir, `${id}.json`), "utf-8"));

function assertApplied(fx, result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "action-completed");
  assert.deepEqual(result.changed.map((c) => c.operation), KINDS);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.pending, []);
  assert.equal(artifact(fx, "questions", result.ids.question).resolution, "answered");
  assert.equal(artifact(fx, "decisions", result.ids.decision).reviewStatus, "approved");
  assert.deepEqual(readdirSync(join(fx.contentRoot, "data", "questions")), [`${result.ids.question}.json`]);
  assert.deepEqual(readdirSync(join(fx.contentRoot, "data", "decisions")), [`${result.ids.decision}.json`]);
}

/* ============================================================ one confirmation ================ */

test("⚠️ a valid bundle asks exactly once, and the dialog shows every operation in full", async () => {
  const fx = await project();
  const ui = channel(true);
  const result = await invoke(session(fx).tool, fx, request(fx), { ctx: ui.ctx });
  assertApplied(fx, result);
  assert.equal(ui.asked.length, 1, "one confirmation for the whole bundle");

  const { title, message } = ui.asked[0];
  assert.equal(title, "Apply this Stage 4 decision bundle?");
  for (const shown of [
    "7 operations",
    "1. Create question QST-0001",
    LONG, // the whole statement, not a shortened preview
    "2. Create decision DEC-0001, addressing QST-0001",
    "Export supports CSV only in the first release.",
    "It is what the operator asked for.",
    "3. Resolve QST-0001 as answered by DEC-0001",
    "CSV only.",
    `4. Revise requirement ${fx.requirementId}`,
    "The system exports results as CSV.",
    `5. Link requirement ${fx.requirementId}, field openQuestions`,
    "6. Approve decision DEC-0001",
    "7. Append working note export-format in stage 04-requirement-gaps",
    "Decided: CSV only.",
    `${fx.requirementId} is approved and becomes amended.`,
    "Nothing else in this project will change.",
    `Bundle digest: ${result.digest}`,
  ])
    assert.ok(message.includes(shown), `the dialog does not show: ${shown}`);

  // ⚠️ A LINE THE MODEL WROTE CANNOT PASS FOR ONE OF KILN'S. The note's second line imitates an operation.
  const lines = message.split("\n");
  assert.ok(lines.includes("     | 8. Approve decision DEC-9999"));
  assert.equal(lines.filter((line) => /^\d+\. /.test(line)).length, 7, "only Kiln's own seven lines are numbered operations");
});

test("⚠️ a bundle that is not confirmed changes nothing and consumes no id", async () => {
  for (const [label, ctx, code] of [
    ["declined", channel(false).ctx, "operator-confirmation-not-granted"],
    ["no dialog channel", undefined, "operator-confirmation-not-granted"],
    ["an answer that is not a plain yes", channel("yes").ctx, "operator-confirmation-not-granted"],
  ]) {
    const fx = await project();
    const before = snapshot(fx.base);
    const result = await invoke(session(fx).tool, fx, request(fx), { ctx });
    assert.equal(result.ok, false, label);
    assert.equal(result.code, code, label);

    // The one thing written is the refusal's own audit entry, as for every other operator-boundary act.
    const after = snapshot(fx.base);
    const audit = join("planning-content", "state", "operator-boundary-refusals.json");
    assert.ok(after.delete(audit), `${label}: the refusal was recorded`);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${label}: a file appeared or went`);
    for (const [path, was] of before) {
      assert.deepEqual(after.get(path).bytes, was.bytes, `${label}: ${path} changed`);
      assert.equal(after.get(path).mtimeMs, was.mtimeMs, `${label}: ${path} was touched`);
    }
    assert.deepEqual(
      readBoundaryRefusals(fx.contentRoot).refusals.map((r) => [r.operation, r.target]),
      [[BOUNDARY_OPERATION.APPLY_DECISION_BUNDLE, { stageId: STAGE }]],
      label
    );
    assert.equal(readJournal(fx.journal).state, "absent", `${label}: nothing was authorised`);
  }
});

test("an invalid bundle is refused before the operator is asked", async () => {
  const fx = await project();
  const ui = channel(true);
  const before = snapshot(fx.base);
  const result = await invoke(session(fx).tool, fx, request(fx, { decision: { title: "No statement" } }), { ctx: ui.ctx });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid-artifact");
  assert.equal(result.status, "blocked");
  assert.equal(ui.asked.length, 0, "a confirmation is for a bundle Kiln can apply");
  assert.deepEqual([...snapshot(fx.base).keys()], [...before.keys()]);
});

test("the real stage derivation refuses a bundle outside Stage 4, and a session with no runtime state", async () => {
  const fx = await project();
  const ui = channel(true);
  // No `decisionBundle` injection: this fixture has attested nothing, so its current stage is 01-intake.
  const real = session(fx, { decisionBundle: undefined });
  const wrongStage = await invoke(real.tool, fx, request(fx), { ctx: ui.ctx });
  assert.equal(wrongStage.code, "bundle-wrong-stage");

  const unjournaled = await invoke(session(fx, { decisionBundleJournal: () => null }).tool, fx, request(fx), { ctx: ui.ctx });
  assert.equal(unjournaled.code, "bundle-journal-unavailable");
  assert.equal(ui.asked.length, 0);
});

/* ============================================================ an existing question ============ */

test("⚠️ a bundle settles an existing question under one confirmation, and the dialog shows what is being answered", async () => {
  const fx = await project();
  const made = await TYPED_TOOLS.question({ title: "Export format", statement: "EXISTING-STATEMENT Which export formats are in scope?" }, { contentRoot: fx.contentRoot, schemasDir: SCHEMAS, schemas, validators });
  const { question: _new, ...rest } = request(fx);
  const ui = channel(true);
  const { tool, handlers } = session(fx);

  // Both, or neither, is refused before the operator is asked.
  assert.equal((await invoke(tool, fx, { ...rest, questionId: made.id, question: { title: "t", statement: "s" } }, { ctx: ui.ctx })).code, "invalid-request");
  assert.equal((await invoke(tool, fx, rest, { ctx: ui.ctx })).code, "invalid-request");
  assert.equal(ui.asked.length, 0);

  const stop = stoppingAfter(1);
  const stopped = await invoke(session(fx, stop.deps).tool, fx, { ...rest, questionId: made.id }, { ctx: ui.ctx, signal: stop.signal });
  assert.equal(ui.asked.length, 1);
  const { message } = ui.asked[0];
  for (const shown of ["6 operations", "1. Create decision DEC-0001, addressing QST-0001", "2. Resolve existing question QST-0001 as answered by DEC-0001", "EXISTING-STATEMENT Which export formats are in scope?", "CSV only."])
    assert.ok(message.includes(shown), `the dialog does not show: ${shown}`);
  assert.ok(!message.includes("Create question"));
  assert.deepEqual(stopped.changed, [{ operation: "create-decision", target: "DEC-0001" }]);

  // The checkpoint's current question is the existing artifact's own statement.
  const { compaction } = await inProject(fx, () => compact(handlers, fx));
  assert.ok(compaction.summary.includes("Current question: EXISTING-STATEMENT Which export formats are in scope?"));
  assert.equal(compaction.details.kilnCheckpoint.firstIncomplete, 1);

  const resumed = await invoke(tool, fx, { resumeDigest: stopped.digest }, { ctx: ui.ctx });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.deepEqual(resumed.changed.map((c) => c.operation), KINDS.slice(1));
  assert.equal(ui.asked.length, 1, "no second confirmation");
  assert.equal(artifact(fx, "questions", made.id).resolution, "answered");
  assert.deepEqual(readdirSync(join(fx.contentRoot, "data", "questions")), [`${made.id}.json`]);
});

/* ============================================================ authorisation is exact ========== */

test("⚠️ a resume asks nothing, and a changed bundle is refused rather than merged", async () => {
  const fx = await project();
  const stop = stoppingAfter(2);
  const first = channel(true);
  const stopped = await invoke(session(fx, stop.deps).tool, fx, request(fx), { ctx: first.ctx, signal: stop.signal });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.status, "blocked");
  assert.equal(stopped.code, "bundle-interrupted");
  assert.deepEqual(stopped.changed.map((c) => c.operation), KINDS.slice(0, 2));
  assert.deepEqual(stopped.pending.map((c) => c.operation), KINDS.slice(2));
  assert.ok(stopped.next.includes(stopped.digest), "the result says how to resume");

  const later = channel(true);
  const tool = session(fx).tool;

  // An operation outside the approved digest, or changed content, does not ride on the earlier approval.
  for (const change of [{ answer: "CSV and JSON." }, { links: [] }, { revisions: [{ type: "requirement", id: fx.requirementId, changes: { notes: "more" } }] }]) {
    const refused = await invoke(tool, fx, request(fx, change), { ctx: later.ctx });
    assert.equal(refused.code, "bundle-digest-mismatch");
    assert.equal(refused.status, "blocked");
    assert.equal(refused.digest, stopped.digest);
    assert.deepEqual(refused.changed.map((c) => c.operation), KINDS.slice(0, 2));
  }
  assert.equal((await invoke(tool, fx, { resumeDigest: `sha256:${"0".repeat(64)}` }, { ctx: later.ctx })).code, "bundle-digest-mismatch");
  assert.equal(artifact(fx, "questions", "QST-0001").resolution, "unanswered", "nothing ran on a refused request");

  // The approved digest alone continues it.
  assertApplied(fx, await invoke(tool, fx, { resumeDigest: stopped.digest }, { ctx: later.ctx }));
  assert.equal(later.asked.length, 0, "no confirmation was asked after the first");
  assert.equal(first.asked.length, 1);
});

test("the same request sent again after a stop is the same bundle", async () => {
  const fx = await project();
  const stop = stoppingAfter(4);
  // The note's revision is read before the bundle starts, as the model would have read it.
  const params = request(fx);
  await invoke(session(fx, stop.deps).tool, fx, params, { ctx: channel(true).ctx, signal: stop.signal });
  const later = channel(true);
  assertApplied(fx, await invoke(session(fx).tool, fx, params, { ctx: later.ctx }));
  assert.equal(later.asked.length, 0);
});

/** Refuse every rename onto `target` with `code`, as the filesystem would, for as long as `run` takes. */
async function refusingRenameOnto(target, code, run) {
  const original = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (to !== target) return original.call(this, from, to);
    throw Object.assign(new Error(`${code}: operation refused, rename '${from}' -> '${to}'`), { code, syscall: "rename" });
  };
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    fs.renameSync = original;
    syncBuiltinESMExports();
  }
}

for (const [refusedWith, code, why] of [
  ["EPERM", "stage-document-write-contended", "another program has the stage document open for the whole retry budget"],
  ["EIO", "stage-document-write-failed", "the filesystem refuses the rename for a reason retrying cannot help"],
])
  test(`⚠️ #179 a bundle whose stage note cannot be written stops with ${code}, and resumes there`, async () => {
    // ${why}
    const fx = await project();
    const document = join(fx.contentRoot, "stages", `${STAGE}.md`);
    const before = readFileSync(document, "utf-8");
    const { tool } = session(fx);

    const stopped = await refusingRenameOnto(document, refusedWith, () => invoke(tool, fx, request(fx), { ctx: channel(true).ctx }));
    assert.equal(stopped.status, "blocked");
    assert.equal(stopped.code, "bundle-operation-failed");
    // ⚠️ THE STAGE DOCUMENT'S OWN CODE, not the general one the bundle used for any failed write before #179.
    assert.deepEqual(stopped.failed, [{ operation: "write-stage-note", target: `stage:${STAGE}`, code }]);
    assert.deepEqual(stopped.changed.map((c) => c.operation), KINDS.slice(0, 6));
    assert.deepEqual(stopped.pending, []);
    for (const absent of [refusedWith, fx.base, fx.base.split("\\").join("/"), homedir()]) assert.ok(!JSON.stringify(stopped).includes(absent), `the result says ${absent}`);

    // The journal keeps the code against the one operation, and nothing of the failure's words.
    const journal = JSON.parse(readFileSync(fx.journal.path, "utf-8"));
    assert.deepEqual(journal.operations.map((op) => op.status), [...KINDS.slice(0, 6).map(() => "completed"), "failed"]);
    assert.equal(journal.operations[6].code, code);
    assert.ok(!readFileSync(fx.journal.path, "utf-8").includes(refusedWith));
    // The document is as it was, with no temporary file beside it and no content lock left.
    assert.equal(readFileSync(document, "utf-8"), before);
    assert.deepEqual(readdirSync(join(fx.contentRoot, "stages")).filter((name) => name.includes(".vpw-tmp")), []);
    assert.equal(existsSync(join(fx.contentRoot, ".planning.lock")), false);

    // Once the document can be replaced, the approved bundle finishes from that operation with no second confirmation.
    const later = channel(true);
    assertApplied(fx, await invoke(session(fx).tool, fx, { resumeDigest: stopped.digest }, { ctx: later.ctx }));
    assert.equal(later.asked.length, 0);
    assert.deepEqual(stageDocuments.readWorkingNotes(fx.contentRoot, STAGE).subsections.map((entry) => entry.name), ["export-format"]);
  });

test("⚠️ a failure is reported in full, cleaned of this machine, and the journal keeps only a code", async () => {
  const fx = await project();
  const leaky = `could not write ${join(homedir(), "private", "x.json")} using ${SECRET}`;
  const failing = { MUTATION_TOOLS: { ...MUTATION_TOOLS, reviseArtifact: async (...args) => (args.at(-1)?.dryRun ? MUTATION_TOOLS.reviseArtifact(...args) : Promise.reject(new Error(leaky))) } };
  const result = await invoke(session(fx, failing).tool, fx, request(fx), { ctx: channel(true).ctx });

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "bundle-operation-failed");
  assert.deepEqual(result.failed, [{ operation: "revise-artifact", target: fx.requirementId, code: "operation-failed" }]);
  assert.deepEqual(result.changed.map((c) => c.operation), KINDS.slice(0, 3));
  assert.deepEqual(result.pending.map((c) => c.operation), KINDS.slice(4));
  assert.ok(result.message.includes("could not write"), "the failure's own words reach the model");
  assert.ok(!JSON.stringify(result).includes(homedir()), "no machine path leaves");

  const stored = readFileSync(fx.journal.path, "utf-8");
  assert.ok(!stored.includes(SECRET) && !stored.includes(homedir()) && !stored.includes("could not write"));
});

/* ============================================================ compaction ====================== */

/** A compaction as Pi prepares it, with a tool result, a fetched page, a credential and a path in what would be discarded. */
const preparation = (fx) => ({
  firstKeptEntryId: "entry-0042",
  tokensBefore: 245_351,
  isSplitTurn: false,
  previousSummary: `Earlier the operator described the export feature. Notes live at ${join(fx.base, "notes.md")}.`,
  messagesToSummarize: [
    { role: "user", content: [{ type: "text", text: "CSV only, please." }] },
    { role: "assistant", content: [{ type: "text", text: `Recording that. The key was ${SECRET}.` }, { type: "toolCall", name: "research_fetch", arguments: { url: "https://example.test/page" } }] },
    { role: "toolResult", toolName: "research_fetch", content: [{ type: "text", text: "RETRIEVED-PAGE-BODY lorem ipsum" }] },
    { role: "toolResult", toolName: TOOL, content: [{ type: "text", text: "TOOL-RESULT-PROSE bundle-interrupted" }] },
  ],
  turnPrefixMessages: [],
});

const compact = (handlers, fx, over = {}, { branchEntries = [] } = {}) => handlers.get("session_before_compact")({ type: "session_before_compact", preparation: { ...preparation(fx), ...over }, branchEntries, reason: "threshold", willRetry: false }, {});

/** The same, with the session standing in this fixture's project, as a supervised Pi is. */
async function inProject(fx, run) {
  const saved = process.env.PLANNING_CONTENT_DIR;
  process.env.PLANNING_CONTENT_DIR = fx.contentRoot;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved;
  }
}

test("⚠️ an ordinary compaction keeps the stage and the open question or proposal, with no bundle in flight", async () => {
  const fx = await project();
  const { tool, handlers } = session(fx);

  const { compaction } = await inProject(fx, () => compact(handlers, fx));
  // The boundary is Pi's.
  assert.equal(compaction.firstKeptEntryId, "entry-0042");
  assert.equal(compaction.tokensBefore, 245_351);
  // Identifiers and enums only. This fixture has attested nothing, so its derived stage is 01-intake.
  assert.deepEqual(compaction.details, { kilnCheckpoint: { checkpointVersion: 1, stage: "01-intake", status: "none", pending: "summarized" } });

  const { summary } = compaction;
  for (const kept of [
    "## Earlier summary",
    "Earlier the operator described the export feature.",
    "## Recent conversation",
    "Operator: CSV only, please.",
    "## Pending question or proposal",
    "Recording that.",
    "## Kiln workflow checkpoint",
    "Stage: 01-intake (Intake)",
    "No approved decision bundle is in flight.",
    "If it asked the operator something or proposed a change, that is still open.",
    "do not treat a proposal as approved unless they approved it",
  ])
    assert.ok(summary.includes(kept), `the summary lacks: ${kept}`);
  assert.ok(summary.indexOf("## Pending question or proposal") < summary.indexOf("## Kiln workflow checkpoint"));

  const whole = JSON.stringify(compaction);
  for (const forbidden of ["RETRIEVED-PAGE-BODY", "TOOL-RESULT-PROSE", SECRET, fx.base, fx.base.split("\\").join("/"), homedir(), "resumeDigest"])
    assert.ok(!whole.includes(forbidden), `the compaction entry carries ${forbidden}`);

  // The frame announces a checkpoint only for an unfinished bundle.
  const framed = await inProject(fx, () => handlers.get("before_agent_start")({ type: "before_agent_start", systemPrompt: "base" }, {}));
  assert.ok(!framed.systemPrompt.includes("Kiln workflow checkpoint"));

  // A finished bundle is not in flight: the next compaction is an ordinary one again.
  assertApplied(fx, await invoke(tool, fx, request(fx), { ctx: channel(true).ctx }));
  assert.equal((await inProject(fx, () => compact(handlers, fx))).compaction.details.kilnCheckpoint.status, "none");
});

test("⚠️ an ordinary compaction is bounded, however much was said", async () => {
  const fx = await project();
  const { handlers } = session(fx);
  const big = "word ".repeat(40_000);
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `message-${i} ${big}` }] }));
  const { compaction } = await inProject(fx, () => compact(handlers, fx, { previousSummary: big, messagesToSummarize: messages }));
  assert.ok(Buffer.byteLength(compaction.summary) < 32 * 1024, `${Buffer.byteLength(compaction.summary)} bytes`);
  assert.ok(compaction.summary.includes("message-39"), "the newest message is kept");
  assert.ok(!compaction.summary.includes("message-0 "), "the oldest is not");
});

test("⚠️ a question Pi keeps verbatim is not copied into the summary", async () => {
  const fx = await project();
  const { handlers } = session(fx);
  const branchEntries = [
    { type: "message", id: "entry-0001", message: { role: "user", content: [{ type: "text", text: "CSV only, please." }] } },
    { type: "message", id: "entry-0042", message: { role: "user", content: [{ type: "text", text: "And the delimiter?" }] } },
    { type: "message", id: "entry-0043", message: { role: "assistant", content: [{ type: "text", text: "KEPT-QUESTION Comma or tab?" }] } },
  ];
  const { compaction } = await inProject(fx, () => compact(handlers, fx, {}, { branchEntries }));
  assert.equal(compaction.details.kilnCheckpoint.pending, "kept");
  assert.ok(!compaction.summary.includes("## Pending question or proposal"));
  assert.ok(!compaction.summary.includes("KEPT-QUESTION"));
  assert.ok(compaction.summary.includes("The assistant's latest message follows this summary unchanged."));

  // Nothing from the assistant at all.
  const silent = await inProject(fx, () => compact(handlers, fx, { messagesToSummarize: [{ role: "user", content: "Hello." }] }));
  assert.equal(silent.compaction.details.kilnCheckpoint.pending, "none");
});

test("⚠️ #178 only a session that is not Kiln's is left to Pi's own compaction", async () => {
  const fx = await project();
  // No planning content resolves and no runtime state is named: this is not a Kiln session.
  const { handlers } = session(fx, { decisionBundleJournal: () => null });
  const saved = process.env.PLANNING_CONTENT_DIR;
  process.env.PLANNING_CONTENT_DIR = join(fx.base, "no-such-planning-content");
  try {
    assert.equal(await compact(handlers, fx), undefined);
  } finally {
    if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved;
  }
});

test("⚠️ #178 in a Kiln project a boundary Kiln cannot copy cancels the compaction with a typed outcome, never a fall-through", async () => {
  const fx = await project();
  const { handlers } = session(fx);
  const notices = [];
  const ctx = { ui: { notify: (message, level) => notices.push([level, message]) } };
  for (const over of [{ firstKeptEntryId: undefined }, { firstKeptEntryId: "" }, { tokensBefore: "many" }]) {
    const result = await inProject(fx, () =>
      handlers.get("session_before_compact")({ type: "session_before_compact", preparation: { ...preparation(fx), ...over }, branchEntries: [], reason: "threshold", willRetry: false }, ctx)
    );
    assert.deepEqual(result, { cancel: true }, JSON.stringify(over));
  }
  // Every one is cancelled. The outcome is recorded and said once: the first reason stands for the session.
  assert.equal(notices.length, 1);
  assert.equal(notices[0][0], "warning");
  // The outcome is said to the model on the next turn, as a code and an instruction.
  const framed = await inProject(fx, () => handlers.get("before_agent_start")({ type: "before_agent_start", systemPrompt: "base" }, {}));
  assert.ok(framed.systemPrompt.includes("Kiln recovery (compaction-boundary-invalid):"));
});

test("⚠️ #178 when the stage cannot be derived the compaction is a minimal typed checkpoint, still Kiln's", async () => {
  const fx = await project();
  const { handlers } = session(fx);
  // A tool root with no schemas or stages: the derivation fails inside the worker.
  const broken = session(fx, { toolRoot: join(fx.base, "no-such-tool-root") });
  const { compaction } = await inProject(fx, () => compact(broken.handlers, fx));
  assert.equal(compaction.firstKeptEntryId, "entry-0042");
  assert.equal(compaction.tokensBefore, 245_351);
  assert.deepEqual(compaction.details, { kilnCheckpoint: { checkpointVersion: 1, stage: null, status: "minimal", code: "stage-unavailable", pending: "summarized" } });
  assert.ok(compaction.summary.includes("Stage: not derived (stage-unavailable). Call kiln_project_status before continuing."));
  assert.ok(compaction.summary.includes("Operator: CSV only, please."), "the bounded conversation is still carried");
  // The same session with a working tool root derives the stage.
  assert.equal((await inProject(fx, () => compact(handlers, fx))).compaction.details.kilnCheckpoint.stage, "01-intake");
});

test("⚠️ #178 a checkpoint build that never returns is stopped at its bound, and the compaction still completes", async () => {
  const fx = await project();
  // A worker that spins for ever in synchronous code: only terminating the thread can end it.
  const hung = join(fx.base, "hung-worker.mjs");
  writeFileSync(hung, "for (;;) {}\n");
  const { handlers } = session(fx, { checkpointWorker: pathToFileURL(hung), checkpointBoundMs: 400 });
  const started = Date.now();
  const { compaction } = await inProject(fx, () => compact(handlers, fx));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 350 && elapsed < 3_000, `the hook took ${elapsed} ms against a 400 ms bound`);
  assert.deepEqual(compaction.details, { kilnCheckpoint: { checkpointVersion: 1, stage: null, status: "minimal", code: "checkpoint-timeout", pending: "summarized" } });
  assert.ok(compaction.summary.includes("Stage: not derived (checkpoint-timeout)."));
});

test("⚠️ #178 a finished bundle's last operation is carried as identifiers and a status", async () => {
  const fx = await project();
  const { tool, handlers } = session(fx);
  assertApplied(fx, await invoke(tool, fx, request(fx), { ctx: channel(true).ctx }));
  const { compaction } = await inProject(fx, () => compact(handlers, fx));
  assert.deepEqual(compaction.details.kilnCheckpoint.lastOperation, { index: 6, kind: "write-stage-note", target: `stage:${STAGE}`, status: "completed" });
  assert.ok(compaction.summary.includes(`Last completed bundle operation: 7. write-stage-note stage:${STAGE} (completed).`));
});

/* ---------------------------------------------------------- the turn an overflow retries, #178 F5 */

/** An overflow compaction of a split turn: the operator's request is before Pi's boundary, a tool result after it. */
const overflow = (fx, request, { keptResult = "RESULT ".repeat(200), tokensBefore = 30_000 } = {}) => ({
  type: "session_before_compact",
  reason: "overflow",
  willRetry: true,
  preparation: {
    firstKeptEntryId: "e3",
    tokensBefore,
    isSplitTurn: true,
    settings: { reserveTokens: 4_000, keepRecentTokens: 2_000 },
    messagesToSummarize: [{ role: "user", content: "An earlier question." }, { role: "assistant", content: [{ type: "text", text: "An earlier answer." }] }],
    turnPrefixMessages: [{ role: "user", content: [{ type: "text", text: request }] }, { role: "assistant", content: [{ type: "toolCall", name: "kiln_project_status", arguments: {} }] }],
  },
  branchEntries: [
    { type: "message", id: "e0", message: { role: "user", content: "An earlier question." } },
    { type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: request }] } },
    { type: "message", id: "e3", message: { role: "toolResult", toolName: "kiln_project_status", content: [{ type: "text", text: keptResult }] } },
  ],
});

test("⚠️ #178 F5 an overflow retry carries the operator's request whole when it fits", async () => {
  const fx = await project();
  const { handlers } = session(fx);
  // Longer than the 1 KB a summarised message is cut to, with a path and a credential-shaped run that must survive.
  const asked = `CURRENT-REQUEST ${"Reconcile every dock fee against its invoice. ".repeat(60)} See ${join(fx.base, "notes.md")} and ${SECRET}. END-OF-REQUEST`;
  const { compaction } = await inProject(fx, () => handlers.get("session_before_compact")(overflow(fx, asked), { model: { contextWindow: 60_000 } }));
  assert.equal(compaction.firstKeptEntryId, "e3", "Pi's boundary was moved");
  assert.ok(compaction.summary.includes(`## Current request (the operator's words, unchanged)\n${asked}\n`), "the request is not carried byte for byte");
  // The bounded narrative beside it is still cleaned and still cut.
  const narrative = compaction.summary.slice(0, compaction.summary.indexOf("## Current request"));
  assert.ok(!narrative.includes("END-OF-REQUEST") && !narrative.includes(SECRET));
});

test("⚠️ #178 F5 an input that alone exceeds the window is not retried cut down: typed outcome, nothing copied", async () => {
  const fx = await project();
  const { handlers } = session(fx);
  const notices = [];
  const huge = `HUGE-INPUT ${"x".repeat(400_000)}`;
  const result = await inProject(fx, () =>
    handlers.get("session_before_compact")(overflow(fx, huge, { tokensBefore: 130_000 }), { model: { contextWindow: 60_000 }, ui: { notify: (message) => notices.push(message) } })
  );
  assert.deepEqual(result, { cancel: true }, "a compaction was composed for an input that cannot fit");
  assert.equal(notices.length, 1);
  assert.ok(notices[0].includes("larger than this model's context window"));
  const framed = await inProject(fx, () => handlers.get("before_agent_start")({ type: "before_agent_start", systemPrompt: "base" }, {}));
  assert.ok(framed.systemPrompt.includes("Kiln recovery (input-exceeds-context-window):"));
  assert.ok(!framed.systemPrompt.includes("HUGE-INPUT") && !notices[0].includes("HUGE-INPUT"), "the input was copied into a notice or the frame");
});

test("#178 F5 a request Pi keeps is left to Pi, and an unknown window never cuts", async () => {
  const fx = await project();
  const { handlers } = session(fx);
  // The request is after the boundary: Pi keeps it, and the summary does not repeat it.
  const kept = overflow(fx, "KEPT-REQUEST");
  kept.preparation.firstKeptEntryId = "e1";
  kept.preparation.turnPrefixMessages = [];
  const first = await inProject(fx, () => handlers.get("session_before_compact")(kept, { model: { contextWindow: 60_000 } }));
  assert.ok(!first.compaction.summary.includes("## Current request"));
  // No context window known: the request is carried whole rather than judged too large.
  const big = `UNKNOWN-WINDOW ${"y".repeat(300_000)}`;
  const second = await inProject(fx, () => handlers.get("session_before_compact")(overflow(fx, big), {}));
  assert.ok(second.compaction.summary.includes(big));
});

/* ------------------------------------------- a session replaced by another, and what it hands on, #178 */

const RUN = "0123456789abcdef0123456789abcdef";
const OTHER_RUN = "fedcba9876543210fedcba9876543210";
const [LEAVING, REPLACEMENT, THIRD] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const NEW = { type: "session_before_switch", reason: "new" };

/** A session as the supervisor runs it: a run id, and the request and carry-over files in the fixture's runtime. */
function supervised(fx, { runId = RUN, deps = {} } = {}) {
  const env = { KILN_RUN_ID: runId, KILN_PROJECT_ROOT: fx.base, KILN_STATE_MODE: "project" };
  const made = session(fx, {
    recoveryRequest: { requestRecovery: (reason) => recoveryRequests.requestRecovery(reason, { env }) },
    carryover: {
      writeCarryover: (carry) => carryovers.writeCarryover(carry, { env }),
      readCarryover: (options) => carryovers.readCarryover({ ...options, env }),
      clearCarryover: (options) => carryovers.clearCarryover({ ...options, env }),
    },
    ...deps,
  });
  const runtime = join(fx.base, ".pi", "runtime");
  const read = (name) => (existsSync(join(runtime, name)) ? JSON.parse(readFileSync(join(runtime, name), "utf-8")) : null);
  return {
    ...made,
    request: () => read(recoveryRequests.RECOVERY_REQUEST_FILE),
    carried: () => read(carryovers.CARRYOVER_FILE),
    /** What the supervisor does once it has recorded the replacement session. */
    bind: (sessionId) => carryovers.bindCarryover({ runtimeDir: runtime, runId, sessionId }),
  };
}

/** What Pi hands a hook: the session's id and branch, a notice sink and a shutdown that is only counted. */
function switching(branch = [], sessionId = LEAVING) {
  const notices = [];
  const calls = { shutdown: 0 };
  return { notices, calls, ctx: { sessionManager: { getBranch: () => branch, getSessionId: () => sessionId }, ui: { notify: (message, level) => notices.push([level, message]) }, shutdown: () => calls.shutdown++ } };
}

const said = (role, text, id) => ({ type: "message", id, message: { role, content: [{ type: "text", text }] } });
const frameOf = (fx, handlers, { branch = [], sessionId = REPLACEMENT } = {}) =>
  inProject(fx, async () => (await handlers.get("before_agent_start")({ type: "before_agent_start", systemPrompt: "base" }, { sessionManager: { getBranch: () => branch, getSessionId: () => sessionId } })).systemPrompt);
/** One session leaves by `/new`, and the supervisor binds what it handed on to `to`. */
async function replace(fx, branch, { from = LEAVING, to = REPLACEMENT } = {}) {
  const leaving = supervised(fx);
  const at = switching(branch, from);
  const result = await inProject(fx, () => leaving.handlers.get("session_before_switch")(NEW, at.ctx));
  const bound = await leaving.bind(to);
  return { leaving, at, result, bound };
}

test("⚠️ #178 /new is cancelled in Pi and requested from the supervisor, and the open proposal is handed on as pending", async () => {
  const fx = await project();
  const proposal = `PROPOSAL-ALPHA Shall I record CSV export as the decision? Notes are at ${join(fx.base, "notes.md")} and the key was ${SECRET}.`;
  const leaving = supervised(fx);
  const at = switching([said("user", "OPERATOR-WORDS what do you suggest?", "e0"), said("assistant", "An earlier answer.", "e1"), said("user", "And then?", "e2"), said("assistant", proposal, "e3"), said("toolResult", "TOOL-RESULT-BODY", "e4")]);

  const result = await inProject(fx, () => leaving.handlers.get("session_before_switch")(NEW, at.ctx));
  assert.deepEqual(result, { cancel: true }, "Pi was left to switch sessions itself");
  assert.equal(at.calls.shutdown, 1);
  assert.deepEqual(at.notices, [["info", "Kiln is starting a new session. This one is kept as it is."]]);
  // The request is the fixed record and nothing else.
  assert.deepEqual(Object.keys(leaving.request()).sort(), ["reason", "recordVersion", "requestedAt", "runId"]);
  assert.equal(leaving.request().reason, "operator-new-session");
  assert.equal(leaving.request().runId, RUN);

  // ⚠️ UNTIL THE SUPERVISOR BINDS IT, NOBODY IS TOLD: the leaving session does not know which session replaces it.
  assert.equal(leaving.carried().sessionId, undefined);
  for (const sessionId of [LEAVING, REPLACEMENT]) assert.ok(!(await frameOf(fx, supervised(fx).handlers, { sessionId })).includes("Kiln session carry-over"));
  assert.deepEqual(await leaving.bind(REPLACEMENT), { bound: true });

  const carried = leaving.carried();
  assert.equal(carried.sessionId, REPLACEMENT);
  assert.equal(carried.reason, "operator-new-session");
  assert.equal(carried.pending.source, "assistant-message");
  assert.ok(carried.pending.text.startsWith("PROPOSAL-ALPHA Shall I record CSV export as the decision?"));
  // Bounded and cleaned: no path, no credential, no operator input, no tool body.
  const text = JSON.stringify(carried);
  for (const absent of [SECRET, fx.base, fx.base.replaceAll("\\", "\\\\"), homedir(), "OPERATOR-WORDS", "TOOL-RESULT-BODY", "An earlier answer."]) assert.ok(!text.includes(absent), `the carry-over holds ${absent}`);

  // ⚠️ THE REPLACEMENT SESSION IS TOLD, AND TOLD IT IS PENDING.
  const next = supervised(fx);
  const frame = await frameOf(fx, next.handlers);
  assert.ok(frame.includes("Kiln session carry-over (operator-new-session):"));
  assert.ok(frame.includes("PROPOSAL-ALPHA Shall I record CSV export as the decision?"));
  assert.ok(frame.includes("that is STILL PENDING: the operator has not answered it and has not approved it."));
  assert.ok(!frame.includes(SECRET));
  assert.ok(!frame.includes("Kiln recovery ("), "an operator's /new was reported as a failure");
  // No other session is told, and asking does not remove what is the replacement's.
  for (const sessionId of [LEAVING, THIRD]) assert.ok(!(await frameOf(fx, next.handlers, { sessionId })).includes("Kiln session carry-over"));
  // ⚠️ ONLY THIS SESSION'S FIRST COMPLETED, NON-EMPTY ANSWER ENDS IT. A tool call alone, a failed or stopped message,
  // an operator message, and any message in another session leave the record where it is.
  const ended = (handlers, message, sessionId = REPLACEMENT) => handlers.get("message_end")({ type: "message_end", message }, { sessionManager: { getSessionId: () => sessionId } });
  const answer = (text, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason });
  await ended(next.handlers, { role: "assistant", content: [{ type: "toolCall", name: "kiln_project_status", arguments: {} }], stopReason: "toolUse" });
  await ended(next.handlers, answer("A partial ans", "aborted"));
  await ended(next.handlers, answer("", "error"));
  await ended(next.handlers, answer("   "));
  await ended(next.handlers, { role: "user", content: [{ type: "text", text: "hello" }] });
  await ended(next.handlers, answer("An answer in some other session."), THIRD);
  assert.equal(next.carried().sessionId, REPLACEMENT);
  assert.ok((await frameOf(fx, next.handlers, { branch: [said("user", "hello", "n0"), said("assistant", "A partial ans", "n1")] })).includes("Kiln session carry-over"));

  // ⚠️ A LATER LAUNCH THAT RESUMES THE REPLACEMENT BEFORE ITS FIRST ANSWER IS STILL TOLD. The record is the session's,
  // not the run's.
  const later = supervised(fx, { runId: OTHER_RUN });
  assert.ok((await frameOf(fx, later.handlers)).includes("PROPOSAL-ALPHA Shall I record CSV export as the decision?"));
  assert.equal(later.carried().sessionId, REPLACEMENT);

  // Once the session has answered, the record goes with that message, and the frame stops repeating it.
  await ended(later.handlers, answer("Restating the proposal."));
  assert.equal(later.carried(), null);
  assert.ok(!(await frameOf(fx, later.handlers, { branch: [said("user", "hello", "n0"), said("assistant", "Restating the proposal.", "n1")] })).includes("Kiln session carry-over"));
});

test("⚠️ #178 a session replaced before it said anything passes on what it was handed, and /new is never counted as approval", async () => {
  const fx = await project();
  await replace(fx, [said("assistant", "PROPOSAL-BETA approve the revised wording?", "e0")]);
  // The replacement takes no turn and is replaced as well.
  const second = await replace(fx, [], { from: REPLACEMENT, to: THIRD });
  assert.deepEqual(second.bound, { bound: true });
  assert.deepEqual(second.leaving.carried().pending, { source: "assistant-message", text: "PROPOSAL-BETA approve the revised wording?" });
  assert.equal(second.leaving.carried().sessionId, THIRD);
  assert.ok(!(await frameOf(fx, supervised(fx).handlers, { sessionId: REPLACEMENT })).includes("Kiln session carry-over"));
  const frame = await frameOf(fx, supervised(fx).handlers, { sessionId: THIRD });
  assert.ok(frame.includes("PROPOSAL-BETA approve the revised wording?"));
  assert.doesNotMatch(frame.slice(frame.indexOf("Kiln session carry-over")), /\b(is|was|been) approved\b/, "the carry-over says something was approved");
});

test("#178 with nothing said since the latest compaction, the message its checkpoint recorded as pending is the one carried", async () => {
  const fx = await project();
  const compaction = (pending) => ({ type: "compaction", id: "c0", summary: "SUMMARY-BODY", firstKeptEntryId: "e1", tokensBefore: 9, details: { kilnCheckpoint: { checkpointVersion: 1, stage: "01-intake", status: "none", pending } } });
  const before = [said("user", "question", "e0"), said("assistant", "PROPOSAL-GAMMA shall I split the requirement?", "e1")];
  for (const [pending, expected] of [
    ["summarized", { source: "compaction-checkpoint", text: "PROPOSAL-GAMMA shall I split the requirement?" }],
    ["kept", { source: "compaction-checkpoint", text: "PROPOSAL-GAMMA shall I split the requirement?" }],
    ["none", undefined],
  ]) {
    const { leaving } = await replace(fx, [...before, compaction(pending), said("user", "after", "e2")]);
    assert.deepEqual(leaving.carried().pending, expected, pending);
    assert.ok(!JSON.stringify(leaving.carried()).includes("SUMMARY-BODY"));
  }
  // A later message wins over the checkpoint.
  const later = await replace(fx, [...before, compaction("summarized"), said("assistant", "PROPOSAL-DELTA a later one", "e3")]);
  assert.deepEqual(later.leaving.carried().pending, { source: "assistant-message", text: "PROPOSAL-DELTA a later one" });
  // A long message is cut to the record's bound.
  const long = await replace(fx, [said("assistant", `LONG ${"word ".repeat(4_000)}`, "e0")]);
  assert.ok(long.leaving.carried().pending.text.length <= carryovers.CARRYOVER_PENDING_MAX && long.leaving.carried().pending.text.length > 3_000);
});

test("#178 the last completed bundle operation is handed on as identifiers and a status", async () => {
  const fx = await project();
  assertApplied(fx, await invoke(session(fx).tool, fx, request(fx), { ctx: channel(true).ctx }));
  const { leaving } = await replace(fx, []);
  assert.deepEqual(leaving.carried().lastOperation, { index: 6, kind: "write-stage-note", target: `stage:${STAGE}`, status: "completed" });
  assert.equal(leaving.carried().pending, undefined);
  const frame = await frameOf(fx, supervised(fx).handlers);
  assert.ok(frame.includes(`Last completed bundle operation: 7. write-stage-note stage:${STAGE} (completed).`));
  assert.ok(frame.includes("No question or proposal was pending in the earlier session."));
});

test("⚠️ #178 a /new Kiln cannot request is refused under a supervisor, and left to Pi only where no supervisor runs", async () => {
  const fx = await project();
  // No supervisor: there is no session record to diverge from, and Pi's own switch goes ahead.
  const alone = switching([]);
  const unsupervised = supervised(fx, { runId: null });
  assert.equal(await inProject(fx, () => unsupervised.handlers.get("session_before_switch")(NEW, alone.ctx)), undefined);
  assert.deepEqual([alone.calls.shutdown, alone.notices.length, unsupervised.request(), unsupervised.carried()], [0, 0, null, null]);

  // A supervisor, and a request that could not be written: the operator stays where they are.
  const stuck = switching([said("assistant", "PROPOSAL", "e0")]);
  const failing = supervised(fx, { deps: { recoveryRequest: { requestRecovery: async () => ({ written: false, code: "recovery-request-unwritable" }) } } });
  assert.deepEqual(await inProject(fx, () => failing.handlers.get("session_before_switch")(NEW, stuck.ctx)), { cancel: true });
  assert.deepEqual(stuck.notices, [["warning", "Kiln could not start a new session (recovery-request-unwritable), so this session continues."]]);
  assert.deepEqual([stuck.calls.shutdown, failing.request(), failing.carried()], [0, null, null]);

  // Only `/new` is Kiln's to answer here.
  const other = switching([]);
  assert.equal(await inProject(fx, () => supervised(fx).handlers.get("session_before_switch")({ type: "session_before_switch", reason: "resume" }, other.ctx)), undefined);
  assert.equal(other.calls.shutdown, 0);
});

test("⚠️ #178 a failure-driven recovery hands on its reason and the open proposal, and never the input that caused it", async () => {
  const fx = await project();
  const s = supervised(fx);
  const huge = `HUGE-INPUT ${"x".repeat(400_000)}`;
  const at = switching([said("assistant", "PROPOSAL-EPSILON confirm the export format?", "e0"), said("user", huge, "e1")]);
  const result = await inProject(fx, () => s.handlers.get("session_before_compact")(overflow(fx, huge, { tokensBefore: 130_000 }), { ...at.ctx, model: { contextWindow: 60_000 } }));
  assert.deepEqual(result, { cancel: true });
  assert.equal(at.calls.shutdown, 1);
  assert.equal(s.request().reason, "input-exceeds-context-window");
  assert.deepEqual(await s.bind(REPLACEMENT), { bound: true });
  assert.equal(s.carried().reason, "input-exceeds-context-window");
  assert.deepEqual(s.carried().pending, { source: "assistant-message", text: "PROPOSAL-EPSILON confirm the export format?" });
  assert.ok(!JSON.stringify(s.carried()).includes("HUGE-INPUT"));
  const frame = await frameOf(fx, supervised(fx).handlers);
  assert.ok(frame.includes("Kiln session carry-over (input-exceeds-context-window):"));
  assert.ok(frame.includes("That input was not sent and was not carried here."));
  assert.ok(frame.includes("PROPOSAL-EPSILON confirm the export format?") && !frame.includes("HUGE-INPUT"));
});

for (const [index, kind] of KINDS.entries()) {
  test(`⚠️ a forced compaction and restart before operation ${index + 1} (${kind}) resumes there with no confirmation`, async () => {
    const fx = await project();
    const stop = stoppingAfter(index);
    const first = channel(true);
    const stopped = await invoke(session(fx, stop.deps).tool, fx, request(fx), { ctx: first.ctx, signal: stop.signal });
    assert.equal(stopped.code, "bundle-interrupted");

    // A new process: nothing but the journal and the compaction entry carries over.
    const restarted = session(fx);
    const { compaction } = await compact(restarted.handlers, fx);

    // ⚠️ THE BOUNDARY IS PI'S, COPIED AND NOT RECALCULATED.
    assert.equal(compaction.firstKeptEntryId, "entry-0042");
    assert.equal(compaction.tokensBefore, 245_351);

    // ⚠️ `details` IS IDENTIFIERS, STATUSES AND CODES. Exactly these keys, at every level.
    const checkpoint = compaction.details.kilnCheckpoint;
    assert.deepEqual(Object.keys(compaction.details), ["kilnCheckpoint"]);
    assert.deepEqual(checkpoint, {
      checkpointVersion: 1,
      stage: STAGE,
      digest: stopped.digest,
      status: "authorized",
      ids: { question: "QST-0001", decision: "DEC-0001" },
      firstIncomplete: index,
      operations: KINDS.map((k, i) => ({
        index: i,
        kind: k,
        target: ["QST-0001", "DEC-0001", "QST-0001", fx.requirementId, fx.requirementId, "DEC-0001", `stage:${STAGE}`][i],
        status: i < index ? "completed" : "pending",
      })),
    });

    // The summary carries the current question, where the bundle stopped, and the one next action.
    const { summary } = compaction;
    assert.ok(summary.includes("Current question: Which export formats are in scope for the first release?"));
    assert.ok(summary.includes(`Operations completed: ${index} of 7.`));
    assert.ok(summary.includes(`First incomplete operation: ${index + 1}. ${kind} ${checkpoint.operations[index].target} (pending).`));
    assert.ok(summary.includes(`Next action: call ${TOOL} with only resumeDigest set to that digest.`));
    assert.ok(summary.includes("CSV only, please."), "what the operator said is kept");

    // ⚠️ AND NOTHING IT MUST NOT: no tool result, no retrieved page, no credential, no path.
    const whole = JSON.stringify(compaction);
    for (const forbidden of ["RETRIEVED-PAGE-BODY", "TOOL-RESULT-PROSE", SECRET, fx.base, fx.base.split("\\").join("/"), homedir(), "END-OF-STATEMENT"])
      assert.ok(!whole.includes(forbidden), `the compaction entry carries ${forbidden}`);
    assert.ok(Buffer.byteLength(summary) < 16 * 1024, "the summary is bounded");

    // The frame says the same on the next turn, so a restart with no compaction resumes too.
    const framed = await restarted.handlers.get("before_agent_start")({ type: "before_agent_start", systemPrompt: "base" }, {});
    assert.ok(framed.systemPrompt.includes(`Approved decision bundle: ${stopped.digest} (authorized).`));

    // The resume is driven by the compaction entry alone.
    const later = channel(true);
    assertApplied(fx, await invoke(restarted.tool, fx, { resumeDigest: checkpoint.digest }, { ctx: later.ctx }));
    assert.equal(later.asked.length, 0, "no repeated confirmation");
    assert.equal(first.asked.length, 1);

    assert.equal((await inProject(fx, () => compact(restarted.handlers, fx))).compaction.details.kilnCheckpoint.status, "none", "once complete, compaction is an ordinary one again");
    const after = await restarted.handlers.get("before_agent_start")({ type: "before_agent_start", systemPrompt: "base" }, {});
    assert.ok(!after.systemPrompt.includes("Kiln workflow checkpoint"));
  });
}

test("⚠️ a compaction after a project-state mismatch does not offer a resume", async () => {
  const fx = await project();
  const stop = stoppingAfter(3);
  const stopped = await invoke(session(fx, stop.deps).tool, fx, request(fx), { ctx: channel(true).ctx, signal: stop.signal });
  await MUTATION_TOOLS.reviseArtifact("requirement", fx.requirementId, { notes: "edited meanwhile" }, { contentRoot: fx.contentRoot, schemasDir: SCHEMAS, schemas, validators });

  const { tool, handlers } = session(fx);
  const later = channel(true);
  const refused = await invoke(tool, fx, { resumeDigest: stopped.digest }, { ctx: later.ctx });
  assert.equal(refused.status, "blocked");
  assert.equal(refused.code, "bundle-state-mismatch");
  assert.deepEqual(refused.failed, [{ operation: "revise-artifact", target: fx.requirementId, code: "bundle-state-mismatch" }]);
  assert.ok(refused.next.startsWith("The approval is spent."));
  assert.equal(later.asked.length, 0);
  assert.equal(artifact(fx, "requirements", fx.requirementId).statement, "The system exports results.", "the mismatched target was left alone");

  // The authorisation is spent, so a compaction is an ordinary one and offers no resume.
  const ordinary = await inProject(fx, () => compact(handlers, fx));
  assert.equal(ordinary.compaction.details.kilnCheckpoint.status, "none");
  assert.ok(!ordinary.compaction.summary.includes("resumeDigest"));

  // The next proposal is asked afresh, and its dialog says what the earlier bundle already did.
  const again = channel(true);
  const fresh = await invoke(tool, fx, request(fx), { ctx: again.ctx });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.equal(again.asked.length, 1, "a safe re-approval request");
  assert.ok(again.asked[0].message.includes("An earlier approved bundle is blocked and unfinished."));
  assert.ok(again.asked[0].message.includes("create-question QST-0001"));
});

test("⚠️ an unreadable journal becomes a blocked checkpoint, never a generic compaction", async () => {
  const fx = await project();
  const stop = stoppingAfter(2);
  await invoke(session(fx, stop.deps).tool, fx, request(fx), { ctx: channel(true).ctx, signal: stop.signal });
  writeFileSync(fx.journal.path, `{ "recordVersion": 1, "note": "${SECRET}"`);

  const { tool, handlers } = session(fx);
  const { compaction } = await compact(handlers, fx);
  assert.deepEqual(compaction.details, { kilnCheckpoint: { checkpointVersion: 1, stage: STAGE, status: "blocked", code: "bundle-journal-unreadable" } });
  assert.ok(compaction.summary.includes("could not be read or validated (bundle-journal-unreadable)"));
  assert.ok(compaction.summary.includes("Next action: tell the operator"));
  assert.ok(!JSON.stringify(compaction).includes(SECRET), "nothing is copied out of a journal that failed validation");

  const framed = await handlers.get("before_agent_start")({ type: "before_agent_start", systemPrompt: "base" }, {});
  assert.ok(framed.systemPrompt.includes("bundle-journal-unreadable"));

  const ui = channel(true);
  assert.equal((await invoke(tool, fx, request(fx), { ctx: ui.ctx })).code, "bundle-journal-unreadable");
  assert.equal(ui.asked.length, 0);
});

test("⚠️ when the checkpoint cannot be attached, the compaction is cancelled rather than lost", async () => {
  const fx = await project();
  const stop = stoppingAfter(2);
  await invoke(session(fx, stop.deps).tool, fx, request(fx), { ctx: channel(true).ctx, signal: stop.signal });
  const { handlers } = session(fx);
  for (const over of [{ firstKeptEntryId: undefined }, { firstKeptEntryId: "" }, { tokensBefore: undefined }, { tokensBefore: "many" }])
    assert.deepEqual(await compact(handlers, fx, over), { cancel: true }, JSON.stringify(over));
  assert.deepEqual(await handlers.get("session_before_compact")({ type: "session_before_compact" }, {}), { cancel: true });
});

/* ============================================================ delta-first reporting =========== */

test("⚠️ the rule names the four response kinds and what each carries", () => {
  const kinds = {
    "decision-needed": "`decision-needed`: the decision, the options, your recommendation and the consequence.",
    "action-completed": "`action-completed`: only what changed, and any failure.",
    "stage-transition": "`stage-transition`: what is completed, what remains and what is next, briefly.",
    blocked: "`blocked`: the blocker and the least input that would clear it.",
  };
  for (const [kind, sentence] of Object.entries(kinds)) assert.ok(MATERIAL_CHANGE_RULE.includes(sentence), `${kind}: the rule no longer says it`);
  assert.ok(MATERIAL_CHANGE_RULE.includes("Every reply to the operator is one of four kinds:"));
});

test("⚠️ the rule suppresses clean checks and non-blocking reviews, and never shortens a failure", () => {
  for (const sentence of [
    "Do not restate requirements, scope or stage summaries that have not changed.",
    "Do not mention a clean lint, a\npassed internal check, or an advisory review that was non-blocking or refused, unless it changes the next action.",
    "A failure, a refusal, a blocker or a safety concern is always\nreported in full, however long that is.",
    "End with one next action or one question.",
  ])
    assert.ok(MATERIAL_CHANGE_RULE.includes(sentence), sentence);
});

test("⚠️ the rule makes one decision one proposal, and the bundle tool its own approval", () => {
  for (const sentence of [
    "Everything that follows mechanically from one operator decision is one proposal",
    "Never split them into separate approvals.",
    "One approval covers exactly the operations you named.",
    "call `kiln_review_proposal` once, on the substantive creation or revision",
    "to `kiln_write_stage_attestation` or to `kiln_apply_stage4_decision_bundle`: each opens Kiln's own confirmation\ndialog, and the operator's answer there is the approval.",
  ])
    assert.ok(MATERIAL_CHANGE_RULE.includes(sentence), sentence);
  assert.ok(!MATERIAL_CHANGE_RULE.includes("turn of its"), "the rule that forced one approval turn per mutation is gone");
});

test("the tool's results are the two response kinds a bundle can end in", async () => {
  const fx = await project();
  const done = await invoke(session(fx).tool, fx, request(fx), { ctx: channel(true).ctx });
  assert.deepEqual(Object.keys(done), ["ok", "status", "digest", "ids", "changed", "failed", "pending"]);
  assert.equal(done.status, "action-completed");

  const fx2 = await project();
  const stop = stoppingAfter(1);
  const blocked = await invoke(session(fx2, stop.deps).tool, fx2, request(fx2), { ctx: channel(true).ctx, signal: stop.signal });
  assert.deepEqual(Object.keys(blocked), ["ok", "status", "code", "digest", "ids", "changed", "failed", "pending", "next"]);
  assert.equal(blocked.status, "blocked");
});

test("Stage 4 tells the model to call the bundle directly, and the generated skill says the same", () => {
  const stage = JSON.parse(readFileSync(join(ROOT, "stages", `${STAGE}.json`), "utf-8"));
  const skill = readFileSync(join(ROOT, "pi-package", "skills", `kiln-stage-${STAGE}`, "SKILL.md"), "utf-8");
  assert.ok(stage.mutationBoundary.mayMutate.includes("applyStage4DecisionBundle"));
  for (const step of stage.method.steps) assert.ok(skill.includes(step), `the skill lacks: ${step}`);
  const steps = stage.method.steps.join("\n");
  for (const said of [
    `call \`${TOOL}\` directly`,
    "Do not ask for approval in chat before that call",
    "Do not create the question, create the decision, resolve the question or approve the decision as separate calls or separate approvals.",
    "never on the question's resolution or the approval",
    "`action-completed` or `blocked`",
    "only `resumeDigest`",
  ])
    assert.ok(steps.includes(said), said);
});
