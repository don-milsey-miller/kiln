/**
 * The structured integration mode: Pi's own RPC protocol, selected through Kiln - #177.
 *
 * An integration that reads a pseudo-terminal receives every repaint Pi's interactive display makes. `--rpc` is
 * the explicit alternative: `withRpcMode` adds Pi's `--mode rpc` to the same agent command Kiln starts for an
 * operator, and standard output then carries one JSON event per line and no terminal rendering at all.
 *
 * ⚠️ **THE CEILING IS IN TERMS OF WHAT WAS NEW.** Output may grow with the bytes the model sent and with the number
 * of events, and with nothing else: `fixed + perEvent × events + multiplier × payload`. It is asserted on the
 * DIFFERENCE between a short stream and a long one, so a transcript of one size cannot pass by accident and the
 * session's fixed opening cost cannot hide growth.
 *
 * ⚠️ **NOTHING HERE CLAIMS THE INTERACTIVE DISPLAY CHANGED.** A terminal still gets Pi's own rendering by default.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedProvider, sessionFixture, toolResults } from "./helpers/pi-session.mjs";
import { MODE_FLAG, RPC_MODE, withRpcMode } from "../bin/start-kiln.mjs";

const MANIFEST = "name: rpc fixture\ncapabilities:\n  artifactTypes:\n    activated: [requirement, decision]\n  sandboxTiers:\n    active:\n      - 1\n";
const ESC = "\u001b";
/** What one streamed event may cost beyond its own payload, and how many times a payload byte may be repeated. */
const PER_EVENT_BYTES = 400;
const PAYLOAD_MULTIPLIER = 8;

const words = (count) => Array.from({ length: count }, (_, i) => `${["dock", "fees", "reconcile", "against", "invoices", "weekly"][i % 6]}-${i} `);

/**
 * One run of the agent in RPC mode over pipes. `drive` sends commands and waits on the events Pi prints.
 *
 * @returns {Promise<{stdout: string, lines: string[], events: (object|null)[]}>}
 */
