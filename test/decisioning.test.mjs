import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GRANT, consentLocation, recordGrant } from "../lib/consent-record.mjs";
import { DECISIONING_REFUSAL, decisioningPermission } from "../lib/decisioning/permission.mjs";
import { permittedToolFamilies } from "../lib/decisioning/policy.mjs";
import { createDecisioningTools } from "../lib/decisioning/tools.mjs";
import { createTypeSafeAdapter } from "../lib/decisioning/typesafe-adapter.mjs";
import { configureDecisioning } from "../lib/decisioning-enablement.mjs";
import { IGNORE_RULES } from "../lib/project-gitignore.mjs";
import { projectRecordTarget } from "../lib/local-state.mjs";
import { runTransaction } from "../lib/setup-transaction.mjs";

const PROJECT_ID = "0123456789abcdef0123456789abcdef";

test("issue #59: TypeSafe adapter refuses before constructing a client when the key is absent", async () => {
  let clients = 0;
  const adapter = createTypeSafeAdapter({
    env: {},
    clientFactory: async () => {
      clients += 1;
      throw new Error("must not construct");
    },
  });
  assert.equal((await adapter.probe()).reason, "no-credential");
  assert.equal((await adapter.evaluate({ state: "x", questions: { yes: { type: "noul" } } })).reason, "no-credential");
  assert.equal(clients, 0);
});

test("issue #59: TypeSafe adapter probes without inference and returns structured evaluations", async () => {
  const calls = [];
  const adapter = createTypeSafeAdapter({
    env: { TYPESAFE_API_KEY: "temporary-test-key" },
    clientFactory: async (config) => ({
      models: {
        list: async () => {
          calls.push(["models", config.apiKey]);
          return [{ name: "jev-latest" }, { name: "jev-preview" }];
        },
      },
      systemOne: async (request) => {
        calls.push(["systemOne", request]);
        return {
          model: "jev-1.13.0",
          answers: { answer: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 10, output_tokens: 2 },
        };
      },
    }),
  });
  const probe = await adapter.probe();
  assert.equal(probe.ok, true);
  assert.equal(probe.checkedWithoutInference, true);
  const evaluated = await adapter.evaluate({ state: "state", questions: { answer: { type: "noul" } } });
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.model, "jev-1.13.0");
  assert.equal(calls.filter(([name]) => name === "systemOne").length, 1);
});

test("issue #59: adapter failures disclose neither the credential nor remote response bodies", async () => {
  const key = "apikey-secret-sentinel-1234567890";
  const adapter = createTypeSafeAdapter({
    env: { TYPESAFE_API_KEY: key },
    clientFactory: async () => ({
      models: { list: async () => { const error = new Error(`rejected ${key}`); error.status = 401; error.body = key; throw error; } },
    }),
  });
  const result = await adapter.probe();
  assert.equal(result.reason, "auth-failed");
  assert.equal(JSON.stringify(result).includes(key), false);
});

