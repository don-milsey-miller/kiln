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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  const { canaryRequest, readJournal, resumeCommand: resume } = await import("../bin/setup.mjs");

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
  const { canaryRequest } = await import("../bin/setup.mjs");
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

    // Every path git would commit, which is the set the criterion asks for.
    const committed = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: p.dir, encoding: "utf-8" })
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""));
    assert.ok(committed.length > 5, `the run committed almost nothing: ${committed.join(", ")}`);
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
    const absolute = [p.root, p.dir, p.agentDir, stateHome, tmpdir(), homedir()];
    const headers = [/authorization:/i, /bearer\s/i, /x-api-key/i];

    for (const rel of committed) {
      // ⚠️ **THE ONE ENTRY THAT IS NOT A FILE IS NAMED, NOT SKIPPED.** This fixture's `.planning` is a link to the
      // checkout, and `.planning/` in the ignore block does not match a link, so git lists it — on Linux, where a
      // symlink is what it is; on Windows the junction reads as a directory and git says nothing. In a real
      // project `.planning` is a directory the block does ignore. Anything else that is not a regular file would
      // be something this scan has never looked inside, so it fails rather than being passed over.
      if (!statSync(join(p.dir, rel)).isFile()) {
        assert.equal(rel, ".planning", `${rel} is in the committed set and is not a file this scan can read`);
        continue;
      }
      const text = readFileSync(join(p.dir, rel), "utf-8");
      for (const secret of [PROVIDER_KEY, RESEARCH_KEY, ...derived])
        assert.equal(text.includes(secret), false, `${rel} carries a credential or something derived from one`);
      for (const header of headers) assert.equal(header.test(text), false, `${rel} carries an authorisation header`);
      for (const path of absolute)
        assert.equal(text.includes(path), false, `${rel} carries this machine's own path (${path})`);
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

    // ⚠️ **AND THAT COMMAND IS WHAT IS RUN.** Its argument list is taken from the journal rather than written
    // here; only npm and the canary are replaced, as they are in every case, because a test may not install a
    // dependency graph or send a provider a billable request.
    const recorded = journal.recovery.command;
    const argv = ["--project-root", p.dir, "--resume"];
    assert.ok(recorded.endsWith("--resume"), recorded);
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
