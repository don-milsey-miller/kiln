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

test("⚠️ no synchronous export offers a way around the contract", () => {
  // ⚠️ THE RULE IS ABOUT READS, AND IT USED TO BE STATED AS "no synchronous export". That was the
  // same claim while the reader exported nothing but reads. TSK-0012 needed the WRITE to address the
  // same content root the page reads from — two resolutions that agreed today and drifted later
  // would have the operator approving an artifact in one directory while the page rendered another,
  // with nothing to say which half was wrong — so one function here returns WHERE content lives.
  //
  // It returns paths and reads nothing, so `connection()` has nothing to protect. The exception is
  // named rather than inferred, and the list is pinned, so a second one is a visible act.
  const PERMITTED = {
    planningRoots:
      "returns the project and content roots; touches no content. Shared with the review write so " +
      "the page and the write cannot address different directories (TSK-0012).",
  };
  // Anything that would actually READ. A synchronous export calling one of these is the defect the
  // original rule was written against, and it stays refused however the export is named.
  const READS = /(lintProject|loadStageDefinitions|loadStageAttestations|evaluateStageGate|readStageDocs|readActivatedTypes|createValidators|loadSchemaSet)\s*\(/;

  for (const f of files()) {
    const src = readFileSync(f, "utf-8");
    const sync = [...src.matchAll(/export\s+function\s+(\w+)/g)].map((m) => m[1]);
    assert.deepEqual(
      sync.filter((n) => !PERMITTED[n]),
      [],
      `${f} exports a synchronous reader, which cannot await connection()`
    );

    // ⚠️ AND THE PERMITTED ONE MUST STILL BE WHAT IT CLAIMS. Without this the exception is a
    // hole: `planningRoots` could grow a `lintProject` call tomorrow and read the whole project
    // outside the freshness contract under a name this list already trusts.
    for (const n of sync) {
      const at = src.indexOf(`export function ${n}`);
      const end = src.indexOf("\n}", at);
      const body = src.slice(at, end === -1 ? undefined : end);
      assert.ok(!READS.test(body), `${n} is a permitted synchronous export but it READS — that is the thing the rule forbids`);
      assert.ok(!/await\s/.test(body), `${n} awaits, so it is not the synchronous path this exception was granted for`);
    }
  }

  assert.deepEqual(Object.keys(PERMITTED).sort(), ["planningRoots"], "the exception list itself is pinned");
});

test("the criteria and document reads are separate exports", () => {
  // ACC-0016 needs them behind INDEPENDENT Suspense boundaries; one combined call would make that
  // impossible. This checks the shape the boundary requires, not the boundary itself.
  const src = files().map((f) => readFileSync(f, "utf-8")).join("\n");
  for (const name of ["readStageCriteria", "readStageDocument"])
    assert.match(src, new RegExp(`export\\s+async\\s+function\\s+${name}\\b`), `${name} must be its own read`);
});

test("⚠️ the stage view's reads sit behind DISTINCT boundaries with distinct fallbacks", () => {
  // ACC-0016's structural half. One boundary around both reads would make the whole page the
  // fallback and satisfy DEC-0019 on paper while buying nothing; the smoke test proves the other
  // half — that a failure in one region leaves the other rendered.
  const src = readFileSync(join(ROOT, "app", "stage", "[stageId]", "page.js"), "utf-8");
  const opens = src.match(/<Suspense\b/g) ?? [];
  assert.ok(opens.length >= 3, `expected a boundary per read, found ${opens.length}`);

  const fallbacks = [...src.matchAll(/data-vpw-loading="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...fallbacks].sort(),
    ["criteria", "document", "review"],
    "each fallback must name the content it stands in for, and they must differ"
  );

  // ...and each panel is rendered literally, which the boundary check also enforces.
  for (const name of ["CriteriaPanel", "DocumentPanel", "ReviewPanel"])
    assert.ok(src.includes(`<${name} `), `${name} must be rendered by its declared name`);
});
