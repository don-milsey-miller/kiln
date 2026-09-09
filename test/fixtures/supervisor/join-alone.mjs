#!/usr/bin/env node
/**
 * One bounded join, with NOTHING ELSE IN THE EVENT LOOP.
 *
 * ⚠️ **THAT IS THE WHOLE POINT, AND IT CANNOT BE ASSERTED FROM INSIDE THE TEST RUNNER.** A suite
 * always has other work pending — other tests, their timers, their children — so a join held open
 * only by an UNREFFED timer resolves there for reasons that have nothing to do with the join. Run
 * alone, an unreffed bound is no live handle at all: node decides the loop has drained and the
 * process leaves with `exit=13, unsettled top-level await`, which in the supervisor is a shutdown
 * that stops mid-teardown with no file cleanup, no record and no refusal. Node 22's test runner
 * reported it as three failing subtests; node 24's did not. A separate process is what makes the
 * observation the same on both.
 */
import { trackDescendants } from "../../../lib/supervisor.mjs";

const child = { pid: 100, exitCode: null, signalCode: null };
// A process table that never answers: the join's bound is the only thing that can end this.
const tracker = trackDescendants(child, { psRun: () => new Promise(() => {}), platform: "linux" });

await tracker.stop({ joinMs: 300 });
console.log(JSON.stringify({ resolved: true, looks: tracker.snapshot().looks }));
