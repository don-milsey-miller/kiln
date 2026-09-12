/**
 * What a real Pi session's tool registry actually holds — TSK-0044, against ACC-0064 and ACC-0065.
 *
 * ⚠️ **THE PINNED CLI IS RUN, NOT THE SDK IN PROCESS.** `test/pi-package-load.test.mjs` asks the
 * runtime's resource loader what it discovered; that proves the package loads. It cannot say what a
 * session ends up offering a model, because the active set is decided by the session, from the
 * command line, over everything discovery found. So this spawns the pinned `bin.pi` entry point with
 * the argument array `bin/start-kiln.mjs` composes, and measures inside the session that results.
 *
 * ⚠️ **THE MEASUREMENT IS `pi.getActiveTools()`, WHICH IS THE SESSION'S OWN REGISTRY.** Not
 * `signature.json`, not the registration recorder, not the `--tools` argument, and not the tool
 * definitions in a provider request. Each of those would be a different claim: what the package
 * declares, what registration produces, what Kiln asked for, and what one request happened to carry.
 * What ACC-0064 is about is what the session offers, so the reading is taken from the session.
 *
 * ⚠️ **THE CONTROL IS THE SAME RUN WITHOUT THE ALLOWLIST.** A measurement that returned the Kiln
 * tools and nothing else would look identical whether Pi had applied the allowlist or the probe had
 * simply been unable to see built-ins. The control run measures Pi's own defaults through exactly the
 * same probe, so the reading is known to be capable of seeing what the first run says is absent.
 *
 * ⚠️ **NO MODEL REQUEST IS MADE, AND THAT IS OBSERVED RATHER THAN ASSUMED.** The provider is
 * registered by the probe against a server this test starts on the loopback interface, with zero
 * cost, a planted key that is not a credential, and `--offline`. The server counts what arrives, and
 * the count must be zero: the session is asked for its state, not for inference.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { resolvePinnedAgent, resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import { packageRootFor } from "../lib/pi-package.mjs";
import { PORTABLE_PACKAGE_ENTRY } from "../lib/pi-package-entry.mjs";
import { piToolAllowlist, withToolAllowlist } from "../bin/start-kiln.mjs";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = await import(resolvePinnedSdk(ROOT).url);

/** Pi's own built-in tool names, read from the pinned runtime rather than restated here. */
function pinnedBuiltinToolNames() {
  const source = readFileSync(join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "tools", "index.js"), "utf-8");
  const declared = source.match(/allToolNames\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(declared, "the pinned runtime no longer declares allToolNames where this test reads it");
  const names = [...declared[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  for (const expected of ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"])
    assert.ok(names.includes(expected), `the extracted built-in set is missing ${expected}, so it was not parsed`);
  return names;
}

/** A credential-shaped value planted in the child's environment. Nothing retained may carry it. */
const PLANTED_KEY = "sk-kiln-LOOPBACK-PLANTED-3ba7";

/**
 * This process's environment with anything credential-shaped taken out.
 *
 * ⚠️ **THE SESSION IS NOT MERELY POINTED AWAY FROM THE OPERATOR'S KEYS; IT IS NOT GIVEN THEM.** The
 * loopback provider means nothing would be sent anywhere, but "no operator credential is used" is a
 * stronger claim when the child never held one. The planted key is added back afterwards, and it is
 * not a credential: no service would accept it.
 */
const CREDENTIAL_SHAPED = /(API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|_AUTH)/i;
function environmentWithoutCredentials() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !CREDENTIAL_SHAPED.test(name)));
}

/**
 * The probe extension.
 *
 * ⚠️ **IT REGISTERS A PROVIDER AND READS THE REGISTRY, AND REGISTERS NO TOOL.** A probe that added a
 * tool would change the very set it exists to measure. The provider it registers is the loopback one,
 * so a session can resolve a model without an operator's credential or anyone's endpoint.
 */
const PROBE_SOURCE = (port) => `
import { writeFileSync } from "node:fs";

export default function (pi) {
  pi.registerProvider("kiln-loopback", {
    baseUrl: "http://127.0.0.1:${port}/v1",
    apiKey: "$KILN_LOOPBACK_KEY",
    api: "openai-completions",
    models: [
      {
        id: "loopback-model",
        name: "Loopback",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 1024,
      },
    ],
  });

  // ⚠️ THE SESSION'S OWN REGISTRY, READ ONCE THE SESSION EXISTS. Only names are written out: this
  // file is what the test keeps, and a tool's description or source path would put this machine in it.
  pi.on("session_start", () => {
    writeFileSync(
      process.env.KILN_PROBE_OUT,
      JSON.stringify({ active: pi.getActiveTools(), all: pi.getAllTools().map((t) => t.name) })
    );
  });
}
`;

/** A server on the loopback interface that answers nothing and counts what reaches it. */
async function loopback() {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.statusCode = 500;
    res.end("this test makes no model request");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { port: server.address().port, requests, close: () => new Promise((done) => server.close(done)) };
}

