import test from "node:test";
import assert from "node:assert/strict";

import { SETUP_RENDERER_METHODS, assertSetupRenderer, createAutomationRenderer, createRendererDecisionProvider, setupProgressLabel } from "../lib/setup-renderer.mjs";

test("the renderer contract names every interaction primitive", () => {
  assert.deepEqual(SETUP_RENDERER_METHODS, ["text", "secret", "confirm", "select", "autocomplete", "progress", "warning", "cancel", "review"]);
  assert.throws(() => assertSetupRenderer({}), /text, secret, confirm/);
});
test("automation emits status but refuses every implicit decision", async () => {
  const events = [];
  const renderer = createAutomationRenderer({ emit: (event) => events.push(event) });
  renderer.progress("installing");
  renderer.warning("fixture warning");
  await assert.rejects(() => renderer.confirm({ type: "model-use" }), (error) => error.reason === "decision-required" && error.decision === "model-use");
  assert.deepEqual(events.map((event) => event.type), ["phase:progress", "warning"]);
});

test("setup phases render as numbered plain-language steps without internal enum tokens", () => {
  assert.equal(setupProgressLabel("state-protection"), "[3/8] Protect local files");
  assert.equal(setupProgressLabel("model"), "[5/8] Choose and authorize the AI model");
  assert.equal(setupProgressLabel("connections"), "[6/8] Connections & capabilities");
  assert.doesNotMatch(setupProgressLabel("declared-identities"), /declared-identities/);
});

test("decision providers preserve structured text and secret prompt requests", async () => {
  const received = [];
  const renderer = Object.fromEntries(SETUP_RENDERER_METHODS.map((method) => [method, async (request) => {
    received.push([method, request]);
    return "fixture";
  }]));
  const decide = createRendererDecisionProvider(renderer);
  const secret = { type: "connection:openai-source:credential-secret", message: "OpenAI API key", required: true };
  const text = { type: "connection:elevenlabs:voice-id-value", message: "ElevenLabs Voice ID", required: true };
  await decide(secret);
  await decide(text);
  assert.deepEqual(received, [["secret", secret], ["text", text]]);
});
