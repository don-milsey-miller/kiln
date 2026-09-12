/**
 * What Kiln's Pi package declares, and whether it is true — TSK-0043, CMP-0031, against ACC-0063.
 *
 * `pi-package/` is the unit Pi loads for a trusted project. Three things are authored by hand and
 * must agree: the manifest naming the resources, the resources themselves, and a signature
 * declaration naming what a consumer should expect to find.
 *
 * ⚠️ **THE SIGNATURE IS NOT DERIVED FROM THE MANIFEST, AND THAT IS THE POINT.** Deriving it would
 * make the two agree by construction and prove nothing. They are written separately and compared
 * here, so an extension added without a declaration — or a declaration naming a skill that was
 * deleted — is a refusal rather than a signature nobody checked. The entry point states the
 * signature version a third time, for the same reason.
 *
 * ⚠️ **PATHS ARE CHECKED BEFORE THEY ARE FOLLOWED.** A manifest entry that is absolute, or that
 * climbs out of the package with `..`, would make the package's contents depend on where it was
 * installed and on what sits beside it. Those are refused rather than resolved.
 *
 * ⚠️ **THIS VALIDATES; IT DOES NOT REGISTER.** What the package registers is TSK-0044's and
 * TSK-0045's, and what any consumer does with the signature belongs to the criteria that own those
 * comparisons — the capability tool (ACC-0109), delegation refusal (ACC-0075), canary invalidation
 * (ACC-0062) and the launch gate (ACC-0051).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";

import { toolRoot } from "./content-root.mjs";

/** The package directory, at the tool root — where the committed entry `../.planning/pi-package` lands. */
export const PACKAGE_DIR = "pi-package";
export const packageRootFor = (root = toolRoot()) => join(root, PACKAGE_DIR);

/** Pi's own rule for what it will load as an extension: `.ts` or `.js`, nothing else. */
const EXTENSION_SUFFIXES = Object.freeze([".js", ".ts"]);

/** The resource kinds a manifest declares, and what each one names on disk. */
const KINDS = Object.freeze({ extensions: "file", skills: "directory", prompts: "directory" });

export const PACKAGE_REFUSAL = Object.freeze({
  MANIFEST_UNREADABLE: "package-manifest-unreadable",
  MANIFEST_INVALID: "package-manifest-invalid",
  PATH_UNSAFE: "package-path-unsafe",
  PATH_DUPLICATE: "package-path-duplicate",
  RESOURCE_MISSING: "package-resource-missing",
  SIGNATURE_UNREADABLE: "package-signature-unreadable",
  SIGNATURE_INVALID: "package-signature-invalid",
  SIGNATURE_MISMATCH: "package-signature-mismatch",
  SIGNATURE_VERSION_MISMATCH: "package-signature-version-mismatch",
  ENTRY_POINT_INVALID: "package-entry-point-invalid",
  TOOL_UNDECLARED: "package-tool-undeclared",
  TOOL_NOT_REGISTERED: "package-tool-not-registered",
  TOOL_DUPLICATE: "package-tool-duplicate",
});

export class PackageRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "PackageRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isName = (v) => typeof v === "string" && v.length > 0 && !/[\\/]/.test(v) && v.trim() === v;

/** Deeply frozen, so what a consumer is handed cannot be edited and passed on as the declaration. */
export const deepFreeze = (value) => {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
  if (isPlainObject(value))
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepFreeze(v)])));
  return value;
};

