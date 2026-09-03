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
import { withBuildLock } from "./helpers/build-lock.mjs";

installReaper();

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NEXT_CLI = join(ROOT, "node_modules", "next", "dist", "bin", "next");
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

  // ⚠️ HELD FOR THE WHOLE TEST, not just the build. This deletes `.next` and then serves from it;
  // `launcher.test.mjs` does the same, and `node --test` runs files in parallel.
  await withBuildLock(() => runSmokeCheck(t));
});

/**
 * ⚠️ **THE BUILD IS GIVEN A DECOY RUN IDENTITY, AND THE SERVER A DIFFERENT ONE.** `/health/kiln`
 * reports the identity of the RUNNING process; a route frozen into the build would report these.
 * That is the direct control on the property, rather than an argument about which Next versions
 * cache a `GET` by default — the answer to which has changed between releases and would leave the
 * check resting on a default nobody re-verifies.
 */
const BUILD_DECOY_RUN = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BUILD_DECOY_PROJECT = "cccccccccccccccccccccccccccccccc";
const STARTED_RUN = "1a2b3c4d5e6f708192a3b4c5d6e7f809";
const STARTED_PROJECT = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const HEALTH_PORT = PORT + 1;

async function runSmokeCheck(t) {
  rmSync(join(ROOT, ".next"), { recursive: true, force: true });
  const build = await execFileP(process.execPath, [NEXT_CLI, "build"], {
    cwd: ROOT,
    timeout: 6 * 60 * 1000,
    maxBuffer: 16 << 20,
    env: { ...process.env, KILN_RUN_ID: BUILD_DECOY_RUN, KILN_PROJECT_ID: BUILD_DECOY_PROJECT },
  });
  // The build's own words are NOT the assertion. They are kept only to report with a failure.
  const buildOut = `${build.stdout ?? ""}${build.stderr ?? ""}`;

  // A COPY, so the regression can run on every commit without touching the project's own content.
  const contentCopy = reapLater(mkdtempSync(join(tmpdir(), "vpw-smoke-")));
  cpSync(join(ROOT, "planning-content"), join(contentCopy, "planning-content"), { recursive: true });

  let server = null;
  try {
    server = spawn(process.execPath, [NEXT_CLI, "start", "--hostname", "127.0.0.1", "--port", String(PORT)], {
      cwd: ROOT,
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
    /* ---------------------------------------------------- the health endpoint, over real HTTP */

    // ⚠️ THIS SERVER WAS STARTED WITHOUT A RUN IDENTITY, so it is the unidentified case, transported
    // for real. A process nobody supervised must say so rather than answer with gaps — and this is
    // the assertion that a unit test of the response body cannot make, because what is under test
    // is the status and headers the ROUTE chose, not the ones the body implied.
    const unsupervised = await fetch(`http://127.0.0.1:${PORT}/health/kiln`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(unsupervised.status, 503, "an unsupervised process must not report itself ready");
    assert.match(unsupervised.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(unsupervised.headers.get("cache-control"), "no-store");
    assert.deepEqual(await unsupervised.json(), {
      service: "kiln",
      protocol: "kiln.health/1",
      error: "no-run-identity",
    });

    // ⚠️ A SECOND SERVER FROM THE SAME BUILD, started WITH an identity that differs from the one the
    // build saw. No rebuild: `next start` is cheap and the build lock is already held.
    const identified = spawn(
      process.execPath,
      [NEXT_CLI, "start", "--hostname", "127.0.0.1", "--port", String(HEALTH_PORT)],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PLANNING_CONTENT_DIR: join(contentCopy, "planning-content"),
          KILN_RUN_ID: STARTED_RUN,
          KILN_PROJECT_ID: STARTED_PROJECT,
        },
      }
    );
    try {
      const healthBy = Date.now() + 90_000;
      let health = null;
      while (Date.now() < healthBy && !health) {
        try {
          health = await fetch(`http://127.0.0.1:${HEALTH_PORT}/health/kiln`, { signal: AbortSignal.timeout(5_000) });
        } catch {
          await sleep(1000);
        }
      }
      assert.ok(health, `the identified server never accepted a connection on ${HEALTH_PORT}`);

      assert.equal(health.status, 200);
      assert.match(health.headers.get("content-type") ?? "", /^application\/json/);
      assert.equal(health.headers.get("cache-control"), "no-store");

      const body = await health.json();
      const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version;

      // The exact response, over the wire. ⚠️ Key SET, not key order — JSON object order is not
      // part of the protocol and pinning it would fail a reordering that changes nothing.
      assert.deepEqual(Object.keys(body).sort(), ["build", "projectId", "protocol", "runId", "service"]);
      assert.deepEqual(body, {
        service: "kiln",
        protocol: "kiln.health/1",
        runId: STARTED_RUN,
        projectId: STARTED_PROJECT,
        build: version,
      });

      // ⚠️ AND THE CONTROL: the identity is the one this SERVER was started with, never the one the
      // BUILD was given. A route frozen into the build would answer with the decoys, and would be
      // indistinguishable from a correct one by every other assertion above.
      assert.notEqual(body.runId, BUILD_DECOY_RUN, "the response carried the BUILD's identity — the route is frozen");
      assert.notEqual(body.projectId, BUILD_DECOY_PROJECT, "the response carried the BUILD's project identity");
    } finally {
      await killTree(identified);
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

    /* ------------------------------------------------- the client half actually SHIPS (CMP-0017) */

    // ⚠️ THE BUILD SUCCEEDING PROVES NOTHING HERE, AND NEITHER DOES THE HTML. A client component
    // that renders on the server and is never sent to the browser produces byte-identical markup
    // and is inert — the indicator would show "Connecting…" forever, or worse, sit on a reassuring
    // label while nothing can refresh the page. That is the same class of failure as a route that
    // builds while rendering nothing you wrote. So this asserts the markup is served AND that the
    // component's own text is inside a script the page actually loads.
    const shell = await (await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(15_000) })).text();
    assert.match(shell, /data-vpw-stream="/, "the indicator renders on every page, because it is in the layout");
    assert.match(shell, /Connecting|Receiving updates/, "and states itself in words, not colour alone");

    const scripts = [...shell.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, "a client component whose page loads no script can never run");

    let carriesWatchdog = false;
    for (const src of scripts) {
      const js = await (
        await fetch(new URL(src, `http://127.0.0.1:${PORT}/`), { signal: AbortSignal.timeout(15_000) })
      ).text();
      if (js.includes("Not receiving updates")) carriesWatchdog = true;
    }
    assert.ok(
      carriesWatchdog,
      "no script this page loads contains the watchdog's own text — the indicator would render once " +
        "and never change again, which is worse than having none: a label that reassures permanently"
    );

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

    /* ------------------------------------------------- the review write, end to end (ACC-0034) */

    // ⚠️ A REAL POST TO THE REAL SERVER ACTION, not a call to the logic behind it. Next.js renders
    // the form with a hidden `$ACTION_ID_…` field so it works without JavaScript, which means the
    // whole path — form markup, action dispatch, adapter, lock, atomic write, redirect, re-render —
    // can be exercised with `fetch`. `test/review-write.test.mjs` proves what the write does; this
    // proves the write is actually WIRED, which is the half a unit test cannot see.
    const reviewTarget = join(contentCopy, "planning-content", "data", "assertions", "AST-0021.json");
    const otherArtifact = join(contentCopy, "planning-content", "data", "assertions", "AST-0022.json");
    const reviewUrl = `/stage/${STAGE}?artifact=AST-0021`;

    const formPage = await (await fetch(`http://127.0.0.1:${PORT}${reviewUrl}`, { signal: AbortSignal.timeout(15_000) })).text();
    const actionId = (formPage.match(/name="(\$ACTION_ID_[a-f0-9]+)"/) ?? [])[1];
    assert.ok(actionId, "the form must be served with an action id, or it cannot submit without JavaScript");
    assert.match(formPage, /<form[^>]*method="POST"/i, "the review control must be a real form");
    assert.ok(
      !/name="type"/.test(formPage),
      "the form must not carry a type field — the type is derived from the id, never taken from the browser"
    );

    const submit = async (fields) => {
      const fd = new FormData();
      fd.set(actionId, "");
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      const res = await fetch(`http://127.0.0.1:${PORT}${reviewUrl}`, {
        method: "POST",
        body: fd,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      return { status: res.status, location: res.headers.get("location") };
    };

    const startDoc = JSON.parse(readFileSync(reviewTarget, "utf-8"));
    const otherBefore = readFileSync(otherArtifact, "utf-8");

    // ---- a successful change
    const ok = await submit({ id: "AST-0021", path: `/stage/${STAGE}`, status: "in-review", reviewedBy: "" });
    assert.equal(ok.status, 303, "a Server Action redirect, so the outcome survives in the URL");
    assert.equal(ok.location, reviewUrl, "back to the same page with the same artifact selected");

    // The DISK first, exactly as the unit tests do.
    const written = JSON.parse(readFileSync(reviewTarget, "utf-8"));
    assert.equal(written.reviewStatus, "in-review", "the artifact on disk must actually have changed");
    assert.equal(written.lifecycle, startDoc.lifecycle, "lifecycle must be untouched (ACC-0034)");
    assert.equal(written.statement, startDoc.statement, "and nothing else about the artifact moved");
    assert.equal(readFileSync(otherArtifact, "utf-8"), otherBefore, "no other artifact may change");

    // ...then the FRESHLY RENDERED page. A write that persisted while the page kept serving the old
    // value would satisfy every assertion above and still be broken for the operator.
    const afterWrite = await (await fetch(`http://127.0.0.1:${PORT}${reviewUrl}`, { signal: AbortSignal.timeout(15_000) })).text();
    assert.match(afterWrite, /data-vpw-review-status="in-review"/, "the page must render the value that was written");
    assert.ok(!/data-vpw-review-error=/.test(afterWrite), "and report no error");

    // ---- a refused change: visible, and the page is not discarded
    const bad = await submit({ id: "AST-0021", path: `/stage/${STAGE}`, status: "retired", reviewedBy: "" });
    assert.equal(bad.location, `${reviewUrl}&reviewError=bad-status`, "the failure comes back in the URL as a code");
    assert.equal(
      JSON.parse(readFileSync(reviewTarget, "utf-8")).reviewStatus,
      "in-review",
      "a refused submission must not change anything — `retired` is a LIFECYCLE value and unreachable here"
    );

    const errorPage = await (
      await fetch(`http://127.0.0.1:${PORT}${reviewUrl}&reviewError=bad-status`, { signal: AbortSignal.timeout(15_000) })
    ).text();
    assert.match(errorPage, /data-vpw-review-error="bad-status"/, "the failure must be visible on the page");
    assert.match(errorPage, /not a review status/, "in words, not just an attribute");
    assert.match(errorPage, /data-vpw-review-status="in-review"/, "and the panel still shows the artifact");
    assert.match(errorPage, new RegExp(`data-vpw-criteria="${STAGE}"`), "the rest of the page survives the failure");

    // ---- approving with nobody attached
    const unattributed = await submit({ id: "AST-0021", path: `/stage/${STAGE}`, status: "approved", reviewedBy: "" });
    assert.match(unattributed.location, /reviewError=needs-reviewer/, "an approval nobody is attached to is refused");
    assert.equal(JSON.parse(readFileSync(reviewTarget, "utf-8")).reviewStatus, "in-review", "and does not land");

    // ---- restore, so the rest of this test sees the content it expects
    writeFileSync(reviewTarget, JSON.stringify(startDoc, null, 2) + "\n");
    await sleep(800);

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
}

test("the marker is application-owned, so the check cannot pass on a stray page", () => {
  // ⚠️ Falsification in miniature: if this string ever appears in the framework's own output the
  // check above stops proving anything. It is deliberately project-specific for that reason.
  for (const { marker } of ROUTES) {
    assert.match(marker, /^data-vpw-route=/, "the marker must be ours, not the framework's");
    assert.ok(existsSync(join(ROOT, "app", "page.js")), "the route that owns the marker must exist");
  }
});
