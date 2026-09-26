/**
 * ACC-0089's negative controls, as a suite — TSK-0064.
 *
 * ⚠️ **EACH WRONG STATE IS A NAMED TEST WHERE ITS BEHAVIOUR IS ALREADY PROVED.** A control lives beside the fixtures
 * that can drive it (setup, launch checks, the supervisor, the research gate, the specialist contract), and its title
 * carries `ACC-0089 (n)`, n being the wrong state's place in the criterion. Each of those tests asserts the specific
 * refusal and its side effect: nothing started, read, sent or written where it must not be.
 *
 * This file is the suite's index: it fails when any of the nineteen states has no named test, so a control that is
 * renamed or deleted is a failure rather than a quiet gap.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = import.meta.dirname;

/** ACC-0089's wrong states, in the criterion's order. */
const STATES = [
  "a missing or mismatched project or content root, whatever the working directory",
  "inspection denied",
  "a configuration read attempted before consent",
  "implicit adoption of a sole or default model",
  "missing model authentication",
  "an overbroad environment-only provider",
  "a TTY-less login attempt",
  "live-check denial",
  "a malformed canary tool call",
  "Tavily contacted before approval",
  "a committed research choice with no local consent",
  "trust denial",
  "corrupt settings",
  "untracked-state exposure",
  "an interrupted transaction",
  "an occupied port",
  "an unrelated healthy HTTP service",
  "tool signature drift",
  "a fake child returning plausible prose without Kiln tools",
];

/** Every test title in this directory that names ACC-0089, with the items it claims. */
function namedControls() {
  const found = [];
  // This file is the index, not a control: its own titles never count.
  for (const file of readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.mjs") && f !== "negative-controls.test.mjs")) {
    const source = readFileSync(join(TEST_DIR, file), "utf-8");
    for (const m of source.matchAll(/^test\(\s*"([^"]*ACC-0089[^"]*)"/gm)) {
      // Only the numbers that follow ACC-0089 itself: "ACC-0075 (2) ACC-0089 (18)" claims item 18, not item 2.
      const run = /ACC-0089((?:\s*\(\d+\))+)/.exec(m[1])?.[1] ?? "";
      const items = [...run.matchAll(/\((\d+)\)/g)].map((x) => Number(x[1])).filter((n) => n >= 1 && n <= STATES.length);
      found.push({ file, title: m[1], items });
    }
  }
  return found;
}

test("⚠️ ACC-0089 every one of the nineteen wrong states has a named negative control", () => {
  const controls = namedControls();
  const missing = STATES.map((state, i) => ({ n: i + 1, state })).filter(({ n }) => !controls.some((c) => c.items.includes(n)));
  assert.deepEqual(missing, [], `no named control for: ${missing.map(({ n, state }) => `(${n}) ${state}`).join("; ")}`);
});

test("⚠️ ACC-0089 (1) is controlled three ways: a valid unrelated working directory, a missing root and a mismatched one", () => {
  const titles = namedControls()
    .filter((c) => c.items.includes(1))
    .map((c) => c.title);
  assert.ok(titles.some((t) => /unrelated working directory/.test(t)), titles.join("\n"));
  assert.ok(titles.some((t) => /does not exist/.test(t)), titles.join("\n"));
  assert.ok(titles.some((t) => /disagrees/.test(t)), titles.join("\n"));
});
