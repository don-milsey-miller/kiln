import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  try {
    const result = repairPiBraceExpansion(root);
    assert.equal(result.repaired, true);
    assert.equal(installedPiBraceExpansion(root), PATCHED_BRACE_EXPANSION);
    assert.equal(readFileSync(join(target, "index.js"), "utf8"), "patched");
    assert.deepEqual(repairPiBraceExpansion(root, { check: true }), {
      repaired: false,
      version: PATCHED_BRACE_EXPANSION,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
