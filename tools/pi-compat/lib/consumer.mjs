/**
 * A real clean consumer for the Pi compatibility spike.
 *
 * ⚠️ THIS REPLACES A FIXTURE THAT ONLY LOOKED LIKE ONE. The first version created a bare
 * `.planning/pi-package` directory and then ran Pi out of THIS repository's `node_modules`, so the
 * assertion the whole exercise exists to make — that a consumer resolves the pinned runtime from
 * its own `.planning/node_modules` — was the one thing it never touched. It also hard-coded one
 * developer's scratch path, so nobody else could run it.
 *
 * What a consumer actually is, and what this builds:
 *   <tmp>/                     generated, never a hard-coded path
 *   ├── .git/                  an UNBORN repository: `git init` with no commits, which is the
 *   │                          documented first-run state and the one most likely to be untested
 *   ├── .planning/             the tool, copied from `git ls-files` — tracked files only, so a
 *   │   ├── node_modules/      file that exists locally and was never committed fails here
 *   │   └── pi-package/        rather than on a stranger's first clone
 *   └── planning-content/
 */
import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * ⚠️ AN ALLOWLIST, NEVER A DENYLIST, and the distinction is the entire point of this function.
 * Removing `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` by name would leave every provider variable
 * nobody thought of — and the spike's own finding is that `PI_CODING_AGENT_DIR` isolates the stored
 * auth file and does nothing whatever about environment authentication. A run that inherits the
 * host environment can reach a paid provider no matter where its config directory points.
 *
 * These are OS and runtime variables only. Nothing here authenticates anything.
 */
const BASE_ALLOWLIST = [
  // POSIX
  "PATH", "HOME", "LANG", "LC_ALL", "SHELL", "TMPDIR", "USER", "TERM",
  // Windows
  "SystemRoot", "SystemDrive", "windir", "COMSPEC", "PATHEXT", "TEMP", "TMP",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
];

/**
 * Build the environment a spike child runs in.
 *
 * ⚠️ `exact` REPLACES THE ALLOWLIST ENTIRELY, and it exists because the default one always carries
 * `HOME`. A claim of the form "a child resolves its configuration with no HOME at all" cannot be
 * made by a harness that always supplies one — the retained Linux report said `HOME: true` while
 * `AST-0044` claimed the opposite. A cell that needs a precise environment names it.
 *
 * @param {{agentDir?: string, sessionDir?: string, extra?: Record<string,string>,
 *          sentinels?: boolean, exact?: Record<string,string>}} opts
 */
export function spikeEnv({ agentDir, sessionDir, extra = {}, sentinels = false, exact = null } = {}) {
  const env = {};
  if (exact) {
    for (const [k, v] of Object.entries(exact)) if (v !== undefined) env[k] = v;
  } else {
    for (const name of BASE_ALLOWLIST) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
  }
  if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
  if (sessionDir) env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  if (sentinels) {
    // Deliberately shaped like credentials so a leak is unmistakable, and deliberately not real.
    env.KILN_SENTINEL_API_KEY = "sentinel-not-a-real-key";
    env.KILN_SENTINEL_TOKEN = "sentinel-not-a-real-token";
  }
  return { ...env, ...extra };
}

/** Names a run must never pass on, asserted rather than assumed. */
export const FORBIDDEN_IN_CHILD = [
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "GROQ_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AZURE_OPENAI_API_KEY", "TAVILY_API_KEY",
];

/** Tracked files only — `git ls-files`, so an uncommitted local file cannot make the run pass. */
function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  return out.split("\0").filter(Boolean);
}

/**
 * @param {{install?: boolean, keep?: string}} opts
 *   install: run `npm install` inside `.planning`, which is what proves local Pi resolution.
 *   keep:    reuse an existing consumer directory instead of building one (for repeated runs).
 */
