/**
 * The consumer layout, end to end — a project directory that has never seen Kiln, initialized and
 * then opened by the real commands.
 *
 * ⚠️ **THE TOOL IS COPIED WITHOUT `node_modules`, AND THAT IS AN ASSERTION RATHER THAN A SHORTCUT.**
 * `init-project.mjs` is documented as the first command a user runs — before `npm install`, because
 * it is what creates the project the install is for. If anything in its import graph reached for a
 * package, this test would fail with `Cannot find package`, which is exactly what the user would see.
 * A copy that included `node_modules` would prove nothing about that claim.
 *
 * ⚠️ **IT IS A REAL SIBLING LAYOUT, NOT `PLANNING_CONTENT_DIR`.** Every other test in this suite names
 * the content root through the override, so every other test passes whether or not the sibling rule
 * works. Here nothing sets the variable: `.planning/` and `planning-content/` sit beside each other on
 * disk and the resolver has to find the second from the first, which is the arrangement every consumer
 * install actually has and the one this project could not previously produce.
 *
 * ⚠️ **THE LAUNCHER IS RUN AND ALLOWED TO FAIL.** The copy has no dependencies, so `next build` cannot
 * succeed there — but the content root is resolved and printed BEFORE install and build, so what this
 * observes is the line, not the server. Making the launcher survive that would mean installing Next
 * into a throwaway directory to check a `console.log`, and the print order is the reason it does not
 * have to.
 *
 * ⚠️ **THE APPLICATION HALF SERVES FROM THIS REPOSITORY'S BUILD**, pointed at the consumer's content.
 * That is the same shape `next start` has in a consumer install — the tool serves, the project's
 * content is read — and it avoids a second production build of a directory tree that has no
 * `node_modules` to build with.
 *
 * The Windows/Ubuntu and Node 22/24 half of the criterion is the CI matrix in `.github/workflows/ci.yml`;
 * this file is what that matrix runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";

installReaper();

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NEXT_CLI = join(ROOT, "node_modules", "next", "dist", "bin", "next");
const PORT = 4416;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What a consumer's `.planning/` needs in order to initialize a project. Deliberately not everything. */
const TOOL_PARTS = ["bin", "lib", "stages", "schemas", "package.json"];

/**
 * `project/.planning/` + an empty `project/`. No content root: creating it is the thing under test.
 *
 * ⚠️ `planning-content/`, `node_modules/`, `.next/` and `docs/` are NOT copied. The first would hand
 * the consumer Kiln's own history — the exact substitution the initializer exists to avoid — and the
 * last would make "nothing was written under .planning/docs/" true before the test started.
 */
function consumerProject() {
  const dir = reapLater(realpathSync(mkdtempSync(join(tmpdir(), "kiln-consumer-"))));
  const tool = join(dir, ".planning");
  mkdirSync(tool);
  for (const part of TOOL_PARTS) cpSync(join(ROOT, part), join(tool, part), { recursive: true });
  return { dir, tool };
}

/** `git init`, or a bare `.git` directory when git is not on PATH. Both are what the check looks for. */
async function makeRepository(dir) {
  try {
    await execFileP("git", ["init", "-q"], { cwd: dir });
    return "git init";
  } catch {
    mkdirSync(join(dir, ".git"), { recursive: true });
    return ".git directory (git not on PATH)";
  }
}

const run = (args, opts = {}) =>
  execFileP(process.execPath, args, { maxBuffer: 16 << 20, ...opts }).catch((e) => e);

