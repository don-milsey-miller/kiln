/**
 * The provider canary — TSK-0040's parent boundary, against ACC-0104.
 *
 * Before a provider contract is accepted, a disposable restricted child resolves the exact provider and
 * model through the pinned Pi SDK. The parent decides everything the child could get wrong: whether the
 * contract exists, what the child's environment holds, where its state lives, and what a Pi auth source
 * is allowed to mean.
 *
 * ⚠️ **AVAILABILITY IS THE EXACT MODEL IN THE AVAILABLE SET, NEVER "CONFIGURED".** The two disagree, and
 * the disagreement is measured: a stored OAuth credential for a custom provider reports
 * `configured: true` while the model is absent from `getAvailable()`. A canary gating on `configured`
 * tells an operator they are connected when the run cannot infer.
 *
 * ⚠️ **THE SOURCE IS JUDGED BEFORE AVAILABILITY, SO AN UNAVAILABLE MODEL CANNOT HIDE A BAD ROUTE.** A
 * forbidden, unknown or contract-mismatched source is its own refusal whether or not the model resolved.
 * Checking availability first reported the stored-OAuth custom-provider case as merely unavailable, which
 * hid that it was authenticated by a route the contract never declared.
 *
 * ⚠️ **EVERY REFUSAL BEFORE THE CHILD IS A REFUSAL BEFORE ANY STATE.** An unsupported provider, an invalid
 * custom configuration and a mismatched Pi install are refused before the temporary root exists, so a
 * contract that was never going to run leaves nothing behind. Everything after the root exists runs
 * inside a `finally` that removes it, and a removal that fails is a refusal of its own.
 *
 * ⚠️ **STORED AUTH IS THE SELECTED PROVIDER'S ENTRY ONLY, COPIED INTO THE TEMPORARY ROOT.** Pi's
 * credential store is not read-only: it creates the parent directory, writes `{}` when `auth.json` is
 * missing, and takes a `proper-lockfile` lock beside it, so it must never be pointed at the operator's
 * real file. And copying that file whole would hand the disposable child every provider's credential to
 * inspect one. The parent parses the file in its own memory and writes `{ [provider]: entry }` — or `{}`
 * — which is the same narrowing `childEnv` applies to environment variables: the child holds what the
 * selected contract needs and nothing a different provider would.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toolRoot as ownToolRoot } from "./content-root.mjs";
import { AUTH_SOURCE, CredentialContractRefusal, resolveProviderCredentials } from "./pi-provider-credentials.mjs";
import { resolvePinnedSdk } from "./pi-runtime.mjs";
import { AGENT_DIR_ENV, AGENT_SESSION_DIR_ENV, ChildEnvRefusal, childEnv } from "./specialists/contract.mjs";
import { SupervisorRefusal } from "./supervisor.mjs";

/** The child this boundary spawns. Resolved from this module's own location, never from cwd or PATH. */
export const CANARY_CHILD_PATH = join(dirname(fileURLToPath(import.meta.url)), "pi-provider-canary-child.mjs");

/** Prefix of every temporary root, so a test can prove none survives. */
export const CANARY_TEMP_PREFIX = "kiln-canary-";

/**
 * ⚠️ **THE ROLE IS `validation` BECAUSE IT HOLDS NO TOOL-PLANE CREDENTIAL.** `childEnv` builds an
 * environment per role, and the canary needs the model plane only. `research` could carry the research
 * key and `planning` would describe the wrong work; `validation` checks something and holds nothing.
 */
const CANARY_ROLE = "validation";

/** A report is three small facts. Anything larger is not one. */
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;

export const CANARY_REFUSAL = Object.freeze({
  INVALID_REQUEST: "canary-invalid-request",
  UNSUPPORTED: "unsupported-credential-contract",
  CUSTOM_CONFIG_INVALID: "canary-custom-config-invalid",
  RUNTIME_UNAVAILABLE: "canary-runtime-unavailable",
  STORED_AUTH_MISSING: "canary-stored-auth-missing",
  STORED_AUTH_INVALID: "canary-stored-auth-invalid",
  ENVIRONMENT_REFUSED: "canary-environment-refused",
  CHILD_FAILED: "canary-child-failed",
  OUTPUT_INVALID: "canary-output-invalid",
  UNAVAILABLE: "canary-model-unavailable",
  AUTH_SOURCE_FORBIDDEN: "canary-auth-source-forbidden",
  AUTH_SOURCE_MISMATCH: "canary-auth-source-mismatch",
  AUTH_SOURCE_UNKNOWN: "canary-auth-source-unknown",
  CLEANUP_FAILED: "canary-cleanup-failed",
});

