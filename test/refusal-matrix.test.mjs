/**
 * The refusal matrix — TSK-0054, toward ACC-0075.
 *
 * ⚠️ **ONE CASE PER CAUSE, AND EACH PROVES THE PROSE IS NOT READ.** "Not read" is operational here:
 * rejected assistant text is never selected as the answer, returned, logged or put in a refusal's
 * details. Buffering stdout is permitted, and necessary, because detecting a malformed stream requires
 * reading it.
 *
 * ⚠️ **THE SENTINEL IS THE POINT.** Every refusal case makes the child emit a confident, plausible
 * answer containing `PLAUSIBLE-PROSE-SENTINEL`. A case passes only when that string appears nowhere in
 * the result, its refusal, its observation or anything serialisable from it.
 *
 * ⚠️ **FAULTS COMBINE (F43).** The scripted child takes a LIST of faults, not one. A precedence test
 * whose cases can each contain only a single failure is not testing precedence at all: it never
 * produces the situation the order exists to resolve. Every adjacent pair in the seven-step order is
 * built here as a genuine double failure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CHILD_REFUSED, contractFor } from "../lib/specialists/contract.mjs";
import { buildChildReport } from "../lib/specialists/child-report.mjs";
import { AUTHORITATIVE_MESSAGE_TYPES, EVENTS_INVALID, PI_EVENT_TYPES, answerFrom, nativeSelection, readChildEvents, toolsStarted } from "../lib/specialists/child-events.mjs";
import { delegateToSpecialist } from "../lib/specialists/delegate.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SENTINEL = "PLAUSIBLE-PROSE-SENTINEL";
const PROSE = `Nightly reconciliation is what the port office needs. ${SENTINEL}`;
const TASK = "Find what the port office publishes about dock-fee reconciliation.";
const digestOf = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const flag = (args, name) => (args.indexOf(name) < 0 ? undefined : args[args.indexOf(name) + 1]);

/** A tool name Kiln does not register. The child controls this string; nothing may copy it. */
const INVENTED_TOOL = "kiln_exfiltrate_everything";

const created = new Set();
const leaked = () => [...created].filter((p) => readdirSync(tmpdir()).includes(p.split(/[\\/]/).pop()));

/** A teardown pair shaped like the supervisor's. */
const teardown = () => ({
  trackDescendants: () => ({ stop: async () => {}, snapshot: () => ({ pids: [], identities: [], enumerated: true, looks: {}, queries: [] }) }),
  stopTree: async (child) => {
    child.emit?.("exit", null, "SIGTERM");
    return { requested: true, exitObserved: true, escalated: false, method: "signal", error: null };
  },
});

/**
 * A scripted child that always produces plausible prose, and fails in every declared way at once.
 *
 * ⚠️ **`faults` IS A LIST.** Each entry is independent, so a caller can build "did not finish AND its
 * stream is garbage" or "no binding AND a wrong model" without the fixture deciding which of the two
 * it is allowed to be.
 *
 * @param {{faults?: string[], exitCode?: number}} spec
 */