test("issue #59: turn routing is one parallel decision, bounded by stage activities and families", async () => {
  let request;
  const tools = createDecisioningTools({
    name: "stand-in",
    probe: async () => ({ ok: true }),
    evaluate: async (input) => {
      request = input;
      return {
        ok: true,
        backend: "stand-in",
        model: "jev-test",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: {
          activity: { type: "choice", choice: "author", confidence: 0.91, probabilities: { question: 0.08, author: 0.91, attest: 0.01 } },
          tool_family: { type: "choice", choice: "author", confidence: 0.87, probabilities: { read: 0.1, author: 0.87, attest: 0.03 } },
          needs_research: { type: "noul", noul: 0.05 },
          needs_validation: { type: "noul", noul: 0.02 },
          needs_operator_decision: { type: "noul", noul: 0.21 },
        },
      };
    },
  });
  const result = await tools.kiln_route_turn({
    request: "Split authentication into a separate requirement.",
    stage: {
      id: "02-intent-decomposition",
      permittedActivities: ["question", "author", "attest"],
      permittedToolFamilies: ["read", "author", "attest"],
      blockers: [],
      nextAction: { kind: "resolve-gate-finding" },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.activity.choice, "author");
  assert.equal(result.policy.automaticAction, false);
  assert.deepEqual(Object.keys(request.questions), [
    "activity",
    "tool_family",
    "needs_research",
    "needs_validation",
    "needs_operator_decision",
  ]);
  assert.deepEqual(Object.keys(request.questions.activity.criteria), ["question", "author", "attest"]);
  assert.deepEqual(Object.keys(request.questions.tool_family.criteria), ["read", "author", "attest"]);
});

test("issue #59: an out-of-policy routing answer falls back instead of granting a family", async () => {
  const tools = createDecisioningTools({
    name: "stand-in",
    probe: async () => ({ ok: true }),
    evaluate: async () => ({
      ok: true,
      answers: {
        activity: { type: "choice", choice: "exit", confidence: 1, probabilities: { exit: 1 } },
        tool_family: { type: "choice", choice: "mutate", confidence: 1, probabilities: { mutate: 1 } },
        needs_research: { type: "noul", noul: 0 },
        needs_validation: { type: "noul", noul: 0 },
        needs_operator_decision: { type: "noul", noul: 0 },
      },
    }),
  });
  const result = await tools.kiln_route_turn({
    request: "change it",
    stage: { id: "01-intake", permittedActivities: ["question"], permittedToolFamilies: ["read", "author"] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-response");
  assert.match(result.fallback, /existing reasoning path/i);
});

test("issue #59: artifact comparisons batch candidates and preserve probability distributions", async () => {
  let evaluated;
  const tools = createDecisioningTools({
    name: "stand-in",
    probe: async () => ({ ok: true }),
    evaluate: async (input) => {
      evaluated = input;
      return {
        ok: true,
        backend: "stand-in",
        model: "jev-test",
        answers: {
          candidate_0: { type: "choice", choice: "duplicate", confidence: 0.96, probabilities: { distinct: 0.01, duplicate: 0.96, overlaps: 0.02, refines: 0.01, contradicts: 0 } },
          candidate_1: { type: "choice", choice: "distinct", confidence: 0.75, probabilities: { distinct: 0.75, duplicate: 0.05, overlaps: 0.1, refines: 0.05, contradicts: 0.05 } },
        },
      };
    },
  });
  const result = await tools.kiln_compare_artifacts({
    type: "requirement",
    content: "Normal API requests must complete within 500 ms.",
    candidates: [
      { id: "REQ-0012", type: "requirement", artifact: { statement: "Normal requests respond in under half a second." } },
      { id: "REQ-0013", type: "requirement", artifact: { statement: "Requests require authentication." } },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.comparisons.map((entry) => entry.candidateId), ["REQ-0012", "REQ-0013"]);
  assert.equal(result.comparisons[0].relationship.probabilities.duplicate, 0.96);
  assert.equal(Object.keys(evaluated.questions).length, 2, "both comparisons share one API request");
  assert.equal(result.policy.automaticAction, false);
});

test("issue #59: deterministic stage policy decides which families Jev may see", () => {
  const families = permittedToolFamilies({
    nextActivity: { activities: ["question", "author", "delegate", "attest", "exit"] },
    mutationBoundary: { mayMutate: ["reviseArtifact", "setReviewStatus", "setTypeActivation"] },
    delegations: [{ role: "research" }, { role: "validation" }],
  });
  assert.deepEqual(families, ["read", "author", "mutate", "research", "validate", "delegate", "approve", "attest"]);
});

async function permissionProject({ choice = "typesafe", grant = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-decisioning-permission-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), `${IGNORE_RULES.join("\n")}\n`);
  mkdirSync(join(root, ".pi", "runtime"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "kiln.json"),
    JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID, decisioning: { provider: choice } }, null, 2)
  );
  if (grant !== null)
    await recordGrant(
      consentLocation({ projectRoot: root }),
      { grant: GRANT.DECISIONING, granted: grant, choice: { decisioning: "typesafe" } }
    );
  return root;
}

test("issue #59: project choice and host consent are both required", async () => {
  const enabled = await permissionProject();
  const disabled = await permissionProject({ choice: "none", grant: null });
  const ungranted = await permissionProject({ grant: null });
  try {
    assert.deepEqual(decisioningPermission({ projectRoot: enabled }), { permitted: true, provider: "typesafe" });
    assert.equal(decisioningPermission({ projectRoot: disabled }).reason, DECISIONING_REFUSAL.NOT_CHOSEN);
    assert.equal(decisioningPermission({ projectRoot: ungranted }).reason, DECISIONING_REFUSAL.NOT_GRANTED);
    assert.equal(decisioningPermission().reason, DECISIONING_REFUSAL.NO_PROJECT);
  } finally {
    for (const root of [enabled, disabled, ungranted]) rmSync(root, { recursive: true, force: true });
  }
});

test("issue #59: configuration probes before enabling, and disabling clears the host grant", async () => {
  const root = await permissionProject({ choice: "none", grant: null });
  const location = consentLocation({ projectRoot: root });
  try {
    const enabled = await runTransaction(
      { projectRoot: root, files: [projectRecordTarget()] },
      (transaction) => configureDecisioning({
        transaction,
        location,
        provider: "typesafe",
        adapter: {
          probe: async () => ({
            ok: true,
            model: "jev-latest",
            models: ["jev-latest"],
            checkedWithoutInference: true,
          }),
        },
      })
    );
    assert.equal(enabled.ok, true);
    assert.deepEqual(decisioningPermission({ projectRoot: root }), { permitted: true, provider: "typesafe" });

    const disabled = await runTransaction(
      { projectRoot: root, files: [projectRecordTarget()] },
      (transaction) => configureDecisioning({ transaction, location, provider: "none" })
    );
    assert.equal(disabled.ok, true);
    assert.equal(decisioningPermission({ projectRoot: root }).reason, DECISIONING_REFUSAL.NOT_CHOSEN);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue #59: a failed live probe changes neither project choice nor consent", async () => {
  const root = await permissionProject({ choice: "none", grant: null });
  const location = consentLocation({ projectRoot: root });
  try {
    const result = await runTransaction(
      { projectRoot: root, files: [projectRecordTarget()] },
      (transaction) => configureDecisioning({
        transaction,
        location,
        provider: "typesafe",
        adapter: { probe: async () => ({ ok: false, kind: "capability-unavailable", reason: "auth-failed", detail: "rejected" }) },
      })
    );
    assert.equal(result.ok, false);
    assert.equal(decisioningPermission({ projectRoot: root }).reason, DECISIONING_REFUSAL.NOT_CHOSEN);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
