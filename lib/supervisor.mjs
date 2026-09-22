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
import { GUARD_ENV, GUARD_OUTCOME, createGuardFile } from "./session-guard.mjs";
// ⚠️ ONE WAY ONLY. `session-record.mjs` reaches the validators, the lock and the atomic writer, and
// nothing in it imports this module back — which is why `recordSession` returns a result rather than
// raising a refusal of its own.
import {
  RECOVERY,
  SESSION,
  SESSION_PROBLEM,
  STORAGE,
  chooseSession,
  planSession,
  recordSession,
  sessionPrecondition,
} from "./session-record.mjs";
import { SELF_HOST_MARKER, SELF_HOST_VALIDATED, withoutSelfHostMarker } from "./orchestrator-root.mjs";
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
  // ⚠️ **A LAUNCH THAT CANNOT READ THE PROCESS TABLE CANNOT SHUT DOWN WHAT IT IS ABOUT TO START.**
  // The table is what names a survivor and what verifies an identity before any signal; a run that
  // starts without it can only ever fail closed at the end, having already taken the port and put
  // two process trees on the operator's machine.
  PROCESS_TABLE_NOT_PRIMED: "process-table-not-primed",
  SHUTDOWN_NOT_OBSERVED: "shutdown-not-observed",
  STATE_UNPROTECTED: "state-unprotected",
  SESSION_DIR_CONFLICT: "session-dir-conflict",
  // ⚠️ THE CALLER MAY NOT ALSO CHOOSE THE SESSION. Kiln names the exact session to resume; a second
  // selector in the same argument list leaves the choice to whichever Pi prefers, which is the
  // "resumed something, and nobody can say what" outcome ACC-0103 exists to forbid.
  SESSION_SELECTOR_CONFLICT: "session-selector-conflict",
  // ⚠️ A SESSION THAT CANNOT BE RECORDED IS NOT A SESSION ANYONE CAN RETURN TO, so the run refuses
  // before Pi is started rather than after a conversation exists that nothing points at.
  SESSION_RECORD_UNWRITABLE: "session-record-unwritable",
  // ⚠️ AND AN UNRESOLVED SESSION FAILS CLOSED until the recovery UI exists: never a silent fresh one.
  SESSION_UNRESOLVED: "session-unresolved",
  SESSION_RECOVERY_DECLINED: "session-recovery-declined",
  SESSION_GUARD_REFUSED: "session-guard-refused",
  SESSION_GUARD_NOT_REACHED: "session-guard-not-reached",
  SESSION_GUARD_UNWRITABLE: "session-guard-unwritable",
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
  // ⚠️ TWO AGAIN, FOR THE SAME REASON. "Nothing said which tools" and "something already did" are
  // different faults: the first is a launch that forgot to constrain the agent, the second a launch
  // with two tool policies in one argument list.
  TOOL_ALLOWLIST_MISSING: "agent-tool-allowlist-missing",
  TOOL_ALLOWLIST_CONFLICT: "agent-tool-allowlist-conflict",
  // ⚠️ AND THE SAME PAIR FOR THE MODEL. Pi is held to the selection the launch checks passed; an argument list that
  // already names one, or a checked selection with nothing usable in it, would leave the billable model unstated.
  MODEL_SELECTION_MISSING: "agent-model-selection-missing",
  MODEL_SELECTION_CONFLICT: "agent-model-selection-conflict",
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

/** The flag that names an EXACT session, creating it if missing — measured on the pinned 0.84.4. */
export const SESSION_ID_FLAG = "--session-id";

/**
 * Every way Pi can be told which session to use. All of them are refused when Kiln supplies one.
 *
 * ⚠️ **EACH OF THESE DECIDES THE SESSION, AND ONLY ONE THING MAY.** `--session` takes a partial uuid,
 * `--continue` takes the previous one, `--resume` opens a picker, `--fork` branches another, and
 * `--no-session` throws the conversation away entirely. Any of them beside Kiln's `--session-id` means
 * the record and the running session can disagree, which is exactly the failure this is here to prevent.
 */
export const SESSION_SELECTORS = Object.freeze([
  SESSION_ID_FLAG,
  "--session",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--fork",
  "--no-session",
]);

/** Pi's selector for a session that must already exist: it refuses rather than creating one (F128). */
export const SESSION_RESUME_FLAG = "--session";
/** Pi's flag for loading one extension file, which is how Kiln's guard reaches a resumed session. */
export const EXTENSION_FLAG = "-e";

/**
 * Give Pi the exact session Kiln decided on.
 *
 * ⚠️ **A FIRST RUN AND A RESUME USE DIFFERENT FLAGS, BECAUSE THEY NEED DIFFERENT ANSWERS (F128).** A first run
 * passes `--session-id`, which creates the session it names: that is what makes a new session's identity Kiln's
 * to know rather than something read back out of Pi's files. A resume passes `--session <id>`, which refuses
 * when no session carries that id instead of quietly creating one — measured on the pinned 0.84.4, where
 * `--session-id` for a session that has gone prints a warning and starts an empty one with the same id.
 *
 * ⚠️ **AND A RESUME CARRIES KILN'S GUARD.** `--session` still lists and then opens in two steps, falls back to
 * a prefix match, and would open a stranger's file if the ids collided. The guard extension compares what Pi
 * bound against what Kiln recorded, inside Pi, before the session is used.
 */
export function withSessionPolicy(agent, sessionId, env, { resume = null } = {}) {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0)
    throw new TypeError(`withSessionPolicy needs the session id to pass to Pi, got ${JSON.stringify(sessionId)}`);

  const args = agent.args ?? [];
  // ⚠️ **THE SELECTOR'S NAME, NEVER ITS VALUE.** `--session=<id>` and the arguments beside it can carry a
  // session id, a path or a credential, and a refusal is printed, logged and pasted into issues. Only the
  // normalised flag names and how many there were leave this function.
  const conflicts = [...new Set(args.map(String).flatMap((text) => SESSION_SELECTORS.filter((flag) => text === flag || text.startsWith(`${flag}=`))))];
  if (conflicts.length)
    throw new SupervisorRefusal(
      REFUSAL.SESSION_SELECTOR_CONFLICT,
      `The agent's argument list already names ${conflicts.join(", ")}, and the supervisor must choose the ` +
        `session: two selectors leave it to whichever Pi prefers, and a run that resumed something other ` +
        `than the recorded session is the failure this refuses to risk.`,
      { selectors: conflicts, conflicts: conflicts.length }
    );

  if (!resume) return { args: [...args, SESSION_ID_FLAG, sessionId], env: { ...env } };
  return {
    args: [...args, SESSION_RESUME_FLAG, sessionId, EXTENSION_FLAG, resume.guardExtension],
    // Only the guard file's PATH travels in the environment, and the guard removes the variable as it loads.
    env: { ...env, [GUARD_ENV]: resume.guardFile },
  };
}

/**
 * The identifier a first run gives Pi, in the shape Pi uses for its own.
 *
 * ⚠️ **KILN MINTS IT RATHER THAN READING PI'S CHOICE BACK.** `--session-id` creates the session when it
 * is missing, so naming it here is what makes the identity knowable without parsing a file Kiln does
 * not own. Measured on the pinned 0.84.4: a generated v4 uuid was accepted, the session file's header
 * carried exactly that id, and Pi's own lister reported it.
 */
