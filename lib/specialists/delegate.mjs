/**
 * The delegation runtime: run a specialist as an isolated Pi child — TSK-0053, toward ACC-0076.
 *
 * ⚠️ **THE CHILD IS TOLD ONE TASK AND NOTHING ELSE.** It receives a task-scoped prompt file, never the
 * conversation, and the file is the only place the task exists: not argv, not stdin, not an environment
 * variable. stdin is closed, so a non-interactive child cannot wait forever for input it will never get.
 *
 * ⚠️ **THE BINDING IS OBSERVED, NOT ASSERTED (D42, D45).** This module cannot set
 * `taskBindingObserved` from the fact that it wrote the prompt file - that proves preparation, not
 * consumption. An observer extension loaded into the child attests what the child's FIRST outbound
 * provider request actually carried, over a dedicated pipe, and this module judges that attestation
 * against the nonce, length and digest it generated.
 *
 * ⚠️ **NOTHING SUBSTANTIVE IS READ BEFORE `verifyChild` ACCEPTS (D43).** There is no permissive path.
 * Output is parsed only to be handed to the gate; a refusal returns the structured refusal and the
 * output is dropped. Expanding the refusal matrix - malformed events, provider mismatch, out-of-role
 * writes - is TSK-0054's.
 *
 * ⚠️ **TEMPORARY MATERIAL IS DELETED ON EVERY EXIT PATH.** Success, refusal, timeout and abort all pass
 * through the same `finally`, and the removal is verified rather than attempted.
 *
 * ⚠️ **ONE TREE, WRAPPING THE SUPERVISOR'S PRIMITIVES (D44).** `trackDescendants` and `stopTree` already
 * carry F116's rule that a pid alone is not an identity, and a second PID-only termination here would be
 * a weaker copy of machinery that has already been measured.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AGENT_DIR_ENV, CHILD_REFUSED, ChildEnvRefusal, ROLES, childEnv, contractFor, verifyChild } from "./contract.mjs";
import { BINDING_REJECTED, frameTask, judgeAttestation } from "./task-frame.mjs";
import { FD_ENV, NONCE_ENV } from "./task-observer.mjs";

let supervisorModule = null;

/**
 * The production teardown (D44), loaded on demand.
 *
 * ⚠️ **THE SUPERVISOR'S PRIMITIVES, NOT A SECOND IMPLEMENTATION.** `trackDescendants` and `stopTree`
 * already carry F116's rule that a pid alone is not an identity, the bounded identity reads and the
 * abandoned-wait accounting. A smaller teardown here would be a weaker copy of machinery that has been
 * measured, which is why the only local addition is the order the three calls happen in.
 *
 * ⚠️ ON DEMAND, so a caller that injects its own pair never pays for loading the supervisor, and a
 * host where the supervisor cannot load refuses before a child exists rather than after.
 */
export async function loadSupervisorPrimitives() {
  if (supervisorModule === null) supervisorModule = await import("../supervisor.mjs");
  return supervisorModule;
}

/** Why a delegation could not be attempted at all. Distinct from a child whose ANSWER was refused. */
export const DELEGATION_REFUSED = Object.freeze({
  UNKNOWN_ROLE: "unknown-role",
  INVALID_TASK: "invalid-task",
  NO_AGENT_DIR: "agent-directory-missing",
  NO_TOOLS: "role-derives-no-tools",
  NO_HOST_TOOLS: "host-registry-empty",
  ALLOWLIST_EMPTY: "allowlist-intersection-empty",
  ENVIRONMENT: "child-environment-refused",
  LAUNCH: "child-could-not-start",
  NO_TEARDOWN: "teardown-machinery-missing",
  TEARDOWN_UNCONFIRMED: "child-tree-not-confirmed-stopped",
  CLEANUP: "temporary-material-survived",
});

/**
 * ⚠️ **A PRE-LAUNCH REFUSAL NEVER ECHOES WHAT IT WAS GIVEN (F31).** The role, the task and the
 * registry are the caller's, and a caller may be a model. A message that quoted them back would carry
 * untrusted text into a result, a log and a transcript, for no gain: the CODE says what was wrong, and
 * the caller already knows what it sent.
 */
