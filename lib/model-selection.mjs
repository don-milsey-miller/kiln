/**
 * Model discovery, explicit selection and persistence — TSK-0036, CMP-0028, against ACC-0055 and ACC-0054.
 *
 * ⚠️ **DETECTION IS NOT SELECTION.** The choices are what a granted inspection listed: models Pi finds with
 * configured authentication, by provider display name and exact model ID. Nothing here reads Pi's global
 * default, and the first listed model is never taken for the operator. A choice is a number the operator
 * typed, or `--provider`/`--model` checked against that same list, and either way it is confirmed before it
 * is assigned, even when only one model is listed.
 *
 * ⚠️ **CONFIRMING IS THE BILLING DECISION.** The confirmation states that intake turns and specialist work
 * will run on this model and may consume billable tokens or provider quota on the account connected to this
 * computer. A yes is recorded as this host's model-use grant for that exact provider and model, which is what
 * authorises ongoing use. The selection itself is committed in `.pi/settings.json` through the settings merge
 * (DEC-0028), and a clone inherits it without inheriting the grant.
 *
 * ⚠️ **A CHANGED SELECTION CLEARS THE OLD GRANT BEFORE IT IS WRITTEN, OR IS NOT WRITTEN.** Cleared first, a
 * crash between the two leaves the old selection with no grant, which only asks again. If the grant cannot be
 * cleared, because Git cannot verify the record or the record is tracked, the selection is refused before
 * anything is written or granted: a new selection beside an old grant that cannot be removed would let a
 * later change back reuse an approval given for a different choice.
 *
 * ⚠️ **THE THINKING LEVEL IS THE MODEL'S, ASKED OF PI.** Pi clamps a level the model does not support to one it
 * does, silently, when it runs. A confirmation that said `high` for a model Pi runs at `off` would be a promise
 * about a request that is never made. So the supported levels come from Pi's own `getSupportedThinkingLevels`
 * applied to the registry's model, after inspection consent, and only those are offered or accepted.
 *
 * ⚠️ **A COMMITTED SELECTION STILL ASKS ON A HOST WITHOUT A GRANT.** A project arriving with `defaultProvider`
 * and `defaultModel` already set, from another operator or written by Pi after a login (F14), is offered for
 * confirmation. It is never used on the strength of being in the file.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultAccess } from "./connection-inspection.mjs";
import { GRANT, NOT_REMEMBERED, STANDING, clearGrants, peekGrant, recordGrant, reconcileGrant } from "./consent-record.mjs";
import { resolvePinnedCompat } from "./pi-runtime.mjs";
import { SETTINGS_PATH, THINKING_LEVELS, applyKilnSettings, readSettings } from "./pi-settings.mjs";

const TOOL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SELECTION_OUTCOME = Object.freeze({
  /** A new or changed selection was confirmed, written and granted. */
  SELECTED: "selected",
  /** The project's existing selection was confirmed for this host. */
  CONFIRMED: "confirmed",
  /** This host already holds a grant for the project's unchanged selection. */
  REUSED: "reused",
  /** The operator said no. Nothing billable is enabled, and setup is partial. */
  DECLINED: "declined",
  /** No choice was made. Nothing was written. */
  CANCELLED: "cancelled",
});

export const SELECTION_REFUSAL = Object.freeze({
  NOT_INSPECTED: "not-inspected",
  NO_MODELS: "no-available-models",
  UNKNOWN_PROVIDER: "unknown-provider",
  MODEL_NOT_AVAILABLE: "model-not-available",
  INCOMPLETE_REQUEST: "incomplete-request",
  INVALID_THINKING: "invalid-thinking-level",
  THINKING_NOT_SUPPORTED: "thinking-level-not-supported",
  THINKING_UNKNOWN: "thinking-support-unknown",
  NEEDS_CONFIRMATION: "needs-confirmation",
  GRANT_NOT_CLEARED: "grant-not-cleared",
});

export class ModelSelectionRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "ModelSelectionRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

/** Every listed model, one entry per provider and exact ID, in the order the inspection listed them. */
export function listChoices(providers) {
  const out = [];
  for (const p of providers ?? []) for (const model of p.models ?? []) out.push({ provider: p.provider, displayName: p.displayName, model });
  return out;
}

/** The numbered lines the operator chooses from. Nothing is marked as a default. */
export function renderChoices(choices) {
  return choices.map((c, i) => `  ${i + 1}. ${c.displayName} — ${c.model}`);
}

