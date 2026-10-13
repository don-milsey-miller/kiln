/**
 * `start-kiln --rpc` is refused on Windows under a Node release that can crash the session at exit - #218.
 *
 * Pi's RPC mode calls `process.exit()` as soon as its runtime is disposed, and on Windows the Node releases carrying
 * nodejs/node#56645 can abort inside that exit with status `0xC0000409`, after the session's work is done. Measured
 * with the pinned Pi at every boundary: all of 23.x, 24.0 through 24.19, all of 25.x and 26.0 through 26.6 crash, and
 * 22.x, 24.20 onward, 26.7 onward do not.
 *
 * ⚠️ **THE REFUSAL COMES FIRST AND TOUCHES NOTHING.** It is decided from the flag, the platform and the process's own
 * version, before the project is resolved or a launch check runs. Standard output stays empty, because in `--rpc` it
 * is a client's protocol stream.
 *
 * ⚠️ **ONLY WINDOWS AND ONLY `--rpc`.** Every other launch reaches the launch checks exactly as before.
 *
 * ⚠️ **NO OVERRIDE, AND THE TESTS DO NOT NEED ONE.** `main` takes the platform and version as a dependency a test
 * supplies, which no argument or environment variable can reach. The last case runs the real command under this
 * process's own Node, and so proves the refusal for real on a machine whose Node is one of the unsafe releases.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { main as startKiln } from "../bin/start-kiln.mjs";
import { RPC_NODE_REFUSED, nodeUnsafeForRpc, rpcNodeRefusal } from "../lib/rpc-node-range.mjs";
import { removeTestTree } from "./helpers/cleanup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const messageFor = (version) =>
  `Node ${version} on Windows can crash when a --rpc session exits after completing work (node-version-unsafe-for-rpc; nodejs/node#56645). ` +
  `Use Node 22.19.0 or newer 22.x, Node 24.20.0 or newer 24.x, Node 26.7.0 or newer 26.x, or stable Node 27+. Nothing was started.`;

/** Every transition, as the last release on one side and the first on the other. */
const UNSAFE = ["23.0.0", "23.11.1", "23.99.99", "24.0.0", "24.1.0", "24.18.0", "24.18.1", "24.19.0", "24.19.99", "25.0.0", "25.9.0", "25.99.0", "26.0.0", "26.5.1", "26.6.0", "26.6.99"];
const SAFE = ["22.19.0", "22.23.3", "22.99.99", "24.20.0", "24.20.1", "24.21.0", "24.99.0", "26.7.0", "26.7.1", "26.11.1", "26.99.0", "27.0.0", "27.5.0", "28.0.0", "30.1.2", "100.0.0"];

