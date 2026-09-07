/**
 * The single ignore owner, observed — `lib/project-gitignore.mjs` (CMP-0023, REQ-0027, ACC-0046).
 *
 * ⚠️ **EVERY CLAIM IS READ BACK OFF DISK, AND USUALLY AS BYTES.** The interesting failures here are
 * not "the rule is missing" — they are "a byte outside the markers moved", "the block appeared
 * twice", "a rerun churned the file". A test that compared a returned status would miss all three.
 *
 * ⚠️ **THE INTEGRATION WITH THE INITIALIZER LIVES IN `initialize-project.test.mjs`.** Append before
 * the swap, the crash window, and the deleted block a rerun must not restore are properties of the
 * initializer's ordering, not of the owner, and they are asserted where that ordering is.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { installReaper, reapLater } from "./helpers/reap.mjs";

import {
  GITIGNORE_BEGIN,
  GITIGNORE_END,
  GITIGNORE_STATUS,
  IGNORE_ACTION,
  IGNORE_CHOICE,
  IGNORE_RULES,
  IGNORE_STATE,
  IgnoreRefusal,
  applyIgnoreBlock,
  blockText,
  coverage,
  findBlock,
  blockWasWritten,
  planIgnoreBlock,
  readRecordedIgnoreStep,
  recordIgnoreStep,
  ruleSpellings,
} from "../lib/project-gitignore.mjs";
import { initializeProject } from "../lib/initialize-project.mjs";
import { SETUP_FILE } from "../lib/project-scaffold.mjs";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function repo() {
  const dir = reapLater(mkdtempSync(join(tmpdir(), "kiln-ignore-")));
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

const ignoreFile = (dir) => join(dir, ".gitignore");
const read = (dir) => readFileSync(ignoreFile(dir), "utf-8");
const write = (dir, text) => writeFileSync(ignoreFile(dir), text, "utf-8");
const countBlocks = (text) => text.split(/\r?\n/).filter((l) => l.trim() === GITIGNORE_BEGIN).length;

/** The block Kiln wrote before the rule set grew to three (DEC-0029). */
const legacyBlock = (eol = "\n") => [GITIGNORE_BEGIN, ".planning/", GITIGNORE_END].join(eol) + eol;

/**
 * A reader that answers `first` once and `rest` thereafter — the file changing between the check and
 * the write that check authorised, which is otherwise unreachable without a second thread.
 */
function movingReader(first, rest) {
  let calls = 0;
  return () => (calls++ === 0 ? first : rest);
}

/** Everything except the block, so "no byte outside the markers moved" is a comparison of bytes. */
function outsideBlock(text) {
  const b = findBlock(text);
  if (!b || b.malformed) return text;
  return text.slice(0, b.start) + "<<BLOCK>>" + text.slice(b.end);
}

/* ================================================================== reading */

test("the equivalent spellings of a directory rule are the four git treats as one", () => {
  assert.deepEqual(
    [...ruleSpellings(".pi/sessions/")].sort(),
    [".pi/sessions", ".pi/sessions/", "/.pi/sessions", "/.pi/sessions/"].sort()
  );
  assert.deepEqual([...ruleSpellings(".pi/sessions")], [...ruleSpellings(".pi/sessions/")], "the trailing slash is not a spelling of its own");
});

test("a file with no markers has no block, and a file with only rules covers them", () => {
  assert.equal(findBlock("node_modules/\n"), null);
  const covers = coverage(`# mine\n${IGNORE_RULES.join("\n")}\n`);
  assert.deepEqual(covers.uncovered, []);
  assert.deepEqual([...covers.inFile].sort(), [...IGNORE_RULES].sort());
  assert.equal(covers.inBlock.size, 0, "nothing is inside a block, because there is no block");
});

test("⚠️ a rule inside the block and the same rule outside it are told apart", () => {
  // The distinction is what lets an appended block carry only what nobody has written yet. Counting
  // the block's own lines as the operator's would make every rerun believe the file already covered
  // everything and that the block was therefore unnecessary.
  const text = `.planning/\n\n${blockText("\n", [".pi/sessions/", ".pi/runtime/"])}`;
  const covers = coverage(text);
  assert.deepEqual([...covers.inFile], [".planning/"]);
  assert.deepEqual([...covers.inBlock].sort(), [".pi/runtime/", ".pi/sessions/"]);
  assert.deepEqual(covers.uncovered, []);
});

test("⚠️ a negation REVOKES coverage rather than providing it", () => {
  // `!.planning/` re-includes what the line above ignored. Counting it because it contains the same
  // path would report a tracked directory as protected — the one error coverage-before-data cannot
  // tolerate, because the next thing that happens is a transcript being written into it.
  const covers = coverage(`.planning/\n!.planning/\n.pi/sessions/\n.pi/runtime/\n`);
  assert.deepEqual(covers.uncovered, [".planning/"]);
  assert.deepEqual([...covers.negated], [".planning/"]);
});

test("a commented-out rule is a comment, not coverage", () => {
  assert.deepEqual(coverage("# .planning/\n").uncovered, [...IGNORE_RULES]);
});

test("⚠️ unpaired or repeated markers are malformed, never 'the first block'", () => {
  // Choosing a block out of a file with two begin markers means overwriting bytes between markers
  // picked by position. Whatever produced that file, the operator has to look at it.
  for (const [text, why] of [
    [`${GITIGNORE_BEGIN}\n.planning/\n`, "a begin with no end"],
    [`.planning/\n${GITIGNORE_END}\n`, "an end with no begin"],
    [`${blockText()}${blockText()}`, "two complete blocks"],
    [`${GITIGNORE_END}\n${GITIGNORE_BEGIN}\n`, "an end before its begin"],
  ]) {
    const found = findBlock(text);
    assert.ok(found?.malformed, why);
  }
});

