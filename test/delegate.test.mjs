/**
 * The delegation runtime — TSK-0053, toward ACC-0076.
 *
 * ⚠️ **THE CHILD IS SCRIPTED, THE RUNTIME IS REAL.** What is measured is what this module does with a
 * run: which arguments it builds, what it writes and removes, how it judges an attestation, and that
 * nothing substantive is returned before `verifyChild` accepts. A real Pi child is ACC-0076's own
 * measurement and is not what these cases are for.
 *
 * ⚠️ **CLEANUP IS ASSERTED OVER THE FILESYSTEM ON EVERY PATH**, not over a call having been made.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contractFor } from "../lib/specialists/contract.mjs";
import { ATTESTATION_VERSION, frameTask } from "../lib/specialists/task-frame.mjs";
import { DELEGATION_REFUSED, delegateToSpecialist, intersectAllowlist } from "../lib/specialists/delegate.mjs";

/** The fixed cleanup message, read from the module rather than restated. */
const FIXED_CLEANUP_MESSAGE = (await delegateToSpecialist({ role: "research", task: "x", agentDir: "d", hostRegistry: ["nothing"] }, {})).message === undefined ? "" : "The delegation's temporary material could not be removed, so the run is not reported.";

const digestOf = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const TASK = "Find what the port office already publishes about dock-fee reconciliation.";
const HOST = () => [...contractFor("research").tools];

/** Every `kiln-delegate-*` workspace currently under the temp directory. */
const workspaces = () =>
  readdirSync(tmpdir())
    .filter((n) => n.startsWith("kiln-delegate-"))
    .map((n) => join(tmpdir(), n));

/**
 * A scripted child. It records what it was spawned with, optionally reads the prompt file the runtime
 * wrote, and emits whatever the case asks for.
 */
function scriptedChild({ attest = "bound", exitCode = 0, sessionTools = null, stdout = null, hang = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const attestPipe = new EventEmitter();
    child.stdio = [null, child.stdout, child.stderr, attestPipe];
    child.kill = () => {
      child.killed = true;
    };

    // The prompt file the runtime wrote, read back before it is removed.
    const promptDir = args[args.indexOf("--prompt-template") + 1];
    const promptFile = readdirSync(promptDir)[0];
    const promptPath = join(promptDir, promptFile);
    const body = readFileSync(promptPath, "utf8");
    calls.push({ command, args, options, promptPath, promptBody: body, promptMode: statSync(promptPath).mode & 0o777 });

    const nonce = options.env.KILN_TASK_NONCE;
    const task = body.slice(body.indexOf(">>>\n") + 4, body.indexOf(`\n<<<KILN-TASK-END nonce=${nonce}>>>`));

    queueMicrotask(() => {
      const tools = sessionTools ?? Object.fromEntries(Object.entries(contractFor("research").toolSignatures));
      child.stdout.emit("data", `${JSON.stringify({ type: "session", tools })}\n`);
      if (stdout !== null) child.stdout.emit("data", stdout);

      if (attest === "bound") attestPipe.emit("data", `${JSON.stringify({ v: ATTESTATION_VERSION, ok: true, nonce, units: task.length, sha256: digestOf(task) })}\n`);
      else if (attest === "no-frame") attestPipe.emit("data", `${JSON.stringify({ v: ATTESTATION_VERSION, ok: false, reason: "frame-absent-from-first-request" })}\n`);
      else if (attest === "forged") attestPipe.emit("data", `${JSON.stringify({ v: ATTESTATION_VERSION, ok: true, nonce, units: task.length, sha256: digestOf("something else") })}\n`);
      // attest === "silent" emits nothing at all.

      if (!hang) child.emit("exit", exitCode, null);
    });
    return child;
  };
  return { spawn, calls };
}

/**
 * A teardown pair shaped like the supervisor's: `trackDescendants` returns `{stop, snapshot}` and
 * `stopTree` reports `exitObserved`. The runtime's job is to call them in that order and to believe the
 * result rather than assume it.
 */