export class CanaryRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "CanaryRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Pi auth sources Kiln does not permit, whatever the contract says.
 *
 * ⚠️ **REFUSALS, NOT CLASSIFICATIONS.** `runtime` is a key passed on a command line. `models_json_command`
 * produces a credential by executing something. `fallback` inherits an extension's key.
 * `models_json_key` is a literal credential written into `models.json` — the validated custom route is
 * always a `$NAME` reference, which Pi reports as `environment`, so a literal can only mean a
 * configuration the table refuses. Mapping any of these onto `custom-environment-key` would let a route
 * CMP-0029 rejects arrive under a name it accepts.
 */
export const FORBIDDEN_PI_SOURCES = Object.freeze(["runtime", "models_json_command", "fallback", "models_json_key"]);

/**
 * What a Pi auth source means under a declared contract, or which refusal it earns.
 *
 * Pure, and exported so the sources Pi will not produce against a fixture — `runtime`, a command, a
 * fallback — are tested against the same function the canary uses.
 *
 * ⚠️ **PI CANNOT TELL A BUILT-IN KEY FROM A CUSTOM ONE; THE CONTRACT CAN.** Both report `environment`. The
 * canary writes a custom provider's `apiKey` as exactly `$NAME` from its validated declaration, so an
 * `environment` source on a custom contract is that route by construction.
 *
 * @param {string|null|undefined} piSource
 * @param {{authSources: string[]}} contract
 * @returns {{authSource: string} | {refusal: string}}
 */
export function mapAuthSource(piSource, contract) {
  const sources = contract?.authSources ?? [];
  if (FORBIDDEN_PI_SOURCES.includes(piSource)) return { refusal: CANARY_REFUSAL.AUTH_SOURCE_FORBIDDEN };

  if (piSource === "stored")
    return sources.includes(AUTH_SOURCE.STORED)
      ? { authSource: AUTH_SOURCE.STORED }
      : { refusal: CANARY_REFUSAL.AUTH_SOURCE_MISMATCH };

  if (piSource === "environment") {
    if (sources.includes(AUTH_SOURCE.CUSTOM_ENVIRONMENT_KEY)) return { authSource: AUTH_SOURCE.CUSTOM_ENVIRONMENT_KEY };
    if (sources.includes(AUTH_SOURCE.ENVIRONMENT_KEY)) return { authSource: AUTH_SOURCE.ENVIRONMENT_KEY };
    return { refusal: CANARY_REFUSAL.AUTH_SOURCE_MISMATCH };
  }

  return { refusal: CANARY_REFUSAL.AUTH_SOURCE_UNKNOWN };
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The provider configuration a custom provider may supply. Credentials are not among it. */
const ACCEPTED_CONFIG_KEYS = Object.freeze(["baseUrl", "api", "models"]);
const ACCEPTED_MODEL_KEYS = Object.freeze(["id", "name", "contextWindow", "maxTokens", "reasoning", "input", "cost"]);

/**
 * The non-credential half of a custom provider, closed.
 *
 * ⚠️ **`apiKey`, `headers` AND `authHeader` ARE REFUSED HERE, AND THE KEY IS WRITTEN BY THE CANARY.**
 * The credential half of a custom provider is the validated declaration's `$NAME`, and nothing a caller
 * supplies may replace it. A `models.json` block that also carried a header or a literal key would
 * authenticate by a route the contract never declared. Refusals report a count, never a key or value.
 */
function customConfigFor(config, isCustom, provider, model) {
  const refuse = (problem, extra = {}) => {
    throw new CanaryRefusal(
      CANARY_REFUSAL.CUSTOM_CONFIG_INVALID,
      `The provider configuration for ${provider} cannot be used (${problem}). A custom provider supplies ` +
        `exactly ${ACCEPTED_CONFIG_KEYS.join(", ")}; its credential is the declared variable name, written by ` +
        `the canary. No canary child was created.`,
      { provider, model, problem, ...extra }
    );
  };

  if (!isCustom) {
    if (config !== null) refuse("built-in-provider");
    return null;
  }
  if (config === null) refuse("missing");
  if (!isPlainObject(config)) refuse("bad-shape");

  const unknown = Object.keys(config).filter((k) => !ACCEPTED_CONFIG_KEYS.includes(k));
  if (unknown.length > 0) refuse("unknown-property", { unknownCount: unknown.length });
  if (typeof config.baseUrl !== "string" || config.baseUrl.length === 0) refuse("bad-shape");
  if (typeof config.api !== "string" || config.api.length === 0) refuse("bad-shape");
  if (!Array.isArray(config.models) || config.models.length === 0) refuse("bad-shape");

  for (const entry of config.models) {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || entry.id.length === 0) refuse("bad-shape");
    const extra = Object.keys(entry).filter((k) => !ACCEPTED_MODEL_KEYS.includes(k));
    if (extra.length > 0) refuse("unknown-property", { unknownCount: extra.length });
  }

  return { baseUrl: config.baseUrl, api: config.api, models: config.models.map((m) => ({ ...m })) };
}