test("the block's extent includes its trailing newline, and stops there", () => {
  const text = `before\n${blockText()}after\n`;
  const b = findBlock(text);
  assert.equal(text.slice(b.start, b.end), blockText());
  assert.equal(text.slice(0, b.start), "before\n");
  assert.equal(text.slice(b.end), "after\n");
});

test("a block that ends the file without a trailing newline is still bounded correctly", () => {
  const text = `before\n${blockText().replace(/\n$/, "")}`;
  const b = findBlock(text);
  assert.equal(text.slice(b.end), "", "there is no byte after the end marker to claim");
  assert.equal(text.slice(0, b.start), "before\n");
});

/* ================================================================== planning */

test("a project that is not a Git repository is planned as nothing to do", () => {
  const dir = reapLater(mkdtempSync(join(tmpdir(), "kiln-ignore-")));
  const plan = planIgnoreBlock(dir);
  assert.equal(plan.repository, false);
  assert.equal(plan.action, IGNORE_ACTION.NONE);
  assert.equal(plan.status, GITIGNORE_STATUS.NOT_A_REPOSITORY);
});

test("⚠️ a fresh repository is planned to receive exactly one block holding all three rules", async () => {
  const dir = repo();
  const plan = planIgnoreBlock(dir);
  assert.equal(plan.action, IGNORE_ACTION.CREATE);

  const applied = await applyIgnoreBlock(plan);
  assert.equal(applied.changed, true);
  assert.deepEqual(applied.wrote, [...IGNORE_RULES]);

  const text = read(dir);
  assert.equal(text, blockText("\n", IGNORE_RULES));
  assert.equal(countBlocks(text), 1);
  for (const rule of IGNORE_RULES) assert.match(text, new RegExp(`^${rule.replace(/[.\/]/g, "\\$&")}$`, "m"), rule);
});

test("⚠️ the block carries only the rules the operator has not already written", async () => {
  const dir = repo();
  write(dir, "# mine\n.pi/runtime/\n");

  const plan = planIgnoreBlock(dir);
  assert.deepEqual(plan.adds, [".planning/", ".pi/sessions/"]);

  const applied = await applyIgnoreBlock(plan);
  const text = read(dir);
  assert.deepEqual(applied.wrote, [".planning/", ".pi/sessions/"]);
  assert.equal(text.split(/\r?\n/).filter((l) => l.trim() === ".pi/runtime/").length, 1, "not written twice");
  assert.deepEqual(coverage(text).uncovered, []);
});

test("a file that already covers everything is planned as already-ignored and left alone", async () => {
  const dir = repo();
  const existing = `${IGNORE_RULES.join("\n")}\n`;
  write(dir, existing);

  const plan = planIgnoreBlock(dir);
  assert.equal(plan.state, IGNORE_STATE.ALREADY_COVERED);
  assert.equal(plan.status, GITIGNORE_STATUS.ALREADY_IGNORED);

  const applied = await applyIgnoreBlock(plan);
  assert.equal(applied.changed, false);
  assert.equal(read(dir), existing);
});

test("⚠️ Kiln's own block for a partially-covered file is `current`, not `edited`", async () => {
  // The block written into a project that already ignored `.planning/` holds only the other two
  // rules. Comparing its interior against `IGNORE_RULES` flat would report the tool's own correct
  // output as damage, and the rerun would then ask the operator to resolve a problem it invented.
  const dir = repo();
  write(dir, ".planning/\n");
  await applyIgnoreBlock(planIgnoreBlock(dir));

  const plan = planIgnoreBlock(dir);
  assert.equal(plan.state, IGNORE_STATE.CURRENT);
  assert.equal(plan.action, IGNORE_ACTION.NONE);
});

test("rerunning plan-and-apply on a current file is byte-stable", async () => {
  const dir = repo();
  write(dir, "node_modules/\n");
  await applyIgnoreBlock(planIgnoreBlock(dir));
  const once = read(dir);

  await applyIgnoreBlock(planIgnoreBlock(dir));
  assert.equal(read(dir), once);
  assert.equal(countBlocks(once), 1);
});

/* ================================================================== migration */

test("⚠️ an exact legacy block is migrated, and every byte outside the markers survives", async () => {
  const dir = repo();
  const before = "# top of my file\nnode_modules/\n\n";
  const after = "\n# things I keep below it\ncoverage/\n*.log\n";
  write(dir, before + legacyBlock() + after);

  const plan = planIgnoreBlock(dir);
  assert.equal(plan.state, IGNORE_STATE.LEGACY);
  assert.equal(plan.action, IGNORE_ACTION.MIGRATE);
  assert.equal(plan.status, GITIGNORE_STATUS.MIGRATED);
  assert.deepEqual(plan.from, [".planning/"]);

  const applied = await applyIgnoreBlock(plan);
  const text = read(dir);

  assert.equal(applied.changed, true);
  assert.deepEqual(applied.wrote, [...IGNORE_RULES]);
  assert.equal(text, before + blockText() + after, "the splice replaced the block and nothing else");
  assert.equal(text.startsWith(before), true);
  assert.equal(text.endsWith(after), true);
  assert.equal(countBlocks(text), 1);
  assert.deepEqual(coverage(text).uncovered, []);
});

