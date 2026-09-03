/**
 * The Pi compatibility contract — CMP-0041, in the normal suite.
 *
 * ⚠️ **WHY THIS IS A TEST AND NOT A SCRIPT.** Every design position in the agent-delivery layer
 * rests on something the pinned runtime does: the trust API, the package entry, what a child
 * inherits, whether a closed-stdin task arrives. A spike proves those once, against one version, on
 * one afternoon. Only a test makes a later `@earendil-works/pi-coding-agent` bump RE-PROVE them
 * instead of inheriting them, which is the whole of `TSK-0023`.
 *
 * ⚠️ **ONE ASSERTION FUNCTION, TWO SOURCES.** `assertContract()` is applied to the retained results
 * AND to a freshly-run live spike. An earlier version asserted eleven things about the retained
 * files and four about the live run, so the advertised "live re-proof" could pass after
 * package-entry normalisation, tools, skills, sessions, task binding, environment behaviour or
 * authentication discovery had all regressed. A live tier that checks less than the record is a
 * live tier in name.
 *
 *  - The default tier reads `tools/pi-compat/runs/` — fast, no Pi process, and it additionally
 *    checks what only the record can answer: that both platforms are present and that nothing
 *    machine-identifying survived redaction.
 *  - The live tier re-runs the spike against a real consumer install. Slow, so it is gated behind
 *    `KILN_PI_COMPAT=live` and enabled on one CI cell.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { redactionViolations, redact } from "../tools/pi-compat/lib/redact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(ROOT, "tools", "pi-compat", "runs");
const PINNED = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  .dependencies["@earendil-works/pi-coding-agent"];

const load = (name) => JSON.parse(readFileSync(join(RUNS, name), "utf8"));
const platforms = () => readdirSync(RUNS).filter((f) => f.endsWith(".json"));

/**
 * Everything the design positions rest on, asserted against one result set.
 *
 * `where` names the source so a failure says whether the record or the live run disagreed.
 */
