/**
 * The combined runtime supervisor — CMP-0037, against ACC-0078/0079/0080/0102.
 *
 * One terminal, two processes, and only one of them may read it. The supervisor starts the
 * application launcher in the background and Pi in the foreground, and the whole shape of this file
 * follows from that: the launcher gets a private pipe it cannot type into, Pi gets the terminal, and
 * the supervisor holds the writable end of the launcher's pipe as its control channel.
 *
 * ⚠️ **READINESS IS AN IDENTITY, NOT A RESPONSE.** An unrelated service on the chosen port answers an
 * HTTP probe perfectly, and so does a Kiln left over from a previous run. Four facts make the
 * responder *this* one — service, protocol, exact run id, exact project id — and they are checked
 * while the child this invocation started is still alive, because an identity from a process that
 * has since died is a fact about the past.
 *
 * ⚠️ **THE BUILD VERSION IS COMPARED AND CREDITED WITH NOTHING.** A mismatch refuses; a match adds no
 * identity, because this package is `0.0.0` and every build of it reports that. Counting it would
 * turn a four-fact handshake into a five-fact one that is not stronger. The two ways to make the
 * word "identity" true here were both refused: a derived fingerprint puts an invented value in a
 * readiness check nothing versions, and bumping the version to fit a sentence is the sentence
 * editing the system.
 *
 * ⚠️ **ORCHESTRATION LIVES HERE SO IT CAN BE TESTED WITHOUT CREDENTIALS OR A REAL AGENT UI.** What
 * `bin/start-kiln.mjs` adds is the one thing tests must not choose: WHICH commands run. The seam is
 * structured — a command and an argument array, spawned with `shell: false` — and it is internal.
 * No flag and no environment variable reaches it, because an override that can name a program is a
 * way to make this supervisor start something else with the operator's terminal attached.
 */

import { createServer } from "node:net";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  OVERRIDE_ENV,
  canonicalPath,
  contentRootCandidate,
  isAtOrInside,
  pathIdentityKey,
  toolRoot as ownToolRoot,
} from "./content-root.mjs";
import { createRuntimeValidators, assertValidRecord } from "./runtime-records.mjs";
import { STATE_MODE, coverageState, stateRootFor } from "./local-state.mjs";
import {
  HEALTH_ERRORS,
  HEALTH_PATH,
  isKilnHealthBody,
  generateRunId,
  matchHealth,
  parsePort,
  toolVersion,
} from "./run-identity.mjs";

export const HOST = "127.0.0.1";

export const REFUSAL = {
  NO_PROJECT_RECORD: "no-project-record",
  PROJECT_RECORD_INVALID: "project-record-invalid",
  PORT_INVALID: "port-invalid",
  PORT_OCCUPIED: "port-occupied",
  LAUNCHER_EXITED: "launcher-exited",
  IDENTITY_MISMATCH: "identity-mismatch",
  BUILD_MISMATCH: "build-mismatch",
  NOT_IDENTIFIED: "not-identified",
  NOT_READY: "not-ready",
  AGENT_NOT_INSTALLED: "agent-not-installed",
  SPAWN_FAILED: "spawn-failed",
  SHUTDOWN_NOT_OBSERVED: "shutdown-not-observed",
  STATE_UNPROTECTED: "state-unprotected",
  SESSION_DIR_CONFLICT: "session-dir-conflict",
  RUN_FILE_UNSAFE: "run-file-unsafe",
  SELF_HOST_UNDECLARED: "self-host-undeclared",
  SELF_HOST_NOT_SELF_HOSTING: "self-host-not-self-hosting",
  SELF_HOST_NO_CONTENT_OVERRIDE: "self-host-no-content-override",
  SELF_HOST_CONTENT_MISMATCH: "self-host-content-mismatch",
  // ⚠️ TWO CODES, NOT ONE WITH A FIELD. An unasked project and a declined one need different things
  // from the operator — a decision, or a change of mind — and a caller should not have to read a
  // detail to tell which it is looking at.
  TRUST_MISSING: "trust-missing",
  TRUST_DENIED: "trust-denied",
  AGENT_DIR_MISSING: "agent-dir-missing",
};

/** The command that starts the application without an agent, named in every trust refusal. */
export const BROWSER_ONLY_COMMAND = "bin/start-shell.mjs";

/**
 * The trust gate: an approved project, or a refusal that names which of the two reasons it is.
 *
 * ⚠️ **BEFORE THE PROJECT RECORD, THE PORT AND EITHER CHILD.** A child started in a project nobody
 * trusted loads none of the project package — no Kiln tools, no role boundaries — and, as AST-0042
 * measured, says nothing about it. So this asks before anything is read, chosen or spawned, and a
 * refusal here costs the operator nothing: no port taken, no file written, the scaffold untouched.
 *
 * ⚠️ **THE READER IS IMPORTED LAZILY, TO KEEP THE DEPENDENCY POINTING ONE WAY.** `lib/pi-trust.mjs`
 * reaches the pinned SDK through `lib/pi-runtime.mjs`, which imports this module's refusal types; a
 * static import here would close that circle at load time. The default still lives in this function
 * rather than in its callers, because a gate a caller can forget to pass is not a gate.
 *
 * @param {object} options
 * @param {string} options.projectRoot  canonical project root
 * @param {string} options.agentDir     the directory Pi itself resolved, and the one the child will use
 * @param {(o: object) => Promise<{state: string, projectRoot: string, recordedFor: string|null}>} [options.readTrust]
 */
export async function assertProjectTrusted({ projectRoot, agentDir, toolRoot, readTrust = null, log = () => {} }) {
  if (typeof agentDir !== "string" || agentDir.trim().length === 0)
    throw new SupervisorRefusal(
      REFUSAL.AGENT_DIR_MISSING,
      `Starting an agent needs the directory Pi keeps its own state in, and none was supplied. The ` +
        `command resolves it from the pinned package so that the store checked here and the store the ` +
        `child reads are one directory; a default guessed here could be neither.`,
      { field: "agentDir" }
    );

  const trust = await import("./pi-trust.mjs");
  const decision = await (readTrust ?? trust.readTrust)({ projectRoot, agentDir, toolRoot });

  if (decision.state === trust.TRUST.APPROVED) {
    log(`project trust: approved for ${decision.projectRoot}`);
    return decision;
  }

  const denied = decision.state === trust.TRUST.DENIED;
  const shared =
    `A Pi agent started in a project that is not trusted loads none of this project's package — none ` +
    `of Kiln's typed tools, and none of the role boundaries they enforce — and reports no error while ` +
    `doing it. Nothing was started and nothing was created: the planning scaffold is exactly as it ` +
    `was. To work without an agent, start the application alone with \`node ${BROWSER_ONLY_COMMAND}\`.`;

  throw new SupervisorRefusal(
    denied ? REFUSAL.TRUST_DENIED : REFUSAL.TRUST_MISSING,
    denied
      ? `Project trust for ${decision.projectRoot} was declined, and that decision stands until it is ` +
        `changed. ${shared} To change it, run setup again and approve.`
      : `Nothing has been decided about trusting ${decision.projectRoot}. ${shared} To decide, run ` +
        `setup, which asks and records the answer.`,
    {
      projectRoot: decision.projectRoot,
      state: decision.state,
      recordedFor: decision.recordedFor ?? null,
      browserOnly: BROWSER_ONLY_COMMAND,
    }
  );
}

/* ------------------------------------------------------- where Pi puts its transcripts */

/**
 * The routes Pi reads a session location from, in the precedence EVD-0081 measured on both
 * platforms: the flag, then the environment variable, then the `sessionDir` setting.
 */
export const SESSION_DIR_FLAG = "--session-dir";
export const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

/**
 * Give Pi the session directory Kiln chose, by the route that was proved.
 *
 * ⚠️ **THE FLAG, BECAUSE IT IS THE ONE NOTHING ELSE OUTRANKS.** All three routes were measured to
 * work; they are not interchangeable here. An operator with a stale `PI_CODING_AGENT_SESSION_DIR`
 * exported, or a `sessionDir` left in settings, would otherwise decide where transcripts land —
 * and the whole point of the coverage gate is that Kiln knows that location and has checked it.
 * The environment variable is set to the SAME path rather than left alone, so every route agrees
 * and a future version that stopped passing the flag would still land inside the gated directory
 * instead of silently reverting to `.pi/sessions`.
 *
 * ⚠️ **A CALLER THAT ALREADY NAMES ONE IS A REFUSAL, NOT AN APPEND.** Two `--session-dir` flags
 * mean Pi decides which wins, and Kiln can no longer say where the transcripts went — which is
 * exactly the claim the coverage gate exists to be able to make. `bin/start-kiln.mjs` builds the
 * argument array itself and passes none, so reaching this is a programming error rather than
 * something an operator can do; it refuses anyway, because the cost of being wrong is transcripts
 * in a tracked directory.
 */
export function withSessionDir(agent, sessionDir, env) {
  const args = agent.args ?? [];
  const conflict = args.findIndex((a) => a === SESSION_DIR_FLAG || String(a).startsWith(`${SESSION_DIR_FLAG}=`));
  if (conflict !== -1)
    throw new SupervisorRefusal(
      REFUSAL.SESSION_DIR_CONFLICT,
      `The agent's argument list already names ${SESSION_DIR_FLAG} at position ${conflict}, and the ` +
        `supervisor must supply it: two of them leave the transcript location to whichever Pi ` +
        `prefers, and the coverage check is only meaningful if Kiln knows where the transcripts go.`,
      { args, sessionDir }
    );

  return {
    args: [...args, SESSION_DIR_FLAG, sessionDir],
    env: { ...env, [SESSION_DIR_ENV]: sessionDir },
  };
}

/**
 * Where this run's state lives, refusing if the protection for it is not in place RIGHT NOW.
 *
 * ⚠️ **THE SUPERVISOR CREATES NOTHING, AND PI CREATING ITS OWN SESSION DIRECTORY IS AUTHORISED.**
 * An earlier version of this comment said a missing root meant setup had not run and would refuse.
 * Both halves were false: nothing here checked existence, and the pinned Pi creates the directory
 * regardless — `SessionManager`'s constructor does `mkdirSync(sessionDir, { recursive: true })` when
 * a custom directory does not exist. Stating an ownership rule the code did not implement, about a
 * runtime that does the opposite, is worse than having no rule.
 *
 * What is true, and is the design: Kiln proves the LOCATION is ignored, and Pi creates the directory
 * at that location on first use. That is coverage-before-data exactly as REQ-0027 words it — the
 * protection exists before the data — and an absent session directory is a legitimate first run
 * rather than evidence of anything, which is what ACC-0103 requires it to be treated as. "Has setup
 * run at all?" is a question `readProjectRecord` already answers, by refusing when `.pi/kiln.json`
 * is missing and naming setup as the fix.
 *
 * The supervisor still creates nothing itself. Creating the state root under a transaction is
 * setup's work, and a start command that made directories would be a second writer with no
 * exclusion behind it.
 *
 * ⚠️ **AND IT IS CHECKED AT LAUNCH, NOT TRUSTED FROM SETUP.** REQ-0027's ordering is about what is
 * true at the moment data is written. Setup may have run months ago; the operator may have removed
 * the ignore block since. The first thing Pi does with a session directory is write a transcript
 * into it, so this is the last moment the question can still be asked.
 */
export function resolveRunState({ projectRoot, stateMode = STATE_MODE.PROJECT, projectId, platform, env, home }) {
  const roots = stateRootFor({ mode: stateMode, projectRoot, projectId, platform, env, home });
  const covers = coverageState({ projectRoot, mode: stateMode, roots });

  if (!covers.covered)
    throw new SupervisorRefusal(
      REFUSAL.STATE_UNPROTECTED,
      `Pi's session transcripts would be written to ${roots.sessions}, and this repository does not ` +
        `ignore ${covers.uncovered.join(", ")}. Nothing was started. A transcript is the first thing ` +
        `written after Pi launches, and writing one into a directory Git is tracking is the failure ` +
        `REQ-0027 exists to prevent — re-run setup to restore the ignore block, or start with ` +
        `external state.`,
      { sessions: roots.sessions, uncovered: covers.uncovered, state: covers.state }
    );

  return { roots, covers };
}

