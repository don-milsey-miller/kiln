/**
 * The Pi compatibility contract, proved against the pinned runtime as a consumer resolves it.
 *
 * Every claim has a control that would fail if the claimed behaviour were absent. Every run passes
 * a sanitized environment AND an explicit loopback model, so reproduction on a host that has
 * provider credentials in its environment still cannot reach a paid provider.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ENV_AUTH_MODEL, ENV_AUTH_VAR, FAKE_MODEL, FAKE_PROVIDER, PROMPT_MARKER, REPO_ROOT,
  createConsumer, modelArgs, pinnedPiVersion, resolvePiFromConsumer, spikeEnv, writeFakeModels,
  writeProbePackage, FORBIDDEN_IN_CHILD,
} from "./consumer.mjs";
import { PROBE_EXTENSION, reachedObservationPoint } from "./probe.mjs";

const AUTH_PROVIDER = "kiln-authtest";
const AUTH_MODEL = "auth-probe-model";

export async function runSpike({ port = 8099, keep = null, install = true, onLog = () => {} } = {}) {
  const results = { meta: { platform: process.platform, node: process.version, ranAt: new Date().toISOString() } };
  // Every captured subprocess surface, so the redaction claim covers command output and error text
  // rather than only the summary. Declared first because the consumer build already produces some.
  const captured = [];
  const consumer = createConsumer({ install, keep });
  const { dir, tool, agentDir, pkgDir } = consumer;

  /* ---------------------------------------------------- A. the consumer runtime resolves locally */

  // ⚠️ A `--keep` RUN REUSES AN INSTALL AND SO CAPTURES NO npm OUTPUT. That makes its record
  // strictly less complete than a clean one, which matters because the retained evidence is what
  // `ACC-0040` is evaluated against. Recorded rather than left to be inferred from an absence.
  results.meta.consumerWasReused = !consumer.installOutput;
  if (consumer.installOutput) captured.push({ label: "npm install", ...consumer.installOutput });

  const pin = pinnedPiVersion();
  const resolved = resolvePiFromConsumer(tool);
  const CLI = resolved.cli;
  results.consumerRuntime = {
    pinnedInManifest: pin,
    versionInstalledInConsumer: resolved.version,
    matchesPin: resolved.version === pin,
    cliInsideConsumer: realpathSync(CLI).startsWith(realpathSync(dir)),
    cliInsideDevelopmentCheckout: realpathSync(CLI).startsWith(realpathSync(REPO_ROOT)),
    // ⚠️ ASKED OF GIT, NOT OF THE FILESYSTEM. An earlier version checked for the absence of
    // `.git/refs/heads/main`, which a repository committed on `master` also satisfies — and which
    // an empty `.git` directory satisfies best of all. `rev-parse --verify HEAD` failing while the
    // work tree is real is what "initialised and never committed" actually means.
    ...unbornRepositoryCheck(dir),
    toolCopyHasPackageJson: existsSync(join(tool, "package.json")),
  };
  onLog(`consumer runtime: pi ${resolved.version} (pin ${pin}) resolved inside the consumer`);

  writeProbePackage(pkgDir, PROBE_EXTENSION);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2) + "\n");
  writeFakeModels(agentDir, port);

  const MARKER = join(dir, "marker.txt");
  const REPORT = join(dir, "report.json");
  const PROVIDER_LOG = join(dir, "provider-requests.json");

  // ⚠️ `exact` MUST BE FORWARDED, and the first version of this wrapper silently dropped it — so a
  // cell asking for a precise environment quietly got the default allowlist instead, HOME included.
  // The self-contradiction in the recorded result (`homeWasPassed: false` beside
  // `varsPresent.HOME: true`) is what exposed it. Recording both halves is why it was catchable.
  function pi(args, label, { env = {}, sentinels = false, sessionDir, exact = null } = {}) {
    rmSync(MARKER, { force: true });
    rmSync(REPORT, { force: true });
    // ⚠️ THE EFFECTIVE ENVIRONMENT, COMPUTED ONCE AND RECORDED. An earlier version recorded the
    // caller's partial object as `passedNames` while this wrapper went on to add the marker, report
    // and label variables — so a cell claiming "exactly three variables" was passing six. Whatever
    // is recorded has to be the thing that was actually handed to the child.
    const effectiveEnv = spikeEnv({
      agentDir, sessionDir, sentinels, exact,
      extra: { KILN_SPIKE_MARKER: MARKER, KILN_SPIKE_REPORT: REPORT, KILN_SPIKE_LABEL: label, ...env },
    });
    const res = spawnSync(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: effectiveEnv,
      encoding: "utf8", timeout: 180_000, shell: false,
      stdio: ["ignore", "pipe", "pipe"], // stdin CLOSED, per the approved child contract
    });
    let report = null;
    if (existsSync(REPORT)) { try { report = JSON.parse(readFileSync(REPORT, "utf8")); } catch {} }
    const events = (res.stdout ?? "").trim().split("\n")
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const run = { status: res.status, loaded: existsSync(MARKER), report, events,
      stdout: res.stdout ?? "", stderr: res.stderr ?? "", effectiveEnvNames: Object.keys(effectiveEnv).sort() };
    run.reachedObservationPoint = reachedObservationPoint(run);
    // ⚠️ RETAINED SO THE REDACTION CLAIM COVERS WHAT IT SAYS IT COVERS. `ACC-0040` names command
    // output and error text, and a test that scans only a summary is not scanning those. Every
    // child's stdout and stderr goes into the saved artefact and through the same redaction.
    captured.push({ label, argv: args, status: res.status, stdout: run.stdout, stderr: run.stderr });
    return run;
  }

  /* ---------------------------------------------------- B. the package entry pi writes */

  const install1 = spawnSync(process.execPath, [CLI, "install", "-l", "./.planning/pi-package"], {
    cwd: dir, env: spikeEnv({ agentDir }), encoding: "utf8", timeout: 300_000, shell: false,
  });
  captured.push({ label: "pi install -l", status: install1.status, stdout: install1.stdout ?? "", stderr: install1.stderr ?? "" });
  const settingsPath = join(dir, ".pi", "settings.json");
  const written = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : null;
  const entry = written?.packages?.[0] ?? null;
  results.packageEntry = {
    installExit: install1.status,
    entry,
    isRelative: entry ? !/^([A-Za-z]:[\\/]|\/)/.test(entry) : null,
    containsHomePath: entry ? /Users|home/.test(entry) : null,
    separatorNormalised: entry ? entry.replace(/\\/g, "/") : null,
  };
  onLog(`package entry: ${JSON.stringify(entry)}`);

  /* ---------------------------------------------------- C. trust, five rows */

  const { ProjectTrustStore, ModelRuntime, ModelRegistry, VERSION } =
    await import(resolved.indexUrl);
  results.meta.piVersionFromModule = VERSION;

  const store = new ProjectTrustStore(agentDir);
  const canonical = realpathSync(dir);
  const TASK = "KILN-TASK-SENTINEL-9F3A reply ok";
  const ARGS = [...modelArgs(), "--mode", "json", "-p", TASK, "--no-session"];

  results.trust = [];
  const trustRow = (n, label, decision, args) => {
    if (decision !== "skip") store.set(canonical, decision);
    const r = pi(args, `trust${n}`);
    results.trust.push({ run: n, label, loaded: r.loaded, status: r.status,
      reachedObservationPoint: r.reachedObservationPoint,
      eventTypes: r.events.map((e) => e.type) });
    onLog(`trust ${n} ${label.padEnd(18)} loaded=${r.loaded}`);
    return r;
  };
  trustRow(1, "no decision", null, ARGS);
  trustRow(2, "--approve", null, [...ARGS, "--approve"]);
  const trusted = trustRow(3, "API set(true)", true, ARGS);
  trustRow(4, "API set(false)", false, ARGS);
  trustRow(5, "API set(null)", null, ARGS);
  store.set(canonical, true);
  results.trustStoreShape = existsSync(join(agentDir, "trust.json"))
    ? Object.keys(JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8"))).length
    : 0;

  /* ---------------------------------------------------- D. tools */

  results.tools = {
    defaultActive: trusted.report?.activeTools ?? null,
    allConfigured: trusted.report?.allTools ?? null,
    allowlisted: pi([...ARGS, "--tools", "read,kiln_spike_probe"], "allowlist").report?.activeTools ?? null,
  };

  /* ---------------------------------------------------- E. child environment */

  const sanitized = pi(ARGS, "sanitized");
  const sentinelControl = pi(ARGS, "sentinels", { sentinels: true });
  results.childEnv = {
    sanitized: {
      forbiddenPresent: sanitized.report?.forbiddenPresent ?? null,
      sentinelsVisible: sanitized.report?.sentinelsVisible ?? null,
      envVarCount: sanitized.report?.envVarCount ?? null,
      varsPresent: sanitized.report?.varsPresent ?? null,
    },
    sentinelControl: {
      sentinelsVisible: sentinelControl.report?.sentinelsVisible ?? null,
      envVarCount: sentinelControl.report?.envVarCount ?? null,
    },
    parentHasForbidden: FORBIDDEN_IN_CHILD.filter((n) => process.env[n] !== undefined).sort(),
  };

  /* ---------------------------------------------------- F. what the OS adds, isolated from Pi */

  // ⚠️ THIS CONTROL IS RETAINED, and it is narrower than the claim it first supported. A bare Node
  // child excludes Pi as the source; it does NOT separate the operating system from Node/libuv's
  // own process-creation path. What it establishes is the observable the product depends on: a
  // Node-spawned child on this platform receives these names whatever environment it was handed.
  const bare = spawnSync(process.execPath,
    ["-e", "console.log(JSON.stringify(Object.keys(process.env).sort()))"],
    { env: { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "" },
      encoding: "utf8", shell: false });
  const passedNames = ["SystemRoot", "PATH"];
  const seen = bare.stdout?.trim() ? JSON.parse(bare.stdout) : [];
  results.osInjection = {
    method: "node -e, env replaced with two names, no Pi involved",
    passed: passedNames,
    observed: seen,
    addedBeyondWhatWasPassed: seen.filter((n) => !passedNames.includes(n)),
    exit: bare.status,
    rawStdout: bare.stdout ?? "",
  };
  onLog(`os injection: child received ${seen.length} names having been passed ${passedNames.length}`);

  /* ---------------------------------------------------- G/H/I. model-dependent proofs */

  const provider = spawn(process.execPath, [join(REPO_ROOT, "tools", "pi-compat", "fake-provider.mjs")], {
    env: { ...spikeEnv({ agentDir }), FAKE_PROVIDER_PORT: String(port), FAKE_PROVIDER_LOG: PROVIDER_LOG },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // ⚠️ THE FAKE PROVIDER IS A SUBPROCESS TOO, and its streams carry request bodies. Accumulated
  // rather than sampled, and retained with the rest so the redaction claim covers it.
  const providerOut = { stdout: "", stderr: "" };
  provider.stdout.on("data", (d) => { providerOut.stdout += String(d); });
  provider.stderr.on("data", (d) => { providerOut.stderr += String(d); });
  await new Promise((r, reject) => {
    const t = setTimeout(() => reject(new Error("fake provider did not start")), 20_000);
    provider.stdout.once("data", () => { clearTimeout(t); r(); });
  });

  try {
    rmSync(PROVIDER_LOG, { force: true });
    const turn = pi(ARGS, "turn");
    const reqs = existsSync(PROVIDER_LOG) ? JSON.parse(readFileSync(PROVIDER_LOG, "utf8")) : [];
    results.taskBinding = {
      exit: turn.status,
      stdinClosed: true,
      sentinelReachedProvider: reqs.some((r) =>
        r.messages.some((m) => m.role === "user" && m.text.includes("KILN-TASK-SENTINEL-9F3A"))),
      toolsOfferedToModel: reqs[0]?.toolNames ?? [],
      eventTypes: turn.events.map((e) => e.type),
    };

    // skills override, with the removal control
    const overrideDir = join(dir, "planning-content", "skills-overrides", "kiln-probe");
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(join(overrideDir, "SKILL.md"),
      ["---", "name: kiln-probe", "description: Spike-only skill.", "---", "", "BODY-MARKER: OVERRIDE", ""].join("\n"));
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    s.skills = ["../planning-content/skills-overrides"];
    writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
    const marked = (run) => (run.report?.skills ?? []).map((k) => ({
      name: k.name,
      marker: k.filePath && existsSync(k.filePath)
        ? (readFileSync(k.filePath, "utf8").match(/BODY-MARKER: (\w+)/) ?? [])[1] ?? null : null,
    }));
    results.skills = { withOverride: marked(pi(ARGS, "override")) };
    rmSync(join(dir, "planning-content", "skills-overrides"), { recursive: true, force: true });
    results.skills.overrideRemovedControl = marked(pi(ARGS, "nooverride"));

    // session relocation, three routes
    // ⚠️ CLEARED EACH RUN. With `--keep` reusing a consumer these directories accumulate across
    // runs, and a count of 2 would read as a second transcript rather than as yesterday's.
    const extA = join(dir, "external-a", "sessions");
    const extB = join(dir, "external-b", "sessions");
    rmSync(join(dir, "external-a"), { recursive: true, force: true });
    rmSync(join(dir, "external-b"), { recursive: true, force: true });
    rmSync(join(dir, ".pi", "sessions"), { recursive: true, force: true });
    mkdirSync(extA, { recursive: true }); mkdirSync(extB, { recursive: true });
    pi([...modelArgs(), "--mode", "json", "-p", "hi", "--session-dir", extA], "sessflag");
    pi([...modelArgs(), "--mode", "json", "-p", "hi"], "sessenv", { sessionDir: extB });
    const s2 = JSON.parse(readFileSync(settingsPath, "utf8"));
    s2.sessionDir = ".pi/sessions";
    writeFileSync(settingsPath, JSON.stringify(s2, null, 2) + "\n");
    pi([...modelArgs(), "--mode", "json", "-p", "hi"], "sesssetting");
    results.sessionRelocation = {
      flag: readdirSync(extA).length,
      envVar: readdirSync(extB).length,
      setting: existsSync(join(dir, ".pi", "sessions")) ? readdirSync(join(dir, ".pi", "sessions")).length : 0,
    };

    // the live-canary shape, with two controls
    const tc = pi([...modelArgs(), "--mode", "json", "--no-session",
      "-p", "CALL-TOOL:kiln_spike_probe CHALLENGE:abc123xyz go"], "toolcall");
    const prose = pi([...modelArgs(), "--mode", "json", "--no-session", "-p", "just prose please"], "prose");
    const excluded = pi([...modelArgs(), "--mode", "json", "--no-session", "--tools", "read",
      "-p", "CALL-TOOL:kiln_spike_probe CHALLENGE:abc123xyz go"], "excluded");
    results.canary = {
      toolCalls: tc.report?.toolCalls ?? [],
      proseControl: prose.report?.toolCalls ?? [],
      excludedControl: { activeTools: excluded.report?.activeTools, toolCalls: excluded.report?.toolCalls ?? [] },
    };

    /* ------------------------------------------------ J. authentication and model discovery */

    results.authDiscovery = await proveAuthDiscovery({ agentDir, port, ModelRuntime, ModelRegistry });

    /* ------------------------------------------------ K. no HOME at all */

    // ⚠️ A DEDICATED EXACT ENVIRONMENT. The default allowlist always carries HOME, so a run using
    // it can never support the claim that PI_CODING_AGENT_DIR alone suffices — and the retained
    // Linux report said `HOME: true` while the assertion said otherwise. This run names its whole
    // environment, and HOME is deliberately absent from it.
    const noHomeEnv = {
      PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: agentDir,
      ...(process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT, TEMP: process.env.TEMP }
        : { TMPDIR: process.env.TMPDIR ?? "/tmp" }),
    };
    const noHome = pi(ARGS, "nohome", { exact: noHomeEnv });
    // ⚠️ CONFIGURATION-LOCATING VARIABLES, NOT "EXACTLY THREE". The wrapper adds its own marker,
    // report and label variables, so the honest claim is about which HOME/config names were supplied
    // — none but the override — and the effective list is recorded so the two can be checked apart.
    const CONFIG_LOCATING = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_STATE_HOME"];
    results.noHome = {
      effectiveEnvNames: noHome.effectiveEnvNames,
      configLocatingNamesSupplied: noHome.effectiveEnvNames.filter((n) => CONFIG_LOCATING.includes(n)),
      overrideSupplied: noHome.effectiveEnvNames.includes("PI_CODING_AGENT_DIR"),
      homeWasPassed: noHome.effectiveEnvNames.some((k) => k === "HOME" || k === "USERPROFILE"),
      loaded: noHome.loaded,
      status: noHome.status,
      varsPresent: noHome.report?.varsPresent ?? null,
      // ⚠️ ON POSIX THIS IS THE WHOLE CLAIM. On Windows the platform repopulates USERPROFILE
      // whatever is passed, so the honest reading there is "the override is sufficient", never
      // "the child had no home".
      homeVisibleToChild: Boolean(noHome.report?.varsPresent?.HOME || noHome.report?.varsPresent?.USERPROFILE),
    };

    /* ------------------------------------------------ L. default vs overridden config directory */

    // Where does Pi resolve its agent directory with NO override, and does the override move it?
    // Asked of a child rather than in-process, because this process already imported the module.
    const askAgentDir = (env, label) => {
      const r = spawnSync(process.execPath,
        ["--input-type=module", "-e",
          "const m = await import(" + JSON.stringify(resolved.indexUrl) + "); console.log(m.getAgentDir());"],
        { env, encoding: "utf8", timeout: 60_000, shell: false });
      captured.push({ label, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
      return (r.stdout ?? "").trim();
    };
    const fakeHome = join(dir, "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    const defaultEnv = {
      PATH: process.env.PATH, HOME: fakeHome, USERPROFILE: fakeHome,
      ...(process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, APPDATA: join(fakeHome, "AppData", "Roaming"), LOCALAPPDATA: join(fakeHome, "AppData", "Local") }
        : { TMPDIR: process.env.TMPDIR ?? "/tmp" }),
    };
    const defaultResolved = askAgentDir(defaultEnv, "getAgentDir default");
    const overriddenResolved = askAgentDir({ ...defaultEnv, PI_CODING_AGENT_DIR: agentDir }, "getAgentDir overridden");
    results.configDir = {
      defaultUnderFakeHome: defaultResolved,
      defaultIsUnderHome: defaultResolved.startsWith(fakeHome),
      overridden: overriddenResolved,
      overrideResolvesToAgentDir: safeJson(() => realpathSync(overriddenResolved) === realpathSync(agentDir)),
      // ⚠️ THE CONTROL. Without it, "the override wins" is satisfied by an override that changed
      // nothing because the default already pointed there.
      overrideActuallyMoved: defaultResolved !== overriddenResolved,
    };

    /* ------------------------------------------------ M. provider-scoped environment auth */

    // ⚠️ THE CASE THE CREDENTIAL CONTRACT EXISTS FOR, and nothing exercised it before. The models
    // file declares a provider whose key is `$KILN_PROBE_PROVIDER_KEY`, so it is authenticated
    // ONLY by an environment variable. The model must be available in a child that carries the
    // variable and unavailable in one that does not — the second run being the control without
    // which the first proves nothing.
    const listModels = (extraEnv, label) => {
      const r = spawnSync(process.execPath, [CLI, "--list-models"], {
        cwd: dir,
        env: spikeEnv({ agentDir, extra: extraEnv }),
        encoding: "utf8", timeout: 120_000, shell: false, stdio: ["ignore", "pipe", "pipe"],
      });
      captured.push({ label, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
      return { text: (r.stdout ?? "") + (r.stderr ?? ""), status: r.status };
    };
    const withEnvKey = listModels({ [ENV_AUTH_VAR]: "env-provided-probe-key-not-real" }, "--list-models with env key");
    const withoutEnvKey = listModels({}, "--list-models without env key");
    results.providerEnvAuth = {
      shape: `models.json provider with apiKey: $${ENV_AUTH_VAR}`,
      withKeyExit: withEnvKey.status,
      withoutKeyExit: withoutEnvKey.status,
      availableWithEnvKey: withEnvKey.text.includes(ENV_AUTH_MODEL),
      availableWithoutEnvKey: withoutEnvKey.text.includes(ENV_AUTH_MODEL),
      // The inline-key provider must be listed in BOTH, or the two runs differ by more than the
      // variable and the comparison is not isolating anything.
      inlineKeyProviderListedInBoth:
        withEnvKey.text.includes(FAKE_MODEL) && withoutEnvKey.text.includes(FAKE_MODEL),
    };

    /* ------------------------------------------------ N. packaged prompt loading */

    rmSync(PROVIDER_LOG, { force: true });
    const promptRun = pi([...modelArgs(), "--mode", "json", "--no-session", "-p", "/kiln-probe-prompt"], "prompt");
    const promptReqs = existsSync(PROVIDER_LOG) ? JSON.parse(readFileSync(PROVIDER_LOG, "utf8")) : [];
    const lastUser = promptReqs.at(-1)?.messages?.filter((m) => m.role === "user").at(-1)?.text ?? "";
    results.promptTemplate = {
      invoked: "/kiln-probe-prompt",
      // ⚠️ THE OBSERVABLE IS THE EXPANSION AT THE PROVIDER. A loaded template's body arrives; an
      // unloaded one leaves the literal slash string, which is the control condition.
      expandedBodyReachedProvider: lastUser.includes(PROMPT_MARKER),
      literalSlashStringReachedProvider: lastUser.includes("/kiln-probe-prompt"),
      exit: promptRun.status,
    };

    // ⚠️ THE CONTROL, AND IT IS A SEPARATE RUN. `literalSlashStringReachedProvider: false` in the
    // SAME run is not a control — it is the other half of one observation, and it would read the
    // same way if the template had expanded for some reason unrelated to package loading. The real
    // control revokes trust so the package (and its prompts) do not load at all, and requires the
    // literal slash string to survive to the provider instead of a body marker.
    store.set(canonical, false);
    rmSync(PROVIDER_LOG, { force: true });
    const promptUntrusted = pi([...modelArgs(), "--mode", "json", "--no-session", "-p", "/kiln-probe-prompt"], "prompt-untrusted");
    const untrustedReqs = existsSync(PROVIDER_LOG) ? JSON.parse(readFileSync(PROVIDER_LOG, "utf8")) : [];
    const untrustedUser = untrustedReqs.at(-1)?.messages?.filter((m) => m.role === "user").at(-1)?.text ?? "";
    store.set(canonical, true);
    results.promptTemplate.untrustedControl = {
      packageLoaded: promptUntrusted.loaded,
      expandedBodyReachedProvider: untrustedUser.includes(PROMPT_MARKER),
      literalSlashStringReachedProvider: untrustedUser.includes("/kiln-probe-prompt"),
      reachedObservationPoint: promptUntrusted.reachedObservationPoint,
    };

    /* ------------------------------------------------ O. package entry canonical equivalence */

    // ⚠️ THE PROOF THE DESIGN REQUIRES BEFORE PERMITTING THE REWRITE. Recording that two spellings
    // differ only by separator is not the same as showing they name one directory.
    const resolveFromSettings = (e) => realpathSync(join(dir, ".pi", e));
    results.packageEntry.canonicalEquivalence = safeJson(() => ({
      rawResolvesTo: resolveFromSettings(results.packageEntry.entry),
      normalisedResolvesTo: resolveFromSettings(results.packageEntry.separatorNormalised),
      identical: resolveFromSettings(results.packageEntry.entry) === resolveFromSettings(results.packageEntry.separatorNormalised),
      andItIsThePackageDirectory: resolveFromSettings(results.packageEntry.separatorNormalised) === realpathSync(pkgDir),
    }));
  } finally {
    provider.kill("SIGTERM");
  }

  captured.push({ label: "fake provider", status: 0, ...providerOut });

  // ⚠️ GENERATED STATE IS A NAMED SURFACE. The provider's request log and the settings file the
  // install produced are files the suite created, and a criterion that says "generated state" has
  // to mean something. Retained as text and redacted with everything else.
  // ⚠️ PUSHED UNCONDITIONALLY, WITH A `present` FLAG. Guarding each on `existsSync` meant a missing
  // file silently reduced coverage: the criterion enumerates three generated surfaces, and a test
  // asking only whether ANY of them was captured would pass with one. Each is now always recorded,
  // so an absent file is a visible false rather than a shorter list.
  for (const [label, path] of [
    ["generated: provider-requests.json", PROVIDER_LOG],
    ["generated: .pi/settings.json", join(dir, ".pi", "settings.json")],
    ["generated: trust.json", join(agentDir, "trust.json")],
  ]) {
    const present = existsSync(path);
    captured.push({ label, status: 0, present, stdout: present ? readFileSync(path, "utf8") : "", stderr: "" });
  }

  results.consumerDir = dir;
  results.captured = captured;
  return results;
}

/**
 * Section 6.2's discovery step, settled against the surface that actually exists.
 *
 * ⚠️ `AuthStorage` IS A CLASS IN THE PACKAGE AND IS NOT REACHABLE. It lives at
 * `dist/core/auth-storage.js` and the package's `exports` map publishes only ".", "./rpc-entry" and
 * "./client", so a deep import is blocked. The supported surface is `ModelRuntime.create()` plus
 * `ModelRegistry`, and `readStoredCredential` from the root for a one-off presence read.
 *
 * ⚠️ `allowModelNetwork` DEFAULTS TO FALSE, which is what lets discovery satisfy the rule that the
 * consent-gated check contacts no external service.
 */
async function proveAuthDiscovery({ agentDir, port, ModelRuntime, ModelRegistry }) {
  const authPath = join(agentDir, "auth.json");
  const modelsPath = join(agentDir, "models-authprobe.json");

  // Two providers: one with an inline key (always available) and one with none, whose availability
  // must therefore turn on a stored credential — that second one is the actual experiment.
  writeFileSync(modelsPath, JSON.stringify({
    providers: {
      [FAKE_PROVIDER]: {
        baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions",
        apiKey: "spike-placeholder-not-a-real-key",
        models: [{ id: FAKE_MODEL, name: "Spike Model", contextWindow: 128000, maxTokens: 4096 }],
      },
      [AUTH_PROVIDER]: {
        baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions",
        models: [{ id: AUTH_MODEL, name: "Auth Probe Model", contextWindow: 128000, maxTokens: 4096 }],
      },
    },
  }, null, 2) + "\n");

  const snapshot = async (label) => {
    const runtime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false });
    const registry = new ModelRegistry(runtime);
    const all = registry.getAll().map((m) => `${m.provider}/${m.id}`);
    const available = registry.getAvailable().map((m) => `${m.provider}/${m.id}`).sort();
    const target = registry.find(AUTH_PROVIDER, AUTH_MODEL);
    const status = safeJson(() => registry.getProviderAuthStatus(AUTH_PROVIDER));
    const hasAuth = target ? registry.hasConfiguredAuth(target) : null;
    return {
      label,
      // ⚠️ SIZES, NOT THE LIST. `getAll()` returns the entire built-in catalogue — over a thousand
      // models across every provider pi knows about, whether or not any of them can be used. A
      // discovery step that presented `getAll()` would offer the operator a thousand models they
      // cannot authenticate. `getAvailable()` is the one to present.
      catalogueSize: all.length,
      availableCount: available.length,
      availableProviders: [...new Set(available.map((m) => m.split("/")[0]))].sort(),
      probeModelInCatalogue: all.includes(`${AUTH_PROVIDER}/${AUTH_MODEL}`),
      probeModelAvailable: available.includes(`${AUTH_PROVIDER}/${AUTH_MODEL}`),
      hasConfiguredAuth: hasAuth,
      providerAuthStatus: status,
      providerDisplayName: safeJson(() => registry.getProviderDisplayName(AUTH_PROVIDER)),
      isUsingOAuth: target ? safeJson(() => registry.isUsingOAuth(target)) : null,
      // ⚠️ THE TRAP THIS PROBE FOUND. `getProviderAuthStatus()` can report `configured: true` while
      // `hasConfiguredAuth()` is false and the model is absent from `getAvailable()`. Anything that
      // gates on "is some authentication source configured" alone will tell an operator they are
      // connected when they cannot infer.
      statusDisagreesWithAvailability:
        Boolean(status?.configured) !== Boolean(hasAuth),
    };
  };

  // CONTROL first: no credential at all. The model must be configured but unavailable.
  rmSync(authPath, { force: true });
  const withoutCredential = await snapshot("no stored credential");

  // Then a stored API key, written the way `/login` would leave one.
  writeFileSync(authPath, JSON.stringify({
    [AUTH_PROVIDER]: { type: "api_key", key: "stored-probe-key-not-real" },
  }, null, 2) + "\n");
  const withApiKey = await snapshot("stored api_key credential");

  // And an OAuth credential in the canonical shape pi-ai declares — `{ type, refresh, access,
  // expires }`, not the `*_token`/`expires_at` spelling a reader might assume.
  writeFileSync(authPath, JSON.stringify({
    [AUTH_PROVIDER]: {
      type: "oauth", refresh: "probe-refresh-not-real", access: "probe-access-not-real",
      expires: Date.now() + 3600_000,
    },
  }, null, 2) + "\n");
  const withOAuth = await snapshot("stored oauth credential, canonical shape");

  rmSync(authPath, { force: true });

  return {
    supportedSurface: {
      authStorageExportedFromRoot: false,
      note: "AuthStorage exists at dist/core/auth-storage.js but the package exports map does not publish it.",
      usedInstead: ["ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false })", "ModelRegistry", "readStoredCredential"],
      networkDefaultsOff: true,
    },
    withoutCredential,
    withApiKey,
    withOAuth,
    // ⚠️ WHAT THIS DOES NOT ESTABLISH, stated rather than left to be assumed. A provider declared
    // in `models.json` is composed with apiKey auth only — pi-ai's `ProviderAuth` notes that even
    // keyless local servers supply apiKey auth — so a stored OAuth credential for such a provider
    // has no flow to resolve it and the model stays unavailable. OAuth discovery for a BUILT-IN
    // provider therefore remains unproved here: proving it needs a real interactive `/login`
    // against a real account, which is account-bound and cannot run in CI.
    oauthProvedForCustomProvider: false,
    oauthRemainsOpenForBuiltInProviders: true,
  };
}

function safeJson(fn) {
  try { const v = fn(); return typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v; }
  catch (e) { return { error: String(e?.message ?? e) }; }
}

/**
 * "Initialised and never committed", asked of git rather than of the filesystem.
 *
 * ⚠️ THE PREVIOUS CHECK COULD FALSE-PASS TWO WAYS. It looked for the absence of
 * `.git/refs/heads/main`, which a repository committed on `master` also satisfies — and which an
 * empty `.git` directory satisfies best of all. What "unborn" means is that HEAD does not resolve
 * while the work tree is real, so that is what this asks.
 */
function unbornRepositoryCheck(dir) {
  const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8", shell: false });
  const insideWorkTree = git(["rev-parse", "--is-inside-work-tree"]).stdout?.trim() === "true";
  const head = git(["rev-parse", "--verify", "HEAD"]);
  const commitCount = git(["rev-list", "--count", "--all"]).stdout?.trim();
  return {
    insideWorkTree,
    headResolves: head.status === 0,
    commitCount: commitCount === "" ? null : Number(commitCount),
    unbornRepository: insideWorkTree && head.status !== 0 && commitCount === "0",
  };
}
