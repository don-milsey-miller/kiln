/**
 * The combined runtime supervisor — CMP-0037, against ACC-0078/0079/0080/0102.
 *
 * ⚠️ **STAND-IN CHILDREN, BECAUSE THE SUPERVISOR'S RESPONSIBILITY IS THE SUBJECT.** Real Pi needs
 * credentials and an interactive UI, and neither is what these assert: what is under test is which
 * descriptor each child is given, which facts are required before readiness is claimed, and whether
 * the shutdown contract is performed. The seam is internal — `runSupervisor` takes a command and an
 * argument array — and `bin/start-kiln.mjs` supplies fixed, canonically resolved ones with no flag
 * or environment variable able to reach them.
 *
 * ⚠️ **THE PIPE STANDS IN FOR THE TERMINAL, AND THAT LIMIT IS REAL.** Node has no pseudo-terminal,
 * so the harness gives the supervisor a pipe on fd 0. That proves descriptor ownership and byte
 * routing — one handle, two candidate readers, only one may get the bytes — and it does NOT prove
 * TTY line discipline or signal behaviour. What connects it to the real terminal topology is the
 * structural assertion: the launcher is spawned with a NEW writable pipe, the agent with fd 0
 * inherited, whatever fd 0 happens to be.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import {
  HOST,
  REFUSAL,
  SupervisorRefusal,
  awaitReadiness,
  classifyError,
  choosePort,
  probePort,
  resolvePinnedAgent,
  retryWithPort,
  readProjectRecord,
  runSupervisor,
  stopLauncher,
} from "../lib/supervisor.mjs";
import { HEALTH_PATH, matchHealth } from "../lib/run-identity.mjs";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "test", "fixtures", "supervisor");
const PROJECT_ID = "abcdef0123456789abcdef0123456789";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function project({ record = { recordVersion: 1, projectId: PROJECT_ID } } = {}) {
  const dir = reapLater(mkdtempSync(join(tmpdir(), "kiln-sup-")));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  if (record) writeFileSync(join(dir, ".pi", "kiln.json"), JSON.stringify(record, null, 2) + "\n");
  return dir;
}

/** Wait for a JSON report file to satisfy `done`, or fail with what it last said. */
async function until(path, done, why, ms = 25_000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        last = JSON.parse(readFileSync(path, "utf-8"));
        if (done(last)) return last;
      } catch {
        /* mid-write; read again */
      }
    }
    await sleep(25);
  }
  assert.fail(`${why} — last report: ${JSON.stringify(last)}`);
}

const freePort = async () => (await probePort(0)).port;

/** Every file under `dir`, with its bytes — so "changed nothing" is a claim about content. */
function snapshot(dir, prefix = "") {
  const out = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, snapshot(join(dir, entry.name), rel));
    else out[rel] = readFileSync(join(dir, entry.name), "utf-8");
  }
  return out;
}

/* ============================================== the project record ============================= */

