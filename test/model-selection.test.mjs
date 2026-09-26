/**
 * Model discovery, explicit selection and persistence — TSK-0036, against ACC-0055 and toward ACC-0054.
 *
 * ⚠️ **"BILLABLE USE ENABLED" IS OBSERVED AS THE GRANT.** Nothing here calls a model. What authorises
 * ongoing billable use is this host's model-use grant for an exact provider and model, so each control
 * asserts what the consent record and `.pi/settings.json` hold afterwards, byte for byte where it matters.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONSENT_READ, GRANT, STANDING, consentLocation, peekGrant, readConsent, recordGrant } from "../lib/consent-record.mjs";
import { inspectConnections } from "../lib/connection-inspection.mjs";
import {
  ModelSelectionRefusal,
  SELECTION_OUTCOME,
  SELECTION_REFUSAL,
  committedSelection,
  confirmationPrompt,
  loadThinkingSupport,
  modelUseStanding,
  selectModel,
} from "../lib/model-selection.mjs";
import { blockText } from "../lib/project-gitignore.mjs";
import { settingsTarget } from "../lib/pi-settings.mjs";
import { runTransaction } from "../lib/setup-transaction.mjs";

const PROJECT_ID = "00112233445566778899aabbccddeeff";
const A = { provider: "anthropic", model: "claude-opus-5" };
const B = { provider: "openai", model: "gpt-5" };

const INSPECTION = {
  inspected: true,
  providers: [
    { provider: "anthropic", displayName: "Anthropic", models: ["claude-opus-5", "claude-sonnet-5"] },
    { provider: "openai", displayName: "OpenAI", models: ["gpt-5"] },
  ],
};

/** A stand-in for Pi's registry: every listed model supports off to high. The real one is used below. */
const REASONING = Object.freeze(["off", "minimal", "low", "medium", "high"]);
const SUPPORT = Object.freeze({ levelsFor: () => REASONING });

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function project({ selection = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-model-"));
  const dir = join(root, "project");
  mkdirSync(join(dir, ".pi", "runtime"), { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), blockText());
  writeFileSync(join(dir, ".pi", "kiln.json"), JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID }, null, 2) + "\n");
  if (selection) writeSettings(dir, selection);
  return { root, dir, where: consentLocation({ projectRoot: dir }) };
}

const settingsPath = (dir) => join(dir, ".pi", "settings.json");
/** Settings exactly as the merge writes them for project-local state, so a no-op merge is byte-identical. */
function writeSettings(dir, { provider, model, thinkingLevel = "high" }, extra = {}) {
  writeFileSync(
    settingsPath(dir),
    JSON.stringify({ ...extra, defaultProvider: provider, defaultModel: model, defaultThinkingLevel: thinkingLevel, skills: ["../planning-content/skills-overrides"], sessionDir: ".pi/sessions" }, null, 2)
  );
}
const bytes = (path) => (existsSync(path) ? readFileSync(path) : null);

/** An `ask` that answers from a queue and keeps every prompt. */
function answering(...answers) {
  const asked = [];
  return { asked, ask: (prompt) => (asked.push(prompt), answers.shift()) };
}

const select = (p, opts) =>
  runTransaction({ projectRoot: p.dir, files: [settingsTarget()] }, (transaction) =>
    selectModel({ transaction, thinkingSupport: SUPPORT, location: p.where, inspection: INSPECTION, settings: { stateMode: "project" }, ...opts })
  );

const grantOf = (p) => readConsent(p.where).record?.modelUse ?? null;
const confirmations = (asked) => asked.filter((q) => q.startsWith("Use this model for this project?"));

