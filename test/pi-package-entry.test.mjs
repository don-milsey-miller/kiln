/**
 * The portable spelling of Kiln's package entry — TSK-0030, against ACC-0105.
 *
 * ⚠️ **THE PROOF IS MADE AGAINST REAL DIRECTORIES.** Every case builds an actual package directory and an
 * actual settings file, because the claim is about what the filesystem says two spellings resolve to, not
 * about string handling. Where a failure cannot be built — a directory that cannot be read — `statSync` is
 * replaced for exactly that one path.
 *
 * ⚠️ **A REFUSAL LEAVES THE FILE AND THE DIRECTORY EXACTLY AS THEY WERE.** Each refusal checks the settings
 * bytes and that no lock or temporary file appeared, since a proof that fails must cost nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { runTransaction } from "../lib/setup-transaction.mjs";
import { STATE_MODE } from "../lib/local-state.mjs";
import { SKILL_OVERRIDE_PATH, settingsTarget } from "../lib/pi-settings.mjs";
import {
  PACKAGE_ENTRY_REFUSAL,
  PORTABLE_PACKAGE_ENTRY,
  PackageEntryRefusal,
  applyPortablePackageEntry,
  provePortablePackageEntry,
} from "../lib/pi-package-entry.mjs";

installReaper();

const WINDOWS = process.platform === "win32";

/** The rest of the desired state. The package entry is the function's to decide, so it is not here. */
const DESIRED = Object.freeze({
  stateMode: STATE_MODE.PROJECT,
  provider: "anthropic",
  model: "claude-fable-5",
  thinkingLevel: "medium",
});

/** A project with `.pi/`, `.planning/pi-package/` and a second package directory to be wrong about. */
const project = ({ pkg = true } = {}) => {
  const dir = reapLater(mkdtempSync(join(tmpdir(), "kiln-pkg-entry-")));
  mkdirSync(join(dir, ".pi"));
  mkdirSync(join(dir, ".planning"));
  if (pkg) mkdirSync(join(dir, ".planning", "pi-package"));
  mkdirSync(join(dir, ".planning", "other-package"));
  writeFileSync(join(dir, ".planning", "not-a-directory"), "{}");
  return dir;
};

const settingsDirOf = (dir) => join(dir, ".pi");
const settingsFile = (dir) => join(dir, ".pi", "settings.json");
const writeSettings = (dir, text) => writeFileSync(settingsFile(dir), text);
const readText = (dir) => readFileSync(settingsFile(dir), "utf-8");
const json = (o) => JSON.stringify(o, null, 2);
const artifacts = (dir) => readdirSync(join(dir, ".pi")).filter((n) => n.endsWith(".lock") || n.includes(".vpw-tmp"));

const apply = (dir, literalEntry, desired = DESIRED, options = {}) =>
  runTransaction({ projectRoot: dir, files: [settingsTarget()] }, (tx) =>
    applyPortablePackageEntry({ transaction: tx, literalEntry, desired, ...options })
  );

const prove = (dir, literalEntry) => provePortablePackageEntry({ settingsDir: settingsDirOf(dir), literalEntry });

async function refusal(promise, check) {
  try {
    await promise;
  } catch (e) {
    check(e);
    return e;
  }
  assert.fail("expected a refusal, and the operation succeeded");
}

const refusedWith = (reason, label) => (e) =>
  assert.ok(e instanceof PackageEntryRefusal && e.reason === reason, `${label}: got ${e?.reason ?? e}`);

/* ============================================ the proof ========================================= */

test("⚠️ ACC-0105 spellings that resolve to the package directory are proved equivalent, on this platform", () => {
  const dir = project();
  const absolute = join(dir, ".planning", "pi-package");

  const spellings = [
    ["the portable spelling itself", PORTABLE_PACKAGE_ENTRY],
    ["an absolute path, as `pi install -l` may write", absolute],
    ["a redundant but equivalent relative path", "./../.planning/./pi-package"],
  ];
  // ⚠️ Windows accepts both separators, so the backslash spelling is one of its own. On POSIX a backslash is
  // an ordinary character in a name, so that spelling is a different path and is refused below.
  if (WINDOWS) spellings.push(["the Windows spelling", `..${sep}.planning${sep}pi-package`]);

  for (const [label, literal] of spellings) {
    const proved = prove(dir, literal);
    assert.deepEqual(proved, { packageEntry: PORTABLE_PACKAGE_ENTRY, packageEntryEquivalents: [literal] }, label);
  }

  if (!WINDOWS) {
    const backslashed = "..\\.planning\\pi-package";
    const e = refusalOf(() => prove(dir, backslashed));
    assert.equal(e.reason, PACKAGE_ENTRY_REFUSAL.MISSING, "a Windows spelling names nothing on POSIX");
    assert.equal(e.detail.side, "literal");
  }
});

