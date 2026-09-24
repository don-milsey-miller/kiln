/**
 * The host consent record — TSK-0034, against ACC-0054.
 *
 * ⚠️ **THE CLONE CONTROL COPIES ONLY WHAT GIT COMMITS.** The first host grants everything, the project is
 * committed, and `git clone` produces the second host's copy, so what the clone inherits is decided by the
 * repository and not by the test. The second host then holds real credentials (sentinels in Pi's
 * authentication store and in the environment), and `test/helpers/access-recorder.mjs` observes that
 * none of them is touched before the prompt is answered. The granted run is the positive control.
 *
 * ⚠️ **THE RECORDER WATCHES THE CREDENTIALS, NOT KILN'S OWN FILES.** Its root is Pi's agent directory,
 * and its names are the credential variables. Reading the consent record and the ignore file is how the
 * prompt decision is made, and is not a credential access.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordAccess } from "./helpers/access-recorder.mjs";
import {
  CONSENT_READ,
  GIT,
  GRANT,
  NOT_REMEMBERED,
  STANDING,
  clearGrants,
  committedResearchChoice,
  consentLocation,
  declaredCredentialVar,
  gitProtection,
  obtainGrant,
  readConsent,
  reconcileConsent,
  recordGrant,
} from "../lib/consent-record.mjs";
import { INSPECTION, INSPECTION_PROMPT, RESEARCH_CREDENTIAL, inspectWithConsent } from "../lib/connection-inspection.mjs";
import { blockText } from "../lib/project-gitignore.mjs";

const PROJECT_ID = "0123456789abcdef0123456789abcdef";
const A = { provider: "anthropic", model: "claude-opus-5" };
const B = { provider: "openai", model: "gpt-5" };
const MODEL_PROMPT = "Use this computer's anthropic credential for claude-opus-5?";
const RESEARCH_PROMPT = "Use this computer's Tavily key for web research?";

const SENTINELS = {
  stored: "sk-kiln-consent-STORED-5d1c7e42",
  env: "sk-ant-kiln-consent-ENV-8a03f6b1",
  research: "tvly-kiln-consent-RESEARCH-2e97c4d0",
};

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A Git project with Kiln's ignore block, a committed research choice, and setup's runtime directory. */
function project({ research = "tavily", ignored = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-consent-"));
  const dir = join(root, "project");
  mkdirSync(join(dir, ".pi", "runtime"), { recursive: true });
  git(dir, "init", "-q");
  if (ignored) writeFileSync(join(dir, ".gitignore"), blockText());
  writeFileSync(
    join(dir, ".pi", "kiln.json"),
    JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID, ...(research ? { research: { provider: research } } : {}) }, null, 2) + "\n"
  );
  return { root, dir };
}

/** A Pi agent directory holding a stored key: what a granted inspection reads. */
function agentDirIn(root) {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: SENTINELS.stored } }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  return agentDir;
}

/** An `ask` that answers from a list and counts how often it was asked. */
function answering(...answers) {
  const asked = [];
  const ask = (prompt) => {
    asked.push(prompt);
    return answers.shift();
  };
  return { ask, asked };
}

const choice = (model, research) => ({ model, research });

