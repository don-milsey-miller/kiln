#!/usr/bin/env node
/**
 * A stand-in for Pi: it does exactly what the supervisor's stdio routing must deliver to, and
 * nothing else. Real Pi needs credentials and offers no clean way to assert "I received exactly
 * this" — and what is under test is the SUPERVISOR's responsibility, not the agent's behaviour.
 *
 * ⚠️ **IT DOES NOT READ UNTIL RELEASED.** The release gate is a fixture-only file, watched here and
 * created by the test, and it exists so the adversary is provably reading FIRST. Without it the two
 * children race, the mutation could pass on luck, and a control that passes on luck is not one.
 *
 * Reports through its own fd 3 rather than stdout, so the supervisor may inherit stdout freely.
 */
import { existsSync, writeFileSync } from "node:fs";

/**
 * ⚠️ **A PRECONDITION, AND ALSO WHY THIS FILE IS HARMLESS TO `node --test`.** The runner executes
 * every file under `test/`, and unlike the inert fixtures beside it this one is a real program. Run
 * without the arguments that give it somewhere to report, it has no contract to fulfil and does
 * nothing — rather than throwing on an undefined path and failing a suite it is not part of.
 */
if (process.argv.length < 4) process.exit(0);

const [, , reportPath, gatePath] = process.argv;
const report = (o) => writeFileSync(reportPath, JSON.stringify(o) + "\n");

report({ state: "started" });

const waitForGate = async () => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (existsSync(gatePath)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

const released = await waitForGate();
if (!released) {
  report({ state: "never-released", received: "" });
  process.exit(3);
}

let received = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  received += chunk;
  report({ state: "read", received });
});
process.stdin.on("end", () => {
  report({ state: "eof", received });
  process.exit(0);
});
process.stdin.resume();

// Bounded: the agent must not outlive the test if nothing ever arrives.
setTimeout(() => {
  report({ state: "timeout", received });
  process.exit(4);
}, 20_000);
