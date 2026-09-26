#!/usr/bin/env node
/**
 * `npm run research:probe` — is research usable on this host, right now?
 *
 * This is 7a step 2 pointed at the real backend instead of a stub. It calls `research_capability`,
 * which calls the adapter's live probe (`GET /usage`), so it answers with a **measured** result
 * rather than "the key looks set" — #121's detectability half, and the difference #67 measured.
 *
 * ⚠️ **It never prints the key**, and it takes no key as an argument: reading it from the process
 * environment is the whole point (DEC-0006), and a key passed on a command line would land in shell
 * history — a model-visible-adjacent surface the credential contract exists to avoid.
 *
 * ⚠️ **A search credit is not spent.** The probe uses the usage endpoint, which is why that endpoint
 * was part of choosing this backend (#128).
 */

import { resolve } from "node:path";

import { createResearchTools } from "../lib/research/tools.mjs";
import { createTavilyAdapter, TAVILY } from "../lib/research/tavily-adapter.mjs";
import { researchPermission } from "../lib/research/permission.mjs";

// ⚠️ THE PROJECT IS NAMED, AND ITS RESEARCH MUST BE PERMITTED, BEFORE THE PROBE (F4, ACC-0120). A probe contacts Tavily
// with the key, so it is research like any other: the project must have chosen Tavily and this computer granted it.
const at = process.argv.indexOf("--project-root");
const root = at >= 0 ? process.argv[at + 1] : undefined;
const modeAt = process.argv.indexOf("--local-state");
const stateMode = modeAt >= 0 ? process.argv[modeAt + 1] : "project";
const gate = root ? researchPermission({ projectRoot: resolve(root), stateMode }) : null;
const out = !root || !gate.permitted ? null : await createResearchTools(createTavilyAdapter()).research_capability();

if (!root) {
  console.error("REFUSED     research-no-project-context");
  console.error("detail      Name the project whose research choice and consent apply: npm run research:probe -- --project-root <dir>.");
  process.exitCode = 2;
} else if (!gate.permitted) {
  console.error(`REFUSED     ${gate.reason}`);
  console.error(`detail      ${gate.detail}`);
  process.exitCode = 1;
} else if (out.available) {
  const q = out.quota ?? {};
  const quota =
    q.remaining === null || q.remaining === undefined
      ? "unknown (the usage response did not carry a readable plan/limit — reported as unknown, not assumed fine)"
      : `${q.remaining} of ${q.limit} credits remaining (${q.used} used)`;
  console.log(`available   backend=${out.backend}  probed live, no search credit spent`);
  console.log(`quota       ${quota}`);
  console.log(`tools       ${Object.keys(out.signatures).join(", ")}`);
  process.exitCode = 0;
} else {

console.log(`UNAVAILABLE backend=${out.backend}`);
console.log(`reason      ${out.reason}`);
console.log(`detail      ${out.detail}`);
console.log("");
console.log(
  out.reason === "no-credential"
    ? `Set ${TAVILY.envVar} in this shell's environment and re-run. It is read from the environment on\n` +
        `purpose: it must stay out of project files, planning content, and every model-visible surface.`
    : `This is a structured capability refusal, not a failure to report. A specialist seeing this must\n` +
        `record the gap and must NOT answer from model memory (DEC-0004).`
);
  process.exitCode = 1;
}