export function generateSessionId(randomBytes) {
  const bytes = randomBytes(16);
  // The version and variant bits, so what is stored is a well-formed v4 rather than 16 loose bytes.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * What is actually there, for a refusal an operator can act on.
 *
 * ⚠️ **COUNTS AND STATES, NEVER PATHS OR IDS.** A refusal is printed, logged and pasted into issues; the
 * location of someone's state directory is not the supervisor's to publish, and a session id in a
 * message invites resuming by hand the thing this criterion exists to decide.
 */
/** The one warning a choice needs: what replacing this record would take away, when it would take anything. */
function recoveryWarning(problem) {
  if (problem === SESSION_PROBLEM.FOREIGN)
    return "This project's session record was written for a different project. Choosing here replaces it.";
  if (problem === SESSION_PROBLEM.MODE_CHANGED)
    return "The session record was written under a different state mode, and names a session in the other store. Choosing here replaces it.";
  return null;
}

function describeSessions(available) {
  if (!available || available.state === STORAGE.UNREADABLE) return "The session storage could not be inspected.";
  if (available.state === STORAGE.NOT_A_DIRECTORY) return "The session storage is a file where a directory belongs.";
  const found = available.sessions?.length ?? 0;
  return found === 0
    ? "No sessions are stored for this project."
    : `${found} session${found === 1 ? " is" : "s are"} stored for this project.`;
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

/** How often a waiting period looks again at whatever it is waiting for. */
export const WAIT_POLL_MS = 50;

/**
 * Wait until `done()` says so or `ms` has passed, whichever is first, and say which (O12, F120).
 *
 * ⚠️ **NO SLEEP IS EVER ASKED FOR PAST WHAT IS LEFT OF THE ALLOWANCE.** A loop that always slept a whole
 * poll ran up to that poll past its allowance and spent the reserve held back for the step after it. How
 * late the operating system then wakes it is not this function's to promise: a Windows CI runner fired a
 * 25ms timer 31ms late. That lateness is measured in the shutdown record, not asserted here.
 *
 * `now` and `sleep` are seams so the arithmetic can be proved without depending on a real timer.
 */
export async function waitUntil(done, ms, { now = () => Date.now(), sleep: pause = sleep, pollMs = WAIT_POLL_MS } = {}) {
  let ok = done();
  const until = now() + ms;
  while (!ok && now() < until) {
    await pause(Math.max(1, Math.min(pollMs, until - now())));
    ok = done();
  }
  return ok;
}
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
export function probePort(port, { host = HOST, createServerImpl = createServer, timeoutMs = null } = {}) {
  return new Promise((resolve) => {
    const server = createServerImpl();
    let settled = false;
    // ⚠️ **A BIND THAT NEVER ANSWERS IS NOT A FREE PORT AND IS NOT A BUSY ONE (O12).** Unbounded, it
    // was the one step of a shutdown that could outlast the deadline by any amount; bounded, a
    // probe that does not answer in time is recorded as unmade rather than guessed either way.
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            try {
              server.close();
            } catch {}
            finish({ free: null, timedOut: true });
          }, timeoutMs);
    if (timer?.unref) timer.unref();
    function finish(value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    }
    server.once("error", (e) => finish({ free: false, code: e.code ?? String(e.message) }));
    server.once("listening", () => {
      const chosen = server.address()?.port ?? port;
      server.close(() => finish({ free: true, port: chosen }));
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

/**
 * What to do about an unresolved session when there is nobody to ask.
 *
 * ⚠️ **THE COMMAND FOR EACH SHELL, BECAUSE "RUN IT IN A TERMINAL" IS NOT AN INSTRUCTION ANYWHERE.** Choosing
 * between sessions is a question with a person's memory as its only answer, so a run with no terminal cannot
 * decide it — and neither can a flag, which is why none is offered here.
 */
export function recoverInTerminal(command = DEFAULT_RETRY_COMMAND) {
  return [`  PowerShell   ${command}`, `  sh           ${command}`].join(NEWLINE);
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
export async function stopLauncher(
  child,
  { graceMs = 8000, hardMs = 3000, kill, log = () => {}, timeline = null, deadline = null, waitFloorMs = null } = {}
) {
  const record = { sentStop: false, endRequested: false, exitObserved: false, exitObservedMs: null, escalated: false, stdinError: null, unfinished: [] };
  if (!child) return record;
  // O12: the control channel spends the same deadline as everything else in the teardown.
  const clock = deadline ?? createShutdownDeadline({ at: Date.now() + graceMs + hardMs });
  const hardMinMs = Math.min(hardMs, SHUTDOWN_MIN_PHASE_MS);
  const waitMinMs = waitFloorMs ?? waitFloor(graceMs + hardMs);

  // R19: when the launcher's exit was first observed, on the shutdown's clock. Observing changes nothing.
  const tl = timeline ?? createShutdownTimeline();
  let exitObservedAt = exited(child) ? tl.now() : null;
  const gone = () => {
    const g = exited(child);
    if (g && exitObservedAt === null) exitObservedAt = tl.now();
    return g;
  };
  const stdin = child.stdin;
  if (stdin && !stdin.destroyed && !exited(child)) {
    const control = tl.begin("launcher-control", { tree: "launcher" });
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
    tl.end(control, { sentStop: record.sentStop, endRequested: record.endRequested, stdinError: record.stdinError });
  }

  // The wait for the launcher to take the message, out of what the deadline still has, and holding
  // back what a kill and the period observing it would need.
  const graceAllowed = clock.allow(graceMs, { reserveMs: hardMinMs + WAIT_SLACK_MS, floorMs: waitMinMs });
  let graceGone = gone();
  if (!graceAllowed.granted) tl.observe("deadline-refusal", { tree: "launcher-control", operation: "grace-wait", reason: graceAllowed.reason });
  else {
    const grace = tl.begin("grace-wait", { tree: "launcher-control", ms: graceAllowed.ms });
    graceGone = await waitUntil(gone, graceAllowed.ms);
    tl.end(grace, { exited: graceGone });
  }

  if (!gone()) {
    const killAllowed = clock.allow(KILL_TIMEOUT_MS, { minMs: 1, reserveMs: hardMinMs });
    if (!killAllowed.granted) {
      record.unfinished.push({ operation: "terminate", reason: killAllowed.reason, remainingMs: killAllowed.remainingMs });
      tl.observe("deadline-refusal", { tree: "launcher-control", operation: "terminate", reason: killAllowed.reason });
    } else {
      record.escalated = true;
      log(`the launcher did not exit within ${graceAllowed.ms}ms — killing`);
      const signalled = tl.begin("signal", { tree: "launcher-control", via: "handle", signal: "SIGKILL" });
      try {
        (kill ?? ((c) => c.kill("SIGKILL")))(child);
        tl.end(signalled, { error: null });
      } catch (e) {
        tl.end(signalled, { error: classifyError(e) });
        throw e;
      }
      const hardAllowed = clock.allow(hardMs, { minMs: 1, floorMs: waitMinMs });
      if (!hardAllowed.granted) {
        record.unfinished.push({ operation: "hard-wait", reason: hardAllowed.reason, remainingMs: hardAllowed.remainingMs });
        tl.observe("deadline-refusal", { tree: "launcher-control", operation: "hard-wait", reason: hardAllowed.reason });
      } else {
        const hardWait = tl.begin("hard-wait", { tree: "launcher-control", ms: hardAllowed.ms });
        const hardGone = await waitUntil(gone, hardAllowed.ms);
        tl.end(hardWait, { exited: hardGone });
      }
    }
  }

  record.exitObserved = gone();
  record.exitObservedMs = exitObservedAt;
  record.exitCode = child.exitCode;
  record.signal = child.signalCode;
  return record;
}

/**
 * The most one waiting period keeps out of a spent budget.
 *
 * ⚠️ **A KILL WITH NO TIME TO OBSERVE ITS EFFECT IS NOT A STOP, IT IS A GUESS.** Scaling every
 * period down to whatever remains reaches zero on exactly the runs that go badly — and a zero-length
 * hard period means signalling a process and recording, in the same instant, that it did not go.
 *
 * ⚠️ **IT IS A FLOOR INSIDE THE DEADLINE, NOT ABOVE IT (O12).** It used to be guaranteed whatever the
 * deadline said, so six periods could overrun a budget by six of these — which is what the evidence
 * test's 9,500ms ceiling for an 8,000ms budget was written around. A period that cannot have it is
 * shortened or not started, and `waitFloor` scales it to teardowns configured smaller than it.
 */
export const SHUTDOWN_MIN_PHASE_MS = 250;

/**
 * What one waiting period gets out of the shutdown's SHARED budget.
 *
 * ⚠️ **THE SHARE IS WHAT A PERIOD ASKS FOR; `createShutdownDeadline` DECIDES WHAT IT GETS.** This
 * divides the time left between the two waiting periods in the ratio the caller asked for. It knows
 * nothing about the identity reads, terminations, cleanup and port probe between them, which is why
 * its answer is a request rather than a grant (O12).
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
 * How long one termination call may take before the shutdown stops waiting for it.
 *
 * Measured against the thing it bounds: a `taskkill` returned in 42 to 124ms across every recorded
 * Windows run. A call that has not returned in two seconds is not going to help this teardown.
 */
export const KILL_TIMEOUT_MS = 2000;

/**
 * How late a waiting period can end: one operating-system timer tick past the allowance it was given.
 *
 * ⚠️ MEASURED, NOT GUESSED: Windows' default timer resolution is about 15.6ms, and a wait bounded at
 * 88ms was recorded ending at 101.8. A reserve that ignores it is a reserve the wait before it eats.
 */
export const WAIT_SLACK_MS = 25;

/** How long the closing port probe may take. A local bind and close was recorded at 1.2 to 4ms. */
export const PORT_PROBE_TIMEOUT_MS = 2000;

/**
 * What the tail of a shutdown is never allowed to lose: removing this run's own files and probing the
 * port. Both are local and were recorded at under 5ms together; holding this back is what keeps the
 * last two observations from being the ones the deadline cuts off.
 */
export const SHUTDOWN_TAIL_RESERVE_MS = 50;

/**
 * The shortest timeout a process-table read is worth starting with.
 *
 * ⚠️ MEASURED AGAINST THE THING IT BOUNDS, AND IT IS NOT THE TIMEOUT. A Windows CIM query answered
 * in 0.4 to 1.4 seconds across every recorded run; below that a read cannot answer at all, and the
 * teardown has bought an unverifiable identity with time the kill needed. `IDENTITY_READ_FLOOR_MS` is
 * how long a read is ALLOWED to take; this is how little makes it worth starting.
 */
export const IDENTITY_READ_MIN_MS = 1500;

/**
 * What one identity read must be able to claim out of a whole teardown's budget.
 *
 * ⚠️ **TAKEN FROM THE WHOLE BUDGET, NOT FROM A SHARE OF WHAT IS LEFT.** A share shrinks as the
 * teardown spends, so the second tree's read — the one most likely to be short of time — would end up
 * with the smallest minimum and the largest chance of answering nothing. A caller whose entire
 * teardown is shorter than one read gets a proportionate floor rather than a refusal it could never
 * satisfy.
 */
export const identityFloor = (budgetMs) => Math.min(IDENTITY_READ_MIN_MS, Math.max(1, Math.floor(budgetMs / 4)));

/**
 * What one waiting period keeps, whatever is reserved out of it.
 *
 * ⚠️ **A TEARDOWN THAT NEVER WAITS CANNOT OBSERVE AN ORDINARY EXIT.** Reserving for verification is
 * what stops grace from spending the budget, but a reserve that deletes the wait entirely turns every
 * polite shutdown into a kill: a process that would have gone in 30ms is signalled instead, and the
 * record says it had to be. Both floors come from the same budget so neither can crowd the other out.
 */
export const waitFloor = (budgetMs) => Math.min(SHUTDOWN_MIN_PHASE_MS, Math.max(1, Math.floor(budgetMs / 8)));

/**
 * ONE ABSOLUTE DEADLINE, AND EVERY ALLOWANCE DRAWN FROM IT (O12).
 *
 * ⚠️ **THE BUDGET WAS A DESCRIPTION, NOT A LIMIT.** Waiting periods were shares of the time left, so
 * they scaled — but the work between them did not: an identity read took its own two seconds and a
 * `taskkill` its own spawn, from whatever was left over, after a grace period had already been
 * assigned as if nothing followed it. A Windows run measured 8,092ms against a budget of 8,000, and
 * a second 8,071ms, both of them entirely the unreserved reads and kills. Every operation now asks
 * this for its allowance, and what it gets is bounded by the same deadline the operator is waiting
 * out.
 *
 * ⚠️ **AN OPERATION TOO SHORT TO DO ITS JOB IS NOT STARTED.** A process-table read given 80ms on
 * Windows cannot answer, and spending the last of a teardown on one buys an unverifiable identity
 * instead of a kill. `minMs` is what the operation needs to be worth starting; below it the
 * allowance is refused, with the reason, and the caller records the operation as unfinished rather
 * than as done.
 */
export function createShutdownDeadline({ at, now = () => Date.now() } = {}) {
  let standing = 0;
  const left = () => Math.max(0, at - now());
  return {
    at,
    remainingMs: left,
    reached: () => left() <= 0,
    /** What every later allowance must leave behind, whatever else it is asked for. */
    reserveFor: (ms) => {
      standing = Math.max(0, ms);
    },
    /**
     * ⚠️ **A RESERVE NEVER STARVES THE OPERATION IT IS HELD BACK FROM.** Reserving for what comes
     * later is what stops one grace period from spending a whole teardown. But a reserve allowed to
     * take everything would delete every wait on exactly the runs that are already short, and then
     * refuse the verification it was reserved for as well, having left too little for either. So it
     * yields to whichever is larger: what this operation needs to be worth starting, or one floor of
     * the waiting it was asked to do.
     */
    allow: (requestedMs, { reserveMs = 0, minMs = 0, floorMs = 0 } = {}) => {
      const remaining = left();
      const asked = standing + Math.max(0, reserveMs);
      // A minimum never exceeds what the operation was asking for: a 50ms wait needs 50ms, not a floor.
      const needed = Math.min(requestedMs, minMs);
      const protect = Math.max(needed, Math.min(requestedMs, floorMs));
      const reserve = Math.min(asked, Math.max(0, remaining - protect));
      const available = Math.max(0, remaining - reserve);
      if (available <= 0 || available < needed)
        return { ms: 0, granted: false, reason: remaining <= 0 ? "deadline-reached" : "insufficient-time", remainingMs: remaining };
      return { ms: Math.min(requestedMs, available), granted: true, reason: null, remainingMs: remaining };
    },
  };
}

/**
 * One shutdown's timeline: every operation it performs, on one monotonic clock, relative to one origin (R19).
 *
 * ⚠️ **BECAUSE ONE NUMBER COULD NOT SAY WHEN A TREE STOPPED.** A Windows shutdown recorded `spentMs: 8092` against an
 * 8,000 ms budget, and nothing in its record could say whether its trees had stopped before that mark or after it, or
 * what the rest of the time went on. Each tracker join, grace and hard wait, identity read, signal, `taskkill`,
 * launcher control, owned-file cleanup and port probe now records its own start and end.
 *
 * ⚠️ **AN OPERATION THAT DID NOT FINISH HAS NO END.** One the shutdown stopped waiting for is `abandoned` at the moment it
 * gave up, with `endMs` left null, and one never ended at all keeps both null. Nothing is inferred to have completed.
 *
 * ⚠️ **THE RECORD IS A COPY.** `snapshot()` returns plain values, so activity after a record is taken, including anything
 * that ends after `finalize()`, cannot change a record already produced; it is marked on the entry instead.
 *
 * The timeline observes and decides nothing: no wait, timeout, signal or refusal reads it.
 */
export function createShutdownTimeline({ clock = () => performance.now(), origin = clock() } = {}) {
  const entries = [];
  const observations = [];
  let finalizedAt = null;
  const rel = (t) => (t === null || t === undefined ? null : Math.round((t - origin) * 10) / 10);
  const plain = (value) => (value === undefined || value === null ? null : JSON.parse(JSON.stringify(value)));
  return {
    now: () => rel(clock()),
    begin: (kind, attrs = {}) => {
      const entry = {
        id: `${kind}-${entries.length + 1}`,
        kind,
        attrs: plain(attrs),
        start: clock(),
        end: null,
        abandoned: null,
        outcome: null,
        startedAfterFinalize: finalizedAt !== null,
        endedAfterFinalize: false,
      };
      entries.push(entry);
      return entry;
    },
    end: (entry, outcome = null) => {
      if (!entry || entry.end !== null || entry.abandoned !== null) return;
      entry.end = clock();
      entry.outcome = plain(outcome);
      entry.endedAfterFinalize = finalizedAt !== null;
    },
    abandon: (entry, outcome = null) => {
      if (!entry || entry.end !== null || entry.abandoned !== null) return;
      entry.abandoned = clock();
      entry.outcome = plain(outcome);
      entry.endedAfterFinalize = finalizedAt !== null;
    },
    observe: (kind, attrs = {}, at = clock()) => {
      observations.push({ kind, attrs: plain(attrs), at, afterFinalize: finalizedAt !== null });
    },
    finalize: () => {
      finalizedAt ??= clock();
    },
    snapshot: () => ({
      origin: "shutdown-start",
      finalizedMs: rel(finalizedAt),
      entries: entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        ...plain(e.attrs),
        startMs: rel(e.start),
        endMs: rel(e.end),
        abandonedMs: rel(e.abandoned),
        durationMs: e.end === null ? null : Math.round((e.end - e.start) * 10) / 10,
        outcome: plain(e.outcome),
        startedAfterFinalize: e.startedAfterFinalize,
        endedAfterFinalize: e.endedAfterFinalize,
      })),
      observations: observations.map((o) => ({ kind: o.kind, ...plain(o.attrs), atMs: rel(o.at), afterFinalize: o.afterFinalize })),
    }),
  };
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
  timeline = null,
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
  // R19: one timeline for the whole teardown. A caller that started the clock earlier passes its own.
  const tl = timeline ?? createShutdownTimeline();
  // ⚠️ **O12: ONE DEADLINE, HELD BY EVERY STEP BELOW.** Each used to be bounded on its own and their
  // sum was not, so the record could declare 8,092ms spent of 8,000 and call itself within budget.
  const clock = createShutdownDeadline({ at: ends, now });
  // ⚠️ **THE SECOND TREE'S VERIFICATION IS RESERVED BEFORE THE FIRST TREE IS ASKED ANYTHING.** Every
  // period was a share of what remained, and what remained was whatever the step before it left — so
  // the agent's grace period, taken first and out of the whole budget, was assigned as if the launcher
  // had nothing left to do. A recorded Windows teardown left its launcher's identity read 337ms of a
  // table that costs 850, and refused to report the tree stopped because of it.
  const treeFloorMs = identityFloor(budgetMs);
  const waitFloorMs = waitFloor(budgetMs);
  const treeReserveMs = treeFloorMs + Math.min(hardMs, SHUTDOWN_MIN_PHASE_MS) + WAIT_SLACK_MS;
  // The last two observations are local and cost under 5ms together; the tail is what stops a slow
  // tree from being the reason the port was never probed.
  clock.reserveFor(SHUTDOWN_TAIL_RESERVE_MS + treeReserveMs);
  const opts = { platform, run, psRun, kill, log, timeline: tl, deadline: clock, identityFloorMs: treeFloorMs, waitFloorMs };
  // ⚠️ THE SNAPSHOTS TAKEN WHILE THE CHILDREN LIVED. Without them an already-exited leader has no
  // tree anyone can name, and the ordinary Pi-exit shutdown would report a clean one.
  // ⚠️ THE AGENT IS NOT SPAWNED `detached` — it must stay in the terminal's foreground group to read
  // from it — so its tree is signalled directly. The launcher is, so its group can be targeted.
  const agentTree = await stopTree(agent, { ...opts, ...phase(), tree: "agent", knownDescendants: agentDescendants });

  // ⚠️ THE LAUNCHER GETS ITS OWN CONTROL CHANNEL FIRST — a stop message and a closed pipe are what
  // it was built to answer.
  const launcherControl = await stopLauncher(launcher, { ...phase(), log, timeline: tl, deadline: clock, waitFloorMs });

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
  // The tree the reserve was held for: it keeps only the tail behind it.
  clock.reserveFor(SHUTDOWN_TAIL_RESERVE_MS);
  const launcherTree = await stopTree(launcher, { ...opts, ...phase(), tree: "launcher", group: true, knownDescendants: launcherDescendants });

  // ⚠️ **AN OPERATION THE DEADLINE CUT OFF IS NAMED, AND A RESULT THAT NAMES ONE IS NOT COMPLETE.**
  // The trees report their own; these last two report here.
  const unfinished = [
    ...(agentTree.unfinished ?? []).map((u) => ({ tree: "agent", ...u })),
    ...(launcherControl.unfinished ?? []).map((u) => ({ tree: "launcher-control", ...u })),
    ...(launcherTree.unfinished ?? []).map((u) => ({ tree: "launcher", ...u })),
  ];
  const refused = (operation, allowed) => {
    unfinished.push({ tree: null, operation, reason: allowed.reason, remainingMs: allowed.remainingMs });
    tl.observe("deadline-refusal", { tree: null, operation, reason: allowed.reason });
  };

  // The tail is held back for exactly this, and is released to it.
  clock.reserveFor(0);
  const cleanupAllowed = clock.allow(SHUTDOWN_TAIL_RESERVE_MS, { minMs: 1 });
  let files = { removed: [], failed: [] };
  if (!cleanupAllowed.granted) refused("owned-file-cleanup", cleanupAllowed);
  else {
    const cleanup = tl.begin("owned-file-cleanup", { files: ownedFiles.length });
    files = removeOwnedFiles(ownedFiles, { log });
    tl.end(cleanup, { removed: files.removed.length, failed: files.failed.length });
  }

  // ⚠️ **THE PORT IS ITS OWN OBSERVATION, AND IT WAS MISSING.** The criterion requires a free port,
  // and every other record here is about a process — `exitCode` says the leader is gone and says
  // nothing about a worker still listening. Rebinding is the only check that asks the question the
  // criterion actually poses.
  let portFree = null;
  if (port !== null) {
    const probeAllowed = clock.allow(PORT_PROBE_TIMEOUT_MS, { minMs: 1 });
    if (!probeAllowed.granted) refused("port-probe", probeAllowed);
    else {
      const probe = tl.begin("port-probe", { port, timeoutMs: probeAllowed.ms });
      const result = await probePort(port, { host, createServerImpl, timeoutMs: probeAllowed.ms });
      portFree = result.timedOut ? null : result.free;
      tl.end(probe, { free: portFree, timedOut: result.timedOut === true });
      if (result.timedOut) refused("port-probe", { reason: "port-probe-timeout", remainingMs: clock.remainingMs() });
    }
  }

  // ⚠️ **AN OMITTED OBSERVATION IS NOT A PASSED ONE.** `portFree !== false` let a shutdown with no
  // port to check report itself complete, which is the criterion's mandatory rebinding clause
  // quietly skipped. What could not be observed is named, and naming anything makes the result
  // partial rather than complete.
  const notObserved = [];
  // A port nobody probed is unobserved whether there was none to probe or the deadline cut the probe off.
  if (port === null || portFree === null) notObserved.push("port");
  if (agentTree.descendantsEnumerated === false) notObserved.push("agent-descendants");
  if (agentTree.descendantsSurviving?.length) notObserved.push("agent-descendants-survived");
  // ⚠️ **A DESCENDANT WHOSE IDENTITY COULD NOT BE CHECKED IS NEITHER GONE NOR OURS (F116).** Nothing was
  // sent to it, and the tree cannot be reported stopped while it is running under a pid nobody verified.
  if (agentTree.descendantsUnverified?.length) notObserved.push("agent-descendants-unverified");
  // ⚠️ THE LAUNCHER'S TWO NOW MIRROR THE AGENT'S. Only the enumeration failure was named before, and
  // only on the escalation path — so a KNOWN survivor, the more serious of the two, was reported
  // nowhere at all.
  if (launcherTree.descendantsEnumerated === false) notObserved.push("launcher-descendants");
  if (launcherTree.descendantsSurviving?.length) notObserved.push("launcher-descendants-survived");
  if (launcherTree.descendantsUnverified?.length) notObserved.push("launcher-descendants-unverified");

  // ⚠️ **WHAT THE TEARDOWN ACTUALLY COST, RECORDED.** A shutdown that spent its whole budget
  // enumerating gave its later periods the floor and nothing more, and its record would otherwise
  // read identically to one that had all the time it asked for — the evidence silently describing a
  // degraded stop as an ordinary one.
  const spentMs = Math.max(0, now() - startedAt);
  tl.finalize();

  const withinBudget = spentMs <= budgetMs;

  return {
    trigger,
    signal,
    budget: { ms: budgetMs, spentMs, withinBudget },
    // Every operation the deadline did not leave time for, with the reason and what was left (O12).
    unfinished,
    agent: agentTree,
    // The private control channel's answer, and the tree's, as two records because they are two
    // facts: `launcher.exitObserved` says the leader went, `launcherTree.treeStopped` says the tree did.
    launcher: launcherControl,
    launcherTree,
    files,
    portFree,
    notObserved,
    timeline: tl.snapshot(),
    // ⚠️ A SINGLE VERDICT IS OFFERED, NOT SUBSTITUTED FOR THE PARTS. It is derived from them here so
    // no caller has to re-derive it, and every part stays readable beside it.
    complete:
      // ⚠️ **A TEARDOWN THAT RAN PAST ITS DEADLINE DID NOT MEET IT, WHATEVER ELSE IT MANAGED.** The
      // budget used to be reported beside the verdict and read by nothing, so an overrun was a
      // number in a record that still said `complete: true`.
      withinBudget &&
      unfinished.length === 0 &&
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
 * The Windows process table as `pid ppid created` lines, `created` a UTC FILETIME or `-` when zero.
 *
 * ⚠️ IT CONTAINS NO DOUBLE QUOTE, so it passes through the Windows command line unescaped.
 */
const WINDOWS_PROCESS_TABLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$m = [Runtime.InteropServices.Marshal]",
  "$b = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'KilnProcessTable'), 'Run')",
  "$t = $b.DefineDynamicModule('KilnProcessTable').DefineType('KilnNt', 'Public,Class')",
  "$q = $t.DefinePInvokeMethod('NtQuerySystemInformation', 'ntdll.dll', 'Public,Static,PinvokeImpl', 'Standard', [int], [Type[]]@([int], [IntPtr], [int], [int].MakeByRefType()), 'Winapi', 'Auto')",
  // ⚠️ PRESERVESIG, or the CLR turns STATUS_INFO_LENGTH_MISMATCH into an exception and the retry never runs.
  "$q.SetImplementationFlags('PreserveSig')",
  "$nt = $t.CreateType()",
  "$size = 65536",
  "$buf = [IntPtr]::Zero",
  "for ($try = 0; $try -lt 12; $try++) {",
  "  $buf = $m::AllocHGlobal($size)",
  "  $need = 0",
  "  $status = $nt::NtQuerySystemInformation(5, $buf, $size, [ref]$need)",
  "  if ($status -eq 0) { break }",
  "  $m::FreeHGlobal($buf)",
  "  $buf = [IntPtr]::Zero",
  "  if ($status -ne -1073741820) { [Console]::Error.Write('ntstatus ' + $status); exit 2 }",
  "  $size = [Math]::Max($need, $size) * 2",
  "}",
  "if ($buf -eq [IntPtr]::Zero) { [Console]::Error.Write('buffer'); exit 3 }",
  "if ([IntPtr]::Size -eq 8) { $oPid = 0x50; $oPpid = 0x58 } else { $oPid = 0x44; $oPpid = 0x48 }",
  "$o = New-Object Text.StringBuilder",
  "$at = 0",
  "try {",
  "  while ($true) {",
  "    $e = [IntPtr]::Add($buf, $at)",
  "    $created = $m::ReadInt64($e, 0x20)",
  "    $c = if ($created -gt 0) { $created } else { '-' }",
  "    [void]$o.Append($m::ReadIntPtr($e, $oPid).ToInt64()).Append(' ').Append($m::ReadIntPtr($e, $oPpid).ToInt64()).Append(' ').Append($c).Append([char]10)",
  "    $next = $m::ReadInt32($e, 0)",
  "    if ($next -eq 0) { break }",
  "    $at += $next",
  "  }",
  "} finally { $m::FreeHGlobal($buf) }",
  "[Console]::Out.Write($o.ToString())",
].join("\n");

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
  //
  // ⚠️ **EACH ROW CARRIES ITS PROCESS'S CREATION TIME, BECAUSE A PID IS NOT AN IDENTITY (F116).** A pid
  // is reused once its process is gone, and a shutdown that signals a remembered pid addresses whoever
  // holds it now. Measured on Windows with a harness-owned stand-in: a stale tracked pid was sent
  // `taskkill /T /F`, which ended the stand-in and its own child, and the record still said the tree
  // had stopped. The pair (pid, creation time) is what is tracked and re-checked before any signal.
  // `lstart` is whole seconds, read with `LC_ALL=C` so its month names parse the same everywhere.
  posix: ["ps", ["-A", "-o", "pid=,ppid=,lstart="]],
  // ⚠️ **NO WMI, WHICH IS WHY THIS IS NOT `Get-CimInstance` (F122).** CIM replaced `wmic`, which is being
  // removed from Windows, and CIM then failed in its own way: the first use of the WMI provider stalled for
  // 7,114ms in CI run 35055338147, and after the launch preflight was added to absorb that cost, the primed
  // read itself exceeded the 10,000ms bound in run 35097288227. The recorded rule was that one more primed
  // timeout retires WMI, so the table is now read from the kernel directly.
  //
  // ⚠️ **`NtQuerySystemInformation(SystemProcessInformation)`, THE CALL TOOLHELP32 IS BUILT ON.** One call
  // returns every process with its pid, its parent pid and its creation FILETIME, in one snapshot and
  // without opening any process. Toolhelp32 drops the creation time, and reading it back through
  // `OpenProcess` failed for 160 of 291 processes measured without elevation. The parent pid sits in a
  // region `winternl.h` marks reserved; the layout has been stable since NT and is what Toolhelp32 reads.
  //
  // ⚠️ **NO COMPILER EITHER.** `Add-Type` compiles C# through `csc.exe` on each call. The P/Invoke is
  // defined through reflection emit instead, in memory, and the buffer is read at fixed offsets for the
  // running pointer size. The buffer starts deliberately small, so the grow-and-retry path runs on every
  // real read rather than only on a machine busier than any test.
  win32: ["powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_TABLE_SCRIPT]],
});

/**
 * How long a process table has to answer.
 *
 * ⚠️ MEASURED AGAINST THE THING IT BOUNDS, not chosen as a round number: `ps` answers in
 * milliseconds and the Windows read in about 300ms (F122), so ten is far outside the ordinary
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

export function descendantsOf(pid, { run, platform = process.platform, alive = true } = {}) {
  const exec = run ?? ((cmd, args) => spawnSync(cmd, args, { encoding: "utf-8", timeout: PROCESS_TABLE_TIMEOUT_MS, env: tableEnv() }));
  const [cmd, args] = PROCESS_TABLE_COMMAND[platform === "win32" ? "win32" : "posix"];
  let out;
  try {
    out = exec(cmd, args);
  } catch (e) {
    return unenumerated(classifyError(e));
  }
  const table = tableFrom(out, cmd);
  return table.error ? unenumerated(table.error) : walkTree(table.rows, { pid, alive });
}

const unenumerated = (error) => ({ pids: [], identities: [], enumerated: false, error });

/** `lstart` names months and days, so the locale is pinned for the reader that parses it. */
const tableEnv = () => ({ ...process.env, LC_ALL: "C" });

function tableFrom(out, cmd) {
  if (!out || out.status !== 0 || typeof out.stdout !== "string")
    return { rows: null, error: out?.error ? classifyError(out.error) : `${cmd}-failed` };
  return { rows: parseProcessTable(out.stdout), error: null };
}

/**
 * A `pid ppid created` table, keyed by pid.
 *
 * ⚠️ **A ROW WITHOUT A READABLE CREATION TIME KEEPS `created: null`, AND NULL IS NEVER A MATCH.** A
 * process whose identity cannot be read cannot be shown to be the one that was tracked, so everything
 * downstream treats it as unverifiable rather than guessing. FILETIME digits are kept as written;
 * an `lstart` date becomes epoch milliseconds. Both compare as integers.
 */
export function parseProcessTable(stdout) {
  const rows = new Map();
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)(?:\s+(.*))?$/);
    if (!m) continue;
    rows.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), created: creationKey(m[3]) });
  }
  return rows;
}

