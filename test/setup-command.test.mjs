/**
 * The ordered setup command, slice 1 — TSK-0060, toward ACC-0083, ACC-0085, ACC-0107, ACC-0043 and ACC-0045.
 *
 * ⚠️ **THE REAL COMMAND, WITH TWO SEAMS.** `main()` runs for real against a temporary project: it resolves and
 * prints the paths, checks the runtime, takes the lock, runs the bootstrap install, imports the rest, plans the
 * transaction, initializes, protects the state and mints the identity. Only npm and the operator's answer are
 * replaced — spawning npm in a test would install a dependency graph, and there is nobody to ask.
 *
 * ⚠️ **WHAT IS ASSERTED IS THE FILESYSTEM AND THE ORDER**, not a reported status: which paths were printed
 * before anything existed, what the install could see, and the bytes of every file two runs apart.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { createServer } from "node:http";
import { basename, dirname, join, relative, resolve } from "node:path";

import { EXIT, SetupCommandRefusal, main, nodeSatisfies, parseArgs, renderChoices, resolvePaths, resumeCommand } from "../bin/setup.mjs";
import { IGNORE_RULES, blockText } from "../lib/project-gitignore.mjs";

const ROOT = join(import.meta.dirname, "..");
const SENTINEL_KEY = "kiln-setup-STORED-SENTINEL-8ac3";

/**
 * A fresh consumer project: a Git repository with nothing of Kiln's in it yet, and this checkout as its
 * `.planning`.
 *
 * ⚠️ **THE LAYOUT IS THE REAL ONE, BECAUSE SLICE 2 COMMITS A PATH THAT DEPENDS ON IT.** Kiln registers its
 * package as `../.planning/pi-package`, and it writes that entry only after proving it resolves to the package
 * directory of the checkout that is running. A fixture whose `.planning` was somewhere else would exercise the
 * refusal on every case rather than the registration. The link is a junction on Windows, which needs no
 * privilege, and a directory symlink elsewhere; `canonicalPath` resolves both, which is why the proof holds
 * through it.
 */
function project({ ignored = false, models = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-setup-"));
  const dir = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  symlinkSync(ROOT, join(dir, ".planning"), process.platform === "win32" ? "junction" : "dir");
  if (ignored) writeFileSync(join(dir, ".gitignore"), blockText());

  // ⚠️ **AN AGENT DIRECTORY PER PROJECT, WITH ONE LOCAL PROVIDER IN IT.** The trust decision and the
  // authentication Pi discovers are both real, and neither is the operator's own: the provider points at a
  // closed loopback port with an inline sentinel key, and Pi's registry is built with its network disabled, so
  // discovery is genuine and nothing billable can be reached. `models: false` is the host with nothing
  // configured, which is a state setup has to report rather than crash on.
  mkdirSync(agentDir, { recursive: true });
  // ⚠️ **A STORED KEY FOR A PROVIDER KILN SUPPORTS, AND NOTHING IS EVER SENT TO IT.** Discovery is Pi's own:
  // it lists the provider's catalogue models whose authentication is configured, which is a question about this
  // directory rather than about the network, and the registry is built with its network disabled. The key is an
  // obvious sentinel; no request is made by setup, whose slices here stop before any inference.
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(models ? { openai: { type: "api_key", key: SENTINEL_KEY } } : {}));
  // ⚠️ A CUSTOM PROVIDER ALONGSIDE IT, pointed at a closed loopback port: setup has no credential declaration to
  // supply for one, so it is the case that must refuse rather than the case that must work (D25).
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "kiln-local": {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "kiln-setup-INLINE-SENTINEL-4f21",
          models: [{ id: "kiln-plain", name: "Plain", reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
        },
      },
    })
  );
  return { root, dir, contentRoot: join(dir, "planning-content"), agentDir };
}

/**
 * The answers a complete run needs, by the question it is answering.
 *
 * ⚠️ **BY PROMPT, NOT BY POSITION.** A queue of answers in order silently reassigns them the moment a phase asks
 * one more question, which is how a test starts approving something it never meant to. Each entry says which
 * question it answers.
 */
const ANSWERS = [
  [/^Which\?/i, "fix-ignore"],
  [/^Trust this project/i, "yes"],
  [/^Check this computer/i, "yes"],
  [/^Which model should this project use/i, "1"],
  [/^Thinking level/i, "off"],
  [/^Use this model for this project/i, "yes"],
  [/^Optional web research/i, "no"],
];
const scriptedAnswer = (question, overrides) => {
  for (const [pattern, answer] of overrides ?? []) if (pattern.test(question)) return answer;
  for (const [pattern, answer] of ANSWERS) if (pattern.test(question)) return answer;
  return null;
};

/**
 * Every file under `dir`, by path and digest, except Git's own and the setup lock.
 *
 * ⚠️ **THE LOCK IS NOT A LASTING WRITE.** `.planning-init.lock` is the single setup lock, taken for the whole
 * run and removed when it ends, and it lives in the project root because that is the project it excludes other
 * runs from. A test that counted it would report every run as having mutated the project before printing.
 */
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      // ⚠️ `.planning` IS THIS CHECKOUT, not the project's content: walking it would digest the whole tool.
      if (entry.name === ".git" || entry.name === ".planning" || entry.name === ".planning-init.lock") continue;
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out[relative(dir, p).split("\\").join("/")] = `sha256:${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}


/**
 * The arguments inside a command line Kiln printed, read back the way the shell it targets would.
 *
 * ⚠️ **SO THE RECORDED COMMAND IS THE SOURCE, NOT A COPY OF IT.** A recovery test that types the arguments it
 * expects passes whatever the journal says, including nothing and including the wrong project. Parsing the line
 * makes the recorded command the thing under test: a command naming another directory sends the run there, and
 * the assertions about this project fail.
 */
function parseShellArgv(command, platform = process.platform) {
  const out = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (!quoted && /\s/.test(c)) {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    started = true;
    if (c === "'") {
      if (!quoted) {
        quoted = true;
        continue;
      }
      // Inside a quoted run: PowerShell writes an apostrophe twice, a POSIX shell closes, escapes and reopens.
      if (platform === "win32" && command[i + 1] === "'") {
        current += "'";
        i += 1;
        continue;
      }
      if (platform !== "win32" && command.slice(i, i + 4) === `'${String.fromCharCode(92)}''`) {
        current += "'";
        i += 3;
        continue;
      }
      quoted = false;
      continue;
    }
    current += c;
  }
  if (started) out.push(current);
  return out;
}


/**
 * What git would commit, as paths, read the way git offers them rather than parsed out of a display format.
 *
 * ⚠️ **NUL-DELIMITED, BECAUSE A NEWLINE IS A LEGAL CHARACTER IN A PATH.** `--porcelain` quotes and escapes such a
 * path for display, and a test that split its output on newlines would silently read one entry as two — and would
 * never see the file whose name did it. `-z` gives the paths themselves, unquoted and unescaped, which is what a
 * scan of every committed file has to enumerate.
 *
 * ⚠️ **AND THE RENAME FORM IS HANDLED**, since `XY` records for a rename carry two NUL-separated paths; both are
 * returned, because both are things the working tree now has an opinion about.
 */
function committedPaths(dir) {
  const raw = execFileSync("git", ["status", "-z", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf-8" });
  const fields = raw.split("\0").filter((f) => f.length > 0);
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i].slice(0, 2);
    out.push({ status, path: fields[i].slice(3) });
    // A rename or copy is followed by its source path in the next field.
    if (/R|C/.test(status)) {
      i += 1;
      if (fields[i] !== undefined) out.push({ status, path: fields[i] });
    }
  }
  return out;
}

/** Run the real command against a project, with npm and the operator replaced. */
/**
 * ⚠️ **THE DEFAULT RUN NAMES ITS MODEL, because Pi's catalogue is not this test's to pin.** A host with an OpenAI
 * key configured can use dozens of models, and their order is Pi's; answering the list by position would make
 * every case depend on a catalogue that moves under it. The flags name one model, the confirmation is still
 * asked and answered, and the interactive list has its own case that reads the index out of what was printed.
 */
const PICKED = ["--provider", "openai", "--model", "gpt-4o", "--thinking", "off"];

/**
 * A canary that proves the key this run computed, without sending anything.
 *
 * ⚠️ **NO TEST MAY RUN THE REAL ONE.** The canary is the single step that sends a request to the selected
 * provider, and the fixture's model is a real OpenAI catalogue entry — so a suite that let the default through
 * would bill somebody for running the tests. Every case injects a runner; this one returns what a passing check
 * would have observed, derived from the preflight the command itself resolved.
 */
async function passingCanary({ selection, declared = {}, preflight }) {
  const { computeCompatibilityKey, OBSERVED_KEY_FIELDS } = await import("../lib/compatibility-record.mjs");
  const key = computeCompatibilityKey({
    selection,
    model: preflight.model,
    piVersion: preflight.piVersion,
    declared,
    effectiveBaseUrl: preflight.effectiveBaseUrl,
  });
  return {
    passed: true,
    challengeEchoed: true,
    observed: Object.fromEntries(OBSERVED_KEY_FIELDS.map((f) => [f, key[f]])),
    requests: [{ ...key.endpointIdentity, pathname: `${key.endpointIdentity.pathname}/responses` }],
  };
}

