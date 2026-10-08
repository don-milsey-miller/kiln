/**
 * The session chooser in a real terminal, through `start-kiln.mjs` and the real supervisor - #182.
 *
 * `test/session-chooser.test.mjs` holds every state of the record and the storage against the chooser's own
 * functions. This file sets up a real project, runs one real session, and then starts Kiln in a pseudo-terminal
 * the way an operator does: what is on the screen is read back, an answer is typed, and what Pi was then started
 * on is read from the provider's requests and the project's session record.
 *
 * ⚠️ **THE STORED SESSIONS BESIDE THE REAL ONE ARE WRITTEN BY THE TEST**, in the pinned Pi's current format and
 * then broken in one way each: a line that is not JSON, and an older format. Pi lists both, and can resume neither.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { kilnProject } from "./helpers/kiln-launch.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";
import { startPty } from "./helpers/pty.mjs";
import { textOf } from "./helpers/pi-session.mjs";

const ROOT = join(import.meta.dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settled = (event) => event.type === "agent_settled";
const CORRUPT = "c0ffee00-1111-4111-8111-111111111111";
const INCOMPATIBLE = "0ddba115-2222-4222-8222-222222222222";
const conversation = (request) => request.messages.filter((m) => m.role !== "system" && m.role !== "developer").map((m) => textOf(m.content)).join("\n");

/** A project with one real session in it, and what is needed to rearrange its storage. */
async function withOneSession(label, run) {
  const fx = await kilnProject({ label });
  try {
    await withBuildLock(async () => {
      fx.provider.script.push({ text: "FIRST-ANSWER" });
      const first = await fx.launch(async (io) => {
        io.send({ id: "a", type: "prompt", message: "FIRST-QUESTION about the plan" });
        await io.waitFor("the first turn to settle", settled);
      });
      assert.equal(first.exit.status, 0, first.stderr.slice(-2000));
      const sessions = join(fx.dir, ".pi", "sessions");
      const name = readdirSync(sessions).find((n) => n.endsWith(".jsonl"));
      const transcript = join(sessions, name);
      const lines = readFileSync(transcript, "utf-8").split("\n");
      const header = JSON.parse(lines[0]);
      const record = join(fx.runtimeDir, "kiln-session.json");
      /** Another stored session of this project, valid except for what `change` does to it. */
      const store = (id, day, change) => {
        const at = `2026-09-${day}T10:00:00.000Z`;
        const own = [JSON.stringify({ ...header, id, timestamp: at }), ...lines.slice(1)];
        // The file's name carries a uuid of its own, which is not the session's id and must never be shown.
        writeFileSync(join(sessions, `2026-09-${day}T10-00-00-000Z_f11e0000-0000-4000-8000-0000000000${day}.jsonl`), change(own).join("\n"));
      };
      await run({ fx, sessions, transcript, header, record, store, recorded: () => JSON.parse(readFileSync(record, "utf-8")) });
    });
  } finally {
    await fx.close();
  }
}

/** Kiln in a terminal. `screen()` is what has been printed, as text. */
function terminal(fx) {
  const pty = startPty(join(ROOT, "bin", "start-kiln.mjs"), [], { cwd: fx.dir, env: fx.env, cols: 160, rows: 45 });
  const screen = () => stripVTControlCharacters(pty.output());
  return {
    pty,
    screen,
    lines: () => screen().split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0),
    /** Ask Kiln to stop as an operator does, and wait for the whole run to end. */
    async stop() {
      for (let attempt = 0; attempt < 3 && !pty.exit(); attempt++) {
        pty.write("\u0003");
        await Promise.race([pty.exited(), sleep(15_000)]);
      }
      const ended = pty.exit() !== null;
      // Only a run that would not end is killed: killing a terminal that has closed makes node-pty report on a
      // console that is gone.
      if (!ended) pty.kill();
      return ended;
    },
  };
}
const until = async (what, probe, ms = 120_000) => {
  for (const started = Date.now(); Date.now() - started < ms; await sleep(100)) if (await probe()) return;
  assert.fail(`timed out waiting for ${what}`);
};

