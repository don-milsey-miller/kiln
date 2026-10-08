/**
 * The real launcher: a forced build, then a start that reuses it - #184.
 *
 * `start-kiln.mjs --rpc` over a project real setup prepared, three times against this checkout's own `.next`:
 * with `--rebuild`, without it, and with it again. The supervisor, the browser launcher, the compiler and Pi are
 * the real ones. `test/build-cache.test.mjs` holds the decision itself, field by field.
 *
 * ⚠️ **THE ASSERTION IS THAT THE COMPILER DID NOT RUN, NOT THAT THE START WAS FAST.** The times are recorded as
 * diagnostics and nothing is asserted about them: a ratio would fail under load without anything being wrong.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { kilnProject } from "./helpers/kiln-launch.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";
import { removeTestTree } from "./helpers/cleanup.mjs";
import { BUILD_MARKER, BUILD_REASON, decideBuild } from "../lib/build-cache.mjs";

const ROOT = join(import.meta.dirname, "..");
const MARKER = join(ROOT, ".next", BUILD_MARKER);
const BUILD_ID = join(ROOT, ".next", "BUILD_ID");
const settled = (event) => event.type === "agent_settled";
/** Said by the launcher when it runs the compiler, and by the compiler itself. */
const COMPILER = [/\[vpw\] building \(production\)/, /Creating an optimized production build/, /Compiled successfully/];
const ESC = "\u001b";

test("⚠️ #184 a forced build is followed by a start that reuses it: same build, same marker, no compiler", { timeout: 15 * 60_000 }, async (t) => {
  const fx = await kilnProject({ label: "#184 build reuse" });
  // What would disable reuse for a reason that is not this test's: the contract says so, and the test does not hide it.
  delete fx.env.NODE_OPTIONS;
  try {
    await withBuildLock(async () => {
      assert.notEqual(decideBuild({ root: ROOT, env: fx.env }).reason, BUILD_REASON.ENV_FILE, "this checkout has an .env file in its root, so no start can reuse a build and this test cannot run");

      /** One run: one turn in Pi once the browser shell is up, then the client closes the protocol's input. */
      const start = async (id, args) => {
        fx.provider.script.push({ text: `REPLY-${id}` });
        const began = Date.now();
        let readyMs = null;
        const run = await fx.launch(
          async (io) => {
            await io.said("\\[vpw\\] ready — http", { timeoutMs: 6 * 60_000 });
            readyMs = Date.now() - began;
            io.send({ id, type: "prompt", message: `BUILD-REUSE-${id}` });
            await io.waitFor(`turn ${id} to settle`, settled, { timeoutMs: 120_000 });
          },
          { args, boundMs: 8 * 60_000 }
        );
        assert.equal(run.exit.signal, null, `the run was killed at its bound:\n${run.stderr.slice(-4000)}`);
        assert.equal(run.exit.status, 0, run.stderr.slice(-4000));

        // ⚠️ STANDARD OUTPUT IS STILL PI'S PROTOCOL AND NOTHING ELSE, with the launcher saying more than it used to.
        const lines = run.stdout.split("\n").filter((line) => line.trim().length > 0);
        assert.ok(lines.length > 3, `standard output carried ${lines.length} lines`);
        for (const line of lines) {
          let event = null;
          try {
            event = JSON.parse(line);
          } catch {
            assert.fail(`a line of standard output is not JSON: ${line.slice(0, 200)}`);
          }
          assert.equal(typeof event.type, "string", `an event has no type: ${line.slice(0, 200)}`);
        }
        for (const stray of [ESC, "[kiln]", "[vpw]", "build reused", "build required", "build recorded"]) assert.equal(run.stdout.includes(stray), false, `standard output carries ${JSON.stringify(stray)}`);
        assert.ok(run.stdout.includes(`REPLY-${id}`), "the turn's reply is not in the event stream");
        assert.match(run.stderr, /\[kiln\] stopped \(agent-exit\)/);
        return { ...run, readyMs, buildId: readFileSync(BUILD_ID, "utf-8"), marker: readFileSync(MARKER, "utf-8"), markerStat: statSync(MARKER), buildIdStat: statSync(BUILD_ID) };
      };

      // 1. FORCED: whatever is in `.next`, the compiler runs and what it made is recorded.
      const cold = await start("cold", ["--rebuild"]);
      assert.ok(cold.stderr.includes(`[vpw] build required (${BUILD_REASON.FORCED})`), cold.stderr.slice(-3000));
      assert.match(cold.stderr, COMPILER[0]);
      assert.ok(cold.stderr.includes("[vpw] build recorded; an unchanged checkout will reuse it"), cold.stderr.slice(-3000));
      assert.ok(!cold.stderr.includes("build reused"));
      const recorded = JSON.parse(cold.marker);
      assert.equal(recorded.buildId, cold.buildId.trim());

      // 2. ⚠️ WARM: nothing changed, so nothing is compiled and nothing is written.
      const warm = await start("warm", []);
      assert.ok(warm.stderr.includes(`[vpw] build reused (${BUILD_REASON.REUSED}); the production compiler was not run`), warm.stderr.slice(-3000));
      for (const ran of COMPILER) assert.doesNotMatch(warm.stderr, ran, "the compiler ran on a start that said it reused the build");
      for (const absent of ["build required", "build recorded", "build not recorded"]) assert.ok(!warm.stderr.includes(absent), `a reusing start said ${JSON.stringify(absent)}`);
      assert.equal(warm.buildId, cold.buildId, "the build id changed on a start that reused the build");
      assert.equal(warm.marker, cold.marker, "the marker changed on a start that reused the build");
      assert.equal(warm.markerStat.mtimeMs, cold.markerStat.mtimeMs, "the marker was rewritten on a start that reused the build");
      assert.equal(warm.buildIdStat.mtimeMs, cold.buildIdStat.mtimeMs, "the build id was rewritten on a start that reused the build");
      // The install decision is its own, made first, and unchanged by any of this.
      for (const run of [cold, warm]) assert.match(run.stderr, /\[vpw\] dependencies present; skipping install/);

      // 3. FORCED AGAIN, over a build that would have been reused: a new build, and a marker that describes it.
      const again = await start("again", ["--rebuild"]);
      assert.ok(again.stderr.includes(`[vpw] build required (${BUILD_REASON.FORCED})`), again.stderr.slice(-3000));
      assert.match(again.stderr, COMPILER[0]);
      assert.notEqual(again.buildId, warm.buildId, "a forced build left the build it was told to replace");
      assert.equal(JSON.parse(again.marker).buildId, again.buildId.trim());
      // The same inputs give the same key: only the build it vouches for is different.
      assert.equal(JSON.parse(again.marker).key, recorded.key);

      // Recorded, never asserted.
      t.diagnostic(`#184 time to the browser shell answering: forced build ${cold.readyMs} ms, reuse ${warm.readyMs} ms, forced build again ${again.readyMs} ms`);
    });
  } finally {
    await fx.close();
  }
});

