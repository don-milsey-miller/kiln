/** The stable renderer surface shared by terminal, accessibility, automation, and test adapters. */
export const SETUP_RENDERER_METHODS = Object.freeze([
  "text",
  "secret",
  "confirm",
  "select",
  "autocomplete",
  "progress",
  "warning",
  "cancel",
  "review",
]);

export function assertSetupRenderer(renderer) {
  const missing = SETUP_RENDERER_METHODS.filter((method) => typeof renderer?.[method] !== "function");
  if (missing.length > 0) throw new TypeError(`Setup renderer is missing: ${missing.join(", ")}.`);
  return renderer;
}

const PHASE_STEPS = Object.freeze({
  install: [1, "Welcome & preflight"],
  "dependency-repair": [1, "Welcome & preflight"],
  "runtime-verification": [1, "Welcome & preflight"],
  initialize: [2, "Project identity"],
  "project-identity": [2, "Project identity"],
  "state-coverage": [3, "Protect local files"],
  "state-protection": [3, "Protect local files"],
  trust: [4, "Install Kiln"],
  registration: [4, "Install Kiln"],
  inspection: [5, "Choose and authorize the AI model"],
  model: [5, "Choose and authorize the AI model"],
  "credential-contract": [5, "Choose and authorize the AI model"],
  preflight: [5, "Choose and authorize the AI model"],
  "live-check": [5, "Choose and authorize the AI model"],
  research: [6, "Connections & capabilities"],
  connections: [6, "Connections & capabilities"],
  "declared-identities": [7, "Review & validate"],
  "read-back": [7, "Review & validate"],
});

export function setupProgressLabel(phase) {
  const [step, label] = PHASE_STEPS[phase] ?? [7, "Review & validate"];
  return `[${step}/8] ${label}`;
}

/** Automation never invents an answer: callers must supply every required decision explicitly. */
export function createAutomationRenderer({ emit = () => {} } = {}) {
  const refusePrompt = async (request) => {
    const type = typeof request === "string" ? "unspecified" : request?.type ?? "unspecified";
    throw Object.assign(new Error(`Automation requires an explicit value for ${type}; prompting is disabled.`), {
      name: "SetupAutomationRefusal",
      reason: "decision-required",
      decision: type,
    });
  };
  return assertSetupRenderer(
    Object.freeze({
      mode: "automation",
      text: refusePrompt,
      secret: refusePrompt,
      confirm: refusePrompt,
      select: refusePrompt,
      autocomplete: refusePrompt,
      progress: (message) => emit({ type: "phase:progress", message }),
      warning: (message) => emit({ type: "warning", message }),
      cancel: (message) => emit({ type: "setup:partial", reason: "cancelled", message }),
      review: (summary) => emit({ type: "review", summary }),
    })
  );
}

const OPTION_LABELS = Object.freeze({
  enable: "Enable for this project",
  "use-existing": "Use existing credential",
  connect: "Connect now (store in this computer's credential vault)",
  "configure-later": "Configure later",
  skip: "Skip for now",
  back: "Back",
  cancel: "Cancel setup",
  provide: "Configure now",
  apply: "Apply these connection choices",
  stt: "Voice dictation only",
  tts: "Speech output only",
  "stt-and-tts": "Voice dictation and speech output",
});

/** Translate a semantic decision into one renderer operation. */
export function createRendererDecisionProvider(renderer) {
  assertSetupRenderer(renderer);
  return async (request) => {
    if (request.type.endsWith("-secret")) return renderer.secret(request);
    if (request.type.endsWith("-value")) return renderer.text(request);
    const options = request.options.map((value) => ({ value, label: OPTION_LABELS[value] ?? value }));
    return renderer.select({ message: request.message ?? request.type, options });
  };
}
