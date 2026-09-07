/**
 * The SINGLE owner of every Kiln edit to the consumer's `.gitignore`.
 *
 * ⚠️ **BUILT-INS ONLY.** This module is imported by `initialize-project.mjs`, which runs in a
 * checkout where `npm install` has not happened yet. An import of `ajv` anywhere in this graph would
 * make the documented first run fail on `Cannot find package` — and fail AFTER the user had already
 * cloned a tool that could not introduce itself. `atomic-write.mjs` is `node:fs` and `node:path`
 * only, which is why the migration can use it.
 *
 * ⚠️ **ONE OWNER, BECAUSE TWO APPENDERS IS HOW A HAND-EDITED FILE ACQUIRES TWO KILN BLOCKS.**
 * CMP-0023 names the failure precisely: not a missing capability, but setup growing a second
 * appender with its own idempotency rules beside the initializer's. Every Kiln write to `.gitignore`
 * goes through `planIgnoreBlock` and `applyIgnoreBlock`, so the at-most-once rule is a property of
 * the code rather than of two callers agreeing.
 *
 * ⚠️ **PLAN AND APPLY ARE SEPARATE ON PURPOSE.** The initializer plans before it generates the
 * content tree and applies just before the swap, because the other order leaves a crash window in
 * which the content root exists — so every later run reports `already-initialized` and does nothing
 * — while `.planning/` was never ignored, and nothing would ever notice.
 *
 * ⚠️ **THE SCAN IS OF THE FILE'S TEXT, NOT `git check-ignore`.** Shelling out to git would be more
 * thorough — it would see a global excludes file, a parent repository's rules, and that a line
 * `.pi/` already covers `.pi/sessions/` — and it would make the answer depend on a binary being on
 * PATH in a command whose whole selling point is that it needs nothing installed. The text scan is
 * what this can honestly claim, and it is what the block-at-most-once rule actually needs. The cost
 * is bounded and in the safe direction: an operator whose own line covers a rule in a spelling this
 * does not model gets that rule written again, which git ignores, rather than not written at all.
 */

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "./atomic-write.mjs";
import { GITIGNORE_BEGIN, GITIGNORE_END, GITIGNORE_STATUS, SETUP_FILE, SETUP_VERSION } from "./project-scaffold.mjs";

export { GITIGNORE_BEGIN, GITIGNORE_END, GITIGNORE_STATUS };

/**
 * What the marked block ignores, in the order it is written (DEC-0029).
 *
 * ⚠️ **`.pi/settings.json` AND `.pi/kiln.json` ARE DELIBERATELY ABSENT.** They are reproducible,
 * non-secret project configuration and belong in a diff. Ignoring the whole of `.pi/` would have
 * been one line and would have hidden the model selection, the package entry and the skill-override
 * path — the configuration that most deserves review.
 */
export const IGNORE_RULES = Object.freeze([".planning/", ".pi/sessions/", ".pi/runtime/"]);

/**
 * Block interiors earlier versions of Kiln wrote, newest first.
 *
 * ⚠️ **AN EXACT LIST, NOT A PATTERN.** Migration REPLACES bytes rather than appending them, so the
 * question it has to answer is "is this block untouched Kiln output" — and only an exact match
 * answers that. A pattern that accepted anything block-shaped would eventually accept a block an
 * operator had edited, and rewriting one of those is the defect this whole component exists to
 * prevent.
 */
export const LEGACY_RULE_SETS = Object.freeze([Object.freeze([".planning/"])]);

/** What `planIgnoreBlock` OBSERVED. Not what it will do — that is `action`. */
export const IGNORE_STATE = Object.freeze({
  NOT_A_REPOSITORY: "not-a-git-repository",
  ABSENT: "absent",
  CURRENT: "current",
  LEGACY: "legacy",
  ALREADY_COVERED: "already-covered",
  EDITED: "edited",
  REMOVED: "removed",
  MALFORMED: "malformed",
});

/** What `applyIgnoreBlock` will do about it. */
export const IGNORE_ACTION = Object.freeze({
  NONE: "none",
  CREATE: "create",
  APPEND: "append",
  MIGRATE: "migrate",
  REPORT: "report",
});

/** The two answers an operator may give to a reported block. There is deliberately no third. */
export const IGNORE_CHOICE = Object.freeze({ KEEP: "keep", REWRITE: "rewrite" });

export class IgnoreRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "IgnoreRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ reading the file */

/**
 * The spellings git treats as equivalent for a directory rule.
 *
 * ⚠️ **A NEGATION IS NOT ONE OF THEM, AND IS TRACKED SEPARATELY.** `!.planning/` re-includes what an
 * earlier line ignored. Counting it as coverage because it contains the same path would report a
 * tracked directory as protected, which is the one error the coverage-before-data rule cannot
 * tolerate.
 */
