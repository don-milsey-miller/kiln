/**
 * Dependency-free setup input primitives.
 *
 * These values deliberately distinguish an invalid answer from a closed input. A caller may
 * reprompt the former; it must treat the latter as cancellation and must never turn either into a
 * denial that could be persisted.
 */
export const ANSWER = Object.freeze({
  YES: "yes",
  NO: "no",
  INVALID: "invalid",
  CANCEL: "cancel",
  BACK: "back",
});

export function parseConfirmation(value) {
  if (value === null || value === undefined) return ANSWER.CANCEL;
  if (value === true) return ANSWER.YES;
  if (value === false) return ANSWER.NO;
  const said = String(value).trim().toLowerCase();
  if (["yes", "y", "approve"].includes(said)) return ANSWER.YES;
  if (["no", "n", "deny"].includes(said)) return ANSWER.NO;
  if (said === "back") return ANSWER.BACK;
  return ANSWER.INVALID;
}

export async function askForConfirmation(ask, prompt, { invalid = () => {}, allowBack = false } = {}) {
  while (true) {
    const parsed = parseConfirmation(await ask(prompt));
    if (parsed === ANSWER.YES) return true;
    if (parsed === ANSWER.NO) return false;
    if (parsed === ANSWER.CANCEL) return null;
    if (parsed === ANSWER.BACK && allowBack) return ANSWER.BACK;
    invalid("Please choose yes or no.");
  }
}

export function isConfirmationPrompt(prompt) {
  if (prompt && typeof prompt === "object") return prompt.type === "live-model-check";
  return /^(?:Check this computer|Use this model for this project|Optional web research)/i.test(
    String(prompt).trim()
  );
}
