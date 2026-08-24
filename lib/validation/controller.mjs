/**
 * The tier-1 validation controller: `provision → execute → observe → destroy` (DEC-0005).
 *
 * ⚠️ **The destroy path is the design, not the epilogue.** Every path out of this function — a job
 * refused before provisioning, a provisioning failure, an execution failure, a timeout, a thrown
 * collector — reaches a recorded destroy attempt, and the recorded outcome is the result of
 * OBSERVING whether the workspace is gone, never of `rm` not having thrown.
 *
 * ⚠️ **A retained environment is never labelled destroyed.** `destroy.outcome` is `"destroyed"` only
 * when the path is verifiably absent afterwards; otherwise it is `"retained"` and carries the path
 * that still exists. A cleanup failure reported as success is worse than a cleanup failure: it leaves
 * the disk dirty AND the record wrong, and only one of those is discoverable later.
 *
 * ⚠️ **Nothing is written outside the workspace, and nothing is timed outside the job's deadline.**
 * Both were holes rather than decisions. Input names were joined onto the workspace unchecked, so a
 * declaration naming `../../escaped.txt` wrote outside the only directory `destroy` disposes of; and
 * every command received the FULL `job.timeoutMs`, so an approved 120s ceiling bounded one command
 * rather than the run, and a ten-command job could burn twenty minutes without exceeding anything.
 * A ceiling that scales with the length of the job is not a ceiling. The execution phase now shares
 * one absolute deadline, and provisioning is capped separately and says so.
 *
 * ⚠️ **`ok` is about the LIFECYCLE; `outputsSatisfied` is about the RESULT.** They are separate on
 * purpose, and for the same reason a command exiting non-zero still leaves `ok: true`: this returns an
 * observation, never a verdict. What changed is that the observation now EXISTS — `expectedOutputs`
 * was a required declaration nothing ever read, so a job could declare a result, produce none, and be
 * recorded as a completed run.
 *
 * ⚠️ **Tier 1 states what it is.** Every observation this emits carries `isolationBoundary`, so the
 * claim that a virtual environment isolates Python dependencies and provides no containment travels
 * with the evidence rather than living in a decision the reader has to go and find.
 */

import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, sep, dirname } from "node:path";
import { tmpdir } from "node:os";

import { checkJob, expectedOutputSpecs, unsafeWorkspacePath, DEFAULT_CEILING, TIER_1_BOUNDARY } from "./job.mjs";
import { collect } from "./collectors.mjs";

const run = promisify(execFile);

/**
 * The allowlisted process environment (DEC-0005). NOT `process.env`: a run that inherits everything
 * inherits every credential the PM happens to have exported, and the tier-1 boundary says it supplies
 * none. Extend deliberately, never by spreading.
 */
export function allowlistedEnv(hostEnv = process.env) {
  const allow = ["PATH", "Path", "SystemRoot", "windir", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "PATHEXT"];
  const out = {};
  for (const k of allow) if (hostEnv[k] !== undefined) out[k] = hostEnv[k];
  return out;
}

/**
 * Resolve a declared, workspace-relative path — and REFUSE anything that leaves the workspace.
 *
 * ⚠️ The second half of a two-part guarantee. `unsafeWorkspacePath` decides, purely and before
 * provisioning, whether a job may run at all; this decides, against the real resolved path, whether a
 * particular file may be opened. Keeping both means a declaration form nobody anticipated still
 * cannot reach outside the disposable directory — the check that matters is the one made against the
 * path the filesystem will actually use.
 */
export function resolveWithin(workspace, relPath) {
  const bad = unsafeWorkspacePath(relPath);
  if (bad) throw new Error(`Declared path ${JSON.stringify(relPath)} ${bad}; it must stay inside the workspace.`);

  const root = resolve(workspace);
  const full = resolve(root, relPath);
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep))
    throw new Error(`Declared path ${JSON.stringify(relPath)} resolves outside the workspace (${full} is not under ${root}).`);
  return full;
}

/**
 * Look for each declared expected output and say what was there.
 *
 * ⚠️ **`present: false` is an OBSERVATION, and `observed: false` is the absence of one.** The
 * distinction is the same one the collectors draw between `unavailable` and `not-captured`: a run that
 * failed at provisioning did not fail to produce its outputs, it never got to the point of producing
 * anything, and a record that flattened those two would license a conclusion neither supports.
 */
export function observeExpectedOutputs(workspace, job) {
  return expectedOutputSpecs(job).map((spec) => {
    let full;
    try {
      full = resolveWithin(workspace, spec.path);
    } catch (e) {
      return { path: spec.path, observed: true, present: false, satisfied: false, reason: e.message };
    }

    let stat = null;
    try {
      stat = statSync(full);
    } catch {
      stat = null;
    }

    if (!stat)
      return {
        path: spec.path,
        observed: true,
        present: false,
        satisfied: false,
        reason: "Declared as an expected output and not present in the workspace: the run did not produce its declared result.",
      };

    if (stat.isDirectory()) return { path: spec.path, observed: true, present: true, kind: "directory", satisfied: true };

    const bytes = stat.size;
    if (spec.minBytes !== null && bytes < spec.minBytes)
      return {
        path: spec.path,
        observed: true,
        present: true,
        bytes,
        satisfied: false,
        reason: `Present at ${bytes} bytes, below the declared minimum of ${spec.minBytes}.`,
      };

    return { path: spec.path, observed: true, present: true, bytes, satisfied: true };
  });
}

