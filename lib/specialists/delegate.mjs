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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AGENT_DIR_ENV, CHILD_REFUSED, ChildEnvRefusal, ROLES, childEnv, contractFor, mayWrite, verifyChild } from "./contract.mjs";
import { CHILD_REPORT_TYPE, REPORT_REJECTED, judgeChildReport, reportedToolsOf } from "./child-report.mjs";
import { answerFrom, nativeSelection, readChildEvents, toolsStarted } from "./child-events.mjs";
import { BINDING_REJECTED, frameTask, judgeAttestation } from "./task-frame.mjs";
import { FD_ENV, NONCE_ENV } from "./task-observer.mjs";
import { SPECIALISTS_DIR } from "./render.mjs";
import { toolOperation } from "../tool-wire-names.mjs";

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

/**
 * The isolated agent directory this session was given, or null.
 *
 * ⚠️ **IT LIVES HERE BECAUSE THE PACKAGE ENTRY POINT MAY NOT READ THE ENVIRONMENT.** `kiln.js` must
 * load with nothing but `pi-package/` present and is held to reading no `process.env` at all, so the one
 * place that knows which variable names the agent directory is this module, which already owns
 * `AGENT_DIR_ENV` through the contract.
 *
 * ⚠️ **THE SESSION'S OWN DIRECTORY, PASSED POSITIVELY.** A Kiln session is started with an agent
 * directory the launcher chose; handing the child that same one is a decision, where leaving it unset
 * would let the child resolve the OPERATOR's default and read the stored credentials there.
 */
export function sessionAgentDirectory(env = process.env) {
  const dir = env?.[AGENT_DIR_ENV];
  return typeof dir === "string" && dir.length > 0 ? dir : null;
}

