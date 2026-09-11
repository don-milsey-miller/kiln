/**
 * Kiln's Pi package — TSK-0043, against ACC-0063.
 *
 * ⚠️ **THE MANIFEST AND THE DECLARATION ARE AUTHORED SEPARATELY, AND THAT IS WHAT MAKES THIS A TEST.**
 * A signature derived from the manifest would agree with it by construction. These compare two
 * hand-written files — three, counting the version the entry point states for itself — so a resource
 * added, renamed or deleted without its declaration is a failure rather than a signature nobody
 * checked.
 *
 * ⚠️ **NO PI RUNS HERE.** Whether a real trusted Pi discovers these resources, and an untrusted one
 * does not, is the live half of ACC-0063 and is not claimed by anything in this file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import {
  PACKAGE_REFUSAL,
  PackageRefusal,
  packageRootFor,
  readManifest,
  readSignature,
  validatePackage,
} from "../lib/pi-package.mjs";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = packageRootFor(ROOT);

/** A throwaway copy of the real package, for the cases that must break it. */
const brokenCopy = (mutate) => {
  const root = join(reapLater(mkdtempSync(join(tmpdir(), "kiln-pkg-"))), "pi-package");
  cpSync(PACKAGE, root, { recursive: true });
  mutate({
    root,
    manifest: (fn) => {
      const path = join(root, "package.json");
      const manifest = JSON.parse(readFileSync(path, "utf-8"));
      fn(manifest);
      writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
    },
    signature: (fn) => {
      const path = join(root, "signature.json");
      const signature = JSON.parse(readFileSync(path, "utf-8"));
      fn(signature);
      writeFileSync(path, JSON.stringify(signature, null, 2) + "\n");
    },
  });
  return root;
};

async function refusal(promise, reason, label) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof PackageRefusal && e.reason === reason, `${label}: got ${e?.reason ?? e}`);
    return e;
  }
  assert.fail(`${label}: expected a refusal, and it was accepted`);
}

/* ============================================ the package as authored ========================== */

test("⚠️ ACC-0063 the real package validates: its declared resources exist and its entry point loads", async () => {
  const { manifest, signature, resources, register } = await validatePackage({ packageRoot: PACKAGE });

  assert.equal(manifest.name, "@kiln/pi-package");
  assert.deepEqual(resources.extensions, ["kiln"]);
  assert.deepEqual(resources.skills, ["kiln-planning"]);
  assert.deepEqual(resources.prompts, ["kiln-start"]);
  assert.deepEqual([...signature.extensions], resources.extensions, "the declaration names what is there");
  assert.deepEqual([...signature.skills], resources.skills);
  assert.deepEqual([...signature.prompts], resources.prompts);
  assert.equal(typeof register, "function");

  // ⚠️ NO TOOLS YET, DECLARED AS AN EMPTY LIST rather than left out: TSK-0044 and TSK-0045 register them.
  assert.deepEqual([...signature.tools], [], "this package registers no tools yet, and says so");

  const calls = [];
  register({ registerTool: (t) => calls.push(t), registerCommand: (c) => calls.push(c) });
  assert.deepEqual(calls, [], "the entry point registers nothing at this stage");
});

test("⚠️ ACC-0063 the signature is immutable and JSON-safe", async () => {
  const signature = readSignature(PACKAGE);

  assert.equal(Object.isFrozen(signature), true);
  for (const kind of ["extensions", "skills", "prompts", "tools"]) assert.equal(Object.isFrozen(signature[kind]), true);
  assert.throws(() => {
    signature.signatureVersion = 99;
  }, TypeError);
  assert.throws(() => {
    signature.tools.push("kiln_anything");
  }, TypeError);

  assert.deepEqual(JSON.parse(JSON.stringify(signature)), {
    signatureVersion: signature.signatureVersion,
    extensions: [...signature.extensions],
    skills: [...signature.skills],
    prompts: [...signature.prompts],
    tools: [...signature.tools],
  });
  assert.equal(Number.isInteger(signature.signatureVersion) && signature.signatureVersion >= 1, true);
});

