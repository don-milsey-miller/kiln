/**
 * The trust decision, taken in a child whose environment holds no credential variable.
 *
 * ⚠️ **WHY A CHILD AT ALL: LOADING PI'S SDK ENUMERATES THE ENVIRONMENT.** Pi's bundled `debug` calls
 * `Object.keys(process.env)` at module load to find its own settings. It reads no value, but it does see which
 * credential variables this computer has — and presence is exactly what setup's inspection consent exists to
 * gate. The trust store is Pi's, so a setup that asks about trust before it asks about connections cannot avoid
 * loading the SDK first. What it can do is load it somewhere the names are not: this process is started with an
 * environment built from a fixed list of variables, by name, so no credential variable is in it to be seen.
 *
 * ⚠️ **AND IT IS NOT A SECOND TRUST IMPLEMENTATION.** `lib/pi-trust.mjs` performs the decision, including its
 * read-back through a second store; this file only carries the request across the process boundary.
 *
 * ⚠️ **IT PRINTS ONE JSON LINE AND NOTHING ELSE.** The parent parses that line; anything on stderr is the
 * failure path, where the exit status is what the parent classifies.
 *
 * argv: one JSON object — `{ action, projectRoot, toolRoot, agentDir? }`.
 */

import { readTrust, grantTrust, denyTrust } from "./pi-trust.mjs";
import { resolvePinnedAgentDir } from "./pi-runtime.mjs";

const ACTIONS = { read: readTrust, approve: grantTrust, deny: denyTrust };

async function main() {
  const [raw] = process.argv.slice(2);
  let spec;
  try {
    spec = JSON.parse(raw ?? "");
  } catch {
    process.stderr.write("the trust child takes one JSON argument\n");
    return 2;
  }

  const act = ACTIONS[spec.action];
  if (!act) {
    process.stderr.write(`unknown trust action: ${JSON.stringify(spec.action)}\n`);
    return 2;
  }

  // ⚠️ RESOLVED HERE, BECAUSE ASKING PI WHERE ITS DIRECTORY IS *IS* LOADING PI. The parent needs the answer for
  // its own later phases, so it comes back in the report rather than being resolved twice.
  const agentDir = spec.agentDir ?? (await resolvePinnedAgentDir(spec.toolRoot));
  const decision = await act({ projectRoot: spec.projectRoot, agentDir, toolRoot: spec.toolRoot });
  process.stdout.write(`${JSON.stringify({ ...decision, agentDir })}\n`);
  return 0;
}

try {
  process.exit(await main());
} catch (e) {
  // ⚠️ THE MESSAGE IS KILN'S OWN REFUSAL TEXT, which names paths and decisions but never a credential; anything
  // else is reported by class alone, because an error from Pi can carry configuration this must not print.
  process.stderr.write(`${e?.name === "TrustRefusal" || e?.name === "SupervisorRefusal" ? e.message : (e?.name ?? "Error")}\n`);
  process.exit(3);
}
