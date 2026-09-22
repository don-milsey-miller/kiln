/**
 * Where the pinned Pi runtime comes from — TSK-0024's `lib/pi-runtime.mjs`, and the only copy.
 *
 * ⚠️ **IT LIVES HERE RATHER THAN IN `supervisor.mjs` BECAUSE THE TASK NAMED THIS FILE AND THE TREE
 * DID NOT HAVE IT.** The resolver was written inside the supervisor, which worked and left the
 * approved task describing a module nobody could open. One home, imported by the command that needs
 * it; a second copy anywhere is the defect this file exists to make impossible.
 *
 * ⚠️ **`runSupervisor` DOES NOT CALL THIS, AND THAT IS THE DESIGN RATHER THAN AN OVERSIGHT.** The
 * supervisor takes the agent as a command and an argument array, because the choice of program is
 * the security boundary and the seam that makes the supervisor testable must stay internal. So the
 * consumer is `bin/start-kiln.mjs`, the half of the supervisor whose job is to say what runs. A
 * `runSupervisor` that resolved its own agent would be a supervisor that could be pointed at
 * something else, which is exactly what its header refuses.
 *
 * ⚠️ **THE REFUSAL TYPES COME FROM THE SUPERVISOR, AND THE DEPENDENCY POINTS ONE WAY.** An agent
 * that will not resolve is a supervisor refusal — the operator meets it from the same command, with
 * the same exit status — so it is not given a private error class of its own. Nothing in
 * `supervisor.mjs` imports this module back.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalPath, isAtOrInside } from "./content-root.mjs";
import { REFUSAL, SupervisorRefusal } from "./supervisor.mjs";

const NEWLINE = "\n";

/** The package this project pins. Named once, here, because two spellings of it is two resolvers. */
export const PINNED_AGENT_NAME = "@earendil-works/pi-coding-agent";

/**
 * The pinned Pi CLI, resolved from the installed package's OWN declaration.
 *
 * ⚠️ **THE MANIFEST SAYS WHERE THE ENTRY POINT IS; GUESSING IS HOW YOU RUN A DIFFERENT FILE.** An
 * earlier version tried `dist/cli.js` first with two speculative fallbacks, and `bin.pi` on the
 * pinned version is `dist/bundle/cli.js` — a different file that happens to sit beside it. The
 * package declares one entry point and that is the one an operator's `pi` would run.
 *
 * ⚠️ **NAME AND VERSION ARE CHECKED AGAINST THE PIN, and the path is contained inside the package.**
 * `bin.pi` is data from a manifest on disk; a relative path escaping the package directory would be
 * this supervisor handing the operator's terminal to something outside the thing it pinned.
 */
