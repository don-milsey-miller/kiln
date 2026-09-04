#!/usr/bin/env node
/**
 * A launcher that MISBEHAVES on purpose: it attaches a stdin reader immediately and consumes
 * anything it can get. The supervisor is correct exactly when this program receives no sentinel.
 *
 * ⚠️ **THE ADVERSARY IS THE TEST.** A positive "the agent received the input" check passes whenever
 * the agent happens to win a read — including when both processes hold the terminal, which is the
 * arrangement the rule forbids. Only a reader actively trying to steal the bytes distinguishes the
 * two implementations.
 *
 * It also answers the health endpoint, because the supervisor will not start the agent until
 * something proves it is this run's application.
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

/**
 * ⚠️ **A PRECONDITION, AND ALSO WHY THIS FILE IS HARMLESS TO `node --test`.** The runner executes
 * every file under `test/`, and unlike the inert fixtures beside it this one is a real program. Run
 * without the arguments that give it somewhere to report, it has no contract to fulfil and does
 * nothing — rather than throwing on an undefined path and failing a suite it is not part of.
 */
if (process.argv.length < 4) process.exit(0);

const [, , reportPath, readyPath] = process.argv;
let received = "";
const report = (extra = {}) => writeFileSync(reportPath, JSON.stringify({ received, ...extra }) + "\n");

const body = JSON.stringify({
  service: "kiln",
  protocol: "kiln.health/1",
  runId: process.env.KILN_RUN_ID,
  projectId: process.env.KILN_PROJECT_ID,
  build: process.env.KILN_FAKE_BUILD,
});
const server = createServer((req, res) => {
  if (req.url === "/health/kiln") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  } else {
    res.writeHead(404).end();
  }
});
server.listen(Number(process.env.PORT), "127.0.0.1");

// ⚠️ ATTACHED BEFORE ANNOUNCING READY, so "the adversary is reading" is true by the time the test
// writes. The announcement is the second half of the determinism the gate provides.
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  received += chunk;
  report({ state: "read" });
  if (/stop/i.test(received)) {
    report({ state: "stopped" });
    server.close();
    process.exit(0);
  }
});
process.stdin.on("end", () => {
  report({ state: "eof" });
  server.close();
  process.exit(0);
});
process.stdin.resume();

report({ state: "reading" });
writeFileSync(readyPath, "reading\n");

setTimeout(() => {
  report({ state: "timeout" });
  server.close();
  process.exit(4);
}, 25_000);
