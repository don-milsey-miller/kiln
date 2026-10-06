/**
 * Kiln's compaction checkpoint, built within a bound that can actually be enforced - #178.
 *
 * A compaction must finish. The part of the checkpoint that is derived from the project - the current stage, the
 * decision-bundle journal - is synchronous work that grows with the project, and a timer on the main thread cannot
 * interrupt synchronous work: it only fires after the work returns. So that part runs in a worker thread, and the
 * bound is kept by terminating the thread.
 *
 * ⚠️ **THE RESULT IS ALWAYS A CHECKPOINT, NEVER A THROW.** When the worker fails, or is stopped at the bound, the
 * answer is a minimal checkpoint carrying a fixed code. A caller that received nothing would have nothing to give
 * Pi, and Pi's own fallback is a model-written summary of an over-limit context.
 */

import { Worker } from "node:worker_threads";

/** The whole derived build, start to finish. About fifteen times the largest cost measured on a 540-artifact project. */
export const CHECKPOINT_BOUND_MS = 5_000;

export const CHECKPOINT_CODE = Object.freeze({
  TIMEOUT: "checkpoint-timeout",
  FAILED: "checkpoint-build-failed",
  STAGE_UNAVAILABLE: "stage-unavailable",
});

const DEFAULT_WORKER = new URL("./workflow-checkpoint-worker.mjs", import.meta.url);

/** What a caller gets when the derived build produced nothing usable. */
const minimal = (code) => ({ stage: null, bundle: { state: "unknown", lastOperation: null }, code });

/**
 * Derive the stage and the bundle state, or a minimal checkpoint with the reason, within `boundMs`.
 *
 * @param {{toolRoot?: string, journalLocation?: object|null, journalFromEnv?: boolean, boundMs?: number, worker?: URL|string}} [options]
 *   `worker` replaces the worker module, for a test that needs one that never returns.
 * @returns {Promise<{stage: object|null, bundle: object, code?: string, elapsedMs: number}>}
 */
export function buildWorkflowCheckpoint({ toolRoot, journalLocation = null, journalFromEnv = true, boundMs = CHECKPOINT_BOUND_MS, worker = DEFAULT_WORKER } = {}) {
  const started = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    let thread;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ⚠️ TERMINATED WHETHER OR NOT IT ANSWERED. A worker left running holds the event loop open, and one that is
      // still spinning at the bound is stopped here: this is what makes the bound real for synchronous work.
      void thread?.terminate();
      resolve({ ...value, elapsedMs: Math.round(performance.now() - started) });
    };
    try {
      thread = new Worker(worker, { workerData: { toolRoot, journalLocation, journalFromEnv }, stdout: true, stderr: true });
    } catch {
      return finish(minimal(CHECKPOINT_CODE.FAILED));
    }
    timer = setTimeout(() => finish(minimal(CHECKPOINT_CODE.TIMEOUT)), boundMs);
    thread.once("message", (message) => {
      const usable = message !== null && typeof message === "object" && message.bundle !== null && typeof message.bundle === "object";
      if (!usable) return finish(minimal(CHECKPOINT_CODE.FAILED));
      finish({ stage: message.stage ?? null, bundle: message.bundle, ...(message.stage ? {} : { code: CHECKPOINT_CODE.STAGE_UNAVAILABLE }) });
    });
    thread.once("error", () => finish(minimal(CHECKPOINT_CODE.FAILED)));
    thread.once("exit", () => finish(minimal(CHECKPOINT_CODE.FAILED)));
  });
}

/* ------------------------------------------------------------------ the current turn, on an overflow */

export const INPUT_EXCEEDS = "input-exceeds-context-window";

/** Pi's own size estimate for text: four characters to a token. */
export const estimateTokens = (text) => Math.ceil((typeof text === "string" ? text.length : 0) / 4);

const textParts = (message) =>
  typeof message?.content === "string" ? message.content : (Array.isArray(message?.content) ? message.content : []).map((part) => (part?.type === "text" ? part.text : part?.type === "image" ? "" : JSON.stringify(part ?? ""))).join("\n");

/** A message's size as the provider will see it, tool calls and results included. */
const messageTokens = (message) => estimateTokens(textParts(message));
const userText = (message) => (typeof message?.content === "string" ? message.content : (Array.isArray(message?.content) ? message.content : []).filter((part) => part?.type === "text").map((part) => part.text).join("\n"));

/** Tokens the summary itself may take beside a verbatim turn: the checkpoint and the bounded narrative. */
const SUMMARY_ALLOWANCE_TOKENS = 6_000;

/**
 * What an overflow retry must do with the turn it is retrying.
 *
 * Pi compacts and then sends the interrupted turn again. That is only correct if the request the operator made is
 * still in it. Three answers:
 *
 *  - `kept`     the latest user message is after Pi's boundary, so Pi keeps it word for word;
 *  - `verbatim` it falls before the boundary and fits, so the summary must carry it whole (`text`);
 *  - `exceeds`  it cannot fit in this model's window at all, so retrying would mean retrying a cut-down prompt.
 *
 * ⚠️ **PI'S BOUNDARY IS READ, NEVER MOVED.** Which entries are kept is `preparation.firstKeptEntryId`. This decides
 * only what the summary must contain, and whether the retry may happen.
 *
 * ⚠️ **AN UNKNOWN WINDOW IS NOT A REASON TO CUT.** Without the model's context window nothing can be judged too
 * large, so the turn is carried whole.
 *
 * @param {object} event the `session_before_compact` event
 * @param {{contextWindow?: number}} model
 */
export function currentTurnOnRetry(event, { contextWindow } = {}) {
  const preparation = event?.preparation ?? {};
  const discarded = [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])];
  const entries = Array.isArray(event?.branchEntries) ? event.branchEntries : [];
  const keptFrom = entries.findIndex((entry) => entry?.id === preparation.firstKeptEntryId);
  const kept = keptFrom === -1 ? [] : entries.slice(keptFrom).filter((entry) => entry?.type === "message").map((entry) => entry.message);
  const keptUser = kept.filter((message) => message?.role === "user").at(-1) ?? null;
  const discardedUser = discarded.filter((message) => message?.role === "user").at(-1) ?? null;

  const known = Number.isFinite(contextWindow) && contextWindow > 0;
  // What is not messages: the system prompt and tool schemas. Pi's own count before compaction, less every message.
  const allMessages = entries.filter((entry) => entry?.type === "message").reduce((sum, entry) => sum + messageTokens(entry.message), 0);
  const overhead = Math.max(0, (Number.isFinite(preparation.tokensBefore) ? preparation.tokensBefore : 0) - allMessages);
  const reserve = Number.isFinite(preparation.settings?.reserveTokens) ? preparation.settings.reserveTokens : 16_384;
  const available = known ? contextWindow - reserve - overhead - SUMMARY_ALLOWANCE_TOKENS : Infinity;

  if (keptUser !== null) {
    // Pi keeps it. It is still too large when it alone is more than the window can hold.
    return messageTokens(keptUser) > available ? { outcome: "exceeds" } : { outcome: "kept" };
  }
  if (discardedUser === null) return { outcome: "kept" };
  const text = userText(discardedUser);
  // ⚠️ JUDGED ALONE. Whether the entries Pi keeps also fit is Pi's boundary to answer: if the retry still overflows,
  // Pi reports that failure itself. What is decided here is only whether this request could ever be sent whole.
  return estimateTokens(text) > available ? { outcome: "exceeds" } : { outcome: "verbatim", text };
}