async function setup(
  p,
  argv = [],
  {
    answer,
    answers,
    install,
    env = {},
    trust = "approve",
    verifyRuntime,
    pick = PICKED,
    tavily = null,
    canary = passingCanary,
    liveCheck = "approve",
    researchAdapter = null,
  } = {}
) {
  const printed = [];
  // ⚠️ REFUSALS GO TO STDERR, and what they say is part of the contract: the operator reads the refusal, not the
  // exit code. Captured here so a test can hold the words as well as the number.
  const warned = [];
  const realError = console.error;
  console.error = (...args) => warned.push(args.join(" "));
  const seen = { atInstall: null, installs: 0, asks: [] };
  const saved = process.env.PLANNING_CONTENT_DIR;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const savedTavily = process.env.TAVILY_API_KEY;
  // ⚠️ **THE RESEARCH CREDENTIAL IS THE FIXTURE'S, NEVER THE OPERATOR'S.** Its presence decides whether setup asks
  // about web research at all, so a machine that happens to have one runs a different path from a machine that
  // does not — which is a test that passes or fails on whose computer it is. Absent unless a case asks for it, and
  // then an obvious fake. No case answers yes: a yes is what makes the probe contact Tavily.
  if (tavily === null) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = tavily;
  process.env.PLANNING_CONTENT_DIR = p.contentRoot;
  // ⚠️ PI'S OWN STATE GOES IN THE FIXTURE, not in the operator's home: the trust decision is recorded for real.
  process.env.PI_CODING_AGENT_DIR = p.agentDir;
  // ⚠️ RESTORED, NOT DELETED. A case that points LOCALAPPDATA at a fixture must not leave the runner without the
  // real one, and deleting a variable this machine had is not the same as putting it back.
  const savedEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    const code = await main(
      [
        "--project-root",
        p.dir,
        "--name",
        "Test Project",
        ...(trust ? ["--trust", trust] : []),
        ...(liveCheck ? ["--live-model-check", liveCheck] : []),
        ...pick,
        ...argv,
      ],
      {
      print: (line) => printed.push(line),
      // ⚠️ EVERY QUESTION IS RECORDED, not just answered: "did not ask" is the assertion a non-interactive run needs.
      ask: async (question) => {
        seen.asks.push(question);
        return answer === undefined ? scriptedAnswer(question, answers) : answer;
      },
      ...(verifyRuntime ? { verifyRuntime } : {}),
      ...(canary ? { canary } : {}),
      ...(researchAdapter ? { researchAdapter } : {}),
      install:
        install ??
        (() => {
          seen.installs++;
          // What the project looked like at the moment the bootstrap ran.
          seen.atInstall = { tree: tree(p.dir), printed: [...printed] };
          return { installed: true, why: "the test's bootstrap" };
        }),
    });
    return { code, printed, warned, seen };
  } finally {
    console.error = realError;
    if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedTavily === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = savedTavily;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("⚠️ ACC-0083 the setup command's pre-install import graph is Node built-ins only", () => {
  // ⚠️ THE WHOLE STATIC GRAPH, not just this file's own line. A module it imports may import an installed
  // dependency, and the command would then fail to start in the very checkout it exists to prepare.
  const scan = (entry) => {
    const seen = new Set();
    const installed = new Map();
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf-8");
      for (const m of src.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)) {
        const spec = m[1];
        if (spec.startsWith("node:")) continue;
        if (spec.startsWith("./") || spec.startsWith("../")) walk(resolve(dirname(file), spec));
        else installed.set(spec, (installed.get(spec) ?? []).concat(relative(ROOT, file).split("\\").join("/")));
      }
    };
    walk(entry);
    return installed;
  };

  const found = scan(join(ROOT, "bin", "setup.mjs"));
  assert.deepEqual([...found.keys()], [], `the pre-install graph imports installed dependencies: ${JSON.stringify([...found])}`);

  // ⚠️ THE CHECK ITSELF IS CHECKED: a top-level import of the validator or the pinned runtime must fail it.
  const copy = mkdtempSync(join(tmpdir(), "kiln-setup-graph-"));
  try {
    for (const bad of ['import Ajv from "ajv/dist/2020.js";', 'import { x } from "@earendil-works/pi-coding-agent";']) {
      const file = join(copy, "candidate.mjs");
      writeFileSync(file, `${bad}\nimport { join } from "node:path";\nvoid join;\nvoid Ajv;\n`);
      assert.notDeepEqual([...scan(file).keys()], [], `${bad} was not caught`);
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0085 every path is printed before anything is mutated, including before the bootstrap install", async () => {
  const p = project({ ignored: true });
  try {
    const before = tree(p.dir);
    const o = await setup(p);
    assert.equal(o.code, EXIT.OK, o.printed.join("\n"));

    // The five paths, in the first five lines, before the install ran.
    const heads = o.seen.atInstall.printed;
    for (const [label, value] of [
      ["tool root", ROOT],
      ["project root", p.dir],
      ["content root", p.contentRoot],
      ["settings", join(p.dir, ".pi", "settings.json")],
      ["runtime state", join(p.dir, ".pi", "runtime")],
    ]) {
      const line = heads.find((l) => l.startsWith(label));
      assert.ok(line, `${label} was not printed before the install: ${heads.join(" | ")}`);
      assert.ok(line.includes(value), `${label} printed ${line}, expected ${value}`);
    }
    // ⚠️ AND NOTHING HAD BEEN WRITTEN WHEN THEY WERE PRINTED.
    assert.deepEqual(o.seen.atInstall.tree, before, "the project was mutated before the paths were printed");
    // ⚠️ AND THE LOCK ITSELF DOES NOT SURVIVE THE RUN.
    assert.equal(existsSync(join(p.dir, ".planning-init.lock")), false, "the setup lock outlived the run");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0085 a project root that disagrees with the content's owner refuses, printing both, having written nothing", async () => {
  const p = project({ ignored: true });
  const other = project();
  try {
    const before = tree(p.dir);
    const printed = [];
    const saved = process.env.PLANNING_CONTENT_DIR;
    process.env.PLANNING_CONTENT_DIR = p.contentRoot;
    let code;
    try {
      code = await main(["--project-root", other.dir, "--name", "Test Project"], { print: (l) => printed.push(l), install: () => assert.fail("the install ran") });
    } finally {
      if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
      else process.env.PLANNING_CONTENT_DIR = saved;
    }
    assert.equal(code, EXIT.PATHS);
    assert.deepEqual(tree(p.dir), before, "the refusal wrote something");
    assert.deepEqual(tree(other.dir), {}, "the refusal wrote into the named project");
    assert.throws(
      () => resolvePaths({ projectRoot: other.dir, env: { PLANNING_CONTENT_DIR: p.contentRoot } }),
      (e) => e instanceof SetupCommandRefusal && e.exit === EXIT.PATHS && e.message.includes(other.dir) && e.message.includes(p.dir)
    );
  } finally {
    rmSync(p.root, { recursive: true, force: true });
    rmSync(other.root, { recursive: true, force: true });
  }
});

test("the runtime is checked against this checkout's engines before any dependency is installed", async () => {
  assert.equal(nodeSatisfies(">=22.19.0", "24.18.0").ok, true);
  assert.equal(nodeSatisfies(">=22.19.0", "22.19.0").ok, true);
  assert.equal(nodeSatisfies(">=22.19.0", "22.18.9").ok, false);
  assert.equal(nodeSatisfies(">=22.19.0", "20.11.1").ok, false);
  assert.match(nodeSatisfies(">=22.19.0", "20.11.1").why, /Node 20\.11\.1.*needs Node >=22\.19\.0/);
  // An engines this command cannot read is a refusal, not an assumption that it fits.
  for (const odd of [undefined, "", "^22", ">=22", "22.x"]) assert.equal(nodeSatisfies(odd, "24.18.0").ok, false);
  // The declared engines of this checkout are readable and satisfied by the runtime running these tests.
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  assert.equal(nodeSatisfies(manifest.engines.node).ok, true);
});

test("⚠️ the bootstrap install is confined to this checkout, and a lockfile it rewrote is a refusal", async () => {
  const p = project({ ignored: true });
  try {
    // What the install may see and touch: the tool root, never the project.
    const o = await setup(p, [], {
      install: ({ toolRoot }) => {
        assert.equal(toolRoot, ROOT, "the install was pointed somewhere other than this checkout");
        assert.deepEqual(Object.keys(tree(p.dir)), [".gitignore"], "the project held setup's writes before the install");
        return { installed: true, why: "the test's bootstrap" };
      },
    });
    assert.equal(o.code, EXIT.OK, o.printed.join("\n"));
    assert.ok(o.printed.some((l) => l.startsWith("dependencies installed")));

    // A real install that rewrites the lockfile is not the locked install this command promised.
    const { installDependencies } = await import("../bin/setup.mjs");
    const fake = mkdtempSync(join(tmpdir(), "kiln-setup-lock-"));
    try {
      writeFileSync(join(fake, "package-lock.json"), '{"lockfileVersion":3}');
      assert.throws(
        () =>
          installDependencies({
            toolRoot: fake,
            run: () => {
              writeFileSync(join(fake, "package-lock.json"), '{"lockfileVersion":3,"changed":true}');
              return { ok: true };
            },
          }),
        (e) => e instanceof SetupCommandRefusal && e.exit === EXIT.INSTALL && /rewrote/.test(e.message)
      );
      // A failing install refuses too, and says the project was untouched.
      assert.throws(
        () => installDependencies({ toolRoot: fake, run: () => ({ ok: false, why: "exit 1" }) }),
        (e) => e.exit === EXIT.INSTALL && /Nothing of the project was changed/.test(e.message)
      );
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0045 an interruption during the bootstrap leaves the project untouched and has no journal to resume", async () => {
  const p = project({ ignored: true });
  try {
    const before = tree(p.dir);
    const o = await setup(p, [], {
      install: () => {
        throw new SetupCommandRefusal(EXIT.INSTALL, "the bootstrap was interrupted");
      },
    });
    assert.equal(o.code, EXIT.INSTALL);
    assert.deepEqual(tree(p.dir), before, "the interrupted bootstrap changed consumer project state");
    assert.equal(existsSync(join(p.dir, ".pi")), false, "a runtime directory survived an interrupted bootstrap");

    // Rerunning repeats the locked install and completes.
    const again = await setup(p);
    assert.equal(again.code, EXIT.OK, again.printed.join("\n"));
    assert.equal(existsSync(join(p.dir, ".pi", "kiln.json")), true);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0107 the project id is minted once and reused, and the journal is gone when setup completes", async () => {
  const p = project({ ignored: true });
  try {
    const first = await setup(p);
    assert.equal(first.code, EXIT.OK, first.printed.join("\n"));
    const id = JSON.parse(readFileSync(join(p.dir, ".pi", "kiln.json"), "utf-8")).projectId;
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.ok(first.printed.some((l) => l === "project id created"));
    // ⚠️ THE JOURNAL IS REMOVED ON SUCCESS, so a completed run leaves nothing to resume from.
    assert.equal(existsSync(join(p.dir, ".pi", "runtime", "setup-transaction.json")), false);
    assert.match(resumeCommand(p.dir), /--project-root .* --resume$/);

    const second = await setup(p);
    assert.equal(second.code, EXIT.OK, second.printed.join("\n"));
    assert.equal(JSON.parse(readFileSync(join(p.dir, ".pi", "kiln.json"), "utf-8")).projectId, id, "a second identity was minted");
    assert.ok(second.printed.some((l) => l === "project id reused"));
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0107 missing coverage renders the state library's own three choices, and a non-interactive run refuses on the same object before writing runtime data", async () => {
  // Interactive: the three choices, with the ignore block's exact bytes, and the chosen one applied.
  const p = project();
  try {
    const o = await setup(p);
    assert.equal(o.code, EXIT.OK, o.printed.join("\n"));
    const rendered = o.printed.find((l) => l.includes("fix-ignore:"));
    assert.ok(rendered, o.printed.join("\n"));
    for (const id of ["fix-ignore", "user-state", "stop"]) assert.ok(rendered.includes(`${id}:`), `${id} was not offered`);
    for (const rule of IGNORE_RULES) assert.ok(rendered.includes(rule), `${rule} was not shown in the block`);
    assert.equal(readFileSync(join(p.dir, ".gitignore"), "utf-8").includes(blockText()), true, "the chosen block is not what was written");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }

  // Non-interactive: the same choices, as a refusal, with nothing written.
  const q = project();
  try {
    const o = await setup(q, ["--non-interactive"]);
    assert.equal(o.code, EXIT.STATE);
    assert.equal(existsSync(join(q.dir, ".pi")), false, "runtime data was written before the coverage refusal");
    assert.equal(existsSync(join(q.dir, "planning-content")), false, "content was written before the coverage refusal");
    assert.equal(existsSync(join(q.dir, ".gitignore")), false, "the refusal wrote an ignore file");
  } finally {
    rmSync(q.root, { recursive: true, force: true });
  }

  // Declining, or answering nothing, stops without writing.
  const r = project();
  try {
    for (const answer of [null, "stop", "user-state", "nonsense"]) {
      const o = await setup(r, [], { answer });
      assert.equal(o.code, EXIT.STATE, `${answer} did not stop`);
      assert.equal(existsSync(join(r.dir, ".pi")), false, `${answer} wrote runtime state`);
    }
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0043 a rerun with the same inputs changes no bytes of what setup owns", async () => {
  const p = project({ ignored: true });
  try {
    assert.equal((await setup(p)).code, EXIT.OK);
    const after = tree(p.dir);
    assert.ok(Object.keys(after).length > 5, "the first run wrote nothing to compare");
    // ⚠️ A RERUN NAMES NOTHING, which is what running setup again actually does: the committed selection and this
    // host's approval of it are read back and reused, so nothing is asked and nothing is rewritten.
    const again = await setup(p, [], { pick: [] });
    assert.equal(again.code, EXIT.OK, again.printed.join("\n"));
    assert.deepEqual(again.seen.asks, [], "a rerun asked about a decision this host had already made");
    assert.deepEqual(tree(p.dir), after, "a rerun with unchanged inputs changed bytes");
    // Including the times: a rerun that rewrites identical content still churns them.
    const idPath = join(p.dir, ".pi", "kiln.json");
    const mtime = statSync(idPath).mtimeMs;
    assert.equal((await setup(p, [], { pick: [] })).code, EXIT.OK);
    assert.equal(statSync(idPath).mtimeMs, mtime, "the project identity was rewritten on a rerun");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("the command line refuses what it does not take, and renders the choices it was given", () => {
  assert.deepEqual(parseArgs(["--project-root", "x", "--name", "n"]), { localState: "project", projectRoot: "x", name: "n" });
  assert.deepEqual(parseArgs(["--non-interactive", "--resume"]), { localState: "project", nonInteractive: true, resume: true });
  for (const bad of [["--project"], ["--name"], ["--local-state", "elsewhere"], ["extra"], ["--project-root", "--name"]])
    assert.ok(parseArgs(bad).error, `must refuse ${JSON.stringify(bad)}`);

  // ⚠️ **`--credential-var` TAKES A NAME, AND A KEY LOOKS NOTHING LIKE ONE.** An operator who pastes the secret
  // itself has put it in their shell history and in every process listing on the machine; the refusal is what
  // tells them, and it names neither the value nor any part of it.
  assert.deepEqual(parseArgs(["--credential-var", "ACME_KEY"]), { localState: "project", credentialVar: "ACME_KEY" });
  for (const bad of ["sk-live-2f8a0b", "$ACME_KEY", "acme_key", "ACME KEY", "ACME-KEY", "1ACME"]) {
    const refused = parseArgs(["--credential-var", bad]);
    assert.ok(refused.error, `--credential-var ${bad} was accepted`);
    assert.equal(refused.error.includes("2f8a0b"), false, "the refusal repeated part of the value");
  }
  assert.match(renderChoices([{ id: "stop", summary: "change nothing and stop", available: true }]), /stop: change nothing and stop/);
  assert.match(renderChoices([{ id: "fix-ignore", summary: "add", available: false, block: "x\n" }]), /\(not available\)/);
});

test("⚠️ a runtime this checkout does not support refuses before the dependency install, having written nothing", async () => {
  const p = project({ ignored: true });
  try {
    const before = tree(p.dir);
    const printed = [];
    const saved = process.env.PLANNING_CONTENT_DIR;
    process.env.PLANNING_CONTENT_DIR = p.contentRoot;
    let code;
    try {
      code = await main(["--project-root", p.dir, "--name", "Test Project"], {
        print: (l) => printed.push(l),
        nodeVersion: "20.11.1",
        install: () => assert.fail("the install ran on an unsupported runtime"),
      });
    } finally {
      if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
      else process.env.PLANNING_CONTENT_DIR = saved;
    }
    assert.equal(code, EXIT.RUNTIME);
    assert.deepEqual(tree(p.dir), before, "the refusal wrote something");
    // The paths are still printed first: an operator meeting this refusal has been told where it was looking.
    assert.ok(printed.some((l) => l.startsWith("project root")), printed.join("\n"));
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ the coverage fix is part of the planned transaction: a plan that refuses leaves .gitignore untouched", async () => {
  // The write used to happen before the plan existed. It was inside the lock, but outside the transaction's
  // lifetime and its phase ledger, so a run that then refused had already changed a file nothing recorded.
  // A malformed project record is refused at plan time, which is strictly before any phase runs.
  const p = project();
  try {
    mkdirSync(join(p.dir, ".pi"));
    writeFileSync(join(p.dir, ".pi", "kiln.json"), "{ not json\n");
    const o = await setup(p);
    assert.equal(o.code, EXIT.SETUP, o.printed.join("\n"));
    assert.equal(existsSync(join(p.dir, ".gitignore")), false, "the ignore block was written before the plan was built");
    assert.equal(existsSync(join(p.dir, "planning-content")), false);
    assert.equal(readFileSync(join(p.dir, ".pi", "kiln.json"), "utf-8"), "{ not json\n", "the refused run rewrote the record it refused over");

    // With the record repaired, the same project is covered and set up in one run.
    rmSync(join(p.dir, ".pi"), { recursive: true, force: true });
    const ok = await setup(p);
    assert.equal(ok.code, EXIT.OK, ok.printed.join("\n"));
    assert.equal(readFileSync(join(p.dir, ".gitignore"), "utf-8").includes(blockText()), true);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ the bootstrap install is `npm ci --ignore-scripts`, whichever npm it reaches", async () => {
  // `ci` refuses a lockfile that disagrees with package.json BEFORE it writes anything, which is the check the
  // digest comparison can only make afterwards; `--ignore-scripts` keeps a dependency's install lifecycle from
  // running in this checkout. Both are arguments, so both are asserted as arguments.
  const { INSTALL_ARGS, defaultInstall } = await import("../bin/setup.mjs");
  assert.deepEqual([...INSTALL_ARGS], ["ci", "--ignore-scripts"]);

  const calls = [];
  const spawn = (command, argv, opts) => {
    calls.push({ command, argv, opts });
    return { status: 0 };
  };
  const saved = process.env.npm_execpath;
  try {
    process.env.npm_execpath = "/npm/bin/npm-cli.js";
    assert.deepEqual(defaultInstall({ toolRoot: "/tool", spawn }), { ok: true });
    assert.deepEqual(calls[0].argv, ["/npm/bin/npm-cli.js", "ci", "--ignore-scripts"]);
    assert.equal(calls[0].command, process.execPath);

    delete process.env.npm_execpath;
    defaultInstall({ toolRoot: "/tool", spawn });
    assert.deepEqual(calls[1].argv, ["ci", "--ignore-scripts"]);
    assert.match(calls[1].command, /^npm(\.cmd)?$/);
    for (const c of calls) assert.equal(c.opts.cwd, "/tool", "the install ran outside this checkout");

    // A failing install is a refusal naming what the runner reported, never a silent continue.
    assert.deepEqual(defaultInstall({ toolRoot: "/tool", spawn: () => ({ status: 1 }) }), { ok: false, why: "exit 1" });
  } finally {
    if (saved === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = saved;
  }
});

/* ============================================== slice 2 ======================================== */

/** What the pinned runtime discovers in a project, asked of Pi's own loader and nothing else. */
async function discover(p) {
  const { resolvePinnedSdk } = await import("../lib/pi-runtime.mjs");
  const { DefaultResourceLoader, ProjectTrustStore, hasTrustRequiringProjectResources } = await import(resolvePinnedSdk(ROOT).url);
  const loader = new DefaultResourceLoader({ cwd: p.dir, agentDir: p.agentDir });
  await loader.reload({
    resolveProjectTrust: async () => {
      if (!hasTrustRequiringProjectResources(p.dir)) return true;
      const decision = new ProjectTrustStore(p.agentDir).get(p.dir);
      return decision === null ? false : decision;
    },
  });
  return {
    tools: loader.getExtensions().extensions.flatMap((e) => [...e.tools.keys()]).sort(),
    errors: loader.getExtensions().errors.map((e) => String(e.error)),
    skills: loader.getSkills().skills.map((sk) => sk.name).sort(),
  };
}

const settingsOf = (p) => JSON.parse(readFileSync(join(p.dir, ".pi", "settings.json"), "utf-8"));

test("⚠️ setup registers the package itself, and the pinned runtime loads what it wrote", async () => {
  // D27: Kiln writes the entry through its own planned merge rather than running `pi install -l` against the
  // project. What makes that more than a claim about a string is the runtime: Pi's own loader is pointed at the
  // project and asked what it found.
  const p = project({ ignored: true });
  try {
    // ⚠️ THE RUN STOPS AT THE INSPECTION, so what the settings file holds is registration's work and nothing else.
    const o = await setup(p, [], { pick: [], answers: [[/^Check this computer/i, "no"]] });
    assert.equal(o.code, EXIT.CONSENT, o.printed.join("\n"));

    const settings = settingsOf(p);
    assert.deepEqual(settings.packages, ["../.planning/pi-package"]);
    assert.deepEqual(settings.skills, ["../planning-content/skills-overrides"]);
    // ⚠️ AND NO SELECTION. The registration merge writes two keys; a provider nobody chose is not one of them.
    for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel"])
      assert.equal(Object.hasOwn(settings, key), false, `${key} was committed before anybody chose one`);

    const found = await discover(p);
    assert.deepEqual(found.errors, [], "the registered package did not load");
    assert.ok(found.tools.includes("kiln_project_status"), `the package's tools are missing: ${found.tools.join(", ")}`);
    assert.ok(found.skills.includes("kiln-planning"), `the package's skills are missing: ${found.skills.join(", ")}`);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ R9 the skill-override entry is derived from the selected content root, and setup initializes there", async () => {
  // The entry used to be fixed at `../planning-content/skills-overrides`, while the content root can be selected
  // elsewhere. Two halves: the entry setup writes is derived from the resolved content root and proved to resolve
  // back to it, and a selection this command cannot create is refused instead of quietly making a second root.
  const { skillOverrideEntry, SETTINGS_REFUSAL } = await import("../lib/pi-settings.mjs");

  const p = project({ ignored: true });
  try {
    // The derivation, over a content directory with another name: the entry follows the directory.
    mkdirSync(join(p.dir, "kiln-content", "skills-overrides"), { recursive: true });
    assert.deepEqual(skillOverrideEntry({ projectRoot: p.dir, contentRoot: join(p.dir, "kiln-content") }), {
      skillsEntry: "../kiln-content/skills-overrides",
      directory: join(p.dir, "kiln-content", "skills-overrides"),
    });
    // A content root with no overrides directory is not a Kiln content root, and registers nothing.
    assert.throws(
      () => skillOverrideEntry({ projectRoot: p.dir, contentRoot: join(p.dir, "empty-content") }),
      (e) => e.reason === SETTINGS_REFUSAL.SKILL_OVERRIDE_MISSING
    );
    // And one outside the project cannot be committed at all: the entry would be this machine's own path.
    assert.throws(
      () => skillOverrideEntry({ projectRoot: p.dir, contentRoot: join(p.root, "outside-content") }),
      (e) => e.reason === SETTINGS_REFUSAL.SKILL_OVERRIDE_OUTSIDE
    );

    // ⚠️ **AND THE COMMAND SETS UP THE CONTENT WHERE IT WAS SELECTED, rather than creating a second root beside
    // it.** This is the half R9 was missing: the entry was derived and proved, but every non-default selection was
    // refused, so nothing exercised the derivation through the command.
    const q = project({ ignored: true });
    try {
      q.contentRoot = join(q.dir, "kiln-content");
      const o = await setup(q);
      assert.equal(o.code, EXIT.OK, o.printed.join("\n"));
      assert.equal(existsSync(join(q.dir, "kiln-content", "project.yaml")), true, "the selected content root was not initialized");
      assert.equal(existsSync(join(q.dir, "planning-content")), false, "a second content root was created beside it");
      assert.deepEqual(settingsOf(q).skills, ["../kiln-content/skills-overrides"]);
      // ⚠️ AND THE OPERATOR IS TOLD what later runs need, since only the same selection finds this content again.
      assert.ok(o.printed.some((l) => /later runs need the same selection/.test(l)), o.printed.join(" | "));

      // ⚠️ THE ENTRY IS WHAT PI FOLLOWS, so the proof is Pi following it: an override in that directory wins.
      writeFileSync(
        join(q.dir, "kiln-content", "skills-overrides", "SKILL.md"),
        ["---", "name: kiln-planning", "description: An override only the selected content root can supply.", "---", "", "override", ""].join("\n")
      );
      const found = await discover(q);
      assert.deepEqual(found.errors, []);
      assert.ok(found.skills.includes("kiln-planning"), found.skills.join(", "));
    } finally {
      rmSync(q.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ the registration merge preserves every unrelated setting and adds each entry once", async () => {
  const p = project({ ignored: true });
  try {
    mkdirSync(join(p.dir, ".pi"));
    writeFileSync(
      join(p.dir, ".pi", "settings.json"),
      JSON.stringify({ defaultModel: "somebody-elses-choice", packages: ["../their-package"], theirKey: { kept: true } }, null, 2) + "\n"
    );

    // ⚠️ MEASURED WHERE REGISTRATION IS THE LAST WRITER: the run stops at the inspection, so a selection key that
    // survived can only have survived registration. The model phase commits one of its own, and legitimately.
    const declined = { pick: [], answers: [[/^Check this computer/i, "no"]] };
    assert.equal((await setup(p, [], declined)).code, EXIT.CONSENT);
    const after = settingsOf(p);
    assert.deepEqual(after.packages, ["../their-package", "../.planning/pi-package"], "an unrelated package entry was disturbed");
    assert.deepEqual(after.theirKey, { kept: true }, "an unrelated key was lost");
    assert.equal(after.defaultModel, "somebody-elses-choice", "the registration merge overwrote a selection");

    // A rerun adds nothing a second time and changes no bytes.
    const bytes = readFileSync(join(p.dir, ".pi", "settings.json"), "utf-8");
    assert.equal((await setup(p, [], declined)).code, EXIT.CONSENT);
    assert.equal(readFileSync(join(p.dir, ".pi", "settings.json"), "utf-8"), bytes, "a rerun rewrote the settings file");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0108 trust is obtained and never assumed, and a denial leaves a working project", async () => {
  // A non-interactive run with no decision recorded.
  const p = project({ ignored: true });
  try {
    const o = await setup(p, ["--non-interactive"], { trust: null });
    assert.equal(o.code, EXIT.TRUST);
    // ⚠️ IT NEITHER PROMPTED NOR ASSUMED. A run with nobody to ask that reaches the question at all would take
    // whatever a closed input returns as an answer, which is the defaulting this criterion exists to forbid.
    assert.deepEqual(o.seen.asks, [], "a non-interactive run asked a question");
    assert.equal(existsSync(join(p.dir, ".pi", "settings.json")), false, "the package was registered for an untrusted project");
    assert.equal(existsSync(join(p.dir, "planning-content", "project.yaml")), true, "the scaffold was not written");

    // Nothing was decided on its behalf: the store still has no answer, so Pi loads no project resources.
    const found = await discover(p);
    assert.deepEqual(found.tools, [], "an unapproved project loaded the package's tools");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }

  // An explicit denial: an answer, not a failure.
  const q = project({ ignored: true });
  try {
    const o = await setup(q, [], { trust: "deny" });
    assert.equal(o.code, EXIT.TRUST);
    assert.equal(existsSync(join(q.dir, ".pi", "settings.json")), false, "a denied project was registered anyway");
    assert.equal(existsSync(join(q.dir, "planning-content", "project.yaml")), true, "the scaffold did not survive a denial");
    assert.equal(existsSync(join(q.dir, ".pi", "runtime", "setup-transaction.json")), false, "a denial left a journal to resume");

    // ⚠️ **"INTACT AND VALID" IS MEASURED, NOT ASSERTED.** The scaffold surviving a denial is worth nothing if what
    // survived does not validate, so the project's own content is put through Kiln's plan linter — the same check
    // this repository runs over its own planning content.
    const linted = spawnSync(process.execPath, [join(ROOT, "bin", "lint-plan.mjs")], {
      encoding: "utf-8",
      env: { ...process.env, PLANNING_CONTENT_DIR: q.contentRoot },
    });
    assert.equal(linted.status, 0, `the scaffold a denial left does not validate:\n${linted.stdout}${linted.stderr}`);

    // ⚠️ **AND THE BROWSER-ONLY ROUTE IS SERVED, NOT INFERRED FROM THE FILES VALIDATING.** A denial means the agent
    // is not ready; what the operator keeps is the project in the browser, so that route is started against THIS
    // project and asked for a page. Content that validates does not establish that a server can read it.
    const served = await new Promise((resolve, reject) => {
      const app = spawn(process.execPath, [join(ROOT, "app", "server.mjs")], {
        env: { ...process.env, PLANNING_CONTENT_DIR: q.contentRoot, PORT: "0" },
      });
      let out = "";
      const finish = (value) => {
        app.kill("SIGKILL");
        resolve(value);
      };
      app.stdout.on("data", async (chunk) => {
        out += chunk;
        const url = /Walking skeleton on (\S+)/.exec(out)?.[1];
        if (!url) return;
        try {
          const response = await fetch(url);
          finish({ status: response.status, body: await response.text() });
        } catch (e) {
          finish({ status: 0, body: String(e?.message ?? e) });
        }
      });
      app.on("exit", (code) => {
        if (!/Walking skeleton on/.test(out)) resolve({ status: 0, body: `the server exited ${code}: ${out}` });
      });
      app.on("error", reject);
    });
    assert.equal(served.status, 200, `the browser-only route did not serve this project: ${served.body.slice(0, 400)}`);
    // A rendered page, not an error body: the skeleton's own document, and no sign of a failed read behind it.
    assert.match(served.body, /^<!doctype html>/i, served.body.slice(0, 200));
    assert.equal(/error|cannot|failed/i.test(served.body.slice(0, 600)), false, served.body.slice(0, 600));

    // ⚠️ AND THE DENIAL IS RECORDED, so the next run knows somebody said no rather than asking again.
    const { readTrust, TRUST } = await import("../lib/pi-trust.mjs");
    const recorded = await readTrust({ projectRoot: q.dir, agentDir: q.agentDir, toolRoot: ROOT });
    assert.equal(recorded.state, TRUST.DENIED);

    // Rerunning with an approval turns the same project into a ready one.
    const again = await setup(q, [], { trust: "approve" });
    assert.equal(again.code, EXIT.OK, again.printed.join("\n"));
    assert.deepEqual(settingsOf(q).packages, ["../.planning/pi-package"]);
  } finally {
    rmSync(q.root, { recursive: true, force: true });
  }

  // Interactively: the canonical directory is in the question, and "no" is a denial rather than a crash.
  const r = project({ ignored: true });
  try {
    const o = await setup(r, [], { trust: null, answer: "no" });
    assert.equal(o.code, EXIT.TRUST);
    assert.ok(o.seen.asks.some((q2) => /trust/i.test(q2)), `the operator was not asked: ${o.seen.asks.join(" | ")}`);
    assert.ok(o.printed.some((l) => l.includes(r.dir)), "the directory the decision applies to was not shown");

    const { readTrust, TRUST } = await import("../lib/pi-trust.mjs");
    assert.equal((await readTrust({ projectRoot: r.dir, agentDir: r.agentDir, toolRoot: ROOT })).state, TRUST.DENIED);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }

  // ⚠️ **ONLY A NO IS A NO.** A closed input, an empty line and an answer nobody can read are not decisions, and
  // recording any of them as a denial would make every later run stop without asking — on a decision the
  // operator never made.
  const { readTrust, TRUST } = await import("../lib/pi-trust.mjs");
  for (const [what, answer] of [
    ["a closed input", null],
    ["an empty line", "   "],
    ["an answer that is neither", "maybe later"],
  ]) {
    const t = project({ ignored: true });
    try {
      const o = await setup(t, [], { trust: null, answer });
      assert.equal(o.code, EXIT.TRUST, `${what} did not stop the run`);
      assert.ok(o.seen.asks.some((q2) => /trust/i.test(q2)), `${what} was never asked about`);
      assert.equal(
        (await readTrust({ projectRoot: t.dir, agentDir: t.agentDir, toolRoot: ROOT })).state,
        TRUST.MISSING,
        `${what} was recorded as a decision`
      );
      assert.equal(existsSync(join(t.dir, ".pi", "settings.json")), false, `${what} registered the package`);
      // The project itself is set up and can be answered later.
      assert.equal(existsSync(join(t.dir, "planning-content", "project.yaml")), true, `${what} lost the scaffold`);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  }
});

test("⚠️ the pinned runtime is verified before the transaction plan, and a mismatch writes nothing", async () => {
  // D26 step 5: everything after the dynamic imports is Pi's — the trust store, the package the settings
  // register, the loader that reads them — so a version this checkout was never measured against is a refusal
  // taken while the project is still untouched, rather than four phases in.
  const p = project({ ignored: true });
  try {
    const { resolvePinnedAgent } = await import("../lib/pi-runtime.mjs");
    const before = tree(p.dir);
    const o = await setup(p, [], {
      // The real resolver, held to a version this checkout does not have: the refusal is Pi's own.
      verifyRuntime: (_modules, paths) => resolvePinnedAgent(paths.toolRoot, { version: "0.0.0-not-this-one" }),
    });
    assert.equal(o.code, EXIT.RUNTIME, o.printed.join("\n"));
    assert.deepEqual(tree(p.dir), before, "a version mismatch changed consumer project state");
    assert.equal(existsSync(join(p.dir, ".pi")), false, "runtime state was written before the version was checked");
    assert.equal(existsSync(join(p.dir, "planning-content")), false, "the scaffold was written before the version was checked");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ the package entry is written only after it is proved to reach THIS checkout's package", async () => {
  // A `.planning` that is not this checkout: the portable entry would resolve somewhere else, so it is refused
  // rather than committed, and the settings file is not created at all.
  const p = project({ ignored: true });
  try {
    rmSync(join(p.dir, ".planning"), { recursive: true, force: true });
    mkdirSync(join(p.root, "other", "pi-package"), { recursive: true });
    symlinkSync(join(p.root, "other"), join(p.dir, ".planning"), process.platform === "win32" ? "junction" : "dir");

    const o = await setup(p);
    assert.equal(o.code, EXIT.REGISTRATION, o.printed.join("\n"));
    assert.equal(existsSync(join(p.dir, ".pi", "settings.json")), false, "an unproved entry was committed");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});


/* ============================================== slice 3 ======================================== */

const consentOf = (p) => JSON.parse(readFileSync(join(p.dir, ".pi", "runtime", "consent.json"), "utf-8"));

test("⚠️ a complete run commits the confirmed selection and grants its use on this host", async () => {
  const p = project({ ignored: true });
  try {
    const o = await setup(p);
    assert.equal(o.code, EXIT.OK, o.printed.join("\n"));

    // The selection is committed configuration, in the file Pi reads.
    const settings = settingsOf(p);
    assert.equal(settings.defaultProvider, "openai");
    assert.equal(settings.defaultModel, "gpt-4o");
    assert.equal(settings.defaultThinkingLevel, "off");
    // ⚠️ AND THE APPROVAL IS NOT. What is committed is the choice; what stays on this computer is the permission
    // to use this host's credential for it, which lives in the ignored runtime directory.
    const consent = consentOf(p);
    assert.equal(consent.modelUse.granted, true);
    assert.equal(consent.inspection.granted, true);
    assert.equal(JSON.stringify(consent).includes(SENTINEL_KEY), false, "the consent record carries credential material");
    assert.equal(readFileSync(join(p.dir, ".pi", "settings.json"), "utf-8").includes(SENTINEL_KEY), false, "settings carry credential material");

    // The credential contract for what was selected was resolved from Kiln's own table.
    assert.ok(o.printed.some((l) => l.startsWith("credential contract openai:")), o.printed.join(" | "));
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ nothing of this host is read before the inspection is allowed, and a decline reads nothing at all", async () => {
  // The order is the guarantee: Pi's authentication store, its custom-model registry and the presence of any
  // credential variable are all behind one answer. This runs the real command in a child with Node's own fs, env
  // and network boundaries recorded from before it starts, so "nothing was read" is observed rather than asserted.
  for (const [what, answers, expected] of [
    ["a decline", [["^Check this computer", "no"]], EXIT.CONSENT],
    ["a closed input", [], EXIT.CONSENT],
  ]) {
    const p = project({ ignored: true });
    try {
      // ⚠️ `spawnSync`, BECAUSE A REFUSAL IS A NON-ZERO EXIT and that is the case under test.
      const run = spawnSync(process.execPath, [join(ROOT, "test", "fixtures", "setup", "capture-setup.mjs")], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PLANNING_CONTENT_DIR: p.contentRoot,
          PI_CODING_AGENT_DIR: p.agentDir,
          OPENAI_API_KEY: "kiln-setup-ENV-SENTINEL-must-not-be-read",
          KILN_CAPTURE_SETUP: JSON.stringify({
            agentDir: p.agentDir,
            answers,
            argv: ["--project-root", p.dir, "--name", "Recorded", "--trust", "approve"],
          }),
        },
      });

      const out = run.stdout ?? "";
      const access = JSON.parse(/KILN_ACCESS (.+)/.exec(out)[1]);
      assert.equal(run.status, expected, `${what}: ${out}${run.stderr ?? ""}`);

      // ⚠️ THE COUNTS AS THEY STOOD WHEN THE QUESTION WAS ASKED, which is what makes this about order.
      const asked = access.asked.find((a) => /^Check this computer/.test(a.question));
      assert.ok(asked, `${what}: the inspection was never asked: ${access.asked.map((a) => a.question).join(" | ")}`);
      assert.deepEqual(
        { fs: access.fs.filter((f) => /auth\.json|models\.json/i.test(f)).length, credentials: access.env.filter((e) => /^get .*API_KEY/.test(e)).length },
        { fs: 0, credentials: 0 },
        `${what}: something of this host was read before the operator allowed it`
      );
      // ⚠️ **NOT ONE ENVIRONMENT EVENT, NOT MERELY NO CREDENTIAL ONES.** Loading Pi's SDK — which the trust phase
      // needs, and which the proposal orders before this one — runs its bundled `debug`, and that calls
      // `Object.keys(process.env)` for its own DEBUG settings. It reads no value, but an enumeration shows which
      // credential variables this computer has, and presence is precisely what this consent gates. So the trust
      // decision is taken in a child with an environment built by naming variables, and this process touches the
      // environment not at all before the question: a filter for credential names would pass an enumeration that
      // saw every one of them.
      assert.deepEqual(
        { events: asked.before.env, net: asked.before.net },
        { events: 0, net: 0 },
        `${what}: the environment or the network was touched before the operator allowed it: ${access.env.join(" | ")}`
      );

      // And a declined run never touches them at all: nothing in it had permission to look.
      assert.deepEqual(access.fs.filter((f) => /auth\.json|models\.json/i.test(f)), [], `${what}: the store was read anyway`);
      assert.deepEqual(access.env, [], `${what}: the environment was read anyway: ${access.env.join(" | ")}`);
      assert.deepEqual(access.net, [], `${what}: the network was reached`);

      // A declined inspection records the decline; a closed input records nothing at all.
      const consent = existsSync(join(p.dir, ".pi", "runtime", "consent.json")) ? consentOf(p) : null;
      if (what === "a decline") assert.equal(consent.inspection.granted, false);
      else assert.equal(consent?.inspection ?? null, null, "an unanswered question was recorded as a decision");
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  }
});

test("⚠️ a changed selection clears this host's approval for the old model before the new one is written", async () => {
  const p = project({ ignored: true });
  try {
    assert.equal((await setup(p)).code, EXIT.OK);
    assert.equal(consentOf(p).modelUse.model, "gpt-4o");

    // A different model: the old approval goes first, and the new one is granted only after it is confirmed.
    const changed = await setup(p, [], { pick: ["--provider", "openai", "--model", "gpt-4.1", "--thinking", "off"] });
    assert.equal(changed.code, EXIT.OK, changed.printed.join("\n"));
    assert.equal(settingsOf(p).defaultModel, "gpt-4.1");
    assert.equal(consentOf(p).modelUse.model, "gpt-4.1");

    // ⚠️ AND A DECLINED CHANGE CHANGES NOTHING. The committed selection and its grant are what they were, because
    // a no to a change says nothing about what this host already approved.
    const refused = await setup(p, [], {
      pick: ["--provider", "openai", "--model", "gpt-4o", "--thinking", "off"],
      answers: [[/^Use this model for this project/i, "no"]],
    });
    assert.equal(refused.code, EXIT.CONSENT);
    assert.equal(settingsOf(p).defaultModel, "gpt-4.1", "a declined change was written anyway");
    assert.equal(consentOf(p).modelUse.model, "gpt-4.1", "a declined change cleared the existing approval");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ the research decision is its own, and is recorded separately from the model's", async () => {
  // No Tavily key on this host: there is nothing to ask about, nothing is probed, and no grant is recorded.
  const p = project({ ignored: true });
  try {
    const o = await setup(p);
    assert.equal(o.code, EXIT.OK, o.printed.join("\n"));
    assert.equal(o.seen.asks.some((q) => /^Optional web research/i.test(q)), false, "a host with no key was asked about one");
    assert.ok(o.printed.some((l) => /Tavily/i.test(l)), o.printed.join(" | "));
    assert.equal(consentOf(p).research ?? null, null, "a research grant was recorded without a credential");

    // Asked to disable it explicitly, the project records the choice rather than leaving it unstated.
    const off = await setup(p, ["--research", "disabled"], { pick: [] });
    assert.equal(off.code, EXIT.OK, off.printed.join("\n"));
    assert.equal(JSON.parse(readFileSync(join(p.dir, ".pi", "kiln.json"), "utf-8")).research?.provider ?? "none", "none");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }

  // ⚠️ **A KEY ON THE HOST IS A QUESTION, NOT AN ENABLEMENT.** With one present the operator is asked, and a no
  // records the project's choice without the connection ever being checked. No case here answers yes: the probe
  // is what contacts Tavily, and what a probe does is measured in the research component's own tests against an
  // injected fetch.
  const q = project({ ignored: true });
  try {
    const o = await setup(q, [], { tavily: "kiln-setup-TAVILY-SENTINEL-not-a-key" });
    assert.equal(o.code, EXIT.OK, o.printed.join("\n"));
    assert.ok(o.seen.asks.some((a) => /^Optional web research/i.test(a)), o.seen.asks.join(" | "));
    assert.equal(JSON.parse(readFileSync(join(q.dir, ".pi", "kiln.json"), "utf-8")).research?.provider ?? "none", "none");
    assert.equal(consentOf(q).research ?? null, null, "a declined connection recorded a research grant");
  } finally {
    rmSync(q.root, { recursive: true, force: true });
  }
});

test("⚠️ a non-interactive run neither asks nor assumes, and a host with no models is reported rather than guessed", async () => {
  // Nobody to ask, and nothing recorded to read back: the run stops with the project valid and nothing approved.
  const p = project({ ignored: true });
  try {
    const o = await setup(p, ["--non-interactive"], { pick: [] });
    assert.equal(o.code, EXIT.CONSENT, o.printed.join("\n"));
    assert.deepEqual(o.seen.asks, [], "a non-interactive run asked a question");
    assert.equal(existsSync(join(p.dir, ".pi", "runtime", "consent.json")), false, "a run nobody answered recorded a decision");
    assert.equal(Object.hasOwn(settingsOf(p), "defaultModel"), false, "a model was committed with nobody to confirm it");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }

  // A provider Kiln has no credential contract for is refused by name, rather than bound to.
  const q = project({ ignored: true });
  try {
    const o = await setup(q, [], { pick: ["--provider", "kiln-local", "--model", "kiln-plain", "--thinking", "off"] });
    assert.equal(o.code, EXIT.CREDENTIALS, o.printed.join("\n"));
    assert.ok(
      o.printed.concat(o.printed).some(() => true) && existsSync(join(q.dir, ".pi", "settings.json")),
      "the run should have reached the settings write before refusing"
    );
    assert.equal(settingsOf(q).defaultProvider, "kiln-local", "the selection this run confirmed was not committed");
  } finally {
    rmSync(q.root, { recursive: true, force: true });
  }
});

test("⚠️ the trust child is given named variables only, so no credential variable is in it to be seen", async () => {
  // Pi's SDK enumerates the environment when it loads, and the trust store is Pi's — so setup takes that decision
  // in a child whose environment is built by naming variables rather than by copying this one. What proves the
  // boundary is the builder: a host with every credential variable set hands the child none of them.
  const { trustChildEnv } = await import("../bin/setup.mjs");
  const { BASE_ENV, AGENT_DIR_ENV } = await import("../lib/specialists/contract.mjs");
  const { supportedProviders, resolveProviderCredentials, declaredNames } = await import("../lib/pi-provider-credentials.mjs");
  const { RESEARCH_CREDENTIAL } = await import("../lib/connection-inspection.mjs");

  const credentials = new Set([RESEARCH_CREDENTIAL]);
  for (const id of supportedProviders()) for (const n of declaredNames(resolveProviderCredentials(id))) credentials.add(n);

  const host = { PATH: "/usr/bin", HOME: "/home/k", SystemRoot: "C:\Windows", [AGENT_DIR_ENV]: "/agent" };
  for (const name of credentials) host[name] = "kiln-setup-MUST-NOT-CROSS";

  const names = [...BASE_ENV[process.platform === "win32" ? "win32" : "posix"], AGENT_DIR_ENV];
  const built = trustChildEnv(names, host);

  assert.equal(built[AGENT_DIR_ENV], "/agent", "the child was not told which agent directory to use");
  for (const name of credentials) assert.equal(Object.hasOwn(built, name), false, `${name} reached the trust child`);
  // ⚠️ AND NOTHING THE LIST DOES NOT NAME: a builder that copied anything else would carry whatever the operator
  // happened to have exported, which is the copy this exists to avoid.
  assert.deepEqual(Object.keys(built).filter((k) => !names.includes(k)), []);
});

test("⚠️ a trust child that fails is a refusal, never a decision", async () => {
  // The child answers with one JSON line. Anything else — a non-zero exit, silence, a half-written line — means
  // nobody knows what this project's trust is, and continuing as though it were approved is the one outcome that
  // must not be reachable.
  const { trustDecision } = await import("../bin/setup.mjs");
  const { BASE_ENV, AGENT_DIR_ENV, AGENT_SESSION_DIR_ENV } = await import("../lib/specialists/contract.mjs");
  const modules = { contract: { BASE_ENV, AGENT_DIR_ENV, AGENT_SESSION_DIR_ENV } };
  const paths = { toolRoot: ROOT, projectRoot: join(ROOT, "nowhere") };

  await assert.rejects(
    () => trustDecision("approve", paths, modules, () => ({ status: 3, stdout: "", stderr: "the trust store could not be written" })),
    (e) => e instanceof SetupCommandRefusal && e.exit === EXIT.TRUST && /could not be written/.test(e.message),
    "a failed child must refuse, and say what it said"
  );
  await assert.rejects(
    () => trustDecision("read", paths, modules, () => ({ status: 0, stdout: "half a line", stderr: "" })),
    (e) => e instanceof SetupCommandRefusal && e.exit === EXIT.TRUST,
    "an unreadable report must refuse"
  );
  // ⚠️ AND A FAILED CHILD DOES NOT PROMISE THAT NOTHING HAPPENED: it may have written the decision and failed on
  // the read-back that proves it landed, so what the operator is told is that the result is unverified.
  await assert.rejects(
    () => trustDecision("approve", paths, modules, () => ({ status: 3, stdout: "", stderr: "" })),
    (e) => /unknown/i.test(e.message) && !/nothing about this project's trust was changed/i.test(e.message),
    "a failed recording must not claim nothing changed"
  );

  // ⚠️ **A PARSEABLE LINE IS NOT A DECISION.** Each of these parses, and each would have this run act on evidence
  // about something else — another project, another question, or a report missing what makes it one.
  const good = { state: "approved", projectRoot: paths.projectRoot, agentDir: "/agent", recordedFor: paths.projectRoot };
  const line = (o) => ({ status: 0, stdout: `${JSON.stringify(o)}\n`, stderr: "" });
  for (const [why, report, action] of [
    ["another project", { ...good, projectRoot: join(ROOT, "somebody-elses-project") }, "approve"],
    ["no project at all", { ...good, projectRoot: undefined }, "approve"],
    ["no agent directory", { ...good, agentDir: "" }, "approve"],
    ["a state Pi's store cannot give", { ...good, state: "probably" }, "read"],
    ["an approval to a denial", { ...good }, "deny"],
    ["not an object", "approved", "read"],
  ])
    await assert.rejects(
      () => trustDecision(action, paths, modules, () => line(report)),
      (e) => e instanceof SetupCommandRefusal && e.exit === EXIT.TRUST,
      `${why} was accepted as this project's trust`
    );

  // And a report that answers the question, about this project, is returned as the decision it is.
  assert.deepEqual(await trustDecision("approve", paths, modules, () => line(good)), good);
  assert.equal((await trustDecision("read", paths, modules, () => line({ ...good, state: "missing" }))).state, "missing");
});

/* ============================================== slice 4 ======================================== */

test("⚠️ ACC-0045 an interrupted run is continued deliberately, and the published mapping says what each code means", async () => {
  // The journal's presence is the interruption signal. Every phase is idempotent, so continuing is safe — but the
  // operator has to learn that a run did not finish, so an ordinary rerun says so and prints the command the
  // interrupted run itself recorded, rather than quietly carrying on.
  const p = project({ ignored: true });
  try {
    assert.equal((await setup(p)).code, EXIT.OK);

    const journal = join(p.dir, ".pi", "runtime", "setup-transaction.json");
    writeFileSync(
      journal,
      JSON.stringify({
        recordVersion: 1,
        operation: "setup",
        startedAt: new Date().toISOString(),
        phases: [
          { name: "initialize", status: "complete" },
          { name: "registration", status: "running" },
        ],
        lastCompletedPhase: "initialize",
        fileIdentities: [],
        // ⚠️ A COMMAND NOBODY SHOULD PRINT BACK. The journal is a file in a project directory, so a refusal that
        // echoed its `recovery.command` would put whatever is in that file in front of the operator to copy.
        recovery: { command: "echo this-came-out-of-the-journal", reason: "setup was interrupted after the journal began" },
      }) + "\n"
    );

    const stopped = await setup(p, [], { pick: [] });
    assert.equal(stopped.code, EXIT.INTERRUPTED, stopped.printed.join("\n"));
    assert.equal(existsSync(journal), true, "the refusal removed the evidence of the interruption");
    // ⚠️ WHAT IT TELLS THE OPERATOR TO RUN IS THIS RUN'S OWN COMMAND, never the one in the file it just read.
    const refusal = stopped.warned.join("\n");
    assert.ok(refusal.includes(resumeCommand(p.dir)), refusal);
    // ⚠️ AND IT SAYS WHICH SHELL THAT LINE IS QUOTED FOR: `cmd.exe` does not treat single quotes as quoting at all,
    // so an operator in one has to know to adjust rather than to paste.
    assert.match(refusal, process.platform === "win32" ? /Continue it with, in PowerShell:/ : /Continue it with, in a POSIX shell:/);
    assert.equal(refusal.includes("this-came-out-of-the-journal"), false, "the refusal printed a command out of the journal");

    // With --resume it continues, and the completed run leaves no journal behind.
    const resumed = await setup(p, ["--resume"], { pick: [] });
    assert.equal(resumed.code, EXIT.OK, resumed.printed.join("\n"));
    assert.ok(resumed.printed.some((l) => /continuing an interrupted run/.test(l)), resumed.printed.join(" | "));
    assert.equal(existsSync(journal), false, "a completed run left a journal to resume");

    // ⚠️ AND `--resume` WITH NOTHING TO RESUME IS AN ORDINARY RUN, said out loud rather than implied.
    const ordinary = await setup(p, ["--resume"], { pick: [] });
    assert.equal(ordinary.code, EXIT.OK);
    assert.ok(ordinary.printed.some((l) => /nothing to resume/.test(l)), ordinary.printed.join(" | "));
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ every exit code this command can return is published by --help", async () => {
  const { usage, EXIT_MEANING } = await import("../bin/setup.mjs");
  const printed = [];
  assert.equal(await main(["--help"], { print: (l) => printed.push(l), install: () => ({ installed: false, why: "unused" }) }), EXIT.OK);

  const text = printed.join("\n");
  for (const [name, code] of Object.entries(EXIT)) {
    assert.ok(Object.hasOwn(EXIT_MEANING, String(code)), `${name} (${code}) has no published meaning`);
    assert.ok(printed.some((l) => new RegExp(`^\\s*${code}\\s`).test(l)), `${name} (${code}) is not in --help`);
  }
  // ⚠️ AND THE OPTIONS THAT DECIDE SOMETHING BILLABLE OR IRREVERSIBLE ARE NAMED THERE TOO.
  for (const flag of ["--trust", "--live-model-check", "--non-interactive", "--resume", "--credential-var", "--local-state"])
    assert.ok(text.includes(flag), `${flag} is undocumented`);
  // ⚠️ AND WHAT IT SAYS ABOUT THEM IS TRUE. Help that still calls a supported mode unsupported is worse than no
  // help: an operator reads it and does not try the thing that works.
  const localState = printed.find((l) => l.includes("--local-state"));
  assert.match(localState, /project\|user/, localState);
  assert.equal(/not supported|unsupported/.test(localState), false, localState);
  assert.deepEqual(usage(), printed, "--help printed something other than the command's own usage");
});

/** A canary that counts its runs, so "it never ran" is an observation rather than an inference. */
function countingCanary(result = passingCanary) {
  const runs = [];
  const seen = { runs, preflight: null };
  seen.canary = async (ctx) => {
    runs.push(ctx.selection);
    // ⚠️ KEPT, BECAUSE THE READ-BACK IS ASKED THE SAME QUESTION LATER: what the command resolved is what the
    // record has to match, and rebuilding it here would be a second answer rather than the one under test.
    seen.preflight = ctx.preflight;
    return typeof result === "function" ? result(ctx) : result;
  };
  return seen;
}

const recordPath = (p) => join(p.dir, ".pi", "runtime", "model-compatibility.json");

test("⚠️ the zero-cost checks run first, and a run they refuse sends nothing", async () => {
  // Everything a run can be refused for without spending anything — the selection, this host's grant, the
  // credential contract, Pi's catalogue, the thinking level, the package — is settled before the one check that
  // costs money is offered. So a project whose authentication has gone never reaches the canary at all.
  const p = project({ ignored: true });
  try {
    assert.equal((await setup(p)).code, EXIT.OK);
    writeFileSync(join(p.agentDir, "auth.json"), "{}");

    const c = countingCanary();
    const o = await setup(p, [], { pick: [], canary: c.canary });
    assert.equal(o.code, EXIT.CREDENTIALS, o.printed.join("\n"));
    assert.deepEqual(c.runs, [], "the billable check ran for a project the zero-cost checks refused");
    assert.ok(o.printed.every((l) => !/^preflight passed/.test(l)), o.printed.join(" | "));

    // ⚠️ **THE JOURNAL THE FAILED RUN LEFT SAYS WHERE IT STOPPED, AND THAT THE BILLABLE PHASE NEVER STARTED.**
    // An exit code alone cannot show that; the ledger can. Which zero-cost phase refuses depends on what the host
    // lost — here the host's only remaining provider is the loopback one, which has no credential contract — and
    // the guarantee is about the two phases after them, not about which of them fires.
    const journal = JSON.parse(readFileSync(join(p.dir, ".pi", "runtime", "setup-transaction.json"), "utf-8"));
    const status = Object.fromEntries(journal.phases.map((ph) => [ph.name, ph.status]));
    const zeroCost = ["inspection", "model", "credential-contract", "preflight"];
    assert.ok(zeroCost.some((name) => status[name] === "failed"), `no zero-cost phase failed: ${JSON.stringify(status)}`);
    assert.equal(status["live-check"], "pending", JSON.stringify(status));
    assert.equal(status["read-back"], "pending", JSON.stringify(status));
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ the billable check needs its own approval, which is separate from every other answer", async () => {
  // Denied outright: nothing is sent, nothing is recorded, and the project is left valid and partial.
  const p = project({ ignored: true });
  try {
    const c = countingCanary();
    const o = await setup(p, [], { liveCheck: "deny", canary: c.canary });
    assert.equal(o.code, EXIT.CONSENT, o.printed.join("\n"));
    assert.deepEqual(c.runs, [], "a denied check still sent a request");
    assert.equal(existsSync(recordPath(p)), false, "a denied check recorded compatibility");
    assert.ok(o.printed.some((l) => /not run, by your choice/.test(l)), o.printed.join(" | "));
    // The project itself is set up: the model is committed, the package registered, the scaffold valid.
    assert.equal(settingsOf(p).defaultModel, "gpt-4o");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }

  // Asked interactively and answered no: the same outcome, from the operator rather than the flag.
  const q = project({ ignored: true });
  try {
    const c = countingCanary();
    const o = await setup(q, [], { liveCheck: null, canary: c.canary, answers: [[/^Live model check/i, "no"]] });
    assert.equal(o.code, EXIT.CONSENT, o.printed.join("\n"));
    assert.ok(o.seen.asks.some((a) => /^Live model check/i.test(a)), o.seen.asks.join(" | "));
    assert.deepEqual(c.runs, []);
    assert.equal(existsSync(recordPath(q)), false);
  } finally {
    rmSync(q.root, { recursive: true, force: true });
  }

  // ⚠️ NOBODY TO ASK, AND NO FLAG: it refuses rather than assuming approval for something billable. The project is
  // taken all the way to the check first — inspection allowed, model confirmed, only the check outstanding — so
  // what this measures is the billable step, and not an earlier refusal standing in for it.
  const r = project({ ignored: true });
  try {
    const c = countingCanary();
    assert.equal((await setup(r, [], { liveCheck: "deny", canary: c.canary })).code, EXIT.CONSENT);
    assert.equal(existsSync(recordPath(r)), false);

    const o = await setup(r, ["--non-interactive"], { liveCheck: null, canary: c.canary, pick: [] });
    assert.equal(o.code, EXIT.CONSENT, o.printed.join("\n"));
    assert.deepEqual(o.seen.asks, [], "a run with nobody to ask asked anyway");
    assert.deepEqual(c.runs, [], "a run with nobody to ask sent a billable request");
    assert.equal(existsSync(recordPath(r)), false);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("⚠️ a passing check is recorded, read back, and reused by the next run without asking again", async () => {
  const p = project({ ignored: true });
  try {
    const c = countingCanary();
    const first = await setup(p, [], { canary: c.canary });
    assert.equal(first.code, EXIT.OK, first.printed.join("\n"));
    assert.equal(c.runs.length, 1, "the check ran more than once, or not at all");
    assert.ok(first.printed.some((l) => /^compatibility recorded and read back/.test(l)), first.printed.join(" | "));

    // ⚠️ THE RECORD IS WHAT THE NEXT START WILL READ, so the test reads it the same way and recomputes the key.
    const { readCompatibility, compatibilityLocation, computeCompatibilityKey, differingFields } = await import("../lib/compatibility-record.mjs");
    const found = readCompatibility(compatibilityLocation({ projectRoot: p.dir }));
    assert.equal(found.state, "valid", JSON.stringify(found));
    assert.equal(found.record.result.outcome, "passed");
    assert.equal(JSON.stringify(found.record).includes(SENTINEL_KEY), false, "the compatibility record carries credential material");

    // A second run reuses it: no question, no request, and the same bytes.
    const bytes = readFileSync(recordPath(p), "utf-8");
    const second = await setup(p, [], { pick: [], canary: c.canary, liveCheck: null });
    assert.equal(second.code, EXIT.OK, second.printed.join("\n"));
    assert.equal(c.runs.length, 1, "a recorded check was run again");
    assert.deepEqual(second.seen.asks, [], "a recorded check asked again");
    assert.equal(readFileSync(recordPath(p), "utf-8"), bytes, "a rerun rewrote the compatibility record");
    void computeCompatibilityKey;
    void differingFields;
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ a check that does not pass, or does not prove what it checked, records nothing and reports not ready", async () => {
  // The canary said no.
  const p = project({ ignored: true });
  try {
    const o = await setup(p, [], { canary: async () => ({ passed: false }) });
    assert.equal(o.code, EXIT.NOT_PROVED, o.printed.join("\n"));
    assert.equal(existsSync(recordPath(p)), false, "a failed check was recorded");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }

  // ⚠️ THE CANARY PASSED, BUT NOT ON WHAT THIS RUN CHECKED. A child that resolved a different endpoint proves
  // something about another configuration, and a record made from it would let a later start skip the check on
  // evidence that never applied to it.
  const q = project({ ignored: true });
  try {
    const o = await setup(q, [], {
      canary: async (ctx) => {
        const proof = await passingCanary(ctx);
        return { ...proof, requests: [{ ...proof.requests[0], hostname: "somewhere-else.example" }] };
      },
    });
    assert.equal(o.code, EXIT.NOT_PROVED, o.printed.join("\n"));
    assert.equal(existsSync(recordPath(q)), false, "a check that proved something else was recorded");
  } finally {
    rmSync(q.root, { recursive: true, force: true });
  }
});

test("⚠️ readiness is what the record says on disk, not what the writer reported", async () => {
  // The read-back is its own step, and it answers with the file. Held directly, because the case it exists for —
  // a record that cannot be read back — is one the filesystem has to produce.
  const { verifyRecorded } = await import("../bin/setup.mjs");
  const { compatibilityLocation, computeCompatibilityKey, readCompatibility, differingFields, recordCompatibility } = await import(
    "../lib/compatibility-record.mjs"
  );
  const modules = { compatibility: { compatibilityLocation, computeCompatibilityKey, readCompatibility, differingFields } };

  const p = project({ ignored: true });
  try {
    const c = countingCanary();
    assert.equal((await setup(p, [], { canary: c.canary })).code, EXIT.OK);
    const compatibility = compatibilityLocation({ projectRoot: p.dir });
    const preflight = c.preflight;

    // The record this run wrote reads back and matches.
    const ok = await verifyRecorded({ compatibility, preflight, modules, validators: undefined });
    assert.equal(ok.record.result.outcome, "passed");

    // A record that is gone is not readiness.
    rmSync(recordPath(p));
    await assert.rejects(
      () => verifyRecorded({ compatibility, preflight, modules, validators: undefined }),
      (e) => e instanceof SetupCommandRefusal && e.exit === EXIT.NOT_PROVED && /cannot be read back/.test(e.message)
    );

    // And a record about another model is not this project's proof.
    const otherKey = { ...ok.key, model: "gpt-4.1" };
    await recordCompatibility(compatibility, { key: otherKey, result: { outcome: "passed", observedAt: new Date().toISOString(), challengeEchoed: true } });
    await assert.rejects(
      () => verifyRecorded({ compatibility, preflight, modules, validators: undefined }),
      (e) => e instanceof SetupCommandRefusal && e.exit === EXIT.NOT_PROVED && /model/.test(e.message)
    );
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ the live check is given this host's saved credential, and a recovery file is never trusted for what it prints", async () => {
  // Two production paths that no earlier control reached.
  const { readJournal, resumeCommand: resume } = await import("../bin/setup.mjs");
  const { canaryRequest } = await import("../lib/launch-checks.mjs");

  // ⚠️ **THE SAVED CREDENTIAL REACHES THE CHECK.** Pi authenticates a provider from its stored auth.json as
  // readily as from the environment; a canary run against an empty store would fail a model that works on this
  // computer. The path handed over is the agent directory the preflight resolved, and the canary's own boundary
  // copies only the selected provider's entry out of it (test/pi-provider-canary.test.mjs).
  const request = canaryRequest(
    { selection: { provider: "openai", model: "gpt-4o", thinkingLevel: "off" }, declared: { endpointIdentity: "x" } },
    { agentDir: join("/some", "agent"), authSource: "stored" }
  );
  assert.deepEqual(request, {
    provider: "openai",
    model: "gpt-4o",
    thinkingLevel: "off",
    declared: { endpointIdentity: "x" },
    storedAuthPath: join("/some", "agent", "auth.json"),
  });

  // ⚠️ **AND THE RECOVERY READ IS CONTAINED, VALIDATED, AND NOT A SOURCE OF WHAT IS PRINTED.** The journal is a
  // file in a project directory: read through a link it is somebody else's file, and read unvalidated it is
  // somebody else's text in this command's own refusal.
  const p = project({ ignored: true });
  try {
    const roots = { within: p.dir, root: join(p.dir, ".pi"), runtime: join(p.dir, ".pi", "runtime") };
    const validate = (record) => {
      if (!Array.isArray(record?.phases)) throw new Error("not a journal");
    };
    mkdirSync(roots.runtime, { recursive: true });
    const journal = join(roots.runtime, "setup-transaction.json");

    assert.equal(readJournal(roots, validate), null, "an absent journal is not an interruption");

    writeFileSync(journal, "{ half a record");
    assert.deepEqual(readJournal(roots, validate), { unreadable: true }, "a truncated journal is still an interruption");

    writeFileSync(journal, JSON.stringify({ phases: "not an array", recovery: { command: "rm -rf /" } }));
    assert.deepEqual(readJournal(roots, validate), { unreadable: true }, "an invalid journal was read as a decision");

    writeFileSync(journal, JSON.stringify({ phases: [{ name: "initialize", status: "complete" }], lastCompletedPhase: "initialize" }));
    assert.equal(readJournal(roots, validate).lastCompletedPhase, "initialize");

    // Something that is not a regular file where the journal should be is refused rather than read.
    rmSync(journal, { force: true });
    mkdirSync(journal);
    assert.deepEqual(readJournal(roots, validate), { contained: false }, "a directory at the journal path was read as one");
    rmSync(journal, { recursive: true });

    // ⚠️ **A STATE ROOT THAT IS ITSELF A LINK OUT OF THE PROJECT.** Canonicalising `.pi` and then asking whether
    // the journal is inside it answers yes here — both sides resolve to the same somewhere-else — so the question
    // has to be asked of the state root against the project first.
    mkdirSync(join(p.root, "outside-pi", "runtime"), { recursive: true });
    writeFileSync(join(p.root, "outside-pi", "runtime", "setup-transaction.json"), JSON.stringify({ phases: [] }));
    rmSync(roots.root, { recursive: true, force: true });
    symlinkSync(join(p.root, "outside-pi"), roots.root, process.platform === "win32" ? "junction" : "dir");
    assert.deepEqual(readJournal({ ...roots, within: p.dir }, validate), { contained: false }, "a linked .pi was read");
    rmSync(roots.root, { recursive: true, force: true });
    mkdirSync(roots.runtime, { recursive: true });

    // A runtime directory that resolves outside the state root is refused rather than read.
    rmSync(roots.runtime, { recursive: true, force: true });
    symlinkSync(join(p.root, "elsewhere"), roots.runtime, process.platform === "win32" ? "junction" : "dir");
    mkdirSync(join(p.root, "elsewhere"), { recursive: true });
    writeFileSync(join(p.root, "elsewhere", "setup-transaction.json"), JSON.stringify({ phases: [] }));
    assert.deepEqual(readJournal(roots, validate), { contained: false }, "a journal outside the state root was read");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }

  // ⚠️ THE COMMAND AN OPERATOR IS TOLD TO RUN IS QUOTED, ALWAYS AND FOR THE RIGHT SHELL — the metacharacter cases
  // are held on their own below; this is the shape of the line they appear in.
  assert.equal(resume("C:/a b/proj", "win32"), "node .planning/bin/setup.mjs --project-root 'C:/a b/proj' --resume");
  assert.equal(resume("/home/plain/proj", "linux"), "node .planning/bin/setup.mjs --project-root '/home/plain/proj' --resume");
});

test("⚠️ the command an operator is told to run names the same project after the shell has read it", async () => {
  const { shellArgument, shellName, resumeCommand: resume } = await import("../bin/setup.mjs");

  // ⚠️ **QUOTED FOR POWERSHELL ON WINDOWS, AND THAT IS A MEASUREMENT, NOT A PREFERENCE.** Inside double quotes
  // PowerShell expands `$` and backticks, so `"C:/a$null/project"` pasted back names `C:/a/project` — a different
  // directory, silently, with no error for the operator to notice. Single quotes suppress every expansion, and an
  // apostrophe inside them is written twice. POSIX shells need the other sequence, since a backslash does not
  // escape inside single quotes there.
  for (const awkward of ["C:/a&b/project", "C:/a b/project", "C:/a;b/project", "C:/a|b/project", "C:/a$b/project"]) {
    assert.equal(shellArgument(awkward, "win32"), `'${awkward}'`, awkward);
    assert.equal(shellArgument(awkward, "linux"), `'${awkward}'`, awkward);
  }
  assert.equal(shellArgument("C:/it's/here", "win32"), "'C:/it''s/here'");
  assert.equal(shellArgument("/it's/here", "linux"), "'/it'" + String.fromCharCode(92) + "''s/here'");
  // ⚠️ AND THE LINE SAYS WHICH SHELL IT IS FOR, because `cmd.exe` does not treat single quotes as quoting at all.
  assert.equal(shellName("win32"), "PowerShell");
  assert.equal(shellName("linux"), "a POSIX shell");

  // ⚠️ **THE PROOF IS THE ROUND TRIP, NOT THE STRING.** A test that checks the path is wrapped in quotes cannot
  // tell quoting that works from quoting that silently renames a directory. So the generated command is run by
  // the shell it names, against a project whose path holds each metacharacter, and what is read back is the
  // project the command actually reached — the command refuses, and its refusal prints the root it was given.
  const p = project({ ignored: true });
  try {
    for (const awkward of ["a$null-x", "a`b-x", "a&b-x", "it's-x"]) {
      const named = join(p.root, awkward, "project");
      mkdirSync(named, { recursive: true });

      // ⚠️ **ONLY THE SCRIPT'S LOCATION IS SUBSTITUTED; THE QUOTED ARGUMENT IS THE COMMAND'S OWN.** The printed
      // line names `.planning/bin/setup.mjs`, and this fixture's `.planning` is a link to the checkout — Node
      // resolves a script through its real path, so invoked that way the file would not recognise itself as the
      // program being run and would do nothing. What is under test is the quoting of the project path, so that
      // part travels verbatim.
      const printed = resume(named);
      const command = printed.replace(".planning/bin/setup.mjs", shellArgument(join(ROOT, "bin", "setup.mjs")));
      assert.ok(command.endsWith(printed.slice(printed.indexOf("--project-root"))), printed);

      const env = { ...process.env, PLANNING_CONTENT_DIR: p.contentRoot };
      const run =
        process.platform === "win32"
          ? // ⚠️ POWERSHELL RETURNS ITS OWN STATUS, not the program's, unless it is told to pass it on.
            spawnSync("powershell", ["-NoProfile", "-Command", `${command}; exit $LASTEXITCODE`], { cwd: p.dir, encoding: "utf-8", env })
          : spawnSync("sh", ["-c", command], { cwd: p.dir, encoding: "utf-8", env });

      // The run refuses, because the named project does not own the selected content root — and the refusal is
      // where it prints the project root it was handed, which is exactly what the shell delivered.
      const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      assert.equal(run.status, EXIT.PATHS, `${awkward}: ${output}`);
      assert.ok(
        output.includes(realpathSync(named)),
        `${awkward}: the shell did not deliver the path this command named${String.fromCharCode(10)}  command: ${command}${String.fromCharCode(10)}  output:  ${output}`
      );
    }
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ a host authenticated by an environment variable is not handed a stored file that does not exist", async () => {
  // The canary refuses a stored path that is not there, and a host authenticated by a variable commonly has no
  // auth.json at all — so always supplying one would fail a check whose credential never needed that file. What
  // decides is what the preflight found: the source that actually authenticates this selection.
  const { canaryRequest } = await import("../lib/launch-checks.mjs");
  const selection = { provider: "openai", model: "gpt-4o", thinkingLevel: "off" };

  assert.equal(
    canaryRequest({ selection, declared: {} }, { agentDir: join("/some", "agent"), authSource: "stored" }).storedAuthPath,
    join("/some", "agent", "auth.json")
  );
  for (const source of ["environment-key", "custom-environment-key"])
    assert.equal(
      canaryRequest({ selection, declared: {} }, { agentDir: join("/some", "agent"), authSource: source }).storedAuthPath,
      null,
      `${source} was handed a stored file`
    );

  // ⚠️ AND THE CANARY IS THE ONE THAT SAYS SO: a supplied path that is not there is its refusal, which is why the
  // decision above is not a matter of taste.
  const { runLiveCanary } = await import("../lib/live-canary.mjs");
  await assert.rejects(
    () => runLiveCanary({ ...selection, storedAuthPath: join(tmpdir(), "kiln-no-such-auth-file.json") }),
    (e) => e.name === "CanaryRefusal" && e.reason === "canary-stored-auth-missing"
  );
});

test("⚠️ --local-state user keeps every runtime record outside the project, keyed by the committed id", async () => {
  // The external root is keyed by the project's committed id and never by its path: a path-derived root moves the
  // moment somebody renames the project, taking every transcript and consent record with it. So the id is
  // committed first, in a transaction that plans that record and nothing else, and the root is named from it.
  const p = project({ ignored: true });
  const stateHome = join(p.root, "state-home");
  try {
    const o = await setup(p, ["--local-state", "user"], { env: { LOCALAPPDATA: stateHome, XDG_STATE_HOME: stateHome } });
    assert.equal(o.code, EXIT.OK, o.printed.join("\n"));

    // ⚠️ THE RULE IS PRINTED BEFORE ANYTHING IS MUTATED, and the path as soon as the id makes it knowable.
    const paths = o.printed.filter((l) => l.startsWith("runtime state"));
    assert.match(paths[0], /keyed by this project's committed id/);
    assert.equal(paths.length, 2, o.printed.join(" | "));

    // ⚠️ THE ROOT IS TAKEN FROM WHAT THE COMMAND PRINTED, not rebuilt here: the layout under the per-user home is
    // the state library's, and a test that spelled it again would be asserting its own copy of that rule.
    const id = JSON.parse(readFileSync(join(p.dir, ".pi", "kiln.json"), "utf-8")).projectId;
    const runtime = paths[1].replace(/^runtime state /, "").trim();
    const external = dirname(runtime);
    assert.ok(runtime.startsWith(stateHome), `${runtime} is not under the fixture's state home`);
    assert.equal(basename(external), id, `${external} is not keyed by the committed id`);

    // Every runtime record is out there, and none of it is in the project.
    for (const name of ["consent.json", "model-compatibility.json"])
      assert.equal(existsSync(join(external, "runtime", name)), true, `${name} is not in the external root`);
    assert.equal(existsSync(join(p.dir, ".pi", "runtime")), false, "runtime state was written into the project");

    // ⚠️ AND NO SESSION PATH IS COMMITTED: the external root is this machine's, and the launcher supplies it.
    assert.equal(Object.hasOwn(settingsOf(p), "sessionDir"), false, "an external run committed a machine-specific session path");
    assert.equal(settingsOf(p).defaultModel, "gpt-4o");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ D25 a custom provider is declared, not guessed, and the real canary checks it against its own endpoint", async () => {
  // ⚠️ **THE ONLY CASE IN THIS FILE THAT RUNS THE REAL CANARY**, which is possible here and nowhere else: the
  // provider is one this fixture defines, pointed at a loopback server, so the request that proves the model can
  // call a tool is answered by this test rather than by anybody's paid service.
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({ path: req.url, authorization: req.headers.authorization ?? null, model: parsed.model });
      // The challenge comes back through the one tool the canary exposes, which is what a pass means.
      const seen = /[0-9a-f]{32}/.exec(JSON.stringify(parsed.messages))?.[0];
      const base = { id: "x", object: "chat.completion.chunk", created: 0, model: parsed.model };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "kiln_preflight", arguments: JSON.stringify({ challenge: seen }) } }] },
              finish_reason: null,
            },
          ],
        })}\n\n`
      );
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const p = project({ ignored: true, models: false });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    writeFileSync(
      join(p.agentDir, "models.json"),
      JSON.stringify({
        providers: {
          acme: {
            baseUrl,
            api: "openai-completions",
            // ⚠️ A NAME, NOT A KEY: this is how Pi is told where the credential is, and it is also what setup
            // declares to Kiln's credential table.
            apiKey: "$ACME_SETUP_KEY",
            models: [{ id: "acme-model", name: "Acme Model", contextWindow: 128000, maxTokens: 4096, reasoning: false }],
          },
        },
      })
    );

    // Without the declaration, the provider has no contract Kiln knows, and setup refuses rather than inventing one.
    const undeclared = await setup(p, [], {
      pick: ["--provider", "acme", "--model", "acme-model", "--thinking", "off"],
      env: { ACME_SETUP_KEY: "acme-setup-KEY-7b2f" },
      canary: null,
      liveCheck: "approve",
    });
    assert.equal(undeclared.code, EXIT.CREDENTIALS, undeclared.printed.join("\n"));
    assert.deepEqual(requests, [], "a provider with no contract was contacted");

    // ⚠️ AND THE NEXT RUN RESUMES, because the refused one left a journal — which is the operator's real path
    // here: the run stopped, they supply what it asked for, and continue.
    const o = await setup(p, ["--credential-var", "ACME_SETUP_KEY", "--resume"], {
      pick: ["--provider", "acme", "--model", "acme-model", "--thinking", "off"],
      env: { ACME_SETUP_KEY: "acme-setup-KEY-7b2f" },
      canary: null,
      liveCheck: "approve",
    });
    assert.equal(o.code, EXIT.OK, o.printed.join("\n"));
    assert.equal(requests.length, 1, `the canary made ${requests.length} requests`);
    assert.equal(requests[0].model, "acme-model");

    // ⚠️ THE RECORD DESCRIBES THIS ENDPOINT, AND CARRIES NO CREDENTIAL.
    const record = JSON.parse(readFileSync(recordPath(p), "utf-8"));
    assert.equal(record.result.outcome, "passed");
    assert.equal(record.key.endpointIdentity.hostname, "127.0.0.1");
    const written = `${readFileSync(recordPath(p), "utf-8")}${readFileSync(join(p.dir, ".pi", "settings.json"), "utf-8")}`;
    assert.equal(written.includes("acme-setup-KEY-7b2f"), false, "a written file carries the key");
    assert.equal(written.includes("ACME_SETUP_KEY"), false, "a written file carries the credential variable's name");

    // And the next run reuses it: no second request to the provider.
    const again = await setup(p, ["--credential-var", "ACME_SETUP_KEY"], {
      pick: [],
      env: { ACME_SETUP_KEY: "acme-setup-KEY-7b2f" },
      canary: null,
      liveCheck: null,
    });
    assert.equal(again.code, EXIT.OK, again.printed.join("\n"));
    assert.equal(requests.length, 1, "a recorded check was run again");
  } finally {
    server.close();
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0116 a project set up with a custom provider starts, and refuses by name without its key", async () => {
  // ⚠️ **BOTH COMMANDS FOR REAL, AGAINST TSK-0062's FIXTURE.** Setup declares the variable and runs the real canary
  // against the loopback provider; the real `bin/start-kiln.mjs`, with its real launch checks and only its supervisor
  // replaced by a recorder, then has to find that declaration on its own. Nothing billable exists to reach.
  const { FIXTURE_KEY, FIXTURE_KEY_VAR, FIXTURE_MODEL, FIXTURE_PROVIDER, modelsJson, startProviderFixture } = await import("./helpers/provider-fixture.mjs");
  const { consentLocation, readConsent } = await import("../lib/consent-record.mjs");
  const echo = (request) => ({ toolCalls: [{ name: "kiln_preflight", arguments: { challenge: /[0-9a-f]{32}/.exec(JSON.stringify(request.messages))?.[0] ?? "absent" } }] });
  const fixture = await startProviderFixture({ script: [echo] });
  const p = project({ ignored: true, models: false });
  const launch = (env) => {
    const r = spawnSync(process.execPath, [join(ROOT, "test", "fixtures", "start-kiln", "capture-launch.mjs")], {
      env: { ...process.env, PLANNING_CONTENT_DIR: p.contentRoot, PI_CODING_AGENT_DIR: p.agentDir, KILN_CAPTURE_LAUNCH: "1", KILN_CAPTURE_REAL_CHECKS: "1", ...env },
      encoding: "utf-8",
      cwd: ROOT,
    });
    const line = `${r.stdout}`.split("\n").find((l) => l.startsWith("KILN_LAUNCH "));
    return { status: r.status, launch: line ? JSON.parse(line.slice("KILN_LAUNCH ".length)) : null, stdout: `${r.stdout}`, stderr: `${r.stderr}` };
  };
  const pick = ["--provider", FIXTURE_PROVIDER, "--model", FIXTURE_MODEL, "--thinking", "off"];
  const keyed = { [FIXTURE_KEY_VAR]: FIXTURE_KEY };
  const savedKey = process.env[FIXTURE_KEY_VAR];
  delete process.env[FIXTURE_KEY_VAR];
  try {
    writeFileSync(join(p.agentDir, "models.json"), JSON.stringify(modelsJson(fixture.url)));
    const o = await setup(p, ["--credential-var", FIXTURE_KEY_VAR], { pick, env: keyed, canary: null, liveCheck: "approve" });
    assert.equal(o.code, EXIT.OK, o.printed.concat(o.warned).join("\n"));
    assert.equal(fixture.requests.length, 1, `setup's canary made ${fixture.requests.length} requests`);

    // ⚠️ THE NAME IS THIS HOST'S, ON THE GRANT, AND NOWHERE COMMITTED.
    const consent = readConsent(consentLocation({ projectRoot: p.dir }));
    assert.equal(consent.record?.modelUse?.credentialVar, FIXTURE_KEY_VAR, `the declaration was not remembered: ${JSON.stringify(consent)}`);
    for (const committed of [join(p.dir, ".pi", "settings.json"), join(p.dir, ".pi", "kiln.json")])
      assert.equal(readFileSync(committed, "utf-8").includes(FIXTURE_KEY_VAR), false, `${committed} carries the variable's name`);

    // A later setup run is not told again, and reuses the record rather than asking the provider.
    const again = await setup(p, [], { pick: [], env: keyed, canary: null, liveCheck: null });
    assert.equal(again.code, EXIT.OK, again.printed.concat(again.warned).join("\n"));
    assert.equal(fixture.requests.length, 1, "the rerun asked the provider again");

    // ⚠️ THE LAUNCH: the project's own selection, proved by setup's record, and Pi held to it.
    const started = launch(keyed);
    assert.ok(started.launch, `the custom-provider project did not start: ${started.stdout}${started.stderr}`);
    assert.deepEqual(started.launch.agentArgs.slice(-6), ["--provider", FIXTURE_PROVIDER, "--model", FIXTURE_MODEL, "--thinking", "off"]);
    assert.match(started.stdout, /compatibility proved by this computer's record/);
    assert.equal(fixture.requests.length, 1, "launch asked the provider for something already proved");

    // ⚠️ THE CONTROL: the same project with the declared variable absent refuses, names the selection, starts nothing.
    const refused = launch({ [FIXTURE_KEY_VAR]: "" });
    assert.equal(refused.launch, null, `launched without its key: ${refused.stdout}`);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, new RegExp(`\\[kiln\\] No authentication is configured for ${FIXTURE_PROVIDER} ${FIXTURE_MODEL}`));
    assert.equal(fixture.requests.length, 1, "a refused launch contacted the provider");
  } finally {
    if (savedKey === undefined) delete process.env[FIXTURE_KEY_VAR];
    else process.env[FIXTURE_KEY_VAR] = savedKey;
    await fixture.close();
    rmSync(p.root, { recursive: true, force: true });
  }
});

/**
 * A project whose Pi knows only TSK-0062's fixture, and the fixture answering the canary. `apiKey` is what Pi's
 * `models.json` says the key is, so a case can make Pi's route differ from the declared one.
 */
async function fixtureProject({ apiKey } = {}) {
  const fx = await import("./helpers/provider-fixture.mjs");
  const echo = (request) => ({ toolCalls: [{ name: "kiln_preflight", arguments: { challenge: /[0-9a-f]{32}/.exec(JSON.stringify(request.messages))?.[0] ?? "absent" } }] });
  const fixture = await fx.startProviderFixture({ script: [echo] });
  const p = project({ ignored: true, models: false });
  const models = (key) => {
    const config = fx.modelsJson(fixture.url);
    if (key !== undefined) config.providers[fx.FIXTURE_PROVIDER].apiKey = key;
    writeFileSync(join(p.agentDir, "models.json"), JSON.stringify(config));
  };
  models(apiKey);
  const pick = ["--provider", fx.FIXTURE_PROVIDER, "--model", fx.FIXTURE_MODEL, "--thinking", "off"];
  const close = async () => {
    await fixture.close();
    rmSync(p.root, { recursive: true, force: true });
  };
  return { fx, fixture, p, models, pick, close };
}

test("⚠️ TSK-0072 F11 the credential variable is disclosed before confirmation, and a new one is confirmed again", async () => {
  const { fx, fixture, p, pick, close } = await fixtureProject({ apiKey: "$KILN_FIXTURE_OTHER_KEY" });
  const env = { [fx.FIXTURE_KEY_VAR]: fx.FIXTURE_KEY, KILN_FIXTURE_OTHER_KEY: fx.FIXTURE_KEY };
  const confirmations = (o) => o.seen.asks.filter((q) => /^Use this model for this project/.test(q));
  try {
    const first = await setup(p, ["--credential-var", "KILN_FIXTURE_OTHER_KEY"], { pick, env, canary: null, liveCheck: "approve" });
    assert.equal(first.code, EXIT.OK, first.printed.concat(first.warned).join("\n"));
    assert.equal(confirmations(first).length, 1);
    assert.match(confirmations(first)[0], /Key from: the environment variable KILN_FIXTURE_OTHER_KEY/, "the variable was not disclosed before confirmation");

    // The same model through a different variable: the old grant goes, and the new name is asked about by name.
    const changed = await setup(p, ["--credential-var", fx.FIXTURE_KEY_VAR], { pick: [], env, canary: null, liveCheck: "approve", answers: [[/^Use this model/i, "no"]] });
    assert.equal(confirmations(changed).length, 1, "a new credential variable was used without confirmation");
    assert.match(confirmations(changed)[0], new RegExp(`Key from: the environment variable ${fx.FIXTURE_KEY_VAR}`));
    assert.notEqual(changed.code, EXIT.OK, "a declined change left the project ready");
    const { consentLocation, readConsent } = await import("../lib/consent-record.mjs");
    const use = readConsent(consentLocation({ projectRoot: p.dir })).record?.modelUse ?? null;
    assert.ok(use === null || use.granted === false, `the grant for the old variable survived the change: ${JSON.stringify(use)}`);
    assert.equal(fixture.requests.length, 1, "the declined change contacted the provider");
  } finally {
    await close();
  }
});

test("⚠️ TSK-0072 F12 a declaration this computer cannot keep refuses before the live check", async () => {
  const { fx, fixture, p, pick, close } = await fixtureProject();
  const env = { [fx.FIXTURE_KEY_VAR]: fx.FIXTURE_KEY };
  try {
    const first = await setup(p, ["--credential-var", fx.FIXTURE_KEY_VAR], { pick, env, canary: null, liveCheck: "approve" });
    assert.equal(first.code, EXIT.OK, first.printed.concat(first.warned).join("\n"));
    assert.equal(fixture.requests.length, 1);

    // ⚠️ THEN GIT TRACKS THE CONSENT RECORD, which is never trusted or written again: the model is confirmed for this
    // run only, and the grant with its variable cannot be kept. The compatibility record still matches, so without
    // this refusal setup would call the project ready although no launch could find the declaration.
    execFileSync("git", ["add", "-f", ".pi/runtime/consent.json"], { cwd: p.dir });
    const o = await setup(p, ["--credential-var", fx.FIXTURE_KEY_VAR], { pick: [], env, canary: null, liveCheck: "approve" });
    const all = o.printed.concat(o.warned).join("\n");
    assert.equal(o.code, EXIT.CREDENTIALS, all);
    assert.ok(all.includes(`The variable ${fx.FIXTURE_KEY_VAR} for ${fx.FIXTURE_PROVIDER} ${fx.FIXTURE_MODEL} was not remembered on this computer`), all);
    assert.equal(fixture.requests.length, 1, "a declaration launch cannot find was proved with a billable request");
  } finally {
    await close();
  }
});

test("⚠️ TSK-0072 F13 the declared variable must be the one Pi's models.json reads, at setup and at launch", async () => {
  const LITERAL = "kiln-fixture-LITERAL-KEY-9c41";
  const { fx, fixture, p, models, pick, close } = await fixtureProject({ apiKey: "$KILN_FIXTURE_OTHER_KEY" });
  const env = { [fx.FIXTURE_KEY_VAR]: fx.FIXTURE_KEY, KILN_FIXTURE_OTHER_KEY: fx.FIXTURE_KEY };
  const launch = (extra = {}) =>
    spawnSync(process.execPath, [join(ROOT, "test", "fixtures", "start-kiln", "capture-launch.mjs")], {
      env: { ...process.env, PLANNING_CONTENT_DIR: p.contentRoot, PI_CODING_AGENT_DIR: p.agentDir, KILN_CAPTURE_LAUNCH: "1", KILN_CAPTURE_REAL_CHECKS: "1", ...env, ...extra },
      encoding: "utf-8",
      cwd: ROOT,
    });
  try {
    // Setup: Pi reads KILN_FIXTURE_OTHER_KEY, the declaration names another. Refused before anything is sent.
    const mismatched = await setup(p, ["--credential-var", fx.FIXTURE_KEY_VAR], { pick, env, canary: null, liveCheck: "approve" });
    assert.equal(mismatched.code, EXIT.CREDENTIALS, mismatched.printed.concat(mismatched.warned).join("\n"));
    assert.ok(mismatched.warned.join("\n").includes(`key from ${fx.FIXTURE_KEY_VAR}, the variable declared for it (different-variable)`), mismatched.warned.join("\n"));
    assert.equal(fixture.requests.length, 0);

    // Made to agree, setup completes; then Pi's route is changed under a proved project, and launch refuses.
    models(undefined);
    const proved = await setup(p, ["--credential-var", fx.FIXTURE_KEY_VAR, "--resume"], { pick, env, canary: null, liveCheck: "approve" });
    assert.equal(proved.code, EXIT.OK, proved.printed.concat(proved.warned).join("\n"));
    assert.equal(launch().status, 0, "the agreeing project did not start");

    for (const [key, route] of [["$KILN_FIXTURE_OTHER_KEY", "different-variable"], [LITERAL, "not-a-variable"]]) {
      models(key);
      const r = launch();
      assert.equal(r.status, 2, `${route}: ${r.stdout}${r.stderr}`);
      assert.equal(`${r.stdout}`.includes("KILN_LAUNCH "), false, `${route}: the supervisor was reached`);
      assert.ok(`${r.stderr}`.includes(`does not read its key from the variable declared for it on this computer (${route})`), `${r.stderr}`);
      assert.equal(`${r.stdout}${r.stderr}`.includes(LITERAL), false, "the refusal quoted models.json");
    }
    assert.equal(fixture.requests.length, 1, "a refused launch contacted the provider");
  } finally {
    await close();
  }
});

test("⚠️ D22 a request Kiln cannot digest safely is proved only with a declared identity, and the record carries it", async () => {
  // ⚠️ **THE CONFIGURATION THAT HAS NO KEY WITHOUT A NAME.** Sampling parameters override named request
  // fields, so they are part of what a proof is about — and they are unbounded operator-authored values, which
  // must not be hashed or persisted. The request profile therefore refuses to be cached until the operator
  // declares a non-secret label for it. Until then there is no compatibility key: nothing is sent, nothing is
  // charged, and the run reports not ready. This is that whole path through the real command, against a loopback
  // endpoint, with the real canary.
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({
        path: req.url,
        model: parsed.model,
        temperature: parsed.temperature ?? null,
        tools: (parsed.tools ?? []).map((t) => t.function?.name ?? t.name),
        stream: parsed.stream ?? null,
      });
      const seen = /[0-9a-f]{32}/.exec(JSON.stringify(parsed.messages))?.[0];
      const base = { id: "x", object: "chat.completion.chunk", created: 0, model: parsed.model };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "kiln_preflight", arguments: JSON.stringify({ challenge: seen }) } }] },
              finish_reason: null,
            },
          ],
        })}\n\n`
      );
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const p = project({ ignored: true, models: false });
  const declare = ["--credential-var", "ACME_SETUP_KEY"];
  const flags = { pick: ["--provider", "acme", "--model", "acme-model", "--thinking", "off"], env: { ACME_SETUP_KEY: "acme-setup-KEY-7b2f" }, canary: null, liveCheck: "approve" };
  try {
    writeFileSync(
      join(p.agentDir, "models.json"),
      JSON.stringify({
        providers: {
          acme: {
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            api: "openai-completions",
            apiKey: "$ACME_SETUP_KEY",
            models: [
              {
                id: "acme-model",
                name: "Acme Model",
                contextWindow: 128000,
                maxTokens: 4096,
                reasoning: false,
                // ⚠️ THE POINT OF THE FIXTURE: a value that changes the request and cannot go in the key.
                samplingParams: { temperature: 0.2 },
              },
            ],
          },
        },
      })
    );

    const undeclared = await setup(p, declare, flags);
    assert.notEqual(undeclared.code, EXIT.OK, undeclared.printed.join("\n"));
    const said = undeclared.printed.concat(undeclared.warned).join("\n");
    assert.ok(/non-secret identity|cannot be identified/.test(said), `the run does not say what is missing: ${said}`);
    assert.deepEqual(requests, [], "a model with no compatibility key was still checked live");

    // ⚠️ WITH THE LABEL, the key exists: the canary runs once, and the record carries the declared name
    // rather than anything derived from the configuration it stands for.
    const declared = await setup(p, [...declare, "--request-identity", "acme-gateway-v3", "--resume"], flags);
    assert.equal(declared.code, EXIT.OK, declared.printed.concat(declared.warned).join("\n"));
    assert.equal(requests.length, 1, `the canary made ${requests.length} requests`);
    // ⚠️ **FIELD BY FIELD, BECAUSE "IT PASSED" IS NOT THE CLAIM.** What the record vouches for is this
    // model, at this endpoint, with this project's sampling parameters and Kiln's one preflight tool. A child
    // that reached the endpoint with anything else would have proved a request nobody makes.
    assert.deepEqual(
      { model: requests[0].model, temperature: requests[0].temperature, tools: requests[0].tools },
      { model: "acme-model", temperature: 0.2, tools: ["kiln_preflight"] },
      `the canary sent a different request: ${JSON.stringify(requests[0])}`
    );
    // The credential half is refused by the canary rather than carried: apiKey, headers and authHeader in a
    // supplied provider configuration are each rejected, measured in test/pi-provider-canary.test.mjs.

    const record = JSON.parse(readFileSync(recordPath(p), "utf-8"));
    assert.deepEqual(record.key.effectiveRequestProfile.unboundedInputs, { categories: ["samplingParams"], declaredIdentity: "acme-gateway-v3" });
    assert.equal(readFileSync(recordPath(p), "utf-8").includes("temperature"), false, "the record carries the configuration's own values");

    // ⚠️ **AND THE READ-BACK USED THE SAME LABEL.** A read-back that recomputed the key without it would
    // find a record describing something else and report a run that actually succeeded as not proved.
    assert.ok(
      declared.printed.some((l) => /^compatibility recorded and read back/.test(l)),
      declared.printed.join("\n")
    );

    // ⚠️ **THE DECLARATION IS THE PROJECT'S, NOT THAT COMMAND LINE'S.** It is committed to `.pi/kiln.json`,
    // so the next run — which names no identity at all — recomputes the same key and reuses the record
    // instead of asking the provider again.
    const record2 = JSON.parse(readFileSync(join(p.dir, ".pi", "kiln.json"), "utf-8"));
    assert.deepEqual(record2.declaredIdentities, { request: "acme-gateway-v3" });
    const reused = await setup(p, declare, { ...flags, liveCheck: null });
    assert.equal(reused.code, EXIT.OK, reused.printed.concat(reused.warned).join("\n"));
    assert.equal(requests.length, 1, "a recorded check was run again");

    // A label that changes is a different request: the next run does not reuse the record.
    const changed = await setup(p, [...declare, "--request-identity", "acme-gateway-v4"], { ...flags, liveCheck: "deny" });
    assert.notEqual(changed.code, EXIT.OK, changed.printed.join("\n"));
    assert.equal(requests.length, 1, "a declined check was sent anyway");
  } finally {
    server.close();
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ no refusal repeats the value it refused, because the value may be the credential", async () => {
  // ⚠️ **AN OPERATOR WHO PASTES A KEY INTO THE WRONG OPTION HAS ALREADY PUT IT IN THEIR SHELL HISTORY.**
  // Repeating it in a refusal spreads it to a terminal, a log and a CI transcript, so every option with a fixed
  // set of answers says what it accepts instead of what it got. The sentinel is shaped like a real key so that a
  // single leak anywhere in what the command printed is visible.
  const SENTINEL = "sk-live-Ax7Kq2ZmT4pR9wLd";
  const { parseArgs, usage } = await import("../bin/setup.mjs");
  const options = [
    "--trust",
    "--inspect",
    "--model-use",
    "--research",
    "--live-model-check",
    "--local-state",
    "--credential-var",
    "--endpoint-identity",
  ];
  for (const flag of options) {
    const parsed = parseArgs([flag, SENTINEL]);
    assert.ok(parsed.error, `${flag} accepted a credential-shaped value`);
    assert.equal(parsed.error.includes(SENTINEL), false, `${flag} repeated what it refused: ${parsed.error}`);
  }
  // ⚠️ AND THROUGH THE REAL COMMAND, where the refusal is printed with the whole help text after it.
  const p = project({ ignored: true });
  try {
    const o = await setup(p, ["--inspect", SENTINEL]);
    assert.equal(o.code, EXIT.ARGUMENTS, o.warned.join("\n"));
    const everything = o.printed.concat(o.warned).concat(usage()).join("\n");
    assert.equal(everything.includes(SENTINEL), false, `the refused value reached the operator's terminal: ${everything}`);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }

  // ⚠️ **A LABEL IS DIFFERENT, AND ITS LIMIT IS DECLARED.** `--request-identity` is written into the project
  // record and the compatibility key on purpose, so Kiln cannot tell a label from a secret and does not pretend
  // to: what it does is bound the shape and refuse without echoing.
  const tooLong = parseArgs(["--request-identity", "x".repeat(200)]);
  assert.ok(tooLong.error && !tooLong.error.includes("x".repeat(200)), tooLong.error);
  assert.ok(/COMMITTED to this project's record/.test(tooLong.error), `the refusal does not say where it goes: ${tooLong.error}`);
});

test("⚠️ a declared identity in the shape of a key is refused before anything is printed, written or committed", async () => {
  // ⚠️ **THE ONE MISTAKE WORTH CATCHING IS THE COMMON ONE.** A declared identity is printed, committed to
  // `.pi/kiln.json` and written into the compatibility key, so a pasted credential there is published rather than
  // merely mistyped. What is recognised is a shape somebody issues — a prefix, a JWT, a long opaque token —
  // and a key in a shape nothing publishes still passes, which is stated as a limit rather than papered over.
  const { parseArgs } = await import("../bin/setup.mjs");
  const refused = [
    ["an issuer prefix", "--request-identity", "sk-live-0123456789"],
    ["a Tavily key", "--request-identity", "tvly-9f3a2b1c9d4e5f60"],
    ["a JWT", "--request-identity", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"],
    ["a long opaque token", "--request-identity", "AcmeGatewayRevision2024xyzAbc123456"],
    // ⚠️ A KEY DOES NOT HAVE TO BE THE WHOLE VALUE: pasted beside a word, it is still pasted.
    ["a key beside a word", "--request-identity", "acme sk-live-0123456789"],
    ["a header pasted whole", "--request-identity", "Bearer 0123456789abcdef"],
    ["a key routed as a path segment", "--endpoint-identity", "https://gate.example.com/v1/sk-live-0123456789abcdef/chat"],
  ];
  for (const [what, flag, value] of refused) {
    const parsed = parseArgs([flag, value]);
    assert.ok(parsed.error, `${what} was accepted as a declared identity`);
    assert.equal(parsed.error.includes(value), false, `${what}: the refusal repeated it: ${parsed.error}`);
  }
  // And a label that names a configuration is still a label.
  for (const [flag, value] of [
    ["--request-identity", "acme-gateway-v3"],
    ["--request-identity", "house style v2"],
    ["--endpoint-identity", "https://gate.example.com/v1"],
  ])
    assert.equal(parseArgs([flag, value]).error, undefined, `${value} was refused`);

  // ⚠️ **AND THROUGH THE REAL COMMAND, NOTHING IS WRITTEN.** The check is an argument check, so it happens
  // before the install, the scaffold and the record it would otherwise have been committed to.
  const p = project({ ignored: true });
  try {
    const before = tree(p.dir);
    const o = await setup(p, ["--request-identity", "sk-live-0123456789"]);
    assert.equal(o.code, EXIT.ARGUMENTS, o.warned.join("\n"));
    assert.equal(o.seen.installs, 0, "the bootstrap ran for a run that could not start");
    assert.deepEqual(tree(p.dir), before, "a refused argument changed the project");
    assert.equal(existsSync(join(p.dir, ".pi")), false, "runtime state was written for a refused argument");
    assert.equal(o.printed.concat(o.warned).join("\n").includes("sk-live-0123456789"), false, "the value reached the terminal");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ a fresh non-interactive run confirms the model it names, and confirms nothing it did not", async () => {
  // ⚠️ **THE GAP TSK-0061 OWNS (EVD-0128).** A model is used only after an explicit confirmation, and a run
  // with nobody to ask cannot get one — so a fresh non-interactive setup could never finish. The answer is the
  // same one, given in advance, and it is an answer to the BILLING question only: naming a model is still
  // --provider and --model, and this flag confirms what they name rather than picking anything.
  for (const [what, argv, expected] of [
    ["nothing to confirm it", ["--non-interactive", "--inspect", "approve", ...PICKED], EXIT.SELECTION],
    ["nothing to confirm", ["--non-interactive", "--inspect", "approve", "--model-use", "approve"], EXIT.SELECTION],
  ]) {
    const p = project({ ignored: true });
    try {
      const o = await setup(p, argv, { pick: [], liveCheck: "approve" });
      assert.equal(o.code, expected, `${what}: ${o.printed.concat(o.warned).join("\n")}`);
      assert.deepEqual(o.seen.asks, [], `${what}: a non-interactive run asked something`);
      // The inspection was allowed on the command line and is recorded; the model was not, and is not.
      const consent = existsSync(join(p.dir, ".pi", "runtime", "consent.json")) ? consentOf(p) : {};
      assert.notEqual(consent.modelUse?.granted, true, `${what}: a model nobody confirmed was granted`);
      // ⚠️ AND THE REFUSAL SAYS WHAT WOULD MAKE IT WORK, which is the only part of it an operator can act on.
      const said = o.warned.join("\n");
      assert.ok(/--model-use approve/.test(said), `${what}: the refusal does not name the flag: ${said}`);
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  }

  // ⚠️ AND WITH BOTH HALVES: the model named, and its use confirmed. Nothing is asked, and the project is ready.
  const p = project({ ignored: true });
  try {
    const o = await setup(p, ["--non-interactive", "--inspect", "approve", "--model-use", "approve"], { liveCheck: "approve" });
    assert.equal(o.code, EXIT.OK, o.printed.concat(o.warned).join("\n"));
    assert.deepEqual(o.seen.asks, [], "a non-interactive run asked something");

    // ⚠️ **WHAT WAS AUTHORISED IS ON THE SCREEN.** The prompt is where the billing is disclosed, so a flag
    // that skipped the words would authorise ongoing charges with nothing saying so in the terminal or the log.
    // ⚠⚠ THE WORDS BEFORE THE ANSWER: the prompt is where the billing is disclosed, so a flag that applied
    // the answer first, or printed only its own outcome, would authorise ongoing charges with nothing saying so.
    const disclosure = o.printed.findIndex((l) => /may consume billable tokens or provider quota/.test(l));
    const outcome = o.printed.findIndex((l) => /confirmed by --model-use approve/.test(l));
    assert.ok(disclosure >= 0, `the disclosure was not printed: ${o.printed.join("\n")}`);
    assert.ok(outcome > disclosure, `the answer was applied before what it authorises was said: ${o.printed.join("\n")}`);
    assert.ok(
      o.printed.some((l) => /Confirming authorises that ongoing use on this computer/.test(l)),
      o.printed.join("\n")
    );

    const settings = settingsOf(p);
    assert.equal(settings.defaultModel, "gpt-4o");
    assert.equal(consentOf(p).modelUse.granted, true, "the model-use grant was not recorded");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }

  // ⚠️ AND DENY IS AN ANSWER TOO: nothing is granted, nothing is committed, and the scaffold is left valid.
  const denied = project({ ignored: true });
  try {
    const o = await setup(denied, ["--non-interactive", "--inspect", "approve", "--model-use", "deny"], { liveCheck: "approve" });
    assert.notEqual(o.code, EXIT.OK, o.printed.join("\n"));
    assert.deepEqual(o.seen.asks, [], "a non-interactive run asked something");
    // ⚠️ AND A DENIAL READS THE SAME WORDS FIRST: what is being refused has to be as clear as what is agreed.
    const saidNo = o.printed.join("\n");
    assert.ok(/may consume billable tokens or provider quota/.test(saidNo), `the disclosure was not printed: ${saidNo}`);
    assert.ok(/declined by --model-use deny/.test(saidNo), saidNo);
    const consent = existsSync(join(denied.dir, ".pi", "runtime", "consent.json")) ? consentOf(denied) : {};
    assert.notEqual(consent.modelUse?.granted, true, "a denial granted the model");
    assert.equal(settingsOf(denied).defaultModel, undefined, "a denied model was committed anyway");
    assert.equal(existsSync(join(denied.dir, "planning-content", "project.yaml")), true, "the scaffold did not survive");
  } finally {
    rmSync(denied.root, { recursive: true, force: true });
  }
});

/** Stops the launcher after the checks it is given, without starting anything. */
class LaunchRefusalStub extends Error {
  constructor(message) {
    super(message);
    this.name = "LaunchRefusal";
    this.reason = "stub";
    this.remedies = [];
  }
}

test("⚠️ a project proved with a declared identity passes the launch checks, and does not without it", async () => {
  // ⚠️ **THE KEY IS RECOMPUTED AT LAUNCH, NOT READ BACK.** So a declaration that lived only on setup's command
  // line would leave every later start computing a different key and refusing the record setup had just written.
  // This runs the launcher's own checks — the real `checkLaunch`, with only the supervisor stubbed — against
  // a project setup proved, and then removes the declaration from the committed record to show it was load-bearing.
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed.model);
      const seen = /[0-9a-f]{32}/.exec(JSON.stringify(parsed.messages))?.[0];
      const base = { id: "x", object: "chat.completion.chunk", created: 0, model: parsed.model };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "kiln_preflight", arguments: JSON.stringify({ challenge: seen }) } }] },
              finish_reason: null,
            },
          ],
        })}\n\n`
      );
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const p = project({ ignored: true, models: false });
  const saved = { content: process.env.PLANNING_CONTENT_DIR, agent: process.env.PI_CODING_AGENT_DIR, key: process.env.ACME_SETUP_KEY };
  try {
    writeFileSync(
      join(p.agentDir, "models.json"),
      JSON.stringify({
        providers: {
          acme: {
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            api: "openai-completions",
            apiKey: "$ACME_SETUP_KEY",
            models: [
              { id: "acme-model", name: "Acme Model", contextWindow: 128000, maxTokens: 4096, reasoning: false, samplingParams: { temperature: 0.2 } },
            ],
          },
        },
      })
    );
    const proved = await setup(p, ["--credential-var", "ACME_SETUP_KEY", "--request-identity", "acme-gateway-v3"], {
      pick: ["--provider", "acme", "--model", "acme-model", "--thinking", "off"],
      env: { ACME_SETUP_KEY: "acme-setup-KEY-7b2f" },
      canary: null,
      liveCheck: "approve",
    });
    assert.equal(proved.code, EXIT.OK, proved.printed.concat(proved.warned).join("\n"));
    assert.equal(requests.length, 1, `setup made ${requests.length} requests`);

    /**
     * ⚠️ **THE LAUNCH CHECKS THEMSELVES, RECOMPUTING THE KEY.** This is what the launcher calls, given what
     * the launcher gives it: the project's committed declarations. The record setup wrote matches, so the checks
     * pass without asking the provider anything.
     *
     * ⚠️ **AND THIS CONTROL STOPS AT THE CHECKS, NOT AT A STARTED PROCESS.** Starting a custom-provider project
     * is ACC-0116's, measured through the real command in its own case above; here the declaration is passed in.
     */
    const { checkLaunch } = await import("../lib/launch-checks.mjs");
    const { consentLocation } = await import("../lib/consent-record.mjs");
    const { committedDeclarations } = await import("../lib/local-state.mjs");
    process.env.PI_CODING_AGENT_DIR = p.agentDir;
    process.env.ACME_SETUP_KEY = "acme-setup-KEY-7b2f";
    const declared = committedDeclarations(p.dir);
    assert.deepEqual(declared, { requestIdentity: "acme-gateway-v3" }, "the declaration did not survive as the project's");

    const launchable = await checkLaunch({
      projectRoot: p.dir,
      location: consentLocation({ projectRoot: p.dir }),
      declared,
      custom: { id: "acme", apiKey: "$ACME_SETUP_KEY" },
      canary: async () => { throw new Error("the launch checks asked the provider for something already proved"); },
    });
    assert.equal(launchable.proof, "record", `launch did not reuse the record: ${JSON.stringify(launchable)}`);
    assert.equal(requests.length, 1, "launch re-ran a check the record already proved");

    // ⚠️ **AND WITHOUT THE DECLARATION THERE IS NO KEY AT ALL**, so launch refuses rather than starting on a
    // proof it cannot match. This is the same project, one input removed.
    await assert.rejects(
      () =>
        checkLaunch({
          projectRoot: p.dir,
          location: consentLocation({ projectRoot: p.dir }),
          declared: {},
          custom: { id: "acme", apiKey: "$ACME_SETUP_KEY" },
          canary: async () => { throw new Error("a request was sent for a key that cannot be computed"); },
        }),
      (e) => e.name === "LaunchRefusal" && /identit|cannot be cached|uncacheable/i.test(e.message),
      "launch started a project whose key it cannot compute"
    );

    // ⚠️ **AND THE LAUNCHER IS WHAT SUPPLIES THEM.** Its own checks are the ones above; what is asserted here
    // is the wiring — that `bin/start-kiln.mjs` hands the project's committed declarations to those checks
    // rather than nothing, which is the defect this control exists for.
    const { main: startKiln } = await import("../bin/start-kiln.mjs");
    process.env.PLANNING_CONTENT_DIR = p.contentRoot;
    let handed = "never called";
    await startKiln([], {
      checkLaunch: async (opts) => {
        handed = opts.declared;
        throw new LaunchRefusalStub("stopping before anything starts");
      },
      runSupervisor: async () => ({ code: 0 }),
    }).catch(() => {});
    assert.deepEqual(handed, { requestIdentity: "acme-gateway-v3" }, `the launcher passed ${JSON.stringify(handed)}`);
  } finally {
    for (const [k, v] of Object.entries({ PLANNING_CONTENT_DIR: saved.content, PI_CODING_AGENT_DIR: saved.agent, ACME_SETUP_KEY: saved.key }))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    server.close();
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ D22 a built-in provider with unbounded configuration fails closed: the boundary is declared, not worked around", async () => {
  // ⚠️ **WHAT DECLARING AN IDENTITY DOES NOT FIX.** The canary proves a request by making it in an isolated
  // agent directory. A CUSTOM provider's non-credential configuration crosses into that directory, so the child
  // makes the same request this project makes. A BUILT-IN provider's does not: the child resolves the model from
  // Pi's own catalogue, so an operator's `samplingParams` for `openai gpt-4o` never reach it. The parent's key
  // then describes a request the child did not make, and this is what must happen next — a refusal, with
  // nothing recorded — rather than a record vouching for a request nobody made.
  const { computeCompatibilityKey, proofProblem } = await import("../lib/compatibility-record.mjs");
  const { canaryRequest } = await import("../lib/launch-checks.mjs");

  const selection = { provider: "openai", model: "gpt-4o", thinkingLevel: "off" };
  const asConfigured = {
    provider: "openai",
    id: "gpt-4o",
    api: "openai-completions",
    baseUrl: "https://api.example.test/v1",
    reasoning: false,
    samplingParams: { temperature: 0.2 },
  };
  // The parent's key: the request as this project configures it, named by the declared identity.
  const key = computeCompatibilityKey({
    selection,
    model: asConfigured,
    piVersion: "0.84.4",
    declared: { requestIdentity: "house-style-v2" },
    effectiveBaseUrl: asConfigured.baseUrl,
  });
  assert.deepEqual(key.effectiveRequestProfile.unboundedInputs, { categories: ["samplingParams"], declaredIdentity: "house-style-v2" });

  // What the child computes from the catalogue's model, which carries none of that configuration.
  const inTheChild = { ...asConfigured, samplingParams: undefined };
  assert.throws(
    () => computeCompatibilityKey({ selection, model: inTheChild, piVersion: "0.84.4", declared: { requestIdentity: "house-style-v2" }, effectiveBaseUrl: asConfigured.baseUrl }),
    (e) => e.name === "CompatibilityKeyRefusal",
    "the child computed a key for a request it was not given"
  );

  // ⚠️ SO THE CHECK CANNOT PASS, AND SAYS SO. A child that reports no key is not a proof of anything.
  assert.deepEqual(proofProblem(key, { observed: { keyError: "request-profile-uncacheable" }, requests: [] }), { reason: "canary-key-unavailable" });

  // ⚠️ AND THE REASON IT CANNOT REACH THE CHILD IS STRUCTURAL, NOT AN OVERSIGHT: only a declared custom
  // provider's configuration crosses, because only that provider's credential is a declared variable name.
  const built = canaryRequest({ selection, declared: { requestIdentity: "house-style-v2" } }, { authSource: "environment", agentDir: "/nowhere", model: asConfigured }, null);
  assert.equal(Object.hasOwn(built, "customProviderConfig"), false, "a built-in provider's configuration crossed into the canary");
  assert.deepEqual(built.declared, { requestIdentity: "house-style-v2" });
});

test("⚠️ ACC-0084 each refusal class exits with its own published code, observed through the command", async () => {
  // ⚠️ **THE MAPPING IS ONLY WORTH HAVING IF IT IS WHAT RUNS.** `exitFor` is checked against the table
  // elsewhere; this drives the real command into each class and compares what it RETURNS with what `--help`
  // publishes. A table that agrees with itself and disagrees with the command is the failure this exists to catch.
  const { EXIT_MEANING, usage } = await import("../bin/setup.mjs");
  const help = usage();
  const observed = new Map();

  const run = async (what, expected, make) => {
    const p = project({ ignored: true });
    try {
      const o = await make(p);
      assert.equal(o.code, expected, `${what}: expected ${expected}, got ${o.code}\n${o.printed.concat(o.warned).join("\n")}`);
      // ⚠️ WHAT THE OPERATOR IS TOLD IS PART OF THE CLASS: a code with no words is a number to guess at.
      if (expected !== EXIT.OK) assert.ok(o.warned.join("").length > 0, `${what}: refused with nothing said`);
      observed.set(what, o.code);
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  };

  await run("a value the command cannot read", EXIT.ARGUMENTS, (p) => setup(p, ["--trust", "maybe"]));
  await run("an unknown option", EXIT.ARGUMENTS, (p) => setup(p, ["--wat"]));
  await run("a credential where a variable name belongs", EXIT.ARGUMENTS, (p) => setup(p, ["--credential-var", "sk-live-0123456789"]));
  await run("an endpoint identity carrying credentials", EXIT.ARGUMENTS, (p) => setup(p, ["--endpoint-identity", "https://u:p@gate.example.com/v1"]));
  await run("a project root that does not own the content", EXIT.PATHS, (p) => setup(p, ["--project-root", join(p.root, "elsewhere")]));
  // ⚠️ THE REAL RESOLVER, held to a version this checkout does not have: the refusal is Pi's own class, and
  // the command tells "your install is not the pin" apart from "setup could not write something".
  const { resolvePinnedAgent } = await import("../lib/pi-runtime.mjs");
  await run("an install that is not the pinned runtime", EXIT.RUNTIME, (p) =>
    setup(p, [], { verifyRuntime: (_m, paths) => resolvePinnedAgent(paths.toolRoot, { version: "0.0.0-not-this-one" }) })
  );
  // ⚠️ AND THE BOOTSTRAP'S OWN CLASS, raised where the real one raises it. What a test may not do is run a
  // registry install, so the seam throws what `installDependencies` throws when the lockfile check fails.
  await run("a bootstrap that could not complete", EXIT.INSTALL, (p) =>
    setup(p, [], {
      install: () => {
        throw new SetupCommandRefusal(EXIT.INSTALL, ["npm ci did not complete.", "Nothing of the project was changed."].join("\n"));
      },
    })
  );
  await run("a project nobody trusts", EXIT.TRUST, (p) => setup(p, [], { trust: "deny" }));
  await run("a look at this computer that was refused", EXIT.CONSENT, (p) => setup(p, ["--inspect", "deny"]));
  await run("a model named but never confirmed", EXIT.SELECTION, (p) => setup(p, ["--non-interactive", "--inspect", "approve", ...PICKED], { pick: [] }));
  // ⚠️ **AUTHENTICATION IS ITS OWN CLASS, WHICH ACC-0084 NAMES.** "Choose a model" and "connect a provider
  // in Pi" are different instructions: the first can be answered with flags, the second cannot be answered by
  // this command at all. A host with nothing configured gets the second.
  // ⚠️ THE CLASSES THAT NEED THE PROJECT PUT IN A PARTICULAR STATE FIRST, each one a state an operator
  // can actually arrive in: a settings file somebody broke, a run that was interrupted, a provider Kiln has no
  // contract for, and a consent record a colleague committed.
  await run("a file setup owns that it cannot read", EXIT.SETUP, (p) => {
    mkdirSync(join(p.dir, ".pi"), { recursive: true });
    writeFileSync(join(p.dir, ".pi", "settings.json"), "{ this is not settings");
    return setup(p);
  });
  await run("a package entry that cannot be proved", EXIT.REGISTRATION, (p) => {
    // The link Kiln registers itself through, pointing somewhere that is not this checkout: the portable entry
    // is written only after it is proved to resolve to the canonical package directory, and here it cannot be.
    rmSync(join(p.dir, ".planning"), { recursive: true, force: true });
    mkdirSync(join(p.root, "not-kiln"), { recursive: true });
    symlinkSync(join(p.root, "not-kiln"), join(p.dir, ".planning"), process.platform === "win32" ? "junction" : "dir");
    return setup(p);
  });
  await run("an interrupted run nobody chose to continue", EXIT.INTERRUPTED, async (p) => {
    const first = await setup(p, ["--inspect", "deny"]);
    assert.equal(first.code, EXIT.CONSENT, first.warned.join("\n"));
    writeFileSync(join(p.dir, ".pi", "runtime", "setup-transaction.json"), JSON.stringify({
      recordVersion: 1,
      startedAt: new Date().toISOString(),
      projectRoot: p.dir,
      phases: [{ name: "trust", status: "running" }],
      resumeCommand: "node .planning/bin/setup.mjs --resume",
    }));
    return setup(p);
  });
  await run("a provider Kiln has no contract for", EXIT.CREDENTIALS, (p) => {
    writeFileSync(join(p.agentDir, "auth.json"), "{}");
    return setup(p, [], { pick: ["--provider", "kiln-local", "--model", "kiln-plain", "--thinking", "off"] });
  });
  // ⚠️ THE STATE THE RUNTIME DIRECTORY IS IN, which is its own class: what could not be protected was not
  // written. A project whose repository does not ignore the runtime paths, and nobody to ask about it.
  await run("runtime state that could not be protected", EXIT.STATE, () => {
    const bare = project();
    return setup(bare, ["--non-interactive", "--project-root", bare.dir]).finally(() => rmSync(bare.root, { recursive: true, force: true }));
  });

  // ⚠️ AND A RECOVERY THAT CANNOT BE PROVED SAFE, which is the lock's own class: the files another run left
  // are the operator's to remove, and this run says which.
  await run("a recovery that cannot be proved safe", EXIT.LOCK_RECOVERY, (p) => {
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" });
    const owner = JSON.stringify({ pid: Number(gone.stdout), hostname: hostname() });
    const lock = join(p.dir, ".planning-init.lock");
    const stale = Date.now() / 1000 - 600;
    for (const path of [lock, `${lock}.breaking`, `${lock}.breaking.reclaim`]) {
      writeFileSync(path, owner);
      utimesSync(path, stale, stale);
    }
    return setup(p);
  });

  // ⚠️ AND THE RESEARCH CLASS, WHICH NEEDS A PROJECT SOMEBODY ELSE HAS ALREADY TOUCHED: turning research
  // back on has to clear this host's earlier approval first, and it cannot clear one a colleague committed.
  await run("research that cannot be turned back on safely", EXIT.RESEARCH, async (p) => {
    const research = { tavily: "kiln-fake-tavily-key-4c7f", researchAdapter: { probe: async () => ({ ok: true, backend: "tavily", checkedWithoutSearching: true }) } };
    const off = await setup(p, ["--research", "disabled"], research);
    assert.equal(off.code, EXIT.OK, off.printed.concat(off.warned).join("\n"));
    // A consent record in version control is one Kiln may not act on: it reached this clone from somewhere else.
    execFileSync("git", ["add", "-f", ".pi/runtime/consent.json"], { cwd: p.dir });
    execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=T", "commit", "-qm", "committed by a colleague"], { cwd: p.dir });
    return setup(p, ["--research", "tavily"], research);
  });
  await run("a computer with no provider connected", EXIT.AUTHENTICATION, (p) => {
    writeFileSync(join(p.agentDir, "auth.json"), "{}");
    writeFileSync(join(p.agentDir, "models.json"), JSON.stringify({ providers: {} }));
    return setup(p, ["--non-interactive", "--inspect", "approve"], { pick: [] });
  });
  // ⚠️ TWO ANSWERS, ONE CLASS: a refused look at this computer and a refused billable check both leave setup
  // partial with the project valid, which is what code 9 means. What they are not is "the model failed".
  await run("a billable check the operator refused", EXIT.CONSENT, (p) =>
    setup(p, ["--non-interactive", "--inspect", "approve", "--model-use", "approve"], { liveCheck: "deny" })
  );
  await run("a model that did not pass the check", EXIT.NOT_PROVED, (p) =>
    setup(p, ["--non-interactive", "--inspect", "approve", "--model-use", "approve"], { liveCheck: "approve", canary: async () => ({ passed: false }) })
  );

  // ⚠️ **A MODEL THIS COMPUTER DECLINED IS AN ANSWER, NOT A FAULT**, which is why it arrives as the partial
  // code and not as "this selection cannot be used". The latter is the preflight's class, and in THIS command the
  // selection phase refuses first in every case that would reach it — an unavailable model is offered for
  // reselection, a missing credential is a contract refusal. It is reached for real by the launcher, which has no
  // selection phase in front of it, and is proved there and in the mapping below.
  const declined = project({ ignored: true });
  try {
    const first = await setup(declined, ["--non-interactive", "--inspect", "approve", "--model-use", "approve"], { liveCheck: "approve" });
    assert.equal(first.code, EXIT.OK, first.printed.join("\n"));
    const consentPath = join(declined.dir, ".pi", "runtime", "consent.json");
    const consent = JSON.parse(readFileSync(consentPath, "utf-8"));
    consent.modelUse.granted = false;
    writeFileSync(consentPath, JSON.stringify(consent));
    const after = await setup(declined, ["--non-interactive", "--inspect", "approve"], { pick: [], liveCheck: "approve" });
    assert.equal(after.code, EXIT.CONSENT, `a declined model: ${after.printed.concat(after.warned).join("\n")}`);
    assert.ok(
      after.printed.every((l) => !/^compatibility recorded/.test(l)),
      `a declined model was checked live: ${after.printed.join("\n")}`
    );
  } finally {
    rmSync(declined.root, { recursive: true, force: true });
  }

  // ⚠️ AND THE CONTRACT ITSELF: every code observed is published, distinct, and described in --help.
  assert.equal(new Set(Object.values(EXIT)).size, Object.values(EXIT).length, "two classes share a code");
  for (const [what, code] of observed) {
    assert.ok(Object.hasOwn(EXIT_MEANING, String(code)), `${what}: ${code} has no published meaning`);
    assert.ok(help.some((line) => new RegExp(`^\\s*${code}\\s`).test(line)), `${what}: ${code} is not in --help`);
  }
  // ⚠️ **A CODE PER CLASS, NOT PER SCENARIO.** Several bad arguments are one class, and so are the answers
  // that leave setup partial; what may not happen is two DIFFERENT instructions to the operator arriving as one
  // number. So the scenarios are grouped by the class they belong to, and those groups may not share a code.
  const byClass = new Map();
  for (const [what, code] of observed) {
    const cls = code === EXIT.ARGUMENTS ? "arguments" : code === EXIT.CONSENT ? "an answer that left setup partial" : what;
    byClass.set(cls, code);
  }
  assert.equal(new Set(byClass.values()).size, byClass.size, `two classes arrived as one code: ${[...byClass]}`);

  /**
   * ⚠️ **WHAT THIS MATRIX DOES NOT REACH, SAID HERE RATHER THAN LEFT TO BE INFERRED.** Two launch-side
   * refusal classes are not setup's to raise:
   *
   * • `EXIT.UNUSABLE` — the preflight's `LaunchRefusal`. In THIS command the selection phase refuses first
   *   in every case that would reach it: an unavailable model is offered for reselection, a model this host
   *   declined leaves setup partial (measured above), and a provider with no contract is a credential refusal.
   * • Launch failure — raised on the way to a running Kiln, which has no selection phase in front of it.
   *
   * ACC-0084 was amended to `bin/setup.mjs` on that basis and names neither; a criterion against CMP-0037, the
   * combined runtime supervisor that raises them, is owed. Setup publishes `EXIT.UNUSABLE` and checks it
   * below, so it is not unpublished; launch failure has no code of setup's. What is declared is that this file
   * observes neither.
   */
  const { exitFor } = await import("../bin/setup.mjs");
  for (const [name, code] of [["LaunchRefusal", EXIT.UNUSABLE]]) {
    assert.equal(exitFor(Object.assign(new Error("x"), { name, reason: "whatever" })), code, `${name} is not mapped`);
    assert.ok(Object.hasOwn(EXIT_MEANING, String(code)), `${code} has no published meaning`);
    assert.ok([...observed.values()].includes(code) === false, `${code} was observed after all; move it out of the boundary list`);
  }

  // ⚠️ AND THE OPTIONS THE HELP DESCRIBES ARE THE OPTIONS THE COMMAND TAKES, including what re-enables research.
  // Read as an operator reads it, so a sentence wrapped across two lines is still the sentence.
  const text = help.join(" ").replace(/\s+/g, " ");
  for (const flag of ["--inspect", "--model-use", "--endpoint-identity", "--request-identity"]) assert.ok(text.includes(flag), `${flag} is undocumented`);
  // ⚠️ THE SAME INSTRUCTION EVERY USER-DISABLED RESEARCH OUTCOME CARRIES (EVD-0127): one way to turn it on,
  // said in one form, wherever the operator meets it.
  assert.ok(
    /to enable web research later, run setup again with --research tavily/i.test(text),
    `--help does not say what re-enables research: ${text}`
  );
});

test("⚠️ every refusal class this command can raise has its own published exit code", async () => {
  // ⚠️ **A CODE PER CLASS IS WHAT A CALLER CAN ACT ON.** "Choose a model", "this provider needs a credential
  // declaration" and "the package entry could not be written" are three different instructions; one code for all
  // of them is none. Each class is checked against the table, and the table against what --help publishes.
  const { exitFor, EXIT_MEANING, usage } = await import("../bin/setup.mjs");
  const classes = [
    ["ModelSelectionRefusal", EXIT.SELECTION],
    ["CredentialContractRefusal", EXIT.CREDENTIALS],
    ["PackageEntryRefusal", EXIT.REGISTRATION],
    ["SettingsRefusal", EXIT.REGISTRATION],
    ["ResearchChoiceRefusal", EXIT.RESEARCH],
    ["LaunchRefusal", EXIT.UNUSABLE],
    ["IgnoreRefusal", EXIT.STATE],
    ["LiveCheckRefusal", EXIT.CONSENT],
    ["TrustRefusal", EXIT.TRUST],
  ];
  const text = usage().join("\n");
  for (const [name, code] of classes) {
    const error = Object.assign(new Error("refused"), { name, reason: "whatever" });
    assert.equal(exitFor(error), code, `${name} maps to the wrong code`);
    assert.ok(Object.hasOwn(EXIT_MEANING, String(code)), `${code} has no published meaning`);
    assert.ok(usage().some((line) => new RegExp(`^\\s*${code}\\s`).test(line)), `${code} is not in --help`);
  }

  // ⚠️ AND A CLASS THIS TABLE DOES NOT NAME IS NOT GUESSED AT: it keeps the generic setup code, which is at least
  // honest about "this run refused".
  assert.equal(exitFor(Object.assign(new Error("x"), { name: "SomethingElseRefusal", reason: "r" })), null);
  assert.equal(exitFor(new Error("x")), null);
  assert.equal(exitFor(null), null);

  // The classes the command can reach are each proved through it elsewhere in this file; these are the ones it
  // cannot, held here so the table is not a list of aspirations.
  const unreachable = ["ResearchChoiceRefusal", "IgnoreRefusal", "SettingsRefusal"];
  for (const name of unreachable) assert.ok(classes.some(([c]) => c === name), `${name} left the table`);
});

test("⚠️ a stage document written before the intake section gets one, and a document somebody edited is left alone", async () => {
  // `kiln_write_stage_document` refuses a document without the `## Intake` section rather than restructuring one
  // mid-write, so a project initialized before that section existed cannot record an answer at all. Setup adds it,
  // as a planned write like any other, and adds it only where it is absent.
  const { INTAKE_HEADING, ANSWERS_HEADING, READING_HEADING, parseIntakeSection } = await import("../lib/stage-documents.mjs");
  const p = project({ ignored: true });
  try {
    assert.equal((await setup(p)).code, EXIT.OK);

    // An older document: everything of the operator's, and no intake section.
    const stage = join(p.dir, "planning-content", "stages", "01-intake.md");
    const older = ["# Stage 1 — Intake", "", "## Purpose", "", "What this project is for.", "", "## Working notes", "", "Ours, not Kiln's.", ""].join("\n");
    writeFileSync(stage, older);

    const migrated = await setup(p, [], { pick: [] });
    assert.equal(migrated.code, EXIT.OK, migrated.printed.join("\n"));
    const text = readFileSync(stage, "utf-8");

    // ⚠️ EVERY LINE THE OPERATOR WROTE IS STILL THERE, IN ORDER, and the section is now readable by the writer.
    for (const line of ["# Stage 1 — Intake", "## Purpose", "What this project is for.", "## Working notes", "Ours, not Kiln's."])
      assert.ok(text.includes(line), `${line} was lost`);
    assert.ok(text.indexOf("Ours, not Kiln's.") < text.indexOf(INTAKE_HEADING), "the section was inserted into the operator's material");
    for (const heading of [INTAKE_HEADING, ANSWERS_HEADING, READING_HEADING]) assert.ok(text.includes(heading), `${heading} is missing`);
    assert.ok(parseIntakeSection(text), "the writer cannot read the section this migration added");
    assert.ok(migrated.printed.some((l) => /intake section/.test(l)), migrated.printed.join(" | "));

    // ⚠️ AND IT IS DONE ONCE: a rerun changes no bytes, and adds no second section.
    const bytes = readFileSync(stage, "utf-8");
    assert.equal((await setup(p, [], { pick: [] })).code, EXIT.OK);
    assert.equal(readFileSync(stage, "utf-8"), bytes, "a rerun rewrote a migrated document");
    assert.equal(text.split(INTAKE_HEADING).length - 1, 1, "the document has more than one intake section");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ the migration adds a section, never repairs one, and keeps the document's own line endings", async () => {
  const { migrateIntakeSection } = await import("../lib/stage-document-migration.mjs");
  const { INTAKE_HEADING, ANSWERS_HEADING } = await import("../lib/stage-documents.mjs");

  // ⚠️ **A HEADING THAT IS THERE IS LEFT ALONE, whatever state its anchors are in.** A renamed or reordered anchor
  // is the operator's own edit, and the writer's refusal already tells them what it cannot follow; repairing one
  // here would mean deciding which of their lines were meant to be Kiln's.
  assert.deepEqual(migrateIntakeSection(`# S\n\n${INTAKE_HEADING}\n\n${ANSWERS_HEADING}\n\nwhatever\n`), { needed: false });
  assert.deepEqual(migrateIntakeSection(`# S\n\n${INTAKE_HEADING}\n\nthe anchors are gone\n`), { needed: false });
  // A heading that merely mentions it is not that heading.
  assert.equal(migrateIntakeSection(`# S\n\n## Intake notes\n\ntext\n`).needed, true);
  assert.equal(migrateIntakeSection(`# S\n\nprose about ${INTAKE_HEADING} in a sentence\n`).needed, true);

  // ⚠️ AND THE DOCUMENT'S OWN LINE ENDINGS ARE KEPT: appending LF to a CRLF document leaves one file with two
  // conventions, and shows every added line as changed in an editor that normalises.
  const crlf = migrateIntakeSection("# S\r\n\r\n## Purpose\r\n\r\nwhy\r\n");
  assert.equal(crlf.needed, true);
  assert.equal(/(^|[^\r])\n/.test(crlf.text), false, "a CRLF document gained bare LF lines");
  const lf = migrateIntakeSection("# S\n\n## Purpose\n\nwhy\n");
  assert.equal(lf.text.includes("\r"), false, "an LF document gained CRLF lines");
});

test("⚠️ ACC-0085 the external runtime path is printed before anything of the project is written", async () => {
  // An external root is keyed by the project's committed id, so a fresh project has to produce one before its
  // runtime path can be named. Deriving it in memory costs nothing and changes nothing; committing it first would
  // print the path after the first lasting write, which is what this criterion forbids. Measured in a child with
  // every filesystem call recorded from before the command starts, so "before" is a count and not a reading of
  // the source.
  const p = project({ ignored: true });
  const stateHome = join(p.root, "state-home");
  try {
    const run = spawnSync(process.execPath, [join(ROOT, "test", "fixtures", "setup", "capture-setup.mjs")], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PLANNING_CONTENT_DIR: p.contentRoot,
        PI_CODING_AGENT_DIR: p.agentDir,
        LOCALAPPDATA: stateHome,
        XDG_STATE_HOME: stateHome,
        KILN_CAPTURE_SETUP: JSON.stringify({
          agentDir: p.agentDir,
          answers: [["^Check this computer", "no"]],
          argv: ["--project-root", p.dir, "--name", "External", "--trust", "approve", "--local-state", "user"],
        }),
      },
    });

    const access = JSON.parse(/KILN_ACCESS (.+)/.exec(run.stdout)[1]);
    // ⚠️ THE LINE THAT NAMES THE PATH, not the earlier one that states the rule. Both come before any write — the
    // rule is printed with the other paths, before the install — and what this asserts is the exact one.
    const line = access.printed.find((entry) => entry.line.includes(stateHome));
    assert.ok(line, access.printed.map((entry) => entry.line).join(" | "));
    assert.equal(line.writes, 0, `the path was printed after ${line.writes} write(s) to the project`);

    // ⚠️ AND THE ID IN THAT PATH IS THE ONE THE RUN THEN COMMITTED, or the path described a directory nothing uses.
    const id = JSON.parse(readFileSync(join(p.dir, ".pi", "kiln.json"), "utf-8")).projectId;
    assert.ok(line.line.includes(id), `${line.line} does not name the committed id ${id}`);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0106 a complete setup, with an environment-authenticated provider and research enabled, commits no secret and no absolute path", async () => {
  // ⚠️ **THE FILE SET COMES FROM WHAT THE RUN ACTUALLY COMMITTED, NOT FROM A LIST WRITTEN HERE.** A fixed list
  // passes forever while the command grows a file nobody added to it; git's own answer — every untracked or
  // modified path it would commit, with the ignore rules applied — is the set that cannot go stale.
  const p = project({ ignored: true, models: false });
  const stateHome = join(p.root, "state-home");
  const PROVIDER_KEY = "sk-kiln-acc0106-PROVIDER-9c41f7";
  const RESEARCH_KEY = "tvly-kiln-acc0106-RESEARCH-3b08de";
  try {
    // ⚠️ THE BOUNDARY IS TAKEN BEFORE THE RUN, so what is scanned is what this run did and not what the fixture
    // arrived with. The operator's own file is written first and carries a path and a secret-shaped string of its
    // own: it must not be in the scanned set, and a scan that took the whole after-set would fail on it — which is
    // how this boundary is observable rather than merely intended.
    writeFileSync(join(p.dir, "OPERATOR-NOTES.md"), `# Notes

My key is ${PROVIDER_KEY} and my project is ${p.dir}.
`);
    const before = committedPaths(p.dir);

    // An environment-authenticated provider: Pi finds openai through the variable, with nothing in auth.json.
    const probes = [];
    const o = await setup(p, ["--research", "tavily"], {
      env: { OPENAI_API_KEY: PROVIDER_KEY, LOCALAPPDATA: stateHome, XDG_STATE_HOME: stateHome },
      tavily: RESEARCH_KEY,
      answers: [[/^Optional web research/i, "yes"]],
      // ⚠️ NEITHER CHECK LEAVES THIS MACHINE: the canary's proof is derived from what the command resolved, and
      // the research probe answers as a healthy connection would. What is under test is the bytes that land.
      researchAdapter: {
        probe: async () => {
          probes.push("probe");
          return { ok: true, backend: "tavily", quota: { used: 1, limit: 1000, remaining: 999 }, checkedWithoutSearching: true };
        },
      },
    });
    assert.equal(o.code, EXIT.OK, o.printed.join("\n"));
    assert.deepEqual(probes, ["probe"], "the research connection was not checked");
    // ⚠️ AND IT REALLY WAS THE ENVIRONMENT THAT AUTHENTICATED IT: this project's agent directory holds no stored
    // credential, so a run that reported "stored" here would be testing a different arrangement than the one the
    // criterion names.
    assert.ok(
      o.printed.some((l) => /^preflight passed:.*authentication environment-key/.test(l)),
      o.printed.filter((l) => l.startsWith("preflight")).join(" | ")
    );

    // ⚠️ **WHAT THE RUN ADDED OR CHANGED, WHICH IS A BEFORE AND AN AFTER.** The set that matters is the run's own
    // effect on what git would commit, so it is the difference between the two: a fixture artefact that was
    // already there — this project's `.planning` link, which the ignore block's `.planning/` does not match — is
    // in both, and therefore in neither the set nor an exemption list somebody has to maintain.
    const after = committedPaths(p.dir);
    const wasThere = new Set(before.map((entry) => `${entry.status} ${entry.path}`));
    const committed = after.filter((entry) => !wasThere.has(`${entry.status} ${entry.path}`)).map((entry) => entry.path);
    assert.ok(committed.length > 5, `the run committed almost nothing: ${committed.join(", ")}`);
    assert.equal(committed.includes("OPERATOR-NOTES.md"), false, "the scan claimed a file the operator wrote before the run");
    // ⚠️ EVERY ENTRY IS ACCOUNTED FOR: each one is read below, and anything not readable as a file fails rather
    // than being passed over, because a scan that skips what it cannot read is not a scan.
    for (const entry of committed) assert.ok(typeof entry === "string" && entry.length > 0, JSON.stringify(after));
    // ⚠️ AND THE TWO FILES THE CRITERION NAMES ARE IN IT, by name, rather than assumed to be.
    for (const named of [".pi/settings.json", ".pi/kiln.json"])
      assert.ok(committed.includes(named), `${named} is not among what the run committed: ${committed.join(", ")}`);
    // The ignored runtime state is NOT in it: consent and compatibility records are not committed at all.
    for (const ignored of [".pi/runtime/consent.json", ".pi/runtime/model-compatibility.json"])
      assert.equal(committed.includes(ignored), false, `${ignored} would be committed`);

    // ⚠️ WHAT IS LOOKED FOR IS THE CREDENTIAL, THINGS DERIVED FROM IT, AND THIS MACHINE'S PATHS. A fingerprint is
    // still a credential-derived value: a project that committed one would leak which key a host holds.
    const derived = [
      createHash("sha256").update(PROVIDER_KEY).digest("hex"),
      createHash("sha256").update(PROVIDER_KEY).digest("base64"),
      createHash("sha256").update(RESEARCH_KEY).digest("hex"),
      Buffer.from(PROVIDER_KEY).toString("base64"),
      PROVIDER_KEY.slice(0, 12),
      RESEARCH_KEY.slice(0, 12),
    ];
    // ⚠️ **ANY ABSOLUTE PATH, NOT ONLY THIS FIXTURE'S.** The tool root is the likeliest one to leak in practice —
    // a generator that interpolated where it was running would commit the developer's checkout into every
    // project — so the fixture's own paths are checked by value and absolute paths in general by shape.
    const absolute = [p.root, p.dir, p.agentDir, stateHome, tmpdir(), homedir(), ROOT];
    const absoluteShapes = [/[A-Za-z]:[\/]/, /\/home\//, /\/Users\//, /\/tmp\//, /\/var\/folders\//];
    const headers = [/authorization:/i, /bearer\s/i, /x-api-key/i];

    for (const rel of committed) {
      // ⚠️ **EVERYTHING THIS RUN ADDED IS A FILE THIS SCAN READS.** There is no exemption list: an entry that is
      // not a regular file is one nobody has looked inside, and a leak scan that passes over what it cannot read
      // is not one. The fixture's `.planning` link is not here because it was in the before set too.
      assert.ok(statSync(join(p.dir, rel)).isFile(), `${rel} was added by this run and is not a file this scan can read`);
      const text = readFileSync(join(p.dir, rel), "utf-8");
      for (const secret of [PROVIDER_KEY, RESEARCH_KEY, ...derived])
        assert.equal(text.includes(secret), false, `${rel} carries a credential or something derived from one`);
      for (const header of headers) assert.equal(header.test(text), false, `${rel} carries an authorisation header`);
      for (const path of absolute)
        assert.equal(text.includes(path), false, `${rel} carries this machine's own path (${path})`);
      for (const shape of absoluteShapes)
        assert.equal(shape.test(text), false, `${rel} carries an absolute path (${shape})`);
      // The variables' NAMES are configuration, not credentials — but this project never needed to commit one.
      for (const name of ["OPENAI_API_KEY", "TAVILY_API_KEY"]) assert.equal(text.includes(name), false, `${rel} names a credential variable`);
    }

    // And the research choice did land: the criterion asks for an ENABLED connection, not merely a run that asked.
    assert.equal(JSON.parse(readFileSync(join(p.dir, ".pi", "kiln.json"), "utf-8")).research.provider, "tavily");
    assert.equal(settingsOf(p).defaultProvider, "openai");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0045 a run killed after its journal began records where it stopped, and the command it recorded finishes it", async () => {
  // ⚠️ **KILLED, NOT MADE TO THROW.** Every other interruption case in this file simulates one; this one takes a
  // real child through the journal and then removes it from the world, because what the journal is FOR is the run
  // that had no chance to clean up after itself.
  const p = project({ ignored: true });
  const spec = {
    agentDir: p.agentDir,
    answers: [
      ["^Check this computer", "yes"],
      ["^Use this model for this project", "yes"],
      ["^Optional web research", "no"],
    ],
    argv: ["--project-root", p.dir, "--name", "Interrupted", "--trust", "approve", "--live-model-check", "approve", ...PICKED],
  };
  try {
    const killed = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(ROOT, "test", "fixtures", "setup", "capture-setup.mjs")], {
        env: { ...process.env, PLANNING_CONTENT_DIR: p.contentRoot, PI_CODING_AGENT_DIR: p.agentDir, KILN_CAPTURE_SETUP: JSON.stringify(spec) },
      });
      let out = "";
      let done = false;
      child.stdout.on("data", (chunk) => {
        out += chunk;
        // ⚠️ THE FIRST LINE PRINTED AFTER THE JOURNAL IS OPEN. The identity line comes just before it opens, so
        // killing on that one would land in the window this criterion is not about; the trust decision is the
        // first thing that happens with a journal on disk.
        if (!done && /trust (approved|denied) for /.test(out)) {
          done = true;
          child.kill("SIGKILL");
        }
      });
      child.on("exit", (code, signal) => resolve({ out, code, signal }));
      child.on("error", reject);
    });
    assert.notEqual(killed.code, 0, `the run finished instead of being killed: ${killed.out}`);

    // ⚠️ THE JOURNAL IS WHAT THE KILLED RUN LEFT, and it says where it stopped and how to continue.
    const journal = JSON.parse(readFileSync(join(p.dir, ".pi", "runtime", "setup-transaction.json"), "utf-8"));
    // ⚠️ WHERE IT STOPPED, NOT A FIXED PHASE NAME: what the criterion asks for is that the journal SAYS where,
    // and a kill lands wherever the scheduler put it.
    assert.ok(["project-identity", "trust"].includes(journal.lastCompletedPhase), JSON.stringify(journal.phases));
    // ⚠️ THE PHASE THAT WAS IN FLIGHT SAYS SO, which is only true because `running` is written BEFORE the work:
    // a status recorded on completion cannot tell "never started" from "died halfway", and those need different
    // recoveries.
    assert.ok(
      journal.phases.some((ph) => ph.status === "running"),
      `no phase was recorded as in flight: ${JSON.stringify(journal.phases)}`
    );
    assert.ok(journal.recovery?.command, JSON.stringify(journal.recovery ?? null));
    assert.ok(journal.recovery.command.includes("--resume"), journal.recovery.command);
    assert.ok(journal.recovery.command.includes(p.dir), journal.recovery.command);

    // ⚠️ **AND THAT COMMAND IS THE SOURCE OF WHAT IS RUN.** Its arguments are parsed out of the recorded line —
    // not typed here — so a command naming another project, or omitting `--resume`, sends this run somewhere else
    // and the assertions below fail. Only npm and the canary are replaced, as everywhere, because a test may not
    // install a dependency graph or send a provider a billable request; the operator's own answers are added.
    const parsed = parseShellArgv(journal.recovery.command);
    assert.equal(parsed[0], "node", journal.recovery.command);
    assert.match(parsed[1], /bin[\/]setup\.mjs$/, journal.recovery.command);
    const argv = parsed.slice(2);
    assert.deepEqual(argv, ["--project-root", p.dir, "--resume"], journal.recovery.command);
    const resumed = spawnSync(process.execPath, [join(ROOT, "test", "fixtures", "setup", "capture-setup.mjs")], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PLANNING_CONTENT_DIR: p.contentRoot,
        PI_CODING_AGENT_DIR: p.agentDir,
        KILN_CAPTURE_SETUP: JSON.stringify({ ...spec, argv: [...argv, "--name", "Interrupted", "--trust", "approve", "--live-model-check", "approve", ...PICKED] }),
      },
    });
    assert.equal(resumed.status, EXIT.OK, `${resumed.stdout}${resumed.stderr}`);
    assert.ok(/continuing an interrupted run/.test(resumed.stdout), resumed.stdout);

    // The remaining phases ran, and the completed run left nothing to resume.
    assert.equal(existsSync(join(p.dir, ".pi", "runtime", "setup-transaction.json")), false, "the completed run left a journal");
    assert.equal(existsSync(join(p.dir, ".pi", "runtime", "model-compatibility.json")), true, "the resumed run did not finish the checks");
    assert.equal(settingsOf(p).defaultModel, "gpt-4o");
    assert.equal(existsSync(join(p.dir, "planning-content", "project.yaml")), true, "the scaffold did not survive");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ a recovery clears only a lock whose owner is provably gone", async () => {
  // The stale window protects a waiter from a slow holder; a recovery is the other situation — the operator has
  // been told the run was interrupted and has asked for it to be continued. What it may not do is take a lock
  // from a process that might still be holding it.
  const { breakDeadLock } = await import("../lib/lock.mjs");
  const p = project();
  const lock = join(p.dir, ".planning-init.lock");
  try {
    assert.deepEqual(breakDeadLock(lock), { broken: false, reason: "absent" });

    writeFileSync(lock, "half a lockfile");
    assert.deepEqual(breakDeadLock(lock), { broken: false, reason: "unreadable" });
    assert.equal(existsSync(lock), true, "an unreadable lock was removed");

    // ⚠️ THIS PROCESS IS ALIVE, and a lock naming it is one somebody is holding.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() }));
    assert.deepEqual(breakDeadLock(lock), { broken: false, reason: "alive" });
    assert.equal(existsSync(lock), true, "a live holder's lock was removed");

    // ⚠️ AND A LOCK FROM ANOTHER MACHINE CANNOT BE JUDGED FROM HERE: its pid means nothing on this one.
    writeFileSync(lock, JSON.stringify({ pid: 1, hostname: `${hostname()}-somewhere-else`, acquiredAt: new Date().toISOString() }));
    assert.deepEqual(breakDeadLock(lock), { broken: false, reason: "other-host" });
    assert.equal(existsSync(lock), true, "another machine's lock was removed");

    // A process that has exited: its lock is what a killed run leaves, and clearing it is the whole point.
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" });
    writeFileSync(lock, JSON.stringify({ pid: Number(gone.stdout), hostname: hostname(), acquiredAt: new Date().toISOString() }));
    const broke = breakDeadLock(lock);
    assert.equal(broke.broken, true, JSON.stringify(broke));
    assert.equal(existsSync(lock), false, "a dead holder's lock survived");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0045 a run killed inside the bootstrap leaves the project untouched and nothing to resume", async () => {
  // The second interruption window: the bootstrap runs before any journal exists, so what a kill there must leave
  // is a project that looks exactly as it did — and a rerun that simply does the install again.
  const p = project({ ignored: true });
  try {
    const before = tree(p.dir);
    const spec = {
      agentDir: p.agentDir,
      installMs: 4000,
      answers: [["^Check this computer", "no"]],
      argv: ["--project-root", p.dir, "--name", "Killed", "--trust", "approve"],
    };
    const killed = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(ROOT, "test", "fixtures", "setup", "capture-setup.mjs")], {
        env: { ...process.env, PLANNING_CONTENT_DIR: p.contentRoot, PI_CODING_AGENT_DIR: p.agentDir, KILN_CAPTURE_SETUP: JSON.stringify(spec) },
      });
      let out = "";
      let done = false;
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (!done && /KILN_INSTALLING/.test(out)) {
          done = true;
          child.kill("SIGKILL");
        }
      });
      child.on("exit", (code, signal) => resolve({ out, code, signal }));
      child.on("error", reject);
    });
    assert.notEqual(killed.code, 0, `the run finished instead of being killed: ${killed.out}`);
    assert.ok(/KILN_INSTALLING/.test(killed.out), killed.out);

    // ⚠️ NOT ONE BYTE OF THE PROJECT, and nothing that would make the next run think it was recovering.
    assert.deepEqual(tree(p.dir), before, "a run killed in the bootstrap changed the project");
    assert.equal(existsSync(join(p.dir, ".pi")), false, "runtime state survived a killed bootstrap");

    // And an ordinary rerun — no --resume, because there is nothing to resume — completes.
    const again = await setup(p);
    assert.equal(again.code, EXIT.OK, again.printed.join("\n"));
    assert.ok(again.printed.every((l) => !/continuing an interrupted run/.test(l)), again.printed.join(" | "));
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ two recoveries racing for one dead run's lock do not both get it", async () => {
  // ⚠️ **THE DEFECT THIS EXISTS FOR:** a recovery that reads a dead owner and then unlinks the lock can unlink a
  // lock another recovery has just legitimately acquired, and both then believe they hold the project. Setup
  // clears such a lock on every rerun, so two reruns started together is not a contrived case.
  const p = project();
  const lock = join(p.dir, ".planning-init.lock");
  const log = join(p.root, "holders.log");
  try {
    // A lockfile owned by a process that has exited: what a killed run leaves behind.
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" });
    writeFileSync(lock, JSON.stringify({ pid: Number(gone.stdout), hostname: hostname(), acquiredAt: new Date().toISOString() }));
    writeFileSync(log, "");

    const racers = [0, 1, 2, 3].map(
      () =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [join(ROOT, "test", "fixtures", "setup", "racing-recovery.mjs"), lock, log, "250"], {
            stdio: "ignore",
          });
          child.on("exit", (code) => resolve(code));
        })
    );
    const codes = await Promise.all(racers);
    assert.ok(codes.some((c) => c === 0), `nobody acquired the lock: ${codes.join(", ")}`);

    // ⚠️ **OVERLAP IS READ OUT OF WHAT THE HOLDERS WROTE.** Every `enter` must be followed by its own `exit`
    // before another `enter`; two arrivals in a row is two writers inside one lock.
    const events = readFileSync(log, "utf-8").split("\n").filter(Boolean);
    let held = 0;
    for (const event of events) {
      if (event.startsWith("enter")) held += 1;
      if (event.startsWith("exit")) held -= 1;
      assert.ok(held <= 1, `two processes held the lock at once:\n${events.join("\n")}`);
    }
    assert.equal(held, 0, `a holder never left:\n${events.join("\n")}`);
    assert.equal(events.filter((e) => e.startsWith("enter")).length >= 1, true, events.join(" | "));

    // And the lock is gone when they are all finished, with nothing a recovery used left beside it.
    assert.equal(existsSync(lock), false, "the lock outlived its holders");
    assert.deepEqual(
      readdirSync(p.dir).filter((name) => name.startsWith(".planning-init.lock.")),
      [],
      "a recovery left a file of its own behind"
    );
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ one process at a time may clear a lock, and a gate nobody holds does not block recovery", async () => {
  // ⚠️ **WHAT THE RACE CONTROL CAUGHT IN CI ON 2026-09-23.** Judging a lock and then removing it are two
  // moments, and in between the lock can become a live holder's — so the removal is serialised, and the
  // judgement that acts is made where no other process can be removing anything. This is that gate from the
  // outside: while somebody is breaking, nobody else breaks, by either path.
  const { breakDeadLock, withLock, LockError } = await import("../lib/lock.mjs");
  const p = project();
  const lock = join(p.dir, ".planning-init.lock");
  const { gate, token } = { gate: `${lock}.breaking`, token: `${lock}.breaking.reclaim` };
  const exited = () =>
    Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" }).stdout);
  try {
    const dead = JSON.stringify({ pid: exited(), hostname: hostname(), acquiredAt: new Date().toISOString() });
    writeFileSync(lock, dead);
    // Somebody is breaking this lock right now, and that somebody is alive.
    writeFileSync(gate, JSON.stringify({ pid: process.pid, hostname: hostname(), takenAt: new Date().toISOString() }));

    assert.deepEqual(breakDeadLock(lock), { broken: false, reason: "claimed-elsewhere" });
    assert.equal(readFileSync(lock, "utf-8"), dead, "a second recovery cleared a lock somebody else was clearing");

    // ⚠️ AND A GATE JUST TAKEN IS SOMEBODY'S EVEN BEFORE THEY HAVE WRITTEN THEIR NAME IN IT: a fresh gate that
    // cannot be read is the microsecond between the create and the write, not an abandoned one.
    writeFileSync(gate, "");
    assert.deepEqual(breakDeadLock(lock), { broken: false, reason: "claimed-elsewhere" });
    assert.equal(readFileSync(lock, "utf-8"), dead, "a recovery took a gate another process had just created");

    // ⚠️ AND THE WAITER'S PATH IS THE SAME PATH. An old lock with a dead owner is exactly what a waiter
    // may break — unless a recovery is already acting on it, in which case waiting and giving up is correct.
    const old = Date.now() / 1000 - 600;
    utimesSync(lock, old, old);
    await assert.rejects(
      () => withLock(lock, async () => "acquired", { maxWaitMs: 200, retryMs: 5 }),
      (e) => e instanceof LockError && /Timed out/.test(e.message),
      "a waiter broke a lock another process was already breaking"
    );
    assert.equal(readFileSync(lock, "utf-8"), dead, "a waiter cleared a lock somebody else was clearing");

    // ⚠️ **AND RECLAIMING AN ABANDONED GATE IS ITSELF SERIALISED.** Two reclaimers can reach the same
    // judgement about one old gate; the first clears it and takes a new one, and the second would then clear THAT
    // gate, a live one. Only the process holding the token may reclaim, so the other one breaks nothing.
    const abandon = () => {
      writeFileSync(lock, dead);
      writeFileSync(gate, JSON.stringify({ pid: exited(), hostname: hostname() }));
      const stale = Date.now() / 1000 - 60;
      utimesSync(gate, stale, stale);
    };
    abandon();
    writeFileSync(token, JSON.stringify({ pid: process.pid, hostname: hostname(), takenAt: new Date().toISOString() }));
    assert.deepEqual(breakDeadLock(lock), { broken: false, reason: "claimed-elsewhere" });
    assert.equal(existsSync(gate), true, "a second reclaimer cleared a gate somebody else was reclaiming");

    // ⚠️ AND AGE ALONE DOES NOT MAKE A GATE ABANDONED: a breaker whose machine is loaded is still a breaker, so
    // the holder has to be gone as well. This one is old and alive, and it is left exactly where it is.
    rmSync(token);
    writeFileSync(gate, JSON.stringify({ pid: process.pid, hostname: hostname() }));
    const longSince = Date.now() / 1000 - 600;
    utimesSync(gate, longSince, longSince);
    assert.deepEqual(breakDeadLock(lock), { broken: false, reason: "claimed-elsewhere" });
    assert.equal(existsSync(gate), true, "a live breaker's gate was reclaimed because it was old");
    writeFileSync(token, JSON.stringify({ pid: process.pid, hostname: hostname(), takenAt: new Date().toISOString() }));
    abandon();

    // ⚠️ **AND THE TOKEN IS NEVER RECLAIMED IN TURN, WHICH IS WHERE THIS STOPS.** Judging a file and then
    // removing it is the defect at every level, so the last file is not judged at all: one left behind by a killed
    // process fails closed and names itself, because removing it is a decision only the operator can make.
    const longAgo = Date.now() / 1000 - 600;
    utimesSync(token, longAgo, longAgo);
    assert.deepEqual(breakDeadLock(lock), { broken: false, reason: "break-blocked", blockedBy: { gate, token } });
    assert.equal(existsSync(gate), true, "a blocked recovery cleared the gate anyway");
    assert.equal(readFileSync(lock, "utf-8"), dead, "a blocked recovery cleared the lock anyway");
    rmSync(token);

    // ⚠️ **AND AN OLD GATE NOBODY CAN READ IS NOT AN ABANDONED ONE EITHER.** Creating the gate and writing
    // the owner into it are two calls, and a process can be stopped between them for as long as the operating
    // system likes, so an empty gate says only that somebody created it. It fails closed, with both paths named.
    rmSync(token, { force: true });
    writeFileSync(lock, dead);
    for (const unprovable of ["", JSON.stringify({ pid: exited(), hostname: `${hostname()}-somewhere-else` })]) {
      writeFileSync(gate, unprovable);
      const stale = Date.now() / 1000 - 60;
      utimesSync(gate, stale, stale);
      assert.deepEqual(breakDeadLock(lock), { broken: false, reason: "break-blocked", blockedBy: { gate, token } });
      assert.equal(existsSync(gate), true, "a gate nobody can judge was reclaimed anyway");
      assert.equal(readFileSync(lock, "utf-8"), dead, "a lock was cleared behind a gate nobody can judge");
    }

    // ⚠️ WHAT IS RECLAIMED IS A GATE WHOSE RECORD NAMES A PROCESS ON THIS HOST THAT IS GONE, and nothing
    // else — otherwise one killed recovery would stop every later one for good.
    writeFileSync(gate, JSON.stringify({ pid: exited(), hostname: hostname() }));
    const stale = Date.now() / 1000 - 60;
    utimesSync(gate, stale, stale);
    const broke = breakDeadLock(lock);
    assert.equal(broke.broken, true, `an abandoned gate blocked a recovery: ${JSON.stringify(broke)}`);
    assert.equal(existsSync(lock), false, "the dead run's lock survived");
    assert.equal(existsSync(gate), false, "the abandoned gate survived");

    // A recovery that runs to the end leaves nothing of its own beside the lock.
    assert.deepEqual(
      readdirSync(p.dir).filter((name) => name.startsWith(".planning-init.lock")),
      [],
      "a recovery left a file of its own behind"
    );
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("\u26a0\ufe0f a breaker stopped before it names itself keeps its gate, and the run says so", async () => {
  // \u26a0\ufe0f **THE CASE AGE CANNOT DECIDE, MEASURED AGAINST A REAL PROCESS.** A breaker that is stopped
  // between taking its gate and writing its name into it leaves exactly what a killed one leaves: an old, empty
  // gate. Clearing it would take the gate from a process that is still running, so nothing clears it \u2014 the
  // run fails closed and names it, and the stopped process carries on and releases it itself.
  const { breakDeadLock } = await import("../lib/lock.mjs");
  const p = project();
  const lock = join(p.dir, ".planning-init.lock");
  const gate = `${lock}.breaking`;
  const ready = join(p.root, "gate-taken");
  const go = join(p.root, "carry-on");
  try {
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" });
    const dead = JSON.stringify({ pid: Number(gone.stdout), hostname: hostname(), acquiredAt: new Date().toISOString() });
    writeFileSync(lock, dead);

    const argv = [join(ROOT, "test", "fixtures", "setup", "paused-breaker.mjs"), gate, ready, go];
    const paused = spawn(process.execPath, argv, { stdio: "ignore" });
    const finished = new Promise((resolve) => paused.on("exit", resolve));
    while (!existsSync(ready)) await new Promise((r) => setTimeout(r, 10));

    // The gate is old, empty, and its holder is very much alive. Whatever this finds, the paused process is let
    // go afterwards: a fixture left waiting for a signal a failed assertion never sends is a hung run.
    try {
      assert.deepEqual(breakDeadLock(lock), {
        broken: false,
        reason: "break-blocked",
        blockedBy: { gate, token: `${lock}.breaking.reclaim` },
      });
      assert.equal(existsSync(gate), true, "a running breaker's gate was taken from it");
      assert.equal(readFileSync(lock, "utf-8"), dead, "the lock was cleared while a breaker still held the gate");
    } finally {
      // And the process that was stopped carries on and releases its own gate, as it would have all along.
      writeFileSync(go, "");
    }
    assert.equal(await finished, 0, "the paused breaker did not finish");
    assert.equal(existsSync(gate), false, "the breaker did not release its gate");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ two reclaimers and a waiter, starting from a gate nobody holds, do not both get the lock", async () => {
  // ⚠️ **THE STATE THE FOUR-RACER CONTROL NEVER STARTS IN.** A recovery killed inside the gate leaves it
  // behind, and the next two runs both find it abandoned. If they could both act on that judgement, the second
  // would clear a gate the first is already holding, and the waiter beside them would take the lock over the top.
  const p = project();
  const lock = join(p.dir, ".planning-init.lock");
  const gate = `${lock}.breaking`;
  const log = join(p.root, "holders.log");
  try {
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" });
    const dead = JSON.stringify({ pid: Number(gone.stdout), hostname: hostname(), acquiredAt: new Date().toISOString() });
    writeFileSync(lock, dead);
    // What a run killed inside the gate leaves: old enough to be nobody's, owned by a process that is gone.
    writeFileSync(gate, JSON.stringify({ pid: Number(gone.stdout), hostname: hostname() }));
    const stale = Date.now() / 1000 - 60;
    utimesSync(gate, stale, stale);
    writeFileSync(log, "");

    const racers = ["break", "break", "wait"].map(
      (mode) =>
        new Promise((resolve) => {
          const argv = [join(ROOT, "test", "fixtures", "setup", "racing-recovery.mjs"), lock, log, "250", mode];
          spawn(process.execPath, argv, { stdio: "ignore" }).on("exit", (code) => resolve(code));
        })
    );
    const codes = await Promise.all(racers);
    assert.ok(codes.some((c) => c === 0), `nobody acquired the lock: ${codes.join(", ")}`);

    const events = readFileSync(log, "utf-8").split("\n").filter(Boolean);
    let held = 0;
    for (const event of events) {
      if (event.startsWith("enter")) held += 1;
      if (event.startsWith("exit")) held -= 1;
      assert.ok(held <= 1, `two processes held the lock at once:\n${events.join("\n")}`);
    }
    assert.equal(held, 0, `a holder never left:\n${events.join("\n")}`);
    assert.equal(events.filter((e) => e.startsWith("enter")).length >= 1, true, events.join(" | "));

    // The abandoned gate was cleared by whoever reclaimed it, and nothing of the recovery is left behind.
    assert.deepEqual(
      readdirSync(p.dir).filter((name) => name.startsWith(".planning-init.lock.")),
      [],
      "a recovery left a file of its own behind"
    );
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ a recovery that cannot be proved safe stops the command and names the files to remove", async () => {
  // ⚠️ **FAIL CLOSED, WITH A ROUTE OUT.** The last file in the chain is never cleared on a guess, so a run
  // killed inside that window blocks automatic recovery. What the operator gets is the two paths and a published
  // exit code — not a timeout whose message names a pid they cannot do anything with.
  const p = project({ ignored: true });
  const lock = join(p.dir, ".planning-init.lock");
  const gate = `${lock}.breaking`;
  const token = `${lock}.breaking.reclaim`;
  try {
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" });
    writeFileSync(lock, JSON.stringify({ pid: Number(gone.stdout), hostname: hostname(), acquiredAt: new Date().toISOString() }));
    const stale = Date.now() / 1000 - 600;
    for (const path of [gate, token]) {
      writeFileSync(path, JSON.stringify({ pid: Number(gone.stdout), hostname: hostname() }));
      utimesSync(path, stale, stale);
    }
    const before = tree(p.dir);

    const refused = await setup(p);
    assert.equal(refused.code, EXIT.LOCK_RECOVERY, refused.printed.concat(refused.warned).join("\n"));
    const said = refused.warned.join("\n");
    assert.ok(said.includes(gate) && said.includes(token), `the refusal does not name what to remove: ${said}`);
    assert.deepEqual(tree(p.dir), before, "a blocked run changed the project");

    // And the route works: with those files gone, the same command clears the dead run's lock and completes.
    rmSync(gate);
    rmSync(token);
    const again = await setup(p);
    assert.equal(again.code, EXIT.OK, again.printed.concat(again.warned).join("\n"));
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ TSK-0063 --state-protection fix-ignore answers the coverage question without a prompt, only when fix-ignore is available, and writes nothing once protected", async () => {
  // Checked with the other arguments, before anything is installed: only the choice this slice applies is taken.
  assert.equal(parseArgs(["--state-protection", "fix-ignore"]).stateProtection, "fix-ignore");
  for (const bad of ["user-state", "stop", "yes"]) assert.ok(parseArgs(["--state-protection", bad]).error, `--state-protection ${bad} was accepted`);

  // A fresh repository, nobody to ask: the flag is the answer, and the owner's own block is written.
  const p = project();
  try {
    const o = await setup(p, ["--non-interactive", "--state-protection", "fix-ignore"]);
    assert.notEqual(o.code, EXIT.STATE, [...o.printed, ...o.warned].join("\n"));
    assert.equal(o.seen.asks.length, 0, "a non-interactive run asked");
    assert.ok(o.printed.includes("runtime state will be protected by fix-ignore, as --state-protection chose"), o.printed.join("\n"));
    const ignore = readFileSync(join(p.dir, ".gitignore"));
    assert.equal(ignore.toString("utf-8").includes(blockText()), true, "the block is not what was written");

    // Already protected: the same flag causes no write.
    const again = await setup(p, ["--non-interactive", "--state-protection", "fix-ignore"]);
    assert.notEqual(again.code, EXIT.STATE, [...again.printed, ...again.warned].join("\n"));
    assert.equal(again.printed.some((l) => l.startsWith("runtime state will be protected")), false, "a protected project was protected again");
    assert.ok(readFileSync(join(p.dir, ".gitignore")).equals(ignore), "the ignore file changed");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }

  // An edited Kiln block is the operator's decision, so fix-ignore is not available and the flag cannot take it.
  const q = project();
  try {
    const edited = blockText().replace(".pi/runtime/", ".pi/runtime-edited/");
    writeFileSync(join(q.dir, ".gitignore"), edited);
    const o = await setup(q, ["--non-interactive", "--state-protection", "fix-ignore"]);
    assert.equal(o.code, EXIT.STATE, [...o.printed, ...o.warned].join("\n"));
    assert.ok(o.warned.some((l) => l.includes("--state-protection fix-ignore cannot protect this project's runtime state")), o.warned.join("\n"));
    assert.equal(readFileSync(join(q.dir, ".gitignore"), "utf-8"), edited, "the refusal changed the ignore file");
    assert.equal(existsSync(join(q.dir, ".pi")), false, "runtime data was written before the refusal");
  } finally {
    rmSync(q.root, { recursive: true, force: true });
  }
});
