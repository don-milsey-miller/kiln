/**
 * Research is permitted only when the project chose Tavily and this computer granted it — F4, TSK-0075, ACC-0120.
 *
 * ⚠️ **REAL RECORDS IN REAL REPOSITORIES.** The consent record is trusted only where Git keeps it out of the repository,
 * so each project here is a real repository that ignores Kiln's runtime paths, and every refusal reason is produced by
 * a state an operator could actually be in. The CLI cases run the real scripts with a preload that records any read of
 * TAVILY_API_KEY and any request, so "refused before the key or a request" is observed rather than assumed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { RESEARCH_REFUSAL, researchPermission } from "../lib/research/permission.mjs";
import { GRANT, consentLocation, recordGrant } from "../lib/consent-record.mjs";
import { IGNORE_RULES } from "../lib/project-gitignore.mjs";

const ROOT = join(import.meta.dirname, "..");
const PROJECT_ID = "0123456789abcdef0123456789abcdef";

/** A real repository that ignores the runtime paths, with the project record and grant a case asks for. */
async function projectWith({ record = { research: { provider: "tavily" } }, grant = true, ignored = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-research-permission-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (ignored) writeFileSync(join(root, ".gitignore"), `${IGNORE_RULES.join("\n")}\n`);
  mkdirSync(join(root, ".pi", "runtime"), { recursive: true });
  if (record === "corrupt") writeFileSync(join(root, ".pi", "kiln.json"), "{ not json");
  else if (record) writeFileSync(join(root, ".pi", "kiln.json"), JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID, ...record }, null, 2));
  if (grant === "corrupt") writeFileSync(join(root, ".pi", "runtime", "consent.json"), "{ not json");
  else if (typeof grant === "boolean")
    await recordGrant(consentLocation({ projectRoot: root }), { grant: GRANT.RESEARCH, granted: grant, choice: { research: "tavily" } });
  return root;
}

const cases = [
  ["no project is named", null, RESEARCH_REFUSAL.NO_PROJECT],
  ["there is no project record", { record: null, grant: null }, RESEARCH_REFUSAL.PROJECT_UNREADABLE],
  ["the project record is not JSON", { record: "corrupt", grant: null }, RESEARCH_REFUSAL.PROJECT_UNREADABLE],
  ["research was not chosen", { record: { research: { provider: "none" } }, grant: null }, RESEARCH_REFUSAL.NOT_CHOSEN],
  ["research was never decided", { record: {}, grant: null }, RESEARCH_REFUSAL.NOT_CHOSEN],
  ["research was chosen but nobody on this computer answered", { grant: null }, RESEARCH_REFUSAL.NOT_GRANTED],
  ["research was chosen and declined on this computer", { grant: false }, RESEARCH_REFUSAL.NOT_GRANTED],
  ["the consent record is not JSON", { grant: "corrupt" }, RESEARCH_REFUSAL.CONSENT_UNREADABLE],
];

for (const [what, setup, reason] of cases)
  test(`⚠️ F4 ACC-0120 research is refused when ${what}: ${reason}`, async () => {
    const root = setup === null ? null : await projectWith(setup);
    try {
      const gate = researchPermission({ projectRoot: root });
      assert.equal(gate.permitted, false);
      assert.equal(gate.reason, reason, JSON.stringify(gate));
      assert.ok(gate.detail.length > 0);
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

test("⚠️ F4 ACC-0120 a consent record in a place Git would carry is not read as a grant: research-consent-unreadable", async () => {
  // The grant is written while the runtime paths are ignored, then the ignore rules are removed: the same bytes are no
  // longer this computer's to trust.
  const root = await projectWith({ grant: true });
  try {
    writeFileSync(join(root, ".gitignore"), "");
    const gate = researchPermission({ projectRoot: root });
    assert.equal(gate.permitted, false);
    assert.equal(gate.reason, RESEARCH_REFUSAL.CONSENT_UNREADABLE, JSON.stringify(gate));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ F4 ACC-0120 CONTROL: research chosen and granted on this computer is permitted", async () => {
  const root = await projectWith({ grant: true });
  try {
    assert.deepEqual(researchPermission({ projectRoot: root }), { permitted: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A research CLI with key reads and requests recorded, in a named project or with none. */
function cli(script, args, { projectRoot = null } = {}) {
  const access = join(mkdtempSync(join(tmpdir(), "kiln-research-access-")), "access.log");
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(join(ROOT, "test", "fixtures", "research", "observe-access.mjs")).href,
      join(ROOT, "bin", script),
      ...args,
      ...(projectRoot ? ["--project-root", projectRoot] : []),
    ],
    { encoding: "utf-8", timeout: 60_000, env: { ...process.env, TAVILY_API_KEY: "kiln-fake-tavily-key-f4", KILN_ACCESS_OUT: access } }
  );
  const seen = existsSync(access) ? readFileSync(access, "utf-8").trim().split("\n").filter(Boolean) : [];
  return { status: r.status, out: `${r.stdout}${r.stderr}`, seen };
}

const ENTRY_POINTS = [
  ["research.mjs", ["search", "a question"]],
  ["research.mjs", ["record", "https://example.invalid/", "--claim", "c", "--quote", "q"]],
  ["research-probe.mjs", []],
];

test("⚠️ F4 ACC-0120 each research CLI refuses with no project named, before reading the key or making a request", () => {
  for (const [script, args] of ENTRY_POINTS) {
    const r = cli(script, args);
    const label = `${script} ${args[0] ?? ""}`;
    assert.equal(r.status, 2, `${label}: ${r.out}`);
    assert.match(r.out, /REFUSED\s+research-no-project-context/, r.out);
    assert.deepEqual(r.seen, [], `${label} read the key or made a request: ${r.seen}`);
  }
});

test("⚠️ F4 ACC-0120 each research CLI refuses a project that has not chosen research, before reading the key or making a request", async () => {
  const root = await projectWith({ record: { research: { provider: "none" } }, grant: null });
  try {
    for (const [script, args] of ENTRY_POINTS) {
      const r = cli(script, args, { projectRoot: root });
      const label = `${script} ${args[0] ?? ""}`;
      assert.equal(r.status, 1, `${label}: ${r.out}`);
      assert.match(r.out, /REFUSED\s+research-not-chosen/, r.out);
      assert.deepEqual(r.seen, [], `${label} read the key or made a request: ${r.seen}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ F4 ACC-0120 CONTROL: a permitted project gets past the gate, and only then is the key read and a request made", async () => {
  const root = await projectWith({ grant: true });
  try {
    const r = cli("research.mjs", ["search", "a question"], { projectRoot: root });
    assert.ok(r.seen.includes("key-read"), `the permitted search never reached the adapter: ${r.out}`);
    assert.ok(r.seen.some((s) => s.startsWith("request ")), `the permitted search made no request: ${r.seen}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
