import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { consentLocation } from "../lib/consent-record.mjs";
import { CREDENTIAL_SERVICE, createCredentialBroker } from "../lib/credential-broker.mjs";
import { PROJECT_RECORD_KEY, projectRecordTarget } from "../lib/local-state.mjs";
import {
  CONNECTION_STATE,
  applyConnectionPlan,
  collectConnectionPlan,
  connectionPermission,
  connectionRuntimePermission,
} from "../lib/setup-connections.mjs";
import { runTransaction } from "../lib/setup-transaction.mjs";

const PROJECT_ID = "0123456789abcdef0123456789abcdef";
const SENTINELS = Object.freeze({
  OPENAI_API_KEY: "sk-test-openai-CONNECTION-SENTINEL",
  ELEVENLABS_API_KEY: "eleven-CONNECTION-SENTINEL",
  TYPESAFE_API_KEY: "typesafe-CONNECTION-SENTINEL",
});
test("connections gather every decision before mutation and support Back without replaying state", async () => {
  const broker = createCredentialBroker({ env: SENTINELS });
  const answers = [
    "use-existing", "skip",
    "skip",
    "back",
    "use-existing", "stt",
    "use-existing",
  ];
  const seen = [];
  const collected = await collectConnectionPlan({
    broker,
    decide: async (decision) => (seen.push(decision), answers.shift()),
  });
  assert.equal(collected.cancelled, false);
  assert.deepEqual(collected.plan[CREDENTIAL_SERVICE.OPENAI_SOURCE], { enabled: true, extractionModel: null });
  assert.deepEqual(collected.plan[CREDENTIAL_SERVICE.ELEVENLABS], { enabled: true, stt: true, tts: false, voiceId: null });
  assert.deepEqual(collected.plan[CREDENTIAL_SERVICE.TYPESAFE_JEV], { enabled: true });
  assert.equal(seen.filter((decision) => decision.type === "connection:elevenlabs").length, 2, "Back did not return to the prior decision");
  assert.equal(JSON.stringify(collected).includes("SENTINEL"), false, "presentation-safe status exposed a credential");
});

test("missing credentials cannot be enabled and do not trigger secret enumeration", async () => {
  const requested = [];
  const broker = createCredentialBroker({
    env: new Proxy({}, { get: (_target, name) => (requested.push(String(name)), undefined) }),
  });
  const decisions = [];
  const collected = await collectConnectionPlan({
    broker,
    decide: async (decision) => (decisions.push(decision), "skip"),
  });
  assert.equal(collected.cancelled, false);
  assert.ok(decisions.every((decision) => !decision.options.includes("enable")));
  assert.ok(decisions.every((decision) => decision.options.includes("configure-later")));
  assert.deepEqual(requested.sort(), ["ELEVENLABS_API_KEY", "OPENAI_API_KEY", "TYPESAFE_API_KEY"]);
});