function child({ faults = [], exitCode = 0 } = {}) {
  const has = (fault) => faults.includes(fault);
  const calls = [];
  const spawn = (command, args, options) => {
    created.add(options.cwd);
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    const fd3 = new EventEmitter();
    proc.stdio = [null, proc.stdout, proc.stderr, fd3];
    proc.kill = () => {};
    calls.push({ args, options });

    // ⚠️ A CHILD THAT NEVER EXITS, INCLUDING WHEN ITS TREE IS STOPPED. Only the timeout ends the run.
    if (has("hang")) {
      const original = proc.emit.bind(proc);
      proc.emit = (type, ...rest) => (type === "exit" ? undefined : original(type, ...rest));
    }

    const promptDir = flag(args, "--prompt-template");
    const promptBody = readFileSync(join(promptDir, readdirSync(promptDir)[0]), "utf8");
    const nonce = options.env.KILN_TASK_NONCE;
    const task = promptBody.slice(promptBody.indexOf(">>>\n") + 4, promptBody.indexOf(`\n<<<KILN-TASK-END nonce=${nonce}>>>`));
    const activeTools = [...(flag(args, "--tools") ?? "").split(",").filter(Boolean)].sort();
    const signatures = Object.fromEntries(Object.entries(contractFor("research").toolSignatures));
    const line = (event) => proc.stdout.emit("data", `${JSON.stringify(event)}\n`);

    queueMicrotask(() => {
      // Every run emits a well-formed stream carrying confident prose. That is the #67 shape.
      line({ type: "session", version: 3, id: "s-1", cwd: options.cwd });
      if (has("out-of-role")) line({ type: "tool_execution_start", toolName: "kiln_set_review_status" });
      if (has("other-write")) line({ type: "tool_execution_start", toolName: "kiln_write_stage_attestation" });
      if (has("read-outside-role")) line({ type: "tool_execution_start", toolName: "kiln_project_status" });
      if (has("in-boundary-write")) line({ type: "tool_execution_start", toolName: "kiln_create_evidence" });
      if (has("unknown-tool")) line({ type: "tool_execution_start", toolName: INVENTED_TOOL });
      line({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: PROSE }],
          provider: has("native-mismatch") ? "somewhere-else" : flag(args, "--provider"),
          model: flag(args, "--model"),
        },
      });
      // ⚠️ THE UNREADABLE LINE CARRIES THE PROSE. A reader that reported the line back would put
      // the child's own text into the refusal, which is the disclosure the line number exists to avoid.
      if (has("unparseable")) proc.stdout.emit("data", `{not json at all, ${PROSE}\n`);
      if (has("unknown-event")) line({ type: "kiln_invented_event", text: PROSE });
      if (has("not-an-object")) proc.stdout.emit("data", `${JSON.stringify([1, 2, 3])}\n`);
      if (has("hollow-session")) line({ type: "session" });
      if (has("hollow-message")) line({ type: "message_end", text: PROSE });
      line({ type: "agent_settled" });

      if (has("no-binding")) {
        fd3.emit("data", `${JSON.stringify({ v: 1, ok: false, reason: "frame-absent-from-first-request" })}\n`);
      } else {
        fd3.emit("data", `${JSON.stringify({ v: 1, ok: true, nonce, units: task.length, sha256: digestOf(task) })}\n`);
      }

      if (!has("no-report")) {
        const base = buildChildReport({
          pi: {
            getActiveTools: () => (has("toolless") ? [] : activeTools),
            getAllTools: () => (has("toolless") ? [] : activeTools.map((name) => ({ name, parameters: signatures[name]?.input }))),
          },
          ctx: { model: { provider: flag(args, "--provider"), id: flag(args, "--model") }, thinkingLevel: flag(args, "--thinking") },
        });
        const drifted = has("signature-drift")
          ? { ...base, toolSignatures: { ...base.toolSignatures, research_search: { input: { properties: { query: {}, anExtraProperty: {} }, required: ["query"] } } } }
          : base;
        fd3.emit("data", `${JSON.stringify(has("selection-mismatch") ? { ...drifted, model: "a-model-nobody-asked-for" } : drifted)}\n`);
      }

      proc.emit("exit", has("nonzero-exit") ? 1 : exitCode, null);
    });
    return proc;
  };
  return { spawn, calls };
}

const deps = (script) => ({ spawn: script.spawn, resolveAgent: () => ({ command: "node", args: ["cli.js"] }), ...teardown() });

const request = (over = {}) => ({
  role: "research",
  task: TASK,
  toolRoot: REPO,
  agentDir: join(tmpdir(), "kiln-matrix-agent"),
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  thinkingLevel: "medium",
  hostRegistry: [...contractFor("research").tools],
  hostEnv: { PATH: "/usr/bin", HOME: "/home/x" },
  ...over,
});

/** Run one delegation with these faults and assert the sentinel escaped nowhere. */
async function refused(faults, code, over = {}) {
  const label = faults.join("+");
  const script = child({ faults });
  const result = await delegateToSpecialist(request(over), deps(script));

  assert.equal(result.ok, false, `${label}: accepted`);
  assert.equal(result.code, code, `${label}: ${result.code}`);

  // ⚠️ THE WHOLE RESULT, SERIALISED. Answer, message, observation and anything nested.
  const serialised = JSON.stringify(result);
  assert.equal(serialised.includes(SENTINEL), false, `${label}: the rejected prose reached the result`);
  assert.equal(serialised.includes(PROSE), false, `${label}: the rejected prose reached the result`);
  assert.equal(serialised.includes(INVENTED_TOOL), false, `${label}: a child-controlled tool name reached the result`);
  assert.equal("output" in result, false, `${label}: a refusal carried an output field`);
  assert.ok(result.message.length > 0, `${label}: no message`);
  assert.equal(result.message.includes(SENTINEL), false, `${label}: the prose reached the message`);
  assert.ok(Number.isInteger(result.observation.durationMs), `${label}: no durationMs`);
  assert.equal("bindingDetail" in result.observation, false, `${label}: the observation carried bindingDetail`);
  return result;
}