const FIXED_MESSAGE = Object.freeze({
  "unknown-role": "That is not one of this project's specialist roles.",
  "invalid-task": "A delegation needs one non-empty task within the permitted length.",
  "agent-directory-missing": "A delegation needs an isolated agent directory; without one the child would read the operator's own.",
  "role-derives-no-tools": "That role's contract derives no tools, so a child would inherit the agent's defaults.",
  "host-registry-empty": "The host registry is empty, so no allowlist could be intersected.",
  "allowlist-intersection-empty": "None of that role's tools are registered on this host.",
  "teardown-machinery-missing": "No process-tree teardown is available, so a child could not be stopped once started.",
  "child-could-not-start": "The specialist child could not be started.",
  "child-environment-refused": "The child's environment could not be built.",
  "child-tree-not-confirmed-stopped": "The child's process tree was not confirmed stopped, so the run is not reported.",
  "temporary-material-survived": "The delegation's temporary material could not be removed, so the run is not reported.",
});

export const ATTEST_FD = 3;
const NONCE_BYTES = 16;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TASK_UNITS = 32_000;

const digestOf = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const refusal = (code, detail = {}) => ({ ok: false, code, message: FIXED_MESSAGE[code] ?? "The delegation was refused.", ...detail });

/**
 * The tools a child is actually offered: what its role declares, kept only where the host has it.
 *
 * ⚠️ **AN INTERSECTION, AND IT IS REPORTED BOTH WAYS.** A declared tool the host does not register is
 * DROPPED, which is the quiet narrowing ACC-0076 exists to make visible; `missing` says which, so a
 * caller can tell a deliberate intersection from a broken installation.
 */
export function intersectAllowlist(declared, hostRegistry) {
  const host = new Set(hostRegistry ?? []);
  const active = (declared ?? []).filter((name) => host.has(name));
  const missing = (declared ?? []).filter((name) => !host.has(name));
  return { active, missing };
}

/** The one place a delegation's temporary material lives, so one `finally` can remove all of it. */
function privateWorkspace() {
  // ⚠️ `mkdtemp` RATHER THAN A NAME WE CHOSE. A predictable path is one another process can sit on
  // before the prompt file is written, and the prompt file is the task.
  const dir = mkdtempSync(join(tmpdir(), "kiln-delegate-"));
  const prompts = join(dir, "prompts");
  mkdirSync(prompts, { recursive: true, mode: 0o700 });
  return { dir, prompts };
}

/**
 * Remove a workspace and say whether it is gone. Never throws.
 *
 * ⚠️ **THE FILESYSTEM ERROR IS DROPPED, NOT WRAPPED.** Its message carries the absolute path of the
 * directory the task was written into. What the caller needs is whether the material survived.
 */
function removeWorkspace(dir) {
  // ⚠️ IT MAY THROW, AND THE CALL SITE OWNS THAT. An earlier version caught here as well, which made
  // the outer catch unreachable for the throw and left a branch no test could distinguish - a mutation
  // removing it survived, which is how it was found. One place decides what a failed removal means.
  rmSync(dir, { recursive: true, force: true });
  return !existsSync(dir);
}

/**
 * Write the task where only this user can read it.
 *
 * ⚠️ **THE MODE IS SET AT CREATION, NOT AFTERWARDS.** A file created 0644 and chmodded is readable for
 * the instant between the two calls. On Windows the mode is advisory and the directory is the real
 * boundary, which is why the workspace is created 0700 as well.
 */
function writeTaskPrompt(prompts, name, body) {
  const file = join(prompts, `${name}.md`);
  writeFileSync(file, ["---", `name: ${name}`, "description: One delegated task.", "---", "", body, ""].join("\n"), { mode: 0o600 });
  return file;
}

/**
 * Run one specialist.
 *
 * @param {{role: string, task: string, toolRoot: string, agentDir: string, provider: string, model: string,
 *          thinkingLevel: string, hostRegistry: string[], hostEnv?: object, providerContract?: object|null,
 *          researchEnabled?: boolean, timeoutMs?: number, signal?: AbortSignal}} request
 * @param {{spawn: Function, resolveAgent: Function, trackDescendants?: Function, stopTree?: Function,
 *          now?: () => number}} deps
 */
