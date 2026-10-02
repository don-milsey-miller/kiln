import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PATCHED_BRACE_EXPANSION,
  installedPiBraceExpansion,
  repairPiBraceExpansion,
} from "../bin/repair-pi-brace-expansion.mjs";

test("#61 repairs Pi's shrinkwrapped brace-expansion package and verifies the installed version", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-pi-dependency-"));
  const source = join(root, "node_modules", "brace-expansion");
  const target = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "brace-expansion");
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "brace-expansion", version: PATCHED_BRACE_EXPANSION }));
  writeFileSync(join(source, "index.js"), "patched");
  writeFileSync(join(target, "package.json"), JSON.stringify({ name: "brace-expansion", version: "5.0.9" }));
  const lockPath = join(root, "package-lock.json");
  const lockEntry = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
  writeFileSync(lockPath, `${JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "node_modules/brace-expansion": {
        version: PATCHED_BRACE_EXPANSION,
        resolved: "https://registry.invalid/brace-expansion-5.0.12.tgz",
        integrity: "sha512-patched",
      },
      [lockEntry]: {
        version: "5.0.9",
        resolved: "https://registry.invalid/brace-expansion-5.0.9.tgz",
        integrity: "sha512-old",
      },
    },
  }, null, 2)}\n`);

  try {
    const result = repairPiBraceExpansion(root);
    assert.equal(result.repaired, true);
    assert.equal(installedPiBraceExpansion(root), PATCHED_BRACE_EXPANSION);
    assert.equal(readFileSync(join(target, "index.js"), "utf8"), "patched");
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).packages[lockEntry].version, PATCHED_BRACE_EXPANSION);

    // A verified tree must not make package-lock.json newer than npm's installed-tree marker. That would make
    // the launcher treat every warm checkout as stale and reinstall on every start (#100's full-suite catch).
    const old = new Date(1_000);
    utimesSync(lockPath, old, old);
    assert.deepEqual(repairPiBraceExpansion(root), { repaired: false, version: PATCHED_BRACE_EXPANSION });
    assert.equal(statSync(lockPath).mtimeMs, old.getTime(), "an idempotent repair rewrote the lockfile");
    assert.deepEqual(repairPiBraceExpansion(root, { check: true }), {
      repaired: false,
      version: PATCHED_BRACE_EXPANSION,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
