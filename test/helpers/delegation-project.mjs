/**
 * A project as setup leaves it for a delegation, written by the modules that own each record - #194.
 *
 * A custom provider's credential declaration lives on this computer's model-use grant, which is read only for a project
 * that has a record and a consent location Git does not track. Nothing here writes either file by hand: the ignore
 * block, the project record and the grant each come from Kiln's own writer, so a fixture cannot hold a record setup
 * would not have produced.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GRANT, consentLocation, recordGrant } from "../../lib/consent-record.mjs";
import { PROJECT_RECORD, ensureProjectId, projectRecordTarget } from "../../lib/local-state.mjs";
import { IGNORE_RULES, blockText } from "../../lib/project-gitignore.mjs";
import { runTransaction } from "../../lib/setup-transaction.mjs";

/**
 * @param {string} projectRoot  an existing directory
 * @param {{ignored?: boolean, grant?: {model: {provider: string, model: string, credentialVar?: string}, granted?: boolean}|null,
 *   research?: {chosen?: boolean, granted?: boolean|null}|null, stateMode?: string, env?: object}} [opts]
 *   `ignored: false` leaves the consent record where Git would track it, so it is never trusted.
 *   `research` adds the project's research choice to its record and, when `granted` is a boolean, this computer's
 *   answer to it (#215). `stateMode: "user"` keeps the consent record under the per-user root that `env` locates.
 * @returns {Promise<{projectId: string, grantWritten: boolean|null}>}
 */
export async function projectForDelegation(projectRoot, { ignored = true, grant = null, research = null, stateMode = "project", env = process.env } = {}) {
  execFileSync("git", ["init", "-q"], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
  if (ignored) writeFileSync(join(projectRoot, ".gitignore"), blockText("\n", IGNORE_RULES));
  mkdirSync(join(projectRoot, ".pi", "runtime"), { recursive: true });
  const { projectId } = await runTransaction({ projectRoot, files: [projectRecordTarget()] }, (tx) => ensureProjectId({ transaction: tx, randomBytes }));
  // The research choice has no writer of its own outside setup, so it is added to the record setup's writer produced.
  if (research?.chosen !== false && research) {
    const record = join(projectRoot, PROJECT_RECORD);
    writeFileSync(record, `${JSON.stringify({ ...JSON.parse(readFileSync(record, "utf-8")), research: { provider: "tavily" } }, null, 2)}
`);
  }
  const where = consentLocation({ projectRoot, stateMode, projectId, env });
  mkdirSync(where.runtime, { recursive: true });
  if (typeof research?.granted === "boolean") await recordGrant(where, { grant: GRANT.RESEARCH, granted: research.granted, choice: { research: "tavily" } });
  if (!grant) return { projectId, grantWritten: null };
  const written = await recordGrant(where, { grant: GRANT.MODEL_USE, granted: grant.granted ?? true, choice: { model: grant.model } });
  return { projectId, grantWritten: written.written === true };
}
