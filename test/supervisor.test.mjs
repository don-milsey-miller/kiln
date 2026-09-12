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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import {
  HOST,
  BROWSER_ONLY_COMMAND,
  REFUSAL,
  SupervisorRefusal,
  assertProjectTrusted,
  resolveSelfHost,
  awaitReadiness,
  classifyError,
  choosePort,
  probePort,
  retryWithPort,
  readProjectRecord,
  runSupervisor,
  resolveRunState,
  SESSION_DIR_ENV,
  SESSION_DIR_FLAG,
  stopLauncher,
  withSessionDir,
  leftoverRunFiles,
  runFilePath,
  writeRunFile,
} from "../lib/supervisor.mjs";
import { PINNED_AGENT_NAME, readOwnPin, resolvePinnedAgent, resolvePinnedAgentDir } from "../lib/pi-runtime.mjs";
import { TRUST, denyTrust, grantTrust } from "../lib/pi-trust.mjs";
import { canonicalPath } from "../lib/content-root.mjs";
import { IGNORE_RULES } from "../lib/project-gitignore.mjs";
import {
  TOOLS_FLAG,
  exitStatusFor,
  parseArgs,
  piToolAllowlist,
  stoppedSummary,
  withToolAllowlist,
} from "../bin/start-kiln.mjs";
import { validatePackage } from "../lib/pi-package.mjs";
import { HEALTH_PATH, matchHealth } from "../lib/run-identity.mjs";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "test", "fixtures", "supervisor");
const PROJECT_ID = "abcdef0123456789abcdef0123456789";

/**
 * ⚠️ **THE TRUST GATE IS NOT WHAT THE CASES BELOW ARE ABOUT.** Every run now asks whether this project
 * is trusted before it does anything else, so these supply an already-approved answer and a directory
 * that is never opened — the injected reader is the only thing that would open one. The gate's own
 * behaviour, including two cases that run the real store, is asserted in its own section at the end.
 */
const AGENT_DIR = join(tmpdir(), "kiln-supervisor-agent-dir");
const APPROVED = async ({ projectRoot }) => ({ state: "approved", projectRoot, recordedFor: projectRoot });
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
      agentDir: AGENT_DIR,
      readTrust: APPROVED,
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

  // ⚠️ **THE REFUSAL MUST NAME THE EXPECTED VERSION AND THE RESOLVED PATH, not merely refuse.**
  // ACC-0041 asks for exactly those two, and asserting only the reason code passed while the message
  // said "not installed" and left an operator to work out which version was wanted and where it was
  // looked for. Both spellings are checked: the prose an operator reads, and the `detail` a caller
  // can act on.
  const missing = refusalFrom(() => resolvePinnedAgent(fake), REFUSAL.AGENT_NOT_INSTALLED);
  assert.ok(missing.message.includes("0.84.4"), `the refusal must name the expected version: ${missing.message}`);
  const resolvedPkgDir = join(canonicalPath(fake), "node_modules", "@earendil-works", "pi-coding-agent");
  assert.ok(missing.message.includes(resolvedPkgDir), `and the path it resolved: ${missing.message}`);
  assert.equal(missing.detail.expected, `${PINNED_AGENT_NAME}@0.84.4`);
  assert.equal(missing.detail.pkgDir, resolvedPkgDir);

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

/**
 * A directory holding an executable named `pi` that reports a version this project never pinned.
 *
 * ⚠️ **A REAL EXECUTABLE ON A REAL PATH, because the claim is about what a PATH LOOKUP WOULD FIND.**
 * A stub that only a test knows about proves nothing: the control below runs bare `pi` through the
 * platform's own resolution and requires that it find THIS file, which is what makes the treatment
 * meaningful. Windows resolves `pi` to `pi.cmd` through PATHEXT; POSIX needs the execute bit.
 */
const SHADOW_VERSION = "9.9.9-shadow";

function shadowPiOnPath() {
  const dir = reapLater(mkdtempSync(join(tmpdir(), "kiln-shadow-")));
  if (process.platform === "win32") {
    writeFileSync(join(dir, "pi.cmd"), `@echo off\r\necho ${SHADOW_VERSION}\r\n`);
  } else {
    const exe = join(dir, "pi");
    writeFileSync(exe, `#!/bin/sh\necho ${SHADOW_VERSION}\n`);
    chmodSync(exe, 0o755);
  }

  // ⚠️ **EVERY SPELLING OF THE VARIABLE IS REPLACED, NOT JUST `PATH`.** Windows environment names are
  // case-insensitive and a copied `process.env` can carry `Path`; adding a second `PATH` key beside
  // it leaves the child resolving against whichever the platform prefers, which is the one thing this
  // test must not leave to chance.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^path$/i.test(k)) env[k] = v;
  env.PATH = dir + delimiter + (process.env.PATH ?? "");
  return { dir, env };
}

test("⚠️ ACC-0041: a different `pi` earlier on PATH is never what starts", () => {
  const { env } = shadowPiOnPath();

  // ⚠️ **THE CONTROL COMES FIRST, AND WITHOUT IT THE TREATMENT ASSERTS NOTHING.** If the shadow were
  // not actually reachable — wrong directory, missing execute bit, PATHEXT not applying — the
  // treatment below would pass on a machine where no shadowing was ever possible, which is the
  // failure mode of every "we are not affected by X" test that never established X.
  // ⚠️ ONE STRING, NOT A COMMAND PLUS ARGS: passing args alongside `shell: true` is deprecated
  // (DEP0190) because the shell concatenates them unescaped, and a deprecation warning in every
  // CI cell is noise nobody reads.
  const control = spawnSync("pi --version", { env, encoding: "utf-8", shell: true });
  assert.equal(control.status, 0, `the shadow must be runnable: ${control.stderr}`);
  assert.match(
    `${control.stdout}`,
    new RegExp(SHADOW_VERSION),
    `a PATH lookup must find the shadow, or this test proves nothing: ${control.stdout}`
  );

  // The treatment: resolve the agent the way the command does, and start it with that same poisoned
  // PATH. What comes back must be the pinned version from this checkout's node_modules.
  const agent = resolvePinnedAgent(ROOT);
  const started = spawnSync(agent.command, [...agent.args, "--version"], { env, encoding: "utf-8" });

  assert.equal(started.status, 0, `the pinned agent must run: ${started.stderr}`);
  const said = `${started.stdout}`.trim();
  assert.match(said, /0\.84\.4/, `the started process must report the pinned version, said: ${said}`);
  assert.ok(!said.includes(SHADOW_VERSION), `the shadow must not be what ran: ${said}`);
  assert.equal(agent.version, readOwnPin(ROOT).version, "and the resolver's report agrees with the pin");
});

