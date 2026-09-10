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

/** The version this checkout pinned, read from its own manifest rather than restated here. */
export function readOwnPin(root) {
  const own = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  const name = PINNED_AGENT_NAME;
  return { name, version: own.dependencies?.[name] ?? null };
}