test("a project with no Kiln record is refused, and says what to run", () => {
  const dir = project({ record: null });
  assert.throws(
    () => readProjectRecord(dir),
    (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.NO_PROJECT_RECORD && /setup/i.test(e.message)
  );
});

test("a record that does not validate is refused rather than read for one field", () => {
  // ⚠️ GUESSING PAST IT WOULD START A SUPERVISOR whose entire readiness check compares against a
  // project identity it invented.
  for (const bad of ["{ not json", JSON.stringify({ recordVersion: 1 }), JSON.stringify({ recordVersion: 1, projectId: "nope" })]) {
    const dir = project({ record: null });
    writeFileSync(join(dir, ".pi", "kiln.json"), bad);
    assert.throws(
      () => readProjectRecord(dir),
      (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.PROJECT_RECORD_INVALID,
      `must refuse ${bad.slice(0, 40)}`
    );
  }
  assert.equal(readProjectRecord(project()).projectId, PROJECT_ID);
});

/* ============================================== ACC-0080: ports ================================ */

test("a port outside the range or not an integer is refused", async () => {
  for (const value of ["0", "65536", "abc", "3000.5", "-1", ""])
    await assert.rejects(
      () => choosePort({ value, interactive: false, ask: async () => true }),
      (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.PORT_INVALID,
      `must refuse PORT=${JSON.stringify(value)}`
    );
});

test("an occupied port refuses non-interactively with an exact recovery command", async () => {
  const held = createServer((_, res) => res.end());
  const port = await freePort();
  await new Promise((r) => held.listen(port, HOST, r));
  try {
    const e = await choosePort({ value: String(port), interactive: false, ask: async () => true }).catch((x) => x);
    assert.ok(e instanceof SupervisorRefusal && e.reason === REFUSAL.PORT_OCCUPIED);
    // ⚠️ THE EXACT COMMAND, not a description of one. A script has nobody to ask, and "port in use"
    // leaves the reader to work out both the variable and a free number.
    assert.match(e.message, /PORT=\d+/, "the refusal must carry a runnable recovery line");
    assert.ok(e.detail.suggestion > 0 && e.detail.suggestion !== port);
  } finally {
    held.close();
  }
});

test("an offered port is declinable, and declining still refuses", async () => {
  const held = createServer((_, res) => res.end());
  const port = await freePort();
  await new Promise((r) => held.listen(port, HOST, r));
  try {
    let prompt = "";
    const accepted = await choosePort({ value: String(port), interactive: true, ask: async (q) => ((prompt = q), true) });
    assert.equal(accepted.chosen, "offered");
    assert.notEqual(accepted.port, port);
    assert.match(prompt, /this run only|not be saved/i, "the offer must say it is not saved");

    await assert.rejects(
      () => choosePort({ value: String(port), interactive: true, ask: async () => false }),
      (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.PORT_OCCUPIED
    );
  } finally {
    held.close();
  }
});

test("⚠️ an offered port changes no byte of the project, proved through a whole run", async () => {
  // ⚠️ **THE PREVIOUS VERSION OF THIS ASSERTED NOTHING.** It exercised `choosePort`, which is handed
  // no project path and therefore could not have persisted anything wherever it tried. The claim is
  // about the COMMAND, so the run is the thing to observe: take the port, force the fallback, and
  // compare the project tree byte for byte across a complete supervised run.
  const dir = project();
  const before = snapshot(dir);

  const wanted = await freePort();
  const held = createServer((_, res) => res.end());
  await new Promise((r) => held.listen(wanted, HOST, r));

  let launcherExit = null;
  const calls = [];
  try {
    const result = await runSupervisor({
      projectRoot: dir,
      launcher: { command: "L", args: [] },
      agent: { command: "A", args: [] },
      env: { PORT: String(wanted) },
      interactive: true,
      ask: async () => true,
      randomBytes: () => Buffer.alloc(16, 9),
      build: null,
      spawn: (command, args, options) => {
        calls.push(options);
        if (calls.length === 1)
          return {
            get exitCode() {
              return launcherExit;
            },
            signalCode: null,
            stdin: { destroyed: false, write: () => {}, end: () => (launcherExit = 0) },
            once: () => {},
          };
        return {
          exitCode: null,
          signalCode: null,
          stdin: null,
          once: (event, cb) => {
            if (event === "exit") setImmediate(() => cb(0, null));
          },
        };
      },
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({
          service: "kiln",
          protocol: "kiln.health/1",
          runId: "09".repeat(16),
          projectId: PROJECT_ID,
          build: null,
        }),
      }),
    });

    assert.notEqual(result.port, wanted, "the run must have fallen back to another port");
    assert.equal(calls[0].env.PORT, String(result.port), "and the launcher must be told the port actually used");
  } finally {
    held.close();
  }

  // ⚠️ BYTES, NOT A FILE LIST. A configuration silently gaining `"port": 41234` would keep the same
  // names and turn one busy afternoon into the project's permanent setting.
  assert.deepEqual(snapshot(dir), before, "a supervised run must write nothing into the project");
});

test("the recovery command is runnable in the operator's actual shell", async () => {
  // WARNING: `PORT=<n>` IS sh SYNTAX AND A PARSE ERROR IN POWERSHELL, which is where most Windows
  // operators are — so the "exact recovery command" was exact for half the audience and left the
  // other half to work out both the syntax and the invocation.
  const lines = retryWithPort(4321).split("\n");
  assert.equal(lines.length, 2, "one complete command per shell");
  assert.ok(lines[0].includes('$env:PORT = "4321"; node .planning/bin/start-kiln.mjs'));
  assert.ok(lines[1].includes("PORT=4321 node .planning/bin/start-kiln.mjs"));
  assert.ok(!lines[0].trimStart().startsWith("PORT="), "the PowerShell line must not be a bare sh assignment");
  assert.ok(lines[0].includes("PowerShell") && lines[1].includes("sh "), "each line names its shell");

  // And the refusal an operator actually sees carries both.
  const held = createServer((_, res) => res.end());
  const port = await freePort();
  await new Promise((r) => held.listen(port, HOST, r));
  try {
    const e = await choosePort({ value: String(port), interactive: false, ask: async () => true }).catch((x) => x);
    assert.ok(e.message.includes('$env:PORT = '), "the PowerShell form must be in the refusal");
    assert.ok(/sh {2,}PORT=[0-9]+ node/.test(e.message), "and the sh form too");
  } finally {
    held.close();
  }
});

/* ============================================== ACC-0079: readiness ============================ */

/** A server that answers `/health/kiln` with whatever body the test hands it. */
async function healthServer(bodyFor) {
  const server = createServer((req, res) => {
    if (req.url !== HEALTH_PATH) return void res.writeHead(404).end();
    const { status, body } = bodyFor();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, HOST, r));
  return { server, port, close: () => new Promise((r) => server.close(r)) };
}

const good = (over = {}) => ({
  status: 200,
  body: { service: "kiln", protocol: "kiln.health/1", runId: "a".repeat(32), projectId: PROJECT_ID, build: "0.0.0", ...over },
});
const expected = { runId: "a".repeat(32), projectId: PROJECT_ID, build: "0.0.0" };

test("an unrelated healthy HTTP service does not satisfy readiness", async () => {
  // ⚠️ THE NEGATIVE CONTROL THE GENERIC PROBE LACKED. This server is up, healthy and answering 200.
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: 41 }));
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, HOST, r));
  try {
    await assert.rejects(
      () => awaitReadiness({ port, expected, childAlive: () => true, deadlineMs: 4000 }),
      (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.IDENTITY_MISMATCH,
      "a response that merely arrives must not be readiness"
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("a wrong run id, a wrong project id, or a wrong build each fail readiness", async () => {
  for (const [over, reason] of [
    [{ runId: "b".repeat(32) }, REFUSAL.IDENTITY_MISMATCH],
    [{ projectId: "c".repeat(32) }, REFUSAL.IDENTITY_MISMATCH],
    [{ service: "something-else" }, REFUSAL.IDENTITY_MISMATCH],
    [{ protocol: "kiln.health/99" }, REFUSAL.IDENTITY_MISMATCH],
    [{ build: "9.9.9" }, REFUSAL.BUILD_MISMATCH],
  ]) {
    const h = await healthServer(() => good(over));
    try {
      const e = await awaitReadiness({ port: h.port, expected, childAlive: () => true, deadlineMs: 4000 }).catch((x) => x);
      assert.ok(e instanceof SupervisorRefusal, `${JSON.stringify(over)} must refuse`);
      assert.equal(e.reason, reason, JSON.stringify(over));
    } finally {
      await h.close();
    }
  }
});

test("a matching identity is ready, and the build is credited with nothing", async () => {
  const h = await healthServer(() => good());
  try {
    const r = await awaitReadiness({ port: h.port, expected, childAlive: () => true, deadlineMs: 8000 });
    assert.equal(r.ready, true);
    // ⚠️ FOUR FACTS, AND `build` IS NOT ONE. Every build of this package reports `0.0.0`, so
    // agreement between two copies of it is not evidence — counting it would inflate the handshake
    // without strengthening it.
    assert.deepEqual(r.identityConfirmedBy, ["service", "protocol", "runId", "projectId"]);
    assert.ok(!r.identityConfirmedBy.includes("build"));
    assert.equal(r.buildCompared, true, "compared, and refused on mismatch — just not counted");
  } finally {
    await h.close();
  }
});

test("readiness stops the moment the expected child is gone, rather than waiting out the clock", async () => {
  // ⚠️ A LAUNCHER THAT DIED AT SECOND TWO would otherwise surface at second ninety as a readiness
  // timeout, and the operator would read the symptom instead of the exit that caused it.
  const started = Date.now();
  let alive = true;
  setTimeout(() => (alive = false), 300);
  await assert.rejects(
    () => awaitReadiness({ port: await0(), expected, childAlive: () => alive, deadlineMs: 60_000, intervalMs: 50 }),
    (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.LAUNCHER_EXITED
  );
  assert.ok(Date.now() - started < 10_000, "it must not wait out the readiness deadline");
  function await0() {
    return 1; // nothing listens on port 1; every probe is a transport failure
  }
});

test("matchHealth separates identity from compatibility", () => {
  assert.deepEqual(matchHealth(expected, good().body).mismatches, []);
  assert.deepEqual(matchHealth(expected, good().body).identityFields, ["service", "protocol", "runId", "projectId"]);
  assert.equal(matchHealth({ ...expected, build: null }, good().body).buildCompared, false, "an unknown build is not compared");
  assert.deepEqual(matchHealth(expected, good({ build: "1.0.0" }).body).mismatches, ["build"]);

  // ⚠️ **FIELD NAMES, NEVER THE VALUES.** Whatever answers the port is untrusted and can put a path
  // or a token in any field; a comparison that handed those back would carry them into every
  // diagnostic that prints its result.
  const hostile = good({ runId: "C:\Users\someone\secret", projectId: "sk-live-0123456789abcdef" });
  const v = matchHealth(expected, hostile.body);
  assert.deepEqual(v.mismatches, ["runId", "projectId"]);
  assert.ok(!JSON.stringify(v).includes("someone"), "no remote value may survive in the verdict");
  assert.ok(!JSON.stringify(v).includes("sk-live"));
});

test("⚠️ nothing a stranger returns is repeated in the refusal", async () => {
  // ⚠️ THE SUPERVISOR PROBES AN UNKNOWN PORT, so its diagnostics are printing something it did not
  // author. A path or a token placed in a health field must not reach the operator's terminal, the
  // error detail, or a log through this route.
  const secrets = ["C:\Users\someone\project", "/home/someone/.ssh/id_ed25519", "sk-live-0123456789abcdef"];
  for (const secret of secrets) {
    const h = await healthServer(() => good({ runId: secret, projectId: secret, build: secret }));
    try {
      const e = await awaitReadiness({ port: h.port, expected, childAlive: () => true, deadlineMs: 4000 }).catch((x) => x);
      assert.ok(e instanceof SupervisorRefusal);
      const everything = e.message + JSON.stringify(e.detail);
      assert.ok(!everything.includes(secret), `the refusal repeated a remote value: ${secret}`);
      assert.match(e.message, /disagreeing fields: /, "it names the fields instead");
    } finally {
      await h.close();
    }
  }
});

test("⚠️ a launcher that dies mid-request does not get its readiness accepted", async () => {
  // ⚠️ CHECKED AT THE TOP OF THE LOOP AND AGAIN AT ACCEPTANCE. Only the second catches this: the
  // child was alive when the request went out and gone when the reply came back, and a readiness
  // claim from a reply whose sender has exited is a fact about the past.
  let alive = true;
  const fetchImpl = async () => {
    alive = false; // it died while we were asking
    return { status: 200, json: async () => good().body };
  };
  await assert.rejects(
    () => awaitReadiness({ port: 1, expected, childAlive: () => alive, deadlineMs: 4000, fetchImpl }),
    (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.LAUNCHER_EXITED
  );
});

test("⚠️ a 503 from our own endpoint refuses at once, because it cannot heal", async () => {
  // ⚠️ WHAT IT REPORTS COMES FROM AN ENVIRONMENT FIXED AT SPAWN. Retrying converts missing identity
  // propagation into a readiness timeout — the same defect one layer up, a symptom reported in
  // place of its cause.
  for (const [body, code] of [
    [{ service: "kiln", protocol: "kiln.health/1", error: "no-run-identity" }, "no-run-identity"],
    [{ service: "kiln", protocol: "kiln.health/1", error: "no-build-identity" }, "no-build-identity"],
  ]) {
    const h = await healthServer(() => ({ status: 503, body }));
    const started = Date.now();
    try {
      const e = await awaitReadiness({ port: h.port, expected, childAlive: () => true, deadlineMs: 60_000 }).catch((x) => x);
      assert.equal(e.reason, REFUSAL.NOT_IDENTIFIED);
      assert.equal(e.detail.code, code);
      assert.ok(Date.now() - started < 10_000, "it must not wait out the readiness deadline");
    } finally {
      await h.close();
    }
  }

  // An unrecognised code is described rather than quoted — it came off the wire like everything else.
  const h = await healthServer(() => ({ status: 503, body: { service: "kiln", protocol: "kiln.health/1", error: "/etc/passwd" } }));
  try {
    const e = await awaitReadiness({ port: h.port, expected, childAlive: () => true, deadlineMs: 4000 }).catch((x) => x);
    assert.equal(e.detail.code, null);
    assert.ok(!e.message.includes("/etc/passwd"));
  } finally {
    await h.close();
  }
});

/* ============================================== the pinned agent =============================== */

test("the agent is the package's own declared bin entry, not a guessed path", () => {
  // ⚠️ THE SPIKE ESTABLISHED `bin.pi` IS `dist/bundle/cli.js`. An earlier resolver tried `dist/cli.js`
  // first — a real file that sits beside it and is not what `pi` runs.
  const agent = resolvePinnedAgent(ROOT);
  const pkgDir = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
  const declared = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")).bin.pi;
  assert.equal(agent.entry, join(pkgDir, ...declared.split("/")), "it must BE the installed bin entry");
  assert.equal(agent.command, process.execPath, "run with this Node, never a PATH lookup");
  assert.equal(agent.version, "0.84.4");
});

test("a missing, mispinned or escaping agent entry is refused", () => {
  const fake = reapLater(mkdtempSync(join(tmpdir(), "kiln-agent-")));
  const pkgDir = join(fake, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(fake, "package.json"), JSON.stringify({ dependencies: { "@earendil-works/pi-coding-agent": "0.84.4" } }));

  const refuses = (why) =>
    assert.throws(
      () => resolvePinnedAgent(fake),
      (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.AGENT_NOT_INSTALLED,
      why
    );

  refuses("not installed at all");
  const manifest = (o) => writeFileSync(join(pkgDir, "package.json"), JSON.stringify(o));
  manifest({ name: "@earendil-works/pi-coding-agent", version: "0.80.6", bin: { pi: "dist/bundle/cli.js" } });
  refuses("a version this checkout never measured");
  manifest({ name: "@earendil-works/pi-coding-agent", version: "0.84.4" });
  refuses("no bin.pi declared");
  // ⚠️ `bin.pi` IS DATA FROM A FILE ON DISK. A path escaping its own package would be this
  // supervisor handing the terminal to something outside the thing it pinned.
  manifest({ name: "@earendil-works/pi-coding-agent", version: "0.84.4", bin: { pi: "../../../../evil.js" } });
  refuses("an entry point outside its own package");
  manifest({ name: "@earendil-works/pi-coding-agent", version: "0.84.4", bin: { pi: "dist/bundle/cli.js" } });
  refuses("declared but not installed");
});

/* ============================================== ACC-0078: stdio routing ======================== */

test("⚠️ the sentinel reaches the agent while an adversary is trying to take it", async (t) => {
  t.diagnostic("two stand-in children and a real supervisor; the adversary reads first by construction");
  const dir = project();
  const agentReport = join(dir, "agent.json");
  const launcherReport = join(dir, "launcher.json");
  const readyFlag = join(dir, "adversary-reading");
  const gate = join(dir, "release-agent");
  // ⚠️ AN EXPLICITLY PROBED PORT. The supervisor's default is 3000, which on a developer machine is
  // whatever they are already running, and `node --test` runs these files in parallel. Leaving it
  // unset made this harness ask for one fixed port every time — it surfaced once as a lone failure
  // in a full-suite run that passed on its own, which is the shape of a flake nobody tracks down.
  const port = String(await freePort());
  const SENTINEL = "kiln-sentinel-7f3a\n";

  // The supervisor inherits THIS pipe as its fd 0 — the harness's stand-in for the terminal.
  const supervisor = spawn(
    process.execPath,
    [join(FIXTURES, "run-supervisor.mjs"), dir, agentReport, launcherReport, readyFlag, gate, port],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], shell: false }
  );
  let out = "";
  supervisor.stdout.on("data", (b) => (out += String(b)));
  supervisor.stderr.on("data", (b) => (out += String(b)));

  try {
    // 1 + 2. The agent is up but blocked on its gate; the adversary has ATTACHED its reader and said so.
    await until(agentReport, (r) => r.state === "started", "the agent never started");
    const readingBy = Date.now() + 30_000;
    while (Date.now() < readingBy && !existsSync(readyFlag)) await sleep(25);
    assert.ok(existsSync(readyFlag), `the adversary never reported reading. supervisor said:\n${out.slice(-1500)}`);

    // 3. Write the sentinel. At this instant the ONLY process with a reader attached is the adversary.
    supervisor.stdin.write(SENTINEL);
    await sleep(500);

    // 4. Release the agent, which must find the sentinel waiting on its own inherited fd 0.
    writeFileSync(gate, "go\n");
    const agent = await until(agentReport, (r) => r.received?.includes("kiln-sentinel-7f3a"), "the agent never received the sentinel");
    assert.equal(agent.received.trim(), SENTINEL.trim(), "and it must be the exact bytes");

    // 5. ⚠️ THE HALF THAT MAKES THIS A CONTROL. A positive check alone passes whenever the agent wins
    // a race, including when both processes hold the terminal — the arrangement this forbids.
    const launcher = JSON.parse(readFileSync(launcherReport, "utf-8"));
    assert.ok(
      !launcher.received.includes("kiln-sentinel-7f3a"),
      `the adversarial launcher consumed the operator's input: ${JSON.stringify(launcher.received)}`
    );
    // Receiving the later `stop` is expected: that is the supervisor's own control channel working.
  } finally {
    try {
      supervisor.stdin.end();
    } catch {}
    const done = Date.now() + 20_000;
    while (Date.now() < done && supervisor.exitCode === null) await sleep(100);
    if (supervisor.exitCode === null) supervisor.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("structurally: the launcher gets a new writable pipe and the agent inherits fd 0", async () => {
  // ⚠️ THIS IS WHAT CONNECTS THE PIPE HARNESS ABOVE TO A REAL TERMINAL. The routing test proves
  // descriptor ownership on a pipe; it cannot prove TTY line discipline, and does not claim to.
  // What carries over is the topology: whatever fd 0 IS, the launcher is not given it.
  const calls = [];
  let launcherExit = null;
  // ⚠️ THE TWO CHILDREN BEHAVE DIFFERENTLY, because the supervisor treats them differently: the
  // launcher must stay alive through the readiness poll and go when its pipe is closed; the agent
  // exits, which is what ends the run.
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (calls.length === 1)
      return {
        get exitCode() {
          return launcherExit;
        },
        signalCode: null,
        stdin: { destroyed: false, write: () => {}, end: () => (launcherExit = 0) },
      };
    // ⚠️ DISPATCHES BY EVENT NAME. A fake that fires every listener made the supervisor's new
    // `error` handler resolve the exit promise with a spawn failure — the fake reporting a defect
    // it invented.
    return {
      exitCode: null,
      signalCode: null,
      stdin: null,
      once: (event, cb) => {
        if (event === "exit") setImmediate(() => cb(0, null));
      },
    };
  };

  const dir = project();
  const result = await runSupervisor({
    projectRoot: dir,
    launcher: { command: "L", args: ["a"] },
    agent: { command: "A", args: ["b"] },
    spawn: fakeSpawn,
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({
        service: "kiln",
        protocol: "kiln.health/1",
        runId: "07".repeat(16),
        projectId: PROJECT_ID,
        build: null,
      }),
    }),
    build: null,
  });

  const [launcher, agent] = calls;
  assert.deepEqual(launcher.options.stdio, ["pipe", "inherit", "inherit"], "the launcher must get its OWN stdin");
  // ⚠️ **A PROCESS GROUP ON POSIX, AND ONLY FOR THE LAUNCHER.** `kill(-pid)` can only reach
  // `next start`'s workers if the child leads a group, which `detached` is what creates. The agent
  // is deliberately NOT detached: a detached foreground process cannot read the terminal — it takes
  // SIGTTIN — which would break the very routing ACC-0078 protects.
  assert.equal(launcher.options.detached, process.platform !== "win32");
  assert.ok(!agent.options.detached, "the agent stays in the terminal's foreground group");
  assert.equal(launcher.options.shell, false, "no shell to re-parse the argument array");
  assert.equal(agent.options.stdio, "inherit", "the agent inherits the terminal, fd 0 included");
  assert.equal(agent.options.shell, false);
  assert.deepEqual([launcher.args, agent.args], [["a"], ["b"]], "structured arguments, never a command string");

  // ⚠️ AND THE IDENTITY THE LAUNCHER IS TOLD TO SERVE is the one the supervisor then demands back.
  // A supervisor that generated a run id and passed a different one would poll forever.
  assert.equal(launcher.options.env.KILN_RUN_ID, "07".repeat(16));
  assert.equal(launcher.options.env.KILN_PROJECT_ID, PROJECT_ID);
  assert.deepEqual(result.ready.identityConfirmedBy, ["service", "protocol", "runId", "projectId"]);
  rmSync(dir, { recursive: true, force: true });
});

test("⚠️ bin/start-kiln.mjs exposes no way to name a different program", () => {
  // ⚠️ AN OVERRIDE WOULD BE A SUPPORTED WAY TO RUN AN ARBITRARY PROGRAM WITH THE TERMINAL ATTACHED.
  // The seam that makes the supervisor testable is internal, and this is what keeps it internal.
  const src = readFileSync(join(ROOT, "bin", "start-kiln.mjs"), "utf-8");
  assert.ok(!/process\.argv\[\s*2\s*\]/.test(src), "no positional command argument");
  assert.ok(!/env\.[A-Z_]*(COMMAND|CMD|BIN|EXEC|LAUNCHER|AGENT)/.test(src), "no command override from the environment");
  assert.ok(!/shell:\s*true/.test(src), "never through a shell");
  assert.match(src, /join\(TOOL_ROOT, "bin", "start-shell\.mjs"\)/, "the launcher is resolved from this checkout");
  // ⚠️ THE SUCCESS EXIT IS ONLY REACHABLE AFTER A SUCCESSFUL RETURN, and an unobserved shutdown is a
  // refusal rather than a return — so a launcher still holding the port cannot leave here as exit 0.
  assert.match(src, /if \(e instanceof ContentRootError \|\| e instanceof SupervisorRefusal\)[\s\S]*?process\.exit\(2\)/);
  assert.ok(!/agentExit\.code \?\? 0/.test(src), "a signal kill must not be reported as success");
  assert.match(src, /agent: resolvePinnedAgent\(TOOL_ROOT\)/, "the agent comes from the pinned-package resolver");
  assert.ok(!/dist[\/](bundle[\/])?cli\.js/.test(src), "and the wrapper names no entry-point path of its own");
});

/* ============================================== ACC-0102: shutdown ============================= */

test("the supervisor sends stop, closes the pipe, and observes the exit", async () => {
  const writes = [];
  let ended = false;
  let exit = null;
  const child = {
    get exitCode() {
      return exit;
    },
    signalCode: null,
    stdin: { destroyed: false, write: (s) => writes.push(s), end: () => (ended = true) },
  };
  setTimeout(() => (exit = 0), 200);

  const record = await stopLauncher(child, { graceMs: 5000 });
  // ⚠️ THREE ACTS, EACH OBSERVED. "The launcher would have stopped if asked" and "it was asked" are
  // different claims, and a supervisor that sends nothing looks identical to one that does on every
  // occasion the launcher exits for its own reasons.
  assert.deepEqual(writes, ["stop\n"], "the stop message is sent");
  // ⚠️ `endRequested`, NOT `closed`. `end()` ASKS the stream to finish; the close completes later and
  // on an already-exited child may never be acknowledged. What is truthfully recordable is that the
  // request was made — and what proves the launcher went is the exit, which IS observed.
  assert.equal(ended, true, "and then the end of the pipe is requested");
  assert.deepEqual(
    { sentStop: record.sentStop, endRequested: record.endRequested, exitObserved: record.exitObserved, escalated: record.escalated },
    { sentStop: true, endRequested: true, exitObserved: true, escalated: false }
  );
});

test("a launcher that will not go is escalated within the grace period, not waited on forever", async () => {
  let killed = false;
  const child = { exitCode: null, signalCode: null, stdin: { destroyed: false, write: () => {}, end: () => {} } };
  const started = Date.now();
  const record = await stopLauncher(child, { graceMs: 300, hardMs: 200, kill: () => (killed = true) });

  // ⚠️ BOUNDED IN BOTH DIRECTIONS: returning early leaves a process holding the port; waiting
  // forever replaces a hung application with a hung terminal.
  assert.equal(killed, true, "it must escalate");
  assert.equal(record.escalated, true);
  assert.equal(record.exitObserved, false, "and must REPORT that it never saw the exit, rather than claiming one");
  assert.ok(Date.now() - started < 5000, "the wait is bounded");
});

test("⚠️ a broken pipe is recorded, not thrown, because it arrives as an event", async () => {
  // ⚠️ WRITING TO A PIPE WHOSE READER HAS GONE FAILS ASYNCHRONOUSLY. `try/catch` around `write`
  // catches nothing; the process takes an unhandled 'error' instead. Listening first is what turns
  // the failure into a recorded fact rather than a crash during shutdown.
  const listeners = {};
  let exit = null;
  const child = {
    get exitCode() {
      return exit;
    },
    signalCode: null,
    stdin: {
      destroyed: false,
      once: (event, cb) => (listeners[event] = cb),
      write: () => setImmediate(() => listeners.error?.({ code: "EPIPE" })),
      end: () => setTimeout(() => (exit = 0), 100),
    },
  };

  const record = await stopLauncher(child, { graceMs: 3000 });
  assert.equal(record.sentStop, true);
  assert.equal(record.endRequested, true);
  assert.equal(record.exitObserved, true, "the launcher still went, which is what actually matters");
  assert.equal(record.stdinError, "EPIPE", "and the broken pipe is reported rather than swallowed or thrown");
});

test("⚠️ a child that cannot be spawned is refused, and never leaves the wait pending", async () => {
  // ⚠️ A SPAWN FAILURE ARRIVES AS AN EVENT, NOT A THROW. Unlistened it is an unhandled error — and
  // for the agent it would also leave the exit promise pending for ever, the supervisor hanging on a
  // child that was never born.
  const dir = project();
  const mk = (fail) => {
    const handlers = {};
    return {
      exitCode: null,
      signalCode: null,
      stdin: { destroyed: false, write: () => {}, end: () => {} },
      kill: () => {},
      once: (event, cb) => {
        handlers[event] = cb;
        if (event === fail) setImmediate(() => cb({ code: "ENOENT" }));
      },
    };
  };

  // The AGENT cannot start: the run must refuse rather than wait.
  let n = 0;
  const e = await runSupervisor({
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 5),
    build: null,
    spawn: () => (++n === 1 ? mk(null) : mk("error")),
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({
        service: "kiln",
        protocol: "kiln.health/1",
        runId: "05".repeat(16),
        projectId: PROJECT_ID,
        build: null,
      }),
    }),
    graceMs: 300,
    hardMs: 200,
  }).catch((x) => x);
  assert.ok(e instanceof SupervisorRefusal && e.reason === REFUSAL.SPAWN_FAILED, `got ${e?.reason ?? e}`);
  assert.match(e.message, /Nothing was handed the terminal/);

  // The LAUNCHER cannot start: readiness must stop rather than poll a process that never existed.
  const e2 = await runSupervisor({
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 5),
    build: null,
    spawn: () => mk("error"),
    fetchImpl: async () => {
      throw new Error("nothing is listening");
    },
    readyMs: 30_000,
    graceMs: 300,
    hardMs: 200,
  }).catch((x) => x);
  // ⚠️ **`SPAWN_FAILED`, NOT `LAUNCHER_EXITED`** — and the earlier version of this test locked in the
  // wrong one. A launcher that was never found did not exit; reporting that it did sends the
  // operator looking for output from a process that never existed.
  assert.ok(e2 instanceof SupervisorRefusal && e2.reason === REFUSAL.SPAWN_FAILED, `got ${e2?.reason ?? e2}`);
  assert.equal(e2.detail.code, "ENOENT", "carrying a classification, not a message");
  assert.match(e2.message, /no readiness was claimed/);
  rmSync(dir, { recursive: true, force: true });
});