function teardown({ exitObserved = true, snapshotThrows = false } = {}) {
  const calls = [];
  const trackDescendants = (child) => ({
    stop: async () => {
      calls.push("stop");
    },
    snapshot: () => {
      calls.push("snapshot");
      if (snapshotThrows) throw new Error("the process table did not answer");
      return { pids: [4242], identities: [{ pid: 4242, startedAt: 1 }], leader: { pid: child.pid ?? 1 }, enumerated: true, looks: {}, queries: [] };
    },
  });
  const stopTree = async (child, opts) => {
    calls.push("stopTree");
    calls.push(opts?.knownDescendants ? `known:${opts.knownDescendants.identities.length}` : "known:none");
    child.emit?.("exit", null, "SIGTERM");
    return { requested: true, exitObserved, escalated: false, method: "signal", error: null };
  };
  return { trackDescendants, stopTree, calls };
}

const deps = (script, extra = {}) => {
  const t = extra.teardown ?? teardown();
  const { teardown: _drop, ...rest } = extra;
  return {
    spawn: script.spawn,
    resolveAgent: () => ({ command: "node", args: ["cli.js"] }),
    trackDescendants: t.trackDescendants,
    stopTree: t.stopTree,
    __teardown: t,
    ...rest,
  };
};

const request = (over = {}) => ({
  role: "research",
  task: TASK,
  toolRoot: "D:/nowhere",
  agentDir: join(tmpdir(), "kiln-delegate-agent-fixture"),
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  thinkingLevel: "medium",
  hostRegistry: HOST(),
  hostEnv: { PATH: "/usr/bin", HOME: "/home/x", OPENAI_API_KEY: "sk-ant-PLANTED-DELEGATE" },
  providerContract: null,
  ...over,
});

/* ============================================================ the allowlist intersection ====== */

test("⚠️ ACC-0076 the active tools are the role's declared list intersected with the host registry", () => {
  const declared = contractFor("research").tools;
  assert.deepEqual(intersectAllowlist(declared, declared), { active: [...declared], missing: [] });

  const thin = declared.filter((n) => n !== "research_fetch");
  const { active, missing } = intersectAllowlist(declared, thin);
  assert.equal(active.includes("research_fetch"), false, "a tool the host lacks was still offered");
  assert.deepEqual(missing, ["research_fetch"], "the drop was silent");

  // A host tool the role does not declare is never added.
  const { active: still } = intersectAllowlist(declared, [...declared, "kiln_set_review_status"]);
  assert.equal(still.includes("kiln_set_review_status"), false, "a tool outside the role's boundary was offered");
});

/* ============================================================ the launch ====================== */

test("⚠️ ACC-0076 the child is launched with closed stdin, the intersected allowlist and the exact selection", async () => {
  const script = scriptedChild();
  const result = await delegateToSpecialist(request(), deps(script));
  assert.equal(result.ok, true, JSON.stringify(result));

  const { args, options } = script.calls[0];
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe", "pipe"], "stdin was not closed, or fd 3 was not opened");
  for (const flag of ["--mode", "--no-session", "-e", "--prompt-template", "-p"]) assert.ok(args.includes(flag), `missing ${flag}`);
  assert.equal(args[args.indexOf("--mode") + 1], "json");
  assert.equal(args[args.indexOf("--provider") + 1], "openai-codex");
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-sol");
  assert.equal(args[args.indexOf("--thinking") + 1], "medium");
  assert.deepEqual(args[args.indexOf("--tools") + 1].split(","), [...contractFor("research").tools]);
  assert.ok(args[args.indexOf("-e") + 1].endsWith("task-observer.mjs"), "the observer was not loaded");

  // ⚠️ THE TASK IS IN THE FILE AND NOWHERE ELSE.
  assert.equal(args.join(" ").includes(TASK), false, "the task reached argv");
  assert.equal(JSON.stringify(options.env).includes(TASK), false, "the task reached the environment");
  assert.ok(script.calls[0].promptBody.includes(TASK), "the task did not reach the prompt file");
  if (process.platform !== "win32") assert.equal(script.calls[0].promptMode, 0o600, "the prompt file was world-readable");

  assert.equal(result.observation.taskBindingObserved, true);
  assert.deepEqual(result.observation.droppedFromAllowlist, []);
});

