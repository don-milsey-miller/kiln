/**
 * The agent-owned regions of a stage document, and the only writer for them (ACC-0113 and issue #33).
 *
 * ⚠️ **NOT A TYPED ARTIFACT TOOL, FOR THE SAME REASON AN ATTESTATION IS NOT.** `lib/tools/registry.mjs`
 * governs artifacts: a stage document has no id, no schema and no lifecycle, and filing it there would
 * make two different kinds of thing look like one.
 *
 * ⚠️ **TWO REGIONS, KEPT APART ON PURPOSE.** What the operator said is stored exactly as supplied; what
 * Kiln took from it is stored separately and labelled with the same entry. A reader can always tell which
 * words are whose, and an interpretation can be wrong without the wording changing.
 *
 * ⚠️ **PAYLOADS ARE LENGTH-FRAMED, AND THE PARSER NEVER READS INSIDE ONE.** An operator may type
 * `### Kiln's reading`, or `**A99**`, or a code fence. If the parser searched the document for headings or
 * labels, that text would forge an anchor or move the next label. Each payload records its own UTF-16
 * code-unit length, the parser skips exactly that many units, and only then looks at the frame again. The
 * dynamic fence is for the renderer's benefit; the measure is what the parser trusts.
 * Working-note subsections use the same measured-span rule. Their audit markers are Markdown reference
 * definitions, so they remain inspectable in source and disappear from the rendered visualization.
 *
 * ⚠️ **WHAT IS PRESERVED IS THE EXACT INPUT STRING, NOT THE OPERATOR'S ORIGINAL BYTES.** The text arrives
 * over JSON transport, which does not carry an independent byte representation. Round-tripping this module
 * returns the string that was supplied to it, code unit for code unit.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "./runtime-path.mjs";

import { PathEscapeError, resolveInContentRoot } from "./content-root.mjs";

// ⚠️ THE WRITE'S MACHINERY IS IMPORTED WHERE IT IS USED, as `lib/attestations.mjs` does. The initializer
// imports this module for the section it generates, and generating content should not drag the lock, the
// atomic writer and the schema loader in behind it.

/** The refusals this module raises. Every one of them leaves the document unchanged. */
export const STAGE_DOCUMENT_REFUSAL = Object.freeze({
  INVALID_REQUEST: "invalid-request",
  OUTSIDE_ROOT: "stage-document-outside-root",
  MISSING: "stage-document-missing",
  UNREADABLE: "stage-document-unreadable",
  ANCHOR_MISSING: "stage-document-anchor-missing",
  FRAME_INVALID: "stage-document-frame-invalid",
  ENTRIES_INVALID: "stage-document-entries-invalid",
  WORKING_NOTES_INVALID: "stage-document-working-notes-invalid",
  REVISION_CONFLICT: "stage-document-revision-conflict",
  SUBSECTION_EXISTS: "stage-document-subsection-exists",
  SUBSECTION_MISSING: "stage-document-subsection-missing",
  // The write itself, as opposed to what was asked for (#179). Each of these also leaves the document unchanged.
  LOCK_TIMEOUT: "stage-document-lock-timeout",
  WRITE_CANCELLED: "stage-document-write-cancelled",
  WRITE_CONTENDED: "stage-document-write-contended",
  WRITE_FAILED: "stage-document-write-failed",
});

export class StageDocumentRefusal extends Error {
  /** @param {object|null} [details] fields a caller may return beside the code: relative paths and fixed guidance. */
  constructor(code, message, details = null) {
    super(message);
    this.name = "StageDocumentRefusal";
    this.code = code;
    this.details = details;
  }
}

const refuse = (code, message) => {
  throw new StageDocumentRefusal(code, message);
};

/* ============================================================================ the contract */

