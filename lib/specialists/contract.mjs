/**
 * 7c — specialist contracts, DERIVED from measured tool signatures (#127, DEC-0003).
 *
 * ⚠️ **Nothing here restates a tool's shape.** The contracts import `RESEARCH_TOOL_SIGNATURES` and the
 * typed-tool registry and reference them; they do not copy them. A contract that duplicated a
 * signature would be a second source of truth that drifts the first time a tool changes, and #81's
 * check would then be comparing a child against a document rather than against the host — which is
 * precisely the failure #67 measured, one level up.
 *
 * ⚠️ **A contract describes what the host can supply AND detect.** Every capability named here is
 * probeable, and `verifyChild` refuses output from a child that cannot demonstrate them. A capability
 * that could not be checked would make the contract true on Monday and silently false on Tuesday.
 */

import { RESEARCH_TOOL_SIGNATURES } from "../research/tools.mjs";
import { VALIDATION_TOOL_SIGNATURES } from "../validation/tools.mjs";
import { TYPED_TOOLS, MUTATION_TOOLS } from "../tools/registry.mjs";
import { TAVILY } from "../research/tavily-adapter.mjs";

/** Roles, from #26's roster. */
export const ROLES = ["research", "planning", "validation"];

/**
 * Which environment variables each role's child may see.
 *
 * ⚠️ **This is the injection point DEC-0006 named and nothing implemented.** Until now the credential
 * contract said "injected only into the research child" with nothing to do the injecting, so the
 * boundary was a habit. `childEnv` is that boundary, and the test that proves it spawns real children
 * and asks them what they can read.
 */
const ENV_ALLOW = {
  base: ["PATH", "Path", "SystemRoot", "windir", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "PATHEXT"],
  research: [TAVILY.envVar],
  planning: [],
  validation: [],
};

/**
 * Build the environment for one role's child. NEVER `process.env`.
 * @param {"research"|"planning"|"validation"} role
 */
export function childEnv(role, hostEnv = process.env) {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
  const allow = [...ENV_ALLOW.base, ...ENV_ALLOW[role]];
  const out = {};
  for (const k of allow) if (hostEnv[k] !== undefined) out[k] = hostEnv[k];
  return out;
}

/**
 * The write boundary: which typed tools a role may call.
 *
 * ⚠️ Enforced by ABSENCE, not by refusal (#67's lesson, verified by check 2): an out-of-role tool is
 * not present in the child's registry, so the model cannot call it and then be told no. A boundary
 * that depends on the child choosing to respect it is an instruction, not a boundary.
 */
const WRITE_BOUNDARY = {
  research: { create: ["evidence", "assertion", "question"], mutate: ["linkEvidence", "unlinkEvidence"] },
  planning: { create: ["requirement", "decision", "question", "assertion", "runbook-step"], mutate: ["reviseArtifact", "setLifecycle", "resolveQuestion", "linkEvidence", "unlinkEvidence"] },
  validation: { create: ["evidence"], mutate: ["linkEvidence"] },
};

/** Capabilities each role REQUIRES, named as things the host can probe. */
const REQUIRED_CAPABILITIES = {
  research: ["research_capability", "research_search", "research_fetch"],
  planning: [],
  validation: ["validation_capability", "validation_run"],
};

/**
 * Every measured signature the host publishes, in one place so a contract looks its capabilities up
 * rather than knowing where they live.
 *
 * ⚠️ A capability named by a role and ABSENT here is a contract promising something nothing defines.
 * `contractFor` reports it rather than dropping it silently — that omission is what let the first
 * validation contract require `validation_controller`, a name with no signature behind it, so #81's
 * check would have compared the child against an empty object and passed.
 */
const MEASURED_SIGNATURES = { ...RESEARCH_TOOL_SIGNATURES, ...VALIDATION_TOOL_SIGNATURES };

/**
 * Build a role's contract by REFERENCE to what exists.
 *
 * @param {"research"|"planning"|"validation"} role
 * @returns {object} the contract — signatures included by reference, never restated
 */
