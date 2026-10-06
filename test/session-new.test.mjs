/**
 * The operator's `/new`, through the real launcher and supervisor - #178.
 *
 * Left to Pi, `/new` opens a session the project's record does not name. On a first run that orphaned a transcript,
 * and on a resumed run the session guard stopped Pi. Kiln now cancels Pi's own switch and has the supervisor record
 * a new session and start Pi on it. This file drives `start-kiln.mjs --rpc`, sends Pi's `new_session` command, and
 * reads the outcome from the session record, the transcripts on disk, the supervisor's notices and what the
 * provider was sent.
 *
 * ⚠️ **THE GUARD IS NOT LOOSENED TO MAKE THIS PASS.** The resumed run below is a guarded run, and the launch after
 * it is guarded again on the session `/new` produced.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { kilnProject } from "./helpers/kiln-launch.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";
import { textOf } from "./helpers/pi-session.mjs";
import { bundleDigest, journalLocation, writeJournal } from "../lib/decision-bundle-journal.mjs";
import { RECOVERY_REQUEST_FILE } from "../lib/recovery-request.mjs";
import { CARRYOVER_FILE } from "../lib/workflow-carryover.mjs";

const settled = (event) => event.type === "agent_settled";
const frame = (request) => request.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
const conversation = (request) => request.messages.filter((m) => m.role !== "system" && m.role !== "developer").map((m) => textOf(m.content)).join("\n");
const RECOVERED = "\\[kiln\\] session (\\S+) \\(new, recorded; recovery: ([a-z-]+)\\)";
/**
 * One line for every time the supervisor starts Pi: the session it starts it on. Said on every platform, which the
 * Windows job's own "agent started" notice is not.
 */
const AGENT_START = "\\[kiln\\] session [0-9a-f-]{36} \\(";
/** Said once for each browser launcher the supervisor brings up, on every platform. */
const LAUNCHER_READY = "\\[kiln\\] ready — identity confirmed";
const GUARD_STOP ="Pi did not open the session Kiln recorded";
const count = (text, pattern) => [...text.matchAll(new RegExp(pattern, "g"))].length;

/** One turn in whichever agent is running, and the request the provider received for it. */
async function turn(fx, io, id, message, reply = null) {
  const before = fx.provider.requests.length;
  const settledSoFar = io.events().filter(settled).length;
  if (reply) fx.provider.script.push({ text: reply });
  io.send({ id, type: "prompt", message });
  await io.waitFor(`turn ${id} to settle`, settled, { count: settledSoFar + 1, timeoutMs: 120_000 });
  return fx.provider.requests[before];
}

/** Pi's `new_session`, and the session the supervisor recorded in answer to it. */
async function newSession(fx, io, id, nth) {
  io.send({ id, type: "new_session" });
  const recovered = await io.said(RECOVERED, { count: nth });
  assert.equal(recovered[2], "operator-new-session");
  // ⚠️ RECORDED BEFORE IT IS USABLE: the record names the new session before any turn has run in it.
  assert.equal(fx.pointer().sessionId, recovered[1], "the supervisor announced a session the record does not name");
  return recovered[1];
}

