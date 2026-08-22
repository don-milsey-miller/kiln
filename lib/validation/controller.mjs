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
 * ⚠️ **Tier 1 states what it is.** Every observation this emits carries `isolationBoundary`, so the
 * claim that a virtual environment isolates Python dependencies and provides no containment travels
 * with the evidence rather than living in a decision the reader has to go and find.
 */

import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkJob, DEFAULT_CEILING, TIER_1_BOUNDARY } from "./job.mjs";
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

  let workspace = null;
  let phase = "provision";
  const ctx = { env, hostEnv, python, venvCreated: false };

  try {
    workspace = mkdtempSync(join(opts.baseDir ?? tmpdir(), "vpw-tier1-"));
    ctx.workspace = workspace;

    // Provision: a Python virtual environment. ⚠️ Which isolates DEPENDENCIES. See the boundary.
    const venvPath = join(workspace, ".venv");
    await run(python, ["-m", "venv", venvPath], { cwd: workspace, env, timeout: Math.min(job.timeoutMs, ceiling.maxTimeoutMs) });
    ctx.venvCreated = true;
    ctx.python = process.platform === "win32" ? join(venvPath, "Scripts", "python.exe") : join(venvPath, "bin", "python");

    for (const [name, content] of Object.entries(job.inputs ?? {})) writeFileSync(join(workspace, name), content);

    // ---- execute
    phase = "execute";
    const executions = [];
    for (const argv of job.commands) {
      const [cmd, ...args] = argv.map((a) => (a === "{python}" ? ctx.python : a));
      const at = Date.now();
      try {
        const { stdout, stderr } = await run(cmd, args, {
          cwd: workspace,
          env,
          timeout: job.timeoutMs,
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
    const { facts, omissions } = await collect(job.capturePlan, ctx);

    return finish({ ok: true, phase: "complete", executions, facts, omissions, workspace, started, opts, job });
  } catch (e) {
    // Provisioning or an unexpected failure. The record says which phase, and STILL destroys.
    return finish({
      ok: false,
      phase,
      failure: { message: String(e.message ?? e), code: e.code ?? null },
      executions: [],
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
function finish({ ok, phase, executions, facts, omissions, workspace, started, opts, job, failure }) {
  const destroy = destroyWorkspace(workspace, opts.io);
  return {
    ok,
    phase,
    ...(failure ? { failure } : {}),
    executions,
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