test("a migrated file is byte-stable on rerun", async () => {
  const dir = repo();
  write(dir, `node_modules/\n\n${legacyBlock()}\ntail\n`);
  await applyIgnoreBlock(planIgnoreBlock(dir));
  const migrated = read(dir);

  const again = planIgnoreBlock(dir);
  assert.equal(again.state, IGNORE_STATE.CURRENT);
  assert.equal(again.action, IGNORE_ACTION.NONE);
  const applied = await applyIgnoreBlock(again);
  assert.equal(applied.changed, false);
  assert.equal(read(dir), migrated, "a second migration is not a second write");
});

test("⚠️ a legacy block is matched BY ITS BYTES, so a whitespace edit is not 'untouched'", async () => {
  // The mutation: comparing the TRIMMED interior. Every one of these reads as `[".planning/"]` after
  // trimming and would have been classified untouched legacy output and overwritten — destroying the
  // edit that was the evidence it was not Kiln's to replace. Migration is the only operation here
  // that replaces bytes, so it is the only one that must ask a question about bytes.
  const edits = {
    "an indented rule": [GITIGNORE_BEGIN, "  .planning/", GITIGNORE_END].join("\n") + "\n",
    "a trailing space on the rule": [GITIGNORE_BEGIN, ".planning/ ", GITIGNORE_END].join("\n") + "\n",
    "an indented begin marker": [`  ${GITIGNORE_BEGIN}`, ".planning/", GITIGNORE_END].join("\n") + "\n",
    "a trailing space on the end marker": [GITIGNORE_BEGIN, ".planning/", `${GITIGNORE_END} `].join("\n") + "\n",
    "a tab before the rule": [GITIGNORE_BEGIN, "\t.planning/", GITIGNORE_END].join("\n") + "\n",
    "a blank line inside the block": [GITIGNORE_BEGIN, ".planning/", "", GITIGNORE_END].join("\n") + "\n",
    "mixed line endings": `${GITIGNORE_BEGIN}\r\n.planning/\n${GITIGNORE_END}\r\n`,
  };

  for (const [what, text] of Object.entries(edits)) {
    const dir = repo();
    write(dir, text);

    const plan = planIgnoreBlock(dir);
    assert.equal(plan.state, IGNORE_STATE.EDITED, `${what}: classified as edited, not legacy`);
    assert.equal(plan.action, IGNORE_ACTION.REPORT, what);

    const applied = await applyIgnoreBlock(plan);
    assert.equal(applied.changed, false, what);
    assert.equal(read(dir), text, `${what}: not one byte was replaced`);
  }
});

test("⚠️ a legacy block missing the final newline Kiln wrote is MODIFIED, and is not migrated", async () => {
  // ACC-0046 authorises migrating "an exact unmodified legacy block". A block short one byte Kiln
  // wrote is modified, whatever stripped it, so it does not qualify — the criterion and the code's
  // definition of exactness have to be the same definition, or the criterion is not what is enforced.
  const dir = repo();
  const text = `head\n${legacyBlock().replace(/\n$/, "")}`;
  write(dir, text);

  const plan = planIgnoreBlock(dir);
  assert.equal(plan.state, IGNORE_STATE.EDITED, "not legacy: it is not byte-for-byte what Kiln wrote");
  assert.equal(plan.action, IGNORE_ACTION.REPORT);
  assert.match(plan.detail, /byte for byte/);

  assert.equal((await applyIgnoreBlock(plan)).changed, false);
  assert.equal(read(dir), text, "nothing was written");
});

test("⚠️ an explicit rewrite still does not add a trailing newline the file did not have", async () => {
  // The tolerance belongs to the WRITE, not to the recognition. Migration is automatic and must match
  // the criterion exactly; a rewrite was asked for, and there the only duty is not to tidy anything
  // that was not asked about. A file that gained a final newline it never had is a diff nobody wanted.
  const dir = repo();
  write(dir, `head\n${legacyBlock().replace(/\n$/, "")}`);
  const plan = planIgnoreBlock(dir);

  await applyIgnoreBlock(plan, { choice: IGNORE_CHOICE.REWRITE });
  const after = read(dir);
  assert.equal(after, `head\n${blockText().replace(/\n$/, "")}`, "still no trailing newline");
  assert.deepEqual(coverage(after).uncovered, []);
});

test("a CRLF legacy block migrates to a CRLF block, and introduces no bare LF", async () => {
  const dir = repo();
  write(dir, `node_modules/\r\n${legacyBlock("\r\n")}`);
  await applyIgnoreBlock(planIgnoreBlock(dir));

  const text = read(dir);
  assert.ok(text.includes(blockText("\r\n")), "the block keeps the line ending it had");
  assert.equal(/(?<!\r)\n/.test(text), false);
});

test("⚠️ migration does not duplicate a rule the operator wrote outside the block", async () => {
  const dir = repo();
  write(dir, `.pi/runtime/\n${legacyBlock()}`);
  await applyIgnoreBlock(planIgnoreBlock(dir));

  const text = read(dir);
  assert.deepEqual(findBlock(text).interior, [".planning/", ".pi/sessions/"]);
  assert.equal(text.split(/\r?\n/).filter((l) => l.trim() === ".pi/runtime/").length, 1);
});