test("⚠️ #178 /new on a first run starts a recorded session, leaves no orphan transcript, and is not limited to once", { timeout: 12 * 60_000 }, async () => {
  const fx = await kilnProject({ label: "#178 /new on a first run" });
  try {
    await withBuildLock(async () => {
      const ids = [];
      const run = await fx.launch(async (io) => {
        await turn(fx, io, "a", "FIRST-SESSION what do you suggest?", "PROPOSAL-ALPHA Shall I record CSV export as the decision?");
        ids.push(fx.pointer().sessionId);

        ids.push(await newSession(fx, io, "n1", 1));
        const second = await turn(fx, io, "b", "SECOND-SESSION go on", "PROPOSAL-BETA Or should it be JSON?");
        assert.ok(second && conversation(second).includes("SECOND-SESSION go on"));
        assert.ok(!conversation(second).includes("FIRST-SESSION"), "the new session was sent the old conversation");
        // ⚠️ THE OPEN PROPOSAL IS CARRIED, AS PENDING.
        assert.ok(frame(second).includes("Kiln session carry-over (operator-new-session):"), frame(second).slice(-1500));
        assert.ok(frame(second).includes("PROPOSAL-ALPHA Shall I record CSV export as the decision?"));
        assert.ok(frame(second).includes("that is STILL PENDING: the operator has not answered it and has not approved it."));

        // ⚠️ THE OPERATOR'S OWN REQUEST IS NOT COUNTED AGAINST THE ONE AUTOMATIC RECOVERY: a second `/new` works.
        ids.push(await newSession(fx, io, "n2", 2));
        const third = await turn(fx, io, "c", "THIRD-SESSION and now?");
        assert.ok(frame(third).includes("PROPOSAL-BETA Or should it be JSON?"), "the second session's proposal was not carried");
        assert.ok(!frame(third).includes("PROPOSAL-ALPHA"), "a proposal two sessions old was carried");
      });

      assert.equal(run.exit.status, 0, run.stderr.slice(-3000));
      assert.equal(new Set(ids).size, 3);
      assert.equal(count(run.stderr, RECOVERED), 2);
      assert.equal(count(run.stderr, AGENT_START), 3, "Pi was started other than three times");
      assert.equal(count(run.stderr, LAUNCHER_READY), 1, "the browser launcher was restarted");
      assert.ok(!run.stderr.includes("this launch has already recovered once"), "an operator's /new was counted as an automatic recovery");
      assert.ok(!run.stderr.includes(GUARD_STOP));
      assert.equal(run.stdout.split("\n").filter((line) => line.trim() && !line.trim().startsWith("{")).length, 0, "the protocol stream was corrupted across a relaunch");

      // ⚠️ NO ORPHAN: every transcript on disk is a session the supervisor recorded, and the first is still there.
      assert.deepEqual(fx.transcripts().map((t) => t.id).sort(), [...ids].sort(), "a transcript exists that the supervisor never recorded, or one was removed");
      assert.equal(fx.pointer().sessionId, ids[2]);
      assert.equal(existsSync(join(fx.runtimeDir, RECOVERY_REQUEST_FILE)), false);
    });
  } finally {
    await fx.close();
  }
});

test("⚠️ #178 /new on a resumed, guarded run starts a recorded session, and the next launch resumes that one under the guard", { timeout: 12 * 60_000 }, async () => {
  const fx = await kilnProject({ label: "#178 /new on a resumed run" });
  try {
    await withBuildLock(async () => {
      const first = await fx.launch(async (io) => {
        await turn(fx, io, "a", "FIRST-SESSION what do you suggest?", "PROPOSAL-GAMMA Shall I split the requirement in two?");
      });
      assert.equal(first.exit.status, 0, first.stderr.slice(-3000));
      const original = fx.pointer().sessionId;

      let replaced = null;
      const resumed = await fx.launch(async (io) => {
        // A resumed run: the guard is installed and expects exactly the recorded session.
        await io.said(`\\[kiln\\] session ${original} \\(resumed from the record\\)`);
        replaced = await newSession(fx, io, "n1", 1);
        assert.notEqual(replaced, original);
        const next = await turn(fx, io, "b", "SECOND-SESSION go on");
        assert.ok(!conversation(next).includes("FIRST-SESSION"), "the new session was sent the resumed conversation");
        // The proposal came from the resumed transcript, which this run never added to.
        assert.ok(frame(next).includes("PROPOSAL-GAMMA Shall I split the requirement in two?"), frame(next).slice(-1500));
      });
      assert.equal(resumed.exit.status, 0, resumed.stderr.slice(-3000));
      assert.ok(!resumed.stderr.includes(GUARD_STOP), "the guard stopped Pi after /new");
      assert.equal(count(resumed.stderr, RECOVERED), 1);
      assert.equal(count(resumed.stderr, AGENT_START), 2, "Pi was started other than twice");
      assert.equal(count(resumed.stderr, LAUNCHER_READY), 1);
      assert.deepEqual(fx.transcripts().map((t) => t.id).sort(), [original, replaced].sort(), "a transcript exists that the supervisor never recorded, or one was removed");
      assert.equal(fx.pointer().sessionId, replaced);

      // ⚠️ THE GUARD STILL GUARDS. The next launch resumes the session `/new` produced. That session has already
      // answered once, so the carry-over is in its own conversation and its record went with that answer.
      assert.equal(existsSync(join(fx.runtimeDir, CARRYOVER_FILE)), false, "the carry-over outlived the session's first answer");
      const before = fx.provider.requests.length;
      const later = await fx.launch(async (io) => {
        await turn(fx, io, "c", "THIRD-LAUNCH hello");
      });
      assert.equal(later.exit.status, 0, later.stderr.slice(-3000));
      assert.ok(later.stderr.includes(`[kiln] session ${replaced} (resumed from the record)`), later.stderr.slice(-2000));
      assert.ok(!later.stderr.includes(GUARD_STOP));
      assert.ok(conversation(fx.provider.requests[before]).includes("SECOND-SESSION go on"));
      assert.ok(!frame(fx.provider.requests[before]).includes("Kiln session carry-over"));
      assert.equal(fx.transcripts().length, 2);
      assert.equal(existsSync(join(fx.runtimeDir, CARRYOVER_FILE)), false, "the carry-over outlived the session's first answer");
    });
  } finally {
    await fx.close();
  }
});

