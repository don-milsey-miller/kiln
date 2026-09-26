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
/**
 * The per-user state root, pointed inside the fixture: where `setup --local-state user` would keep this project's
 * consent record, on a host whose LOCALAPPDATA and XDG_STATE_HOME are the ones given here.
 */
const hostState = (base) => ({ LOCALAPPDATA: join(base, "local-app-data"), XDG_STATE_HOME: join(base, "xdg-state") });
/** The fixture host's per-user base, beside the project and outside its repository. */
const hostOf = (root) => `${root}-host`;

async function projectWith({ record = { research: { provider: "tavily" } }, grant = true, ignored = true, stateMode = "project" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-research-permission-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (ignored) writeFileSync(join(root, ".gitignore"), `${IGNORE_RULES.join("\n")}\n`);
  mkdirSync(join(root, ".pi", "runtime"), { recursive: true });
  if (record === "corrupt") writeFileSync(join(root, ".pi", "kiln.json"), "{ not json");
  else if (record) writeFileSync(join(root, ".pi", "kiln.json"), JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID, ...record }, null, 2));
  const where =
    stateMode === "user"
      ? consentLocation({ projectRoot: root, stateMode: "user", projectId: PROJECT_ID, env: hostState(hostOf(root)) })
      : consentLocation({ projectRoot: root });
  mkdirSync(where.runtime, { recursive: true });
  if (grant === "corrupt") writeFileSync(where.path, "{ not json");
  else if (typeof grant === "boolean") await recordGrant(where, { grant: GRANT.RESEARCH, granted: grant, choice: { research: "tavily" } });
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
function cli(script, args, { projectRoot = null, env = {} } = {}) {
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
    { encoding: "utf-8", timeout: 60_000, env: { ...process.env, TAVILY_API_KEY: "kiln-fake-tavily-key-f4", KILN_ACCESS_OUT: access, ...env } }
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

/* ---- the local-state mode is supported explicitly ----------------------------------------------------------------- */

test("⚠️ F4 ACC-0120 a grant kept in per-user state is found in user mode, and not looked for in project mode", async () => {
  const root = await projectWith({ grant: true, stateMode: "user" });
  try {
    assert.deepEqual(researchPermission({ projectRoot: root, stateMode: "user", env: hostState(hostOf(root)) }), { permitted: true });
    assert.equal(researchPermission({ projectRoot: root }).reason, RESEARCH_REFUSAL.NOT_GRANTED, "the project-local record holds no grant");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hostOf(root), { recursive: true, force: true });
  }
});