export function resolvePinnedAgent(toolRoot, { name, version } = {}) {
  const root = canonicalPath(toolRoot);
  const expectName = name ?? readOwnPin(root).name;
  const expectVersion = version ?? readOwnPin(root).version;
  const pkgDir = join(root, "node_modules", ...expectName.split("/"));
  const manifestPath = join(pkgDir, "package.json");

  const refuse = (message, detail = {}) =>
    new SupervisorRefusal(REFUSAL.AGENT_NOT_INSTALLED, message, { package: expectName, ...detail });

  // ⚠️ **THE EXPECTED VERSION AND THE RESOLVED PATH ARE BOTH IN THE MESSAGE, AND BOTH IN `detail`.**
  // ACC-0041 asks the refusal to NAME them: "not installed" alone leaves an operator to work out
  // which version was wanted and which directory was looked in, and those are the only two facts
  // that distinguish "run setup" from "your pin moved". They are in `detail` as well because a test
  // that can only match prose pins the wording rather than the content.
  if (!existsSync(manifestPath))
    throw refuse(
      `The pinned agent ${expectName}@${expectVersion} is not installed under ${pkgDir}.` +
        `${NEWLINE}Run setup for this project, which installs the pinned agent runtime.`,
      { expected: `${expectName}@${expectVersion}`, pkgDir }
    );

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    throw refuse(`${manifestPath} is not readable JSON: ${e.message}`);
  }
  if (manifest.name !== expectName || manifest.version !== expectVersion)
    throw refuse(
      `The installed agent is ${manifest.name}@${manifest.version}, not the pinned ` +
        `${expectName}@${expectVersion}. Refusing rather than starting a version nothing here was ` +
        `measured against.`,
      { installed: `${manifest.name}@${manifest.version}` }
    );

  // ⚠️ **`bin.pi` SPECIFICALLY, NOT "WHATEVER `bin` IS".** A string-valued `bin` is npm shorthand
  // for "one executable named after the package"; accepting it here would run an entry point this
  // contract never names, on a package that declares no `pi` at all.
  const bin = manifest.bin;
  const declared = bin && typeof bin === "object" && !Array.isArray(bin) ? bin.pi : undefined;
  if (typeof declared !== "string" || declared.length === 0)
    throw refuse(`${manifestPath} declares no \`bin.pi\` entry point.`);

  const entry = canonicalPath(join(pkgDir, declared));
  if (!isAtOrInside(entry, canonicalPath(pkgDir)))
    throw refuse(`\`bin.pi\` resolves outside its own package, which nothing legitimate does.`, { entry });
  // ⚠️ **A REGULAR FILE, BECAUSE `existsSync` IS TRUE OF A DIRECTORY.** `bin.pi: "."` resolved to the
  // package root and passed — an entry point that is not a program at all, discovered only when the
  // spawn failed with the terminal already committed.
  let entryStat = null;
  try {
    entryStat = statSync(entry);
  } catch {
    /* reported as missing below */
  }
  if (!entryStat) throw refuse(`\`bin.pi\` points at ${declared}, which is not installed.`, { entry });
  if (!entryStat.isFile()) throw refuse(`\`bin.pi\` points at ${declared}, which is not a file.`, { entry });

  return { command: process.execPath, args: [entry], entry, version: manifest.version };
}

/**
 * The pinned Pi SDK entry, resolved from the installed package OWN `exports` declaration.
 *
 * ⚠️ **THE SAME PIN AS THE CLI, CHECKED BY THE SAME FUNCTION, IN THE SAME FILE.** The name and version gate
 * is `resolvePinnedAgent`, called rather than restated, so the CLI and the SDK can never be held to two
 * different checks. What this adds is the one thing the CLI resolver does not know: where the ESM entry is.
 *
 * ⚠️ **THE MANIFEST SAYS WHERE THE ENTRY IS, AND THE PATH IS CONTAINED.** The compatibility spike built
 * `dist/index.js` by hand. The package declares it under `exports["."]`, which is what a consumer import
 * resolves, so that is what is read. It must canonicalise inside the package and be a regular file, for the
 * reason `bin.pi` must: an entry outside the pinned package is this process importing something it never
 * pinned.
 *
 * @param {string} toolRoot
 * @returns {{url: string, entry: string, version: string}}
 */
export function resolvePinnedSdk(toolRoot) {
  const agent = resolvePinnedAgent(toolRoot);
  const pkgDir = canonicalPath(join(canonicalPath(toolRoot), "node_modules", ...PINNED_AGENT_NAME.split("/")));
  const manifestPath = join(pkgDir, "package.json");
  const refuse = (message, detail = {}) =>
    new SupervisorRefusal(REFUSAL.AGENT_NOT_INSTALLED, message, { package: PINNED_AGENT_NAME, ...detail });

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const dot = manifest.exports && manifest.exports["."];
  const declared = typeof dot === "string" ? dot : dot && typeof dot === "object" ? dot.import : undefined;
  if (typeof declared !== "string" || declared.length === 0)
    throw refuse(`${manifestPath} declares no ESM entry point under exports["."].`);

  const entry = canonicalPath(join(pkgDir, declared));
  if (!isAtOrInside(entry, pkgDir))
    throw refuse(`The SDK entry resolves outside its own package, which nothing legitimate does.`, { entry });

  let entryStat = null;
  try {
    entryStat = statSync(entry);
  } catch {
    /* reported below */
  }
  if (!entryStat || !entryStat.isFile())
    throw refuse(`The SDK entry ${declared} is not an installed file.`, { entry });

  return { url: pathToFileURL(entry).href, entry, version: agent.version };
}