/** Expected outputs on a path that never reached the observe phase. Not absent — never looked for. */
function unobservedExpectedOutputs(job, phase) {
  return expectedOutputSpecs(job).map((spec) => ({
    path: spec.path,
    observed: false,
    present: false,
    satisfied: false,
    reason: `The run failed during ${phase}, so this expected output was never looked for.`,
  }));
}

/**
 * Destroy a workspace and REPORT WHAT WAS OBSERVED.
 *
 * @param {string} path
 * @param {{remove?: (p: string) => void, exists?: (p: string) => boolean}} [io] injectable, so a
 *        cleanup failure can be FORCED in a test rather than hoped for.
 */
export function destroyWorkspace(path, io = {}) {
  const remove = io.remove ?? ((p) => rmSync(p, { recursive: true, force: true, maxRetries: 3 }));
  const exists = io.exists ?? existsSync;

  if (!path) return { outcome: "nothing-to-destroy", reason: "No workspace was provisioned." };

  let removalError = null;
  try {
    remove(path);
  } catch (e) {
    removalError = e;
  }

  // ⚠️ The observation, not the absence of an exception. `rmSync` with `force: true` can return
  // without throwing while leaving a directory behind (Windows, a file still open). Trusting the
  // call rather than the filesystem is exactly how a retained environment gets labelled destroyed.
  if (exists(path))
    return {
      outcome: "retained",
      retainedPath: path,
      reason: removalError
        ? `Removal failed (${removalError.code ?? removalError.message}) and the workspace is still present.`
        : "Removal reported success and the workspace is still present.",
      evidencePreserved: true,
    };

  return {
    outcome: "destroyed",
    verifiedAbsent: true,
    ...(removalError ? { note: `Removal reported ${removalError.code ?? removalError.message}, but the workspace is verifiably gone.` } : {}),
  };
}

/**
 * Run one declared job.
 *
 * @param {object} job
 * @param {{ceiling?: object, python?: string, hostEnv?: object, io?: object, baseDir?: string}} [opts]
 * @returns {Promise<object>} an observation record — always including a destroy outcome
 */
