import test from "node:test";
import assert from "node:assert/strict";

import { isFirstRunWorkspace } from "../app/first-run.js";

test("first-run mode is derived from canonical artifacts, not browser state", () => {
  assert.equal(isFirstRunWorkspace({ artifactCount: 0, currentStage: "01-intake" }), true);
  assert.equal(isFirstRunWorkspace({ artifactCount: 1, currentStage: "01-intake" }), false);
  assert.equal(isFirstRunWorkspace({ artifactCount: 0, currentStage: null }), true);
  assert.equal(isFirstRunWorkspace({ artifactCount: "0" }), false);
  assert.equal(isFirstRunWorkspace(null), false);
});
