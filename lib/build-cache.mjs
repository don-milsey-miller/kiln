/**
 * Whether the production build already on disk may be served again - #184.
 *
 * Every start used to run `next build`. On an unchanged checkout that is a few seconds of work that produces the
 * same application under a new build id. This decides, before the compiler is run, whether the build in `.next`
 * is the one this start would produce, and says why whichever way it goes.
 *
 * ⚠️ **A BUILD IS REUSED ONLY WHEN THREE THINGS HOLD, AND EVERY OTHER CASE REBUILDS.**
 *
 *  1. A marker says which inputs the build on disk was made from, and they are the inputs present now.
 *  2. The files Next itself lists as required are all there, inside `.next`, as files.
 *  3. Nothing about this start is of a kind the marker cannot describe.
 *
 * `.next` existing proves nothing, and nor does `BUILD_ID`: an interrupted build leaves both.
 *
 * ⚠️ **THE KEY IS BUILT FROM CONTENT AND VERSIONS, NEVER FROM TIMES AND NEVER FROM THE ENVIRONMENT.** A file's bytes
 * say what it is; its modification time says when something touched it. And no environment value is hashed or
 * written down: a variable can be misnamed and still hold a credential. The one thing recorded about the
 * environment is the build mode, which the launcher fixes. A start whose environment could change the output in
 * a way this cannot see - an `.env` file in the tool root, or `NODE_OPTIONS` - is rebuilt, and is told so with a
 * reason that names no variable, value or path.
 *
 * ⚠️ **INSTALLING DEPENDENCIES AND REUSING A BUILD ARE SEPARATE DECISIONS.** `lib/dependency-freshness.mjs` decides
 * the first and is not consulted here. This reads npm's own record of the installed tree as one input among
 * several, so a build made against a different tree is not reused.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { atomicWrite } from "./atomic-write.mjs";
import { canonicalPath, isAtOrInside, pathIdentityKey } from "./content-root.mjs";

export const BUILD_DIR = ".next";
export const BUILD_MARKER = "kiln-build.json";
/** The version of this contract. A marker written under another one says nothing this code can rely on. */
export const BUILD_MARKER_VERSION = 1;
/** The only build mode the launcher uses, and the only thing recorded about the environment. */
export const BUILD_MODE = "production";
/** The version of `required-server-files.json` whose shape is understood here. */
const REQUIRED_FILES_VERSION = 1;

/** What a build is made from, always: directories walked whole, and single files. */
const INPUT_DIRECTORIES = ["app", "lib", "schemas", "stages"];
const INPUT_FILES = ["package.json", "package-lock.json"];
/**
 * Inputs Next would pick up if they existed. Each is recorded as present or absent, and read when present, so that
 * adding one - a `middleware.js`, a `public/` directory, a second config file - cannot leave an old build in use.
 */
const OPTIONAL_DIRECTORIES = ["pages", "src", "public"];
const OPTIONAL_FILES = [
  ...["js", "mjs", "cjs", "ts", "mts", "cts"].map((ext) => `next.config.${ext}`),
  ...["js", "mjs", "cjs", "ts", "mts"].flatMap((ext) => [`middleware.${ext}`, `instrumentation.${ext}`, `instrumentation-client.${ext}`, `proxy.${ext}`]),
  "jsconfig.json",
  "tsconfig.json",
];

/** Why a build was reused or not. Codes, in fixed words: none of them carries the value that differed. */
export const BUILD_REASON = Object.freeze({
  REUSED: "build-reused",
  FORCED: "rebuild-requested",
  ENV_FILE: "env-file-present",
  NODE_OPTIONS: "node-options-set",
  PUBLIC_ENV: "public-env-referenced",
  NO_MARKER: "no-build-marker",
  MARKER_INVALID: "build-marker-invalid",
  MARKER_VERSION: "build-marker-version",
  MARKER_NOT_WRITTEN: "build-marker-not-written",
  SOURCE: "source-changed",
  OPTIONAL_INPUTS: "optional-inputs-changed",
  INSTALLED_TREE: "installed-tree-changed",
  NEXT_VERSION: "next-version-changed",
  NODE_VERSION: "node-version-changed",
  PLATFORM: "platform-changed",
  ARCH: "arch-changed",
  CHECKOUT: "checkout-moved",
  BUILD_MODE: "build-mode-changed",
  KEY: "build-key-mismatch",
  NO_MANIFEST: "required-files-manifest-missing",
  MANIFEST_INVALID: "required-files-manifest-invalid",
  APP_DIR: "build-made-elsewhere",
  FILE_OUTSIDE: "required-file-outside-build",
  FILE_MISSING: "required-file-missing",
  BUILD_ID_EMPTY: "build-id-empty",
  BUILD_ID_MISMATCH: "build-id-mismatch",
});

