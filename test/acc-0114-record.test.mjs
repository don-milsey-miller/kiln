/**
 * ACC-0114's retained record — tools/acc-0114/first-turn-record.mjs.
 *
 * The entries below have the shape Pi 0.84.4 writes to its session transcript (observed in a real run: an assistant
 * message with a `toolCall` block, a `toolResult` message, then an assistant message that stops). The record must carry
 * the turn verbatim and leave the verdict to a person; a session that did not open with Pi's own expansion of
 * `/kiln-start`, or whose turn did not end, is refused and nothing is written.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RecordRefusal, record } from "../tools/acc-0114/first-turn-record.mjs";
import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";

const ROOT = join(import.meta.dirname, "..");
const sdk = await import(resolvePinnedSdk(ROOT).url);
const START = sdk.parseFrontmatter(readFileSync(join(ROOT, "pi-package", "prompts", "kiln-start.md"), "utf8")).body;
const QUESTION = "Who is this project for, and what problem do they have today?";

function session({ opening = START, stop = "stop" } = {}) {
  const at = (s) => `2026-09-25T12:00:0${s}.000Z`;
  return [
    { type: "session", version: 3, id: "sess-1", timestamp: at(0), cwd: "/p" },
    { type: "model_change", id: "a", parentId: null, timestamp: at(0), provider: "real-provider", modelId: "real-model" },
    { type: "message", id: "b", parentId: "a", timestamp: at(1), message: { role: "user", content: [{ type: "text", text: opening }] } },
    { type: "message", id: "c", parentId: "b", timestamp: at(2), message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "kiln_project_status", arguments: {} }], provider: "real-provider", model: "real-model", stopReason: "toolUse" } },
    { type: "message", id: "d", parentId: "c", timestamp: at(3), message: { role: "toolResult", toolCallId: "call_1", toolName: "kiln_project_status", content: [{ type: "text", text: '{"ok":true,"artifactCount":0}' }], isError: false } },
    { type: "message", id: "e", parentId: "d", timestamp: at(4), message: { role: "assistant", content: [{ type: "text", text: QUESTION }], provider: "real-provider", model: "real-model", stopReason: stop } },
    { type: "message", id: "f", parentId: "e", timestamp: at(5), message: { role: "user", content: [{ type: "text", text: "a later answer" }] } },
    { type: "message", id: "g", parentId: "f", timestamp: at(6), message: { role: "assistant", content: [{ type: "text", text: "NOT PART OF THE FIRST TURN" }], stopReason: "stop" } },
  ];
}

function projectWith(entries) {
  const project = mkdtempSync(join(tmpdir(), "kiln-acc-0114-"));
  mkdirSync(join(project, ".pi", "runtime"), { recursive: true });
  mkdirSync(join(project, ".pi", "sessions"), { recursive: true });
  writeFileSync(join(project, ".pi", "runtime", "kiln-session.json"), JSON.stringify({ recordVersion: 1, sessionId: "sess-1" }));
  writeFileSync(join(project, ".pi", "sessions", "2026-09-25T12-00-00-000Z_sess-1.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return project;
}

test("⚠️ ACC-0114 the record carries the first turn verbatim, every tool call, and an empty verdict for a person", async () => {
  const project = projectWith(session());
  try {
    const { result, files } = await record({ project });
    assert.equal(result.turn.provider, "real-provider");
    assert.equal(result.turn.model, "real-model");
    assert.equal(result.turn.visibleText, QUESTION, "only the first turn, and all of what the operator saw");
    assert.deepEqual(result.turn.toolCalls, [{ name: "kiln_project_status", arguments: {} }]);
    assert.deepEqual(result.turn.steps.map((s) => s.kind), ["toolCall", "toolResult", "text"]);
    assert.deepEqual(result.verdict, { oneQuestion: null, noSolution: null, noMutatingTool: null, reviewer: null, reviewedAt: null, notes: null }, "the script judges nothing");
    const md = readFileSync(files[1], "utf-8");
    assert.ok(md.includes(QUESTION) && md.includes("`kiln_project_status` {}") && md.includes("- [ ] The turn asks exactly one question."), md);
    assert.equal(md.includes("NOT PART OF THE FIRST TURN"), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0114 a session that did not open with /kiln-start, or whose turn did not end, is refused and nothing is written", async () => {
  for (const [entries, why] of [
    [session({ opening: "hello" }), /did not open with Pi's own expansion of \/kiln-start/],
    [session({ stop: "aborted" }), /did not end on its own/],
  ]) {
    const project = projectWith(entries);
    try {
      await assert.rejects(record({ project }), (e) => e instanceof RecordRefusal && why.test(e.message));
      assert.equal(existsSync(join(project, "acc-0114-first-turn-sess-1.json")), false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
});
