/**
 * ACC-0116: a project set up with a custom provider STARTS — TSK-0072, measured with nothing replaced.
 *
 * ⚠️ **THE REAL COMMANDS, THE REAL SUPERVISOR, THE REAL SHELL AND THE REAL PI.** Setup runs as its own process with
 * `--credential-var`; `bin/start-kiln.mjs` then runs its launch checks, starts the shell and Pi, and is stopped the
 * way an operator stops it: Pi's input ends, Pi exits, and the supervisor tears the rest down. The only provider is
 * TSK-0062's loopback fixture, so nothing billable exists to reach.
 *
 * ⚠️ **PI'S INPUT IS A PIPE, NOT A TERMINAL.** Measured on the pinned Pi: with no TTY it reads its input to the end and
 * runs it as one prompt, so the one line written here reaches the fixture as a real turn from the started process.
 * What an interactive terminal session does is TSK-0063's to observe.
 *
 * ⚠️ **BOUNDED.** The shell builds and serves from this checkout's `.next`, so the run holds the build lock other test
 * files take, and a start that never ends is killed at the bound and fails rather than hanging the suite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_DONE, FIXTURE_KEY, FIXTURE_KEY_VAR, FIXTURE_MODEL, FIXTURE_PROVIDER, modelsJson, startProviderFixture } from "./helpers/provider-fixture.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";
import { blockText } from "../lib/project-gitignore.mjs";

const ROOT = join(import.meta.dirname, "..");
const BOUND_MS = 5 * 60_000;
const PROMPT = "KILN-START-PROMPT-51d7";

/** Run a command to completion without blocking this process, which is serving the fixture. */
function run(args, opts) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, opts);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

/** Whether anything still answers on the port. */
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