test("⚠️ a legacy block edited between plan and apply is reported, and the edit survives", async () => {
  // Compare before write, the same rule the setup transaction enforces on every file it merges. The
  // plan says the block was untouched Kiln output when it was READ; only a fresh read under the
  // caller's lock can say it still is — and when it says otherwise, the answer is the edited block's
  // answer, not the plan's.
  const dir = repo();
  write(dir, `head\n${legacyBlock()}tail\n`);
  const plan = planIgnoreBlock(dir);
  assert.equal(plan.action, IGNORE_ACTION.MIGRATE);

  const edited = `head\n${[GITIGNORE_BEGIN, ".planning/", "# and this, which I need", GITIGNORE_END].join("\n")}\ntail\n`;
  write(dir, edited); // somebody else, in between

  const applied = await applyIgnoreBlock(plan);
  assert.equal(applied.changed, false);
  assert.equal(applied.state, IGNORE_STATE.EDITED, "the outcome describes the file, not the plan");
  assert.equal(applied.status, GITIGNORE_STATUS.NEEDS_ATTENTION);
  assert.match(applied.note ?? "", /legacy when planned and is edited now/);
  assert.equal(read(dir), edited, "and not one byte of their edit was lost");
});

test("⚠️ a reported block that is DELETED before apply is not recreated, whatever the answer", async () => {
  // The mutation: testing consent inside the `report` branch, so it was consulted only while the file
  // still classified as a report. A deleted block reclassified as `create` and was recreated — for no
  // choice, for `keep`, and for `rewrite` alike. Deleting the block you have just been told about is
  // a plausible answer to being told about it, and answering that with a fresh block is the worst
  // available reading of it. A plan that reported operator-owned content writes NOTHING unless the
  // file is still byte-for-byte what was reported and the operator said `rewrite`.
  const theirs = `head\n${[GITIGNORE_BEGIN, "operator-owned content", GITIGNORE_END].join("\n")}\ntail\n`;

  for (const choice of [null, IGNORE_CHOICE.KEEP, IGNORE_CHOICE.REWRITE]) {
    const dir = repo();
    write(dir, theirs);
    const plan = planIgnoreBlock(dir);
    assert.equal(plan.action, IGNORE_ACTION.REPORT, String(choice));

    rmSync(ignoreFile(dir)); // the operator deletes the whole file after being shown the report
    const applied = await applyIgnoreBlock(plan, choice === null ? {} : { choice });

    assert.equal(applied.changed, false, `${choice}: nothing was written`);
    assert.equal(existsSync(ignoreFile(dir)), false, `${choice}: the file is still absent`);
    assert.equal(applied.status, GITIGNORE_STATUS.NEEDS_ATTENTION, `${choice}: never a bare "added"`);
    assert.deepEqual(applied.uncovered, [...IGNORE_RULES], `${choice}: and it says so`);
  }
});

test("⚠️ a non-writing plan does not become an automatic MIGRATION either", async () => {
  // The boundary is above every fresh action, not just `create`. A reported block replaced by an
  // untouched legacy one would otherwise be migrated — a byte-replacing write on a plan whose whole
  // meaning was that the operator had to decide first.
  const dir = repo();
  write(dir, `${[GITIGNORE_BEGIN, "operator-owned content", GITIGNORE_END].join("\n")}\n`);
  const plan = planIgnoreBlock(dir);
  assert.equal(plan.action, IGNORE_ACTION.REPORT);

  write(dir, legacyBlock());
  const applied = await applyIgnoreBlock(plan);

  assert.equal(applied.changed, false);
  assert.equal(read(dir), legacyBlock(), "not one byte replaced");
  assert.match(applied.note ?? "", /nothing was written/);

  // Planning afresh against what is actually there does migrate it, which is the point: the refusal
  // is about acting on a stale plan, not about refusing the work.
  assert.equal((await applyIgnoreBlock(planIgnoreBlock(dir))).changed, true);
  assert.deepEqual(coverage(read(dir)).uncovered, []);
});

test("a report answered `rewrite` on the UNCHANGED file still writes — the boundary is not a block on work", async () => {
  const dir = repo();
  const theirs = `head\n${[GITIGNORE_BEGIN, "mine", GITIGNORE_END].join("\n")}\ntail\n`;
  write(dir, theirs);

  const applied = await applyIgnoreBlock(planIgnoreBlock(dir), { choice: IGNORE_CHOICE.REWRITE });
  assert.equal(applied.changed, true);
  assert.equal(read(dir), `head\n${blockText()}tail\n`);
  assert.deepEqual(coverage(read(dir)).uncovered, []);
});

test("⚠️ consent to rewrite block A does not authorise rewriting block B", async () => {
  // The mutation: comparing only `action === "report"` on both sides. Two edited blocks are both
  // reports and are not the same file, so an answer given about one operator's block destroyed a
  // different one that had replaced it. Consent is to replacing the bytes they were SHOWN, never to
  // a category of file.
  const dir = repo();
  const blockA = `head\n${[GITIGNORE_BEGIN, "block A, which I wrote", GITIGNORE_END].join("\n")}\ntail\n`;
  const blockB = `head\n${[GITIGNORE_BEGIN, "block B, entirely different", GITIGNORE_END].join("\n")}\ntail\n`;

  write(dir, blockA);
  const plan = planIgnoreBlock(dir);
  assert.equal(plan.state, IGNORE_STATE.EDITED);
  assert.equal(plan.action, IGNORE_ACTION.REPORT);

  write(dir, blockB); // A is replaced by a different reportable block before the answer is applied

  const applied = await applyIgnoreBlock(plan, { choice: IGNORE_CHOICE.REWRITE });
  assert.equal(applied.changed, false, "the answer was not applied to a block it was not about");
  assert.equal(applied.reported, true);
  assert.match(applied.note ?? "", /the edited block that was reported has been replaced by different content/);
  assert.equal(read(dir), blockB, "and block B is byte-identical to what its author left");

  // The operator can still answer about what is actually there, and that answer is honoured.
  const fresh = planIgnoreBlock(dir);
  assert.equal((await applyIgnoreBlock(fresh, { choice: IGNORE_CHOICE.REWRITE })).changed, true);
  assert.deepEqual(coverage(read(dir)).uncovered, []);
});

