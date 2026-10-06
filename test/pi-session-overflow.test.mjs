/**
 * Threshold and overflow compaction in a real pinned Pi, with a small-context loopback model - #178.
 *
 * #178 reported a session at 290% of its window whose compaction ran for minutes, restarted on Escape, and was
 * still over the limit after a restart. Each claim here is read from where it lands: the events Pi prints, the
 * requests the provider received, and the transcript Pi wrote.
 *
 * ⚠️ **THE PROVIDER REFUSES AN OVER-LIMIT REQUEST THE WAY A REAL ONE DOES**, with a 400 naming the context length, so
 * the overflow path is Pi's own and not something a test called directly.
 *
 * ⚠️ **NO SUMMARISATION REQUEST IS EVER MADE.** Kiln composes every compaction locally. A provider request that is
 * not one of the session's own turns would be Pi's model-written summary, which is the unbounded step.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { rpcSession, scriptedProvider, sessionFixture, textOf } from "./helpers/pi-session.mjs";
import { CHECKPOINT_BOUND_MS } from "../lib/workflow-checkpoint.mjs";

/** The loopback model's declared window, and how much of it the session's own prompt and tool schemas take. */
const WINDOW = 100_000;
const OVERHEAD_TOKENS = 30_000;
/** What the provider accepts in messages before it answers "maximum context length". */
const LIMIT_CHARS = (WINDOW - OVERHEAD_TOKENS) * 4;

const settled = (event) => event.type === "agent_settled";
const filler = (kb, tag) => `${tag} ${"dock fees reconcile against invoices weekly ".repeat(Math.ceil((kb * 1024) / 45))}`;
const compactions = (events, type) => events.filter((event) => event.type === type);
const conversation = (request) => request.messages.filter((m) => m.role !== "system" && m.role !== "developer").map((m) => textOf(m.content)).join("\n");
const transcriptEntries = (fx) =>
  readdirSync(join(fx.base, "sessions"), { recursive: true })
    .filter((name) => String(name).endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(fx.base, "sessions", String(name)), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));

/** Every request is one of the session's own turns: it carries Kiln's frame, so it is not a summarisation call. */
function assertNoSummarisation(provider) {
  for (const [index, request] of provider.requests.entries()) {
    const system = request.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
    assert.ok(system.includes("Kiln rule, for every turn of this session"), `request ${index + 1} is not a session turn: Pi asked the model for a summary`);
  }
}

/** Each compaction, start to end, took less than Kiln's bound. */
function assertBounded(events) {
  const starts = compactions(events, "compaction_start");
  const ends = compactions(events, "compaction_end");
  assert.equal(starts.length, ends.length, "a compaction started and never ended");
  for (const [index, start] of starts.entries()) {
    const took = ends[index].arrivedAt - start.arrivedAt;
    assert.ok(took < CHECKPOINT_BOUND_MS, `compaction ${index + 1} took ${took} ms`);
  }
}

async function fixture(options = {}) {
  const provider = await scriptedProvider();
  provider.limit.chars = LIMIT_CHARS;
  provider.limit.tokens = WINDOW;
  const fx = await sessionFixture(provider, { contextWindow: WINDOW, ...options });
  return { provider, fx, close: async () => (await provider.close(), fx.remove()) };
}

test("⚠️ #178 threshold compaction completes locally within the bound, and a restart does not resend the old context", { timeout: 240_000 }, async () => {
  const { provider, fx, close } = await fixture();
  try {
    // Turns of 60 KB: the estimate crosses the window less Pi's reserve after a few of them.
    const first = await rpcSession(fx, async (io) => {
      for (let turn = 1; turn <= 6; turn++) {
        io.send({ id: `p${turn}`, type: "prompt", message: filler(60, `TURN-${turn}`) });
        await io.waitFor(`turn ${turn} to settle`, settled, { count: turn });
      }
    });
    const ended = compactions(first.events, "compaction_end");
    assert.ok(ended.length >= 1, "no threshold compaction happened");
    for (const end of ended) {
      assert.equal(end.reason, "threshold");
      assert.equal(end.aborted, false);
      assert.equal(end.errorMessage, undefined);
    }
    assertBounded(first.events);
    assertNoSummarisation(provider);
    assert.equal(provider.requests.filter((request) => request.refused).length, 0, "a threshold run reached the provider's limit");

    // The transcript holds Kiln's entries, supplied by the extension, with the derived stage.
    const written = transcriptEntries(fx).filter((entry) => entry.type === "compaction");
    assert.equal(written.length, ended.length);
    for (const entry of written) assert.equal(entry.details.kilnCheckpoint.stage, "01-intake");

    // ⚠️ AFTER A RESTART, THE FIRST REQUEST IS BELOW THE WINDOW AND CARRIES THE SUMMARY, NOT THE OLD TURNS.
    const before = provider.requests.length;
    await rpcSession(fx, async (io) => {
      io.send({ id: "r", type: "prompt", message: "RESUMED: what is next?" });
      await io.waitFor("the resumed turn to settle", settled);
    }, { args: ["--continue"] });
    const resumed = provider.requests[before];
    assert.equal(resumed.refused, undefined, "the resumed session immediately sent an over-limit request");
    assert.ok(resumed.messageChars < LIMIT_CHARS / 2, `the resumed request carried ${resumed.messageChars} characters`);
    assert.ok(conversation(resumed).includes("No approved decision bundle is in flight."), "the resumed session was not rebuilt from Kiln's summary");
    assert.ok(!conversation(resumed).includes(filler(60, "TURN-1")), "the first turn is still sent verbatim");
  } finally {
    await close();
  }
});