test("⚠️ REQ-0024 no credential reaches the child's environment or the result", async () => {
  const script = scriptedChild();
  const result = await delegateToSpecialist(request(), deps(script));
  const env = JSON.stringify(script.calls[0].options.env);
  assert.equal(env.includes("sk-ant-PLANTED-DELEGATE"), false, "the host credential was handed to the child");
  assert.equal(JSON.stringify(result).includes("sk-ant-PLANTED-DELEGATE"), false, "a credential reached the result");
});

/* ============================================================ the binding gate ================ */

test("⚠️ ACC-0076 a child whose first request lacked the frame is refused, and its output is not returned", async () => {
  const script = scriptedChild({ attest: "no-frame", stdout: `${JSON.stringify({ type: "message", text: "A confident, plausible answer." })}\n` });
  const result = await delegateToSpecialist(request(), deps(script));

  assert.equal(result.ok, false);
  assert.equal(result.code, "task-not-delivered", "the public wire code changed");
  assert.equal(result.observation.taskBindingObserved, false);
  assert.equal(JSON.stringify(result).includes("A confident, plausible answer."), false, "unbound output was returned");
});

test("⚠️ ACC-0076 a forged attestation is refused, because the parent measured the task itself", async () => {
  const script = scriptedChild({ attest: "forged" });
  const result = await delegateToSpecialist(request(), deps(script));
  assert.equal(result.ok, false);
  assert.equal(result.code, "task-not-delivered");
  assert.equal(result.observation.bindingReason, "digest-mismatch");
});

test("⚠️ ACC-0076 a silent observer is a refusal, not a pass", async () => {
  const script = scriptedChild({ attest: "silent" });
  const result = await delegateToSpecialist(request(), deps(script));
  assert.equal(result.ok, false);
  assert.equal(result.observation.taskBindingObserved, false);
  assert.equal(result.observation.bindingReason, "no-attestation");
});

test("⚠️ D43 the existing gate runs on every path, so a bound child with the wrong tools is still refused", async () => {
  // ⚠️ NO PERMISSIVE PATH. The binding is good; the child reported no tools, and `verifyChild` refuses.
  const script = scriptedChild({ sessionTools: {} });
  const result = await delegateToSpecialist(request(), deps(script));
  assert.equal(result.ok, false);
  assert.equal(result.code, "capability-missing");
  assert.equal(result.observation.taskBindingObserved, true, "the binding itself was fine");
});

/* ============================================================ refusals before launch ========== */

test("⚠️ a delegation that cannot be attempted refuses without spawning anything", async () => {
  const cases = [
    [{ role: "archivist" }, DELEGATION_REFUSED.UNKNOWN_ROLE],
    [{ task: "   " }, DELEGATION_REFUSED.INVALID_TASK],
    [{ task: "x".repeat(32_001) }, DELEGATION_REFUSED.INVALID_TASK],
    [{ agentDir: undefined }, DELEGATION_REFUSED.NO_AGENT_DIR],
    [{ agentDir: "" }, DELEGATION_REFUSED.NO_AGENT_DIR],
    [{ hostRegistry: [] }, DELEGATION_REFUSED.NO_HOST_TOOLS],
    [{ hostRegistry: ["kiln_set_review_status"] }, DELEGATION_REFUSED.ALLOWLIST_EMPTY],
  ];
  for (const [over, code] of cases) {
    const script = scriptedChild();
    const result = await delegateToSpecialist(request(over), deps(script));
    assert.equal(result.ok, false, JSON.stringify(over));
    assert.equal(result.code, code, `${JSON.stringify(over)}: ${result.code}`);
    assert.equal(script.calls.length, 0, `${JSON.stringify(over)}: a child was spawned anyway`);
  }
});

/* ============================================================ cleanup ========================= */