/**
 * A decision bundle that ran to completion, as its journal records it. Written with the journal's own writer and
 * digest, because driving the Stage 4 tool to completion needs a project at Stage 4.
 */
async function completedBundle(fx) {
  const stage = "04-requirement-gaps";
  const ids = { question: "QST-0001", decision: "DEC-0001" };
  const operations = [
    { kind: "create-question", target: "QST-0001", args: {}, status: "completed" },
    { kind: "create-decision", target: "DEC-0001", args: {}, status: "completed" },
    { kind: "resolve-question", target: "QST-0001", args: {}, status: "completed" },
    { kind: "approve-decision", target: "DEC-0001", args: {}, status: "completed" },
  ];
  const journal = { recordVersion: 1, stage, digest: bundleDigest({ stage, ids, operations }), status: "completed", authorizedAt: "2026-10-06T12:00:00.000Z", ids, targets: { "QST-0001": null, "DEC-0001": null }, operations };
  await writeJournal(journalLocation({ projectRoot: fx.dir }), journal);
}

/**
 * ⚠️ **A RECORDED SESSION PI HAS NOT WRITTEN YET.** Pi writes no transcript until a session has an assistant message,
 * so a replacement session closed before its first turn is a recorded id with no file. The next launch starts that
 * same id, unguarded, because the supervisor's bound carry-over names it. Every other missing transcript is still a
 * question; `test/shutdown-and-session.test.mjs` holds those cases.
 */
test("⚠️ #178 a replacement session closed before its first turn keeps the pending proposal and the last operation", { timeout: 12 * 60_000 }, async (t) => {
  const fx = await kilnProject({ label: "#178 carry-over across a restart" });
  try {
    await withBuildLock(async () => {
      await completedBundle(fx);
      let replaced = null;

      await t.test("the carry-over is bound to the replacement session and is still there when the launch has ended", async () => {
        const first = await fx.launch(async (io) => {
          await turn(fx, io, "a", "FIRST-SESSION what do you suggest?", "PROPOSAL-OMEGA Shall I approve the revised requirement?");
          replaced = await newSession(fx, io, "n1", 1);
          // ⚠️ NO TURN IN THE REPLACEMENT. The launch ends here, with the proposal unanswered.
        });
        assert.equal(first.exit.status, 0, first.stderr.slice(-3000));
        assert.equal(fx.pointer().sessionId, replaced);
        const kept = JSON.parse(readFileSync(join(fx.runtimeDir, CARRYOVER_FILE), "utf-8"));
        assert.equal(kept.sessionId, replaced, "the carry-over is not bound to the replacement session");
        assert.equal(kept.pending.text, "PROPOSAL-OMEGA Shall I approve the revised requirement?");
        assert.deepEqual(kept.lastOperation, { index: 3, kind: "approve-decision", target: "DEC-0001", status: "completed" });
      });

      await t.test("another launch starts that recorded session and tells it both", async () => {
        // ⚠️ ANOTHER LAUNCH, ANOTHER SUPERVISOR RUN, THE SAME RECORDED SESSION.
        const later = await fx.launch(async (io) => {
          await io.said(`\\[kiln\\] session ${replaced} \\(recorded, starting its first turn\\)`, { timeoutMs: 30_000 });
          const resumed = await turn(fx, io, "b", "SECOND-LAUNCH where were we?");
          assert.ok(!conversation(resumed).includes("FIRST-SESSION"));
          assert.ok(frame(resumed).includes("Kiln session carry-over (operator-new-session):"), frame(resumed).slice(-1500));
          assert.ok(frame(resumed).includes("PROPOSAL-OMEGA Shall I approve the revised requirement?"), "the pending proposal did not survive the restart");
          assert.ok(frame(resumed).includes("that is STILL PENDING: the operator has not answered it and has not approved it."));
          assert.ok(frame(resumed).includes("Last completed bundle operation: 4. approve-decision DEC-0001 (completed)."), "the last completed operation did not survive the restart");

          // ⚠️ REMOVED AT THE FIRST COMPLETED ANSWER, not at the next turn: from here a missing transcript is a question again.
          assert.equal(existsSync(join(fx.runtimeDir, CARRYOVER_FILE)), false, "the carry-over outlived the session's first answer");
          const next = await turn(fx, io, "c", "And then?");
          assert.ok(!frame(next).includes("Kiln session carry-over"));
        });
        assert.equal(later.exit.status, 0, later.stderr.slice(-3000));
        assert.ok(!later.stderr.includes(GUARD_STOP));
        assert.equal(fx.pointer().sessionId, replaced, "the relaunch did not use the recorded replacement session");
        assert.equal(count(later.stderr, RECOVERED), 0);
        assert.equal(existsSync(join(fx.runtimeDir, CARRYOVER_FILE)), false);
      });

      // One transcript for each recorded session, and the first is where it was.
      assert.equal(fx.transcripts().length, 2);
      assert.ok(fx.transcripts().some((t) => t.id === replaced));

      // ⚠️ AND THE NEXT LAUNCH IS AN ORDINARY GUARDED RESUME of that session, now that Pi has written it.
      const third = await fx.launch(async (io) => {
        await turn(fx, io, "d", "THIRD-LAUNCH hello");
      });
      assert.equal(third.exit.status, 0, third.stderr.slice(-3000));
      assert.ok(third.stderr.includes(`[kiln] session ${replaced} (resumed from the record)`), third.stderr.slice(-2000));
    });
  } finally {
    await fx.close();
  }
});