/** The key's fields in the order they are compared, each with the code that says it differed. */
const FIELD_REASONS = Object.freeze([
  ["buildMode", BUILD_REASON.BUILD_MODE],
  ["checkout", BUILD_REASON.CHECKOUT],
  ["platform", BUILD_REASON.PLATFORM],
  ["arch", BUILD_REASON.ARCH],
  ["nodeVersion", BUILD_REASON.NODE_VERSION],
  ["nextVersion", BUILD_REASON.NEXT_VERSION],
  ["installedTree", BUILD_REASON.INSTALLED_TREE],
  ["optionalInputs", BUILD_REASON.OPTIONAL_INPUTS],
  ["source", BUILD_REASON.SOURCE],
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
/** A directory as Kiln compares directories: canonical, and case-folded where the platform's paths are. */
const identityOf = (path) => pathIdentityKey(canonicalPath(resolve(path)));
// Assembled, so that this file - which is itself a build input - does not contain what it looks for.
const PUBLIC_ENV_PREFIX = ["NEXT", "PUBLIC", ""].join("_");

function filesUnder(root, relative) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  walk(relative);
  return out;
}

/**
 * What the build is made from, read from the working tree as it is now.
 *
 * ⚠️ **THE BYTES ON DISK, SO AN UNCOMMITTED CHANGE COUNTS.** Git is not asked: a checkout with edits nobody has
 * committed builds those edits, and a tool directory with no repository in it builds all the same.
 *
 * @returns {{source: string, optionalInputs: string, referencesPublicEnv: boolean}}
 *   `source` and `optionalInputs` are digests. `optionalInputs` is over which optional inputs exist, by name.
 */
export function readBuildInputs(root) {
  const present = [...OPTIONAL_DIRECTORIES, ...OPTIONAL_FILES].filter((name) => existsSync(join(root, name)));
  const files = [
    ...[...INPUT_DIRECTORIES, ...OPTIONAL_DIRECTORIES].filter((dir) => existsSync(join(root, dir)) && statSync(join(root, dir)).isDirectory()).flatMap((dir) => filesUnder(root, dir)),
    ...[...INPUT_FILES, ...OPTIONAL_FILES].filter((file) => existsSync(join(root, file)) && statSync(join(root, file)).isFile()),
  ].sort();

  const hash = createHash("sha256");
  let referencesPublicEnv = false;
  for (const file of files) {
    const bytes = readFileSync(join(root, file));
    hash.update(`${file}\0${bytes.length}\0`);
    hash.update(bytes);
    // ⚠️ THE GUARD ON THE ONE KIND OF ENVIRONMENT VALUE NEXT WRITES INTO A BUILD. Nothing here records such a
    // value, so a build input that asks for one is a build this contract cannot describe.
    if (!referencesPublicEnv && bytes.includes(PUBLIC_ENV_PREFIX)) referencesPublicEnv = true;
  }
  return { source: hash.digest("hex"), optionalInputs: sha256(present.join("\n")), referencesPublicEnv };
}

/** What about this start the marker has no way to describe, as a reason, or `null`. Names nothing it found. */
export function reuseBlockedBy(root, env) {
  if (typeof env?.NODE_OPTIONS === "string" && env.NODE_OPTIONS.trim().length > 0) return BUILD_REASON.NODE_OPTIONS;
  try {
    if (readdirSync(root).some((name) => name === ".env" || name.startsWith(".env."))) return BUILD_REASON.ENV_FILE;
  } catch {
    return BUILD_REASON.ENV_FILE; // a root that cannot be listed cannot be shown to hold none
  }
  return null;
}

/** The versions and the machine, as the running process reports them. A test supplies its own. */
export function currentSystem(root) {
  const read = (path) => {
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  };
  const next = read(join(root, "node_modules", "next", "package.json"));
  const installed = read(join(root, "node_modules", ".package-lock.json"));
  let nextVersion = "unknown";
  try {
    nextVersion = String(JSON.parse(next).version);
  } catch {
    nextVersion = "unknown";
  }
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    nextVersion,
    // npm's own record of the tree it laid down. Absent, the tree is nobody's to vouch for.
    installedTree: installed === null ? "absent" : sha256(installed),
  };
}