/** The confirmation, naming the exact model and what confirming authorises. */
export function confirmationPrompt({ displayName, provider, model, thinkingLevel }) {
  return [
    "Use this model for this project?",
    "",
    `  Provider: ${displayName} (${provider})`,
    `  Model:    ${model}`,
    `  Thinking: ${thinkingLevel}`,
    "",
    "Kiln's intake turns and specialist work for this project will run on this model, using the connection",
    "configured on this computer. That may consume billable tokens or provider quota. The account, its limits,",
    "its pricing plan and its charges are yours. Confirming authorises that ongoing use on this computer.",
  ].join("\n");
}

/** The project's committed selection, or `null` if `.pi/settings.json` names none. */
export function committedSelection(projectRoot) {
  const path = join(projectRoot, ...SETTINGS_PATH.split("/"));
  if (!existsSync(path)) return null;
  const s = readSettings(readFileSync(path, "utf8"));
  if (typeof s.defaultProvider !== "string" || typeof s.defaultModel !== "string") return null;
  return { provider: s.defaultProvider, model: s.defaultModel, thinkingLevel: s.defaultThinkingLevel ?? null };
}

const sameModel = (a, b) => a !== null && b !== null && a.provider === b.provider && a.model === b.model;

/** The same access points the inspection uses, plus Pi's thinking-level rule. */
export const defaultThinkingAccess = Object.freeze({
  loadSdk: defaultAccess.loadSdk,
  loadCompat: async () => import(resolvePinnedCompat(TOOL_ROOT).url),
});

/**
 * The thinking levels Pi supports for each listed model.
 *
 * ⚠️ **ONLY AFTER A GRANTED INSPECTION.** Building Pi's registry reads its authentication store and custom-model
 * file, which is exactly what the inspection asked permission for. Nothing is contacted: the runtime is
 * created with `allowModelNetwork: false`, as the inspection's is.
 *
 * @param {{inspection: object, agentDir?: string, access?: object}} opts
 * @returns {Promise<{levelsFor: (provider: string, model: string) => string[]|null}>}
 */
export async function loadThinkingSupport({ inspection, agentDir, access = defaultThinkingAccess } = {}) {
  if (!inspection?.inspected)
    throw new ModelSelectionRefusal(SELECTION_REFUSAL.NOT_INSPECTED, "Connections were not checked, so Pi's model registry was not read.");
  const sdk = await access.loadSdk();
  const compat = await access.loadCompat();
  if (typeof compat.getSupportedThinkingLevels !== "function")
    throw new ModelSelectionRefusal(SELECTION_REFUSAL.THINKING_UNKNOWN, "The pinned Pi does not provide getSupportedThinkingLevels.");
  const root = agentDir ?? sdk.getAgentDir();
  const registry = new sdk.ModelRegistry(
    await sdk.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), allowModelNetwork: false })
  );
  const levels = new Map();
  for (const c of listChoices(inspection.providers)) {
    const model = registry.find(c.provider, c.model);
    if (model) levels.set(`${c.provider}\u0000${c.model}`, Object.freeze([...compat.getSupportedThinkingLevels(model)]));
  }
  return Object.freeze({ levelsFor: (provider, model) => levels.get(`${provider}\u0000${model}`) ?? null });
}

/** The levels this model supports, or a refusal when Pi could not say. */
function supportedLevels(thinkingSupport, choice) {
  const levels = thinkingSupport.levelsFor(choice.provider, choice.model);
  if (!Array.isArray(levels) || levels.length === 0)
    throw new ModelSelectionRefusal(
      SELECTION_REFUSAL.THINKING_UNKNOWN,
      `Pi did not report which thinking levels ${choice.displayName} ${choice.model} supports, so no level can be confirmed for it.`,
      { provider: choice.provider, model: choice.model }
    );
  return levels;
}

/** Refuse a level the model does not support, naming the ones it does. */
function checkThinking(levels, level, choice) {
  if (!levels.includes(level))
    throw new ModelSelectionRefusal(
      SELECTION_REFUSAL.THINKING_NOT_SUPPORTED,
      `${choice.displayName} ${choice.model} does not support thinking level "${level}". Pi would run it at a different ` +
        `level, so it is not accepted. The levels it supports are: ${levels.join(", ")}.`,
      { provider: choice.provider, model: choice.model, level, supported: [...levels] }
    );
  return level;
}