test("⚠️ the INNERMOST consent check refuses when the file moves after the answer was matched", async () => {
  // The outer check compares the fresh classification against the plan; this one closes the window
  // between that comparison and the write it authorised. It refuses rather than reporting, because
  // reaching it means the file moved inside the caller's lock — a race, not an ordinary outcome.
  //
  // Reachable only through the injected reader: both reads live inside `applyIgnoreBlock`, so nothing
  // single-threaded can interleave them on a real file. `movingReader` returns what the classification
  // saw, then something else — which is exactly the race, without needing one.
  const dir = repo();
  const theirs = `${[GITIGNORE_BEGIN, "mine", GITIGNORE_END].join("\n")}\n`;
  write(dir, theirs);
  const plan = planIgnoreBlock(dir);
  assert.equal(plan.state, IGNORE_STATE.EDITED);

  await assert.rejects(
    () =>
      applyIgnoreBlock(plan, {
        choice: IGNORE_CHOICE.REWRITE,
        read: movingReader(theirs, `${[GITIGNORE_BEGIN, "somebody else's, now", GITIGNORE_END].join("\n")}\n`),
      }),
    (e) => e instanceof IgnoreRefusal && e.reason === "consent-stale"
  );
  assert.equal(read(dir), theirs, "nothing was written");
});

test("⚠️ the INNERMOST migration check refuses when the block moves after it was classified", async () => {
  // The same guard on the other write path. A weaker re-check here than the one that authorised the
  // migration would be theatre: it would pass for exactly the blocks the classification refused.
  const dir = repo();
  write(dir, legacyBlock());
  const plan = planIgnoreBlock(dir);
  assert.equal(plan.action, IGNORE_ACTION.MIGRATE);

  const edited = `${[GITIGNORE_BEGIN, ".planning/", "# and this", GITIGNORE_END].join("\n")}\n`;
  await assert.rejects(
    () => applyIgnoreBlock(plan, { read: movingReader(legacyBlock(), edited) }),
    (e) => e instanceof IgnoreRefusal && e.reason === "block-changed"
  );
  assert.equal(read(dir), legacyBlock(), "nothing was written");
});

test("⚠️ a `rewrite` answer does not carry over to a block that arrived after it was given", async () => {
  // The operator was shown one block and answered about that one. Applying their answer to whatever
  // is there now is how a considered "yes" becomes consent to overwrite something they never saw.
  const dir = repo();
  write(dir, `head\n${legacyBlock()}tail\n`);
  const plan = planIgnoreBlock(dir);

  const theirs = `head\n${[GITIGNORE_BEGIN, "entirely mine", GITIGNORE_END].join("\n")}\ntail\n`;
  write(dir, theirs);

  const applied = await applyIgnoreBlock(plan, { choice: IGNORE_CHOICE.REWRITE });
  assert.equal(applied.changed, false, "the plan was a migration; the answer belonged to no report");
  assert.equal(read(dir), theirs);
});

test("⚠️ a block that vanished between plan and apply is REPORTED when the record says Kiln wrote one", async () => {
  const dir = repo();
  write(dir, legacyBlock());
  const plan = planIgnoreBlock(dir, { recorded: GITIGNORE_STATUS.ADDED });

  write(dir, "# I removed it while you were thinking\n");
  const applied = await applyIgnoreBlock(plan);

  assert.equal(applied.changed, false);
  assert.equal(applied.state, IGNORE_STATE.REMOVED);
  assert.equal(read(dir), "# I removed it while you were thinking\n", "a deliberate deletion is not undone");
});

test("with nothing recorded, a vanished block is a project with no block, and one is written", async () => {
  // The other half of the rule above, and the reason the record exists at all: with no record there
  // is nothing to distinguish "they removed it" from "there was never one", and appending is the
  // documented behaviour for the second. What must not happen is the plan's stale conclusion being
  // written instead of this one.
  const dir = repo();
  write(dir, legacyBlock());
  const plan = planIgnoreBlock(dir);

  write(dir, "# not a Kiln block\n");
  const applied = await applyIgnoreBlock(plan);

  assert.equal(applied.action, IGNORE_ACTION.APPEND, "reported as what it did, not as what it planned");
  assert.deepEqual(applied.wrote, [...IGNORE_RULES]);
  assert.deepEqual(coverage(read(dir)).uncovered, []);
});

/* ================================================================== the operator's block */

test("⚠️ an edited block is REPORTED and never silently rewritten", async () => {
  const dir = repo();
  const edited = `${[GITIGNORE_BEGIN, ".planning/", "!.pi/runtime/", GITIGNORE_END].join("\n")}\n`;
  write(dir, edited);

  const plan = planIgnoreBlock(dir);
  assert.equal(plan.state, IGNORE_STATE.EDITED);
  assert.equal(plan.action, IGNORE_ACTION.REPORT);
  assert.equal(plan.requiresChoice, true);
  assert.deepEqual(plan.choices, [IGNORE_CHOICE.KEEP, IGNORE_CHOICE.REWRITE]);

  const applied = await applyIgnoreBlock(plan); // no choice supplied
  assert.equal(applied.changed, false);
  assert.equal(applied.reported, true);
  assert.equal(applied.requiresChoice, true);
  assert.deepEqual(applied.uncovered, [".pi/sessions/", ".pi/runtime/"], "and it says what is unprotected");
  assert.equal(read(dir), edited, "nothing was written");
});

