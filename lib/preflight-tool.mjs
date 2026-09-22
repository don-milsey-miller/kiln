/**
 * `kiln_preflight`, the setup-only canary tool — TSK-0041, CMP-0030, against ACC-0061 and ACC-0062.
 *
 * ⚠️ **THIS MODULE IMPORTS NOTHING, AND A TEST HOLDS IT TO THAT.** The tool has no access to planning content,
 * mutation, research, validation, delegation or the shell because nothing that provides them is reachable from
 * here. A capability it cannot import is one it cannot be given by accident.
 *
 * ⚠️ **NOT IN THE ORCHESTRATOR'S REGISTRY.** The package's entry (`pi-package/extensions/kiln.js`) does not
 * register it and its signature does not declare it, so the user-facing session, whose tool allowlist is the
 * validated signature, and every specialist cannot be offered it. It exists only as a custom tool of the
 * canary's own session, which is a separate process that ends before setup continues.
 *
 * ⚠️ **ONE ARGUMENT, EXACTLY.** The schema accepts an object holding `challenge` and nothing else, and the
 * challenge is 32 lowercase hexadecimal characters. The acknowledgement is fixed: it says nothing about the
 * challenge, so a model cannot learn from the result what it should have sent.
 */

export const PREFLIGHT_TOOL_NAME = "kiln_preflight";

/** The shape of a one-time challenge: 16 random bytes as lowercase hex. */
export const CHALLENGE_PATTERN = /^[0-9a-f]{32}$/;

/** The output-token ceiling for the one canary request. */
export const CANARY_MAX_TOKENS = 256;

/** The fixed acknowledgement, identical for every call. */
export const PREFLIGHT_ACKNOWLEDGEMENT = "kiln_preflight: acknowledged.";

/** The declared input schema, as handed to Pi. */
export const PREFLIGHT_PARAMETERS = Object.freeze({
  type: "object",
  properties: Object.freeze({
    challenge: Object.freeze({
      type: "string",
      pattern: CHALLENGE_PATTERN.source,
      description: "The one-time challenge from the request, copied exactly.",
    }),
  }),
  required: Object.freeze(["challenge"]),
  additionalProperties: false,
});

export const PREFLIGHT_DESCRIPTION =
  "Setup-only compatibility check. Call this tool once with the challenge given in the request. It does nothing else.";

/** The one request the canary sends. It carries the challenge and no project content. */
export function canaryPrompt(challenge) {
  if (!CHALLENGE_PATTERN.test(challenge)) throw new TypeError("A canary challenge is 32 lowercase hexadecimal characters");
  return `Call the ${PREFLIGHT_TOOL_NAME} tool exactly once with {"challenge": "${challenge}"}. Do not reply with text.`;
}

/** The system prompt for the canary session, replacing Pi's own so nothing of a project reaches the model. */
export const CANARY_SYSTEM_PROMPT =
  "You are running a one-time tool-call compatibility check. Use only the tool you are given, exactly as asked.";

/**
 * Does a tool call's argument object satisfy the declared schema for this challenge? Exact keys, exact value.
 *
 * ⚠️ **THE SUCCESS PREDICATE, AND THE ONLY ONE.** A call to another name, a missing or extra field, a value of
 * another type, or a challenge differing in any character is not a pass. What the model says about itself is
 * never consulted.
 */
export function isExactChallengeCall(call, challenge) {
  if (!call || call.name !== PREFLIGHT_TOOL_NAME) return false;
  const args = call.args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
  const keys = Object.keys(args);
  return keys.length === 1 && keys[0] === "challenge" && args.challenge === challenge && CHALLENGE_PATTERN.test(challenge);
}

/**
 * The tool definition for the canary session's `customTools`.
 *
 * @param {(call: {toolCallId: string, args: unknown}) => void} [onCall]  observes each execution, for the report
 */
export function preflightToolDefinition(onCall = () => {}) {
  return {
    name: PREFLIGHT_TOOL_NAME,
    label: PREFLIGHT_TOOL_NAME,
    description: PREFLIGHT_DESCRIPTION,
    parameters: PREFLIGHT_PARAMETERS,
    async execute(toolCallId, params) {
      onCall({ toolCallId, args: params });
      return { content: [{ type: "text", text: PREFLIGHT_ACKNOWLEDGEMENT }], details: {} };
    },
  };
}
