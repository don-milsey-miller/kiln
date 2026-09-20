/**
 * The child's own event stream, read strictly — TSK-0054 (D47, D49, F41, F42).
 *
 * ⚠️ **A LINE THAT IS NOT AN EVENT IS A REFUSAL, NOT SOMETHING TO SKIP.** The runtime used to `continue`
 * past anything `JSON.parse` rejected, so a child emitting garbage around one valid assistant message was
 * accepted on the strength of that one message. A stream that cannot be read whole is a stream nothing
 * about the run can be concluded from.
 *
 * ⚠️ **A TYPE IS NOT A SHAPE (F42).** `{"type":"session"}` names a real event and is not one. Every type
 * the gate CONSUMES is checked for the fields the gate reads, because accepting a hollow event would let
 * a child satisfy the reader by naming a type and supplying nothing.
 *
 * ⚠️ **AN UNKNOWN TOOL NAME FAILS CLOSED AND IS NEVER COPIED (F41).** `toolName` is whatever the child
 * put there. A name Kiln does not know makes the stream unreadable, and the refusal says so without
 * repeating the name: a raw child string in an observation is a channel out of the sandbox.
 *
 * ⚠️ **THE VOCABULARY IS MEASURED, NOT GUESSED.** These are the types the pinned agent emits, read from
 * `core/agent-session.js` and confirmed against a retained real-child run.
 */

import { KNOWN_TOOL_NAMES } from "../tool-wire-names.mjs";

/** Every event type the pinned Pi emits on stdout in `--mode json`. */
export const PI_EVENT_TYPES = Object.freeze([
  "session",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

/**
 * The types the gate reads, and which it therefore pins the shape of.
 *
 * ⚠️ **ANSWER AND SELECTION COME FROM `message_end` AND `turn_end` ONLY.** Those carry a completed
 * assistant message. `message_update` is a partial and `message_start` has no content yet, so reading
 * either would let a child's half-written text stand in for its answer.
 */
export const AUTHORITATIVE_MESSAGE_TYPES = Object.freeze(["message_end", "turn_end"]);

const KNOWN_TYPES = new Set(PI_EVENT_TYPES);
const KNOWN_TOOLS = new Set(KNOWN_TOOL_NAMES);
/**
 * MEASURED: `message_start`, `message_end` and `turn_end` carry `message`; `message_update` does NOT.
 * It carries `usage` and `assistantMessageEvent`, because it is a delta rather than a message. Only the
 * two the gate reads are shape-checked, and requiring `message` on an update would refuse every real run.
 */
const MESSAGE_BEARING = new Set(AUTHORITATIVE_MESSAGE_TYPES);

export const EVENTS_INVALID = Object.freeze({
  UNPARSEABLE: "line-is-not-json",
  NOT_AN_OBJECT: "line-is-not-an-event-object",
  UNKNOWN_TYPE: "line-has-an-unknown-event-type",
  BAD_SHAPE: "event-is-missing-a-field-the-gate-reads",
  UNKNOWN_TOOL: "event-names-a-tool-this-host-does-not-register",
});

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The minimum shape each consumed type must have. A type not listed here is accepted on its type alone,
 * because nothing reads it — and it is listed in `PI_EVENT_TYPES`, so it is still a type Pi emits.
 */
function shapeProblem(event) {
  if (event.type === "session") {
    // Measured: {type, version, id, timestamp, cwd}.
    if (typeof event.version !== "number") return EVENTS_INVALID.BAD_SHAPE;
    if (typeof event.id !== "string" || event.id.length === 0) return EVENTS_INVALID.BAD_SHAPE;
    return null;
  }
  if (MESSAGE_BEARING.has(event.type)) {
    if (!isObject(event.message)) return EVENTS_INVALID.BAD_SHAPE;
    if (typeof event.message.role !== "string" || event.message.role.length === 0) return EVENTS_INVALID.BAD_SHAPE;
    // An assistant message the gate will read must carry content it can read.
    if (event.message.role === "assistant" && !Array.isArray(event.message.content)) return EVENTS_INVALID.BAD_SHAPE;
    return null;
  }
  if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
    if (typeof event.toolName !== "string" || event.toolName.length === 0) return EVENTS_INVALID.BAD_SHAPE;
    // ⚠️ FAIL CLOSED ON A NAME NOBODY REGISTERED, and say nothing about what it was.
    if (!KNOWN_TOOLS.has(event.toolName)) return EVENTS_INVALID.UNKNOWN_TOOL;
    return null;
  }
  return null;
}

/**
 * Read the stream, or say which line could not be read and why.
 *
 * ⚠️ **THE REASON NAMES A LINE NUMBER AND NEVER ITS CONTENT.** The content is the child's, and a refusal
 * quoting it would carry exactly the prose — or the invented tool name — the gate exists to withhold.
 *
 * @param {string} stdout
 * @returns {{ok: true, events: object[]} | {ok: false, reason: string, line: number}}
 */
export function readChildEvents(stdout) {
  const events = [];
  const lines = String(stdout ?? "").split(String.fromCharCode(10));
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    // ⚠️ EMPTY LINES ARE NOT CONTENT. A trailing newline is how a stream ends, not a malformed event.
    if (raw.trim().length === 0) continue;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: EVENTS_INVALID.UNPARSEABLE, line: i + 1 };
    }
    if (!isObject(parsed)) return { ok: false, reason: EVENTS_INVALID.NOT_AN_OBJECT, line: i + 1 };
    if (typeof parsed.type !== "string" || !KNOWN_TYPES.has(parsed.type)) return { ok: false, reason: EVENTS_INVALID.UNKNOWN_TYPE, line: i + 1 };

    const problem = shapeProblem(parsed);
    if (problem !== null) return { ok: false, reason: problem, line: i + 1 };
    events.push(parsed);
  }
  return { ok: true, events };
}

