import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import register from "../pi-package/extensions/kiln.js";
import { createVoiceController, VOICE_STATES } from "../lib/voice/controller.mjs";
import { VoiceContractError, VoiceTransitionError } from "../lib/voice/errors.mjs";
import { assertSttSession } from "../lib/voice/stt/provider.mjs";

const ROOT = join(import.meta.dirname, "..");

function resource(name, calls, methods) {
  return Object.fromEntries(methods.map((method) => [method, async () => calls.push(`${name}.${method}`)]));
}

test("voice construction is inert and explicit listening owns injected resources", async () => {
  const calls = [];
  let signal;
  const controller = createVoiceController({
    createCapture: ({ signal: owned }) => {
      signal = owned;
      calls.push("create.capture");
      return resource("capture", calls, ["start", "stop", "dispose"]);
    },
    createSttProvider: () => {
      calls.push("create.stt");
      return resource("stt", calls, ["start", "dispose"]);
    },
  });

  assert.equal(controller.state, VOICE_STATES.IDLE);
  assert.deepEqual(calls, [], "construction acquired a voice resource");

  const active = await controller.startListening({ source: "operator" });
  assert.equal(controller.state, VOICE_STATES.LISTENING);
  assert.equal(active.signal, signal);
  assert.deepEqual(calls, ["create.capture", "create.stt"]);

  controller.beginFinalizing();
  assert.equal(controller.state, VOICE_STATES.FINALIZING);
  const completed = await controller.complete();
  assert.deepEqual(completed, { ok: true });
  assert.equal(controller.state, VOICE_STATES.IDLE);
  assert.equal(signal.aborted, true);
  assert.deepEqual(calls, ["create.capture", "create.stt", "stt.dispose", "capture.stop", "capture.dispose"]);
});

test("dispose aborts active work, terminates resources once, and is idempotent", async () => {
  const calls = [];
  let signal;
  const controller = createVoiceController({
    createTtsProvider: ({ signal: owned }) => {
      signal = owned;
      return resource("tts", calls, ["synthesize", "dispose"]);
    },
    createPlayback: () => resource("playback", calls, ["play", "stop", "dispose"]),
  });

  await controller.startSpeaking();
  const first = await controller.dispose();
  const second = await controller.dispose();

  assert.equal(signal.aborted, true);
  assert.equal(controller.state, VOICE_STATES.DISPOSED);
  assert.deepEqual(first, { ok: true, alreadyDisposed: false, cleanupErrors: [] });
  assert.deepEqual(second, { ok: true, alreadyDisposed: true, cleanupErrors: [] });
  assert.deepEqual(calls, ["playback.stop", "playback.dispose", "tts.dispose"]);
});

test("factory and cleanup failures remain inside the voice state machine", async () => {
  const secret = "temporary-secret-that-must-not-escape";
  const controller = createVoiceController({
    createCapture: () => resource("capture", [], ["start", "stop", "dispose"]),
    createSttProvider: () => {
      const error = new Error(`provider rejected ${secret}`);
      error.code = "AUTH_FAILED";
      throw error;
    },
  });

  await assert.rejects(() => controller.startListening(), (error) => {
    assert.equal(error.code, "voice-operation-failed");
    assert.equal(error.details.causeCode, "AUTH_FAILED");
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(controller.state, VOICE_STATES.ERROR);
  assert.equal(controller.snapshot().failure.message.includes(secret), false);
  controller.reset();
  assert.equal(controller.state, VOICE_STATES.IDLE);
});

test("illegal transitions and malformed implementations fail deterministically", async () => {
  const controller = createVoiceController();
  assert.throws(() => controller.beginFinalizing(), (error) => {
    assert.ok(error instanceof VoiceTransitionError);
    assert.deepEqual(error.details, { from: "idle", action: "begin-finalizing", allowed: ["listening"] });
    return true;
  });

  await assert.rejects(() => controller.startListening(), (error) => {
    assert.equal(error.code, "voice-dependency-unavailable");
    assert.equal(error.details.dependency, "capture");
    return true;
  });

  assert.throws(() => assertSttSession({ write() {}, close() {} }), (error) => {
    assert.ok(error instanceof VoiceContractError);
    assert.deepEqual(error.details.missing, ["finish"]);
    return true;
  });
});

test("Kiln registration remains voice-free and does not expose model-callable voice tools", () => {
  const tools = [];
  const hooks = [];
  register({ registerTool: (tool) => tools.push(tool.name), on: (event) => hooks.push(event) });
  const signature = JSON.parse(readFileSync(join(ROOT, "pi-package", "signature.json"), "utf-8"));

  assert.deepEqual(tools.sort(), [...signature.tools].sort());
  assert.equal(tools.some((name) => name.startsWith("kiln_voice_")), false);
  assert.equal(signature.tools.some((name) => name.startsWith("kiln_voice_")), false);
  assert.deepEqual(hooks, ["session_start", "message_end", "session_shutdown", "session_before_switch", "session_before_compact", "session_compact_failed", "session_compact", "before_agent_start"]);
});