export async function runJob(job, opts = {}) {
  const ceiling = opts.ceiling ?? DEFAULT_CEILING;
  const started = opts.now ?? Date.now();

  // ---- refuse BEFORE provisioning (#125). Nothing exists yet, so there is nothing to clean up.
  const check = checkJob(job, ceiling);
  if (!check.ok)
    return {
      ok: false,
      phase: "refused",
      ...check,
      // ⚠️ Still reports a destroy outcome, so "every path reaches a recorded destroy attempt" holds
      // for the refusal path too — and the honest value is that there was nothing to destroy.
      destroy: { outcome: "nothing-to-destroy", reason: "Refused before provisioning; no workspace was created." },
    };

  const hostEnv = opts.hostEnv ?? process.env;
  const env = allowlistedEnv(hostEnv);
  const python = opts.python ?? "python";

  // ⚠️ TWO CAPS, BOTH NAMED, NEITHER PER-COMMAND. `job.timeoutMs` used to be handed to every command
  // in turn, so a job of n commands could run for n times the figure the ceiling authorised (#77) —
  // an authorisation that grows with the thing it authorises is not one. It now bounds the EXECUTION
  // PHASE as a whole, as one absolute deadline the commands share.
  //
  // ⚠️ Provisioning is capped at the CEILING rather than at the job's execution budget. It used to be
  // `min(job.timeoutMs, ceiling)`, which made a job's declared run time double as a cap on setting up
  // the interpreter — so a two-second job could not provision at all on a host where `python -m venv`
  // takes three, and the record blamed `provision` for a figure that was about execution. A venv is a
  // fixed cost of running anything; it is bounded by what the PM approved, not by how long the work
  // is expected to take. Worst-case wall clock is `ceiling.maxTimeoutMs + job.timeoutMs`: two caps,
  // both stated, neither multiplied by the number of commands.
  const provisionCapMs = ceiling.maxTimeoutMs;
  let deadlineAt = Infinity;
  const remainingMs = () => deadlineAt - Date.now();

  let workspace = null;
  let phase = "provision";
  const ctx = { env, hostEnv, python, venvCreated: false };

  try {
    workspace = mkdtempSync(join(opts.baseDir ?? tmpdir(), "vpw-tier1-"));
    ctx.workspace = workspace;

    // Provision: a Python virtual environment. ⚠️ Which isolates DEPENDENCIES. See the boundary.
    const venvPath = join(workspace, ".venv");
    await run(python, ["-m", "venv", venvPath], { cwd: workspace, env, timeout: provisionCapMs });
    ctx.venvCreated = true;
    ctx.python = process.platform === "win32" ? join(venvPath, "Scripts", "python.exe") : join(venvPath, "bin", "python");

    // ⚠️ `resolveWithin`, not `join`. `join(workspace, "../../escaped.txt")` is a valid path outside
    // the only directory this controller disposes of, and it used to be written without comment.
    for (const [name, content] of Object.entries(job.inputs ?? {})) {
      const target = resolveWithin(workspace, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }

    // ---- execute
    phase = "execute";
    deadlineAt = Date.now() + job.timeoutMs; // the shared budget starts when execution does
    const executions = [];
    for (const argv of job.commands) {
      const [cmd, ...args] = argv.map((a) => (a === "{python}" ? ctx.python : a));
      const at = Date.now();

      const budget = remainingMs();
      if (budget <= 0) {
        // Recorded, not silently dropped: a command that never started is a fact about the run, and
        // an execution list that simply ended would look like a job with fewer commands than it had.
        executions.push({
          argv,
          exitStatus: null,
          killed: true,
          timedOut: true,
          stdout: "",
          stderr: "",
          durationMs: 0,
          note: `The job deadline of ${job.timeoutMs}ms was already spent; this command did not start.`,
        });
        break;
      }

      try {
        const { stdout, stderr } = await run(cmd, args, {
          cwd: workspace,
          env,
          timeout: budget,
          maxBuffer: job.maxOutputBytes,
          shell: false, // argument arrays, never a shell string (DEC-0005)
        });
        executions.push({ argv, exitStatus: 0, stdout: cap(stdout, job), stderr: cap(stderr, job), durationMs: Date.now() - at });
      } catch (e) {
        executions.push({
          argv,
          exitStatus: e.code ?? null,
          killed: Boolean(e.killed),
          timedOut: e.killed && e.signal === "SIGTERM",
          stdout: cap(e.stdout ?? "", job),
          stderr: cap(e.stderr ?? "", job),
          durationMs: Date.now() - at,
        });
        break; // a failed step stops the run; the record still says what happened
      }
    }

    // ---- observe
    phase = "observe";
    // ⚠️ Before the capture plan, and before destroy: the workspace is the only place these can be
    // looked for, and `finish` removes it.
    const expectedOutputs = observeExpectedOutputs(workspace, job);
    const { facts, omissions } = await collect(job.capturePlan, ctx);

    return finish({ ok: true, phase: "complete", executions, facts, omissions, expectedOutputs, workspace, started, opts, job });
  } catch (e) {
    // Provisioning or an unexpected failure. The record says which phase, and STILL destroys.
    return finish({
      ok: false,
      phase,
      failure: { message: String(e.message ?? e), code: e.code ?? null },
      executions: [],
      expectedOutputs: unobservedExpectedOutputs(job, phase),
      facts: {},
      omissions: [
        {
          fact: "*",
          state: "not-captured",
          reason: `The run failed during ${phase}, so the capture plan never ran. Nothing here was observed.`,
        },
      ],
      workspace,
      started,
      opts,
      job,
    });
  }
}

function cap(text, job) {
  const s = String(text ?? "");
  return s.length > job.maxOutputBytes ? s.slice(0, job.maxOutputBytes) : s;
}

/** Build the observation record. The ONLY exit, so no path can skip the destroy. */
function finish({ ok, phase, executions, facts, omissions, expectedOutputs, workspace, started, opts, job, failure }) {
  const destroy = destroyWorkspace(workspace, opts.io);
  const outputs = expectedOutputs ?? [];
  return {
    ok,
    phase,
    ...(failure ? { failure } : {}),
    executions,
    // ⚠️ Separate from `ok` on purpose — see the header. `ok` says the controller completed its
    // lifecycle; this says whether the job produced what it declared it would. A job declaring no
    // outputs is vacuously satisfied, which is honest: it promised nothing.
    expectedOutputs: outputs,
    outputsSatisfied: outputs.every((o) => o.satisfied),
    // What actually bounded this run, in the record rather than only in the declaration.
    limits: { executionDeadlineMs: job.timeoutMs, provisionCapMs: (opts.ceiling ?? DEFAULT_CEILING).maxTimeoutMs },
    destroy,
    durationMs: (opts.now ?? Date.now()) - started,
    // The environment record, in exactly the shape #131's schema requires of a controller run.
    environment: {
      execution: "controller",
      sandboxTier: job.tier,
      isolationBoundary: { isolates: TIER_1_BOUNDARY.isolates, doesNotClaim: TIER_1_BOUNDARY.doesNotClaim },
      facts,
      omissions: [
        ...omissions,
        // ⚠️ A retained workspace is a fact about the run, and it belongs in the record rather than
        // only in a log nobody reads.
        ...(destroy.outcome === "retained"
          ? [{ fact: "workspace-destroyed", state: "unavailable", reason: `Cleanup did not complete: ${destroy.reason} The environment is retained at ${destroy.retainedPath}.` }]
          : []),
      ],
    },
  };
}
