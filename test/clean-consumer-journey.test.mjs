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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { FIXTURE_KEY, FIXTURE_KEY_VAR, FIXTURE_MODEL, FIXTURE_PROVIDER, modelsJson, startProviderFixture } from "./helpers/provider-fixture.mjs";
import { findBrowser, launchBrowser, until } from "./helpers/browser.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";
import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";

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

        // The outer repository still has no commit: nothing in the journey committed on the operator's behalf.
        assert.notEqual(spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: project }).status, 0, "a commit was made in the operator's repository");
      });
    } finally {
      if (browser) await browser.close();
      await fixture.close();
      rmSync(base, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 });
    }
  }
);