export function assertContract(r, where) {
  const at = (m) => `${where}: ${m}`;

  /* -- the consumer runtime, and the negative half that the first fixture failed -------------- */
  assert.equal(r.consumerRuntime.matchesPin, true, at("the installed version does not match the pin"));
  assert.equal(r.consumerRuntime.versionInstalledInConsumer, PINNED, at("consumer installed a different version"));
  assert.equal(r.consumerRuntime.cliInsideConsumer, true, at("the CLI was not resolved from the consumer's own .planning"));
  assert.equal(r.consumerRuntime.cliInsideDevelopmentCheckout, false,
    at("the CLI resolved inside the development checkout, so local Pi resolution is unproved"));
  assert.equal(r.consumerRuntime.insideWorkTree, true, at("the fixture is not a git work tree"));
  assert.equal(r.consumerRuntime.headResolves, false, at("HEAD resolves, so the repository is not unborn"));
  assert.equal(r.consumerRuntime.commitCount, 0, at("the fixture repository has commits"));
  assert.equal(r.consumerRuntime.unbornRepository, true, at("the fixture was not an unborn git repository"));

  /* -- trust: causal only because denial and revocation revert it ---------------------------- */
  const byRun = Object.fromEntries(r.trust.map((t) => [t.run, t]));
  assert.equal(byRun[1].loaded, false, at("row 1 must reproduce the silent untrusted load"));
  assert.equal(byRun[2].loaded, true, at("row 2 is the fixture control — the extension must be loadable"));
  assert.equal(byRun[3].loaded, true, at("the public trust API must grant"));
  assert.equal(byRun[4].loaded, false, at("an explicit denial must be honoured"));
  assert.equal(byRun[5].loaded, false, at("revoking must revert, or row 3 is correlation"));
  for (const row of r.trust)
    assert.equal(row.reachedObservationPoint, true,
      at(`run ${row.run} never reached the point where the marker would be written, so its result is void`));

  /* -- the package entry, and the equivalence proof the rewrite depends on ------------------- */
  assert.equal(r.packageEntry.isRelative, true, at("the package entry is not relative"));
  assert.equal(r.packageEntry.containsHomePath, false, at("the package entry contains a home path"));
  const eq = r.packageEntry.canonicalEquivalence;
  assert.equal(eq.identical, true,
    at("the raw and separator-normalised entries do not resolve to one directory, so normalising is not a safe rewrite"));
  assert.equal(eq.andItIsThePackageDirectory, true, at("the entry does not resolve to the package directory"));

  /* -- tools: the default set is still the hazard #68 named ---------------------------------- */
  for (const dangerous of ["bash", "edit", "write"])
    assert.ok(r.tools.defaultActive.includes(dangerous),
      at(`${dangerous} is no longer active by default — decision #68's hazard has changed shape`));
  assert.deepEqual(r.tools.allowlisted, ["read", "kiln_spike_probe"], at("--tools did not narrow the set"));

  /* -- the credential boundary, with its control --------------------------------------------- */
  assert.deepEqual(r.childEnv.sanitized.sentinelsVisible, [], at("a sentinel crossed into the child"));
  assert.deepEqual(r.childEnv.sanitized.forbiddenPresent, [], at("a provider credential name reached the child"));
  assert.ok(r.childEnv.sentinelControl.sentinelsVisible.length >= 2,
    at("the control did not show sentinels crossing, so the clean result proves nothing"));

  /* -- provider-scoped environment authentication -------------------------------------------- */
  assert.equal(r.providerEnvAuth.availableWithEnvKey, true,
    at("a provider authenticated only by an environment variable was unavailable with the variable set"));
  assert.equal(r.providerEnvAuth.availableWithoutEnvKey, false,
    at("the env-authenticated model was available WITHOUT its variable, so the variable is not what makes it usable"));
  assert.equal(r.providerEnvAuth.inlineKeyProviderListedInBoth, true,
    at("the two runs differ by more than the variable, so the comparison isolates nothing"));

  /* -- configuration directory: default, override, and the control --------------------------- */
  assert.equal(r.configDir.defaultIsUnderHome, true, at("the default agent directory is not under HOME"));
  assert.equal(r.configDir.overrideResolvesToAgentDir, true, at("PI_CODING_AGENT_DIR did not select the directory"));
  assert.equal(r.configDir.overrideActuallyMoved, true,
    at("the override resolved where the default already was, so 'the override wins' is vacuous"));

  /* -- no HOME: the claim is POSIX-only, and is stated that way ------------------------------- */
  // ⚠️ ASSERTED OVER THE EFFECTIVE ENVIRONMENT, not over the caller's intent. The claim is about
  // which configuration-locating names were supplied — none but the override — and NOT "exactly
  // three variables", which was never true: the wrapper adds its own marker, report and label.
  assert.deepEqual(r.noHome.configLocatingNamesSupplied, [],
    at("a home or config-locating variable was supplied to the no-HOME run"));
  assert.equal(r.noHome.overrideSupplied, true, at("the no-HOME run was not given PI_CODING_AGENT_DIR"));
  assert.equal(r.noHome.homeWasPassed, false, at("the no-HOME run was given a home variable"));
  assert.ok((r.noHome.effectiveEnvNames ?? []).length > 0, at("the effective environment was not recorded"));
  assert.equal(r.noHome.loaded, true, at("the package did not load without a home variable"));
  assert.equal(r.noHome.status, 0, at("the no-HOME run did not complete"));
  if (r.meta.platform === "win32") {
    // ⚠️ NOT AN EXCEPTION, A DIFFERENT CLAIM. Windows repopulates USERPROFILE whatever is passed,
    // so the honest statement there is "the override is sufficient", never "the child had no home".
    assert.equal(r.noHome.varsPresent.USERPROFILE, true,
      at("Windows no longer repopulates USERPROFILE — AST-0045 should be revisited"));
  } else {
    assert.equal(r.noHome.homeVisibleToChild, false,
      at("a home variable reached the child on POSIX, so AST-0044's no-HOME claim is not exercised"));
  }

  /* -- skills, prompts, sessions, task binding, canary ---------------------------------------- */
  assert.deepEqual(r.skills.withOverride, [{ name: "kiln-probe", marker: "OVERRIDE" }], at("the override did not win"));
  assert.deepEqual(r.skills.overrideRemovedControl, [{ name: "kiln-probe", marker: "PACKAGED" }],
    at("removing the override did not restore the packaged skill"));

  assert.equal(r.promptTemplate.expandedBodyReachedProvider, true,
    at("a packaged prompt template did not expand, so package prompt loading is unproved"));
  assert.equal(r.promptTemplate.literalSlashStringReachedProvider, false,
    at("the literal slash string reached the provider, which is the unloaded-template condition"));
  // ⚠️ THE CONTROL IS A SEPARATE RUN WITH TRUST REVOKED. The two halves above come from ONE run and
  // are one observation, not an observation and its control — they would read the same way if the
  // template had expanded for a reason unrelated to package loading.
  const pc = r.promptTemplate.untrustedControl;
  assert.equal(pc.packageLoaded, false, at("the control run loaded the package, so it controls nothing"));
  assert.equal(pc.expandedBodyReachedProvider, false, at("an unloaded package still expanded its prompt template"));
  assert.equal(pc.literalSlashStringReachedProvider, true,
    at("the literal slash string did not survive when the package was absent, so the positive result is unexplained"));
  assert.equal(pc.reachedObservationPoint, true, at("the prompt control run never reached its observation point"));

  assert.equal(r.sessionRelocation.flag, 1, at("--session-dir did not relocate the transcript"));
  assert.equal(r.sessionRelocation.envVar, 1, at("the session env var did not relocate the transcript"));
  assert.equal(r.sessionRelocation.setting, 1, at("the sessionDir setting did not place the transcript"));

  assert.equal(r.taskBinding.stdinClosed, true, at("stdin was not closed"));
  assert.equal(r.taskBinding.sentinelReachedProvider, true, at("the task did not reach the provider"));

  assert.deepEqual(r.canary.toolCalls, [{ challenge: "abc123xyz" }], at("the challenge did not arrive intact"));
  assert.deepEqual(r.canary.proseControl, [], at("a prose reply executed a tool"));
  assert.deepEqual(r.canary.excludedControl.toolCalls, [], at("an excluded tool was still executed"));

  /* -- what the OS adds ----------------------------------------------------------------------- */
  if (r.meta.platform === "win32") {
    assert.ok(r.osInjection.addedBeyondWhatWasPassed.includes("USERPROFILE"),
      at("USERPROFILE is no longer injected, which changes how a child is redirected"));
  } else {
    assert.deepEqual(r.osInjection.addedBeyondWhatWasPassed, [],
      at("POSIX added names to a child that were not passed, contradicting the exactness claim"));
  }

  /* -- authentication discovery, and the trap ------------------------------------------------- */
  const a = r.authDiscovery;
  assert.equal(a.withoutCredential.probeModelAvailable, false, at("a model was available with no credential"));
  assert.equal(a.withApiKey.probeModelAvailable, true, at("a stored API key did not make the model available"));
  assert.ok(a.withoutCredential.catalogueSize > 100,
    at("getAll() no longer returns the whole catalogue — the getAvailable() instruction may be stale"));
  assert.equal(a.withOAuth.statusDisagreesWithAvailability, true,
    at("the auth status/availability disagreement no longer reproduces — re-check the launch gate"));
}

