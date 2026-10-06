/**
 * Session recovery through the real launcher and supervisor - #178.
 *
 * When a session cannot go on, Kiln's extension leaves a request bound to the run and asks Pi to shut down. The
 * supervisor then records a new session under the session lock and starts Pi on it, keeping the browser launcher
 * and every earlier transcript. This file drives `start-kiln.mjs --rpc` and reads the outcome from the session
 * record, the transcripts on disk, the supervisor's notices and the requests the provider received.
 *
 * ⚠️ **THE SESSION RECORD IS THE SUPERVISOR'S.** Nothing here writes it, and the assertions read it only to see that
 * it named a session before Pi was started on that session.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { kilnProject } from "./helpers/kiln-launch.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";
import { textOf } from "./helpers/pi-session.mjs";
import { RECOVERY_REQUEST_FILE } from "../lib/recovery-request.mjs";

const WINDOW = 128_000;
/** What the provider accepts in messages. An input past this is refused with "maximum context length". */
const LIMIT_CHARS = 300_000;
/** Larger than the provider accepts, and larger than the window less its reserve and the session's own prompt. */
const huge = (tag) => `${tag}-START ${"x".repeat(LIMIT_CHARS + 120_000)} ${tag}-END`;

const settled = (event) => event.type === "agent_settled";
const conversation = (request) => request.messages.filter((m) => m.role !== "system" && m.role !== "developer").map((m) => textOf(m.content)).join("\n");
const RECOVERED = "\\[kiln\\] session (\\S+) \\(new, recorded; recovery: ([a-z-]+)\\)";

