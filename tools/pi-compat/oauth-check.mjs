#!/usr/bin/env node
/**
 * TSK-0066, toward ACC-0091: a real OAuth `/login`, discovery after it, and a revocation control.
 *
 *   node tools/pi-compat/oauth-check.mjs --provider <id> --model <id>            # the manual run
 *   node tools/pi-compat/oauth-check.mjs --provider <id> --model <id> --dry-run  # baseline only
 *
 * ⚠️ **MANUAL, ACCOUNT-BOUND AND SINGLE-INSTANCE.** An operator completes `/login` against a real
 * subscription. Nothing here runs in CI, and the record is labelled so it is never read as a suite result.
 *
 * ⚠️ **THE PROVIDER AND MODEL ARE NAMED BEFORE THE RUN**, on the command line, and the baseline refuses
 * to continue unless that built-in model is in the catalogue and is NOT already available.
 *
 * ⚠️ **EVERY DISCOVERY IS A FRESH RUNTIME IN A FRESH PROCESS.** A runtime built before the login would
 * report a cached snapshot, and the harness's own environment could make a model available for a
 * reason unrelated to the login. Each reading is a new child with the allowlisted environment only,
 * constructing a new `ModelRuntime` and `ModelRegistry`, and a child that does not exit 0 is refused.
 *
 * ⚠️ **THE TUI IS NOT LOGGED.** Pi displays entered credentials (F13, EVD-0123). The TUI gets the
 * operator's terminal directly, and nothing captures it.
 *
 * ⚠️ **THE STORED CREDENTIAL NEVER OUTLIVES THE RUN.** The isolated directory is removed on every exit
 * path this process can see: completion, refusal, an exception, and SIGINT, SIGTERM or SIGHUP. A
 * process killed outright runs nothing, so each run first removes any `kiln-oauth-*` directory an
 * earlier run left behind.
 *
 * ⚠️ **AVAILABILITY IS NOT A WORKING REQUEST.** `getAvailable()` and `hasConfiguredAuth()` say a usable
 * credential is configured. No model request and no token refresh is made, and the record claims
 * neither.
 *
 * `--self-test <fault>` exists for test/pi-compat-oauth-harness.test.mjs. It plants a fake credential
 * instead of running the TUI, injects one fault, and can never save a record.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { spikeEnv } from "./lib/consumer.mjs";
import { redact, redactionViolations } from "./lib/redact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
// A subdirectory: every JSON directly under runs/ is a platform record to test/pi-compat.test.mjs.
const RUNS = join(HERE, "runs", "oauth");
const WORK_PREFIX = "kiln-oauth-";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] ?? null; };
const PROVIDER = flag("--provider");
const MODEL = flag("--model");
const DRY = args.includes("--dry-run");
const SELF_TEST = flag("--self-test");
const FAULTS = ["throw-after-credential", "leak-in-record", "leak-path-in-record", "discover-nonzero"];

/* ------------------------------------------------------------------ cleanup, on every exit path */

let WORK = null;
function cleanup() {
  if (WORK) {
    try { rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    WORK = null;
  }
}
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => { cleanup(); process.exit(130); });

function fail(message) {
  console.error(`oauth-check: ${message}`);
  process.exit(2);
}

if (!PROVIDER || !MODEL) fail("usage: oauth-check.mjs --provider <id> --model <id> [--dry-run]");
if (SELF_TEST && !FAULTS.includes(SELF_TEST)) fail(`unknown self-test fault; expected one of ${FAULTS.join(", ")}`);

const platformName = process.platform === "win32" ? "windows" : process.platform;
const OUT = join(RUNS, `oauth-${platformName}.json`);
// ⚠️ A RETAINED REAL-ACCOUNT RECORD IS NEVER OVERWRITTEN, and this is checked before anyone logs in.
if (!DRY && !SELF_TEST && existsSync(OUT)) fail(`${join("runs", "oauth", `oauth-${platformName}.json`)} already exists; a retained record is not overwritten`);

// ⚠️ WHAT A KILLED RUN LEFT BEHIND. Nothing runs in a process killed outright, so the next run removes it.
for (const entry of readdirSync(tmpdir()))
  if (entry.startsWith(WORK_PREFIX)) {
    try { rmSync(join(tmpdir(), entry), { recursive: true, force: true }); console.log(`  removed a leftover isolated directory from an earlier run`); } catch {}
  }

const piPkg = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent");
const manifest = JSON.parse(readFileSync(join(piPkg, "package.json"), "utf8"));
const PI_CLI = join(piPkg, typeof manifest.bin === "string" ? manifest.bin : manifest.bin.pi);
const PI_INDEX = pathToFileURL(join(piPkg, "dist", "index.js")).href;
const PINNED = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).dependencies["@earendil-works/pi-coding-agent"];