test("⚠️ #182 a valid session beside a corrupt and an incompatible one: only it has a number, and choosing it resumes it", { timeout: 15 * 60_000 }, async () => {
  await withOneSession("#182 chooser, mixed store", async ({ fx, header, record, store, recorded, sessions }) => {
    store(CORRUPT, "11", (own) => [own[0], "{ this line is not JSON", ...own.slice(1)]);
    store(INCOMPATIBLE, "12", (own) => [JSON.stringify({ ...JSON.parse(own[0]), version: header.version - 1 }), ...own.slice(1)]);
    writeFileSync(record, "{ not json");

    const t = terminal(fx);
    try {
      await t.pty.waitFor(/Which session should this run continue\?/, 180_000);
      const shown = t.lines();
      const at = shown.findIndex((line) => line.includes("session record cannot be read"));
      assert.deepEqual(
        shown.slice(at, at + 6).map((line) => line.replace(/^\[kiln\] /, "").replace(/\d{4}-\d\d-\d\d \d\d:\d\d UTC/g, "<time>").replace(/\d+ messages?/, "<n> messages")),
        [
          "This project's session record cannot be read, so it does not say which session to resume. Choosing here replaces it.",
          "2 stored sessions cannot be resumed:",
          `  - ${INCOMPATIBLE.slice(0, 8)} | modified <time> | incompatible`,
          `  - ${CORRUPT.slice(0, 8)} | modified <time> | corrupt`,
          "1 session can be resumed:",
          `  1. ${header.id.slice(0, 8)} | (unnamed) | created <time> | modified <time> | <n> messages | unrecorded`,
        ]
      );
      assert.ok(shown.some((line) => line.includes("Which session should this run continue? (1 to resume it, n for a new session, q to cancel)")));
      // ⚠️ NOTHING OF THE FILES THEMSELVES: no path, no file-name uuid, no whole id, no message text, no parser's words.
      const text = shown.slice(at).join("\n");
      for (const absent of [sessions, ".jsonl", "f11e0000", header.id, CORRUPT, INCOMPATIBLE, "FIRST-QUESTION", "FIRST-ANSWER", "not JSON", "Unexpected token"])
        assert.ok(!text.includes(absent), `the chooser shows ${absent}`);

      // The one numbered row is chosen, and Pi is started on that session.
      const requestsBefore = fx.provider.requests.length;
      t.pty.write("1\r");
      await until("the chosen session to be recorded", () => existsSync(record) && readFileSync(record, "utf-8").includes(header.id));
      assert.equal(recorded().sessionId, header.id);
      // ⚠️ SAID AS WHAT IT IS: a session the operator picked is a resume, and is not called new.
      await t.pty.waitFor(/\[kiln\] session \S+ \(/, 120_000);
      assert.ok(t.screen().includes(`[kiln] session ${header.id} (resumed by operator choice)`), t.lines().filter((line) => line.includes("[kiln] session ")).join(" / "));
      assert.ok(!t.screen().includes("(new, recorded)"));
      await sleep(4_000);
      t.pty.write("SECOND-QUESTION after choosing\r");
      await until("the resumed session's turn to reach the provider", () => fx.provider.requests.length > requestsBefore, 120_000);
      const resumed = conversation(fx.provider.requests[requestsBefore]);
      assert.ok(resumed.includes("FIRST-QUESTION about the plan") && resumed.includes("SECOND-QUESTION after choosing"), "Pi was not started on the chosen session");
      assert.ok(!t.screen().includes("Pi did not open the session Kiln recorded"), "the guard stopped the chosen session");
    } finally {
      await t.stop();
    }
    // The two that cannot be resumed are exactly where they were, and no further transcript appeared.
    assert.equal(readdirSync(sessions).filter((n) => n.endsWith(".jsonl")).length, 3);
  });
});

test("⚠️ #182 with nothing that can be resumed, the question is only whether to start a new session", { timeout: 15 * 60_000 }, async () => {
  await withOneSession("#182 chooser, nothing resumable", async ({ fx, transcript, header, store, recorded, sessions }) => {
    // The recorded session's transcript is gone, and what is left cannot be resumed.
    mkdirSync(join(fx.dir, "moved-away"));
    renameSync(transcript, join(fx.dir, "moved-away", "transcript.jsonl"));
    store(CORRUPT, "11", (own) => [own[0], "{ this line is not JSON", ...own.slice(1)]);

    const t = terminal(fx);
    try {
      await t.pty.waitFor(/Start a new session, or cancel\?/, 180_000);
      const shown = t.lines();
      const at = shown.findIndex((line) => line.includes("The session this project recorded"));
      assert.deepEqual(
        shown.slice(at, at + 5).map((line) => line.replace(/^\[kiln\] /, "").replace(/\d{4}-\d\d-\d\d \d\d:\d\d UTC/g, "<time>")),
        [
          `The session this project recorded (${header.id.slice(0, 8)}) is not in its session storage.`,
          "1 stored session cannot be resumed:",
          `  - ${CORRUPT.slice(0, 8)} | modified <time> | corrupt`,
          "No session can be resumed.",
          "Start a new session, or cancel? (n for a new session, q to cancel)",
        ]
      );
      // ⚠️ NEVER "WHICH SESSION" WITH NOTHING TO CHOOSE FROM.
      assert.ok(!t.screen().includes("Which session"));
      assert.ok(!t.screen().includes("of this project's"));

      // An empty answer is not consent to anything.
      t.pty.write("\r");
      await Promise.race([t.pty.exited(), sleep(30_000)]);
      assert.ok(t.pty.exit(), "an empty answer did not end the run");
      assert.ok(t.screen().includes("No session was chosen, so nothing was started."));
      assert.equal(recorded().sessionId, header.id, "an empty answer changed the record");
    } finally {
      await t.stop();
    }

    // Asked again, `n` starts a new session, and the record names it.
    const again = terminal(fx);
    try {
      await again.pty.waitFor(/Start a new session, or cancel\?/, 180_000);
      again.pty.write("n\r");
      await until("a new session to be recorded", () => recorded().sessionId !== header.id);
      assert.notEqual(recorded().sessionId, CORRUPT);
      await again.pty.waitFor(/\[kiln\] session \S+ \(new, recorded\)/, 120_000);
    } finally {
      await again.stop();
    }
    assert.ok(existsSync(join(sessions, readdirSync(sessions).find((n) => n.includes("f11e0000")))), "the corrupt transcript was removed");
  });
});

test("⚠️ #182 Windows: a session stored under the other case of the drive letter is this project's, and is resumed", { timeout: 15 * 60_000, skip: process.platform !== "win32" && "a drive letter's case is a Windows spelling" }, async () => {
  await withOneSession("#182 drive-letter case", async ({ fx, transcript, header, recorded }) => {
    const lines = readFileSync(transcript, "utf-8").split("\n");
    const flipped = header.cwd[0] === header.cwd[0].toUpperCase() ? header.cwd[0].toLowerCase() + header.cwd.slice(1) : header.cwd[0].toUpperCase() + header.cwd.slice(1);
    assert.notEqual(flipped, header.cwd);
    writeFileSync(transcript, [JSON.stringify({ ...header, cwd: flipped }), ...lines.slice(1)].join("\n"));

    // ⚠️ NO CHOOSER AT ALL: the record names this session, and it is this project's however its directory is spelled.
    const before = fx.provider.requests.length;
    const run = await fx.launch(async (io) => {
      io.send({ id: "b", type: "prompt", message: "SECOND-QUESTION after the respelling" });
      await io.waitFor("the resumed turn to settle", settled);
    });
    assert.equal(run.exit.status, 0, run.stderr.slice(-3000));
    assert.ok(run.stderr.includes(`[kiln] session ${header.id} (resumed from the record)`), run.stderr.slice(-2000));
    // Pi, asked by id, would have taken it for another project's and offered to fork it.
    for (const absent of ["Session found in different project", "Fork this session", "Pi did not open the session Kiln recorded", "could not be resumed"]) assert.ok(!run.stderr.includes(absent) && !run.stdout.includes(absent), absent);
    const resumed = conversation(fx.provider.requests[before]);
    assert.ok(resumed.includes("FIRST-QUESTION about the plan") && resumed.includes("SECOND-QUESTION after the respelling"));
    assert.equal(recorded().sessionId, header.id);
    assert.equal(fx.transcripts().length, 1, "the session was forked or replaced, not resumed");
  });
});