test("⚠️ #178 an input that exceeds the window ends that session, and the supervisor starts one new recorded session, once", { timeout: 12 * 60_000 }, async () => {
  const fx = await kilnProject({ contextWindow: WINDOW, label: "#178 session recovery" });
  try {
    fx.provider.limit.chars = LIMIT_CHARS;
    fx.provider.limit.tokens = WINDOW;
    await withBuildLock(async () => {
      let first = null;
      let recoveredTo = null;
      const run = await fx.launch(async (io) => {
        io.send({ id: "a", type: "prompt", message: "FIRST-SESSION an ordinary question" });
        await io.waitFor("the first turn to settle", settled);
        first = fx.pointer().sessionId;

        // ⚠️ THE OVERSIZED INPUT. The provider refuses it; Kiln cancels the compaction and asks for a new session.
        io.send({ id: "b", type: "prompt", message: huge("HUGE-ONE") });
        const recovered = await io.said(RECOVERED);
        recoveredTo = recovered[1];
        assert.equal(recovered[2], "input-exceeds-context-window");
        // ⚠️ RECORDED BEFORE IT IS USABLE: the record names the new session before any turn has run in it.
        assert.equal(fx.pointer().sessionId, recoveredTo, "the supervisor announced a session the record does not name");
        assert.notEqual(recoveredTo, first);

        // The relaunched agent is usable, on the new session, and was not handed the oversized input.
        await io.said("\\[kiln\\] agent started", { count: 2 });
        const before = fx.provider.requests.length;
        // Both agents write to the one event stream, so the wait is for one more settle than has been seen.
        const settledSoFar = io.events().filter(settled).length;
        io.send({ id: "c", type: "prompt", message: "SECOND-SESSION are you there?" });
        await io.waitFor("the recovered session's turn to settle", settled, { count: settledSoFar + 1, timeoutMs: 120_000 });
        const next = fx.provider.requests[before];
        assert.ok(next && !next.refused, "the recovered session's first request was refused");
        assert.ok(conversation(next).includes("SECOND-SESSION are you there?"));
        assert.ok(!conversation(next).includes("HUGE-ONE"), "the oversized input, or a piece of it, was carried into the new session");
        assert.ok(!conversation(next).includes("FIRST-SESSION"), "the new session was sent the old transcript");

        // ⚠️ ONE AUTOMATIC RECOVERY PER LAUNCH. A second failure of the same kind stops the run instead of looping.
        io.send({ id: "d", type: "prompt", message: huge("HUGE-TWO") });
        await io.said("this launch has already recovered once, so it stops here");
      });

      assert.equal(run.exit.signal, null, run.stderr.slice(-3000));
      assert.equal([...run.stderr.matchAll(new RegExp(RECOVERED, "g"))].length, 1, "the supervisor recovered more than once");
      assert.equal([...run.stderr.matchAll(/\[kiln\] agent started/g)].length, 2, "the agent was started other than twice");
      assert.equal([...run.stderr.matchAll(/\[kiln\] launcher started/g)].length, 1, "the browser launcher was restarted");
      assert.equal(run.stdout.split("\n").filter((line) => line.trim() && !line.trim().startsWith("{")).length, 0, "the protocol stream was corrupted across the relaunch");

      // Both transcripts exist, each under its own id, and the record still names the recovered one.
      const transcripts = fx.transcripts();
      assert.deepEqual(transcripts.map((t) => t.id).sort(), [first, recoveredTo].sort(), "a transcript was removed, or an unrecorded one was created");
      assert.ok(transcripts.find((t) => t.id === first).bytes > LIMIT_CHARS, "the oversized transcript was not left in place");
      assert.equal(fx.pointer().sessionId, recoveredTo);
      // Every request was consumed: nothing is left for a later run to find.
      assert.equal(existsSync(join(fx.runtimeDir, RECOVERY_REQUEST_FILE)), false);

      // The provider never received a shortened copy of either oversized input.
      for (const request of fx.provider.requests) assert.ok(request.refused || !/HUGE-(ONE|TWO)/.test(conversation(request)), "a cut-down oversized input was sent");

      // ⚠️ THE NEXT ORDINARY LAUNCH RESUMES THE RECOVERED SESSION, NOT THE OVERSIZED ONE, and its first request fits.
      const before = fx.provider.requests.length;
      const later = await fx.launch(async (io) => {
        io.send({ id: "e", type: "prompt", message: "THIRD-LAUNCH hello" });
        await io.waitFor("the resumed turn to settle", settled);
      });
      assert.equal(later.exit.status, 0, later.stderr.slice(-3000));
      assert.ok(later.stderr.includes(`[kiln] session ${recoveredTo} (resumed from the record)`), later.stderr.slice(-2000));
      assert.equal(fx.provider.requests[before].refused, undefined, "the resumed session immediately resent an over-limit payload");
      assert.ok(conversation(fx.provider.requests[before]).includes("SECOND-SESSION are you there?"));
    });
  } finally {
    await fx.close();
  }
});

test("⚠️ #178 a recovery request left by another run is discarded unread and starts nothing", { timeout: 8 * 60_000 }, async () => {
  const fx = await kilnProject({ label: "#178 stale recovery request" });
  try {
    await withBuildLock(async () => {
      // Well-formed, for a run that is not the one about to start.
      writeFileSync(
        join(fx.runtimeDir, RECOVERY_REQUEST_FILE),
        JSON.stringify({ recordVersion: 1, runId: "0123456789abcdef0123456789abcdef", reason: "input-exceeds-context-window", requestedAt: "2026-10-06T12:00:00.000Z" })
      );
      const run = await fx.launch(async (io) => {
        io.send({ id: "a", type: "prompt", message: "An ordinary question." });
        await io.waitFor("the turn to settle", settled);
      });
      assert.equal(run.exit.status, 0, run.stderr.slice(-3000));
      assert.ok(run.stderr.includes("a session recovery request from an earlier run was discarded unread"), run.stderr.slice(-2000));
      assert.equal(existsSync(join(fx.runtimeDir, RECOVERY_REQUEST_FILE)), false, "the stale request was left for the next run");
      assert.equal([...run.stderr.matchAll(/\[kiln\] agent started/g)].length, 1, "the stale request started a second agent");
      assert.doesNotMatch(run.stderr, new RegExp(RECOVERED));
      assert.equal(fx.transcripts().length, 1);
    });
  } finally {
    await fx.close();
  }
});