function creationKey(raw) {
  const text = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!text || text === "-") return null;
  if (/^\d+$/.test(text)) return BigInt(text).toString();
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : String(ms);
}

const createdBefore = (a, b) => BigInt(a) < BigInt(b);

/**
 * The descendants of `pid`, deepest first, each with the creation time that identifies it.
 *
 * ⚠️ **DEEPEST FIRST, so a parent is never signalled before the children it might otherwise
 * re-parent away.** Extracted so the synchronous and asynchronous readers cannot disagree about what
 * a process table means — two walks would drift, and the one that drifted would be the one nobody
 * was looking at.
 *
 * ⚠️ **A PARENT ID IS NOT PROOF OF PARENTAGE ON WINDOWS (F116).** Windows never re-parents: a process
 * keeps the parent id it was created with after that parent is gone, and the id can then belong to
 * someone else. So a row counts as a child only if it was created no earlier than its parent. `alive`
 * says whether the root is known to be running, which is the only case in which the row under its pid
 * is the root's own and can supply its creation time.
 *
 * ⚠️ **A CANDIDATE WHOSE ORDER CANNOT BE ESTABLISHED IS NOT TAKEN, AND THE LOOK SAYS SO.** It is left
 * out of `pids`, named in `unverifiable`, and the enumeration is reported unmade.
 */