export class SupervisorRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "SupervisorRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEWLINE = '\n';

/* ============================================================== the self-hosting mode =========== */

/**
 * The half of the self-host decision that needs only the flag and the environment.
 *
 * A consumer install has the tool at `<project>/.planning/` and the project one directory above it,
 * so the tool root and the project root are different directories. In THIS repository they are the
 * same one, because the tool is its own consumer — and that is a distinct mode rather than an
 * ordinary run: `.pi/` would be written into the tool repository, and a contributor who meant to open
 * their own project would not find out until they read a diff.
 *
 * ⚠️ **THE OPT-IN IS TWO INPUTS, AND SUPPLYING ONE IS NOT ASKING.** `--self-host` states the intent;
 * `PLANNING_CONTENT_DIR` states which content directory is meant. Either alone is an operator who has
 * said half of something: a flag with no override names no content, and an override with no flag is
 * how this repository's dev commands ordinarily point at their own content — which is exactly the run
 * that must not quietly become a self-hosting one. Both are required, and this checks that they agree
 * before anything starts.
 *
 * ⚠️ **AGREEMENT IS CHECKED AGAINST THE OVERRIDE ITSELF, NOT AGAINST THE PROJECT ROOT ALONE.** The
 * caller derives the project root FROM the override — `dirname(contentRoot)`, #70's one rule — so
 * comparing only the project root would be checking that derivation against itself. The directory
 * that owns the named content root is re-derived here and compared to the tool root, so a caller that
 * arrived at its project root some other way is a refusal rather than a silently accepted third
 * opinion about where this run is.
 *
 * ⚠️ **IT GRANTS NOTHING.** The only outcome is permission to carry on into the same project record,
 * port, state-coverage and readiness checks every other run makes. Self-host is a mode this command
 * may enter, never a mode in which it checks less.
 *
 * @param {{toolRoot?: string, selfHost?: boolean, env?: NodeJS.ProcessEnv}} opts
 * @returns {{selfHost: boolean, toolRoot: string, contentOwner: string | null}}
 */
export function assertSelfHostOptIn({ toolRoot = ownToolRoot(), selfHost = false, env = process.env }) {
  const tool = canonicalPath(toolRoot);
  if (!selfHost) return { selfHost: false, toolRoot: tool, contentOwner: null };

  // ⚠️ ASKED OF THE SHARED RESOLVER RATHER THAN OF THE ENVIRONMENT. "Was the override used?" already
  // has exactly one definition — `contentRootCandidate`, including what it makes of an empty value —
  // and a second reading of the same variable here is how this file and the resolver come to disagree
  // about which content root a run opened.
  const candidate = contentRootCandidate(env);

  if (!candidate.override)
    throw new SupervisorRefusal(
      REFUSAL.SELF_HOST_NO_CONTENT_OVERRIDE,
      `--self-host was given without ${OVERRIDE_ENV}, and the opt-in is BOTH of them.\n` +
        `  tool root: ${tool}\n  rule:      ${candidate.how}\n` +
        `The flag says which mode this is; the variable says which content directory it opens, and ` +
        `neither is inferred from the other. Give both:\n` +
        `  ${OVERRIDE_ENV}=${join(tool, "planning-content")}\n` +
        `  --self-host`,
      { toolRoot: tool }
    );

  const owner = canonicalPath(dirname(resolve(env[OVERRIDE_ENV])));
  if (pathIdentityKey(owner) !== pathIdentityKey(tool))
    throw new SupervisorRefusal(
      REFUSAL.SELF_HOST_CONTENT_MISMATCH,
      `--self-host and ${OVERRIDE_ENV} disagree — refusing to choose between them.\n` +
        `  content root: ${canonicalPath(resolve(env[OVERRIDE_ENV]))}\n` +
        `  owned by:     ${owner}\n` +
        `  tool root:    ${tool}\n` +
        `The flag says this run is the tool's own checkout; the named content directory belongs to a ` +
        `different project. Correct one of the two.`,
      { toolRoot: tool, contentOwner: owner }
    );

  return { selfHost: true, toolRoot: tool, contentOwner: owner };
}

/**
 * The whole decision: the opt-in above, and then whether the roots are what the flag claims.
 *
 * ⚠️ **THE OPT-IN HALF RUNS FIRST BECAUSE THE COMMAND CANNOT REACH THIS FUNCTION OTHERWISE.** The
 * project root is `dirname(contentRoot)`, so resolving it needs a content root — and with
 * `--self-host` given and no `${OVERRIDE_ENV}`, there is none. `bin/start-kiln.mjs` therefore died in
 * `resolveProjectRoot` with the generic "no planning content root", which answers a question the
 * operator did not ask and whose hint line does not even mention the flag they typed. Splitting the
 * checks that need only the flag and the environment into `assertSelfHostOptIn` lets the command run
 * them BEFORE it resolves anything, and this function still runs them itself, so the earlier call is
 * an ordering fix rather than the only place the rule lives.
 *
 * @param {{toolRoot?: string, projectRoot: string, selfHost?: boolean, env?: NodeJS.ProcessEnv}} opts
 * @returns {{selfHost: boolean, toolRoot: string, projectRoot: string}}
 */
export function resolveSelfHost({ toolRoot = ownToolRoot(), projectRoot, selfHost = false, env = process.env }) {
  const { toolRoot: tool } = assertSelfHostOptIn({ toolRoot, selfHost, env });
  const project = canonicalPath(projectRoot);
  const inToolRoot = pathIdentityKey(project) === pathIdentityKey(tool);

  if (selfHost && !inToolRoot)
    throw new SupervisorRefusal(
      REFUSAL.SELF_HOST_NOT_SELF_HOSTING,
      `--self-host was given, but this run is not in the tool checkout.\n` +
        `  project root: ${project}\n  tool root:    ${tool}\n` +
        `Self-host mode is for the case where those two are the same directory. Drop the flag to run ` +
        `this project normally.`,
      { toolRoot: tool, projectRoot: project }
    );

  if (inToolRoot && !selfHost)
    throw new SupervisorRefusal(
      REFUSAL.SELF_HOST_UNDECLARED,
      `Refusing to run in the tool checkout itself.\n` +
        `  project root: ${project}\n  tool root:    ${tool}\n` +
        `This would write .pi/ into the tool repository. If that is what you want, say so with BOTH:\n` +
        `  ${OVERRIDE_ENV}=${join(tool, "planning-content")}\n` +
        `  --self-host\n` +
        `Otherwise point ${OVERRIDE_ENV} at your own project's planning-content directory.`,
      { toolRoot: tool, projectRoot: project }
    );

  return { selfHost, toolRoot: tool, projectRoot: project };
}

/* ============================================================== project and port =============== */

/**
 * The stable, non-secret project id, from the record setup wrote.
 *
 * ⚠️ Validated against its schema rather than read for one field. A `kiln.json` this cannot parse is
 * a project that was not set up, or was set up by a version that disagrees; guessing past it would
 * start a supervisor whose whole readiness check compares against a value it invented.
 */
export function readProjectRecord(projectRoot, { validators } = {}) {
  const path = join(projectRoot, ".pi", "kiln.json");
  if (!existsSync(path))
    throw new SupervisorRefusal(
      REFUSAL.NO_PROJECT_RECORD,
      `No Kiln project record at ${path}. Run setup for this project first — the supervisor needs the ` +
        `project identity to tell its own application apart from anything else answering the port.`,
      { path }
    );

  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new SupervisorRefusal(REFUSAL.PROJECT_RECORD_INVALID, `${path} is not readable JSON: ${e.message}`, { path });
  }
  try {
    assertValidRecord(validators ?? createRuntimeValidators(), "kiln-project", doc, path);
  } catch (e) {
    throw new SupervisorRefusal(REFUSAL.PROJECT_RECORD_INVALID, `${path} is not a valid Kiln project record: ${e.message}`, {
      path,
    });
  }
  return doc;
}

/**
 * Prove nothing else holds the port, by taking it exclusively and letting it go.
 *
 * ⚠️ **A BIND TEST NARROWS THE RACE; IT DOES NOT ESTABLISH IDENTITY.** Between this and the child's
 * own listen, someone else can take the port — which is exactly why readiness is a handshake rather
 * than a connection. What this buys is a clear refusal BEFORE a build, instead of a confusing one
 * after it.
 */
export function probePort(port, { host = HOST, createServerImpl = createServer } = {}) {
  return new Promise((resolve) => {
    const server = createServerImpl();
    server.once("error", (e) => resolve({ free: false, code: e.code ?? String(e.message) }));
    server.once("listening", () => {
      const chosen = server.address()?.port ?? port;
      server.close(() => resolve({ free: true, port: chosen }));
    });
    server.listen({ port, host, exclusive: true });
  });
}

/**
 * Decide which port this invocation will use.
 *
 * ⚠️ **AN AUTOMATIC CHOICE IS FOR THIS INVOCATION ONLY AND IS NEVER WRITTEN DOWN.** Persisting it
 * would make one busy afternoon the project's permanent configuration, and the operator would have
 * no idea which file to look in when the port moved.
 *
 * ⚠️ **NON-INTERACTIVE REFUSES WITH THE EXACT COMMAND**, because a script has nobody to ask and
 * "port in use" leaves the reader to work out both the flag and a free number.
 */
export function retryWithPort(port, command = DEFAULT_RETRY_COMMAND) {
  // ⚠️ **A COMPLETE COMMAND FOR EACH SHELL, NOT `PORT=<n>`.** That prefix form is sh syntax and is a
  // parse error in PowerShell, which is the shell most Windows operators are in — so the "exact
  // recovery command" was exact only for half the audience, and the half it failed was left to work
  // out both the syntax and the invocation.
  return [
    `  PowerShell   $env:PORT = "${port}"; ${command}`,
    `  sh           PORT=${port} ${command}`,
  ].join(NEWLINE);
}

export async function choosePort({
  value,
  interactive,
  ask,
  host = HOST,
  createServerImpl = createServer,
  retryCommand = DEFAULT_RETRY_COMMAND,
}) {
  const parsed = parsePort(value);
  if (parsed.problem) throw new SupervisorRefusal(REFUSAL.PORT_INVALID, parsed.problem, {});

  const wanted = parsed.port;
  const first = await probePort(wanted, { host, createServerImpl });
  if (first.free) return { port: wanted, chosen: "requested" };

  const spare = await probePort(0, { host, createServerImpl });
  const suggestion = spare.free ? spare.port : null;

  if (!interactive)
    throw new SupervisorRefusal(
      REFUSAL.PORT_OCCUPIED,
      `Port ${wanted} on ${host} is already in use (${first.code}).` +
        (suggestion
          ? `${NEWLINE}Retry with a free port:${NEWLINE}${retryWithPort(suggestion, retryCommand)}`
          : `${NEWLINE}No free port was available to suggest.`),
      { port: wanted, code: first.code, suggestion }
    );

  if (!suggestion)
    throw new SupervisorRefusal(REFUSAL.PORT_OCCUPIED, `Port ${wanted} is in use and no free port was available.`, {
      port: wanted,
    });

  const accepted = await ask(
    `Port ${wanted} is in use. Use ${suggestion} for this run only? It will not be saved. [y/N] `
  );
  if (!accepted)
    throw new SupervisorRefusal(
      REFUSAL.PORT_OCCUPIED,
      `Port ${wanted} is in use and ${suggestion} was declined.${NEWLINE}Retry with a port you choose:` +
        `${NEWLINE}${retryWithPort("<n>", retryCommand)}`,
      { port: wanted, suggestion }
    );
  return { port: suggestion, chosen: "offered" };
}

/* ============================================================== readiness ====================== */

