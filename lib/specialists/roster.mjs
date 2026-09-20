/**
 * The specialist roster and what each role must be able to do — TSK-0051, extracted TSK-0071.
 *
 * ⚠️ **THIS FILE IMPORTS NOTHING, AND THAT IS ITS JOB.** `lib/specialists/contract.mjs` reaches the tool
 * registry, the research and validation adapters and the provider credentials, and through them `ajv`.
 * A stage definition is checked against the roster while it loads, and `lib/stages.mjs` is read by the
 * stage-skill CLI inside a copied tree that installs no dependencies. Importing the contract there made
 * that CLI unloadable, which a retained fixture caught. So the table lives here, where both can read it.
 *
 * ⚠️ **IT IS STILL ONE TABLE, NOT TWO.** `contractFor(role).requiredCapabilities` returns what this file
 * declares, and `test/specialist-contract.test.mjs` asserts the two agree for every role, in order.
 * Copying the names into the loader instead would have been the second description this repository keeps
 * refusing.
 *
 * ⚠️ **NOT `roles.mjs`.** That file is the authored PROSE of each role definition. This is the roster the
 * contract and the stage loader both derive from, and keeping the two apart is why neither has to import
 * the other's dependencies.
 */

/** Every specialist role Kiln defines. */
export const ROLES = ["research", "planning", "validation"];

/**
 * The capabilities a role cannot work without.
 *
 * ⚠️ **AN EMPTY LIST IS A DECLARATION, NOT AN OVERSIGHT.** `planning` needs no capability tool: it works
 * on artifacts the project already has. A stage definition delegating to it says `"capabilities": []` for
 * the same reason — silence and "none required" must not look alike.
 */
const REQUIRED_CAPABILITIES = {
  research: ["research_capability", "research_search", "research_fetch"],
  planning: [],
  validation: ["validation_capability", "validation_run"],
};

/** What this role requires, in the order it was declared. An unknown role gets null, never a guess. */
export function requiredCapabilitiesFor(role) {
  return Object.hasOwn(REQUIRED_CAPABILITIES, role) ? [...REQUIRED_CAPABILITIES[role]] : null;
}

/**
 * The same list, sorted and de-duplicated: the form a stage definition must declare (D50).
 *
 * ⚠️ **THE DECLARED ORDER IS NOT SORTED, WHICH IS WHY THIS EXISTS.** `research` is declared capability,
 * search, fetch; sorted it is capability, fetch, search. A definition copying the declaration order is
 * refused, so the comparison needs one canonical form on both sides rather than two orders to reconcile.
 */
export function canonicalCapabilitiesFor(role) {
  const required = requiredCapabilitiesFor(role);
  return required === null ? null : [...new Set(required)].sort();
}