export function ruleSpellings(rule) {
  const bare = rule.replace(/\/$/, "");
  return new Set([bare, `${bare}/`, `/${bare}`, `/${bare}/`]);
}

const SPELLINGS = new Map(IGNORE_RULES.map((r) => [r, ruleSpellings(r)]));

/**
 * Split `text` into lines that remember where they started and which line ending they carried.
 *
 * The offsets are what make a byte-preserving splice possible: replacing a block means knowing
 * exactly which bytes are the block and leaving every other byte alone.
 */
function scanLines(text) {
  const lines = [];
  let offset = 0;
  for (const raw of text.split("\n")) {
    const hasCr = raw.endsWith("\r");
    const body = hasCr ? raw.slice(0, -1) : raw;
    lines.push({ body, trimmed: body.trim(), start: offset, eol: hasCr ? "\r\n" : "\n" });
    offset += raw.length + 1; // the "\n" the split consumed
  }
  return lines;
}

/**
 * Locate Kiln's marked block.
 *
 * ⚠️ **UNPAIRED OR REPEATED MARKERS ARE `malformed`, NOT "the first one".** Picking a block out of a
 * file with two begin markers means writing over bytes between markers this function chose by
 * position. Whatever produced that file — a merge conflict resolved by hand, two Kilns from before
 * this component existed — the operator has to look at it.
 *
 * @returns {null | {malformed: string} | {start: number, end: number, eol: string, interior: string[]}}
 */
export function findBlock(text) {
  const lines = scanLines(text);
  const begins = [];
  const ends = [];
  for (const [i, l] of lines.entries()) {
    if (l.trimmed === GITIGNORE_BEGIN) begins.push(i);
    if (l.trimmed === GITIGNORE_END) ends.push(i);
  }

  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1)
    return {
      malformed:
        `${begins.length} begin marker(s) and ${ends.length} end marker(s); exactly one of each is a block`,
    };
  if (ends[0] < begins[0]) return { malformed: "the end marker precedes the begin marker" };

  const first = lines[begins[0]];
  const last = lines[ends[0]];
  const trailingNewline = !(ends[0] === lines.length - 1 && !text.endsWith("\n"));
  // ⚠️ THE TRAILING NEWLINE IS PART OF THE BLOCK, so a replacement neither eats the byte that
  // separates the block from what follows nor adds a second one. The exception is an end marker that
  // is the file's last line with no newline after it: there is no byte there to include.
  const end = last.start + last.body.length + (trailingNewline ? last.eol.length : 0);
  return {
    start: first.start,
    end,
    eol: first.eol,
    trailingNewline,
    // ⚠️ **`raw` IS THE BYTES; `interior` IS THE READING OF THEM.** Everything that only has to
    // RECOGNISE a block uses `interior`, which is trimmed and therefore tolerant. Everything that
    // OVERWRITES a block compares `raw`, because "this is untouched Kiln output" is a claim about
    // bytes and a trimmed comparison cannot make it — see `matchesExactly`.
    raw: text.slice(first.start, end),
    interior: lines.slice(begins[0] + 1, ends[0]).map((l) => l.trimmed),
  };
}

/**
 * Is this block byte-for-byte the block Kiln would have written for `rules`?
 *
 * ⚠️ **THE ONLY TEST ALLOWED TO AUTHORISE AN OVERWRITE.** Migration replaces bytes rather than
 * appending them, so the question it must answer is not "does this look like Kiln's block" but "is
 * this block, byte for byte, output nobody has touched". A trimmed comparison answers the first
 * question and reads as if it answered the second: a block whose rule line an operator had indented,
 * or whose marker carries a trailing space, compares equal and gets silently overwritten. Their edit
 * is the very signal that it is not Kiln's to replace.
 *
 * The one tolerance is a block that ends the file with its final newline stripped — by an editor, or
 * by a tool that trims trailing whitespace. Those bytes were not authored, and `findBlock` has
 * already excluded them from the block's extent, so the splice puts back exactly what it found.
 */
function matchesExactly(block, rules) {
  return block.raw === blockText(block.eol, rules);
}