function walkTree(rows, { pid, alive = true }) {
  const root = Number(pid);
  const rootRow = rows.get(root);
  const rootCreated = alive && rootRow ? rootRow.created : null;

  const children = new Map();
  for (const row of rows.values()) {
    if (row.pid === row.ppid) continue;
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }

  // Breadth-first from the root, then reversed: deepest first.
  const order = [];
  const unverifiable = [];
  const queue = [{ pid: root, created: rootCreated }];
  const seen = new Set([root]);
  while (queue.length) {
    const parent = queue.shift();
    for (const row of children.get(parent.pid) ?? []) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      if (parent.created === null || row.created === null) {
        unverifiable.push(row.pid);
        continue;
      }
      if (createdBefore(row.created, parent.created)) continue;
      order.push({ pid: row.pid, created: row.created });
      queue.push({ pid: row.pid, created: row.created });
    }
  }
  const identities = order.reverse();
  return {
    pids: identities.map((d) => d.pid),
    identities,
    root: { pid: root, created: rootCreated },
    enumerated: unverifiable.length === 0,
    error: unverifiable.length ? "identity-unverifiable" : null,
    unverifiable,
  };
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
export async function descendantsOfAsync(pid, { run, platform = process.platform, alive = true } = {}) {
  const [cmd, args] = PROCESS_TABLE_COMMAND[platform === "win32" ? "win32" : "posix"];
  const exec = run ?? tableReader(PROCESS_TABLE_TIMEOUT_MS);

  let out;
  try {
    out = await exec(cmd, args);
  } catch (e) {
    return { ...unenumerated(classifyError(e)), process: { status: null, timedOut: false, signal: null, error: classifyError(e) } };
  }
  const table = tableFrom(out, cmd);
  const found = table.error ? unenumerated(table.error) : walkTree(table.rows, { pid, alive });
  // ⚠️ HOW THE PROCESS-TABLE PROGRAM ENDED IS RECORDED BESIDE WHAT IT RETURNED (F119). A query killed by its own
  // timeout and one that exited with an error read the same once they are only an `error` string.
  return {
    ...found,
    process: {
      status: out?.status ?? null,
      timedOut: out?.error?.killed === true,
      signal: out?.error?.signal ?? null,
      error: out?.error ? classifyError(out.error) : null,
    },
  };
}

/**
 * The production process-table program, run without blocking.
 *
 * ⚠️ **BOUNDED, AND KILLED IF IT OVERRUNS — MEASURED, NOT PRECAUTIONARY.** A process table is an
 * external program, and on Windows it is PowerShell: an operator's Ctrl+Break reaches every process in
 * the console, and PowerShell answers Ctrl+Break by breaking into its debugger, so a query already in
 * flight never returns. Six supervisors were left hung on exactly that, each holding a wedged
 * `powershell` child, and the shutdown they were in the middle of is the one ACC-0081 requires to be
 * BOUNDED. A query that overruns is killed and reported as an enumeration that failed, which is a
 * fact; waiting for it is a hang.
 */
const tableReader = (timeoutMs) => (c, a) =>
  new Promise((resolve) => {
    execFile(c, a, { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs, env: tableEnv() }, (error, stdout) =>
      resolve(error ? { status: error.code ?? 1, stdout: "", error } : { status: 0, stdout })
    );
  });

/**
 * One read of the whole process table, for re-checking identities, with its own bound.
 *
 * ⚠️ **THE BOUND IS HERE, NOT LEFT TO THE READER.** An injected reader owes this module nothing, and a
 * shutdown that waited on one that never answered would be the hung terminal the budget exists to
 * prevent. A read that has not answered in time is `process-table-timeout`, and every identity it was
 * meant to confirm is then unverifiable.
 */
export async function readProcessTable({ run, platform = process.platform, timeoutMs = PROCESS_TABLE_TIMEOUT_MS } = {}) {
  const [cmd, args] = PROCESS_TABLE_COMMAND[platform === "win32" ? "win32" : "posix"];
  const exec = run ?? tableReader(timeoutMs);
  const expired = Symbol("expired");
  let timer;
  try {
    const out = await Promise.race([
      Promise.resolve().then(() => exec(cmd, args)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(expired), timeoutMs);
      }),
    ]);
    return out === expired ? { rows: null, error: "process-table-timeout" } : tableFrom(out, cmd);
  } catch (e) {
    return { rows: null, error: classifyError(e) };
  } finally {
    clearTimeout(timer);
  }
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
/**
 * Read the process table ONCE before anything is spawned, so the shutdown never pays for the first read.
 *
 * ⚠️ **MEASURED, AND THIS IS THE DEFECT IT ANSWERS (F119).** In CI run 35055338147 the first Windows
 * query of a run took 7,114ms between its child starting and that child's first byte, while the process
 * itself started in 13ms and every later query answered in about 300ms. Both trees' first queries unblocked
 * in the same millisecond despite starting 450ms apart, and a WMI-free enumeration of the same machine at
 * the same moment finished in 68ms — so the cost is neither load nor process creation, it is one shared
 * first use of the WMI provider. Paid here, before either child exists, it is not paid during a teardown an
 * operator is waiting out.
 *
 * ⚠️ **THE WMI PROVIDER IS GONE, AND THE PREFLIGHT STAYS (F122).** Even primed, the CIM read exceeded this
 * bound in CI run 35097288227, so the table is now read without WMI. The preflight remains ACC-0081's launch
 * prerequisite: it proves, before anything is spawned, that the reader answers within its bound and can show
 * this process its own identity.
 *
 * ⚠️ **THE TABLE IS NOT KEPT.** Only its row count is reported. A table read before the children existed
 * describes a machine none of them were on, and a shutdown that trusted it would be verifying identities
 * against a snapshot older than the processes it is about to signal.
 *
 * ⚠️ **AND IT MUST FIND THIS PROCESS IN IT.** A table that answers but cannot show the supervisor its own
 * pid and creation time is not a table this run can verify anything against, so it refuses rather than
 * starting children it would only be able to fail closed on.
 *
 * POSIX does not run it at all: `ps` answers in milliseconds and has no provider to start.
 */
