/**
 * The retained record of Pi's interactive `/login` and its no-TTY controls — TSK-0065, toward ACC-0090.
 *
 * ⚠️ **THIS READS WHAT `tools/pi-compat/login-check.mjs` SAVED; IT RUNS NOTHING.** The interactive half
 * needs a person at a real terminal, and every half needs `script(1)` on Linux, so neither belongs in
 * the default suite. What this holds is the record: that it was taken against the pin, in the isolated
 * environment it claims, and that each control's mode and bounded outcome are what the evidence says.
 *
 * ⚠️ **IT CANNOT PROVE THE THROWAWAY KEY IS ABSENT, AND DOES NOT CLAIM TO.** The key was generated at
 * capture time and never retained, so nothing here knows it. That claim rests on the capture-time
 * check in `login-check.mjs`, which refused to save if any 8-character run of the key survived. What
 * this adds is the redaction scan, a check that no key-shaped value survived, and that the number of
 * redaction markers matches the number of redactions the capture recorded.
 *
 * ⚠️ **LINUX ONLY.** Nothing here says how Pi behaves in a Windows terminal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { redactionViolations } from "../tools/pi-compat/lib/redact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(ROOT, "tools", "pi-compat", "runs", "login");
const PINNED = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).dependencies["@earendil-works/pi-coding-agent"];

const text = (name) => readFileSync(join(RUNS, name), "utf8");
const controls = JSON.parse(text("login-controls-linux.json"));
const interactive = JSON.parse(text("login-interactive-linux.json"));

/** Written out rather than imported, so the harness and this assertion are two statements. */
const LAUNCH_ARGS = [
  "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
  "--no-context-files", "--no-approve", "--offline",
];
const ENVIRONMENT_NAMES = ["HOME", "LANG", "PATH", "PI_CODING_AGENT_DIR", "TERM"];
const REDACTION_MARKER = "[THROWAWAY-KEY-REDACTED]";

test("both login records were taken on Linux against the pin, with the same launch and environment", () => {
  for (const [name, r] of [["controls", controls], ["interactive", interactive]]) {
    assert.equal(r.meta.platform, "linux", `${name}: not a Linux record`);
    assert.equal(r.meta.pinned, PINNED, `${name} was taken against pin ${r.meta.pinned}; re-run login-check.mjs`);
    assert.equal(r.meta.piVersion, PINNED, `${name}: the installed Pi was not the pinned one`);
    assert.deepEqual(r.meta.launchArgs, LAUNCH_ARGS, `${name}: the launch arguments differ`);
    // ⚠️ THE WHOLE ENVIRONMENT BY NAME. A credential name, or the operator's own configuration, would show here.
    assert.deepEqual(r.meta.environmentNames, ENVIRONMENT_NAMES, `${name}: Pi received other environment names`);
  }
});

test("the no-TTY controls keep the launch fixed, and only both terminals render the TUI", () => {
  const byLabel = Object.fromEntries(controls.controls.map((c) => [c.label, c]));
  const limitMs = (controls.meta.controlTimeoutSeconds + 5) * 1000 + 2000;

  // ⚠️ THE MODE CONTROL. Without it, an absent TUI in the other rows could be a probe unable to see one.
  assert.equal(byLabel["both-tty"].tuiObserved, true, "the TUI did not render with both streams a terminal");
  assert.equal(byLabel["both-tty"].timedOut, true, "the TUI control ended before the timeout");

  const expected = {
    "stdin-closed": { piExit: 0, timedOut: false },
    "stdin-open-pipe": { piExit: 124, timedOut: true },
    "stdout-pipe": { piExit: 0, timedOut: false },
    "both-pipes": { piExit: 124, timedOut: true },
  };
  for (const [label, want] of Object.entries(expected)) {
    const c = byLabel[label];
    assert.ok(c, `no ${label} control was recorded`);
    // Not the interactive mode: none of the TUI's terminal signals appeared.
    assert.equal(c.tuiObserved, false, `${label}: the TUI rendered without both terminals`);
    assert.equal(c.signals.bracketedPasteEnabled, false, `${label}: bracketed paste was enabled`);
    assert.equal(c.piExit, want.piExit, `${label}: Pi exited ${c.piExit}`);
    assert.equal(c.timedOut, want.timedOut, `${label}: the timeout outcome changed`);
  }

  // ⚠️ BOUNDED, BOTH WAYS. A quick exit is quick, and a timed-out run stopped at the harness's limit.
  for (const c of controls.controls) {
    assert.ok(Number.isFinite(c.piElapsedMs) && c.piElapsedMs <= limitMs, `${c.label}: Pi ran ${c.piElapsedMs} ms`);
    if (!c.timedOut) assert.ok(c.piElapsedMs < 5000, `${c.label}: a quick exit took ${c.piElapsedMs} ms`);
  }
});

test("the interactive run owned the terminal, exited 0, and auth changed from not ready to ready", () => {
  const i = interactive.interactive;
  assert.equal(i.piExit, 0, "Pi's own exit was not 0");
  assert.equal(i.tuiObserved, true, "the TUI did not render");
  assert.equal(i.loginTyped, true, "/login does not appear in the transcript");

  // ⚠️ AUTH IS ASKED SEPARATELY, NOT INFERRED FROM THE EXIT. Before is the control.
  assert.equal(interactive.authBefore.exit, 1);
  assert.equal(interactive.authBefore.result?.status, "not_ready");
  assert.equal(interactive.authAfter.exit, 0);
  assert.deepEqual(interactive.authAfter.result, { status: "ready", provider: "openai", authType: "api_key" });

  assert.deepEqual(interactive.stored.shape, { openai: { type: "api_key" } }, "the stored credentials are not one OpenAI API key");
  assert.equal(interactive.stored.storedKeyIsTheThrowawayKey, true, "what Pi stored is not the key that was entered");
});

test("the retained login records pass the redaction scan and carry no key-shaped value", () => {
  for (const name of [
    "login-controls-linux.json", "login-controls-linux.transcript.txt",
    "login-interactive-linux.json", "login-interactive-linux.transcript.txt",
  ]) {
    const body = text(name);
    assert.deepEqual(redactionViolations(body), [], `${name} retains machine-identifying or credential-shaped content`);
    // The generated key's shape is sk-kiln-throwaway- and 32 hex characters. No hex run of 16 survives.
    assert.equal(/[0-9a-f]{16,}/.test(body), false, `${name} retains a long hex run`);
    assert.equal(/sk-kiln-throwaway-[0-9a-f]/.test(body), false, `${name} retains the start of a throwaway key`);
  }

  // ⚠️ EVERY REDACTION THE CAPTURE COUNTED IS STILL A MARKER. A later edit that removed or rewrote one
  // would show here as a mismatch.
  const transcript = text("login-interactive-linux.transcript.txt");
  const markers = transcript.split(REDACTION_MARKER).length - 1;
  assert.ok(interactive.interactive.keyOccurrencesRedacted >= 1, "the key was never seen, so nothing was redacted");
  assert.equal(markers, interactive.interactive.keyOccurrencesRedacted, "the transcript's markers do not match the recorded redactions");
});