/**
 * The block to write in place of `block`: Kiln's text, ending exactly as the block it replaces ended.
 *
 * ⚠️ **A FILE WHOSE LAST BYTE WAS NOT A NEWLINE MUST NOT ACQUIRE ONE.** Always appending the line
 * ending adds a byte outside the markers, which is precisely what "every byte outside the markers is
 * preserved" forbids, and it is a diff on a file the operator did not ask to have tidied.
 *
 * ⚠️ **THIS TOLERANCE BELONGS TO THE WRITE, NOT TO THE RECOGNITION, and the difference is the whole
 * argument.** An earlier version had `matchesExactly` defer to this function, so a legacy block whose
 * final newline something had stripped counted as untouched Kiln output and migrated automatically.
 * That is a defensible engineering call and it is not what ACC-0046 says: "an exact unmodified legacy
 * block" admits no normalisation, and a block missing a byte Kiln wrote is modified. So recognition is
 * strict — such a block is `edited`, and reported — while the splice still preserves the file's ending
 * when the operator explicitly asks for a rewrite. Migration is automatic and must match the criterion
 * exactly; a rewrite was asked for, and there the only duty is not to tidy anything unasked.
 */
function spliceText(block, rules) {
  const text = blockText(block.eol, rules);
  return block.trailingNewline ? text : text.slice(0, -block.eol.length);
}

/**
 * Which of `IGNORE_RULES` the file covers OUTSIDE Kiln's block, and which the block itself covers.
 *
 * Splitting the two is what lets an appended block carry only the rules nobody has written yet: a
 * project that already ignores `.planning/` by the operator's own hand gets `.pi/sessions/` and
 * `.pi/runtime/`, and never a second `.planning/`.
 */
export function coverage(text, block = findBlock(text)) {
  const inBlock = new Set();
  const inFile = new Set();
  const negated = new Set();
  const region = block && !block.malformed ? [block.start, block.end] : null;

  for (const line of scanLines(text)) {
    const { trimmed, start } = line;
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const negation = trimmed.startsWith("!");
    const path = negation ? trimmed.slice(1).trim() : trimmed;
    for (const [rule, spellings] of SPELLINGS) {
      if (!spellings.has(path)) continue;
      if (negation) {
        negated.add(rule);
        continue;
      }
      if (region && start >= region[0] && start < region[1]) inBlock.add(rule);
      else inFile.add(rule);
    }
  }

  // ⚠️ A NEGATION TAKES COVERAGE AWAY, whichever side of the block it is on. Reporting coverage that
  // a `!` line has revoked is how runtime data ends up in a tracked directory.
  for (const rule of negated) {
    inBlock.delete(rule);
    inFile.delete(rule);
  }
  return {
    inBlock,
    inFile,
    negated,
    uncovered: IGNORE_RULES.filter((r) => !inBlock.has(r) && !inFile.has(r)),
  };
}

/** The marked block, with the line ending the target file already uses. */
export function blockText(eol = "\n", rules = IGNORE_RULES) {
  return [GITIGNORE_BEGIN, ...rules, GITIGNORE_END].join(eol) + eol;
}

const sameRules = (a, b) => a.length === b.length && a.every((r, i) => r === b[i]);

/* ------------------------------------------------------------------ the record */

/**
 * What `state/setup.json` says Kiln last did to the ignore file, or `null` if there is nothing
 * readable to say.
 *
 * ⚠️ **A NARROWER QUESTION THAN `readSetupRecord`'s, DELIBERATELY.** The initializer's reader decides
 * whether a content root is a working Kiln project, and distinguishes unreadable from unsupported
 * because it refuses on the difference. This one asks only what the last recorded ignore step was,
 * and treats every unreadable answer as "nothing recorded" — which is the safe reading, since an
 * absent record makes a missing block `absent` rather than `removed`, and `absent` writes a block
 * where `removed` refuses to.
 */
export function readRecordedIgnoreStep(contentRoot) {
  try {
    const record = JSON.parse(readFileSync(join(contentRoot, ...SETUP_FILE.split("/")), "utf-8"));
    if (record?.setupVersion !== SETUP_VERSION) return null;
    const step = record?.steps?.gitignore;
    return typeof step === "string" ? step : null;
  } catch {
    return null;
  }
}

/**
 * Record what the ignore owner did, so a later run can tell a block the operator removed from one
 * that was never added.
 *
 * ⚠️ **READ-MODIFY-WRITE PRESERVING EVERY OTHER KEY, and byte-identical to what `buildScaffold`
 * would generate for the same status.** Drift detection rebuilds the reference scaffold FROM this
 * field, so a record written with different spacing or key order would report the file it had just
 * written as modified.
 */
