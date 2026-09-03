#!/usr/bin/env node
/**
 * Run the whole Pi compatibility spike and save a redacted result set under `runs/`.
 *
 *   node tools/pi-compat/run-all.mjs [--port 8099] [--keep <dir>] [--no-install]
 *
 * `--keep` reuses an already-built consumer, which skips the `npm install` that dominates the
 * runtime. `--no-install` builds the consumer layout without installing, and is only useful for
 * checking the fixture itself — the runtime proofs need `.planning/node_modules`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runSpike } from "./lib/spike.mjs";
import { redact, redactionViolations } from "./lib/redact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const results = await runSpike({
  port: Number(flag("--port", 8099)),
  keep: flag("--keep", null),
  install: !args.includes("--no-install"),
  onLog: (m) => console.log(`  ${m}`),
});

const platform = results.meta.platform === "win32" ? "windows" : results.meta.platform;
const outDir = join(HERE, "runs");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${platform}.json`);

// ⚠️ REDACT BEFORE WRITING, never assert afterwards that the paths happened not to appear.
const redacted = redact(results);
const text = JSON.stringify(redacted, null, 2) + "\n";

const violations = redactionViolations(text);
if (violations.length) {
  console.error("\nREFUSING TO SAVE: redaction left machine-identifying content behind:");
  for (const v of violations.slice(0, 10)) console.error(`  ${v.label}: ${v.fragment}`);
  process.exit(2);
}

writeFileSync(outFile, text);
console.log(`\nsaved ${outFile}`);

const r = results;
console.log(`
  consumer runtime : pi ${r.consumerRuntime.versionInstalledInConsumer} (pin ${r.consumerRuntime.pinnedInManifest}), inside consumer=${r.consumerRuntime.cliInsideConsumer}, inside dev checkout=${r.consumerRuntime.cliInsideDevelopmentCheckout}
  package entry    : ${JSON.stringify(r.packageEntry.entry)} relative=${r.packageEntry.isRelative}
  trust            : ${r.trust.map((t) => `${t.run}:${t.loaded ? "Y" : "n"}`).join(" ")}
  default tools    : ${JSON.stringify(r.tools.defaultActive)}
  allowlisted      : ${JSON.stringify(r.tools.allowlisted)}
  child env        : forbidden=${JSON.stringify(r.childEnv.sanitized.forbiddenPresent)} sentinels=${JSON.stringify(r.childEnv.sanitized.sentinelsVisible)} control=${JSON.stringify(r.childEnv.sentinelControl.sentinelsVisible)}
  os injection     : passed ${r.osInjection.passed.length}, received ${r.osInjection.observed.length}
  task binding     : sentinel reached provider=${r.taskBinding.sentinelReachedProvider}
  skills           : ${JSON.stringify(r.skills.withOverride)} control=${JSON.stringify(r.skills.overrideRemovedControl)}
  sessions         : flag=${r.sessionRelocation.flag} env=${r.sessionRelocation.envVar} setting=${r.sessionRelocation.setting}
  canary           : ${JSON.stringify(r.canary.toolCalls)} prose=${JSON.stringify(r.canary.proseControl)}
  auth discovery   : catalogue=${r.authDiscovery.withoutCredential.catalogueSize} available: none=${r.authDiscovery.withoutCredential.availableCount} apiKey=${r.authDiscovery.withApiKey.availableCount} oauth=${r.authDiscovery.withOAuth.availableCount}
  auth status trap : oauth status=${JSON.stringify(r.authDiscovery.withOAuth.providerAuthStatus)} hasConfiguredAuth=${r.authDiscovery.withOAuth.hasConfiguredAuth} disagree=${r.authDiscovery.withOAuth.statusDisagreesWithAvailability}
`);