/**
 * The stored credential the child may see: the selected provider's entry, or none.
 *
 * ⚠️ **PARSED IN THE PARENT, AND ITS ERRORS NEVER BECOME A MESSAGE.** V8's `JSON.parse` error text can
 * quote a fragment of the input — which, in a malformed `auth.json`, is a fragment of a credential. A
 * file that will not parse is refused with a fixed message and nothing from the file or the parser.
 *
 * ⚠️ **OWN PROPERTY ONLY.** An id that happens to name something on `Object.prototype` must not select an
 * inherited value that was never in the operator's file.
 *
 * @returns {object} `{ [provider]: entry }`, or `{}` when the file holds nothing for this provider
 */
function selectedStoredCredential(storedAuthPath, provider, model) {
  if (storedAuthPath === null) return {};

  if (typeof storedAuthPath !== "string" || !existsSync(storedAuthPath) || !statSync(storedAuthPath).isFile())
    throw new CanaryRefusal(
      CANARY_REFUSAL.STORED_AUTH_MISSING,
      `The stored credential file supplied for ${provider}/${model} does not exist, so there is nothing to copy.`,
      { provider, model }
    );

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(storedAuthPath, "utf-8").replace(/^﻿/, ""));
  } catch {
    parsed = undefined;
  }
  if (!isPlainObject(parsed))
    throw new CanaryRefusal(
      CANARY_REFUSAL.STORED_AUTH_INVALID,
      `The stored credential file supplied for ${provider}/${model} is not a credential object, so nothing was copied.`,
      { provider, model }
    );

  // ⚠️ A complete environment route can still authenticate when the file holds nothing for this provider,
  // so an absent entry is `{}` rather than a refusal.
  return Object.prototype.hasOwnProperty.call(parsed, provider) ? { [provider]: parsed[provider] } : {};
}

/**
 * Run the child to completion and return its stdout. Stderr is drained and never read into anything.
 *
 * ⚠️ **A TIMED-OUT CHILD IS WAITED FOR, NOT ABANDONED.** Rejecting the moment the timer fires would let
 * the `finally` remove the temporary root while the child still holds a lock inside it — on Windows the
 * removal then fails, and on POSIX the child writes into a directory being deleted.
 */
function runChild(spawnImpl, args, env, timeoutMs, provider, model) {
  const failed = () =>
    new CanaryRefusal(CANARY_REFUSAL.CHILD_FAILED, `The canary child for ${provider}/${model} did not complete.`, {
      provider,
      model,
    });

  return new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawnImpl(process.execPath, args, {
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      rejectRun(failed());
      return;
    }

    const chunks = [];
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let timer = null;
    let hardStop = null;

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardStop) clearTimeout(hardStop);
      fn();
    };

    child.stdout?.on("data", (b) => {
      bytes += b.length;
      if (bytes <= MAX_CHILD_OUTPUT_BYTES) chunks.push(b);
    });
    child.stderr?.on("data", () => {});

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* the close handler, or the hard stop, still settles */
      }
      hardStop = setTimeout(() => settle(() => rejectRun(failed())), 5_000);
    }, timeoutMs);

    child.once("error", () => settle(() => rejectRun(failed())));
    child.once("close", (code, signal) =>
      settle(() => {
        if (timedOut || code !== 0 || signal) return rejectRun(failed());
        if (bytes > MAX_CHILD_OUTPUT_BYTES)
          return rejectRun(
            new CanaryRefusal(CANARY_REFUSAL.OUTPUT_INVALID, `The canary child for ${provider}/${model} reported too much.`, {
              provider,
              model,
            })
          );
        resolveRun(Buffer.concat(chunks).toString("utf-8"));
      })
    );
  });
}

