import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CI_ENVIRONMENTS, CI_GROUPS } from "./ci-groups.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8").replaceAll("\r\n", "\n");

test("#51 every test file has exactly one explicit CI group", () => {
  const discovered = readdirSync(join(ROOT, "test"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort();
  const classified = Object.values(CI_GROUPS).flat().sort();
  assert.deepEqual(classified, discovered);
  assert.equal(new Set(classified).size, classified.length, "a test file belongs to more than one group");
});

test("#51 each group declares the environments that prove its contract", () => {
  assert.deepEqual(Object.keys(CI_ENVIRONMENTS).sort(), Object.keys(CI_GROUPS).sort());
  assert.deepEqual(CI_ENVIRONMENTS.core, ["ubuntu-24"]);
  assert.deepEqual(CI_ENVIRONMENTS.node, ["ubuntu-22", "ubuntu-24"]);
  assert.deepEqual(CI_ENVIRONMENTS.platform, ["ubuntu-24", "windows-24"]);
  assert.deepEqual(CI_ENVIRONMENTS.setup, ["ubuntu-24", "windows-24"]);
  assert.deepEqual(CI_ENVIRONMENTS.consumer, ["ubuntu-24", "windows-22"]);
  assert.ok(CI_GROUPS.platform.includes("launcher.test.mjs"));
  assert.ok(CI_GROUPS.platform.includes("process-table-windows.test.mjs"));
  assert.ok(CI_GROUPS.setup.includes("setup-command.test.mjs"));
  assert.ok(CI_GROUPS.consumer.includes("clean-consumer-journey.test.mjs"));
  assert.ok(CI_GROUPS.consumer.includes("shell-smoke.test.mjs"));
  assert.ok(CI_GROUPS.node.includes("pi-package-load.test.mjs"));
});

test("#51 package scripts make every CI group locally reproducible", () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
  for (const group of Object.keys(CI_GROUPS)) {
    assert.equal(scripts[`test:ci:${group}`], `node bin/run-test-group.mjs ${group}`);
  }
  assert.equal(scripts["test:pi-compat"], "node --test test/pi-compat.test.mjs");
});

test("#51 PRs run once, stale same-ref work cancels, and main still runs", () => {
  assert.match(workflow, /push:\n\s+branches:\n\s+- main\n\s+pull_request:\n\s+workflow_dispatch:/);
  assert.match(workflow, /group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: true/);
});

test("#51 CI is least-privilege and third-party actions are immutable", () => {
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.equal(/uses: actions\/(?:checkout|setup-node)@v\d/.test(workflow), false);
  for (const match of workflow.matchAll(/uses: actions\/(?:checkout|setup-node)@([^\s]+)/g)) {
    assert.match(match[1], /^[0-9a-f]{40}$/);
  }
});

test("#51 the asymmetric jobs preserve every compatibility dimension", () => {
  assert.match(workflow, /node-compat:[\s\S]*?node: \["22", "24"\]/);
  assert.match(workflow, /platform:[\s\S]*?os: \[ubuntu-latest, windows-latest\]/);
  assert.match(workflow, /setup:[\s\S]*?os: \[ubuntu-latest, windows-latest\]/);
  assert.match(workflow, /consumer:[\s\S]*?- os: ubuntu-latest\n\s+node: "24"[\s\S]*?- os: windows-latest\n\s+node: "22"/);
  assert.match(workflow, /pi-compat-live:[\s\S]*?KILN_PI_COMPAT: live/);
  for (const group of Object.keys(CI_GROUPS)) assert.match(workflow, new RegExp(`npm run test:ci:${group}`));
});

test("#51 one install is deliberately uncached and other jobs may restore only the npm download cache", () => {
  const validate = workflow.slice(workflow.indexOf("  validate:"), workflow.indexOf("  core:"));
  assert.match(validate, /run: npm ci/);
  assert.equal(validate.includes("cache: npm"), false);
  assert.match(workflow.slice(workflow.indexOf("  core:")), /cache: npm/);
});
