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
 * ⚠️ **THE EXPECTED KEY IS THE LAUNCH'S OWN.** Step 7 computes all eight determinants from the model Pi resolved
 * in step 4, the selection and the pinned Pi version (`computeCompatibilityKey`), and compares the stored record
 * with that. The record never supplies its own expectation.
 *
 * ⚠️ **A ONE-RUN PROOF WHERE A RECORD CANNOT APPLY.** A one-run override of the model, and a selection whose key
 * cannot be cached because its configuration needs a declared identity nobody gave, cannot be matched by the
 * project's record. For those, and only those, the run offers the live model check for this run alone: its own
 * approval naming the provider, the model and the possible charge, the bounded canary, and nothing recorded. The
 * canary runner is supplied by the caller and has no default, so nothing here can reach a provider by accident.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CompatibilityKeyRefusal,
  COMPATIBILITY_RECORD,
  KEY_REFUSAL,
  compatibilityLocationFrom,
  computeCompatibilityKey,
  differingFields,
  proofProblem,
  readCompatibility,
  resolveEffectiveBaseUrl,
} from "./compatibility-record.mjs";
import { GRANT, STANDING, declaredCredentialVar, reconcileGrant } from "./consent-record.mjs";
import { liveCheckPrompt } from "./live-canary.mjs";
import { defaultThinkingAccess, committedSelection, confirmationPrompt } from "./model-selection.mjs";
import { PackageRefusal, packageRootFor, validatePackage } from "./pi-package.mjs";
import { CredentialContractRefusal, readDeclaredName, resolveProviderCredentials } from "./pi-provider-credentials.mjs";
import { CanaryRefusal, mapAuthSource } from "./pi-provider-canary.mjs";
import { resolvePinnedSdk } from "./pi-runtime.mjs";
import { THINKING_LEVELS } from "./pi-settings.mjs";

const TOOL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export { COMPATIBILITY_RECORD };