/** The child's report, checked as a closed shape before any of it is believed. */
function readReport(raw, provider, model) {
  const invalid = () =>
    new CanaryRefusal(
      CANARY_REFUSAL.OUTPUT_INVALID,
      `The canary child for ${provider}/${model} did not return its report shape.`,
      { provider, model }
    );

  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!isPlainObject(report)) throw invalid();
  if (Object.keys(report).sort().join(",") !== "available,configured,piSource") throw invalid();
  if (typeof report.available !== "boolean" || typeof report.configured !== "boolean") throw invalid();
  if (!(report.piSource === null || typeof report.piSource === "string")) throw invalid();
  return report;
}

/** Removes a temporary root. Replaceable so a test can make removal fail on purpose. */
const removeRootDefault = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

/**
 * Resolve the exact provider and model in a disposable restricted child.
 *
 * @param {object} request
 * @param {string} request.provider            the provider id
 * @param {string} request.model               the exact model id
 * @param {object|null} [request.custom]       a custom provider's credential declaration
 * @param {object|null} [request.customProviderConfig]  `{baseUrl, api, models}` for a custom provider
 * @param {string|null} [request.storedAuthPath]        an existing `auth.json`; only the selected entry is copied
 * @param {Record<string,string|undefined>} [request.hostEnv]
 * @returns {Promise<{provider: string, model: string, available: true, authSource: string}>}
 */