/** Why a delegation could not be attempted at all. Distinct from a child whose ANSWER was refused. */
export const DELEGATION_REFUSED = Object.freeze({
  UNKNOWN_ROLE: "unknown-role",
  INVALID_TASK: "invalid-task",
  NO_AGENT_DIR: "agent-directory-missing",
  NO_TOOLS: "role-derives-no-tools",
  NO_HOST_TOOLS: "host-registry-empty",
  ALLOWLIST_EMPTY: "allowlist-intersection-empty",
  NO_ROLE_DEFINITION: "role-definition-unreadable",
  NO_ROLE_DEFINITION: "role-definition-unreadable",
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
  "role-definition-unreadable": "That role's definition could not be read, so a child could not be told what it is.",
  "role-definition-unreadable": "That role's definition could not be read, so a child could not be told what it is.",
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

  // ⚠️ THE CANONICAL DEFINITION, READ FROM DISK, NOT REBUILT. `specialists/<role>.md` is generated and
  // checked in every CI cell; rendering it again here would be a second copy that drifts.
  let roleDefinition;
  try {
    roleDefinition = readFileSync(join(toolRoot, SPECIALISTS_DIR, `${role}.md`), "utf8");
  } catch {
    return refusal(DELEGATION_REFUSED.NO_ROLE_DEFINITION);
  }
  if (roleDefinition.trim().length === 0) return refusal(DELEGATION_REFUSED.NO_ROLE_DEFINITION);

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
    run = await runChild({ workspace, promptName, nonce, active, provider, model, thinkingLevel, env, timeoutMs, signal, toolRoot, track, stop, roleDefinition }, deps);
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

  /**
   * ⚠️ **THE ORDER IS THE CONTRACT, AND IT HAS ITS OWN TEST.** A run can fail several ways at once,
   * and which refusal a caller is told decides what they do next. Cheapest and most fundamental
   * first: what the PROCESS did, then whether its stream can be read at all, then what the child
   * claims about itself. Nothing the child says is consulted before the facts it does not control.
   */

  // ⚠️ THE DURATION IS READ WHEN THE OBSERVATION IS BUILT, not once at the top, so a run refused
  // late reports the time it actually took.
  const elapsed = () => (deps.now ?? (() => Date.now()))() - started;
  const seen = (extra = {}) => ({ role, provider, model, thinkingLevel, active, missing, durationMs: elapsed(), ...extra });

  // 1. Timeout or abort. Partial output is not a partial answer.
  //
  // ⚠️ AN ABORT IS STILL A CHILD THAT DID NOT FINISH, and both refuse here under `timed-out`.
  // The observation records them apart, so a caller can tell which happened.
  const didNotFinish = run.timedOut || run.aborted;
  if (didNotFinish) return childRefusal(CHILD_REFUSED.TIMED_OUT, observationOf(run, {}, {}, seen()));

  // 2. The stream, read strictly. A line that is not an event is a refusal, not something to skip.
  const stream = readChildEvents(run.stdout);
  if (!stream.ok)
    return childRefusal(CHILD_REFUSED.EVENTS_MALFORMED, observationOf(run, {}, {}, seen({ eventsInvalid: stream.reason, eventsInvalidLine: stream.line })));

  // 3. A nonzero exit. The child said it failed; nothing it printed is an answer to anything.
  if (run.exit?.code !== 0) return childRefusal(CHILD_REFUSED.NONZERO_EXIT, observationOf(run, {}, {}, seen()));

  // 4. The task binding (F39).
  //
  // ⚠️ **A CHILD THAT WAS NEVER GIVEN THE TASK REFUSES HERE, NOT AT `verifyChild`.** An earlier
  // version judged the binding here and carried the verdict to the end, so a child that never received
  // the task could be refused for a wrong model or an out-of-role write instead - a caller told to fix
  // its model selection when the real fact is that nothing it asked for was ever delivered. Everything
  // below this line is about a child that at least got the task.
  const binding = judgeAttestation(run.attestation, framed);
  if (!binding.taskBindingObserved) return childRefusal(CHILD_REFUSED.NO_TASK_BINDING, observationOf(run, binding, {}, seen()));

  // 5. The selection the child says it ran under, cross-checked against the request and against Pi's
  //    own assistant events. A wrong provider or model is its own fact, not a missing capability.
  const reportVerdict = judgeChildReport(run.reports, { provider, model, thinkingLevel }, nativeSelection(stream.events));
  const contradicted = reportVerdict.reason === REPORT_REJECTED.SELECTION_MISMATCH || reportVerdict.reason === REPORT_REJECTED.NATIVE_MISMATCH;
  if (!reportVerdict.accepted && contradicted)
    return childRefusal(CHILD_REFUSED.SELECTION_MISMATCH, observationOf(run, binding, reportVerdict, seen()));

  // 6. A write outside the role's boundary that nevertheless STARTED (D49's fail-safe, F40).
  //
  // ⚠️ **THE BOUNDARY IS `mayWrite`, NOT THE ALLOWLIST.** An earlier version refused every tool
  // outside `active`, which called a read the role simply was not given an out-of-role WRITE and told
  // the caller a mutation had been attempted when none had. The wire name is resolved to the canonical
  // operation it performs and put to the same function the wrapper gate uses, so one definition of the
  // write boundary governs both.
  //
  // ⚠️ **EVERY NAME HERE IS CANONICAL (F41).** `readChildEvents` refuses a stream naming a tool
  // this host does not register, so no child-controlled string reaches an observation.
  const toolsThatStarted = toolsStarted(stream.events);
  const forbidden = toolsThatStarted.filter((name) => {
    const operation = toolOperation(name);
    if (operation === null || operation.kind === "read") return false;
    return !mayWrite(contract, operation);
  });
  if (forbidden.length > 0)
    return childRefusal(
      CHILD_REFUSED.OUT_OF_ROLE_WRITE,
      observationOf(run, binding, reportVerdict, seen({ outOfRoleTools: [...new Set(forbidden)].sort() }), toolsThatStarted)
    );

  // 7. The capabilities and the signatures, through the existing gate.
  const verdict = verifyChild(contract, {
    taskBindingObserved: binding.taskBindingObserved,
    timedOut: false,
    reportedTools: reportedToolsOf(reportVerdict),
    output: null,
  });
  if (!verdict.accepted) return { ok: false, code: verdict.reason, message: verdict.detail, observation: observationOf(run, binding, reportVerdict, seen()) };

  // ⚠️ **ONLY NOW.** Every fact about the run has been checked, so selecting the assistant's text
  // cannot be reading prose the gate was going to reject.
  const answer = answerFrom(stream.events);

  return { ok: true, role, output: answer, observation: observationOf(run, binding, reportVerdict, seen(), toolsThatStarted) };
}

/**
 * What was observed about a run, for a caller to read whether it was accepted or refused.
 *
 * ⚠️ **IDENTIFIERS, BOOLEANS AND CODES ONLY.** No assistant prose, no raw stream, no workspace path,
 * no nonce and no digest. A refusal carries the same shape as an acceptance, so a caller reads one
 * record either way and nothing leaks by travelling only on the unhappy path.
 *
 * ⚠️ **NO `bindingDetail` (F43).** The binding verdict's detail quotes what the child's first
 * provider request actually carried, which is the child's own material; the reason code says which
 * check failed without reproducing it.
 *
 * ⚠️ **TOOL NAMES ARE CANONICAL OR ABSENT (F41).** `toolsStarted` and `outOfRoleTools` are
 * filled from `KNOWN_TOOL_NAMES`, never from a `toolName` field as it arrived.
 */
function observationOf(run, binding, reportVerdict, context, toolsThatStarted = null) {
  return {
    role: context.role,
    provider: context.provider,
    model: context.model,
    thinkingLevel: context.thinkingLevel,
    activeTools: context.active ?? [],
    droppedFromAllowlist: context.missing ?? [],
    taskBindingObserved: binding?.taskBindingObserved === true,
    bindingReason: binding?.reason ?? null,
    childReportAccepted: reportVerdict?.accepted === true,
    childReportReason: reportVerdict?.reason ?? null,
    reportedActiveTools: reportVerdict?.accepted === true ? reportVerdict.report.activeTools : [],
    toolsStarted: toolsThatStarted ?? [],
    outOfRoleTools: context.outOfRoleTools ?? [],
    eventsInvalid: context.eventsInvalid ?? null,
    eventsInvalidLine: context.eventsInvalidLine ?? null,
    timedOut: run.timedOut === true,
    aborted: run.aborted === true,
    exit: run.exit ?? null,
    durationMs: context.durationMs ?? null,
    treeStopped: run.treeStopped === true,
  };
}

/**
 * A refusal about the CHILD, as opposed to one about the delegation never being attempted.
 *
 * ⚠️ **THE MESSAGE IS FIXED AND THE CODE CARRIES THE FACT.** Nothing the child produced reaches it:
 * not its prose, not the line that failed to parse, not the tool it should not have called.
 */
const CHILD_MESSAGE = Object.freeze({
  "timed-out": "The child did not finish, so what it produced is not an answer.",
  "task-not-delivered": "The child was not observed to receive the task, so its answer is not an answer to it.",
  "child-events-malformed": "The child's event stream could not be read, so nothing about the run can be concluded from it.",
  "child-exited-nonzero": "The child reported failure, so what it produced is not an answer.",
  "child-selection-mismatch": "The child ran under a provider or model that was not the one requested.",
  "out-of-role-write": "The child started a tool outside its role's boundary.",
});

const childRefusal = (code, observation) => ({
  ok: false,
  code,
  message: CHILD_MESSAGE[code] ?? "The child's answer was refused.",
  observation,
});


/**
 * Spawn, watch, bound and stop one child.
 *
 * ⚠️ **fd 3 IS THE ATTESTATION CHANNEL AND CARRIES NOTHING ELSE.** Keeping it off stdout means the
 * observer's report cannot be forged by anything the child prints, and cannot be lost in a transcript.
 */
async function runChild(spec, deps) {
  const { workspace, promptName, nonce, active, provider, model, thinkingLevel, env, timeoutMs, signal, toolRoot, track, stop, roleDefinition } = spec;
  const agent = deps.resolveAgent(toolRoot);
  const observerPath = new URL("./task-observer.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

  // ⚠️ **EXACTLY WHAT IS NAMED, IN ORDER: KILN'S PACKAGE, THEN THE OBSERVER.** The package registers
  // the specialist tools; without it `--tools` restricts an empty set, which a first real run measured
  // as a child offered no tools at all.
  //
  // ⚠️ **`extraExtensions` IS DEPENDENCY INJECTION AND NOTHING ELSE.** It is not a request field, it
  // is absent from every model-facing schema, and production passes nothing, so the list is empty
  // there. A test uses it to give a child a loopback provider without a credential. Anything it does
  // carry is APPENDED, so the package and the observer are always loaded first and a test extension
  // cannot displace either.
  const injected = Array.isArray(deps?.extraExtensions) ? deps.extraExtensions.filter((p) => typeof p === "string" && p.length > 0) : [];
  const extensions = [join(toolRoot, "pi-package", "extensions", "kiln.js"), observerPath, ...injected];

  // ⚠️ **PI'S OWN ISOLATION FLAGS, MEASURED BEFORE THEY WERE RELIED ON.** A first real run showed the
  // provider receiving Pi's generic coding-assistant prompt, no role definition at all, and NO `tools`
  // key whatsoever - the child was told it was a coding assistant and offered nothing.
  //
  //  • `--system-prompt` puts the canonical role definition where Pi's default was. Prepending it to the
  //    task would have left the default in front of it, telling the child it may read files and run
  //    commands while the role's own forbidden actions say otherwise.
  //  • `--no-context-files` and `--no-skills` stop discovered instructions editing the role.
  //  • `--no-extensions` stops discovery; explicit `-e` paths still load, which is the documented
  //    guarantee this depends on.
  //  • `--no-builtin-tools` removes read, write, edit and bash, so `--tools` restricts what Kiln's
  //    package registered and nothing else.
  const args = [
    ...(agent.args ?? []),
    "--mode", "json",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-builtin-tools",
    "--system-prompt", roleDefinition,
    ...extensions.flatMap((path) => ["-e", path]),
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

  // ⚠️ TWO KINDS OF LINE ON ONE FD, ROUTED BY TYPE. The binding attestation has no `type`; the child
  // report does. A reader that took the first line would depend on the order they were written in.
  const lines = [];
  for (const raw of attest.split(String.fromCharCode(10))) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {
      lines.push({ malformed: true });
    }
  }
  const reports = lines.filter((l) => l?.type === CHILD_REPORT_TYPE);
  const attestation = lines.find((l) => l?.type === undefined) ?? null;

  // ⚠️ **THE TEARDOWN IS AWAITED BEFORE ITS RESULT IS READ.** `stopTree` ends the child, so the exit
  // listener can resolve the race first and leave `teardown` still null - which read as "no teardown was
  // needed" and reported a tree nobody had confirmed stopped as a finished run.
  if (stopping !== null) await stopping.catch(() => {});

  // A tree stopped on purpose must be CONFIRMED stopped. `exitObserved` is the supervisor's own word for
  // "the leader was seen to go"; anything else is a tree that may still be running.
  const treeStopped = teardown === null ? true : teardown.exitObserved === true;
  // ⚠️ THE STREAM IS HANDED OVER WHOLE, NOT INTERPRETED HERE. Reading it is the gate's business, and
  // the assistant's text is not selected until the gate has accepted the run.
  return { exit, timedOut, aborted, teardown, treeStopped, attestation, reports, stdout, stderr };
}

/**
 * What Pi's own assistant events said the request went out under — TSK-0053 (F34).
 *
 * ⚠️ **THIS REPLACES `reportedToolsFrom`, WHICH READ A FIELD THAT DOES NOT EXIST.** That function
 * looked for `session.tools`; a real child's `session` event carries `{type, version, id, timestamp,
 * cwd}` and nothing else, measured, so the gate refused every real child. Pi DOES report the provider
 * and the model, on the assistant `message_start`, `message_end` and `turn_end` events, and those are
 * what the child's own report is cross-checked against.
 *
 * ⚠️ **NOT A SOURCE OF TRUTH ON ITS OWN.** A child controls its stdout. This is a second statement to
 * disagree with the report, never evidence in its own right.
 */
export { BINDING_REJECTED, CHILD_REFUSED };