async function rpcSession(fx, drive, { env = {} } = {}) {
  const agent = withRpcMode(fx.agent);
  const child = spawn(agent.command, [...agent.args, ...fx.args], { cwd: fx.project, env: { ...fx.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let exited = false;
  const waiters = [];
  const parsed = () => stdout.split("\n").filter((line) => line.trim().length > 0).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  });
  const settle = () => {
    for (const waiter of [...waiters]) {
      const found = parsed().filter((event) => event !== null && waiter.match(event))[waiter.count - 1];
      if (found === undefined && !exited) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      if (found !== undefined) waiter.resolve(found);
      else waiter.reject(new Error(`Pi exited while waiting for ${waiter.what}.\n${stderr.slice(-2000)}`));
    }
  };
  child.stdout.on("data", (data) => ((stdout += data), settle()));
  child.stderr.on("data", (data) => (stderr += data));
  const closed = new Promise((done) => child.on("exit", () => ((exited = true), settle(), done())));
  const io = {
    send: (command) => child.stdin.write(`${JSON.stringify(command)}\n`),
    waitFor: (what, match, count = 1) =>
      new Promise((resolve, reject) => {
        const waiter = { what, match, count, resolve, reject };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${what}.\n${stdout.slice(-1500)}\n${stderr.slice(-1500)}`));
        }, 90_000);
        waiters.push(waiter);
        settle();
      }),
  };
  try {
    await drive(io);
  } finally {
    child.kill();
    await closed;
  }
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  return { stdout, lines, events: parsed() };
}

const settled = (event) => event.type === "agent_settled";

/** One prompt answered by a stream of `count` chunks, in a fresh fixture. */
async function streamed(count, { env } = {}) {
  const provider = await scriptedProvider();
  const fx = await sessionFixture(provider, { manifest: MANIFEST });
  try {
    provider.script.push({ stream: words(count), everyMs: 5 });
    const run = await rpcSession(
      fx,
      async (io) => {
        io.send({ id: "p", type: "prompt", message: "describe the weekly reconciliation" });
        await io.waitFor("the turn to settle", settled);
      },
      { env }
    );
    return { ...run, payloadBytes: provider.sent.payloadBytes, chunks: provider.sent.chunks };
  } finally {
    await provider.close();
    fx.remove();
  }
}

test("the structured mode is Pi's RPC mode added to the agent's own command, and a second mode is refused", () => {
  const agent = { command: "node", args: ["cli.js", "--tools", "a,b"] };
  assert.deepEqual(withRpcMode(agent), { command: "node", args: ["cli.js", "--tools", "a,b", MODE_FLAG, RPC_MODE] });
  assert.deepEqual(agent.args, ["cli.js", "--tools", "a,b"], "the agent it was given was changed");
  assert.equal(`${MODE_FLAG} ${RPC_MODE}`, "--mode rpc");
  for (const taken of [["--mode", "json"], ["--mode=rpc"]]) assert.throws(() => withRpcMode({ command: "node", args: ["cli.js", ...taken] }), /already names a mode/);
});

test("⚠️ #177 RPC output is structured events with no terminal frames, and grows only with new payload and event count", { timeout: 240_000 }, async () => {
  const short = await streamed(20);
  const long = await streamed(140);

  for (const [label, run] of [["short", short], ["long", long]]) {
    // Every line is one JSON object with a type. Nothing else is on standard output.
    assert.equal(run.events.filter((event) => event === null).length, 0, `${label}: a line of standard output is not JSON`);
    assert.ok(run.events.every((event) => typeof event.type === "string"), `${label}: an event has no type`);
    // ⚠️ NO ANSI FRAMES: not one escape byte, carriage return or synchronized-update marker.
    assert.equal(run.stdout.includes(ESC), false, `${label}: standard output carries an escape sequence`);
    assert.equal(run.stdout.includes("\r"), false, `${label}: standard output carries a carriage return`);
    // The stream arrived as deltas, one per chunk the provider sent, each carrying only its own text.
    const deltas = run.events.filter((event) => event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta");
    assert.equal(deltas.length, run.chunks, `${label}: ${deltas.length} deltas for ${run.chunks} chunks`);
    assert.equal(Buffer.byteLength(deltas.map((event) => event.assistantMessageEvent.delta).join("")), run.payloadBytes, `${label}: the deltas are not the payload`);
  }

  // ⚠️ THE CEILING, ON THE GROWTH BETWEEN THE TWO RUNS. The session's opening cost is the same in both and cancels.
  const growth = Buffer.byteLength(long.stdout) - Buffer.byteLength(short.stdout);
  const newEvents = long.lines.length - short.lines.length;
  const newPayload = long.payloadBytes - short.payloadBytes;
  assert.ok(newEvents > 0 && newPayload > 0, "the long run was not longer");
  const ceiling = PER_EVENT_BYTES * newEvents + PAYLOAD_MULTIPLIER * newPayload;
  assert.ok(growth <= ceiling, `${growth} bytes of growth for ${newEvents} new events and ${newPayload} new payload bytes exceeds ${ceiling}`);
  // And it is growth in events, not in repaints: one new line per new chunk.
  assert.equal(newEvents, long.chunks - short.chunks, "the long run added events that were not chunks");

  // The fixed part is the session describing itself, a few times over, and is not a function of the stream.
  const opening = Buffer.byteLength(short.lines.find((line) => line.includes('"type":"message_start"')) ?? "");
  const fixed = Buffer.byteLength(short.stdout) - (PER_EVENT_BYTES * short.lines.length + PAYLOAD_MULTIPLIER * short.payloadBytes);
  assert.ok(fixed <= 4 * opening + 16 * 1024, `the fixed overhead of ${fixed} bytes is more than four copies of the ${opening}-byte opening event`);
});

test("⚠️ #177 RPC output does not depend on terminal dimensions", { timeout: 240_000 }, async () => {
  const narrow = await streamed(40, { env: { COLUMNS: "40", LINES: "8" } });
  const wide = await streamed(40, { env: { COLUMNS: "240", LINES: "80" } });
  assert.deepEqual(narrow.events.map((event) => event.type), wide.events.map((event) => event.type));
  // Identifiers and timestamps differ run to run; lengths of everything else do not.
  const drift = Math.abs(Buffer.byteLength(narrow.stdout) - Buffer.byteLength(wide.stdout));
  assert.ok(drift <= 512, `output differs by ${drift} bytes between a 40x8 and a 240x80 terminal`);
});

test("⚠️ #177 an RPC confirmation is one request, takes one response, and completes the gated operation", { timeout: 240_000 }, async () => {
  const provider = await scriptedProvider();
  const fx = await sessionFixture(provider, { manifest: MANIFEST });
  try {
    provider.script.push({ tool: "kiln_set_type_activation", arguments: { type: "component", action: "activate", reason: "The design names components." } }, { text: "Activated." });
    const run = await rpcSession(fx, async (io) => {
      io.send({ id: "p", type: "prompt", message: "activate the component type" });
      const request = await io.waitFor("the confirmation request", (event) => event.type === "extension_ui_request" && event.method === "confirm");
      assert.equal(provider.requests.length, 1, "the gated tool ran before the client answered");
      io.send({ type: "extension_ui_response", id: request.id, confirmed: true });
      await io.waitFor("the turn to settle", settled);
    });

    const confirmations = run.events.filter((event) => event?.type === "extension_ui_request" && event.method === "confirm");
    assert.equal(confirmations.length, 1, "the client was asked other than once");
    const [asked] = confirmations;
    assert.equal(asked.title, "Change this project's artifact types?");
    assert.ok(asked.message.includes("Type:    component"));
    assert.ok(asked.message.endsWith("This confirmation expires after five minutes."), "the request does not state Kiln's bound");
    // Kiln asks Pi for no countdown, so the request carries none. Kiln's own timer still bounds the wait.
    assert.equal(asked.timeout, undefined, "the request carries a Pi timeout");

    assert.equal(provider.requests.length, 2);
    const [result] = toolResults(provider.requests[1]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.changed, true);
    assert.ok(readFileSync(join(fx.contentRoot, "project.yaml"), "utf-8").includes("component"), "the confirmed activation did not reach the manifest");
    assert.equal(run.stdout.includes(ESC), false);
    assert.equal(run.events.filter((event) => event === null).length, 0);
  } finally {
    await provider.close();
    fx.remove();
  }
});