test("⚠️ #218 the unsafe releases are all of 23.x, 24.0 to 24.19, all of 25.x and 26.0 to 26.6, and nothing else", () => {
  assert.equal(RPC_NODE_REFUSED, "node-version-unsafe-for-rpc");
  for (const version of UNSAFE) assert.equal(nodeUnsafeForRpc(version), true, `${version} is unsafe`);
  for (const version of SAFE) assert.equal(nodeUnsafeForRpc(version), false, `${version} is safe`);

  // Each boundary, side by side: the last unsafe release of a line and the first safe one after it.
  for (const [last, first] of [["22.99.99", "23.0.0"], ["24.20.0", "24.19.99"], ["24.99.99", "25.0.0"], ["26.7.0", "26.6.99"], ["27.0.0", "26.6.0"]]) {
    assert.notEqual(nodeUnsafeForRpc(last), nodeUnsafeForRpc(first), `${last} and ${first} are on the same side`);
  }
  // Every minor of the two lines that were fixed part-way.
  for (let minor = 0; minor < 40; minor++) {
    assert.equal(nodeUnsafeForRpc(`24.${minor}.0`), minor < 20, `24.${minor}.0`);
    assert.equal(nodeUnsafeForRpc(`26.${minor}.0`), minor < 7, `26.${minor}.0`);
    assert.equal(nodeUnsafeForRpc(`23.${minor}.0`), true, `23.${minor}.0`);
    assert.equal(nodeUnsafeForRpc(`25.${minor}.0`), true, `25.${minor}.0`);
    assert.equal(nodeUnsafeForRpc(`22.${minor}.0`), false, `22.${minor}.0`);
    assert.equal(nodeUnsafeForRpc(`27.${minor}.0`), false, `27.${minor}.0`);
  }

  // The spellings a runtime can report, and what is not a version at all.
  assert.equal(nodeUnsafeForRpc("v24.19.0"), true);
  assert.equal(nodeUnsafeForRpc("v24.20.0"), false);
  assert.equal(nodeUnsafeForRpc("24.19.0-nightly20260801abcdef"), true);

  // ⚠️ A PRERELEASE OF A FIRST FIXED RELEASE IS REFUSED. The stable 24.20.0 and 26.7.0 were measured. A build cut
  // before one of them was not, so it is not assumed to carry the fix.
  for (const before of ["24.20.0-rc.1", "24.20.0-rc.0", "24.20.0-nightly20260820abcdef", "24.20.0-pre", "v24.20.0-rc.1", "26.7.0-pre", "26.7.0-rc.2", "26.7.0-nightly20260804abcdef", "26.7.0-test"])
    assert.equal(nodeUnsafeForRpc(before), true, `${before} precedes the first fixed release`);
  // The stable releases themselves, with or without build metadata, and everything after them on the line.
  for (const fixed of ["24.20.0", "v24.20.0", "24.20.0+build.5", "24.20.1", "24.20.1-rc.1", "24.21.0-rc.1", "24.21.0-nightly20260901abcdef", "26.7.0", "26.7.0+x", "26.7.1-pre", "26.8.0-rc.1", "26.11.1"])
    assert.equal(nodeUnsafeForRpc(fixed), false, `${fixed} is the first fixed release or later`);
  // A prerelease is no different on a line that is unsafe throughout, or on one that never was.
  assert.equal(nodeUnsafeForRpc("23.5.0-rc.1"), true);
  assert.equal(nodeUnsafeForRpc("25.0.0-pre"), true);
  assert.equal(nodeUnsafeForRpc("22.20.0-rc.1"), false);
  // A major that only begins with an unsafe one is its own major.
  assert.equal(nodeUnsafeForRpc("230.0.0"), false);
  assert.equal(nodeUnsafeForRpc("2.23.0"), false);
  for (const unreadable of ["", "24", "24.19", "twenty-four", "x.y.z", null, undefined, 24, {}]) assert.equal(nodeUnsafeForRpc(unreadable), false, JSON.stringify(unreadable));

  // ⚠️ PRERELEASES OF 27.0.0 ARE REFUSED TOO. They began before the fix reached Node's main branch. The stable
  // release, its build-metadata forms and everything after it are treated as safe.
  for (const before of ["27.0.0-pre", "27.0.0-nightly20260601abcdef", "27.0.0-rc.1", "v27.0.0-rc.0", "27.0.0-rc.1+build.5"]) assert.equal(nodeUnsafeForRpc(before), true, `${before} precedes 27.0.0`);
  for (const stable of ["27.0.0", "v27.0.0", "27.0.0+build.5", "27.0.1", "27.0.1-rc.1", "27.1.0", "27.1.0-nightly20270101abcdef", "28.0.0", "28.0.0-pre"]) assert.equal(nodeUnsafeForRpc(stable), false, `${stable} is stable 27 or later`);

  // ⚠️ THE WHOLE STRING IS READ. Valid build metadata changes nothing about which release it is.
  for (const [version, unsafe] of [["24.19.0+build.5", true], ["24.19.0-rc.1+build.5", true], ["v23.1.0+x.y-z", true], ["24.20.0+build.5", false], ["24.20.0-rc.1+build.5", true], ["26.7.0+a.b", false], ["22.19.0+build", false]])
    assert.equal(nodeUnsafeForRpc(version), unsafe, version);
  // Text that only begins like an unsafe release is not a version, and an unreadable version is not called unsafe.
  for (const malformed of ["24.19.0garbage", "24.19.0 ", " 24.19.0", "24.19.0\n", "24.19.0.1", "24.19.0-", "24.19.0+", "24.19.0-rc..1", "24.19.0+build+again", "24.19.0-rc 1", "24.19.x", "24.19.0/extra", "23.0.0;rm", "x24.19.0", "vv24.19.0", "24.19.0-rc.1 garbage", "25.0.0garbage", "26.6.0_x"])
    assert.equal(nodeUnsafeForRpc(malformed), false, JSON.stringify(malformed));
});

test("⚠️ #218 only Windows with --rpc is refused, with the stable code and the exact message", () => {
  for (const version of UNSAFE) {
    assert.deepEqual(rpcNodeRefusal({ rpc: true, platform: "win32", nodeVersion: version }), { code: "node-version-unsafe-for-rpc", message: messageFor(version) });
    // Another platform, or another kind of launch, is never refused on the same release.
    for (const platform of ["linux", "darwin", "freebsd", "aix", ""]) assert.equal(rpcNodeRefusal({ rpc: true, platform, nodeVersion: version }), null, `${platform} ${version}`);
    for (const rpc of [false, undefined, null, "true", 1]) assert.equal(rpcNodeRefusal({ rpc, platform: "win32", nodeVersion: version }), null, `rpc ${JSON.stringify(rpc)} ${version}`);
  }
  for (const version of SAFE) assert.equal(rpcNodeRefusal({ rpc: true, platform: "win32", nodeVersion: version }), null, version);
  // Asked of this process, it answers for this process.
  const own = rpcNodeRefusal({ rpc: true });
  assert.equal(own !== null, process.platform === "win32" && nodeUnsafeForRpc(process.versions.node));
});