export async function recordIgnoreStep(contentRoot, status) {
  if (!Object.values(GITIGNORE_STATUS).includes(status))
    throw new IgnoreRefusal("unknown-status", `Refusing to record unknown ignore status ${JSON.stringify(status)}.`);

  const path = join(contentRoot, ...SETUP_FILE.split("/"));
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new IgnoreRefusal(
      "record-unreadable",
      `${path} cannot be read as a setup record (${e.message}), so what Kiln did to .gitignore cannot ` +
        `be recorded. The write to .gitignore already happened; restore the record from Git rather than ` +
        `letting a later run conclude the block was never added.`,
      { path }
    );
  }
  const previous = typeof record?.steps?.gitignore === "string" ? record.steps.gitignore : null;
  if (previous === status) return { path, changed: false, status, previous };

  // ⚠️ **THE ONE QUESTION THIS FIELD ANSWERS IS "HAS KILN EVER PUT A BLOCK IN THIS FILE?", AND A
  // REPORT MUST NOT ERASE A YES.** `added` and `migrated` are what make a later run classify a missing
  // block as `removed` rather than `absent` — the difference between reporting a deliberate deletion
  // and silently undoing it. Writing `needs-attention` over one of them would destroy exactly that
  // signal, and the next run would restore the block the operator had removed: the defect this whole
  // component exists to prevent, arriving through the mechanism meant to prevent it. So a report is
  // recorded only where nothing yet claims a block was written — which is where it is also the honest
  // answer, because there was none to remove.
  if (status === GITIGNORE_STATUS.NEEDS_ATTENTION && blockWasWritten(previous))
    return { path, changed: false, status: previous, previous, refused: "would-erase-block-written" };

  record.steps = { ...record.steps, gitignore: status };
  await atomicWrite(path, JSON.stringify(record, null, 2) + "\n");
  return { path, changed: true, status, previous };
}

/** Does this recorded status assert that Kiln put a block in the file? */
export function blockWasWritten(status) {
  return status === GITIGNORE_STATUS.ADDED || status === GITIGNORE_STATUS.MIGRATED;
}

/* ------------------------------------------------------------------ plan */

/**
 * Decide what should happen to `.gitignore` WITHOUT writing anything.
 *
 * ⚠️ **A KILN-MARKED BLOCK ALREADY PRESENT COUNTS AS `added`, NOT AS `already-covered`.** That
 * distinction is what makes a crash between the append and the rename recoverable: the rerun can see
 * that the block is Kiln's own work rather than a pre-existing rule, and records the truth.
 *
 * ⚠️ **`recorded` IS WHAT SEPARATES "NEVER ADDED" FROM "DELIBERATELY REMOVED".** Without it a missing
 * block is indistinguishable from a fresh project, and the rerun of a command the operator expected
 * to do nothing would put back a block they had removed on purpose. Pass what
 * `readRecordedIgnoreStep` returns; a project with no content root yet has nothing to pass.
 *
 * @param {string} projectRoot
 * @param {{recorded?: string|null}} [opts]
 */
export function planIgnoreBlock(projectRoot, { recorded = null } = {}) {
  // A worktree or submodule has `.git` as a FILE pointing elsewhere; both are repositories.
  if (!existsSync(join(projectRoot, ".git")))
    return {
      repository: false,
      requiresChoice: false,
      path: join(projectRoot, ".gitignore"),
      recorded,
      state: IGNORE_STATE.NOT_A_REPOSITORY,
      status: GITIGNORE_STATUS.NOT_A_REPOSITORY,
      action: IGNORE_ACTION.NONE,
    };

  return classifyFile(join(projectRoot, ".gitignore"), recorded);
}

/**
 * The classification itself, over one read of the file.
 *
 * ⚠️ **SEPARATE FROM `planIgnoreBlock` SO `applyIgnoreBlock` CAN RE-RUN IT.** A plan is a statement
 * about the file as it was READ, and the whole discipline of this module is that the file may have
 * moved since. Apply re-classifies rather than trusting what it was handed — which is only possible
 * if the classification is a function of text rather than a step inside the public planner. The
 * repository check is deliberately NOT re-run: whether the project is a repository is a property of
 * the project the caller resolved, not of this file.
 */