/* ------------------------------------------------------------------ the retained record */

test("the contract was proved on both supported platforms, against the pinned version", () => {
  const files = platforms();
  assert.ok(files.includes("windows.json"), "no retained Windows result");
  assert.ok(files.includes("linux.json"), "no retained POSIX result");

  for (const f of files) {
    const r = load(f);
    assert.ok(r.meta?.platform, `${f}: no platform recorded`);
    assert.ok(r.meta?.node, `${f}: no Node version recorded`);
    // ⚠️ THE MECHANISM THAT MAKES A BUMP RE-PROVE RATHER THAN INHERIT.
    assert.equal(
      r.consumerRuntime.pinnedInManifest,
      PINNED,
      `${f} was taken against pin ${r.consumerRuntime.pinnedInManifest}, but this repository now pins ` +
        `${PINNED}. Re-run \`node tools/pi-compat/run-all.mjs\` on both platforms.`
    );
  }
});

test("the retained results satisfy the whole contract", () => {
  for (const f of platforms()) assertContract(load(f), f);
});

/* ------------------------------------------------------------------ ACC-0040 */

test("no captured surface contains credential material or a machine path", () => {
  for (const f of platforms()) {
    const r = load(f);

    // ⚠️ OVER THE CAPTURED BYTES, NOT A SUMMARY OF THEM. `ACC-0040` names command output, logs and
    // error text, and an earlier version of this test scanned only the summary object — which is
    // not those. Every child's stdout and stderr, and npm's, is retained under `captured` and
    // scanned here alongside the file as a whole.
    const whole = readFileSync(join(RUNS, f), "utf8");
    assert.deepEqual(redactionViolations(whole), [],
      `${f} retains machine-identifying or credential-shaped content`);

    assert.ok(Array.isArray(r.captured) && r.captured.length > 0,
      `${f}: no captured subprocess output was retained, so the redaction claim covers nothing`);
    assert.equal(r.meta.consumerWasReused, false,
      `${f} was produced by a --keep run that reused an existing install, so it captures no npm ` +
        `output and under-covers this criterion. Regenerate it with a clean ` +
        `\`node tools/pi-compat/run-all.mjs\`.`);
    // ⚠️ THE NAMED SURFACES, EACH REQUIRED. The criterion is only as good as what is retained, and
    // an earlier version retained the Pi child streams and nothing else — so `pi install -l`, the
    // fake provider, and the files the suite generated were all outside a claim that named them.
    for (const required of ["npm install", "pi install -l", "fake provider"])
      assert.ok(r.captured.some((c) => c.label === required),
        `${f}: ${required} is not among the captured surfaces, so the redaction claim does not cover it`);
    // ⚠️ EACH NAMED SURFACE, NOT "AT LEAST ONE". `ACC-0040` enumerates three generated files, and an
    // assertion satisfied by any single `generated:` entry would pass while two of them had
    // silently stopped being captured — which is exactly what the producer's conditional
    // `existsSync` made possible. Present AND non-empty, so a path regression cannot pass as a file
    // that happens to be missing.
    for (const label of [
      "generated: provider-requests.json",
      "generated: .pi/settings.json",
      "generated: trust.json",
    ]) {
      const entry = r.captured.find((c) => c.label === label);
      assert.ok(entry, `${f}: ${label} was not retained, and ACC-0040 names it`);
      assert.equal(entry.present, true, `${f}: ${label} was recorded as absent, so its bytes were never scanned`);
      assert.ok((entry.stdout ?? "").length > 0, `${f}: ${label} was retained empty`);
    }

    for (const c of r.captured) {
      for (const stream of ["stdout", "stderr"]) {
        const violations = redactionViolations(c[stream] ?? "");
        assert.deepEqual(violations, [],
          `${f}: captured ${c.label} ${stream} retains ${JSON.stringify(violations.slice(0, 3))}`);
      }
    }
  }
});

