import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CI_GROUPS } from "./ci-groups.mjs";
import { SAFE_TEST_GROUP_ORDER, runTestGroups } from "../bin/run-test-suite.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("issue #84: the default test command uses the safe grouped runner", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node bin/run-test-suite.mjs");
  assert.doesNotMatch(pkg.scripts.test, /node\s+--test(?:\s|$)/);
  assert.deepEqual(SAFE_TEST_GROUP_ORDER, Object.keys(CI_GROUPS));
});

test("issue #84: the complete default suite never overlaps dependency-mutating groups with readers", async () => {
  const started = [];
  const finished = [];
  let active = 0;
  let peak = 0;
  const output = { write() {} };
  const code = await runTestGroups({
    output,
    runGroup: async (group) => {
      started.push(group);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      finished.push(group);
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.equal(peak, 1, "two test groups overlapped");
  assert.deepEqual(started, Object.keys(CI_GROUPS));
  assert.deepEqual(finished, started);
  assert.ok(started.indexOf("setup") > started.indexOf("node"));
  assert.ok(started.indexOf("consumer") > started.indexOf("setup"));
});

test("issue #84: the serial runner stops before starting later groups after a failure", async () => {
  const started = [];
  const code = await runTestGroups({
    groups: ["core", "node", "setup"],
    output: { write() {} },
    runGroup: async (group) => {
      started.push(group);
      return group === "node" ? 7 : 0;
    },
  });
  assert.equal(code, 7);
  assert.deepEqual(started, ["core", "node"]);
});