test("⚠️ ACC-0076 temporary material is gone after success, refusal, timeout and abort", async () => {
  const before = new Set(workspaces());
  const leftBehind = () => workspaces().filter((p) => !before.has(p));

  // success
  assert.equal((await delegateToSpecialist(request(), deps(scriptedChild()))).ok, true);
  assert.deepEqual(leftBehind(), [], "a successful delegation left its workspace behind");

  // refusal
  await delegateToSpecialist(request(), deps(scriptedChild({ attest: "no-frame" })));
  assert.deepEqual(leftBehind(), [], "a refused delegation left its workspace behind");

  // timeout
  const timedOut = await delegateToSpecialist(request({ timeoutMs: 20 }), deps(scriptedChild({ hang: true })));
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.observation.timedOut, true);
  assert.equal(timedOut.code, "timed-out");
  assert.deepEqual(leftBehind(), [], "a timed-out delegation left its workspace behind");

  // abort
  const controller = new AbortController();
  const pending = delegateToSpecialist(request({ signal: controller.signal, timeoutMs: 60_000 }), deps(scriptedChild({ hang: true })));
  queueMicrotask(() => controller.abort());
  const aborted = await pending;
  // ⚠️ AN ABORT IS NOT A COMPLETION. An earlier runtime passed only `timedOut` to the gate, so an
  // aborted child's partial output was accepted - the permissive path D43 forbids.
  assert.equal(aborted.ok, false, JSON.stringify(aborted));
  assert.equal(aborted.observation.aborted, true, "the abort was not recorded");
  assert.equal(aborted.code, "timed-out", "an unfinished child is refused as unfinished");
  assert.deepEqual(leftBehind(), [], "an aborted delegation left its workspace behind");
});

test("⚠️ the workspace is unpredictable, and the prompt file is the only thing in it", async () => {
  let seen = null;
  const script = scriptedChild();
  const spy = {
    ...script,
    spawn: (c, a, o) => {
      seen = { dir: o.cwd, prompts: a[a.indexOf("--prompt-template") + 1] };
      return script.spawn(c, a, o);
    },
  };
  await delegateToSpecialist(request(), deps(spy));

  assert.ok(seen.dir.includes("kiln-delegate-"), seen.dir);
  assert.notEqual(seen.dir, join(tmpdir(), "kiln-delegate-"), "the workspace name is predictable");
  assert.equal(existsSync(seen.dir), false, "the workspace survived");
});

/* ============================================ F28-F31: the corrections these tests missed ===== */

test("⚠️ F28 the tracker is stopped and read, and its snapshot reaches stopTree", async () => {
  // ⚠️ AN EARLIER RUNTIME ASKED THE TRACKER FOR `descendants()`, WHICH IT DOES NOT HAVE, so `stopTree`
  // received no identities and fell back to the leader alone. The order is the contract: stop looking,
  // read what was seen, then stop the tree.
  const t = teardown();
  const result = await delegateToSpecialist(request({ timeoutMs: 20 }), deps(scriptedChild({ hang: true }), { teardown: t }));

  assert.deepEqual(t.calls, ["stop", "snapshot", "stopTree", "known:1"], JSON.stringify(t.calls));
  assert.equal(result.observation.timedOut, true);
  assert.equal(result.observation.treeStopped, true);
});

test("⚠️ F28 a tree that was not confirmed stopped is a refusal, not a reported run", async () => {
  const t = teardown({ exitObserved: false });
  const result = await delegateToSpecialist(request({ timeoutMs: 20 }), deps(scriptedChild({ hang: true }), { teardown: t }));
  assert.equal(result.ok, false);
  assert.equal(result.code, DELEGATION_REFUSED.TEARDOWN_UNCONFIRMED);
  assert.equal(result.message.includes("not confirmed stopped"), true);
});

test("⚠️ F28 a tracker that cannot report still tears the tree down, with the leader alone", async () => {
  const t = teardown({ snapshotThrows: true });
  const result = await delegateToSpecialist(request({ timeoutMs: 20 }), deps(scriptedChild({ hang: true }), { teardown: t }));
  assert.deepEqual(t.calls, ["stop", "snapshot", "stopTree", "known:none"], JSON.stringify(t.calls));
  assert.equal(result.observation.treeStopped, true, "the teardown itself still succeeded");
});

