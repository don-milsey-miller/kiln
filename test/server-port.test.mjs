/**
 * The port the skeleton server binds — F50, `app/server.mjs`.
 *
 * ⚠️ **THE DEFECT WAS IN THE SERVER, NOT IN A TEST.** Binding port 0 asks the operating system for a
 * port out of its dynamic range, and the range is the machine's to configure: a Windows host set to
 * the legacy `1024`-and-up range hands out 6000 or 10080 as readily as 52000. `fetch` and every
 * standards-following browser refuse those before opening a connection, so the server was handing
 * back a URL nobody it serves could open. It was found as an intermittent `fetch failed: bad port` in
 * a slice test, which is the symptom rather than the fault.
 *
 * ⚠️ **THE LIST IS CHECKED AGAINST THE RUNTIME, NOT AGAINST A LIST SOMEBODY TYPED.** A constant copied
 * from a standard is a claim about what `fetch` does; the test below asks `fetch` itself, so a runtime
 * that changes its answer fails here rather than silently disagreeing with the server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { FETCH_BLOCKED_PORTS, ServerPortError, isFetchBlockedPort, startServer } from "../app/server.mjs";
import { DATA_DIR } from "../lib/layout.mjs";

installReaper();

/** The least content root the server will start over. These tests are about the port, not the page. */
const contentRoot = () => {
  const root = join(reapLater(mkdtempSync(join(tmpdir(), "vpw-port-"))), "planning-content");
  mkdirSync(join(root, DATA_DIR), { recursive: true });
  return root;
};

/** Ports handed back in order, standing in for what the OS assigned — the seam these tests need. */
const handBack = (...ports) => {
  const queue = [...ports];
  return (server) => (queue.length > 0 ? queue.shift() : server.address().port);
};

test("⚠️ F50 a blocked port the OS hands back is rejected, its listener closed, and the bind repeated", async () => {
  const root = contentRoot();
  let closes = 0;

  const started = await startServer({
    contentRoot: root,
    port: 0,
    // Two blocked ports, then whatever the OS really gave us.
    portOf: handBack(6000, 10080),
  });
  started.server.on("close", () => {
    closes += 1;
  });

  try {
    assert.deepEqual(started.rejectedPorts, [6000, 10080], "both blocked ports were rejected, in order");
    assert.equal(isFetchBlockedPort(started.port), false, "and the port it settled on is one fetch will connect to");
    assert.equal(started.url, `http://127.0.0.1:${started.port}/`, "the URL names the port it actually listens on");
    assert.equal(started.server.listening, true);

    // ⚠️ THE POINT OF THE WHOLE FIX: the address it hands back can be fetched.
    const response = await fetch(started.url);
    assert.equal(response.status, 200);
  } finally {
    await started.close();
  }
  assert.equal(closes, 1, "the successful listener closed once at the end; the rejected ones were already closed");
});

test("⚠️ F50 every rejected listener is closed before the next attempt", async () => {
  const root = contentRoot();
  const ports = [];

  // Recording the REAL port behind each attempt, while reporting a blocked one to the server.
  const portOf = (() => {
    const blocked = [6000, 6667];
    return (server) => {
      ports.push(server.address().port);
      return blocked.length > 0 ? blocked.shift() : server.address().port;
    };
  })();

  const started = await startServer({ contentRoot: root, port: 0, portOf });
  try {
    assert.equal(ports.length, 3, "three binds: two rejected, one kept");
    // Each rejected attempt's real port is free again — provable by binding it, which a held listener would refuse.
    for (const port of ports.slice(0, 2)) {
      const probe = createServer();
      await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", resolve);
      });
      await new Promise((r) => probe.close(r));
    }
  } finally {
    await started.close();
  }
});

test("⚠️ F50 the retries are bounded, and the refusal says nothing is listening", async () => {
  const root = contentRoot();
  const attempts = [];
  let error = null;

  try {
    await startServer({
      contentRoot: root,
      port: 0,
      maxPortAttempts: 3,
      portOf: (server) => {
        attempts.push(server.address().port);
        return 6000; // a machine whose dynamic range is entirely unusable
      },
    });
  } catch (e) {
    error = e;
  }

  assert.ok(error instanceof ServerPortError, `got ${error}`);
  assert.equal(error.code, "EPORTUNUSABLE");
  assert.deepEqual(error.detail, { attempts: 3, rejectedPorts: [6000, 6000, 6000] });
  assert.equal(attempts.length, 3, "it stopped at the bound rather than trying forever");
  assert.match(error.message, /Nothing is listening/);
});

test("⚠️ F50 an unrelated listen failure is reported, never retried onto a different port", async () => {
  const root = contentRoot();

  // Somebody else holds the port the caller named.
  const occupier = createServer();
  await new Promise((resolve, reject) => {
    occupier.once("error", reject);
    occupier.listen(0, "127.0.0.1", resolve);
  });
  const taken = occupier.address().port;

  let error = null;
  try {
    await startServer({ contentRoot: root, port: taken });
  } catch (e) {
    error = e;
  } finally {
    await new Promise((r) => occupier.close(r));
  }

  // ⚠️ A ServerPortError HERE WOULD MEAN IT HAD RETRIED: the caller asked for one port and is owed
  // that answer, not a quiet move to another one.
  assert.equal(error?.code, "EADDRINUSE", `got ${error?.code ?? error}`);
  assert.ok(!(error instanceof ServerPortError));
});

test("⚠️ F50 an explicit port is the caller's choice, and is not second-guessed", async () => {
  assert.equal(isFetchBlockedPort(6000), true);
  assert.equal(isFetchBlockedPort(10080), true);
  assert.equal(isFetchBlockedPort(52_000), false);
  assert.equal(isFetchBlockedPort(0), false);

  // The retry exists because port 0 means the OS is choosing. A caller who NAMES a port has taken
  // responsibility for it, and moving them somewhere else would answer a question they did not ask.
  // Asserted through the seam: a real free port to bind, reported as though it were a blocked one.
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const free = probe.address().port;
  await new Promise((r) => probe.close(r));

  const started = await startServer({ contentRoot: contentRoot(), port: free, portOf: () => 6000 });
  try {
    assert.equal(started.port, 6000, "what the caller asked for is what it reports, blocked or not");
    assert.deepEqual(started.rejectedPorts, [], "and nothing was rejected, because nothing was chosen for them");
  } finally {
    await started.close();
  }
});

test("⚠️ F50 the blocked list is what THIS runtime's fetch actually refuses", async () => {
  // Asked of fetch: a blocked port fails as `bad port` before any connection is attempted, and an
  // ordinary closed port fails as a refused connection. If a future runtime changes its list, this
  // fails rather than letting the server's list drift away from the client's.
  const reason = async (port) => {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      return "answered";
    } catch (e) {
      return String(e?.cause?.message ?? e?.message ?? e);
    }
  };

  for (const port of FETCH_BLOCKED_PORTS) assert.match(await reason(port), /bad port/i, `port ${port}`);

  // Controls: ports nothing is listening on, which fetch is willing to try.
  for (const port of [52_001, 52_002]) {
    const why = await reason(port);
    assert.ok(!/bad port/i.test(why), `port ${port} must not be refused as a bad port: ${why}`);
  }
});
