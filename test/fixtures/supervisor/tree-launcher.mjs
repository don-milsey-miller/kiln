#!/usr/bin/env node
/**
 * A launcher that answers the health endpoint, obeys its private control channel, and spawns ONE
 * real long-lived child — the launcher tree's known descendant.
 *
 * ⚠️ **IT IS THE POLITE CASE ON PURPOSE.** It exits when told to, without stopping its own child,
 * which is exactly what `next start` does to its workers when the parent goes: the worker is not
 * the parent's to clean up and nothing tells it to leave. That combination — a leader that exits
 * cleanly and a descendant that does not — is the arrangement in which "the launcher was seen to
 * exit" reads as a completed shutdown and is not one.
 *
 * ⚠️ **THE CHILD IS SPAWNED DETACHED ON BOTH PLATFORMS**, so it survives its parent rather than
 * being torn down as a side effect of the parent's own exit — by the process group on POSIX, by the
 * job object on Windows, where an ordinary grandchild was measured gone 1.5s after its parent went.
 * Without that the descendant would disappear for a reason that has nothing to do with the
 * supervisor reaching it, and the observation would credit a mechanism that never ran.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length < 5) process.exit(0);

const [, , reportPath, readyPath, childReportPath] = process.argv;
const HERE = dirname(fileURLToPath(import.meta.url));

const child = spawn(process.execPath, [join(HERE, "long-lived-child.mjs"), childReportPath], {
  stdio: "ignore",
  detached: true,
});
child.unref?.();

const report = (o) =>
  writeFileSync(reportPath, JSON.stringify({ pid: process.pid, childPid: child.pid, ...o }) + "\n");
report({ state: "started" });

const server = createServer((req, res) => {
  if (req.url === "/health/kiln") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        service: "kiln",
        protocol: "kiln.health/1",
        runId: process.env.KILN_RUN_ID,
        projectId: process.env.KILN_PROJECT_ID,
        build: null,
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(Number(process.env.PORT), "127.0.0.1", () => writeFileSync(readyPath, "ready\n"));

// ⚠️ THE CONTROL CHANNEL IT WAS BUILT TO ANSWER. `stop` on the private pipe, or the pipe closing,
// and it goes — leaving its child exactly where it is.
process.stdin.setEncoding("utf-8");
let seen = "";
const leave = () => {
  report({ state: "stopped" });
  server.close();
  process.exit(0);
};
process.stdin.on("data", (chunk) => {
  seen += chunk;
  if (/stop/i.test(seen)) leave();
});
process.stdin.on("end", leave);
process.stdin.resume();

// A floor under the mess, far above any shutdown this is used to observe.
setTimeout(() => process.exit(0), 120_000).unref?.();
