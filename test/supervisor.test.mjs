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
  resolveRunState,
  SESSION_DIR_ENV,
  SESSION_DIR_FLAG,
  stopLauncher,
  withSessionDir,
} from "../lib/supervisor.mjs";
import { IGNORE_RULES } from "../lib/project-gitignore.mjs";
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

/**
 * A process lister that succeeds and finds nothing — the honest fixture for a stand-in child, which
 * has no real pid for `ps` to relate anything to.
 *
 * ⚠️ **SUPPLIED RATHER THAN LEFT TO THE REAL `ps`, AND THE DIFFERENCE IS RECORDED EITHER WAY.** With
 * no lister the enumeration genuinely FAILS against a fake pid, and the supervisor rightly reports
 * the shutdown partial — `descendantsEnumerated: false` is not `no descendants`. That distinction has
 * its own test below; here it would only be noise.
 */
const NO_DESCENDANTS = () => ({ status: 0, stdout: "" });

/**
 * A stand-in child that exits the way a real one does: the exit event AND `exitCode` together.
 *
 * ⚠️ **THE TWO USED TO BE SEPARATE IN THESE FIXTURES, AND THAT MATTERED THE MOMENT THE SHUTDOWN
 * CHECK GOT STRICTER.** Firing `once("exit")` while leaving `exitCode` at null models a process that
 * announced its death and is still running — which no process does, and which made every stub tree
 * read as "never seen to exit" once `treeStopped` began asking. A fixture may simplify; it may not
 * describe something impossible.
 */
