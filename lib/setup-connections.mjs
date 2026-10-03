import { spawnSync } from "node:child_process";
import { CREDENTIAL_SERVICE } from "./connection-services.mjs";
import { CONSENT_READ, GRANT, clearGrants, consentLocation, readConsent, recordGrant } from "./consent-record.mjs";
import { PROJECT_RECORD_KEY, RECORD, STATE_MODE, projectRecordState } from "./local-state.mjs";

export const CONNECTION_STATE = Object.freeze({
  READY: "ready",
  SKIPPED: "skipped",
  INCOMPLETE: "incomplete",
  FAILED: "failed",
});

export const CONNECTIONS = Object.freeze([
  Object.freeze({ id: CREDENTIAL_SERVICE.OPENAI_SOURCE, label: "OpenAI source processing", credentialLabel: "OpenAI API key", capability: "audio transcription and remote PDF/image extraction" }),
  Object.freeze({ id: CREDENTIAL_SERVICE.ELEVENLABS, label: "ElevenLabs voice", credentialLabel: "ElevenLabs API key", capability: "voice dictation and speech output" }),
  Object.freeze({ id: CREDENTIAL_SERVICE.TYPESAFE_JEV, label: "TypeSafe Jev", credentialLabel: "TypeSafe API key", capability: "optional advisory semantic decisioning" }),
]);

const cleanOptional = (value, max = 256) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max || /[\r\n\0]/.test(text)) throw new TypeError("Connection configuration must be a short, single-line non-secret identifier.");
  return text;
};

const SECRETS_BY_PLAN = new WeakMap();

async function collectRequiredValue({ decide, request, maxLength = 256 }) {
  while (true) {
    const answer = await decide({
      ...request,
      required: true,
      maxLength,
      requiredMessage: request.requiredMessage ?? "Enter a value or cancel setup.",
    });
    if (answer === null || answer === "cancel") return Object.freeze({ cancelled: true, value: null });
    try {
      const value = cleanOptional(answer, maxLength);
      if (value) return Object.freeze({ cancelled: false, value });
    } catch {
      // The renderer normally reports this inline. Other adapters still get a safe retry.
    }
  }
}

export function inspectVoiceDependencies({ run = spawnSync } = {}) {
  const available = (command) => {
    try {
      const result = run(command, ["-version"], { shell: false, windowsHide: true, stdio: "ignore", timeout: 5_000 });
      return result?.status === 0;
    } catch {
      return false;
    }
  };
  return Object.freeze({ ffmpeg: available("ffmpeg"), ffplay: available("ffplay") });
}
export async function inspectOptionalConnections(broker) {
  const entries = await Promise.all(CONNECTIONS.map(async (connection) => [connection.id, await broker.status(connection.id)]));
  return Object.freeze(Object.fromEntries(entries));
}