/* ============================================== the second round of leaks ====================== */

test("⚠️ a transport failure is classified, never quoted", async () => {
  // ⚠️ THE BODY WAS REDACTED AND THE ERROR WAS NOT, which left the same hole one step to the left: a
  // rejected fetch carries whatever text produced it, and that text was printed and retained.
  const hostile = new Error("sk-live-secret /home/alice/key");
  const e = await awaitReadiness({
    port: 1,
    expected,
    childAlive: () => true,
    deadlineMs: 600,
    intervalMs: 50,
    fetchImpl: async () => {
      throw hostile;
    },
  }).catch((x) => x);

  assert.equal(e.reason, REFUSAL.NOT_READY);
  const everything = e.message + JSON.stringify(e.detail);
  assert.ok(!everything.includes("sk-live-secret"), "the message must not survive into the refusal");
  assert.ok(!everything.includes("/home/alice/key"));
  assert.equal(e.detail.lastTransport, "Error", "only a classification is kept");

  // The classification is drawn from a checkable shape, so prose cannot masquerade as a code.
  const wrapped = new TypeError("fetch failed");
  wrapped.cause = { code: "ECONNREFUSED" };
  assert.equal(classifyError(wrapped), "ECONNREFUSED", "the real cause is preferred");
  assert.equal(classifyError({ code: "not a code at all /home/x" }), "unknown");
  assert.equal(classifyError(null), "unknown");
});

