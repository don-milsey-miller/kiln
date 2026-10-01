#!/usr/bin/env node

/**
 * The safe local full-suite runner (#84).
 *
 * Some setup and consumer journeys install dependencies inside copied or locked tool roots. Running
 * every test file in one `node --test` invocation lets those journeys overlap readers of the checkout's
 * dependency tree on Windows. CI already classifies the suite by operating contract; the local full
 * command uses the same exhaustive groups, one child process at a time.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CI_GROUPS } from "../test/ci-groups.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SAFE_TEST_GROUP_ORDER = Object.freeze(Object.keys(CI_GROUPS));

export function runGroupProcess(group, { spawnProcess = spawn, output = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    output.write(`\n[kiln-test-suite] starting group=${group}\n`);
    const child = spawnProcess(process.execPath, [join(ROOT, "bin", "run-test-group.mjs"), group], {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Test group ${group} ended from signal ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}

/** Run exhaustively classified groups serially and stop at the first failure. */
export async function runTestGroups({
  groups = SAFE_TEST_GROUP_ORDER,
  runGroup = (group) => runGroupProcess(group),
  output = process.stdout,
} = {}) {
  for (const group of groups) {
    const code = await runGroup(group);
    if (code !== 0) {
      output.write(`[kiln-test-suite] failed group=${group} exit=${code}\n`);
      return code;
    }
    output.write(`[kiln-test-suite] passed group=${group}\n`);
  }
  output.write(`[kiln-test-suite] complete groups=${groups.length}\n`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = await runTestGroups();