export function createConsumer({ install = true, keep = null } = {}) {
  const dir = keep ? realpathSync(keep) : realpathSync(mkdtempSync(join(tmpdir(), "kiln-pi-compat-")));
  const tool = join(dir, ".planning");
  const agentDir = join(dir, ".pi-agent-isolated");
  const built = existsSync(join(tool, "package.json"));
  let installOutput = null;

  if (!built) {
    mkdirSync(tool, { recursive: true });
    for (const rel of trackedFiles()) {
      const dest = join(tool, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(REPO_ROOT, rel), dest);
    }
    mkdirSync(join(dir, "planning-content"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    // ⚠️ AN UNBORN REPOSITORY: `git init` and no commit. That is the state section 4.1 documents
    // as the first thing a consumer does, and the state in which `.gitignore` planning and every
    // `git`-shaped assumption is least likely to have been exercised.
    // ⚠️ NO FALLBACK. An earlier version created an empty `.git` directory when git was missing,
    // which then satisfied the unborn-repository assertion without a repository existing at all —
    // a false pass dressed as resilience. If git is unavailable the spike cannot make the claim,
    // so it refuses rather than making it anyway.
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  }

  if (install && !existsSync(join(tool, "node_modules", "@earendil-works", "pi-coding-agent"))) {
    // The consumer's own install, into the consumer's own tree. Slow and load-bearing: without it
    // there is no `.planning/node_modules` and nothing to resolve the runtime from.
    // ⚠️ A FIXED COMMAND STRING, not an args array with `shell: true`. Node 20+ refuses to spawn
    // `npm.cmd` without a shell, and passing an args array alongside `shell: true` earns a
    // deprecation warning precisely because arguments are concatenated rather than escaped. There
    // is nothing to escape here — every character is a literal in this file, none of it derived
    // from a path, an argument or the environment — so the single-string form is both correct and
    // quiet.
    // ⚠️ CAPTURED, NOT INHERITED. `ACC-0040` names command output as a surface the redaction claim
    // covers, and output that goes straight to the terminal is output nothing can scan. npm prints
    // absolute paths freely, so this is the noisiest surface of the lot.
    try {
      const out = execSync("npm install --no-audit --no-fund --loglevel=error", {
        cwd: tool, encoding: "utf8", timeout: 900_000, stdio: ["ignore", "pipe", "pipe"],
      });
      installOutput = { status: 0, stdout: out ?? "", stderr: "" };
    } catch (e) {
      installOutput = { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      throw new Error(`the consumer's npm install failed (exit ${installOutput.status}):\n${installOutput.stderr.slice(-2000)}`);
    }
  }

  return { dir, tool, agentDir, pkgDir: join(tool, "pi-package"), installOutput };
}

/**
 * Resolve the CLI the way a consumer must: through the COPIED tool's installed package metadata,
 * never through this repository and never through PATH. Returns the path and the version it
 * reports, so a caller can assert both.
 */
export function resolvePiFromConsumer(tool) {
  const pkgRoot = join(tool, "node_modules", "@earendil-works", "pi-coding-agent");
  const manifestPath = join(pkgRoot, "package.json");
  if (!existsSync(manifestPath))
    throw new Error(`No Pi runtime under ${pkgRoot}. The consumer's own install has not run.`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const binRel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
  if (!binRel) throw new Error(`The installed Pi package declares no \`bin.pi\`: ${manifestPath}`);
  const cli = join(pkgRoot, binRel);
  if (!existsSync(cli)) throw new Error(`\`bin.pi\` points at ${cli}, which does not exist.`);
  return { cli, version: manifest.version, pkgRoot, indexUrl: `file://${join(pkgRoot, "dist", "index.js").replace(/\\/g, "/")}` };
}

/** The version this repository pins, read from the manifest rather than restated in a test. */
export function pinnedPiVersion() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const spec = pkg.dependencies?.["@earendil-works/pi-coding-agent"];
  if (!spec) throw new Error("This repository declares no pinned Pi dependency.");
  return spec;
}

/** Write the probe package into the consumer's `.planning/pi-package`. */
export const PROMPT_MARKER = "PROMPT-BODY-MARKER-7C2E";

export function writeProbePackage(pkgDir, extensionSource) {
  // ⚠️ **CLEARED FIRST, BECAUSE THE CONSUMER ALREADY HAS A REAL `pi-package/` IN IT.** `createConsumer`
  // copies every tracked file into `.planning/`, and Kiln now ships its own package there. Writing the
  // probe fixture over it left both present: Pi discovered `kiln-probe` AND `kiln-planning`, and the
  // skill-override row measured a directory holding two packages' worth of skills. This directory is
  // inside a throwaway consumer, and what the spike measures is Pi's behaviour against a package it
  // controls entirely — not against whatever Kiln's package happens to contain this week.
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(join(pkgDir, "extensions"), { recursive: true });
  mkdirSync(join(pkgDir, "skills", "kiln-probe"), { recursive: true });
  mkdirSync(join(pkgDir, "prompts"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
    name: "@kiln/spike-probe", private: true, version: "0.1.0", keywords: ["pi-package"],
    pi: { extensions: ["./extensions/index.ts"], skills: ["./skills"], prompts: ["./prompts"] },
  }, null, 2) + "\n");
  // ⚠️ A PROMPT TEMPLATE WHOSE BODY IS THE OBSERVABLE. Invoked as `/kiln-probe-prompt`, a loaded
  // template expands to this text and the fake provider sees the marker in the user message; an
  // unloaded one leaves the literal slash string. The observation is at the provider boundary,
  // upstream of anything the model says — there is no extension-side event reporting which prompt
  // templates were discovered, so this is the only honest way to see it.
  writeFileSync(join(pkgDir, "prompts", "kiln-probe-prompt.md"),
    ["---", "description: Spike-only prompt template.", "---", `${PROMPT_MARKER} respond briefly.`, ""].join("\n"));
  writeFileSync(join(pkgDir, "extensions", "index.ts"), extensionSource);
  writeFileSync(join(pkgDir, "skills", "kiln-probe", "SKILL.md"),
    ["---", "name: kiln-probe", "description: Spike-only skill.", "---", "", "BODY-MARKER: PACKAGED", ""].join("\n"));
}

/**
 * A models.json naming ONE loopback model, written into the isolated agent directory.
 *
 * ⚠️ EVERY RUN THAT CAN REACH INFERENCE MUST ALSO PASS `--model`. The sanitized environment is the
 * first defence and this is the second: even a run that somehow acquired a credential resolves a
 * model that points at 127.0.0.1.
 */
export const FAKE_PROVIDER = "kiln-spike";
export const FAKE_MODEL = "spike-model";

export function writeFakeModels(agentDir, port) {
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [FAKE_PROVIDER]: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "spike-placeholder-not-a-real-key",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: FAKE_MODEL, name: "Spike Model", contextWindow: 128000, maxTokens: 4096 }],
      },
      // ⚠️ A PROVIDER AUTHENTICATED ONLY BY AN ENVIRONMENT VARIABLE. `models.json` interpolates
      // `$VAR` into `apiKey`, which is the exact shape section 3.4's credential contract exists
      // for: the model must be available in a child carrying the variable and unavailable in one
      // that is not. It lives in the REAL models file because `--models` is a NAME FILTER and not a
      // path — pointing it at a file yields `No models match pattern <path>`, which is how the
      // first version of this cell managed to fail in both directions and still look like a result.
      [ENV_AUTH_PROVIDER]: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: `$${ENV_AUTH_VAR}`,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: ENV_AUTH_MODEL, name: "Env Auth Model", contextWindow: 128000, maxTokens: 4096 }],
      },
    },
  }, null, 2) + "\n");
}

export const ENV_AUTH_PROVIDER = "kiln-envauth";
export const ENV_AUTH_MODEL = "env-auth-model";
export const ENV_AUTH_VAR = "KILN_PROBE_PROVIDER_KEY";

export const modelArgs = () => ["--model", `${FAKE_PROVIDER}/${FAKE_MODEL}`];