/**
 * Poll the health endpoint until it proves it is this invocation's application, or refuse.
 *
 * ⚠️ **CHILD LIVENESS IS CHECKED EVERY ITERATION, NOT AT THE END.** A launcher that died at second
 * two would otherwise be discovered at second ninety, and the operator would read a readiness
 * timeout instead of the exit that caused it.
 *
 * ⚠️ **AN IDENTITY MISMATCH IS FATAL, NOT A REASON TO KEEP POLLING.** Something is answering this
 * port and it is not ours; waiting is waiting for it to change its mind. A CONNECTION failure is
 * different and is retried — nothing has answered yet.
 */
export async function awaitReadiness({
  port,
  expected,
  childAlive,
  childFault = () => null,
  host = HOST,
  deadlineMs = 90_000,
  intervalMs = 400,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  const url = `http://${host}:${port}${HEALTH_PATH}`;
  const until = now() + deadlineMs;
  let lastTransport = null;

  const gone = () =>
    new SupervisorRefusal(
      REFUSAL.LAUNCHER_EXITED,
      `The application launcher exited before readiness could be established. Its output is above; ` +
        `the supervisor stopped rather than waiting out its readiness timeout on a process that is gone.`,
      { url }
    );

  /**
   * ⚠️ **ONE ASSERTION, ASKED IN TWO PLACES, IN ONE ORDER.** Before polling and again at acceptance:
   * the success branch used to re-check liveness but not the fault, so a spawn failure raised while
   * the health request was in flight still produced `ready: true`. Two checks that are supposed to
   * be the same check must BE the same check.
   *
   * ⚠️ **"NEVER STARTED" AND "STARTED AND DIED" ARE DIFFERENT FAILURES.** A spawn error made
   * `childAlive()` false, so the launcher that could not be found was reported as one that had
   * exited — a refusal naming the wrong event, and the operator looking for output that never
   * existed. The fault is asked about first, and carries only a classification.
   */
  const assertChildHealthy = () => {
    const fault = childFault();
    if (fault)
      throw new SupervisorRefusal(
        REFUSAL.SPAWN_FAILED,
        `The application launcher could not be started (${fault}). Nothing was handed a port or a ` +
          `terminal, and no readiness was claimed.`,
        { url, code: fault }
      );
    if (!childAlive()) throw gone();
  };

  for (;;) {
    assertChildHealthy();

    let response = null;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
      response = { status: res.status, body: await res.json().catch(() => null) };
    } catch (e) {
      lastTransport = classifyError(e);
    }

    if (response) {
      // ⚠️ **ANY RESPONSE DECIDES; ONLY SILENCE IS RETRIED.** Nothing an answer can say about this
      // endpoint improves by asking again: its identity comes from a process environment fixed at
      // spawn and a package version fixed at install. Retrying a 503 turns missing propagation into
      // a readiness timeout, which is the same defect one layer up — a symptom reported in place of
      // its cause. The retry loop exists for the window before anything is listening.
      const verdict = matchHealth(expected, response.body);

      if (response.status === 200 && verdict.ok) {
        // ⚠️ **LIVENESS IS RE-CHECKED HERE, AT ACCEPTANCE, NOT ONLY AT THE TOP OF THE ITERATION.**
        // The launcher can die while this request is in flight, and a readiness claim made from a
        // reply whose sender has since exited is a fact about the past.
        assertChildHealthy();
        return {
          ready: true,
          url,
          // What was proved, named. `build` is deliberately absent: it agreed, and agreement between
          // two copies of `0.0.0` is not evidence.
          identityConfirmedBy: verdict.identityFields,
          buildCompared: verdict.buildCompared,
        };
      }

      // ⚠️ OUR OWN ENDPOINT SAYING IT HAS NO IDENTITY. The code is reported only when it is one this
      // module defines; anything else is described rather than quoted, because it came off the wire.
      if (response.status === 503 && isKilnHealthBody(response.body)) {
        const code = HEALTH_ERRORS.includes(response.body.error) ? response.body.error : null;
        throw new SupervisorRefusal(
          REFUSAL.NOT_IDENTIFIED,
          `The application is running but reports no usable identity` +
            (code ? ` (${code})` : ` (an error code this tool does not recognise)`) +
            `.
  ${url}${NEWLINE}` +
            `That does not improve with waiting: what it reports comes from an environment fixed when ` +
            `it started. Something in the chain that hands it the run identity is wrong.`,
          { url, code }
        );
      }

      // ⚠️ **FIELD NAMES ONLY, NEVER THE VALUES THAT CAME BACK.** Whatever is on this port is
      // untrusted, and it can put a path or a token in any field it likes. Naming the field is what
      // a reader needs; carrying the value would put a stranger's data into Kiln's diagnostics.
      const identityWrong = verdict.mismatches.filter((f) => f !== "build");
      if (identityWrong.length)
        throw new SupervisorRefusal(
          REFUSAL.IDENTITY_MISMATCH,
          `Something is answering ${url}, and it is not this run's application.${NEWLINE}` +
            `  disagreeing fields: ${identityWrong.join(", ")}${NEWLINE}` +
            `Refusing rather than reporting ready: a response that merely arrives proves nothing about ` +
            `who sent it. The values it returned are not repeated here — they came from whatever that is.`,
          { url, fields: identityWrong }
        );

      if (verdict.mismatches.includes("build"))
        throw new SupervisorRefusal(
          REFUSAL.BUILD_MISMATCH,
          `The application answering ${url} reports a different build than this tool checkout ` +
            `(expected ${JSON.stringify(expected.build)}; the value it returned is not repeated here).`,
          { url, fields: ["build"] }
        );

      throw new SupervisorRefusal(
        REFUSAL.NOT_READY,
        `${url} answered ${response.status} with nothing this tool recognises, so readiness cannot be ` +
          `established. Waiting would not change what it is.`,
        { url, status: response.status }
      );
    }

    if (now() >= until)
      throw new SupervisorRefusal(
        REFUSAL.NOT_READY,
        `Nothing answered ${url} within ${deadlineMs}ms.` + (lastTransport ? `
  last transport error: ${lastTransport}` : ``),
        { url, lastTransport }
      );
    await sleep(intervalMs);
  }
}

/* ============================================================== the run ======================== */

/** What an operator would actually re-run. Named once so every refusal quotes the same thing. */
export const DEFAULT_RETRY_COMMAND = "node .planning/bin/start-kiln.mjs";

/**
 * Any runtime failure reduced to a CLASSIFICATION, never its message.
 *
 * ⚠️ **THE BODY WAS REDACTED AND THE ERROR WAS NOT, WHICH LEFT THE SAME HOLE ONE STEP TO THE LEFT.**
 * A rejected `fetch` carries whatever text produced it — a URL with credentials in it, a path, or
 * anything a hostile listener can provoke — and that message was being printed and retained. A code
 * or an error name says everything a reader needs about why nothing answered, and is drawn from a
 * shape this module can check rather than from prose it cannot.
 */