const readJson = (path, unreadable, invalid, what) => {
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    throw new PackageRefusal(unreadable, `The package's ${what} could not be read (${e?.code ?? "unknown error"}).`, {
      file: `${PACKAGE_DIR}/${basename(path)}`,
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    // ⚠️ The parser's message quotes the file; a manifest is authored content and is not repeated here.
    throw new PackageRefusal(invalid, `The package's ${what} is not valid JSON.`, {
      file: `${PACKAGE_DIR}/${basename(path)}`,
    });
  }
};

/**
 * A declared path that means the same thing wherever the package is installed.
 *
 * ⚠️ Relative, forward-slashed, and inside the package. An absolute path, a backslash or a `..`
 * segment makes the package's contents depend on the machine it landed on.
 */
function assertSafeRelative(declared, kind) {
  const unsafe = (why) =>
    new PackageRefusal(
      PACKAGE_REFUSAL.PATH_UNSAFE,
      `A ${kind} path in the package manifest ${why}, so what it names would depend on where the package ` +
        `was installed. The manifest is left as it is.`,
      { kind, why }
    );

  if (typeof declared !== "string" || declared.length === 0) throw unsafe("is not a path");
  if (/^([A-Za-z]:)?[\\/]/.test(declared)) throw unsafe("is absolute");
  if (declared.includes("\\")) throw unsafe("uses backslashes, which are not portable");
  if (posix.normalize(declared).startsWith("..") || declared.split("/").includes(".."))
    throw unsafe("climbs out of the package");
  return declared;
}

/** The manifest, with its declared paths checked and de-duplicated. */
export function readManifest(packageRoot = packageRootFor()) {
  const manifest = readJson(
    join(packageRoot, "package.json"),
    PACKAGE_REFUSAL.MANIFEST_UNREADABLE,
    PACKAGE_REFUSAL.MANIFEST_INVALID,
    "manifest"
  );

  if (!isPlainObject(manifest) || !isPlainObject(manifest.pi))
    throw new PackageRefusal(
      PACKAGE_REFUSAL.MANIFEST_INVALID,
      `The package manifest declares no \`pi\` section, so it names no extensions, skills or prompts.`,
      { field: "pi" }
    );

  const declared = {};
  const seen = new Map();
  for (const kind of Object.keys(KINDS)) {
    const paths = manifest.pi[kind];
    if (!Array.isArray(paths) || paths.length === 0)
      throw new PackageRefusal(
        PACKAGE_REFUSAL.MANIFEST_INVALID,
        `The package manifest's \`pi.${kind}\` is not a non-empty list of paths.`,
        { field: `pi.${kind}` }
      );
    for (const path of paths) {
      assertSafeRelative(path, kind);
      const already = seen.get(posix.normalize(path));
      if (already)
        throw new PackageRefusal(
          PACKAGE_REFUSAL.PATH_DUPLICATE,
          `The package manifest declares the same path under \`pi.${already}\` and \`pi.${kind}\`, so what is ` +
            `loaded would depend on which declaration Pi read first.`,
          { kind, alreadyAs: already }
        );
      seen.set(posix.normalize(path), kind);
    }
    declared[kind] = [...paths];
  }
  return { manifest, declared };
}

/** The authored declaration, frozen and checked for shape — never built from the manifest. */
export function readSignature(packageRoot = packageRootFor()) {
  const signature = readJson(
    join(packageRoot, "signature.json"),
    PACKAGE_REFUSAL.SIGNATURE_UNREADABLE,
    PACKAGE_REFUSAL.SIGNATURE_INVALID,
    "signature declaration"
  );

  const invalid = (why, detail = {}) =>
    new PackageRefusal(PACKAGE_REFUSAL.SIGNATURE_INVALID, `The package's signature declaration ${why}.`, detail);

  if (!isPlainObject(signature)) throw invalid("is not a JSON object");
  if (!Number.isInteger(signature.signatureVersion) || signature.signatureVersion < 1)
    throw invalid("has no whole-number signature version", { field: "signatureVersion" });

  for (const kind of ["extensions", "skills", "prompts", "tools"]) {
    const names = signature[kind];
    if (!Array.isArray(names) || !names.every(isName))
      throw invalid(`does not list \`${kind}\` as plain names`, { field: kind });
    if (new Set(names).size !== names.length) throw invalid(`names the same \`${kind}\` entry twice`, { field: kind });
  }

  // ⚠️ JSON-SAFE, ASKED OF JSON RATHER THAN ASSUMED: a consumer receives this over a tool boundary.
  if (JSON.stringify(JSON.parse(JSON.stringify(signature))) !== JSON.stringify(signature))
    throw invalid("does not survive a JSON round trip unchanged");

  return deepFreeze(signature);
}

/** What is actually on disk under the declared paths. */
function discover(packageRoot, declared) {
  const found = { extensions: [], skills: [], prompts: [] };
  const missing = (kind, path, why) =>
    new PackageRefusal(
      PACKAGE_REFUSAL.RESOURCE_MISSING,
      `The package manifest declares a ${kind} path that ${why}, so it names a resource the package does not have.`,
      { kind, path, why }
    );

  for (const path of declared.extensions) {
    const abs = join(packageRoot, path);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw missing("extensions", path, "is not a file in the package");
    if (!EXTENSION_SUFFIXES.includes(extname(abs)))
      throw missing("extensions", path, `is not one of the suffixes Pi loads (${EXTENSION_SUFFIXES.join(", ")})`);
    found.extensions.push(basename(abs, extname(abs)));
  }

  for (const path of declared.skills) {
    const abs = join(packageRoot, path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw missing("skills", path, "is not a directory");
    for (const entry of readdirSync(abs, { withFileTypes: true }))
      if (entry.isDirectory() && existsSync(join(abs, entry.name, "SKILL.md"))) found.skills.push(entry.name);
  }

  for (const path of declared.prompts) {
    const abs = join(packageRoot, path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw missing("prompts", path, "is not a directory");
    for (const entry of readdirSync(abs, { withFileTypes: true }))
      if (entry.isFile() && entry.name.endsWith(".md")) found.prompts.push(basename(entry.name, ".md"));
  }

  return found;
}

/**
 * What the entry point registers, observed by running it against a stub that records instead of a
 * session that would run it.
 *
 * ⚠️ **THE DECLARED `tools` LIST IS THE ONE PART OF THE SIGNATURE NOTHING ELSE CAN CHECK.** Extensions,
 * skills and prompts are files: they are either in the package or they are not. A tool exists only
 * once registration runs, so a declaration could name tools nobody registers — or registration could
 * add tools nobody declared — with every other check still passing. This is what closes that.
 *
 * ⚠️ **THE REAL REGISTRATION FUNCTION, NOT A READING OF THE SOURCE.** Grepping the entry point for
 * `registerTool` would agree with a file that registers conditionally, or in a loop, or not at all.
 */
function recordRegistrations(register) {
  const names = [];
  // Only what a Kiln registration uses. An entry point reaching for more of Pi's API than this would
  // fail loudly here rather than registering something the check never saw.
  const stub = {
    registerTool: (tool) => {
      names.push(tool?.name);
    },
  };
  register(stub);
  return names;
}

/**
 * Validate the package: the manifest's paths, the resources behind them, the declaration, the entry
 * point — including the version it states for itself — and what it actually registers.
 *
 * @returns {Promise<{manifest: object, signature: object, resources: object, tools: string[], register: Function}>}
 */
/**
 * The tool names this package is entitled to, taken from a declaration that has just been checked
 * against what registration actually produces.
 *
 * ⚠️ **NOTHING HERE RETYPES A NAME.** A second handwritten list would be a second answer to "what does
 * Kiln offer", and the two would disagree the first time one of them was edited alone. The launch
 * allowlist is the validated set or it is nothing: if the declaration and the registration disagree,
 * this refuses rather than handing a launcher a list that describes neither.
 */
export async function declaredToolNames({ packageRoot = packageRootFor() } = {}) {
  const { tools } = await validatePackage({ packageRoot });
  return tools;
}

export async function validatePackage({ packageRoot = packageRootFor() } = {}) {
  const { manifest, declared } = readManifest(packageRoot);
  const signature = readSignature(packageRoot);
  const resources = discover(packageRoot, declared);

  for (const kind of ["extensions", "skills", "prompts"]) {
    const declaredNames = [...signature[kind]].sort();
    const foundNames = [...resources[kind]].sort();
    const missing = declaredNames.filter((n) => !foundNames.includes(n));
    const extra = foundNames.filter((n) => !declaredNames.includes(n));
    if (missing.length > 0 || extra.length > 0)
      throw new PackageRefusal(
        PACKAGE_REFUSAL.SIGNATURE_MISMATCH,
        `The signature declaration and the package disagree about which ${kind} exist, so the declaration ` +
          `describes something other than what would load.`,
        { kind, declaredNotFound: missing, foundNotDeclared: extra }
      );
  }

  // ⚠️ IMPORTED, WHICH IS ALSO THE CHECK THAT IT LOADS AT ALL.
  const entryPath = join(packageRoot, declared.extensions[0]);
  const entry = await import(pathToFileURL(entryPath).href);
  if (typeof entry.default !== "function")
    throw new PackageRefusal(
      PACKAGE_REFUSAL.ENTRY_POINT_INVALID,
      `The package's entry point exports no default registration function, so Pi would load a module that ` +
        `registers nothing.`,
      { entry: declared.extensions[0] }
    );

  if (entry.SIGNATURE_VERSION !== signature.signatureVersion)
    throw new PackageRefusal(
      PACKAGE_REFUSAL.SIGNATURE_VERSION_MISMATCH,
      `The entry point states a different signature version from the declaration, so one of the two was ` +
        `changed without the other. Neither is trusted until they agree.`,
      { entryPoint: entry.SIGNATURE_VERSION ?? null, declaration: signature.signatureVersion }
    );

  // ⚠️ RUN, THEN COMPARED. What registration produces is the only honest reading of `tools`.
  const registered = recordRegistrations(entry.default);

  const duplicates = registered.filter((name, i) => registered.indexOf(name) !== i);
  if (duplicates.length > 0)
    throw new PackageRefusal(
      PACKAGE_REFUSAL.TOOL_DUPLICATE,
      `The package registers the same tool name more than once, so which registration a session would end ` +
        `up holding depends on the order they ran in.`,
      { duplicated: [...new Set(duplicates)].sort() }
    );

  const declaredTools = [...signature.tools].sort();
  const registeredTools = [...registered].sort();
  const undeclared = registeredTools.filter((n) => !declaredTools.includes(n));
  if (undeclared.length > 0)
    throw new PackageRefusal(
      PACKAGE_REFUSAL.TOOL_UNDECLARED,
      `The package registers a tool its signature does not declare, so a consumer comparing the declaration ` +
        `against what loaded would find a capability nobody announced.`,
      { registeredNotDeclared: undeclared }
    );

  const unregistered = declaredTools.filter((n) => !registeredTools.includes(n));
  if (unregistered.length > 0)
    throw new PackageRefusal(
      PACKAGE_REFUSAL.TOOL_NOT_REGISTERED,
      `The package's signature declares a tool that registration does not produce, so the declaration ` +
        `promises a capability a session would not have.`,
      { declaredNotRegistered: unregistered }
    );

  return { manifest, signature, resources, tools: registeredTools, register: entry.default };
}
