/**
 * The route smoke check — build the real application, start it, and prove each required route is
 * SERVED by asserting a marker the application itself owns.
 *
 * ⚠️ IT EXISTS BECAUSE "the build succeeded" HAS TWICE MEANT NOTHING. TSK-0003 put the routes at
 * `src/app/` and Next.js ignored them, because a root `app/` directory takes precedence — the build
 * printed `✓ Compiled successfully` and served only `/404`. TSK-0004 put a probe at `app/_probe/`
 * and the leading underscore made it a PRIVATE FOLDER, opted out of routing — the build succeeded
 * again and the route never existed. Two different causes, same shape: a build that succeeds while
 * rendering nothing you wrote.
 *
 * ⚠️ SO THIS ASSERTS AN APPLICATION-OWNED MARKER, never a success message and never the route table.
 * `data-vpw-route` is written by our own page and by nothing else; Next.js cannot emit it, and a
 * page that failed to render cannot either. Parsing the build's output would just be trusting the
 * same sentence that was true both times it lied.
 *
 * ⚠️ It is slow on purpose: a real production build and a real server. This is the check that
 * ACC-0033 will ultimately rest on, and a fast proxy for it would be a proxy for the wrong thing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4410;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every route the shell must serve, with the marker that proves the APPLICATION rendered it.
 * ⚠️ Extend this as routes land — `/stage/[stageId]` joins it with TSK-0009.
 */
const ROUTES = [
  {
    path: "/",
    // The route rendered at all...
    marker: 'data-vpw-route="/"',
    // ...and the panel that does the READING rendered too. Without the second marker a page whose
    // Suspense boundary never resolved would still pass: the shell ships, the fallback ships, and
    // the content never arrives. That is the streaming version of "a build that succeeds while
    // rendering nothing you wrote".
    also: ["data-vpw-stages=", "data-vpw-current="],
  },
];

async function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === "win32") await execFileP("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
    else proc.kill("SIGKILL");
  } catch { /* already gone */ }
  await sleep(500);
}

test("every required route is built and served, proven by an application-owned marker", async (t) => {
  t.diagnostic("production build + start; this is the slow one");

  rmSync(join(ROOT, ".next"), { recursive: true, force: true });
  const build = await execFileP("npx", ["next", "build"], {
    cwd: ROOT,
    timeout: 6 * 60 * 1000,
    maxBuffer: 16 << 20,
    shell: process.platform === "win32",
  });
  // The build's own words are NOT the assertion. They are kept only to report with a failure.
  const buildOut = `${build.stdout ?? ""}${build.stderr ?? ""}`;

  let server = null;
  try {
    server = spawn("npx", ["next", "start", "--hostname", "127.0.0.1", "--port", String(PORT)], {
      cwd: ROOT,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const readyBy = Date.now() + 90_000;
    let up = false;
    while (Date.now() < readyBy && !up) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(5_000) });
        up = true;
      } catch {
        await sleep(1000);
      }
    }
    assert.ok(up, `the server never accepted a connection on ${PORT}`);

    for (const { path, marker, also = [] } of ROUTES) {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(15_000) });
      const html = await res.text();
      assert.equal(res.status, 200, `${path} returned ${res.status}`);
      for (const m of also)
        assert.ok(html.includes(m), `${path} rendered but its reading panel never produced ${m}`);
      assert.ok(
        html.includes(marker),
        `${path} responded without its application-owned marker ${marker}. A 200 alone does not ` +
          `mean the intended route rendered — Next.js serves a 404 page with a 200 in some ` +
          `configurations, and both prior failures of this kind produced a clean build.\n` +
          `build output was:\n${buildOut.slice(-800)}`
      );
    }
  } finally {
    await killTree(server);
  }
});

test("the marker is application-owned, so the check cannot pass on a stray page", () => {
  // ⚠️ Falsification in miniature: if this string ever appears in the framework's own output the
  // check above stops proving anything. It is deliberately project-specific for that reason.
  for (const { marker } of ROUTES) {
    assert.match(marker, /^data-vpw-route=/, "the marker must be ours, not the framework's");
    assert.ok(existsSync(join(ROOT, "app", "page.js")), "the route that owns the marker must exist");
  }
});