const SAFE_CLASSIFICATION = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export function classifyError(e) {
  // `fetch` wraps the real reason: TypeError "fetch failed" with a `cause` carrying the code.
  for (const candidate of [e?.cause?.code, e?.code, e?.cause?.name, e?.name])
    if (typeof candidate === "string" && SAFE_CLASSIFICATION.test(candidate)) return candidate;
  return "unknown";
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

/**
 * Send the stop message, close the control pipe, and WATCH the launcher go.
 *
 * ⚠️ **THREE ACTS, EACH OBSERVED, BECAUSE THEY FAIL SEPARATELY.** That the launcher reacts to a stop
 * message and to a close is settled elsewhere; what is unproved until here is that the supervisor
 * performs the contract at all — and a supervisor that sends nothing looks identical to one that
 * does, on every occasion the launcher would have exited anyway.
 *
 * ⚠️ **BOUNDED IN BOTH DIRECTIONS.** Returning before the child is gone leaves a process holding the
 * port; waiting without a limit replaces a hung application with a hung terminal.
 */
export async function stopLauncher(child, { graceMs = 8000, hardMs = 3000, kill, log = () => {} } = {}) {
  const record = { sentStop: false, endRequested: false, exitObserved: false, escalated: false, stdinError: null };
  if (!child) return record;

  const stdin = child.stdin;
  if (stdin && !stdin.destroyed && !exited(child)) {
    // ⚠️ **AN EPIPE ARRIVES AS AN EVENT, NOT AS A THROW.** Writing to a pipe whose reader has gone
    // fails asynchronously, so `try/catch` around `write` catches nothing — the process would take
    // an unhandled 'error' instead. Listening first is what makes the failure a recorded fact.
    if (typeof stdin.once === "function")
      stdin.once("error", (e) => (record.stdinError ??= classifyError(e)));
    try {
      stdin.write("stop\n");
      record.sentStop = true;
    } catch (e) {
      record.stdinError ??= classifyError(e);
    }
    // ⚠️ **`endRequested`, NOT `closed`, AND THE NAME IS THE HONEST ONE.** `end()` asks the stream to
    // finish; the close completes later, and on a child that has already exited it may never be
    // acknowledged at all. What this can truthfully record is that the request was made. What proves
    // the launcher actually went is the exit below, which IS observed.
    try {
      stdin.end();
      record.endRequested = true;
    } catch (e) {
      record.stdinError ??= classifyError(e);
    }
  }

  const until = Date.now() + graceMs;
  while (!exited(child) && Date.now() < until) await sleep(50);

  if (!exited(child)) {
    record.escalated = true;
    log(`the launcher did not exit within ${graceMs}ms — killing`);
    (kill ?? ((c) => c.kill("SIGKILL")))(child);
    const hard = Date.now() + hardMs;
    while (!exited(child) && Date.now() < hard) await sleep(50);
  }

  record.exitObserved = exited(child);
  record.exitCode = child.exitCode;
  record.signal = child.signalCode;
  return record;
}

/**
 * The floor under any one waiting period, however little of the budget is left.
 *
 * ⚠️ **A KILL WITH NO TIME TO OBSERVE ITS EFFECT IS NOT A STOP, IT IS A GUESS.** Scaling every
 * period down to whatever remains reaches zero on exactly the runs that go badly — and a zero-length
 * hard period means signalling a process and recording, in the same instant, that it did not go. So
 * a spent budget still leaves each period this much, and the deadline can be overrun by at most one
 * floor per period rather than by a whole grace period per tree.
 */
export const SHUTDOWN_MIN_PHASE_MS = 250;

/**
 * What one waiting period gets out of the shutdown's SHARED budget.
 *
 * ⚠️ **ONE DEADLINE FOR THE WHOLE TEARDOWN, NOT ONE TIMER PER STEP.** Every step used to start its
 * own `graceMs` and `hardMs` from the moment it began: two descendant joins, then the agent tree,
 * then the launcher's control channel, then the launcher tree. Each bound was honoured and their sum
 * was not bounded at all. Against a process table that had stopped answering — which is not
 * hypothetical, an operator's Ctrl+Break wedges PowerShell — a teardown configured for 900ms was
 * measured at 48.8 SECONDS, on a terminal whose operator had just pressed Ctrl+C and is entitled to
 * it back. The periods are therefore shares of what is LEFT, in the same ratio the caller asked for,
 * so enumeration, stopping and escalation all spend one budget.
 */
export function shutdownPhase(deadline, { graceMs, hardMs, now = () => Date.now(), floorMs = SHUTDOWN_MIN_PHASE_MS } = {}) {
  const left = Math.max(0, deadline - now());
  const total = graceMs + hardMs;
  // ⚠️ THE FLOOR NEVER EXTENDS A PERIOD THE CALLER ASKED TO BE SHORTER than it. A test that asks
  // for a 200ms grace must get 200ms, not 250.
  const share = (ms) => {
    const scaled = total > 0 ? Math.round((left * ms) / total) : 0;
    return Math.max(Math.min(ms, floorMs), Math.min(ms, scaled));
  };
  return { graceMs: share(graceMs), hardMs: share(hardMs) };
}

/**
 * Stop everything this invocation started, keeping each observation its own.
 *
 * ⚠️ **SEVEN FACTS, SEVEN RECORDS (ACC-0081).** They fail separately, so they are reported separately —
 * and any one of them standing in for the others is precisely how a shutdown claim stops being
 * testable. A supervisor that asks one tree and not the other looks identical to a correct one on
 * every run where the unasked tree exits anyway.
 *
 * ⚠️ **THE AGENT GOES FIRST.** It owns the terminal; leaving it running while the background
 * launcher is torn down hands the operator a prompt attached to half a system.
 */
export async function shutdown({
  agent,
  launcher,
  ownedFiles = [],
  agentDescendants = null,
  launcherDescendants = null,
  signal = null,
  port = null,
  host = HOST,
  graceMs = 8000,
  hardMs = 3000,
  // ⚠️ **THE DEADLINE BELONGS TO THE TRIGGER, NOT TO THIS CALL.** The descendant joins happen
  // before this function is entered and are part of the same teardown an operator is waiting out, so
  // the caller starts the clock when Pi exits or the interrupt arrives and passes it in. Absent one,
  // the budget starts here — which is right for a direct caller, and is what every unit test does.
  deadline = null,
  now = () => Date.now(),
  platform,
  run,
  psRun,
  kill,
  createServerImpl,
  log = () => {},
} = {}) {
  // ⚠️ **ONE FACT, ONE REPRESENTATION.** `trigger` used to be a second, independently writable copy
  // of what `signal` already says, so `{trigger: "agent-exit", signal: "SIGINT"}` was accepted and
  // returned unchanged — a record that contradicts itself, which is worse than either half alone.
  const trigger = signal ? "signal" : "agent-exit";
  const budgetMs = graceMs + hardMs;
  const ends = deadline ?? now() + budgetMs;
  const startedAt = ends - budgetMs;
  const phase = () => shutdownPhase(ends, { graceMs, hardMs, now });
  const opts = { platform, run, psRun, kill, log };
  // ⚠️ THE SNAPSHOTS TAKEN WHILE THE CHILDREN LIVED. Without them an already-exited leader has no
  // tree anyone can name, and the ordinary Pi-exit shutdown would report a clean one.
  // ⚠️ THE AGENT IS NOT SPAWNED `detached` — it must stay in the terminal's foreground group to read
  // from it — so its tree is signalled directly. The launcher is, so its group can be targeted.
  const agentTree = await stopTree(agent, { ...opts, ...phase(), knownDescendants: agentDescendants });

  // ⚠️ THE LAUNCHER GETS ITS OWN CONTROL CHANNEL FIRST — a stop message and a closed pipe are what
  // it was built to answer.
  const launcherControl = await stopLauncher(launcher, { ...phase(), log });

  // ⚠️ **AND ITS TREE IS OBSERVED WHATEVER THE CONTROL CHANNEL SAID, WHICH IT WAS NOT.** The tree
  // treatment used to run only when the leader failed to exit, so the ordinary, POLITE shutdown —
  // the launcher accepting `stop` and going — never looked at the descendants tracked while it
  // lived. A `next start` worker that outlived its parent then permitted `complete: true` as long as
  // the port happened to rebind, which is the same defect the agent side already had: an exited
  // leader is not a stopped tree. The two facts are kept apart because they fail apart — a launcher
  // can answer its pipe perfectly and leave a worker behind.
  //
  // Asking an already-settled tree costs nothing: `stopTree` sends no signal when the leader has
  // exited and no tracked descendant is alive.
  const launcherTree = await stopTree(launcher, { ...opts, ...phase(), group: true, knownDescendants: launcherDescendants });

  const files = removeOwnedFiles(ownedFiles, { log });

  // ⚠️ **THE PORT IS ITS OWN OBSERVATION, AND IT WAS MISSING.** The criterion requires a free port,
  // and every other record here is about a process — `exitCode` says the leader is gone and says
  // nothing about a worker still listening. Rebinding is the only check that asks the question the
  // criterion actually poses.
  const portFree = port === null ? null : (await probePort(port, { host, createServerImpl })).free;

  // ⚠️ **AN OMITTED OBSERVATION IS NOT A PASSED ONE.** `portFree !== false` let a shutdown with no
  // port to check report itself complete, which is the criterion's mandatory rebinding clause
  // quietly skipped. What could not be observed is named, and naming anything makes the result
  // partial rather than complete.
  const notObserved = [];
  if (port === null) notObserved.push("port");
  if (agentTree.descendantsEnumerated === false) notObserved.push("agent-descendants");
  if (agentTree.descendantsSurviving?.length) notObserved.push("agent-descendants-survived");
  // ⚠️ THE LAUNCHER'S TWO NOW MIRROR THE AGENT'S. Only the enumeration failure was named before, and
  // only on the escalation path — so a KNOWN survivor, the more serious of the two, was reported
  // nowhere at all.
  if (launcherTree.descendantsEnumerated === false) notObserved.push("launcher-descendants");
  if (launcherTree.descendantsSurviving?.length) notObserved.push("launcher-descendants-survived");

  // ⚠️ **WHAT THE TEARDOWN ACTUALLY COST, RECORDED.** A shutdown that spent its whole budget
  // enumerating gave its later periods the floor and nothing more, and its record would otherwise
  // read identically to one that had all the time it asked for — the evidence silently describing a
  // degraded stop as an ordinary one.
  const spentMs = Math.max(0, now() - startedAt);

  return {
    trigger,
    signal,
    budget: { ms: budgetMs, spentMs, withinBudget: spentMs <= budgetMs },
    agent: agentTree,
    // The private control channel's answer, and the tree's, as two records because they are two
    // facts: `launcher.exitObserved` says the leader went, `launcherTree.treeStopped` says the tree did.
    launcher: launcherControl,
    launcherTree,
    files,
    portFree,
    notObserved,
    // ⚠️ A SINGLE VERDICT IS OFFERED, NOT SUBSTITUTED FOR THE PARTS. It is derived from them here so
    // no caller has to re-derive it, and every part stays readable beside it.
    complete:
      agentTree.treeStopped &&
      // ⚠️ THE TREE, NOT THE LEADER. `launcherControl.exitObserved` was accepted on its own and is a
      // fact about one process; the criterion is about both trees.
      launcherTree.treeStopped &&
      files.failed.length === 0 &&
      portFree === true &&
      notObserved.length === 0,
  };
}

/** The signals an operator or a supervisor of ours can send. `SIGBREAK` is Windows' Ctrl+Break. */
export const STOP_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]);

/**
 * Listen for an interrupt, and RECORD that it arrived where it was handled.
 *
 * ⚠️ **THE SIGNAL IS ITS OWN OBSERVATION, AND IT HAS TO BE.** Inferring "we were interrupted" from
 * the processes having gone is unfalsifiable: they exit on their own, all the time, for reasons that
 * have nothing to do with a signal. A supervisor with no handler at all would look identical on
 * every run where Pi happened to finish first. This records the fact at the only place it is true.
 *
 * @returns {{received: string|null, completion: Promise<any>|null, error: string|null, dispose: () => void}}
 */
export function watchForStop(onStop, { signals = STOP_SIGNALS, target = process } = {}) {
  // ⚠️ **ONE STABLE PROMISE, CREATED NOW, SETTLED BY THE FIRST SIGNAL.** `completion` used to be null
  // until a handler ran, so a run loop that established `Promise.race([agentExit, completion])`
  // before any signal raced against `null` — which resolves immediately, making the race meaningless
  // in exactly the arrangement it exists for. It is pending from the moment this returns.
  let settle;
  let fail;
  const completion = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const state = { received: null, completion, error: null, dispose: () => {} };
  // Handled here so an un-awaited rejection cannot crash the process mid-teardown; a caller that
  // does await `completion` still sees it reject.
  completion.catch((e) => (state.error = classifyError(e)));
  const handlers = [];
  for (const signal of signals) {
    const handler = () => {
      // ⚠️ FIRST ONE WINS. A second Ctrl+C during a bounded shutdown must not restart it.
      if (state.received) return;
      state.received = signal;
      // ⚠️ **ONE SIGNAL, ONE OWNED COMPLETION.** `void onStop(signal)` captured neither a synchronous
      // throw nor the returned promise, so a shutdown that failed became an unhandled rejection and
      // the run loop had nothing to await. The promise is kept for a caller to race and await; a
      // second listener records the failure so an un-awaited rejection is still handled rather than
      // crashing the process mid-teardown.
      try {
        Promise.resolve(onStop(signal)).then(settle, fail);
      } catch (e) {
        fail(e);
      }
    };
    try {
      target.on(signal, handler);
      handlers.push([signal, handler]);
    } catch {
      // ⚠️ NOT EVERY SIGNAL EXISTS EVERYWHERE — `SIGBREAK` is Windows-only, `SIGHUP` is not. Failing
      // to register one is not a reason to register none.
    }
  }
  state.dispose = () => {
    for (const [signal, handler] of handlers) {
      try {
        target.removeListener(signal, handler);
      } catch {}
    }
  };
  return state;
}

/**
 * Whether a pid is still there.
 *
 * ⚠️ **`EPERM` MEANS IT EXISTS AND IS NOT OURS**, which is still "alive" for the purpose of deciding
 * whether a tree went. Treating it as gone is how a survivor gets reported as a clean teardown.
 */
export function pidAlive(pid, { kill } = {}) {
  const send = kill ?? ((p, sig) => process.kill(p, sig));
  try {
    send(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/**
 * The descendants of a process, deepest first, on a platform with no process group to signal.
 *
 * ⚠️ **A FOREGROUND CHILD CANNOT BE A GROUP LEADER, SO ITS TREE HAS TO BE FOUND RATHER THAN NAMED.**
 * `detached` is what creates a group, and a detached process cannot read the terminal — it takes
 * SIGTTIN — so the agent must stay in the foreground group and `kill(-pid)` is unavailable for it.
 * Signalling the agent alone is not stopping the agent's TREE, and a child it spawned can outlive
 * it. On Windows `taskkill /T` already walks the tree; this is the POSIX half of the same job.
 *
 * ⚠️ **ENUMERATION CAN FAIL, AND THEN IT SAYS SO.** `ps` may be absent or restricted. Reporting an
 * empty list would claim a tree with no descendants, which is exactly the false clean bill this
 * whole record exists to avoid.
 *
 * @returns {{pids: number[], enumerated: boolean, error: string|null}}
 */
export const PROCESS_TABLE_COMMAND = Object.freeze({
  // ⚠️ **`ps` IS NOT ON WINDOWS, AND THIS FUNCTION USED TO ASK FOR IT THERE ANYWAY.** Every unit test
  // injects the process lister, so nothing noticed until the first run against a real platform: on
  // Windows the enumeration failed on every call, `descendantsEnumerated` was false for both trees,
  // and no descendant could ever be known. That is precisely what ACC-0081's clause 7 asks each
  // platform's observation to include, and it is why the criterion refuses to let one platform's
  // pass stand for the other's.
  posix: ["ps", ["-A", "-o", "pid=,ppid="]],
  // ⚠️ **CIM, NOT `wmic`.** `wmic` was the obvious answer and is being removed from Windows — absent
  // on the Windows 11 build this was measured on — so it would have worked on the author's machine
  // for exactly as long as that lasted. `Get-CimInstance` is the supported route and is present
  // wherever PowerShell is, which on Windows is everywhere.
  win32: [
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }",
    ],
  ],
});

/**
 * How long a process table has to answer.
 *
 * ⚠️ MEASURED AGAINST THE THING IT BOUNDS, not chosen as a round number: `ps` answers in
 * milliseconds and the Windows CIM query in about 1.4 seconds, so ten is far outside the ordinary
 * cost and short enough that a wedged query cannot outlast a grace period.
 */
export const PROCESS_TABLE_TIMEOUT_MS = 10_000;

/**
 * How much of a shutdown's budget the descendant enumeration may spend.
 *
 * ⚠️ **A THIRD, BECAUSE THE OTHER TWO THIRDS ARE THE PART THE CRITERION IS ABOUT.** Enumeration
 * is what makes the stop able to name a survivor, so it cannot be skipped; it is also not the stop.
 * At the default 8s + 3s that is a shade under four seconds for a query measured at 1.4 — room for
 * one in flight and one more — and on a badly wedged process table it is four seconds the trees
 * still have to go quietly in.
 */
export const ENUMERATION_BUDGET_SHARE = 1 / 3;

export function descendantsOf(pid, { run, platform = process.platform } = {}) {
  const exec = run ?? ((cmd, args) => spawnSync(cmd, args, { encoding: "utf-8", timeout: PROCESS_TABLE_TIMEOUT_MS }));
  const [cmd, args] = PROCESS_TABLE_COMMAND[platform === "win32" ? "win32" : "posix"];
  let out;
  try {
    out = exec(cmd, args);
  } catch (e) {
    return { pids: [], enumerated: false, error: classifyError(e) };
  }
  if (!out || out.status !== 0 || typeof out.stdout !== "string")
    return { pids: [], enumerated: false, error: out?.error ? classifyError(out.error) : `${cmd}-failed` };

  return walkTree(out.stdout, pid);
}

/**
 * The descendants of `pid` in a `pid ppid` table, deepest first.
 *
 * ⚠️ **DEEPEST FIRST, so a parent is never signalled before the children it might otherwise
 * re-parent away.** Extracted so the synchronous and asynchronous readers cannot disagree about what
 * a process table means — two walks would drift, and the one that drifted would be the one nobody
 * was looking at.
 */
function walkTree(stdout, pid) {
  const children = new Map();
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const [, child, parent] = m;
    const key = Number(parent);
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(Number(child));
  }

  // Breadth-first from the root, then reversed: deepest first, so a parent is never signalled before
  // the children it might otherwise re-parent away.
  const order = [];
  const queue = [Number(pid)];
  const seen = new Set(queue);
  while (queue.length) {
    const next = queue.shift();
    for (const c of children.get(next) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      order.push(c);
      queue.push(c);
    }
  }
  return { pids: order.reverse(), enumerated: true, error: null };
}

