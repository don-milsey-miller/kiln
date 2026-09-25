/**
 * ACC-0118: the four commands run through a linked `.planning`, and none runs on import — TSK-0074.
 *
 * ⚠️ **EACH RUN IS PROVED BY WHAT THE COMMAND DID, NOT BY ITS EXIT STATUS.** The defect this exists for exited 0 having
 * done nothing: Node resolved the main module's real path, the guard compared it with the linked path the operator
 * typed, and every command decided it was only imported. So each invocation below must show its own effect — a usage
 * text, a refusal naming the argument, a check's verdict — and the one that refuses must exit with its own code.
 *
 * ⚠️ **A REAL LINK OF EACH PLATFORM'S KIND.** A junction on Windows and a directory symlink on POSIX, which is what an
 * operator's `.planning` is when it is linked rather than cloned.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isEntryPoint } from "../lib/entry-point.mjs";

const ROOT = join(import.meta.dirname, "..");

const COMMANDS = [
  { file: "setup.mjs", args: ["--help"], status: 0, effect: /node \.planning\/bin\/setup\.mjs \[options\]/ },
  { file: "start-kiln.mjs", args: ["--linked-entry-probe"], status: 2, effect: /Unrecognised argument: --linked-entry-probe/ },
  { file: "init-project.mjs", args: ["--help"], status: 0, effect: /Create a project's planning-content\/ directory\./ },
  { file: "generate-stage-skills.mjs", args: ["--check"], status: 0, effect: /\[stage-skills\] clean/ },
];

function linkedTool() {
  const dir = mkdtempSync(join(tmpdir(), "kiln-linked-entry-"));
  symlinkSync(ROOT, join(dir, ".planning"), process.platform === "win32" ? "junction" : "dir");
  return dir;
}

/** The link first, on its own, so nothing that follows it can reach this checkout; then the directory. */
function removeLinkedTool(dir) {
  const link = join(dir, ".planning");
  if (process.platform === "win32") rmdirSync(link);
  else unlinkSync(link);
  rmSync(dir, { recursive: true, force: true });
}

test("⚠️ ACC-0118 each of the four commands runs when invoked through a linked .planning", () => {
  const dir = linkedTool();
  try {
    for (const { file, args, status, effect } of COMMANDS) {
      const r = spawnSync(process.execPath, [join(dir, ".planning", "bin", file), ...args], { cwd: dir, encoding: "utf-8", timeout: 120_000 });
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, effect, `${file} ${args.join(" ")} did not run through the link (exit ${r.status}): ${JSON.stringify(out.slice(0, 400))}`);
      assert.equal(r.status, status, `${file}: ${out.slice(0, 400)}`);
    }
  } finally {
    removeLinkedTool(dir);
  }
});

test("⚠️ ACC-0118 importing any of the four, through the link or not, runs no command", () => {
  const dir = linkedTool();
  try {
    for (const { file } of COMMANDS)
      for (const path of [join(dir, ".planning", "bin", file), join(ROOT, "bin", file)]) {
        const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path).href)});`], {
          cwd: dir,
          encoding: "utf-8",
          timeout: 120_000,
        });
        assert.equal(r.status, 0, `importing ${path} failed: ${r.stderr.slice(0, 400)}`);
        assert.equal(`${r.stdout}${r.stderr}`.trim(), "", `importing ${path} ran something: ${JSON.stringify((r.stdout + r.stderr).slice(0, 300))}`);
      }
  } finally {
    removeLinkedTool(dir);
  }
});

test("the entry-point check compares real paths, and answers false for nothing or a different file", () => {
  const dir = linkedTool();
  try {
    const url = pathToFileURL(join(ROOT, "bin", "setup.mjs")).href;
    assert.equal(isEntryPoint(url, join(dir, ".planning", "bin", "setup.mjs")), true, "through the link");
    assert.equal(isEntryPoint(url, join(ROOT, "bin", "setup.mjs")), true, "by its real path");
    assert.equal(isEntryPoint(url, join(ROOT, "bin", "start-kiln.mjs")), false, "another command");
    assert.equal(isEntryPoint(url, undefined), false, "no program at all");
    assert.equal(isEntryPoint(url, join(dir, "missing.mjs")), false, "a path that does not exist");
  } finally {
    removeLinkedTool(dir);
  }
});