test("⚠️ only a declared bin.pi naming a real file is accepted", () => {
  const fake = reapLater(mkdtempSync(join(tmpdir(), "kiln-agent2-")));
  const pkgDir = join(fake, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(pkgDir, "dist", "bundle"), { recursive: true });
  writeFileSync(join(fake, "package.json"), JSON.stringify({ dependencies: { "@earendil-works/pi-coding-agent": "0.84.4" } }));
  const manifest = (bin) =>
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.4", bin })
    );
  const refuses = (why) =>
    assert.throws(() => resolvePinnedAgent(fake), (e) => e.reason === REFUSAL.AGENT_NOT_INSTALLED, why);

  // ⚠️ A STRING `bin` IS npm SHORTHAND for "one executable named after the package". Accepting it
  // would run an entry point this contract never names, on a package declaring no `pi` at all.
  writeFileSync(join(pkgDir, "dist", "bundle", "cli.js"), "// pi\n");
  manifest("dist/bundle/cli.js");
  refuses("a string-valued bin is not a declared bin.pi");
  manifest(["dist/bundle/cli.js"]);
  refuses("an array is not either");

  // ⚠️ `existsSync` IS TRUE OF A DIRECTORY, so `bin.pi: "."` resolved to the package root and passed
  // — an entry point that is not a program, discovered when the spawn failed with the terminal
  // already committed.
  manifest({ pi: "." });
  refuses("a directory is not an entry point");
  manifest({ pi: "dist" });
  refuses("nor is a subdirectory");

  manifest({ pi: "dist/bundle/cli.js" });
  assert.equal(resolvePinnedAgent(fake).entry, join(pkgDir, "dist", "bundle", "cli.js"));
});