/** The launch arguments TSK-0065 used, so the TUI is the same one. */
const LAUNCH_ARGS = [
  "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
  "--no-context-files", "--no-approve", "--offline",
];

WORK = mkdtempSync(join(tmpdir(), WORK_PREFIX));
if (SELF_TEST) console.log(`WORK=${WORK}`);
const AGENT_DIR = join(WORK, "agent");
const PROJECT = join(WORK, "project");
for (const d of [AGENT_DIR, PROJECT]) mkdirSync(d, { recursive: true });
const AUTH = join(AGENT_DIR, "auth.json");
const MODELS = join(AGENT_DIR, "models.json");

/** The allowlisted environment: OS and runtime names only, and the isolated agent directory. */
const ENV = spikeEnv({ agentDir: AGENT_DIR });

/** One reading from a fresh runtime and registry, in a fresh process with the allowlisted environment. */
function discover(label) {
  const source = `
    const { ModelRuntime, ModelRegistry } = await import(${JSON.stringify(PI_INDEX)});
    const runtime = await ModelRuntime.create({ authPath: ${JSON.stringify(AUTH)}, modelsPath: ${JSON.stringify(MODELS)}, allowModelNetwork: false });
    const registry = new ModelRegistry(runtime);
    const model = registry.find(${JSON.stringify(PROVIDER)}, ${JSON.stringify(MODEL)});
    let status = null;
    try { status = registry.getProviderAuthStatus(${JSON.stringify(PROVIDER)}); } catch {}
    console.log(JSON.stringify({
      inCatalogue: Boolean(model),
      available: registry.getAvailable().some((m) => m.provider === ${JSON.stringify(PROVIDER)} && m.id === ${JSON.stringify(MODEL)}),
      hasConfiguredAuth: model ? registry.hasConfiguredAuth(model) : null,
      providerAuthStatus: status ? { configured: Boolean(status.configured), source: status.source ?? null } : null,
    }));
    ${SELF_TEST === "discover-nonzero" && label !== "baseline" ? "process.exitCode = 3;" : ""}`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: PROJECT, env: ENV, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
  });
  // ⚠️ PARSEABLE IS NOT ENOUGH. A child that printed a reading and then failed, was signalled or timed
  // out did not finish the reading it printed.
  if (r.error || r.signal || r.status !== 0)
    fail(`the ${label} discovery did not finish cleanly (exit ${r.status}, signal ${r.signal ?? "none"}${r.error ? `, ${r.error.code ?? "error"}` : ""})`);
  let reading = null;
  try { reading = JSON.parse((r.stdout ?? "").trim().split("\n").at(-1)); } catch {}
  if (!reading) fail(`the ${label} discovery produced no reading`);
  return { label, freshProcess: true, ...reading };
}

/** What the stored credential file holds, by provider and type only. */
function storedShape() {
  if (!existsSync(AUTH)) return { present: false, providers: {} };
  const parsed = JSON.parse(readFileSync(AUTH, "utf8"));
  return { present: true, providers: Object.fromEntries(Object.entries(parsed).map(([p, c]) => [p, { type: c?.type ?? null }])) };
}

