/**
 * The project's trust decision — TSK-0032, CMP-0026, against ACC-0051.
 *
 * A Pi child started in a project nobody has trusted loads none of that project's package: no Kiln
 * tools, no role boundaries, and — measured on 0.84.4 in AST-0042 — no error, no warning and no
 * non-zero exit to say so. The resulting child is not a degraded specialist but an unconstrained
 * model whose output looks exactly like one. So the decision has to be read before an agent starts,
 * and it has to be readable, grantable, deniable and revocable by setup.
 *
 * ⚠️ **THROUGH PI'S OWN EXPORTED STORE, NEVER THROUGH ITS FILE.** DEC-0027 withdrew the earlier plan
 * of writing Pi's user-scoped `trust.json`: its shape is undocumented, unversioned, and belongs to
 * the operator rather than to Kiln. `ProjectTrustStore` is exported from the pinned package's root
 * (QST-0026), so this module depends on a typed class and knows nothing about the file underneath —
 * which is the whole of the difference between the withdrawn decision and this one.
 *
 * ⚠️ **THREE STATES, AND `missing` IS NOT `denied`.** An absent decision is a project nobody has been
 * asked about; a denial is an answer the operator gave. Setup may ask about the first and must not
 * re-ask about the second, and a launch refusal should say which it is. Collapsing them into "not
 * trusted" one layer down would make both impossible one layer up.
 *
 * ⚠️ **THE CANONICAL DIRECTORY IS THE KEY.** The store records a decision against a path, so two
 * spellings of one project — a trailing `.`, a `..` that comes back, a differently cased drive letter
 * on Windows — must not become two decisions, one of which the operator never made.
 *
 * ⚠️ **A WRITE IS VERIFIED THROUGH A SECOND STORE, NOT THE ONE THAT WROTE IT.** The instance that
 * performed a write can answer from whatever it holds in memory; a fresh instance has to read what
 * actually landed. An unverified write is how "trusted" becomes a claim about an object rather than
 * about the project.
 *
 * ⚠️ **THE AGENT DIRECTORY IS ALWAYS THE CALLER'S TO NAME.** There is no default here. Pi's own
 * default is the operator's `~/.pi/agent`, and a module that reached for it whenever a caller forgot
 * would make every test, probe and mistaken call a write into the operator's real trust store.
 */

import { statSync } from "node:fs";

import { canonicalPath, toolRoot } from "./content-root.mjs";
import { resolvePinnedSdk } from "./pi-runtime.mjs";

/** What the store says about a project. `missing` is a question nobody has answered. */
export const TRUST = Object.freeze({ APPROVED: "approved", DENIED: "denied", MISSING: "missing" });

export const TRUST_REFUSAL = Object.freeze({
  NO_AGENT_DIR: "trust-no-agent-dir",
  INVALID_PROJECT: "trust-invalid-project",
  STORE_UNAVAILABLE: "trust-store-unavailable",
  NOT_PERSISTED: "trust-not-persisted",
});

export class TrustRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "TrustRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

/** `boolean | null`, as the store speaks, to one of this module's three states. */
const stateOf = (decision) => (decision === true ? TRUST.APPROVED : decision === false ? TRUST.DENIED : TRUST.MISSING);

/** The decision each state asks the store to record. `missing` is the absence, written as `null`. */
const DECISION_OF = Object.freeze({ [TRUST.APPROVED]: true, [TRUST.DENIED]: false, [TRUST.MISSING]: null });

/**
 * The project directory this decision is about, canonical and existing.
 *
 * ⚠️ It must exist: a decision recorded against a directory that is not there would key on a path the
 * operator cannot inspect, and the first real run would key on a different one.
 */
function canonicalProject(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0)
    throw new TrustRefusal(
      TRUST_REFUSAL.INVALID_PROJECT,
      `A trust decision is about a project directory, and none was named. Nothing was read or written.`,
      { field: "projectRoot" }
    );

  const canonical = canonicalPath(projectRoot);
  let stats = null;
  try {
    stats = statSync(canonical);
  } catch {
    /* reported below */
  }
  if (!stats?.isDirectory())
    throw new TrustRefusal(
      TRUST_REFUSAL.INVALID_PROJECT,
      `The project directory a trust decision would be recorded against is not a directory that exists. ` +
        `Nothing was read or written.`,
      { field: "projectRoot" }
    );
  return canonical;
}