test("⚠️ a launcher that outlives its escalation makes the run fail, not succeed", async () => {
  // ⚠️ THIS RETURNED NORMALLY, and the wrapper then exited with Pi's code — so Pi finishing cleanly
  // reported overall success while a launcher that would not go was still holding the port. The
  // next start would meet an occupied port with nothing to explain it.
  const dir = project();
  const port = String(await freePort());
  let n = 0;
  const immortal = {
    exitCode: null,
    signalCode: null,
    stdin: { destroyed: false, write: () => {}, end: () => {} },
    kill: () => {},
    once: () => {},
  };
  const agent = {
    exitCode: null,
    signalCode: null,
    stdin: null,
    once: (event, cb) => {
      if (event === "exit") setImmediate(() => cb(0, null)); // Pi exits CLEANLY
    },
  };

  const e = await runSupervisor({
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    env: { PORT: port },
    randomBytes: () => Buffer.alloc(16, 3),
    build: null,
    spawn: () => (++n === 1 ? immortal : agent),
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({
        service: "kiln",
        protocol: "kiln.health/1",
        runId: "03".repeat(16),
        projectId: PROJECT_ID,
        build: null,
      }),
    }),
    graceMs: 200,
    hardMs: 150,
  }).catch((x) => x);

  assert.ok(e instanceof SupervisorRefusal, `expected a refusal, got ${JSON.stringify(e)?.slice(0, 120)}`);
  assert.equal(e.reason, REFUSAL.SHUTDOWN_NOT_OBSERVED);
  assert.equal(e.detail.agentExit.code, 0, "even though the agent itself finished cleanly");
  assert.equal(e.detail.shutdown.escalated, true);
  assert.equal(e.detail.shutdown.exitObserved, false);
  assert.match(e.message, new RegExp(`still be listening on 127\.0\.0\.1:${port}`), "and it says where to look");
  rmSync(dir, { recursive: true, force: true });
});