/**
 * The key for the build this start would make, with the fields it is made of.
 *
 * @returns {{key: string, fields: object, referencesPublicEnv: boolean}}
 */
export function buildKey(root, { system = currentSystem(root), inputs = readBuildInputs(root) } = {}) {
  const fields = {
    buildMode: BUILD_MODE,
    // A digest of where the checkout is, since the build embeds that path and the marker has no need to.
    checkout: sha256(identityOf(root)),
    platform: system.platform,
    arch: system.arch,
    nodeVersion: system.nodeVersion,
    nextVersion: system.nextVersion,
    installedTree: system.installedTree,
    optionalInputs: inputs.optionalInputs,
    source: inputs.source,
  };
  return { key: sha256(JSON.stringify([BUILD_MARKER_VERSION, ...FIELD_REASONS.map(([name]) => fields[name])])), fields, referencesPublicEnv: inputs.referencesPublicEnv };
}

/**
 * Whether the build output on disk is whole, by Next's own list of what it requires.
 *
 * ⚠️ **EVERY LISTED FILE MUST BE A FILE INSIDE THIS CHECKOUT'S `.next`, FOLLOWED TO WHERE IT REALLY IS.** The list is
 * read from the build directory, so it is not trusted to stay inside it: a path that climbs out, an absolute
 * path, and a link that leads elsewhere are each refused. A build made in another directory is refused too,
 * since its manifest names that directory.
 *
 * @returns {{ok: true, buildId: string} | {ok: false, reason: string}}
 */
export function validateBuildOutput(root) {
  const buildDir = join(root, BUILD_DIR);
  const manifestPath = join(buildDir, "required-server-files.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    return { ok: false, reason: e?.code === "ENOENT" || e?.code === "ENOTDIR" ? BUILD_REASON.NO_MANIFEST : BUILD_REASON.MANIFEST_INVALID };
  }
  if (manifest === null || typeof manifest !== "object" || manifest.version !== REQUIRED_FILES_VERSION || typeof manifest.appDir !== "string" || !Array.isArray(manifest.files) || manifest.files.length === 0)
    return { ok: false, reason: BUILD_REASON.MANIFEST_INVALID };
  if (identityOf(manifest.appDir) !== identityOf(root)) return { ok: false, reason: BUILD_REASON.APP_DIR };

  let realBuildDir;
  try {
    realBuildDir = realpathSync(buildDir);
  } catch {
    return { ok: false, reason: BUILD_REASON.NO_MANIFEST };
  }
  for (const listed of manifest.files) {
    if (typeof listed !== "string" || listed.length === 0 || isAbsolute(listed)) return { ok: false, reason: BUILD_REASON.FILE_OUTSIDE };
    const path = resolve(root, listed.split("\\").join("/"));
    // As written: nothing that climbs out of the build directory by its own spelling.
    if (!isAtOrInside(pathIdentityKey(path), pathIdentityKey(resolve(buildDir))) || pathIdentityKey(path) === pathIdentityKey(resolve(buildDir))) return { ok: false, reason: BUILD_REASON.FILE_OUTSIDE };
    let real;
    try {
      real = realpathSync(path);
    } catch {
      return { ok: false, reason: BUILD_REASON.FILE_MISSING };
    }
    // And as it really is: a link or a junction on the way does not lead somewhere else.
    if (!isAtOrInside(pathIdentityKey(real), pathIdentityKey(realBuildDir))) return { ok: false, reason: BUILD_REASON.FILE_OUTSIDE };
    if (!lstatSync(real).isFile()) return { ok: false, reason: BUILD_REASON.FILE_MISSING };
  }

  let buildId;
  try {
    buildId = readFileSync(join(buildDir, "BUILD_ID"), "utf-8").trim();
  } catch {
    return { ok: false, reason: BUILD_REASON.FILE_MISSING };
  }
  if (buildId.length === 0) return { ok: false, reason: BUILD_REASON.BUILD_ID_EMPTY };
  return { ok: true, buildId };
}

const markerPath = (root) => join(root, BUILD_DIR, BUILD_MARKER);

