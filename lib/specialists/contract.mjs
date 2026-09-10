/**
 * 7c — specialist contracts, DERIVED from measured tool signatures (#127, DEC-0003).
 *
 * ⚠️ **Nothing here restates a tool's shape.** The contracts import `RESEARCH_TOOL_SIGNATURES` and the
 * typed-tool registry and reference them; they do not copy them. A contract that duplicated a
 * signature would be a second source of truth that drifts the first time a tool changes, and #81's
 * check would then be comparing a child against a document rather than against the host — which is
 * precisely the failure #67 measured, one level up.
 *
 * ⚠️ **A contract describes what the host can supply AND detect.** Every capability named here is
 * probeable, and `verifyChild` refuses output from a child that cannot demonstrate them. A capability
 * that could not be checked would make the contract true on Monday and silently false on Tuesday.
 */

import { RESEARCH_TOOL_SIGNATURES } from "../research/tools.mjs";
import { VALIDATION_TOOL_SIGNATURES } from "../validation/tools.mjs";
import { TYPED_TOOLS, MUTATION_TOOLS } from "../tools/registry.mjs";
import { TAVILY } from "../research/tavily-adapter.mjs";
import { AUTH_SOURCE } from "../pi-provider-credentials.mjs";

/** Roles, from #26's roster. */
export const ROLES = ["research", "planning", "validation"];

/**
 * Why a child's environment could not be built. Raised BEFORE anything is spawned.
 *
 * ⚠️ **A REFUSAL RATHER THAN A THINNER ENVIRONMENT, BECAUSE THE ALTERNATIVE IS A CHILD THAT STARTS
 * AND CANNOT WORK.** A research child with no research credential, or a provider whose declared name
 * is not set, fails somewhere inside a model turn and surfaces as an unhelpful capability error two
 * processes away from its cause. The names are in the refusal; no value ever is.
 */
export const ENV_REFUSAL = Object.freeze({
  UNKNOWN_ROLE: "unknown-role",
  AGENT_DIR_MISSING: "agent-dir-missing",
  PROVIDER_NAME_MISSING: "provider-name-missing",
  PROVIDER_ANYOF_UNSATISFIED: "provider-anyof-unsatisfied",
  RESEARCH_CREDENTIAL_MISSING: "research-credential-missing",
  RESEARCH_FLAG_INVALID: "research-flag-invalid",
});

export class ChildEnvRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "ChildEnvRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * The base runtime and configuration names, per platform, reproduced from the compatibility spike's
 * own source allowlist (`tools/pi-compat/lib/consumer.mjs`) rather than restated from memory.
 *
 * ⚠️ **PLATFORM-SPECIFIC, WHERE THE OLD LIST WAS ONE SHARED SET WITH BOTH PLATFORMS' SPELLINGS IN
 * IT.** That list carried `Path` beside `PATH`, and since Windows environment names are
 * case-insensitive both entries read one variable and both were written into the child — a duplicate
 * key emitted for every child on every run. On POSIX `Path` is simply a different variable that is
 * never set. Splitting the lists removes the duplicate and stops the allowlist claiming credit for
 * `USERPROFILE`, `TEMP` and `windir`, which AST-0045 measured Windows injecting regardless.
 *
 * ⚠️ **`COMSPEC` AND `SHELL` STAY, AND THE REASON IS A BOUNDARY QUESTION RATHER THAN A LIST
 * QUESTION.** Shell execution is prohibited by the child's capabilities — the tool is absent, so
 * nothing can call it — and removing the variable that names the interpreter would be a second,
 * weaker mechanism for the same rule. A boundary enforced by withholding a runtime variable is one an
 * ordinary `/bin/sh` default defeats.
 */
export const BASE_ENV = Object.freeze({
  posix: Object.freeze(["PATH", "HOME", "LANG", "LC_ALL", "SHELL", "TMPDIR", "USER", "TERM"]),
  win32: Object.freeze([
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "COMSPEC",
    "TEMP",
    "TMP",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
  ]),
});

/** Pi's own locators: where the stored auth file is, and where transcripts go. */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const AGENT_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

/**
 * Names Windows puts into every child whatever environment it is handed — AST-0045, measured on both
 * platforms.
 *
 * ⚠️ **EXPORTED SO A TEST CAN REPORT THEM RATHER THAN FAIL ON THEM.** The boundary is a LOWER BOUND
 * on Windows and an exact set on POSIX. A test asserting that a child's environment equals what Kiln
 * added would fail on Windows for reasons that are the operating system's, and reporting the OS as a
 * defect is how a real leak gets lost in a familiar red result. What is asserted instead is the claim
 * that survives: no credential and no unrelated secret is among what Kiln adds.
 */