function classifyFile(path, recorded, read = readFileSync) {
  const base = { repository: true, path, recorded, requiresChoice: false };

  if (!existsSync(path))
    return {
      ...base,
      state: IGNORE_STATE.ABSENT,
      status: GITIGNORE_STATUS.ADDED,
      action: IGNORE_ACTION.CREATE,
      existing: "",
      // ⚠️ DERIVED FROM THE ABSENT FILE, WHICH COVERS NOTHING. Carrying a rule list computed against
      // a file that has since been deleted is how a create writes two rules and leaves the third
      // uncovered: the coverage those rules were subtracted against went with the file.
      adds: [...IGNORE_RULES],
    };

  const existing = read(path, "utf-8");
  const block = findBlock(existing);
  const covers = coverage(existing, block);

  if (block?.malformed)
    return {
      ...base,
      state: IGNORE_STATE.MALFORMED,
      status: GITIGNORE_STATUS.NEEDS_ATTENTION,
      action: IGNORE_ACTION.REPORT,
      existing,
      requiresChoice: true,
      // ⚠️ NO `rewrite`. Rewriting means replacing the bytes between one begin marker and one end
      // marker, and this file does not have one of each — there is nothing to replace that could be
      // chosen without guessing which markers pair up.
      choices: [IGNORE_CHOICE.KEEP],
      detail: block.malformed,
      uncovered: covers.uncovered,
    };

  if (block) {
    // ⚠️ THE INTERIOR IS COMPARED AGAINST WHAT KILN WOULD HAVE WRITTEN FOR THIS FILE, not against
    // `IGNORE_RULES` flat. A project whose operator already ignored `.planning/` gets a block holding
    // only the other two, and that block is untouched Kiln output — calling it `edited` would report
    // the tool's own correct work as damage.
    //
    // ⚠️ **RECOGNISED BY ITS READING, BECAUSE NOTHING IS WRITTEN.** `current` is the one classification
    // that authorises no write at all, so a tolerant comparison here costs nothing: a block whose rule
    // line somebody indented is still Kiln's block, still covers what it says, and is best left alone.
    // `legacy` below is the opposite case and is compared byte for byte — the asymmetry is the point,
    // not an oversight. Tolerance where we do nothing; exactness where we overwrite.
    const expected = IGNORE_RULES.filter((r) => !covers.inFile.has(r));
    if (sameRules(block.interior, expected) && covers.uncovered.length === 0)
      return {
        ...base,
        state: IGNORE_STATE.CURRENT,
        status: GITIGNORE_STATUS.ADDED,
        action: IGNORE_ACTION.NONE,
        existing,
        block,
      };

    // ⚠️ **BYTE-EXACT, BECAUSE THIS ONE ENDS IN AN OVERWRITE.** A trimmed comparison here classified a
    // whitespace-edited operator block as untouched Kiln output and replaced it — destroying the edit
    // that was the evidence it was not Kiln's to replace. An inexact block falls through to `edited`
    // below, where the operator is asked.
    const legacy = LEGACY_RULE_SETS.find((set) => matchesExactly(block, set));
    if (legacy)
      return {
        ...base,
        state: IGNORE_STATE.LEGACY,
        status: GITIGNORE_STATUS.MIGRATED,
        action: IGNORE_ACTION.MIGRATE,
        existing,
        block,
        from: [...legacy],
        // The migrated block still skips what the operator's own lines cover, so migration cannot
        // introduce a duplicate either.
        adds: IGNORE_RULES.filter((r) => !covers.inFile.has(r)),
      };

    return {
      ...base,
      state: IGNORE_STATE.EDITED,
      status: GITIGNORE_STATUS.NEEDS_ATTENTION,
      action: IGNORE_ACTION.REPORT,
      existing,
      block,
      requiresChoice: true,
      choices: [IGNORE_CHOICE.KEEP, IGNORE_CHOICE.REWRITE],
      // ⚠️ NAMES THE WHITESPACE CASE, because "the block contains exactly what I expect and Kiln
      // says it does not" is otherwise an unanswerable report.
      detail: LEGACY_RULE_SETS.some((set) => sameRules(block.interior, set))
        ? `the block reads as Kiln's old one-rule block but does not match it byte for byte — ` +
          `something has edited its spacing or line endings, so it will not be replaced`
        : `the block contains ${JSON.stringify(block.interior)}, which is not a block Kiln has written`,
      uncovered: covers.uncovered,
    };
  }

  // No block at all. Either one was never added, or somebody removed it.
  if (blockWasWritten(recorded))
    return {
      ...base,
      state: IGNORE_STATE.REMOVED,
      status: GITIGNORE_STATUS.NEEDS_ATTENTION,
      action: IGNORE_ACTION.REPORT,
      existing,
      requiresChoice: true,
      choices: [IGNORE_CHOICE.KEEP, IGNORE_CHOICE.REWRITE],
      detail: `the setup record says Kiln ${recorded} a block, and there is none in the file`,
      uncovered: covers.uncovered,
    };

  if (covers.uncovered.length === 0)
    return {
      ...base,
      state: IGNORE_STATE.ALREADY_COVERED,
      status: GITIGNORE_STATUS.ALREADY_IGNORED,
      action: IGNORE_ACTION.NONE,
      existing,
    };

  return {
    ...base,
    state: IGNORE_STATE.ABSENT,
    status: GITIGNORE_STATUS.ADDED,
    action: IGNORE_ACTION.APPEND,
    existing,
    adds: covers.uncovered,
  };
}

/* ------------------------------------------------------------------ apply */

