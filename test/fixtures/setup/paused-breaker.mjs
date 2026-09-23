#!/usr/bin/env node
/**
 * A breaker stopped between creating its gate and writing its name in it — spawned only by
 * `test/setup-command.test.mjs`.
 *
 * ⚠️ **THE POINT IS THAT AN EMPTY GATE IS NOT AN ABANDONED ONE.** Creating the gate and writing the owner record
 * are two calls, and a process can be stopped between them for as long as the operating system likes: suspended,
 * paged out, or held at a breakpoint. A reclaimer that removes such a gate on age alone takes it from a process
 * that is still running and still believes it holds it. This child is that process, paused on purpose, and its
 * gate is aged so nothing but the rule itself decides the outcome.
 *
 * argv: `<gatePath> <readyPath> <goPath>`. It signals with `readyPath` once the gate is taken and empty, waits
 * for `goPath`, then finishes what a real breaker does: writes its record, releases the gate, exits 0.
 */

import { closeSync, existsSync, openSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";

const [gate, ready, go] = process.argv.slice(2);
// Run by `node --test` with no gate to take, this is a program with nothing to do rather than a failing suite.
if (!gate || !ready || !go) process.exit(0);

const fd = openSync(gate, "wx");
// Old enough that age alone would condemn it, which is exactly what must not be enough.
const longAgo = Date.now() / 1000 - 600;
utimesSync(gate, longAgo, longAgo);
writeFileSync(ready, String(process.pid));

// ⚠️ A BLOCKING WAIT, because what is being modelled is a process that is not running its own code. It is bounded
// so that a failing assertion in the parent ends this process too: a fixture that waits for a signal the test is
// no longer going to send is a hung run, not a failed one.
const idle = new Int32Array(new SharedArrayBuffer(4));
const giveUpAt = Date.now() + 30_000;
while (!existsSync(go) && Date.now() < giveUpAt) Atomics.wait(idle, 0, 0, 20);

// And then it wakes up and carries on, still holding the gate it took.
writeSync(fd, JSON.stringify({ pid: process.pid, hostname: hostname(), takenAt: new Date().toISOString() }));
closeSync(fd);
unlinkSync(gate);
process.exit(0);