/**
 * Check `--provider`, `--model` and `--thinking` against what discovery listed. Whether the model supports the
 * thinking level is checked separately, against Pi's registry.
 *
 * @returns {{provider: string, displayName: string, model: string, thinkingLevel?: string}}
 */
export function validateRequested(choices, { provider, model, thinking } = {}) {
  if (thinking !== undefined && !THINKING_LEVELS.includes(thinking))
    throw new ModelSelectionRefusal(
      SELECTION_REFUSAL.INVALID_THINKING,
      `--thinking ${JSON.stringify(thinking)} is not a thinking level. The levels are ${THINKING_LEVELS.join(", ")}.`,
      { thinking }
    );
  if ((provider === undefined) !== (model === undefined))
    throw new ModelSelectionRefusal(
      SELECTION_REFUSAL.INCOMPLETE_REQUEST,
      "--provider and --model are given together. One without the other would leave Kiln to pick the rest."
    );
  const ofProvider = choices.filter((c) => c.provider === provider);
  if (ofProvider.length === 0)
    throw new ModelSelectionRefusal(
      SELECTION_REFUSAL.UNKNOWN_PROVIDER,
      `--provider ${JSON.stringify(provider)} is not a provider Pi found with configured authentication on this computer.`,
      { provider }
    );
  const found = ofProvider.find((c) => c.model === model);
  if (!found)
    throw new ModelSelectionRefusal(
      SELECTION_REFUSAL.MODEL_NOT_AVAILABLE,
      `--model ${JSON.stringify(model)} is not an available model of ${ofProvider[0].displayName}. Kiln uses the exact ` +
        "identifier Pi lists and does not substitute another.",
      { provider, model }
    );
  return { ...found, ...(thinking !== undefined ? { thinkingLevel: thinking } : {}) };
}

/** Ask for a number from the list. An empty answer, a closed input or anything not on the list is no choice. */
async function chooseFrom(choices, { ask, print }) {
  print(`${choices.length} model${choices.length === 1 ? "" : "s"} can be used on this computer:`);
  for (const line of renderChoices(choices)) print(line);
  const answer = await ask(`Which model should this project use? (1-${choices.length}, or q to cancel) `);
  if (answer === null || answer === undefined) return null;
  const said = String(answer).trim();
  const n = Number.parseInt(said, 10);
  return String(n) === said && n >= 1 && n <= choices.length ? choices[n - 1] : null;
}

/** Ask for one of the levels this model supports. There is no default, so an empty answer is no choice. */
async function chooseThinking({ ask, levels }) {
  const answer = await ask(`Thinking level? (${levels.join(", ")}) `);
  const said = typeof answer === "string" ? answer.trim() : null;
  return levels.includes(said) ? said : null;
}

const result = (outcome, extra = {}) => ({ outcome, ...extra });

/**
 * Select, confirm and persist the project's model, and grant its use on this host.
 *
 * @param {object} opts
 * @param {object} opts.transaction  a live setup transaction that planned `settingsTarget()`
 * @param {object} opts.location     from `consentLocation`
 * @param {object} opts.inspection   the result of a granted inspection
 * @param {{levelsFor: Function}} opts.thinkingSupport  from `loadThinkingSupport`
 * @param {(prompt: string) => unknown} [opts.ask]  absent in a non-interactive run
 * @param {(line: string) => void} [opts.print]
 * @param {{provider?: string, model?: string, thinking?: string}} [opts.requested]  the CLI flags
 * @param {{stateMode: string, packageEntry?: string|null, packageEntryEquivalents?: string[]}} opts.settings
 *        the rest of the settings merge's desired state
 * @param {() => Date} [opts.now]
 */