/**
 * A compiler that exits 0 whatever it leaves, and a server that only listens.
 *
 * The real compiler cannot be asked to succeed and leave a broken build, so this stands where the launcher looks
 * for it, in a copy of the tool that holds the real launcher and the real library. What it leaves is chosen by a
 * file, and every invocation is written down so that "the server was never started" is read, not inferred.
 */
const FAKE_NEXT = `
const fs = require("node:fs");
const path = require("node:path");
const root = process.cwd();
const mode = fs.readFileSync(path.join(root, "fake-mode"), "utf-8").trim();
const command = process.argv[2];
fs.appendFileSync(path.join(root, "fake-calls"), command + "\\n");
if (command === "build") {
  const dir = path.join(root, ".next");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "BUILD_ID"), mode === "empty-build-id" ? "" : "fake-" + Date.now());
  if (mode !== "missing-file") fs.writeFileSync(path.join(dir, "routes-manifest.json"), "{}");
  if (mode !== "no-manifest") fs.writeFileSync(path.join(dir, "required-server-files.json"), JSON.stringify({ version: 1, appDir: root, files: [".next/BUILD_ID", ".next/routes-manifest.json"] }));
  if (mode === "marker-blocked") fs.mkdirSync(path.join(dir, "kiln-build.json"), { recursive: true });
  console.log("fake compiler finished");
  process.exit(0);
}
if (command === "start") {
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
  require("node:http").createServer((_, res) => res.end("ok")).listen(port, "127.0.0.1");
}
`;

