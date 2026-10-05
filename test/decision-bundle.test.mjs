/**
 * The Stage 4 decision bundle - #173 (F11, F13).
 *
 * One approval covers several typed writes, so what has to hold is everything an approval per write
 * used to give for free: nothing outside the approved set runs, a changed bundle is a different
 * bundle, and a failure between two writes neither repeats the first nor loses the second.
 *
 * ⚠️ **EVERY FAILURE POINT IS EXERCISED, NOT A SAMPLE.** The three ways a bundle stops part way - a
 * writer refuses, the invocation is aborted between two operations, the journal cannot record an
 * operation that ran - are each injected at every operation of a bundle that uses every kind.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { atomicWrite } from "../lib/atomic-write.mjs";
import { BUNDLE_REFUSAL, BUNDLE_STAGE, BundleRefusal, STAGE_TARGET, buildOperations, executeDecisionBundle, planDecisionBundle, resumeDecisionBundle } from "../lib/decision-bundle.mjs";
import { JOURNAL_READ, bundleDigest, journalLocation, readJournal } from "../lib/decision-bundle-journal.mjs";
import { readHighWaterMarks } from "../lib/id-allocator.mjs";
import { IGNORE_RULES } from "../lib/project-gitignore.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import * as stageDocuments from "../lib/stage-documents.mjs";
import { createRequirement } from "../lib/tools/create-requirement.mjs";
import { MUTATION_TOOLS, TYPED_TOOLS } from "../lib/tools/registry.mjs";
import { setReviewStatus } from "../lib/tools/review-status.mjs";
import { createValidators } from "../lib/validate.mjs";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const validators = createValidators(SCHEMAS);

/** A credential-shaped string and a machine path, for a writer to fail with. Neither may be kept anywhere. */
const SECRET = "sk-live-0123456789abcdefghijklmnopqrstuvwxyzABCD";
const LEAKY = `could not write ${join(homedir(), "somewhere", "private.json")} using ${SECRET}`;

/** A project with protected runtime state, a Stage 4 document, and one approved requirement. */
async function project({ runtime = true } = {}) {
  const base = reapLater(mkdtempSync(join(tmpdir(), "kiln-bundle-")));
  execFileSync("git", ["init", "-q"], { cwd: base });
  writeFileSync(join(base, ".gitignore"), `${IGNORE_RULES.join("\n")}\n`);
  if (runtime) mkdirSync(join(base, ".pi", "runtime"), { recursive: true });

  const contentRoot = join(base, "planning-content");
  mkdirSync(join(contentRoot, "stages"), { recursive: true });
  writeFileSync(
    join(contentRoot, "stages", `${BUNDLE_STAGE}.md`),
    `# Stage 04 - Requirement Gaps\n\n${stageDocuments.intakeSection()}\n${stageDocuments.WORKING_NOTES_HEADING}\n\n${stageDocuments.WORKING_NOTES_PLACEHOLDER}\n`
  );

  const base0 = { contentRoot, schemasDir: SCHEMAS, schemas, validators };
  const requirement = await createRequirement({ title: "Export results", statement: "The system exports results.", priority: "must" }, base0);
  await setReviewStatus("requirement", requirement.id, "approved", { ...base0, reviewedBy: "a test" });

  return { base, contentRoot, requirementId: requirement.id, journal: journalLocation({ projectRoot: base }) };
}

const optionsFor = (fx, extra = {}) => ({
  contentRoot: fx.contentRoot,
  schemasDir: SCHEMAS,
  schemas,
  validators,
  journal: fx.journal,
  reviewedBy: "operator via a test",
  currentStage: async () => BUNDLE_STAGE,
  ...extra,
});

/** A bundle that uses every kind of operation: seven in all. */
const fullRequest = (fx, extra = {}) => ({
  question: { title: "Export format", statement: "Which export formats are in scope?" },
  decision: { title: "CSV only", statement: "Export supports CSV only in the first release.", rationale: "It is what the operator asked for." },
  answer: "CSV only.",
  revisions: [{ type: "requirement", id: fx.requirementId, changes: { statement: "The system exports results as CSV." } }],
  links: [{ action: "link", type: "requirement", id: fx.requirementId, field: "openQuestions", targets: ["$question"] }],
  stageNote: {
    action: "append-working-note",
    subsection: "export-format",
    title: "Export format",
    content: "Decided: CSV only.",
    expectedRevision: stageDocuments.readWorkingNotes(fx.contentRoot, BUNDLE_STAGE).revision,
  },
  ...extra,
});

