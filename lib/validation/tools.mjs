/**
 * The typed validation tools — the controller's public face, and the thing a contract can be written
 * against.
 *
 * ⚠️ **Written because the validation contract had nothing to verify.** 7b built a working controller
 * as a library function, and `contractFor("validation")` named `validation_controller` as a required
 * capability with **no measured signature behind it** — so #81's signature check would have compared
 * the child against an empty object and passed. **A verification that cannot fail is not a
 * verification**, and that is #94's capability gap reappearing inside a specialist contract.
 *
 * ⚠️ **`validation_capability` probes, exactly as the research side does.** It runs the interpreter
 * and reports the version, so "can this host validate" is a measured answer rather than an assumption
 * — and a host with no Python reports `not-configured` instead of failing at `provision` (DEC-0003).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runJob } from "./controller.mjs";
import { DEFAULT_CEILING, TIER_1_BOUNDARY } from "./job.mjs";
import { capabilityUnavailable, UNAVAILABLE } from "../research/refusal.mjs";

const run = promisify(execFile);

export const VALIDATION_TOOL_SIGNATURES = {
  validation_capability: {
    description:
      "Report whether this host can run tier-1 validation, proven by executing the interpreter. Returns available:false with a reason when it cannot.",
    input: { type: "object", properties: {}, additionalProperties: false },
  },
  validation_run: {
    description:
      "Run one DECLARED validation job under the controller: provision -> execute -> observe -> destroy. Refuses jobs above the approved ceiling before provisioning. Returns an observation record, never a verdict.",
    input: {
      type: "object",
      properties: {
        tier: { type: "integer", minimum: 1, maximum: 3 },
        commands: { type: "array", items: { type: "array", items: { type: "string" } } },
        timeoutMs: { type: "integer", minimum: 1 },
        maxOutputBytes: { type: "integer", minimum: 1 },
        capturePlan: { type: "object" },
        expectedOutputs: { type: "array" },
        inputs: { type: "object" },
        requires: { type: "object" },
      },
      required: ["tier", "commands", "timeoutMs", "maxOutputBytes", "capturePlan", "expectedOutputs"],
      additionalProperties: false,
    },
  },
};

export function createValidationTools(opts = {}) {
  const python = opts.python ?? "python";

  async function validation_capability() {
    try {
      const { stdout, stderr } = await run(python, ["--version"], { timeout: 10_000 });
      return {
        tool: "validation_capability",
        available: true,
        tier: 1,
        interpreter: (stdout || stderr).trim(),
        ceiling: opts.ceiling ?? DEFAULT_CEILING,
        // ⚠️ The boundary is part of the capability report, not a footnote. A caller learning that
        // validation is available must learn in the same breath what it does not provide.
        isolationBoundary: { isolates: TIER_1_BOUNDARY.isolates, doesNotClaim: TIER_1_BOUNDARY.doesNotClaim },
        statement: TIER_1_BOUNDARY.statement,
        probedLive: true,
        signatures: VALIDATION_TOOL_SIGNATURES,
      };
    } catch (e) {
      const out = capabilityUnavailable(
        UNAVAILABLE.NOT_CONFIGURED,
        `No usable Python interpreter (${python}): ${e.code ?? e.message}. Tier 1 provisions a virtual environment and cannot without one.`
      );
      return {
        tool: "validation_capability",
        available: false,
        tier: 1,
        reason: out.reason,
        detail: out.detail,
        mustRecordGap: true,
        signatures: VALIDATION_TOOL_SIGNATURES,
      };
    }
  }

  async function validation_run(job) {
    const capability = await validation_capability();
    // ⚠️ Probe before provisioning. Running first and discovering the interpreter is missing would
    // produce a failed run where the honest answer is "this host cannot validate at all".
    if (!capability.available)
      return { tool: "validation_run", ok: false, phase: "refused", reason: capability.reason, detail: capability.detail, mustRecordGap: true,
               destroy: { outcome: "nothing-to-destroy", reason: "Refused before provisioning: no validation capability on this host." } };
    return { tool: "validation_run", ...(await runJob(job, opts)) };
  }

  return { validation_capability, validation_run };
}

export function validationToolRegistrations(tools) {
  return Object.entries(VALIDATION_TOOL_SIGNATURES).map(([name, spec]) => ({
    name,
    description: spec.description,
    inputSchema: spec.input,
    handler: tools[name],
  }));
}
