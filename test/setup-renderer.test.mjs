import test from "node:test";
import assert from "node:assert/strict";

import { SETUP_RENDERER_METHODS, assertSetupRenderer, createAutomationRenderer, setupProgressLabel } from "../lib/setup-renderer.mjs";

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
