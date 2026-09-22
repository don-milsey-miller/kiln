/**
 * Launch-time availability checks and the refusal path — TSK-0037, CMP-0028, against ACC-0056.
 *
 * ⚠️ **THE RECORDED SELECTION OR NOTHING.** Every launch resolves the provider, model and thinking level the
 * project committed, exactly, and runs only if each check below passes for that selection. When one fails
 * the run is refused with a reason that names the recorded provider and model, and offers two ways on: rerun
 * setup, or start once with an explicit `--provider`/`--model`/`--thinking` override. Nothing is substituted:
 * not Pi's global default, not another model of the same provider, not another provider, and not an answer
 * from memory.
 *
 * ⚠️ **CONSENT IS CHECKED BEFORE ANY CREDENTIAL IS TOUCHED.** The first two steps read only Kiln's own files:
 * `.pi/settings.json` and the consent record. A host with no model-use grant for the exact provider and model
 * is refused there, before Pi's authentication store, its custom-model file or a credential variable is
 * read, so a clone arriving with a committed selection does not use this host's credential (ACC-0054).
 *
 * ⚠️ **AN OVERRIDE IS FOR ONE RUN AND CHANGES NOTHING.** It is checked exactly as the recorded selection is,
 * never written to settings, and never recorded as a grant: a different model is confirmed for this run with
 * the same billing statement setup uses, and a run that cannot ask refuses. A thinking-level override for
 * the granted model needs no new confirmation, because the grant is keyed to provider and model.
 *
 * ⚠️ **THE ORDER.** Selection, consent, credential contract, registry (custom-model file, model, authentication
 * and its source), thinking level, package and tools, compatibility record. Each failure is its own reason, so
 * a caller can say exactly what is wrong, and a failure of Pi itself to load at any stage is `pi-load-failed`
 * naming the stage, never an exception escaping the refusal path.
 *
 * ⚠️ **THE EXPECTED KEY IS THE LAUNCH'S OWN.** `expectedKey` must be computed from the current runtime inputs by
 * the preflight (TSK-0041, TSK-0042), never read back from the stored record, or the comparison would compare
 * the record with itself. Until that exists no launch can show a matching record, and these checks are not
 * wired into launch.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GRANT, STANDING, reconcileGrant } from "./consent-record.mjs";
import { defaultThinkingAccess, committedSelection, confirmationPrompt } from "./model-selection.mjs";
import { PackageRefusal, packageRootFor, validatePackage } from "./pi-package.mjs";
import { CredentialContractRefusal, resolveProviderCredentials } from "./pi-provider-credentials.mjs";
import { mapAuthSource } from "./pi-provider-canary.mjs";
import { THINKING_LEVELS } from "./pi-settings.mjs";
import { COMPATIBILITY_KEY_FIELDS, createRuntimeValidators } from "./runtime-records.mjs";

const TOOL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const COMPATIBILITY_RECORD = join("runtime", "model-compatibility.json");

export const LAUNCH_REFUSAL = Object.freeze({
  NO_SELECTION: "no-recorded-selection",
  OVERRIDE_INVALID: "override-invalid",
  OVERRIDE_NOT_CONFIRMED: "override-not-confirmed",
  MODEL_USE_NOT_GRANTED: "model-use-not-granted",
  MODEL_USE_DECLINED: "model-use-declined",
  CREDENTIAL_CONTRACT: "credential-contract",
  PI_LOAD_FAILED: "pi-load-failed",
  CUSTOM_MODELS_ERROR: "custom-models-error",
  MODEL_NOT_FOUND: "model-not-found",
  AUTH_ABSENT: "authentication-absent",
  AUTH_SOURCE: "authentication-source-refused",
  THINKING_NOT_SUPPORTED: "thinking-level-not-supported",
  PACKAGE_INVALID: "package-invalid",
  COMPATIBILITY_MISSING: "compatibility-record-missing",
  COMPATIBILITY_INVALID: "compatibility-record-invalid",
  COMPATIBILITY_MISMATCH: "compatibility-record-mismatch",
  COMPATIBILITY_UNVERIFIABLE: "compatibility-unverifiable",
});

/** The two ways on from any refusal. Neither substitutes anything. */
export const REMEDIES = Object.freeze([
  Object.freeze({ id: "rerun-setup", text: "Run Kiln's setup for this project again to choose and confirm a model on this computer." }),
  Object.freeze({
    id: "one-run-override",
    text:
      "Or start once with an explicit override: --provider <id> --model <id> --thinking <level> to use a different " +
      "model, which is confirmed for this run only, or --thinking <level> alone to change only the thinking level. " +
      "Neither changes the project's selection.",
  }),
]);

