/**
 * Selection lives in the URL — TSK-0010, the static half of ACC-0035.
 *
 * ⚠️ THE RULE IS ABOUT CONSEQUENCE, NOT PURITY. DEC-0023's wording was corrected during approval
 * from "no client state" to "no CORRECTNESS-CRITICAL state held only in the client", and the reason
 * is DEC-0022: every content change and every reconnection reloads the page, at a moment the user
 * did not choose and without telling them what went. Transient interface state survives that fine
 * because losing it costs nothing. A selection does not.
 *
 * ⚠️ Today the application has no client components at all, so these checks pass trivially. They are
 * written anyway, because the first `"use client"` file is exactly when someone reaches for
 * `useState` to remember which artifact is open — and that is the moment this should fail rather
 * than the moment someone notices a reload lost their place.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "app");
const CODE = /\.(js|mjs|jsx|ts|tsx)$/;

const appFiles = (dir = APP) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? appFiles(join(dir, e.name)) : CODE.test(e.name) && e.name !== "server.mjs" ? [join(dir, e.name)] : []
  );

test("no application module reaches for browser storage", () => {
  // localStorage/sessionStorage would survive a reload — and would then be a SECOND source of truth
  // for a selection the URL already carries, free to disagree with it.
  for (const f of appFiles()) {
    const src = readFileSync(f, "utf-8");
    for (const api of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"])
      assert.ok(!src.includes(api), `${relative(ROOT, f)} uses ${api} — selection belongs in the URL`);
  }
});

test("⚠️ any client component must not hold the selection", () => {
  // Scoped deliberately: a `"use client"` file may hold transient state. What it may not do is own
  // `stageId` or the selected artifact, because a reload would silently discard it.
  const clients = appFiles().filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf-8")));
  for (const f of clients) {
    const src = readFileSync(f, "utf-8");
    for (const bad of [/useState\s*\([^)]*artifact/i, /useState\s*\([^)]*stageId/i])
      assert.ok(!bad.test(src), `${relative(ROOT, f)} holds a correctness-critical selection in client state`);
  }
  // Recorded so the count moving is a visible event rather than a silent one.
  assert.equal(clients.length, 0, `expected no client components yet, found ${clients.map((f) => relative(ROOT, f))}`);
});

test("the selections come from the route and the query, and from nowhere else", () => {
  const page = readFileSync(join(APP, "stage", "[stageId]", "page.js"), "utf-8");
  assert.match(page, /await\s+params/, "the stage id comes from the route segment");
  assert.match(page, /await\s+searchParams/, "the artifact id comes from the query string");
  assert.match(page, /artifact/, "the query key is named");
});

test("the artifact id is never turned into a path", () => {
  // The same rule the stage id follows. `readArtifactSummary` scans linted records for an exact id
  // match; nothing is concatenated onto a directory, so a hostile id is simply an id that matches
  // nothing rather than a traversal that has to be sanitised.
  const reader = readFileSync(join(APP, "_read", "planning.js"), "utf-8");
  const fn = reader.slice(reader.indexOf("export async function readArtifactSummary"));
  assert.ok(fn.includes("records"), "the lookup goes through the linted records");
  assert.ok(!/join\([^)]*id/.test(fn), "no path is built from the id");
  assert.ok(!/\$\{\s*id\s*\}/.test(fn.split("return")[0]), "the id is not interpolated into a path");
});