export const STAGE_ID_PATTERN = /^[0-9]{2}-[a-z0-9-]+$/;
/** The section, and the two anchors inside it. Matched as whole lines, never as substrings. */
export const INTAKE_HEADING = "## Intake";
export const ANSWERS_HEADING = "### Recorded answers";
export const READING_HEADING = "### Kiln's reading";
export const INTAKE_PLACEHOLDER = "_Nothing recorded yet._";
export const WORKING_NOTES_HEADING = "## Working notes";
export const WORKING_NOTES_PLACEHOLDER = "_No stage-specific narrative has been recorded._";
const MIN_FENCE = 3;
const WORKING_NOTE_MARKER = /^\[kiln-working-note name=([a-z0-9][a-z0-9-]{0,63}) revision=([1-9][0-9]*) units=(0|[1-9][0-9]*)\]: #$/;
const WORKING_NOTE_END = "[/kiln-working-note]: #";
const LEGACY_WORKING_NOTES_PLACEHOLDER = "_Nothing yet._";

/** The section the writer owns, as the initializer generates it. */
export function intakeSection() {
  return [
    INTAKE_HEADING,
    "",
    "Kiln writes this section through `kiln_write_stage_document`. The two headings below are",
    "anchors, and the region under each one is Kiln's to write: rename one, or write prose of your",
    "own between the entries, and the next write is refused rather than guessed at.",
    "",
    ANSWERS_HEADING,
    "",
    INTAKE_PLACEHOLDER,
    "",
    READING_HEADING,
    "",
    INTAKE_PLACEHOLDER,
    "",
  ].join("\n");
}