/** The synchronous counterpart of `refusal`, for the pure proof. */
function refusalOf(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a refusal, and the call returned");
}

test("⚠️ ACC-0105 an entry that reaches the package directory through a link is proved equivalent", async (t) => {
  const dir = project();
  const linkEntry = "../.planning/link-to-package";
  // A junction on Windows, a directory symlink on POSIX: both are what a package directory is reached through.
  const kind = WINDOWS ? "junction" : "dir";
  try {
    symlinkSync(join(dir, ".planning", "pi-package"), join(dir, ".planning", "link-to-package"), kind);
  } catch (e) {
    // ⚠️ REPORTED, NOT PASSED OVER IN SILENCE. On a runner that will not create one, this claim is untested
    // here and the skip says so, rather than the suite implying the link case was covered.
    t.diagnostic(`a ${kind} could not be created on ${process.platform}: ${e.code ?? e.message}. This claim is untested on this runner.`);
    t.skip(`a ${kind} could not be created: ${e.code ?? e.message}`);
    return;
  }

  assert.deepEqual(prove(dir, linkEntry), { packageEntry: PORTABLE_PACKAGE_ENTRY, packageEntryEquivalents: [linkEntry] });

  writeSettings(dir, json({ theme: "dark", packages: [linkEntry, "npm:x"] }));
  assert.equal((await apply(dir, linkEntry)).changed, true);
  assert.deepEqual(
    JSON.parse(readText(dir)).packages,
    [PORTABLE_PACKAGE_ENTRY, "npm:x"],
    "the entry reached through the link became the portable spelling, in place and once"
  );
  assert.deepEqual(artifacts(dir), []);
});

test("⚠️ ACC-0105 an entry that resolves elsewhere, nowhere, or not to a directory is refused, naming the side", () => {
  const dir = project();
  const cases = [
    ["another package directory", "../.planning/other-package", PACKAGE_ENTRY_REFUSAL.NOT_EQUIVALENT, "literal"],
    ["a directory that is not there", "../.planning/absent", PACKAGE_ENTRY_REFUSAL.MISSING, "literal"],
    ["a path below a file", "../.planning/not-a-directory/pi-package", PACKAGE_ENTRY_REFUSAL.MISSING, "literal"],
    ["a file, not a directory", "../.planning/not-a-directory", PACKAGE_ENTRY_REFUSAL.NOT_A_DIRECTORY, "literal"],
    ["an empty entry", "   ", PACKAGE_ENTRY_REFUSAL.INVALID_LITERAL, "literal"],
    ["no entry at all", null, PACKAGE_ENTRY_REFUSAL.INVALID_LITERAL, "literal"],
  ];
  for (const [label, literal, reason, side] of cases) {
    const e = refusalOf(() => prove(dir, literal));
    assert.ok(e instanceof PackageEntryRefusal, `${label}: ${e}`);
    assert.equal(e.reason, reason, label);
    assert.equal(e.detail.side, side, label);
    // ⚠️ The literal may be an absolute home path, and the refusal is printed.
    assert.ok(!e.message.includes(dir), `${label}: the refusal carries a machine path: ${e.message}`);
  }

  // ⚠️ THE PORTABLE SIDE IS PROVED TOO, and a missing package directory is named as the portable side.
  const withoutPackage = project({ pkg: false });
  const e = refusalOf(() => prove(withoutPackage, "../.planning/other-package"));
  assert.equal(e.reason, PACKAGE_ENTRY_REFUSAL.MISSING);
  assert.equal(e.detail.side, "portable", "the side that could not be resolved is named");
});