export async function primeProcessTable({
  psRun,
  platform = process.platform,
  timeoutMs = PROCESS_TABLE_TIMEOUT_MS,
  pid = process.pid,
  clock = () => performance.now(),
} = {}) {
  if (platform !== "win32") return { ran: false, ok: true, verified: false, reason: "not-windows", ms: 0, rows: null };
  const started = clock();
  // The production reader, the production command, the existing bound: priming what the run will use.
  const table = await readProcessTable({ run: psRun, platform, timeoutMs });
  const ms = Math.round((clock() - started) * 10) / 10;
  const failed = (reason, rows = null) => ({ ran: true, ok: false, verified: false, reason, ms, rows });
  if (table.error) return failed(table.error);
  const row = table.rows.get(pid);
  if (!row) return failed("supervisor-not-in-table", table.rows.size);
  if (row.created === null) return failed("creation-time-unavailable", table.rows.size);
  return { ran: true, ok: true, verified: true, reason: null, ms, rows: table.rows.size };
}

export const TRACK_INTERVAL_MS = Object.freeze({ posix: 500, win32: 3000 });

const relativeMs = (t, origin) => (t === null ? null : Math.round((t - origin) * 10) / 10);

/** One query as a record: plain values, copied, with times relative to `origin`. */
function queryView(q, origin) {
  return {
    id: q.id,
    tree: q.tree,
    look: q.look,
    startMs: relativeMs(q.start, origin),
    endMs: relativeMs(q.end, origin),
    durationMs: q.end === null ? null : Math.round((q.end - q.start) * 10) / 10,
    leaderAliveAtStart: q.leaderAliveAtStart,
    leaderAliveAtEnd: q.leaderAliveAtEnd,
    descendants: q.descendants && [...q.descendants],
    identities: q.identities && q.identities.map((d) => ({ ...d })),
    unverifiable: q.unverifiable && [...q.unverifiable],
    process: q.process && { ...q.process },
    error: q.error,
    classification: q.classification,
    discarded: q.discarded,
    discardReason: q.discardReason,
    unresolvedAtFinalize: q.unresolvedAtFinalize,
    completedAfterFinalize: q.completedAfterFinalize,
    lateOutcome: q.lateOutcome && { ...q.lateOutcome },
    completedAfterRootExit: q.completedAfterRootExit,
    rootRow: q.rootRow && { ...q.rootRow },
    rootVerification: q.rootVerification,
  };
}