test("⚠️ a block the operator removed is REPORTED rather than restored", async () => {
  // Distinguishable from a fresh project only by the record. Without it, the rerun of a command the
  // operator expected to do nothing puts back a block they deleted on purpose.
  const dir = repo();
  write(dir, "# I removed Kiln's block on purpose\n");

  const fresh = planIgnoreBlock(dir, { recorded: null });
  assert.equal(fresh.state, IGNORE_STATE.ABSENT, "with nothing recorded, this is simply a new project");
  assert.equal(fresh.action, IGNORE_ACTION.APPEND);

  for (const recorded of [GITIGNORE_STATUS.ADDED, GITIGNORE_STATUS.MIGRATED]) {
    const plan = planIgnoreBlock(dir, { recorded });
    assert.equal(plan.state, IGNORE_STATE.REMOVED, recorded);
    assert.equal(plan.action, IGNORE_ACTION.REPORT, recorded);

    const applied = await applyIgnoreBlock(plan);
    assert.equal(applied.changed, false, recorded);
    assert.equal(read(dir), "# I removed Kiln's block on purpose\n", recorded);
  }
});

test("`keep` is an explicit no-op, and an unknown answer is refused rather than guessed", async () => {
  const dir = repo();
  write(dir, "# gone\n");
  const plan = planIgnoreBlock(dir, { recorded: GITIGNORE_STATUS.ADDED });

  const kept = await applyIgnoreBlock(plan, { choice: IGNORE_CHOICE.KEEP });
  assert.equal(kept.changed, false);
  assert.equal(read(dir), "# gone\n");

  await assert.rejects(
    () => applyIgnoreBlock(plan, { choice: "yes" }),
    (e) => e instanceof IgnoreRefusal && e.reason === "unknown-choice"
  );
  assert.equal(read(dir), "# gone\n");
});

test("⚠️ only an explicit `rewrite` writes, and it preserves every byte outside the block", async () => {
  const dir = repo();
  const head = "# top\nnode_modules/\n";
  const tail = "# bottom\ncoverage/\n";
  write(dir, `${head}${[GITIGNORE_BEGIN, "whatever I put here", GITIGNORE_END].join("\n")}\n${tail}`);

  const plan = planIgnoreBlock(dir);
  assert.equal(plan.state, IGNORE_STATE.EDITED);

  const applied = await applyIgnoreBlock(plan, { choice: IGNORE_CHOICE.REWRITE });
  assert.equal(applied.changed, true);
  assert.equal(applied.status, GITIGNORE_STATUS.ADDED);
  assert.equal(read(dir), `${head}${blockText()}${tail}`);
  assert.equal(countBlocks(read(dir)), 1);
});

test("a removed block is restored by `rewrite` as an append, not by rebuilding the file", async () => {
  const dir = repo();
  write(dir, "# what I kept\nnode_modules/\n");
  const plan = planIgnoreBlock(dir, { recorded: GITIGNORE_STATUS.ADDED });

  await applyIgnoreBlock(plan, { choice: IGNORE_CHOICE.REWRITE });
  const text = read(dir);
  assert.ok(text.startsWith("# what I kept\nnode_modules/\n"), "their file survived");
  assert.equal(countBlocks(text), 1);
  assert.deepEqual(coverage(text).uncovered, []);
});

test("⚠️ a MALFORMED file offers no rewrite at all", async () => {
  // There is nothing to replace that could be chosen without guessing which markers pair up, so the
  // only honest option is to stop and let the operator look.
  const dir = repo();
  const twoBlocks = `${blockText()}${legacyBlock()}`;
  write(dir, twoBlocks);

  const plan = planIgnoreBlock(dir);
  assert.equal(plan.state, IGNORE_STATE.MALFORMED);
  assert.deepEqual(plan.choices, [IGNORE_CHOICE.KEEP]);

  await assert.rejects(
    () => applyIgnoreBlock(plan, { choice: IGNORE_CHOICE.REWRITE }),
    (e) => e instanceof IgnoreRefusal && e.reason === "choice-unavailable"
  );
  assert.equal(read(dir), twoBlocks, "nothing was written to a file nobody can safely edit");
});

/* ================================================================== the record */

test("⚠️ the migration is recorded, and the record is byte-identical to a generated one", async () => {
  const dir = repo();
  const r = await initializeProject({ projectRoot: dir, name: "Recorded", description: "d" });
  assert.equal(r.status, "created");

  const recordPath = join(r.contentRoot, ...SETUP_FILE.split("/"));
  const generated = readFileSync(recordPath, "utf-8");
  assert.equal(readRecordedIgnoreStep(r.contentRoot), GITIGNORE_STATUS.ADDED);

  // Wind the project back to what an older Kiln would have left behind.
  write(dir, legacyBlock());
  const plan = planIgnoreBlock(dir, { recorded: readRecordedIgnoreStep(r.contentRoot) });
  assert.equal(plan.action, IGNORE_ACTION.MIGRATE);

  const applied = await applyIgnoreBlock(plan, { contentRoot: r.contentRoot });
  assert.equal(applied.record.changed, true);
  assert.equal(readRecordedIgnoreStep(r.contentRoot), GITIGNORE_STATUS.MIGRATED);

  const written = readFileSync(recordPath, "utf-8");
  assert.equal(
    written,
    generated.replace('"gitignore": "added"', '"gitignore": "migrated"'),
    "one field changed and the file's shape did not — drift rebuilds the reference FROM this field"
  );
  assert.equal(readdirSync(dir).filter((f) => f.includes("vpw-tmp")).length, 0, "the atomic write left nothing behind");
});

