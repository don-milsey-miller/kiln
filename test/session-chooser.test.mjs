/**
 * Which stored sessions can be chosen, and what the chooser says - #182.
 *
 * The chooser used to number every session Pi listed, including ones Pi could not open unchanged, and with none
 * listed it still asked "Which session". It never said why the recorded session was unavailable. This file holds
 * the replacement against the pinned Pi's own lister and transcripts in its current format: which sessions are
 * this project's, which of those can be resumed, what each of the others is reported as, what is printed, how
 * much of it, and that choosing a session Pi cannot open leaves the record exactly as it was.
 *
 * `test/session-chooser-pty.test.mjs` runs the same chooser in a terminal through the real supervisor.
 *
 * ⚠️ **NOTHING HERE COMES FROM A FILE'S NAME.** Every transcript is stored under a name whose uuid is not its
 * session's id, and each test that prints anything checks the name's uuid is not in it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePinnedSessionLister } from "../lib/pi-runtime.mjs";
import {
  DIAGNOSTIC_ROWS_MAX,
  MAX_INVALID_ANSWERS,
  RECOVERY,
  SESSION,
  SESSION_PROBLEM,
  SESSION_RECORD,
  SESSION_ROWS_MAX,
  SESSION_STATUS,
  TRANSCRIPT_PROBLEM,
  availableSessions,
  chooseSession,
  classifySessions,
  inspectTranscript,
  planSession,
  recordSession,
  recordedProblemLine,
  renderUnresumable,
  sessionPrecondition,
  sessionStatusOf,
  shownSessionIds,
} from "../lib/session-record.mjs";
import { withSessionPolicy } from "../lib/supervisor.mjs";

const ROOT = join(import.meta.dirname, "..");
const lister = await resolvePinnedSessionLister(ROOT);
const VERSION = lister.sessionVersion;
const PROJECT_ID = "abcdef0123456789abcdef0123456789";
/** A session id whose first eight characters are `prefix`. */
const ID = (prefix, rest = "0000-4000-8000-000000000000") => `${prefix}-${rest}`;
const FILE_UUID = "f11e0000";
const SECRET_TEXT = "MESSAGE-TEXT-THAT-MUST-NOT-BE-SHOWN";

let serial = 0;
/** A state root, a project directory, and a way to store transcripts in the pinned Pi's format. */
function fixture({ record } = {}) {
  const base = mkdtempSync(join(tmpdir(), "kiln-chooser-"));
  const root = join(base, "state");
  const project = join(base, "project");
  const sessions = join(root, "sessions");
  for (const dir of [join(root, "runtime"), sessions, project]) mkdirSync(dir, { recursive: true });
  const recordPath = join(root, SESSION_RECORD);
  if (record !== undefined) writeFileSync(recordPath, typeof record === "string" ? record : JSON.stringify(record));
  const common = { stateRoot: root, projectId: PROJECT_ID, stateMode: "project", projectRoot: project, lister };
  return {
    base,
    root,
    project,
    sessions,
    recordPath,
    common,
    /**
     * One transcript. `day` orders them (a later day is newer). The rest break it in one way each.
     * @returns {string} the path it was written to
     */
    store(id, { day = 1, cwd = project, version = VERSION, header = true, garbage = false, unterminated = false, empty = false, noMessage = false, noThinkingLevel = false, headerId = id } = {}) {
      const at = new Date(Date.UTC(2026, 8, day, 10, 0, 0)).toISOString();
      const lines = [];
      if (header) lines.push(JSON.stringify({ type: "session", version, id: headerId, timestamp: at, cwd }));
      lines.push(JSON.stringify({ type: "model_change", id: "e1", parentId: null, timestamp: at, provider: "p", modelId: "m" }));
      if (!noThinkingLevel) lines.push(JSON.stringify({ type: "thinking_level_change", id: "e2", parentId: "e1", timestamp: at, thinkingLevel: "off" }));
      if (!noMessage) lines.push(JSON.stringify({ type: "message", id: "e3", parentId: noThinkingLevel ? "e1" : "e2", timestamp: at, message: { role: "user", content: [{ type: "text", text: SECRET_TEXT }], timestamp: Date.parse(at) } }));
      if (garbage) lines.splice(2, 0, "{ this line is not JSON");
      const path = join(sessions, `2026-09-${String(day).padStart(2, "0")}T10-00-00-000Z_${FILE_UUID}-0000-4000-8000-${String(++serial).padStart(12, "0")}.jsonl`);
      writeFileSync(path, empty ? "" : lines.join("\n") + (unterminated ? "" : "\n"));
      return path;
    },
    plan: () => planSession(common),
    recordBytes: () => (existsSync(recordPath) ? readFileSync(recordPath, "utf-8") : null),
    remove: () => rmSync(base, { recursive: true, force: true }),
  };
}
const valid = (sessionId, over = {}) => ({ recordVersion: 1, projectId: PROJECT_ID, sessionId, stateMode: "project", ...over });
/** Run the chooser on a plan, answering with `answers` in turn. */
async function choose(plan, answers = ["q"]) {
  const printed = [];
  const asked = [];
  const queue = [...answers];
  const choice = await chooseSession({ choices: plan.choices, problem: recordedProblemLine(plan), print: (line) => printed.push(line), ask: async (question) => (asked.push(question), queue.length ? queue.shift() : null) });
  return { choice, printed, asked, text: [...printed, ...asked].join("\n") };
}
const stamped = (line) => line.replace(/\d{4}-\d\d-\d\d \d\d:\d\d UTC/g, "<time>");

