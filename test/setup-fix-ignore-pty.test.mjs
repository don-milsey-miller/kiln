/**
 * Guided setup continues after the ignore-file repair - #175.
 *
 * v26.9.0 wrote `.gitignore` when the operator chose the offered repair and then exited with
 * `project name required`, so the default first-run path stopped right after a successful fix. The guided
 * identity prompts and the `fix-ignore` branch each have tests of their own; what had none is the path an
 * operator actually takes, in a real terminal: no identity arguments, the two identity prompts, the repair,
 * and a run that then carries on to the end.
 *
 * ⚠️ **A REAL PSEUDO-TERMINAL, AND THE COMMAND'S OWN PROMPTS.** The answers are typed into the renderer setup
 * chooses for a terminal. Only npm and the billable model check are replaced, and the network is counted.
 *
 * ⚠️ **THE INVARIANT IS THAT THE WIZARD CONTINUES.** The order asserted - name, purpose, then the repair - is
 * today's intended order. What must never return is an exit between the repair and the rest of the run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { startPty } from "./helpers/pty.mjs";
import { EXIT } from "../bin/setup.mjs";
import { blockText } from "../lib/project-gitignore.mjs";
import { CONNECTIONS } from "../lib/setup-connections.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test", "fixtures", "setup", "pty-setup.mjs");
const SENTINEL_KEY = "kiln-setup-STORED-SENTINEL-175a";
const NAME = "Harbour Ledger";
const PURPOSE = "Reconcile dock fees against invoices.";
const SLOW = 120_000;

/** Every later question answered by flag, so the only prompts typed into are the ones this issue is about. */
const SETTLED = ["--inspect", "approve", "--provider", "openai", "--model", "gpt-4o", "--thinking", "off", "--model-use", "approve", "--research", "disabled", "--live-model-check", "approve"];

/** A new Git repository with no `.gitignore`, Kiln linked in as `.planning`, and an agent directory of its own. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "kiln-fix-ignore-pty-"));
  const dir = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(dir);
  mkdirSync(agentDir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  symlinkSync(ROOT, join(dir, ".planning"), process.platform === "win32" ? "junction" : "dir");
  // A stored sentinel key for a provider Kiln supports. Nothing is ever sent to it: the fixture refuses the network.
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: SENTINEL_KEY } }));
  return { root, dir, agentDir, contentRoot: join(dir, "planning-content") };
}

const terminal = (p, argv) =>
  startPty(FIXTURE, [], {
    cwd: p.dir,
    cols: 100,
    rows: 40,
    env: { PLANNING_CONTENT_DIR: p.contentRoot, PI_CODING_AGENT_DIR: p.agentDir, KILN_PTY_SETUP: JSON.stringify({ agentDir: p.agentDir, argv }) },
  });

const clean = (output) => stripVTControlCharacters(output).replace(/\r/g, "");

/** Type an answer once its prompt has been drawn. The pause lets the renderer finish attaching its key handler. */
async function answer(pty, prompt, keys) {
  await pty.waitFor(prompt, SLOW);
  await new Promise((resolve) => setTimeout(resolve, 300));
  pty.write(keys);
}

/** The three prompts #175 is about, in order: name, purpose, and the repair, which is the selector's first option. */
async function identityThenRepair(pty) {
  await answer(pty, /Project name/, `${NAME}\r`);
  await answer(pty, /What are you trying to accomplish/, `${PURPOSE}\r`);
  await answer(pty, /Where should Kiln keep local runtime files/, "\r");
}

/**
 * The optional connections, each left unconfigured, then the review applied.
 *
 * The fixture gives setup no credential and no vault, so each connection's first choice is to configure it later.
 */
async function leaveConnectionsForLater(pty) {
  for (const connection of CONNECTIONS) await answer(pty, new RegExp(`${connection.label}:`), "\r");
  await answer(pty, /Review optional connections/, "\r");
}

/** Every file of the project as bytes, leaving out Kiln's own checkout and the setup lock a killed run can leave. */
function snapshot(p) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === p.dir && [".planning", ".git", ".planning-init.lock"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.set(relative(p.dir, path).split("\\").join("/"), `${statSync(path).mtimeMs}:${readFileSync(path).toString("base64")}`);
    }
  };
  walk(p.dir);
  return out;
}

const kilnBlocks = (p) => readFileSync(join(p.dir, ".gitignore"), "utf-8").split("# Kiln planning tool").length - 1;
const manifest = (p) => readFileSync(join(p.contentRoot, "project.yaml"), "utf-8");

function assertIdentityAndOneBlock(p) {
  assert.equal(kilnBlocks(p), 1, "`.gitignore` must hold exactly one Kiln block");
  assert.equal(readFileSync(join(p.dir, ".gitignore"), "utf-8"), blockText(), "`.gitignore` is exactly Kiln's block");
  assert.ok(manifest(p).includes(`name: ${JSON.stringify(NAME)}`), manifest(p).slice(0, 600));
  assert.ok(manifest(p).includes(`description: ${JSON.stringify(PURPOSE)}`), manifest(p).slice(0, 600));
}

/**
 * End the setup process itself, as a crash or a closed terminal would, and wait for the terminal to report it.
 *
 * ⚠️ **BY PROCESS ID, NOT THROUGH THE PSEUDO-TERMINAL.** On Windows `pty.kill()` has node-pty list the console's
 * processes with a helper that throws `AttachConsole failed` while the console is closing. The fixture prints its
 * own id, the process is ended directly, and the terminal then closes on its own.
 */