test("⚠️ a report IS recorded, on a project where nothing yet claims a block was written", async () => {
  // The mutation: recording gated on `result.changed`. A report is the one outcome that never writes
  // to .gitignore, so it was the one outcome never recorded — which made `needs-attention` an
  // unreachable value in a vocabulary that documents it as persisted.
  const dir = repo();
  write(dir, `${[GITIGNORE_BEGIN, "not Kiln's", GITIGNORE_END].join("\n")}\n`);
  const r = await initializeProject({ projectRoot: dir, name: "Reported", description: "d" });

  assert.equal(r.git.gitignore, GITIGNORE_STATUS.NEEDS_ATTENTION, "the scaffold records what was found");
  assert.equal(readRecordedIgnoreStep(r.contentRoot), GITIGNORE_STATUS.NEEDS_ATTENTION);

  const applied = await applyIgnoreBlock(planIgnoreBlock(dir, { recorded: readRecordedIgnoreStep(r.contentRoot) }), {
    contentRoot: r.contentRoot,
  });
  assert.equal(applied.changed, false);
  assert.equal(applied.record.changed, false, "and re-recording the same answer is not a write");
});

test("⚠️ a report NEVER erases a record that says Kiln wrote a block", async () => {
  // The field answers one question: has Kiln ever put a block in this file? `added` and `migrated`
  // are what make a later run classify a missing block as `removed` rather than `absent`. Writing
  // `needs-attention` over one of them destroys that signal, and the run after it restores the block
  // the operator deleted — the defect this component exists to prevent, arriving through the
  // mechanism meant to prevent it.
  const dir = repo();
  const r = await initializeProject({ projectRoot: dir, name: "Protected", description: "d" });
  assert.equal(readRecordedIgnoreStep(r.contentRoot), GITIGNORE_STATUS.ADDED);

  write(dir, "# I removed Kiln's block on purpose\n");
  const plan = planIgnoreBlock(dir, { recorded: readRecordedIgnoreStep(r.contentRoot) });
  assert.equal(plan.state, IGNORE_STATE.REMOVED);

  const applied = await applyIgnoreBlock(plan, { contentRoot: r.contentRoot });
  assert.equal(applied.record.changed, false);
  assert.equal(applied.record.refused, "would-erase-block-written");
  assert.equal(readRecordedIgnoreStep(r.contentRoot), GITIGNORE_STATUS.ADDED, "the signal survives");

  // And the run after it still refuses, rather than restoring what they deleted.
  const again = planIgnoreBlock(dir, { recorded: readRecordedIgnoreStep(r.contentRoot) });
  assert.equal(again.state, IGNORE_STATE.REMOVED);
  assert.equal((await applyIgnoreBlock(again, { contentRoot: r.contentRoot })).changed, false);
  assert.equal(read(dir), "# I removed Kiln's block on purpose\n");
});

test("the record's one question is answered by exactly two statuses", () => {
  assert.deepEqual(
    Object.values(GITIGNORE_STATUS).filter(blockWasWritten).sort(),
    [GITIGNORE_STATUS.ADDED, GITIGNORE_STATUS.MIGRATED].sort()
  );
  assert.equal(blockWasWritten(null), false);
});

test("recording the same status twice writes nothing", async () => {
  const dir = repo();
  const r = await initializeProject({ projectRoot: dir, name: "Stable", description: "d" });
  const before = readFileSync(join(r.contentRoot, ...SETUP_FILE.split("/")), "utf-8");

  const result = await recordIgnoreStep(r.contentRoot, GITIGNORE_STATUS.ADDED);
  assert.equal(result.changed, false);
  assert.equal(readFileSync(join(r.contentRoot, ...SETUP_FILE.split("/")), "utf-8"), before);
});

test("an unknown status is refused rather than recorded", async () => {
  const dir = repo();
  const r = await initializeProject({ projectRoot: dir, name: "Refuses", description: "d" });
  await assert.rejects(
    () => recordIgnoreStep(r.contentRoot, "probably-fine"),
    (e) => e instanceof IgnoreRefusal && e.reason === "unknown-status"
  );
});

test("⚠️ an unreadable record reads as nothing recorded, and refuses to be written", async () => {
  // The two directions differ on purpose. READING treats damage as "nothing recorded", which is the
  // safe reading: it makes a missing block `absent` — which appends — rather than `removed`, which
  // refuses. WRITING cannot be safe about it, because the .gitignore write has already happened and
  // an invented record would tell the next run something false.
  const dir = repo();
  const r = await initializeProject({ projectRoot: dir, name: "Damaged", description: "d" });
  writeFileSync(join(r.contentRoot, ...SETUP_FILE.split("/")), "{ not json", "utf-8");

  assert.equal(readRecordedIgnoreStep(r.contentRoot), null);
  await assert.rejects(
    () => recordIgnoreStep(r.contentRoot, GITIGNORE_STATUS.MIGRATED),
    (e) => e instanceof IgnoreRefusal && e.reason === "record-unreadable"
  );
});

test("a record from an unsupported setup version reads as nothing recorded", () => {
  const dir = repo();
  const contentRoot = join(dir, "planning-content");
  mkdirSync(join(contentRoot, "state"), { recursive: true });
  writeFileSync(
    join(contentRoot, ...SETUP_FILE.split("/")),
    JSON.stringify({ setupVersion: 99, steps: { gitignore: "added" } }),
    "utf-8"
  );
  assert.equal(readRecordedIgnoreStep(contentRoot), null);
});

/* ================================================================== races */

