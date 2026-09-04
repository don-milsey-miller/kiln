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
  const endsFile = ends[0] === lines.length - 1;
  return {
    start: first.start,
    // ⚠️ THE TRAILING NEWLINE IS PART OF THE BLOCK, so a replacement neither eats the byte that
    // separates the block from what follows nor adds a second one. The exception is an end marker
    // that is the file's last line with no newline after it: there is no byte there to include.
    end: last.start + last.body.length + (endsFile && !text.endsWith("\n") ? 0 : last.eol.length),
    eol: first.eol,
    interior: lines.slice(begins[0] + 1, ends[0]).map((l) => l.trimmed),
  };
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
  if (record?.steps?.gitignore === status) return { path, changed: false, status };

  record.steps = { ...record.steps, gitignore: status };
  await atomicWrite(path, JSON.stringify(record, null, 2) + "\n");
  return { path, changed: true, status };
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
  const path = join(projectRoot, ".gitignore");
  const base = { repository: true, path, requiresChoice: false };

  // A worktree or submodule has `.git` as a FILE pointing elsewhere; both are repositories.
  if (!existsSync(join(projectRoot, ".git")))
    return {
      ...base,
      repository: false,
      state: IGNORE_STATE.NOT_A_REPOSITORY,
      status: GITIGNORE_STATUS.NOT_A_REPOSITORY,
      action: IGNORE_ACTION.NONE,
    };

  if (!existsSync(path))
    return {
      ...base,
      state: IGNORE_STATE.ABSENT,
      status: GITIGNORE_STATUS.ADDED,
      action: IGNORE_ACTION.CREATE,
      existing: "",
      adds: [...IGNORE_RULES],
    };

  const existing = readFileSync(path, "utf-8");
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

    const legacy = LEGACY_RULE_SETS.find((set) => sameRules(block.interior, set));
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
      detail: `the block contains ${JSON.stringify(block.interior)}, which is not a block Kiln has written`,
      uncovered: covers.uncovered,
    };
  }

  // No block at all. Either one was never added, or somebody removed it.
  if (recorded === GITIGNORE_STATUS.ADDED || recorded === GITIGNORE_STATUS.MIGRATED)
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
 * @param {{choice?: string, contentRoot?: string}} [opts]
 *   `contentRoot` records the outcome in `state/setup.json`, which is what lets a later run tell a
 *   removed block from one that was never there.
 */
export async function applyIgnoreBlock(plan, { choice = null, contentRoot = null } = {}) {
  const result = await perform(plan, choice);
  if (contentRoot && result.changed) result.record = await recordIgnoreStep(contentRoot, result.status);
  return result;
}

async function perform(plan, choice) {
  const unchanged = (extra = {}) => ({ ...outcome(plan), changed: false, ...extra });

  if (plan.action === IGNORE_ACTION.NONE) return unchanged();
  if (plan.action === IGNORE_ACTION.REPORT) return report(plan, choice, unchanged);
  if (plan.action === IGNORE_ACTION.MIGRATE) return migrate(plan);

  // ⚠️ AN EXCLUSIVE CREATE, SO TWO PROCESSES CANNOT BOTH "CREATE" THE FILE. `wx` fails with EEXIST if
  // anything got there first — a concurrent Kiln, a `git init` template, the user — and that failure
  // is the signal to append instead. Checking `existsSync` and then writing would be the same race
  // with a wider window, and the loser would silently discard whatever the winner wrote.
  if (!existsSync(plan.path)) {
    try {
      const fd = openSync(plan.path, "wx");
      try {
        writeSync(fd, blockText("\n", plan.adds ?? IGNORE_RULES));
      } finally {
        closeSync(fd);
      }
      return { ...outcome(plan), changed: true, wrote: plan.adds ?? [...IGNORE_RULES] };
    } catch (e) {
      if (e.code !== "EEXIST") throw e; // a real failure, not contention
    }
  }

  // ⚠️ READ TO DECIDE, APPEND TO WRITE — never `writeFileSync(path, existing + block)`. Rebuilding
  // the whole file from a string this function is holding means every byte written between the read
  // and the write is destroyed, and `.gitignore` is a file people edit by hand and tools append to.
  // `appendFileSync` writes only the new bytes and cannot revert anyone else's.
  const existing = readFileSync(plan.path, "utf-8");
  if (findBlock(existing)) return unchanged({ note: "a marked block arrived between plan and apply" });

  // ⚠️ THE RULES TO WRITE ARE RE-DERIVED FROM THE FRESH TEXT, so a rule somebody added in between is
  // not written a second time.
  const adds = coverage(existing, null).uncovered;
  if (adds.length === 0) return unchanged({ note: "every rule was covered between plan and apply" });

  const eol = /\r\n/.test(existing) ? "\r\n" : "\n";
  const separator = existing.length === 0 ? "" : (existing.endsWith("\n") ? "" : eol) + eol;
  appendFileSync(plan.path, separator + blockText(eol, adds), "utf-8");
  return { ...outcome(plan), changed: true, wrote: adds };
}

/** Surface a block the operator removed or edited, and write only if they said to. */
function report(plan, choice, unchanged) {
  if (choice === null || choice === IGNORE_CHOICE.KEEP) return unchanged({ reported: true });
  if (choice === IGNORE_CHOICE.REWRITE) return rewrite(plan);
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
async function migrate(plan) {
  const existing = readFileSync(plan.path, "utf-8");
  const block = findBlock(existing);

  if (!block || block.malformed || !LEGACY_RULE_SETS.some((set) => sameRules(block.interior, set)))
    throw new IgnoreRefusal(
      "block-changed",
      `${plan.path}'s Kiln block changed between planning the migration and performing it, so it is no ` +
        `longer the untouched legacy block the plan identified. Nothing was written: replacing a block ` +
        `somebody has edited is the one thing this owner must never do. Re-run to see what it says now.`,
      { path: plan.path, interior: block?.interior ?? null }
    );

  const adds = IGNORE_RULES.filter((r) => !coverage(existing, block).inFile.has(r));
  const next = existing.slice(0, block.start) + blockText(block.eol, adds) + existing.slice(block.end);
  await atomicWrite(plan.path, next);
  return { ...outcome(plan), changed: true, wrote: adds, from: plan.from };
}

/** The explicit rewrite: the operator was shown what is there and asked for Kiln's block back. */
async function rewrite(plan) {
  if (!plan.choices?.includes(IGNORE_CHOICE.REWRITE))
    throw new IgnoreRefusal(
      "choice-unavailable",
      `A ${plan.state} ignore file cannot be resolved by rewriting — the operator has to look at it.`,
      { state: plan.state }
    );

  const existing = existsSync(plan.path) ? readFileSync(plan.path, "utf-8") : "";
  const block = findBlock(existing);
  if (block?.malformed)
    throw new IgnoreRefusal("block-changed", `${plan.path} now holds ${block.malformed}.`, { path: plan.path });

  const adds = IGNORE_RULES.filter((r) => !coverage(existing, block).inFile.has(r));
  const eol = block?.eol ?? (/\r\n/.test(existing) ? "\r\n" : "\n");
  const next = block
    ? existing.slice(0, block.start) + blockText(eol, adds) + existing.slice(block.end)
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