const KINDS = ["create-question", "create-decision", "resolve-question", "revise-artifact", "link-trace", "approve-decision", "write-stage-note"];

/** Plan, then do what the plan says: execute a fresh bundle as if confirmed, or resume an authorised one. */
async function apply(request, options) {
  const planned = await planDecisionBundle(request, options);
  return planned.mode === "resume" ? resumeDecisionBundle(planned.digest, options) : executeDecisionBundle(planned.plan, options);
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

const assertUnchanged = (before, after, label) => {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${label}: the set of files changed`);
  for (const [path, was] of before) {
    assert.deepEqual(after.get(path).bytes, was.bytes, `${label}: ${path} changed`);
    assert.equal(after.get(path).mtimeMs, was.mtimeMs, `${label}: ${path} was rewritten or touched`);
  }
};

const artifact = (fx, dir, id) => JSON.parse(readFileSync(join(fx.contentRoot, "data", dir, `${id}.json`), "utf-8"));
const statuses = (result) => result.checkpoint.operations.map((op) => op.status);

/** The project as a finished full bundle leaves it. Asserted after every recovery, so a repeat or a gap shows. */
function assertApplied(fx, result) {
  assert.equal(result.ok, true);
  assert.equal(result.status, "action-completed");
  assert.deepEqual(result.checkpoint.operations.map((op) => op.kind), KINDS);
  assert.deepEqual(statuses(result), KINDS.map(() => "completed"));
  assert.equal(result.checkpoint.firstIncomplete, null);

  const { question: qid, decision: did } = result.checkpoint.ids;
  const question = artifact(fx, "questions", qid);
  const decision = artifact(fx, "decisions", did);
  const requirement = artifact(fx, "requirements", fx.requirementId);
  assert.equal(question.resolution, "answered");
  assert.equal(question.answer, "CSV only.");
  assert.deepEqual(question.answeredBy, [did]);
  assert.equal(decision.reviewStatus, "approved");
  assert.deepEqual(decision.addresses, [qid]);
  assert.equal(requirement.statement, "The system exports results as CSV.");
  assert.deepEqual(requirement.openQuestions, [qid]);
  assert.equal(requirement.reviewStatus, "amended", "an approved artifact the bundle edits is amended, as the typed writers decide");

  const notes = stageDocuments.readWorkingNotes(fx.contentRoot, BUNDLE_STAGE).subsections;
  assert.deepEqual(notes.map((n) => [n.name, n.revision, n.content]), [["export-format", 1, "Decided: CSV only."]]);

  // Exactly one of each, under exactly the reserved ids: nothing was created twice.
  assert.deepEqual(readdirSync(join(fx.contentRoot, "data", "questions")), [`${qid}.json`]);
  assert.deepEqual(readdirSync(join(fx.contentRoot, "data", "decisions")), [`${did}.json`]);
  assert.equal(readHighWaterMarks(fx.contentRoot).QST, Number(qid.slice(4)));
  assert.equal(readHighWaterMarks(fx.contentRoot).DEC, Number(did.slice(4)));

  const journal = readJournal(fx.journal);
  assert.equal(journal.state, JOURNAL_READ.VALID);
  assert.equal(journal.journal.status, "completed");
}

/** Writers that behave exactly as the registry's, until `at(kind)` says otherwise. */
function instrumented({ before = () => {}, after = () => {} } = {}) {
  const calls = [];
  const wrap = (kind, fn) => async (...args) => {
    const dryRun = args.at(-1)?.dryRun === true;
    if (!dryRun) {
      calls.push(kind);
      await before(kind);
    }
    const result = await fn(...args);
    if (!dryRun) await after(kind);
    return result;
  };
  return {
    calls,
    TYPED_TOOLS: { ...TYPED_TOOLS, question: wrap("create-question", TYPED_TOOLS.question), decision: wrap("create-decision", TYPED_TOOLS.decision) },
    MUTATION_TOOLS: {
      ...MUTATION_TOOLS,
      resolveQuestion: wrap("resolve-question", MUTATION_TOOLS.resolveQuestion),
      reviseArtifact: wrap("revise-artifact", MUTATION_TOOLS.reviseArtifact),
      linkTrace: wrap("link-trace", MUTATION_TOOLS.linkTrace),
      setReviewStatus: wrap("approve-decision", MUTATION_TOOLS.setReviewStatus),
    },
    stageDocuments: { ...stageDocuments, writeWorkingNotes: wrap("write-stage-note", stageDocuments.writeWorkingNotes) },
  };
}

/* ============================================================ the plan ======================== */

test("a plan validates everything, names the exact ids, and changes nothing", async () => {
  const fx = await project();
  const before = snapshot(fx.base);
  const planned = await planDecisionBundle(fullRequest(fx), optionsFor(fx));
  assertUnchanged(before, snapshot(fx.base), "planning");

  assert.equal(planned.mode, "fresh");
  const { plan } = planned;
  assert.deepEqual(plan.ids, { question: "QST-0001", decision: "DEC-0001" });
  assert.deepEqual(plan.operations.map((op) => op.kind), KINDS);
  assert.match(plan.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(plan.effects, [{ target: fx.requirementId, from: "approved", to: "amended" }], "the confirmation can say which approval the bundle reopens");
  assert.equal(plan.replaces, null);
  // Kiln adds the question to what the decision addresses, and a placeholder becomes the exact id.
  assert.deepEqual(plan.operations[1].args.artifact.addresses, ["QST-0001"]);
  assert.deepEqual(plan.operations[4].args.targets, ["QST-0001"]);
});

test("⚠️ an invalid operation anywhere in the bundle refuses the whole plan before an id is consumed", async () => {
  const fx = await project();
  const before = snapshot(fx.base);
  const cases = [
    ["a question the schema refuses", { question: { title: "No statement" } }, "ValidationError"],
    ["a decision the schema refuses", { decision: { title: "No statement" } }, "ValidationError"],
    ["a decision addressing something that does not exist", { decision: { title: "t", statement: "s", addresses: ["REQ-0999"] } }, "ValidationError"],
    ["a revision of a field that is not revisable", { revisions: [{ type: "requirement", id: fx.requirementId, changes: { reviewStatus: "approved" } }] }, "ValidationError"],
    ["a revision of an artifact that does not exist", { revisions: [{ type: "requirement", id: "REQ-0999", changes: { notes: "x" } }] }, "ValidationError"],
    ["a revision that changes nothing", { revisions: [{ type: "requirement", id: fx.requirementId, changes: { statement: "The system exports results." } }] }, "BundleRefusal"],
    ["a link the field does not allow", { links: [{ action: "link", type: "requirement", id: fx.requirementId, field: "openQuestions", targets: ["$decision"] }] }, "ValidationError"],
    ["a stage note written against a stale revision", { stageNote: { ...fullRequest(fx).stageNote, expectedRevision: `sha256:${"0".repeat(64)}` } }, "StageDocumentRefusal"],
    ["a question that arrives already answered", { question: { title: "t", statement: "s", answer: "x" } }, "BundleRefusal"],
    ["no answer", { answer: "  " }, "BundleRefusal"],
  ];
  for (const [label, change, name] of cases) {
    await assert.rejects(planDecisionBundle(fullRequest(fx, change), optionsFor(fx)), (e) => e.name === name, label);
    assertUnchanged(before, snapshot(fx.base), label);
  }
});

test("a bundle outside Stage 4 is refused", async () => {
  const fx = await project();
  await assert.rejects(
    planDecisionBundle(fullRequest(fx), optionsFor(fx, { currentStage: async () => "05-solution-design" })),
    (e) => e instanceof BundleRefusal && e.code === BUNDLE_REFUSAL.WRONG_STAGE
  );
});

test("⚠️ the digest covers content, targets, order and scope, and nothing else", async () => {
  const fx = await project();
  const ids = { question: "QST-0001", decision: "DEC-0001" };
  const digest = (request, withIds = ids) => bundleDigest({ stage: BUNDLE_STAGE, ids: withIds, operations: buildOperations(request, withIds) });
  const same = digest(fullRequest(fx));

  // Key order is not content.
  const reordered = fullRequest(fx);
  reordered.decision = { rationale: reordered.decision.rationale, statement: reordered.decision.statement, title: reordered.decision.title };
  assert.equal(digest(reordered), same);

  const changed = [
    ["wording", { answer: "CSV and JSON." }],
    ["a question field", { question: { title: "Export format", statement: "Which formats?" } }],
    ["a revision's content", { revisions: [{ type: "requirement", id: fx.requirementId, changes: { statement: "Something else." } }] }],
    ["a target", { links: [{ action: "link", type: "requirement", id: fx.requirementId, field: "openQuestions", targets: ["QST-0009"] }] }],
    ["scope: one operation fewer", { links: [] }],
    ["scope: one operation more", { revisions: [...fullRequest(fx).revisions, { type: "requirement", id: "REQ-0002", changes: { notes: "x" } }] }],
    ["the stage note", { stageNote: { ...fullRequest(fx).stageNote, content: "Decided otherwise." } }],
  ];
  for (const [label, change] of changed) assert.notEqual(digest(fullRequest(fx, change)), same, label);
  assert.notEqual(digest(fullRequest(fx), { question: "QST-0002", decision: "DEC-0001" }), same, "the reserved ids are part of what was approved");

  // Order: the same operations in another order are another bundle.
  const operations = buildOperations(fullRequest(fx), ids);
  const swapped = [...operations];
  [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  assert.notEqual(bundleDigest({ stage: BUNDLE_STAGE, ids, operations: swapped }), same);
});

/* ============================================================ a clean run ===================== */

test("⚠️ one confirmed bundle applies every operation under one held lock, through the typed writers", async () => {
  const fx = await project();
  const writers = instrumented();
  const result = await apply(fullRequest(fx), optionsFor(fx, writers));
  assertApplied(fx, result);
  // Each writer ran once, in the approved order. A writer that took the lock again without being told
  // it was held would have thrown; none did.
  assert.deepEqual(writers.calls, KINDS);
});

test("the journal is authorised before the first mutation", async () => {
  const fx = await project();
  const before = snapshot(fx.contentRoot);
  let first = null;
  const journalWriteFile = async (path, text) => {
    // The project as it stood when the journal was first written: untouched, with no id consumed.
    first ??= { content: snapshot(fx.contentRoot), journal: JSON.parse(text) };
    return atomicWrite(path, text);
  };
  await apply(fullRequest(fx), optionsFor(fx, { journalWriteFile }));
  assert.ok(first.content.delete(".planning.lock"), "the content lock was held when the journal was written");
  assertUnchanged(before, first.content, "when the journal was first written");
  assert.equal(first.journal.status, "authorized");
  assert.deepEqual(first.journal.operations.map((op) => op.status), KINDS.map(() => "pending"));
});

test("⚠️ a bundle whose journal cannot be kept is refused before anything changes", async () => {
  const fx = await project({ runtime: false });
  const before = snapshot(fx.base);
  await assert.rejects(planDecisionBundle(fullRequest(fx), optionsFor(fx)), (e) => e.code === BUNDLE_REFUSAL.JOURNAL_UNAVAILABLE);
  await assert.rejects(planDecisionBundle(fullRequest(fx), optionsFor(fx, { journal: null })), (e) => e.code === BUNDLE_REFUSAL.JOURNAL_UNAVAILABLE);
  assertUnchanged(before, snapshot(fx.base), "no runtime directory");

  // Authorised, but the first journal write fails: still nothing.
  const fx2 = await project();
  const planned = await planDecisionBundle(fullRequest(fx2), optionsFor(fx2));
  const before2 = snapshot(fx2.base);
  await assert.rejects(
    executeDecisionBundle(planned.plan, optionsFor(fx2, { journalWriteFile: async () => { throw new Error(LEAKY); } })),
    (e) => e.code === BUNDLE_REFUSAL.JOURNAL_UNWRITABLE && !e.message.includes(SECRET)
  );
  assertUnchanged(before2, snapshot(fx2.base), "an unwritable journal");
});

test("⚠️ a project that moved while the operator was deciding spends nothing and changes nothing", async () => {
  const moves = [
    ["a revised target changed", (fx) => MUTATION_TOOLS.reviseArtifact("requirement", fx.requirementId, { notes: "edited meanwhile" }, { contentRoot: fx.contentRoot, schemasDir: SCHEMAS, schemas, validators })],
    ["another question took the id", (fx) => TYPED_TOOLS.question({ title: "Other", statement: "Another question?" }, { contentRoot: fx.contentRoot, schemasDir: SCHEMAS, schemas, validators })],
    ["the stage document changed", (fx) => stageDocuments.writeStageDocumentEntry(fx.contentRoot, BUNDLE_STAGE, { verbatim: "An answer.", interpretation: "A reading." })],
  ];
  for (const [label, move] of moves) {
    const fx = await project();
    const planned = await planDecisionBundle(fullRequest(fx), optionsFor(fx));
    await move(fx);
    const before = snapshot(fx.base);
    await assert.rejects(executeDecisionBundle(planned.plan, optionsFor(fx)), (e) => e.code === BUNDLE_REFUSAL.STATE_MISMATCH, label);
    assertUnchanged(before, snapshot(fx.base), label);
    assert.equal(readJournal(fx.journal).state, JOURNAL_READ.ABSENT, `${label}: no authorisation was recorded`);
  }
});

/* ============================================================ failure at every operation ====== */

for (const [index, kind] of KINDS.entries()) {
  test(`⚠️ a writer that fails at operation ${index + 1} (${kind}) leaves a resumable journal, and the resume neither repeats nor skips`, async () => {
    const fx = await project();
    let armed = true;
    const failing = instrumented({
      before: (k) => {
        if (armed && k === kind) {
          armed = false;
          throw new Error(LEAKY);
        }
      },
    });
    const failed = await apply(fullRequest(fx), optionsFor(fx, failing));
    assert.equal(failed.ok, false);
    assert.equal(failed.status, "blocked");
    assert.equal(failed.code, BUNDLE_REFUSAL.OPERATION_FAILED);
    assert.deepEqual(statuses(failed), KINDS.map((_, i) => (i < index ? "completed" : i === index ? "failed" : "pending")));
    assert.equal(failed.checkpoint.firstIncomplete, index);
    assert.equal(failed.checkpoint.operations[index].code, "operation-failed");

    // ⚠️ THE JOURNAL KEEPS A CODE AND NOTHING THE FAILURE SAID.
    const stored = readFileSync(fx.journal.path, "utf-8");
    assert.ok(!stored.includes(SECRET) && !stored.includes(homedir()), "the journal holds no credential and no machine path");
    assert.equal(readJournal(fx.journal).journal.status, "failed");

    // The same request again is the same bundle: it resumes, with no second plan to confirm.
    const writers = instrumented();
    const planned = await planDecisionBundle(fullRequest(fx, { stageNote: fullRequest(fx).stageNote }), optionsFor(fx, writers));
    assert.equal(planned.mode, "resume");
    const resumed = await resumeDecisionBundle(planned.digest, optionsFor(fx, writers));
    assertApplied(fx, resumed);
    assert.deepEqual(writers.calls, KINDS.slice(index), "the resume started at the first incomplete operation");
  });

  test(`⚠️ an abort before operation ${index + 1} (${kind}) stops between operations, and the resume continues there`, async () => {
    const fx = await project();
    const controller = new AbortController();
    if (index === 0) controller.abort();
    const stopping = instrumented({
      after: (k) => {
        if (k === KINDS[index - 1]) controller.abort();
      },
    });
    const stopped = await apply(fullRequest(fx), optionsFor(fx, { ...stopping, signal: controller.signal }));
    assert.equal(stopped.code, BUNDLE_REFUSAL.INTERRUPTED);
    assert.deepEqual(statuses(stopped), KINDS.map((_, i) => (i < index ? "completed" : "pending")));
    assert.deepEqual(stopping.calls, KINDS.slice(0, index));
    assert.equal(readJournal(fx.journal).journal.status, "authorized");

    const writers = instrumented();
    const resumed = await resumeDecisionBundle(stopped.checkpoint.digest, optionsFor(fx, writers));
    assertApplied(fx, resumed);
    assert.deepEqual(writers.calls, KINDS.slice(index));
  });

  test(`⚠️ a crash after operation ${index + 1} (${kind}) ran and before the journal recorded it is not repeated on resume`, async () => {
    const fx = await project();
    // Write 1 is the authorisation; write index + 2 is the record of this operation.
    let writes = 0;
    const journalWriteFile = async (path, text) => {
      writes++;
      if (writes === index + 2) throw new Error(LEAKY);
      return atomicWrite(path, text);
    };
    const first = instrumented();
    const crashed = await apply(fullRequest(fx), optionsFor(fx, { ...first, journalWriteFile }));
    assert.equal(crashed.code, BUNDLE_REFUSAL.JOURNAL_UNWRITABLE);
    assert.deepEqual(first.calls, KINDS.slice(0, index + 1), "the bundle stopped rather than continue unjournaled");
    // On disk the operation ran, and the journal still says it did not.
    assert.equal(readJournal(fx.journal).journal.operations[index].status, "pending");

    const writers = instrumented();
    const resumed = await resumeDecisionBundle(crashed.checkpoint.digest, optionsFor(fx, writers));
    assertApplied(fx, resumed);
    assert.deepEqual(writers.calls, KINDS.slice(index + 1), "the operation that had already landed was recorded, not run again");
  });
}

/* ============================================================ authorisation is exact ========== */

async function interruptedAfter(fx, count) {
  const controller = new AbortController();
  let done = 0;
  const stopping = instrumented({
    after: () => {
      if (++done === count) controller.abort();
    },
  });
  return apply(fullRequest(fx), optionsFor(fx, { ...stopping, signal: controller.signal }));
}

test("⚠️ a changed request does not inherit an incomplete bundle's approval", async () => {
  const fx = await project();
  const stopped = await interruptedAfter(fx, 2);
  const before = snapshot(fx.base);

  const changes = [
    ["content", { answer: "CSV and JSON." }],
    ["a target", { revisions: [{ type: "requirement", id: fx.requirementId, changes: { notes: "different" } }] }],
    ["scope", { links: [] }],
  ];
  for (const [label, change] of changes) {
    await assert.rejects(
      planDecisionBundle(fullRequest(fx, change), optionsFor(fx)),
      (e) => e instanceof BundleRefusal && e.code === BUNDLE_REFUSAL.DIGEST_MISMATCH && e.checkpoint.digest === stopped.checkpoint.digest,
      label
    );
  }
  await assert.rejects(planDecisionBundle({ resumeDigest: `sha256:${"0".repeat(64)}` }, optionsFor(fx)), (e) => e.code === BUNDLE_REFUSAL.DIGEST_MISMATCH);
  await assert.rejects(resumeDecisionBundle(`sha256:${"0".repeat(64)}`, optionsFor(fx)), (e) => e.code === BUNDLE_REFUSAL.DIGEST_MISMATCH);
  assertUnchanged(before, snapshot(fx.base), "refused requests");

  // Asking to replace it is a fresh plan, with fresh ids, that discloses what the earlier bundle already did.
  const replacement = await planDecisionBundle(fullRequest(fx, { answer: "CSV and JSON.", replaceIncomplete: true }), optionsFor(fx));
  assert.equal(replacement.mode, "fresh");
  assert.deepEqual(replacement.plan.ids, { question: "QST-0002", decision: "DEC-0002" }, "consumed ids stay consumed");
  assert.equal(replacement.plan.replaces.digest, stopped.checkpoint.digest);
  assert.deepEqual(replacement.plan.replaces.operations.filter((op) => op.status === "completed").map((op) => op.kind), KINDS.slice(0, 2));
});

test("the approved digest alone resumes, and there is nothing to resume once it is done", async () => {
  const fx = await project();
  const stopped = await interruptedAfter(fx, 3);
  const planned = await planDecisionBundle({ resumeDigest: stopped.checkpoint.digest }, optionsFor(fx));
  assert.deepEqual(planned, { mode: "resume", digest: stopped.checkpoint.digest });
  assertApplied(fx, await resumeDecisionBundle(planned.digest, optionsFor(fx)));

  await assert.rejects(planDecisionBundle({ resumeDigest: stopped.checkpoint.digest }, optionsFor(fx)), (e) => e.code === BUNDLE_REFUSAL.NOTHING_TO_RESUME);
  await assert.rejects(resumeDecisionBundle(stopped.checkpoint.digest, optionsFor(fx)), (e) => e.code === BUNDLE_REFUSAL.NOTHING_TO_RESUME);
});

test("⚠️ a resume refuses safely when the project no longer matches the journal, and the authorisation is spent", async () => {
  const base0 = (fx) => ({ contentRoot: fx.contentRoot, schemasDir: SCHEMAS, schemas, validators });
  const moves = [
    ["a completed operation's artifact was edited", 3, (fx) => MUTATION_TOOLS.reviseArtifact("question", "QST-0001", { notes: "edited meanwhile" }, base0(fx))],
    ["a pending operation's target was edited", 3, (fx) => MUTATION_TOOLS.reviseArtifact("requirement", fx.requirementId, { notes: "edited meanwhile" }, base0(fx))],
    ["a created artifact was removed", 2, (fx) => rmSync(join(fx.contentRoot, "data", "decisions", "DEC-0001.json"))],
    ["the stage document changed", 5, (fx) => stageDocuments.writeStageDocumentEntry(fx.contentRoot, BUNDLE_STAGE, { verbatim: "An answer.", interpretation: "A reading." })],
  ];
  for (const [label, count, move] of moves) {
    const fx = await project();
    const stopped = await interruptedAfter(fx, count);
    await move(fx);
    const before = snapshot(fx.contentRoot);

    const writers = instrumented();
    const refused = await resumeDecisionBundle(stopped.checkpoint.digest, optionsFor(fx, writers));
    assert.equal(refused.ok, false, label);
    assert.equal(refused.code, BUNDLE_REFUSAL.STATE_MISMATCH, label);
    assert.equal(refused.checkpoint.status, "blocked", label);
    assert.equal(refused.checkpoint.operations[count].status, "blocked", label);
    assert.deepEqual(writers.calls, [], `${label}: nothing ran`);
    assertUnchanged(before, snapshot(fx.contentRoot), label);

    // Blocked is final: the digest no longer resumes, and the next proposal is a fresh one to confirm.
    await assert.rejects(resumeDecisionBundle(stopped.checkpoint.digest, optionsFor(fx)), (e) => e.code === BUNDLE_REFUSAL.NOTHING_TO_RESUME, label);
    const request = fullRequest(fx, label.includes("pending") ? { revisions: [{ type: "requirement", id: fx.requirementId, changes: { statement: "The system exports results as CSV." } }] } : {});
    const again = await planDecisionBundle(request, optionsFor(fx)).catch((e) => e);
    if (!(again instanceof Error)) {
      assert.equal(again.mode, "fresh", label);
      assert.equal(again.plan.replaces.status, "blocked", label);
    }
  }
});

test("⚠️ a journal that cannot be read or validated is never resumed and never silently replaced", async () => {
  const fx = await project();
  const stopped = await interruptedAfter(fx, 2);

  // An operation edited under an unedited digest is a bundle nobody approved.
  const tampered = JSON.parse(readFileSync(fx.journal.path, "utf-8"));
  tampered.operations[3].args.changes.statement = "Something the operator never saw.";
  writeFileSync(fx.journal.path, JSON.stringify(tampered, null, 2));
  assert.equal(readJournal(fx.journal).state, JOURNAL_READ.INVALID);

  const before = snapshot(fx.base);
  for (const attempt of [
    () => resumeDecisionBundle(stopped.checkpoint.digest, optionsFor(fx)),
    () => planDecisionBundle({ resumeDigest: stopped.checkpoint.digest }, optionsFor(fx)),
    () => planDecisionBundle(fullRequest(fx), optionsFor(fx)),
  ])
    await assert.rejects(attempt(), (e) => e.code === BUNDLE_REFUSAL.JOURNAL_UNREADABLE);
  assertUnchanged(before, snapshot(fx.base), "an unreadable journal");

  for (const text of ["{ not json", JSON.stringify({ recordVersion: 1, status: "authorized" }), JSON.stringify({ ...tampered, somethingNobodyDeclared: true })]) {
    writeFileSync(fx.journal.path, text);
    assert.equal(readJournal(fx.journal).state, JOURNAL_READ.INVALID);
  }

  // Only an explicit replacement, which the caller must put to the operator, gets past it.
  const replacement = await planDecisionBundle(fullRequest(fx, { replaceIncomplete: true }), optionsFor(fx));
  assert.deepEqual(replacement.plan.replaces, { unreadable: true });
});

test("⚠️ a journal Git would carry is not this computer's to resume", async () => {
  const fx = await project();
  const stopped = await interruptedAfter(fx, 2);
  execFileSync("git", ["add", "-f", fx.journal.path], { cwd: fx.base });
  assert.equal(readJournal(fx.journal).state, JOURNAL_READ.UNPROTECTED);
  await assert.rejects(resumeDecisionBundle(stopped.checkpoint.digest, optionsFor(fx)), (e) => e.code === BUNDLE_REFUSAL.JOURNAL_UNAVAILABLE);
});

test("the stage target is the only non-artifact a bundle touches", () => {
  assert.equal(STAGE_TARGET, `stage:${BUNDLE_STAGE}`);
});