/** Every string value in the provider's stored credential, to be used as a probe and then discarded. */
function credentialStrings() {
  if (!existsSync(AUTH)) return [];
  const out = [];
  const walk = (v) => {
    if (typeof v === "string" && v.length >= 8) out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(JSON.parse(readFileSync(AUTH, "utf8"))[PROVIDER]);
  return out;
}

/**
 * Refuse to keep a record carrying any 8-character run of any credential string, the username or the
 * home path. ⚠️ THE MESSAGE NAMES WHAT KIND OF THING WAS FOUND, NEVER THE THING.
 */
function assertSanitized(text, secrets) {
  for (const s of secrets)
    for (let i = 0; i + 8 <= s.length; i++)
      if (text.includes(s.slice(i, i + 8))) fail("the record carries part of a stored credential value; nothing was saved");
  const user = userInfo().username;
  if (user.length >= 3 && text.toLowerCase().includes(user.toLowerCase())) fail("the record carries the username; nothing was saved");
  if (text.includes(homedir()) || text.includes(JSON.stringify(homedir()).slice(1, -1))) fail("the record carries the home path; nothing was saved");
  const v = redactionViolations(text);
  if (v.length)
    fail(`the record retains ${v.length} machine-identifying fragment(s) (${[...new Set(v.map((x) => x.label))].join(", ")}); nothing was saved`);
}

try {
  /* ---------------------------------------------------------------- baseline */

  const baseline = discover("baseline");
  if (!baseline.inCatalogue) fail(`${PROVIDER}/${MODEL} is not a built-in model in Pi ${manifest.version}`);
  if (baseline.available || baseline.hasConfiguredAuth)
    fail(`${PROVIDER}/${MODEL} is already available before any login, so a login could not be shown to cause it`);
  console.log(`  baseline: ${PROVIDER}/${MODEL} is in the catalogue and unavailable, with no stored credential`);

  if (DRY) {
    console.log("  dry run: baseline only; no login, nothing saved");
    process.exit(0);
  }

  /* ---------------------------------------------------------------- the operator's login */

  let tui;
  if (SELF_TEST) {
    // ⚠️ A FAKE CREDENTIAL, FOR THE HARNESS'S OWN FAILURE PATHS ONLY. Self-test never saves a record.
    writeFileSync(AUTH, JSON.stringify({ [PROVIDER]: { type: "oauth", access: "selftest-access-9d2c71b4e0", refresh: "selftest-refresh-5a8e03f6c1", expires: Date.now() + 3600_000 } }) + "\n");
    tui = { status: 0 };
    if (SELF_TEST === "throw-after-credential") throw new Error("self-test: injected exception after a credential was stored");
  } else {
    console.log(`
  Pi will start in its full interactive TUI, isolated from your own configuration.
  Nothing on this screen is recorded.

    1. Type /login and press Enter.
    2. Choose the subscription sign-in, then select the provider for ${PROVIDER}.
    3. Complete the sign-in in the browser.
    4. When Pi reports you are logged in, exit Pi with /quit.
`);
    tui = spawnSync(process.execPath, [PI_CLI, ...LAUNCH_ARGS], { cwd: PROJECT, env: ENV, stdio: "inherit" });
  }
  const afterLogin = discover("after-login");
  const storedAfterLogin = storedShape();
  const secrets = credentialStrings();

  /* ---------------------------------------------------------------- the revocation control */

  // ⚠️ THE STORED CREDENTIAL IS REMOVED, AND ONLY IT. Anything else in the file is left as it was.
  if (existsSync(AUTH)) {
    const parsed = JSON.parse(readFileSync(AUTH, "utf8"));
    delete parsed[PROVIDER];
    writeFileSync(AUTH, JSON.stringify(parsed, null, 2) + "\n");
  }
  const afterRemoval = discover("after-removal");
  const storedAfterRemoval = storedShape();

  const record = {
    meta: {
      label: "manual, account-bound, single-instance; not a suite result",
      platform: process.platform,
      node: process.version,
      pinned: PINNED,
      piVersion: manifest.version,
      ranAt: new Date().toISOString(),
      provider: PROVIDER,
      model: MODEL,
      launchArgs: LAUNCH_ARGS,
      environmentNames: Object.keys(ENV).sort(),
      isolation: "PI_CODING_AGENT_DIR and the working directory are fresh temporary directories; the TUI was not logged",
      discovery: "each reading is a fresh process constructing a fresh ModelRuntime (allowModelNetwork: false) and ModelRegistry, and must exit 0",
      revocation: "the provider's entry was removed from the isolated auth.json",
    },
    baseline,
    login: { piExit: tui.status },
    afterLogin,
    storedAfterLogin,
    afterRemoval,
    storedAfterRemoval,
    limits: [
      "availability and hasConfiguredAuth show a usable credential is configured; no model request or token refresh was made",
      "manual, account-bound and single-instance: one operator, one subscription, one run",
    ],
  };

  let text = JSON.stringify(redact(record), null, 2) + "\n";
  if (SELF_TEST === "leak-in-record") text += secrets[0];
  if (SELF_TEST === "leak-path-in-record") text += "/home/kilnprobeuser/.pi/agent/auth.json\n";
  assertSanitized(text, secrets);
  secrets.length = 0;
  if (SELF_TEST) fail("self-test reached the save step; a self-test never saves a record");

  mkdirSync(RUNS, { recursive: true });
  // `wx`: refuse to replace a file that appeared since the check at startup.
  writeFileSync(OUT, text, { flag: "wx" });
  console.log(`
  after login  : available=${afterLogin.available} hasConfiguredAuth=${afterLogin.hasConfiguredAuth}
  after removal: available=${afterRemoval.available} hasConfiguredAuth=${afterRemoval.hasConfiguredAuth}
  saved ${join("tools", "pi-compat", "runs", "oauth", `oauth-${platformName}.json`)}
  The isolated configuration, including the stored token, is deleted on exit.`);
} catch (e) {
  // ⚠️ THE ERROR'S CLASS ONLY. A message could quote a credential or a path.
  fail(`stopped by an unexpected ${e?.name ?? "error"}; the isolated configuration is being deleted`);
} finally {
  cleanup();
}