const ANSWER_LABEL = /^\*\*A([1-9][0-9]*)\*\*$/;
const READING_LABEL = /^\*\*A([1-9][0-9]*)\*\* (.+)$/;
const FENCE_LINE = /^(`{3,})text kiln=A([1-9][0-9]*) units=(0|[1-9][0-9]*) fence=([1-9][0-9]*)$/;

/* ============================================================================ the parse */

/**
 * A cursor over the document's lines that can also skip a measured span of raw text.
 *
 * ⚠️ `next()` never includes the newline, and `at` is always the index of the start of the next line, so a
 * caller can record where a region begins without re-scanning.
 */
class Cursor {
  constructor(text) {
    this.text = text;
    this.at = 0;
  }
  get done() {
    return this.at >= this.text.length;
  }
  next() {
    const end = this.text.indexOf("\n", this.at);
    const line = end === -1 ? this.text.slice(this.at) : this.text.slice(this.at, end);
    this.at = end === -1 ? this.text.length : end + 1;
    return line;
  }
}

/**
 * The intake section, parsed sequentially from the top of the document.
 *
 * @returns {{answers: Array<{label: number, text: string}>, readings: Array<{label: number, text: string}>,
 *            answersEnd: number, readingsEnd: number, answersPlaceholder: ?{start: number, end: number},
 *            readingsPlaceholder: ?{start: number, end: number}, lastReadingEnd: ?number,
 *            intakeStart: number, intakeEnd: number}}
 */
export function parseIntakeSection(text) {
  const cursor = new Cursor(text);

  // The preamble holds no payloads, so reading it line by line is safe.
  let found = false;
  let intakeStart = null;
  while (!cursor.done) {
    const start = cursor.at;
    if (cursor.next() === INTAKE_HEADING) {
      intakeStart = start;
      found = true;
      break;
    }
  }
  if (!found) refuse(STAGE_DOCUMENT_REFUSAL.ANCHOR_MISSING, `This stage document has no \`${INTAKE_HEADING}\` section.`);

  found = false;
  while (!cursor.done) {
    const line = cursor.next();
    if (line === ANSWERS_HEADING) {
      found = true;
      break;
    }
    if (line.startsWith("## "))
      refuse(STAGE_DOCUMENT_REFUSAL.ANCHOR_MISSING, `The \`${INTAKE_HEADING}\` section ends before \`${ANSWERS_HEADING}\`.`);
  }
  if (!found) refuse(STAGE_DOCUMENT_REFUSAL.ANCHOR_MISSING, `This stage document has no \`${ANSWERS_HEADING}\` heading.`);

  const answers = [];
  let answersPlaceholder = null;
  let answersEnd = null;
  for (;;) {
    if (cursor.done) refuse(STAGE_DOCUMENT_REFUSAL.ANCHOR_MISSING, `This stage document has no \`${READING_HEADING}\` heading.`);
    const start = cursor.at;
    const line = cursor.next();
    if (line === READING_HEADING) {
      answersEnd = start;
      break;
    }
    if (line === "") continue;
    // ⚠️ A HEADING HERE MEANS THE SIBLING ANCHOR IS GONE, not that somebody wrote prose. Saying so names the
    // thing that has to be put back.
    if (line.startsWith("#"))
      refuse(STAGE_DOCUMENT_REFUSAL.ANCHOR_MISSING, `\`${ANSWERS_HEADING}\` is not followed by \`${READING_HEADING}\`.`);
    if (line === INTAKE_PLACEHOLDER) {
      if (answersPlaceholder || answers.length)
        refuse(STAGE_DOCUMENT_REFUSAL.FRAME_INVALID, `\`${ANSWERS_HEADING}\` holds a placeholder beside recorded answers.`);
      answersPlaceholder = { start, end: cursor.at };
      continue;
    }
    const label = ANSWER_LABEL.exec(line);
    if (!label)
      refuse(
        STAGE_DOCUMENT_REFUSAL.FRAME_INVALID,
        `\`${ANSWERS_HEADING}\` holds a line Kiln did not write. This region is written by \`kiln_write_stage_document\`.`
      );
    answers.push(readAnswerEntry(cursor, Number(label[1])));
  }

  const readings = [];
  let readingsPlaceholder = null;
  let readingsEnd = null;
  let lastReadingEnd = null;
  for (;;) {
    if (cursor.done) {
      readingsEnd = cursor.at;
      break;
    }
    const start = cursor.at;
    const line = cursor.next();
    if (line.startsWith("## ")) {
      readingsEnd = start;
      break;
    }
    if (line === "") continue;
    if (line === INTAKE_PLACEHOLDER) {
      if (readingsPlaceholder || readings.length)
        refuse(STAGE_DOCUMENT_REFUSAL.FRAME_INVALID, `\`${READING_HEADING}\` holds a placeholder beside recorded readings.`);
      readingsPlaceholder = { start, end: cursor.at };
      continue;
    }
    const entry = READING_LABEL.exec(line);
    if (!entry)
      refuse(
        STAGE_DOCUMENT_REFUSAL.FRAME_INVALID,
        `\`${READING_HEADING}\` holds a line Kiln did not write. This region is written by \`kiln_write_stage_document\`.`
      );
    readings.push({ label: Number(entry[1]), text: unescapeReading(entry[2]) });
    lastReadingEnd = cursor.at;
  }

  // ⚠️ EXACTLY A1..An IN BOTH REGIONS. The next label is this sequence's length plus one; it is never the
  // highest number the document happens to contain, which is a quantity a payload could raise.
  // ⚠️ A PLACEHOLDER MEANS THE REGION IS EMPTY, so one beside an entry is a document two things have edited.
  if (answersPlaceholder && answers.length)
    refuse(STAGE_DOCUMENT_REFUSAL.FRAME_INVALID, `\`${ANSWERS_HEADING}\` holds a placeholder beside recorded answers.`);
  if (readingsPlaceholder && readings.length)
    refuse(STAGE_DOCUMENT_REFUSAL.FRAME_INVALID, `\`${READING_HEADING}\` holds a placeholder beside recorded readings.`);

  sequential(answers, ANSWERS_HEADING);
  sequential(readings, READING_HEADING);
  if (answers.length !== readings.length)
    refuse(
      STAGE_DOCUMENT_REFUSAL.ENTRIES_INVALID,
      `The intake section holds ${answers.length} answer(s) and ${readings.length} reading(s). Each answer has exactly one reading.`
    );

  return { answers, readings, answersEnd, readingsEnd, answersPlaceholder, readingsPlaceholder, lastReadingEnd, intakeStart, intakeEnd: readingsEnd };
}

