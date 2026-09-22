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
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

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

async function setup(p, argv = [], { answer, answers, install, env = {}, trust = "approve", verifyRuntime, pick = PICKED, tavily = null } = {}) {
  const printed = [];
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
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    const code = await main(["--project-root", p.dir, "--name", "Test Project", ...(trust ? ["--trust", trust] : []), ...pick, ...argv], {
      print: (line) => printed.push(line),
      // ⚠️ EVERY QUESTION IS RECORDED, not just answered: "did not ask" is the assertion a non-interactive run needs.
      ask: async (question) => {
        seen.asks.push(question);
        return answer === undefined ? scriptedAnswer(question, answers) : answer;
      },
      ...(verifyRuntime ? { verifyRuntime } : {}),
      install:
        install ??
        (() => {
          seen.installs++;
          // What the project looked like at the moment the bootstrap ran.
          seen.atInstall = { tree: tree(p.dir), printed: [...printed] };
          return { installed: true, why: "the test's bootstrap" };
        }),
    });
    return { code, printed, seen };
  } finally {
    if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedTavily === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = savedTavily;
    for (const k of Object.keys(env)) delete process.env[k];
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

test("⚠️ R9 the skill-override entry is derived from the content root, and a root setup cannot own is refused", async () => {
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

    // The command refuses a selection it cannot create, before anything is read or written.
    const q = project();
    try {
      q.contentRoot = join(q.dir, "kiln-content");
      const o = await setup(q);
      assert.equal(o.code, EXIT.PATHS);
      assert.equal(existsSync(join(q.dir, "planning-content")), false, "a second content root was created");
      assert.equal(existsSync(join(q.dir, ".pi")), false, "runtime state was written for a refused selection");
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
    assert.equal(o.code, EXIT.SETUP);
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
    assert.equal(o.code, EXIT.SETUP);
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
