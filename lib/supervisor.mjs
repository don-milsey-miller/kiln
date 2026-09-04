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
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { canonicalPath, isAtOrInside } from "./content-root.mjs";
import { createRuntimeValidators, assertValidRecord } from "./runtime-records.mjs";
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
};

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
 * The pinned Pi CLI, resolved from the installed package's OWN declaration.
 *
 * ⚠️ **THE MANIFEST SAYS WHERE THE ENTRY POINT IS; GUESSING IS HOW YOU RUN A DIFFERENT FILE.** An
 * earlier version tried `dist/cli.js` first with two speculative fallbacks, and `bin.pi` on the
 * pinned version is `dist/bundle/cli.js` — a different file that happens to sit beside it. The
 * package declares one entry point and that is the one an operator's `pi` would run.
 *
 * ⚠️ **NAME AND VERSION ARE CHECKED AGAINST THE PIN, and the path is contained inside the package.**
 * `bin.pi` is data from a manifest on disk; a relative path escaping the package directory would be
 * this supervisor handing the operator's terminal to something outside the thing it pinned.
 */
export function resolvePinnedAgent(toolRoot, { name, version } = {}) {
  const root = canonicalPath(toolRoot);
  const expectName = name ?? readOwnPin(root).name;
  const expectVersion = version ?? readOwnPin(root).version;
  const pkgDir = join(root, "node_modules", ...expectName.split("/"));
  const manifestPath = join(pkgDir, "package.json");

  const refuse = (message, detail = {}) =>
    new SupervisorRefusal(REFUSAL.AGENT_NOT_INSTALLED, message, { package: expectName, ...detail });

  if (!existsSync(manifestPath))
    throw refuse(
      `The pinned agent ${expectName}@${expectVersion} is not installed under ${pkgDir}.` +
        `${NEWLINE}Run setup for this project, which installs the pinned agent runtime.`
    );

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    throw refuse(`${manifestPath} is not readable JSON: ${e.message}`);
  }
  if (manifest.name !== expectName || manifest.version !== expectVersion)
    throw refuse(
      `The installed agent is ${manifest.name}@${manifest.version}, not the pinned ` +
        `${expectName}@${expectVersion}. Refusing rather than starting a version nothing here was ` +
        `measured against.`,
      { installed: `${manifest.name}@${manifest.version}` }
    );

  // ⚠️ **`bin.pi` SPECIFICALLY, NOT "WHATEVER `bin` IS".** A string-valued `bin` is npm shorthand
  // for "one executable named after the package"; accepting it here would run an entry point this
  // contract never names, on a package that declares no `pi` at all.
  const bin = manifest.bin;
  const declared = bin && typeof bin === "object" && !Array.isArray(bin) ? bin.pi : undefined;
  if (typeof declared !== "string" || declared.length === 0)
    throw refuse(`${manifestPath} declares no \`bin.pi\` entry point.`);

  const entry = canonicalPath(join(pkgDir, declared));
  if (!isAtOrInside(entry, canonicalPath(pkgDir)))
    throw refuse(`\`bin.pi\` resolves outside its own package, which nothing legitimate does.`, { entry });
  // ⚠️ **A REGULAR FILE, BECAUSE `existsSync` IS TRUE OF A DIRECTORY.** `bin.pi: "."` resolved to the
  // package root and passed — an entry point that is not a program at all, discovered only when the
  // spawn failed with the terminal already committed.
  let entryStat = null;
  try {
    entryStat = statSync(entry);
  } catch {
    /* reported as missing below */
  }
  if (!entryStat) throw refuse(`\`bin.pi\` points at ${declared}, which is not installed.`, { entry });
  if (!entryStat.isFile()) throw refuse(`\`bin.pi\` points at ${declared}, which is not a file.`, { entry });

  return { command: process.execPath, args: [entry], entry, version: manifest.version };
}