/* ------------------------------------------------------------------ which sessions, and what each is */

test("⚠️ #182 a mixed store: only inspected sessions can be chosen, and every other one is reported as one of three statuses", async () => {
  const f = fixture();
  try {
    f.store(ID("600d0001"), { day: 20 });
    f.store(ID("600d0002"), { day: 19 });
    f.store(ID("01d00001"), { day: 18, version: VERSION - 1 });
    f.store(ID("bad00001"), { day: 17, garbage: true });
    f.store(ID("bad00002"), { day: 16, unterminated: true });
    f.store(ID("01d00002"), { day: 15, noMessage: true });
    f.store(ID("01d00003"), { day: 14, noThinkingLevel: true });
    // Pi cannot identify these two: nothing is known of them but that they are there.
    f.store(ID("nohead01"), { day: 13, header: false });
    f.store(ID("empty001"), { day: 12, empty: true });
    // And these belong to another directory.
    f.store(ID("e15e0001"), { day: 11, cwd: join(f.base, "another-project") });
    f.store(ID("e15e0002"), { day: 10, cwd: join(f.base, "a-third") });

    const plan = await f.plan();
    assert.deepEqual([plan.action, plan.problem, plan.recoverable, plan.recordedId], [SESSION.ASK, SESSION_PROBLEM.MISSING, true, null]);
    assert.deepEqual(plan.choices.selectable.map((s) => s.id), [ID("600d0001"), ID("600d0002")]);
    assert.deepEqual(plan.choices.unresumable.map((s) => [s.id.slice(0, 8), s.status]), [
      ["01d00001", "incompatible"],
      ["bad00001", "corrupt"],
      ["bad00002", "corrupt"],
      ["01d00002", "incompatible"],
      ["01d00003", "incompatible"],
    ]);
    assert.deepEqual([plan.choices.unidentified, plan.choices.elsewhere], [2, 2]);
    // An unresumable entry carries an id, a time and a status, and no path to anything.
    for (const entry of plan.choices.unresumable) assert.deepEqual(Object.keys(entry), ["id", "modifiedMs", "status"]);
    // ⚠️ THE RACE PRECONDITION IS OVER EVERY SESSION OF THIS PROJECT, resumable or not, and none of another's.
    assert.equal(sessionPrecondition(f.root, plan.available).sessions.length, 7);

    const { printed, asked, text } = await choose(plan);
    assert.deepEqual(printed.map(stamped), [
      "This project has no session record, so none of its stored sessions is the recorded one.",
      "5 stored sessions cannot be resumed:",
      "  - 01d00001 | modified <time> | incompatible",
      "  - bad00001 | modified <time> | corrupt",
      "  - bad00002 | modified <time> | corrupt",
      "  - 01d00002 | modified <time> | incompatible",
      "  - 01d00003 | modified <time> | incompatible",
      "2 transcript files in the session storage could not be identified.",
      "2 stored sessions belong to a different directory.",
      "2 sessions can be resumed:",
      "  1. 600d0001 | (unnamed) | created <time> | modified <time> | 1 message | unrecorded",
      "  2. 600d0002 | (unnamed) | created <time> | modified <time> | 1 message | unrecorded",
    ]);
    assert.deepEqual(asked, ["Which session should this run continue? (1-2 to resume one, n for a new session, q to cancel) "]);
    // ⚠️ NOTHING OF THE FILES: no path, no file-name uuid, no whole id, no message text, no parser's words, and no
    // id for what Pi could not identify or what belongs elsewhere.
    for (const absent of [f.base, f.sessions, ".jsonl", FILE_UUID, ID("600d0001"), "0000-4000", SECRET_TEXT, "not JSON", "Unexpected", "unterminated", "nohead01", "empty001", "e15e0001", "of this project's"])
      assert.ok(!text.includes(absent), `the chooser shows ${absent}`);

    assert.deepEqual((await choose(plan, ["2"])).choice, { action: RECOVERY.RESUME, sessionId: ID("600d0002") });
    // A position past the numbered rows is not a choice: an unresumable session cannot be reached by counting on.
    for (const position of ["3", "7", "0"]) assert.deepEqual((await choose(plan, [position, "q"])).choice, { action: RECOVERY.CANCEL, reason: "declined" }, position);
  } finally {
    f.remove();
  }
});