test("⚠️ ACC-0041: the pin and the Node floor are exactly what DEC-0026 decided", () => {
  // ⚠️ **EXACT, NOT A RANGE.** DEC-0026: "Changing the pin is an intentional, tested dependency
  // update that re-runs the compatibility suite; it is never a range that floats." A `^` or `~` here
  // would let a machine resolve a runtime nothing in this repository was measured against, and the
  // compatibility suite would go on passing against whatever happened to be installed.
  const own = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  assert.equal(own.dependencies[PINNED_AGENT_NAME], "0.84.4", "the pin is an exact version");
  // ⚠️ AND THE FLOOR IS NOT A PREFERENCE: 0.84.4 declares engines.node >=22.19.0, and a >=22 floor
  // would let a 22.0 install resolve a runtime that cannot start.
  assert.equal(own.engines.node, ">=22.19.0", "the Node floor matches what the pinned runtime requires");
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

  // ⚠️ THE REAL TRUST GATE, IN A REAL SUPERVISOR PROCESS: granted through the real store in a
  // temporary agent directory, so this run passes the gate the way a production run would.
  const trustAgentDir = reapLater(mkdtempSync(join(tmpdir(), "kiln-sentinel-agent-")));
  await grantTrust({ projectRoot: dir, agentDir: trustAgentDir, toolRoot: ROOT });

  // The supervisor inherits THIS pipe as its fd 0 — the harness's stand-in for the terminal.
  const supervisor = spawn(
    process.execPath,
    [join(FIXTURES, "run-supervisor.mjs"), dir, agentReport, launcherReport, readyFlag, gate, port, trustAgentDir],
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
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
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
  // ⚠️ THE RESOLVER, AND THE ALLOWLIST AROUND IT. Both halves are the security boundary: which
  // program runs, and what that program may do. A composition that dropped either would still read
  // as a launch, and the operator would not be able to tell from the outside.
  assert.match(
    src,
    /agent: withToolAllowlist\(resolvePinnedAgent\(TOOL_ROOT\), await piToolAllowlist\(TOOL_ROOT\)\)/,
    "the agent comes from the pinned-package resolver, constrained to the declared tools"
  );
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
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
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
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
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
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
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
  assert.equal(e.detail.shutdown.launcherTree.escalated, true, "so the tree was escalated against");
  assert.equal(e.detail.shutdown.launcherTree.treeStopped, false, "and it still was not seen to stop");
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
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
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
        agentDir: AGENT_DIR,
        readTrust: APPROVED,
        projectRoot: dir,
        launcher: { command: "L", args: ["a"] },
        agent: { command: "A", args: ["b"] },
        spawn: recordingSpawn(calls),
        env: { PORT: port },
        randomBytes: () => Buffer.alloc(16, 7),
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
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
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
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
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
      agentDir: AGENT_DIR,
      readTrust: APPROVED,
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
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
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
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
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
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
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

test("⚠️ the port is proved free by REBINDING it, and a port held at SHUTDOWN fails the run", async () => {
  // ⚠️ **THE PREVIOUS VERSION OF THIS ASSERTED THE WRONG GUARD.** It held the port before the run
  // began, so `choosePort` refused at startup and the shutdown rebind never happened — a test named
  // for the rebind that could not reach it. The port has to be FREE at selection and HELD at
  // teardown, which is the state the clause exists for: every process record is clean, the leader's
  // exit code says nothing about a worker still listening, and the rebind is the only check that
  // can notice.
  const dir = repoProject();
  ignoreAll(dir);
  const port = await freePort();
  const calls = [];

  let probes = 0;
  let held = null;
  try {
    const e = await runSupervisor({
      agentDir: AGENT_DIR,
      readTrust: APPROVED,
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
      // ⚠️ OCCUPIED BETWEEN THE TWO PROBES, WITH A REAL LISTENER. The first probe is the startup
      // selection and must succeed; something else takes the port while the run is going, and the
      // second probe is the rebind. Faking the second probe's answer would test the assertion rather
      // than the mechanism — `probePort` really has to fail to bind.
      createServerImpl: () => {
        probes += 1;
        if (probes === 2 && !held) {
          held = createServer((_, res) => res?.end?.());
          held.listen(port, HOST);
        }
        return createServer();
      },
    }).catch((x) => x);

    assert.ok(e instanceof SupervisorRefusal, `expected a refusal, got ${JSON.stringify(e)?.slice(0, 160)}`);
    assert.equal(e.reason, REFUSAL.SHUTDOWN_NOT_OBSERVED, "the run reached shutdown and failed THERE");
    assert.equal(e.detail.shutdown.portFree, false, "the rebind is what noticed");
    assert.equal(e.detail.shutdown.agent.treeStopped, true, "every process record is clean");
    assert.equal(e.detail.shutdown.launcherTree.treeStopped, true);
    assert.match(e.message, new RegExp(`listening on 127\.0\.0\.1:${port}`), "and it says where to look");
    assert.equal(calls.length, 2, "both children really started, so this is a shutdown-time failure");
  } finally {
    held?.close();
  }
});

test("⚠️ the signal handlers are removed when the run ends, on every path", async () => {
  // A supervisor that returns while still owning the operator's Ctrl+C has not finished.
  const dir = repoProject();
  ignoreAll(dir);
  const signals = fakeSignals();
  const calls = [];

  await runSupervisor({
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
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
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
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

test("⚠️ A DESCENDANT THAT APPEARS AFTER THE FIRST SAMPLE IS STILL SEEN AT TEARDOWN", async () => {
  // The snapshots handed to the shutdown are copies of what each tracker had already seen, and the
  // poll runs every 500ms. A worker that appeared since the last tick was missing from the copy the
  // shutdown then acted on — `stop()` does take a final look, but it ran in the `finally`, after the
  // stale copies had been used. Sampling immediately before the snapshots is what closes that.
  //
  // The lister below reports nothing at first and a worker afterwards, which is the whole scenario:
  // `next start` spawns its workers a moment after the launcher itself is up.
  const dir = repoProject();
  ignoreAll(dir);
  const calls = [];
  let listed = 0;
  const WORKER = 6001;

  // ⚠️ **ITS OWN STUB, WITH PIDS, AND DELIBERATELY NOT `recordingSpawn`.** That helper leaves `pid`
  // null on purpose: a test that does not stub `run` would otherwise reach the real `taskkill` with
  // a pid this fixture invented, which on a busy machine is somebody else's process. This test stubs
  // both `run` and `kill`, so pids are safe here and necessary — `ps` relates a worker to its parent
  // by pid, and a null one can never be anybody's parent.
  let nextPid = 5900;
  const spawn = (command, args, options) => {
    const child = {
      pid: nextPid++,
      exitCode: null,
      signalCode: null,
      stdin: command === "L" ? { destroyed: false, write: () => {}, end: () => {} } : null,
      kill: () => {
        child.exitCode = 0;
        child.onExit?.(0, null);
        return true;
      },
      once: (event, cb) => {
        if (event !== "exit") return;
        child.onExit = cb;
        // The agent finishes on its own; the launcher waits to be stopped.
        if (command !== "L")
          setImmediate(() => {
            child.exitCode = 0;
            cb(0, null);
          });
      },
    };
    calls.push({ command, args, options, child });
    return child;
  };

  const e = await runSupervisor({
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn,
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    // ⚠️ THE FIRST LOOK FINDS NOTHING; EVERY LATER ONE FINDS THE WORKER, reported as a child of the
    // launcher. A tracker that never re-sampled would carry the empty first answer into the shutdown.
    psRun: () => {
      listed += 1;
      const launcherPid = calls.find((c) => c.command === "L")?.child?.pid;
      if (listed === 1 || !launcherPid) return { status: 0, stdout: "" };
      return { status: 0, stdout: `${WORKER} ${launcherPid}
` };
    },
    // The worker never dies, so it is a survivor at teardown — which is only observable if it was
    // sampled at all.
    kill: (pid, signal) => {
      if (signal === 0 && Number(pid) === WORKER) return true;
      if (signal === 0) {
        const err = new Error("gone");
        err.code = "ESRCH";
        throw err;
      }
      return true;
    },
    run: () => ({ status: 0, stdout: "" }),
    signalTarget: fakeSignals(),
    fetchImpl: healthyFetch(),
    build: null,
    graceMs: 200,
    hardMs: 100,
  }).catch((x) => x);

  assert.ok(e instanceof SupervisorRefusal, `expected a refusal, got ${JSON.stringify(e)?.slice(0, 160)}`);
  assert.ok(
    e.detail.shutdown.notObserved.includes("launcher-descendants-survived"),
    `the late worker must reach the shutdown: ${JSON.stringify(e.detail.shutdown.notObserved)}`
  );
  assert.deepEqual(e.detail.shutdown.launcherTree.descendantsSurviving, [WORKER]);
});

test("⚠️ THE RUN REMOVES THE FILE IT CREATED, AND LEAVES EVERY FILE IT DID NOT (clause 6)", async () => {
  // ⚠️ **BOTH HALVES, BECAUSE ONLY ONE OF THEM IS ABOUT THIS INVOCATION.** "Its own file is
  // gone" is satisfied by a shutdown that empties the runtime directory, which is the failure the
  // criterion is worded against: another Kiln may be running in this project right now, and its live
  // -run file has the same NAME SHAPE as ours. So a stranger's file and a previous run's file are
  // both put there first, and both must still be there afterwards.
  //
  // ⚠️ AND THE LIST WAS VACUOUS UNTIL THIS RAN. The run loop passed `ownedFiles: []`, so
  // `files.failed === []` was true of a shutdown that removed nothing and could never have failed.
  const dir = repoProject();
  ignoreAll(dir);
  const runtime = join(dir, ".pi", "runtime");
  mkdirSync(runtime, { recursive: true });               // setup's work, done here as setup does it
  const stranger = join(runtime, "notes.txt");
  const earlier = join(runtime, `run-${"ab".repeat(16)}.json`);
  writeFileSync(stranger, "not Kiln's", "utf-8");
  writeFileSync(earlier, JSON.stringify({ runId: "ab".repeat(16) }), "utf-8");

  const runId = "07".repeat(16);
  const mine = join(runtime, `run-${runId}.json`);
  const calls = [];
  const spawn = recordingSpawn(calls);
  const lines = [];

  // ⚠️ OBSERVED WHILE THE RUN IS STILL GOING. Afterwards the file is gone either way — by
  // being removed, or by never having been written — and those are the two things being told apart.
  let presentAtAgentSpawn = null;
  let contentAtAgentSpawn = null;

  const result = await runSupervisor({
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn: (command, args, options) => {
      if (command === "A") {
        presentAtAgentSpawn = existsSync(mine);
        contentAtAgentSpawn = presentAtAgentSpawn ? JSON.parse(readFileSync(mine, "utf-8")) : null;
      }
      return spawn(command, args, options);
    },
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: NO_DESCENDANTS,
    fetchImpl: healthyFetch(runId),
    build: null,
    log: (m) => lines.push(m),
  });

  assert.equal(presentAtAgentSpawn, true, "the run must have created its own file before handing over the terminal");
  assert.equal(contentAtAgentSpawn.runId, runId, "and it names the run an operator would be reading the log for");
  assert.equal(contentAtAgentSpawn.projectId, PROJECT_ID);
  assert.equal(contentAtAgentSpawn.port, result.port, "and the port it holds");

  assert.deepEqual(result.shutdown.files.removed, [mine], "exactly what this invocation created, and nothing else");
  assert.deepEqual(result.shutdown.files.failed, []);
  assert.equal(existsSync(mine), false, "the run's own file is gone");
  assert.equal(existsSync(stranger), true, "a file this run did not create is still there");
  assert.equal(readFileSync(earlier, "utf-8").includes("ab".repeat(16)), true, "and so is an earlier run's, byte for byte");

  // The one thing that reads these files back: a leftover is REPORTED, by name, and left alone.
  assert.ok(
    lines.some((m) => m.includes("did not complete their shutdown") && m.includes(`run-${"ab".repeat(16)}.json`)),
    `the earlier run's file must be reported to the operator: ${JSON.stringify(lines)}`
  );
});

test("⚠️ a project whose runtime directory is gone still runs, and says it left no run file", async () => {
  // ⚠️ THE SUPERVISOR CREATES NO STATE DIRECTORY, here as everywhere: that is setup's work,
  // under the transaction that owns the project lock. The alternative — refusing — would make a
  // deleted breadcrumb directory more serious than the run it is a breadcrumb for.
  const dir = repoProject();
  ignoreAll(dir);
  const lines = [];
  const calls = [];
  await runSupervisor({
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn: recordingSpawn(calls),
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: NO_DESCENDANTS,
    fetchImpl: healthyFetch(),
    build: null,
    log: (m) => lines.push(m),
  });

  assert.deepEqual(calls.map((c) => c.command), ["L", "A"], "the run proceeded");
  assert.equal(existsSync(join(dir, ".pi", "runtime")), false, "and nothing created the directory");
  assert.ok(lines.some((m) => m.includes("leaves no run file")), JSON.stringify(lines));
});

test("⚠️ A RUN ID THAT IS NOT ONE NEVER BECOMES A PATH (traversal)", () => {
  // Reproduced before the check existed: `runFilePath(runtime, "x/../../escaped")` returned
  // `<two directories above runtime>/escaped.json` — a path the shutdown would then have DELETED as
  // a file this invocation created. The id is generated internally and cannot be malformed today;
  // the function is exported, composes a path, and is one caller away from being handed anything.
  const runtime = reapLater(mkdtempSync(join(tmpdir(), "kiln-runfile-")));
  const bad = [
    "x/../../escaped",
    "..",
    `../${"a".repeat(32)}`,
    `${"a".repeat(30)}/x`,
    "A".repeat(32), // uppercase hex is not what `generateRunId` writes
    "a".repeat(31),
    "a".repeat(33),
    "",
    `${"a".repeat(32)}.json`,
    null,
    12,
  ];
  for (const runId of bad) {
    assert.throws(
      () => runFilePath(runtime, runId),
      (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.RUN_FILE_UNSAFE,
      `runFilePath must refuse ${JSON.stringify(runId)}`
    );
    // ⚠️ AND THE WRITER REFUSES AT THE SAME BOUNDARY, because it is the writer that creates the
    // file the shutdown will remove; a check only the path helper performs is one call away from
    // being bypassed.
    assert.throws(
      () => writeRunFile(runtime, { runId, projectId: PROJECT_ID, port: 3000 }),
      (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.RUN_FILE_UNSAFE,
      `writeRunFile must refuse ${JSON.stringify(runId)}`
    );
  }
  assert.deepEqual(readdirSync(runtime), [], "and nothing was written anywhere while refusing");

  const runId = "0f".repeat(16);
  const good = runFilePath(runtime, runId);
  assert.equal(good, join(canonicalPath(runtime), `run-${runId}.json`), "a real run id still names its own file");
});

test("⚠️ A FILE ALREADY AT THAT NAME IS NOT CLAIMED BY THIS RUN, and survives it byte for byte", async () => {
  // ⚠️ **THE OWNED LIST IS AN AUTHORSHIP CLAIM, AND AN OVERWRITE IS NOT AUTHORSHIP.** The writer
  // used an ordinary `writeFileSync`: a file already at this exact name was silently replaced and
  // then added to `ownedFiles`, so the shutdown deleted a file this invocation did not create — the
  // half of clause 6 the run-file work was added to satisfy. `wx` is what makes the filesystem, not
  // this module's own earlier stat, answer the question.
  const dir = repoProject();
  ignoreAll(dir);
  const runtime = join(dir, ".pi", "runtime");
  mkdirSync(runtime, { recursive: true });

  const runId = "07".repeat(16); // what `randomBytes` below produces, and what the health probe reports
  const taken = join(runtime, `run-${runId}.json`);
  const contents = "somebody else was here first";
  writeFileSync(taken, contents, "utf-8");

  const calls = [];
  const lines = [];
  const result = await runSupervisor({
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn: recordingSpawn(calls),
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: NO_DESCENDANTS,
    fetchImpl: healthyFetch(runId),
    build: null,
    log: (m) => lines.push(m),
  });

  assert.deepEqual(calls.map((c) => c.command), ["L", "A"], "the run proceeded — a breadcrumb is not a contract");
  assert.deepEqual(result.shutdown.files.removed, [], "nothing was owned, so nothing was removed");
  assert.deepEqual(result.shutdown.files.failed, []);
  assert.equal(readFileSync(taken, "utf-8"), contents, "and the file that was there is untouched");
  assert.ok(
    lines.some((m) => m.includes("NOT written or claimed by this run")),
    `the operator is told why this run left no file: ${JSON.stringify(lines)}`
  );
});

test("⚠️ A LEFTOVER IS A RUN FILE, not anything shaped roughly like one", () => {
  // Prefix-and-suffix matching put any `run-*.json` — an operator's, another tool's — into Kiln's
  // log as a run that failed to shut down: a message about somebody else's file, containing a name
  // somebody else chose, saying something went wrong.
  const runtime = reapLater(mkdtempSync(join(tmpdir(), "kiln-runfile-")));
  const real = `run-${"ab".repeat(16)}.json`;
  for (const name of [real, "run-.json", "run-not-a-run-id.json", `run-${"AB".repeat(16)}.json`, "run-x.json.json", "notes.txt"])
    writeFileSync(join(runtime, name), "x", "utf-8");
  assert.deepEqual(leftoverRunFiles(runtime), [real]);
});

test("⚠️ ONE DEADLINE COVERS THE WHOLE TEARDOWN, ENUMERATION INCLUDED", async () => {
  // Reproduced against the previous version, with this fixture: the two descendant joins ran one
  // after the other and each waited out the process table's own timeout, and the run loop's
  // `finally` then took two more of them, so the teardown had not finished when this test gave up
  // at TWENTY SECONDS — with a 600ms budget configured, on a terminal whose operator had just
  // pressed Ctrl+C. The sibling control below, which lets the old version run to completion,
  // measured the whole of it at 48.8 seconds. Each bound was honoured; their sum was not bounded.
  //
  // ⚠️ ASSERTED AS A DEADLINE, because a hang has no failing assertion of its own — and the
  // arithmetic is stated rather than a round number: a 600ms budget, of which enumeration may take a
  // third, and three waiting periods that each keep their floor however little is left.
  const dir = repoProject();
  ignoreAll(dir);
  const signals = fakeSignals();
  const calls = [];
  const spawn = (command, args, options) => {
    const child = {
      pid: 9100 + calls.length,
      exitCode: null,
      signalCode: null,
      stdin: command === "L" ? { destroyed: false, write: () => {}, end: () => {} } : null,
      kill: () => true, // nothing here ever goes: the bound is the whole of what is under test
      once: (event, cb) => {
        if (event === "exit") child.onExit = cb;
      },
    };
    calls.push({ command, args, options, child });
    return child;
  };

  const graceMs = 400;
  const hardMs = 200;
  const outcome = runSupervisor({
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn,
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    // ⚠️ A PROCESS TABLE THAT NEVER ANSWERS. Measured on Windows, not invented: an operator's
    // Ctrl+Break reaches PowerShell too, and PowerShell answers it by breaking into its debugger.
    psRun: () => new Promise(() => {}),
    kill: () => true,
    run: () => ({ status: 0, stdout: "" }),
    signalTarget: signals,
    fetchImpl: healthyFetch(),
    build: null,
    graceMs,
    hardMs,
  }).catch((x) => x);

  for (let i = 0; i < 400 && calls.length < 2; i++) await sleep(10);
  assert.equal(calls.length, 2, "both children started");
  const raised = Date.now();
  signals.raise("SIGINT");
  const e = await Promise.race([outcome, sleep(20_000).then(() => "HUNG")]);
  const elapsed = Date.now() - raised;

  assert.notEqual(e, "HUNG", "the teardown must end without waiting out two process-table timeouts");
  assert.ok(e instanceof SupervisorRefusal, `expected a refusal, got ${JSON.stringify(e)?.slice(0, 140)}`);
  const ceiling = graceMs + hardMs + 3 * (graceMs + hardMs) + 1500; // budget, the three floors, and slack
  assert.ok(elapsed < ceiling, `the whole teardown must fit one budget: ${elapsed}ms, ceiling ${ceiling}ms`);

  // ⚠️ AND THE JOIN HAPPENED RATHER THAN BEING SKIPPED, on BOTH trees. A shutdown that never
  // waited for its queries would also be fast, and would be fast by not looking.
  const shutdown = e.detail.shutdown;
  assert.equal(shutdown.agent.descendantLooks.unresolved, 1, "the agent's query was joined, bounded, and reported");
  assert.equal(shutdown.launcherTree.descendantLooks.unresolved, 1, "and so was the launcher's");
  assert.equal(shutdown.budget.ms, graceMs + hardMs, "the record carries the budget it was given");
  assert.ok(shutdown.budget.spentMs >= 0, "and what the teardown actually cost");
});

test("⚠️ THE TWO DESCENDANT JOINS RUN TOGETHER, not one after the other", async () => {
  // The bound above is satisfied by a sequential join too — the periods after it simply get less —
  // so the thing that makes the enumeration worth its share of the budget needs its own control.
  // They are two independent queries about two different trees; run one after the other, the second
  // starts with the budget already half spent.
  //
  // ⚠️ COUNTED, NOT TIMED. Two queries in flight at once is the fact; a duration would be a proxy
  // for it that a slow machine can falsify.
  const dir = repoProject();
  ignoreAll(dir);
  const signals = fakeSignals();
  const calls = [];
  const byPid = new Map();
  const spawn = (command, args, options) => {
    const child = {
      pid: 9300 + calls.length,
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

  let hang = false;
  let inFlight = 0;
  let mostAtOnce = 0;
  const startedAt = [];
  const psRun = () => {
    if (!hang) return Promise.resolve({ status: 0, stdout: "" });
    startedAt.push(Date.now());
    inFlight += 1;
    mostAtOnce = Math.max(mostAtOnce, inFlight);
    return new Promise(() => {}); // the join has to give up on this one, which is what makes it observable
  };

  const run = runSupervisor({
    agentDir: AGENT_DIR,
    readTrust: APPROVED,
    projectRoot: dir,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn,
    env: { PORT: String(await freePort()) },
    randomBytes: () => Buffer.alloc(16, 7),
    psRun,
    // ⚠️ **WINDOWS, FOR ITS THREE-SECOND POLL.** What is being counted is the two joins the
    // shutdown performs; a 500ms poll would put its own queries in flight beside them and the count
    // would no longer be about the joins at all.
    platform: "win32",
    kill: (pid, signal) => (signal === 0 ? true : (end(pid), true)),
    run: (cmd, args) =>
      cmd === "taskkill" ? (end(args[args.indexOf("/pid") + 1]), { status: 0, stdout: "" }) : { status: 0, stdout: "" },
    signalTarget: signals,
    fetchImpl: healthyFetch(),
    build: null,
    graceMs: 600,
    hardMs: 300,
  });

  for (let i = 0; i < 400 && calls.length < 2; i++) await sleep(10);
  assert.equal(calls.length, 2, "both children started");
  hang = true;
  signals.raise("SIGINT");
  await run;

  assert.equal(mostAtOnce, 2, `both joins must be in flight at once, saw at most ${mostAtOnce}`);
  assert.equal(startedAt.length, 2, `one last look per tree and no more, saw ${startedAt.length}`);
  // ⚠️ **AND THEY STARTED TOGETHER, WHICH IS THE PART THE COUNT ALONE DOES NOT SETTLE.** Measured
  // against the previous version, the count assertions above pass there too, for a reason that has
  // nothing to do with the fix: the joins ran one after the other for twelve seconds each, and
  // during the first of them the OTHER tracker's three-second poll started a query of its own. Two
  // were in flight, and neither pair was two joins. What separates the two versions is WHEN the
  // second query begins — in the same tick as the first, or at whatever the other tracker's next
  // poll happens to be, measured there at 3008ms after it.
  const apart = Math.abs(startedAt[1] - startedAt[0]);
  assert.ok(apart < 250, `the second join must not wait for the first: they began ${apart}ms apart`);
});

/* ============================================ what the command reports (bin/start-kiln.mjs) ===== */

test("⚠️ AN INTERRUPT NEVER EXITS 0, EVEN WHEN PI SHUT DOWN TIDILY", () => {
  // The subtle half of this, and the one that survived the earlier fix. `code: null` from a killed
  // Pi was already handled; a signal Pi HANDLES — shutting down cleanly and exiting 0 — left the
  // agent's code saying success while the run had been interrupted, so a script wrapping this would
  // carry on. The supervisor observed which of the two ended the run; that decides the status.
  assert.equal(exitStatusFor({ trigger: "signal", agentExit: { code: 0, signal: null } }), 1, "the tidy interrupt");
  assert.equal(exitStatusFor({ trigger: "signal", agentExit: { code: null, signal: "SIGINT" } }), 1);
  assert.equal(exitStatusFor({ trigger: "signal", agentExit: { code: 7, signal: null } }), 1);

  // And an uninterrupted run still reports what Pi reported.
  assert.equal(exitStatusFor({ trigger: "agent-exit", agentExit: { code: 0, signal: null } }), 0);
  assert.equal(exitStatusFor({ trigger: "agent-exit", agentExit: { code: 3, signal: null } }), 3);
  assert.equal(exitStatusFor({ trigger: "agent-exit", agentExit: { code: null, signal: "SIGKILL" } }), 1);

  // ⚠️ AN EXIT NOBODY SAW IS NOT A ZERO. Unreachable today — such a run refuses before returning —
  // which is why it is pinned rather than left to the next change.
  assert.equal(exitStatusFor({ trigger: "agent-exit", agentExit: { code: null, signal: null, observed: false } }), 1);
});

test("⚠️ the stopped summary reads the record that exists, not the one that used to", () => {
  // The launcher's control-channel answer and its tree's are separate records now. This line kept
  // reading the old flat fields and printed three `undefined`s on every successful run — in the one
  // part of the system that had no test at all.
  const line = stoppedSummary({
    trigger: "agent-exit",
    shutdown: {
      launcher: { sentStop: true, endRequested: true, exitObserved: true },
      launcherTree: { treeStopped: true },
    },
  });

  assert.equal(/undefined/.test(line), false, `the summary must not print undefined: ${line}`);
  assert.match(line, /stop sent: true/);
  assert.match(line, /stdin end requested: true/);
  assert.match(line, /launcher exit observed: true/);
  assert.match(line, /launcher tree stopped: true/, "the tree is the half that notices a worker left behind");
  assert.match(line, /\(agent-exit\)/, "and it says which of the two ended the run");
});


/* ============================================ ACC-0082: the self-hosting checkout =============== */

/**
 * ⚠️ **COVERED SEPARATELY, AND THAT SEPARATION IS THE POINT.** The consumer-root checks are what stop
 * a run writing where it was not asked to; self-host mode is the one arrangement in which the tool
 * checkout IS the place it was asked to write. A mode that arrived by relaxing those checks would be
 * indistinguishable from the bug they exist to prevent, so both halves are asserted here: that the
 * mode is refused unless it was asked for twice, and that asking twice buys nothing except permission
 * to reach the same checks every other run makes.
 */

const selfHosting = (dir) => ({ toolRoot: dir, projectRoot: dir, agentDir: AGENT_DIR, readTrust: APPROVED });

/**
 * The refusal itself, not merely the fact of one. `assert.throws` returns undefined, and what these
 * assert is largely what the operator READS — the roots named, and the two parts of the opt-in.
 */
function refusalFrom(fn, reason) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SupervisorRefusal && e.reason === reason, `expected ${reason}, got ${e?.reason ?? e}`);
    return e;
  }
  assert.fail(`expected a ${reason} refusal, and nothing was thrown`);
}

test("the tool checkout is refused without the opt-in, and the refusal names both roots and both parts", () => {
  const dir = project();
  const e = refusalFrom(
    () =>
      resolveSelfHost({
        ...selfHosting(dir),
        selfHost: false,
        env: { PLANNING_CONTENT_DIR: join(dir, "planning-content") },
      }),
    REFUSAL.SELF_HOST_UNDECLARED
  );
  // ⚠️ THE REFUSAL HAS TO BE ACTIONABLE, because the operator who meets it is one keystroke from the
  // arrangement that writes `.pi/` into the tool repository.
  assert.match(e.message, /--self-host/, "it must name the flag");
  assert.match(e.message, /PLANNING_CONTENT_DIR/, "and the override, since the opt-in is both");
  assert.ok(e.message.includes(canonicalPath(dir)), "and the directory it is refusing to write into");
});

test("⚠️ the refusal arrives BEFORE the project record, so it never tells the operator to run setup here", async () => {
  // ⚠️ THIS IS THE ORDERING CLAUSE OF ACC-0082, NOT A TIDY-UP. A tool checkout has no `.pi/kiln.json`,
  // so checking the record first would answer "run setup for this project" — and setup is precisely
  // the thing that would create `.pi/` in the tool repository. The right refusal is about WHERE the
  // run is, and it has to arrive first to be the one the operator reads.
  const dir = reapLater(mkdtempSync(join(tmpdir(), "kiln-selfhost-")));
  await assert.rejects(
    () =>
      runSupervisor({
        ...selfHosting(dir),
        selfHost: false,
        launcher: { command: "L", args: [] },
        agent: { command: "A", args: [] },
        env: { PLANNING_CONTENT_DIR: join(dir, "planning-content") },
        spawn: () => assert.fail("nothing may be spawned before the mode is settled"),
        randomBytes: () => Buffer.alloc(16, 1),
      }),
    (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.SELF_HOST_UNDECLARED,
    "a tool checkout must refuse for being one, not for being unset up"
  );
});

test("the flag outside the tool checkout is refused rather than ignored", () => {
  // ⚠️ ACCEPTING IT WOULD BE THE WORST OF THE FOUR OUTCOMES: an operator with `--self-host` left in a
  // script believes they are running against the tool's own content while writing into someone
  // else's project, and nothing in the output would say otherwise.
  //
  // ⚠️ THE OVERRIDE IS SUPPLIED AND AGREES WITH THE TOOL ROOT, so the opt-in half passes and this
  // asserts the root comparison rather than being answered by an earlier check.
  const dir = project();
  const tool = join(dir, "tool");
  assert.throws(
    () =>
      resolveSelfHost({
        toolRoot: tool,
        projectRoot: dir,
        selfHost: true,
        env: { PLANNING_CONTENT_DIR: join(tool, "planning-content") },
      }),
    (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.SELF_HOST_NOT_SELF_HOSTING
  );
});

test("the flag without the content override is refused, because the opt-in is two inputs", () => {
  const dir = project();
  const e = refusalFrom(
    () => resolveSelfHost({ ...selfHosting(dir), selfHost: true, env: {} }),
    REFUSAL.SELF_HOST_NO_CONTENT_OVERRIDE
  );
  assert.match(e.message, /PLANNING_CONTENT_DIR=/, "it must name the variable AND a value to give it");
});

test("⚠️ the flag and the override are checked against each other, not merely each present", () => {
  // ⚠️ **THE PROJECT ROOT IS DERIVED FROM THE OVERRIDE, SO COMPARING ONLY IT CHECKS A DERIVATION
  // AGAINST ITSELF.** Here the caller says the project root is the tool root while the override names
  // content that some other directory owns. One of the two inputs is wrong and neither may be picked.
  const dir = project();
  const elsewhere = reapLater(mkdtempSync(join(tmpdir(), "kiln-other-")));
  const e = refusalFrom(
    () =>
      resolveSelfHost({
        ...selfHosting(dir),
        selfHost: true,
        env: { PLANNING_CONTENT_DIR: join(elsewhere, "planning-content") },
      }),
    REFUSAL.SELF_HOST_CONTENT_MISMATCH
  );
  assert.ok(e.message.includes(canonicalPath(elsewhere)), "the refusal must name the directory that owns the content");
  assert.ok(e.message.includes(canonicalPath(dir)), "and the tool root it disagrees with");
});

test("both parts, agreeing, is the one accepted arrangement", () => {
  const dir = project();
  const mode = resolveSelfHost({
    ...selfHosting(dir),
    selfHost: true,
    env: { PLANNING_CONTENT_DIR: join(dir, "planning-content") },
  });
  assert.equal(mode.selfHost, true);
  assert.equal(mode.projectRoot, canonicalPath(dir));

  // And an ordinary consumer run — different roots, no flag — is untouched by any of this.
  assert.equal(resolveSelfHost({ toolRoot: join(dir, ".planning"), projectRoot: dir, env: {} }).selfHost, false);
});

test("⚠️ the opt-in grants nothing: a self-hosting run meets every check a consumer run meets", async () => {
  // ⚠️ THE MUTATION THIS EXISTS TO CATCH is a self-host branch that skips the consumer-root checks
  // "because the operator asked for it". The opt-in decides WHERE the run is; the record, port,
  // state-coverage and readiness checks all still have to happen after it.
  const dir = project({ record: null });
  writeFileSync(join(dir, ".pi", "kiln.json"), JSON.stringify({ recordVersion: 1, projectId: "nope" }));

  await assert.rejects(
    () =>
      runSupervisor({
        ...selfHosting(dir),
        selfHost: true,
        launcher: { command: "L", args: [] },
        agent: { command: "A", args: [] },
        env: { PLANNING_CONTENT_DIR: join(dir, "planning-content") },
        spawn: () => assert.fail("an invalid record must refuse before anything is spawned"),
        randomBytes: () => Buffer.alloc(16, 1),
      }),
    (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.PROJECT_RECORD_INVALID,
    "self-host mode must not be a way past the project record"
  );
});

test("an explicit self-hosting run completes, and says which directory it opened", async () => {
  const dir = project();
  const said = [];
  let launcherExit = null;
  const calls = [];

  const result = await runSupervisor({
    ...selfHosting(dir),
    selfHost: true,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    env: { PLANNING_CONTENT_DIR: join(dir, "planning-content") },
    psRun: NO_DESCENDANTS,
    randomBytes: () => Buffer.alloc(16, 9),
    build: null,
    log: (m) => said.push(m),
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

  assert.equal(result.trigger, "agent-exit");
  // ⚠️ SAID OUT LOUD. Self-hosting is the one mode where the tool repository is the thing being
  // written into, and an operator should not have to infer that from a path in some later line.
  assert.ok(
    said.some((m) => /self-hosting/i.test(m) && m.includes(canonicalPath(dir))),
    `the run must name the mode and the directory: ${JSON.stringify(said)}`
  );
});

test("⚠️ --self-host with no override reaches the SELF-HOST refusal, through the real command", () => {
  // ⚠️ **THE HELPER TEST ABOVE CANNOT SEE THIS, AND THAT IS THE WHOLE POINT.** `resolveSelfHost` is
  // reached from `main()` only after `resolveProjectRoot()`, and the project root is
  // `dirname(contentRoot)` — so with the flag given and no `PLANNING_CONTENT_DIR` there is no content
  // root to take the dirname of, and the command died first with the generic "no planning content
  // root". That refusal answers a question the operator did not ask: they were overriding that rule,
  // and its hint line does not mention the flag they typed. Only running the command proves the
  // order, so this runs the command.
  const env = { ...process.env };
  delete env.PLANNING_CONTENT_DIR;

  const r = spawnSync(process.execPath, [join(ROOT, "bin", "start-kiln.mjs"), "--self-host"], {
    env,
    encoding: "utf-8",
    cwd: ROOT,
  });

  assert.equal(r.status, 2, `expected a refusal exit, got ${r.status}: ${r.stderr}${r.stdout}`);
  const said = `${r.stderr}${r.stdout}`;
  assert.match(said, /--self-host was given without PLANNING_CONTENT_DIR/, "the refusal must be the self-host one");
  assert.ok(!/No planning content root/.test(said), `the generic content-root refusal must not be what answers: ${said}`);

  // ⚠️ AND IT MUST SAY WHAT TO DO, both parts of it. An operator who reads only the first line has to
  // come away knowing the opt-in is two inputs and what the second one is.
  assert.match(said, /opt-in is BOTH/, "it must say the opt-in is both inputs");
  assert.match(said, /PLANNING_CONTENT_DIR=.+planning-content/, "and give the variable a value to use");
  assert.match(said, /^\s*\[kiln\]\s+--self-host\s*$/m, "and repeat the flag beside it");
});

test("the command line takes --self-host and refuses anything else", () => {
  assert.deepEqual(parseArgs([]), { selfHost: false });
  assert.deepEqual(parseArgs(["--self-host"]), { selfHost: true });

  // ⚠️ **A NEAR MISS IS A REFUSAL, NOT A SILENT FALSE.** A dropped unrecognised argument would report
  // a mistyped flag as "refusing to run in the tool checkout", which reads as the flag not working.
  for (const bad of ["--selfhost", "--self_host", "-s", "--self-host=true", "extra"])
    assert.match(parseArgs([bad]).error ?? "", /Unrecognised argument/, `must refuse ${bad}`);
});


/* ============================================== ACC-0051: the trust gate ======================= */

/** A project that would launch: covered state, a valid record, and a free port to ask for. */
const trustableProject = async () => {
  const dir = repoProject();
  ignoreAll(dir);
  return dir;
};

/** The bytes a refusal must not change: the committed record, the ignore block, and what is in .pi. */
const scaffoldBytes = (dir) => ({
  record: readFileSync(join(dir, ".pi", "kiln.json"), "utf-8"),
  ignore: readFileSync(join(dir, ".gitignore"), "utf-8"),
  pi: readdirSync(join(dir, ".pi")).sort(),
});

/** Records what the gate asked, and answers with the state it was built for. */
const trustReader = (state) => {
  const asked = [];
  const read = async ({ projectRoot, agentDir, toolRoot }) => {
    asked.push({ projectRoot, agentDir, toolRoot });
    return { state, projectRoot, recordedFor: state === TRUST.MISSING ? null : projectRoot };
  };
  return { read, asked };
};

/** A spawn that fails the test if it is ever reached. */
const forbiddenSpawn = () => {
  throw new assert.AssertionError({ message: "a child was spawned after a trust refusal" });
};

const refusedRun = async (options) => {
  try {
    await runSupervisor(options);
  } catch (e) {
    return e;
  }
  assert.fail("expected a trust refusal, and the run proceeded");
};

test("⚠️ ACC-0051 an unasked project refuses as trust-missing, and a declined one as trust-denied", async () => {
  for (const [state, reason, remediation] of [
    [TRUST.MISSING, REFUSAL.TRUST_MISSING, /run setup/i],
    [TRUST.DENIED, REFUSAL.TRUST_DENIED, /run setup again and approve/i],
  ]) {
    const dir = await trustableProject();
    const { read, asked } = trustReader(state);
    const before = scaffoldBytes(dir);

    const e = await refusedRun({
      projectRoot: dir,
      agentDir: AGENT_DIR,
      readTrust: read,
      launcher: { command: "L", args: [] },
      agent: { command: "A", args: [] },
      spawn: forbiddenSpawn,
      // ⚠️ AN UNUSABLE PORT ON PURPOSE: reaching the port check would refuse with PORT_INVALID, so a
      // trust refusal here proves the gate ran BEFORE a port was chosen rather than after.
      env: { PORT: "not-a-port" },
      randomBytes: () => Buffer.alloc(16, 7),
      psRun: NO_DESCENDANTS,
      fetchImpl: healthyFetch(),
      build: null,
    });

    assert.ok(e instanceof SupervisorRefusal && e.reason === reason, `${state}: got ${e?.reason ?? e}`);
    assert.equal(e.detail.state, state);
    assert.equal(asked.length, 1, "the gate asked once");
    assert.match(e.message, remediation, "the refusal says what to do about this particular answer");
    assert.match(e.message, new RegExp(BROWSER_ONLY_COMMAND.replace(/[./]/g, "\\$&")), "and names the browser-only route");
    assert.equal(e.detail.browserOnly, BROWSER_ONLY_COMMAND);

    // Nothing was spawned - forbiddenSpawn would have failed the test - and nothing changed on disk.
    assert.deepEqual(scaffoldBytes(dir), before, `${state}: the scaffold changed`);
    assert.equal(existsSync(join(dir, ".pi", "runtime")), false, `${state}: a runtime directory appeared`);
  }
});

test("⚠️ ACC-0051 the gate is asked BEFORE the project record is read", async () => {
  // ⚠️ **ORDERING, PROVED BY WHICH REFUSAL ARRIVES.** This project has no `.pi/kiln.json`, so reading
  // the record would refuse with NO_PROJECT_RECORD. A trust refusal instead is the only way to tell
  // that the gate ran first — and it must, because "run setup" is useless advice to an operator whose
  // project the agent may not be started in at all.
  const dir = repoProject({ record: false });
  ignoreAll(dir);
  const { read } = trustReader(TRUST.MISSING);

  const e = await refusedRun({
    projectRoot: dir,
    agentDir: AGENT_DIR,
    readTrust: read,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn: forbiddenSpawn,
    env: { PORT: "not-a-port" },
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: NO_DESCENDANTS,
    fetchImpl: healthyFetch(),
    build: null,
  });

  assert.equal(e.reason, REFUSAL.TRUST_MISSING, "the trust question came first, before the record and the port");
});

test("⚠️ ACC-0051 the two refusals are distinct codes, so a caller need not read a detail to tell them apart", () => {
  assert.notEqual(REFUSAL.TRUST_MISSING, REFUSAL.TRUST_DENIED);
  assert.equal(REFUSAL.TRUST_MISSING, "trust-missing");
  assert.equal(REFUSAL.TRUST_DENIED, "trust-denied");
});

test("⚠️ ACC-0051 the gate is asked with the canonical project root and the exact agent directory", async () => {
  const dir = await trustableProject();
  const { read, asked } = trustReader(TRUST.MISSING);
  const agentDir = join(tmpdir(), "kiln-exact-agent-dir");

  await refusedRun({
    // ⚠️ A SPELLING `join` WOULD NOT FIX: built by concatenation, because `join(dir, ".")` collapses to
    // `dir` and would have compared the canonical root against itself.
    projectRoot: `${dir}${sep}.${sep}`,
    agentDir,
    readTrust: read,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn: forbiddenSpawn,
    env: {},
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: NO_DESCENDANTS,
    fetchImpl: healthyFetch(),
    build: null,
  });

  assert.equal(asked[0].projectRoot, canonicalPath(dir), "the canonical root, not the spelling passed in");
  assert.equal(asked[0].agentDir, agentDir, "the exact directory the command resolved, unchanged");
});

test("⚠️ ACC-0051 a run without a resolved agent directory refuses rather than guessing one", async () => {
  const dir = await trustableProject();
  const { read, asked } = trustReader(TRUST.APPROVED);

  for (const agentDir of [undefined, "", "   "]) {
    const e = await refusedRun({
      projectRoot: dir,
      agentDir,
      readTrust: read,
      launcher: { command: "L", args: [] },
      agent: { command: "A", args: [] },
      spawn: forbiddenSpawn,
      env: {},
      randomBytes: () => Buffer.alloc(16, 7),
      psRun: NO_DESCENDANTS,
      fetchImpl: healthyFetch(),
      build: null,
    });
    assert.equal(e.reason, REFUSAL.AGENT_DIR_MISSING, JSON.stringify(agentDir));
  }
  assert.equal(asked.length, 0, "no store was consulted at all");
});

test("⚠️ ACC-0051 an approved project reaches the launch path, and every child is told that agent directory", async () => {
  const dir = await trustableProject();
  const agent = reapLater(mkdtempSync(join(tmpdir(), "kiln-gate-agent-")));
  // ⚠️ THE REAL MODULE AND THE REAL STORE, in a temporary agent directory: no injected answer.
  await grantTrust({ projectRoot: dir, agentDir: agent, toolRoot: ROOT });

  const calls = [];
  const result = await runSupervisor({
    projectRoot: dir,
    agentDir: agent,
    launcher: { command: "L", args: ["a"] },
    agent: { command: "A", args: ["b"] },
    spawn: recordingSpawn(calls),
    // ⚠️ A STALE SPELLING IN THE INHERITED ENVIRONMENT, which every child must have replaced.
    env: { PORT: String(await freePort()), PI_CODING_AGENT_DIR: join(tmpdir(), "somewhere-else") },
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: NO_DESCENDANTS,
    fetchImpl: healthyFetch(),
    build: null,
  });

  assert.deepEqual(calls.map((c) => c.command), ["L", "A"], "the approved run reached the existing launch path");
  assert.equal(result.shutdown.complete, true, "and completed the ordinary shutdown contract, gate or no gate");
  for (const call of calls)
    assert.equal(call.options.env.PI_CODING_AGENT_DIR, agent, `${call.command} was given the resolved agent directory`);
});

test("⚠️ ACC-0051 a denial recorded in the real store stops the run, through the real module", async () => {
  const dir = await trustableProject();
  const agent = reapLater(mkdtempSync(join(tmpdir(), "kiln-gate-denied-")));
  await denyTrust({ projectRoot: dir, agentDir: agent, toolRoot: ROOT });
  const before = scaffoldBytes(dir);

  const e = await refusedRun({
    projectRoot: dir,
    agentDir: agent,
    launcher: { command: "L", args: [] },
    agent: { command: "A", args: [] },
    spawn: forbiddenSpawn,
    env: {},
    randomBytes: () => Buffer.alloc(16, 7),
    psRun: NO_DESCENDANTS,
    fetchImpl: healthyFetch(),
    build: null,
  });

  assert.equal(e.reason, REFUSAL.TRUST_DENIED);
  assert.equal(e.detail.state, TRUST.DENIED);
  assert.equal(e.detail.recordedFor, canonicalPath(dir), "the refusal names the directory the denial was recorded against");
  assert.deepEqual(scaffoldBytes(dir), before, "the scaffold is untouched");
});

test("⚠️ ACC-0051 the gate can be asked on its own, and approves without opening anything else", async () => {
  const dir = await trustableProject();
  const agent = reapLater(mkdtempSync(join(tmpdir(), "kiln-gate-direct-")));
  await grantTrust({ projectRoot: dir, agentDir: agent, toolRoot: ROOT });

  const said = [];
  const decision = await assertProjectTrusted({ projectRoot: canonicalPath(dir), agentDir: agent, toolRoot: ROOT, log: (m) => said.push(m) });

  assert.equal(decision.state, TRUST.APPROVED);
  assert.equal(decision.projectRoot, canonicalPath(dir));
  assert.ok(said.some((m) => /project trust: approved/.test(m)), "an approval is reported rather than silent");
});

test("⚠️ the pinned package's own agent directory is asked of it, and follows the environment Pi reads", async () => {
  const resolved = await resolvePinnedAgentDir(ROOT);
  assert.equal(typeof resolved, "string");
  assert.ok(resolved.length > 0);

  // ⚠️ getAgentDir() reads process.env itself, which is exactly why the command resolves it in the
  // process whose environment the children inherit.
  const saved = process.env.PI_CODING_AGENT_DIR;
  const chosen = join(tmpdir(), "kiln-agent-dir-from-env");
  try {
    process.env.PI_CODING_AGENT_DIR = chosen;
    assert.equal(await resolvePinnedAgentDir(ROOT), chosen, "the environment Pi reads is the one that decides");
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

/* ====================================== ACC-0065: what the agent may do ======================== */

/**
 * Pi's own built-in tool names, read out of the pinned runtime rather than written down here.
 *
 * ⚠️ **A HANDWRITTEN LIST WOULD GO STALE SILENTLY**, and the assertion it feeds would then pass by
 * knowing less than the runtime does. The set is not reachable through the package's `exports` map,
 * so it is read as data from the file that declares it, and the extraction is checked before it is
 * trusted: an empty or partial parse would make every "no built-in survived" assertion vacuous.
 */
function pinnedBuiltinToolNames() {
  const source = readFileSync(
    join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "tools", "index.js"),
    "utf-8"
  );
  const declared = source.match(/allToolNames\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(declared, "the pinned runtime no longer declares allToolNames where this test reads it");
  const names = [...declared[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  for (const expected of ["read", "bash", "edit", "write"])
    assert.ok(names.includes(expected), `the extracted built-in set is missing ${expected}, so it was not parsed`);
  return names;
}

/** The refusal a call makes, so a test reads its reason and its detail rather than only its text. */
const refusalOf = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SupervisorRefusal, `not a refusal: ${e}`);
    return e;
  }
  assert.fail("the call was expected to refuse and returned instead");
};

test("⚠️ ACC-0065 the launch allowlist is the validated declaration, and holds no Pi built-in", async () => {
  const tools = await piToolAllowlist(ROOT);
  const { tools: validated, signature } = await validatePackage({ packageRoot: join(ROOT, "pi-package") });

  // ⚠️ THE SAME LIST, NOT A COPY OF IT. A second handwritten table is a second answer to what Kiln
  // offers, and the two disagree the first time one is edited alone.
  assert.deepEqual(tools, validated, "the allowlist is what validation produced");
  assert.deepEqual(tools, [...signature.tools].sort(), "which is what the declaration claims");
  assert.equal(signature.signatureVersion, 1, "and the declaration's shape is unchanged");
  // ⚠️ THE DECLARATION DECIDES THE COUNT (F83). A number written here goes stale the moment a tool
  // is added, and it did.
  assert.equal(tools.length, signature.tools.length);

  const builtins = pinnedBuiltinToolNames();
  for (const builtin of builtins)
    assert.equal(tools.includes(builtin), false, `${builtin} is a Pi built-in and must not be requested`);
  // ⚠️ **AN EXACT SET, NOT A PREFIX.** This line used to assert that every declared name began
  // `kiln_`, which was true of the 22 that existed when it was written and is not a rule of the
  // package: TSK-0045 registers research_capability, research_search, research_fetch,
  // validation_capability and validation_run under the names `lib/specialists/contract.mjs`
  // requires by key. The declaration itself is the thing to compare against, and it is compared
  // above - so what is left here is the claim a prefix was standing in for: no name Kiln did not
  // declare, which the built-in check below then makes specific.
  assert.deepEqual(new Set(tools).size, tools.length, "a name is declared twice");
});

test("⚠️ ACC-0065 the allowlist is appended as the one flag Pi reads, and reads back as the same names", async () => {
  const tools = await piToolAllowlist(ROOT);
  const agent = { command: "A", args: ["entry.js"], entry: "entry.js", version: "0.84.4" };
  const constrained = withToolAllowlist(agent, tools);

  assert.equal(constrained.command, "A", "the pinned command is untouched");
  assert.equal(constrained.entry, "entry.js", "and so is everything else the resolver reported");
  assert.deepEqual(constrained.args.slice(0, 1), ["entry.js"], "the arguments it already had come first");
  assert.deepEqual(constrained.args.slice(1, 2), [TOOLS_FLAG], "then the flag");
  assert.equal(constrained.args.length, 3, "one flag and one value, nothing else");
  assert.deepEqual(agent.args, ["entry.js"], "and the caller's array is not mutated");

  // ⚠️ READ BACK THE WAY PI READS IT: `dist/cli/args.js` takes the NEXT argument and splits it on
  // commas, trimming each. A value that needed different handling would not be this flag's value.
  const asPiWouldRead = constrained.args[2]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  assert.deepEqual(asPiWouldRead, tools, "Pi's own splitting returns exactly the declared names");
});

test("⚠️ ACC-0065 the session directory is still the supervisor's, and lands after the allowlist", async () => {
  const tools = await piToolAllowlist(ROOT);
  const constrained = withToolAllowlist({ command: "A", args: ["entry.js"] }, tools);
  const session = withSessionDir(constrained, "/s/sessions", {});

  // ⚠️ TWO OWNERS, ONE ARRAY, AND NEITHER OVERWRITES THE OTHER. What the agent may do is this
  // command's to state; where the transcripts go is the supervisor's, because the coverage gate is
  // only meaningful if Kiln knows the location.
  assert.deepEqual(session.args, ["entry.js", TOOLS_FLAG, tools.join(","), SESSION_DIR_FLAG, "/s/sessions"]);
  assert.equal(session.env[SESSION_DIR_ENV], "/s/sessions");
});

test("⚠️ ACC-0065 an argument list that already names a tool policy is refused, in every spelling Pi accepts", async () => {
  const tools = await piToolAllowlist(ROOT);

  // ⚠️ `-t` IS THE SAME FLAG, and `--tools=…` is worse than a duplicate: Pi matches neither that form
  // nor `-t=…`, so an argument list carrying one has a policy in it that would silently do nothing.
  for (const existing of [["--tools", "bash"], ["-t", "bash"], ["--tools=bash"], ["-t=bash"]]) {
    const e = refusalOf(() => withToolAllowlist({ command: "A", args: ["entry.js", ...existing] }, tools));
    assert.equal(e.reason, REFUSAL.TOOL_ALLOWLIST_CONFLICT, `${existing.join(" ")}: ${e.reason} — ${e.message}`);
    assert.deepEqual(e.detail.tools, tools, "and the refusal carries the list it was asked to apply");
  }

  // And a flag that merely looks similar is not a conflict: refusing it would be refusing a launch
  // for an argument Pi reads as something else entirely.
  const fine = withToolAllowlist({ command: "A", args: ["entry.js", "--exclude-tools", "ask_question"] }, tools);
  assert.deepEqual(fine.args.slice(-2), [TOOLS_FLAG, tools.join(",")]);
});

test("⚠️ ACC-0065 no allowlist is a refusal, not a launch with Pi's built-ins active", () => {
  for (const nothing of [undefined, null, [], "kiln_lint"]) {
    const e = refusalOf(() => withToolAllowlist({ command: "A", args: [] }, nothing));
    assert.equal(e.reason, REFUSAL.TOOL_ALLOWLIST_MISSING, `${JSON.stringify(nothing)}: ${e.reason}`);
    assert.match(e.message, /built-in|boundary/i);
  }

  // ⚠️ A NAME THAT WOULD NOT SURVIVE THE COMMAND LINE IS ALSO NOT AN ALLOWLIST. Pi splits this value
  // on commas, so a name carrying one arrives as two names, neither of which Kiln registered.
  for (const malformed of [["kiln_lint,bash"], ["kiln_lint", ""], ["kiln_lint", "   "], ["kiln lint"]]) {
    const e = refusalOf(() => withToolAllowlist({ command: "A", args: [] }, malformed));
    assert.equal(e.reason, REFUSAL.TOOL_ALLOWLIST_MISSING, `${JSON.stringify(malformed)}: ${e.reason}`);
  }
});

test("⚠️ ACC-0065 the real command constrains the agent it hands the supervisor", () => {
  // ⚠️ **THE HELPER TESTS ABOVE CANNOT SEE THIS.** They prove that a composer composes; this proves
  // that the command calls it, over the pinned agent this checkout resolves, with the package this
  // checkout declares. The supervisor is replaced by a recorder because the alternative is attaching
  // the operator's terminal to Pi.
  const base = reapLater(mkdtempSync(join(tmpdir(), "kiln-launch-")));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });

  const r = spawnSync(process.execPath, [join(ROOT, "test", "fixtures", "start-kiln", "capture-launch.mjs")], {
    env: { ...process.env, PLANNING_CONTENT_DIR: contentRoot, KILN_CAPTURE_LAUNCH: "1" },
    encoding: "utf-8",
    cwd: ROOT,
  });

  const line = `${r.stdout}`.split("\n").find((l) => l.startsWith("KILN_LAUNCH "));
  assert.ok(line, `the command did not reach the supervisor: ${r.stdout}${r.stderr}`);
  const launch = JSON.parse(line.slice("KILN_LAUNCH ".length));

  const pinned = resolvePinnedAgent(ROOT);
  const declared = JSON.parse(readFileSync(join(ROOT, "pi-package", "signature.json"), "utf-8")).tools.slice().sort();

  assert.equal(launch.agentCommand, pinned.command, "the pinned command is what runs");
  assert.deepEqual(
    launch.agentArgs,
    [...pinned.args, TOOLS_FLAG, declared.join(",")],
    "the pinned entry point, then the allowlist, and nothing else"
  );
  assert.equal(launch.agentArgs.includes(SESSION_DIR_FLAG), false, "the session directory is still the supervisor's to add");
  assert.deepEqual(launch.launcherArgs, [join(ROOT, "bin", "start-shell.mjs")], "the launcher is unchanged");
  assert.equal(launch.agentDir, "string", "and the pinned agent directory is still resolved and passed");

  for (const builtin of pinnedBuiltinToolNames())
    assert.equal(
      launch.agentArgs[launch.agentArgs.length - 1].split(",").includes(builtin),
      false,
      `${builtin} reached the real command line`
    );
});
