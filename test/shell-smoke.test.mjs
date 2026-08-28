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
 * ⚠️ IT ALSO PROVES THE PAGE IS NOT FROZEN INTO THE BUILD, using the SAME build. The marker shows
 * the panel resolved; it does not show the panel is still reading. So the server is started against
 * a temporary COPY of `planning-content`, an attestation in that copy is changed while it runs, and
 * the displayed stage is required to move. A route that had been prerendered would keep serving the
 * first answer — which is AST-0019 exactly, and the failure DEC-0019's contract exists to prevent.
 * The copy is why this can be a regression test rather than a one-off measurement: the real content
 * is never touched.
 *
 * ⚠️ It is slow on purpose: a real production build and a real server. This is the check that
 * ACC-0033 will ultimately rest on, and a fast proxy for it would be a proxy for the wrong thing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync, cpSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { reapLater, installReaper } from "./helpers/reap.mjs";

installReaper();

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4410;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every route the shell must serve, with the marker that proves the APPLICATION rendered it.
 * ⚠️ Extend this as routes land — `/stage/[stageId]` joins it with TSK-0009.
 */
const STAGE = "06-risk-feasibility";

const ROUTES = [
  {
    path: `/stage/${STAGE}?artifact=AST-0021`,
    marker: 'data-vpw-route="/stage"',
    // Each of the three independent boundaries must RESOLVE, not merely ship its fallback. A page
    // whose reads never completed streams the shell and stops, which looks identical to success from
    // the status line.
    also: [`data-vpw-criteria="${STAGE}"`, "data-vpw-criterion=", "data-vpw-document=", 'data-vpw-review="AST-0021"'],
  },
  {
    path: "/",
    // The route rendered at all...
    marker: 'data-vpw-route="/"',
    // ...and the panel that does the READING rendered too. Without the second marker a page whose
    // Suspense boundary never resolved would still pass: the shell ships, the fallback ships, and
    // the content never arrives. That is the streaming version of "a build that succeeds while
    // rendering nothing you wrote".
    also: ["data-vpw-stages=", "data-vpw-current=", "data-vpw-diagnostics=", "data-vpw-count=", "data-vpw-lint="],
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

  // A COPY, so the regression can run on every commit without touching the project's own content.
  const contentCopy = reapLater(mkdtempSync(join(tmpdir(), "vpw-smoke-")));
  cpSync(join(ROOT, "planning-content"), join(contentCopy, "planning-content"), { recursive: true });

  let server = null;
  try {
    server = spawn("npx", ["next", "start", "--hostname", "127.0.0.1", "--port", String(PORT)], {
      cwd: ROOT,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PLANNING_CONTENT_DIR: join(contentCopy, "planning-content") },
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
    /* ---------------------------------------------------------- the freshness regression */

    const currentOf = async () => {
      const html = await (await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(15_000) })).text();
      return (html.match(/data-vpw-current="([^"]*)"/) ?? [])[1] ?? null;
    };

    const before = await currentOf();
    assert.ok(before !== null, "the panel never reported a current stage");

    // Make the FIRST stage unready in the copy, so the earliest-unready rule has a definite answer.
    const attestations = join(contentCopy, "planning-content", "state", "stage-attestations", "01-intake.json");
    const doc = JSON.parse(readFileSync(attestations, "utf-8"));
    const firstCriterion = Object.keys(doc.attestations)[0];
    doc.attestations[firstCriterion] = {
      result: "not-satisfied",
      decidedBy: "smoke-test",
      reason: "Temporary, in a copy: proving the running application still reads rather than serving a frozen build.",
    };
    writeFileSync(attestations, JSON.stringify(doc, null, 2) + "\n");

    await sleep(1500);
    const after = await currentOf();

    assert.notEqual(
      after,
      before,
      `the displayed stage did not move after an attestation changed on disk (still ${after}). ` +
        `That is a page frozen into the build, which is what AST-0019 measured and DEC-0019 forbids.`
    );
    assert.equal(after, "01-intake", `expected the first stage to become current, got ${after}`);

    /* ------------------------------------------------- the change stream (ACC-0028) */

    // ⚠️ READ INCREMENTALLY, NEVER `await res.text()`. An event stream does not finish; awaiting
    // the body would hang until the timeout and report a stream that was working perfectly as a
    // failure. The reader is released as soon as both frames have been seen.
    const streamFrames = async (afterOpen) => {
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${PORT}/events`, {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
      assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let fired = false;
      const deadline = Date.now() + 20_000;

      while (Date.now() < deadline) {
        if (!fired && /event: heartbeat/.test(text)) {
          fired = true;
          await afterOpen();
        }
        if (/event: heartbeat/.test(text) && /event: change/.test(text)) break;
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        /* the abort already tore it down */
      }
      return text;
    };

    const watched = join(contentCopy, "planning-content", "data", "assertions", "AST-0001.json");
    const frames = await streamFrames(async () => {
      await sleep(300);
      writeFileSync(watched, readFileSync(watched, "utf-8"));
    });

    assert.match(frames, /event: heartbeat/, "a NAMED heartbeat, not a comment frame — a comment fires no listener");
    assert.match(frames, /data: \{"ok":true\}/, "carrying data, so a client listener receives something");
    assert.match(frames, /event: change/, "and a change hint after a real file was written");
    assert.ok(!/^id:/m.test(frames), "no event ids: hints are not deltas, so there is nothing to resume");

    /* ------------------------------------------------- totals stay truthful under corruption (ACC-0014/0015) */

    const diagnosticsOf = async () => {
      const html = await (await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(15_000) })).text();
      const counts = {};
      for (const m of html.matchAll(/data-vpw-count="([^"]+)" data-vpw-count-value="([^"]+)"/g))
        counts[m[1]] = Number(m[2]);
      return { html, counts, unreadable: (html.match(/data-vpw-unreadable="([0-9]+)"/) ?? [])[1] ?? null };
    };

    const healthy = await diagnosticsOf();
    assert.ok(healthy.counts.assertion > 0, "the totals must render at all");
    assert.equal(healthy.unreadable, null, "a healthy project reports nothing unreadable");

    // ⚠️ ORACLE: the count of PARSABLE files of that type in the copy, computed here, outside the
    // application. Comparing the page against itself is what made the original ACC-0014 vacuous.
    const assertionDir = join(contentCopy, "planning-content", "data", "assertions");
    const parsable = readdirSync(assertionDir).filter((f) => {
      if (!f.endsWith(".json")) return false;
      try {
        JSON.parse(readFileSync(join(assertionDir, f), "utf-8"));
        return true;
      } catch {
        return false;
      }
    }).length;
    assert.equal(healthy.counts.assertion, parsable, "the displayed total must equal the fixture oracle");

    // Corrupt exactly one, with the server running and nothing rebuilt.
    const victim = join(assertionDir, readdirSync(assertionDir).filter((f) => f.endsWith(".json")).sort()[0]);
    const original = readFileSync(victim, "utf-8");
    writeFileSync(victim, "{ this is not json");
    await sleep(1500);

    const corrupted = await diagnosticsOf();
    assert.equal(
      corrupted.counts.assertion,
      healthy.counts.assertion - 1,
      "the corrupted artifact must be subtracted from its own type"
    );
    assert.equal(corrupted.counts.decision, healthy.counts.decision, "and from no other type");
    assert.equal(corrupted.unreadable, "1", "the page must say one artifact could not be read");
    assert.match(
      corrupted.html,
      /data-vpw-unreadable-at="planning-content\/data\/assertions\/[A-Z]+-[0-9]+[.]json:[0-9]+:[0-9]+"/,
      "with a repository-relative path and a parse position"
    );
    assert.match(corrupted.html, /data-vpw-stages=/, "every other section still renders");
    assert.match(corrupted.html, /data-vpw-lint=/, "including the lint region");

    // Restore it: both the count and the error state must recover, still without a rebuild.
    writeFileSync(victim, original);
    await sleep(1500);
    const restored = await diagnosticsOf();
    assert.equal(restored.counts.assertion, healthy.counts.assertion, "the total must come back");
    assert.equal(restored.unreadable, null, "and the error state must clear");

    /* ------------------------------------------------- selection is recoverable from the URL (ACC-0035) */

    // ⚠️ A FRESH SESSION IS THE POINT. `fetch` carries no cookies, no storage and no memory of
    // the previous request, so each call below IS a fresh session by construction. If either
    // selection lived anywhere but the URL, the second visitor would not see what the first did.
    const selectionsOf = (html) => ({
      stage: (html.match(/data-vpw-criteria="([^"]*)"/) ?? [])[1] ?? null,
      artifact: (html.match(/data-vpw-review="([^"]*)"/) ?? [])[1] ?? null,
    });
    const visit = async (url) =>
      selectionsOf(await (await fetch(`http://127.0.0.1:${PORT}${url}`, { signal: AbortSignal.timeout(15_000) })).text());

    const first = await visit(`/stage/${STAGE}?artifact=AST-0021`);
    assert.deepEqual(first, { stage: STAGE, artifact: "AST-0021" }, "both selections must come back");

    const reloaded = await visit(`/stage/${STAGE}?artifact=AST-0021`);
    assert.deepEqual(reloaded, first, "the same URL in a fresh session must restore the same selections");

    // ⚠️ The control. Without it the assertions above would pass on a page that ignored the URL
    // entirely and always showed the same thing.
    const other = await visit("/stage/01-intake?artifact=AST-0022");
    assert.deepEqual(other, { stage: "01-intake", artifact: "AST-0022" }, "a different URL must select differently");

    // An id that matches nothing is a VISIBLE not-found, never a silent fallback to another artifact.
    const bogus = await (
      await fetch(`http://127.0.0.1:${PORT}/stage/${STAGE}?artifact=NOPE-9999`, { signal: AbortSignal.timeout(15_000) })
    ).text();
    assert.match(bogus, /data-vpw-review="unknown"/, "an unknown artifact must say so");
    assert.ok(!/data-vpw-review="[A-Z]{3}-[0-9]{4}"/.test(bogus), "and must not select a different artifact instead");
    assert.match(bogus, /NOPE-9999/, "the id the operator asked for is echoed back so the typo is findable");
    assert.match(bogus, new RegExp(`data-vpw-criteria="${STAGE}"`), "the rest of the page still renders");

    /* ------------------------------------------------- a permitted component renders (ACC-0018) */

    const stageDocForComponent = join(contentCopy, "planning-content", "stages", `${STAGE}.md`);
    writeFileSync(
      stageDocForComponent,
      ["# Stage six", "", "<Callout>the mapped component rendered</Callout>", ""].join("\n")
    );
    await sleep(1500);

    const permitted = await (
      await fetch(`http://127.0.0.1:${PORT}/stage/${STAGE}`, { signal: AbortSignal.timeout(15_000) })
    ).text();
    assert.match(permitted, /data-vpw-mdx="Callout"/, "a permitted component must render, not be dropped");
    assert.match(permitted, /the mapped component rendered/);
    assert.match(permitted, /<h1[^>]*>Stage six/, "markdown structure must render too");

    /* ------------------------------------------------- a refused document must fail VISIBLY */

    // ⚠️ ACC-0036, and it is a regression test rather than a nicety: AST-0039 measured that an
    // uncaught rejection reaches the browser as HTTP 200 and an opaque digest, so the operator sees a
    // blank region and a success status for a document the compiler refused precisely.
    const stageDoc = join(contentCopy, "planning-content", "stages", `${STAGE}.md`);
    writeFileSync(stageDoc, ["# Stage", "", "<Danger>an unmapped component</Danger>", ""].join("\n"));
    await sleep(1500);

    const refused = await (await fetch(`http://127.0.0.1:${PORT}/stage/${STAGE}`, { signal: AbortSignal.timeout(15_000) })).text();

    assert.match(refused, /data-vpw-document="rejected"/, "the document region must say it was refused");
    assert.match(
      refused,
      // ⚠️ Character classes rather than `\d`/`\.` escapes: this is a template literal, and an escape
      // here is consumed by the string before the regex ever sees it.
      new RegExp(`data-vpw-rejection-at="planning-content/stages/${STAGE}[.]md:[0-9]+:[0-9]+"`),
      "the refusal must carry a repository-relative path and a line:column"
    );
    assert.match(refused, /&lt;Danger&gt;/, "the diagnostic must be escaped as text, never interpolated as markup");
    assert.ok(!refused.includes("<Danger>"), "the refused source must not reach the page as live markup");
    assert.match(refused, /data-vpw-criterion=/, "the exit criteria must still render beside a refused document");
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