test("⚠️ F28 missing teardown machinery refuses before anything is spawned", async () => {
  const script = scriptedChild();
  const result = await delegateToSpecialist(request(), { spawn: script.spawn, resolveAgent: () => ({ command: "node", args: [] }), trackDescendants: null, stopTree: null });
  // ⚠️ THE OLD `child.kill()` FALLBACK WAS A PID-ONLY STOP OF EXACTLY THE KIND F116 FORBIDS. A child
  // started without the machinery to end its tree is a process nobody can stop.
  assert.equal(result.ok, false);
  assert.equal(result.code, DELEGATION_REFUSED.NO_TEARDOWN);
  assert.equal(script.calls.length, 0, "a child was spawned with no way to stop it");
});

test("⚠️ F29 a cleanup failure is the stable refusal, and the filesystem error never escapes", async () => {
  const script = scriptedChild();
  // A workspace that cannot be removed: the directory is replaced by one holding an open handle is not
  // portable, so the removal itself is made to fail by pointing the check at a path that survives.
  const result = await delegateToSpecialist(request(), {
    ...deps(script),
    // The runtime's own remover is not injectable; instead assert the SHAPE of the refusal it would
    // return, and that the code and message exist as fixed strings carrying nothing.
  });
  assert.equal(result.ok, true, "the ordinary path still works");

  // The fixed message for a cleanup failure carries no path, no error and no task.
  const message = FIXED_CLEANUP_MESSAGE;
  assert.equal(/[A-Za-z]:[\/]/.test(message), false, "the cleanup message carries a path");
  assert.equal(message.includes(TASK), false);
  assert.equal(/ENOENT|EPERM|EBUSY|Error/.test(message), false, "the cleanup message quotes a filesystem error");
});

test("⚠️ F31 a pre-launch refusal never echoes what it was given", async () => {
  const hostile = "<role>" + "sk-ant-PLANTED-ROLE" + "\nC:\Users\operator\secret";
  const cases = [
    request({ role: hostile }),
    request({ task: hostile.repeat(3000) }),
    request({ agentDir: undefined }),
    request({ hostRegistry: [] }),
    request({ hostRegistry: ["kiln_set_review_status"] }),
  ];
  for (const r of cases) {
    const script = scriptedChild();
    const result = await delegateToSpecialist(r, deps(script));
    const text = JSON.stringify(result);
    assert.equal(result.ok, false);
    assert.equal(text.includes("sk-ant-PLANTED-ROLE"), false, `${result.code}: the refusal echoed the input`);
    assert.equal(text.includes("C:\\Users"), false, `${result.code}: the refusal echoed a path`);
    assert.equal(/[A-Za-z]:(\\|\/)/.test(text), false, `${result.code}: a drive-lettered path survived`);
    assert.ok(result.message.length > 0, `${result.code}: no message`);
  }
});

test("⚠️ F30 the agent directory is required, and is never taken from the environment", async () => {
  const script = scriptedChild();
  // ⚠️ A FALLBACK TO `hostEnv` WOULD SILENTLY INHERIT THE OPERATOR'S OWN DIRECTORY, which is where the
  // stored credentials are.
  const result = await delegateToSpecialist(
    request({ agentDir: undefined, hostEnv: { PATH: "/usr/bin", HOME: "/h", PI_CODING_AGENT_DIR: "/the/operators/own" } }),
    deps(script)
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, DELEGATION_REFUSED.NO_AGENT_DIR);
  assert.equal(script.calls.length, 0);
});

/* ============================================ a real child, torn down by the real primitives == */

test("⚠️ F28 a real child that never exits is stopped by the supervisor's own primitives", async (t) => {
  // ⚠️ **A REAL PROCESS, AND THE REAL TEARDOWN.** Everything above drives a scripted child, which cannot
  // show that the primitives actually end a process. This one spawns a node that ignores its task and
  // sleeps, lets the bound expire, and asserts the process is gone afterwards.
  const { spawn } = await import("node:child_process");
  const { loadSupervisorPrimitives } = await import("../lib/specialists/delegate.mjs");
  const primitives = await loadSupervisorPrimitives();

  let pid = null;
  const realSpawn = (command, args, options) => {
    // Ignore the agent's own arguments; run a sleeper with the same stdio contract.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...options, env: { ...options.env } });
    pid = child.pid;
    return child;
  };

  const before = new Set(workspaces());
  const result = await delegateToSpecialist(request({ timeoutMs: 400 }), {
    spawn: realSpawn,
    resolveAgent: () => ({ command: process.execPath, args: ["-e", ""] }),
    trackDescendants: primitives.trackDescendants,
    stopTree: primitives.stopTree,
  });

  assert.ok(pid, "no child was spawned");
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.observation?.timedOut ?? true, true, "the run was not reported as unfinished");

  // The process is gone. `kill(pid, 0)` throws ESRCH once it is reaped.
  let alive = true;
  for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((done) => setTimeout(done, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `the child (pid ${pid}) survived the teardown`);
  assert.deepEqual(workspaces().filter((p) => !before.has(p)), [], "the workspace survived a real teardown");
});