/* ============================================================ one row per cause =============== */

test("⚠️ ACC-0075 (1) ACC-0089 (19) plausible prose with none of Kiln's tools is refused, and the prose is not used", async () => {
  // ⚠️ **#67's OWN CASE.** The child exits zero, emits a well-formed stream and answers confidently, and
  // holds nothing. Its answer must not be what the delegation returns.
  const result = await refused(["toolless"], CHILD_REFUSED.CAPABILITY_MISSING);
  assert.equal(result.observation.exit.code, 0, "the control is not a control: the child did not exit zero");
  assert.deepEqual(result.observation.reportedActiveTools, [], "the child claimed tools it did not hold");
});

test("⚠️ ACC-0075 (2) ACC-0089 (18) capability-signature drift is refused", async () => {
  await refused(["signature-drift"], CHILD_REFUSED.SIGNATURE_MISMATCH);
});

test("⚠️ ACC-0075 (3) a write started outside the role's boundary is refused", async () => {
  // ⚠️ D49's FAIL-SAFE. Absence is the primary boundary - `--tools` never offered this - and STARTING is
  // the fact, because a handler that failed may already have mutated state.
  const result = await refused(["out-of-role"], CHILD_REFUSED.OUT_OF_ROLE_WRITE);
  assert.deepEqual(result.observation.outOfRoleTools, ["kiln_set_review_status"]);
  assert.ok(result.observation.toolsStarted.includes("kiln_set_review_status"));

  // A write belonging to neither registry is still a write no role declares.
  const other = await refused(["other-write"], CHILD_REFUSED.OUT_OF_ROLE_WRITE);
  assert.deepEqual(other.observation.outOfRoleTools, ["kiln_write_stage_attestation"]);
});

test("⚠️ ACC-0075 (4) a nonzero exit is refused under its own code", async () => {
  const result = await refused(["nonzero-exit"], CHILD_REFUSED.NONZERO_EXIT);
  assert.equal(result.observation.exit.code, 1);
  assert.equal(result.observation.timedOut, false, "a nonzero exit is not a timeout");
});

test("⚠️ ACC-0075 (5) a timeout is refused, and its partial output is not an answer", async () => {
  const result = await refused(["hang"], CHILD_REFUSED.TIMED_OUT, { timeoutMs: 30 });
  assert.equal(result.observation.timedOut, true);
});

test("⚠️ ACC-0075 (6) a stream that cannot be read whole is refused, five ways", async () => {
  // ⚠️ **A LINE THAT IS NOT AN EVENT IS A REFUSAL, NOT SOMETHING TO SKIP.** The runtime used to `continue`
  // past it, so a child emitting garbage around one valid message was accepted on that message's strength.
  for (const [fault, reason] of [
    ["unparseable", EVENTS_INVALID.UNPARSEABLE],
    ["unknown-event", EVENTS_INVALID.UNKNOWN_TYPE],
    ["not-an-object", EVENTS_INVALID.NOT_AN_OBJECT],
    ["hollow-session", EVENTS_INVALID.BAD_SHAPE],
    ["hollow-message", EVENTS_INVALID.BAD_SHAPE],
  ]) {
    const result = await refused([fault], CHILD_REFUSED.EVENTS_MALFORMED);
    assert.equal(result.observation.eventsInvalid, reason, fault);
    assert.ok(Number.isInteger(result.observation.eventsInvalidLine), `${fault}: no line number`);
  }
});

test("⚠️ ACC-0075 (7) a missing task binding is refused", async () => {
  const result = await refused(["no-binding"], CHILD_REFUSED.NO_TASK_BINDING);
  assert.equal(result.observation.taskBindingObserved, false);
});