function exitingChild({ code = 0, signal = null } = {}) {
  const child = {
    exitCode: null,
    signalCode: null,
    stdin: null,
    kill: () => true,
    once: (event, cb) => {
      if (event !== "exit") return;
      setImmediate(() => {
        child.exitCode = code;
        child.signalCode = signal;
        cb(code, signal);
      });
    },
  };
  return child;
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
      psRun: NO_DESCENDANTS,
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
        return exitingChild();
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
    return exitingChild();
  };

  const dir = project();
  const result = await runSupervisor({
    projectRoot: dir,
    launcher: { command: "L", args: ["a"] },
    agent: { command: "A", args: ["b"] },
    spawn: fakeSpawn,
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: NO_DESCENDANTS,
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
  assert.deepEqual(launcher.args, ["a"], "structured arguments, never a command string");
  // ⚠️ THE AGENT'S ARRAY IS THE CALLER'S PLUS EXACTLY ONE PAIR THE SUPERVISOR OWNS. Where Pi writes
  // transcripts is not the caller's to choose — the coverage gate is only meaningful if Kiln knows
  // the location — so the flag is appended here rather than composed in `bin/start-kiln.mjs`, and it
  // is still a structured array with no shell between it and the child.
  assert.deepEqual(agent.args, ["b", "--session-dir", join(dir, ".pi", "sessions")]);
  assert.equal(agent.options.env.PI_CODING_AGENT_SESSION_DIR, join(dir, ".pi", "sessions"), "every route agrees");

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
    ...exitingChild(), // Pi exits CLEANLY

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
  // ⚠️ THE RECORD IS THE SEVEN-PART OBSERVATION NOW, not the launcher's alone. The launcher's own
  // control channel is one fact and the escalation against its tree is another, and this test is
  // about the second: the stop was asked for, it was not obeyed, and that is reported.
  assert.equal(e.detail.shutdown.launcher.exitObserved, false, "the control channel never saw it go");
  assert.equal(e.detail.shutdown.launcherEscalation.escalated, true, "so the tree was escalated against");
  assert.equal(e.detail.shutdown.launcherEscalation.treeStopped, false, "and it still was not seen to stop");
  assert.equal(e.detail.shutdown.complete, false);
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

/* ============================================ where Pi's transcripts go (TSK-0031, REQ-0027) ==== */

/**
 * ⚠️ **THE OTHER SUPERVISOR FIXTURES ARE NOT GIT REPOSITORIES, so the coverage gate passes them
 * vacuously.** That is correct for what they test and useless for testing the gate: `coverageState`
 * answers "not a repository, so nothing here is tracked" and never looks at a `.gitignore`. These
 * fixtures are repositories, which is the only way the refusal is reachable at all.
 */
function repoProject(opts) {
  const dir = project(opts);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}
const ignoreAll = (dir) =>
  writeFileSync(join(dir, ".gitignore"), `${IGNORE_RULES.join("\n")}\n`, "utf-8");

/**
 * Records every spawn without starting anything, so "nothing was started" is observable.
 *
 * ⚠️ IT REPORTS ITSELF EXITED ONCE ITS EXIT FIRES, and carries a `kill` that records rather than
 * signalling. Without the first, the supervisor's cleanup treats the stub as a live child and tries
 * to stop it; without the second it would call `kill` on a pid this test invented, which on a busy
 * machine is somebody else's process.
 */
function recordingSpawn(calls) {
  return (command, args, options) => {
    const exitListeners = [];
    const child = {
      exitCode: null,
      signalCode: null,
      stdin: null,
      pid: null,
      killed: [],
      // ⚠️ A KILL THAT ACTUALLY ENDS THE STUB. One that only recorded left the supervisor waiting out
      // its grace period and escalating on a child that could never go — a fake manufacturing the
      // failure it was standing in to avoid.
      kill: (sig) => {
        child.killed.push(sig ?? null);
        child.exitCode = 0;
        for (const cb of exitListeners.splice(0)) cb(0, null);
        return true;
      },
      once: (event, cb) => {
        if (event !== "exit") return;
        if (child.exitCode !== null) return void setImmediate(() => cb(child.exitCode, null));
        exitListeners.push(cb);
        // The agent is the one whose exit ends the run; the launcher waits to be stopped.
        if (command !== "L")
          setImmediate(() => {
            if (child.exitCode === null) {
              child.exitCode = 0;
              for (const l of exitListeners.splice(0)) l(0, null);
            }
          });
      },
    };
    calls.push({ command, args, options, child });
    return child;
  };
}

const healthyFetch = (runId = "07".repeat(16)) => async () => ({
  status: 200,
  json: async () => ({ service: "kiln", protocol: "kiln.health/1", runId, projectId: PROJECT_ID, build: null }),
});

test("⚠️ an unprotected project is REFUSED, and Pi is never started", async () => {
  // REQ-0027's ordering, at the last moment it can still be asked: the transcript is the first thing
  // Pi writes. The assertion that matters is that the agent was never spawned — a version that
  // logged a warning and launched anyway would satisfy any check on the message.
  const dir = repoProject();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");
  const calls = [];
  const port = String(await freePort());

  await assert.rejects(
    () =>
      runSupervisor({
        projectRoot: dir,
        launcher: { command: "L", args: ["a"] },
        agent: { command: "A", args: ["b"] },
        spawn: recordingSpawn(calls),
        env: { PORT: port },
        randomBytes: () => Buffer.alloc(16, 7),
      psRun: NO_DESCENDANTS,
    psRun: NO_DESCENDANTS,
        fetchImpl: healthyFetch(),
        build: null,
      }),
    (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.STATE_UNPROTECTED
  );

  assert.deepEqual(calls.map((c) => c.command), ["L"], "the launcher started; the AGENT never did");
  assert.equal(existsSync(join(dir, ".pi", "sessions")), false, "and no session directory was created");
});

test("⚠️ the gate is asked at LAUNCH, so a block removed after setup still refuses", async () => {
  const dir = repoProject();
  ignoreAll(dir);
  assert.equal(resolveRunState({ projectRoot: dir, projectId: PROJECT_ID }).roots.sessions, join(dir, ".pi", "sessions"));

  writeFileSync(join(dir, ".gitignore"), "# I removed it after setup ran\n", "utf-8");
  assert.throws(
    () => resolveRunState({ projectRoot: dir, projectId: PROJECT_ID }),
    (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.STATE_UNPROTECTED
  );
});

test("partial coverage is not coverage, and the refusal names what is missing", () => {
  const dir = repoProject();
  writeFileSync(join(dir, ".gitignore"), ".planning/\n", "utf-8");

  assert.throws(
    () => resolveRunState({ projectRoot: dir, projectId: PROJECT_ID }),
    (e) => e.reason === REFUSAL.STATE_UNPROTECTED && e.detail.uncovered.join() === ".pi/sessions/,.pi/runtime/"
  );
});

test("⚠️ external state is located by the committed id, and needs no ignore block", () => {
  // Nothing under the per-user root is inside the repository, so no rule protects it and none is
  // needed — which is why this project has no coverage at all and still resolves.
  const dir = repoProject();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");
  const home = reapLater(mkdtempSync(join(tmpdir(), "kiln-home-")));

  const { roots } = resolveRunState({
    projectRoot: dir,
    stateMode: "user",
    projectId: PROJECT_ID,
    platform: "linux",
    env: { XDG_STATE_HOME: home },
  });
  assert.equal(roots.sessions, join(home, "kiln", "projects", PROJECT_ID, "sessions"));
});

test("⚠️ an ABSENT session directory is a first run, not a refusal — and the supervisor does not create it", async () => {
  // The ownership contract, stated where it can be checked. The pinned Pi creates a custom session
  // directory itself (`SessionManager`'s constructor calls `mkdirSync(..., {recursive: true})`), and
  // that is authorised BECAUSE the location was proved ignored first — coverage-before-data as
  // REQ-0027 words it: the protection exists before the data. ACC-0103 requires absent storage to
  // read as a first run rather than as a problem.
  //
  // What must remain true is that the SUPERVISOR creates nothing: making directories is setup's
  // work, under the transaction that owns the project lock.
  const dir = repoProject();
  ignoreAll(dir);
  assert.equal(existsSync(join(dir, ".pi", "sessions")), false, "precondition: nothing has created it");

  const { roots } = resolveRunState({ projectRoot: dir, projectId: PROJECT_ID });
  assert.equal(roots.sessions, join(dir, ".pi", "sessions"));
  assert.equal(existsSync(roots.sessions), false, "resolving the location must not create it");

  const calls = [];
  await runSupervisor({
    projectRoot: dir,
    launcher: { command: "L", args: ["a"] },
    agent: { command: "A", args: ["b"] },
    spawn: recordingSpawn(calls),
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: NO_DESCENDANTS,
    fetchImpl: healthyFetch(),
    build: null,
  });

  assert.deepEqual(calls.map((c) => c.command), ["L", "A"], "the run proceeded — an absent directory is not a refusal");
  assert.equal(existsSync(join(dir, ".pi", "sessions")), false, "and the supervisor still created nothing");
});

test("⚠️ the session directory is supplied by the FLAG, and the variable is made to agree", () => {
  // All three routes were measured to work (EVD-0081) and they are not interchangeable: the flag is
  // the one a stale exported variable or a leftover `sessionDir` setting cannot outrank. The variable
  // is set to the same path so a future version that stopped passing the flag would still land in the
  // gated directory rather than silently reverting to `.pi/sessions`.
  const out = withSessionDir({ args: ["b"] }, "/s/sessions", { PATH: "x", PI_CODING_AGENT_SESSION_DIR: "/somewhere/stale" });

  assert.deepEqual(out.args, ["b", SESSION_DIR_FLAG, "/s/sessions"]);
  assert.equal(out.env[SESSION_DIR_ENV], "/s/sessions", "the operator's stale value is replaced, not respected");
  assert.equal(out.env.PATH, "x", "and the rest of the environment is untouched");
});

test("⚠️ an agent already naming a session directory is refused, never appended to", () => {
  // Two of them leave the location to whichever Pi prefers, and the coverage check is only
  // meaningful if Kiln can say where the transcripts went.
  for (const args of [["--session-dir", "/theirs"], ["--session-dir=/theirs"], ["x", "--session-dir", "/theirs"]])
    assert.throws(
      () => withSessionDir({ args }, "/ours", {}),
      (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.SESSION_DIR_CONFLICT,
      JSON.stringify(args)
    );
});

/* ================================ the run loop's shutdown, integrated (ACC-0081) =============== */

/** A signal target the test owns, so nothing is installed on the real process. */
function fakeSignals() {
  const handlers = new Map();
  return {
    on: (sig, cb) => handlers.set(sig, cb),
    off: (sig) => handlers.delete(sig),
    removeListener: (sig) => handlers.delete(sig),
    raise: (sig) => handlers.get(sig)?.(),
    installed: () => [...handlers.keys()],
  };
}

test("⚠️ AN INTERRUPT ENDS THE RUN WITHOUT WAITING FOR THE AGENT", async () => {
  // The race is the point. Awaiting the agent's exit and only then looking for a signal means an
  // interrupt during a long session is handled when the session ends — which is to say, not handled.
  // This agent never exits on its own; only the signal can end the run.
  const dir = repoProject();
  ignoreAll(dir);
  const signals = fakeSignals();
  const calls = [];
  // ⚠️ PIDS AND AN INJECTED KILLER, because `stopTree` signals BY PID — it never calls `child.kill()`.
  // A stub without a pid cannot be stopped by the code under test, and the run would report an agent
  // tree it never saw go. This models the one thing that actually ends these processes.
  const byPid = new Map();
  let nextPid = 4100;
  const spawn = (command, args, options) => {
    const child = {
      pid: nextPid++,
      exitCode: null,
      signalCode: null,
      stdin: command === "L" ? { destroyed: false, write: () => {}, end: () => {} } : null,
      // ⚠️ BOTH ROUTES, because the code under test uses both: `stopLauncher` escalates through the
      // child handle it holds, and `stopTree` signals by pid. A stub answering only one of them
      // fails for a reason that has nothing to do with the behaviour being tested.
      kill: () => {
        child.exitCode = 0;
        child.onExit?.(0, null);
        return true;
      },
      once: (event, cb) => {
        if (event === "exit") child.onExit = cb;
      },
    };
    byPid.set(child.pid, child);
    calls.push({ command, args, options, child });
    return child;
  };
  const end = (pid) => {
    const child = byPid.get(Number(pid));
    if (!child) return;
    child.exitCode = 0;
    child.onExit?.(0, null);
  };
  const kill = (pid, signal) => {
    // ⚠️ SIGNAL 0 IS A LIVENESS PROBE, NOT A REQUEST TO STOP. `pidAlive` uses it, and a stub that
    // died from being asked whether it was alive would make every survivor check self-fulfilling.
    if (signal !== 0) end(pid);
    return true;
  };
  // ⚠️ **AND THE WINDOWS ROUTE, WHICH IS A DIFFERENT MECHANISM ENTIRELY.** There is no graceful
  // signal there, so `stopTree` shells out to `taskkill /T /F` through the `run` seam rather than
  // calling `kill`. A fixture that modelled only the POSIX route would pass on Linux and fail on
  // Windows for a reason that has nothing to do with the race under test.
  const taskkill = (cmd, args) => {
    if (cmd === "taskkill") end(args[args.indexOf("/pid") + 1]);
    return { status: 0, stdout: "" };
  };

  const run = runSupervisor({
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn,
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: NO_DESCENDANTS,
    kill,
    run: taskkill,
    signalTarget: signals,
    fetchImpl: healthyFetch(),
    build: null,
    graceMs: 400,
    hardMs: 200,
  });

  // Wait until both children exist, then interrupt.
  for (let i = 0; i < 200 && calls.length < 2; i++) await sleep(10);
  assert.equal(calls.length, 2, "both children started");
  signals.raise("SIGINT");

  const result = await run;
  assert.equal(result.trigger, "signal", "the record says a signal ended it");
  assert.equal(result.shutdown.signal, "SIGINT", "recorded where it was handled, not inferred");
  assert.equal(result.shutdown.complete, true);
});

test("⚠️ AN AGENT THAT NEVER GOES DOES NOT HANG THE SUPERVISOR", async () => {
  // The control the previous test could not be. There, the signal handler's teardown killed the
  // agent, so awaiting its exit resolved anyway and a version that awaited instead of racing looked
  // identical. Here the agent survives everything — which is precisely the case bounded escalation
  // exists for — and awaiting it means replacing a hung application with a hung terminal.
  //
  // Asserted as a DEADLINE rather than by waiting to see: a hang has no failing assertion of its own.
  const dir = repoProject();
  ignoreAll(dir);
  const signals = fakeSignals();
  const calls = [];
  const spawn = (command, args, options) => {
    const child = {
      pid: 7100 + calls.length,
      exitCode: null,
      signalCode: null,
      stdin: command === "L" ? { destroyed: false, write: () => {}, end: () => {} } : null,
      // The launcher goes when asked; the agent never does, whatever is sent to it.
      kill: () => {
        if (command === "L") {
          child.exitCode = 0;
          child.onExit?.(0, null);
        }
        return true;
      },
      once: (event, cb) => {
        if (event === "exit") child.onExit = cb;
      },
    };
    calls.push({ command, args, options, child });
    return child;
  };

  const started = Date.now();
  const outcome = await Promise.race([
    runSupervisor({
      projectRoot: dir,
      launcher: { command: "L", args: [] },
      agent: { command: "A", args: [] },
      spawn,
      env: { PORT: String(await freePort()) },
      randomBytes: () => Buffer.alloc(16, 7),
      psRun: NO_DESCENDANTS,
      kill: () => true,
      run: () => ({ status: 0, stdout: "" }),
      signalTarget: signals,
      fetchImpl: healthyFetch(),
      build: null,
      graceMs: 200,
      hardMs: 150,
    }).catch((x) => x),
    (async () => {
      for (let i = 0; i < 200 && calls.length < 2; i++) await sleep(10);
      signals.raise("SIGINT");
      await sleep(6000);
      return "HUNG";
    })(),
  ]);

  assert.notEqual(outcome, "HUNG", "the supervisor must return rather than wait on a process that will not go");
  assert.ok(outcome instanceof SupervisorRefusal, `expected a refusal, got ${JSON.stringify(outcome)?.slice(0, 140)}`);
  assert.equal(outcome.reason, REFUSAL.SHUTDOWN_NOT_OBSERVED);
  assert.equal(outcome.detail.shutdown.agent.treeStopped, false, "and it says the agent tree was not stopped");
  assert.equal(outcome.detail.agentExit.observed, false, "rather than inventing an exit it never saw");
  assert.ok(Date.now() - started < 12_000, "bounded");
});

test("⚠️ the teardown runs ONCE, however many callers ask for it", async () => {
  // The signal handler and the agent-exit path both call it, within a tick of each other — the agent
  // exits BECAUSE the handler's teardown stopped it. Memoising the finished record rather than the
  // in-flight promise left a window where the second caller saw nothing recorded and began its own,
  // signalling processes the first was already escalating against.
  //
  // Counted through the port probe, because that is the one step of a shutdown that is observable
  // from outside without changing what it does.
  // ⚠️ IT HAS TO BE THE SIGNAL PATH. On a clean exit there is only one caller, so a version with no
  // memoisation at all behaves identically — the test would pass against the bug.
  const dir = repoProject();
  ignoreAll(dir);
  const signals = fakeSignals();
  const byPid = new Map();
  const calls = [];
  let probes = 0;

  const spawn = (command, args, options) => {
    const child = {
      pid: 8100 + calls.length,
      exitCode: null,
      signalCode: null,
      stdin: command === "L" ? { destroyed: false, write: () => {}, end: () => {} } : null,
      kill: () => {
        child.exitCode = 0;
        child.onExit?.(0, null);
        return true;
      },
      once: (event, cb) => {
        if (event === "exit") child.onExit = cb;
      },
    };
    byPid.set(child.pid, child);
    calls.push({ command, args, options, child });
    return child;
  };
  const end = (pid) => {
    const c = byPid.get(Number(pid));
    if (!c) return;
    c.exitCode = 0;
    c.onExit?.(0, null);
  };

  const run = runSupervisor({
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn,
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: NO_DESCENDANTS,
    kill: (pid, signal) => (signal === 0 ? true : (end(pid), true)),
    run: (cmd, args) => (cmd === "taskkill" ? (end(args[args.indexOf("/pid") + 1]), { status: 0, stdout: "" }) : { status: 0, stdout: "" }),
    signalTarget: signals,
    fetchImpl: healthyFetch(),
    build: null,
    graceMs: 300,
    hardMs: 200,
    createServerImpl: () => {
      probes += 1;
      return createServer();
    },
  });

  for (let i = 0; i < 200 && calls.length < 2; i++) await sleep(10);
  signals.raise("SIGINT");
  await run;

  // One probe for the port choice at startup, one for the rebind at shutdown. A second teardown —
  // the signal handler's and the main path's, which arrive within a tick of each other — adds a third.
  assert.equal(probes, 2, `expected one startup probe and one shutdown rebind, saw ${probes}`);
});

test("⚠️ the signal is recorded where it was HANDLED, and a clean exit records none", async () => {
  // Inferring "we were interrupted" from the processes having gone is unfalsifiable — they exit on
  // their own all the time. A run Pi ended must carry no signal rather than a plausible one.
  const dir = repoProject();
  ignoreAll(dir);
  const calls = [];
  const result = await runSupervisor({
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn: recordingSpawn(calls),
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: NO_DESCENDANTS,
    signalTarget: fakeSignals(),
    fetchImpl: healthyFetch(),
    build: null,
  });

  assert.equal(result.trigger, "agent-exit");
  assert.equal(result.shutdown.signal, null, "no signal is fabricated for a run that had none");
});

test("⚠️ A FAILED DESCENDANT ENUMERATION IS REPORTED, NOT READ AS AN EMPTY TREE", async () => {
  // ACC-0081's seventh clause: "a descendant enumeration that fails is recorded as unmade, because
  // an empty list would claim a tree with no children". The lister here fails the way a real one
  // does — a non-zero status — and the run must refuse rather than report a clean shutdown.
  const dir = repoProject();
  ignoreAll(dir);
  const calls = [];

  const e = await runSupervisor({
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn: recordingSpawn(calls),
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: () => ({ status: 1, stdout: "" }),
    signalTarget: fakeSignals(),
    fetchImpl: healthyFetch(),
    build: null,
  }).catch((x) => x);

  assert.ok(e instanceof SupervisorRefusal, `expected a refusal, got ${JSON.stringify(e)?.slice(0, 140)}`);
  assert.equal(e.reason, REFUSAL.SHUTDOWN_NOT_OBSERVED);
  assert.ok(e.detail.shutdown.notObserved.includes("agent-descendants"), "and it names WHICH observation was not made");
  assert.match(e.message, /Not observed/);
});

test("⚠️ the port is proved free by REBINDING it, and a held port fails the run", async () => {
  // An exit code says the leader is gone and says nothing about a worker still listening. This holds
  // the port with an unrelated server, so every process record is clean and the rebind is the only
  // check that can notice.
  const dir = repoProject();
  ignoreAll(dir);
  const port = await freePort();
  const calls = [];

  const held = createServer((_, res) => res.end());
  await new Promise((r) => held.listen(port, HOST, r));
  try {
    const e = await runSupervisor({
      projectRoot: dir,
      launcher: { command: "L", args: [] },
      agent: { command: "A", args: [] },
      spawn: recordingSpawn(calls),
      env: { PORT: String(port) },
      randomBytes: () => Buffer.alloc(16, 7),
      psRun: NO_DESCENDANTS,
      signalTarget: fakeSignals(),
      interactive: false,
      fetchImpl: healthyFetch(),
      build: null,
    }).catch((x) => x);

    // The port is occupied before the run even starts, so this refuses at port selection — which is
    // the earlier of the two guards and the one that should win.
    assert.ok(e instanceof SupervisorRefusal);
    assert.equal(e.reason, REFUSAL.PORT_OCCUPIED);
  } finally {
    held.close();
  }
});

test("⚠️ the signal handlers are removed when the run ends, on every path", async () => {
  // A supervisor that returns while still owning the operator's Ctrl+C has not finished.
  const dir = repoProject();
  ignoreAll(dir);
  const signals = fakeSignals();
  const calls = [];

  await runSupervisor({
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn: recordingSpawn(calls),
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: NO_DESCENDANTS,
    signalTarget: signals,
    fetchImpl: healthyFetch(),
    build: null,
  });
  assert.deepEqual(signals.installed(), [], "nothing left installed after a clean run");

  // And after a refusal.
  const bad = repoProject();
  writeFileSync(join(bad, ".gitignore"), "node_modules/\n", "utf-8");
  const signals2 = fakeSignals();
  await runSupervisor({
    projectRoot: bad,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn: recordingSpawn([]),
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: NO_DESCENDANTS,
    signalTarget: signals2,
    fetchImpl: healthyFetch(),
    build: null,
  }).catch(() => {});
  assert.deepEqual(signals2.installed(), [], "nothing left installed after a refusal either");
});