/**
 * The same question, asked without blocking the event loop.
 *
 * ⚠️ **BECAUSE ON WINDOWS THE ANSWER COSTS A POWERSHELL START — about 1.4 seconds, measured.** The
 * tracker polls for the whole of an agent session, and `spawnSync` at that price would leave the
 * supervisor blocked a large fraction of the time: an operator's Ctrl+C would sit unhandled until
 * the current query returned. The poll is a diagnostic; it must never be the reason the process is
 * unresponsive.
 *
 * ⚠️ AN INJECTED `run` MAY BE SYNCHRONOUS OR NOT. Tests hand it a plain object, production hands it
 * a promise, and `await` treats them alike — so the seam does not force every caller to become
 * asynchronous to describe a process table.
 */
export async function descendantsOfAsync(pid, { run, platform = process.platform } = {}) {
  const [cmd, args] = PROCESS_TABLE_COMMAND[platform === "win32" ? "win32" : "posix"];
  const exec =
    run ??
    ((c, a) =>
      new Promise((resolve) => {
        // ⚠️ **BOUNDED, AND KILLED IF IT OVERRUNS — MEASURED, NOT PRECAUTIONARY.** A process table is
        // an external program, and on Windows it is PowerShell: an operator's Ctrl+Break reaches
        // every process in the console, and PowerShell answers Ctrl+Break by breaking into its
        // debugger, so a query already in flight never returns. Six supervisors were left hung on
        // exactly that, each holding a wedged `powershell` child, and the shutdown they were in the
        // middle of is the one ACC-0081 requires to be BOUNDED. A query that overruns is killed and
        // reported as an enumeration that failed, which is a fact; waiting for it is a hang.
        execFile(
          c,
          a,
          { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, timeout: PROCESS_TABLE_TIMEOUT_MS },
          (error, stdout) => resolve(error ? { status: error.code ?? 1, stdout: "", error } : { status: 0, stdout })
        );
      }));

  let out;
  try {
    out = await exec(cmd, args);
  } catch (e) {
    return { pids: [], enumerated: false, error: classifyError(e) };
  }
  if (!out || out.status !== 0 || typeof out.stdout !== "string")
    return { pids: [], enumerated: false, error: out?.error ? classifyError(out.error) : `${cmd}-failed` };

  return walkTree(out.stdout, pid);
}

/**
 * Keep a running record of a child's descendants WHILE IT IS STILL ALIVE.
 *
 * ⚠️ **BY THE TIME A LEADER HAS EXITED, ITS CHILDREN ARE NO LONGER ITS CHILDREN.** The normal end of
 * a run is Pi finishing on its own, so the shutdown reaches the agent with the leader already gone —
 * and `ps` then shows any surviving child re-parented to init, related to nothing this supervisor
 * can name. Enumerating at teardown finds an empty tree and reports a clean one. The snapshot has to
 * be taken while the relationship is still visible.
 *
 * ⚠️ **THE UNION, NOT THE LATEST.** A child that came and went is simply not alive at settle time;
 * a child seen once and still running is the whole point. Keeping only the last sample would lose
 * anything that started and finished between two polls.
 *
 * ⚠️ **PID REUSE IS A NAMED RESIDUAL.** A pid recorded here could, in principle, be recycled by an
 * unrelated process before the shutdown looks at it. Nothing portable distinguishes them from
 * userspace. The window is the seconds between the leader exiting and the grace period ending, and
 * the alternative — leaving a process of ours holding the port — is the failure the criterion is
 * actually about.
 */
/**
 * ⚠️ **WINDOWS POLLS FAR MORE SLOWLY, BECAUSE ITS PROCESS TABLE COSTS A POWERSHELL START.** Measured
 * at roughly 1.4 seconds a call, against a few milliseconds for `ps` — so a 500ms interval there
 * would run the query back to back for the whole of an agent session and pin a core for a
 * diagnostic. The poll is not what makes the observation correct in any case: the forced sample
 * immediately before the shutdown is, and it runs whatever the interval was. The poll only catches a
 * child that appears and disappears mid-run.
 */
export const TRACK_INTERVAL_MS = Object.freeze({ posix: 500, win32: 3000 });

export function trackDescendants(
  child,
  { psRun, platform = process.platform, intervalMs = TRACK_INTERVAL_MS[platform === "win32" ? "win32" : "posix"], now = () => Date.now() } = {}
) {
  const seen = new Set();
  // ⚠️ **THREE FACTS ABOUT THE LOOKS, NOT ONE FLAG.** A query that could not be RUN and a query whose
  // answer arrived too late are different failures, and one of them is ordinary: the run's normal end
  // is the agent exiting, which is exactly when a poll already in flight becomes unusable.
  let failed = 0; // looks whose process table could not be read or parsed at all
  let clean = 0; // looks that completed while the leader was still alive
  let raced = 0; // looks whose answer arrived after the leader had gone
  let unresolved = 0; // looks still in flight when the shutdown stopped waiting for them
  let timer = null;
  let inFlight = null;
  let stopped = null;

  const sample = async () => {
    // ⚠️ ONE QUERY AT A TIME. On Windows a sample outlasts a short interval, and starting a second
    // while the first is running would multiply the cost of the thing that is already the expensive
    // part. A sample that arrives while one is in flight joins it rather than adding to it.
    //
    // ⚠️ **AND THE JOIN COMES BEFORE THE EXITED-LEADER RETURN, WHICH IT DID NOT.** Ordered the other
    // way, a leader that died while an interval query was in flight made `stop()` return at once —
    // so the shutdown read a snapshot still saying `enumerated: true`, and the query settled a
    // moment later and marked it unmade, after the decision had been taken on the earlier answer.
    // An exited leader is a reason not to START a query; it is not a reason to walk away from one
    // already running, which is precisely the query whose result is about to be doubted.
    if (inFlight) return inFlight;
    if (!child || exited(child)) return;
    inFlight = descendantsOfAsync(child.pid, { run: psRun, platform }).then((found) => {
      // ⚠️ **A SAMPLE THE LEADER DID NOT SURVIVE DESCRIBES SOMEBODY ELSE'S CHILDREN.** Reading a
      // process table is not instant — on Windows it is well over a second — and if the leader died
      // while the query was in flight, its children have been re-parented by the time the answer
      // arrives. The table then honestly shows it with no children, and taking that at face value is
      // the empty list that claims a tree with no children, which is exactly what clause 7 forbids.
      // So its answer is DISCARDED and the look is counted as raced.
      //
      // ⚠️ **AND A RACED LOOK IS NOT THE SAME AS A FAILURE TO ENUMERATE, WHICH IS WHAT IT USED TO
      // BE.** Marking the whole tree unmade for it read well and was measurably wrong: the ordinary
      // end of a run is the agent exiting on its own, a Windows process table costs about 1.4s
      // against a 3s poll, so roughly half of all normal Windows shutdowns raced their last look —
      // and every one of them reported the run INCOMPLETE and refused, with the tree enumerated,
      // reached and stopped. What the criterion forbids is claiming an enumeration that never
      // happened; a union built from looks taken while the leader lived is exactly that enumeration,
      // and this one added nothing to it. `enumerated` therefore means "at least one look completed
      // while the leader was alive" — a tree whose looks ALL raced, failed or never came back is
      // still reported unmade, which is the case clause 7 is about, and the counts of each are in
      // the snapshot so a later look that failed is visible rather than silently forgiven. The same
      // reasoning applies to a failed look as to a raced one: an interrupt reaches the process table
      // program too, and a query it cancelled does not unmake the ones that answered.
      if (exited(child)) {
        raced += 1;
        inFlight = null;
        return;
      }
      if (found.enumerated) clean += 1;
      else failed += 1;
      for (const pid of found.pids) seen.add(pid);
      inFlight = null;
    });
    return inFlight;
  };

  const first = sample();
  if (child && !exited(child)) {
    // ⚠️ NOT AWAITED HERE, AND UNREFFED. The poll is a diagnostic: it must neither delay the caller
    // that started the tracking nor be the reason the process stays alive.
    timer = setInterval(sample, intervalMs);
    timer.unref?.();
  }

  return {
    sample,
    // ⚠️ THE LOOKS ARE PART OF THE SNAPSHOT, because the record is the evidence: a shutdown that
    // acted while a query was still in flight would otherwise report the same thing as one that
    // waited for it. `stop()` joins that query, so the counts a caller reads are final.
    snapshot: () => ({ pids: [...seen], enumerated: clean > 0, looks: { clean, raced, failed, unresolved } }),
    /**
     * ⚠️ **AWAITED, AND IT TAKES ONE LAST LOOK.** This runs immediately before the shutdown reads the
     * snapshot, which is the last moment the leader may still be alive and therefore the last moment
     * the process table can relate anything to it.
     */
    stop: async ({ joinMs = PROCESS_TABLE_TIMEOUT_MS + 2000 } = {}) => {
      // ⚠️ **STOPPING IS A ONE-TIME ACT, AND SAYING SO WAS NOT ENOUGH.** The run loop's `finally`
      // calls this again on every path, described there as idempotent because the timer is already
      // null — but the last look below is NOT a timer, and a second call started a second query and
      // waited out a second join. With a process table that had stopped answering that was two full
      // joins after the teardown had finished, measured at 24 seconds, outside the shutdown's
      // deadline entirely because it happens after the shutdown returns. A tracker that has been
      // stopped has taken its last look; there is no later moment whose answer could be about the
      // leader, because the leader is gone.
      if (stopped) return stopped;
      stopped = (async () => {
        if (timer) clearInterval(timer);
        timer = null;
        // ⚠️ **JOINED, BUT NOT WAITED ON FOR EVER.** Joining an in-flight query is what keeps the
        // shutdown from acting on a snapshot that is about to change; waiting for one that never
        // answers is a hung terminal, which is the failure the whole bounded escalation exists to
        // avoid. The supplied `psRun` seam means this cannot be left to the default runner's own
        // timeout: a caller's lister owes this module nothing. A look that has not come back when the
        // bound expires is counted as unresolved — not as an absence, and not as a reason to wait.
        const pending = (async () => {
          await first.catch(() => {});
          await sample();
        })();

        // ⚠️ **AND THIS TIMER IS NOT UNREFFED, WHICH IT WAS.** The poll above is unreffed because a
        // diagnostic must not be the reason a process stays alive; this one is the opposite — it is
        // the only thing that ENDS a join, so a loop with nothing else in it must stay awake for it.
        // Unreffed, a join whose query never answers was left with no live handle at all: node
        // considered the loop drained and the shutdown simply stopped there, mid-teardown, with no
        // file cleanup, no record and no refusal. Measured as `exit=13, unsettled top-level await`
        // in isolation, and as three failing tests on node 22 in CI, green on node 24 only because
        // the rest of the suite happened to keep the loop alive. It is cleared the moment the race
        // settles, so it holds the process for the join window and not a millisecond longer.
        let timeout;
        const expired = Symbol("expired");
        const bound = new Promise((resolve) => {
          timeout = setTimeout(() => resolve(expired), joinMs);
        });
        const outcome = await Promise.race([pending.then(() => null).catch(() => null), bound]);
        clearTimeout(timeout);
        if (outcome === expired) unresolved += 1;
      })();
      return stopped;
    },
  };
}

