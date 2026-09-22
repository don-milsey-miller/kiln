/**
 * Tavily consent, probe and plain-English outcomes — TSK-0035, toward ACC-0054.
 *
 * ⚠️ **THE KEY IS OBSERVED WHERE THE ADAPTER READS IT.** The real `createTavilyAdapter` is given an
 * environment Proxy that records every read of `TAVILY_API_KEY`, and a `fetch` that records every call
 * and answers as Tavily would. So "no credential use before the answer" is a count taken at the prompt,
 * and the probe runs through the same code a real setup runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONSENT_READ, GRANT, STANDING, consentLocation, readConsent, reconcileGrant, recordGrant } from "../lib/consent-record.mjs";
import { projectRecordTarget } from "../lib/local-state.mjs";
import { blockText } from "../lib/project-gitignore.mjs";
import {
  ENABLE_LATER,
  RESEARCH_OUTCOME,
  RESEARCH_PROMPT,
  ResearchChoiceRefusal,
  outcomeFromProbe,
  researchMessage,
  setUpResearch,
  writeResearchChoice,
} from "../lib/research-enablement.mjs";
import { createTavilyAdapter, TAVILY } from "../lib/research/tavily-adapter.mjs";
import { runTransaction } from "../lib/setup-transaction.mjs";

const PROJECT_ID = "fedcba9876543210fedcba9876543210";
const KEY = "tvly-kiln-enable-SENTINEL-6c41a09e";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function project({ research } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-research-"));
  const dir = join(root, "project");
  mkdirSync(join(dir, ".pi", "runtime"), { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), blockText());
  writeFileSync(
    join(dir, ".pi", "kiln.json"),
    JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID, ...(research ? { research: { provider: research } } : {}) }, null, 2) + "\n"
  );
  return { root, dir, where: consentLocation({ projectRoot: dir }) };
}

const withTx = (dir, body) => runTransaction({ projectRoot: dir, files: [projectRecordTarget()] }, body);
const committed = (dir) => JSON.parse(readFileSync(join(dir, ".pi", "kiln.json"), "utf8")).research?.provider ?? null;

/** Tavily's `/usage` answer, and a recorder of every key read and every request. */
function tavily({ status = 200, body = { account: { plan_usage: 12, plan_limit: 1000 } }, throws = null, key = KEY } = {}) {
  const seen = { keyReads: 0, requests: [] };
  const env = new Proxy(key === null ? {} : { [TAVILY.envVar]: key }, {
    get(target, name) {
      if (name === TAVILY.envVar) seen.keyReads++;
      return Reflect.get(target, name);
    },
  });
  const fetchImpl = async (url, init) => {
    seen.requests.push(`${init?.method ?? "GET"} ${url}`);
    if (throws) throw throws;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { adapter: createTavilyAdapter({ env, fetchImpl }), seen };
}

/** An `ask` that answers once, recording the key reads and requests at the moment it is asked. */
function answering(answer, seen) {
  const asked = [];
  return {
    asked,
    ask: (prompt) => {
      asked.push({ prompt, keyReads: seen.keyReads, requests: seen.requests.length });
      return answer;
    },
  };
}

const run = (p, opts) => withTx(p.dir, (transaction) => setUpResearch({ transaction, location: p.where, ...opts }));

test("the six outcomes carry the wording the proposal requires", () => {
  assert.deepEqual(Object.values(RESEARCH_OUTCOME).sort(), ["authentication-failed", "available", "backend-unreachable", "no-credential", "quota-exhausted", "user-disabled"]);
  assert.equal(researchMessage("available", { quota: { remaining: 988, limit: 1000 } }), "Web research is ready. 988 of 1000 search credits remain.");
  assert.equal(researchMessage("available", { quota: { remaining: null, limit: null } }), "Web research is ready.");
  assert.match(researchMessage("no-credential"), /^No Tavily connection was found\. Kiln can continue without it/);
  assert.equal(researchMessage("authentication-failed"), "Tavily did not accept the existing connection. No changes were made.");
  assert.equal(researchMessage("quota-exhausted"), "The connection works, but the Tavily account has no search credits remaining.");
  assert.equal(researchMessage("backend-unreachable"), "Kiln could not reach Tavily. You can retry later.");
  assert.equal(researchMessage("user-disabled"), "Web research remains disabled for this project.");
  assert.throws(() => researchMessage("maybe"), TypeError);
  assert.match(RESEARCH_PROMPT, /^Optional web research\n\nKiln can use Tavily/);
  assert.match(RESEARCH_PROMPT, /does not perform a search or use search credits/);
});

test("probe results map to distinct outcomes, and an unknown reason is not reported as available", () => {
  assert.equal(outcomeFromProbe({ ok: true }), "available");
  assert.equal(outcomeFromProbe({ ok: false, reason: "no-credential" }), "no-credential");
  assert.equal(outcomeFromProbe({ ok: false, reason: "auth-failed" }), "authentication-failed");
  assert.equal(outcomeFromProbe({ ok: false, reason: "quota-exhausted" }), "quota-exhausted");
  assert.equal(outcomeFromProbe({ ok: false, reason: "backend-unreachable" }), "backend-unreachable");
  assert.equal(outcomeFromProbe({ ok: false, reason: "something-new" }), "backend-unreachable");
  assert.equal(outcomeFromProbe(undefined), "backend-unreachable");
});

test("⚠️ approval comes before the key is read, and only an available probe persists anything", async () => {
  const p = project();
  try {
    const t = tavily();
    const a = answering(true, t.seen);
    const r = await run(p, { presence: "present", ask: a.ask, adapter: t.adapter });

    assert.equal(a.asked.length, 1);
    assert.equal(a.asked[0].prompt, RESEARCH_PROMPT);
    assert.deepEqual([a.asked[0].keyReads, a.asked[0].requests], [0, 0], "the key was used before the approval was answered");
    // The positive control: the probe reads the key and makes exactly one request, to /usage.
    assert.ok(t.seen.keyReads > 0);
    assert.deepEqual(t.seen.requests, [`GET ${TAVILY.base}/usage`]);

    assert.equal(r.outcome, RESEARCH_OUTCOME.AVAILABLE);
    assert.equal(r.message, "Web research is ready. 988 of 1000 search credits remain.");
    assert.equal(committed(p.dir), "tavily");
    const record = readConsent(p.where).record;
    assert.equal(record.research.granted, true);

    // Unchanged: reused without asking, and the probe runs again.
    const again = tavily();
    const b = answering(false, again.seen);
    const second = await run(p, { presence: "present", ask: b.ask, adapter: again.adapter });
    assert.equal(b.asked.length, 0, "an unchanged project was asked again");
    assert.equal(second.outcome, RESEARCH_OUTCOME.AVAILABLE);
    assert.deepEqual(again.seen.requests, [`GET ${TAVILY.base}/usage`]);

    // Neither file holds the key.
    for (const f of [join(p.dir, ".pi", "kiln.json"), p.where.path]) assert.equal(readFileSync(f, "utf8").includes(KEY.slice(0, 12)), false, `${f} holds the key`);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ a failed probe changes nothing, and each failure has its own outcome", async () => {
  for (const [label, shape, expected] of [
    ["401", { status: 401 }, RESEARCH_OUTCOME.AUTHENTICATION_FAILED],
    ["403", { status: 403 }, RESEARCH_OUTCOME.AUTHENTICATION_FAILED],
    ["429", { status: 429 }, RESEARCH_OUTCOME.QUOTA_EXHAUSTED],
    ["432", { status: 432 }, RESEARCH_OUTCOME.QUOTA_EXHAUSTED],
    ["no credits", { body: { account: { plan_usage: 1000, plan_limit: 1000 } } }, RESEARCH_OUTCOME.QUOTA_EXHAUSTED],
    ["network", { throws: Object.assign(new Error("down"), { code: "ECONNREFUSED" }) }, RESEARCH_OUTCOME.BACKEND_UNREACHABLE],
    ["500", { status: 500 }, RESEARCH_OUTCOME.BACKEND_UNREACHABLE],
    ["key gone", { key: null }, RESEARCH_OUTCOME.NO_CREDENTIAL],
  ]) {
    const p = project();
    try {
      const t = tavily(shape);
      const r = await run(p, { presence: "present", ask: () => true, adapter: t.adapter });
      assert.equal(r.outcome, expected, label);
      assert.equal(r.message, researchMessage(expected), label);
      assert.equal(committed(p.dir), null, `${label} wrote a research choice`);
      assert.equal(readConsent(p.where).state, CONSENT_READ.ABSENT, `${label} recorded an approval`);
      assert.equal(JSON.stringify(r).includes(KEY.slice(0, 12)), false, `${label} put the key in the result`);
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  }
});

test("⚠️ declining uses no credential, does not block, and is remembered", async () => {
  // No choice yet: the project takes `none`.
  const fresh = project();
  try {
    const t = tavily();
    const r = await run(fresh, { presence: "present", ask: () => false, adapter: t.adapter });
    assert.equal(r.outcome, RESEARCH_OUTCOME.USER_DISABLED);
    assert.deepEqual([t.seen.keyReads, t.seen.requests.length], [0, 0]);
    assert.equal(committed(fresh.dir), "none");
    const again = answering(true, t.seen);
    assert.equal((await run(fresh, { presence: "present", ask: again.ask, adapter: t.adapter })).outcome, RESEARCH_OUTCOME.USER_DISABLED);
    assert.equal(again.asked.length, 0, "a project that chose none was asked again");
  } finally {
    rmSync(fresh.root, { recursive: true, force: true });
  }

  // A committed `tavily` from another operator: only this host's decline is recorded.
  const chosen = project({ research: "tavily" });
  try {
    const t = tavily();
    const r = await run(chosen, { presence: "present", ask: () => false, adapter: t.adapter });
    assert.equal(r.outcome, RESEARCH_OUTCOME.USER_DISABLED);
    assert.equal(committed(chosen.dir), "tavily", "one host's decline changed the project's choice");
    assert.equal(readConsent(chosen.where).record.research.granted, false);
    const again = answering(true, t.seen);
    await run(chosen, { presence: "present", ask: again.ask, adapter: t.adapter });
    assert.equal(again.asked.length, 0);
    assert.deepEqual([t.seen.keyReads, t.seen.requests.length], [0, 0]);
  } finally {
    rmSync(chosen.root, { recursive: true, force: true });
  }
});

test("no key, no inspection or no answer: nothing is asked or used, and nothing is written", async () => {
  for (const [label, opts, expected] of [
    ["absent", { presence: "absent" }, RESEARCH_OUTCOME.NO_CREDENTIAL],
    ["not inspected", { presence: "not-inspected" }, RESEARCH_OUTCOME.USER_DISABLED],
    ["closed input", { presence: "present", answer: null }, RESEARCH_OUTCOME.USER_DISABLED],
    ["a string", { presence: "present", answer: "yes" }, RESEARCH_OUTCOME.USER_DISABLED],
  ]) {
    const p = project({ research: "tavily" });
    try {
      const t = tavily();
      const a = answering(opts.answer, t.seen);
      const r = await run(p, { presence: opts.presence, ask: a.ask, adapter: t.adapter });
      assert.equal(r.outcome, expected, label);
      assert.deepEqual([t.seen.keyReads, t.seen.requests.length], [0, 0], `${label} used the key`);
      assert.equal(readConsent(p.where).state, CONSENT_READ.ABSENT, `${label} recorded something`);
      assert.equal(committed(p.dir), "tavily");
      if (opts.presence !== "present") assert.equal(a.asked.length, 0, `${label} asked`);
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  }
});

test("--research disabled writes none without asking, and --research tavily is the approval", async () => {
  const p = project({ research: "tavily" });
  try {
    await recordGrant(p.where, { grant: GRANT.RESEARCH, granted: true, choice: { research: "tavily" } });
    const t = tavily();
    const off = await run(p, { presence: "present", request: "disabled", adapter: t.adapter });
    assert.equal(off.outcome, RESEARCH_OUTCOME.USER_DISABLED);
    assert.equal(committed(p.dir), "none");
    assert.equal("research" in readConsent(p.where).record, false, "disabling left the research grant in place");
    assert.deepEqual([t.seen.keyReads, t.seen.requests.length], [0, 0]);

    const on = await run(p, { presence: "present", request: "tavily", ask: () => { throw new Error("asked"); }, adapter: t.adapter });
    assert.equal(on.outcome, RESEARCH_OUTCOME.AVAILABLE);
    assert.equal(committed(p.dir), "tavily");
    assert.equal(readConsent(p.where).record.research.granted, true);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ the persisted choice Tavily → none → Tavily: the writer clears the grant, and turning it back on asks again", async () => {
  const p = project();
  try {
    const t = tavily();
    await run(p, { presence: "present", ask: () => true, adapter: t.adapter });
    assert.equal(committed(p.dir), "tavily");
    assert.equal(readConsent(p.where).record.research.granted, true);

    // The writer changes the choice, and clears the grant in the same step.
    const off = await withTx(p.dir, (transaction) => writeResearchChoice({ transaction, location: p.where, provider: "none" }));
    assert.deepEqual([off.changed, off.from, off.to, off.cleared], [true, "tavily", "none", [GRANT.RESEARCH]]);
    assert.equal(committed(p.dir), "none");
    assert.equal("research" in readConsent(p.where).record, false, "the grant survived the change to none");

    // Back to tavily, written by the same writer, with no read in between: nothing to revive.
    const on = await withTx(p.dir, (transaction) => writeResearchChoice({ transaction, location: p.where, provider: "tavily" }));
    assert.deepEqual([on.changed, on.from, on.to], [true, "none", "tavily"]);
    assert.equal((await reconcileGrant(p.where, GRANT.RESEARCH, { research: "tavily" })).standing, STANDING.ASK);

    const back = tavily();
    const a = answering(false, back.seen);
    const r = await run(p, { presence: "present", ask: a.ask, adapter: back.adapter });
    assert.equal(a.asked.length, 1, "returning to tavily reused the grant given before the change to none");
    assert.deepEqual([a.asked[0].keyReads, a.asked[0].requests], [0, 0]);
    assert.equal(r.outcome, RESEARCH_OUTCOME.USER_DISABLED);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ the grant is cleared before the choice is written, so a failed write leaves no grant behind", async () => {
  const p = project({ research: "tavily" });
  try {
    await recordGrant(p.where, { grant: GRANT.RESEARCH, granted: true, choice: { research: "tavily" } });
    // An edit after the transaction planned the record makes its merge refuse.
    await assert.rejects(
      withTx(p.dir, (transaction) => {
        writeFileSync(join(p.dir, ".pi", "kiln.json"), readFileSync(join(p.dir, ".pi", "kiln.json"), "utf8") + " ");
        return writeResearchChoice({ transaction, location: p.where, provider: "none" });
      }),
      (e) => e?.reason === "concurrent-edit"
    );
    assert.equal(committed(p.dir), "tavily", "the choice was written despite the refusal");
    assert.equal("research" in readConsent(p.where).record, false, "the grant outlived a choice change that was attempted");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

/**
 * D1: disabling succeeds when the grant cannot be cleared, and the next Kiln write back to `tavily` must
 * clear it first. `blocked` makes the record uncleareable; `unblock` makes it clearable again.
 */
async function disableThenEnable({ blocked, unblock }) {
  const p = project({ research: "tavily" });
  try {
    await recordGrant(p.where, { grant: GRANT.RESEARCH, granted: true, choice: { research: "tavily" } });
    const grantBytes = readFileSync(p.where.path, "utf8");
    const stuck = blocked(p);

    // Disabling succeeds without the clear, both through the writer and through --research disabled.
    const off = await withTx(p.dir, (transaction) => writeResearchChoice({ transaction, location: stuck, provider: "none" }));
    assert.deepEqual([off.changed, off.to, off.cleared], [true, "none", []]);
    assert.ok(off.uncleared, "the writer did not say the grant was left in place");
    assert.equal(committed(p.dir), "none");
    assert.equal(readFileSync(p.where.path, "utf8"), grantBytes, "the uncleareable record was written");

    const t = tavily();
    const viaSetup = await withTx(p.dir, (transaction) => setUpResearch({ transaction, location: stuck, presence: "present", request: "disabled", adapter: t.adapter }));
    assert.equal(viaSetup.outcome, RESEARCH_OUTCOME.USER_DISABLED);
    assert.deepEqual([t.seen.keyReads, t.seen.requests.length], [0, 0]);

    // Enabling while the grant still cannot be cleared is refused, and changes nothing.
    await assert.rejects(
      withTx(p.dir, (transaction) => writeResearchChoice({ transaction, location: stuck, provider: "tavily" })),
      (e) => e instanceof ResearchChoiceRefusal && e.reason === off.uncleared && /was not changed/.test(e.message)
    );
    await assert.rejects(
      withTx(p.dir, (transaction) => setUpResearch({ transaction, location: stuck, presence: "present", request: "tavily", adapter: t.adapter })),
      ResearchChoiceRefusal
    );
    assert.equal(committed(p.dir), "none");
    assert.equal(readFileSync(p.where.path, "utf8"), grantBytes);

    // Once the record can be cleared, enabling clears the old grant first, and the next setup asks.
    const clearable = unblock(p);
    const on = await withTx(p.dir, (transaction) => writeResearchChoice({ transaction, location: clearable, provider: "tavily" }));
    assert.deepEqual([on.changed, on.to, on.cleared], [true, "tavily", [GRANT.RESEARCH]]);
    assert.equal("research" in readConsent(clearable).record, false, "the grant from before the disable survived");
    const back = tavily();
    const a = answering(false, back.seen);
    await withTx(p.dir, (transaction) => setUpResearch({ transaction, location: clearable, presence: "present", ask: a.ask, adapter: back.adapter }));
    assert.equal(a.asked.length, 1, "the pre-disable grant was reused");
    assert.deepEqual([a.asked[0].keyReads, a.asked[0].requests], [0, 0]);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
}

test("⚠️ D1 with Git unavailable: disabling succeeds, and enabling waits for a clear", () =>
  disableThenEnable({
    blocked: (p) => consentLocation({ projectRoot: p.dir, git: "kiln-no-such-git-binary" }),
    unblock: (p) => p.where,
  }));

test("⚠️ D1 with a tracked record: disabling succeeds, and enabling waits until the removal is committed", () =>
  disableThenEnable({
    blocked: (p) => {
      git(p.dir, "add", "-f", ".pi/runtime/consent.json");
      return p.where;
    },
    unblock: (p) => {
      // A staged removal is not enough: the record is still in HEAD once committed.
      git(p.dir, "-c", "user.name=kiln-test", "-c", "user.email=kiln-test@example.invalid", "commit", "-q", "-m", "tracked");
      git(p.dir, "rm", "-q", "--cached", ".pi/runtime/consent.json");
      git(p.dir, "-c", "user.name=kiln-test", "-c", "user.email=kiln-test@example.invalid", "commit", "-q", "-m", "untracked");
      return p.where;
    },
  }));

test("⚠️ D4 a stale grant needs fresh approval, and a failed probe leaves both files byte-identical", async () => {
  const p = project();
  try {
    // No research choice, and a Tavily grant left from an earlier choice.
    await recordGrant(p.where, { grant: GRANT.RESEARCH, granted: true, choice: { research: "tavily" } });
    const kiln = join(p.dir, ".pi", "kiln.json");
    const before = { kiln: readFileSync(kiln), consent: readFileSync(p.where.path) };

    for (const shape of [{ status: 401 }, { status: 429 }, { throws: new Error("down") }]) {
      const t = tavily(shape);
      const a = answering(true, t.seen);
      const r = await run(p, { presence: "present", ask: a.ask, adapter: t.adapter });
      assert.equal(a.asked.length, 1, "the stale grant was used instead of asking");
      assert.deepEqual([a.asked[0].keyReads, a.asked[0].requests], [0, 0]);
      assert.notEqual(r.outcome, RESEARCH_OUTCOME.AVAILABLE);
      assert.ok(readFileSync(kiln).equals(before.kiln), `kiln.json changed after ${r.outcome}`);
      assert.ok(readFileSync(p.where.path).equals(before.consent), `the consent record changed after ${r.outcome}`);
    }
    // The paths that decide nothing also change nothing.
    for (const presence of ["absent", "not-inspected"]) {
      await run(p, { presence, ask: () => true, adapter: tavily().adapter });
      assert.ok(readFileSync(p.where.path).equals(before.consent), `${presence} changed the consent record`);
    }

    // A successful probe is what replaces it.
    const ok = await run(p, { presence: "present", ask: () => true, adapter: tavily().adapter });
    assert.equal(ok.outcome, RESEARCH_OUTCOME.AVAILABLE);
    assert.equal(committed(p.dir), "tavily");
    assert.notEqual(readConsent(p.where).record.research.decidedAt, JSON.parse(before.consent).research.decidedAt, "the stale grant was kept rather than replaced");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("D3 every disabled outcome says how to enable research later", async () => {
  const p = project();
  try {
    const r = await run(p, { presence: "present", ask: () => false, adapter: tavily().adapter });
    assert.equal(r.outcome, RESEARCH_OUTCOME.USER_DISABLED);
    assert.equal(r.hint, ENABLE_LATER);
    assert.match(ENABLE_LATER, /--research tavily/);
    const off = await run(p, { presence: "present", request: "disabled", adapter: tavily().adapter });
    assert.equal(off.hint, ENABLE_LATER);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("reconciling research does not touch the model-use grant", async () => {
  const p = project({ research: "tavily" });
  try {
    await recordGrant(p.where, { grant: GRANT.MODEL_USE, granted: true, choice: { model: { provider: "anthropic", model: "claude-opus-5" } } });
    await recordGrant(p.where, { grant: GRANT.RESEARCH, granted: true, choice: { research: "tavily" } });
    const r = await reconcileGrant(p.where, GRANT.RESEARCH, { research: "none" });
    assert.deepEqual(r.cleared, [GRANT.RESEARCH]);
    assert.equal(readConsent(p.where).record.modelUse.granted, true, "a research-only reconcile cleared the model grant");
    await assert.rejects(reconcileGrant(p.where, GRANT.RESEARCH, {}), TypeError);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});