function sequential(entries, heading) {
  for (let i = 0; i < entries.length; i++)
    if (entries[i].label !== i + 1)
      refuse(
        STAGE_DOCUMENT_REFUSAL.ENTRIES_INVALID,
        `\`${heading}\` is labelled A${entries[i].label} where A${i + 1} was expected. Entries run A1 upwards with no gap.`
      );
}

/**
 * One recorded answer, read by measure.
 *
 * ⚠️ **THE PAYLOAD IS SKIPPED, NOT SEARCHED.** `units` is authoritative: the closing fence is verified
 * where the measure says it is, and a fence anywhere else is payload.
 */
function readAnswerEntry(cursor, label) {
  if (cursor.next() !== "")
    refuse(STAGE_DOCUMENT_REFUSAL.FRAME_INVALID, `A${label} is not followed by the blank line its frame requires.`);

  const framed = FENCE_LINE.exec(cursor.next());
  if (!framed) refuse(STAGE_DOCUMENT_REFUSAL.FRAME_INVALID, `A${label} has no frame line.`);
  const [, ticks, framedLabel, units, declared] = framed;
  if (Number(framedLabel) !== label) refuse(STAGE_DOCUMENT_REFUSAL.FRAME_INVALID, `A${label}'s frame declares A${framedLabel}.`);
  if (ticks.length !== Number(declared))
    refuse(STAGE_DOCUMENT_REFUSAL.FRAME_INVALID, `A${label}'s frame declares a fence length its fence does not have.`);

  const start = cursor.at;
  const end = start + Number(units);
  if (end > cursor.text.length) refuse(STAGE_DOCUMENT_REFUSAL.FRAME_INVALID, `A${label} is measured past the end of the document.`);
  const text = cursor.text.slice(start, end);
  if (cursor.text[end] !== "\n") refuse(STAGE_DOCUMENT_REFUSAL.FRAME_INVALID, `A${label} is not closed where its measure ends.`);
  cursor.at = end + 1;
  if (cursor.next() !== ticks) refuse(STAGE_DOCUMENT_REFUSAL.FRAME_INVALID, `A${label} is not closed by the fence it opened with.`);
  return { label, text };
}

/* ============================================================================ the write */

/** The longest run of backticks anywhere in the text, so the fence can be made longer than all of them. */
function longestBacktickRun(text) {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    run = ch === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/**
 * Kiln's own words, made safe for a restricted-MDX compile (DEC-0020).
 *
 * ⚠️ **ESCAPED, WHERE THE OPERATOR'S WORDING IS FENCED.** This text is Kiln's, so altering its punctuation
 * costs nothing; the operator's is stored exactly as supplied. A line break is refused rather than escaped,
 * which is what makes a forged heading or fence impossible in this region.
 */
const escapeReading = (text) => text.replace(/[\\`{}<>]/g, (ch) => `\\${ch}`);
/** Its inverse, so a parse returns what was written rather than what the document had to store. */
const unescapeReading = (text) => text.replace(/\\([\\`{}<>])/g, "$1");

function entryBlock(label, verbatim) {
  const fence = "`".repeat(Math.max(MIN_FENCE, longestBacktickRun(verbatim) + 1));
  return (
    `**A${label}**\n\n` +
    `${fence}text kiln=A${label} units=${verbatim.length} fence=${fence.length}\n` +
    `${verbatim}\n${fence}\n`
  );
}

const splice = (text, start, end, insert) => text.slice(0, start) + insert + text.slice(end);

function assertRequest(stageId, verbatim, interpretation) {
  if (typeof stageId !== "string" || !STAGE_ID_PATTERN.test(stageId))
    refuse(STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, "`stage` must be a stage id such as 01-intake.");
  if (typeof verbatim !== "string" || verbatim.length === 0)
    refuse(STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, "`verbatim` must be the operator's own words, as a non-empty string.");
  if (typeof interpretation !== "string" || interpretation.trim().length === 0)
    refuse(STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, "`interpretation` must say what Kiln took from the answer.");
  if (/[\n\r]/.test(interpretation))
    refuse(STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, "`interpretation` is one line. Summarise it, or record several entries.");
}