/**
 * Run the command's `main` in this process with a named platform and version, recording how it ended and everything
 * it wrote, read or started on the way.
 */
async function run(argv, runtime, { contentRoot = null } = {}) {
  const reached = [];
  const written = { stdout: "", stderr: "" };
  const reads = [];
  const started = [];
  const READS = ["readFileSync", "readdirSync", "statSync", "lstatSync", "existsSync", "openSync", "realpathSync", "opendirSync", "accessSync"];
  const STARTS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
  const saved = { exit: process.exit, error: console.error, log: console.log, write: process.stdout.write, content: process.env.PLANNING_CONTENT_DIR };
  const fsOriginals = Object.fromEntries(READS.map((name) => [name, fs[name]]));
  const cpOriginals = Object.fromEntries(STARTS.map((name) => [name, childProcess[name]]));
  let exit = null;

  if (contentRoot === null) delete process.env.PLANNING_CONTENT_DIR;
  else process.env.PLANNING_CONTENT_DIR = contentRoot;
  process.exit = (code) => {
    exit = code;
    throw new Error("exit");
  };
  console.error = (...parts) => (written.stderr += `${parts.join(" ")}\n`);
  console.log = (...parts) => (written.stdout += `${parts.join(" ")}\n`);
  process.stdout.write = (chunk) => ((written.stdout += String(chunk)), true);
  for (const name of READS)
    fs[name] = function (...args) {
      reads.push(`${name} ${String(args[0])}`);
      return fsOriginals[name].apply(this, args);
    };
  for (const name of STARTS)
    childProcess[name] = function (...args) {
      started.push(`${name} ${String(args[0])}`);
      return cpOriginals[name].apply(this, args);
    };
  syncBuiltinESMExports();
  let error = null;
  try {
    await startKiln(argv, {
      runtime,
      checkLaunch: async () => {
        reached.push("launch checks");
        throw new Error("the launch checks were reached");
      },
      runSupervisor: async () => {
        reached.push("supervisor");
        throw new Error("the supervisor was reached");
      },
    });
  } catch (e) {
    error = e;
  } finally {
    for (const name of READS) fs[name] = fsOriginals[name];
    for (const name of STARTS) childProcess[name] = cpOriginals[name];
    syncBuiltinESMExports();
    process.exit = saved.exit;
    console.error = saved.error;
    console.log = saved.log;
    process.stdout.write = saved.write;
    if (saved.content === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved.content;
  }
  return { exit, error: error?.message ?? null, reached, written, reads, started };
}

test("⚠️ #218 the refusal exits 2 on standard error alone, before the project, the launch checks or any process", async () => {
  for (const version of ["23.0.0", "24.0.0", "24.18.0", "24.19.0", "25.9.0", "26.0.0", "26.6.0"])
    for (const argv of [["--rpc"], ["--rpc", "--rebuild"], ["--rebuild", "--rpc"], ["--rpc", "--self-host"]]) {
      // No content root is named and none exists: a launch that got as far as resolving the project would say so.
      const out = await run(argv, { platform: "win32", nodeVersion: version });
      const what = `${version} ${argv.join(" ")}`;
      assert.equal(out.exit, 2, what);
      assert.equal(out.error, "exit", what);
      assert.equal(out.written.stderr, `[kiln] ${messageFor(version)}\n`, what);
      assert.equal(out.written.stdout, "", `${what}: standard output is a client's protocol stream`);
      assert.deepEqual(out.reached, [], `${what}: a launch step ran`);
      assert.deepEqual(out.reads, [], `${what}: the filesystem was read`);
      assert.deepEqual(out.started, [], `${what}: a process was started`);
    }
});

test("⚠️ #218 the test seam names a platform and a version, and cannot say a launch is or is not --rpc", async () => {
  const base = mkdtempSync(join(tmpdir(), "kiln-rpc-node-seam-"));
  const contentRoot = join(base, "project", "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  writeFileSync(join(contentRoot, "project.yaml"), "name: rpc node seam\n");
  try {
    // The command line said --rpc. Nothing the seam carries suppresses the refusal.
    for (const rpc of [false, undefined, null, 0, "", "false"]) {
      const out = await run(["--rpc"], { platform: "win32", nodeVersion: "24.18.0", rpc }, { contentRoot });
      assert.equal(out.exit, 2, `runtime.rpc ${JSON.stringify(rpc)} suppressed the refusal`);
      assert.equal(out.written.stderr, `[kiln] ${messageFor("24.18.0")}\n`);
      assert.equal(out.written.stdout, "");
      assert.deepEqual(out.reached, []);
    }
    // The command line did not. Nothing the seam carries makes it an --rpc launch.
    const terminal = await run([], { platform: "win32", nodeVersion: "24.18.0", rpc: true }, { contentRoot });
    assert.deepEqual(terminal.reached, ["launch checks"], terminal.written.stderr);
    assert.equal(terminal.written.stderr.includes(RPC_NODE_REFUSED), false);
    // And a prerelease of a first fixed release is refused through the command as well.
    for (const nodeVersion of ["24.20.0-rc.1", "26.7.0-pre", "27.0.0-rc.1"]) {
      const out = await run(["--rpc"], { platform: "win32", nodeVersion }, { contentRoot });
      assert.equal(out.exit, 2, nodeVersion);
      assert.equal(out.written.stderr, `[kiln] ${messageFor(nodeVersion)}\n`);
    }
  } finally {
    removeTestTree(base, "#218 rpc node seam");
  }
});

test("⚠️ #218 a safe release, another platform and a launch without --rpc all reach the launch checks as before", async () => {
  const base = mkdtempSync(join(tmpdir(), "kiln-rpc-node-"));
  const contentRoot = join(base, "project", "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  writeFileSync(join(contentRoot, "project.yaml"), "name: rpc node range\n");
  try {
    const cases = [
      // Windows with --rpc, on the first safe release of each line and on Node 22.
      ...["22.19.0", "22.23.3", "24.20.0", "24.21.0", "26.7.0", "26.11.1", "27.0.0"].map((nodeVersion) => [["--rpc"], { platform: "win32", nodeVersion }]),
      // Other platforms with --rpc, on unsafe releases.
      ...["linux", "darwin"].flatMap((platform) => ["23.0.0", "24.19.0", "25.9.0", "26.6.0"].map((nodeVersion) => [["--rpc"], { platform, nodeVersion }])),
      // Windows on unsafe releases, without --rpc.
      ...["23.0.0", "24.19.0", "25.9.0", "26.6.0"].flatMap((nodeVersion) => [[], ["--rebuild"]].map((argv) => [argv, { platform: "win32", nodeVersion }])),
    ];
    for (const [argv, runtime] of cases) {
      const out = await run(argv, runtime, { contentRoot });
      const what = `${runtime.platform} ${runtime.nodeVersion} ${argv.join(" ")}`;
      assert.deepEqual(out.reached, ["launch checks"], `${what}: ${out.written.stderr}`);
      assert.equal(out.error, "the launch checks were reached", what);
      assert.equal(out.exit, null, what);
      assert.equal(out.written.stderr.includes(RPC_NODE_REFUSED), false, what);
    }
  } finally {
    removeTestTree(base, "#218 rpc node range");
  }
});

/* ============================================================================ the real command ==== */

const OWN_UNSAFE = process.platform === "win32" && nodeUnsafeForRpc(process.versions.node);

test(
  "⚠️ #218 the real command under this process's own Node refuses --rpc, and starts nothing",
  { skip: OWN_UNSAFE ? false : `Node ${process.versions.node} on ${process.platform} is not one of the unsafe releases, so the command would not refuse` },
  () => {
    const base = mkdtempSync(join(tmpdir(), "kiln-rpc-node-real-"));
    try {
      // An empty directory and no content root: nothing a launch could open, and nothing it is allowed to look for.
      const env = { ...process.env };
      delete env.PLANNING_CONTENT_DIR;
      const out = spawnSync(process.execPath, [join(ROOT, "bin", "start-kiln.mjs"), "--rpc"], { cwd: base, env, encoding: "utf-8", input: `${JSON.stringify({ id: "1", type: "prompt", message: "hello" })}\n`, timeout: 60_000 });
      assert.equal(out.status, 2, out.stderr);
      assert.equal(out.signal, null);
      assert.equal(out.stdout, "", "standard output is a client's protocol stream");
      assert.equal(out.stderr, `[kiln] ${messageFor(process.versions.node)}\n`);
      assert.deepEqual(fs.readdirSync(base), [], "the command left something behind");
    } finally {
      removeTestTree(base, "#218 real rpc refusal");
    }
  }
);