/**
 * Stop one process TREE, and report what was actually seen.
 *
 * ⚠️ **A TREE, NOT A PROCESS, AND THE TWO CHILDREN BOTH HAVE ONE.** `next start` spawns workers and
 * an agent spawns whatever it is asked to; signalling the pid this supervisor holds leaves those
 * behind, still on the port or still on the terminal. On Windows `taskkill /T` is both the request
 * and the escalation because there is no graceful signal to send; on POSIX the request is SIGTERM to
 * the process GROUP and the escalation is SIGKILL to the same group.
 *
 * ⚠️ **THE PLATFORMS DIFFER IN THE ONLY MECHANISM THAT MATTERS HERE**, which is why ACC-0081 refuses
 * to let one platform's result stand for the other. A Windows pass says nothing about whether a
 * POSIX process group was signalled correctly, and the reverse says nothing about `taskkill`.
 *
 * @returns {{requested: boolean, exitObserved: boolean, escalated: boolean, method: string|null, error: string|null}}
 */
export async function stopTree(
  child,
  {
    graceMs = 8000,
    hardMs = 3000,
    platform = process.platform,
    group = false,
    knownDescendants = null,
    run,
    psRun,
    kill,
    log = () => {},
  } = {}
) {
  const record = {
    requested: false,
    exitObserved: false,
    escalated: false,
    method: null,
    error: null,
    descendants: null,
    descendantsEnumerated: null,
    // ⚠️ HOW THE ENUMERATION WENT, not only whether it counted. A tree enumerated by two clean looks
    // and one that raced the leader's exit is a different observation from one enumerated by a
    // single look, and ACC-0081 is a criterion about what was actually observed.
    descendantLooks: null,
    descendantsSurviving: null,
    treeStopped: false,
  };
  if (!child) return record;
  // ⚠️ **AN EXITED LEADER IS NOT A STOPPED TREE, AND THIS RETURNED TRUE FOR IT.** The normal end of a
  // run is Pi finishing on its own, so this is the path the ordinary shutdown takes — enumeration
  // skipped, no signal sent, a surviving child silently accepted. It now falls through to the same
  // observation as every other case, using the descendants tracked while the leader was alive,
  // because `ps` can no longer relate them to anything once the parent is gone.
  const alreadyExited = exited(child);

  const spawnKill = run ?? ((cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }));
  const killImpl = kill ?? ((p, sig) => process.kill(p, sig));
  const known = knownDescendants
    ? { pids: knownDescendants.pids ?? [], enumerated: knownDescendants.enumerated !== false, tracked: true }
    : { pids: [], enumerated: true, tracked: false };
  // ⚠️ **SET ON EVERY PATH, AND IT WAS SET ON ONE.** Putting this beside the enumeration inside
  // `resolveDescendants` left it null for the case that matters most: a leader that had ALREADY
  // exited takes the branch below and never calls it — which is the ordinary end of a run, so the
  // record said nothing about how its tree was looked at exactly when the looks were most likely to
  // have raced. It depends only on the snapshot, so it is recorded where the snapshot arrives.
  record.descendantLooks = knownDescendants?.looks ?? null;
  // ⚠️ RESOLVED ONCE, BEFORE THE PLATFORM BRANCH, because both platforms need the same list and only
  // one of them used to have it. `record.descendants` was filled inside the POSIX branch, so on
  // Windows the tracked survivors were never even named — let alone targeted.
  const resolveDescendants = () => {
    if (record.descendants !== null) return;
    // ⚠️ WHAT WAS TRACKED WHILE THE LEADER LIVED IS PREFERRED, because it is the only record that
    // can still relate a survivor to this run. A fresh look is the fallback for a caller that
    // tracked nothing.
    const found = known.pids.length || known.tracked ? known : descendantsOf(child.pid, { run: psRun, platform });
    record.descendants = found.pids;
    record.descendantsEnumerated = found.enumerated;
    if (!found.enumerated) record.error ??= found.error;
  };

  const ask = (hard) => {
    resolveDescendants();
    if (platform === "win32") {
      // ⚠️ NO GRACEFUL REQUEST EXISTS. `process.kill(pid, "SIGTERM")` is `TerminateProcess`: a hard
      // kill no handler ever sees. `/T` is what reaches the workers.
      record.method = "taskkill /T /F";
      spawnKill("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      // ⚠️ **AND EACH TRACKED SURVIVOR DIRECTLY, BECAUSE `/T` REACHES A TREE ONLY WHILE ITS ROOT IS
      // THERE.** Once the parent has exited, `taskkill /pid <parent> /T` has nothing to walk and the
      // workers it left behind are untouched — which is precisely the case the tracked snapshot
      // exists for. Each one is asked by its own pid; a pid that has already gone is a taskkill that
      // finds nothing, which costs a process spawn and nothing else.
      for (const pid of record.descendants) spawnKill("taskkill", ["/pid", String(pid), "/T", "/F"]);
      return;
    }
    // ⚠️ **A GROUP ONLY EXISTS IF THE CHILD WAS SPAWNED `detached`.** Without it the child sits in
    // THIS process's group, and `kill(-pid)` would signal the supervisor and the operator's shell
    // along with it. So the group form is used only where a group was actually created — the
    // background launcher — and the foreground agent, which must stay in the terminal's foreground
    // group to read from it at all, is signalled directly.
    const signal = hard ? "SIGKILL" : "SIGTERM";
    record.method = `${signal} to ${group ? "the group" : "the process and its descendants"}`;
    if (!group) {
      // ⚠️ **THE DESCENDANTS FIRST, DEEPEST FIRST.** Signalling only the child leaves whatever it
      // spawned, which is not "the tree was stopped" however the leader's exit code reads.
      //
      // ⚠️ ENUMERATED ONCE AND REUSED. The escalation pass re-signals the SAME snapshot rather than
      // asking again: by then the parent may be gone, and a fresh `ps` would no longer show its
      // children as descendants of anything this function knows about.
      for (const pid of record.descendants) {
        try {
          killImpl(pid, signal);
        } catch (e) {
          if (e?.code !== "ESRCH") record.error ??= classifyError(e);
        }
      }
    }
    // ⚠️ **A GROUP OUTLIVES ITS LEADER, BUT NOT EVERY SURVIVOR IS STILL IN IT.** A worker that called
    // `setsid`, or that was re-parented, is reachable only by its own pid — so the tracked list is
    // signalled here too rather than trusting the group to contain everything it once did.
    if (group)
      for (const pid of record.descendants) {
        try {
          killImpl(pid, signal);
        } catch (e) {
          if (e?.code !== "ESRCH") record.error ??= classifyError(e);
        }
      }
    try {
      killImpl(group ? -child.pid : child.pid, signal);
    } catch (e) {
      // A group that has already gone is ESRCH; anything else is worth reporting.
      if (e?.code !== "ESRCH") record.error ??= classifyError(e);
      try {
        child.kill(signal);
      } catch {}
    }
  };

  // ⚠️ A TREE THAT WAS ALREADY GONE IS RECORDED AS SUCH AND IS NOT ASKED (ACC-0081, clause 2). Its
  // descendants are still observed — that is the point of falling through.
  if (alreadyExited) {
    record.descendants = known.pids;
    record.descendantsEnumerated = known.enumerated;
  } else {
    ask(false);
    record.requested = true;
  }

  // ⚠️ **THE SNAPSHOT IS KEPT AND EVERY PID IN IT IS WATCHED.** Waiting on the leader alone reports
  // a stopped tree the moment the parent goes — while an enumerated descendant is still running, and
  // with escalation skipped because the only thing being watched had already exited. A survivor is
  // exactly what "the tree was stopped" is supposed to rule out.
  const watched = record.descendants ?? [];
  const survivors = () => watched.filter((pid) => pidAlive(pid, { kill: killImpl }));
  const settled = () => exited(child) && survivors().length === 0;

  const until = Date.now() + graceMs;
  while (!settled() && Date.now() < until) await sleep(50);

  if (!settled()) {
    record.escalated = true;
    log(`a process tree did not exit within ${graceMs}ms — escalating`);
    // ⚠️ SURVIVORS ARE ESCALATED EVEN AFTER THE PARENT HAS GONE. `ask(true)` re-signals the whole
    // snapshot; a leader that already exited is an ESRCH nobody needs to hear about.
    ask(true);
    const hard = Date.now() + hardMs;
    while (!settled() && Date.now() < hard) await sleep(50);
  }

  // ⚠️ REPORTED, NOT ASSUMED. A tree that still has not gone is said so rather than counted as gone,
  // and the leader's exit and the tree's are recorded as the different facts they are.
  record.exitObserved = exited(child);
  record.descendantsSurviving = watched.length ? survivors() : [];
  record.treeStopped = record.exitObserved && record.descendantsSurviving.length === 0;
  return record;
}

/**
 * Remove the runtime files THIS invocation created, and nothing else.
 *
 * ⚠️ **THE LIST IS WHAT WAS CREATED, NOT WHAT MATCHES A PATTERN.** A glob over the runtime directory
 * would take the session record, a concurrent run's file, or anything an operator left there — and
 * would do it most reliably on the day something else was mid-write. Each path is recorded when this
 * process writes it, so removal is a fact about authorship rather than about naming.
 */
export function removeOwnedFiles(paths, { log = () => {} } = {}) {
  const removed = [];
  const failed = [];
  for (const path of paths) {
    try {
      if (existsSync(path)) {
        unlinkSync(path);
        removed.push(path);
      }
    } catch (e) {
      failed.push({ path, code: classifyError(e) });
      log(`could not remove ${path}: ${classifyError(e)}`);
    }
  }
  return { removed, failed };
}

/**
 * The file that says A RUN OF THIS PROJECT BELIEVES IT IS LIVE, and the only file this invocation
 * creates.
 *
 * ⚠️ **IT EXISTS SO THE RUNTIME DIRECTORY CAN BE READ BY A PERSON, and it is removed at shutdown
 * because that is what makes its presence mean anything.** A run holds a port and two process trees
 * and, until this, left nothing behind saying which run that was: an operator finding something on
 * 127.0.0.1:3000 had the port and no way back to the run id in the log. The name carries the run id;
 * the body carries the pid, the port and the start time for the same reader.
 *
 * ⚠️ **IT IS DELIBERATELY NOT ONE OF DEC-0033'S FIVE PERSISTED RUNTIME RECORDS.** Those are
 * contracts Kiln writes, versions and READS BACK, which is why they carry schemas. This one is not
 * read back by anything — a leftover is reported by NAME, not parsed — and it is meant to be gone by
 * the time the process that wrote it has exited. Giving it a schema would claim a shape nothing
 * depends on; parsing it would make a crashed run's half-written file a startup failure.
 */
const RUN_FILE_PREFIX = "run-";
const RUN_FILE_SUFFIX = ".json";

