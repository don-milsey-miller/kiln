#!/usr/bin/env node
/**
 * `npm run skills:generate` and `npm run skills:check` — CMP-0033, TSK-0046, against ACC-0066.
 *
 * ⚠️ **THIS FILE ONLY PARSES AND REPORTS.** What the skills should say is `lib/stage-skills.mjs`'s;
 * what differs on disk, and what may be written or removed, is `lib/stage-skills-files.mjs`'s. Both
 * modes here call that one plan, so the check cannot compare against output the write would not produce.
 *
 * ⚠️ **AN UNRECOGNISED ARGUMENT IS A REFUSAL.** `--chek` silently ignored would run the WRITE mode in a
 * CI step that meant to check, and report success after changing the files it was meant to guard.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DRIFT, checkStageSkills, writeStageSkills } from "../lib/stage-skills-files.mjs";

const TOOL_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

export const EXIT = Object.freeze({ CLEAN: 0, DRIFT: 1, REFUSED: 2 });

export const USAGE = `Generate the packaged stage skills from stages/*.json, or check that they are current.

Usage:
  node bin/generate-stage-skills.mjs            write the generated kiln-stage-* skills
  node bin/generate-stage-skills.mjs --check    write nothing; report every stale, missing or orphaned skill
  node bin/generate-stage-skills.mjs --help     print this and exit

Only kiln-stage-* skills under pi-package/skills/ are generated. Every other skill, such as
kiln-planning, is handwritten and is never read, reported, changed or removed.

Exit codes:
  0  the generated skills match the stage definitions (in write mode, after writing)
  1  --check found a stale, missing or orphaned generated skill
  2  the stage definitions are missing or malformed, the skills directory is unusable, a generated
     path is unsafe, content the generator does not own is in the way, or the arguments were not understood
`;

const FLAGS = new Set(["--check", "--help", "-h"]);

/**
 * @param {string[]} argv  the arguments after the script name
 * @returns {{mode: "write"|"check"|"help"} | {error: string}}
 */
export function parseArgs(argv) {
  let check = false;
  let help = false;
  for (const arg of argv) {
    if (!FLAGS.has(arg)) return { error: `Unrecognised argument: ${arg}` };
    if (arg === "--check") check = true;
    else help = true;
  }
  return { mode: help ? "help" : check ? "check" : "write" };
}

const say = (write, message) => write(`[stage-skills] ${message}`);

/** Every drift line in the plan's own order, which is by skill name. */
const driftLines = (write, drift) => {
  for (const item of drift) {
    const note = item.kind === DRIFT.ORPHANED && !item.owned ? " (holds content the generator did not write; write mode will refuse to remove it)" : "";
    say(write, `${item.kind.padEnd(8)} ${item.skill}  ${item.path}${note}`);
  }
};

const refusalLines = (write, refusals) => {
  for (const r of refusals) say(write, `refused: ${r.code}: ${r.message}`);
};

/**
 * The command, as a function that returns its exit status.
 *
 * @param {string[]} argv
 * @param {{toolRoot?: string, out?: (line: string) => void, err?: (line: string) => void}} [deps]
 *   ⚠️ THE ONE SEAM, reachable only by a direct module call: a test points `toolRoot` at a temporary
 *   copy. No argument and no environment variable selects a different root.
 */
export async function main(argv = process.argv.slice(2), { toolRoot = TOOL_ROOT, out = console.log, err = console.error } = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    say(err, args.error);
    err(USAGE);
    return EXIT.REFUSED;
  }
  if (args.mode === "help") {
    out(USAGE);
    return EXIT.CLEAN;
  }

  if (args.mode === "check") {
    const result = checkStageSkills(toolRoot);
    if (result.status === "refused") {
      refusalLines(err, result.refusals);
      return EXIT.REFUSED;
    }
    if (result.status === "drift") {
      driftLines(out, result.drift);
      say(out, `${result.drift.length} generated skill${result.drift.length === 1 ? " is" : "s are"} out of date with stages/. Run npm run skills:generate.`);
      return EXIT.DRIFT;
    }
    say(out, `clean: all ${result.expected} generated skills match stages/.`);
    return EXIT.CLEAN;
  }

  const result = await writeStageSkills(toolRoot);
  if (result.status === "refused") {
    driftLines(out, result.changes);
    refusalLines(err, result.refusals);
    if (result.changes.length === 0) say(err, "nothing was written.");
    return EXIT.REFUSED;
  }
  driftLines(out, result.changes);
  say(out, result.changes.length === 0 ? `nothing to change: all ${result.expected} generated skills already match stages/.` : `wrote ${result.changes.length} change${result.changes.length === 1 ? "" : "s"}; all ${result.expected} generated skills now match stages/.`);
  return EXIT.CLEAN;
}

/** Run only when this file is the program, so importing it to test `parseArgs` and `main` runs nothing. */
const isEntryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntryPoint) {
  try {
    process.exitCode = await main();
  } catch (e) {
    // ⚠️ THE ERROR'S CODE, NOT ITS MESSAGE. A filesystem error's message carries the absolute path it
    // failed on, and this line lands in CI logs.
    console.error(`[stage-skills] failed: ${e?.code ?? e?.name ?? "unknown error"}`);
    process.exitCode = EXIT.REFUSED;
  }
}