test("⚠️ ACC-0075 (8) a provider or model mismatch is refused under its own code", async () => {
  // ⚠️ D48: NOT `capability-missing`. A child answering under a selection nobody asked for is a different
  // failure from one missing a tool, and a caller told the latter would look for the wrong fix.
  const bySelf = await refused(["selection-mismatch"], CHILD_REFUSED.SELECTION_MISMATCH);
  assert.equal(bySelf.observation.childReportReason, "child-report-contradicts-request");

  const byNative = await refused(["native-mismatch"], CHILD_REFUSED.SELECTION_MISMATCH);
  assert.equal(byNative.observation.childReportReason, "child-report-contradicts-transcript");
});

test("⚠️ ACC-0075 a missing report is still a child that cannot demonstrate its tools", async () => {
  await refused(["no-report"], CHILD_REFUSED.CAPABILITY_MISSING);
});

/* ============================================================ F40: what a write IS ============ */

test("⚠️ F40 the write boundary is `mayWrite`, not the allowlist", async () => {
  // ⚠️ **A READ THE ROLE WAS NOT GIVEN IS NOT AN OUT-OF-ROLE WRITE.** The earlier check refused every
  // tool outside `active`, which told the caller a mutation had been attempted when none had. Absence
  // is still the primary boundary: `--tools` never offered this, so it should not be reachable at all.
  const readOnly = child({ faults: ["read-outside-role"] });
  const readResult = await delegateToSpecialist(request(), deps(readOnly));
  assert.equal(readResult.ok, true, `a read outside the allowlist was refused as a write: ${readResult.code}`);
  assert.deepEqual(readResult.observation.outOfRoleTools, []);
  assert.ok(readResult.observation.toolsStarted.includes("kiln_project_status"), "the read was not observed at all");

  // And a write INSIDE the role's declared boundary is not out of role.
  const allowed = child({ faults: ["in-boundary-write"] });
  const allowedResult = await delegateToSpecialist(request(), deps(allowed));
  assert.equal(allowedResult.ok, true, `a declared write was refused: ${allowedResult.code}`);
  assert.deepEqual(allowedResult.observation.outOfRoleTools, []);
});

test("⚠️ F40 the allowlist is an intersection, so it is not the write boundary", async () => {
  // ⚠️ **`active` IS THE ROLE'S TOOLS INTERSECTED WITH WHAT THE HOST REGISTERS.** A host missing a
  // tool drops it from `active` while the role's write boundary still declares it, so checking the
  // allowlist would report an out-of-role WRITE for an operation the role is entitled to perform.
  // The drop is already recorded, under its own field, as the fact it is.
  const withoutEvidence = [...contractFor("research").tools].filter((n) => n !== "kiln_create_evidence");
  const script = child({ faults: ["in-boundary-write"] });
  const result = await delegateToSpecialist(request({ hostRegistry: withoutEvidence }), deps(script));

  assert.deepEqual(result.observation.outOfRoleTools, [], `a declared write was called out of role: ${result.code}`);
  assert.deepEqual(result.observation.droppedFromAllowlist, ["kiln_create_evidence"], "the drop was not recorded");
  assert.equal(result.observation.activeTools.includes("kiln_create_evidence"), false, "the host registry was ignored");
});

/* ============================================================ F41: no raw names ================ */

test("⚠️ F41 a tool name this host does not register fails closed and is never copied", async () => {
  // ⚠️ **`toolName` IS WHATEVER THE CHILD PUT THERE.** Resolving it through Kiln's own tables is what
  // lets a caller be told which operation ran without the child's string leaving the sandbox. An
  // unknown name makes the stream unreadable, and the refusal says so without repeating it.
  const result = await refused(["unknown-tool"], CHILD_REFUSED.EVENTS_MALFORMED);
  assert.equal(result.observation.eventsInvalid, EVENTS_INVALID.UNKNOWN_TOOL);
  assert.deepEqual(result.observation.toolsStarted, [], "an unreadable stream still yielded tool names");
  assert.deepEqual(result.observation.outOfRoleTools, []);
});

/* ============================================================ precedence ====================== */