/** Both streams, whether the command succeeded or failed. */
const output = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`;
const exitCode = (r) => r.code ?? 0;

async function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === "win32") await execFileP("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
    else proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * A production build, unless `.next` is already newer than every source it is built from.
 *
 * ⚠️ The freshness check is a real comparison against `app/`, `lib/` and the build's own
 * configuration — not "a `.next` exists". A stale build would make the render assertions below report
 * on code that is no longer in the repository, which is the failure this whole file is written
 * against, so it rebuilds rather than assuming.
 */
async function ensureBuild(t) {
  const buildId = join(ROOT, ".next", "BUILD_ID");
  if (existsSync(buildId) && statSync(buildId).mtimeMs > newestSource()) {
    t.diagnostic("reusing the existing production build");
    return;
  }
  t.diagnostic("production build (this is the slow one)");
  await execFileP(process.execPath, [NEXT_CLI, "build"], { cwd: ROOT, timeout: 6 * 60 * 1000, maxBuffer: 16 << 20 });
}

function newestSource() {
  let newest = 0;
  const visit = (p) => {
    const s = statSync(p);
    if (s.isDirectory()) for (const e of readdirSync(p)) visit(join(p, e));
    else newest = Math.max(newest, s.mtimeMs);
  };
  for (const p of ["app", "lib", "next.config.mjs", "package.json"]) visit(join(ROOT, p));
  return newest;
}

/* ================================================================== the flow */

test("a fresh project initializes, opens, lints clean, and refuses to publish", async (t) => {
  const { dir, tool } = consumerProject();
  t.diagnostic(`consumer project: ${dir}`);
  t.diagnostic(`repository made by: ${await makeRepository(dir)}`);

  /* ---- 1. initialization succeeds, with no dependencies installed ---------- */

  assert.equal(existsSync(join(tool, "node_modules")), false, "the tool copy must have no dependencies");

  const init = await run(
    [join(tool, "bin", "init-project.mjs"), "--project-root", ".", "--name", "Consumer Project", "--description", "Proves the sibling layout."],
    { cwd: dir }
  );
  assert.equal(exitCode(init), 0, `init failed:\n${output(init)}`);
  assert.match(output(init), /created \d+ file\(s\)/, "it reports what it made");
  assert.ok(!/Cannot find (package|module)/i.test(output(init)), `the initializer reached for a dependency:\n${output(init)}`);

  const content = join(dir, "planning-content");
  assert.ok(existsSync(join(content, "project.yaml")), "the content root is the SIBLING of the tool directory");
  assert.ok(existsSync(join(content, "state", "setup.json")));
  assert.match(readFileSync(join(dir, ".gitignore"), "utf-8"), /^\.planning\/$/m, "the tool directory is ignored");

  /* ---- 2. the launcher resolves and prints that same sibling --------------- */

  // ⚠️ A `node_modules/` WITH npm'S MARKER, CREATED ONLY NOW AND ONLY TO STOP `npm install`. Without
  // it the run below shells out to npm and this test needs a network, a registry, and minutes — and
  // the first version of it did exactly that, passing on partial output because the 60s timeout
  // killed the install. Taking the "dependencies present" branch makes it fail immediately at the
  // missing Next CLI instead, which is offline, fast, and the same code path.
  //
  // ⚠️ **THE MARKER IS NEW HERE, AND ITS ABSENCE USED TO BE ENOUGH.** An empty directory sufficed
  // while the freshness check would fall through to "no lockfile to compare against" and declare the
  // tree usable — a guess about a tree nothing had laid down. That branch was removed on 2026-09-04
  // (ACC-0033, EVD-0087), so this fixture now has to say what it was previously allowed to imply:
  // npm put this here. Writing the marker is more honest than the empty directory ever was.
  //
  // It is created AFTER the initialization above, so the "no dependencies installed" claim that step
  // makes is not quietly weakened by a directory that exists to serve this one.
  mkdirSync(join(tool, "node_modules"));
  writeFileSync(join(tool, "node_modules", ".package-lock.json"), '{"name":"fixture","lockfileVersion":3}\n');

  // ⚠️ Nothing sets PLANNING_CONTENT_DIR here, and the environment it inherits must not either — the
  // whole point is that `<toolRoot>/../planning-content` finds the project on its own.
  const env = { ...process.env };
  delete env.PLANNING_CONTENT_DIR;

  const launch = await run([join(tool, "bin", "start-shell.mjs")], { cwd: dir, env, timeout: 60_000 });
  const log = output(launch);

  const printed = (log.match(/\[vpw\] planning content root: (.+)/) ?? [])[1]?.trim();
  assert.equal(printed, content, `the launcher opened ${printed}, not the project's own content root`);
  assert.ok(!/no planning content at/.test(log), "and it found it without being told where to look");

  // ⚠️ THE OFFLINE PROPERTY IS ASSERTED, NOT ASSUMED. If `needsInstall()` ever changes shape, this
  // test would silently go back to running a real install and would keep passing.
  assert.match(log, /dependencies present; skipping install/, "no install may be attempted");
  assert.ok(!/installing dependencies/.test(log), `the launcher tried to install:\n${log}`);

  // It got past resolution and into the build, which is where a tool copy with an empty
  // `node_modules/` is expected to stop. The content root is printed before that, which is the whole
  // reason this can be observed without a server.
  assert.match(log, /building \(production\)/, "resolution succeeded and the launcher moved on");
  assert.notEqual(exitCode(launch), 0, "and the build failed, because there is no Next to build with");

  /* ---- 3. the application renders the consumer's content ------------------- */

  await withBuildLock(async () => {
    await ensureBuild(t);

    const server = spawn(process.execPath, [NEXT_CLI, "start", "--hostname", "127.0.0.1", "--port", String(PORT)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PLANNING_CONTENT_DIR: content },
    });

    try {
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

      const html = await (await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(20_000) })).text();

      // ⚠️ APPLICATION-OWNED MARKERS, so a page that failed to render cannot pass. `data-vpw-*` is
      // written by our own components and by nothing else.
      assert.match(html, /data-vpw-route="\/"/, "the project view rendered");
      assert.match(html, /data-vpw-diagnostics="0"/, "a fresh project shows zero artifacts");
      assert.match(html, /data-vpw-current="01-intake"/, "and stage one as the current stage");
      assert.match(html, /data-vpw-lint="0"/, "with no lint findings against it");
      assert.ok(!/data-vpw-count=/.test(html), "and no artifact-type totals, because there are none");
    } finally {
      await killTree(server);
      await sleep(300);
    }
  });

  /* ---- 4. the lint reports nothing ---------------------------------------- */

  const lint = await run([join(ROOT, "bin", "lint-plan.mjs")], { env: { ...process.env, PLANNING_CONTENT_DIR: content } });
  assert.equal(exitCode(lint), 0, `lint:plan failed:\n${output(lint)}`);
  assert.match(output(lint), /No findings\./, "a freshly initialized project starts clean");
  assert.match(output(lint), /0 artifact\(s\)/);

  /* ---- 5. handoff refuses, because nothing has been attested --------------- */

  const handoff = await run([join(ROOT, "bin", "handoff.mjs")], { env: { ...process.env, PLANNING_CONTENT_DIR: content } });
  assert.equal(exitCode(handoff), 1, `handoff should refuse, not fail differently:\n${output(handoff)}`);
  assert.match(output(handoff), /REFUSED/, "the gate answers 'may we publish' and the answer is no");

  // ⚠️ THE TARGET IT NAMES IS THE PROJECT'S, NOT THE TOOL'S. This is the derivation under test:
  // `dirname(contentRoot)/docs/plan`, which is right in both layouts and was hardcoded to the tool's
  // own `docs/plan/` before — a directory `git pull` is entitled to overwrite.
  assert.match(output(handoff), new RegExp(`target\\s+${escapeRegExp(join(dir, "docs", "plan"))}`), output(handoff));

  /* ---- 6. nothing was written under the tool directory --------------------- */

  assert.equal(existsSync(join(tool, "docs")), false, "no output may be written inside .planning/");
  assert.equal(existsSync(join(dir, "docs")), false, "and a refused handoff publishes nothing at all");
  assert.deepEqual(
    readdirSync(dir).sort(),
    [".git", ".gitignore", ".planning", "planning-content"],
    "the project holds exactly what the documented flow creates"
  );
});

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