export class LaunchRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(`${message}\n${REMEDIES.map((r) => r.text).join("\n")}`);
    this.name = "LaunchRefusal";
    this.reason = reason;
    this.detail = detail;
    this.remedies = REMEDIES;
  }
}

const named = (s) => `${s.provider} ${s.model}`;

/** What each Pi loading stage is, in the operator's terms. */
const PI_STAGES = Object.freeze({
  sdk: "load the pinned Pi SDK",
  runtime: "open Pi's model runtime over its agent directory",
  registry: "build Pi's model registry",
  lookup: "look the model up in Pi's registry",
  "thinking-rule": "load Pi's thinking-level rule",
});

/**
 * Run one Pi loading stage, turning any failure into a refusal that names the stage.
 *
 * ⚠️ **THE ERROR IS NOT REPEATED, NOT EVEN ITS MESSAGE.** A failure while Pi reads its agent directory can
 * quote the file it was reading, and that file can hold a key. Only the stage and the error's class travel.
 */
async function piStage(stage, selection, ids, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LaunchRefusal) throw e;
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.PI_LOAD_FAILED,
      `Kiln could not ${PI_STAGES[stage]}, so ${named(selection)} was not started and nothing was substituted.`,
      { ...ids, stage, errorName: typeof e?.name === "string" ? e.name : "unknown" }
    );
  }
}
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Key order is not meaning: compare two JSON values with their object keys sorted. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
const sameJson = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * The selection this run uses: the committed one, or an explicit one-run override of it.
 *
 * @returns {{selection: {provider: string, model: string, thinkingLevel: string}, recorded: object|null, overridden: boolean, modelChanged: boolean}}
 */
export function resolveSelection(projectRoot, override = {}) {
  const recorded = committedSelection(projectRoot);
  const { provider, model, thinking } = override ?? {};
  if ((provider === undefined) !== (model === undefined))
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.OVERRIDE_INVALID,
      "--provider and --model override together. One without the other would leave Kiln to pick the rest."
    );
  if (thinking !== undefined && !THINKING_LEVELS.includes(thinking))
    throw new LaunchRefusal(LAUNCH_REFUSAL.OVERRIDE_INVALID, `--thinking ${JSON.stringify(thinking)} is not a thinking level.`, { thinking });

  const base = provider !== undefined ? { provider, model } : recorded;
  if (base === null)
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.NO_SELECTION,
      "This project has no recorded provider and model in .pi/settings.json, so there is nothing to launch with."
    );
  const modelChanged = provider !== undefined && !(recorded && recorded.provider === provider && recorded.model === model);
  const thinkingLevel = thinking ?? (modelChanged ? null : recorded?.thinkingLevel ?? null);
  if (thinkingLevel === null)
    throw new LaunchRefusal(
      modelChanged ? LAUNCH_REFUSAL.OVERRIDE_INVALID : LAUNCH_REFUSAL.NO_SELECTION,
      modelChanged
        ? `The override ${provider} ${model} names no thinking level. Pass --thinking as well; Kiln does not choose one.`
        : `The recorded selection ${named(base)} has no thinking level.`,
      { provider: base.provider, model: base.model }
    );
  return {
    selection: { provider: base.provider, model: base.model, thinkingLevel },
    recorded,
    overridden: provider !== undefined || thinking !== undefined,
    modelChanged,
  };
}

/** Read the compatibility record: absent, invalid, or valid. */
function readCompatibility(stateRoot, validators) {
  let text;
  try {
    text = readFileSync(join(stateRoot, COMPATIBILITY_RECORD), "utf8");
  } catch (e) {
    return e?.code === "ENOENT" ? { state: "absent" } : { state: "invalid", why: `could not be opened (${e?.code ?? "unknown"})` };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { state: "invalid", why: "is not JSON" };
  }
  const validate = (validators ?? createRuntimeValidators())["model-compatibility"];
  if (!validate(doc)) return { state: "invalid", why: "does not match its schema" };
  return { state: "valid", record: doc };
}

