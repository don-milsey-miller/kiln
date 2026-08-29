/**
 * The `app/server/` door, checked statically — ACC-0025 and ACC-0026.
 *
 * ⚠️ These run WITHOUT executing the application, which is the whole point. The third criterion in
 * this family (ACC-0027, a client component reaching an adapter must fail the build with a file and
 * a position) needs a real `next build` and is not run here; it was verified by build and recorded
 * as evidence. What lives here is what can be checked cheaply on every commit.
 *
 * ⚠️ This file reads the adapters as TEXT and never imports them. `server-only` resolves its
 * `react-server` export condition to an empty module inside the RSC compiler and to a THROWING
 * module everywhere else (AST-0033) — so importing an adapter from a test under plain Node would
 * throw by design, and a test that worked around that by stubbing the package would be checking a
 * stub.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { specifiersIn } from "../lib/shell-boundary.mjs";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = join(ROOT, "app", "server");
const CODE = /\.(js|mjs|cjs|jsx|ts|tsx)$/;

const adapters = () =>
  readdirSync(SERVER_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && CODE.test(e.name))
    .map((e) => e.name);

test("the adapter directory exists and holds at least one module", () => {
  assert.ok(existsSync(SERVER_DIR), "app/server/ is the only door into lib/ (DEC-0021)");
  assert.ok(adapters().length > 0, "a door with no modules is not a door");
});

test("every adapter's FIRST statement is `import \"server-only\"`", () => {
  for (const name of adapters()) {
    const src = readFileSync(join(SERVER_DIR, name), "utf-8");
    // Skip a leading block comment or shebang, then take the first line of code.
    const first = src
      .replace(/^#!.*\n/, "")
      .replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("//"));
    assert.match(
      first ?? "",
      /^import\s+["']server-only["'];?$/,
      `app/server/${name} must begin with the guard — its absence turns a build failure that names ` +
        `this file into a Turbopack internal error with no location at all (AST-0032)`
    );
  }
});

test("no adapter uses `export *`", () => {
  for (const name of adapters()) {
    const src = readFileSync(join(SERVER_DIR, name), "utf-8");
    assert.ok(
      !/^\s*export\s*\*/m.test(src),
      `app/server/${name} uses \`export *\`, which makes the adapter a hole rather than a door: the ` +
        `exposed surface then widens every time lib/ gains an export, with no diff to review`
    );
  }
});

test("⚠️ no adapter exposes a locking, writing or spawning capability except the one that was reviewed", () => {
  // The concrete case DEC-0021 was written around: `loadStageAttestations` and
  // `writeStageAttestation` are exports of the SAME module, and only one of them is a read.
  const FORBIDDEN = [
    "writeStageAttestation",
    "writeReviewStatus",
    "setReviewStatus",
    "withLock",
    "atomicWrite",
    "createArtifact",
    "reviseArtifact",
    "resolveQuestion",
    "linkTrace",
    "unlinkTrace",
    "setLifecycle",
    "runJob",
  ];
  for (const name of adapters()) {
    const src = readFileSync(join(SERVER_DIR, name), "utf-8");
    const exported = [...src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)]
      .flatMap((m) => m[1].split(","))
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    for (const bad of FORBIDDEN) {
      // ⚠️ ONE EXCEPTION, AND IT IS THE WHOLE OF WHAT DEC-0021's INDIVIDUAL REVIEW APPROVED:
      // `setReviewStatus`, in `review.js`, and nowhere else. The rule did not weaken when the first
      // write landed — it named the write and kept refusing every other one, including in that
      // same file. `test/review-write.test.mjs` pins the file's whole surface from the other side.
      if (bad === "setReviewStatus" && name === "review.js") continue;
      assert.ok(
        !exported.includes(bad),
        `app/server/${name} exports ${bad}. Locking and writing capabilities are reviewed one at a ` +
          `time (DEC-0021); ${bad === "setReviewStatus" ? "the review write belongs in review.js alone" : "this one has not been reviewed"}`
      );
    }
  }
});

test("`lib/` carries no `server-only` marker, so the CLI and this suite keep working", () => {
  // AST-0033: the marker throws outside the RSC compiler. Marking lib/ would guard the application
  // by breaking every command in bin/ and this test run with it.
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : CODE.test(e.name) ? [join(dir, e.name)] : []
    );
  // ⚠️ Uses the specifier scanner, not a string match. The first version grepped for
  // `"server-only"` and went red the moment a lib module MENTIONED the marker in a comment — which
  // lib/shell-boundary.mjs does, since the guard is part of what it explains. A check that cannot
  // tell an import from prose is a check that punishes documentation.
  const marked = walk(join(ROOT, "lib")).filter((f) =>
    specifiersIn(readFileSync(f, "utf-8")).some((i) => i.spec === "server-only")
  );
  assert.deepEqual(marked, [], "a marked lib/ module would throw under plain Node");
});

test("`lib/` is importable under plain Node, with the shell present", async () => {
  // The suite running at all is most of this criterion; this makes the claim explicit rather than
  // implicit, and names the modules the adapters re-export.
  const mods = await Promise.all([
    import("../lib/content-root.mjs"),
    import("../lib/lint.mjs"),
    import("../lib/stages.mjs"),
    import("../lib/attestations.mjs"),
    import("../lib/activation.mjs"),
    import("../lib/schema-resolver.mjs"),
    import("../lib/validate.mjs"),
  ]);
  for (const m of mods) assert.ok(Object.keys(m).length > 0, "a lib module imported as empty");
  assert.equal(typeof mods[1].lintProject, "function");
  assert.equal(typeof mods[3].loadStageAttestations, "function");
});