function stageDocumentPath(contentRoot, stageId) {
  try {
    return resolveInContentRoot(`stages/${stageId}.md`, { contentRoot });
  } catch (cause) {
    if (cause instanceof PathEscapeError)
      refuse(STAGE_DOCUMENT_REFUSAL.OUTSIDE_ROOT, "This stage's document is not inside the project's planning content.");
    throw cause;
  }
}

function readStageText(contentRoot, stageId) {
  const path = stageDocumentPath(contentRoot, stageId);
  try {
    // `stageDocumentPath` has already proved canonical containment in the content root. The marker
    // prevents build-time tracing and does not weaken that runtime boundary.
    return { path, text: readFileSync(/* turbopackIgnore: true */ path, "utf8") };
  } catch (cause) {
    const missing = cause?.code === "ENOENT" || cause?.code === "ENOTDIR";
    refuse(
      missing ? STAGE_DOCUMENT_REFUSAL.MISSING : STAGE_DOCUMENT_REFUSAL.UNREADABLE,
      missing ? `This project has no document for stage ${stageId}.` : "This stage's document could not be read."
    );
  }
}

/**
 * How long a stage-document rename is retried: 5 ms × (1 + … + 28), about two seconds.
 *
 * ⚠️ **THIS WRITER'S BUDGET, NOT THE ATOMIC WRITER'S DEFAULT (#179).** A stage document is the file another program
 * is most likely to have open: an editor, a renderer, an indexer. Measured on Windows, a process reading one in a
 * loop exhausted the default budget of about 275 ms in 3 writes of 10.
 */
const STAGE_RENAME_ATTEMPTS = 28;

/**
 * Each retry is moved off the system timer tick by up to this many milliseconds.
 *
 * ⚠️ **WITHOUT THIS THE LONGER BUDGET DOES NOT HELP (#179).** A retry wakes from a timer, and on Windows timers fire
 * on a shared tick. A reader that opens the document on a timer of its own, as a polling watcher does, wakes on the
 * same tick, so every retry meets it again. Measured over 60 writes beside a reader opening the file every 2 ms:
 * 10 failed with the two-second budget alone, and none with the retries taken off the tick.
 */
const STAGE_RENAME_JITTER_MS = 3;

const WRITE_REFUSALS = Object.freeze({
  [STAGE_DOCUMENT_REFUSAL.LOCK_TIMEOUT]: [
    "Another Kiln write held this project's content lock for the whole 10-second wait. Nothing was written.",
    "Retry once. If it times out again, tell the operator that another Kiln process may be writing to this project.",
  ],
  [STAGE_DOCUMENT_REFUSAL.WRITE_CANCELLED]: ["The write was cancelled before it was committed. Nothing was written.", "Retry only if the operator asks for it."],
  [STAGE_DOCUMENT_REFUSAL.WRITE_CONTENDED]: [
    "Another program had this stage's document open, and it could not be replaced within about two seconds. Nothing was written.",
    "Read the working notes again, then retry once. If it repeats, ask the operator to close whatever has the document open.",
  ],
  [STAGE_DOCUMENT_REFUSAL.WRITE_FAILED]: ["This stage's document could not be written. Nothing was written.", "Tell the operator. Do not retry in a loop."],
});

/**
 * Run `body` under the content lock, with a cancellable wait and a cancellable, bounded write - #179.
 *
 * ⚠️ **CANCELLATION REACHES THE LOCK AND THE WRITER; NOTHING RACES THEM FROM OUTSIDE.** A timer or a signal raced
 * against this from the caller could report a failure while the write went on to commit. So the signal is handed
 * to the two places that can act on it: the lock's wait, and the atomic writer up to its rename. After the rename
 * the document is written and this returns success, whatever the signal says by then.
 *
 * ⚠️ **EVERY FAILURE OF THE WRITE IS ONE OF FOUR CODES, WITH RELATIVE PATHS AND FIXED WORDS.** The lock's and the
 * writer's own messages carry an absolute path, a process id, a host name and the filesystem's error. None of
 * that is returned.
 *
 * @param {(write: (path: string, text: string) => Promise<unknown>) => Promise<T>} body
 * @template T
 */