/**
 * Check the recorded selection, or an explicit override, before a launch.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {object} opts.location           from `consentLocation`: the consent record's place
 * @param {string} opts.stateRoot          the state root the compatibility record lives under
 * @param {string} [opts.agentDir]         Pi's agent directory; asked of the pinned package when omitted
 * @param {{provider?: string, model?: string, thinking?: string}} [opts.override]  the one-run CLI flags
 * @param {(prompt: string) => unknown} [opts.ask]  to confirm an override of the model; absent when the run cannot ask
 * @param {object|null} [opts.custom]      a custom provider's credential declaration
 * @param {object|null} [opts.expectedKey] the compatibility key this launch would prove, from the preflight
 * @param {object} [opts.access]           `{loadSdk, loadCompat}`, for observation
 * @param {string} [opts.packageRoot]
 * @returns {Promise<{selection: object, overridden: boolean, authSource: string, tools: string[], compatibility: object}>}
 */
export async function checkLaunch({
  projectRoot,
  location,
  stateRoot,
  agentDir,
  override = {},
  ask,
  custom = null,
  expectedKey = null,
  access = defaultThinkingAccess,
  packageRoot = packageRootFor(TOOL_ROOT),
  validators,
}) {
  // 1. The selection, from Kiln's own settings.
  const { selection, recorded, overridden, modelChanged } = resolveSelection(projectRoot, override);
  const ids = { provider: selection.provider, model: selection.model, ...(recorded ? { recorded: { provider: recorded.provider, model: recorded.model } } : {}) };

  // 2. Consent, from Kiln's own consent record. ⚠️ NOTHING OF PI'S HAS BEEN READ YET.
  if (modelChanged) {
    if (typeof ask !== "function")
      throw new LaunchRefusal(
        LAUNCH_REFUSAL.OVERRIDE_NOT_CONFIRMED,
        `The one-run override ${named(selection)} has to be confirmed before Kiln uses it, and this run cannot ask.`,
        ids
      );
    const answer = await ask(
      `${confirmationPrompt({ displayName: selection.provider, ...selection })}\n\nThis is for this run only. The project's selection stays ` +
        `${recorded ? named(recorded) : "unset"}, and nothing is recorded.`
    );
    if (answer !== true)
      throw new LaunchRefusal(LAUNCH_REFUSAL.OVERRIDE_NOT_CONFIRMED, `The one-run override ${named(selection)} was not confirmed, so nothing was started.`, ids);
  } else {
    const { standing } = await reconcileGrant(location, GRANT.MODEL_USE, { model: selection }, { validators });
    if (standing === STANDING.DECLINED)
      throw new LaunchRefusal(
        LAUNCH_REFUSAL.MODEL_USE_DECLINED,
        `Use of ${named(selection)} was declined on this computer, so nothing was started.`,
        ids
      );
    if (standing !== STANDING.GRANTED)
      throw new LaunchRefusal(
        LAUNCH_REFUSAL.MODEL_USE_NOT_GRANTED,
        `This project records ${named(selection)}, and its use has not been confirmed on this computer. Nothing was ` +
          "started, and no credential was read.",
        ids
      );
  }

  // 3. The credential contract, from Kiln's own table. Still nothing of Pi's.
  let contract;
  try {
    contract = resolveProviderCredentials(selection.provider, { custom });
  } catch (e) {
    if (!(e instanceof CredentialContractRefusal)) throw e;
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.CREDENTIAL_CONTRACT,
      `${named(selection)} cannot be launched: ${selection.provider} has no supported credential contract (${e.reason}).`,
      { ...ids, contractReason: e.reason, ...(e.detail?.declarationProblem ? { declarationProblem: e.detail.declarationProblem } : {}) }
    );
  }

  // 4. Pi's registry. ⚠️ FROM HERE ON, PI READS ITS AUTHENTICATION STORE AND CUSTOM-MODEL FILE. Nothing is contacted.
  const sdk = await piStage("sdk", selection, ids, async () => {
    const loaded = await access.loadSdk();
    if (typeof loaded?.ModelRuntime?.create !== "function" || typeof loaded?.ModelRegistry !== "function") throw new TypeError("incomplete SDK");
    return loaded;
  });
  const root = agentDir ?? (await piStage("sdk", selection, ids, () => sdk.getAgentDir()));
  const runtime = await piStage("runtime", selection, ids, () =>
    sdk.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), allowModelNetwork: false })
  );
  const registry = await piStage("registry", selection, ids, () => new sdk.ModelRegistry(runtime));
  // ⚠️ THE ERROR'S TEXT IS NOT REPEATED. It can quote the file it failed on, and that file can hold a key.
  if (await piStage("registry", selection, ids, () => registry.getError()))
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.CUSTOM_MODELS_ERROR,
      `Pi could not load its custom-model file, so ${named(selection)} cannot be resolved reliably. Correct models.json in Pi's agent directory.`,
      ids
    );
  // ⚠️ BOTH IDS, EXACTLY. No prefix, alias or same-provider neighbour is accepted in its place.
  const model = await piStage("lookup", selection, ids, () => registry.find(selection.provider, selection.model));
  if (!model)
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.MODEL_NOT_FOUND,
      `The recorded model ${named(selection)} is not in Pi's model registry on this computer. Nothing was started, and ` +
        "no other model was used in its place.",
      ids
    );
  const { available, status, configured } = await piStage("lookup", selection, ids, () => ({
    available: registry.getAvailable().some((m) => m.provider === selection.provider && m.id === selection.model),
    status: registry.getProviderAuthStatus(selection.provider),
    configured: registry.hasConfiguredAuth(model),
  }));
  if (!available || !configured || status?.configured !== true)
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.AUTH_ABSENT,
      `No authentication is configured for ${named(selection)} on this computer. Nothing was started, and no other ` +
        "provider was used in its place.",
      ids
    );
  const mapped = mapAuthSource(typeof status.source === "string" ? status.source : null, contract);
  if (mapped.refusal)
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.AUTH_SOURCE,
      `${named(selection)} is authenticated through a source Kiln does not accept for ${selection.provider} (${mapped.refusal}).`,
      { ...ids, sourceRefusal: mapped.refusal }
    );

  // 5. The thinking level, by Pi's own rule, so Pi runs at the level the run was confirmed for.
  const levels = await piStage("thinking-rule", selection, ids, async () => {
    const compat = await access.loadCompat();
    const found = compat.getSupportedThinkingLevels(model);
    if (!Array.isArray(found) || found.some((l) => typeof l !== "string")) throw new TypeError("thinking levels are not a list");
    return found;
  });
  if (!levels.includes(selection.thinkingLevel))
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.THINKING_NOT_SUPPORTED,
      `${named(selection)} does not support thinking level "${selection.thinkingLevel}", and Pi would run it at another. ` +
        `The levels it supports are: ${levels.join(", ")}.`,
      { ...ids, thinkingLevel: selection.thinkingLevel, supported: [...levels] }
    );

  // 6. The package and its tools: the declaration checked against what registration actually produces.
  let tools;
  try {
    ({ tools } = await validatePackage({ packageRoot }));
  } catch (e) {
    if (!(e instanceof PackageRefusal)) throw e;
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.PACKAGE_INVALID,
      `Kiln's Pi package or its tools did not load as declared (${e.reason}), so ${named(selection)} was not started.`,
      { ...ids, packageReason: e.reason }
    );
  }

  // 7. A compatibility record for exactly this launch.
  const found = readCompatibility(stateRoot, validators);
  if (found.state === "absent")
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.COMPATIBILITY_MISSING,
      `There is no compatibility record for ${named(selection)} on this computer, so it has not been shown to make the tool calls Kiln depends on.`,
      ids
    );
  if (found.state === "invalid")
    throw new LaunchRefusal(LAUNCH_REFUSAL.COMPATIBILITY_INVALID, `The compatibility record ${found.why}, so it proves nothing about ${named(selection)}.`, ids);
  const key = found.record.key;
  for (const [field, want] of [["provider", selection.provider], ["model", selection.model], ["thinkingLevel", selection.thinkingLevel]])
    if (key[field] !== want)
      throw new LaunchRefusal(
        LAUNCH_REFUSAL.COMPATIBILITY_MISMATCH,
        `The compatibility record was taken for a different ${field}, so it proves nothing about ${named(selection)} at thinking level "${selection.thinkingLevel}".`,
        { ...ids, field }
      );
  // ⚠️ THE REST OF THE KEY IS THE PREFLIGHT'S TO COMPUTE. Without it, a record cannot be shown to match.
  if (!isPlainObject(expectedKey))
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.COMPATIBILITY_UNVERIFIABLE,
      `The compatibility record for ${named(selection)} cannot be compared, because this launch has no expected key to compare it with.`,
      ids
    );
  const differing = COMPATIBILITY_KEY_FIELDS.filter((f) => !sameJson(key[f], expectedKey[f]));
  if (differing.length)
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.COMPATIBILITY_MISMATCH,
      `The compatibility record for ${named(selection)} was taken under different conditions (${differing.join(", ")}), so it no longer proves this launch.`,
      { ...ids, fields: differing }
    );

  return { selection, overridden, authSource: mapped.authSource, tools, compatibility: found.record.result };
}
