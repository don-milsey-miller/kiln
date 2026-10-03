/**
 * Post-install interactive renderer. This module intentionally imports Clack at top level: setup
 * loads the entire module dynamically only after the locked dependency install succeeds.
 */
import * as clack from "@clack/prompts";
import { ANSWER, parseConfirmation } from "./setup-input.mjs";
import { assertSetupRenderer } from "./setup-renderer.mjs";

const cancelled = (value) => {
  if (!clack.isCancel(value)) return value;
  clack.cancel("Setup cancelled. Your completed steps are safe; run setup again to resume.");
  return null;
};

const messageOf = (request) =>
  String(typeof request === "string" ? request : request?.message ?? request?.type ?? "Setup input").trim();

const validateText = (request) => (value) => {
  const text = String(value ?? "").trim();
  if (request?.required && !text) return request.requiredMessage ?? "A value is required.";
  if (request?.maxLength && text.length > request.maxLength)
    return `Enter no more than ${request.maxLength} characters.`;
  return undefined;
};

async function confirmWithText(request) {
  const message = messageOf(request).replace(/\s*\(yes\/no\)\s*$/i, "");
  const answer = cancelled(await clack.text({
    message: `${message} (type yes or no)`,
    placeholder: "yes or no",
    validate: (value) => {
      const parsed = parseConfirmation(value);
      return parsed === ANSWER.INVALID || parsed === ANSWER.BACK ? "Please enter yes or no." : undefined;
    },
  }));
  if (answer === null) return null;
  return parseConfirmation(answer) === ANSWER.YES;
}

function choicesFromPrompt(prompt) {
  const values = /\(([^()]+)\)\s*$/.exec(prompt)?.[1]?.split(",").map((value) => value.trim()) ?? [];
  return values.map((value) => ({ value, label: value }));
}

export function createClackRenderer() {
  const modelChoices = new Map();
  clack.intro("Kiln guided setup");
  const print = (message) => {
    const model = /^\s*(\d+)\.\s+(.+)$/.exec(message);
    if (model) modelChoices.set(model[1], model[2]);
    else clack.log.info(message);
  };
  const ask = async (prompt) => {
    const message = messageOf(prompt);
    if (/^Project name/i.test(message)) return cancelled(await clack.text({ message: "Project name", placeholder: "My Project", validate: (value) => value.trim() ? undefined : "A project name is required." }));
    if (/^What (?:are you trying|is this project)/i.test(message)) return cancelled(await clack.text({ message: "What are you trying to accomplish?", placeholder: "You can change this later" }));
    if (/^Use this model for this project/i.test(message))
      return cancelled(await clack.select({
        message,
        options: [
          { value: true, label: "Use this model" },
          { value: "back", label: "Choose a different model" },
          { value: null, label: "Cancel setup" },
        ],
      }));
    if (/^(?:Trust this project|Check this computer|Optional web research|Run (?:a|one) live model check)/i.test(message))
      return confirmWithText(message);
    if (/^Which model should this project use/i.test(message)) {
      const options = [...modelChoices].map(([value, label]) => ({ value, label }));
      return cancelled(await clack.select({ message: "Choose the AI model Kiln should use", options }));
    }
    if (/^Thinking level/i.test(message)) {
      const levels = /\(([^)]+)\)/.exec(message)?.[1]?.split(",").map((value) => value.trim()) ?? [];
      return cancelled(await clack.select({ message: "Choose a reasoning level", options: levels.map((value) => ({ value, label: value })) }));
    }
    if (/^Which\?/i.test(message)) {
      const labels = {
        "fix-ignore": "In this project and protect them with .gitignore",
        "user-state": "In my user profile",
        stop: "Cancel setup",
      };
      const options = choicesFromPrompt(message).map((option) => ({ ...option, label: labels[option.value] ?? option.label }));
      return cancelled(await clack.select({ message: "Where should Kiln keep local runtime files?", options }));
    }
    return cancelled(await clack.text({ message }));
  };
  return assertSetupRenderer({
    mode: "interactive",
    text: async (request) => cancelled(await clack.text({
      message: messageOf(request),
      ...(request?.placeholder ? { placeholder: request.placeholder } : {}),
      validate: validateText(request),
    })),
    secret: async (request) => cancelled(await clack.password({
      message: messageOf(request),
      mask: "•",
      validate: validateText(request),
    })),
    confirm: confirmWithText,
    select: async ({ message, options }) => cancelled(await clack.select({ message, options })),
    autocomplete: async ({ message, options }) => cancelled(await clack.select({ message, options })),
    progress: (message) => clack.log.step(message),
    warning: (message) => clack.log.warn(message),
    cancel: (message) => clack.cancel(message),
    review: (message) => clack.note(message, "Review"),
    ask,
    print,
    complete: (message) => clack.outro(message),
  });
}