export async function runProviderCanary(request = {}) {
  const {
    provider,
    model,
    custom = null,
    customProviderConfig = null,
    storedAuthPath = null,
    hostEnv = process.env,
    toolRoot = ownToolRoot(),
    platform = process.platform,
    spawnImpl = spawn,
    tempParent = tmpdir(),
    timeoutMs = 60_000,
    removeRoot = removeRootDefault,
  } = request;

  if (typeof provider !== "string" || provider.length === 0 || typeof model !== "string" || model.length === 0)
    throw new CanaryRefusal(CANARY_REFUSAL.INVALID_REQUEST, "A canary needs a provider id and an exact model id.", {
      provider: typeof provider === "string" ? provider : null,
      model: typeof model === "string" ? model : null,
    });

  // ---- everything that can refuse without state, before any state exists --------------------------

  let contract;
  try {
    contract = resolveProviderCredentials(provider, { custom });
  } catch (e) {
    if (!(e instanceof CredentialContractRefusal)) throw e;
    throw new CanaryRefusal(
      CANARY_REFUSAL.UNSUPPORTED,
      `${provider} has no supported credential contract, so no canary child was created.`,
      {
        provider,
        model,
        ...(e.detail?.declarationProblem ? { declarationProblem: e.detail.declarationProblem } : {}),
      }
    );
  }

  const isCustom = contract.authSources.includes(AUTH_SOURCE.CUSTOM_ENVIRONMENT_KEY);
  const config = customConfigFor(customProviderConfig, isCustom, provider, model);

  let sdk;
  try {
    sdk = resolvePinnedSdk(toolRoot);
  } catch (e) {
    if (!(e instanceof SupervisorRefusal)) throw e;
    throw new CanaryRefusal(
      CANARY_REFUSAL.RUNTIME_UNAVAILABLE,
      `The pinned Pi runtime is not installed as this checkout requires, so no canary child was created.`,
      { provider, model }
    );
  }

  // ---- state, all of it under one root, all of it removed ----------------------------------------

  let root = null;
  let primary = null;
  try {
    root = mkdtempSync(join(tempParent, CANARY_TEMP_PREFIX));
    try {
      chmodSync(root, 0o700);
    } catch {
      /* not meaningful on every platform; the root is still private to this run */
    }
    const agentDir = join(root, "agent");
    const sessionDir = join(root, "sessions");
    mkdirSync(agentDir, { mode: 0o700 });
    mkdirSync(sessionDir, { mode: 0o700 });

    // ⚠️ WRITTEN EVERY TIME, `{}` WHEN THERE IS NOTHING TO SELECT. Leaving it to Pi would have its store
    // create the file; writing it here keeps the one credential file this child sees an explicit choice.
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify(selectedStoredCredential(storedAuthPath, provider, model), null, 2) + "\n",
      { mode: 0o600 }
    );

    if (config)
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify(
          {
            providers: {
              [provider]: {
                baseUrl: config.baseUrl,
                api: config.api,
                // ⚠️ The declared NAME, as a reference. Never a value, and never anything the caller wrote.
                apiKey: `$${contract.required[0]}`,
                models: config.models,
              },
            },
          },
          null,
          2
        ) + "\n",
        { mode: 0o600 }
      );

    // ⚠️ THE LOCATORS POINT AT THIS ROOT, OVERRIDING THE OPERATOR'S OWN. A canary that inherited the real
    // agent directory would read and lock the real auth file.
    let env;
    try {
      env = childEnv(
        CANARY_ROLE,
        { ...hostEnv, [AGENT_DIR_ENV]: agentDir, [AGENT_SESSION_DIR_ENV]: sessionDir },
        { contract, platform }
      );
    } catch (e) {
      if (!(e instanceof ChildEnvRefusal)) throw e;
      throw new CanaryRefusal(
        CANARY_REFUSAL.ENVIRONMENT_REFUSED,
        `The environment for the ${provider}/${model} canary could not be built, so no child was created.`,
        { provider, model, environmentReason: e.reason }
      );
    }

    // ⚠️ EXACTLY FOUR ARGUMENTS, NONE OF THEM A CREDENTIAL. No `--api-key`, which Pi reports back as the
    // forbidden `runtime` source, and no `auth print-api-key`, which prints a credential to stdout.
    const raw = await runChild(spawnImpl, [CANARY_CHILD_PATH, sdk.url, provider, model], env, timeoutMs, provider, model);
    const report = readReport(raw, provider, model);

    // ⚠️ THE SOURCE FIRST. A forbidden, unknown or mismatched route keeps its own refusal when the model is
    // also unavailable; otherwise "unavailable" would be the whole story and the route would go unreported.
    let authSource = null;
    if (report.piSource !== null) {
      const mapped = mapAuthSource(report.piSource, contract);
      if (mapped.refusal)
        throw new CanaryRefusal(
          mapped.refusal,
          `${provider}/${model} reports an authentication source this contract does not permit.`,
          { provider, model }
        );
      authSource = mapped.authSource;
    }

    if (!report.available)
      throw new CanaryRefusal(CANARY_REFUSAL.UNAVAILABLE, `${provider}/${model} is not available to this run.`, {
        provider,
        model,
        available: false,
        authSource,
      });

    // An available model with no source Pi could name is not one this canary can vouch for.
    if (authSource === null)
      throw new CanaryRefusal(
        CANARY_REFUSAL.AUTH_SOURCE_UNKNOWN,
        `${provider}/${model} is available with no authentication source the runtime could name.`,
        { provider, model }
      );

    return Object.freeze({ provider, model, available: true, authSource });
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    if (root !== null) {
      // ⚠️ **A ROOT THAT SURVIVES IS A REFUSAL ON EVERY PATH, AND IT IS CHECKED RATHER THAN ASSUMED.** A
      // remover that returns without removing is as much a leak as one that throws, so the root's absence
      // is confirmed. When cleanup fails after another refusal, the cleanup failure is what the caller
      // must act on — a credential copy may still be on disk — and the earlier reason travels with it.
      let removed = true;
      try {
        removeRoot(root);
      } catch {
        removed = false;
      }
      if (removed && existsSync(root)) removed = false;

      if (!removed) {
        const detail = { provider, model };
        if (primary !== null) detail.priorReason = primary instanceof CanaryRefusal ? primary.reason : "unexpected-error";
        // eslint-disable-next-line no-unsafe-finally
        throw new CanaryRefusal(
          CANARY_REFUSAL.CLEANUP_FAILED,
          `The temporary state for the ${provider}/${model} canary could not be removed.`,
          detail
        );
      }
    }
  }
}
