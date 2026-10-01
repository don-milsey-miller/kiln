/** Configure the committed provider choice and this host's separate consent. */

import {
  GRANT,
  NOT_REMEMBERED,
  clearGrants,
  recordGrant,
} from "./consent-record.mjs";
import {
  PROJECT_RECORD,
  PROJECT_RECORD_KEY,
  RECORD,
  projectRecordState,
} from "./local-state.mjs";
import { runWithTransaction } from "./setup-transaction.mjs";

export class DecisioningChoiceRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "DecisioningChoiceRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

export function committedDecisioningChoice(projectRoot, { validators } = {}) {
  const state = projectRecordState(projectRoot, { validators });
  if (state.kind === RECORD.ABSENT) return null;
  if (state.kind === RECORD.INVALID)
    throw new DecisioningChoiceRefusal(
      "project-record-invalid",
      `${PROJECT_RECORD} is invalid (${state.detail}); restore it before configuring decisioning.`
    );
  return state.record.decisioning?.provider ?? null;
}

export async function writeDecisioningChoice({ transaction, location, provider, validators }) {
  if (provider !== "typesafe" && provider !== "none")
    throw new TypeError(`A decisioning choice is "typesafe" or "none", got ${JSON.stringify(provider)}`);

  return runWithTransaction(transaction, "writeDecisioningChoice", async () => {
    const from = committedDecisioningChoice(location.projectRoot, { validators });
    if (from === provider) return { changed: false, from, to: provider, cleared: [] };

    const clear = await clearGrants(location, [GRANT.DECISIONING], { validators });
    const safe = clear.written || clear.reason === "unchanged" || clear.reason === "no-runtime-dir";
    if (!safe && provider === "typesafe")
      throw new DecisioningChoiceRefusal(
        clear.reason,
        `The decisioning choice was not changed because Kiln could not first clear this computer's earlier grant: ${NOT_REMEMBERED[clear.reason] ?? clear.reason}`
      );

    let changed = false;
    await transaction.merge(PROJECT_RECORD_KEY, (current) => {
      if (current === null)
        throw new DecisioningChoiceRefusal(
          "no-project-record",
          `${PROJECT_RECORD} does not exist. Run Kiln setup before configuring decisioning.`
        );
      const record = JSON.parse(current);
      if (record.decisioning?.provider === provider) return null;
      changed = true;
      return JSON.stringify({ ...record, decisioning: { provider } }, null, 2) + "\n";
    });
    return {
      changed,
      from,
      to: provider,
      cleared: clear.written ? [GRANT.DECISIONING] : [],
      ...(!safe ? { uncleared: clear.reason } : {}),
    };
  });
}

/**
 * `provider: typesafe` is an explicit approval to probe and, on success, remember the host grant.
 * A failed probe changes nothing. Disabling clears the grant before committing `none`.
 */
export async function configureDecisioning({
  transaction,
  location,
  provider,
  adapter,
  now,
  validators,
}) {
  if (provider === "none") {
    const choice = await writeDecisioningChoice({ transaction, location, provider, validators });
    return {
      ok: true,
      available: false,
      provider,
      choice,
      message: "TypeSafe decisioning is disabled for this project and its host grant is cleared.",
    };
  }
  if (provider !== "typesafe")
    throw new TypeError(`provider must be "typesafe" or "none", got ${JSON.stringify(provider)}`);
  if (!adapter?.probe) throw new TypeError("Configuring TypeSafe needs an adapter with probe().");

  const probe = await adapter.probe();
  if (probe.ok === false)
    return {
      ok: false,
      available: false,
      provider,
      ...probe,
      message: "TypeSafe was not enabled; the project choice and host consent were left unchanged.",
    };

  const choice = await writeDecisioningChoice({ transaction, location, provider, validators });
  const consent = await recordGrant(
    location,
    {
      grant: GRANT.DECISIONING,
      granted: true,
      choice: { decisioning: "typesafe" },
      now,
    },
    { validators }
  );
  return {
    ok: true,
    available: true,
    provider,
    model: probe.model,
    models: probe.models,
    checkedWithoutInference: probe.checkedWithoutInference === true,
    choice,
    consent,
    ...(consent.written || consent.reason === "unchanged"
      ? {}
      : { notRemembered: NOT_REMEMBERED[consent.reason] }),
    message: "TypeSafe decisioning is enabled for this project on this computer.",
  };
}