test("⚠️ #178 an operator's /new leaves the one automatic recovery available, and a second automatic one still stops the launch", { timeout: 12 * 60_000 }, async () => {
  const WINDOW = 128_000;
  const LIMIT_CHARS = 300_000;
  const huge = (tag) => `${tag}-START ${"x".repeat(LIMIT_CHARS + 120_000)} ${tag}-END`;
  const fx = await kilnProject({ contextWindow: WINDOW, label: "#178 /new then automatic recovery" });
  try {
    fx.provider.limit.chars = LIMIT_CHARS;
    fx.provider.limit.tokens = WINDOW;
    await withBuildLock(async () => {
      const run = await fx.launch(async (io) => {
        await turn(fx, io, "a", "FIRST-SESSION an ordinary question");
        const afterNew = await newSession(fx, io, "n1", 1);

        // ⚠️ THE FIRST FAILURE AFTER `/new` IS STILL RECOVERED: the operator's request used none of the allowance.
        io.send({ id: "b", type: "prompt", message: huge("HUGE-ONE") });
        const automatic = await io.said(RECOVERED, { count: 2 });
        assert.equal(automatic[2], "input-exceeds-context-window");
        assert.notEqual(automatic[1], afterNew);
        assert.equal(fx.pointer().sessionId, automatic[1]);
        const usable = await turn(fx, io, "c", "THIRD-SESSION are you there?");
        assert.ok(usable && !usable.refused && !conversation(usable).includes("HUGE-ONE"));
        assert.ok(frame(usable).includes("Kiln session carry-over (input-exceeds-context-window):"));

        // ⚠️ AND THE SECOND AUTOMATIC ONE IS NOT.
        io.send({ id: "d", type: "prompt", message: huge("HUGE-TWO") });
        await io.said("this launch has already recovered once, so it stops here");
      });
      assert.equal(run.exit.signal, null, run.stderr.slice(-3000));
      assert.deepEqual([...run.stderr.matchAll(new RegExp(RECOVERED, "g"))].map((m) => m[2]), ["operator-new-session", "input-exceeds-context-window"]);
      assert.equal(count(run.stderr, AGENT_START), 3, "Pi was started other than three times");
      assert.equal(count(run.stderr, LAUNCHER_READY), 1);
      assert.equal(fx.transcripts().length, 3);
    });
  } finally {
    await fx.close();
  }
});