test("⚠️ a missing, invalid or unreadable record grants nothing", async () => {
  const { root, dir } = project();
  try {
    const where = consentLocation({ projectRoot: dir });
    const everything = choice(A, "tavily");

    assert.equal(readConsent(where).state, CONSENT_READ.ABSENT);
    assert.deepEqual((await reconcileConsent(where, everything)).standings, { inspection: STANDING.ASK, modelUse: STANDING.ASK, research: STANDING.ASK });

    for (const [text, label] of [
      ["{not json", "not JSON"],
      [JSON.stringify({ recordVersion: 1, inspection: { granted: true, decidedAt: "2026-09-21T00:00:00Z", key: SENTINELS.stored } }), "a credential field"],
      [JSON.stringify({ recordVersion: 1, modelUse: { granted: true, decidedAt: "2026-09-21T00:00:00Z" } }), "a model grant naming no model"],
      [JSON.stringify({ recordVersion: 2, inspection: { granted: true, decidedAt: "2026-09-21T00:00:00Z" } }), "an unknown record version"],
      [JSON.stringify({ inspection: { granted: true, decidedAt: "2026-09-21T00:00:00Z" } }), "no record version"],
    ]) {
      writeFileSync(where.path, text);
      assert.equal(readConsent(where).state, CONSENT_READ.INVALID, label);
      const { standings } = await reconcileConsent(where, everything);
      assert.deepEqual(standings, { inspection: STANDING.ASK, modelUse: STANDING.ASK, research: STANDING.ASK }, `${label} granted something`);
    }

    // An invalid record grants nothing, so an answer replaces it.
    const r = await obtainGrant(where, { grant: GRANT.INSPECTION, ...answering(true), prompt: INSPECTION_PROMPT });
    assert.equal(r.persisted, true);
    assert.equal(readConsent(where).state, CONSENT_READ.VALID);

    // A record that cannot be opened grants nothing, and is not written over.
    rmSync(where.path);
    mkdirSync(where.path);
    assert.equal(readConsent(where).state, CONSENT_READ.INACCESSIBLE);
    const blocked = await obtainGrant(where, { grant: GRANT.INSPECTION, ...answering(true), prompt: INSPECTION_PROMPT });
    assert.equal(blocked.asked, true, "an unreadable record was treated as an answer");
    assert.equal(blocked.persisted, false);
    assert.equal(blocked.notPersistedBecause, "inaccessible");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ a record in a location this repository does not ignore grants nothing and is not written", async () => {
  const { root, dir } = project({ ignored: false });
  try {
    const where = consentLocation({ projectRoot: dir });
    // A valid, fully granted record, as a repository could carry one.
    const at = "2026-09-21T00:00:00Z";
    writeFileSync(where.path, JSON.stringify({
      recordVersion: 1,
      inspection: { granted: true, decidedAt: at },
      modelUse: { granted: true, decidedAt: at, ...A },
      research: { granted: true, decidedAt: at, provider: "tavily" },
    }));
    const before = readFileSync(where.path, "utf8");

    const read = readConsent(where);
    assert.equal(read.state, CONSENT_READ.UNPROTECTED);
    assert.ok(read.uncovered.includes(".pi/runtime/"));
    const { standings } = await reconcileConsent(where, choice(A, "tavily"));
    assert.deepEqual(standings, { inspection: STANDING.ASK, modelUse: STANDING.ASK, research: STANDING.ASK });

    const r = await obtainGrant(where, { grant: GRANT.INSPECTION, ...answering(false), prompt: INSPECTION_PROMPT });
    assert.equal(r.asked, true);
    assert.equal(r.persisted, false);
    assert.equal(r.notPersistedBecause, "unprotected");
    assert.equal(readFileSync(where.path, "utf8"), before, "a record was written into an unprotected location");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ the three grants are separate: one answer grants nothing else", async () => {
  const { root, dir } = project();
  try {
    const where = consentLocation({ projectRoot: dir });
    const now = choice(A, "tavily");

    await obtainGrant(where, { grant: GRANT.INSPECTION, ...answering(true), prompt: INSPECTION_PROMPT });
    assert.deepEqual((await reconcileConsent(where, now)).standings, { inspection: STANDING.GRANTED, modelUse: STANDING.ASK, research: STANDING.ASK });

    await obtainGrant(where, { grant: GRANT.MODEL_USE, choice: now, ...answering(false), prompt: MODEL_PROMPT });
    assert.deepEqual((await reconcileConsent(where, now)).standings, { inspection: STANDING.GRANTED, modelUse: STANDING.DECLINED, research: STANDING.ASK });

    await obtainGrant(where, { grant: GRANT.RESEARCH, choice: now, ...answering(true), prompt: RESEARCH_PROMPT });
    const record = readConsent(where).record;
    assert.deepEqual(Object.keys(record).sort(), ["inspection", "modelUse", "recordVersion", "research"]);
    assert.deepEqual({ ...record.modelUse, decidedAt: null }, { granted: false, decidedAt: null, ...A });
    assert.deepEqual({ ...record.research, decidedAt: null }, { granted: true, decidedAt: null, provider: "tavily" });
    assert.doesNotMatch(JSON.stringify(record), /sk-|tvly-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ a decline is recorded and reused, and a non-answer is neither", async () => {
  const { root, dir } = project();
  try {
    const where = consentLocation({ projectRoot: dir });
    for (const nonAnswer of [null, undefined, "", "yes", 1]) {
      const r = await obtainGrant(where, { grant: GRANT.INSPECTION, ...answering(nonAnswer), prompt: INSPECTION_PROMPT });
      assert.equal(r.granted, false, `${String(nonAnswer)} granted`);
      assert.equal(readConsent(where).state, CONSENT_READ.ABSENT, `${String(nonAnswer)} was recorded as a decision`);
    }
    const no = answering(false);
    await obtainGrant(where, { grant: GRANT.INSPECTION, ...no, prompt: INSPECTION_PROMPT });
    const again = answering(true);
    const r = await obtainGrant(where, { grant: GRANT.INSPECTION, ...again, prompt: INSPECTION_PROMPT });
    assert.deepEqual([no.asked.length, again.asked.length], [1, 0], "a recorded decline was asked again");
    assert.equal(r.granted, false);
    assert.equal(r.standing, STANDING.DECLINED);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ a model change clears the grant, and changing back does not revive it", async () => {
  const { root, dir } = project();
  try {
    const where = consentLocation({ projectRoot: dir });
    const first = answering(true);
    await obtainGrant(where, { grant: GRANT.MODEL_USE, choice: choice(A, "tavily"), ...first, prompt: MODEL_PROMPT });

    // Unchanged: reused without asking.
    const same = answering(false);
    assert.equal((await obtainGrant(where, { grant: GRANT.MODEL_USE, choice: choice(A, "tavily"), ...same, prompt: MODEL_PROMPT })).granted, true);
    assert.equal(same.asked.length, 0);

    // A → B: A's grant is removed from the record, not merely ignored, and B is asked.
    const toB = await reconcileConsent(where, choice(B, "tavily"));
    assert.deepEqual(toB.cleared, [GRANT.MODEL_USE]);
    assert.equal(toB.standings.modelUse, STANDING.ASK);
    assert.equal("modelUse" in readConsent(where).record, false, "the old grant was left in the record");

    // B → A: nothing to revive.
    const back = answering(false);
    const r = await obtainGrant(where, { grant: GRANT.MODEL_USE, choice: choice(A, "tavily"), ...back, prompt: MODEL_PROMPT });
    assert.equal(back.asked.length, 1, "returning to A reused a grant given before the change to B");
    assert.equal(r.granted, false);

    // The same for a change of provider with the model name unchanged, and for no model at all.
    await recordGrant(where, { grant: GRANT.MODEL_USE, granted: true, choice: choice(A, null) });
    assert.deepEqual((await reconcileConsent(where, choice({ ...A, provider: "bedrock" }, null))).cleared, [GRANT.MODEL_USE]);
    await recordGrant(where, { grant: GRANT.MODEL_USE, granted: true, choice: choice(A, null) });
    const none = await reconcileConsent(where, choice(null, null));
    assert.deepEqual(none.cleared, [GRANT.MODEL_USE]);
    assert.equal(none.standings.modelUse, STANDING.NOT_APPLICABLE);
    assert.equal((await reconcileConsent(where, choice(A, null))).standings.modelUse, STANDING.ASK);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ TSK-0072 a custom provider's grant is for a model through a named variable, and a new name asks again", async () => {
  const { root, dir } = project();
  try {
    const where = consentLocation({ projectRoot: dir });
    const C = { provider: "acme", model: "acme-model" };
    const viaA = { ...C, credentialVar: "ACME_KEY_A" };
    const viaB = { ...C, credentialVar: "ACME_KEY_B" };

    // Given through A: recorded with the grant, and read back for this model only.
    const first = answering(true);
    assert.equal((await obtainGrant(where, { grant: GRANT.MODEL_USE, choice: choice(viaA, null), ...first, prompt: MODEL_PROMPT })).granted, true);
    assert.equal(readConsent(where).record.modelUse.credentialVar, "ACME_KEY_A");
    assert.equal(declaredCredentialVar(where, C), "ACME_KEY_A");
    assert.equal(declaredCredentialVar(where, { ...C, model: "acme-other" }), null, "a declaration was applied to another model");

    // The same name: reused without asking. A caller that does not know the name (launch) leaves it alone.
    const same = answering(false);
    assert.equal((await obtainGrant(where, { grant: GRANT.MODEL_USE, choice: choice(viaA, null), ...same, prompt: MODEL_PROMPT })).granted, true);
    assert.equal(same.asked.length, 0);
    assert.deepEqual((await reconcileConsent(where, choice(C, null))).cleared, []);
    assert.equal(declaredCredentialVar(where, C), "ACME_KEY_A");

    // ⚠️ A → B FOR THE SAME MODEL IS NOT A SILENT CHANGE: the grant is cleared and B is asked for.
    const toB = answering(true);
    const r = await obtainGrant(where, { grant: GRANT.MODEL_USE, choice: choice(viaB, null), ...toB, prompt: MODEL_PROMPT });
    assert.deepEqual(r.cleared, [GRANT.MODEL_USE]);
    assert.equal(toB.asked.length, 1, "a new credential variable was used without being confirmed");
    assert.equal(declaredCredentialVar(where, C), "ACME_KEY_B");

    // A decline keeps its name, so the same name finds the same decision.
    await recordGrant(where, { grant: GRANT.MODEL_USE, granted: false, choice: choice(viaB, null) });
    const declined = answering(true);
    assert.equal((await obtainGrant(where, { grant: GRANT.MODEL_USE, choice: choice(viaB, null), ...declined, prompt: MODEL_PROMPT })).granted, false);
    assert.equal(declined.asked.length, 0);

    // ⚠️ A NAME ONLY: a value in its place is refused before anything is written.
    for (const bad of ["acme_key", "sk-live-0123456789", "$ACME_KEY"])
      await assert.rejects(() => recordGrant(where, { grant: GRANT.MODEL_USE, granted: true, choice: choice({ ...C, credentialVar: bad }, null) }), TypeError);
    assert.equal(readConsent(where).record.modelUse.credentialVar, "ACME_KEY_B");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ a research change clears the research grant only, and turning it back on asks again", async () => {
  const { root, dir } = project();
  try {
    const where = consentLocation({ projectRoot: dir });
    const now = choice(A, "tavily");
    await recordGrant(where, { grant: GRANT.INSPECTION, granted: true });
    await recordGrant(where, { grant: GRANT.MODEL_USE, granted: true, choice: now });
    await recordGrant(where, { grant: GRANT.RESEARCH, granted: true, choice: now });

    for (const off of ["none", null]) {
      const r = await reconcileConsent(where, choice(A, off));
      assert.deepEqual(r.cleared, [GRANT.RESEARCH]);
      assert.deepEqual(r.standings, { inspection: STANDING.GRANTED, modelUse: STANDING.GRANTED, research: STANDING.NOT_APPLICABLE });
      const on = answering(false);
      const back = await obtainGrant(where, { grant: GRANT.RESEARCH, choice: now, ...on, prompt: RESEARCH_PROMPT });
      assert.equal(on.asked.length, 1, `research turned ${off} and back on reused the old grant`);
      await recordGrant(where, { grant: GRANT.RESEARCH, granted: true, choice: now });
      void back;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a caller that changes a choice clears its grant in the same step", async () => {
  const { root, dir } = project();
  try {
    const where = consentLocation({ projectRoot: dir });
    await recordGrant(where, { grant: GRANT.INSPECTION, granted: true });
    await recordGrant(where, { grant: GRANT.MODEL_USE, granted: true, choice: choice(A, null) });
    assert.equal((await clearGrants(where, [GRANT.MODEL_USE])).written, true);
    assert.deepEqual(Object.keys(readConsent(where).record).sort(), ["inspection", "recordVersion"]);
    assert.equal((await clearGrants(where, [GRANT.MODEL_USE])).reason, "unchanged");
    await assert.rejects(clearGrants(where, ["everything"]), TypeError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a choice must name both model and research, so a grant cannot be cleared by omission", async () => {
  const { root, dir } = project();
  try {
    const where = consentLocation({ projectRoot: dir });
    await assert.rejects(reconcileConsent(where, { model: A }), TypeError);
    await assert.rejects(reconcileConsent(where, { research: "tavily" }), TypeError);
    await assert.rejects(reconcileConsent(where, choice({ provider: "anthropic" }, null)), TypeError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The second host's launch, under the recorder: inspection, model use and research, each asked and each
 * answered yes, with each credential access made only after its answer. The counts are taken at every
 * prompt and after every access, so each prompt can be compared with the state just before it.
 */
async function secondHostLaunch({ where, projectDir, agentDir }) {
  const names = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", RESEARCH_CREDENTIAL];
  // The second host has a PATH, so Git can be asked whether it tracks the record.
  const system = Object.fromEntries(["PATH", "Path", "SystemRoot", "HOME", "USERPROFILE", "TEMP", "TMP"].filter((n) => typeof process.env[n] === "string").map((n) => [n, process.env[n]]));
  const rec = recordAccess({ root: agentDir, names, env: { ...system, ANTHROPIC_API_KEY: SENTINELS.env, [RESEARCH_CREDENTIAL]: SENTINELS.research } });
  const at = {};
  const asking = (label) => () => {
    at[label] = rec.counts();
    return true;
  };
  try {
    const inspected = await inspectWithConsent({ location: where, agentDir, ask: asking("inspectionPrompt") });
    at.afterInspection = rec.counts();

    const now = choice(A, committedResearchChoice(projectDir));
    const model = await obtainGrant(where, { grant: GRANT.MODEL_USE, choice: now, ask: asking("modelPrompt"), prompt: MODEL_PROMPT });
    // Stand-in for the model run: it uses the credential, and only on a yes.
    if (model.granted) void process.env.ANTHROPIC_API_KEY;
    at.afterModelUse = rec.counts();

    const research = await obtainGrant(where, { grant: GRANT.RESEARCH, choice: now, ask: asking("researchPrompt"), prompt: RESEARCH_PROMPT });
    if (research.granted) void process.env[RESEARCH_CREDENTIAL];
    at.afterResearchUse = rec.counts();

    return { inspected, model, research, at, events: { fs: [...rec.fs], env: [...rec.env], net: [...rec.net] } };
  } finally {
    rec.restore();
  }
}

/** Grant everything on the first host, and show an unchanged launch there asks nothing. */
async function firstHostGrants(where, projectDir, agentDir) {
  const everything = choice(A, committedResearchChoice(projectDir));
  for (const [grant, prompt] of [[GRANT.INSPECTION, INSPECTION_PROMPT], [GRANT.MODEL_USE, MODEL_PROMPT], [GRANT.RESEARCH, RESEARCH_PROMPT]])
    await obtainGrant(where, { grant, choice: everything, ...answering(true), prompt });

  const reuse = answering(false, false, false);
  const reused = await inspectWithConsent({ location: where, agentDir, ask: reuse.ask });
  for (const [grant, prompt] of [[GRANT.MODEL_USE, MODEL_PROMPT], [GRANT.RESEARCH, RESEARCH_PROMPT]])
    assert.equal((await obtainGrant(where, { grant, choice: everything, ask: reuse.ask, prompt })).granted, true);
  assert.equal(reuse.asked.length, 0, "an unchanged project on the same host was asked again");
  assert.equal(reused.decision, INSPECTION.GRANTED);
}

/** Commit what Git will take and clone it: the clone holds exactly what was committed. */
function commitAndClone(first, into, { forceAdd = false } = {}) {
  git(first, "add", "-A");
  if (forceAdd) git(first, "add", "-f", ".pi/runtime/consent.json");
  git(first, "-c", "user.name=kiln-test", "-c", "user.email=kiln-test@example.invalid", "commit", "-q", "-m", "project");
  const committed = git(first, "ls-files").split("\n").filter(Boolean).sort();
  const expected = forceAdd ? [".gitignore", ".pi/kiln.json", ".pi/runtime/consent.json"] : [".gitignore", ".pi/kiln.json"];
  assert.deepEqual(committed, expected, "the commit is not exactly what the control intends");
  const clone = join(into, "project");
  git(into, "clone", "-q", first, clone);
  assert.equal(existsSync(join(clone, ".pi", "runtime", "consent.json")), forceAdd, "the clone's runtime state is not what was committed");
  assert.equal(committedResearchChoice(clone), "tavily", "the clone did not carry the committed research choice");
  return clone;
}

/** Nothing touched a credential before any prompt was answered, and the recorder saw each use after. */
function assertNothingBeforeEachPrompt(o) {
  const none = { fs: 0, env: 0, net: 0 };
  assert.deepEqual(o.at.inspectionPrompt, none, "a credential was touched before the inspection prompt was answered");
  assert.deepEqual(o.at.modelPrompt, o.at.afterInspection, "a credential was touched before the model-use prompt was answered");
  assert.deepEqual(o.at.researchPrompt, o.at.afterModelUse, "a credential was touched before the research prompt was answered");

  // The positive control: each yes is followed by the access, and the recorder sees it.
  assert.ok(o.events.fs.some((e) => /auth\.json$/.test(e)), "the recorder did not see the inspection read Pi's authentication store");
  assert.equal(o.at.afterModelUse.env, o.at.afterInspection.env + 1, "the recorder did not see the model-use credential read");
  assert.equal(o.at.afterResearchUse.env, o.at.afterModelUse.env + 1, "the recorder did not see the research credential read");
  assert.deepEqual(o.events.net, []);

  assert.equal(o.inspected.decision, INSPECTION.GRANTED);
  assert.deepEqual([o.inspected.consent.asked, o.model.asked, o.research.asked], [true, true, true], "a prompt was not reopened");
}

test("⚠️ ACC-0054 project-local state: a clone does not inherit consent, and no credential is touched before each prompt", async () => {
  const first = project({ research: "tavily" });
  const second = mkdtempSync(join(tmpdir(), "kiln-consent-host2-"));
  try {
    await firstHostGrants(consentLocation({ projectRoot: first.dir }), first.dir, agentDirIn(first.root));
    const clone = commitAndClone(first.dir, second);

    // The second host: setup has made its runtime directory, and it holds real credentials.
    mkdirSync(join(clone, ".pi", "runtime"), { recursive: true });
    const where = consentLocation({ projectRoot: clone });
    assert.equal(readConsent(where).state, CONSENT_READ.ABSENT);

    assertNothingBeforeEachPrompt(await secondHostLaunch({ where, projectDir: clone, agentDir: agentDirIn(second) }));
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0054 per-user state: the clone derives the new host's root, which holds no consent", async () => {
  const first = project({ research: "tavily" });
  const second = mkdtempSync(join(tmpdir(), "kiln-consent-host2-"));
  const hostState = (base) => ({ LOCALAPPDATA: join(base, "local-app-data"), XDG_STATE_HOME: join(base, "xdg-state") });
  const userWhere = (projectRoot, base) => {
    const where = consentLocation({ projectRoot, stateMode: "user", projectId: PROJECT_ID, env: hostState(base) });
    mkdirSync(where.runtime, { recursive: true });
    return where;
  };
  try {
    const firstWhere = userWhere(first.dir, first.root);
    await firstHostGrants(firstWhere, first.dir, agentDirIn(first.root));
    assert.equal(readConsent(firstWhere).state, CONSENT_READ.VALID);
    assert.equal(gitProtection(firstWhere).state, GIT.NO_REPOSITORY, "the per-user root is not in any repository");
    const clone = commitAndClone(first.dir, second);

    const where = userWhere(clone, second);
    assert.notEqual(where.path, firstWhere.path);
    assert.equal(readConsent(where).state, CONSENT_READ.ABSENT);

    assertNothingBeforeEachPrompt(await secondHostLaunch({ where, projectDir: clone, agentDir: agentDirIn(second) }));
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

/** Commit the project with a granted record force-added past the ignore block. */
async function forceAddedGrant() {
  const first = project({ research: "tavily" });
  await firstHostGrants(consentLocation({ projectRoot: first.dir }), first.dir, agentDirIn(first.root));
  return first;
}

test("⚠️ ACC-0054 R1 negative control: a force-added, granted record reaches the clone and grants nothing", async () => {
  const first = await forceAddedGrant();
  const second = mkdtempSync(join(tmpdir(), "kiln-consent-host2-"));
  try {
    const clone = commitAndClone(first.dir, second, { forceAdd: true });
    const where = consentLocation({ projectRoot: clone });
    const carried = readFileSync(where.path, "utf8");

    // The premise: the record is valid, fully granted, and inside the ignore block's coverage.
    const parsed = JSON.parse(carried);
    assert.deepEqual([parsed.inspection.granted, parsed.modelUse.granted, parsed.research.granted], [true, true, true]);
    assert.equal(gitProtection(where).state, GIT.TRACKED);
    assert.equal(readConsent(where).state, CONSENT_READ.TRACKED);
    assert.deepEqual((await reconcileConsent(where, choice(A, "tavily"))).standings, { inspection: STANDING.ASK, modelUse: STANDING.ASK, research: STANDING.ASK });

    const o = await secondHostLaunch({ where, projectDir: clone, agentDir: agentDirIn(second) });
    assertNothingBeforeEachPrompt(o);
    // The answers are not written over the tracked record.
    for (const r of [o.inspected.consent, o.model, o.research]) {
      assert.equal(r.persisted, false);
      assert.equal(r.notPersistedBecause, "tracked");
    }
    assert.equal(readFileSync(where.path, "utf8"), carried, "a tracked record was written over");
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("⚠️ an ordinary ignored record is untracked and grants, and a tracked record deleted from the tree is not rewritten", async () => {
  const first = await forceAddedGrant();
  try {
    const where = consentLocation({ projectRoot: first.dir });
    assert.equal(gitProtection(where).state, GIT.IGNORED);
    assert.equal(readConsent(where).state, CONSENT_READ.VALID);

    git(first.dir, "add", "-f", ".pi/runtime/consent.json");
    assert.equal(readConsent(where).state, CONSENT_READ.TRACKED, "a record staged past the ignore block was trusted");
    rmSync(where.path);
    const r = await recordGrant(where, { grant: GRANT.INSPECTION, granted: true });
    assert.deepEqual([r.written, r.reason], [false, "tracked"]);
    assert.equal(existsSync(where.path), false, "a record Git still tracks was written again");
  } finally {
    rmSync(first.root, { recursive: true, force: true });
  }
});

test("⚠️ a linked worktree: Git is found through its .git file, for a tracked and an ignored record", async () => {
  const first = await forceAddedGrant();
  try {
    git(first.dir, "add", "-A");
    git(first.dir, "add", "-f", ".pi/runtime/consent.json");
    git(first.dir, "-c", "user.name=kiln-test", "-c", "user.email=kiln-test@example.invalid", "commit", "-q", "-m", "project");

    const tree = join(first.root, "tree");
    git(first.dir, "worktree", "add", "-q", tree);
    assert.equal(statSync(join(tree, ".git")).isFile(), true, "the worktree's .git is not a file");
    const where = consentLocation({ projectRoot: tree });
    assert.equal(gitProtection(where).state, GIT.TRACKED);
    assert.equal(readConsent(where).state, CONSENT_READ.TRACKED);
    assert.equal((await obtainGrant(where, { grant: GRANT.INSPECTION, ...answering(true), prompt: INSPECTION_PROMPT })).notPersistedBecause, "tracked");

    // ⚠️ R5: a staged removal leaves the record in HEAD, which is what a clone checks out.
    git(tree, "rm", "-q", "--cached", ".pi/runtime/consent.json");
    assert.equal(gitProtection(where).state, GIT.COMMITTED);
    assert.equal(readConsent(where).state, CONSENT_READ.COMMITTED);
    assert.equal((await recordGrant(where, { grant: GRANT.INSPECTION, granted: true })).reason, "committed");

    // The positive case in the same worktree: trusted only once the removal is committed.
    git(tree, "-c", "user.name=kiln-test", "-c", "user.email=kiln-test@example.invalid", "commit", "-q", "-m", "stop tracking consent");
    assert.equal(gitProtection(where).state, GIT.IGNORED);
    assert.equal(readConsent(where).state, CONSENT_READ.VALID);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
  }
});

test("⚠️ an inconclusive Git answer grants nothing and writes nothing", async () => {
  const first = await forceAddedGrant();
  try {
    const where = consentLocation({ projectRoot: first.dir, git: "kiln-no-such-git-binary" });
    const before = readFileSync(where.path, "utf8");
    assert.equal(gitProtection(where).state, GIT.INCONCLUSIVE);
    assert.equal(readConsent(where).state, CONSENT_READ.UNVERIFIED);
    assert.deepEqual((await reconcileConsent(where, choice(A, "tavily"))).standings, { inspection: STANDING.ASK, modelUse: STANDING.ASK, research: STANDING.ASK });
    const r = await obtainGrant(where, { grant: GRANT.INSPECTION, ...answering(true), prompt: INSPECTION_PROMPT });
    assert.deepEqual([r.asked, r.persisted, r.notPersistedBecause], [true, false, "unverified"]);
    assert.equal(r.notRemembered, NOT_REMEMBERED.unverified);
    assert.match(r.notRemembered, /every launch until Git is available/);

    // ⚠️ R4: an unchanged project is asked again on every launch while Git cannot answer.
    const again = answering(true);
    await obtainGrant(where, { grant: GRANT.INSPECTION, ...again, prompt: INSPECTION_PROMPT });
    assert.equal(again.asked.length, 1, "a saved answer was trusted without Git's confirmation");
    assert.equal(readFileSync(where.path, "utf8"), before);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0054 R5 clone control: a removal staged but not committed still carries the grant, and grants nothing", async () => {
  const first = await forceAddedGrant();
  const second = mkdtempSync(join(tmpdir(), "kiln-consent-host2-"));
  try {
    const clone = commitAndClone(first.dir, second, { forceAdd: true });
    rmSync(clone, { recursive: true, force: true });

    // The first host stages the removal and does not commit it.
    git(first.dir, "rm", "-q", "--cached", ".pi/runtime/consent.json");
    const origin = consentLocation({ projectRoot: first.dir });
    assert.equal(gitProtection(origin).state, GIT.COMMITTED);
    assert.equal(readConsent(origin).state, CONSENT_READ.COMMITTED);
    const before = readFileSync(origin.path, "utf8");
    const refused = await recordGrant(origin, { grant: GRANT.INSPECTION, granted: false });
    assert.deepEqual([refused.written, refused.reason], [false, "committed"]);
    assert.equal(readFileSync(origin.path, "utf8"), before);

    // A clone of that HEAD still receives the granted record, and it grants nothing there.
    git(second, "clone", "-q", first.dir, clone);
    const where = consentLocation({ projectRoot: clone });
    assert.equal(JSON.parse(readFileSync(where.path, "utf8")).inspection.granted, true, "the clone did not receive the record");
    assert.notEqual(readConsent(where).state, CONSENT_READ.VALID);
    assertNothingBeforeEachPrompt(await secondHostLaunch({ where, projectDir: clone, agentDir: agentDirIn(second) }));

    // Committing the removal is what makes the first host's record trustworthy again.
    git(first.dir, "-c", "user.name=kiln-test", "-c", "user.email=kiln-test@example.invalid", "commit", "-q", "-m", "stop tracking consent");
    assert.equal(readConsent(origin).state, CONSENT_READ.VALID);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

/**
 * A project with no `.git` of its own, inside a parent repository. The project's own coverage check calls
 * it "not a repository", so only the parent's rules decide whether the record is protected.
 */
function projectInParent({ parentIgnores = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-consent-parent-"));
  const parent = join(root, "parent");
  const dir = join(parent, "work", "project");
  mkdirSync(join(dir, ".pi", "runtime"), { recursive: true });
  git(parent, "init", "-q");
  writeFileSync(join(parent, ".gitignore"), parentIgnores ? "work/project/.pi/runtime/\n" : "# nothing of Kiln's\n");
  writeFileSync(join(dir, ".pi", "kiln.json"), JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID, research: { provider: "tavily" } }, null, 2) + "\n");
  return { root, parent, dir };
}

const fullyGranted = () => {
  const at = "2026-09-22T00:00:00Z";
  return JSON.stringify({
    recordVersion: 1,
    inspection: { granted: true, decidedAt: at },
    modelUse: { granted: true, decidedAt: at, ...A },
    research: { granted: true, decidedAt: at, provider: "tavily" },
  }, null, 2) + "\n";
};

test("⚠️ ACC-0054 R6 parent-repository clone control: an unignored record is neither written nor trusted, and a committed one grants nothing", async () => {
  const first = projectInParent();
  const second = mkdtempSync(join(tmpdir(), "kiln-consent-host2-"));
  try {
    const where = consentLocation({ projectRoot: first.dir });
    assert.equal(existsSync(join(first.dir, ".git")), false, "the project has a repository of its own");
    assert.equal(gitProtection(where).state, GIT.NOT_IGNORED);

    // Nothing is written where the parent's next `git add -A` would take it.
    const r = await obtainGrant(where, { grant: GRANT.INSPECTION, ...answering(true), prompt: INSPECTION_PROMPT });
    assert.deepEqual([r.granted, r.persisted, r.notPersistedBecause], [true, false, "not-ignored"]);
    assert.equal(r.notRemembered, NOT_REMEMBERED["not-ignored"]);
    assert.equal(existsSync(where.path), false, "a consent record was written into the parent repository's working tree");

    // A granted record placed there (as the unchecked writer did) is not trusted.
    writeFileSync(where.path, fullyGranted());
    assert.equal(readConsent(where).state, CONSENT_READ.UNPROTECTED);

    // The parent commits everything, and a clone of the parent carries the record.
    git(first.parent, "add", "-A");
    git(first.parent, "-c", "user.name=kiln-test", "-c", "user.email=kiln-test@example.invalid", "commit", "-q", "-m", "parent");
    assert.ok(git(first.parent, "ls-files").split("\n").includes("work/project/.pi/runtime/consent.json"));
    const cloneParent = join(second, "parent");
    git(second, "clone", "-q", first.parent, cloneParent);
    const clone = join(cloneParent, "work", "project");
    const cloned = consentLocation({ projectRoot: clone });
    assert.equal(JSON.parse(readFileSync(cloned.path, "utf8")).inspection.granted, true, "the clone did not receive the record");
    assert.equal(readConsent(cloned).state, CONSENT_READ.TRACKED);

    assertNothingBeforeEachPrompt(await secondHostLaunch({ where: cloned, projectDir: clone, agentDir: agentDirIn(second) }));
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("a parent repository that ignores the runtime directory protects the record, which is written and reused", async () => {
  const first = projectInParent({ parentIgnores: true });
  try {
    const where = consentLocation({ projectRoot: first.dir });
    assert.equal(gitProtection(where).state, GIT.IGNORED);
    const r = await obtainGrant(where, { grant: GRANT.INSPECTION, ...answering(true), prompt: INSPECTION_PROMPT });
    assert.equal(r.persisted, true);
    const again = answering(false);
    assert.equal((await obtainGrant(where, { grant: GRANT.INSPECTION, ...again, prompt: INSPECTION_PROMPT })).granted, true);
    assert.equal(again.asked.length, 0);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
  }
});