export function contractFor(role) {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);

  const toolSignatures = {};
  const undefinedCapabilities = [];
  for (const name of REQUIRED_CAPABILITIES[role]) {
    // ⚠️ Read from the measured signature table. A name with no signature is a contract that would
    // promise something nothing defines — REPORTED here rather than silently skipped.
    if (MEASURED_SIGNATURES[name]) toolSignatures[name] = MEASURED_SIGNATURES[name];
    else undefinedCapabilities.push(name);
  }

  const boundary = WRITE_BOUNDARY[role];
  const unimplemented = boundary.create.filter((t) => !TYPED_TOOLS[t]);
  const unknownMutations = boundary.mutate.filter((m) => !MUTATION_TOOLS[m]);

  return {
    role,
    requiredCapabilities: REQUIRED_CAPABILITIES[role],
    toolSignatures,
    writeBoundary: boundary,
    // ⚠️ Reported, not hidden. A contract naming a write it cannot perform is #94's capability gap
    // inside a specialist definition, and the honest move is to say so at build time.
    unimplemented,
    unknownMutations,
    undefinedCapabilities,
    credentials: ENV_ALLOW[role],
    forbidden: [
      "shell execution",
      "reading environment variables outside the injected allowlist",
      ...(role === "research" ? ["answering from model memory when retrieval is unavailable"] : []),
      ...(role !== "planning" ? ["authoring requirements or decisions"] : []),
    ],
  };
}

/** Why a child's output was refused. */
export const CHILD_REFUSED = {
  NO_STDIN: "task-not-delivered",
  TIMED_OUT: "timed-out",
  CAPABILITY_MISSING: "capability-missing",
  SIGNATURE_MISMATCH: "signature-mismatch",
  OUT_OF_ROLE_WRITE: "out-of-role-write",
};

/**
 * #81 at the acceptance boundary: a child's output is accepted only after it demonstrates the three
 * preconditions. Any failure is a STRUCTURED REFUSAL, never a fallback to prose.
 *
 * ⚠️ **Order matters and is the point.** Capability is checked BEFORE output is read, because a child
 * that produced plausible text without its tools is the exact #67 failure — and text that has already
 * been read is text that has already been believed.
 *
 * @param {object} contract
 * @param {{stdinDelivered: boolean, timedOut: boolean, reportedTools: object, output: any}} run
 */
export function verifyChild(contract, run) {
  const refuse = (reason, detail) => ({ accepted: false, reason, detail, role: contract.role });

  if (!run?.stdinDelivered)
    return refuse(CHILD_REFUSED.NO_STDIN, "The task was never delivered on stdin, so whatever the child produced is not an answer to it.");

  if (run.timedOut)
    return refuse(CHILD_REFUSED.TIMED_OUT, "The child did not finish. Partial output is not a partial answer.");

  const reported = run.reportedTools ?? {};
  for (const name of contract.requiredCapabilities) {
    if (!(name in reported))
      return refuse(CHILD_REFUSED.CAPABILITY_MISSING, `The child could not demonstrate \`${name}\`. Installed-but-unusable is unavailable (DEC-0004).`);
  }

  // The signature check: not "is it there" but "is it the shape the contract was written against".
  for (const [name, spec] of Object.entries(contract.toolSignatures)) {
    const seen = reported[name];
    if (!signaturesMatch(spec, seen))
      return refuse(
        CHILD_REFUSED.SIGNATURE_MISMATCH,
        `\`${name}\` does not match the measured signature the contract was written against. A contract ` +
          `verified against a changed tool is verified against nothing.`
      );
  }

  return { accepted: true, role: contract.role, output: run.output };
}

/** Compare a reported tool against the signature the contract references. */
export function signaturesMatch(spec, seen) {
  if (!seen || typeof seen !== "object") return false;
  const want = Object.keys(spec.input?.properties ?? {}).sort();
  const got = Object.keys(seen.input?.properties ?? {}).sort();
  if (want.length !== got.length || want.some((k, i) => k !== got[i])) return false;
  const wantReq = [...(spec.input?.required ?? [])].sort();
  const gotReq = [...(seen.input?.required ?? [])].sort();
  return wantReq.length === gotReq.length && wantReq.every((k, i) => k === gotReq[i]);
}

/** May this role perform this write? Consulted by the host when registering the child's tools. */
export function mayWrite(contract, { create, mutate }) {
  if (create) return contract.writeBoundary.create.includes(create);
  if (mutate) return contract.writeBoundary.mutate.includes(mutate);
  return false;
}