/** The pinned agent's model library, whose `./compat` export holds Pi's thinking-level rule. */
export const PINNED_AI_NAME = "@earendil-works/pi-ai";

/**
 * The `./compat` entry of the `pi-ai` that the pinned agent itself imports.
 *
 * ⚠️ **PI'S OWN RULE, NOT A COPY.** Pi decides which thinking levels a model supports in
 * `getSupportedThinkingLevels`, and clamps anything else when it runs. The SDK's root does not export it,
 * so it is imported from the same `pi-ai` the agent resolves, rather than restated here where it could
 * drift from what Pi actually does.
 *
 * ⚠️ **RESOLVED THE WAY NODE WOULD FROM THE AGENT, AND CONTAINED.** The export is import-only, so
 * `require.resolve` refuses it. The candidate directories are Node's own lookup paths from the agent's
 * entry, in order; the first that holds `pi-ai` is the one the agent loads. Its version must equal the
 * agent's, and the entry must canonicalise inside that package and be a regular file.
 *
 * @param {string} toolRoot
 * @returns {{url: string, entry: string, version: string}}
 */
export function resolvePinnedCompat(toolRoot) {
  const sdk = resolvePinnedSdk(toolRoot);
  const refuse = (message, detail = {}) =>
    new SupervisorRefusal(REFUSAL.AGENT_NOT_INSTALLED, message, { package: PINNED_AI_NAME, ...detail });

  const paths = createRequire(sdk.entry).resolve.paths(PINNED_AI_NAME) ?? [];
  const pkgDir = paths.map((p) => join(p, ...PINNED_AI_NAME.split("/"))).find((d) => existsSync(join(d, "package.json")));
  if (!pkgDir) throw refuse(`${PINNED_AI_NAME}, which the pinned agent imports, is not installed.`);

  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
  if (manifest.name !== PINNED_AI_NAME || manifest.version !== sdk.version)
    throw refuse(
      `The installed ${PINNED_AI_NAME} is ${manifest.name}@${manifest.version}, not the version the pinned agent ` +
        `${sdk.version} ships with.`,
      { installed: `${manifest.name}@${manifest.version}` }
    );

  const compat = manifest.exports?.["./compat"];
  const declared = typeof compat === "string" ? compat : compat?.import;
  if (typeof declared !== "string" || declared.length === 0) throw refuse(`${PINNED_AI_NAME} declares no ./compat entry.`);
  const root = canonicalPath(pkgDir);
  const entry = canonicalPath(join(pkgDir, declared));
  if (!isAtOrInside(entry, root)) throw refuse(`${PINNED_AI_NAME}'s ./compat entry resolves outside its package.`, { entry });
  let stat = null;
  try {
    stat = statSync(entry);
  } catch {
    /* reported below */
  }
  if (!stat?.isFile()) throw refuse(`${PINNED_AI_NAME}'s ./compat entry ${declared} is not an installed file.`, { entry });

  return { url: pathToFileURL(entry).href, entry, version: manifest.version };
}

/**
 * Pi's own agent directory, asked of the pinned package rather than re-derived.
 *
 * ⚠️ **ASKED, BECAUSE RE-DERIVING IT IS A SECOND RULE THAT CAN DISAGREE.** Pi reads
 * `PI_CODING_AGENT_DIR` and expands a leading `~`, falling back to `<home>/.pi/agent`. A Kiln that
 * spelled those rules out again would eventually check one directory while the child used another —
 * and for trust that means approving a project in a store nobody reads.
 *
 * ⚠️ **IT ANSWERS FOR THIS PROCESS'S ENVIRONMENT, WHICH IS WHY THE CALLER MUST BE THE COMMAND.**
 * `getAgentDir()` takes no argument and reads `process.env` itself, so its answer is only the child's
 * answer if the child inherits this environment — which is why the launcher resolves it once and then
 * FORCES it into every child's `PI_CODING_AGENT_DIR`, rather than trusting the inherited spelling.
 *
 * @param {string} toolRoot
 * @returns {Promise<string>}
 */
