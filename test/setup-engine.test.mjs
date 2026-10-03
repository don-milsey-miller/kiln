import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SETUP_EVENT, SetupEngineError, createSetupEngine } from "../lib/setup-engine.mjs";

test("the setup engine emits deterministic semantic events around typed phases and decisions", async () => {
  const emitted = [];
  const engine = createSetupEngine({ emit: (event) => emitted.push(event) });
  engine.start({ mode: "test" });
  const answer = await engine.phase("model", async () =>
    engine.decision(
      { type: "model-use", options: ["approve", "change-model", "cancel"], context: { provider: "fixture" } },
      async (decision) => decision.options[0]
    )
  );
  assert.equal(answer, "approve");
  engine.complete({ ready: true });
  assert.deepEqual(
    emitted.map((event) => event.type),
    [SETUP_EVENT.START, SETUP_EVENT.PHASE_START, SETUP_EVENT.DECISION_REQUIRED, SETUP_EVENT.PHASE_COMPLETE, SETUP_EVENT.COMPLETE]
  );
  assert.deepEqual(emitted.map((event) => event.sequence), [1, 2, 3, 4, 5]);
  assert.equal(emitted[2].decision.type, "model-use");
  assert.deepEqual(emitted[2].decision.options, ["approve", "change-model", "cancel"]);
});
test("a failed phase has no false completion event and terminal outcomes are final", async () => {
  const engine = createSetupEngine();
  await assert.rejects(() => engine.phase("install", async () => { throw new Error("fixture failure"); }), /fixture failure/);
  assert.deepEqual(engine.events().map((event) => event.type), [SETUP_EVENT.START, SETUP_EVENT.PHASE_START]);
  engine.partial("install-failed", { resumable: true });
  await assert.rejects(() => engine.phase("model", async () => {}), (error) => error instanceof SetupEngineError && error.reason === "run-finished");
});

test("the engine import graph contains no terminal renderer or readline dependency", () => {
  const source = readFileSync(new URL("../lib/setup-engine.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /setup-renderer|@clack\/prompts|node:readline|process\.(?:stdin|stdout)|console\./);
});
