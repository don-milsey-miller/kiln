import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { startPty } from "./helpers/pty.mjs";

const fixture = fileURLToPath(new URL("./fixtures/pty-select.mjs", import.meta.url));
const plainFixture = fileURLToPath(new URL("./fixtures/plain-prompt.mjs", import.meta.url));

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