test("⚠️ ACC-0055 a single available model is shown and confirmed before it is assigned, even when its id looks like an alias", async () => {
  const single = { inspected: true, providers: [{ provider: "kiln-local", displayName: "Kiln Local", models: ["kiln-latest"] }] };
  const run = (p, a) =>
    runTransaction({ projectRoot: p.dir, files: [settingsTarget()] }, (transaction) =>
      selectModel({ transaction, thinkingSupport: SUPPORT, location: p.where, inspection: single, settings: { stateMode: "project" }, requested: { thinking: "high" }, ...a })
    );

  for (const [label, answer, outcome] of [["no", false, SELECTION_OUTCOME.DECLINED], ["closed", null, SELECTION_OUTCOME.CANCELLED], ["a string", "yes", SELECTION_OUTCOME.CANCELLED]]) {
    const p = project();
    try {
      const a = answering("1", answer);
      const r = await run(p, { ask: a.ask });
      assert.equal(r.outcome, outcome, label);
      assert.equal(confirmations(a.asked).length, 1, `${label}: the single model was not confirmed`);
      assert.equal(existsSync(settingsPath(p.dir)), false, `${label}: a selection was written without a yes`);
      assert.equal(readConsent(p.where).state, CONSENT_READ.ABSENT, `${label}: something was granted without a yes`);
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  }

  const p = project();
  try {
    const a = answering("1", true);
    const r = await run(p, { ask: a.ask });
    const prompt = confirmations(a.asked)[0];
    assert.match(prompt, /Provider: Kiln Local \(kiln-local\)/);
    assert.match(prompt, /Model: {4}kiln-latest/);
    assert.match(prompt, /billable tokens or provider quota/);
    assert.match(prompt, /its charges are yours/);
    assert.equal(r.outcome, SELECTION_OUTCOME.SELECTED);
    assert.deepEqual(committedSelection(p.dir), { provider: "kiln-local", model: "kiln-latest", thinkingLevel: "high" });
    assert.deepEqual({ ...grantOf(p), decidedAt: null }, { granted: true, decidedAt: null, provider: "kiln-local", model: "kiln-latest" });
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0055 no default is adopted: the first entry is never taken, and no answer is no choice", async () => {
  for (const answer of [null, undefined, "", "q", "0", "4", "1.0", " first", "anthropic"]) {
    const p = project();
    try {
      const a = answering(answer, "high", true);
      const r = await select(p, { ask: a.ask, print: () => {} });
      assert.equal(r.outcome, SELECTION_OUTCOME.CANCELLED, `${JSON.stringify(answer)} chose a model`);
      assert.equal(confirmations(a.asked).length, 0);
      assert.equal(existsSync(settingsPath(p.dir)), false);
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  }
  // No thinking level is assumed either.
  const p = project();
  try {
    const r = await select(p, { ask: answering("2", "").ask });
    assert.equal(r.outcome, SELECTION_OUTCOME.CANCELLED);
    assert.equal(existsSync(settingsPath(p.dir)), false);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("the list shows every available model by display name and exact id, with nothing marked as a default", async () => {
  const p = project();
  try {
    const lines = [];
    await select(p, { ask: answering("q").ask, print: (l) => lines.push(l) });
    assert.deepEqual(lines, ["3 models can be used on this computer:", "  1. Anthropic — claude-opus-5", "  2. Anthropic — claude-sonnet-5", "  3. OpenAI — gpt-5"]);
    assert.equal(lines.some((l) => /default|recommended|\*/i.test(l)), false);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0055 a committed selection, as Pi may write after a login, is not used on this host without confirmation", async () => {
  const p = project({ selection: A });
  try {
    const before = bytes(settingsPath(p.dir));
    assert.equal(modelUseStanding(p.where).standing, STANDING.ASK);

    const a = answering(true);
    const r = await select(p, { ask: a.ask });
    assert.equal(r.outcome, SELECTION_OUTCOME.CONFIRMED);
    assert.equal(confirmations(a.asked).length, 1);
    assert.ok(bytes(settingsPath(p.dir)).equals(before), "confirming the unchanged selection rewrote settings");
    assert.deepEqual({ ...grantOf(p), decidedAt: null }, { granted: true, decidedAt: null, ...A });

    const again = answering(false);
    assert.equal((await select(p, { ask: again.ask })).outcome, SELECTION_OUTCOME.REUSED);
    assert.equal(again.asked.length, 0, "an unchanged selection with a grant was asked again");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }

  // A decline of the project's own selection is this host's decision, and is kept.
  const q = project({ selection: A });
  try {
    assert.equal((await select(q, { ask: answering(false).ask })).outcome, SELECTION_OUTCOME.DECLINED);
    assert.deepEqual({ ...grantOf(q), decidedAt: null }, { granted: false, decidedAt: null, ...A });
    const again = answering(true);
    assert.equal((await select(q, { ask: again.ask })).outcome, SELECTION_OUTCOME.DECLINED);
    assert.equal(again.asked.length, 0);
    assert.deepEqual(committedSelection(q.dir), { ...A, thinkingLevel: "high" });
  } finally {
    rmSync(q.root, { recursive: true, force: true });
  }
});

test("⚠️ a declined thinking-level change leaves the approved selection, its grant and settings exactly as they were", async () => {
  const p = project({ selection: A });
  try {
    await select(p, { ask: answering(true).ask });
    assert.deepEqual({ ...grantOf(p), decidedAt: null }, { granted: true, decidedAt: null, ...A });
    const before = { settings: bytes(settingsPath(p.dir)), consent: bytes(p.where.path) };

    const a = answering(false);
    const r = await select(p, { ask: a.ask, requested: { thinking: "low" } });
    assert.equal(r.outcome, SELECTION_OUTCOME.DECLINED);
    assert.equal(confirmations(a.asked).length, 1, "the thinking change was not confirmed");
    assert.match(confirmations(a.asked)[0], /Thinking: low/);
    assert.ok(bytes(settingsPath(p.dir)).equals(before.settings), "settings changed after the change was declined");
    assert.ok(bytes(p.where.path).equals(before.consent), "the grant changed after the change was declined");

    // The approved selection is still reused without asking.
    const again = answering(false);
    assert.equal((await select(p, { ask: again.ask })).outcome, SELECTION_OUTCOME.REUSED);
    assert.equal(again.asked.length, 0);

    // A declined change of model through the flags leaves it the same way.
    const b = answering(false);
    assert.equal((await select(p, { ask: b.ask, requested: { ...B, thinking: "high" } })).outcome, SELECTION_OUTCOME.DECLINED);
    assert.ok(bytes(settingsPath(p.dir)).equals(before.settings));
    assert.ok(bytes(p.where.path).equals(before.consent));
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("a committed selection this computer cannot use is not replaced silently", async () => {
  const p = project({ selection: { provider: "gone", model: "gone-1" } });
  try {
    const lines = [];
    const r = await select(p, { ask: answering("q").ask, print: (l) => lines.push(l) });
    assert.equal(r.outcome, SELECTION_OUTCOME.CANCELLED);
    assert.match(lines[0], /gone gone-1, is not available on this computer/);
    assert.deepEqual(committedSelection(p.dir), { provider: "gone", model: "gone-1", thinkingLevel: "high" });
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("--provider, --model and --thinking are checked against discovery before anything is asked or written", async () => {
  for (const [requested, reason] of [
    [{ provider: "anthropic", model: "claude-opus-5", thinking: "extreme" }, SELECTION_REFUSAL.INVALID_THINKING],
    [{ provider: "anthropic" }, SELECTION_REFUSAL.INCOMPLETE_REQUEST],
    [{ model: "gpt-5" }, SELECTION_REFUSAL.INCOMPLETE_REQUEST],
    [{ provider: "mistral", model: "large" }, SELECTION_REFUSAL.UNKNOWN_PROVIDER],
    [{ provider: "openai", model: "gpt-5-latest" }, SELECTION_REFUSAL.MODEL_NOT_AVAILABLE],
    [{ provider: "openai", model: "claude-opus-5" }, SELECTION_REFUSAL.MODEL_NOT_AVAILABLE],
  ]) {
    const p = project();
    try {
      const a = answering(true, true);
      await assert.rejects(select(p, { ask: a.ask, requested }), (e) => e instanceof ModelSelectionRefusal && e.reason === reason, JSON.stringify(requested));
      assert.equal(a.asked.length, 0);
      assert.equal(existsSync(settingsPath(p.dir)), false);
      assert.equal(readConsent(p.where).state, CONSENT_READ.ABSENT);
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  }

  // Valid flags still need confirmation, and a run that cannot ask refuses.
  const p = project();
  try {
    await assert.rejects(select(p, { requested: { ...B, thinking: "low" } }), (e) => e.reason === SELECTION_REFUSAL.NEEDS_CONFIRMATION);
    assert.equal(existsSync(settingsPath(p.dir)), false);
    const a = answering(true);
    const r = await select(p, { ask: a.ask, requested: { ...B, thinking: "low" } });
    assert.equal(confirmations(a.asked).length, 1);
    assert.equal(r.outcome, SELECTION_OUTCOME.SELECTED);
    assert.deepEqual(committedSelection(p.dir), { ...B, thinkingLevel: "low" });
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("the selection is merged into settings, keeping keys Kiln does not own", async () => {
  const p = project();
  try {
    writeSettings(p.dir, A, { theme: "dark", packages: ["npm:someone-else"] });
    await select(p, { ask: answering(true).ask, requested: { ...B, thinking: "medium" } });
    const s = JSON.parse(readFileSync(settingsPath(p.dir), "utf8"));
    assert.equal(s.theme, "dark");
    assert.deepEqual(s.packages, ["npm:someone-else"]);
    assert.deepEqual([s.defaultProvider, s.defaultModel, s.defaultThinkingLevel], ["openai", "gpt-5", "medium"]);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0054 changing the model away and back reopens approval, and the old grant never comes back", async () => {
  const p = project();
  try {
    await select(p, { ask: answering(true).ask, requested: { ...A, thinking: "high" } });
    assert.deepEqual({ ...grantOf(p), decidedAt: null }, { granted: true, decidedAt: null, ...A });

    // A → B: A's grant is cleared before B is written, and B is granted on its own yes.
    const toB = await select(p, { ask: answering(true).ask, requested: { ...B, thinking: "high" } });
    assert.deepEqual(toB.cleared, [GRANT.MODEL_USE]);
    assert.deepEqual({ ...grantOf(p), decidedAt: null }, { granted: true, decidedAt: null, ...B });
    assert.equal(peekGrant(p.where, GRANT.MODEL_USE, { model: A }).standing, STANDING.ASK);

    // B → A asks, and a no changes nothing.
    const declined = answering(false);
    assert.equal((await select(p, { ask: declined.ask, requested: { ...A, thinking: "high" } })).outcome, SELECTION_OUTCOME.DECLINED);
    assert.equal(confirmations(declined.asked).length, 1, "returning to A was not asked");
    assert.deepEqual(committedSelection(p.dir), { ...B, thinkingLevel: "high" });
    assert.deepEqual({ ...grantOf(p), decidedAt: null }, { granted: true, decidedAt: null, ...B });

    // B → A by hand, outside Kiln: the next setup sees B's grant as stale and asks for A.
    writeSettings(p.dir, A);
    assert.equal(modelUseStanding(p.where).standing, STANDING.ASK);
    const byHand = answering(true);
    assert.equal((await select(p, { ask: byHand.ask })).outcome, SELECTION_OUTCOME.CONFIRMED);
    assert.equal(confirmations(byHand.asked).length, 1, "A was used on the strength of an older grant");
    assert.deepEqual({ ...grantOf(p), decidedAt: null }, { granted: true, decidedAt: null, ...A });
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ the old grant is cleared before the new selection is written, so a failed write leaves no grant", async () => {
  const p = project({ selection: A });
  try {
    await recordGrant(p.where, { grant: GRANT.MODEL_USE, granted: true, choice: { model: A } });
    await assert.rejects(
      runTransaction({ projectRoot: p.dir, files: [settingsTarget()] }, (transaction) => {
        writeFileSync(settingsPath(p.dir), readFileSync(settingsPath(p.dir), "utf8") + "\n");
        return selectModel({ transaction, thinkingSupport: SUPPORT, location: p.where, inspection: INSPECTION, settings: { stateMode: "project" }, ask: () => true, requested: { ...B, thinking: "high" } });
      }),
      (e) => e?.reason === "concurrent-edit"
    );
    assert.deepEqual(committedSelection(p.dir), { ...A, thinkingLevel: "high" });
    assert.equal(grantOf(p), null, "A's grant outlived a change to B that was attempted");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

/** A changed selection whose old grant cannot be cleared is refused before anything is written or granted. */
async function refusedWithoutClear(block) {
  const p = project({ selection: A });
  try {
    await recordGrant(p.where, { grant: GRANT.MODEL_USE, granted: true, choice: { model: A } });
    const where = block(p);
    const before = { settings: bytes(settingsPath(p.dir)), consent: bytes(p.where.path) };
    await assert.rejects(
      runTransaction({ projectRoot: p.dir, files: [settingsTarget()] }, (transaction) =>
        selectModel({ transaction, thinkingSupport: SUPPORT, location: where, inspection: INSPECTION, settings: { stateMode: "project" }, ask: () => true, requested: { ...B, thinking: "high" } })
      ),
      (e) => e instanceof ModelSelectionRefusal && e.reason === SELECTION_REFUSAL.GRANT_NOT_CLEARED && /nothing was enabled/.test(e.message)
    );
    assert.ok(bytes(settingsPath(p.dir)).equals(before.settings), "settings changed");
    assert.ok(bytes(p.where.path).equals(before.consent), "the consent record changed");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
}

test("⚠️ a changed selection is refused before billable use when Git is unavailable", () =>
  refusedWithoutClear((p) => consentLocation({ projectRoot: p.dir, git: "kiln-no-such-git-binary" })));

test("⚠️ a changed selection is refused before billable use when the consent record is tracked", () =>
  refusedWithoutClear((p) => {
    git(p.dir, "add", "-f", ".pi/runtime/consent.json");
    return p.where;
  }));

test("an uninspected host has nothing to choose from", async () => {
  const p = project();
  try {
    await assert.rejects(
      runTransaction({ projectRoot: p.dir, files: [settingsTarget()] }, (transaction) =>
        selectModel({ transaction, thinkingSupport: SUPPORT, location: p.where, inspection: { inspected: false }, settings: { stateMode: "project" }, ask: () => true })
      ),
      (e) => e.reason === SELECTION_REFUSAL.NOT_INSPECTED
    );
    assert.equal(confirmationPrompt({ displayName: "X", provider: "x", model: "x-1", thinkingLevel: "off" }).includes("x-1"), true);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

/**
 * ⚠️ THE REAL REGISTRY AND PI'S OWN RULE. An isolated Pi agent directory with one custom provider holding a
 * non-reasoning model and a reasoning one, both authenticated by an inline sentinel key. The inspection is
 * run for real, and the supported levels come from `loadThinkingSupport`, which applies the pinned Pi's
 * `getSupportedThinkingLevels` to the registry's model.
 */
async function realPi() {
  const root = mkdtempSync(join(tmpdir(), "kiln-model-pi-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "kiln-local": {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "kiln-model-INLINE-SENTINEL-51d0",
          models: [
            { id: "kiln-plain", name: "Plain", reasoning: false, contextWindow: 8192, maxTokens: 1024 },
            { id: "kiln-reasoner", name: "Reasoner", reasoning: true, contextWindow: 8192, maxTokens: 1024 },
          ],
        },
      },
    })
  );
  const saved = process.env;
  process.env = {};
  try {
    const inspection = await inspectConnections({ agentDir, ask: () => true });
    const support = await loadThinkingSupport({ inspection, agentDir });
    return { root, inspection, support };
  } finally {
    process.env = saved;
  }
}

const selectReal = (p, pi, opts) =>
  runTransaction({ projectRoot: p.dir, files: [settingsTarget()] }, (transaction) =>
    selectModel({ transaction, location: p.where, inspection: pi.inspection, thinkingSupport: pi.support, settings: { stateMode: "project" }, ...opts })
  );

test("⚠️ the supported levels are Pi's own: a non-reasoning model supports only off", async () => {
  const pi = await realPi();
  try {
    const local = pi.inspection.providers.find((x) => x.provider === "kiln-local");
    assert.deepEqual(local?.models, ["kiln-plain", "kiln-reasoner"], "the fixture models are not both available");
    assert.deepEqual(pi.support.levelsFor("kiln-local", "kiln-plain"), ["off"]);
    assert.deepEqual(pi.support.levelsFor("kiln-local", "kiln-reasoner"), ["off", "minimal", "low", "medium", "high"]);
    assert.equal(pi.support.levelsFor("kiln-local", "not-listed"), null);
    await assert.rejects(loadThinkingSupport({ inspection: { inspected: false } }), (e) => e.reason === SELECTION_REFUSAL.NOT_INSPECTED);
  } finally {
    rmSync(pi.root, { recursive: true, force: true });
  }
});

test("a model whose thinking support Pi cannot report is refused before confirmation or persistence", async () => {
  const p = project();
  try {
    const unknown = { levelsFor: (provider) => (provider === "openai" ? null : REASONING) };
    for (const opts of [{ requested: { ...B, thinking: "off" } }, { requested: {}, answers: ["3", "off", true] }]) {
      const a = answering(...(opts.answers ?? [true]));
      await assert.rejects(
        runTransaction({ projectRoot: p.dir, files: [settingsTarget()] }, (transaction) =>
          selectModel({ transaction, thinkingSupport: unknown, location: p.where, inspection: INSPECTION, settings: { stateMode: "project" }, ask: a.ask, requested: opts.requested })
        ),
        (e) => e instanceof ModelSelectionRefusal && e.reason === SELECTION_REFUSAL.THINKING_UNKNOWN
      );
      assert.equal(confirmations(a.asked).length, 0);
      assert.equal(existsSync(settingsPath(p.dir)), false);
      assert.equal(readConsent(p.where).state, CONSENT_READ.ABSENT);
    }
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ a non-reasoning model rejects --thinking high before confirmation or persistence, and accepts off", async () => {
  const pi = await realPi();
  const p = project();
  try {
    const a = answering(true);
    await assert.rejects(
      selectReal(p, pi, { ask: a.ask, requested: { provider: "kiln-local", model: "kiln-plain", thinking: "high" } }),
      (e) =>
        e instanceof ModelSelectionRefusal &&
        e.reason === SELECTION_REFUSAL.THINKING_NOT_SUPPORTED &&
        /does not support thinking level "high"/.test(e.message) &&
        JSON.stringify(e.detail.supported) === JSON.stringify(["off"])
    );
    assert.equal(a.asked.length, 0, "a confirmation was shown for a level Pi would not run");
    assert.equal(existsSync(settingsPath(p.dir)), false, "an unsupported level was persisted");
    assert.equal(readConsent(p.where).state, CONSENT_READ.ABSENT, "model use was granted for an unsupported level");

    const ok = answering(true);
    const r = await selectReal(p, pi, { ask: ok.ask, requested: { provider: "kiln-local", model: "kiln-plain", thinking: "off" } });
    assert.equal(r.outcome, SELECTION_OUTCOME.SELECTED);
    assert.match(confirmations(ok.asked)[0], /Thinking: off/);
    assert.deepEqual(committedSelection(p.dir), { provider: "kiln-local", model: "kiln-plain", thinkingLevel: "off" });

    // The reasoning model accepts high, and rejects xhigh, which Pi maps for it to nothing.
    const q = project();
    try {
      await assert.rejects(selectReal(q, pi, { ask: () => true, requested: { provider: "kiln-local", model: "kiln-reasoner", thinking: "xhigh" } }), (e) => e.reason === SELECTION_REFUSAL.THINKING_NOT_SUPPORTED);
      assert.equal(existsSync(settingsPath(q.dir)), false);
      assert.equal((await selectReal(q, pi, { ask: () => true, requested: { provider: "kiln-local", model: "kiln-reasoner", thinking: "high" } })).outcome, SELECTION_OUTCOME.SELECTED);
    } finally {
      rmSync(q.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(pi.root, { recursive: true, force: true });
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ interactively, only the levels the chosen model supports are offered, and no other is accepted", async () => {
  const pi = await realPi();
  const p = project();
  try {
    // 1 is kiln-plain: the question offers only off, and "high" is no answer.
    const refused = answering("1", "high", true);
    assert.equal((await selectReal(p, pi, { ask: refused.ask })).outcome, SELECTION_OUTCOME.CANCELLED);
    assert.equal(refused.asked[1], "Thinking level? (off) ");
    assert.equal(confirmations(refused.asked).length, 0);
    assert.equal(existsSync(settingsPath(p.dir)), false);

    const reasoner = answering("2", "high", false);
    await selectReal(p, pi, { ask: reasoner.ask });
    assert.equal(reasoner.asked[1], "Thinking level? (off, minimal, low, medium, high) ");

    const plain = answering("1", "off", true);
    assert.equal((await selectReal(p, pi, { ask: plain.ask })).outcome, SELECTION_OUTCOME.SELECTED);
    assert.deepEqual(committedSelection(p.dir), { provider: "kiln-local", model: "kiln-plain", thinkingLevel: "off" });
  } finally {
    rmSync(pi.root, { recursive: true, force: true });
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ a committed level the model does not support is not confirmed as if it would run", async () => {
  const pi = await realPi();
  const p = project({ selection: { provider: "kiln-local", model: "kiln-plain", thinkingLevel: "high" } });
  try {
    const before = bytes(settingsPath(p.dir));
    // Even with a grant for the model, the unsupported committed level is not reused.
    await recordGrant(p.where, { grant: GRANT.MODEL_USE, granted: true, choice: { model: { provider: "kiln-local", model: "kiln-plain" } } });
    const lines = [];
    const cancelled = answering("");
    assert.equal((await selectReal(p, pi, { ask: cancelled.ask, print: (l) => lines.push(l) })).outcome, SELECTION_OUTCOME.CANCELLED);
    assert.match(lines[0], /does not support the committed thinking level "high"/);
    assert.equal(cancelled.asked[0], "Thinking level? (off) ");
    assert.ok(bytes(settingsPath(p.dir)).equals(before));

    const a = answering("off", true);
    assert.equal((await selectReal(p, pi, { ask: a.ask })).outcome, SELECTION_OUTCOME.CONFIRMED);
    assert.match(confirmations(a.asked)[0], /Thinking: off/);
    assert.equal(committedSelection(p.dir).thinkingLevel, "off");
  } finally {
    rmSync(pi.root, { recursive: true, force: true });
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ TSK-0063 a rerun naming the committed selection with --model-use approve reuses the standing grant and writes nothing", async () => {
  const p = project();
  const via = (name) => () => name;
  const flags = { requested: { ...A, thinking: "high" }, confirmation: true };
  try {
    const first = await select(p, { ...flags, credentialFor: via("KEY_ONE") });
    assert.equal(first.outcome, SELECTION_OUTCOME.SELECTED);
    const before = { settings: bytes(settingsPath(p.dir)), consent: bytes(p.where.path) };

    // The same provider, model, level and variable, with the grant standing: reused, silently, byte for byte.
    const printed = [];
    const again = await select(p, { ...flags, credentialFor: via("KEY_ONE"), print: (l) => printed.push(l) });
    assert.equal(again.outcome, SELECTION_OUTCOME.REUSED);
    assert.deepEqual(printed, [], "a reused grant printed a new confirmation");
    assert.ok(bytes(settingsPath(p.dir)).equals(before.settings), "settings changed");
    assert.ok(bytes(p.where.path).equals(before.consent), "the grant was recorded again");

    // A different variable is a different grant: it is confirmed again, and recorded.
    const other = await select(p, { ...flags, credentialFor: via("KEY_TWO"), print: () => {} });
    assert.equal(other.outcome, SELECTION_OUTCOME.SELECTED, "a new variable was not taken through the decision path");
    assert.equal(grantOf(p).credentialVar, "KEY_TWO");

    // A different thinking level is a change: confirmed again, and recorded.
    const level = await select(p, { requested: { ...A, thinking: "low" }, confirmation: true, credentialFor: via("KEY_TWO"), print: () => {} });
    assert.equal(level.outcome, SELECTION_OUTCOME.SELECTED, "a new level was not taken through the decision path");
    assert.equal(committedSelection(p.dir).thinkingLevel, "low");

    // An explicit deny still takes its existing decision path: declined, never reused, and through the flags it
    // refuses the change without recording anything.
    const consentBeforeDeny = bytes(p.where.path);
    const denied = await select(p, { requested: { ...A, thinking: "low" }, confirmation: false, credentialFor: via("KEY_TWO"), print: () => {} });
    assert.equal(denied.outcome, SELECTION_OUTCOME.DECLINED);
    assert.ok(bytes(p.where.path).equals(consentBeforeDeny), "a deny through the flags recorded a decision");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0089 (4) a sole available model is not adopted without a confirmation: a run that cannot ask refuses as needs-confirmation", async () => {
  // One model is what this computer offers and the flags name it, so there is nothing to choose between; it is still
  // not this project's until someone says yes, and a run with nobody to ask refuses rather than taking it.
  const single = { inspected: true, providers: [{ provider: "kiln-local", displayName: "Kiln Local", models: ["kiln-latest"] }] };
  const p = project();
  try {
    await assert.rejects(
      runTransaction({ projectRoot: p.dir, files: [settingsTarget()] }, (transaction) =>
        selectModel({
          transaction,
          thinkingSupport: SUPPORT,
          location: p.where,
          inspection: single,
          settings: { stateMode: "project" },
          requested: { provider: "kiln-local", model: "kiln-latest", thinking: "high" },
        })
      ),
      (e) => e.reason === SELECTION_REFUSAL.NEEDS_CONFIRMATION
    );
    assert.equal(existsSync(settingsPath(p.dir)), false, "the sole model was written without a yes");
    assert.equal(readConsent(p.where).state, CONSENT_READ.ABSENT, "something was granted without a yes");
  } finally {
    rmSync(p.root ?? p.dir, { recursive: true, force: true });
  }
});
