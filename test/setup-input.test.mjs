import test from "node:test";
import assert from "node:assert/strict";

import { liveCheckPrompt, liveCheckRequest } from "../lib/live-canary.mjs";
import { ANSWER, askForConfirmation, isConfirmationPrompt, parseConfirmation } from "../lib/setup-input.mjs";

test("plain confirmation aliases distinguish yes, no, invalid and cancellation", () => {
  for (const value of ["yes", "y", "approve", " YES ", true]) assert.equal(parseConfirmation(value), ANSWER.YES);
  for (const value of ["no", "n", "deny", " NO ", false]) assert.equal(parseConfirmation(value), ANSWER.NO);
  assert.equal(parseConfirmation("back"), ANSWER.BACK);
  for (const value of ["", "maybe", "approved", 1]) assert.equal(parseConfirmation(value), ANSWER.INVALID);
  for (const value of [null, undefined]) assert.equal(parseConfirmation(value), ANSWER.CANCEL);
});

test("the live model check is classified by request type instead of prompt wording", () => {
  const context = { displayName: "OpenAI Codex", model: "gpt-6-sol" };
  const request = liveCheckRequest(context);
  assert.equal(request.message, liveCheckPrompt(context));
  assert.equal(isConfirmationPrompt(request), true);
  assert.equal(isConfirmationPrompt({ ...request, message: "Completely different consent wording" }), true);
  assert.equal(isConfirmationPrompt(request.message), false);
});

test("Back is available only to decision screens that explicitly support it", async () => {
  const invalid = [];
  assert.equal(await askForConfirmation(async () => "back", "Use this model?", { allowBack: true }), ANSWER.BACK);
  const answers = ["back", "yes"];
  assert.equal(await askForConfirmation(async () => answers.shift(), "Trust?", { invalid: (message) => invalid.push(message) }), true);
  assert.equal(invalid.length, 1);
});

test("invalid and blank answers reprompt without becoming rejection", async () => {
  const answers = ["approve this", "", "approve"];
  const prompts = [];
  const invalid = [];
  const result = await askForConfirmation(
    async (prompt) => (prompts.push(prompt), answers.shift()),
    "Use this model?",
    { invalid: (message) => invalid.push(message) }
  );
  assert.equal(result, true);
  assert.equal(prompts.length, 3);
  assert.equal(invalid.length, 2);
});

test("EOF cancels immediately and does not reprompt", async () => {
  let calls = 0;
  assert.equal(await askForConfirmation(async () => (calls++, null), "Continue?"), null);
  assert.equal(calls, 1);
});
