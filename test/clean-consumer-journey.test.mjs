/**
 * TSK-0063: the documented journey, from an empty directory, with nothing replaced — toward ACC-0086, ACC-0087 and
 * ACC-0088's automated clauses.
 *
 * ⚠️ **THE README'S SEQUENCE, RUN AS WRITTEN.** `git init` in an empty directory, leaving the repository with no
 * commit; a real `git clone` of a tracked snapshot of this checkout into `.planning`; `node .planning/bin/setup.mjs`
 * without `--project-root`, which installs the locked dependencies inside the clone; then
 * `node .planning/bin/start-kiln.mjs`. The only departures are the ones a machine needs: setup's questions are
 * answered by their flags, and the model is TSK-0062's loopback fixture, so nothing billable exists to reach.
 *
 * ⚠️ **ONE PIPED TURN PER RUN, RESUMING THE SAME SESSION.** CI has no terminal, and without one Pi runs in print
 * mode: it reads its input to the end, answers once and exits. So the first run's input is `/kiln-start` itself —
 * test input, not the supervisor's automatic start prompt, which is sent only to an interactive session (ACC-0103)
 * — and every later run pipes one answer into the resumed session. An operator in a terminal gets one interactive
 * session instead; that path is ACC-0103's terminal control, ACC-0114's and ACC-0088's manual observations.
 *
 * ⚠️ **THE BROWSER IS RUNNING WHEN THE ANSWER IS WRITTEN (ACC-0087).** The fixture holds the answer turn until a
 * real headless browser shows the Stage 1 page, connected to the change stream and without the answer. The page is
 * marked, the write is released, and the page must then show the answer after a reload the stream caused: the mark
 * is gone and the test navigated nowhere. The attempted advance that follows is released only after that.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { FIXTURE_KEY, FIXTURE_KEY_VAR, FIXTURE_MODEL, FIXTURE_PROVIDER, modelsJson, startProviderFixture } from "./helpers/provider-fixture.mjs";
import { findBrowser, launchBrowser, until } from "./helpers/browser.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";
import { describeTraceFailures, inspectBuildTraces } from "./helpers/build-trace.mjs";
import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import { removeTestTree } from "./helpers/cleanup.mjs";

const ROOT = join(import.meta.dirname, "..");
/** Setup's locked install and the shell's first production build happen inside this bound. */
const LONG_MS = 12 * 60_000;
/** A later run: launch checks, the built shell, one turn, cleanup. */
const RUN_MS = 4 * 60_000;
/** How long the browser has to show each state. */
const PAGE_MS = 60_000;

const NAME = "Journey Project";
const DESCRIPTION = "A deterministic clean-consumer journey";
const Q1 = "JOURNEY-Q1-3c2e: what problem are you solving?";
const ANSWER = "JOURNEY-ANSWER-7a41: teams lose track of the decisions behind their plans";
const READING = "The problem is decisions going missing from plans.";
const Q2 = "JOURNEY-Q2-e5d0: who feels that most?";
const FOLLOWUP = "JOURNEY-FOLLOWUP-19bb: the people who inherit a plan";
const Q3 = "JOURNEY-Q3-06fa: what would change for them?";
const CRITERION = "ask-without-solution";
/** #186: names the operator's files that no build trace may contain. */
const TRACE_SENTINEL = "kiln186-sentinel";

const browserPath = findBrowser();

