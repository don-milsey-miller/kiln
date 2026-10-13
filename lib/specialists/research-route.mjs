/**
 * Whether a delegated research child is handed the research credential, decided by its parent before it is spawned - #215.
 *
 * ⚠️ **NOTHING HERE COMES FROM A TOOL ARGUMENT.** The project and its state mode are the ones the supervisor named for
 * this session, and the answer is the same two-record check the session's own research tools make
 * (`lib/research/permission.mjs`).
 *
 * ⚠️ **PERMISSION FIRST, THEN THE KEY.** Resolving a credential is privileged, so nothing is resolved for a project
 * that has not permitted research. That child is still started, without the key: its tools make the same check and
 * answer with the real reason.
 *
 * ⚠️ **THE PARENT RESOLVES; THE CHILD NEVER ASKS THE VAULT.** A key held in the environment or in the system vault is
 * resolved here and travels to the child as one named variable through `childEnv`'s allowlist. Inside the child,
 * `runtimeCredentialEnv` reads its environment and nothing else.
 *
 * ⚠️ **A PERMITTED PROJECT WITH NO KEY IS NOT DECIDED HERE.** The environment is returned as it was, `childEnv`
 * refuses with `research-credential-missing`, and no child is started.
 */

import { CREDENTIAL_SERVICE, runtimeCredentialEnv } from "../credential-broker.mjs";
import { researchPermissionFromEnv } from "../research/permission.mjs";

/**
 * @param {{env?: object, permission?: Function, credentialEnv?: Function}} [deps]  test seams
 * @returns {Promise<{researchEnabled: boolean, hostEnv: object}>}  `hostEnv` is what `childEnv` picks names from
 */
export async function sessionResearchRoute(deps = {}) {
  const env = deps.env ?? process.env;
  let gate;
  try {
    gate = (deps.permission ?? researchPermissionFromEnv)(env);
  } catch {
    // A check that could not be made is not permission.
    gate = null;
  }
  if (gate?.permitted !== true) return { researchEnabled: false, hostEnv: env };

  let hostEnv = env;
  try {
    hostEnv = (await (deps.credentialEnv ?? runtimeCredentialEnv)(CREDENTIAL_SERVICE.TAVILY, { env })) ?? env;
  } catch {
    // ⚠️ THE ERROR IS DROPPED. A vault that could not be asked leaves the environment as it was.
  }
  return { researchEnabled: true, hostEnv };
}