/**
 * Every tool the child STARTED, as canonical names.
 *
 * ⚠️ **STARTING IS THE FACT, NOT FINISHING (D49).** A handler that failed may already have mutated state,
 * so waiting for `tool_execution_end` would be waiting for the damage to finish before objecting. The
 * primary boundary is still absence — `--tools` and the measured registry mean an out-of-role tool is not
 * there to call — and this is the fail-safe for a boundary that did not hold.
 *
 * ⚠️ **EVERY NAME HERE IS ONE KILN KNOWS**, because `readChildEvents` refuses a stream naming anything
 * else. Nothing the child invented can reach a caller through this list.
 */
export function toolsStarted(events) {
  const names = [];
  for (const event of events) {
    if (event?.type !== "tool_execution_start") continue;
    if (KNOWN_TOOLS.has(event.toolName)) names.push(event.toolName);
  }
  return names;
}

/** An assistant message from an authoritative event, or null. */
const assistantMessage = (event) => {
  if (!AUTHORITATIVE_MESSAGE_TYPES.includes(event?.type)) return null;
  const message = event.message;
  return isObject(message) && message.role === "assistant" ? message : null;
};

/** What Pi's own assistant messages said the request went out under. Never a source of truth alone. */
export function nativeSelection(events) {
  let provider = null;
  let model = null;
  for (const event of events) {
    const message = assistantMessage(event);
    if (message === null) continue;
    if (typeof message.provider === "string") provider = message.provider;
    if (typeof message.model === "string") model = message.model;
  }
  return { provider, model };
}

/**
 * The child's answer: the text of its last completed assistant message.
 *
 * ⚠️ **CALLED ONLY AFTER THE GATE ACCEPTS (TSK-0054).** It used to run while the stream was being read,
 * so the assistant's text was selected before anything about the run had been verified. The refusal path
 * dropped it, which made the criterion hold by accident rather than by construction.
 */
export function answerFrom(events) {
  let answer = null;
  for (const event of events) {
    const message = assistantMessage(event);
    if (message === null) continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join(String.fromCharCode(10))
      .trim();
    if (text.length > 0) answer = text;
  }
  return answer;
}