export async function delegateToSpecialist(request, deps) {
  const {
    role,
    task,
    toolRoot,
    agentDir,
    provider,
    model,
    thinkingLevel,
    hostRegistry,
    hostEnv = process.env,
    providerContract = null,
    researchEnabled = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = request ?? {};

  if (!ROLES.includes(role)) return refusal(DELEGATION_REFUSED.UNKNOWN_ROLE);
  if (typeof task !== "string" || task.trim().length === 0 || task.length > MAX_TASK_UNITS)
    return refusal(DELEGATION_REFUSED.INVALID_TASK, { maxUnits: MAX_TASK_UNITS });

  // ⚠️ **AN ISOLATED AGENT DIRECTORY IS NAMED POSITIVELY, NEVER OMITTED.** `childEnv` refuses without
  // one and its reason is the right one: Windows injects `USERPROFILE` regardless, so a child with no
  // configuration directory resolves the OPERATOR's default and reads the stored credentials there.
  // Whether that directory holds an `auth.json` is the caller's decision, because only the caller knows
  // whether the selected provider authenticates from storage or from the environment.
  // ⚠️ **REQUIRED, WITH NO FALLBACK TO THE ENVIRONMENT (F30).** Reading it from `hostEnv` would mean a
  // delegation silently inherited whatever directory the parent process happened to be using, which is
  // the operator's own on any ordinary run. It is supplied by the wrapper from trusted runtime context
  // and never appears in a model-facing schema.
  if (typeof agentDir !== "string" || agentDir.length === 0) return refusal(DELEGATION_REFUSED.NO_AGENT_DIR);
  const childAgentDir = agentDir;

  const contract = contractFor(role);
  if (contract.tools.length === 0) return refusal(DELEGATION_REFUSED.NO_TOOLS);
  if (!Array.isArray(hostRegistry) || hostRegistry.length === 0) return refusal(DELEGATION_REFUSED.NO_HOST_TOOLS);

  const { active, missing } = intersectAllowlist(contract.tools, hostRegistry);
  // `missing` is Kiln's own declared names, never the caller's input, so reporting it echoes nothing.
  if (active.length === 0) return refusal(DELEGATION_REFUSED.ALLOWLIST_EMPTY, { missing });

  // ⚠️ **NO TEARDOWN, NO SPAWN (F28).** A child started without the machinery to stop its tree is a
  // process nobody can end, and the old `child.kill()` fallback was a PID-only stop of exactly the kind
  // F116 forbids. Refusing before anything runs is the only safe order.
  //
  // ⚠️ ABSENT MEANS PRODUCTION; PRESENT-AND-NOT-A-FUNCTION MEANS NONE. A caller that supplies its own
  // pair gets it; a caller that supplies nothing gets the supervisor's; a caller that says explicitly
  // there is none is refused rather than quietly given the real thing.
  let track = deps?.trackDescendants;
  let stop = deps?.stopTree;
  const supplied = deps !== null && typeof deps === "object" && ("trackDescendants" in deps || "stopTree" in deps);
  if (!supplied) {
    try {
      const primitives = await loadSupervisorPrimitives();
      track = primitives.trackDescendants;
      stop = primitives.stopTree;
    } catch {
      return refusal(DELEGATION_REFUSED.NO_TEARDOWN);
    }
  }
  if (typeof track !== "function" || typeof stop !== "function") return refusal(DELEGATION_REFUSED.NO_TEARDOWN);

  let env;
  try {
    env = childEnv(role, { ...hostEnv, [AGENT_DIR_ENV]: childAgentDir }, { contract: providerContract, researchEnabled });
  } catch (error) {
    if (!(error instanceof ChildEnvRefusal)) throw error;
    // ⚠️ THE REASON, NEVER A VALUE. `childEnv`'s reasons are its own fixed codes naming variables,
    // never their contents and never anything the caller supplied.
    return refusal(DELEGATION_REFUSED.ENVIRONMENT, { reason: error.reason });
  }

  let removed = false;
  const nonce = randomBytes(NONCE_BYTES).toString("hex");
  const framed = frameTask({ nonce, task, digestOf });
  const workspace = privateWorkspace();
  const promptName = `kiln-task-${nonce}`;
  const started = (deps.now ?? (() => Date.now()))();

  let run = null;
  let launchFailed = false;
  try {
    writeTaskPrompt(workspace.prompts, promptName, framed.text);
    run = await runChild({ workspace, promptName, nonce, active, provider, model, thinkingLevel, env, timeoutMs, signal, toolRoot, track, stop }, deps);
  } catch {
    // ⚠️ THE LAUNCH ERROR IS SWALLOWED ENTIRELY. A spawn failure's message carries the command and the
    // working directory, and both are absolute paths. The code says what happened.
    launchFailed = true;
  } finally {
    // ⚠️ EVERY EXIT PATH. Success, refusal, timeout, abort and a failed launch all arrive here.
    //
    // ⚠️ THE SEAM IS FOR THE FAILURE, NOT FOR CALLERS. Making a directory genuinely unremovable is
    // platform-specific - an open handle blocks it on Windows and not on Linux - so the one branch that
    // decides whether a surviving workspace is reported would otherwise be untestable on both.
    try {
      removed = (deps?.removeWorkspace ?? removeWorkspace)(workspace.dir);
    } catch {
      // A remover that throws is a remover that did not remove. Letting it out of the `finally` would
      // replace this refusal with a filesystem error carrying the workspace's absolute path.
      removed = false;
    }
  }

  // ⚠️ **CLEANUP FAILURE IS A REFUSAL, NOT A THROW (F29).** An earlier version let `rmSync` throw from
  // the `finally`, which both bypassed this refusal and let the filesystem error - carrying the absolute
  // workspace path - escape to the caller. It is caught inside `removeWorkspace` and reduced to a boolean.
  if (!removed) return refusal(DELEGATION_REFUSED.CLEANUP);
  if (launchFailed) return refusal(DELEGATION_REFUSED.LAUNCH);

  // A tree that was told to stop and was not seen to stop is not a finished run.
  if (!run.treeStopped) return refusal(DELEGATION_REFUSED.TEARDOWN_UNCONFIRMED, { timedOut: run.timedOut, aborted: run.aborted });

  const binding = judgeAttestation(run.attestation, framed);

  // ⚠️ THE EXISTING GATE, ON EVERY RUN (D43). Nothing substantive is read before it accepts, and there
  // is no path that skips it.
  // ⚠️ **AN ABORTED RUN IS A CHILD THAT DID NOT FINISH, AND IT MUST NOT BE ACCEPTED.** An earlier
  // version passed only `timedOut`, so an abort reached the gate looking like an ordinary completion and
  // its partial output was accepted - a permissive path, which is exactly what D43 forbids. Both share
  // the `timed-out` code here because at this layer the fact is the same one: partial output is not a
  // partial answer. Splitting abort from timeout is TSK-0054's, when it owns the refusal matrix.
  const didNotFinish = run.timedOut || run.aborted;
  const verdict = verifyChild(contract, {
    taskBindingObserved: binding.taskBindingObserved,
    timedOut: didNotFinish,
    reportedTools: run.reportedTools,
    output: run.output,
  });

  const observation = {
    role,
    provider,
    model,
    thinkingLevel,
    activeTools: active,
    droppedFromAllowlist: missing,
    taskBindingObserved: binding.taskBindingObserved,
    bindingReason: binding.reason,
    bindingDetail: binding.detail ?? null,
    timedOut: run.timedOut,
    aborted: run.aborted,
    exit: run.exit,
    durationMs: (deps.now ?? (() => Date.now()))() - started,
    // ⚠️ NOT `temporaryMaterialRemoved`. It would be constant-true here: a workspace that survived
    // refuses above and never reaches this object, so the field asserted nothing and a mutation forcing
    // it to `true` survived. What the caller needs is the refusal, which it gets.
    treeStopped: run.treeStopped,
  };

  if (!verdict.accepted)
    // ⚠️ THE PUBLIC CODE STAYS `task-not-delivered` FOR A MISSING BINDING. Finer classification is
    // TSK-0054's, and inventing a second vocabulary here would be the thing that task has to undo.
    return { ok: false, code: verdict.reason, message: verdict.detail, observation };

  return { ok: true, role, output: verdict.output, observation };
}

/**
 * Spawn, watch, bound and stop one child.
 *
 * ⚠️ **fd 3 IS THE ATTESTATION CHANNEL AND CARRIES NOTHING ELSE.** Keeping it off stdout means the
 * observer's report cannot be forged by anything the child prints, and cannot be lost in a transcript.
 */
async function runChild(spec, deps) {
  const { workspace, promptName, nonce, active, provider, model, thinkingLevel, env, timeoutMs, signal, toolRoot, track, stop } = spec;
  const agent = deps.resolveAgent(toolRoot);
  const observerPath = new URL("./task-observer.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

  const args = [
    ...(agent.args ?? []),
    "--mode", "json",
    "--no-session",
    "-e", observerPath,
    "--prompt-template", workspace.prompts,
    "--provider", provider,
    "--model", model,
    "--thinking", thinkingLevel,
    "--tools", active.join(","),
    "-p", `/${promptName}`,
  ];

  const child = deps.spawn(agent.command, args, {
    cwd: workspace.dir,
    env: { ...env, [NONCE_ENV]: nonce, [FD_ENV]: String(ATTEST_FD) },
    // fd 0 closed, fd 1 and 2 captured, fd 3 the attestation pipe.
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });

  // ⚠️ **TRACKING STARTS WITH THE CHILD**, because the identities a teardown needs are the ones seen
  // while the tree was alive. A look taken after the leader exits cannot tell a descendant from whoever
  // holds its pid by then.
  const tracker = track(child, {});

  let stdout = "";
  let stderr = "";
  let attest = "";
  child.stdout?.on?.("data", (d) => (stdout += d));
  child.stderr?.on?.("data", (d) => (stderr += d));
  child.stdio?.[3]?.on?.("data", (d) => (attest += d));

  let timedOut = false;
  let aborted = false;
  let teardown = null;

  /**
   * ⚠️ **STOP LOOKING, THEN READ, THEN STOP THE TREE (F28).** An earlier version asked the tracker for
   * `descendants()`, which it does not have, so `stopTree` received no identities at all and fell back
   * to the leader alone. The tracker's own contract is `stop()` then `snapshot()`: the first takes one
   * last look and ends the polling, the second returns the identities that look established.
   */
  let stopping = null;
  const stopEverything = async () => {
    let known = null;
    try {
      await tracker.stop();
      known = tracker.snapshot();
    } catch {
      // A tracker that could not finish leaves `known` null; `stopTree` then has only the leader, and
      // the teardown result below is what decides whether that was enough.
    }
    teardown = await stop(child, { knownDescendants: known });
    return teardown;
  };

  const exit = await new Promise((done) => {
    const timer = setTimeout(() => {
      timedOut = true;
      stopping = stopEverything();
      void stopping.finally(() => done({ code: null, signal: "timeout" }));
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stopping = stopEverything();
      void stopping.finally(() => done({ code: null, signal: "abort" }));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    child.on("exit", (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      done({ code, signal: sig ?? null });
    });
  });

  const line = attest.split("\n").find((l) => l.trim().length > 0) ?? null;
  let attestation = null;
  if (line !== null) {
    try {
      attestation = JSON.parse(line);
    } catch {
      attestation = { malformed: true };
    }
  }

  // ⚠️ **THE TEARDOWN IS AWAITED BEFORE ITS RESULT IS READ.** `stopTree` ends the child, so the exit
  // listener can resolve the race first and leave `teardown` still null - which read as "no teardown was
  // needed" and reported a tree nobody had confirmed stopped as a finished run.
  if (stopping !== null) await stopping.catch(() => {});

  // A tree stopped on purpose must be CONFIRMED stopped. `exitObserved` is the supervisor's own word for
  // "the leader was seen to go"; anything else is a tree that may still be running.
  const treeStopped = teardown === null ? true : teardown.exitObserved === true;
  return { exit, timedOut, aborted, teardown, treeStopped, attestation, stdout, stderr, reportedTools: reportedToolsFrom(stdout), output: stdout };
}

/**
 * What the child said its tools were, from its JSON event stream.
 *
 * ⚠️ **THIS IS THE CHILD'S OWN ACCOUNT, AND IT IS ONLY EVER USED TO REFUSE.** `verifyChild` compares it
 * against the contract's measured signatures; a child that overstates its tools fails that comparison,
 * and one that understates them fails it too. It is never evidence that the child HAD a tool.
 */
function reportedToolsFrom(stdout) {
  for (const raw of String(stdout).split("\n")) {
    if (!raw.trim()) continue;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    if (event && typeof event === "object" && event.type === "session" && event.tools && typeof event.tools === "object") return event.tools;
  }
  return {};
}

export { BINDING_REJECTED, CHILD_REFUSED };