test("⚠️ a spawn fault raised while the health request is in flight is not accepted as ready", async () => {
  // ⚠️ THE SUCCESS BRANCH RE-CHECKED LIVENESS BUT NOT THE FAULT, so a launcher that failed to start
  // while its health request was in flight still produced `ready: true`. Two checks meant to be the
  // same check have to BE the same check — which is why there is now one assertion asked twice.
  let fault = null;
  const e = await awaitReadiness({
    port: 1,
    expected,
    childAlive: () => true, // never "exited" — only the FAULT ever appears
    childFault: () => fault,
    deadlineMs: 4000,
    fetchImpl: async () => {
      fault = "ENOENT"; // it failed to start while we were asking
      return { status: 200, json: async () => good().body };
    },
  }).catch((x) => x);

  assert.ok(e instanceof SupervisorRefusal, "a valid identity from a launcher that never started is not readiness");
  assert.equal(e.reason, REFUSAL.SPAWN_FAILED);
  assert.equal(e.detail.code, "ENOENT");
});

test("⚠️ every externally reportable error is classified, not quoted", async () => {
  // ⚠️ FIXING THE TRANSPORT LEFT THREE MORE. The launcher spawn error, the agent spawn error and the
  // stdin error each reach a refusal message or a shutdown record, and each fell back to
  // `String(e.message)` — so the same hostile string survived all three.
  const HOSTILE = "sk-live-secret /home/alice/key";
  const bad = new Error(HOSTILE);
  assert.equal(classifyError(bad), "Error", "a message is never the classification");

  // The stdin path, end to end.
  const listeners = {};
  let exit = null;
  const record = await stopLauncher(
    {
      get exitCode() {
        return exit;
      },
      signalCode: null,
      stdin: {
        destroyed: false,
        once: (event, cb) => (listeners[event] = cb),
        write: () => setImmediate(() => listeners.error?.(bad)),
        end: () => setTimeout(() => (exit = 0), 100),
      },
    },
    { graceMs: 3000 }
  );
  assert.equal(record.stdinError, "Error");
  assert.ok(!JSON.stringify(record).includes("sk-live-secret"), "no shutdown record may carry it");

  // And the agent spawn path.
  const dir = project();
  let n = 0;
  const child = (fail) => ({
    exitCode: null,
    signalCode: null,
    stdin: { destroyed: false, write: () => {}, end: () => {} },
    kill: () => {},
    once: (event, cb) => {
      if (event === fail) setImmediate(() => cb(bad));
    },
  });
  const e = await runSupervisor({
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 4),
    build: null,
    spawn: () => (++n === 1 ? child(null) : child("error")),
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({
        service: "kiln",
        protocol: "kiln.health/1",
        runId: "04".repeat(16),
        projectId: PROJECT_ID,
        build: null,
      }),
    }),
    graceMs: 200,
    hardMs: 150,
  }).catch((x) => x);
  assert.ok(!((e.message ?? "") + JSON.stringify(e.detail ?? {})).includes("sk-live-secret"), "nor any refusal");
  rmSync(dir, { recursive: true, force: true });
});