function readMarker(root) {
  let text;
  try {
    text = readFileSync(markerPath(root), "utf-8");
  } catch (e) {
    return { state: e?.code === "ENOENT" || e?.code === "ENOTDIR" ? "absent" : "invalid" };
  }
  let marker;
  try {
    marker = JSON.parse(text);
  } catch {
    return { state: "invalid" };
  }
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)) return { state: "invalid" };
  if (marker.markerVersion !== BUILD_MARKER_VERSION) return { state: Number.isInteger(marker.markerVersion) ? "version" : "invalid" };
  const fields = marker.fields;
  if (typeof marker.key !== "string" || typeof marker.buildId !== "string" || marker.buildId.length === 0 || fields === null || typeof fields !== "object" || FIELD_REASONS.some(([name]) => typeof fields[name] !== "string"))
    return { state: "invalid" };
  return { state: "valid", marker };
}

/**
 * Reuse the build on disk, or build.
 *
 * @param {{root: string, env?: object, forced?: boolean, system?: object, inputs?: object}} args
 *   `system` and `inputs` are what `currentSystem` and `readBuildInputs` return; a test supplies its own.
 * @returns {{action: "reuse"|"build", reason: string, key: string, fields: object, unrecordable: string|null}}
 *   `unrecordable` is why the build this start makes must not be recorded, or `null`. It is set even when the build
 *   was forced: a build made with an `.env` file present is not one a later start without it may reuse.
 */
export function decideBuild({ root, env = process.env, forced = false, system, inputs }) {
  const current = buildKey(root, { system, inputs });
  const blocked = reuseBlockedBy(root, env) ?? (current.referencesPublicEnv ? BUILD_REASON.PUBLIC_ENV : null);
  const build = (reason) => ({ action: "build", reason, key: current.key, fields: current.fields, unrecordable: blocked });

  if (forced) return build(BUILD_REASON.FORCED);
  if (blocked) return build(blocked);

  const read = readMarker(root);
  if (read.state === "absent") return build(BUILD_REASON.NO_MARKER);
  if (read.state === "version") return build(BUILD_REASON.MARKER_VERSION);
  if (read.state !== "valid") return build(BUILD_REASON.MARKER_INVALID);

  // ⚠️ FIELD BY FIELD, SO THE REASON SAYS WHICH KIND OF THING CHANGED, and says nothing of what it changed from or to.
  for (const [name, reason] of FIELD_REASONS) if (read.marker.fields[name] !== current.fields[name]) return build(reason);
  if (read.marker.key !== current.key) return build(BUILD_REASON.KEY);

  const output = validateBuildOutput(root);
  if (!output.ok) return build(output.reason);
  if (output.buildId !== read.marker.buildId) return build(BUILD_REASON.BUILD_ID_MISMATCH);
  return { action: "reuse", reason: BUILD_REASON.REUSED, key: current.key, fields: current.fields, unrecordable: null };
}

/**
 * Take the marker away, before the compiler is run.
 *
 * ⚠️ **FIRST, SO A BUILD THAT FAILS OR IS INTERRUPTED LEAVES NOTHING THAT VOUCHES FOR IT.** Throws when a marker is
 * there and cannot be removed: going on would leave it standing over whatever the compiler does next.
 */
export function invalidateBuildMarker(root) {
  try {
    unlinkSync(markerPath(root));
  } catch (e) {
    if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
  }
}

/**
 * Record a build that has just completed, after checking what it left.
 *
 * ⚠️ **ONLY A BUILD WHOSE OUTPUT VALIDATES IS RECORDED, AND THE RECORD IS WRITTEN WHOLE OR NOT AT ALL.**
 *
 * ⚠️ **A BUILD MADE WHILE REUSE WAS DISABLED IS NEVER RECORDED.** The marker cannot say what the environment did to
 * it, so taking the `.env` file away afterwards must not leave a build that looks reusable.
 *
 * @param {{root: string, decision: {key: string, fields: object, unrecordable?: string|null}}} args the decision this build was made under
 * @returns {Promise<{recorded: true, buildId: string} | {recorded: false, reason: string}>}
 */
export async function recordBuild({ root, decision }) {
  if (decision.unrecordable) return { recorded: false, reason: decision.unrecordable };
  const output = validateBuildOutput(root);
  if (!output.ok) return { recorded: false, reason: output.reason };
  const marker = { markerVersion: BUILD_MARKER_VERSION, key: decision.key, buildId: output.buildId, fields: Object.fromEntries(FIELD_REASONS.map(([name]) => [name, decision.fields[name]])) };
  await atomicWrite(markerPath(root), JSON.stringify(marker, null, 2) + "\n");
  return { recorded: true, buildId: output.buildId };
}