export function trackDescendants(
  child,
  {
    psRun,
    platform = process.platform,
    intervalMs = TRACK_INTERVAL_MS[platform === "win32" ? "win32" : "posix"],
    now = () => Date.now(),
    tree = null,
    clock = () => performance.now(),
  } = {}
) {
  // ⚠️ **IDENTITIES, NOT PIDS (F116).** Each descendant is kept with the creation time it had when a look
  // saw it, so the shutdown can tell the tracked process from whoever holds its pid by then. The leader's
  // own creation time is recorded from the first look that could read it.
  const identities = new Map();
  let leader = null;
  // ⚠️ **THREE FACTS ABOUT THE LOOKS, NOT ONE FLAG.** A query that could not be RUN and a query whose
  // answer arrived too late are different failures, and one of them is ordinary: the run's normal end
  // is the agent exiting, which is exactly when a poll already in flight becomes unusable.
  let failed = 0; // looks whose process table could not be read or parsed at all
  let clean = 0; // looks that completed while the leader lived, or whose table held the identity captured then
  let raced = 0; // looks whose answer arrived after the leader had gone
  let unresolved = 0; // looks still in flight when the shutdown stopped waiting for them
  let timer = null;
  let inFlight = null;
  let stopped = null;
  // ⚠️ **ONE RECORD PER QUERY, BECAUSE THE COUNTS COULD NOT SAY WHY A LOOK NEVER CAME BACK (F119).** A tree reported
  // `unresolved: 1` twice in a row in CI, and nothing recorded when that query started, whether the leader was
  // alive then, or how long it had run. Each query now keeps its own timing and outcome on a monotonic clock.
  // The records describe the looks; they decide nothing, and every count above is kept exactly as it was.
  const queries = [];
  const startedAt = clock();
  let finalizedAt = null;
  let inFlightQuery = null;
  // ⚠️ **A TABLE IS ABOUT THIS ROOT ONLY IF IT HOLDS THE IDENTITY CAPTURED WHILE THE ROOT WAS KNOWN ALIVE (F118).** A
  // pid and an observed exit time prove nothing: the process can exit, its pid be reused, and the exit callback still
  // arrive later. So the row under the root's pid must carry exactly the creation time captured from a look that
  // completed before the exit was reported. Until one is captured, a table that answers after the exit cannot be
  // attributed, and stays raced. A row that contradicts the captured identity is never the root, whatever Node says.
  const rootVerification = (created, rootExited) => {
    if (created === null) return "unavailable";
    if (leader) return created === leader.created ? "verified" : "mismatch";
    return rootExited ? "identity-not-captured" : "captured";
  };
  // ⚠️ A QUERY CLASSIFIED UNRESOLVED WHEN THE SHUTDOWN STOPPED WAITING KEEPS THAT CLASSIFICATION. If it answers
  // later, what it would have been is recorded beside it, because the shutdown acted on `unresolved`.
  const classify = (query, classification, discardReason, discarded, extra = {}) => {
    if (query.classification === "unresolved") {
      query.lateOutcome = { classification, discardReason };
      return;
    }
    Object.assign(query, { classification, discardReason, discarded }, extra);
  };

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
    const query = {
      id: `${tree ?? "tree"}-${queries.length + 1}`,
      tree,
      look: queries.length + 1,
      start: clock(),
      end: null,
      leaderAliveAtStart: !exited(child),
      leaderAliveAtEnd: null,
      descendants: null,
      identities: null,
      unverifiable: null,
      process: null,
      error: null,
      classification: "in-flight",
      discarded: null,
      discardReason: null,
      unresolvedAtFinalize: false,
      completedAfterFinalize: false,
      lateOutcome: null,
      completedAfterRootExit: null,
      rootRow: null,
      rootVerification: null,
    };
    queries.push(query);
    inFlightQuery = query;
    inFlight = descendantsOfAsync(child.pid, { run: psRun, platform, alive: true }).then((found) => {
      Object.assign(query, {
        end: clock(),
        leaderAliveAtEnd: !exited(child),
        descendants: [...(found.pids ?? [])],
        identities: (found.identities ?? []).map((d) => ({ ...d })),
        unverifiable: [...(found.unverifiable ?? [])],
        process: found.process ?? null,
        error: found.error ?? null,
        completedAfterFinalize: finalizedAt !== null,
      });
      // ⚠️ **A SAMPLE THE LEADER DID NOT SURVIVE DESCRIBES SOMEBODY ELSE'S CHILDREN.** Reading a
      // process table is not instant — on Windows it is well over a second — and if the leader died
      // while the query was in flight, its children have been re-parented by the time the answer
      // arrives. The table then honestly shows it with no children, and taking that at face value is
      // the empty list that claims a tree with no children, which is exactly what clause 7 forbids.
      // So its answer is DISCARDED and the look is counted as raced.
      //
      // ⚠️ **UNLESS THE TABLE HOLDS THE ROOT ITSELF, WHICH THE LEADER'S STATE AT COMPLETION CANNOT SAY (F118).** CI
      // recorded a Windows query that read the table while the agent lived, found its real child, and answered
      // 364ms after the agent exited. Discarding it left the tree with no clean look and refused a shutdown that
      // had seen everything. Whether an answer describes this root is a question of identity: a table holding the
      // root's own row, with the creation time captured while the root was known alive, is about the root however
      // late it arrives. Nothing else is: not a row created before the exit was observed, because the exit callback
      // can be late, and not a row seen before any identity was captured. Those stay raced.
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
      const rootExited = exited(child);
      query.rootRow = found.root?.created ? { ...found.root } : null;
      query.rootVerification = rootVerification(found.root?.created ?? null, rootExited);
      query.completedAfterRootExit = rootExited;
      if ((rootExited && query.rootVerification !== "verified") || query.rootVerification === "mismatch") {
        raced += 1;
        classify(query, "raced", "leader-exited-before-completion", true);
        inFlight = null;
        inFlightQuery = null;
        return;
      }
      if (found.enumerated) clean += 1;
      else failed += 1;
      if (found.enumerated) classify(query, "clean", null, false);
      else if (found.error === "identity-unverifiable") classify(query, "failed", "unverifiable-candidates-dropped", false);
      else classify(query, "failed", "table-unreadable", true);
      // ⚠️ THE ROOT'S IDENTITY IS CAPTURED ONLY FROM A LOOK THAT COMPLETED WHILE THE ROOT WAS KNOWN ALIVE. A look that
      // completed after the exit reaches this line only when it already matched the captured identity. Node reports
      // a child's exit only once it has reaped the process or before it closes the process handle, so until then its
      // pid cannot belong to anyone else.
      if (!leader && found.root?.created) leader = { ...found.root };
      for (const d of found.identities ?? []) identities.set(`${d.pid}:${d.created}`, d);
      inFlight = null;
      inFlightQuery = null;
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
    //
    // ⚠️ **COPIES, SO A QUERY THAT ANSWERS LATER CANNOT REWRITE A RECORD ALREADY TAKEN.** `origin` is the monotonic
    // moment the shutdown began; every query time is reported relative to it, so a look that started before the
    // teardown reads as negative.
    snapshot: ({ origin = null } = {}) => ({
      pids: [...new Set([...identities.values()].map((d) => d.pid))],
      identities: [...identities.values()],
      leader,
      enumerated: clean > 0,
      looks: { clean, raced, failed, unresolved },
      queries: queries.map((q) => queryView(q, origin ?? startedAt)),
      queryTiming: {
        origin: origin === null ? "tracking-start" : "shutdown-start",
        trackingStartedMs: relativeMs(startedAt, origin ?? startedAt),
        finalizedMs: relativeMs(finalizedAt, origin ?? startedAt),
      },
    }),
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
        if (outcome === expired) {
          unresolved += 1;
          if (inFlightQuery?.end === null) classify(inFlightQuery, "unresolved", "unresolved-at-finalize", true, { unresolvedAtFinalize: true });
        }
        finalizedAt = clock();
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
 * ⚠️ **EVERY SIGNAL GOES TO A PROCESS WHOSE IDENTITY WAS JUST CHECKED (F116).** A pid outlives its
 * process as a number, and this function used to send `taskkill /T /F` to remembered pids, including
 * an agent that had already exited. Measured with a harness-owned stand-in holding such a pid: the
 * stand-in and its child were ended, and the record said the tree had stopped. Now each tracked
 * descendant is (pid, creation time), re-read from the process table immediately before it is
 * classified as alive and before any signal; it is signalled on its own, deepest first, without `/T`;
 * and a leader is signalled only while it has not exited, when the handle this process holds is what
 * vouches for its pid. What cannot be verified is sent nothing, recorded with its reason, and keeps the
 * tree from being reported stopped.
 *
 * ⚠️ **A WINDOW REMAINS BETWEEN THE CHECK AND THE SIGNAL.** A verified process can exit and its pid be
 * reused in the moment between the read and the kill. Closing that needs a job object or a signal sent
 * through a handle to the verified process, neither of which this does.
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
    identityReadMs = null,
    // The floors under this tree's identity reads and waiting periods, taken from the whole teardown's
    // budget by its caller. A direct caller's own periods are the whole budget.
    identityFloorMs = null,
    waitFloorMs = null,
    timeline = null,
    // O12: the one deadline every allowance below is drawn from. A direct caller without one gets a
    // deadline of its own periods, so its teardown is bounded by exactly what it asked for.
    deadline = null,
    tree = null,
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
    // Each descendant's pid AND creation time, deepest first: the identity every signal is checked against.
    descendantIdentities: null,
    descendantsEnumerated: null,
    // ⚠️ HOW THE ENUMERATION WENT, not only whether it counted. A tree enumerated by two clean looks
    // and one that raced the leader's exit is a different observation from one enumerated by a
    // single look, and ACC-0081 is a criterion about what was actually observed.
    descendantLooks: null,
    // Every tracker query behind those looks, with its timing and outcome (F119), as the snapshot recorded it.
    descendantQueries: null,
    descendantQueryTiming: null,
    descendantsSurviving: null,
    // Still running under a pid whose identity could not be checked: sent nothing, and not a stopped tree.
    descendantsUnverified: null,
    identity: { leaderSignalled: null, reads: 0, withheld: [] },
    // Operations the deadline did not leave time for, named rather than passed over (O12).
    unfinished: [],
    // When the leader's exit and the tree's complete stop were first observed, on the shutdown's clock (R19).
    timing: { leaderExitObservedMs: null, treeStopObservedMs: null },
    treeStopped: false,
  };
  if (!child) return record;
  // ⚠️ **AN EXITED LEADER IS NOT A STOPPED TREE, AND THIS RETURNED TRUE FOR IT.** The normal end of a
  // run is Pi finishing on its own, so this is the path the ordinary shutdown takes — enumeration
  // skipped, no signal sent, a surviving child silently accepted. It now falls through to the same
  // observation as every other case, using the descendants tracked while the leader was alive,
  // because `ps` can no longer relate them to anything once the parent is gone.
  const alreadyExited = exited(child);
  // ⚠️ **R19: EVERY OPERATION BELOW IS TIMED ON THE SHUTDOWN'S CLOCK, AND NONE OF THEM READS THE TIMELINE.** A direct
  // caller without one gets a private timeline, copied into the record.
  const tl = timeline ?? createShutdownTimeline();
  let leaderExitObservedAt = alreadyExited ? tl.now() : null;
  let treeStopObservedAt = null;
  const clock = deadline ?? createShutdownDeadline({ at: Date.now() + graceMs + hardMs });
  // ⚠️ **AN OPERATION THE DEADLINE COULD NOT COVER IS NAMED, AND NAMING ONE MAKES THE TREE UNSTOPPED.**
  // It is the difference between a teardown that ran out of time and one that had nothing to do.
  const unfinished = (operation, allowed) => {
    record.unfinished.push({ operation, reason: allowed.reason, remainingMs: allowed.remainingMs });
    tl.observe("deadline-refusal", { tree, operation, reason: allowed.reason });
    return allowed;
  };

  const spawnKill = run ?? ((cmd, args, opts) => spawnSync(cmd, args, { stdio: "ignore", ...opts }));
  const killImpl = kill ?? ((p, sig) => process.kill(p, sig));
  // Each signal and `taskkill` is timed where it is sent, through exactly the call it always made.
  const timed = (kind, attrs, fn, describe = () => null) => {
    const entry = tl.begin(kind, attrs);
    try {
      const result = fn();
      tl.end(entry, describe(result));
      return result;
    } catch (e) {
      tl.end(entry, { error: classifyError(e) });
      throw e;
    }
  };
  // ⚠️ **A TERMINATION IS AN OPERATION WITH A COST, AND IT WAS THE ONE NOTHING BOUNDED.** Each
  // `taskkill` is a process start, measured at 42 to 124ms on Windows and spawned once per verified
  // descendant and once for the leader, all of it after a grace period assigned as if nothing
  // followed. Each now draws its own allowance, and one the deadline cannot cover is not sent.
  const mayTerminate = () => {
    const allowed = clock.allow(KILL_TIMEOUT_MS, { minMs: killMinMs, reserveMs: hardReserveMs });
    if (allowed.granted) return allowed.ms;
    unfinished("terminate", allowed);
    return null;
  };
  const taskkill = (pid, args) => {
    const ms = mayTerminate();
    if (ms === null) return false;
    timed("taskkill", { tree, pid, args, timeoutMs: ms }, () => spawnKill("taskkill", args, { timeout: ms }), (r) => ({ status: r?.status ?? null }));
    return true;
  };
  const signalPid = (pid, sig) => {
    const ms = mayTerminate();
    if (ms === null) return false;
    timed("signal", { tree, pid, signal: sig }, () => killImpl(pid, sig), () => ({ error: null }));
    return true;
  };
  // ⚠️ **SET ON EVERY PATH, AND IT WAS SET ON ONE.** Putting this beside the enumeration inside
  // `resolveDescendants` left it null for the case that matters most: a leader that had ALREADY
  // exited takes the branch below and never calls it — which is the ordinary end of a run, so the
  // record said nothing about how its tree was looked at exactly when the looks were most likely to
  // have raced. It depends only on the snapshot, so it is recorded where the snapshot arrives.
  record.descendantLooks = knownDescendants?.looks ?? null;
  record.descendantQueries = knownDescendants?.queries ?? null;
  record.descendantQueryTiming = knownDescendants?.queryTiming ?? null;

  // ⚠️ **AN IDENTITY READ HAS ITS OWN BOUND, TAKEN FROM THE HARD PERIOD.** It happens inside the
  // teardown an operator is waiting out, so it cannot have the process table's full ten seconds; and a
  // Windows table costs a PowerShell start, so it cannot have less than a floor either.
  const readMs = identityReadMs ?? Math.min(PROCESS_TABLE_TIMEOUT_MS, Math.max(IDENTITY_READ_FLOOR_MS, hardMs));
  // ⚠️ **WHAT A READ NEEDS TO BE WORTH STARTING, AND IT IS THE ONLY OPERATION HERE THAT HAS ONE.** A
  // Windows table answered in 0.4 to 1.4 seconds; one given less cannot answer, and spending the end
  // of a teardown on it buys an unverifiable identity instead of a kill. At most half the escalation
  // period, so the kill it authorises still has the other half, and never more than the period a
  // caller asked for in the first place.
  const readMinMs = Math.min(readMs, identityFloorMs ?? identityFloor(graceMs + hardMs));
  const waitMinMs = waitFloorMs ?? waitFloor(graceMs + hardMs);
  // ⚠️ A TERMINATION IS WORTH SENDING WHENEVER ANY TIME REMAINS. Unlike a read, it does its work in
  // the sending; the allowance bounds how long the tool is waited on, not whether the signal lands.
  const killMinMs = 1;
  // What a grace period holds back so the escalation it precedes can still be observed.
  const hardReserveMs = Math.min(hardMs, SHUTDOWN_MIN_PHASE_MS);
  const readTable = async () => {
    // The kill it exists to authorise, and the period that observes it, are held back from it.
    const allowed = clock.allow(readMs, { minMs: readMinMs, reserveMs: hardReserveMs });
    if (!allowed.granted) {
      unfinished("identity-read", allowed);
      return { rows: null, error: "shutdown-deadline-reached" };
    }
    record.identity.reads += 1;
    const entry = tl.begin("identity-read", { tree, timeoutMs: allowed.ms });
    const table = await readProcessTable({ run: psRun, platform, timeoutMs: allowed.ms });
    const outcome = { error: table.error ?? null, resolved: table.error !== "process-table-timeout", rows: table.rows ? table.rows.size : null };
    // A read the shutdown stopped waiting for did not finish: it is abandoned, never ended.
    if (table.error === "process-table-timeout") tl.abandon(entry, outcome);
    else tl.end(entry, outcome);
    return table;
  };

  // ⚠️ WHAT WAS TRACKED WHILE THE LEADER LIVED IS PREFERRED, because it is the only record that can
  // still relate a survivor to this run. A fresh look is the fallback for a caller that tracked nothing,
  // and only while the leader is alive: once it has gone its pid may be someone else's, and walking from
  // it would enumerate a stranger's tree.
  let fresh = null;
  if (knownDescendants) {
    record.descendantIdentities = identitiesOf(knownDescendants);
    record.descendantsEnumerated = knownDescendants.enumerated !== false;
  } else if (alreadyExited) {
    record.descendantIdentities = [];
    record.descendantsEnumerated = true;
  } else {
    fresh = await readTable();
    const found = fresh.error ? unenumerated(fresh.error) : walkTree(fresh.rows, { pid: child.pid, alive: true });
    record.descendantIdentities = found.identities;
    record.descendantsEnumerated = found.enumerated;
    if (!found.enumerated) record.error ??= found.error;
  }
  record.descendants = record.descendantIdentities.map((d) => d.pid);
  const watched = record.descendantIdentities;

  const verdictsFrom = (table, ds) => new Map(ds.map((d) => [d.pid, identityVerdict(d, table, platform)]));
  const checkIdentities = async (ds) => {
    if (!ds.length) return new Map();
    const table = ds.some((d) => d.created !== null) ? await readTable() : { rows: null, error: null };
    return verdictsFrom(table, ds);
  };
  const withhold = (d, verdict, phase) =>
    record.identity.withheld.push({ pid: d.pid, created: d.created, state: verdict.state, reason: verdict.reason, phase });

  const ask = (hard, verdicts) => {
    const phase = hard ? "escalation" : "request";
    // ⚠️ **A GROUP ONLY EXISTS IF THE CHILD WAS SPAWNED `detached`.** Without it the child sits in
    // THIS process's group, and `kill(-pid)` would signal the supervisor and the operator's shell
    // along with it. So the group form is used only where a group was actually created — the
    // background launcher — and the foreground agent, which must stay in the terminal's foreground
    // group to read from it at all, is signalled directly.
    const signal = hard ? "SIGKILL" : "SIGTERM";
    // ⚠️ NO GRACEFUL REQUEST EXISTS ON WINDOWS. `process.kill(pid, "SIGTERM")` is `TerminateProcess`:
    // a hard kill no handler ever sees.
    record.method =
      platform === "win32"
        ? "taskkill /T /F to a live leader, /F to each verified descendant"
        : `${signal} to ${group ? "the group" : "the process and its descendants"}`;

    // ⚠️ **THE DESCENDANTS FIRST, DEEPEST FIRST, EACH BY ITS OWN VERIFIED PID AND NOTHING ELSE.**
    // Signalling only the leader leaves whatever it spawned. On Windows `/F` without `/T`, because `/T`
    // walks by parent id, and a parent id there can name a process that is not ours (F116). A pid whose
    // identity changed or could not be checked is sent nothing, and the reason is recorded.
    //
    // ⚠️ ENUMERATED ONCE AND REUSED. The escalation pass re-signals the SAME snapshot rather than
    // asking again: by then the parent may be gone, and a fresh `ps` would no longer show its
    // children as descendants of anything this function knows about.
    for (const d of watched) {
      const verdict = verdicts.get(d.pid) ?? { state: "gone", reason: null };
      if (verdict.state === "gone") continue;
      if (verdict.state !== "same") {
        withhold(d, verdict, phase);
        continue;
      }
      if (platform === "win32") {
        taskkill(d.pid, ["/pid", String(d.pid), "/F"]);
        continue;
      }
      try {
        signalPid(d.pid, signal);
      } catch (e) {
        if (e?.code !== "ESRCH") record.error ??= classifyError(e);
      }
    }

    // ⚠️ **A LEADER THAT HAS EXITED IS NOT SIGNALLED AT ALL, BY PID, GROUP OR TREE (F116).** Its pid is
    // no longer vouched for by anything, and on Windows `taskkill /pid <it> /T /F` ended a stranger's
    // whole tree. Its survivors are reached above, one verified pid at a time.
    if (exited(child)) {
      record.identity.leaderSignalled = false;
      return;
    }
    if (platform === "win32") {
      // Signalled only if the deadline paid for it: a refused kill is not a request that was made.
      record.identity.leaderSignalled = taskkill(child.pid, ["/pid", String(child.pid), "/T", "/F"]);
      return;
    }
    try {
      record.identity.leaderSignalled = signalPid(group ? -child.pid : child.pid, signal);
    } catch (e) {
      // A group that has already gone is ESRCH; anything else is worth reporting.
      if (e?.code !== "ESRCH") record.error ??= classifyError(e);
      try {
        timed("signal", { tree, pid: child.pid, signal, via: "handle" }, () => child.kill(signal));
      } catch {}
    }
  };

  // ⚠️ A TREE THAT WAS ALREADY GONE IS RECORDED AS SUCH AND IS NOT ASKED (ACC-0081, clause 2). Its
  // descendants are still observed — that is the point of falling through.
  if (!alreadyExited) {
    // A walk read a moment ago already confirms what it found; otherwise the identities are read now.
    const verdicts = fresh && !fresh.error ? verdictsFrom(fresh, watched) : await checkIdentities(watched);
    ask(false, verdicts);
    record.requested = true;
  }

  // ⚠️ **THE SNAPSHOT IS KEPT AND EVERY PID IN IT IS WATCHED.** Waiting on the leader alone reports
  // a stopped tree the moment the parent goes — while an enumerated descendant is still running, and
  // with escalation skipped because the only thing being watched had already exited. A survivor is
  // exactly what "the tree was stopped" is supposed to rule out.
  const alive = (d) => pidAlive(d.pid, { kill: killImpl });
  let ours = watched;
  // The same test as always, short-circuit included; it also notes the first moment each fact was observed.
  const settled = () => {
    const leaderGone = exited(child);
    if (leaderGone && leaderExitObservedAt === null) leaderExitObservedAt = tl.now();
    const done = leaderGone && !ours.some(alive);
    if (done && treeStopObservedAt === null) treeStopObservedAt = tl.now();
    return done;
  };

  // ⚠️ **GRACE IS ASSIGNED LAST, OUT OF WHAT IS LEFT AFTER VERIFICATION AND TERMINATION (O12).** It
  // used to be a share of the whole remaining budget, which is how a 4,666ms wait was handed out
  // ahead of a 692ms read and a 71ms kill that nothing had set time aside for. A shortened wait is
  // a harsher shutdown, not an unmade observation, so it is not named as unfinished: what it costs
  // is politeness, and the tree's own stop is reported exactly as before.
  const graceAllowed = clock.allow(graceMs, {
    reserveMs: (watched.length ? readMinMs : 0) + hardReserveMs + WAIT_SLACK_MS,
    floorMs: waitMinMs,
  });
  let graceSettled = settled();
  if (!graceAllowed.granted) tl.observe("deadline-refusal", { tree, operation: "grace-wait", reason: graceAllowed.reason });
  else {
    const graceEntry = tl.begin("grace-wait", { tree, ms: graceAllowed.ms });
    graceSettled = await waitUntil(settled, graceAllowed.ms);
    tl.end(graceEntry, { settled: graceSettled });
  }

  if (!settled()) {
    // ⚠️ **A LIVE PID IS NOT YET A LIVE DESCENDANT.** A pid that answers the liveness probe may be a
    // reused one, so identities are re-read here, immediately before deciding what is ours, and that
    // same read is what the escalation acts on.
    const live = watched.filter(alive);
    const verdicts = await checkIdentities(live);
    ours = live.filter((d) => verdicts.get(d.pid)?.state === "same");
    if (!exited(child) || ours.length) {
      record.escalated = true;
      log(`a process tree did not exit within ${graceMs}ms — escalating`);
      // ⚠️ SURVIVORS ARE ESCALATED EVEN AFTER THE PARENT HAS GONE, by their own verified pids.
      ask(true, verdicts);
      // ⚠️ THE PERIOD THAT OBSERVES THE KILL. Without it nothing here saw the effect of what it just
      // sent, so a deadline that cannot pay for it leaves the tree unsettled and says which
      // operation it ran out of time for.
      // ⚠️ A WAIT NEEDS NO MINIMUM, BUT THE CLASSIFICATION AFTER IT DOES. Less waiting observes less;
      // no final read at all is the difference between a named survivor and an unverified pid, so the
      // hard period holds one back. None of the wait is only a problem when the tree had not settled,
      // which is exactly when it is named.
      // Held back only for a classification that will actually happen: nothing still running means
      // nothing left to read, and the wait keeps the time instead.
      const hardAllowed = clock.allow(hardMs, {
        minMs: 1,
        reserveMs: (watched.some(alive) ? readMinMs : 0) + WAIT_SLACK_MS,
        floorMs: waitMinMs,
      });
      if (!hardAllowed.granted) {
        if (!settled()) unfinished("hard-wait", hardAllowed);
      } else {
        const hardEntry = tl.begin("hard-wait", { tree, ms: hardAllowed.ms });
        const hardSettled = await waitUntil(settled, hardAllowed.ms);
        tl.end(hardEntry, { settled: hardSettled });
      }
    } else {
      for (const d of live) {
        const verdict = verdicts.get(d.pid);
        if (verdict.state === "changed" || verdict.state === "unverifiable") withhold(d, verdict, "escalation");
      }
    }
  }

  // ⚠️ REPORTED, NOT ASSUMED. A tree that still has not gone is said so rather than counted as gone,
  // and the leader's exit and the tree's are recorded as the different facts they are. A pid still
  // answering is classified by identity: ours is a survivor, someone else's is not, and one that could
  // not be checked is unverified, which is not a stopped tree either.
  record.exitObserved = exited(child);
  if (record.exitObserved && leaderExitObservedAt === null) leaderExitObservedAt = tl.now();
  const stillLive = watched.filter(alive);
  const finalVerdicts = await checkIdentities(stillLive);
  const inState = (state) => stillLive.filter((d) => finalVerdicts.get(d.pid)?.state === state);
  record.descendantsSurviving = inState("same").map((d) => d.pid);
  record.descendantsUnverified = inState("unverifiable").map((d) => d.pid);
  for (const d of [...inState("changed"), ...inState("unverifiable")]) withhold(d, finalVerdicts.get(d.pid), "final");
  record.treeStopped = record.exitObserved && record.descendantsSurviving.length === 0 && record.descendantsUnverified.length === 0;
  // A tree carries a stop time only if it was stopped; a moment when only its verified part looked settled is not one.
  if (record.treeStopped) treeStopObservedAt ??= tl.now();
  else treeStopObservedAt = null;
  record.timing = { leaderExitObservedMs: leaderExitObservedAt, treeStopObservedMs: treeStopObservedAt };
  if (!timeline) {
    tl.finalize();
    record.timeline = tl.snapshot();
  }
  return record;
}

/**
 * The shortest an identity read is allowed, however little of the hard period is left.
 *
 * ⚠️ MEASURED AGAINST THE THING IT BOUNDS: a Windows CIM query answered in 0.5 to 0.9 seconds on an idle
 * host and is recorded at about 1.4 in CI. A bound below that would make every Windows identity
 * unverifiable, which fails closed but stops nothing.
 */
export const IDENTITY_READ_FLOOR_MS = 2000;

/** A tracked snapshot's identities. A caller that passed bare pids passed no identity, and gets none. */
function identitiesOf(known) {
  if (Array.isArray(known.identities))
    return known.identities.map((d) => ({ pid: Number(d.pid), created: d.created == null ? null : String(d.created) }));
  return (known.pids ?? []).map((pid) => ({ pid: Number(pid), created: null }));
}

/**
 * Whether a tracked process is still the one that was tracked.
 *
 * `same` may be signalled. `gone` needs nothing. `changed` is someone else's process now. `unverifiable`
 * could be either, so it is sent nothing and reported, never assumed in either direction.
 */
function identityVerdict(d, table, platform) {
  if (d.created === null) return { state: "unverifiable", reason: "identity-not-recorded" };
  if (table.error)
    return {
      state: "unverifiable",
      reason: ["process-table-timeout", "shutdown-deadline-reached"].includes(table.error) ? table.error : "process-table-unavailable",
    };
  const row = table.rows.get(d.pid);
  if (!row) return { state: "gone", reason: "not-in-process-table" };
  if (row.created === null) return { state: "unverifiable", reason: "creation-time-unavailable" };
  if (row.created === d.created) return { state: "same", reason: null };
  // ⚠️ **ON POSIX A ONE-SECOND DIFFERENCE IS AMBIGUOUS, NOT A DIFFERENT PROCESS.** `lstart` is whole seconds
  // counted from a boot time the kernel derives from the wall clock, so a clock step between two reads can
  // move the same process by a second. Calling that `changed` would pass over a real survivor and report
  // its tree stopped; calling it `same` would trust a match nobody established. It is unverifiable.
  const apart = BigInt(row.created) - BigInt(d.created);
  if (platform !== "win32" && apart <= 1000n && apart >= -1000n) return { state: "unverifiable", reason: "creation-time-ambiguous" };
  return { state: "changed", reason: "identity-changed" };
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
    // ⚠️ **A SECOND SEAM, BECAUSE THESE ARE DIFFERENT QUESTIONS.** `ask` answers yes or no, which is all the port
    // needs. Choosing between sessions needs what the operator actually typed, and needs to tell an empty line
    // from a closed input: without a terminal it answers `null`, which the picker reads as "cancel".
    askLine = async () => null,
    // ⚠️ THE MODE COMES FROM THE INVOCATION, NOT FROM THE COMMITTED RECORD. `.pi/kiln.json` is
    // committed and shared; which machine keeps its transcripts where is host-specific, so recording
    // it there would make one operator's choice everyone's. DEC-0029 calls external state "an
    // explicit mode" for exactly that reason, and project-local is the default it is explicit against.
    stateMode = STATE_MODE.PROJECT,
    randomBytes,
    validators,
    // ⚠️ **SUPPLIED, NOT RESOLVED HERE, FOR THE REASON THE AGENT IS.** Pi's own session lister comes
    // from the pinned package, and `lib/pi-runtime.mjs` imports this module's refusal types — reaching
    // back for it would close that circle at load time. `bin/start-kiln.mjs` owns both halves and
    // passes it in, exactly as it passes the command that runs.
    sessionLister,
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

  // ⚠️ **WHICH SESSION IS SETTLED BEFORE ANYTHING IS STARTED (ACC-0103).** An unresolved session used to be
  // discovered after the launcher had started and passed readiness, so its refusal had a child to stop. The
  // plan only reads — the record and Pi's own listing — so it runs here, before the port, the process-table
  // preflight and either child, and a refusal leaves nothing to stop.
  //
  // ⚠️ **THE IDS COME FROM PI'S OWN LISTER (F121).** Session files are `<timestamp>_<uuid>.jsonl` and the id
  // lives in the header, a different value from the uuid in the name.
  const sessionRoots = stateRootFor({
    mode: stateMode,
    projectRoot: root,
    projectId: project.projectId,
    platform: deps.platform,
    env,
    home: deps.home,
  });
  const plan = await planSession({
    stateRoot: sessionRoots.root,
    projectId: project.projectId,
    stateMode,
    projectRoot: root,
    lister: sessionLister,
    validators,
  });

  // ⚠️ **AN UNRESOLVED SESSION IS A QUESTION, AND A QUESTION NEEDS SOMEBODY TO ASK.** Where the state is one
  // an operator could resolve — the record is missing, unreadable, invalid, foreign, from another mode, or
  // names a session that has gone — the sessions actually available are presented and the choice is theirs.
  // Where it is not, or where nobody is there, the run refuses: a fresh session started in place of the one
  // they came back for is the failure this exists to prevent, and it looks identical to success.
  let recovery = null;
  if (plan.action === SESSION.ASK && plan.recoverable && interactive) {
    recovery = {
      choice: await chooseSession({
        sessions: plan.available.sessions,
        ask: askLine,
        print: log,
        warning: recoveryWarning(plan.problem),
      }),
      precondition: sessionPrecondition(sessionRoots.root, plan.available),
    };
    if (recovery.choice.action === RECOVERY.CANCEL)
      throw new SupervisorRefusal(
        REFUSAL.SESSION_RECOVERY_DECLINED,
        `No session was chosen, so nothing was started.${NEWLINE}Run Kiln again in this project when you know ` +
          `which conversation to continue.`,
        { problem: plan.problem, reason: recovery.choice.reason ?? null }
      );
  }

  if (plan.action === SESSION.ASK && !recovery)
    throw new SupervisorRefusal(
      REFUSAL.SESSION_UNRESOLVED,
      `This project's recorded planning session could not be resumed (${plan.problem}). Nothing was ` +
        `started, because starting a fresh session here would silently discard the conversation you ` +
        `came back to.${NEWLINE}${describeSessions(plan.available)}` +
        (plan.recoverable
          ? `${NEWLINE}Choosing between them needs a terminal. Run Kiln again in one:${NEWLINE}${recoverInTerminal()}`
          : ""),
      {
        problem: plan.problem,
        recoverable: plan.recoverable,
        storage: plan.available?.state ?? null,
        sessions: plan.available?.sessions?.length ?? 0,
      }
    );

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
  //
  // ⚠️ **AND NO INHERITED SELF-HOST MARKER REACHES EITHER CHILD (ACC-0071, D20).** The orchestrator opens the
  // tool's own content only when `KILN_SELF_HOST` is `validated-v1`, so an exported value must never be the
  // thing that grants it: every spelling is removed here, case-insensitively on Windows, and the agent alone is
  // given the marker below - and only when `resolveSelfHost` returned `selfHost: true`, never from the raw flag.
  const baseEnv = { ...withoutSelfHostMarker(env, deps.platform ?? process.platform), PI_CODING_AGENT_DIR: agentDir };
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
  // ⚠️ **THE PROVIDER IS STARTED BEFORE THE CHILDREN ARE, AND NOTHING IS SPAWNED UNTIL IT ANSWERS (F119).**
  // This is awaited in full on purpose: a priming read racing the children would put its cost back inside the
  // window the trees are being tracked in, which is the cost it exists to move.
  const preflight = await primeProcessTable({ psRun: deps.psRun, platform: deps.platform });
  if (!preflight.ok)
    throw new SupervisorRefusal(
      REFUSAL.PROCESS_TABLE_NOT_PRIMED,
      `This run could not read the process table before starting anything (${preflight.reason}). Kiln needs it ` +
        `to see what each process tree spawns and to verify a process\'s identity before signalling it, so a run ` +
        `that cannot read it now would be unable to stop cleanly later. Nothing has been started.`,
      { reason: preflight.reason, ms: preflight.ms, rows: preflight.rows }
    );

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
  const launcherTree = trackDescendants(launcherChild, { psRun: deps.psRun, platform: deps.platform, tree: "launcher" });

  let ready = null;
  let shutdownRecord = null;
  // ⚠️ **WHAT THIS INVOCATION CREATED, ACCUMULATED AS IT CREATES IT.** The shutdown removes exactly
  // this list and nothing that matches a pattern, so a path only ever arrives here from the call
  // that wrote it — including on the refusal paths, where the `finally` shutdown reads the same
  // array and removes whatever had been written by the time the run stopped.
  const ownedFiles = [];
  let agentChild = null;
  let agentTree = null;
  // The resume guard's files, cleared on every path out of this function.
  let guard = null;
  // R19: the agent's exit event and the teardown's timeline, on one monotonic clock.
  let agentExitObservedAt = null;
  let shutdownTimeline = null;

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
    // The monotonic moment the teardown began: every recorded query time is relative to it (F119).
    const origin = performance.now();
    shutdownTimeline = createShutdownTimeline({ origin });
    if (agentExitObservedAt !== null) shutdownTimeline.observe("leader-exit-event", { tree: "agent" }, agentExitObservedAt);
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
      // The same two joins, in the same order, each timed on the teardown's clock (R19).
      const joined = (tree, tracker) => {
        if (!tracker) return undefined;
        const entry = shutdownTimeline.begin("tracker-join", { tree, joinMs });
        return tracker.stop({ joinMs }).then(() => shutdownTimeline.end(entry, { unresolved: tracker.snapshot().looks.unresolved }));
      };
      await Promise.all([joined("launcher", launcherTree), joined("agent", agentTree)]);

      return shutdown({
        deadline,
        agent: agentChild,
        launcher: launcherChild,
        agentDescendants: agentTree?.snapshot({ origin }) ?? null,
        launcherDescendants: launcherTree.snapshot({ origin }),
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
        timeline: shutdownTimeline,
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
    const agentEnv = { ...baseEnv, PORT: String(port), ...(mode.selfHost === true ? { [SELF_HOST_MARKER]: SELF_HOST_VALIDATED } : {}) };
    // ⚠️ **THE SESSION WAS PLANNED BEFORE ANYTHING STARTED, AND IS RECORDED HERE, BEFORE PI IS (ACC-0103).**
    // "The agent started" is not "the session resumed": a brand-new unrelated session starts just as
    // successfully. So the id is written down here and passed to Pi as `--session-id`, the same value on both
    // paths, and `recordSession` re-plans under its lock in case the state moved since.
    // ⚠️ A FIRST RUN MINTS THE ID RATHER THAN READING PI'S CHOICE BACK. `--session-id` creates the
    // session when it is missing, so Kiln names it and never has to parse a file it does not own.
    const chosen = recovery
      ? recovery.choice.action === RECOVERY.RESUME
        ? recovery.choice.sessionId
        : generateSessionId(randomBytes)
      : plan.action === SESSION.RESUME
        ? plan.sessionId
        : generateSessionId(randomBytes);
    const recorded = await recordSession({
      stateRoot: stateRoots.root,
      projectId: project.projectId,
      stateMode,
      projectRoot: root,
      lister: sessionLister,
      sessionId: chosen,
      validators,
      // S2: what was chosen, and what the state looked like when the question was asked.
      choice: recovery?.choice ?? null,
      precondition: recovery?.precondition ?? null,
    });
    if (!recorded.ok)
      throw new SupervisorRefusal(
        REFUSAL.SESSION_RECORD_UNWRITABLE,
        `The session this run would start could not be recorded (${recorded.problem}${
          recorded.code ? `, ${recorded.code}` : ""
        }). Nothing was started: a session nothing points at is one no later run can return to.` +
          (recorded.problem === SESSION_PROBLEM.NO_RUNTIME_DIR
            ? `${NEWLINE}Re-run setup for this project, which creates the runtime directory.`
            : ""),
        { problem: recorded.problem, code: recorded.code ?? null }
      );

    // The winner of a concurrent first run is adopted rather than overwritten, so the id passed to Pi
    // is always the one now on disk.
    const sessionId = recorded.sessionId;
    // ⚠️ **THE SECOND HELPER TAKES THE FIRST'S ENVIRONMENT, NOT THE BASE ONE.** Passing `agentEnv` here
    // discarded the `PI_CODING_AGENT_SESSION_DIR` that `withSessionDir` had just set, so the flag and the
    // variable stopped agreeing — which is the one thing EVD-0081 measured them for.
    const located = withSessionDir(agent, stateRoots.sessions, agentEnv);

    // ⚠️ **A RESUME IS GUARDED FROM INSIDE PI, AND THE GUARD IS SET UP BEFORE PI STARTS (F128).** Kiln writes
    // what it selected — the id, the transcript's canonical path and the digest of the bytes it inspected — to
    // a file only this launch and the guard touch, and passes that file's path. Nothing about the session
    // travels in the environment, and the guard's answer comes back as a code.
    const resuming = recorded.action === SESSION.RESUME && recorded.sessionFile && recorded.digest;
    if (resuming) {
      guard = createGuardFile({
        runtimeDir: stateRoots.runtime,
        expected: { sessionId, file: canonicalPath(recorded.sessionFile), digest: recorded.digest },
        randomBytes,
      });
      if (!guard.ok)
        throw new SupervisorRefusal(
          REFUSAL.SESSION_GUARD_UNWRITABLE,
          `The check that proves Pi opened the recorded session could not be set up (${guard.problem}). Nothing ` +
            `was started: resuming without it would mean trusting that the right conversation was opened.`,
          { problem: guard.problem, code: guard.code ?? null }
        );
    }
    const session = withSessionPolicy(located, sessionId, located.env, {
      resume: resuming ? { guardFile: guard.path, guardExtension: join(mode.toolRoot, "lib", "pi-session-guard.mjs") } : null,
    });
    log(`sessions: ${stateRoots.sessions} (${stateMode} state)`);
    log(`session ${sessionId} (${plan.action === SESSION.RESUME ? "resumed from the record" : "new, recorded"})`);

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

    agentTree = trackDescendants(agentChild, { psRun: deps.psRun, platform: deps.platform, tree: "agent" });

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
    agentExitPromise.then((x) => {
      agentExitSeen = x;
      if (x.spawnError) return;
      const at = performance.now();
      agentExitObservedAt ??= at;
      shutdownTimeline?.observe("leader-exit-event", { tree: "agent" }, at);
    });

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
        // The launch preflight travels with the shutdown it preceded, so a refused run keeps it too (F131).
        { host, port, shutdown: shutdownRecord, agentExit, preflight }
      );

    // ⚠️ **WHAT THE GUARD DECIDED, READ BEFORE THIS RUN IS CALLED A SUCCESS.** Pi exits 1 for many reasons, so
    // "the session was not the recorded one" is knowable only from the guard's own answer.
    if (guard?.ok) {
      const verdict = guard.readResult();
      if (verdict.ok && verdict.outcome === GUARD_OUTCOME.REFUSED)
        throw new SupervisorRefusal(
          REFUSAL.SESSION_GUARD_REFUSED,
          `Pi did not open the session this project recorded (${verdict.code}), so it was stopped. Nothing was ` +
            `written to that conversation by this run.`,
          { code: verdict.code, shutdown: shutdownRecord, agentExit }
        );
      if (!verdict.ok)
        throw new SupervisorRefusal(
          REFUSAL.SESSION_GUARD_NOT_REACHED,
          `Pi ended without the check that proves it opened the recorded session (${verdict.problem}), so this ` +
            `run cannot say which conversation it continued.`,
          { problem: verdict.problem, shutdown: shutdownRecord, agentExit }
        );
    }

    // `preflight` is the launch's own cost and is reported apart from the shutdown budget, which it precedes.
    return {
      runId,
      port,
      projectId: project.projectId,
      ready,
      agentExit,
      preflight,
      shutdown: shutdownRecord,
      trigger: shutdownRecord.trigger,
    };
  } finally {
    // ⚠️ ALWAYS, INCLUDING THE REFUSAL PATHS. A launcher started and then abandoned is the port left
    // held by a process nobody is watching, and a signal handler left installed is this module still
    // owning an operator's Ctrl+C after it has returned.
    stopWatch.dispose();
    // ⚠️ THE GUARD'S FILES GO WHATEVER HAPPENED: a clean run, a refusal, a spawn that failed, a child that died.
    guard?.remove?.();
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