export async function selectModel({
  transaction,
  location,
  inspection,
  thinkingSupport,
  ask,
  print = () => {},
  requested = {},
  confirmation,
  settings,
  now,
  validators,
}) {
  const opts = { validators };
  if (!inspection?.inspected)
    throw new ModelSelectionRefusal(
      SELECTION_REFUSAL.NOT_INSPECTED,
      "Connections were not checked, so there is nothing to choose a model from. Setup stays partial until " +
        "the inspection is allowed."
    );
  if (typeof thinkingSupport?.levelsFor !== "function") throw new TypeError("selectModel needs the thinking support loadThinkingSupport returns");
  const choices = listChoices(inspection.providers);
  if (choices.length === 0)
    throw new ModelSelectionRefusal(
      SELECTION_REFUSAL.NO_MODELS,
      "Pi found no model with configured authentication on this computer. Connect a provider in Pi, then run setup again."
    );

  const current = committedSelection(location.projectRoot);
  const wantsChange = requested.provider !== undefined || requested.model !== undefined;
  if (requested.thinking !== undefined && !THINKING_LEVELS.includes(requested.thinking)) validateRequested(choices, { thinking: requested.thinking });

  // ── the project's existing selection, unchanged ────────────────────────────────────────────────────
  if (!wantsChange && current !== null) {
    const listed = choices.find((c) => sameModel(c, current));
    if (listed) {
      const levels = supportedLevels(thinkingSupport, listed);
      if (requested.thinking !== undefined) checkThinking(levels, requested.thinking, listed);
      // ⚠️ A COMMITTED LEVEL THE MODEL DOES NOT SUPPORT IS NOT CONFIRMED AS IF IT WERE THE ONE THAT RUNS.
      const committedSupported = current.thinkingLevel !== null && levels.includes(current.thinkingLevel);
      if (requested.thinking === undefined && current.thinkingLevel !== null && !committedSupported)
        print(`${listed.displayName} ${listed.model} does not support the committed thinking level "${current.thinkingLevel}". Choose one it supports.`);
      let level = requested.thinking ?? (committedSupported ? current.thinkingLevel : null);

      const { standing } = await reconcileGrant(location, GRANT.MODEL_USE, { model: current }, opts);
      if (standing === STANDING.GRANTED && level === current.thinkingLevel) return result(SELECTION_OUTCOME.REUSED, { selection: { ...listed, thinkingLevel: level } });
      if (standing === STANDING.DECLINED && requested.thinking === undefined && committedSupported)
        return result(SELECTION_OUTCOME.DECLINED, { selection: { ...listed, thinkingLevel: level } });
      if (level === null) {
        level = await needThinking({ ask, levels });
        if (level === null) return result(SELECTION_OUTCOME.CANCELLED);
      }
      return confirmAndPersist({
        transaction,
        location,
        choice: { ...listed, thinkingLevel: level },
        current,
        ask,
        print,
        confirmation,
        settings,
        now,
        opts,
        existing: true,
      });
    }
    // A committed selection this computer cannot use is not replaced silently: the operator chooses.
    print(`This project's selected model, ${current.provider} ${current.model}, is not available on this computer.`);
  }

  // ── a new or changed selection ──────────────────────────────────────────────────────────────────────
  let choice;
  if (wantsChange) choice = validateRequested(choices, requested);
  else {
    if (typeof ask !== "function")
      throw new ModelSelectionRefusal(
        SELECTION_REFUSAL.NEEDS_CONFIRMATION,
        "A model has to be chosen and confirmed, and this run cannot ask. Name the model with --provider and " +
          "--model, its thinking level with --thinking, and confirm its use with --model-use approve."
      );
    choice = await chooseFrom(choices, { ask, print });
    if (choice === null) return result(SELECTION_OUTCOME.CANCELLED);
    if (requested.thinking !== undefined) choice = { ...choice, thinkingLevel: requested.thinking };
  }
  // ⚠️ BEFORE ANY CONFIRMATION OR WRITE: the level must be one this model runs at.
  const levels = supportedLevels(thinkingSupport, choice);
  if (choice.thinkingLevel) checkThinking(levels, choice.thinkingLevel, choice);
  else {
    const level = await needThinking({ ask, levels });
    if (level === null) return result(SELECTION_OUTCOME.CANCELLED);
    choice = { ...choice, thinkingLevel: level };
  }
  return confirmAndPersist({ transaction, location, choice, current, ask, print, confirmation, settings, now, opts, existing: false });
}

async function needThinking({ ask, levels }) {
  if (typeof ask !== "function")
    throw new ModelSelectionRefusal(SELECTION_REFUSAL.NEEDS_CONFIRMATION, "A thinking level has to be chosen, and this run cannot ask. Pass --thinking.");
  return chooseThinking({ ask, levels });
}

