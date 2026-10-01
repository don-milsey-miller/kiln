/**
 * Decisioning is usable only when the project chose TypeSafe and this host granted that exact use.
 * The gate reads both records before an adapter is constructed or TYPESAFE_API_KEY is inspected.
 */

import { CONSENT_READ, GRANT, STANDING, consentLocation, peekGrant } from "../consent-record.mjs";
import { PROJECT_ROOT_ENV, STATE_MODE_ENV } from "../research/permission.mjs";
import { RECORD, STATE_MODE, projectRecordState } from "../local-state.mjs";

export const DECISIONING_REFUSAL = Object.freeze({
  NO_PROJECT: "decisioning-no-project-context",
  PROJECT_UNREADABLE: "decisioning-project-record-unreadable",
  NOT_CHOSEN: "decisioning-not-chosen",
  CONSENT_UNREADABLE: "decisioning-consent-unreadable",
  UNKNOWN_STATE_MODE: "decisioning-state-mode-unknown",
  NOT_GRANTED: "decisioning-not-granted",
});

const refuse = (reason, detail) => ({ permitted: false, reason, detail });

export function decisioningPermission({
  projectRoot = null,
  stateMode = STATE_MODE.PROJECT,
  env,
  validators,
} = {}) {
  if (stateMode !== STATE_MODE.PROJECT && stateMode !== STATE_MODE.USER)
    return refuse(
      DECISIONING_REFUSAL.UNKNOWN_STATE_MODE,
      `The local-state mode ${JSON.stringify(stateMode)} is neither "project" nor "user".`
    );
  if (typeof projectRoot !== "string" || projectRoot.length === 0)
    return refuse(
      DECISIONING_REFUSAL.NO_PROJECT,
      "No Kiln project was named, so there is no decisioning choice or host consent to read."
    );

  let project;
  try {
    project = projectRecordState(projectRoot, { validators });
  } catch (error) {
    return refuse(
      DECISIONING_REFUSAL.PROJECT_UNREADABLE,
      `The project record could not be read (${error?.code ?? error?.name ?? "error"}).`
    );
  }
  if (project.kind !== RECORD.VALID)
    return refuse(
      DECISIONING_REFUSAL.PROJECT_UNREADABLE,
      `The project record is ${project.kind}${project.detail ? ` (${project.detail})` : ""}; decisioning needs the project's own choice.`
    );
  if (project.record.decisioning?.provider !== "typesafe")
    return refuse(
      DECISIONING_REFUSAL.NOT_CHOSEN,
      "This project has not enabled TypeSafe decisioning. Run `npm run decisioning:configure -- --project-root <dir> --provider typesafe`."
    );

  let consent;
  try {
    consent = peekGrant(
      consentLocation({
        projectRoot,
        stateMode,
        projectId: project.record.projectId,
        ...(env ? { env } : {}),
      }),
      GRANT.DECISIONING,
      { decisioning: "typesafe" },
      { validators }
    );
  } catch (error) {
    return refuse(
      DECISIONING_REFUSAL.CONSENT_UNREADABLE,
      `This computer's consent record could not be read (${error?.code ?? error?.name ?? "error"}).`
    );
  }
  if (consent.read !== CONSENT_READ.VALID && consent.read !== CONSENT_READ.ABSENT)
    return refuse(
      DECISIONING_REFUSAL.CONSENT_UNREADABLE,
      `This computer's consent record is ${consent.read}, so no decisioning grant can be trusted.`
    );
  if (consent.standing !== STANDING.GRANTED)
    return refuse(
      DECISIONING_REFUSAL.NOT_GRANTED,
      "TypeSafe decisioning has not been approved on this computer for this project. Run the decisioning configuration command here."
    );
  return { permitted: true, provider: "typesafe" };
}

export function decisioningPermissionFromEnv(env = process.env, options = {}) {
  return decisioningPermission({
    projectRoot: env[PROJECT_ROOT_ENV] ?? null,
    stateMode: env[STATE_MODE_ENV] ?? STATE_MODE.PROJECT,
    env,
    ...options,
  });
}

export function refusedDecisioning(tool, gate) {
  return {
    tool,
    ok: false,
    kind: "capability-unavailable",
    reason: gate.reason,
    detail: gate.detail,
    permitted: false,
    fallback: "Use Kiln's existing deterministic state and Pi reasoning path.",
  };
}
