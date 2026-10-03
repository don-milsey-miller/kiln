/**
 * Presentation-free setup orchestration primitives.
 *
 * This module is deliberately dependency-free. It owns semantic setup events and typed decisions;
 * it knows nothing about terminals, readline, Clack, colors, spinners, or console layout.
 */
export const SETUP_EVENT = Object.freeze({
  START: "setup:start",
  PHASE_START: "phase:start",
  PHASE_PROGRESS: "phase:progress",
  DECISION_REQUIRED: "decision:required",
  WARNING: "warning",
  PHASE_COMPLETE: "phase:complete",
  PARTIAL: "setup:partial",
  COMPLETE: "setup:complete",
});

const EVENT_TYPES = new Set(Object.values(SETUP_EVENT));

export class SetupEngineError extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.name = "SetupEngineError";
    this.reason = reason;
    this.details = details;
  }
}

function frozenEvent(sequence, type, fields = {}) {
  if (!EVENT_TYPES.has(type)) throw new SetupEngineError("unknown-event", `Unknown setup event ${type}.`);
  return Object.freeze({ sequence, type, ...fields });
}

function checkedDecision(decision) {
  if (!decision || typeof decision !== "object" || typeof decision.type !== "string" || decision.type.trim() === "")
    throw new SetupEngineError("invalid-decision", "A setup decision needs a semantic type.");
  if (!Array.isArray(decision.options) || decision.options.length === 0 || decision.options.some((option) => typeof option !== "string"))
    throw new SetupEngineError("invalid-decision", `Setup decision ${decision.type} needs string options.`);
  return Object.freeze({ ...decision, options: Object.freeze([...decision.options]) });
}

/**
 * Create one setup run's event and decision boundary.
 *
 * `resolve` belongs to the caller so a terminal renderer, automation adapter, or test fake can all
 * answer the same decision without entering this module's import graph.
 */
export function createSetupEngine({ emit = () => {}, decide = null } = {}) {
  let sequence = 0;
  let started = false;
  let terminal = false;
  const events = [];

  const publish = (type, fields = {}) => {
    const event = frozenEvent(++sequence, type, fields);
    events.push(event);
    emit(event);
    return event;
  };

  const api = {
    start(details = {}) {
      if (started) return events[0];
      started = true;
      return publish(SETUP_EVENT.START, { details: Object.freeze({ ...details }) });
    },

    async phase(name, work, details = {}) {
      if (!started) api.start();
      if (terminal) throw new SetupEngineError("run-finished", `Setup cannot start phase ${name} after its terminal event.`);
      if (typeof name !== "string" || name.trim() === "" || typeof work !== "function")
        throw new SetupEngineError("invalid-phase", "A setup phase needs a name and operation.");
      publish(SETUP_EVENT.PHASE_START, { phase: name, details: Object.freeze({ ...details }) });
      const result = await work();
      publish(SETUP_EVENT.PHASE_COMPLETE, { phase: name });
      return result;
    },

    progress(phase, message, details = {}) {
      return publish(SETUP_EVENT.PHASE_PROGRESS, { phase, message, details: Object.freeze({ ...details }) });
    },

    async decision(decision, resolve = decide) {
      if (!started) api.start();
      if (terminal) throw new SetupEngineError("run-finished", "Setup cannot request a decision after its terminal event.");
      const request = checkedDecision(decision);
      publish(SETUP_EVENT.DECISION_REQUIRED, { decision: request });
      if (typeof resolve !== "function")
        throw new SetupEngineError("decision-provider-missing", `No decision provider can answer ${request.type}.`, { type: request.type });
      return resolve(request);
    },

    warning(message, details = {}) {
      return publish(SETUP_EVENT.WARNING, { message, details: Object.freeze({ ...details }) });
    },

    partial(reason, details = {}) {
      if (terminal) return events.at(-1);
      terminal = true;
      return publish(SETUP_EVENT.PARTIAL, { reason, details: Object.freeze({ ...details }) });
    },

    complete(details = {}) {
      if (terminal) return events.at(-1);
      terminal = true;
      return publish(SETUP_EVENT.COMPLETE, { details: Object.freeze({ ...details }) });
    },

    events() {
      return Object.freeze([...events]);
    },
  };

  return Object.freeze(api);
}
