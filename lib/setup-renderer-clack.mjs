/**
 * Post-install interactive renderer. This module intentionally imports Clack at top level: setup
 * loads the entire module dynamically only after the locked dependency install succeeds.
 */
import * as clack from "@clack/prompts";
import { assertSetupRenderer } from "./setup-renderer.mjs";

const cancelled = (value) => {
  if (!clack.isCancel(value)) return value;
  clack.cancel("Setup cancelled. Your completed steps are safe; run setup again to resume.");
  return null;
};

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
    const message = String(prompt).trim();
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
      return cancelled(await clack.confirm({ message, initialValue: false }));
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
    text: async (message) => cancelled(await clack.text({ message })),
    secret: async (message) => cancelled(await clack.password({ message })),
    confirm: async (message) => cancelled(await clack.confirm({ message, initialValue: false })),
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