test("⚠️ ACC-0105 a package directory that cannot be read is refused, not assumed equivalent", () => {
  const dir = project();
  const literalAbs = resolve(settingsDirOf(dir), PORTABLE_PACKAGE_ENTRY);
  const nodeFs = createRequire(import.meta.url)("node:fs");
  const originalStat = nodeFs.statSync;
  nodeFs.statSync = function (p, ...rest) {
    if (String(p) === literalAbs) throw Object.assign(new Error("simulated permission failure"), { code: "EACCES" });
    return originalStat.call(this, p, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const e = refusalOf(() => prove(dir, PORTABLE_PACKAGE_ENTRY));
    assert.equal(e.reason, PACKAGE_ENTRY_REFUSAL.UNREADABLE);
    assert.deepEqual(e.detail, { side: "literal", code: "EACCES" });
    assert.ok(!e.message.includes(dir) && !e.message.includes("simulated"), e.message);
  } finally {
    nodeFs.statSync = originalStat;
    syncBuiltinESMExports();
  }
});

/* ============================================ the rewrite ======================================= */

test("⚠️ ACC-0105 a proved entry is rewritten through the merge, and everything else is preserved", async () => {
  const dir = project();
  const literal = WINDOWS ? `..${sep}.planning${sep}pi-package` : join(dir, ".planning", "pi-package");
  const original = {
    theme: "dark",
    packages: ["npm:third-party-a", literal, { source: "git:github.com/example/tools", skills: ["only-this"] }],
    skills: ["../team-skills"],
    "vendor.future-setting": { nested: [1, 2] },
  };
  writeSettings(dir, json(original) + "\n");

  const result = await apply(dir, literal);
  assert.equal(result.changed, true);

  const merged = JSON.parse(readText(dir));
  assert.deepEqual(
    merged.packages,
    ["npm:third-party-a", PORTABLE_PACKAGE_ENTRY, { source: "git:github.com/example/tools", skills: ["only-this"] }],
    "the literal entry became the portable one in place, and no other entry moved"
  );
  assert.equal(merged.packages.filter((p) => p === PORTABLE_PACKAGE_ENTRY).length, 1, "exactly once");
  assert.deepEqual(merged.skills, ["../team-skills", SKILL_OVERRIDE_PATH]);
  assert.deepEqual(merged.theme, original.theme);
  assert.deepEqual(merged["vendor.future-setting"], original["vendor.future-setting"]);
  assert.deepEqual(Object.keys(merged).slice(0, 4), Object.keys(original), "unrelated keys keep their order");
  assert.ok(readText(dir).endsWith("\n") && !readText(dir).endsWith("\n\n"), "the trailing-newline style is kept");
  assert.deepEqual(artifacts(dir), []);
});

test("⚠️ ACC-0105 normalising again changes no bytes and no modification time", async () => {
  const dir = project();
  const literal = join(dir, ".planning", "pi-package");
  writeSettings(dir, json({ theme: "dark", packages: ["npm:x", literal] }) + "\n");

  assert.equal((await apply(dir, literal)).changed, true);
  const bytes = readFileSync(settingsFile(dir));
  const mtime = statSync(settingsFile(dir)).mtimeMs;

  await new Promise((r) => setTimeout(r, 30));
  // ⚠️ The literal is gone from the file by now, and the same call must still be a no-op rather than re-adding it.
  assert.equal((await apply(dir, literal)).changed, false, "the second normalisation reports no change");
  assert.deepEqual(readFileSync(settingsFile(dir)), bytes, "and the bytes are identical");
  assert.equal(statSync(settingsFile(dir)).mtimeMs, mtime, "and the file was not touched");

  assert.equal((await apply(dir, PORTABLE_PACKAGE_ENTRY)).changed, false, "and neither does the portable spelling");
  assert.deepEqual(readFileSync(settingsFile(dir)), bytes);
  assert.deepEqual(artifacts(dir), []);
});

test("⚠️ ACC-0105 a refusal leaves the settings file byte-identical, with no lock and no temporary file", async () => {
  for (const [label, literal, reason] of [
    ["resolves elsewhere", "../.planning/other-package", PACKAGE_ENTRY_REFUSAL.NOT_EQUIVALENT],
    ["does not resolve", "../.planning/absent", PACKAGE_ENTRY_REFUSAL.MISSING],
    ["not a directory", "../.planning/not-a-directory", PACKAGE_ENTRY_REFUSAL.NOT_A_DIRECTORY],
  ]) {
    const dir = project();
    const before = json({ theme: "dark", packages: ["npm:x", "../.planning/other-package"] }) + "\n";
    writeSettings(dir, before);
    await refusal(apply(dir, literal), refusedWith(reason, label));
    assert.equal(readText(dir), before, `${label}: the file must be byte-identical`);
    assert.deepEqual(artifacts(dir), [], `${label}: no lock or temporary file`);
  }
});

test("neither a second package entry nor a missing transaction is accepted", async () => {
  const dir = project();
  const before = json({ theme: "dark" });
  writeSettings(dir, before);

  await refusal(
    apply(dir, PORTABLE_PACKAGE_ENTRY, { ...DESIRED, packageEntry: "../elsewhere" }),
    refusedWith(PACKAGE_ENTRY_REFUSAL.CONFLICT, "a supplied package entry")
  );
  await refusal(
    apply(dir, PORTABLE_PACKAGE_ENTRY, { ...DESIRED, packageEntryEquivalents: ["../elsewhere"] }),
    refusedWith(PACKAGE_ENTRY_REFUSAL.CONFLICT, "supplied equivalents")
  );
  await refusal(
    applyPortablePackageEntry({ transaction: { plan: {} }, literalEntry: PORTABLE_PACKAGE_ENTRY, desired: DESIRED }),
    refusedWith(PACKAGE_ENTRY_REFUSAL.NO_TRANSACTION, "no transaction")
  );

  assert.equal(readText(dir), before, "none of them changed the file");
  assert.deepEqual(artifacts(dir), []);
  assert.equal(existsSync(join(dir, ".planning-init.lock")), false);
});
