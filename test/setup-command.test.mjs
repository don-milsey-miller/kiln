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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { EXIT, SetupCommandRefusal, main, nodeSatisfies, parseArgs, renderChoices, resolvePaths, resumeCommand } from "../bin/setup.mjs";
import { IGNORE_RULES, blockText } from "../lib/project-gitignore.mjs";

const ROOT = join(import.meta.dirname, "..");

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
function project({ ignored = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-setup-"));
  const dir = join(root, "project");
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  symlinkSync(ROOT, join(dir, ".planning"), process.platform === "win32" ? "junction" : "dir");
  if (ignored) writeFileSync(join(dir, ".gitignore"), blockText());
  // ⚠️ AN AGENT DIRECTORY PER PROJECT, so a trust decision here is never the operator's own store.
  return { root, dir, contentRoot: join(dir, "planning-content"), agentDir: join(root, "agent") };
}

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
async function setup(p, argv = [], { answer = "fix-ignore", install, env = {}, trust = "approve" } = {}) {
  const printed = [];
  const seen = { atInstall: null, installs: 0, asks: [] };
  const saved = process.env.PLANNING_CONTENT_DIR;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PLANNING_CONTENT_DIR = p.contentRoot;
  // ⚠️ PI'S OWN STATE GOES IN THE FIXTURE, not in the operator's home: the trust decision is recorded for real.
  process.env.PI_CODING_AGENT_DIR = p.agentDir;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    const code = await main(["--project-root", p.dir, "--name", "Test Project", ...(trust ? ["--trust", trust] : []), ...argv], {
      print: (line) => printed.push(line),
      // ⚠️ EVERY QUESTION IS RECORDED, not just answered: "did not ask" is the assertion a non-interactive run needs.
      ask: async (question) => {
        seen.asks.push(question);
        return answer;
      },
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
    assert.equal((await setup(p)).code, EXIT.OK);
    assert.deepEqual(tree(p.dir), after, "a rerun with unchanged inputs changed bytes");
    // Including the times: a rerun that rewrites identical content still churns them.
    const idPath = join(p.dir, ".pi", "kiln.json");
    const mtime = statSync(idPath).mtimeMs;
    assert.equal((await setup(p)).code, EXIT.OK);
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
    const o = await setup(p);
    assert.equal(o.code, EXIT.OK, o.printed.join("\n"));

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

    assert.equal((await setup(p)).code, EXIT.OK);
    const after = settingsOf(p);
    assert.deepEqual(after.packages, ["../their-package", "../.planning/pi-package"], "an unrelated package entry was disturbed");
    assert.deepEqual(after.theirKey, { kept: true }, "an unrelated key was lost");
    assert.equal(after.defaultModel, "somebody-elses-choice", "the registration merge overwrote a selection");

    // A rerun adds nothing a second time and changes no bytes.
    const bytes = readFileSync(join(p.dir, ".pi", "settings.json"), "utf-8");
    assert.equal((await setup(p)).code, EXIT.OK);
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
  } finally {
    rmSync(r.root, { recursive: true, force: true });
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