/**
 * A store instance over `agentDir`.
 *
 * ⚠️ A FRESH ONE EVERY TIME, deliberately: each write's verification depends on a reader that cannot
 * have cached the write, and a module-level singleton would quietly remove that.
 */
async function openStore(agentDir, root, storeFactory = null) {
  if (typeof agentDir !== "string" || agentDir.trim().length === 0)
    throw new TrustRefusal(
      TRUST_REFUSAL.NO_AGENT_DIR,
      `Reading or recording a trust decision needs the Pi agent directory it lives in, and none was ` +
        `supplied. There is no default here on purpose: Pi's own default is the operator's home agent ` +
        `directory, and defaulting to it would write the operator's real trust store by accident.`,
      { field: "agentDir" }
    );

  // ⚠️ **A SEAM, AND THE ONLY THING IT IS FOR.** The verification below depends on a reader that can
  // disagree with the writer, and the real store never does so on demand — so the one caller that
  // passes a factory is the test that has to make a write appear not to land. Production passes none,
  // and the agent directory is still required before this point either way.
  if (storeFactory) return storeFactory(agentDir);

  const { url, version } = resolvePinnedSdk(root ?? toolRoot());
  const sdk = await import(url);
  const Store = sdk.ProjectTrustStore;
  if (typeof Store !== "function")
    throw new TrustRefusal(
      TRUST_REFUSAL.STORE_UNAVAILABLE,
      `The pinned Pi package does not export \`ProjectTrustStore\` from its root, so there is no supported ` +
        `way to read or record a trust decision. Nothing was read or written, and no file was touched: ` +
        `writing Pi's trust store directly is what DEC-0027 withdrew.`,
      { version }
    );
  return new Store(agentDir);
}

/**
 * What the store says about this project, without changing anything.
 *
 * @param {object} options
 * @param {string} options.projectRoot  the project the decision is about
 * @param {string} options.agentDir     Pi's agent directory — always the caller's to name
 * @param {string} [options.toolRoot]   where the pinned package is installed
 * @returns {Promise<{state: string, projectRoot: string, recordedFor: string|null}>}
 */
export async function readTrust({ projectRoot, agentDir, toolRoot: root, storeFactory = null } = {}) {
  const canonical = canonicalProject(projectRoot);
  const store = await openStore(agentDir, root, storeFactory);
  const entry = store.getEntry(canonical);
  return {
    state: stateOf(store.get(canonical)),
    projectRoot: canonical,
    // ⚠️ WHICH PATH THE ANSWER CAME FROM. Pi may answer a project from a decision recorded against an
    // ancestor, and an operator told "denied" is entitled to know which directory they denied.
    recordedFor: entry?.path ?? null,
  };
}

/**
 * Record `state` for this project, and prove it landed by reading it back through a NEW store.
 *
 * @returns {Promise<{state: string, projectRoot: string, recordedFor: string|null, changed: boolean}>}
 */
async function record(state, { projectRoot, agentDir, toolRoot: root, storeFactory = null } = {}) {
  const canonical = canonicalProject(projectRoot);
  const store = await openStore(agentDir, root, storeFactory);
  const before = stateOf(store.get(canonical));

  store.set(canonical, DECISION_OF[state]);

  // ⚠️ A SECOND INSTANCE, WHICH HAS TO READ WHAT LANDED rather than what it was just told.
  const verifier = await openStore(agentDir, root, storeFactory);
  const observed = stateOf(verifier.get(canonical));
  if (observed !== state)
    throw new TrustRefusal(
      TRUST_REFUSAL.NOT_PERSISTED,
      `The trust decision was recorded and a fresh read of the store does not agree, so the project's ` +
        `trust is not what this run just asked for. Nothing here will report it as settled.`,
      { wanted: state, observed }
    );

  const entry = verifier.getEntry(canonical);
  return { state: observed, projectRoot: canonical, recordedFor: entry?.path ?? null, changed: observed !== before };
}

/** Trust this project: a later child loads its package and Kiln's tools with it. */
export const grantTrust = (options) => record(TRUST.APPROVED, options);

/** Refuse this project: the operator's answer, and not the same thing as never having been asked. */
export const denyTrust = (options) => record(TRUST.DENIED, options);

/** Withdraw whatever was decided, leaving the project as one nobody has been asked about. */
export const revokeTrust = (options) => record(TRUST.MISSING, options);