test("⚠️ #182 every reason a transcript is refused is one of the three statuses, and none makes a session a choice", () => {
  const expected = {
    FORMAT_UNKNOWN: "incompatible",
    VERSION: "incompatible",
    NO_MESSAGE: "incompatible",
    NO_THINKING_LEVEL: "incompatible",
    DUPLICATE_ID: "corrupt",
    EMPTY: "corrupt",
    UNTERMINATED: "corrupt",
    MALFORMED: "corrupt",
    NO_HEADER: "corrupt",
    WRONG_SESSION: "corrupt",
    UNREADABLE: "unavailable",
  };
  // Every refusal the inspection can make is named here, so a new one cannot arrive without a status.
  assert.deepEqual(Object.keys(TRANSCRIPT_PROBLEM).sort(), Object.keys(expected).sort());
  for (const [name, status] of Object.entries(expected)) assert.equal(sessionStatusOf(TRANSCRIPT_PROBLEM[name]), status, name);
  assert.deepEqual(Object.values(SESSION_STATUS).sort(), ["corrupt", "incompatible", "unavailable"]);
  // Anything unrecognised is unavailable, never resumable.
  for (const odd of ["some new reason", undefined, null, ""]) assert.equal(sessionStatusOf(odd), "unavailable");

  const f = fixture();
  try {
    // The ones a file on disk can show, each through the real inspection.
    const paths = {
      [TRANSCRIPT_PROBLEM.VERSION]: f.store(ID("aaaa0001"), { version: VERSION - 1 }),
      [TRANSCRIPT_PROBLEM.NO_MESSAGE]: f.store(ID("aaaa0002"), { noMessage: true }),
      [TRANSCRIPT_PROBLEM.NO_THINKING_LEVEL]: f.store(ID("aaaa0003"), { noThinkingLevel: true }),
      [TRANSCRIPT_PROBLEM.EMPTY]: f.store(ID("aaaa0004"), { empty: true }),
      [TRANSCRIPT_PROBLEM.UNTERMINATED]: f.store(ID("aaaa0005"), { unterminated: true }),
      [TRANSCRIPT_PROBLEM.MALFORMED]: f.store(ID("aaaa0006"), { garbage: true }),
      [TRANSCRIPT_PROBLEM.NO_HEADER]: f.store(ID("aaaa0007"), { header: false }),
      [TRANSCRIPT_PROBLEM.WRONG_SESSION]: f.store(ID("aaaa0008"), { headerId: ID("bbbb0008") }),
      [TRANSCRIPT_PROBLEM.UNREADABLE]: join(f.sessions, "there-is-no-such-file.jsonl"),
    };
    const listed = Object.entries(paths).map(([problem, path], i) => ({ id: ID(`aaaa000${i + 1}`), path, name: null, createdMs: 0, modifiedMs: 1000 - i, messageCount: 1, problem }));
    for (const session of listed) assert.equal(inspectTranscript(session.path, { version: VERSION, sessionId: session.id }).problem, session.problem);
    const good = { id: ID("600d0001"), path: f.store(ID("600d0001")), name: null, createdMs: 0, modifiedMs: 5000, messageCount: 1 };
    const choices = classifySessions({ sessions: [good, ...listed] }, { version: VERSION });
    assert.deepEqual(choices.selectable.map((s) => s.id), [good.id]);
    assert.deepEqual(choices.unresumable.map((s) => s.status), listed.map((s) => sessionStatusOf(s.problem)));
    // With no format to compare against, nothing can be shown to be resumable.
    assert.deepEqual(classifySessions({ sessions: [good] }, {}).unresumable.map((s) => s.status), ["incompatible"]);
  } finally {
    f.remove();
  }
});

/* ------------------------------------------------------------------ what is said about the record */

test("⚠️ #182 the recorded session's problem is said once, above the lists, in fixed words", async () => {
  const cases = [
    ["no record", undefined, (f) => f.store(ID("600d0001")), SESSION_PROBLEM.MISSING, "This project has no session record, so none of its stored sessions is the recorded one."],
    ["not JSON", "{ not json", (f) => f.store(ID("600d0001")), SESSION_PROBLEM.UNREADABLE, "This project's session record cannot be read, so it does not say which session to resume. Choosing here replaces it."],
    ["fails its schema", { recordVersion: 1 }, (f) => f.store(ID("600d0001")), SESSION_PROBLEM.INVALID, "This project's session record cannot be read, so it does not say which session to resume. Choosing here replaces it."],
    ["another project's", valid(ID("600d0001"), { projectId: "0".repeat(32) }), (f) => f.store(ID("600d0001")), SESSION_PROBLEM.FOREIGN, "This project's session record was written for a different project. Choosing here replaces it."],
    ["the other state mode", valid(ID("600d0001"), { stateMode: "user" }), (f) => f.store(ID("600d0001")), SESSION_PROBLEM.MODE_CHANGED, "The session record was written under a different state mode, and names a session in the other store. Choosing here replaces it."],
    ["transcript missing", valid(ID("9099e000")), (f) => f.store(ID("600d0001")), SESSION_PROBLEM.GONE, "The session this project recorded (9099e000) is not in its session storage."],
    ["transcript in an older format", valid(ID("01d00001")), (f) => f.store(ID("01d00001"), { version: VERSION - 1 }), SESSION_PROBLEM.TRANSCRIPT_UNSUPPORTED, "The session this project recorded (01d00001) cannot be resumed: its transcript is incompatible."],
    ["transcript with a bad line", valid(ID("bad00001")), (f) => f.store(ID("bad00001"), { garbage: true }), SESSION_PROBLEM.TRANSCRIPT_UNSUPPORTED, "The session this project recorded (bad00001) cannot be resumed: its transcript is corrupt."],
  ];
  for (const [name, record, arrange, problem, line] of cases) {
    const f = fixture({ record });
    try {
      arrange(f);
      const plan = await f.plan();
      assert.deepEqual([plan.action, plan.problem], [SESSION.ASK, problem], name);
      const { printed } = await choose(plan);
      assert.equal(printed[0], line, name);
      assert.equal(printed.filter((p) => p === line).length, 1, `${name}: said more than once`);
      assert.ok(!printed.join("\n").includes(f.base), `${name}: a path is shown`);
    } finally {
      f.remove();
    }
  }
  // A plan that is not a question has nothing to say, and the recorded id is never shown whole.
  assert.equal(recordedProblemLine({ problem: SESSION_PROBLEM.NONE }), null);
  assert.ok(!recordedProblemLine({ problem: SESSION_PROBLEM.GONE, recordedId: ID("9099e000") }).includes(ID("9099e000")));
});