/**
 * Perform the planned `.gitignore` change.
 *
 * ⚠️ **THE FILE IS RE-READ HERE RATHER THAN WRITTEN FROM THE PLAN'S SNAPSHOT.** The plan is made
 * before the content tree is generated, and writing `plan.existing + block` would put those bytes
 * back — silently reverting anything that reached the file in between. The initializer's lock keeps
 * two Kilns apart; it does not keep an editor's save out. Re-reading also lets the append notice a
 * marked block that appeared after the plan was made, so the at-most-once rule holds even then.
 *
 * ⚠️ **A REPORT WRITES NOTHING AND DOES NOT THROW.** An operator who removed or edited the block has
 * made a decision; the owner's job is to surface it, not to overrule it, and not to turn a rerun of
 * a command into a crash. Only `choice: "rewrite"` writes, and only a caller who actually asked the
 * operator may pass it.
 *
 * @param {object} plan  from `planIgnoreBlock`
 * @param {{choice?: string, contentRoot?: string, read?: Function}} [opts]
 *   `contentRoot` records the outcome in `state/setup.json`, which is what lets a later run tell a
 *   removed block from one that was never there.
 *
 *   `read` is injectable for the same reason the initializer's `rename` is: two guards here fire only
 *   when the file changes between a check and the write that check authorised, and nothing
 *   single-threaded can interleave two reads of a real file. Without the seam those guards would be
 *   the two branches in this module that refuse to destroy an operator's work and are never proved to.
 */
export async function applyIgnoreBlock(plan, { choice = null, contentRoot = null, read = readFileSync } = {}) {
  const result = await perform(plan, choice, read);
  // ⚠️ **RECORDED WHETHER OR NOT ANYTHING WAS WRITTEN.** Gating this on `changed` made
  // `needs-attention` unreachable — the one outcome that never writes was the one outcome never
  // recorded — so a documented persisted status could not occur, and a report left no trace for the
  // next run. What protects the removed-block signal is `recordIgnoreStep` refusing to erase it, not
  // this call declining to make it.
  if (contentRoot) result.record = await recordIgnoreStep(contentRoot, result.status);
  return result;
}

/**
 * ⚠️ **THE PLAN IS RE-DERIVED FROM THE FILE, NOT TRUSTED.** A plan describes the file as it was read,
 * and everything in this module exists because that file moves under it. An earlier version trusted
 * two things from the plan and both were wrong:
 *
 *   - It treated ANY block that appeared between plan and apply as "someone else already did it" and
 *     returned the plan's `added`. A legacy, edited or malformed block satisfies `findBlock` just as
 *     well as a current one, so the run reported success while `.pi/sessions/` and `.pi/runtime/`
 *     stayed unprotected — precisely the state REQ-0027's coverage-before-data rule exists to catch.
 *   - It wrote the plan's `adds` through the exclusive create. Those rules were the ones the file did
 *     not already cover; if the file was then DELETED, the coverage they were subtracted against went
 *     with it, and the recreated block held two rules and left the third uncovered.
 *
 * Both are the same mistake — carrying a conclusion across a window in which its premise expired —
 * so both have the same fix: classify the file as it is now, and act on that.
 *
 * The loop exists for the exclusive create losing its race: EEXIST means a file arrived, and a file
 * that arrived has contents that have to be classified rather than appended to blind. It is bounded
 * because an unbounded one turns a pathological writer into a hang.
 */