async function underContentLock(contentRoot, stageId, { signal = null, onLockWait = null, lock = {} } = {}, body) {
  const [{ LOCK_FILE }, { withLock, LockError, LOCK_REFUSAL }, { atomicWrite, AtomicWriteError, ATOMIC_WRITE_REFUSAL }] = await Promise.all([
    import("./tools/create-artifact.mjs"),
    import("./lock.mjs"),
    import("./atomic-write.mjs"),
  ]);
  const refusal = (code) => new StageDocumentRefusal(code, WRITE_REFUSALS[code][0], { path: `stages/${stageId}.md`, lock: LOCK_FILE, retry: WRITE_REFUSALS[code][1] });

  if (signal?.aborted) throw refusal(STAGE_DOCUMENT_REFUSAL.WRITE_CANCELLED);
  try {
    return await withLock(
      join(contentRoot, LOCK_FILE),
      () => body((path, text) => atomicWrite(path, text, { signal, maxAttempts: STAGE_RENAME_ATTEMPTS, retryJitterMs: STAGE_RENAME_JITTER_MS })),
      { ...lock, signal, onWaiting: onLockWait }
    );
  } catch (cause) {
    if (cause instanceof StageDocumentRefusal) throw cause;
    if (cause instanceof LockError)
      throw refusal(
        cause.code === LOCK_REFUSAL.TIMEOUT ? STAGE_DOCUMENT_REFUSAL.LOCK_TIMEOUT : cause.code === LOCK_REFUSAL.CANCELLED ? STAGE_DOCUMENT_REFUSAL.WRITE_CANCELLED : STAGE_DOCUMENT_REFUSAL.WRITE_FAILED
      );
    if (cause instanceof AtomicWriteError)
      throw refusal(
        cause.code === ATOMIC_WRITE_REFUSAL.CANCELLED ? STAGE_DOCUMENT_REFUSAL.WRITE_CANCELLED : cause.code === ATOMIC_WRITE_REFUSAL.CONTENDED ? STAGE_DOCUMENT_REFUSAL.WRITE_CONTENDED : STAGE_DOCUMENT_REFUSAL.WRITE_FAILED
      );
    // The filesystem's own error, from filling the temporary file: a code such as ENOSPC and a message with a path.
    if (typeof cause?.code === "string" && /^E[A-Z0-9]+$/.test(cause.code) && typeof cause?.syscall === "string") throw refusal(STAGE_DOCUMENT_REFUSAL.WRITE_FAILED);
    throw cause;
  }
}