export async function resolvePinnedAgentDir(toolRoot) {
  const { url, version } = resolvePinnedSdk(toolRoot);
  const sdk = await import(url);
  const refuse = (message) =>
    new SupervisorRefusal(REFUSAL.AGENT_NOT_INSTALLED, message, { package: PINNED_AGENT_NAME, version });

  if (typeof sdk.getAgentDir !== "function")
    throw refuse(
      `The pinned Pi package does not export \`getAgentDir\` from its root, so where Pi keeps its own ` +
        `state cannot be asked of it. Kiln will not guess at another tool's directory rules.`
    );

  const dir = sdk.getAgentDir();
  if (typeof dir !== "string" || dir.trim().length === 0)
    throw refuse(`The pinned Pi package's \`getAgentDir\` returned no directory, so there is nothing to pass on.`);
  return dir;
}

/**
 * Pi's OWN session lister, taken from the package root export (F121).
 *
 * ⚠️ **KILN MUST NOT READ SESSION IDENTITY OUT OF FILENAMES.** Pi stores sessions as
 * `<timestamp>_<uuid>.jsonl`, and the id that matters is the one inside the file's header, which is not
 * the uuid in the name. Measured against the pinned 0.84.4: a file named `…_11111111-…` reported
 * `id: 99999999-…`. A filename-derived id therefore never matches a recorded one, and every genuine
 * resume would be reported as a session that no longer exists.
 *
 * ⚠️ **THE ROOT EXPORT, NOT A DEEP IMPORT.** `SessionManager` is exported from the package's declared
 * ESM entry; reaching into `dist/core/…` would pin a path the package does not promise. Measured
 * behaviour of `list(cwd, sessionDir)`: it scans the given directory directly, takes each id from the
 * header, filters by `cwd` exactly, drops malformed and header-less files, and answered 200 sessions in
 * 30ms.
 */
export async function resolvePinnedSessionLister(toolRoot) {
  const { url, version } = resolvePinnedSdk(toolRoot);
  const sdk = await import(url);
  const refuse = (message) =>
    new SupervisorRefusal(REFUSAL.AGENT_NOT_INSTALLED, message, { package: PINNED_AGENT_NAME, version });

  if (typeof sdk.SessionManager?.list !== "function")
    throw refuse(
      `The pinned Pi package does not export \`SessionManager.list\` from its root, so which sessions ` +
        `exist cannot be asked of it. Kiln will not read session identity out of filenames: the id lives ` +
        `in each session's header and the filename's uuid is a different value.`
    );

  // ⚠️ **THE CURRENT TRANSCRIPT FORMAT COMES FROM THE SAME PACKAGE.** Pi migrates, and so rewrites, any
  // transcript older than it; Kiln refuses those before spawning, and needs Pi's own answer to know which.
  if (!Number.isInteger(sdk.CURRENT_SESSION_VERSION))
    throw refuse(
      `The pinned Pi package does not export \`CURRENT_SESSION_VERSION\` from its root, so Kiln cannot tell ` +
        `which transcripts Pi would rewrite while opening them.`
    );

  // ⚠️ NARROWED TO WHAT IS USED, so a caller cannot reach the rest of Pi's session API through this.
  return Object.assign(async (cwd, sessionDir) => sdk.SessionManager.list(cwd, sessionDir), {
    sessionVersion: sdk.CURRENT_SESSION_VERSION,
  });
}

/** The version this checkout pinned, read from its own manifest rather than restated here. */
export function readOwnPin(root) {
  const own = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  const name = PINNED_AGENT_NAME;
  return { name, version: own.dependencies?.[name] ?? null };
}