async function perform(plan, choice, read = readFileSync) {
  for (let attempt = 0; ; attempt++) {
    // ⚠️ THE REPOSITORY CHECK IS NOT RE-RUN, and it is the only thing carried across. Whether the
    // project is a repository is a property of the project the caller resolved; everything else is a
    // property of a file that may have moved.
    const now = plan.repository === false ? plan : classifyFile(plan.path, plan.recorded ?? null, read);
    const unchanged = (extra = {}) => ({ ...outcome(now), changed: false, ...extra });
    const moved = now.state !== plan.state ? { note: `the file was ${plan.state} when planned and is ${now.state} now` } : {};

    // ⚠️ **A PLAN THAT REPORTED OPERATOR-OWNED CONTENT IS A NON-WRITING PLAN, AND THAT IS DECIDED
    // BEFORE ANY FRESH ACTION IS DISPATCHED.** This test used to live inside the `report` branch
    // below, which meant it was only consulted when the file still classified as a report — so a
    // reported block that was DELETED between plan and apply reclassified as `create` and was
    // recreated, identically for no choice, `keep`, and `rewrite`. Every one of those is the same
    // failure: work the operator had been asked to authorise happening because the thing they were
    // asked about went away. Deleting the block one has just been told about is a plausible answer to
    // being told about it, and answering it with a fresh block is the worst possible reading.
    //
    // So the boundary sits here, above `none`, `migrate`, `create` and `append` alike: nothing is
    // written for such a plan unless the file is still byte-for-byte what was reported AND the
    // operator explicitly said `rewrite`. `existing` alone is not enough to establish that — an
    // absent file and an empty one both read as `""` — so the fresh classification must still be a
    // report as well.
    if (plan.action === IGNORE_ACTION.REPORT) {
      const sameFile = now.existing === plan.existing && now.action === IGNORE_ACTION.REPORT;
      if (!sameFile) return staleReport(now, plan);
      return report(now, choice, unchanged, plan.existing, read);
    }

    if (now.action === IGNORE_ACTION.NONE) return unchanged(moved);
    if (now.action === IGNORE_ACTION.REPORT)
      // ⚠️ A REPORT THE CALLER NEVER SAW. The plan authorised a write on a file that has since become
      // one somebody has to look at; the choice the caller holds, if any, was not given about this.
      return unchanged({ ...moved, reported: true });
    if (now.action === IGNORE_ACTION.MIGRATE) return { ...(await migrate(now, read)), ...moved };

    if (now.action === IGNORE_ACTION.CREATE) {
      // ⚠️ AN EXCLUSIVE CREATE, SO TWO PROCESSES CANNOT BOTH "CREATE" THE FILE. `wx` fails with
      // EEXIST if anything got there first — a concurrent Kiln, a `git init` template, the user — and
      // that failure is the signal to go round again. Checking `existsSync` and then writing would be
      // the same race with a wider window, and the loser would silently discard the winner's file.
      try {
        const fd = openSync(now.path, "wx");
        try {
          writeSync(fd, blockText("\n", now.adds));
        } finally {
          closeSync(fd);
        }
        return { ...outcome(now), changed: true, wrote: now.adds, ...moved };
      } catch (e) {
        if (e.code !== "EEXIST") throw e; // a real failure, not contention
        if (attempt < 4) continue; // a file arrived: classify it rather than append to it blind
        throw new IgnoreRefusal(
          "contended",
          `${now.path} kept appearing and disappearing while Kiln tried to write it. Nothing was ` +
            `written. Something else is rewriting the file; stop it before running setup.`,
          { path: now.path }
        );
      }
    }

    // ⚠️ READ TO DECIDE, APPEND TO WRITE — never `writeFileSync(path, existing + block)`. Rebuilding
    // the whole file from a string this function is holding means every byte written between the read
    // and the write is destroyed, and `.gitignore` is a file people edit by hand and tools append to.
    // `appendFileSync` writes only the new bytes and cannot revert anyone else's.
    const { existing, adds } = now;
    const eol = /\r\n/.test(existing) ? "\r\n" : "\n";
    const separator = existing.length === 0 ? "" : (existing.endsWith("\n") ? "" : eol) + eol;
    appendFileSync(now.path, separator + blockText(eol, adds), "utf-8");
    return { ...outcome(now), changed: true, wrote: adds, ...moved };
  }
}

/**
 * The answer to a report whose file has moved: write nothing, and describe what is there now.
 *
 * ⚠️ **THE STATUS IS RECOMPUTED RATHER THAN INHERITED, because the fresh classification's status
 * describes what it WOULD have done and this does nothing.** A deleted block classifies as `create`,
 * whose status is `added` — recording that here would claim a block was added by a call that
 * deliberately wrote none. What is true is whether the file, as it stands and unaided, covers the
 * rules: if it does, the fresh status is honest; if it does not, the honest answer is that somebody
 * has to look at it.
 */
function staleReport(now, plan) {
  const uncovered = coverage(now.existing ?? "").uncovered;
  return {
    ...outcome(now),
    status: uncovered.length === 0 ? now.status : GITIGNORE_STATUS.NEEDS_ATTENTION,
    changed: false,
    reported: true,
    requiresChoice: uncovered.length > 0,
    uncovered,
    // ⚠️ THE TWO SHAPES READ DIFFERENTLY BECAUSE THEY ARE DIFFERENT SITUATIONS. "was edited, is
    // edited" is the least informative thing that could be said about a block having been swapped
    // for another one, and it is exactly the case the state comparison cannot see.
    note:
      (now.state === plan.state
        ? `the ${plan.state} block that was reported has been replaced by different content`
        : `the file was ${plan.state} when it was reported and is ${now.state} now`) +
      `, so nothing was written: an answer about the block that was there is not an answer about this`,
  };
}

/** Surface a block the operator removed or edited, and write only if they said to. */
function report(plan, choice, unchanged, consented = null, read = readFileSync) {
  if (choice === null || choice === IGNORE_CHOICE.KEEP) return unchanged({ reported: true });
  if (choice === IGNORE_CHOICE.REWRITE) return rewrite(plan, consented, read);
  throw new IgnoreRefusal(
    "unknown-choice",
    `${JSON.stringify(choice)} is not one of the choices this report offers ` +
      `(${plan.choices.map((c) => JSON.stringify(c)).join(", ")}).`,
    { choices: plan.choices }
  );
}