/** Gather every editable decision before a project or consent record is changed. */
export async function collectConnectionPlan({ broker, decide }) {
  if (typeof decide !== "function") throw new TypeError("Connections onboarding needs a decision provider.");
  const credentialStatus = await inspectOptionalConnections(broker);
  const plan = {};
  const secrets = new Map();
  let index = 0;
  while (index < CONNECTIONS.length) {
    const connection = CONNECTIONS[index];
    const credential = credentialStatus[connection.id];
    const options = credential.present
      ? ["use-existing", "skip", ...(index > 0 ? ["back"] : []), "cancel"]
      : [
          ...(credential.secureStoreAvailable ? ["connect"] : []),
          "configure-later",
          "skip",
          ...(index > 0 ? ["back"] : []),
          "cancel",
        ];
    const answer = await decide({
      type: `connection:${connection.id}`,
      message: `${connection.label}: ${connection.capability}. Credential ${credential.present ? `found in ${credential.source}` : "not found"}.`,
      options,
      credential,
    });
    if (answer === "cancel" || answer === null) return Object.freeze({ cancelled: true, credentialStatus, plan: Object.freeze({ ...plan }) });
    if (answer === "back") {
      index = Math.max(0, index - 1);
      continue;
    }
    const enabled = answer === "use-existing" || answer === "connect" || answer === "enable";
    if (answer === "connect") {
      if (!secrets.has(connection.id)) {
        const secret = await collectRequiredValue({
          decide,
          request: {
            type: `connection:${connection.id}:credential-secret`,
            message: `${connection.credentialLabel} (input is hidden; stored only in this computer's credential vault)`,
            options: ["provide", "cancel"],
            requiredMessage: `Enter the ${connection.credentialLabel} or cancel setup.`,
          },
          maxLength: 2_048,
        });
        if (secret.cancelled)
          return Object.freeze({ cancelled: true, credentialStatus, plan: Object.freeze({ ...plan }) });
        secrets.set(connection.id, secret.value);
      }
    } else secrets.delete(connection.id);
    if (enabled && !credential.present && answer !== "connect") throw new TypeError(`${connection.label} cannot be enabled without its declared credential.`);
    if (connection.id === CREDENTIAL_SERVICE.OPENAI_SOURCE) {
      if (enabled) {
        const modelAction = await decide({
          type: "connection:openai-source:extraction-model-action",
          message: "Configure an OpenAI extraction model for scanned PDFs and images?",
          options: ["provide", "skip", "back", "cancel"],
        });
        if (modelAction === "back") continue;
        if (modelAction === "cancel" || modelAction === null)
          return Object.freeze({ cancelled: true, credentialStatus, plan: Object.freeze({ ...plan }) });
        const extractionModelResult = modelAction === "provide"
          ? await collectRequiredValue({
              decide,
              request: {
                type: "connection:openai-source:extraction-model-value",
                message: "OpenAI extraction model name (for example, gpt-4.1-mini — not an API key)",
                options: ["provide", "cancel"],
                requiredMessage: "Enter an OpenAI model name or cancel setup.",
                placeholder: "gpt-4.1-mini",
              },
              maxLength: 200,
            })
          : { cancelled: false, value: null };
        if (extractionModelResult.cancelled)
          return Object.freeze({ cancelled: true, credentialStatus, plan: Object.freeze({ ...plan }) });
        const extractionModel = extractionModelResult.value;
        plan[connection.id] = { enabled: true, extractionModel };
      } else plan[connection.id] = { enabled: false };
    } else if (connection.id === CREDENTIAL_SERVICE.ELEVENLABS) {
      if (enabled) {
        const mode = await decide({
          type: "connection:elevenlabs:mode",
          message: "Which voice capabilities should Kiln enable?",
          options: ["stt", "tts", "stt-and-tts", "back", "cancel"],
        });
        if (mode === "back") continue;
        if (mode === "cancel" || mode === null) return Object.freeze({ cancelled: true, credentialStatus, plan: Object.freeze({ ...plan }) });
        const tts = mode === "tts" || mode === "stt-and-tts";
        const voiceIdResult = tts
          ? await collectRequiredValue({
              decide,
              request: {
                type: "connection:elevenlabs:voice-id-value",
                message: "ElevenLabs Voice ID for speech output (not your API key). In ElevenLabs, open Voices, select the voice Kiln should use, and copy its Voice ID.",
                options: ["provide", "cancel"],
                requiredMessage: "Enter the Voice ID for the ElevenLabs voice Kiln should use or cancel setup.",
              },
            })
          : { cancelled: false, value: null };
        if (voiceIdResult.cancelled)
          return Object.freeze({ cancelled: true, credentialStatus, plan: Object.freeze({ ...plan }) });
        const voiceId = voiceIdResult.value;
        plan[connection.id] = { enabled: true, stt: mode === "stt" || mode === "stt-and-tts", tts, voiceId };
      } else plan[connection.id] = { enabled: false };
    } else plan[connection.id] = { enabled };
    index += 1;
  }
  const frozenPlan = Object.freeze({ ...plan });
  SECRETS_BY_PLAN.set(frozenPlan, secrets);
  return Object.freeze({ cancelled: false, credentialStatus, plan: frozenPlan });
}

async function writeChoice(transaction, key, value) {
  return transaction.merge(PROJECT_RECORD_KEY, (current) => {
    if (current === null) throw new TypeError("Kiln's project record must exist before connections are configured.");
    const record = JSON.parse(current);
    if (JSON.stringify(record[key] ?? null) === JSON.stringify(value)) return null;
    return JSON.stringify({ ...record, [key]: value }, null, 2) + "\n";
  });
}

async function grantOrDisable({ transaction, location, validators, key, grant, provider, enabled, value }) {
  if (!enabled) {
    await clearGrants(location, [grant], { validators });
    await writeChoice(transaction, key, value);
    return { state: CONNECTION_STATE.SKIPPED, provider: "none" };
  }
  await writeChoice(transaction, key, value);
  const recorded = await recordGrant(location, { grant, granted: true, choice: { [key]: provider } }, { validators });
  return recorded.written || recorded.reason === "unchanged"
    ? { state: CONNECTION_STATE.READY, provider }
    : { state: CONNECTION_STATE.INCOMPLETE, provider, reason: recorded.reason };
}