/** The version this checkout pinned, read from its own manifest rather than restated here. */
function readOwnPin(root) {
  const own = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  const name = "@earendil-works/pi-coding-agent";
  return { name, version: own.dependencies?.[name] ?? null };
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
    randomBytes,
    validators,
    log = () => {},
    host = HOST,
    readyMs = 90_000,
    graceMs = 8000,
    hardMs = 3000,
    build = toolVersion(),
  } = deps;

  const root = canonicalPath(projectRoot);
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

  const childEnv = { ...env, PORT: String(port), KILN_RUN_ID: runId, KILN_PROJECT_ID: project.projectId };

  // ⚠️ **`stdio[0]` IS "pipe" AND THAT IS THE WHOLE POINT.** The launcher gets a NEW writable
  // descriptor that only this process can write to and close; it never sees fd 0. Change this to
  // "inherit" and the launcher is a second reader on the operator's terminal, racing Pi for the
  // authentication answer and the first planning message.
  //
  // ⚠️ `shell: false`, explicitly. A shell between here and the child is a second interpreter of the
  // argument array and another process to signal.
  const launcherChild = spawn(launcher.command, launcher.args, {
    cwd: launcher.cwd ?? root,
    env: childEnv,
    stdio: ["pipe", "inherit", "inherit"],
    shell: false,
  });

  // ⚠️ **A SPAWN FAILURE ARRIVES AS AN EVENT.** A missing executable or a permissions problem never
  // throws from `spawn`; it emits `error` a tick later. Unlistened, that is an unhandled event, and
  // for the agent it would also leave the exit promise below pending for ever — the supervisor
  // hanging on a child that was never born.
  let launcherSpawnError = null;
  if (typeof launcherChild.once === "function")
    launcherChild.once("error", (e) => (launcherSpawnError = classifyError(e)));

  let ready = null;
  let shutdown = null;
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

    // ⚠️ **PI GETS THE TERMINAL, INHERITED.** fd 0 passes straight through, which is only safe
    // because the launcher above was given a pipe instead of it.
    const agentChild = spawn(agent.command, agent.args, {
      cwd: agent.cwd ?? root,
      env: { ...env, PORT: String(port) },
      stdio: "inherit",
      shell: false,
    });

    const agentExit = await new Promise((resolve) => {
      agentChild.once("error", (e) => resolve({ code: null, signal: null, spawnError: classifyError(e) }));
      agentChild.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (agentExit.spawnError)
      throw new SupervisorRefusal(
        REFUSAL.SPAWN_FAILED,
        `The agent could not be started: ${agentExit.spawnError}. Nothing was handed the terminal.`,
        { spawnError: agentExit.spawnError }
      );
    log(`the agent exited (${agentExit.signal ? `signal ${agentExit.signal}` : `code ${agentExit.code}`})`);
    shutdown = await stopLauncher(launcherChild, { graceMs, hardMs, log });

    // ⚠️ **A SHUTDOWN NOBODY SAW IS NOT A SUCCESSFUL RUN.** This used to return normally, and the
    // wrapper then exited with Pi's code — so Pi finishing cleanly reported overall success while a
    // launcher that outlived its escalation was still holding the port. The next start would meet
    // an occupied port with no explanation for it.
    if (!shutdown.exitObserved)
      throw new SupervisorRefusal(
        REFUSAL.SHUTDOWN_NOT_OBSERVED,
        `The agent finished, but the application launcher did not exit within its grace period and ` +
          `was not seen to go after escalation. Something may still be listening on ${host}:${port}.`,
        { host, port, shutdown, agentExit }
      );

    return { runId, port, projectId: project.projectId, ready, agentExit, shutdown };
  } finally {
    // ⚠️ Also on the refusal path: a launcher started and then abandoned is the port left held by a
    // process nobody is watching. `stopLauncher` is idempotent on an already-exited child.
    if (!shutdown) await stopLauncher(launcherChild, { graceMs, hardMs, log });
  }
}