const documentRevision = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/** Parse only the explicitly agent-owned Working notes region. */
export function parseWorkingNotes(text) {
  const cursor = new Cursor(text);
  let found = false;
  let workingNotesStart = null;
  while (!cursor.done) {
    const start = cursor.at;
    if (cursor.next() === WORKING_NOTES_HEADING) {
      workingNotesStart = start;
      found = true;
      break;
    }
  }
  if (!found) refuse(STAGE_DOCUMENT_REFUSAL.ANCHOR_MISSING, `This stage document has no \`${WORKING_NOTES_HEADING}\` section.`);

  const regionStart = cursor.at;
  const subsections = [];
  let placeholder = null;
  let regionEnd = cursor.at;
  for (;;) {
    if (cursor.done) {
      regionEnd = cursor.at;
      break;
    }
    const start = cursor.at;
    const line = cursor.next();
    if (line.startsWith("## ")) {
      regionEnd = start;
      break;
    }
    if (line === "") continue;
    if (line === WORKING_NOTES_PLACEHOLDER || line === LEGACY_WORKING_NOTES_PLACEHOLDER) {
      if (placeholder || subsections.length)
        refuse(STAGE_DOCUMENT_REFUSAL.WORKING_NOTES_INVALID, `\`${WORKING_NOTES_HEADING}\` holds a placeholder beside authored notes.`);
      placeholder = { start, end: cursor.at };
      continue;
    }

    const marker = WORKING_NOTE_MARKER.exec(line);
    if (!marker)
      refuse(
        STAGE_DOCUMENT_REFUSAL.WORKING_NOTES_INVALID,
        `\`${WORKING_NOTES_HEADING}\` holds content not framed by \`kiln_write_stage_document\`.`
      );
    const [, name, revision, units] = marker;
    const bodyStart = cursor.at;
    const bodyEnd = bodyStart + Number(units);
    if (bodyEnd > text.length) refuse(STAGE_DOCUMENT_REFUSAL.WORKING_NOTES_INVALID, `Working-note subsection \`${name}\` is measured past the document.`);
    const body = text.slice(bodyStart, bodyEnd);
    cursor.at = bodyEnd;
    if (cursor.next() !== WORKING_NOTE_END)
      refuse(STAGE_DOCUMENT_REFUSAL.WORKING_NOTES_INVALID, `Working-note subsection \`${name}\` does not close where its measure ends.`);

    const headingEnd = body.indexOf("\n");
    const heading = headingEnd === -1 ? body : body.slice(0, headingEnd);
    if (!heading.startsWith("### ") || body.slice(headingEnd, headingEnd + 2) !== "\n\n" || !body.endsWith("\n\n"))
      refuse(STAGE_DOCUMENT_REFUSAL.WORKING_NOTES_INVALID, `Working-note subsection \`${name}\` has an invalid frame.`);
    const content = body.slice(headingEnd + 2, -2);
    subsections.push({ name, title: heading.slice(4), revision: Number(revision), content, start, end: cursor.at });
  }

  const names = new Set();
  for (const subsection of subsections) {
    if (names.has(subsection.name))
      refuse(STAGE_DOCUMENT_REFUSAL.WORKING_NOTES_INVALID, `Working-note subsection \`${subsection.name}\` appears more than once.`);
    names.add(subsection.name);
  }
  return { subsections, placeholder, regionStart, regionEnd, workingNotesStart };
}