test("⚠️ TSK-0054 every adjacent pair in the refusal order is decided by the earlier step", async () => {
  // ⚠️ **WHICH REFUSAL A CALLER IS TOLD DECIDES WHAT THEY DO NEXT.** Facts the child does not control
  // come first: it did not finish, then its stream cannot be read, then it reported failure. Only then
  // is anything the child says about itself consulted. Each case below is a REAL double failure, so it
  // fails if either the earlier check is removed or the later one is allowed to answer first.
  const pairs = [
    ["1 beats 2", ["hang", "unparseable"], CHILD_REFUSED.TIMED_OUT, { timeoutMs: 30 }],
    ["2 beats 3", ["unparseable", "nonzero-exit"], CHILD_REFUSED.EVENTS_MALFORMED, {}],
    ["3 beats 4", ["nonzero-exit", "no-binding"], CHILD_REFUSED.NONZERO_EXIT, {}],
    ["4 beats 5", ["no-binding", "selection-mismatch"], CHILD_REFUSED.NO_TASK_BINDING, {}],
    ["5 beats 6", ["selection-mismatch", "out-of-role"], CHILD_REFUSED.SELECTION_MISMATCH, {}],
    ["6 beats 7", ["out-of-role", "toolless"], CHILD_REFUSED.OUT_OF_ROLE_WRITE, {}],
  ];
  for (const [label, faults, code, over] of pairs) {
    const result = await refused(faults, code, over);
    assert.equal(result.code, code, `${label}: ${result.code}`);
  }
});

test("⚠️ TSK-0054 each later fault still refuses on its own, so a pair proves an order", async () => {
  // ⚠️ THE OTHER HALF OF A PRECEDENCE CLAIM. A pair only shows an order if the loser would have won
  // alone; otherwise the test would pass with the later check deleted entirely.
  for (const [faults, code] of [
    [["unparseable"], CHILD_REFUSED.EVENTS_MALFORMED],
    [["nonzero-exit"], CHILD_REFUSED.NONZERO_EXIT],
    [["no-binding"], CHILD_REFUSED.NO_TASK_BINDING],
    [["selection-mismatch"], CHILD_REFUSED.SELECTION_MISMATCH],
    [["out-of-role"], CHILD_REFUSED.OUT_OF_ROLE_WRITE],
    [["toolless"], CHILD_REFUSED.CAPABILITY_MISSING],
  ]) {
    await refused(faults, code);
  }
});

/* ============================================================ the readers ===================== */

test("⚠️ TSK-0054 the event reader accepts Pi's vocabulary and nothing else", () => {
  const ok = readChildEvents(`${JSON.stringify({ type: "session", version: 3, id: "s-1" })}\n\n${JSON.stringify({ type: "agent_settled" })}\n`);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.events.length, 2, "a blank line was treated as content");

  for (const [text, reason, line] of [
    [`{not json, ${PROSE}`, EVENTS_INVALID.UNPARSEABLE, 1],
    ['"a string"', EVENTS_INVALID.NOT_AN_OBJECT, 1],
    ["[1,2]", EVENTS_INVALID.NOT_AN_OBJECT, 1],
    ["null", EVENTS_INVALID.NOT_AN_OBJECT, 1],
    [`${JSON.stringify({ type: "session", version: 3, id: "s-1" })}\n${JSON.stringify({ type: "invented" })}`, EVENTS_INVALID.UNKNOWN_TYPE, 2],
    [`${JSON.stringify({ noType: true })}`, EVENTS_INVALID.UNKNOWN_TYPE, 1],
  ]) {
    const result = readChildEvents(text);
    assert.equal(result.ok, false, text.slice(0, 40));
    assert.equal(result.reason, reason, text.slice(0, 40));
    assert.equal(result.line, line, text.slice(0, 40));
    // ⚠️ **THE REASON NAMES A LINE, NEVER ITS CONTENT, AND THE SHAPE IS FIXED.** Asserting the exact
    // keys is what makes that true of the READER rather than of whichever caller happens to copy only
    // three fields out of it. A reader returning the offending line would hand every future caller the
    // child's own text along with the refusal.
    assert.deepEqual(Object.keys(result).sort(), ["line", "ok", "reason"], "the reader's refusal carried an extra field");
    assert.equal(JSON.stringify(result).includes("invented"), false);
    assert.equal(JSON.stringify(result).includes(SENTINEL), false, "the unreadable line was reported back");
  }

  // The vocabulary is the measured one.
  assert.ok(PI_EVENT_TYPES.includes("tool_execution_start"));
  assert.equal(PI_EVENT_TYPES.includes("error"), false, "a type the pinned agent does not emit was accepted");
});

