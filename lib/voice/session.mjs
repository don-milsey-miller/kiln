import { resolveProjectVoiceConfig } from "./project-config.mjs";
import { createPiVoiceDictation } from "./dictation.mjs";
import { createPiVoiceOutput } from "./output.mjs";

/** One session-scoped owner that keeps dictation and speech output independent. */
export class PiVoiceSession {
  #dictation;
  #output;

  constructor({ dictation, output }) {
    this.#dictation = dictation;
    this.#output = output;
  }

  async start() {
    await this.#output.interrupt();
    return this.#dictation.start();
  }

  stop() {
    return this.#dictation.stop();
  }

  toggle() {
    return this.#dictation.snapshot().listening ? this.stop() : this.start();
  }

  devices() {
    return this.#dictation.devices();
  }

  async outputOn() {
    return this.#output.on();
  }

  async outputOff() {
    return this.#output.off();
  }

  handleMessage(message) {
    return this.#output.handleMessage(message);
  }

  async status() {
    const dictation = await this.#dictation.status();
    return Object.freeze({ ...dictation, tts: this.#output.status() });
  }

  async dispose() {
    const [dictation, output] = await Promise.allSettled([
      this.#dictation.dispose(),
      this.#output.dispose(),
    ]);
    return Object.freeze({ ok: dictation.status === "fulfilled" && output.status === "fulfilled" });
  }
}

export function createPiVoiceSession({ ui, env = process.env, overrides = {} } = {}) {
  const config = overrides.config ?? resolveProjectVoiceConfig(env);
  const dictation = overrides.dictation ?? createPiVoiceDictation({
    ui,
    env,
    overrides: { ...overrides, config },
  });
  const output = overrides.output ?? createPiVoiceOutput({ ui, config, overrides });
  return new PiVoiceSession({ dictation, output });
}
