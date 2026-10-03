import { createInterface } from "node:readline";
import { assertSetupRenderer } from "./setup-renderer.mjs";

const messageOf = (request) => (typeof request === "string" ? request : request?.message ?? request?.type ?? "Setup input");

/** The dependency-free renderer used before npm install and in plain/accessibility mode. */
export function createPlainRenderer({ input = process.stdin, output = process.stdout, error = process.stderr } = {}) {
  const ask = (question) =>
    new Promise((resolveAnswer) => {
      if (!input.isTTY) return resolveAnswer(null);
      const rl = createInterface({ input, output });
      let answered = false;
      const finish = (value) => {
        if (answered) return;
        answered = true;
        rl.close();
        resolveAnswer(value);
      };
      rl.on("SIGINT", () => finish(null));
      rl.on("close", () => finish(null));
      rl.question(question, (answer) => finish(answer));
    });
  const select = async (request) => {
    const message = messageOf(request);
    const options = Array.isArray(request?.options) ? request.options : [];
    if (options.length === 0) return ask(`${message} `);
    output.write(`${message}\n`);
    options.forEach((option, index) => output.write(`  ${index + 1}. ${option.label ?? option.value}\n`));
    const answer = await ask("Choose a number: ");
    if (answer === null) return null;
    const selected = options[Number.parseInt(String(answer), 10) - 1];
    return selected?.value ?? String(answer).trim();
  };
  return assertSetupRenderer({
    mode: "plain",
    text: (request) => ask(`${messageOf(request)} `),
    secret: (request) => ask(`${messageOf(request)} `),
    confirm: (request) => ask(`${messageOf(request)} `),
    select,
    autocomplete: select,
    progress: (message) => output.write(`[kiln] ${message}\n`),
    warning: (message) => error.write(`[kiln] ${message}\n`),
    cancel: (message) => error.write(`[kiln] ${message}\n`),
    review: (message) => output.write(`[kiln] ${message}\n`),
    ask,
    print: (message) => output.write(`[kiln] ${message}\n`),
  });
}