function assertWorkingNotesRequest(stageId, { action, subsection, title, content, expectedRevision } = {}) {
  if (typeof stageId !== "string" || !STAGE_ID_PATTERN.test(stageId))
    refuse(STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, "`stage` must be a stage id such as 06-risk-feasibility.");
  if (!new Set(["append-working-note", "replace-working-note"]).has(action))
    refuse(STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, "`action` must append or replace a working-note subsection.");
  if (typeof subsection !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(subsection))
    refuse(STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, "`subsection` must be a lowercase kebab-case name of at most 64 characters.");
  if (typeof title !== "string" || title.trim() !== title || title.length === 0 || title.length > 120 || /[\r\n]/.test(title))
    refuse(STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, "`title` must be one non-empty line of at most 120 characters.");
  if (/[{}<>]/.test(title))
    refuse(STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, "`title` must be plain Markdown text without executable MDX.");
  if (typeof content !== "string" || content.trim().length === 0)
    refuse(STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, "`content` must be non-empty Markdown.");
  if (/^#{1,2}\s/m.test(content) || /(^|\n)\s*(?:import|export)\s/m.test(content) || /[{}]/.test(content) || /<[A-Za-z/]/.test(content))
    refuse(
      STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST,
      "`content` may contain Markdown tables, lists, links and citations, but not level-one/two headings or executable MDX."
    );
  if (typeof expectedRevision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(expectedRevision))
    refuse(STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, "`expectedRevision` must be the revision returned by read-working-notes.");
}

function workingNoteBlock(name, title, revision, content) {
  const body = `### ${title}\n\n${content}\n\n`;
  return `[kiln-working-note name=${name} revision=${revision} units=${body.length}]: #\n${body}${WORKING_NOTE_END}\n`;
}

/** Read the authored notes and the optimistic-concurrency token needed by a write. */
export function readWorkingNotes(contentRoot, stageId) {
  if (typeof stageId !== "string" || !STAGE_ID_PATTERN.test(stageId))
    refuse(STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, "`stage` must be a stage id such as 06-risk-feasibility.");
  const { path, text } = readStageText(contentRoot, stageId);
  const parsed = parseWorkingNotes(text);
  return { stageId, path, revision: documentRevision(text), subsections: parsed.subsections.map(({ name, title, revision, content }) => ({ name, title, revision, content })) };
}

/**
 * Append or replace one named, length-framed subsection under Working notes.
 *
 * `opts.lock` is passed to `withLock`; `opts.dryRun` runs every check and writes nothing. `opts.signal` cancels the
 * write up to its commit point, and `opts.onLockWait` is called once if the content lock is contended for a second.
 */
export async function writeWorkingNotes(contentRoot, stageId, request = {}, opts = {}) {
  assertWorkingNotesRequest(stageId, request);

  return underContentLock(contentRoot, stageId, opts, async (write) => {
    const { path, text } = readStageText(contentRoot, stageId);
    const currentRevision = documentRevision(text);
    if (request.expectedRevision !== currentRevision)
      refuse(
        STAGE_DOCUMENT_REFUSAL.REVISION_CONFLICT,
        "The stage document changed after it was read. Read working notes again, then retry with the new revision."
      );

    const parsed = parseWorkingNotes(text);
    const existing = parsed.subsections.find((entry) => entry.name === request.subsection);
    if (request.action === "append-working-note" && existing)
      refuse(STAGE_DOCUMENT_REFUSAL.SUBSECTION_EXISTS, `Working-note subsection \`${request.subsection}\` already exists; replace it explicitly.`);
    if (request.action === "replace-working-note" && !existing)
      refuse(STAGE_DOCUMENT_REFUSAL.SUBSECTION_MISSING, `Working-note subsection \`${request.subsection}\` does not exist; append it explicitly.`);

    const subsectionRevision = (existing?.revision ?? 0) + 1;
    const block = workingNoteBlock(request.subsection, request.title, subsectionRevision, request.content);
    let next;
    if (existing) next = splice(text, existing.start, existing.end, block);
    else if (parsed.placeholder) next = splice(text, parsed.placeholder.start, parsed.placeholder.end, block);
    else next = splice(text, parsed.regionEnd, parsed.regionEnd, `${block}\n`);

    if (!opts.dryRun) await write(path, next);
    return {
      stageId,
      path,
      action: request.action,
      subsection: request.subsection,
      subsectionRevision,
      revision: documentRevision(next),
    };
  });
}

/**
 * Record one answer and Kiln's reading of it, as the next entry in both regions.
 *
 * Lock (#78), fresh read inside it, every check before any write, atomic write (#72). A refusal at any
 * point leaves the document exactly as it was.
 *
 * `opts.signal` and `opts.onLockWait` are as for `writeWorkingNotes`.
 *
 * @returns {{stageId: string, path: string, entry: string}}
 */
export async function writeStageDocumentEntry(contentRoot, stageId, { verbatim, interpretation } = {}, opts = {}) {
  assertRequest(stageId, verbatim, interpretation);

  return underContentLock(contentRoot, stageId, opts, async (write) => {
    const { path, text } = readStageText(contentRoot, stageId);

    const section = parseIntakeSection(text);
    const label = section.answers.length + 1;

    // ⚠️ THE READING IS SPLICED FIRST, because both indices come from the same parse and the answer's
    // splice is further up the document. Doing it the other way round would invalidate the second index.
    const reading = `**A${label}** ${escapeReading(interpretation)}\n`;
    let next = section.readingsPlaceholder
      ? splice(text, section.readingsPlaceholder.start, section.readingsPlaceholder.end, reading)
      : section.lastReadingEnd !== null
        ? splice(text, section.lastReadingEnd, section.lastReadingEnd, reading)
        : splice(text, section.readingsEnd, section.readingsEnd, `${reading}\n`);

    const block = entryBlock(label, verbatim);
    next = section.answersPlaceholder
      ? splice(next, section.answersPlaceholder.start, section.answersPlaceholder.end, block)
      : splice(next, section.answersEnd, section.answersEnd, `${block}\n`);

    await write(path, next);
    return { stageId, path, entry: `A${label}` };
  });
}
