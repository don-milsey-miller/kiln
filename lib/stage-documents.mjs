/**
 * The intake section of a stage document, and the only writer for it (ACC-0113).
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
 *
 * ⚠️ **WHAT IS PRESERVED IS THE EXACT INPUT STRING, NOT THE OPERATOR'S ORIGINAL BYTES.** The text arrives
 * over JSON transport, which does not carry an independent byte representation. Round-tripping this module
 * returns the string that was supplied to it, code unit for code unit.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
});

export class StageDocumentRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StageDocumentRefusal";
    this.code = code;
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
const MIN_FENCE = 3;

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
 *            readingsPlaceholder: ?{start: number, end: number}, lastReadingEnd: ?number}}
 */
export function parseIntakeSection(text) {
  const cursor = new Cursor(text);

  // The preamble holds no payloads, so reading it line by line is safe.
  let found = false;
  while (!cursor.done) {
    if (cursor.next() === INTAKE_HEADING) {
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

  return { answers, readings, answersEnd, readingsEnd, answersPlaceholder, readingsPlaceholder, lastReadingEnd };
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

/**
 * Record one answer and Kiln's reading of it, as the next entry in both regions.
 *
 * Lock (#78), fresh read inside it, every check before any write, atomic write (#72). A refusal at any
 * point leaves the document exactly as it was.
 *
 * @returns {{stageId: string, path: string, entry: string}}
 */
export async function writeStageDocumentEntry(contentRoot, stageId, { verbatim, interpretation } = {}) {
  assertRequest(stageId, verbatim, interpretation);

  const [{ LOCK_FILE }, { withLock }, { atomicWrite }] = await Promise.all([
    import("./tools/create-artifact.mjs"),
    import("./lock.mjs"),
    import("./atomic-write.mjs"),
  ]);

  return withLock(join(contentRoot, LOCK_FILE), async () => {
    const path = stageDocumentPath(contentRoot, stageId);

    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (cause) {
      const missing = cause?.code === "ENOENT" || cause?.code === "ENOTDIR";
      refuse(
        missing ? STAGE_DOCUMENT_REFUSAL.MISSING : STAGE_DOCUMENT_REFUSAL.UNREADABLE,
        missing ? `This project has no document for stage ${stageId}.` : "This stage's document could not be read."
      );
    }

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

    await atomicWrite(path, next);
    return { stageId, path, entry: `A${label}` };
  });
}