/**
 * The one name this invocation may own, and the check that the name is one.
 *
 * ⚠️ **A RUN ID IS 32 LOWERCASE HEX CHARACTERS, AND IT IS CHECKED HERE RATHER THAN TRUSTED.** The
 * id arrives from `generateRunId`, which cannot produce anything else — but this function is exported
 * and composes a PATH from it, and a path composed from an unvalidated string is a traversal
 * whatever today's only caller happens to pass. Measured before this check existed:
 * `runFilePath(runtime, "x/../../escaped")` resolved two directories ABOVE the runtime directory,
 * and the shutdown would then have deleted whatever was there as a file this run created.
 *
 * ⚠️ **AND CONTAINMENT IS PROVED, NOT ARGUED FROM THE SHAPE.** The id being safe says nothing
 * about `runtimeDir`: a junction at `<state>/runtime` puts the composed path somewhere else
 * entirely, which is the same attack `canonicalPath` exists for everywhere else in this file.
 */
const RUN_ID_SHAPE = /^[0-9a-f]{32}$/;
const RUN_FILE_NAME = /^run-[0-9a-f]{32}\.json$/;

export function runFilePath(runtimeDir, runId) {
  if (typeof runId !== "string" || !RUN_ID_SHAPE.test(runId))
    throw new SupervisorRefusal(
      REFUSAL.RUN_FILE_UNSAFE,
      `A run file is named after a run id — 32 lowercase hex characters — and this is not one.`,
      { runId: typeof runId === "string" ? runId.slice(0, 64) : typeof runId }
    );
  const dir = canonicalPath(runtimeDir);
  const path = canonicalPath(join(dir, `${RUN_FILE_PREFIX}${runId}${RUN_FILE_SUFFIX}`));
  if (!isAtOrInside(path, dir) || pathIdentityKey(path) === pathIdentityKey(dir))
    throw new SupervisorRefusal(REFUSAL.RUN_FILE_UNSAFE, `${runtimeDir} does not contain the run file named for ${runId}.`, {
      path,
      runtimeDir: dir,
    });
  return path;
}

export function writeRunFile(
  runtimeDir,
  { runId, projectId, pid = process.pid, host = HOST, port, now = () => new Date(), log = () => {} }
) {
  // ⚠️ **THE DIRECTORY IS NOT CREATED HERE, AND ITS ABSENCE IS NOT A REFUSAL.** Making the state
  // directories is setup's work, under the transaction that owns the project lock; a supervisor that
  // created one would be the second writer of a layout that has exactly one owner. A project whose
  // runtime directory was removed after setup still starts — it simply records no live-run file, and
  // says so — because the run is not less valid for having nowhere to leave a breadcrumb.
  if (!existsSync(runtimeDir)) {
    log(`${runtimeDir} does not exist, so this run leaves no run file there; re-run setup to restore it`);
    return null;
  }
  const path = runFilePath(runtimeDir, runId);
  // ⚠️ **CREATED EXCLUSIVELY, AND OWNED ONLY BECAUSE THE CREATION SUCCEEDED.** An ordinary
  // `writeFileSync` OVERWRITES, so a file already at this exact name — an operator's, or a run whose
  // id collided — was silently replaced and then added to `ownedFiles`, which is the shutdown
  // DELETING A FILE THIS INVOCATION DID NOT CREATE. That is precisely what clause 6 forbids, and the
  // list of owned paths cannot be the thing that proves authorship if a path can join it by having
  // been written over. `wx` makes the filesystem answer "did I create this?", and nothing else does:
  // a stat-then-write would answer it for a moment that has already passed.
  try {
    writeFileSync(
      path,
      JSON.stringify({ runId, projectId, pid, host, port, startedAt: now().toISOString() }, null, 2) + NEWLINE,
      { encoding: "utf-8", flag: "wx" }
    );
  } catch (e) {
    // ⚠️ **AND A BREADCRUMB THAT COULD NOT BE LEFT DOES NOT END THE RUN.** It is a diagnostic for
    // an operator, not a contract anything reads back; refusing to start a session because a
    // read-only directory or an occupied name would make the note more important than the work.
    // What must not happen is the run treating somebody else's file as its own, and returning null
    // is exactly that: unowned, so untouched at shutdown.
    log(
      classifyError(e) === "EEXIST"
        ? `${path} already exists and was NOT written or claimed by this run; it is left untouched`
        : `${path} could not be written (${classifyError(e)}), so this run leaves no run file`
    );
    return null;
  }
  return path;
}

/**
 * The run files of earlier runs, by name.
 *
 * ⚠️ **REPORTED AND LEFT ALONE.** A leftover is a run that did not complete its shutdown — the
 * exact failure ACC-0081 is about — so it is worth an operator's attention. Removing one is not this
 * invocation's to do: another Kiln may be running in this project right now, and a supervisor that
 * tidies the runtime directory is the glob that clause 6 exists to forbid.
 *
 * ⚠️ **THE WHOLE NAME MUST BE A RUN FILE'S, NOT ITS TWO ENDS.** Prefix-and-suffix matching put
 * any `run-*.json` an operator or another tool had left there into Kiln's log as a run that failed
 * to shut down — a report about somebody else's file, in an operator-controlled name, in a message
 * that says something went wrong. What this reports is the exact grammar this module writes.
 */
export function leftoverRunFiles(runtimeDir) {
  let names = [];
  try {
    names = readdirSync(runtimeDir);
  } catch {
    return []; // no directory yet is no leftovers, not an error
  }
  return names.filter((n) => RUN_FILE_NAME.test(n)).sort();
}


/**
 * Start the application launcher and Pi, and own both until Pi exits.
 *
 * @param {object} deps
 * @param {string} deps.projectRoot                 canonical outer project root
 * @param {{command: string, args: string[]}} deps.launcher
 * @param {{command: string, args: string[]}} deps.agent
 * @param {(command: string, args: string[], options: object) => object} [deps.spawn]
 */
