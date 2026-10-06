/**
 * The derived half of Kiln's compaction checkpoint, computed off the main thread - #178.
 *
 * Everything here is synchronous work over the project: loading schemas, linting artifacts to find the current
 * stage, reading the decision-bundle journal. It runs in a worker so `lib/workflow-checkpoint.mjs` can stop it
 * after a bound by terminating the thread, which is the only way to interrupt synchronous code.
 *
 * ⚠️ **IT POSTS ONE MESSAGE AND NOTHING ELSE.** Identifiers, statuses, fixed codes, and one bounded question
 * statement. Never an error message, a path or an artifact body.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { readActivatedTypes } from "./activation.mjs";
import { resolveContentRoot, resolveInContentRoot, toolRoot as defaultToolRoot } from "./content-root.mjs";
import { JOURNAL_READ, BUNDLE_STATUS, checkpointOf, isResumable, journalLocationFromEnv, readJournal } from "./decision-bundle-journal.mjs";
import { currentRoutingContext } from "./decisioning/context.mjs";
import { artifactRelPath } from "./layout.mjs";
import { assertOrchestratorContentRoot } from "./orchestrator-root.mjs";
import { loadSchemaSet } from "./schema-resolver.mjs";
import { createValidators } from "./validate.mjs";

const QUESTION_MAX_CHARS = 600;

/** The current stage from project state, or the fixed reason it could not be derived. */
function stageOf({ toolRoot }) {
  try {
    const contentRoot = resolveContentRoot();
    assertOrchestratorContentRoot({ contentRoot, toolRoot });
    const schemasDir = join(toolRoot, "schemas");
    const ctx = { contentRoot, schemas: loadSchemaSet(schemasDir), validators: createValidators(schemasDir), activated: readActivatedTypes(contentRoot) };
    const stage = currentRoutingContext(ctx, { toolRoot });
    return { contentRoot, stage: stage.complete ? { complete: true } : { complete: false, id: stage.id, name: typeof stage.name === "string" ? stage.name : null } };
  } catch {
    return { contentRoot: null, stage: null };
  }
}

/** What the decision-bundle journal says: nothing in flight, an unfinished bundle, or a journal that cannot be read. */
function bundleOf(location, contentRoot) {
  if (!location) return { state: "none", lastOperation: null };
  // ⚠️ DESCRIBED, NOT RESUMED, so Git is not asked here. The bundle tool asks before it continues anything.
  const read = readJournal(location, { verifyGit: false });
  if (read.state === JOURNAL_READ.ABSENT) return { state: "none", lastOperation: null };
  if (read.state !== JOURNAL_READ.VALID) return { state: "unreadable", lastOperation: null };

  const journal = read.journal;
  const details = checkpointOf(journal);
  // The last operation that completed, as identifiers and a status. It outlives the bundle that ran it.
  const completed = details.operations.filter((op) => op.status === "completed").at(-1) ?? null;
  const lastOperation = completed ? { digest: journal.digest, bundleStatus: journal.status, index: completed.index, kind: completed.kind, target: completed.target, status: completed.status } : null;
  if (!isResumable(journal)) return { state: journal.status === BUNDLE_STATUS.BLOCKED ? "blocked" : "none", lastOperation };

  let question = journal.operations.find((op) => op.kind === "create-question")?.args?.artifact?.statement;
  if (typeof question !== "string" && contentRoot) {
    try {
      const path = resolveInContentRoot(artifactRelPath("question", journal.ids.question), { contentRoot });
      if (existsSync(path)) question = JSON.parse(readFileSync(path, "utf-8")).statement;
    } catch {
      question = null;
    }
  }
  return { state: "unfinished", details, question: typeof question === "string" ? question.slice(0, QUESTION_MAX_CHARS) : null, lastOperation };
}

const toolRoot = workerData?.toolRoot ?? defaultToolRoot();
const { contentRoot, stage } = stageOf({ toolRoot });
let location = workerData?.journalLocation ?? null;
if (!location && workerData?.journalFromEnv !== false) {
  try {
    location = journalLocationFromEnv();
  } catch {
    location = null;
  }
}
let bundle;
try {
  bundle = bundleOf(location, contentRoot);
} catch {
  bundle = { state: "unreadable", lastOperation: null };
}
parentPort.postMessage({ stage, bundle });
