/**
 * Whether research may run for a project on this computer — F4, TSK-0075, ACC-0120.
 *
 * ⚠️ **TWO RECORDS, BOTH REQUIRED, BOTH READ BEFORE ANY KEY.** The project's committed research choice (`.pi/kiln.json`)
 * must be `tavily`, and this computer's consent record must hold a standing research grant for it. Nothing here reads
 * `TAVILY_API_KEY` or contacts anything: a caller asks this first and builds the adapter only on `permitted: true`.
 *
 * ⚠️ **AN UNREADABLE RECORD IS A REFUSAL, NEVER PERMISSION.** A project record that is absent or invalid, or a consent
 * record that is unprotected, tracked, committed, unverified, inaccessible or invalid, refuses with its own reason.
 *
 * ⚠️ **THE PROJECT IS NAMED, NOT GUESSED.** The supervisor gives Pi the project root in `KILN_PROJECT_ROOT` and its state
 * mode in `KILN_STATE_MODE`; the research commands take `--project-root` and `--local-state`. Neither looks at the
 * working directory.
 */

import { CONSENT_READ, GRANT, STANDING, consentLocation, peekGrant } from "../consent-record.mjs";
import { RECORD, STATE_MODE, projectRecordState } from "../local-state.mjs";

/** The environment variable the supervisor sets for the agent: the project research is asked about. */
export const PROJECT_ROOT_ENV = "KILN_PROJECT_ROOT";

/**
 * And where that run keeps its runtime state, so the consent record is read from the same place: `project` (the
 * project's ignored `.pi`) or `user` (the per-user root keyed by the project id, `setup --local-state user`).
 */
export const STATE_MODE_ENV = "KILN_STATE_MODE";

/** Why research was refused. Stable names, for a caller or a test to hold. */
export const RESEARCH_REFUSAL = Object.freeze({
  NO_PROJECT: "research-no-project-context",
  PROJECT_UNREADABLE: "research-project-record-unreadable",
  NOT_CHOSEN: "research-not-chosen",
  CONSENT_UNREADABLE: "research-consent-unreadable",
  UNKNOWN_STATE_MODE: "research-state-mode-unknown",
  /** research:record only: the evidence destination belongs to a project other than the one whose consent was read. */
  DESTINATION_MISMATCH: "research-destination-not-this-project",
  NOT_GRANTED: "research-not-granted",
});

/**
 * @param {{projectRoot?: string|null, stateMode?: string, env?: object, validators?: object}} args
 *   `stateMode` is where this run keeps its runtime state, and so where the grant was recorded: `project` or `user`.
 *   `env` locates the per-user root in `user` mode; it defaults to this process's.
 * @returns {{permitted: true} | {permitted: false, reason: string, detail: string}}
 */
export function researchPermission({ projectRoot = null, stateMode = STATE_MODE.PROJECT, env, validators } = {}) {
  const refuse = (reason, detail) => ({ permitted: false, reason, detail });
  // ⚠️ A GRANT IS LOOKED FOR WHERE THE RUN KEEPS ITS STATE, AND NOWHERE ELSE. A mode this does not know is refused rather
  // than read as project-local: looking in the wrong place would report "not granted" for a grant that exists, or worse.
  if (stateMode !== STATE_MODE.PROJECT && stateMode !== STATE_MODE.USER)
    return refuse(RESEARCH_REFUSAL.UNKNOWN_STATE_MODE, `The local-state mode ${JSON.stringify(stateMode)} is neither "project" nor "user".`);
  if (typeof projectRoot !== "string" || projectRoot.length === 0)
    return refuse(RESEARCH_REFUSAL.NO_PROJECT, "No Kiln project was named, so there is no research choice or consent to read.");

  let project;
  try {
    project = projectRecordState(projectRoot, { validators });
  } catch (e) {
    return refuse(RESEARCH_REFUSAL.PROJECT_UNREADABLE, `The project record could not be read (${e?.code ?? e?.name ?? "error"}).`);
  }
  if (project.kind !== RECORD.VALID)
    return refuse(RESEARCH_REFUSAL.PROJECT_UNREADABLE, `The project record is ${project.kind}${project.detail ? ` (${project.detail})` : ""}; research needs the project's own choice.`);
  if (project.record.research?.provider !== "tavily")
    return refuse(RESEARCH_REFUSAL.NOT_CHOSEN, "This project has not chosen web research. Run setup with --research tavily to choose it.");

  let peek;
  try {
    peek = peekGrant(consentLocation({ projectRoot, stateMode, projectId: project.record.projectId, ...(env ? { env } : {}) }), GRANT.RESEARCH, { research: "tavily" }, { validators });
  } catch (e) {
    return refuse(RESEARCH_REFUSAL.CONSENT_UNREADABLE, `This computer's consent record could not be read (${e?.code ?? e?.name ?? "error"}).`);
  }
  if (peek.read !== CONSENT_READ.VALID && peek.read !== CONSENT_READ.ABSENT)
    return refuse(RESEARCH_REFUSAL.CONSENT_UNREADABLE, `This computer's consent record is ${peek.read}, so no research grant can be read from it.`);
  if (peek.standing !== STANDING.GRANTED)
    return refuse(RESEARCH_REFUSAL.NOT_GRANTED, "Web research has not been approved on this computer for this project. Run setup here and approve it.");
  return { permitted: true };
}

/** The same question for a Pi started by Kiln's supervisor, which names the project in `KILN_PROJECT_ROOT`. */
export function researchPermissionFromEnv(env = process.env, opts = {}) {
  return researchPermission({ projectRoot: env[PROJECT_ROOT_ENV] ?? null, stateMode: env[STATE_MODE_ENV] ?? STATE_MODE.PROJECT, ...opts });
}

/**
 * A research tool's answer when research is not permitted, in the research library's own refusal shape.
 *
 * ⚠️ **FOR THE MODEL THIS IS RESEARCH BEING UNAVAILABLE, SO IT RECORDS A GAP (DEC-0004).** It carries `mustRecordGap`
 * and the same instruction a missing backend does, with the permission's own reason, so a specialist neither works
 * around it nor answers from model memory.
 */
export function refusedResearch(tool, gate) {
  const base = { tool, reason: gate.reason, detail: gate.detail, mustRecordGap: true, permitted: false };
  if (tool === "research_capability") return { ...base, available: false };
  return {
    ...base,
    ok: false,
    kind: "capability-unavailable",
    instruction: "Research is not permitted for this project on this computer. Return a capability refusal and record the gap. Do NOT answer from model memory.",
  };
}