test("⚠️ ACC-0116 a custom-provider project starts for real, answers through its provider, and stops leaving nothing", { timeout: BOUND_MS + 120_000 }, async () => {
  // The canary offers exactly `kiln_preflight` and is answered with it; any other turn is answered with prose.
  const offered = (req) => (req.tools ?? []).map((t) => t.function?.name ?? t.name);
  const echo = (req) =>
    offered(req).includes("kiln_preflight")
      ? { toolCalls: [{ name: "kiln_preflight", arguments: { challenge: /[0-9a-f]{32}/.exec(JSON.stringify(req.messages))?.[0] ?? "absent" } }] }
      : { text: FIXTURE_DONE };
  const fixture = await startProviderFixture({ script: [echo] });
  const root = mkdtempSync(join(tmpdir(), "kiln-custom-start-"));
  const dir = join(root, "project");
  const agentDir = join(root, "agent");
  try {
    mkdirSync(dir);
    mkdirSync(agentDir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    symlinkSync(ROOT, join(dir, ".planning"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(dir, ".gitignore"), blockText());
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson(fixture.url)));
    const port = await freePort();
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PLANNING_CONTENT_DIR: join(dir, "planning-content"), PORT: String(port), [FIXTURE_KEY_VAR]: FIXTURE_KEY };

    const setup = await run(
      [
        join(ROOT, "bin", "setup.mjs"),
        ...["--project-root", dir, "--name", "Custom Start", "--trust", "approve", "--inspect", "approve"],
        ...["--provider", FIXTURE_PROVIDER, "--model", FIXTURE_MODEL, "--thinking", "off", "--model-use", "approve"],
        ...["--research", "disabled", "--live-model-check", "approve", "--credential-var", FIXTURE_KEY_VAR, "--non-interactive"],
      ],
      { cwd: dir, env }
    );
    assert.equal(setup.status, 0, `${setup.stdout}${setup.stderr}`);
    assert.equal(fixture.requests.length, 1, "setup's live check made other than one request");

    const started = await withBuildLock(
      () =>
        new Promise((done) => {
          globalThis.__f11StartedAt = Date.now();
          const child = spawn(process.execPath, [join(ROOT, "bin", "start-kiln.mjs")], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          let answering = null;
          child.stdout.on("data", (d) => {
            stdout += d;
            // ⚠️ THE PROMPT GOES IN ONCE PI HAS ITS SESSION, AND ENDING THE INPUT IS HOW THE RUN IS ASKED TO FINISH.
            if (answering === null && /\[kiln\] session \S+ \(new, recorded\)/.test(stdout)) {
              answering = true;
              child.stdin.end(`${PROMPT}\n`);
            }
          });
          child.stderr.on("data", (d) => (stderr += d));
          const bound = setTimeout(() => child.kill(), BOUND_MS);
          child.on("close", (status, signal) => {
            clearTimeout(bound);
            done({ status, signal, stdout, stderr, prompted: answering === true });
          });
        })
    );
    const out = `${started.stdout}\n${started.stderr}`;

    // The launch checks passed on the record setup wrote, for exactly this selection.
    assert.match(started.stdout, new RegExp(`launch checks passed for ${FIXTURE_PROVIDER} ${FIXTURE_MODEL} \\(thinking off\\); compatibility proved by this computer's record`), out);
    // The shell started and was identified as this run's.
    assert.match(started.stdout, /\[kiln\] ready — identity confirmed/, out);
    assert.ok(started.prompted, `Pi never recorded its session: ${out}`);

    // ⚠️ PI RAN THE TURN THROUGH THE CUSTOM PROVIDER, AUTHENTICATED BY THE DECLARED VARIABLE.
    const turn = fixture.requests.slice(1).filter((r) => JSON.stringify(r.body?.messages ?? []).includes(PROMPT));
    assert.equal(turn.length, 1, `the started Pi did not send the prompt to the fixture: ${fixture.requests.length} requests`);
    assert.ok(turn[0].authorized, "the started Pi's request did not carry the declared variable's key");
    assert.equal(turn[0].body.model, FIXTURE_MODEL);
    // Kiln's package loaded in that Pi: its tools were offered to the model.
    assert.ok(offered(turn[0].body).includes("kiln_project_status"), `Kiln's tools were not offered: ${offered(turn[0].body)}`);
    assert.ok(started.stdout.includes(FIXTURE_DONE), `Pi did not print the provider's answer: ${out}`);

    // ⚠️ AND IT STOPPED THE WAY THE SUPERVISOR STOPS, WITH NOTHING LEFT SERVING.
    assert.match(started.stdout, /\[kiln\] the agent exited \(code 0\)/, out);
    assert.match(started.stdout, /\[kiln\] stopped \(agent-exit\) — stop sent: true, stdin end requested: true, launcher exit observed: true, launcher tree stopped: true/, out);
    assert.equal(started.signal, null, `the run was killed at its bound: ${out}`);
    assert.equal(started.status, 0, out);
    assert.equal(await answers(port), false, `something still answers on port ${port}`);
  } finally {
    await fixture.close();
    // F11 DIAGNOSTIC (branch only): on a failed removal, record who holds what, then how long until it goes, and
    // rethrow the original error so the test still fails.
    const startedAtMs = globalThis.__f11StartedAt ?? 0;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (e) {
      const { spawnSync } = await import("node:child_process");
      const { appendFileSync } = await import("node:fs");
      const t0 = Date.now();
      const snap = () => {
        const ps = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
          { encoding: "utf-8", timeout: 60_000 });
        let rows = [];
        try { rows = JSON.parse(ps.stdout || "[]"); } catch { rows = [{ parseError: (ps.stdout || ps.stderr || "").slice(0, 300) }]; }
        rows = (Array.isArray(rows) ? rows : [rows]).filter((p) => !p.Created || Date.parse(p.Created) >= startedAtMs - 2000);
        const h = process.env.HANDLE_EXE ? spawnSync(process.env.HANDLE_EXE, ["-accepteula", "-nobanner", root], { encoding: "utf-8", timeout: 60_000 }) : null;
        return { at: Date.now() - t0, processes: rows, handles: h ? (h.stdout || h.stderr || "").trim().slice(0, 6000) : null };
      };
      // ORDER MATTERS: what is left and who holds it first, then the release timed at 50 ms, then the slow process table.
      const { readdirSync } = await import("node:fs");
      let left;
      try { left = readdirSync(e.path ?? root); } catch (x) { left = x.code; }
      const hStart = Date.now();
      const h = process.env.HANDLE_EXE ? spawnSync(process.env.HANDLE_EXE, ["-accepteula", "-nobanner", root], { encoding: "utf-8", timeout: 60_000 }) : null;
      const record = {
        error: { code: e.code, path: e.path },
        startedAtMs,
        failedAtMs: t0,
        leftInPath: left,
        handlesAt: { startMs: hStart - t0, endMs: Date.now() - t0, out: h ? (h.stdout || h.stderr || "").trim().slice(0, 6000) : null },
      };
      let removedAfterMs = null;
      let attempts = 0;
      while (Date.now() - t0 < 15_000) {
        await new Promise((r) => setTimeout(r, 50));
        attempts++;
        try { rmSync(root, { recursive: true, force: true }); removedAfterMs = Date.now() - t0; break; } catch (again) { record.lastError = again.code; }
      }
      record.removedAfterMs = removedAfterMs;
      record.attempts = attempts;
      record.afterRelease = snap();
      appendFileSync(process.env.F11_OUT ?? "f11-events.jsonl", JSON.stringify(record) + "\n");
      throw e;
    }
  }
});