/**
 * One real session, measured.
 *
 * @param {{allowlist: boolean, trusted?: boolean}} options  whether the production allowlist is
 *   applied — without it the run is Pi's own default, which is what makes the measurement's
 *   sensitivity checkable — and whether the project is trusted, which decides whether Pi loads its
 *   package at all.
 */
async function measure({ allowlist, trusted = true }) {
  const base = reapLater(mkdtempSync(join(tmpdir(), "kiln-session-")));
  const project = join(base, "project");
  const agentDir = join(base, "agent");
  const sessions = join(base, "sessions");
  const probe = join(base, "probe", "probe.js");
  const out = join(base, "active-tools.json");

  const server = await loopback();
  let child = null;

  try {
    mkdirSync(join(project, ".pi"), { recursive: true });
    mkdirSync(join(project, ".planning"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(dirname(probe), { recursive: true });

    // ⚠️ ONLY THE PACKAGE IS COPIED, and the project names it the way a real project would.
    cpSync(packageRootFor(ROOT), join(project, ".planning", "pi-package"), { recursive: true });
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ packages: [PORTABLE_PACKAGE_ENTRY] }, null, 2));
    writeFileSync(probe, PROBE_SOURCE(server.port));

    // ⚠️ TRUST IS RECORDED IN PI'S OWN STORE, in a temporary agent directory. The operator's real
    // store is neither read nor written: `PI_CODING_AGENT_DIR` points the child at this one.
    new sdk.ProjectTrustStore(agentDir).set(project, trusted);

    const pinned = resolvePinnedAgent(ROOT);
    const agent = allowlist ? withToolAllowlist(pinned, await piToolAllowlist(ROOT)) : pinned;
    const args = [
      ...agent.args,
      // What the supervisor adds in production.
      "--session-dir",
      sessions,
      // What this measurement adds, and nothing else: a reader and a provider it can reach.
      "-e",
      probe,
      "--provider",
      "kiln-loopback",
      "--model",
      "loopback-model",
      "--mode",
      "rpc",
      "--offline",
    ];

    child = spawn(agent.command, args, {
      cwd: project,
      env: {
        ...environmentWithoutCredentials(),
        PI_CODING_AGENT_DIR: agentDir,
        KILN_PROBE_OUT: out,
        KILN_LOOPBACK_KEY: PLANTED_KEY,
        PI_OFFLINE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      // ⚠️ CLOSED ON THE ANSWER, NOT ON A TIMER. Ending stdin is how this session is asked to finish,
      // and doing it when the session has actually answered keeps the run as short as it is honest.
      if (stdout.includes('"command":"get_state"')) child.stdin.end();
    });
    child.stderr.on("data", (d) => (stderr += d));

    child.stdin.write(`${JSON.stringify({ id: "1", type: "get_state" })}\n`);

    const exit = await new Promise((done) => {
      const timer = setTimeout(() => {
        child.kill();
        done({ code: null, signal: "timeout" });
      }, 60000);
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        done({ code, signal });
      });
    });
    child = null;

    assert.ok(existsSync(out), `the probe never reported: exit ${JSON.stringify(exit)}\n${stdout}\n${stderr}`);
    const measured = JSON.parse(readFileSync(out, "utf-8"));

    return {
      ...measured,
      exit,
      // ⚠️ THE ANSWER ITSELF IS NOT RETAINED: it carries this machine's session path. What is kept is
      // whether the session answered at all.
      answered: /"command":"get_state","success":true/.test(stdout),
      sessionDir: { exists: existsSync(sessions), entries: existsSync(sessions) ? readdirSync(sessions).length : 0 },
      providerRequests: server.requests.length,
      // ⚠️ A SIGNAL, NOT THE TEXT. Whatever a failing child writes on stderr names this machine, and
      // this value is retained; the text is used only in the diagnostic below, which exists only on a
      // failure somebody is already reading.
      stderrSignal: /error|cannot|failed|refus/i.test(stderr),
      credentialsInEnvironment: Object.keys(environmentWithoutCredentials()).filter((n) => CREDENTIAL_SHAPED.test(n)).length,
    };
  } finally {
    // ⚠️ EVERY EXIT PATH. A child still holding the temporary tree stops the tree being removable,
    // and a listening server outlives the test that opened it.
    if (child) child.kill();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
}