test("redaction is deterministic and would catch what it claims to catch", () => {
  // ⚠️ A REDACTOR NOBODY TESTS IS A REDACTOR THAT MIGHT BE A NO-OP. Feed it the things the
  // criterion forbids and require them gone; feed it the same input twice and require one answer.
  const BS = String.fromCharCode(92);
  const forbidden = [
    `C:${BS}Users${BS}somebody${BS}AppData${BS}Local${BS}Temp${BS}thing`,
    "/home/somebody/.pi/agent/auth.json",
    "/Users/somebody/Library/thing",
    "authorization: Bearer abcdef0123456789",
    "sk-abcdefghijklmnop",
  ];

  // ⚠️ THE DETECTOR MUST SEE EACH SHAPE BEFORE THE REDACTOR IS ASKED TO REMOVE IT. A redactor
  // stronger than its detector is not safe, it is lucky: the scan then passes on forbidden bytes
  // whenever the redactor happens to miss one too.
  for (const f of forbidden)
    assert.ok(redactionViolations(f).length > 0, `the detector does not see ${JSON.stringify(f)}`);

  // ⚠️ AND IT MUST SEE THEM ONCE SERIALISED, which is the form the retained bytes are actually in.
  // A Windows path becomes `C:\\Users\\...` with every separator escaped, and a pattern requiring a
  // single separator walks straight past it. That was reproduced against the committed shape before
  // it was fixed, which is why this assertion exists rather than the raw-string one alone.
  const asJson = JSON.stringify({ paths: forbidden });
  for (const f of forbidden.slice(0, 3)) {
    const encoded = JSON.stringify(f).slice(1, -1);
    assert.ok(redactionViolations(encoded).length > 0,
      `the detector misses ${JSON.stringify(encoded)} once JSON-escaped`);
  }

  const sample = forbidden.join(String.fromCharCode(10));
  const once = redact(sample);
  assert.equal(once, redact(sample), "redaction is not deterministic");
  assert.deepEqual(redactionViolations(once), [], `redaction left: ${JSON.stringify(redactionViolations(once))}`);
  assert.deepEqual(redactionViolations(redact(asJson)), [],
    `redaction left content in the serialised form: ${JSON.stringify(redactionViolations(redact(asJson)))}`);
});