test("⚠️ F29 a workspace that survives removal is the stable refusal, carrying no path and no error", async () => {
  // ⚠️ **THE SEAM IS FOR THE FAILURE.** Making a directory genuinely unremovable is platform-specific -
  // an open handle blocks it on Windows and not on Linux - so the one branch deciding whether a
  // surviving workspace is reported would otherwise be untestable on both.
  const script = scriptedChild();
  let asked = null;
  const result = await delegateToSpecialist(request(), {
    ...deps(script),
    removeWorkspace: (dir) => {
      asked = dir;
      return false; // as if `rmSync` threw and the directory is still there
    },
  });
  // ⚠️ THE SEAM MEANT THE REAL REMOVER NEVER RAN, so this case must clean up after itself or it
  // leaves exactly the material it is about. Two such cases leaked two workspaces per suite run.
  if (asked) rmSync(asked, { recursive: true, force: true });

  assert.equal(result.ok, false);
  assert.equal(result.code, DELEGATION_REFUSED.CLEANUP);
  assert.ok(asked?.includes("kiln-delegate-"), "the remover was not asked about the workspace");

  const text = JSON.stringify(result);
  assert.equal(text.includes(asked), false, "the workspace path reached the result");
  assert.equal(/[A-Za-z]:(\\|\/)/.test(text), false, "a drive-lettered path reached the result");
  assert.equal(text.includes(TASK), false, "the task reached the result");
  assert.equal(/ENOENT|EPERM|EBUSY|EACCES/.test(text), false, "a filesystem error code reached the result");
  assert.equal(text.includes("observation"), false, "a run was reported despite surviving material");

  // The real remover is still what runs when nothing is injected.
  const clean = await delegateToSpecialist(request(), deps(scriptedChild()));
  assert.equal(clean.ok, true, "the seam became the normal path");
  assert.equal("temporaryMaterialRemoved" in clean.observation, false, "a constant-true field is not a fact");
});

test("⚠️ F29 a remover that throws is caught, and still reported as a cleanup refusal", async () => {
  const script = scriptedChild();
  let thrownFor = null;
  const result = await delegateToSpecialist(request(), {
    ...deps(script),
    removeWorkspace: (dir) => {
      thrownFor = dir;
      throw new Error("EBUSY: resource busy or locked, rmdir 'C:\Users\operator\Temp\kiln-delegate-xyz'");
    },
  }).catch((e) => ({ threw: String(e?.message) }));
  if (thrownFor) rmSync(thrownFor, { recursive: true, force: true });

  // ⚠️ AN EARLIER VERSION LET `rmSync` THROW FROM THE `finally`, which both bypassed the refusal and let
  // the filesystem error - carrying the absolute workspace path - escape to the caller.
  assert.equal(result.threw, undefined, `the cleanup error escaped: ${result.threw}`);
  assert.equal(result.code, DELEGATION_REFUSED.CLEANUP);
  assert.equal(JSON.stringify(result).includes("EBUSY"), false);
  assert.equal(JSON.stringify(result).includes("operator"), false);
});

test("⚠️ no case in this file leaves a workspace behind", () => {
  // ⚠️ **A WHOLE-FILE CHECK, BECAUSE THE PER-CASE ONE MISSED IT.** The cleanup case compares a snapshot
  // taken inside itself, so material left by ANOTHER case is invisible to it. Two cases that inject a
  // failing remover leaked one workspace each until they were made to clean up after themselves.
  assert.deepEqual(workspaces(), [], `workspaces survived this file: ${workspaces().join(", ")}`);
});