/** Run `node <args>` with `input` piped and closed, killed at `boundMs`. */
function node(args, { cwd, env, input = "", boundMs }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const bound = setTimeout(() => child.kill(), boundMs);
    child.on("close", (status, signal) => {
      clearTimeout(bound);
      done({ status, signal, stdout, stderr, out: `${stdout}\n${stderr}` });
    });
    child.stdin.end(input);
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

const answers = (port) =>
  new Promise((done) => {
    const req = request({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => {
      res.resume();
      done(true);
    });
    req.on("error", () => done(false));
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.end();
  });

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * A Git repository holding this checkout's tracked files as they are on disk, committed once.
 *
 * ⚠️ TRACKED FILES ONLY, SO THE CLONE IS WHAT A STRANGER WOULD GET, and their working-tree content, so the journey
 * tests the code under test rather than the last commit. A tracked file deleted but not committed is left out.
 */
function trackedSnapshot(into) {
  mkdirSync(into, { recursive: true });
  const files = git(["ls-files", "-z"], ROOT).split("\0").filter(Boolean);
  for (const f of files) {
    const from = join(ROOT, f);
    if (!existsSync(from) || !statSync(from).isFile()) continue;
    mkdirSync(dirname(join(into, f)), { recursive: true });
    copyFileSync(from, join(into, f));
  }
  git(["init", "-q"], into);
  git(["add", "-A"], into);
  git(["-c", "user.name=Kiln Journey", "-c", "user.email=journey@kiln.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "tracked snapshot"], into);
  return into;
}

/** sha256 of every file under `dir`, keyed by path relative to `base`, skipping the named top-level entries. */
function fingerprint(dir, base = dir, skip = new Set()) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(base, full).split("\\").join("/");
    if (skip.has(rel)) continue;
    if (entry.isDirectory()) for (const [k, v] of fingerprint(full, base, skip)) out.set(k, v);
    else if (entry.isFile()) out.set(rel, createHash("sha256").update(readFileSync(full)).digest("hex"));
  }
  return out;
}
const changedBetween = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();

const text = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join(""));
const users = (body) => (body?.messages ?? []).filter((m) => m.role === "user").map(text);
const toolResults = (body) => (body?.messages ?? []).filter((m) => m.role === "tool").map(text);
const offered = (body) => (body?.tools ?? []).map((t) => t.function?.name ?? t.name);

const PAGE_STATE = `(() => ({
  stream: document.querySelector('[data-vpw-stream]')?.getAttribute('data-vpw-stream') ?? null,
  document: document.querySelector('[data-vpw-document]')?.getAttribute('data-vpw-document') ?? null,
  text: document.querySelector('[data-vpw-document]')?.textContent ?? '',
  marked: window.__kilnJourneyMark === true,
}))()`;

test(
  "⚠️ TSK-0063 the documented journey from an empty directory: setup, Stage 1 in the browser, a refused advance, exact resume, stable setup and clean shutdown",
  {
    skip: browserPath || process.env.CI ? false : "no Chromium-based browser on this machine; CI runners have one",
    timeout: LONG_MS * 2 + RUN_MS * 3 + 5 * 60_000,
  },
  async () => {
    assert.ok(browserPath, "no Chromium-based browser was found, and ACC-0087 is observed in one");
    const sdk = await import(resolvePinnedSdk(ROOT).url);
    const startBody = sdk.parseFrontmatter(readFileSync(join(ROOT, "pi-package", "prompts", "kiln-start.md"), "utf8")).body;

    // ---- the scripted model: which turn this is decides the step ----------------------------------------------
    const hooks = { beforeWrite: null, afterWrite: null };
    const turnOf = (req) => {
      const last = users(req).at(-1);
      return last === startBody ? "start" : last === ANSWER ? "answer" : last === FOLLOWUP ? "followup" : "other";
    };
    const script = [
      async (req) => {
        if (offered(req).includes("kiln_preflight"))
          return { toolCalls: [{ name: "kiln_preflight", arguments: { challenge: /[0-9a-f]{32}/.exec(JSON.stringify(req.messages))?.[0] ?? "absent" } }] };
        const turn = turnOf(req);
        if (turn === "answer") {
          await hooks.beforeWrite();
          return { toolCalls: [{ name: "kiln_write_stage_document", arguments: { stage: "01-intake", verbatim: ANSWER, interpretation: READING } }] };
        }
        return { toolCalls: [{ name: "kiln_project_status", arguments: {} }] };
      },
      async (req) => {
        const turn = turnOf(req);
        if (turn === "answer") {
          await hooks.afterWrite();
          return { toolCalls: [{ name: "kiln_write_stage_attestation", arguments: { stage: "01-intake", criterion: CRITERION, result: "satisfied" } }] };
        }
        return { text: turn === "start" ? Q1 : Q3 };
      },
      { text: Q2 },
    ];
    const fixture = await startProviderFixture({ script });

    const base = mkdtempSync(join(tmpdir(), "kiln-journey-"));
    const project = join(base, "project");
    const agentDir = join(base, "agent");
    let browser = null;
    try {
      // ⚠️ THE BUILD LOCK, FOR THE WHOLE JOURNEY. Its shell builds inside the clone, not this checkout's .next, but
      // the launcher tests assert that no launcher's temporary directory exists anywhere once theirs has stopped, and
      // every test that starts a launcher takes this lock so that no other launcher is running while they look.
      await withBuildLock(async () => {
        const source = trackedSnapshot(join(base, "tool-source"));
        mkdirSync(project);
        // #186: the operator's own files, beside the clone and above it, which no build trace may name.
        mkdirSync(join(project, "src"));
        for (const sentinel of [join(base, `${TRACE_SENTINEL}-above.txt`), join(project, `${TRACE_SENTINEL}-root.txt`), join(project, `.env.${TRACE_SENTINEL}`), join(project, "src", `${TRACE_SENTINEL}-source.js`)])
          writeFileSync(sentinel, "the operator's, not Kiln's\n");
        mkdirSync(agentDir);
        writeFileSync(join(agentDir, "auth.json"), "{}");
        writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson(fixture.url)));
        const port = await freePort();
        const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PORT: String(port), [FIXTURE_KEY_VAR]: FIXTURE_KEY, PI_OFFLINE: "1" };
        // ⚠️ THE CONTENT ROOT IS THE CONSUMER LAYOUT'S, resolved beside the clone as the README's operator gets it.
        delete env.PLANNING_CONTENT_DIR;

        // ---- the README's sequence --------------------------------------------------------------------------------
        git(["init", "-q"], project);
        git(["clone", "-q", source, ".planning"], project);
        const setupArgs = [
          join(".planning", "bin", "setup.mjs"),
          ...["--name", NAME, "--description", DESCRIPTION, "--trust", "approve", "--inspect", "approve"],
          ...["--provider", FIXTURE_PROVIDER, "--model", FIXTURE_MODEL, "--thinking", "off", "--model-use", "approve"],
          ...["--research", "disabled", "--live-model-check", "approve", "--credential-var", FIXTURE_KEY_VAR, "--non-interactive"],
          ...["--state-protection", "fix-ignore"],
        ];
        const setup = await node(setupArgs, { cwd: project, env, boundMs: LONG_MS });
        assert.equal(setup.signal, null, `setup was killed at its bound: ${setup.out}`);
        assert.equal(setup.status, 0, setup.out);
        const contentRoot = join(project, "planning-content");
        assert.ok(existsSync(join(contentRoot, "stages", "01-intake.md")), "setup created the Stage 1 document beside the clone");
        assert.ok(existsSync(join(project, ".planning", "node_modules", "@earendil-works", "pi-coding-agent")), "setup installed the locked dependencies inside the clone");
        const nestedBrace = JSON.parse(readFileSync(join(
          project,
          ".planning",
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "node_modules",
          "brace-expansion",
          "package.json"
        ), "utf8"));
        assert.equal(
          nestedBrace.version,
          "5.0.12",
          "setup's trusted post-install repair did not replace Pi's vulnerable shrinkwrapped brace-expansion"
        );
        // ⚠️ #185: SETUP NAMES THE PACKAGE AND THE VERSION IT LEFT, and says which of the two things it did. Pi's
        // shrinkwrap decides which, so either is accepted here; `setup-command.test.mjs` holds each form.
        const did = /^(?:\[kiln\] )?Pi dependency brace-expansion 5\.0\.12 (repaired|verified)$/m.exec(setup.out)?.[1];
        assert.ok(did, setup.out);
        // npm's advisory count is from before the repair. When a repair was made, setup says so and does not call
        // the count a finding about the tree it left.
        if (did === "repaired") assert.equal(/dependency advisor(?:y|ies) found/.test(setup.out), false, `setup reported npm's pre-repair count as current:\n${setup.out}`);
        if (/dependency advisor/.test(setup.out) && did === "repaired")
          assert.match(setup.out, /npm reported \d+ dependency advisor(?:y|ies) before repairing brace-expansion; run npm --prefix \.planning audit for the current result\./, setup.out);

        // ⚠️ #185: BOTH AUDITS, AFTER THE REAL SETUP PATH. These say what a consumer who runs either is told, and that
        // npm's own answer and Kiln's gate over it are the same answer. Run before anything else touches the clone.
        //
        // ⚠️ THE TWO DO NOT SEE THE SAME THING, AND THE VERSION ASSERTION ABOVE IS NOT REDUNDANT. `npm audit` reads
        // `package-lock.json`, not `node_modules`: measured on a clone whose nested package was the vulnerable 5.0.9
        // while the lockfile named 5.0.12, it reported nothing. It is the lockfile's answer. What is installed is
        // checked by the assertion above and by the gate, which reads the installed package before it audits.
        const npm = (args) => spawnSync(`npm ${args}`, { cwd: join(project, ".planning"), env, encoding: "utf8", shell: true, windowsHide: true, timeout: 5 * 60_000 });
        const raw = npm("audit --omit=dev --json");
        let report = null;
        try {
          report = JSON.parse(raw.stdout);
        } catch {
          assert.fail(`npm audit --omit=dev --json did not return a report (exit ${raw.status}): ${raw.stdout.slice(0, 1500)}\n${raw.stderr.slice(0, 1500)}`);
        }
        assert.equal(report.error, undefined, `npm audit could not reach an answer: ${JSON.stringify(report.error)}`);
        const counts = report.metadata?.vulnerabilities;
        assert.ok(counts && Number.isInteger(counts.high) && Number.isInteger(counts.critical), `npm audit returned no severity counts: ${raw.stdout.slice(0, 1500)}`);
        const serious = Object.entries(report.vulnerabilities ?? {}).filter(([, v]) => v.severity === "high" || v.severity === "critical").map(([name, v]) => `${name} (${v.severity}, ${(v.nodes ?? []).join(", ")})`);
        assert.deepEqual(serious, [], "a clean setup left a high or critical production advisory in the installed tree");
        assert.deepEqual([counts.high, counts.critical], [0, 0]);
        const gated = npm("run audit:production");
        assert.equal(gated.status, 0, `npm run audit:production failed after a clean setup:\n${gated.stdout}\n${gated.stderr}`);
        // The same result, read from the gate: no advisory, and none waved through by an exception.
        assert.match(gated.stdout, /\[production-audit\] pass: 0 high\/critical production advisories, 0 excepted\./, gated.stdout);
        assert.equal(/\[production-audit\] (?:blocked|temporary exception|invalid exception)/.test(`${gated.stdout}\n${gated.stderr}`), false, `${gated.stdout}\n${gated.stderr}`);
        // Auditing changed nothing in the clone: the lockfile is still the committed one.
        assert.equal(git(["status", "--porcelain", "--", "package.json", "package-lock.json"], join(project, ".planning")), "", "setup or an audit rewrote the clone's manifest or lockfile");
        const ignore = readFileSync(join(project, ".gitignore"), "utf8");
        assert.match(ignore, /^\/?\.planning\/?$/m, `setup did not ignore .planning: ${ignore}`);

        const start = (input, boundMs) => node([join(".planning", "bin", "start-kiln.mjs")], { cwd: project, env, input: `${input}\n`, boundMs });
        const attestations = () => fingerprint(join(contentRoot, "state", "stage-attestations"));
        const checkRun = async (r, label) => {
          assert.equal(r.signal, null, `${label} was killed at its bound: ${r.out}`);
          assert.equal(r.status, 0, `${label}: ${r.out}`);
          assert.match(r.stdout, /\[kiln\] ready — identity confirmed/, `${label}: ${r.out}`);
          assert.match(r.stdout, new RegExp(`\\[kiln\\] run \\S+ · project \\S+ · http://127\\.0\\.0\\.1:${port}`), `${label} did not print the workspace address: ${r.out}`);
          assert.match(r.stdout, /\[kiln\] stopped \(agent-exit\) — stop sent: true, stdin end requested: true, launcher exit observed: true, launcher tree stopped: true/, `${label}: ${r.out}`);
          assert.equal(r.stdout.includes("run file(s) from earlier runs"), false, `${label} found an earlier run's files left behind: ${r.out}`);
          // ⚠️ THE LAUNCHER'S OWN RUN DIRECTORY IS GONE TOO. It is removed only by the launcher's graceful stop, so one
          // left behind means the launcher was killed rather than stopped.
          const runDir = /run directory: (\S+)/.exec(r.out)?.[1];
          assert.ok(runDir, `${label}: the launcher did not report its run directory: ${r.out}`);
          assert.equal(existsSync(runDir), false, `${label} left its launcher's run directory behind: ${runDir}\n${r.out}`);
          // ⚠️ AND IT WAS A STOP, NOT A KILL: neither the supervisor nor the launcher had to escalate (F15).
          assert.equal(/did not exit within|escalating/.test(r.out), false, `${label} had to kill something to stop: ${r.out}`);
          assert.equal(await answers(port), false, `${label}: something still answers on port ${port}`);
          return /\[kiln\] session (\S+) \(([^)]*)\)/.exec(r.stdout)?.slice(1) ?? [null, null];
        };

        // ---- run 1: /kiln-start reaches a Stage 1 question (ACC-0086) ------------------------------------------------
        const before1 = fixture.requests.length;
        const run1 = await start("/kiln-start", LONG_MS);
        const [sessionId, state1] = await checkRun(run1, "run 1");
        assert.equal(state1, "new, recorded", run1.out);
        const turn1 = fixture.requests.slice(before1);
        assert.equal(turn1.length, 2, `run 1 made ${turn1.length} provider requests, not two: ${run1.out}`);
        assert.deepEqual(users(turn1[1].body), [startBody], "the first turn is Pi's own expansion of /kiln-start");
        const status1 = JSON.parse(toolResults(turn1[1].body).at(-1));
        assert.equal(status1.ok, true, JSON.stringify(status1));
        assert.equal(status1.artifactCount, 0, JSON.stringify(status1));
        assert.ok(JSON.stringify(status1.blockers).includes("Stage 01-intake"), JSON.stringify(status1));
        assert.ok(run1.stdout.includes(Q1), `Pi did not print the Stage 1 question: ${run1.out}`);

        // ---- run 2: the answer, written while the browser watches, then a refused advance (ACC-0087) ---------------
        browser = await launchBrowser(browserPath);
        const { page } = browser;
        const stageUrl = `http://127.0.0.1:${port}/stage/01-intake`;
        const seen = {};
        hooks.beforeWrite = async () => {
          await page.goto(stageUrl);
          const ready = await until(page, PAGE_STATE, (s) => s?.stream === "live" && s.document === "01-intake.md", PAGE_MS);
          seen.before = ready;
          if (!ready.ok) throw new Error(`the stage page never showed a live stream and its document: ${JSON.stringify(ready.value)}`);
          await page.eval("window.__kilnJourneyMark = true");
          seen.navigationsBefore = page.events.filter((e) => e.method === "Page.frameNavigated").length;
        };
        hooks.afterWrite = async () => {
          seen.after = await until(page, PAGE_STATE, (s) => s?.stream === "live" && !s.marked && s.text.includes(ANSWER), PAGE_MS);
          seen.navigationsAfter = page.events.filter((e) => e.method === "Page.frameNavigated").length;
        };
        const attestationsBefore = attestations();
        const before2 = fixture.requests.length;
        const run2 = await start(ANSWER, RUN_MS);
        const [id2, state2] = await checkRun(run2, "run 2");
        assert.equal(state2, "resumed from the record", run2.out);
        assert.equal(id2, sessionId, "run 2 resumed the exact recorded session");

        assert.ok(seen.before?.ok, `the page before the write: ${JSON.stringify(seen.before)}`);
        assert.equal(seen.before.value.text.includes(ANSWER), false, "the page showed the answer before it was written");
        assert.ok(seen.after?.ok, `the page never showed the answer after the write: ${JSON.stringify(seen.after)}`);
        // ⚠️ THE BROWSER WAS STILL OPEN AND SUBSCRIBED WHEN RUN 2 STOPPED, so the graceful stop checked above was made
        // with a page connected (F15). It has since lost its stream because the server went away, not because it closed.
        const afterStop = await until(page, PAGE_STATE, (st) => st !== null && st.stream !== "live", PAGE_MS);
        assert.ok(afterStop.ok, `the page still reports a live stream after shutdown: ${JSON.stringify(afterStop.value)}`);
        assert.ok(seen.navigationsAfter > seen.navigationsBefore, "the page did not reload");
        const turn2 = fixture.requests.slice(before2);
        assert.equal(turn2.length, 3, `run 2 made ${turn2.length} provider requests, not three: ${run2.out}`);
        const written = JSON.parse(toolResults(turn2[1].body).at(-1));
        assert.equal(written.ok, true, `the typed write failed: ${JSON.stringify(written)}`);
        assert.equal(written.path, "stages/01-intake.md");
        const stageDoc = readFileSync(join(contentRoot, "stages", "01-intake.md"), "utf8");
        assert.ok(stageDoc.includes(ANSWER) && stageDoc.includes(READING), "the answer and its reading are in the Stage 1 document");
        const advance = JSON.parse(toolResults(turn2[2].body).at(-1));
        assert.equal(advance.ok, false, `the unauthorised attestation was not refused: ${JSON.stringify(advance)}`);
        assert.equal(advance.code, "operator-confirmation-not-granted", JSON.stringify(advance));
        assert.deepEqual(changedBetween(attestationsBefore, attestations()), [], "an attestation changed");
        assert.ok(run2.stdout.includes(Q2), `Pi did not print the next question: ${run2.out}`);

        // ---- run 3: the exchange continues in the same session -----------------------------------------------------
        const before3 = fixture.requests.length;
        const run3 = await start(FOLLOWUP, RUN_MS);
        const [id3, state3] = await checkRun(run3, "run 3");
        assert.equal(state3, "resumed from the record", run3.out);
        assert.equal(id3, sessionId, "run 3 resumed the exact recorded session");
        const turn3 = fixture.requests.slice(before3);
        assert.equal(turn3.length, 2, `run 3 made ${turn3.length} provider requests, not two`);
        assert.deepEqual(users(turn3[1].body), [startBody, ANSWER, FOLLOWUP], "the session carries every turn");
        assert.ok(run3.stdout.includes(Q3), run3.out);

        // ---- setup again changes no byte of the project (ACC-0088) --------------------------------------------------
        const projectBefore = fingerprint(project, project, new Set([".planning", ".git"]));
        const again = await node(setupArgs, { cwd: project, env, boundMs: LONG_MS });
        assert.equal(again.status, 0, again.out);
        assert.deepEqual(changedBetween(projectBefore, fingerprint(project, project, new Set([".planning", ".git"]))), [], "setup's rerun changed the project");
        assert.equal(git(["status", "--porcelain"], join(project, ".planning")), "", "the clone's tracked files changed");
        // #185: a second setup finds the dependency already as it should be, and says that instead.
        assert.match(again.out, /^(?:\[kiln\] )?Pi dependency brace-expansion 5\.0\.12 verified$/m, again.out);

        // The outer repository still has no commit: nothing in the journey committed on the operator's behalf.
        assert.notEqual(spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: project }).status, 0, "a commit was made in the operator's repository");

        // ---- #186: what the clone's production build recorded in its traces ------------------------------------------
        // ⚠️ THE MANIFESTS, NOT THE BUILD'S OUTPUT. The launcher built the shell inside the clone on run 1, from
        // nothing. Every entry of every trace is resolved to the file it names: none may be outside the clone, none
        // may be inside it except under a justified runtime root, and together they stay under the ceilings.
        const traces = inspectBuildTraces(join(project, ".planning"));
        // Printed on every run: the ceilings are set from these totals, and they differ by platform.
        console.log(`[#186] trace totals on ${process.platform}: ${traces.manifests} manifests, ${traces.files} files, ${traces.bytes} bytes, ${traces.platformBytes} bytes of platform binaries`);
        assert.ok(traces.manifests >= 5,`the clone's build left ${traces.manifests} trace manifests to inspect`);
        assert.equal(traces.violations.length + traces.ceilings.length, 0, `the production build traced files it has no reason to:\n${describeTraceFailures(traces)}`);
        const realContent = realpathSync.native(contentRoot);
        assert.deepEqual(traces.resolved.filter((file) => file.includes(TRACE_SENTINEL) || file.startsWith(realContent)), [], "a trace names the operator's files");

        // ---- #185: the gate reads what is installed, which npm's audit does not ---------------------------------------
        // ⚠️ THE NEGATIVE CONTROL, AND THE LAST THING DONE TO THE CLONE. The passing audits above would pass over an
        // unrepaired tree too, as far as `npm audit` goes: it reads the lockfile. So the installed nested package is
        // made to say it is the vulnerable release, and the gate must refuse on that alone. Nothing uses the clone
        // after this.
        const nestedManifest = join(project, ".planning", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "brace-expansion", "package.json");
        writeFileSync(nestedManifest, JSON.stringify({ ...JSON.parse(readFileSync(nestedManifest, "utf8")), version: "5.0.9" }, null, 2));
        const refused = npm("run audit:production");
        assert.equal(refused.status, 1, `the gate passed a clone whose nested brace-expansion says 5.0.9:\n${refused.stdout}\n${refused.stderr}`);
        assert.ok(refused.stderr.includes("[production-audit] installed dependency check failed: Pi has brace-expansion 5.0.9; expected 5.0.12."), `${refused.stdout}\n${refused.stderr}`);
        // And npm's own audit of the same clone still reports nothing, which is why the control is on the gate.
        const blind = JSON.parse(npm("audit --omit=dev --json").stdout);
        assert.deepEqual([blind.metadata.vulnerabilities.high, blind.metadata.vulnerabilities.critical], [0, 0], "npm audit now reads the installed package; the comments here and the reason for this control are out of date");
      });
    } finally {
      if (browser) await browser.close();
      await fixture.close();
      removeTestTree(base, "TSK-0063 journey");
    }
  }
);