/* ------------------------------------------------------------------ the live tier */

test("the live contract re-proves against the pinned runtime", { skip: liveSkip() }, async () => {
  const { runSpike } = await import("../tools/pi-compat/lib/spike.mjs");
  const { rmSync } = await import("node:fs");
  let consumerDir = null;
  try {
    const r = await runSpike({ port: 8096 });
    consumerDir = r.consumerDir;
    // ⚠️ THE SAME FUNCTION THE RECORD IS HELD TO. Anything less and a regression in a behaviour the
    // record checks could pass the live tier while the tier is advertised as the stronger one.
    assertContract(r, "live run");
    assert.deepEqual(redactionViolations(JSON.stringify(redact(r))), [],
      "the live result set does not survive its own redaction");
  } finally {
    // ⚠️ EACH LIVE RUN BUILDS A CONSUMER WITH ITS OWN `node_modules` — several hundred packages.
    // Removed here rather than in `runSpike`, because `run-all.mjs --keep` deliberately reuses one.
    //
    // ⚠️ BEST-EFFORT, AND DELIBERATELY NOT AN ASSERTION. On Windows this raised EPERM once because
    // a just-killed child still held a handle under the tree — and failing the compatibility test
    // for that would report "the contract regressed" when the contract had passed and only the
    // housekeeping had not. A settle plus retries clears it in practice; a leftover directory is
    // reported rather than thrown, because the test's subject is Pi's behaviour and not the
    // filesystem's timing.
    if (consumerDir) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        rmSync(consumerDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      } catch (e) {
        console.error(`[pi-compat] could not remove the live consumer at ${consumerDir}: ${e.code ?? e.message}`);
      }
    }
  }
});

function liveSkip() {
  if (process.env.KILN_PI_COMPAT === "live") return false;
  return "set KILN_PI_COMPAT=live to re-run the spike against a real consumer install (slow: builds a project and runs npm install)";
}
