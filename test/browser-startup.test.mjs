import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";

import { attachToPage, BROWSER_STARTUP_LIMITS, launchBrowser } from "./helpers/browser.mjs";

const response = (targets) => ({ json: async () => targets });

function clock() {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms) => {
      at += ms;
    },
  };
}

test("#38 delayed port creation receives its own bounded readiness phase", async () => {
  const time = clock();
  let reads = 0;
  const page = { connected: true };
  const result = await attachToPage("unused", { exit: null }, {
    ...time,
    portFileMs: 50,
    pageTargetMs: 20,
    pollMs: 10,
    readPort: () => {
      reads += 1;
      if (time.now() < 40) throw Object.assign(new Error("not created"), { code: "ENOENT" });
      return "9222";
    },
    fetchImpl: async () => response([{ type: "page", webSocketDebuggerUrl: "ws://ready" }]),
    connectImpl: async () => page,
  });
  assert.equal(result, page);
  assert.equal(time.now(), 40);
  assert.equal(reads, 5);
});

test("#38 delayed page discovery gets a fresh bound after the port file is ready", async () => {
  const time = clock();
  let targetProbes = 0;
  const page = { connected: true };
  const result = await attachToPage("unused", { exit: null }, {
    ...time,
    portFileMs: 50,
    pageTargetMs: 50,
    pollMs: 10,
    readPort: () => {
      if (time.now() < 40) throw Object.assign(new Error("not created"), { code: "ENOENT" });
      return "9222";
    },
    fetchImpl: async () => {
      targetProbes += 1;
      return response(time.now() < 80 ? [{ type: "service_worker" }] : [{ type: "page", webSocketDebuggerUrl: "ws://ready" }]);
    },
    connectImpl: async () => page,
  });
  assert.equal(result, page);
  assert.equal(time.now(), 80, "40ms of port wait does not consume the target phase's 50ms");
  assert.equal(targetProbes, 5);
});

test("#38 exhausted readiness reports the distinct phase and its bounded diagnostics", async () => {
  const portTime = clock();
  const portError = await attachToPage("unused", { exit: null }, {
    ...portTime,
    portFileMs: 20,
    pageTargetMs: 30,
    pollMs: 10,
    readPort: () => {
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    },
  }).catch((error) => error);
  assert.equal(portError.phase, "port-file");
  assert.deepEqual(portError.diagnostics.portFile, {
    limitMs: 20,
    probes: 3,
    readyAfterMs: null,
    lastError: "ENOENT: absent",
  });
  assert.equal(portError.diagnostics.pageTarget.probes, 0);

  const targetTime = clock();
  const targetError = await attachToPage("unused", { exit: null }, {
    ...targetTime,
    portFileMs: 20,
    pageTargetMs: 20,
    pollMs: 10,
    readPort: () => "9222",
    fetchImpl: async () => response([{ type: "service_worker" }]),
  }).catch((error) => error);
  assert.equal(targetError.phase, "page-target");
  assert.equal(targetError.diagnostics.portFile.readyAfterMs, 0);
  assert.deepEqual(targetError.diagnostics.pageTarget, {
    limitMs: 20,
    probes: 3,
    readyAfterMs: null,
    lastError: "no page target yet",
    targetTypes: ["service_worker"],
  });
});

function fakeProcess(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.stderr = new PassThrough();
  return proc;
}

test("#38 one failed start is cleaned before one retry uses a fresh profile", async () => {
  const events = [];
  const profiles = ["profile-one", "profile-two"];
  const processes = [];
  const page = { close: () => events.push("page-close") };
  let attachments = 0;
  const browser = await launchBrowser("fake-browser", {
    makeProfile: () => profiles.shift(),
    spawnImpl: (_path, args) => {
      const profile = args.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
      events.push(`spawn:${profile}`);
      const proc = fakeProcess(100 + processes.length);
      processes.push(proc);
      return proc;
    },
    attach: async (profile) => {
      attachments += 1;
      events.push(`attach:${profile}`);
      if (attachments === 1)
        throw Object.assign(new Error("first attempt stalled"), { phase: "port-file", diagnostics: { portFile: { lastError: "late" } } });
      return page;
    },
    inspectProcesses: () => ({ available: true, rows: [] }),
    terminate: async (proc) => events.push(`terminate:${proc.pid}`),
    removeProfile: (profile) => events.push(`remove:${profile}`),
  });

  assert.deepEqual(events.slice(0, 6), [
    "spawn:profile-one",
    "attach:profile-one",
    "terminate:100",
    "remove:profile-one",
    "spawn:profile-two",
    "attach:profile-two",
  ]);
  await browser.close();
  assert.deepEqual(events.slice(6), ["page-close", "terminate:101", "remove:profile-two"]);
});

test("#38 two failed starts stop after one retry, clean both attempts, and redact local paths", async () => {
  const profiles = ["C:\\Users\\person\\AppData\\Local\\Temp\\kiln-browser-one", "C:\\Users\\person\\AppData\\Local\\Temp\\kiln-browser-two"];
  const removed = [];
  const terminated = [];
  let spawned = 0;
  const error = await launchBrowser("fake-browser", {
    limits: { portFileMs: 11, pageTargetMs: 12, attempts: 99 },
    makeProfile: () => profiles[spawned],
    spawnImpl: () => {
      const proc = fakeProcess(200 + spawned);
      proc.stderr.end(`cannot use ${profiles[spawned]} under C:\\Users\\person`);
      spawned += 1;
      return proc;
    },
    attach: async (profile) => {
      throw Object.assign(new Error(`stalled in ${profile}`), {
        phase: "page-target",
        diagnostics: { pageTarget: { lastError: `failed at ${profile}` } },
      });
    },
    inspectProcesses: (profile) => ({ available: false, reason: `inspection failed for ${profile}` }),
    terminate: async (proc) => terminated.push(proc.pid),
    removeProfile: (profile) => removed.push(profile),
  }).catch((caught) => caught);

  assert.match(error.message, /after 2 attempt\(s\)/);
  assert.equal(error.diagnostics.attempts.length, BROWSER_STARTUP_LIMITS.attempts);
  assert.deepEqual(terminated, [200, 201]);
  assert.deepEqual(removed, profiles);
  assert.ok(error.diagnostics.attempts.every((attempt) => attempt.cleanup.complete));
  assert.doesNotMatch(JSON.stringify(error.diagnostics), /C:\\\\Users\\\\person|kiln-browser-(one|two)/);
  assert.equal(spawned, 2, "the configured attempt count cannot increase the one-retry ceiling");
});