test("⚠️ ACC-0063 the extension entry is one Pi will load, and the manifest declares all three kinds", () => {
  const { declared } = readManifest(PACKAGE);
  assert.deepEqual(Object.keys(declared).sort(), ["extensions", "prompts", "skills"]);
  for (const path of declared.extensions)
    assert.match(path, /\.(js|ts)$/, "Pi's loader takes .ts or .js extension entries and nothing else");
  for (const kind of ["extensions", "skills", "prompts"])
    for (const path of declared[kind]) assert.match(path, /^\.\//, `${kind}: ${path} must be relative to the package`);
});

/* ============================================ what must be refused ============================= */

test("⚠️ ACC-0063 a declared resource that is not there is refused", async () => {
  const missingExtension = brokenCopy(({ root }) => rmSync(join(root, "extensions", "kiln.js")));
  await refusal(validatePackage({ packageRoot: missingExtension }), PACKAGE_REFUSAL.RESOURCE_MISSING, "extension file");

  const missingSkillsDir = brokenCopy(({ root }) => rmSync(join(root, "skills"), { recursive: true }));
  await refusal(validatePackage({ packageRoot: missingSkillsDir }), PACKAGE_REFUSAL.RESOURCE_MISSING, "skills directory");

  const notAFile = brokenCopy(({ manifest }) => manifest((m) => (m.pi.extensions = ["./extensions"])));
  await refusal(validatePackage({ packageRoot: notAFile }), PACKAGE_REFUSAL.RESOURCE_MISSING, "a directory as an extension");

  const wrongSuffix = brokenCopy(({ root, manifest }) => {
    cpSync(join(root, "extensions", "kiln.js"), join(root, "extensions", "kiln.mjs"));
    manifest((m) => (m.pi.extensions = ["./extensions/kiln.mjs"]));
  });
  await refusal(validatePackage({ packageRoot: wrongSuffix }), PACKAGE_REFUSAL.RESOURCE_MISSING, "a suffix Pi does not load");
});

test("⚠️ ACC-0063 an unsafe or duplicated declared path is refused before it is followed", async () => {
  const cases = [
    ["absolute posix", "/etc/kiln/extension.js"],
    ["absolute windows", "C:/kiln/extension.js"],
    ["drive-relative", "\\kiln\\extension.js"],
    ["traversal", "./../outside/extension.js"],
    ["traversal in the middle", "./extensions/../../outside/extension.js"],
    ["backslashes", ".\\extensions\\kiln.js"],
  ];
  for (const [label, path] of cases) {
    const root = brokenCopy(({ manifest }) => manifest((m) => (m.pi.extensions = [path])));
    await refusal(validatePackage({ packageRoot: root }), PACKAGE_REFUSAL.PATH_UNSAFE, label);
  }

  const duplicate = brokenCopy(({ manifest }) => manifest((m) => (m.pi.prompts = ["./prompts", "./prompts"])));
  await refusal(validatePackage({ packageRoot: duplicate }), PACKAGE_REFUSAL.PATH_DUPLICATE, "the same path twice");

  const acrossKinds = brokenCopy(({ manifest }) => manifest((m) => (m.pi.skills = ["./prompts"])));
  await refusal(validatePackage({ packageRoot: acrossKinds }), PACKAGE_REFUSAL.PATH_DUPLICATE, "one path under two kinds");
});

test("⚠️ ACC-0063 a declaration that names more or fewer resources than the package has is refused", async () => {
  const extraName = brokenCopy(({ signature }) => signature((s) => s.skills.push("kiln-not-here")));
  const e1 = await refusal(validatePackage({ packageRoot: extraName }), PACKAGE_REFUSAL.SIGNATURE_MISMATCH, "declared but absent");
  assert.deepEqual(e1.detail.declaredNotFound, ["kiln-not-here"]);

  const droppedName = brokenCopy(({ signature }) => signature((s) => (s.prompts = [])));
  const e2 = await refusal(validatePackage({ packageRoot: droppedName }), PACKAGE_REFUSAL.SIGNATURE_MISMATCH, "present but undeclared");
  assert.deepEqual(e2.detail.foundNotDeclared, ["kiln-start"]);

  // ⚠️ A RESOURCE ADDED WITHOUT ITS DECLARATION IS THE DRIFT THIS EXISTS TO CATCH.
  const undeclaredSkill = brokenCopy(({ root }) => {
    mkdirSync(join(root, "skills", "kiln-extra"));
    writeFileSync(join(root, "skills", "kiln-extra", "SKILL.md"), "---\nname: kiln-extra\n---\n");
  });
  const e3 = await refusal(validatePackage({ packageRoot: undeclaredSkill }), PACKAGE_REFUSAL.SIGNATURE_MISMATCH, "a skill nobody declared");
  assert.deepEqual(e3.detail.foundNotDeclared, ["kiln-extra"]);
});

test("⚠️ ACC-0063 a signature version the entry point does not share is refused", async () => {
  const drifted = brokenCopy(({ signature }) => signature((s) => (s.signatureVersion = s.signatureVersion + 1)));
  const e = await refusal(
    validatePackage({ packageRoot: drifted }),
    PACKAGE_REFUSAL.SIGNATURE_VERSION_MISMATCH,
    "the declaration moved and the entry point did not"
  );
  assert.equal(e.detail.entryPoint, 1);
  assert.equal(e.detail.declaration, 2);

  const notAVersion = brokenCopy(({ signature }) => signature((s) => (s.signatureVersion = "1")));
  await refusal(validatePackage({ packageRoot: notAVersion }), PACKAGE_REFUSAL.SIGNATURE_INVALID, "a version that is not a number");

  const duplicatedName = brokenCopy(({ signature }) => signature((s) => (s.skills = ["kiln-planning", "kiln-planning"])));
  await refusal(validatePackage({ packageRoot: duplicatedName }), PACKAGE_REFUSAL.SIGNATURE_INVALID, "a name declared twice");

  const pathAsName = brokenCopy(({ signature }) => signature((s) => (s.prompts = ["./prompts/kiln-start.md"])));
  await refusal(validatePackage({ packageRoot: pathAsName }), PACKAGE_REFUSAL.SIGNATURE_INVALID, "a path where a name belongs");
});

/* ============================================ what loading it costs ============================ */

/**
 * Importing the entry point in a child, with the filesystem, the network and process spawning
 * watched. What is asserted is a NEGATIVE, so the watchers are proved to work first: the same child
 * performs one read, one write and one spawn of its own and sees all three recorded.
 */
const PURITY_CHILD = `
import { createRequire, syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";

const [entry, packageRoot, scratch] = process.argv.slice(-3);
const fs = createRequire(import.meta.url)("node:fs");
const cp = createRequire(import.meta.url)("node:child_process");
const seen = { reads: [], writes: [], spawns: [], network: [] };

const watchRead = (name) => {
  const original = fs[name];
  fs[name] = function (path, ...rest) {
    seen.reads.push(String(path));
    return original.call(this, path, ...rest);
  };
};
const watchWrite = (name) => {
  const original = fs[name];
  fs[name] = function (path, ...rest) {
    seen.writes.push(String(path));
    return original.call(this, path, ...rest);
  };
};
for (const name of ["readFileSync", "readdirSync", "openSync"]) watchRead(name);
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync"]) watchWrite(name);
for (const name of ["spawnSync", "execSync", "spawn", "exec", "execFile"]) {
  const original = cp[name];
  cp[name] = function (...args) {
    seen.spawns.push(String(args[0]));
    return original.apply(this, args);
  };
}
globalThis.fetch = async (url) => {
  seen.network.push(String(url));
  throw new Error("network reached");
};
syncBuiltinESMExports();

const before = JSON.parse(JSON.stringify(seen));
const module = await import(entry);
const after = JSON.parse(JSON.stringify(seen));

// The watchers must be able to see something, or the empty result above means nothing.
fs.readFileSync(process.execPath, { encoding: null });
fs.writeFileSync(scratch, "control");
cp.spawnSync(process.execPath, ["-e", "0"]);
const control = { reads: seen.reads.length > after.reads.length, writes: seen.writes.length > after.writes.length, spawns: seen.spawns.length > after.spawns.length };

process.stdout.write(JSON.stringify({
  before,
  after,
  control,
  registers: typeof module.default === "function",
  signatureVersion: module.SIGNATURE_VERSION ?? null,
  packageRoot,
}));
`;

test("⚠️ ACC-0063 importing the entry point reads no project content, writes nothing, and contacts nothing", () => {
  const scratch = join(reapLater(mkdtempSync(join(tmpdir(), "kiln-pkg-purity-"))), "control.txt");
  const entry = pathToFileUrl(join(PACKAGE, "extensions", "kiln.js"));

  const r = spawnSync(process.execPath, ["--input-type=module", "-e", PURITY_CHILD, entry, PACKAGE, scratch], {
    encoding: "utf-8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? "" },
  });
  assert.equal(r.status, 0, `the purity child failed: ${r.stderr}`);
  const seen = JSON.parse(r.stdout);

  assert.equal(seen.registers, true, "the entry point loaded and exports a registration function");
  assert.equal(seen.signatureVersion, 1, "and states its signature version");

  assert.deepEqual(seen.after.writes, [], "importing wrote a file");
  assert.deepEqual(seen.after.spawns, [], "importing started a process");
  assert.deepEqual(seen.after.network, [], "importing contacted something");
  // ⚠️ THE LOADER RECORDS A `file://` URL, not a path, and Windows compares paths case-insensitively.
  const asPath = (recorded) => (recorded.startsWith("file:") ? fileURLToPath(recorded) : recorded);
  const key = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  for (const recorded of seen.after.reads)
    assert.ok(key(asPath(recorded)).startsWith(key(seen.packageRoot)), `importing read outside the package: ${recorded}`);

  // ⚠️ THE CONTROL: the same watchers DID see a read, a write and a spawn when the child made them.
  assert.deepEqual(seen.control, { reads: true, writes: true, spawns: true }, "the watchers see nothing at all, so the negative proves nothing");
});

/** `file://` for the child, without importing node:url into the test's own namespace twice. */
function pathToFileUrl(path) {
  return new URL(`file://${path.startsWith("/") ? "" : "/"}${path.replace(/\\/g, "/")}`).href;
}

test("⚠️ ACC-0063 the entry point reads no environment and imports nothing outside the package", () => {
  const source = readFileSync(join(PACKAGE, "extensions", "kiln.js"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.ok(!/process\s*\.\s*env/.test(source), "the entry point reads the environment");
  assert.ok(!/node:fs|node:child_process|node:http|fetch\s*\(/.test(source), "the entry point reaches the filesystem or network");
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["../signature.json"], "the only import is the package's own declaration");
});