export const OS_INJECTED_WIN32 = Object.freeze([
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "SYSTEMDRIVE",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

/**
 * The tool-plane credential each role may hold. One name, for one role, and DEC-0006 is why.
 *
 * ⚠️ Separate from the model plane on purpose: a provider credential belongs to whichever provider
 * was selected and reaches every role that talks to a model, while this belongs to one role's tools.
 * Merging them would make "only research holds the research credential" a statement about a list
 * rather than about a boundary.
 */
const TOOL_PLANE = Object.freeze({
  research: Object.freeze([TAVILY.envVar]),
  planning: Object.freeze([]),
  validation: Object.freeze([]),
});

/**
 * Resolve a NAMED variable the way the platform would.
 *
 * ⚠️ **THIS IS NOT THE HOST SCAN THE CREDENTIAL TABLE FORBIDS, AND THE DIFFERENCE IS THE
 * DIRECTION.** Every name asked for here comes from a fixed list or from a provider contract; the
 * index exists only because Windows environment names are case-insensitive, so `windir` and `WINDIR`
 * are one variable and a plain object handed in by a test is not. Nothing here discovers a name by
 * looking at what the host happens to hold, which is the failure `lib/pi-provider-credentials.mjs`
 * exists to prevent one level up.
 */
function resolverFor(hostEnv, win32) {
  if (!win32) return (name) => hostEnv[name];
  const index = new Map();
  for (const [k, v] of Object.entries(hostEnv)) index.set(k.toLowerCase(), v);
  return (name) => (name in hostEnv ? hostEnv[name] : index.get(name.toLowerCase()));
}

/**
 * Which of a provider contract's names this run may hand over, or the refusal that stops it.
 *
 * Four outcomes, and they follow from the contract's own `authSources`:
 *
 *  1. the environment route is complete — every `required` name set and every `anyOf` group
 *     satisfied — so those names, and any `optional` ones that are set, are emitted;
 *  2. it is incomplete and `stored` is a supported source — emit NOTHING and carry on, because the
 *     child can authenticate from `auth.json` through the locator it is given;
 *  3. it is incomplete and `stored` is not supported — refuse, since nothing else can authenticate;
 *  4. only `stored` is supported — emit nothing, whatever the host happens to hold.
 *
 * ⚠️ Case 4 is not case 2 with extra steps. A provider with no environment route must not receive an
 * environment credential merely because a variable of the right name exists on the host.
 */
function providerNamesFor(contract, has, role) {
  const sources = contract.authSources ?? [];
  const stored = sources.includes(AUTH_SOURCE.STORED);
  const viaEnvironment =
    sources.includes(AUTH_SOURCE.ENVIRONMENT_KEY) || sources.includes(AUTH_SOURCE.CUSTOM_ENVIRONMENT_KEY);

  if (!viaEnvironment) return { emit: [], refusal: null, route: stored ? "stored" : "none" };

  const missing = contract.required.filter((name) => !has(name));
  const unsatisfied = contract.anyOf.find((group) => !group.some((name) => has(name)));

  if (missing.length === 0 && unsatisfied === undefined) {
    const emit = [
      ...contract.required,
      ...contract.anyOf.flatMap((group) => group.filter((name) => has(name))),
      ...contract.optional.filter((name) => has(name)),
    ];
    return { emit, refusal: null, route: "environment" };
  }

  if (stored) return { emit: [], refusal: null, route: "stored" };

  const refusal =
    missing.length > 0
      ? new ChildEnvRefusal(
          ENV_REFUSAL.PROVIDER_NAME_MISSING,
          `${contract.id} declares ${missing.length} required variable${missing.length === 1 ? "" : "s"} ` +
            `the host does not set: ${missing.join(", ")}, and it supports no stored credential to fall ` +
            `back to. Refusing rather than spawning a ${role} child that cannot reach its provider.`,
          { role, provider: contract.id, missing }
        )
      : new ChildEnvRefusal(
          ENV_REFUSAL.PROVIDER_ANYOF_UNSATISFIED,
          `${contract.id} needs at least one of ${unsatisfied.join(", ")}, the host sets none of them, ` +
            `and it supports no stored credential to fall back to. Refusing rather than spawning a ` +
            `${role} child that cannot reach its provider.`,
          { role, provider: contract.id, group: [...unsatisfied] }
        );
  return { emit: [], refusal, route: "refused" };
}

/**
 * Build the environment for one role's child. NEVER `process.env` wholesale.
 *
 * The child sees the union of three things and nothing else: the measured base for its platform plus
 * Pi's locators, the selected provider contract's declared model-plane names, and its own role's
 * tool-plane name when that role is enabled to hold one.
 *
 * ⚠️ **`researchEnabled` IS SUPPLIED, NOT DERIVED, AND THAT IS THE WHOLE POINT OF THE PARAMETER.**
 * Deriving it from the credential being present would make "the key crosses only while research is
 * enabled" and "the key crosses when the host has a key" the same sentence, and ACC-0059's negative
 * case — enabled false, key present, key must not cross — would be unreachable. It is `=== true`
 * rather than truthy for the same reason `PORT` is parsed rather than coerced: an absent flag must
 * not read as permission.
 *
 * ⚠️ **THE PROVIDER CONTRACT IS ITERATED, NEVER MATCHED AGAINST THE HOST.** `required`, each
 * `anyOf` group and `optional` are walked by name. A builder that filtered `hostEnv` for things
 * looking like keys would pass every positive test and hand a child whatever the operator happened to
 * have exported.
 *
 * @param {"research"|"planning"|"validation"} role
 * @param {Record<string,string|undefined>} hostEnv
 * @param {{contract?: object|null, researchEnabled?: boolean, platform?: string}} [opts]
 */
export function childEnv(role, hostEnv = process.env, opts = {}) {
  const { contract = null, researchEnabled = false, platform = process.platform } = opts;
  if (!ROLES.includes(role))
    throw new ChildEnvRefusal(ENV_REFUSAL.UNKNOWN_ROLE, `Unknown role: ${role}`, { role });

  const win32 = platform === "win32";
  const read = resolverFor(hostEnv, win32);

  const out = {};
  const seen = new Set();
  /** Emit once, under the spelling this module chose rather than the host's. */
  const emit = (name) => {
    const key = win32 ? name.toLowerCase() : name;
    if (seen.has(key)) return;
    const value = read(name);
    if (value === undefined) return;
    seen.add(key);
    out[name] = value;
  };
  const has = (name) => read(name) !== undefined;

  // ---- validate before emitting, so a refusal never leaves a half-built environment -------------

  // ⚠️ **AN ABSENT AGENT DIRECTORY IS A REFUSAL, BECAUSE OMISSION DOES NOT ISOLATE ON WINDOWS.**
  // `USERPROFILE` is injected into every Windows child, so a child with no `PI_CODING_AGENT_DIR`
  // resolves the DEFAULT agent directory and reads the operator's own stored credentials. Redirecting
  // it therefore requires setting the variable positively; leaving it out is not a narrower child, it
  // is a child pointed at the host's auth file.
  if (!has(AGENT_DIR_ENV))
    throw new ChildEnvRefusal(
      ENV_REFUSAL.AGENT_DIR_MISSING,
      `${AGENT_DIR_ENV} is not set, so a ${role} child cannot be given an isolated agent directory. ` +
        `Omitting it does not produce a child with no configuration directory: Windows injects ` +
        `USERPROFILE regardless, so the child would resolve the operator's own default and read the ` +
        `stored credentials there. The directory must be named positively.`,
      { role, variable: AGENT_DIR_ENV }
    );

  // ⚠️ **COMPLETENESS IS JUDGED AGAINST THE CONTRACT'S AUTH SOURCES, NOT ON ITS OWN.** Requiring the
  // environment names unconditionally made `auth.json` unreachable: every built-in provider supports
  // BOTH routes, so a perfectly good stored credential was refused because the environment did not
  // also carry a copy of it. That is the opposite of what CMP-0029 asks for — the note there PREFERS
  // the auth store, because then a child needs the variables that LOCATE a credential rather than the
  // credential itself. It would also have blocked TSK-0040's canary from ever discovering that the
  // stored source is the one in use.
  //
  // ⚠️ **AND AN INCOMPLETE SET IS EMITTED AS NOTHING, NEVER AS A PARTIAL ONE.** Handing over the two
  // of three names that happen to be set produces a child that authenticates with a half-configured
  // provider or, worse, silently falls through to a stored credential the operator did not intend for
  // this run. Either the environment route is complete and is used, or it is not used at all.
  const provider = contract ? providerNamesFor(contract, has, role) : null;

  if (contract && provider.refusal) throw provider.refusal;

  // ⚠️ **ENABLED AND MISSING IS A REFUSAL, NOT A QUIET DEGRADE.** A research child with research
  // switched on and no credential answers from model memory or reports a capability gap for a reason
  // the operator already fixed host-side. Enabled and absent are different from disabled.
  // ⚠️ **AN OMITTED FLAG IS `false`; A SUPPLIED NON-BOOLEAN IS A REFUSAL.** The two are different
  // mistakes. Not passing it is a caller that has no research to enable, which is the common case and
  // the safe default. Passing `"false"`, `0` or `null` is a caller that BELIEVES it has expressed a
  // choice, and reading that as "disabled" would be right half the time by accident — `"false"` is
  // truthy, so the same sloppy value could equally have opened the gate under a truthiness check.
  if (opts.researchEnabled !== undefined && typeof researchEnabled !== "boolean")
    throw new ChildEnvRefusal(
      ENV_REFUSAL.RESEARCH_FLAG_INVALID,
      `researchEnabled must be a boolean when it is supplied, and it was ${typeof researchEnabled}. ` +
        `It is the committed project choice AND the host-local consent, decided by the caller; a value ` +
        `this cannot read is a configuration error rather than a reason to disable research quietly.`,
      { role, received: typeof researchEnabled }
    );

  const toolPlane = TOOL_PLANE[role];
  const researchCredential = role === "research" && researchEnabled === true;
  if (researchCredential && !has(TAVILY.envVar))
    throw new ChildEnvRefusal(
      ENV_REFUSAL.RESEARCH_CREDENTIAL_MISSING,
      `Research is enabled for this run and ${TAVILY.envVar} is not set in the host environment. ` +
        `Refusing rather than starting a research child that cannot retrieve anything (DEC-0006).`,
      { role, variable: TAVILY.envVar }
    );

  // ---- emit ------------------------------------------------------------------------------------

  for (const name of BASE_ENV[win32 ? "win32" : "posix"]) emit(name);
  emit(AGENT_DIR_ENV);
  emit(AGENT_SESSION_DIR_ENV);

  if (provider) for (const name of provider.emit) emit(name);

  // ⚠️ The ONLY route by which the tool-plane name is emitted, and it is gated on both facts.
  if (researchCredential) for (const name of toolPlane) emit(name);

  return out;
}

/**
 * The write boundary: which typed tools a role may call.
 *
 * ⚠️ Enforced by ABSENCE, not by refusal (#67's lesson, verified by check 2): an out-of-role tool is
 * not present in the child's registry, so the model cannot call it and then be told no. A boundary
 * that depends on the child choosing to respect it is an instruction, not a boundary.
 */
const WRITE_BOUNDARY = {
  research: { create: ["evidence", "assertion", "question"], mutate: ["linkEvidence", "unlinkEvidence"] },
  planning: { create: ["requirement", "decision", "question", "assertion", "runbook-step"], mutate: ["reviseArtifact", "setLifecycle", "resolveQuestion", "linkEvidence", "unlinkEvidence"] },
  validation: { create: ["evidence"], mutate: ["linkEvidence"] },
};

/** Capabilities each role REQUIRES, named as things the host can probe. */
const REQUIRED_CAPABILITIES = {
  research: ["research_capability", "research_search", "research_fetch"],
  planning: [],
  validation: ["validation_capability", "validation_run"],
};

/**
 * Every measured signature the host publishes, in one place so a contract looks its capabilities up
 * rather than knowing where they live.
 *
 * ⚠️ A capability named by a role and ABSENT here is a contract promising something nothing defines.
 * `contractFor` reports it rather than dropping it silently — that omission is what let the first
 * validation contract require `validation_controller`, a name with no signature behind it, so #81's
 * check would have compared the child against an empty object and passed.
 */
const MEASURED_SIGNATURES = { ...RESEARCH_TOOL_SIGNATURES, ...VALIDATION_TOOL_SIGNATURES };

/**
 * Build a role's contract by REFERENCE to what exists.
 *
 * @param {"research"|"planning"|"validation"} role
 * @returns {object} the contract — signatures included by reference, never restated
 */
export function contractFor(role) {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);

  const toolSignatures = {};
  const undefinedCapabilities = [];
  for (const name of REQUIRED_CAPABILITIES[role]) {
    // ⚠️ Read from the measured signature table. A name with no signature is a contract that would
    // promise something nothing defines — REPORTED here rather than silently skipped.
    if (MEASURED_SIGNATURES[name]) toolSignatures[name] = MEASURED_SIGNATURES[name];
    else undefinedCapabilities.push(name);
  }

  const boundary = WRITE_BOUNDARY[role];
  const unimplemented = boundary.create.filter((t) => !TYPED_TOOLS[t]);
  const unknownMutations = boundary.mutate.filter((m) => !MUTATION_TOOLS[m]);

  return {
    role,
    requiredCapabilities: REQUIRED_CAPABILITIES[role],
    toolSignatures,
    writeBoundary: boundary,
    // ⚠️ Reported, not hidden. A contract naming a write it cannot perform is #94's capability gap
    // inside a specialist definition, and the honest move is to say so at build time.
    unimplemented,
    unknownMutations,
    undefinedCapabilities,
    // ⚠️ WHAT THE ROLE MAY HOLD, not what a given run will hand it: the run also needs research
    // to be enabled, which is `childEnv`'s input rather than the contract's property.
    credentials: TOOL_PLANE[role],
    forbidden: [
      "shell execution",
      "reading environment variables outside the injected allowlist",
      ...(role === "research" ? ["answering from model memory when retrieval is unavailable"] : []),
      ...(role !== "planning" ? ["authoring requirements or decisions"] : []),
    ],
  };
}

/** Why a child's output was refused. */
export const CHILD_REFUSED = {
  NO_STDIN: "task-not-delivered",
  TIMED_OUT: "timed-out",
  CAPABILITY_MISSING: "capability-missing",
  SIGNATURE_MISMATCH: "signature-mismatch",
  OUT_OF_ROLE_WRITE: "out-of-role-write",
};

/**
 * #81 at the acceptance boundary: a child's output is accepted only after it demonstrates the three
 * preconditions. Any failure is a STRUCTURED REFUSAL, never a fallback to prose.
 *
 * ⚠️ **Order matters and is the point.** Capability is checked BEFORE output is read, because a child
 * that produced plausible text without its tools is the exact #67 failure — and text that has already
 * been read is text that has already been believed.
 *
 * @param {object} contract
 * @param {{stdinDelivered: boolean, timedOut: boolean, reportedTools: object, output: any}} run
 */
export function verifyChild(contract, run) {
  const refuse = (reason, detail) => ({ accepted: false, reason, detail, role: contract.role });

  if (!run?.stdinDelivered)
    return refuse(CHILD_REFUSED.NO_STDIN, "The task was never delivered on stdin, so whatever the child produced is not an answer to it.");

  if (run.timedOut)
    return refuse(CHILD_REFUSED.TIMED_OUT, "The child did not finish. Partial output is not a partial answer.");

  const reported = run.reportedTools ?? {};
  for (const name of contract.requiredCapabilities) {
    if (!(name in reported))
      return refuse(CHILD_REFUSED.CAPABILITY_MISSING, `The child could not demonstrate \`${name}\`. Installed-but-unusable is unavailable (DEC-0004).`);
  }

  // The signature check: not "is it there" but "is it the shape the contract was written against".
  for (const [name, spec] of Object.entries(contract.toolSignatures)) {
    const seen = reported[name];
    if (!signaturesMatch(spec, seen))
      return refuse(
        CHILD_REFUSED.SIGNATURE_MISMATCH,
        `\`${name}\` does not match the measured signature the contract was written against. A contract ` +
          `verified against a changed tool is verified against nothing.`
      );
  }

  return { accepted: true, role: contract.role, output: run.output };
}

/** Compare a reported tool against the signature the contract references. */
export function signaturesMatch(spec, seen) {
  if (!seen || typeof seen !== "object") return false;
  const want = Object.keys(spec.input?.properties ?? {}).sort();
  const got = Object.keys(seen.input?.properties ?? {}).sort();
  if (want.length !== got.length || want.some((k, i) => k !== got[i])) return false;
  const wantReq = [...(spec.input?.required ?? [])].sort();
  const gotReq = [...(seen.input?.required ?? [])].sort();
  return wantReq.length === gotReq.length && wantReq.every((k, i) => k === gotReq[i]);
}

/** May this role perform this write? Consulted by the host when registering the child's tools. */
export function mayWrite(contract, { create, mutate }) {
  if (create) return contract.writeBoundary.create.includes(create);
  if (mutate) return contract.writeBoundary.mutate.includes(mutate);
  return false;
}