/**
 * Replace an untouched legacy block with the current one.
 *
 * ⚠️ **EVERY BYTE OUTSIDE THE MARKERS IS CARRIED THROUGH, and that is why this splices the FRESH
 * text rather than rebuilding the file.** `.gitignore` is a file people edit by hand; a migration
 * that reconstructed it from the plan's snapshot would revert whatever arrived in between, which is
 * a worse outcome than the stale block it set out to fix.
 *
 * ⚠️ **RE-VERIFIED UNDER THE CALLER'S LOCK BEFORE THE WRITE.** The plan says the block was untouched
 * legacy output when it was read. If it is not that now — an editor's save, another tool, a Kiln of a
 * different version — this refuses rather than overwriting bytes it never saw. Compare before write
 * is the same rule the setup transaction enforces on every file it merges.
 */
async function migrate(plan, read = readFileSync) {
  const existing = read(plan.path, "utf-8");
  const block = findBlock(existing);

  // ⚠️ BYTE-EXACT, THE SAME TEST THE CLASSIFICATION USED. Re-checking with a weaker rule than the one
  // that authorised the write would make this guard theatre: it would pass for exactly the blocks the
  // classification would have refused.
  if (!block || block.malformed || !LEGACY_RULE_SETS.some((set) => matchesExactly(block, set)))
    throw new IgnoreRefusal(
      "block-changed",
      `${plan.path}'s Kiln block changed between planning the migration and performing it, so it is no ` +
        `longer the untouched legacy block the plan identified. Nothing was written: replacing a block ` +
        `somebody has edited is the one thing this owner must never do. Re-run to see what it says now.`,
      { path: plan.path, interior: block?.interior ?? null }
    );

  const adds = IGNORE_RULES.filter((r) => !coverage(existing, block).inFile.has(r));
  const next = existing.slice(0, block.start) + spliceText(block, adds) + existing.slice(block.end);
  await atomicWrite(plan.path, next);
  return { ...outcome(plan), changed: true, wrote: adds, from: plan.from };
}

/** The explicit rewrite: the operator was shown what is there and asked for Kiln's block back. */
async function rewrite(plan, consented = null, read = readFileSync) {
  if (!plan.choices?.includes(IGNORE_CHOICE.REWRITE))
    throw new IgnoreRefusal(
      "choice-unavailable",
      `A ${plan.state} ignore file cannot be resolved by rewriting — the operator has to look at it.`,
      { state: plan.state }
    );

  const existing = existsSync(plan.path) ? read(plan.path, "utf-8") : "";

  // ⚠️ **THE INNERMOST CONSENT CHECK, IMMEDIATELY BEFORE THE WRITE.** The caller already matched the
  // answer to the text it was given about; this closes the window between that match and this write,
  // which is the only place left where the bytes about to be destroyed can differ from the bytes the
  // operator agreed to destroy. It refuses rather than reporting because reaching it means the file
  // moved inside the lock — a race, not an ordinary outcome — and the same discipline `migrate` uses.
  if (consented !== null && existing !== consented)
    throw new IgnoreRefusal(
      "consent-stale",
      `${plan.path} changed between the operator's answer and the write, so the block about to be ` +
        `replaced is not the block they were shown. Nothing was written. Re-run to see what is there ` +
        `now and answer about that.`,
      { path: plan.path }
    );

  const block = findBlock(existing);
  if (block?.malformed)
    throw new IgnoreRefusal("block-changed", `${plan.path} now holds ${block.malformed}.`, { path: plan.path });

  const adds = IGNORE_RULES.filter((r) => !coverage(existing, block).inFile.has(r));
  const eol = block?.eol ?? (/\r\n/.test(existing) ? "\r\n" : "\n");
  const next = block
    ? existing.slice(0, block.start) + spliceText(block, adds) + existing.slice(block.end)
    : existing + (existing.length === 0 ? "" : (existing.endsWith("\n") ? "" : eol) + eol) + blockText(eol, adds);

  await atomicWrite(plan.path, next);
  return { ...outcome(plan), status: GITIGNORE_STATUS.ADDED, changed: true, wrote: adds, choice: IGNORE_CHOICE.REWRITE };
}

function outcome(plan) {
  return {
    status: plan.status,
    state: plan.state,
    action: plan.action,
    path: plan.path,
    requiresChoice: plan.requiresChoice === true,
    ...(plan.detail ? { detail: plan.detail } : {}),
    ...(plan.choices ? { choices: plan.choices } : {}),
    ...(plan.uncovered ? { uncovered: plan.uncovered } : {}),
  };
}