export async function runSupervisor(deps) {
  const {
    projectRoot,
    launcher,
    agent,
    spawn,
    env = process.env,
    interactive = false,
    ask = async () => false,
    // ⚠️ THE MODE COMES FROM THE INVOCATION, NOT FROM THE COMMITTED RECORD. `.pi/kiln.json` is
    // committed and shared; which machine keeps its transcripts where is host-specific, so recording
    // it there would make one operator's choice everyone's. DEC-0029 calls external state "an
    // explicit mode" for exactly that reason, and project-local is the default it is explicit against.
    stateMode = STATE_MODE.PROJECT,
    randomBytes,
    validators,
    log = () => {},
    host = HOST,
    readyMs = 90_000,
    graceMs = 8000,
    hardMs = 3000,
    build = toolVersion(),
    toolRoot,
    selfHost = false,
    // ⚠️ RESOLVED BY THE COMMAND FROM THE PINNED PACKAGE, NEVER DERIVED HERE. See assertProjectTrusted.
    agentDir,
  } = deps;

  const root = canonicalPath(projectRoot);
  // ⚠️ **FIRST, BEFORE THE PROJECT RECORD AND BEFORE ANY CHILD.** Running in the tool checkout without
  // the opt-in is a refusal about WHERE this run is, and it has to arrive before the refusals about
  // what is in that place — otherwise the operator is told to run setup, which would create the very
  // `.pi/` this exists to keep out of the tool repository.
  const mode = resolveSelfHost({ toolRoot, projectRoot: root, selfHost, env });
  if (mode.selfHost) log(`self-hosting run: the tool checkout at ${mode.toolRoot} is this run's project`);

  // ⚠️ **AND TRUST IMMEDIATELY AFTER, BEFORE THE RECORD, THE PORT AND EITHER CHILD.** An untrusted
  // project produces a child with none of Kiln's tools and no complaint about it, so the question is
  // asked while a refusal still costs nothing: no port taken, no run file written, nothing spawned.
  await assertProjectTrusted({ projectRoot: root, agentDir, toolRoot: mode.toolRoot, readTrust: deps.readTrust, log });

  const project = readProjectRecord(root, { validators });
  const runId = generateRunId(randomBytes);
  const { port, chosen } = await choosePort({
    value: env.PORT,
    interactive,
    ask,
    host,
    createServerImpl: deps.createServerImpl,
  });
  if (chosen === "offered") log(`using port ${port} for this run only; it is not saved`);
  log(`run ${runId} · project ${project.projectId} · http://${host}:${port}`);

  // ⚠️ **THE AGENT DIRECTORY IS FORCED, NOT INHERITED.** The trust decision was read from the store in
  // `agentDir`; a child that resolved a different one — a stale exported `PI_CODING_AGENT_DIR`, or a
  // `~` that expands elsewhere — would consult a store nobody approved. Both children get this exact
  // value, replacing whatever spelling the environment arrived with.
  const baseEnv = { ...env, PI_CODING_AGENT_DIR: agentDir };
  const childEnv = { ...baseEnv, PORT: String(port), KILN_RUN_ID: runId, KILN_PROJECT_ID: project.projectId };

  // ⚠️ **`stdio[0]` IS "pipe" AND THAT IS THE WHOLE POINT.** The launcher gets a NEW writable
  // descriptor that only this process can write to and close; it never sees fd 0. Change this to
  // "inherit" and the launcher is a second reader on the operator's terminal, racing Pi for the
  // authentication answer and the first planning message.
  //
  // ⚠️ `shell: false`, explicitly. A shell between here and the child is a second interpreter of the
  // argument array and another process to signal.
  // ⚠️ **`detached` ON POSIX MAKES THE LAUNCHER A PROCESS-GROUP LEADER**, which is the only thing
  // that makes `kill(-pid)` able to reach `next start`'s workers. Without it the child sits in THIS
  // process's group and the group form would signal the supervisor and the operator's shell too.
  // It is set for the LAUNCHER only: the agent must stay in the terminal's foreground group, and a
  // detached foreground process cannot read the terminal at all (it takes SIGTTIN instead) — which
  // would break the routing ACC-0078 exists to protect.
  const launcherChild = spawn(launcher.command, launcher.args, {
    cwd: launcher.cwd ?? root,
    env: childEnv,
    stdio: ["pipe", "inherit", "inherit"],
    shell: false,
    detached: (deps.platform ?? process.platform) !== "win32",
  });

  // ⚠️ **A SPAWN FAILURE ARRIVES AS AN EVENT.** A missing executable or a permissions problem never
  // throws from `spawn`; it emits `error` a tick later. Unlistened, that is an unhandled event, and
  // for the agent it would also leave the exit promise below pending for ever — the supervisor
  // hanging on a child that was never born.
  let launcherSpawnError = null;
  if (typeof launcherChild.once === "function")
    launcherChild.once("error", (e) => (launcherSpawnError = classifyError(e)));

  // ⚠️ **SAMPLED WHILE THE LEADER LIVES, BECAUSE AFTERWARDS NOTHING CAN RELATE THE CHILDREN TO IT.**
  // `next start` spawns workers; once the launcher is gone `ps` cannot name them as its descendants,
  // and a shutdown that asked then would report a clean tree it never looked at.
  const launcherTree = trackDescendants(launcherChild, { psRun: deps.psRun, platform: deps.platform });

  let ready = null;
  let shutdownRecord = null;
  // ⚠️ **WHAT THIS INVOCATION CREATED, ACCUMULATED AS IT CREATES IT.** The shutdown removes exactly
  // this list and nothing that matches a pattern, so a path only ever arrives here from the call
  // that wrote it — including on the refusal paths, where the `finally` shutdown reads the same
  // array and removes whatever had been written by the time the run stopped.
  const ownedFiles = [];
  let agentChild = null;
  let agentTree = null;

  /**
   * Tear both trees down, once, whatever asked for it.
   *
   * ⚠️ **IDEMPOTENT ON PURPOSE, AND IT IS NOT A CONVENIENCE.** Three things can call this — the
   * signal handler, the agent-exit path, and the `finally` — and at least two of them normally do:
   * a signal stops the agent, so its exit arrives immediately after the handler's teardown began. A
   * second bounded shutdown would signal processes the first is already escalating against, and its
   * observations would describe a tree the first one stopped.
   *
   * ⚠️ **THE DESCENDANT SNAPSHOTS ARE TAKEN HERE, AS LATE AS POSSIBLE.** They are unions accumulated
   * while each leader lived, so sampling at teardown time includes everything seen up to the moment
   * the run ended rather than whatever existed when tracking started.
   */
  let shutdownStarted = null;
  const performShutdown = (signal = null) => {
    // ⚠️ **SAMPLED AND STOPPED HERE, NOT IN THE `finally`.** The snapshots below are copies of what
    // each tracker had already seen, and the poll runs every 500ms — so a worker that appeared since
    // the last tick was missing from the copy the shutdown then acted on. `stop()` does take a final
    // look, but it ran afterwards, once the stale copies had been used. This is also the last moment
    // the leaders may still be alive, which is the only time `ps` can relate anything to them.
    // ⚠️ **THE IN-FLIGHT PROMISE IS WHAT IS MEMOISED, NOT THE RESULT.** Keying on the finished record
    // left a window between the first call starting and finishing in which a second caller saw
    // nothing recorded and began its own — and the two callers that matter arrive within a tick of
    // each other, because the signal handler's teardown is what makes the agent exit.
    if (shutdownStarted) return shutdownStarted;
    // ⚠️ **THE DEADLINE STARTS HERE, WHICH IS THE MOMENT AN OPERATOR STARTS WAITING.** Not when
    // `shutdown` is entered: everything between the two — both descendant joins — is time the
    // terminal is held, and a bound that excludes it bounds the wrong thing.
    const deadline = Date.now() + graceMs + hardMs;
    shutdownStarted = (async () => {
      // ⚠️ **SAMPLED AND STOPPED HERE, NOT IN THE `finally`, AND AWAITED.** The snapshots below are
      // copies of what each tracker had already seen, so a worker that appeared since the last poll
      // was missing from the copy the shutdown then acted on. `stop()` takes one last look, and this
      // is the last moment the leaders may still be alive — the only time a process table can relate
      // anything to them.
      //
      // ⚠️ **BOTH AT ONCE, AND FOR A SHARE OF THE BUDGET RATHER THAN THE LISTER'S OWN TIMEOUT.**
      // Sequentially, each join could spend the whole process-table timeout before the other began,
      // and neither knew anything about the grace period it was consuming: two wedged queries alone
      // came to 24 seconds, ahead of a teardown that had not yet sent its first signal. They are two
      // independent queries about two different trees, so they run together; enumeration gets at
      // most a third of the budget because the two thirds left are the stopping the criterion is
      // actually about; and a query that has not answered by then is recorded as unresolved, which
      // is the honest thing to say about it rather than waiting to find out.
      const joinMs = Math.min(
        Math.max(0, deadline - Date.now()) * ENUMERATION_BUDGET_SHARE,
        PROCESS_TABLE_TIMEOUT_MS + 2000
      );
      await Promise.all([launcherTree.stop({ joinMs }), agentTree?.stop({ joinMs })]);

      return shutdown({
        deadline,
        agent: agentChild,
        launcher: launcherChild,
        agentDescendants: agentTree?.snapshot() ?? null,
        launcherDescendants: launcherTree.snapshot(),
        ownedFiles,
        signal,
        port,
        host,
        graceMs,
        hardMs,
        platform: deps.platform,
        run: deps.run,
        psRun: deps.psRun,
        kill: deps.kill,
        createServerImpl: deps.createServerImpl,
        log,
      });
    })().then((record) => (shutdownRecord = record));
    return shutdownStarted;
  };

  // ⚠️ **ESTABLISHED BEFORE THE AGENT IS SPAWNED, so an interrupt during the readiness wait is
  // handled rather than ignored.** That window is up to `readyMs` — a minute and a half by default —
  // and it is exactly when an operator who mistyped something reaches for Ctrl+C.
  const stopWatch = watchForStop((signal) => performShutdown(signal), { target: deps.signalTarget });

  try {
    ready = await awaitReadiness({
      port,
      host,
      expected: { runId, projectId: project.projectId, build },
      childAlive: () => !exited(launcherChild),
      childFault: () => launcherSpawnError,
      deadlineMs: readyMs,
      fetchImpl: deps.fetchImpl,
    });
    log(`ready — identity confirmed on ${ready.identityConfirmedBy.join(", ")}`);
    if (ready.buildCompared) log(`build matched; recorded as compatibility metadata, not identity`);

    // ⚠️ **THE COVERAGE CHECK IS HERE, AS LATE AS IT CAN BE AND STILL BE BEFORE THE FIRST WRITE.**
    // The transcript is the first thing Pi writes, so this is the last moment the question "is that
    // directory ignored?" can still be asked. Setup may have run months ago and the operator may
    // have removed the block since; REQ-0027 is about what is true now.
    const { roots: stateRoots } = resolveRunState({
      projectRoot: root,
      stateMode,
      projectId: project.projectId,
      platform: deps.platform,
      env,
      home: deps.home,
    });
    const session = withSessionDir(agent, stateRoots.sessions, { ...baseEnv, PORT: String(port) });
    log(`sessions: ${stateRoots.sessions} (${stateMode} state)`);

    // ⚠️ **AFTER THE COVERAGE CHECK, BECAUSE IT IS RUNTIME DATA (REQ-0027).** This is the first thing
    // Kiln itself writes into the state directory, and writing it above the check would be the
    // coverage-before-data rule broken by the very call that proves the rule matters.
    //
    // ⚠️ EARLIER RUNS' FILES ARE READ BEFORE THIS ONE EXISTS, so "leftover" needs no exception for
    // the run doing the looking.
    const leftovers = leftoverRunFiles(stateRoots.runtime);
    if (leftovers.length)
      log(
        `${leftovers.length} run file(s) from earlier runs are still in ${stateRoots.runtime} — ` +
          `those runs did not complete their shutdown: ${leftovers.slice(0, 5).join(", ")}` +
          (leftovers.length > 5 ? ", …" : "")
      );
    // ⚠️ **AND IT JOINS `ownedFiles` ONLY WHEN THIS PROCESS CREATED IT.** `writeRunFile` returns a
    // path only for a file it made exclusively; anything else — no directory, the name already
    // taken, an unwritable directory — returns null, having said why, and this run owns nothing.
    const runFile = writeRunFile(stateRoots.runtime, { runId, projectId: project.projectId, host, port, log });
    if (runFile) ownedFiles.push(runFile);

    // ⚠️ **PI GETS THE TERMINAL, INHERITED.** fd 0 passes straight through, which is only safe
    // because the launcher above was given a pipe instead of it.
    agentChild = spawn(agent.command, session.args, {
      cwd: agent.cwd ?? root,
      env: session.env,
      stdio: "inherit",
      shell: false,
    });

    agentTree = trackDescendants(agentChild, { psRun: deps.psRun, platform: deps.platform });

    // ⚠️ **THE TWO WAYS A RUN CAN END ARE RACED, NOT ORDERED.** Awaiting the agent's exit and only
    // then looking for a signal means an interrupt during a long agent session is handled when the
    // agent finishes — which is to say, not handled. `watchForStop` hands back a promise that is
    // pending from the moment it is created, so this race is meaningful before either has happened.
    //
    // ⚠️ AND BOTH ROUTES REACH THE SAME SHUTDOWN, ONCE. `performShutdown` is idempotent because a
    // second Ctrl+C during a bounded teardown must not start a second one, and because the losing
    // side of the race arrives immediately afterwards — the agent exits BECAUSE the signal stopped
    // it, and that exit is not a second reason to tear down.
    let agentExitSeen = null;
    const agentExitPromise = new Promise((resolve) => {
      agentChild.once("error", (e) => resolve({ code: null, signal: null, spawnError: classifyError(e) }));
      agentChild.once("exit", (code, signal) => resolve({ code, signal }));
    });
    agentExitPromise.then((x) => (agentExitSeen = x));

    const ended = await Promise.race([
      agentExitPromise.then((exit) => ({ how: "agent-exit", exit })),
      stopWatch.completion.then(() => ({ how: "signal" })),
    ]);

    // A spawn failure is not an end-of-run; nothing was ever handed the terminal.
    if (ended.how === "agent-exit" && ended.exit.spawnError)
      throw new SupervisorRefusal(
        REFUSAL.SPAWN_FAILED,
        `The agent could not be started: ${ended.exit.spawnError}. Nothing was handed the terminal.`,
        { spawnError: ended.exit.spawnError }
      );

    if (ended.how === "signal") log(`interrupted by ${stopWatch.received}`);
    else log(`the agent exited (${ended.exit.signal ? `signal ${ended.exit.signal}` : `code ${ended.exit.code}`})`);

    shutdownRecord = await performShutdown(stopWatch.received);

    // ⚠️ **READ AFTER THE BOUNDED SHUTDOWN, NEVER AWAITED.** On the signal path this used to be
    // `await agentExitPromise`, which blocks for ever on an agent that does not go — which is
    // precisely the case the bounded escalation exists for, so the supervisor replaced a hung
    // application with a hung terminal. The shutdown has already waited out its grace and hard
    // periods by the time this runs, so an exit that was going to arrive has; one that has not is
    // recorded as unobserved rather than waited for.
    const agentExit = agentExitSeen ?? { code: null, signal: null, observed: false };

    // ⚠️ **A SHUTDOWN NOBODY SAW IS NOT A SUCCESSFUL RUN, AND `complete` IS WHAT SAYS SO NOW.** The
    // old check asked only whether the launcher was seen to exit. That is one of seven things
    // ACC-0081 requires observed separately, and the other six — each tree's exit, bounded
    // escalation, a port that accepts a fresh bind, only this invocation's files removed, and the
    // fact that an observation was MADE rather than skipped — were not asked at all. `complete` is
    // false if any of them is unmet or unobserved, and `notObserved` names which.
    if (!shutdownRecord.complete)
      throw new SupervisorRefusal(
        REFUSAL.SHUTDOWN_NOT_OBSERVED,
        `The run ended (${shutdownRecord.trigger}) but the shutdown was not observed complete.` +
          (shutdownRecord.notObserved.length ? ` Not observed: ${shutdownRecord.notObserved.join(", ")}.` : "") +
          // ⚠️ THE PORT IS NAMED WHENEVER THE LAUNCHER WAS NOT SEEN TO STOP, not only when the
          // rebind failed. A launcher still going down can leave the rebind succeeding for a moment
          // and the port held a moment later, and the operator's next question is the same either
          // way: what is on it.
          (shutdownRecord.portFree === false ||
          !shutdownRecord.launcherTree.treeStopped
            ? ` Something may still be listening on ${host}:${port}.`
            : ""),
        { host, port, shutdown: shutdownRecord, agentExit }
      );

    return { runId, port, projectId: project.projectId, ready, agentExit, shutdown: shutdownRecord, trigger: shutdownRecord.trigger };
  } finally {
    // ⚠️ ALWAYS, INCLUDING THE REFUSAL PATHS. A launcher started and then abandoned is the port left
    // held by a process nobody is watching, and a signal handler left installed is this module still
    // owning an operator's Ctrl+C after it has returned.
    stopWatch.dispose();
    // ⚠️ **THE SHUTDOWN GOES FIRST, BECAUSE IT IS THE ONE HOLDING THE DEADLINE.** These two stops
    // used to run above it: on a refusal path they took the trackers' last look with no bound but
    // the process table's own, one after the other, before the budget that is supposed to cover
    // enumeration had even started. Ordered this way, every look either belongs to the shutdown's
    // budget or is the no-op a stopped tracker now returns.
    if (!shutdownRecord) await performShutdown(stopWatch.received);
    // ⚠️ AND THESE ARE THE NO-OPS THEY ALWAYS CLAIMED TO BE, covering only a tracker the shutdown
    // never reached at all.
    await Promise.all([launcherTree.stop(), agentTree?.stop()]);
  }
}