/** Apply an already-reviewed plan. No renderer or terminal dependency enters this mutation layer. */
export async function applyConnectionPlan({ transaction, location, plan, validators, configureDecisioning, decisioningAdapter, broker, voiceDependencies = inspectVoiceDependencies }) {
  const source = plan[CREDENTIAL_SERVICE.OPENAI_SOURCE] ?? { enabled: false };
  const voice = plan[CREDENTIAL_SERVICE.ELEVENLABS] ?? { enabled: false };
  const jev = plan[CREDENTIAL_SERVICE.TYPESAFE_JEV] ?? { enabled: false };
  const result = {};

  const secrets = SECRETS_BY_PLAN.get(plan);
  if (secrets?.size) {
    if (!broker) throw new TypeError("A credential broker is required to store reviewed connection credentials.");
    for (const [service, secret] of secrets) await broker.store(service, secret);
  }

  result[CREDENTIAL_SERVICE.OPENAI_SOURCE] = await grantOrDisable({
    transaction,
    location,
    validators,
    key: "sourceProcessing",
    grant: GRANT.SOURCE_PROCESSING,
    provider: "openai",
    enabled: source.enabled === true,
    value: source.enabled
      ? { provider: "openai", remoteProcessing: true, ...(source.extractionModel ? { extractionModel: source.extractionModel } : {}) }
      : { provider: "none", remoteProcessing: false },
  });
  result[CREDENTIAL_SERVICE.ELEVENLABS] = await grantOrDisable({
    transaction,
    location,
    validators,
    key: "voice",
    grant: GRANT.VOICE,
    provider: "elevenlabs",
    enabled: voice.enabled === true,
    value: voice.enabled
      ? { provider: "elevenlabs", stt: voice.stt === true, tts: voice.tts === true, ...(voice.voiceId ? { voiceId: voice.voiceId } : {}) }
      : { provider: "none", stt: false, tts: false },
  });
  if (voice.enabled) {
    const dependencies = await voiceDependencies();
    const missing = [
      ...(voice.stt && !dependencies.ffmpeg ? ["ffmpeg"] : []),
      ...(voice.tts && !dependencies.ffplay ? ["ffplay"] : []),
    ];
    if (missing.length > 0) {
      result[CREDENTIAL_SERVICE.ELEVENLABS] = {
        ...result[CREDENTIAL_SERVICE.ELEVENLABS],
        state: CONNECTION_STATE.INCOMPLETE,
        reason: `missing-${missing.join("-")}`,
      };
    }
  }

  if (jev.enabled) {
    if (typeof configureDecisioning !== "function" || !decisioningAdapter)
      throw new TypeError("TypeSafe onboarding needs the existing decisioning configurator and an adapter.");
    const configured = await configureDecisioning({
      transaction,
      location,
      provider: "typesafe",
      adapter: decisioningAdapter,
      validators,
    });
    result[CREDENTIAL_SERVICE.TYPESAFE_JEV] = configured.ok && configured.available
      ? { state: CONNECTION_STATE.READY, provider: "typesafe" }
      : { state: CONNECTION_STATE.FAILED, provider: "typesafe", reason: configured.reason ?? "probe-failed" };
  } else {
    const configured = await configureDecisioning({ transaction, location, provider: "none", adapter: decisioningAdapter, validators });
    result[CREDENTIAL_SERVICE.TYPESAFE_JEV] = configured.ok
      ? { state: CONNECTION_STATE.SKIPPED, provider: "none" }
      : { state: CONNECTION_STATE.FAILED, provider: "none", reason: configured.reason ?? "disable-failed" };
  }
  return Object.freeze(result);
}

export function connectionRuntimePermission({ projectRecord, consentRecord, service }) {
  if (service === CREDENTIAL_SERVICE.OPENAI_SOURCE)
    return projectRecord?.sourceProcessing?.provider === "openai" && projectRecord.sourceProcessing.remoteProcessing === true && consentRecord?.sourceProcessing?.granted === true && consentRecord.sourceProcessing.provider === "openai";
  if (service === CREDENTIAL_SERVICE.ELEVENLABS)
    return projectRecord?.voice?.provider === "elevenlabs" && consentRecord?.voice?.granted === true && consentRecord.voice.provider === "elevenlabs";
  if (service === CREDENTIAL_SERVICE.TYPESAFE_JEV)
    return projectRecord?.decisioning?.provider === "typesafe" && consentRecord?.decisioning?.granted === true && consentRecord.decisioning.provider === "typesafe";
  return false;
}

export function readConnectionRuntimeState(location, projectRecord) {
  return { projectRecord, consentRecord: readConsent(location).record };
}

export function connectionPermission({ projectRoot, stateMode = STATE_MODE.PROJECT, service, env, validators } = {}) {
  const refuse = (reason) => Object.freeze({ permitted: false, reason });
  if (stateMode !== STATE_MODE.PROJECT && stateMode !== STATE_MODE.USER) return refuse("unknown-state-mode");
  if (typeof projectRoot !== "string" || !projectRoot) return refuse("no-project");
  const project = projectRecordState(projectRoot, { validators });
  if (project.kind !== RECORD.VALID) return refuse("project-record-unreadable");
  const location = consentLocation({ projectRoot, stateMode, projectId: project.record.projectId, ...(env ? { env } : {}) });
  const consent = readConsent(location, { validators });
  if (consent.state !== CONSENT_READ.VALID) return refuse(consent.state === CONSENT_READ.ABSENT ? "not-granted" : "consent-record-unreadable");
  if (!connectionRuntimePermission({ projectRecord: project.record, consentRecord: consent.record, service })) return refuse("not-granted");
  const choice = service === CREDENTIAL_SERVICE.OPENAI_SOURCE
    ? project.record.sourceProcessing
    : service === CREDENTIAL_SERVICE.ELEVENLABS
      ? project.record.voice
      : project.record.decisioning;
  return Object.freeze({ permitted: true, choice: Object.freeze({ ...choice }) });
}