test("Connect now stores a secret only after review and keeps it out of the plan", async () => {
  const stored = [];
  const secureStore = {
    available: true,
    get: async () => null,
    set: async (service, value) => stored.push([service, value]),
    delete: async () => false,
  };
  const broker = createCredentialBroker({ env: {}, secureStore });
  const answers = ["connect", SENTINELS.OPENAI_API_KEY, "skip", "skip", "skip"];
  const collected = await collectConnectionPlan({ broker, decide: async () => answers.shift() });
  assert.equal(stored.length, 0, "collection mutated the credential vault before review");
  assert.equal(JSON.stringify(collected).includes(SENTINELS.OPENAI_API_KEY), false);

  const root = mkdtempSync(join(tmpdir(), "kiln-connect-now-"));
  try {
    mkdirSync(join(root, ".pi", "runtime"), { recursive: true });
    writeFileSync(join(root, ".pi", "kiln.json"), JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID }, null, 2) + "\n");
    const location = consentLocation({ projectRoot: root, projectId: PROJECT_ID });
    await runTransaction(
      { projectRoot: root, files: [projectRecordTarget()] },
      (transaction) => applyConnectionPlan({
        transaction,
        location,
        plan: collected.plan,
        broker,
        decisioningAdapter: null,
        configureDecisioning: async ({ transaction: tx, provider }) => {
          await tx.merge(PROJECT_RECORD_KEY, (current) => {
            const record = JSON.parse(current);
            return JSON.stringify({ ...record, decisioning: { provider } }, null, 2) + "\n";
          });
          return { ok: true, available: false };
        },
      })
    );
    assert.deepEqual(stored, [[CREDENTIAL_SERVICE.OPENAI_SOURCE, SENTINELS.OPENAI_API_KEY]]);
    const persisted = `${readFileSync(join(root, ".pi", "kiln.json"), "utf8")}${readFileSync(location.path, "utf8")}`;
    assert.equal(persisted.includes(SENTINELS.OPENAI_API_KEY), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("correcting connection details does not ask for the OpenAI API key again", async () => {
  const secureStore = { available: true, get: async () => null, set: async () => {}, delete: async () => false };
  const broker = createCredentialBroker({ env: {}, secureStore });
  const answers = ["connect", SENTINELS.OPENAI_API_KEY, "provide", "", "gpt-4.1-mini", "skip", "skip"];
  const seen = [];
  const collected = await collectConnectionPlan({
    broker,
    decide: async (decision) => (seen.push(decision), answers.shift()),
  });
  assert.equal(collected.cancelled, false);
  assert.deepEqual(collected.plan[CREDENTIAL_SERVICE.OPENAI_SOURCE], { enabled: true, extractionModel: "gpt-4.1-mini" });
  assert.equal(seen.filter(({ type }) => type === "connection:openai-source:credential-secret").length, 1);
  assert.equal(seen.filter(({ type }) => type === "connection:openai-source:extraction-model-value").length, 2);
  assert.match(seen.find(({ type }) => type === "connection:openai-source:extraction-model-value").message, /model name.*not an API key/i);
});

test("speech output explains where to find the ElevenLabs Voice ID", async () => {
  const secureStore = { available: true, get: async () => null, set: async () => {}, delete: async () => false };
  const broker = createCredentialBroker({ env: {}, secureStore });
  const answers = ["skip", "connect", SENTINELS.ELEVENLABS_API_KEY, "tts", "voice-123", "skip"];
  const seen = [];
  const collected = await collectConnectionPlan({
    broker,
    decide: async (decision) => (seen.push(decision), answers.shift()),
  });
  assert.equal(collected.cancelled, false);
  assert.deepEqual(collected.plan[CREDENTIAL_SERVICE.ELEVENLABS], { enabled: true, stt: false, tts: true, voiceId: "voice-123" });
  const prompt = seen.find(({ type }) => type === "connection:elevenlabs:voice-id-value");
  assert.match(prompt.message, /not your API key/i);
  assert.match(prompt.message, /open Voices/i);
  assert.match(prompt.message, /copy its Voice ID/i);
});
test("applying a reviewed plan persists non-secret intent and separate host consent", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-connections-"));
  try {
    mkdirSync(join(root, ".pi", "runtime"), { recursive: true });
    writeFileSync(join(root, ".pi", "kiln.json"), JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID }, null, 2) + "\n");
    const location = consentLocation({ projectRoot: root, projectId: PROJECT_ID });
    const plan = {
      [CREDENTIAL_SERVICE.OPENAI_SOURCE]: { enabled: true, extractionModel: "gpt-4.1-mini" },
      [CREDENTIAL_SERVICE.ELEVENLABS]: { enabled: true, stt: true, tts: true, voiceId: "voice-123" },
      [CREDENTIAL_SERVICE.TYPESAFE_JEV]: { enabled: true },
    };
    const result = await runTransaction(
      { projectRoot: root, files: [projectRecordTarget()] },
      (transaction) => applyConnectionPlan({
        transaction,
        location,
        plan,
        decisioningAdapter: { probe: async () => ({ ok: true }) },
        configureDecisioning: async ({ transaction: tx, provider }) => {
          await tx.merge(PROJECT_RECORD_KEY, (current) => {
            const record = JSON.parse(current);
            return JSON.stringify({ ...record, decisioning: { provider } }, null, 2) + "\n";
          });
          return { ok: true, available: provider === "typesafe" };
        },
        voiceDependencies: async () => ({ ffmpeg: true, ffplay: true }),
      })
    );
    assert.equal(result[CREDENTIAL_SERVICE.OPENAI_SOURCE].state, CONNECTION_STATE.READY);
    assert.equal(result[CREDENTIAL_SERVICE.ELEVENLABS].state, CONNECTION_STATE.READY);
    assert.equal(result[CREDENTIAL_SERVICE.TYPESAFE_JEV].state, CONNECTION_STATE.READY);
    const project = JSON.parse(readFileSync(join(root, ".pi", "kiln.json"), "utf8"));
    const consent = JSON.parse(readFileSync(location.path, "utf8"));
    assert.deepEqual(project.sourceProcessing, { provider: "openai", remoteProcessing: true, extractionModel: "gpt-4.1-mini" });
    assert.deepEqual(project.voice, { provider: "elevenlabs", stt: true, tts: true, voiceId: "voice-123" });
    assert.equal(connectionRuntimePermission({ projectRecord: project, consentRecord: consent, service: CREDENTIAL_SERVICE.OPENAI_SOURCE }), true);
    assert.equal(connectionRuntimePermission({ projectRecord: project, consentRecord: consent, service: CREDENTIAL_SERVICE.ELEVENLABS }), true);
    assert.equal(connectionPermission({ projectRoot: root, service: CREDENTIAL_SERVICE.OPENAI_SOURCE }).permitted, true);
    const clone = mkdtempSync(join(tmpdir(), "kiln-connections-clone-"));
    try {
      mkdirSync(join(clone, ".pi", "runtime"), { recursive: true });
      writeFileSync(join(clone, ".pi", "kiln.json"), JSON.stringify(project, null, 2) + "\n");
      assert.deepEqual(connectionPermission({ projectRoot: clone, service: CREDENTIAL_SERVICE.OPENAI_SOURCE }), {
        permitted: false,
        reason: "not-granted",
      });
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
    const persisted = `${JSON.stringify(project)}${JSON.stringify(consent)}`;
    for (const secret of Object.values(SENTINELS)) assert.equal(persisted.includes(secret), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing audio executables make voice incomplete without failing setup", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-voice-deps-"));
  try {
    mkdirSync(join(root, ".pi", "runtime"), { recursive: true });
    writeFileSync(join(root, ".pi", "kiln.json"), JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID }, null, 2) + "\n");
    const location = consentLocation({ projectRoot: root, projectId: PROJECT_ID });
    const result = await runTransaction(
      { projectRoot: root, files: [projectRecordTarget()] },
      (transaction) => applyConnectionPlan({
        transaction,
        location,
        plan: {
          [CREDENTIAL_SERVICE.OPENAI_SOURCE]: { enabled: false },
          [CREDENTIAL_SERVICE.ELEVENLABS]: { enabled: true, stt: true, tts: true, voiceId: "voice-123" },
          [CREDENTIAL_SERVICE.TYPESAFE_JEV]: { enabled: false },
        },
        configureDecisioning: async () => ({ ok: true, available: false }),
        voiceDependencies: async () => ({ ffmpeg: false, ffplay: false }),
      })
    );
    assert.deepEqual(result[CREDENTIAL_SERVICE.ELEVENLABS], {
      state: CONNECTION_STATE.INCOMPLETE,
      provider: "elevenlabs",
      reason: "missing-ffmpeg-ffplay",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