test("⚠️ a CURRENT block that arrives between plan and apply is not appended beside", async () => {
  const dir = repo();
  write(dir, "node_modules/\n");
  const plan = planIgnoreBlock(dir);
  assert.equal(plan.action, IGNORE_ACTION.APPEND);

  write(dir, `node_modules/\n${blockText()}`); // another Kiln got there first
  const applied = await applyIgnoreBlock(plan);

  assert.equal(applied.changed, false);
  assert.equal(applied.status, GITIGNORE_STATUS.ADDED, "and it really is covered, so `added` is true");
  assert.equal(countBlocks(read(dir)), 1);
});

test("⚠️ a block that arrives between plan and apply is CLASSIFIED, not merely detected", async () => {
  // The mutation: `if (findBlock(existing)) return unchanged()`. Any block satisfies that — legacy,
  // edited, malformed — and the run then returned the plan's `added` while `.pi/sessions/` and
  // `.pi/runtime/` were not ignored by anything. A truthful `added` on an unprotected project is
  // worse than a refusal, because the next thing that happens is setup writing transcripts into it.
  const arrivals = [
    { what: "legacy", text: legacyBlock(), state: IGNORE_STATE.LEGACY, migrates: true },
    {
      what: "edited",
      text: `${[GITIGNORE_BEGIN, "something of mine", GITIGNORE_END].join("\n")}\n`,
      state: IGNORE_STATE.EDITED,
      migrates: false,
    },
    // ⚠️ TWO LEGACY BLOCKS, not one current and one legacy: the point is a malformed file that is
    // also genuinely uncovered, so "reported" and "not protected" are asserted about the same file.
    { what: "malformed", text: `${legacyBlock()}${legacyBlock()}`, state: IGNORE_STATE.MALFORMED, migrates: false },
  ];

  for (const { what, text, state, migrates } of arrivals) {
    const dir = repo();
    write(dir, "node_modules/\n");
    const plan = planIgnoreBlock(dir);
    assert.equal(plan.action, IGNORE_ACTION.APPEND, what);

    write(dir, `node_modules/\n${text}`); // arrives in between
    const applied = await applyIgnoreBlock(plan);

    assert.equal(applied.state, state, `${what}: the outcome describes the file as it is`);
    if (migrates) {
      assert.equal(applied.changed, true, what);
      assert.deepEqual(coverage(read(dir)).uncovered, [], `${what}: and it ends up protected`);
    } else {
      assert.equal(applied.changed, false, what);
      assert.equal(applied.status, GITIGNORE_STATUS.NEEDS_ATTENTION, `${what}: never a bare "added"`);
      assert.notDeepEqual(coverage(read(dir)).uncovered, [], `${what}: which is honest — it is not covered`);
    }
    assert.equal(countBlocks(read(dir)), what === "malformed" ? 2 : 1, what);
  }
});

test("⚠️ a file that disappears after a PARTIAL-coverage plan is recreated with every rule", async () => {
  // The mutation: the exclusive create wrote `plan.adds`. Those were the rules the file did not
  // already cover — a subtraction whose subtrahend went with the file when it was deleted. The
  // recreated block held two rules and left `.planning/` ignored by nothing, which is the one shape
  // of this bug that looks entirely successful in the result object.
  const dir = repo();
  write(dir, "# mine\n.planning/\n");
  const plan = planIgnoreBlock(dir);
  assert.deepEqual(plan.adds, [".pi/sessions/", ".pi/runtime/"], "the plan is right about the file it read");

  rmSync(ignoreFile(dir)); // the operator deletes the whole file
  const applied = await applyIgnoreBlock(plan);

  assert.equal(applied.action, IGNORE_ACTION.CREATE);
  assert.deepEqual(applied.wrote, [...IGNORE_RULES], "the coverage those two were subtracted against is gone");
  assert.equal(read(dir), blockText());
  assert.deepEqual(coverage(read(dir)).uncovered, []);
});

test("⚠️ a rule that arrives between plan and apply is not written a second time", async () => {
  const dir = repo();
  write(dir, "node_modules/\n");
  const plan = planIgnoreBlock(dir);
  assert.deepEqual(plan.adds, [...IGNORE_RULES]);

  write(dir, "node_modules/\n.planning/\n"); // the operator, in between
  await applyIgnoreBlock(plan);

  const text = read(dir);
  assert.deepEqual(findBlock(text).interior, [".pi/sessions/", ".pi/runtime/"], "the plan's list was re-derived");
  assert.equal(text.split(/\r?\n/).filter((l) => l.trim() === ".planning/").length, 1);
});

test("the surrounding bytes of a migration are taken from the fresh read, not the plan's snapshot", async () => {
  const dir = repo();
  write(dir, `head\n${legacyBlock()}`);
  const plan = planIgnoreBlock(dir);

  write(dir, `head\nsomething I added\n${legacyBlock()}and a tail\n`); // in between
  await applyIgnoreBlock(plan);

  const text = read(dir);
  assert.match(text, /^something I added$/m, "the edit made between plan and apply was not reverted");
  assert.match(text, /^and a tail$/m);
  assert.equal(outsideBlock(text), "head\nsomething I added\n<<BLOCK>>and a tail\n");
});

test("the tool's own repository is a project whose ignore file the owner reports as current", () => {
  // A control that the rule set matches what this repository actually commits. If `.pi/sessions/`
  // were only ever written by a test fixture, every assertion above would still pass while the real
  // file said something else.
  const covers = coverage(readFileSync(join(ROOT, ".gitignore"), "utf-8"));
  assert.deepEqual(covers.uncovered, [], "this checkout ignores every rule the owner writes");
});
