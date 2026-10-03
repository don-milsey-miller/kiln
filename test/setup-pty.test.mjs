import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { startPty } from "./helpers/pty.mjs";

const fixture = fileURLToPath(new URL("./fixtures/pty-select.mjs", import.meta.url));
const plainFixture = fileURLToPath(new URL("./fixtures/plain-prompt.mjs", import.meta.url));
const guidedPromptFixture = fileURLToPath(new URL("./fixtures/pty-guided-prompts.mjs", import.meta.url));
const SECRET_SENTINEL = "sk-test-PTY-SECRET-MUST-NOT-ECHO";

test("PTY harness sends arrow keys and Enter to a real interactive selector", async () => {
  const pty = startPty(fixture, [], { cols: 80 });
  try {
    await pty.waitFor(/Choose a setup path/);
    pty.write("\u001b[B");
    pty.write("\r");
    const result = await pty.exited();
    assert.equal(result.exitCode, 0, result.output);
    assert.match(stripVTControlCharacters(result.output), /RESULT:beta/);
  } finally {
    if (!pty.exit()) pty.kill();
  }
});
test("PTY harness supports narrow terminals, resize, and NO_COLOR", async () => {
  const pty = startPty(fixture, [], { cols: 80, env: { NO_COLOR: "1" } });
  try {
    await pty.waitFor(/Choose a setup path/);
    pty.resize(36, 12);
    pty.write("\r");
    const result = await pty.exited();
    assert.equal(result.exitCode, 0, result.output);
    assert.match(stripVTControlCharacters(result.output), /RESULT:alpha/);
  } finally {
    if (!pty.exit()) pty.kill();
  }
});

test("PTY harness delivers Ctrl+C as cancellation", async () => {
  const pty = startPty(fixture);
  try {
    await pty.waitFor(/Choose a setup path/);
    pty.write("\u0003");
    const result = await pty.exited();
    assert.match(stripVTControlCharacters(result.output), /RESULT:CANCELLED/);
  } finally {
    if (!pty.exit()) pty.kill();
  }
});

test("plain renderer treats redirected stdin and unexpected EOF as cancellation", () => {
  const redirected = spawnSync(process.execPath, [plainFixture], { input: "answer\n", encoding: "utf8" });
  assert.equal(redirected.status, 0, redirected.stderr);
  assert.match(redirected.stdout, /RESULT:CANCELLED/);
  const eof = spawnSync(process.execPath, [plainFixture], { input: "", encoding: "utf8" });
  assert.equal(eof.status, 0, eof.stderr);
  assert.match(eof.stdout, /RESULT:CANCELLED/);
});

test("guided secret entry renders its label and never echoes pasted credentials", async () => {
  const pty = startPty(guidedPromptFixture, ["secret"], { env: { KILN_PTY_SECRET: SECRET_SENTINEL } });
  try {
    await pty.waitFor(/OpenAI API key/);
    pty.write(`${SECRET_SENTINEL}\r`);
    const result = await pty.exited();
    const output = stripVTControlCharacters(result.output);
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /RESULT:MATCH/);
    assert.doesNotMatch(output, /\[object Object\]/);
    assert.equal(output.includes(SECRET_SENTINEL), false, "the terminal echoed a credential");
  } finally {
    if (!pty.exit()) pty.kill();
  }
});

test("guided confirmation accepts a pasted literal Yes", async () => {
  const pty = startPty(guidedPromptFixture, ["confirm"]);
  try {
    await pty.waitFor(/type yes or no/);
    pty.write("Yes\r");
    const result = await pty.exited();
    const output = stripVTControlCharacters(result.output);
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /RESULT:true/);
  } finally {
    if (!pty.exit()) pty.kill();
  }
});