export const LAUNCH_REFUSAL = Object.freeze({
  NO_SELECTION: "no-recorded-selection",
  OVERRIDE_INVALID: "override-invalid",
  OVERRIDE_NOT_CONFIRMED: "override-not-confirmed",
  MODEL_USE_NOT_GRANTED: "model-use-not-granted",
  MODEL_USE_DECLINED: "model-use-declined",
  CREDENTIAL_CONTRACT: "credential-contract",
  CREDENTIAL_ROUTE: "credential-route-mismatch",
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
  COMPATIBILITY_NEEDS_CANARY: "compatibility-needs-live-check",
  COMPATIBILITY_UNCACHEABLE: "compatibility-uncacheable",
  LIVE_CHECK_DECLINED: "live-check-declined",
  LIVE_CHECK_FAILED: "live-check-failed",
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

/**
 * Whether Pi's own `models.json` reads `provider`'s key from exactly the declared variable, as a problem code or `null`.
 *
 * ⚠️ **THE DECLARATION IS KILN'S; THE ROUTE PI TAKES IS PI'S, AND ONLY THIS COMPARES THEM (TSK-0072).** Pi reports a
 * custom provider's authentication only as "environment", so a declaration naming one variable would pass beside a
 * `models.json` reading another, or holding a literal key, and Kiln would scope children to a name Pi never reads.
 *
 * ⚠️ **A CODE, NEVER A VALUE.** The file can hold a literal key, so nothing read from it is returned or quoted.
 * Called only after inspection consent, like every other read of Pi's configuration.
 *
 * @param {{agentDir: string, provider: string, name: string}} route
 * @returns {null | "models-unreadable" | "provider-absent" | "not-a-variable" | "different-variable"}
 */
export function declaredRouteProblem({ agentDir, provider, name }) {
  let config;
  try {
    config = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf-8"));
  } catch {
    return "models-unreadable";
  }
  const providers = config?.providers;
  const block = providers !== null && typeof providers === "object" && Object.hasOwn(providers, provider) ? providers[provider] : undefined;
  if (block === null || typeof block !== "object") return "provider-absent";
  const read = readDeclaredName(block.apiKey);
  if (!read.name) return "not-a-variable";
  return read.name === name ? null : "different-variable";
}

/**
 * Checks 1 to 6 — everything that costs nothing — for the recorded selection or an explicit override.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {object} opts.location           from `consentLocation`: the consent record's place
 * @param {string} opts.stateRoot          the state root the compatibility record lives under
 * @param {string} [opts.agentDir]         Pi's agent directory; asked of the pinned package when omitted
 * @param {{provider?: string, model?: string, thinking?: string}} [opts.override]  the one-run CLI flags
 * @param {(prompt: string) => unknown} [opts.ask]  to confirm an override of the model; absent when the run cannot ask
 * @param {object|null} [opts.custom]      a custom provider's credential declaration
 * @param {object} [opts.access]           `{loadSdk, loadCompat, piVersion}`, for observation
 * @param {string} [opts.packageRoot]
 * @returns {Promise<object>} the selection, the resolved model and what the later steps need
 */
export async function zeroCostPreflight({
  projectRoot,
  location,
  agentDir,
  override = {},
  ask,
  custom = null,
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
    // ⚠️ A CUSTOM PROVIDER'S DECLARATION IS THE ONE SETUP RECORDED ON THIS GRANT (TSK-0072), read only now that the
    // grant stands. A one-run override of the model has no grant, so it has no declaration either.
    if (custom === null) {
      const name = declaredCredentialVar(location, selection, { validators });
      if (name) custom = { id: selection.provider, apiKey: `$${name}` };
    }
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
  // ⚠️ THE DECLARED ROUTE IS PI'S ROUTE, OR NOTHING STARTS (TSK-0072). Pi says only "environment" for a custom
  // provider, so the variable setup was told and the variable `models.json` reads are compared here, by name.
  if (custom !== null) {
    const route = declaredRouteProblem({ agentDir: root, provider: selection.provider, name: readDeclaredName(custom.apiKey).name });
    if (route)
      throw new LaunchRefusal(
        LAUNCH_REFUSAL.CREDENTIAL_ROUTE,
        `${named(selection)} cannot be launched: Pi's models.json does not read its key from the variable declared for it on ` +
          `this computer (${route}). Correct models.json, or run setup again with --credential-var naming the variable it reads.`,
        { ...ids, route }
      );
  }
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

  const displayName = await piStage("lookup", selection, ids, () => registry.getProviderDisplayName(selection.provider) ?? selection.provider);
  // ⚠️ THE ENDPOINT THE REQUEST WILL GO TO, asked of Pi's own authentication resolution with the network refused.
  const effective = await piStage("lookup", selection, ids, () => resolveEffectiveBaseUrl(registry, model));
  const piVersion = typeof access.piVersion === "function" ? access.piVersion() : resolvePinnedSdk(TOOL_ROOT).version;
  return {
    selection,
    recorded,
    overridden,
    modelChanged,
    ids,
    contract,
    model,
    displayName,
    authSource: mapped.authSource,
    tools,
    agentDir: root,
    piVersion,
    custom,
    ...(effective.unestablished ? { endpointUnestablished: true } : { effectiveBaseUrl: effective.baseUrl }),
  };
}

/**
 * Check the recorded selection, or an explicit override, before a launch: checks 1 to 6, then a compatibility
 * record matching the key computed for exactly this launch.
 *
 * @param {object} opts  as `zeroCostPreflight`, plus:
 * @param {{endpointIdentity?: object, requestIdentity?: string}} [opts.declared]  declared non-secret identities
 * @param {(ctx: {selection: object, agentDir: string, declared: object, custom?: object, customProviderConfig?: object}) => Promise<object>} [opts.canary]  runs the
 *        bounded live canary for a one-run proof; without it, a launch that needs one refuses
 * @returns {Promise<{selection: object, overridden: boolean, authSource: string, tools: string[], compatibility: object, proof: string}>}
 */
export async function checkLaunch({ declared = {}, canary = null, ...opts }) {
  const pf = await zeroCostPreflight(opts);
  const { selection, ids } = pf;
  const summary = { selection, overridden: pf.overridden, authSource: pf.authSource, tools: pf.tools };

  // 7. The key for exactly this launch, computed from what Pi resolved — never taken from the record.
  let key = null;
  let uncacheable = pf.endpointUnestablished ? KEY_REFUSAL.EFFECTIVE_ENDPOINT : null;
  if (!uncacheable)
    try {
      key = computeCompatibilityKey({ selection, model: pf.model, piVersion: pf.piVersion, declared, effectiveBaseUrl: pf.effectiveBaseUrl });
    } catch (e) {
      if (!(e instanceof CompatibilityKeyRefusal)) throw e;
      uncacheable = e.reason;
    }
  // ⚠️ NO KEY, NO PROOF: neither a record nor a canary can be shown to be about this launch's request.
  if (!key)
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.COMPATIBILITY_UNCACHEABLE,
      uncacheable === KEY_REFUSAL.EFFECTIVE_ENDPOINT
        ? `Kiln cannot establish, without contacting anything, which endpoint ${named(selection)} will be sent to, so no compatibility proof can be matched to it.`
        : `${named(selection)}'s configuration cannot be identified for a compatibility check (${uncacheable}). Declare a non-secret identity for it.`,
      { ...ids, uncacheable }
    );

  // ⚠️ D17: A DIFFERENT-MODEL OVERRIDE NEVER USES THE RECORD, even one that happens to match it. Its proof is
  // taken for this run, under its own approval.
  let problem = null;
  let untrusted = null;
  if (!pf.modelChanged) {
    const found = readCompatibility(compatibilityLocationFrom(opts.location), { validators: opts.validators });
    if (found.state === "untrusted") untrusted = found.why;
    else if (found.state === "valid") {
      const fields = differingFields(found.record.key, key);
      if (fields.length === 0) return { ...summary, compatibility: found.record.result, proof: "record" };
      problem = new LaunchRefusal(
        LAUNCH_REFUSAL.COMPATIBILITY_MISMATCH,
        `The compatibility record for ${named(selection)} was taken under different conditions (${fields.join(", ")}), so it does not prove this launch.`,
        { ...ids, fields }
      );
    } else if (found.state === "absent")
      problem = new LaunchRefusal(
        LAUNCH_REFUSAL.COMPATIBILITY_MISSING,
        `There is no compatibility record for ${named(selection)} on this computer, so it has not been shown to make the tool calls Kiln depends on.`,
        ids
      );
    else problem = new LaunchRefusal(LAUNCH_REFUSAL.COMPATIBILITY_INVALID, `The compatibility record ${found.why}, so it proves nothing about ${named(selection)}.`, ids);
  }

  // ⚠️ THE PROJECT'S OWN SELECTION IS PROVED BY SETUP'S RECORD, NOT BY A CANARY AT EVERY LAUNCH — unless the
  // record's location cannot be trusted, in which case no record there can ever prove it and each run needs its own.
  if (!pf.modelChanged && !untrusted) throw problem;

  // A one-run proof: an override of the model, or a selection whose record cannot be trusted where it lives.
  const why = pf.modelChanged ? `the one-run override ${named(selection)}` : `${named(selection)}, whose compatibility record cannot be trusted (${untrusted})`;
  if (typeof opts.ask !== "function" || typeof canary !== "function")
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.COMPATIBILITY_NEEDS_CANARY,
      `No compatibility record can prove ${why}, and this run cannot run the live model check for it.`,
      { ...ids, ...(untrusted ? { untrusted } : {}) }
    );
  const approved = await opts.ask(`${liveCheckPrompt({ displayName: pf.displayName, model: selection.model })}\n\nThis check is for this run only, and its result is not recorded.`);
  if (approved !== true)
    throw new LaunchRefusal(LAUNCH_REFUSAL.LIVE_CHECK_DECLINED, `The live model check for ${why} was not approved, so nothing was started.`, ids);
  let result;
  try {
    // ⚠️ A CUSTOM PROVIDER'S CHILD IS TOLD WHERE THE PROVIDER IS AND WHICH VARIABLE NAMES ITS KEY, or it checks another model.
    const provider = pf.custom ? { custom: pf.custom, customProviderConfig: customProviderConfig(pf) } : {};
    result = await canary({ selection, agentDir: pf.agentDir, declared, ...provider });
  } catch (e) {
    if (!(e instanceof CanaryRefusal)) throw e;
    throw new LaunchRefusal(LAUNCH_REFUSAL.LIVE_CHECK_FAILED, `The live model check for ${why} did not pass (${e.reason}), so nothing was started.`, {
      ...ids,
      canaryReason: e.reason,
    });
  }
  if (result?.passed !== true)
    throw new LaunchRefusal(LAUNCH_REFUSAL.LIVE_CHECK_FAILED, `The live model check for ${why} did not pass, so nothing was started.`, ids);
  // ⚠️ R8, R9: a pass is a proof only of the request the canary actually made.
  const mismatch = proofProblem(key, result);
  if (mismatch)
    throw new LaunchRefusal(
      LAUNCH_REFUSAL.LIVE_CHECK_FAILED,
      `The live model check for ${why} ran against a different request than this run makes (${mismatch.reason}), so nothing was started.`,
      { ...ids, canaryReason: mismatch.reason, ...(mismatch.fields ? { fields: mismatch.fields } : {}) }
    );
  return { ...summary, compatibility: { outcome: "passed", challengeEchoed: result.challengeEchoed === true }, proof: "this-run" };
}

/**
 * What the live canary is asked to do: this run's selection, and where its credential lives.
 *
 * ⚠️ **THE SAVED CREDENTIAL HAS TO REACH THE CHECK, OR THE CHECK ANSWERS A DIFFERENT QUESTION.** Pi authenticates
 * a provider from its stored `auth.json` as readily as from the environment, and the preflight has just
 * established which source authenticates this selection. A canary given no auth path runs against an empty store,
 * so a model that works perfectly well on this computer fails a check that was never handed what makes it work.
 *
 * ⚠️ **AND PASSING THE PATH NARROWS RATHER THAN WIDENS.** The canary copies the SELECTED provider's entry alone
 * into its own isolated root; the child never sees the operator's file, and never sees another provider's
 * credential. That boundary is the canary's, measured in test/pi-provider-canary.test.mjs; this hands it the
 * file it narrows.
 *
 * @param {{selection: object, declared?: object}} ctx  what the live check passes its runner
 * @param {object} preflight  the zero-cost preflight's result, including the agent directory it resolved
 */
export function canaryRequest(ctx, preflight, custom = null) {
  // ⚠️ **ONLY WHEN THE PREFLIGHT SAID THE STORED FILE IS WHAT AUTHENTICATES THIS SELECTION.** The canary refuses a
  // stored path that is not there, so a host authenticated by an environment variable — which commonly has no
  // auth.json at all — would fail a check its credential never reached. The environment route needs nothing here:
  // the canary builds its child's environment from the provider's declared names, which is its own boundary.
  const stored = preflight.authSource === "stored" ? join(preflight.agentDir, "auth.json") : null;

  // ⚠️ **A CUSTOM PROVIDER'S CHILD NEEDS TO KNOW WHERE THE PROVIDER IS, AND THAT IS NOT A CREDENTIAL.** The child
  // runs against its own isolated agent directory, so nothing of the operator's `models.json` reaches it: without
  // the endpoint and the model's shape it would resolve the id against Pi's built-in catalogue and check a
  // different service. What crosses is exactly the non-credential half — the base URL, the API kind and the one
  // model — taken from what the preflight resolved rather than re-derived here, so the check and the record
  // describe the same request. The key itself never crosses: the canary writes the DECLARED NAME.
  const config = custom === null ? null : customProviderConfig(preflight);
  return {
    ...ctx.selection,
    declared: ctx.declared,
    storedAuthPath: stored,
    ...(custom === null ? {} : { custom, customProviderConfig: config }),
  };
}

/** The non-credential half of the selected custom provider, as the canary's child needs it. */
export function customProviderConfig(preflight) {
  const model = preflight.model ?? {};
  const entry = { id: model.id };
  // ⚠️ ONLY THE FIELDS THE CANARY ACCEPTS, and only when Pi resolved them: an undefined bound is not a bound, and
  // the canary refuses a configuration carrying anything it does not know.
  // ⚠️ INCLUDING `samplingParams`, WHICH IS PART OF THE REQUEST: without it the child sends something else, and
  // the check would prove a request this project does not make. It is named by the declared identity in the key.
  // ⚠️ AND `compat` AS PI RESOLVED IT (TSK-0073): the provider block, the model definition and `modelOverrides` merged,
  // which is what the project's request is built from. The canary refuses it unless it is in its known shape.
  for (const key of ["name", "contextWindow", "maxTokens", "reasoning", "samplingParams", "compat"]) if (model[key] !== undefined) entry[key] = model[key];
  return { baseUrl: preflight.effectiveBaseUrl, api: model.api, models: [entry] };
}