test("⚠️ F4 ACC-0120 a local-state mode that is neither project nor user is refused, not read as project", async () => {
  const root = await projectWith({ grant: true });
  try {
    const gate = researchPermission({ projectRoot: root, stateMode: "shared" });
    assert.equal(gate.reason, RESEARCH_REFUSAL.UNKNOWN_STATE_MODE, JSON.stringify(gate));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---- every reason at every entry point ---------------------------------------------------------------------------- */

/** Each refusal a named project can produce, with the flags an entry point is given for it. */
const PROJECT_REFUSALS = [
  ["no project record", { record: null, grant: null }, [], RESEARCH_REFUSAL.PROJECT_UNREADABLE],
  ["research not chosen", { record: { research: { provider: "none" } }, grant: null }, [], RESEARCH_REFUSAL.NOT_CHOSEN],
  ["no grant on this computer", { grant: null }, [], RESEARCH_REFUSAL.NOT_GRANTED],
  ["a declined grant", { grant: false }, [], RESEARCH_REFUSAL.NOT_GRANTED],
  ["a consent record that is not JSON", { grant: "corrupt" }, [], RESEARCH_REFUSAL.CONSENT_UNREADABLE],
  ["an unknown local-state mode", { grant: true }, ["--local-state", "shared"], RESEARCH_REFUSAL.UNKNOWN_STATE_MODE],
];

test("⚠️ F4 ACC-0120 ACC-0089 (10) (11) every project refusal, at each research CLI, comes before the key is read or a request made", async () => {
  for (const [what, setup, flags, reason] of PROJECT_REFUSALS) {
    const root = await projectWith(setup);
    try {
      for (const [script, args] of ENTRY_POINTS) {
        const r = cli(script, [...args, ...flags], { projectRoot: root });
        const label = `${what}: ${script} ${args[0] ?? ""}`;
        assert.equal(r.status, 1, `${label}: ${r.out}`);
        assert.match(r.out, new RegExp(`REFUSED\\s+${reason}`), `${label}: ${r.out}`);
        assert.deepEqual(r.seen, [], `${label}: read the key or made a request: ${r.seen}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("⚠️ F4 ACC-0120 every refusal reaches Pi's research tools through the real gate, and no implementation runs", async () => {
  const { default: register } = await import("../pi-package/extensions/kiln.js");
  const saved = { root: process.env.KILN_PROJECT_ROOT, mode: process.env.KILN_STATE_MODE };
  const toolsFor = (reached) => {
    const tools = new Map();
    const stand = (name) => async () => (reached.push(name), { tool: name, ok: true });
    register(
      { registerTool: (tool) => tools.set(tool.name, tool), on: () => {} },
      { researchTools: { research_capability: stand("research_capability"), research_search: stand("research_search"), research_fetch: stand("research_fetch") } }
    );
    return tools;
  };
  try {
    for (const [what, setup, flags, reason] of [["no project named", null, [], RESEARCH_REFUSAL.NO_PROJECT], ...PROJECT_REFUSALS]) {
      const root = setup === null ? null : await projectWith(setup);
      if (root) process.env.KILN_PROJECT_ROOT = root;
      else delete process.env.KILN_PROJECT_ROOT;
      if (flags[0] === "--local-state") process.env.KILN_STATE_MODE = flags[1];
      else delete process.env.KILN_STATE_MODE;
      try {
        const reached = [];
        const tools = toolsFor(reached);
        for (const [name, params] of [["research_capability", {}], ["research_search", { query: "q" }], ["research_fetch", { url: "https://example.invalid/" }]]) {
          const out = await tools.get(name).execute("call-1", params);
          assert.equal(out.details?.reason, reason, `${what}: ${name}: ${JSON.stringify(out.details)}`);
          assert.equal(out.details?.mustRecordGap, true);
        }
        assert.deepEqual(reached, [], `${what}: an implementation ran`);
      } finally {
        if (root) rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (saved.root === undefined) delete process.env.KILN_PROJECT_ROOT;
    else process.env.KILN_PROJECT_ROOT = saved.root;
    if (saved.mode === undefined) delete process.env.KILN_STATE_MODE;
    else process.env.KILN_STATE_MODE = saved.mode;
  }
});

test("⚠️ F4 ACC-0120 CONTROL: a per-user grant, named with --local-state user, lets the probe through to the key", async () => {
  const root = await projectWith({ grant: true, stateMode: "user" });
  try {
    const r = cli("research-probe.mjs", ["--local-state", "user"], { projectRoot: root, env: hostState(hostOf(root)) });
    assert.ok(r.seen.includes("key-read"), `the permitted probe never reached the adapter: ${r.out}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hostOf(root), { recursive: true, force: true });
  }
});

/* ---- research:record writes only into the project whose consent was read ----------------------------------------- */

test("⚠️ F4 ACC-0120 research:record refuses an evidence destination owned by another project, before fetching", async () => {
  const root = await projectWith({ grant: true });
  const other = mkdtempSync(join(tmpdir(), "kiln-research-other-"));
  mkdirSync(join(other, "planning-content"), { recursive: true });
  try {
    const r = cli("research.mjs", ["record", "https://example.invalid/", "--claim", "c", "--quote", "q"], {
      projectRoot: root,
      env: { PLANNING_CONTENT_DIR: join(other, "planning-content") },
    });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /REFUSED\s+research-destination-not-this-project/, r.out);
    assert.equal(r.seen.some((s) => s.startsWith("request ")), false, `a request was made: ${r.seen}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