/**
 * ⚠️ **A STANDING CONFIRMATION IS THE SAME ANSWER, GIVEN BEFORE THE QUESTION.** A run with nobody to ask
 * may still confirm the model it names, because the decision is the operator's and they can make it on the
 * command line as readily as at a prompt. What it may not do is confirm something they did not name: the choice
 * itself still needs an answer, so this reaches here only for a selection `--provider`, `--model` and
 * `--thinking` spelled out, or one the project has already committed.
 *
 * ⚠️ **AND WHAT IT AUTHORISES IS STILL SAID OUT LOUD.** The prompt is what discloses the billing; a flag
 * that skipped the words would authorise ongoing charges with nothing on the screen or in the log that says so,
 * so the same text is printed either way.
 */
async function confirmAndPersist({ transaction, location, choice, current, ask, print = () => {}, confirmation, settings, now, opts, existing }) {
  const standing = confirmation === true || confirmation === false;
  if (!standing && typeof ask !== "function")
    throw new ModelSelectionRefusal(
      SELECTION_REFUSAL.NEEDS_CONFIRMATION,
      `${choice.displayName} ${choice.model} has to be confirmed before Kiln uses it, and this run cannot ask. ` +
        `Run setup interactively, or confirm it without a prompt with --model-use approve.`,
      { provider: choice.provider, model: choice.model }
    );
  const selection = { provider: choice.provider, displayName: choice.displayName, model: choice.model, thinkingLevel: choice.thinkingLevel };

  // ⚠️ ONLY AN EXPLICIT YES, whether it was typed at the prompt or given as the answer to it.
  let answer;
  if (standing) {
    for (const line of confirmationPrompt(selection).split("\n")) print(line);
    print(confirmation ? "confirmed by --model-use approve" : "declined by --model-use deny");
    answer = confirmation;
  } else answer = await ask(confirmationPrompt(selection));
  if (answer !== true) {
    // A no to the project's own selection, exactly as committed, is this host's decision about it. A no to
    // any CHANGE — a different model, or the same model at a different thinking level — refuses the change
    // and says nothing about what is already committed and granted, so nothing is kept and nothing cleared.
    const unchanged = existing && current !== null && sameModel(current, selection) && current.thinkingLevel === selection.thinkingLevel;
    const consent =
      answer === false && unchanged
        ? await recordGrant(location, { grant: GRANT.MODEL_USE, granted: false, choice: { model: selection }, now }, opts)
        : null;
    return result(answer === false ? SELECTION_OUTCOME.DECLINED : SELECTION_OUTCOME.CANCELLED, { selection, ...(consent ? { consent } : {}) });
  }

  // ⚠️ THE OLD GRANT GOES BEFORE THE NEW SELECTION IS WRITTEN, OR NOTHING IS WRITTEN.
  let cleared = [];
  if (!sameModel(current, selection)) {
    const clear = await clearGrants(location, [GRANT.MODEL_USE], opts);
    if (!clear.written && clear.reason !== "unchanged" && clear.reason !== "no-runtime-dir")
      throw new ModelSelectionRefusal(
        SELECTION_REFUSAL.GRANT_NOT_CLEARED,
        `The model selection was not changed and nothing was enabled. Kiln must first clear this computer's ` +
          `approval for the previous model, and could not: ${NOT_REMEMBERED[clear.reason] ?? clear.reason}`,
        { reason: clear.reason }
      );
    if (clear.written) cleared = [GRANT.MODEL_USE];
  }

  const written = await applyKilnSettings({
    transaction,
    desired: { ...settings, provider: selection.provider, model: selection.model, thinkingLevel: selection.thinkingLevel },
  });
  const consent = await recordGrant(location, { grant: GRANT.MODEL_USE, granted: true, choice: { model: selection }, now }, opts);
  return result(existing ? SELECTION_OUTCOME.CONFIRMED : SELECTION_OUTCOME.SELECTED, {
    selection,
    settingsChanged: written.changed,
    cleared,
    consent,
    ...(consent.written ? {} : { notRemembered: NOT_REMEMBERED[consent.reason] }),
  });
}

/** Where this host's model-use grant stands for the committed selection, without changing anything. */
export function modelUseStanding(location, { validators } = {}) {
  const current = committedSelection(location.projectRoot);
  if (current === null) return { selection: null, standing: STANDING.NOT_APPLICABLE };
  return { selection: current, ...peekGrant(location, GRANT.MODEL_USE, { model: current }, { validators }) };
}