/* ------------------------------------------------------------------ nothing to choose from */

test("⚠️ #182 with nothing that can be resumed the prompt is two lines, and never asks which session", async () => {
  const states = [
    ["an unreadable record and nothing stored", "{ not json", () => {}],
    ["a recorded transcript that is missing", valid(ID("9099e000")), () => {}],
    ["a recorded transcript that is corrupt", valid(ID("bad00001")), (f) => f.store(ID("bad00001"), { garbage: true })],
    ["a recorded transcript Pi cannot identify", valid(ID("nohead01")), (f) => f.store(ID("nohead01"), { header: false })],
    ["a recorded transcript that belongs to another directory", valid(ID("e15e0001")), (f) => f.store(ID("e15e0001"), { cwd: join(f.base, "another-project") })],
  ];
  for (const [name, record, arrange] of states) {
    const f = fixture({ record });
    try {
      arrange(f);
      const plan = await f.plan();
      assert.deepEqual(plan.choices.selectable, [], name);
      const { printed, asked, text, choice } = await choose(plan, ["n"]);
      // ⚠️ THE LAST THING PRINTED AND THE QUESTION ARE EXACTLY THESE.
      assert.equal(printed.at(-1), "No session can be resumed.", name);
      assert.deepEqual(asked, ["Start a new session, or cancel? (n for a new session, q to cancel) "], name);
      assert.ok(!text.includes("Which session"), name);
      assert.doesNotMatch(text, /1-|to resume (?:it|one)|of this project's|can be returned/, name);
      assert.deepEqual(choice, { action: RECOVERY.NEW }, name);

      // ⚠️ THE SAFETY BEHAVIOUR IS UNCHANGED: nothing is a default, and silence is not consent.
      assert.deepEqual((await choose(plan, [""])).choice, { action: RECOVERY.CANCEL, reason: "empty" }, name);
      assert.deepEqual((await choose(plan, [])).choice, { action: RECOVERY.CANCEL, reason: "no-answer" }, name);
      assert.deepEqual((await choose(plan, ["q"])).choice, { action: RECOVERY.CANCEL, reason: "declined" }, name);
      // A number is not an answer when no row has one.
      const stubborn = await choose(plan, ["1", "1", "1", "n"]);
      assert.deepEqual([stubborn.choice, stubborn.asked.length], [{ action: RECOVERY.CANCEL, reason: "unanswered" }, MAX_INVALID_ANSWERS], name);
    } finally {
      f.remove();
    }
  }
  // And a first run, with no record and nothing stored, is not asked anything.
  const first = fixture();
  try {
    const plan = await first.plan();
    assert.deepEqual([plan.action, plan.problem, "choices" in plan], [SESSION.START, SESSION_PROBLEM.MISSING, false]);
  } finally {
    first.remove();
  }
});

test("#182 one session that can be resumed is offered as one, with no range", async () => {
  const f = fixture({ record: "{ not json" });
  try {
    f.store(ID("600d0001"));
    const { printed, asked, choice } = await choose(await f.plan(), ["1"]);
    assert.equal(printed[1], "1 session can be resumed:");
    assert.deepEqual(asked, ["Which session should this run continue? (1 to resume it, n for a new session, q to cancel) "]);
    assert.deepEqual(choice, { action: RECOVERY.RESUME, sessionId: ID("600d0001") });
  } finally {
    f.remove();
  }
});

/* ------------------------------------------------------------------ bounds */

test("⚠️ #182 ten sessions that can be resumed and five that cannot are shown, newest first, with each omission counted", async () => {
  const f = fixture();
  try {
    const good = Array.from({ length: 14 }, (_, i) => ID(`600d00${String(i).padStart(2, "0")}`));
    const bad = Array.from({ length: 8 }, (_, i) => ID(`bad000${String(i).padStart(2, "0")}`));
    // Stored oldest first, so "newest first" is not the order they were written in.
    good.forEach((id, i) => f.store(id, { day: 1 + i }));
    bad.forEach((id, i) => f.store(id, { day: 15 + i, garbage: true }));

    const plan = await f.plan();
    assert.deepEqual([plan.choices.selectable.length, plan.choices.unresumable.length], [14, 8]);
    const { printed, asked } = await choose(plan);
    assert.deepEqual([SESSION_ROWS_MAX, DIAGNOSTIC_ROWS_MAX], [10, 5]);

    const numbered = printed.filter((line) => /^ {2}\d+\. /.test(line));
    const diagnostic = printed.filter((line) => line.startsWith("  - "));
    assert.equal(numbered.length, 10);
    assert.equal(diagnostic.length, 5);
    // Newest first: the last stored of each kind leads its list.
    assert.deepEqual(numbered.map((line) => line.split(" | ")[0].trim()), Array.from({ length: 10 }, (_, i) => `${i + 1}. 600d00${String(13 - i).padStart(2, "0")}`));
    assert.deepEqual(diagnostic.map((line) => line.split(" | ")[0].trim()), Array.from({ length: 5 }, (_, i) => `- bad000${String(7 - i).padStart(2, "0")}`));
    assert.ok(printed.includes("8 stored sessions cannot be resumed:"));
    assert.ok(printed.includes("  3 more that cannot be resumed are not shown."));
    assert.ok(printed.includes("14 sessions can be resumed:"));
    assert.ok(printed.includes("  4 older sessions that can be resumed are not shown."));
    assert.deepEqual(asked, ["Which session should this run continue? (1-10 to resume one, n for a new session, q to cancel) "]);
    assert.ok(printed.length <= 1 + 1 + 5 + 1 + 1 + 10 + 1, `the chooser printed ${printed.length} lines`);

    // A position chooses among the rows shown, and only those.
    assert.deepEqual((await choose(plan, ["10"])).choice, { action: RECOVERY.RESUME, sessionId: good[4] });
    assert.deepEqual((await choose(plan, ["1"])).choice, { action: RECOVERY.RESUME, sessionId: good[13] });
    assert.deepEqual((await choose(plan, ["11", "14", "q"])).choice, { action: RECOVERY.CANCEL, reason: "declined" });
    // ⚠️ THE RACE PRECONDITION STILL COVERS ALL TWENTY-TWO, shown or not.
    assert.deepEqual(sessionPrecondition(f.root, plan.available).sessions, [...good, ...bad].sort());

    // One omitted of each is said in the singular.
    const few = { selectable: plan.choices.selectable.slice(0, 11), unresumable: plan.choices.unresumable.slice(0, 6), elsewhere: 1, unidentified: 1 };
    const said = [];
    await chooseSession({ choices: few, ask: async () => "q", print: (line) => said.push(line) });
    for (const line of ["  1 more that cannot be resumed is not shown.", "  1 older session that can be resumed is not shown.", "1 transcript file in the session storage could not be identified.", "1 stored session belongs to a different directory."])
      assert.ok(said.includes(line), line);
  } finally {
    f.remove();
  }
});

/* ------------------------------------------------------------------ the shown id */

test("⚠️ #182 the shown id is eight characters of the header's id, lengthened only where two rows would show the same", async () => {
  const f = fixture();
  try {
    const twins = [ID("abcdef12", "1111-4000-8000-000000000000"), ID("abcdef12", "2222-4000-8000-000000000000")];
    const brokenTwin = ID("abcdef12", "3333-4000-8000-000000000000");
    f.store(twins[0], { day: 5 });
    f.store(twins[1], { day: 4 });
    f.store(brokenTwin, { day: 3, garbage: true });
    f.store(ID("600d0001"), { day: 2 });

    const plan = await f.plan();
    const { printed, text } = await choose(plan);
    // ⚠️ THREE SESSIONS SHARE EIGHT CHARACTERS. Each row still says which one it is, across both lists.
    // Lengthened one character at a time, and only as far as it takes.
    assert.ok(printed.includes("  - abcdef12-3 | modified 2026-09-03 10:00 UTC | corrupt"));
    assert.deepEqual(printed.filter((line) => /^ {2}\d+\. /.test(line)).map((line) => line.split(" | ")[0]), ["  1. abcdef12-1", "  2. abcdef12-2", "  3. 600d0001"]);
    for (const whole of [...twins, brokenTwin]) assert.ok(!text.includes(whole), "a whole id is shown");
    // And a position still chooses the session on that row.
    assert.deepEqual((await choose(plan, ["2"])).choice, { action: RECOVERY.RESUME, sessionId: twins[1] });
    assert.deepEqual((await choose(plan, ["1"])).choice, { action: RECOVERY.RESUME, sessionId: twins[0] });

    assert.deepEqual([...shownSessionIds([{ id: ID("600d0001") }, { id: ID("600d0002") }]).values()], ["600d0001", "600d0002"]);
    // Ids that never differ within the bound show the same bounded text; the bound is not exceeded to tell them apart.
    const same = shownSessionIds([{ id: "abcdef12-1111-4000-8000-00000000000a" }, { id: "abcdef12-1111-4000-8000-00000000000b" }]);
    assert.deepEqual([...same.values()], ["abcdef12-1111", "abcdef12-1111"]);
    // ⚠️ AN ID IS FILE CONTENT: nothing but letters, digits, `-` and `_` reaches the terminal.
    const escape = String.fromCharCode(0x1b);
    const hostile = shownSessionIds([{ id: `ab${escape}[2J\n;rm` }, { id: "../../etc" }, { id: "short" }]);
    assert.deepEqual([...hostile.values()], ["ab??2J??", "??????et", "short"]);
    assert.deepEqual(renderUnresumable([{ id: `x${escape}]0;t`, modifiedMs: 0, status: "corrupt" }]), ["  - x??0?t | modified unknown | corrupt"]);
  } finally {
    f.remove();
  }
});

/* ------------------------------------------------------------------ which directory a session belongs to */

test("⚠️ #182 a session belongs to this project by Kiln's path identity, and one that belongs elsewhere is only counted", async () => {
  const f = fixture({ record: valid(ID("600d0001")) });
  try {
    const flip = (path) => (path[0] === path[0].toUpperCase() ? path[0].toLowerCase() : path[0].toUpperCase()) + path.slice(1);
    // The same directory spelled another way on Windows. Where paths are case-sensitive, a path that differs only
    // in case names a different directory, and a drive letter is not there to flip.
    const respelled = process.platform === "win32" ? flip(f.project) : join(f.base, "PROJECT");
    f.store(ID("600d0001"), { day: 3, cwd: respelled });
    f.store(ID("600d0002"), { day: 2 });
    f.store(ID("e15e0001"), { day: 1, cwd: join(f.base, "another-project") });

    const exact = await lister(f.project, f.sessions);
    const available = await availableSessions(f.sessions, { lister, projectRoot: f.project });
    const plan = await f.plan();
    if (process.platform === "win32") {
      // ⚠️ `c:\…` AND `C:\…` ARE ONE DIRECTORY. Pi's own listing leaves the respelled one out; Kiln's does not.
      assert.notEqual(respelled, f.project);
      assert.deepEqual(exact.map((s) => s.id), [ID("600d0002")]);
      assert.deepEqual(available.sessions.map((s) => [s.id, s.openBy]), [[ID("600d0001"), "path"], [ID("600d0002"), "id"]]);
      assert.equal(available.elsewhere, 1);
      // The recorded session is resumed, and Pi is to be given its file because Pi would not find it by id.
      assert.deepEqual([plan.action, plan.sessionId, plan.openBy, plan.problem], [SESSION.RESUME, ID("600d0001"), "path", SESSION_PROBLEM.NONE]);
      assert.ok(plan.sessionFile.endsWith(".jsonl") && plan.digest.length === 64);
    } else {
      // Where paths are case-sensitive the other spelling is another directory, and stays one.
      assert.deepEqual(available.sessions.map((s) => [s.id, s.openBy]), [[ID("600d0002"), "id"]]);
      assert.equal(available.elsewhere, 2);
      assert.deepEqual([plan.action, plan.problem], [SESSION.ASK, SESSION_PROBLEM.GONE]);
    }
    // ⚠️ A GENUINELY DIFFERENT DIRECTORY'S SESSION IS NEVER THIS PROJECT'S, on any platform.
    assert.ok(!available.sessions.some((s) => s.id === ID("e15e0001")));
    const elsewhere = fixture({ record: valid(ID("e15e0001")) });
    try {
      elsewhere.store(ID("e15e0001"), { cwd: join(elsewhere.base, "another-project") });
      const asked = await elsewhere.plan();
      assert.deepEqual([asked.action, asked.problem, asked.choices.selectable.length, asked.choices.elsewhere], [SESSION.ASK, SESSION_PROBLEM.GONE, 0, 1]);
      assert.ok((await choose(asked)).printed.includes("1 stored session belongs to a different directory."));
    } finally {
      elsewhere.remove();
    }

    // How Pi is asked: by id when it would find the session itself, and by the transcript's file when it would not.
    const agent = { args: ["pi"] };
    const resume = { guardFile: "g", guardExtension: "x.mjs" };
    assert.deepEqual(withSessionPolicy(agent, ID("600d0002"), {}, { resume: { ...resume, sessionFile: null } }).args.slice(1, 3), ["--session", ID("600d0002")]);
    assert.deepEqual(withSessionPolicy(agent, ID("600d0001"), {}, { resume: { ...resume, sessionFile: "/state/sessions/a.jsonl" } }).args.slice(1, 3), ["--session", "/state/sessions/a.jsonl"]);
    assert.deepEqual(withSessionPolicy(agent, ID("600d0001"), {}, { resume }).args.slice(1, 3), ["--session", ID("600d0001")]);

    // A lister that cannot list a whole directory gives no counts, and nothing is claimed about what it cannot see.
    const narrow = Object.assign((cwd, dir) => lister(cwd, dir), { sessionVersion: VERSION });
    const partial = await availableSessions(f.sessions, { lister: narrow, projectRoot: f.project });
    assert.deepEqual([partial.elsewhere, partial.unidentified, partial.sessions.every((s) => s.openBy === "id")], [null, null, true]);
    const quiet = [];
    await chooseSession({ choices: classifySessions(partial, { version: VERSION }), ask: async () => "q", print: (line) => quiet.push(line) });
    assert.ok(!quiet.some((line) => /could not be identified|different directory/.test(line)));
    await assert.rejects(() => lister.listAll(), TypeError);
  } finally {
    f.remove();
  }
});

/* ------------------------------------------------------------------ F3: the record is not written first */

test("⚠️ #182 choosing a session whose transcript fails inspection leaves the record byte-identical", async () => {
  for (const [name, record] of [["an unreadable record", "{ not json   \n"], ["a valid record naming a missing session", JSON.stringify(valid(ID("9099e000")), null, 2) + "\n"], ["no record at all", undefined]]) {
    for (const breakage of [{ garbage: true }, { version: VERSION - 1 }, { unterminated: true }]) {
      const f = fixture({ record });
      try {
        f.store(ID("bad00001"), { day: 2, ...breakage });
        f.store(ID("600d0001"), { day: 1 });
        const plan = await f.plan();
        const before = f.recordBytes();
        const refused = await recordSession({ ...f.common, sessionId: ID("bad00001"), choice: { action: RECOVERY.RESUME, sessionId: ID("bad00001") }, precondition: sessionPrecondition(f.root, plan.available) });
        assert.deepEqual([refused.ok, refused.problem], [false, SESSION_PROBLEM.TRANSCRIPT_UNSUPPORTED], `${name}, ${JSON.stringify(breakage)}`);
        // ⚠️ BYTE FOR BYTE, and absent if it was absent. The record used to be rewritten before this refusal.
        assert.equal(f.recordBytes(), before, `${name}, ${JSON.stringify(breakage)}: the record changed`);
        assert.equal(existsSync(join(f.root, "runtime", "kiln-session.lock")), false);
      } finally {
        f.remove();
      }
    }
  }

  const f = fixture({ record: "{ not json" });
  try {
    const path = f.store(ID("600d0001"));
    const plan = await f.plan();
    // A transcript that was sound when the list was shown and is not when the choice is recorded: the same refusal.
    const precondition = sessionPrecondition(f.root, plan.available);
    const sound = readFileSync(path, "utf-8");
    writeFileSync(path, sound.replace("\n", "\n{ this line is not JSON\n"));
    const late = await recordSession({ ...f.common, sessionId: ID("600d0001"), choice: { action: RECOVERY.RESUME, sessionId: ID("600d0001") }, precondition });
    assert.deepEqual([late.ok, late.problem, f.recordBytes()], [false, SESSION_PROBLEM.TRANSCRIPT_UNSUPPORTED, "{ not json"]);

    // ⚠️ ONE THAT PASSES IS WRITTEN, AND THE INSPECTION MADE UNDER THE LOCK IS THE ONE RETURNED.
    writeFileSync(path, sound);
    const chosen = await recordSession({ ...f.common, sessionId: ID("600d0001"), choice: { action: RECOVERY.RESUME, sessionId: ID("600d0001") }, precondition });
    assert.deepEqual([chosen.ok, chosen.action, chosen.sessionId, chosen.sessionFile, chosen.openBy], [true, SESSION.RESUME, ID("600d0001"), path, "id"]);
    assert.equal(chosen.digest, inspectTranscript(path, { version: VERSION, sessionId: ID("600d0001") }).digest);
    assert.equal(JSON.parse(f.recordBytes()).sessionId, ID("600d0001"));
    // A new session is still recorded without any transcript to inspect.
    const fresh = await recordSession({ ...f.common, sessionId: ID("0e000001"), choice: { action: RECOVERY.NEW }, precondition: sessionPrecondition(f.root, (await f.plan()).available ?? plan.available) });
    assert.deepEqual([fresh.ok, fresh.action, JSON.parse(f.recordBytes()).sessionId], [true, SESSION.START, ID("0e000001")]);
  } finally {
    f.remove();
  }
});

/* ------------------------------------------------------------------ F12: files that are not sessions of this project */

test("⚠️ #182 with no record, a store holding only files that are not this project's sessions is not an empty store", async () => {
  const stores = [
    ["a transcript with no header", (f) => f.store(ID("nohead01"), { header: false }), ["1 transcript file in the session storage could not be identified."]],
    ["an empty transcript", (f) => f.store(ID("empty001"), { empty: true }), ["1 transcript file in the session storage could not be identified."]],
    ["a session that belongs to another directory", (f) => f.store(ID("e15e0001"), { cwd: join(f.base, "another-project") }), ["1 stored session belongs to a different directory."]],
    [
      "all three",
      (f) => (f.store(ID("nohead01"), { header: false }), f.store(ID("empty001"), { empty: true }), f.store(ID("e15e0001"), { cwd: join(f.base, "another-project") })),
      ["2 transcript files in the session storage could not be identified.", "1 stored session belongs to a different directory."],
    ],
  ];
  for (const [name, arrange, counts] of stores) {
    const f = fixture();
    try {
      arrange(f);
      const plan = await f.plan();
      // ⚠️ IT USED TO START SILENTLY HERE, because nothing was listed. Something is stored, and it is not this
      // project's to resume or to ignore.
      assert.deepEqual([plan.action, plan.problem, plan.recoverable, plan.available.sessions.length], [SESSION.ASK, SESSION_PROBLEM.MISSING, true, 0], name);
      const { printed, asked, text, choice } = await choose(plan, ["n"]);
      assert.deepEqual(printed, ["This project has no session record.", ...counts, "No session can be resumed."], name);
      assert.deepEqual(asked, ["Start a new session, or cancel? (n for a new session, q to cancel) "], name);
      assert.deepEqual(choice, { action: RECOVERY.NEW }, name);
      for (const absent of ["Which session", f.base, ".jsonl", FILE_UUID, "nohead01", "empty001", "e15e0001"]) assert.ok(!text.includes(absent), `${name}: the chooser shows ${absent}`);
      assert.deepEqual((await choose(plan, [""])).choice, { action: RECOVERY.CANCEL, reason: "empty" }, name);

      // Nothing is recorded without that explicit answer, and with it a new session is.
      const unasked = await recordSession({ ...f.common, sessionId: ID("0e000001") });
      assert.deepEqual([unasked.ok, unasked.action, f.recordBytes()], [false, SESSION.ASK, null], name);
      const fresh = await recordSession({ ...f.common, sessionId: ID("0e000001"), choice: { action: RECOVERY.NEW }, precondition: sessionPrecondition(f.root, plan.available) });
      assert.deepEqual([fresh.ok, fresh.action, JSON.parse(f.recordBytes()).sessionId], [true, SESSION.START, ID("0e000001")], name);
    } finally {
      f.remove();
    }
  }

  // ⚠️ A STORE WITH NOTHING IN IT IS STILL A FIRST RUN, and starts without a question. So is one holding only a file
  // that is not a transcript.
  const empty = fixture();
  try {
    assert.equal((await empty.plan()).action, SESSION.START);
    writeFileSync(join(empty.sessions, "notes.txt"), "not a transcript");
    const plan = await empty.plan();
    assert.deepEqual([plan.action, plan.available.unidentified, plan.available.elsewhere], [SESSION.START, 0, 0]);
  } finally {
    empty.remove();
  }
});

/* ------------------------------------------------------------------ F13: one id, two transcripts */

test("⚠️ #182 an id that two transcripts carry is corrupt: neither is a choice, and a record naming it does not resume", async () => {
  const twin = ID("d0b1e000");
  // The chooser's path: no record, two sound transcripts under one id, and one session of its own.
  const f = fixture();
  try {
    const first = f.store(twin, { day: 3 });
    const second = f.store(twin, { day: 2 });
    f.store(ID("600d0001"), { day: 1 });
    for (const path of [first, second]) assert.equal(inspectTranscript(path, { version: VERSION, sessionId: twin }).ok, true, "each file is sound on its own");

    const plan = await f.plan();
    assert.deepEqual(plan.choices.selectable.map((s) => s.id), [ID("600d0001")]);
    assert.deepEqual(plan.choices.unresumable.map((s) => [s.id, s.status]), [[twin, "corrupt"], [twin, "corrupt"]]);
    const { printed, asked } = await choose(plan);
    assert.deepEqual(printed.map(stamped), [
      "This project has no session record, so none of its stored sessions is the recorded one.",
      "2 stored sessions cannot be resumed:",
      "  - d0b1e000 | modified <time> | corrupt",
      "  - d0b1e000 | modified <time> | corrupt",
      "1 session can be resumed:",
      "  1. 600d0001 | (unnamed) | created <time> | modified <time> | 1 message | unrecorded",
    ]);
    assert.deepEqual(asked, ["Which session should this run continue? (1 to resume it, n for a new session, q to cancel) "]);
    // ⚠️ NEITHER HAS A NUMBER, so neither can be reached by position.
    assert.deepEqual((await choose(plan, ["2", "3", "q"])).choice, { action: RECOVERY.CANCEL, reason: "declined" });

    // And a caller that names the id directly is refused under the lock, with the record untouched.
    const refused = await recordSession({ ...f.common, sessionId: twin, choice: { action: RECOVERY.RESUME, sessionId: twin }, precondition: sessionPrecondition(f.root, plan.available) });
    assert.deepEqual([refused.ok, refused.problem, refused.transcript, f.recordBytes()], [false, SESSION_PROBLEM.TRANSCRIPT_UNSUPPORTED, TRANSCRIPT_PROBLEM.DUPLICATE_ID, null]);
  } finally {
    f.remove();
  }

  // ⚠️ THE RECORDED-SESSION PATH: a valid record that names the duplicated id is not resumed on its strength.
  const recorded = fixture({ record: valid(twin) });
  try {
    recorded.store(twin, { day: 3 });
    const control = await recorded.plan();
    assert.deepEqual([control.action, control.sessionId], [SESSION.RESUME, twin], "one transcript under the recorded id resumes");

    recorded.store(twin, { day: 2 });
    const before = recorded.recordBytes();
    const plan = await recorded.plan();
    assert.deepEqual([plan.action, plan.problem, plan.transcript, plan.recordedId], [SESSION.ASK, SESSION_PROBLEM.TRANSCRIPT_UNSUPPORTED, TRANSCRIPT_PROBLEM.DUPLICATE_ID, twin]);
    assert.deepEqual([plan.choices.selectable.length, plan.choices.unresumable.map((s) => s.status)], [0, ["corrupt", "corrupt"]]);
    const { printed, asked } = await choose(plan);
    assert.equal(printed[0], "The session this project recorded (d0b1e000) cannot be resumed: its transcript is corrupt.");
    assert.equal(printed.at(-1), "No session can be resumed.");
    assert.deepEqual(asked, ["Start a new session, or cancel? (n for a new session, q to cancel) "]);
    // A run that is not acting on a choice adopts nothing and writes nothing.
    const unasked = await recordSession({ ...recorded.common, sessionId: twin });
    assert.deepEqual([unasked.ok, unasked.action, recorded.recordBytes()], [false, SESSION.ASK, before]);
  } finally {
    recorded.remove();
  }

  // A copy of the recorded session under another directory is not a duplicate in this project.
  const apart = fixture({ record: valid(twin) });
  try {
    apart.store(twin, { day: 3 });
    apart.store(twin, { day: 2, cwd: join(apart.base, "another-project") });
    const plan = await apart.plan();
    assert.deepEqual([plan.action, plan.sessionId, plan.available.elsewhere], [SESSION.RESUME, twin, 1]);
  } finally {
    apart.remove();
  }
});
