import assert from "node:assert/strict";
import test from "node:test";

import { SPEECH_TEXT_MARKERS, speechText } from "../lib/voice/speech-text.mjs";

test("speechText reads only visible assistant text without mutating the message", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hidden chain" },
      { type: "text", text: "Visible answer." },
      { type: "toolCall", name: "shell", arguments: { command: "secret" } },
      { type: "text", text: "Second paragraph." },
    ],
  };
  const original = structuredClone(message);

  assert.equal(speechText(message), "Visible answer. Second paragraph.");
  assert.deepEqual(message, original);
  for (const role of ["system", "user", "tool", "toolResult"]) {
    assert.equal(speechText({ role, content: "Do not say this." }), "");
  }
});

test("speechText removes Markdown syntax, raw locations, and makes artifact IDs intelligible", () => {
  const result = speechText({
    role: "assistant",
    content: "## **Result**\n- Read [the requirement](https://example.test/REQ-0009).\n- See https://unsafe.test/x, `C:\\\\work\\\\plan.md`, and /srv/kiln/output.json for REQ-0009.",
  });

  assert.match(result, /^Result Read the requirement\./);
  assert.match(result, /link omitted/);
  assert.match(result, /file path omitted/);
  assert.match(result, /REQ 0009/);
  assert.doesNotMatch(result, /https?:|C:\\|\/srv\/|\*\*|##/);
});

test("speechText summarizes tables, structured data, and fenced code instead of speaking payloads", () => {
  const result = speechText({
    role: "assistant",
    content: "Before.\n\n| ID | Status |\n| --- | :---: |\n| AST-0001 | ready |\n\n{\n  \"token\": \"private-value\"\n}\n\n```json\n{\"huge\":true}\n```\n\nAfter.",
  });

  assert.equal(
    result,
    `Before. ${SPEECH_TEXT_MARKERS.table} ${SPEECH_TEXT_MARKERS.structured} ${SPEECH_TEXT_MARKERS.code} After.`
  );
  assert.doesNotMatch(result, /AST|private-value|huge/);
});

test("speechText applies a deterministic character bound and ignores non-text responses", () => {
  const message = { role: "assistant", content: "one two three four five" };
  assert.equal(speechText(message, { maxCharacters: 15 }), "one two three\u2026");
  assert.equal(speechText(message, { maxCharacters: 15 }), speechText(message, { maxCharacters: 15 }));
  assert.equal(speechText({ role: "assistant", content: [{ type: "image", data: "ignored" }] }), "");
  assert.throws(() => speechText(message, { maxCharacters: 1 }), /maxCharacters/);
});