test("⚠️ #184 a compiler that exits 0 over unusable output does not get a server started; a marker that cannot be written does not stop one", { timeout: 5 * 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "kiln-build-refusal-"));
  const tool = join(base, "tool");
  try {
    // The real launcher and library, with no application and no real dependencies.
    mkdirSync(join(tool, "bin"), { recursive: true });
    cpSync(join(ROOT, "bin", "start-shell.mjs"), join(tool, "bin", "start-shell.mjs"));
    cpSync(join(ROOT, "lib"), join(tool, "lib"), { recursive: true });
    for (const file of ["package.json", "package-lock.json"]) cpSync(join(ROOT, file), join(tool, file));
    mkdirSync(join(tool, "app"));
    writeFileSync(join(tool, "app", "page.js"), "export default function Page() { return null; }\n");
    mkdirSync(join(tool, "node_modules", "next", "dist", "bin"), { recursive: true });
    writeFileSync(join(tool, "node_modules", "next", "package.json"), '{"name":"next","version":"0.0.0-fake"}\n');
    writeFileSync(join(tool, "node_modules", "next", "dist", "bin", "next"), FAKE_NEXT);
    // An installed tree the install decision accepts: npm's record, no older than the lockfile.
    writeFileSync(join(tool, "node_modules", ".package-lock.json"), "{}\n");
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(tool, "node_modules", ".package-lock.json"), later, later);

    const freePort = async () => {
      const probe = createServer();
      await new Promise((r) => probe.listen(0, "127.0.0.1", r));
      const { port } = probe.address();
      await new Promise((r) => probe.close(r));
      return port;
    };
    const marker = join(tool, ".next", BUILD_MARKER);
    /** One run of the copied launcher. It is told to stop once it says it is ready, and is left alone if it exits first. */
    const start = async (mode) => {
      writeFileSync(join(tool, "fake-mode"), mode);
      writeFileSync(join(tool, "fake-calls"), "");
      const env = { ...process.env, PORT: String(await freePort()), PLANNING_CONTENT_DIR: join(ROOT, "planning-content") };
      for (const name of ["NODE_OPTIONS", "KILN_RUN_ID", "KILN_PROJECT_ID"]) delete env[name];
      const child = spawn(process.execPath, [join(tool, "bin", "start-shell.mjs")], { cwd: tool, env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let stopped = false;
      const take = (d) => {
        out += d;
        if (!stopped && out.includes("[vpw] ready — http")) {
          stopped = true;
          child.stdin.write("stop\n");
        }
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      const bound = setTimeout(() => child.kill(), 2 * 60_000);
      const exit = await new Promise((done) => child.on("close", (status, signal) => done({ status, signal })));
      clearTimeout(bound);
      assert.equal(exit.signal, null, `the launcher was killed at its bound in mode ${mode}:\n${out.slice(-3000)}`);
      return { status: exit.status, out, ready: stopped, calls: readFileSync(join(tool, "fake-calls"), "utf-8").split("\n").filter(Boolean) };
    };

    // ⚠️ THE COMPILER EXITED 0 AND LEFT SOMETHING THAT IS NOT A BUILD: exit 1, the fixed reason, and no server.
    for (const [mode, reason] of [
      ["no-manifest", BUILD_REASON.NO_MANIFEST],
      ["missing-file", BUILD_REASON.FILE_MISSING],
      ["empty-build-id", BUILD_REASON.BUILD_ID_EMPTY],
    ]) {
      const run = await start(mode);
      assert.equal(run.status, 1, `${mode} exited ${run.status}:\n${run.out.slice(-3000)}`);
      assert.ok(run.out.includes("fake compiler finished"), "the compiler did not run, so this proves nothing");
      assert.ok(run.out.includes(`[vpw] the build finished but its output is not usable (${reason}); not starting`), run.out.slice(-3000));
      assert.deepEqual(run.calls, ["build"], `the server was started over ${mode}`);
      for (const absent of ["[vpw] starting on", "[vpw] run directory", "[vpw] ready", "build recorded", "build not recorded"]) assert.ok(!run.out.includes(absent), `${mode}: the launcher said ${JSON.stringify(absent)}`);
      assert.equal(existsSync(marker), false, `${mode} was recorded`);
    }

    // ⚠️ VALID OUTPUT WHOSE MARKER CANNOT BE WRITTEN IS A DIFFERENT CASE: it is served, and not recorded.
    const unrecorded = await start("marker-blocked");
    assert.equal(unrecorded.status, 0, unrecorded.out.slice(-3000));
    assert.ok(unrecorded.ready, "valid output was not served");
    assert.ok(unrecorded.out.includes(`[vpw] build not recorded (${BUILD_REASON.MARKER_NOT_WRITTEN}); the next start will build again`), unrecorded.out.slice(-3000));
    assert.deepEqual(unrecorded.calls, ["build", "start"]);
    assert.equal(statSync(marker).isDirectory(), true);
    // And a marker that cannot be taken away stops the next start before the compiler: nothing is built over it.
    const stuck = await start("marker-blocked");
    assert.equal(stuck.status, 1, stuck.out.slice(-3000));
    assert.match(stuck.out, /\[vpw\] the previous build's marker could not be removed \([A-Z]+\); not building over it/);
    assert.deepEqual(stuck.calls, [], "the compiler or the server ran over a marker that could not be removed");

    // The control, in the same copy: valid output is served and recorded, and the next start does not compile.
    removeTestTree(join(tool, ".next"), "#184 build refusal");
    const built = await start("ok");
    assert.deepEqual([built.status, built.ready, built.calls], [0, true, ["build", "start"]], built.out.slice(-3000));
    assert.ok(built.out.includes("[vpw] build recorded; an unchanged checkout will reuse it"));
    const reused = await start("ok");
    assert.deepEqual([reused.status, reused.ready, reused.calls], [0, true, ["start"]], reused.out.slice(-3000));
    assert.ok(reused.out.includes(`[vpw] build reused (${BUILD_REASON.REUSED})`));
  } finally {
    removeTestTree(base, "#184 build refusal");
  }
});
