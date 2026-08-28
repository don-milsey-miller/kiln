/**
 * The reader's discipline, checked statically — TSK-0005's own guard until TSK-0006 and TSK-0015
 * build the real one.
 *
 * ⚠️ THIS IS A STAND-IN, AND IT SAYS SO. REQ-0021 requires a check that covers the whole
 * application, detects indirect re-export chains, and is falsified against fixtures. This covers one
 * file by pattern. It exists because the reader establishes a discipline several tasks before
 * anything enforces it, and an unenforced convention survives exactly as long as the person who
 * wrote it remembers — but it must not be mistaken for ACC-0021 or ACC-0022, which stay
 * `not-evaluated`.
 *
 * ⚠️ Read as TEXT, never imported: `server-only` throws outside the RSC compiler (AST-0033), so a
 * test that imported this module would fail by design and one that stubbed the package would be
 * checking the stub.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READ_DIR = join(ROOT, "app", "_read");
const files = () =>
  readdirSync(READ_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(js|mjs|jsx)$/.test(e.name))
    .map((e) => join(READ_DIR, e.name));

test("the reader exists where the application can reach it but routing cannot", () => {
  assert.ok(existsSync(READ_DIR), "app/_read/ holds the single reader");
  assert.ok(files().length > 0);
  // A leading underscore is Next.js's private-folder convention — the same rule that silently
  // un-routed a probe during TSK-0004, used deliberately here.
  assert.ok(READ_DIR.includes("_read"), "a private folder, so no read module can become a route");
});

test("the reader never imports `lib/` and never touches `node:fs`", () => {
  for (const f of files()) {
    const src = readFileSync(f, "utf-8");
    const imports = [...src.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(
        !/(^|\/)lib\//.test(spec) && !spec.startsWith("../../lib"),
        `${f} imports ${spec} — every read goes through app/server/* (DEC-0021)`
      );
      assert.ok(!/^node:(fs|fs\/promises)$/.test(spec), `${f} imports ${spec} directly`);
    }
    assert.ok(!/require\(["']node:fs/.test(src), `${f} reaches the filesystem directly`);
  }
});

test("⚠️ every exported reader awaits `connection()` before anything else", () => {
  for (const f of files()) {
    const src = readFileSync(f, "utf-8");
    const exported = [...src.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/g)];
    assert.ok(exported.length > 0, `${f} exports no async reader`);
    for (const [, name, body] of exported) {
      const firstStatement = body
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
      assert.equal(
        firstStatement,
        "await connection();",
        `${name} must await connection() first — DEC-0019's contract is that no planning-content ` +
          `read happens before the request is known to be real. A read above this line would be ` +
          `prerendered into the build, which AST-0019 measured happening with Cache Components ` +
          `both on and off`
      );
    }
  }
});

test("no synchronous export offers a way around the contract", () => {
  for (const f of files()) {
    const src = readFileSync(f, "utf-8");
    const sync = [...src.matchAll(/export\s+function\s+(\w+)/g)].map((m) => m[1]);
    assert.deepEqual(sync, [], `${f} exports a synchronous reader, which cannot await connection()`);
  }
});

test("the criteria and document reads are separate exports", () => {
  // ACC-0016 needs them behind INDEPENDENT Suspense boundaries; one combined call would make that
  // impossible. This checks the shape the boundary requires, not the boundary itself.
  const src = files().map((f) => readFileSync(f, "utf-8")).join("\n");
  for (const name of ["readStageCriteria", "readStageDocument"])
    assert.match(src, new RegExp(`export\\s+async\\s+function\\s+${name}\\b`), `${name} must be its own read`);
});
