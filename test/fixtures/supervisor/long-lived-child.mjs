#!/usr/bin/env node
/**
 * A real, KNOWN DESCENDANT: a process that does nothing, holds no resource, and does not go until
 * something stops it.
 *
 * ⚠️ **IT EXISTS BECAUSE A LEADER'S EXIT CODE IS NOT A STOPPED TREE (ACC-0081, clause 7).** The
 * criterion asks each platform's observation to include a known descendant of each tree rather than
 * only the leader's exit code, and a descendant that dies when its parent does would prove nothing:
 * every implementation passes that, including one that signals only the leader. This one survives
 * its parent, so the only thing that ends it is the supervisor reaching it deliberately.
 *
 * ⚠️ **AND IT SELF-TERMINATES, so a harness that crashes cannot leave it behind.** The timeout is
 * far longer than any shutdown this is used to observe, so it never races the measurement — it is a
 * floor under the mess, not part of the mechanism.
 */
import { writeFileSync } from "node:fs";

if (process.argv.length < 3) process.exit(0);

const [, , reportPath] = process.argv;
writeFileSync(reportPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + "\n");

// ⚠️ **NO SIGNAL HANDLERS, DELIBERATELY.** A handler that logged and exited would make a graceful
// request look like a successful stop even where the platform has none — Windows has no graceful
// request at all, and the point is to observe what each platform's mechanism actually reaches.
const timer = setTimeout(() => process.exit(0), 120_000);
timer.unref?.();
setInterval(() => {}, 1 << 30);