test("⚠️ #178 F5 an overflow in a long turn compacts, retries, and the retry still carries the operator's request whole", { timeout: 240_000 }, async () => {
  // Each status call returns the 60 KB Stage 1 document, so one turn outgrows the window through its own tool results.
  const { provider, fx, close } = await fixture({ stageDocument: `# Stage 01 - Intake\n\n${"The port office reconciles dock fees. ".repeat(1700)}\n` });
  try {
    // Longer than the 1 KB a summarised message is cut to. The end marker is what a truncation would lose.
    const asked = `CURRENT-REQUEST ${"Compare this week's dock fees with last week's and list every difference. ".repeat(30)}END-OF-REQUEST`;
    assert.ok(Buffer.byteLength(asked) > 2_000);
    // ⚠️ A LIMIT BELOW PI'S OWN THRESHOLD, so the provider refuses first and the overflow path is the one taken.
    provider.limit.chars = 180_000;
    for (let call = 0; call < 8; call++) provider.script.push({ tool: "kiln_project_status" });
    const run = await rpcSession(fx, async (io) => {
      io.send({ id: "p", type: "prompt", message: asked });
      // The turn ends when the scripted tool calls are spent and the provider answers in text.
      await io.waitFor("the turn to settle", settled, { timeoutMs: 150_000 });
    });

    const refused = provider.requests.filter((request) => request.refused);
    assert.ok(refused.length >= 1, "the turn never overflowed");
    const ended = compactions(run.events, "compaction_end").filter((event) => event.reason === "overflow");
    assert.ok(ended.length >= 1, "no overflow compaction happened");
    assert.equal(ended[0].aborted, false);
    assert.equal(ended[0].willRetry, true);
    assertBounded(run.events);
    assertNoSummarisation(provider);

    // ⚠️ THE RETRY: the request right after the refused one is under the limit and still holds every word asked.
    const retry = provider.requests[provider.requests.indexOf(refused[0]) + 1];
    assert.ok(retry, "nothing was sent after the overflow");
    assert.equal(retry.refused, undefined, "the retry overflowed again");
    assert.ok(conversation(retry).includes(asked), "the retried turn no longer carries the operator's request whole");
    assert.ok(conversation(retry).includes("## Current request (the operator's words, unchanged)"));
    assert.equal(run.events.filter((event) => event.type === "extension_error").length, 0);
  } finally {
    await close();
  }
});

test("⚠️ #178 F5 a single input larger than the window is not retried cut down, and nothing of it is copied", { timeout: 240_000 }, async () => {
  const { provider, fx, close } = await fixture();
  try {
    const huge = `HUGE-INPUT-START ${"x".repeat(LIMIT_CHARS + 80_000)} HUGE-INPUT-END`;
    const run = await rpcSession(fx, async (io) => {
      io.send({ id: "p1", type: "prompt", message: "A first, ordinary question." });
      await io.waitFor("the first turn to settle", settled);
      io.send({ id: "p2", type: "prompt", message: huge });
      await io.waitFor("the oversized turn to settle", settled, { count: 2 });
    });

    // The provider refused it once. Kiln cancelled the compaction, so there was no retry of a shortened prompt.
    const refusedAt = provider.requests.findIndex((request) => request.refused);
    assert.notEqual(refusedAt, -1, "the oversized input never reached the provider's limit");
    assert.equal(provider.requests.length, refusedAt + 1, "something was sent after the oversized input was refused");
    for (const request of provider.requests) assert.ok(request.refused || !conversation(request).includes("HUGE-INPUT-START"), "a cut-down copy of the input was sent");
    const end = compactions(run.events, "compaction_end").at(-1);
    assert.ok(end, "no compaction was attempted");
    assert.equal(end.reason, "overflow");
    assert.equal(end.aborted, true, "the compaction was not cancelled");
    assertBounded(run.events);
    assertNoSummarisation(provider);

    // No compaction entry was written, and the operator was told why with a fixed notice that quotes nothing.
    assert.equal(transcriptEntries(fx).filter((entry) => entry.type === "compaction").length, 0);
    const notices = run.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify");
    assert.ok(notices.some((notice) => notice.message.includes("larger than this model's context window")), JSON.stringify(notices.map((n) => n.message)));
    for (const notice of notices) assert.ok(!notice.message.includes("HUGE-INPUT"), "the notice quotes the input");
  } finally {
    await close();
  }
});
