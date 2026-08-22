/**
 * The fact collectors — and, more importantly, the four ways a fact can be missing.
 *
 * ⚠️ **Every omission state here is produced by a real code path, not declared and hoped for.**
 * #127 requires the collector's fixtures to justify every schema state; the inverse of that rule is
 * that a state no collector can reach must not exist. These four are reachable:
 *
 *   not-captured   the capture plan explicitly disabled it — someone chose not to look
 *   not-observable no collector exists for that fact on this platform/tier — nothing CAN look
 *   unavailable    a collector ran and the fact was not there — we looked and it was absent
 *   redacted       a collector obtained the value and policy suppressed it — we looked, and you may not see
 *
 * ⚠️ The distinction between the first two is the one that matters most and is easiest to blur.
 * *"We did not look"* and *"nothing could have looked"* license different conclusions about a claim:
 * the first is fixable by asking for it next time, the second is not fixable at all at this tier.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const run = promisify(execFile);

/** Anything whose NAME looks like a secret is redacted whatever its value (DEC-0006). */
const SECRET_PATTERN = /key|token|secret|password|credential/i;

/**
 * A collector returns either `{ value }` or `{ state, reason }`.
 * ⚠️ A collector that cannot get a value must say WHY — returning undefined would make an absent
 * fact indistinguishable from a collector that silently did nothing.
 */
export const COLLECTORS = {
  os: async () => ({ value: `${os.type()} ${os.release()}` }),
  "node-version": async () => ({ value: process.version }),
  "python-version": async (ctx) => {
    try {
      const { stdout, stderr } = await run(ctx.python, ["--version"], { cwd: ctx.workspace, env: ctx.env, timeout: 10_000 });
      return { value: (stdout || stderr).trim() };
    } catch (e) {
      return { state: "unavailable", reason: `The interpreter did not report a version: ${e.code ?? e.message}` };
    }
  },
  "git-commit": async (ctx) => {
    try {
      const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: ctx.workspace, env: ctx.env, timeout: 10_000 });
      return { value: stdout.trim() };
    } catch {
      // ⚠️ The archetypal `unavailable`: collection RAN, and the fact is not there. A fresh
      // workspace is not a repository, so there is no commit — that is an observation, not a gap.
      return { state: "unavailable", reason: "Collection ran: the workspace is not a git repository, so there is no commit to record." };
    }
  },
  workspace: async (ctx) => ({ value: ctx.workspaceKind ?? "fresh temporary directory" }),
  venv: async (ctx) => (ctx.venvCreated ? { value: "created per run" } : { state: "unavailable", reason: "Provisioning did not reach venv creation." }),
};

/**
 * Collect one requested fact.
 * @param {string} name
 * @param {{disabled: Set<string>}} plan
 */
export async function collectFact(name, plan, ctx) {
  if (plan.disabled.has(name))
    return { state: "not-captured", reason: "The capture plan explicitly disabled this fact for this run." };

  // `env:NAME` reads a variable from the allowlisted process environment.
  if (name.startsWith("env:")) {
    const key = name.slice(4);
    if (SECRET_PATTERN.test(key)) {
      const present = key in (ctx.hostEnv ?? {});
      // ⚠️ Redacted only when it was actually OBTAINED. A secret that was not there is `unavailable`
      // — claiming to have suppressed something you never had is a small lie with a confident shape.
      return present
        ? { state: "redacted", reason: `Obtained from the host environment and suppressed by policy: a credential must never reach an evidence record (DEC-0006).` }
        : { state: "unavailable", reason: `Collection ran: ${key} is not set in this environment.` };
    }
    const value = (ctx.env ?? {})[key];
    return value === undefined
      ? { state: "unavailable", reason: `Collection ran: ${key} is not present in the allowlisted environment.` }
      : { value };
  }

  const collector = COLLECTORS[name];
  if (!collector)
    // ⚠️ `not-observable`: nothing on this platform at this tier can produce it. Distinct from
    // not-captured, which means someone chose not to look at something that could have been looked at.
    return { state: "not-observable", reason: `No collector for "${name}" exists on this platform at this tier.` };

  try {
    return await collector(ctx);
  } catch (e) {
    return { state: "unavailable", reason: `The collector for "${name}" failed: ${e.code ?? e.message}` };
  }
}

/**
 * Run a whole capture plan.
 * @returns {{facts: Record<string,string>, omissions: {fact,state,reason}[]}}
 */
export async function collect(plan, ctx) {
  const requested = [...(plan.facts ?? []), ...(plan.disabled ?? [])];
  const disabled = new Set(plan.disabled ?? []);
  const facts = {};
  const omissions = [];
  for (const name of requested) {
    const out = await collectFact(name, { disabled }, ctx);
    if (out.value !== undefined) facts[name] = String(out.value);
    else omissions.push({ fact: name, state: out.state, reason: out.reason });
  }
  return { facts, omissions };
}
