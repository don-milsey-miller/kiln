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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { providerVisible } from "./helpers/provider-visible.mjs";
import { atomicWrite } from "../lib/atomic-write.mjs";
import * as bundle from "../lib/decision-bundle.mjs";
import { journalLocation, readJournal } from "../lib/decision-bundle-journal.mjs";
import { BOUNDARY_OPERATION, readBoundaryRefusals } from "../lib/operator-boundary.mjs";
import { IGNORE_RULES } from "../lib/project-gitignore.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
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

const compact = (handlers, fx, over = {}) => handlers.get("session_before_compact")({ type: "session_before_compact", preparation: { ...preparation(fx), ...over }, branchEntries: [], reason: "threshold", willRetry: false }, {});

test("with no bundle in flight, compaction is left to Pi", async () => {
  const fx = await project();
  const { tool, handlers } = session(fx);
  assert.equal(await compact(handlers, fx), undefined, "no journal");
  assertApplied(fx, await invoke(tool, fx, request(fx), { ctx: channel(true).ctx }));
  assert.equal(await compact(handlers, fx), undefined, "a completed journal");
  assert.equal(await compact(session(fx, { decisionBundleJournal: () => null }).handlers, fx), undefined, "no runtime state");
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

    assert.equal(await compact(restarted.handlers, fx), undefined, "once complete, compaction is Pi's again");
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

  // The authorisation is spent, so there is nothing for a compaction to preserve or a frame to announce.
  assert.equal(await compact(handlers, fx), undefined);

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