test("⚠️ F42 a type is not a shape: every event the gate reads is checked for the fields it reads", () => {
  // ⚠️ **`{"type":"session"}` NAMES A REAL EVENT AND IS NOT ONE.** Accepting it would let a child
  // satisfy the reader by naming a type and supplying nothing.
  const bad = [
    [{ type: "session" }, EVENTS_INVALID.BAD_SHAPE, "a session with no version or id"],
    [{ type: "session", version: "3", id: "s-1" }, EVENTS_INVALID.BAD_SHAPE, "a session whose version is a string"],
    [{ type: "session", version: 3 }, EVENTS_INVALID.BAD_SHAPE, "a session with no id"],
    [{ type: "message_end" }, EVENTS_INVALID.BAD_SHAPE, "a message event with no message"],
    [{ type: "message_end", message: "text" }, EVENTS_INVALID.BAD_SHAPE, "a message that is not an object"],
    [{ type: "message_end", message: { content: [] } }, EVENTS_INVALID.BAD_SHAPE, "a message with no role"],
    [{ type: "message_end", message: { role: "assistant" } }, EVENTS_INVALID.BAD_SHAPE, "an assistant message with no content"],
    [{ type: "turn_end", message: { role: "assistant", content: "not a list" } }, EVENTS_INVALID.BAD_SHAPE, "content that is not a list"],
    [{ type: "tool_execution_start" }, EVENTS_INVALID.BAD_SHAPE, "a tool start with no name"],
    [{ type: "tool_execution_end", toolName: "" }, EVENTS_INVALID.BAD_SHAPE, "a tool end with an empty name"],
    [{ type: "tool_execution_start", toolName: INVENTED_TOOL }, EVENTS_INVALID.UNKNOWN_TOOL, "an invented tool name"],
  ];
  for (const [event, reason, why] of bad) {
    const result = readChildEvents(`${JSON.stringify(event)}\n`);
    assert.equal(result.ok, false, why);
    assert.equal(result.reason, reason, why);
    assert.equal(JSON.stringify(result).includes("exfiltrate"), false, "the invented name was reported back");
  }

  const good = [
    { type: "session", version: 3, id: "s-1", timestamp: 1, cwd: "/w" },
    { type: "message_start", message: { role: "assistant", content: [] } },
    // ⚠️ MEASURED: an update carries no `message` at all. Requiring one would refuse every real run.
    { type: "message_update", usage: { input: 1 }, assistantMessageEvent: { type: "text_delta" } },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "turn_end", message: { role: "assistant", content: [], toolResults: [] } },
    { type: "message_end", message: { role: "user", content: "a string is fine for a user turn" } },
    { type: "tool_execution_start", toolName: "research_search" },
    { type: "turn_start" },
  ];
  for (const event of good) {
    const result = readChildEvents(`${JSON.stringify(event)}\n`);
    assert.equal(result.ok, true, `${event.type}: ${result.reason}`);
  }
});

test("⚠️ F42 the answer and the selection come only from completed assistant messages", () => {
  // ⚠️ **A PARTIAL IS NOT AN ANSWER.** `message_update` carries a half-written message, and reading it
  // would let a child's discarded draft stand in for what it actually said.
  assert.deepEqual([...AUTHORITATIVE_MESSAGE_TYPES], ["message_end", "turn_end"]);

  const events = [
    { type: "session", version: 3, id: "s-1" },
    { type: "tool_execution_start", toolName: "research_search" },
    { type: "tool_execution_start" },
    { type: "tool_execution_start", toolName: INVENTED_TOOL },
    { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "a draft" }], provider: "wrong", model: "wrong" } },
    { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "half" }], provider: "wrong", model: "wrong" } },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "the task" }], provider: "wrong", model: "wrong" } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }], provider: "openai-codex", model: "gpt-5.6-sol" } },
    { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "last" }] } },
    // ⚠️ AFTER the assistant's last word, so a reader that ignores `role` returns this instead.
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "a later user turn" }] } },
  ];
  assert.deepEqual(toolsStarted(events), ["research_search"], "a nameless or invented tool start was counted");
  assert.equal(answerFrom(events), "last", "the answer is the last completed assistant text");
  assert.equal(answerFrom([{ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "half" }] } }]), null, "a partial message was read as an answer");
  assert.equal(answerFrom([{ type: "session", version: 3, id: "s-1" }]), null);
  assert.deepEqual(nativeSelection(events), { provider: "openai-codex", model: "gpt-5.6-sol" }, "a partial or user message supplied the selection");
});

test("⚠️ TSK-0054 no refusal in this file leaves a workspace behind", () => {
  assert.deepEqual(leaked(), [], `workspaces survived: ${leaked().join(", ")}`);
});
