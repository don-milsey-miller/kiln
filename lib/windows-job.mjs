/**
 * Start an agent inside a Windows job object, held by a host the supervisor owns — F130 mechanism 2 (TSK-0058).
 * PROTOTYPE: nothing in production uses this yet.
 *
 * ⚠️ **NO FALLBACK.** A host that cannot create the job, create the process, or assign it before it runs refuses with
 * a code, and the caller refuses the launch. Starting the agent the ordinary way instead would bring back the race
 * this exists to remove, silently.
 *
 * ⚠️ **THE ARGUMENTS ARRIVE EXACTLY.** The host calls CreateProcessW with a command line, so this quotes each argument
 * the way the Microsoft C runtime parses it, which is also how libuv quotes for `spawn()`.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const JOB_HOST_SCRIPT = join(import.meta.dirname, "windows", "job-host.ps1");

export class JobHostRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "JobHostRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

/** One argument, quoted so the Microsoft C runtime parses it back to exactly itself. */
export function quoteWindowsArg(arg) {
  const s = String(arg);
  if (s === "") return '""';
  if (!/[ \t"]/.test(s)) return s;
  if (!/["\\]/.test(s)) return `"${s}"`;
  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  return out + "\\".repeat(backslashes * 2) + '"';
}

/** The command line CreateProcessW is given. */
export const windowsCommandLine = (command, args = []) => [command, ...args].map(quoteWindowsArg).join(" ");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
};

/**
 * Start `command args` in a new job held by a host process.
 *
 * @param {object} o
 * @param {string} o.command
 * @param {string[]} [o.args]
 * @param {string} o.controlDir   a private, existing directory for the host's control files
 * @param {object} [o.env]        the agent's environment; the host is started with it and the agent inherits it
 * @param {string} [o.cwd]
 * @param {any} [o.stdio]         the agent's standard handles, passed through the host unchanged
 * @param {number} [o.startTimeoutMs]
 * @returns {Promise<{host: import("node:child_process").ChildProcess, pid: number, startedMs: number,
 *   list: Function, terminate: Function, release: Function, exited: Function}>}
 */
export async function startInJob({ command, args = [], controlDir, env = process.env, cwd, stdio = "inherit", startTimeoutMs = 60_000, spawnImpl = nodeSpawn }) {
  const plan = join(controlDir, "plan.json");
  writeFileSync(plan, JSON.stringify({ commandLine: windowsCommandLine(command, args), controlDir, parentPid: process.pid }));
  const host = spawnImpl("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", JOB_HOST_SCRIPT, "-Plan", plan], {
    cwd,
    env,
    stdio,
    shell: false,
  });
  let hostExit = null;
  host.once("exit", (code) => (hostExit = code));
  host.once("error", (e) => (hostExit = e?.code ?? "spawn-error"));

  const deadline = Date.now() + startTimeoutMs;
  let started = null;
  while (!started) {
    started = readJson(join(controlDir, "started.json"));
    if (started) break;
    const failed = readJson(join(controlDir, "failed.json"));
    if (failed) throw new JobHostRefusal(failed.reason, `The job host could not start the agent inside a job (${failed.reason}).`, failed);
    if (hostExit !== null) throw new JobHostRefusal("host-exited", `The job host exited (${hostExit}) before it started the agent.`, { code: hostExit });
    if (Date.now() > deadline) {
      host.kill();
      throw new JobHostRefusal("host-start-timeout", `The job host did not start the agent within ${startTimeoutMs}ms.`, {});
    }
    await sleep(20);
  }

  let next = 0;
  /** One request to the host, answered within `timeoutMs` or refused. */
  const request = async (op, timeoutMs = 5000) => {
    const id = `${process.pid}-${++next}`;
    const tmp = join(controlDir, `req-${id}.tmp`);
    writeFileSync(tmp, JSON.stringify({ op }));
    renameSync(tmp, join(controlDir, `req-${id}.json`));
    const answer = join(controlDir, `res-${id}.json`);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const res = readJson(answer);
      if (res) return res;
      if (hostExit !== null && !existsSync(answer)) return { op, ok: false, error: "host-exited" };
      await sleep(10);
    }
    return { op, ok: false, error: "host-timeout" };
  };

  return {
    host,
    pid: started.pid,
    startedMs: started.startedMs,
    list: (timeoutMs) => request("list", timeoutMs),
    terminate: (timeoutMs) => request("terminate", timeoutMs),
    release: (timeoutMs) => request("release", timeoutMs),
    exited: () => readJson(join(controlDir, "exited.json")),
  };
}

/**
 * The agent as the supervisor holds it in job mode: the agent's pid, and its exit as the host reports it.
 *
 * ⚠️ **THE SUPERVISOR WAITS ON THE AGENT, NOT ON THE HOST.** The host outlives the agent on purpose, so the job can be
 * observed and ended after the agent exits; its own exit follows `release`. So this reports `exit` when the host
 * reports the agent's, or, if the host goes first, when the host does.
 */
export function jobAgentProcess(job, { pollMs = 25 } = {}) {
  const emitter = new EventEmitter();
  const agent = {
    pid: job.pid,
    exitCode: null,
    signalCode: null,
    host: job.host,
    once: (event, cb) => (emitter.once(event, cb), agent),
    on: (event, cb) => (emitter.on(event, cb), agent),
    kill: () => (job.terminate(), true),
  };
  const finish = (code) => {
    if (agent.exitCode !== null) return;
    agent.exitCode = code;
    clearInterval(timer);
    emitter.emit("exit", code, null);
  };
  const timer = setInterval(() => {
    const exited = job.exited();
    if (exited) finish(exited.code);
  }, pollMs);
  job.host.once("exit", (code) => finish(job.exited()?.code ?? code ?? 1));
  return agent;
}

/** An agent the host could not start: it reports an `error`, which the supervisor refuses as a failed spawn. */
export function failedJobAgent(refusal) {
  const emitter = new EventEmitter();
  // The code is what the supervisor prints, and it prints only a word: letters, digits and underscores.
  const error = Object.assign(new Error(refusal.message), { code: `JOB_HOST_${String(refusal.reason ?? "failed").toUpperCase().replace(/[^A-Z0-9]/g, "_")}` });
  setImmediate(() => emitter.emit("error", error));
  return { pid: null, exitCode: null, signalCode: null, once: (e, cb) => (emitter.once(e, cb), undefined), on: (e, cb) => emitter.on(e, cb), kill: () => false };
}
