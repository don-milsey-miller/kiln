#!/usr/bin/env node
/**
 * `npm run roles:generate` and `npm run roles:check` — CMP-0035, TSK-0051, against ACC-0072 and ACC-0073.
 *
 * ⚠️ **THIS FILE ONLY PARSES AND REPORTS.** What a role definition should say is
 * `lib/specialists/render.mjs`'s, built from `lib/specialists/roles.mjs` and `contractFor`; what differs
 * on disk is `lib/specialists/role-files.mjs`'s. Both modes here call that one plan, so the check cannot
 * compare against output the write would not produce.
 *
 * ⚠️ **AN UNRECOGNISED ARGUMENT IS A REFUSAL.** `--chek` silently ignored would run the WRITE mode in a
 * CI step that meant to check, and report success after changing the files it was meant to guard.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DRIFT, checkRoleDefinitions, writeRoleDefinitions } from "../lib/specialists/role-files.mjs";

const TOOL_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

export const EXIT = Object.freeze({ CLEAN: 0, DRIFT: 1, REFUSED: 2 });

export const USAGE = `Generate the specialist role definitions, or check that they are current.

Usage:
  node bin/generate-specialist-roles.mjs            write specialists/<role>.md for every role
  node bin/generate-specialist-roles.mjs --check    write nothing; report every stale, missing or orphaned file
  node bin/generate-specialist-roles.mjs --help     print this and exit

The definitions are generated from the authored prose in lib/specialists/roles.mjs merged with the tool
list, write boundary and forbidden actions that lib/specialists/contract.mjs derives. Nothing in a
generated file is authored twice, and no role declares a provider, a model or a thinking level.

Exit codes:
  0  the definitions match the contract (in write mode, after writing)
  1  --check found a stale, missing or orphaned definition
  2  a role could not be rendered, a definition could not be read, the directory is unusable, a path is
     unsafe, content the generator does not own is in the way, or the arguments were not understood
`;

const FLAGS = new Set(["--check", "--help", "-h"]);

const DRIFT_SENTENCE = Object.freeze({
  [DRIFT.STALE]: "is stale",
  [DRIFT.MISSING]: "is missing",
  [DRIFT.ORPHANED]: "is orphaned",
});

const report = (lines) => lines.filter(Boolean).join("\n");

/** @param {string[]} argv */
export function parseArguments(argv) {
  const unknown = argv.filter((arg) => !FLAGS.has(arg));
  if (unknown.length) return { mode: "refused", unknown };
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  return { mode: argv.includes("--check") ? "check" : "write" };
}

/** @returns {Promise<{code: number, output: string}>} */
export async function run(argv, toolRoot = TOOL_ROOT) {
  const parsed = parseArguments(argv);

  if (parsed.mode === "refused")
    return {
      code: EXIT.REFUSED,
      output: report([`Unrecognised argument${parsed.unknown.length > 1 ? "s" : ""}: ${parsed.unknown.join(", ")}.`, "", USAGE]),
    };
  if (parsed.mode === "help") return { code: EXIT.CLEAN, output: USAGE };

  if (parsed.mode === "check") {
    const result = checkRoleDefinitions(toolRoot);
    if (result.status === "refused")
      return { code: EXIT.REFUSED, output: report(["[roles] refused:", ...result.refusals.map((r) => `  ${r.code}: ${r.message}`)]) };
    if (result.status === "drift")
      return {
        code: EXIT.DRIFT,
        output: report(["[roles] out of date:", ...result.drift.map((d) => `  ${d.path} ${DRIFT_SENTENCE[d.kind] ?? d.kind}`), "", "Run `npm run roles:generate`."]),
      };
    return { code: EXIT.CLEAN, output: `[roles] clean: all ${result.expected} role definitions match the specialist contract.` };
  }

  const result = await writeRoleDefinitions(toolRoot);
  if (result.status === "refused")
    return {
      code: EXIT.REFUSED,
      output: report([
        "[roles] refused; nothing was written:",
        ...result.refusals.map((r) => `  ${r.code}: ${r.message}`),
        ...(result.changes.length ? ["", "Changes made before the refusal:", ...result.changes.map((c) => `  ${c.kind} ${c.path}`)] : []),
      ]),
    };
  if (result.changes.length === 0) return { code: EXIT.CLEAN, output: `[roles] clean: all ${result.expected} role definitions already match the specialist contract.` };
  return { code: EXIT.CLEAN, output: report(["[roles] written:", ...result.changes.map((c) => `  ${c.kind} ${c.path}`)]) };
}

// ⚠️ THE MODULE IS IMPORTABLE WITHOUT RUNNING. The suite calls `run` directly, so the check a CI step
// performs and the check a test performs are the same code path rather than two spellings of it.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { code, output } = await run(process.argv.slice(2));
  process.stdout.write(`${output}\n`);
  process.exitCode = code;
}