async function interrupt(pty) {
  if (pty.exit()) return;
  const pid = Number(/KILN_PTY_PID (\d+)/.exec(pty.output())?.[1]);
  assert.ok(Number.isInteger(pid) && pid > 0, "the fixture never printed its process id");
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await pty.exited();
}

async function cleanup(p, pty) {
  // A terminal still open here means the test failed part way; `pty.kill()` is only the fallback for that.
  if (pty && !pty.exit()) await interrupt(pty).catch(() => pty.kill());
  rmSync(p.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

test("⚠️ #175 with no identity arguments, guided setup asks for identity, applies fix-ignore, and runs to completion", async () => {
  const p = project();
  const pty = terminal(p, ["--project-root", p.dir, "--trust", "approve", ...SETTLED]);
  try {
    await identityThenRepair(pty);
    await leaveConnectionsForLater(pty);
    await answer(pty, /Start Kiln now\?/, "no\r");
    const result = await pty.exited();
    const output = clean(result.output);

    assert.equal(result.exitCode, EXIT.OK, output);
    assert.match(output, /KILN_PTY_EXIT 0/);
    // ⚠️ THE REGRESSION ITSELF: no identity refusal, and the run goes on past the repair.
    assert.doesNotMatch(output, /project name required/i);
    assert.doesNotMatch(output, /--resume/, "a completed interactive run printed a recovery command");
    const at = (pattern) => {
      const index = output.search(pattern);
      assert.notEqual(index, -1, `the terminal never showed ${pattern}:\n${output}`);
      return index;
    };
    const order = [/Project name/, /What are you trying to accomplish/, /Where should Kiln keep local runtime files/, /added Kiln's block to \.gitignore/, /project initialized \(created\)/, /setup complete/, /Start Kiln now\?/].map(at);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `the wizard's steps came out of order:\n${output}`);

    // No network access: every network call is replaced by one that records and throws.
    assert.match(output, /KILN_PTY_NET 0\b/, "setup reached for the network");

    assertIdentityAndOneBlock(p);
    assert.equal(existsSync(join(p.dir, ".pi", "runtime", "setup-transaction.json")), false, "a completed run left a journal to resume");
    assert.equal(JSON.parse(readFileSync(join(p.dir, ".pi", "settings.json"), "utf-8")).defaultModel, "gpt-4o");
  } finally {
    await cleanup(p, pty);
  }
});

test("⚠️ #175 a run interrupted after the repair changes nothing on a plain rerun, exits 10, and --resume finishes it once", async () => {
  const p = project();
  let pty = null;
  try {
    // No `--trust`, so the run stops at a prompt just after the identity and the repair are both on disk.
    pty = terminal(p, ["--project-root", p.dir, ...SETTLED]);
    await identityThenRepair(pty);
    await pty.waitFor(/Trust this project\?/, SLOW);
    await interrupt(pty);
    assertIdentityAndOneBlock(p);
    assert.equal(existsSync(join(p.dir, ".pi", "runtime", "setup-transaction.json")), true, "the interrupted run left no journal");

    // ⚠️ A PLAIN RERUN, IN A TERMINAL, WITH THE SAME ARGUMENTS. It may not start again, ask again or repair again.
    const before = snapshot(p);
    pty = terminal(p, ["--project-root", p.dir, ...SETTLED]);
    const rerun = await pty.exited();
    const refused = clean(rerun.output);
    assert.equal(rerun.exitCode, EXIT.INTERRUPTED, refused);
    assert.equal(EXIT.INTERRUPTED, 10);
    assert.match(refused, /A previous setup of this project was interrupted/);
    assert.match(refused, /--resume/);
    assert.match(refused, /Nothing was changed by this run/);
    assert.doesNotMatch(refused, /Project name|What are you trying to accomplish/, "the rerun asked for the identity again");
    assert.deepEqual([...snapshot(p)], [...before], "the plain rerun changed the project");

    // ⚠️ THE RESUME ASKS FOR NO IDENTITY: it is given none, and what the first run saved is what stands.
    pty = terminal(p, ["--project-root", p.dir, "--resume", "--trust", "approve", ...SETTLED]);
    await leaveConnectionsForLater(pty);
    await answer(pty, /Start Kiln now\?/, "no\r");
    const resumed = await pty.exited();
    const output = clean(resumed.output);
    assert.equal(resumed.exitCode, EXIT.OK, output);
    assert.match(output, /continuing an interrupted run/);
    assert.match(output, /project initialized \(already-initialized\)/);
    assert.doesNotMatch(output, /project initialized \(created\)/, "the resume initialized the project a second time");
    assert.doesNotMatch(output, /added Kiln's block to \.gitignore/, "the resume repaired the ignore file a second time");
    assert.doesNotMatch(output, /Project name|What are you trying to accomplish/, "the resume asked for the identity again");
    assert.match(output, /KILN_PTY_NET 0\b/);

    assertIdentityAndOneBlock(p);
    assert.equal(existsSync(join(p.dir, ".pi", "runtime", "setup-transaction.json")), false, "the resumed run left a journal");
  } finally {
    await cleanup(p, pty);
  }
});