test("⚠️ ACC-0064 a real session offers exactly the twenty-two declared Kiln tools", async () => {
  const declared = await piToolAllowlist(ROOT);
  const measured = await measure({ allowlist: true });

  assert.deepEqual(measured.exit, { code: 0, signal: null }, "the session must finish normally");
  assert.equal(measured.answered, true, "and it must have answered while it was running");
  assert.equal(measured.stderrSignal, false, "the run reported a problem on stderr");
  assert.equal(measured.credentialsInEnvironment, 0, "the child was given a credential-shaped variable");

  // ⚠️ THE SESSION'S REGISTRY AGAINST THE PACKAGE'S DECLARATION, which are two different sources.
  assert.deepEqual([...measured.active].sort(), [...declared], "the active set is exactly what the package declares");
  assert.equal(measured.active.length, 22);
  assert.deepEqual([...measured.all].sort(), [...declared], "and the session holds no other tool at all");

  for (const builtin of pinnedBuiltinToolNames()) {
    assert.equal(measured.active.includes(builtin), false, `${builtin} is active in a real session`);
    assert.equal(measured.all.includes(builtin), false, `${builtin} is configured in a real session`);
  }
});

test("⚠️ ACC-0064 the same probe, without the allowlist, measures Pi's own defaults", async () => {
  const measured = await measure({ allowlist: false });

  assert.deepEqual(measured.exit, { code: 0, signal: null });

  // ⚠️ **THIS IS WHAT MAKES THE FIRST TEST MEAN SOMETHING.** The reading is shown to be capable of
  // seeing the very tools the allowlisted run reports as absent, so their absence there is Pi
  // applying the allowlist rather than the probe being blind.
  for (const builtin of ["read", "bash", "edit", "write"])
    assert.equal(measured.active.includes(builtin), true, `the control did not see Pi's default ${builtin}`);

  // And the Kiln tools are there too: without an allowlist an extension's tools are active as well,
  // which is precisely the state the launch flag exists to narrow.
  assert.ok(measured.active.includes("kiln_lint"));
  assert.ok(measured.active.length > 22, `the control set should be larger: ${measured.active.length}`);
});

test("⚠️ ACC-0064 without trust the package is not there to measure, and the session still runs", async () => {
  // ⚠️ **THIS IS WHAT MAKES "A TRUSTED SESSION" MORE THAN A LINE IN THE SETUP.** Recording trust is
  // one call, and a call that changed nothing would leave every reading above meaning only that the
  // package happens to load. Refused, the Kiln tools are gone.
  const measured = await measure({ allowlist: false, trusted: false });

  assert.deepEqual(measured.exit, { code: 0, signal: null }, "the session must still finish normally");
  assert.deepEqual(
    measured.all.filter((name) => name.startsWith("kiln_")),
    [],
    "an untrusted project's package must not reach the session"
  );

  // ⚠️ AND THE SESSION IS STILL THERE: Pi's own tools are active, so the empty Kiln set is a refusal
  // to load a project's package rather than a run that never got as far as having a registry.
  for (const builtin of ["read", "bash", "edit", "write"])
    assert.equal(measured.active.includes(builtin), true, `the untrusted control lost Pi's own ${builtin}`);
});

test("⚠️ ACC-0064 the request counter would notice a request, so counting none means none", async () => {
  // ⚠️ **AN ABSENCE PROVES NOTHING UNTIL THE INSTRUMENT IS SHOWN TO WORK.** "Zero requests reached
  // the provider" and "the counter never counts" are the same reading, and only this tells them apart.
  const server = await loopback();
  try {
    const answer = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, { method: "POST", body: "{}" });
    await answer.text();
    assert.equal(server.requests.length, 1, "the counter missed a request made directly to it");
    assert.equal(server.requests[0], "/v1/chat/completions", "and it recorded what was asked for");
  } finally {
    await server.close();
  }
});

test("⚠️ ACC-0064 the measurement reaches no provider, and what it keeps names no credential, machine or operator", async () => {
  const measured = await measure({ allowlist: true });

  // ⚠️ OBSERVED, NOT ASSUMED. The provider is a server this test owns; it counted nothing.
  assert.equal(measured.providerRequests, 0, "a model request was made");
  // ⚠️ THE DIRECTORY KILN NAMED IS THE ONE PI TOOK, and it is empty: a session that exchanged no
  // message has no transcript to write. What matters is that nothing was written anywhere else.
  assert.equal(measured.sessionDir.exists, true, "Pi did not use the session directory it was given");
  assert.equal(measured.sessionDir.entries, 0, "a session with no messages should have written no transcript");

  // ⚠️ WHAT IS RETAINED IS THE READING, and the reading is names.
  const retained = JSON.stringify({ active: measured.active, all: measured.all });
  assert.equal(retained.includes(PLANTED_KEY), false, "the planted key reached the retained reading");
  assert.equal(/[A-Za-z]:(\\\\|\/)/.test(retained), false, "a drive-lettered path reached the retained reading");
  assert.equal(/\/(home|Users)\//.test(retained), false, "a home directory reached the retained reading");
  for (const identity of [homedir(), userInfo().username, tmpdir()])
    assert.equal(retained.includes(identity), false, `the retained reading names ${identity}`);
  for (const name of measured.all) assert.match(name, /^kiln_[a-z_]+$/, `${name} is not a bare tool name`);
});
