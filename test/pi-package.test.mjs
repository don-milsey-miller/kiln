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
  declaredToolNames,
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

const REGISTERED_TOOLS = Object.freeze([
  "kiln_capability",
  "kiln_create_acceptance_criterion",
  "kiln_create_assertion",
  "kiln_create_component",
  "kiln_create_decision",
  "kiln_create_evidence",
  "kiln_create_question",
  "kiln_create_requirement",
  "kiln_create_runbook_step",
  "kiln_create_task",
  "kiln_link_evidence",
  "kiln_link_trace",
  "kiln_lint",
  "kiln_project_status",
  "kiln_read_stage_attestations",
  "kiln_resolve_question",
  "kiln_revise_artifact",
  "kiln_set_lifecycle",
  "kiln_set_review_status",
  "kiln_set_type_activation",
  "kiln_unlink_evidence",
  "kiln_unlink_trace",
  "kiln_write_stage_attestation",
  "research_capability",
  "research_fetch",
  "research_search",
]);

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

  // ⚠️ THE NINE CREATION TOOLS AND THE TWO READ TOOLS. The mutation, activation and attestation
  // wrappers are later slices of TSK-0044, and TSK-0045's adapters later still; each name arrives with
  // its handler and never before it.
  assert.deepEqual([...signature.tools].sort(), [...REGISTERED_TOOLS]);

  const calls = [];
  register({ registerTool: (t) => calls.push(t.name) });
  assert.deepEqual(calls.sort(), [...REGISTERED_TOOLS], "the entry point registers exactly those");
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

/* ============================================ declared tools vs registered ===================== */

/**
 * Append a registration to the copied entry point, inside its registration function.
 *
 * ⚠️ THE ANCHOR IS ASSERTED. A rename in the entry point once made this a silent no-op, and the
 * fixtures then proved that a package registering nothing extra is accepted — which is true and not
 * what they exist to check.
 */
const REGISTER_ANCHOR = "export default function register(pi, deps = {}) {";
const registering = (...tools) => ({ root }) => {
  const path = join(root, "extensions", "kiln.js");
  const source = readFileSync(path, "utf-8");
  assert.equal(source.split(REGISTER_ANCHOR).length, 2, "the fixture could not find the registration function to extend");
  const calls = tools.map((name) => `  pi?.registerTool?.({ name: ${JSON.stringify(name)} });`).join("\n");
  writeFileSync(path, source.replace(REGISTER_ANCHOR, `${REGISTER_ANCHOR}\n${calls}`));
};

test("⚠️ ACC-0063 what the package registers is exactly what its declaration claims", async () => {
  const { tools, signature } = await validatePackage({ packageRoot: PACKAGE });

  // ⚠️ A NAME ARRIVES WITH ITS WORKING HANDLER, NEVER BEFORE IT. Declaring one earlier would announce
  // a capability the package does not have, and a placeholder handler would put an unusable tool in
  // front of an operator. These two are the read tools, and their handlers are tested beside them.
  assert.deepEqual(tools, [...REGISTERED_TOOLS], "registration produced exactly these");
  assert.deepEqual([...signature.tools].sort(), tools, "and the declaration claims exactly the same");
  assert.equal(signature.signatureVersion, 1, "the declaration's shape has not changed, so its version has not");
});

test("⚠️ ACC-0063 a tool registered but not declared is refused", async () => {
  // ⚠️ AN INVENTED NAME, BECAUSE EVERY DECLARED NAME NOW HAS A HANDLER. These fixtures used to borrow
  // the next slice's tools; there is no next slice's tool left to borrow, and a name the package does
  // register would test nothing.
  const undeclared = brokenCopy(registering("kiln_not_a_tool"));
  const e = await refusal(validatePackage({ packageRoot: undeclared }), PACKAGE_REFUSAL.TOOL_UNDECLARED, "one undeclared tool");
  assert.deepEqual(e.detail.registeredNotDeclared, ["kiln_not_a_tool"]);

  const several = brokenCopy(registering("kiln_not_a_tool", "kiln_nor_is_this"));
  const e2 = await refusal(validatePackage({ packageRoot: several }), PACKAGE_REFUSAL.TOOL_UNDECLARED, "several undeclared tools");
  assert.deepEqual(e2.detail.registeredNotDeclared, ["kiln_nor_is_this", "kiln_not_a_tool"], "named, and in a stable order");
});

test("⚠️ ACC-0063 a tool declared but never registered is refused", async () => {
  const promised = brokenCopy(({ signature }) => signature((s) => s.tools.push("kiln_not_a_tool")));
  const e = await refusal(validatePackage({ packageRoot: promised }), PACKAGE_REFUSAL.TOOL_NOT_REGISTERED, "declared only");
  assert.deepEqual(e.detail.declaredNotRegistered, ["kiln_not_a_tool"]);

  // ⚠️ AND A PARTIAL MATCH IS STILL A MISMATCH: one of the two declared tools registering is not agreement.
  const half = brokenCopy(({ root }) => {
    const path = join(root, "extensions", "kiln.js");
    const source = readFileSync(path, "utf-8");
    // The lint tool's registration is removed while its name stays declared.
    writeFileSync(path, source.replace(/  pi\?\.registerTool\?\.\(\{\n    name: "kiln_lint",[\s\S]*?\n  \}\);\n/, ""));
  });
  const e2 = await refusal(validatePackage({ packageRoot: half }), PACKAGE_REFUSAL.TOOL_NOT_REGISTERED, "half registered");
  assert.deepEqual(e2.detail.declaredNotRegistered, ["kiln_lint"]);
});

test("⚠️ ACC-0063 the names a launch may request come from validation, not from reading the file", async () => {
  // ⚠️ **THE DIFFERENCE IS WHAT HAPPENS WHEN THE TWO DISAGREE.** Reading `signature.json` returns a
  // name the package does not register, and a launch would then ask Pi to enable a tool no session
  // would hold. Validating first turns that into a refusal.
  assert.deepEqual(await declaredToolNames({ packageRoot: PACKAGE }), [...REGISTERED_TOOLS]);

  const promised = brokenCopy(({ signature }) => signature((s) => s.tools.push("kiln_not_a_tool")));
  await refusal(declaredToolNames({ packageRoot: promised }), PACKAGE_REFUSAL.TOOL_NOT_REGISTERED, "a declared name nothing registers");

  const extra = brokenCopy(registering("kiln_not_a_tool"));
  await refusal(declaredToolNames({ packageRoot: extra }), PACKAGE_REFUSAL.TOOL_UNDECLARED, "a registered name nothing declares");
});

test("⚠️ ACC-0063 the same tool registered twice is refused", async () => {
  const twice = brokenCopy(registering("kiln_lint"));
  const e = await refusal(validatePackage({ packageRoot: twice }), PACKAGE_REFUSAL.TOOL_DUPLICATE, "registered twice");
  assert.deepEqual(e.detail.duplicated, ["kiln_lint"]);
});

test("⚠️ ACC-0063 agreement is observed by running registration, not by reading the source", async () => {
  // ⚠️ A SOURCE SCAN WOULD PASS THIS: the file contains `registerTool`, and registers nothing.
  const conditional = brokenCopy(({ root }) => {
    const path = join(root, "extensions", "kiln.js");
    const source = readFileSync(path, "utf-8");
    // ⚠️ THE ANCHOR IS ASSERTED, for the second time and the same reason: this fixture named an older
    // signature of the registration function, matched nothing, and left the copy identical to the
    // real package — so it passed while checking nothing at all.
    assert.equal(source.split(REGISTER_ANCHOR).length, 2, "the fixture could not find the registration function to extend");
    writeFileSync(
      path,
      source.replace(
        REGISTER_ANCHOR,
        `${REGISTER_ANCHOR}\n  if (String(1) === "2") pi?.registerTool?.({ name: "kiln_never" });`
      )
    );
  });

  const { tools } = await validatePackage({ packageRoot: conditional });
  assert.deepEqual(tools, [...REGISTERED_TOOLS], "what did not run did not register, and the check saw that");
});

/* ============================================ what loading it costs ============================ */

/**
 * Loading AND registering the extension in a child, with the filesystem, the network and process
 * spawning watched, and a project sitting where the shared resolver would find one.
 *
 * ⚠️ **THE BOUNDARY THIS ENFORCES.** Importing and registering may load code and this package's
 * declaration. It must not resolve or read planning content, inspect credentials, write files, spawn
 * processes, or contact a network. Project access begins only when an invoked handler resolves the
 * content root through the shared resolver — so the child registers the tools and calls none of them.
 *
 * ⚠️ **THE PROJECT IS REAL AND REACHABLE**, named in PLANNING_CONTENT_DIR and sitting under the
 * child's working directory, with a planted credential in the environment. An entry point that
 * resolved the content root at registration would read it, and this would see that.
 */
const PURITY_CHILD = `
import { createRequire, syncBuiltinESMExports } from "node:module";

const [entry, packageRoot, contentRoot, scratch] = process.argv.slice(-4);
const fs = createRequire(import.meta.url)("node:fs");
const cp = createRequire(import.meta.url)("node:child_process");
const seen = { reads: [], writes: [], spawns: [], network: [], env: [] };

for (const name of ["readFileSync", "readdirSync", "openSync", "statSync", "existsSync"]) {
  const original = fs[name];
  fs[name] = function (path, ...rest) {
    seen.reads.push(String(path));
    return original.call(this, path, ...rest);
  };
}
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync"]) {
  const original = fs[name];
  fs[name] = function (path, ...rest) {
    seen.writes.push(String(path));
    return original.call(this, path, ...rest);
  };
}
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
// Reading a credential is watched the same way: any access to one of these names is recorded.
const realEnv = process.env;
process.env = new Proxy(realEnv, {
  get(target, prop) {
    if (typeof prop === "string") seen.env.push(prop);
    return target[prop];
  },
});
syncBuiltinESMExports();

const module = await import(entry);
const registered = [];
module.default({ registerTool: (tool) => registered.push(tool.name) });
const after = JSON.parse(JSON.stringify(seen));

// The watchers must be able to see something, or the empty result above means nothing.
fs.readFileSync(process.execPath, { encoding: null });
fs.writeFileSync(scratch, "control");
cp.spawnSync(process.execPath, ["-e", "0"]);
void realEnv.PLANNING_CONTENT_DIR;
const control = {
  reads: seen.reads.length > after.reads.length,
  writes: seen.writes.length > after.writes.length,
  spawns: seen.spawns.length > after.spawns.length,
};

process.stdout.write(JSON.stringify({
  after,
  control,
  registered: registered.sort(),
  signatureVersion: module.SIGNATURE_VERSION ?? null,
  packageRoot,
  contentRoot,
}));
`;

test("⚠️ ACC-0063 loading and registering touches no project, no credential, no file and no network", () => {
  const base = reapLater(mkdtempSync(join(tmpdir(), "kiln-pkg-purity-")));
  const contentRoot = join(base, "planning-content");
  mkdirSync(join(contentRoot, "data"), { recursive: true });
  writeFileSync(join(contentRoot, "data", "marker.json"), JSON.stringify({ id: "REQ-0001" }));
  const scratch = join(base, "control.txt");
  const entry = pathToFileUrl(join(PACKAGE, "extensions", "kiln.js"));

  const r = spawnSync(process.execPath, ["--input-type=module", "-e", PURITY_CHILD, entry, PACKAGE, contentRoot, scratch], {
    cwd: base,
    encoding: "utf-8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot ?? "",
      // ⚠️ BOTH PLANTED: a content root the resolver would accept, and a credential to be tempted by.
      PLANNING_CONTENT_DIR: contentRoot,
      ANTHROPIC_API_KEY: "sk-ant-REGISTRATION-PLANTED-2c9f",
    },
  });
  assert.equal(r.status, 0, `the purity child failed: ${r.stderr}`);
  const seen = JSON.parse(r.stdout);

  assert.deepEqual(seen.registered, [...REGISTERED_TOOLS], "registration ran and produced every declared tool");
  assert.equal(seen.signatureVersion, 1);

  assert.deepEqual(seen.after.writes, [], "registration wrote a file");
  assert.deepEqual(seen.after.spawns, [], "registration started a process");
  assert.deepEqual(seen.after.network, [], "registration contacted something");

  // ⚠️ CODE MAY BE LOADED; THE PROJECT MAY NOT BE TOUCHED.
  const asPath = (recorded) => (recorded.startsWith("file:") ? fileURLToPath(recorded) : recorded);
  const key = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  for (const recorded of seen.after.reads)
    assert.equal(
      key(asPath(recorded)).startsWith(key(seen.contentRoot)),
      false,
      `registration read planning content: ${recorded}`
    );

  // No credential name was read, and neither was the variable that would resolve the project.
  for (const name of ["ANTHROPIC_API_KEY", "PLANNING_CONTENT_DIR"])
    assert.equal(seen.after.env.includes(name), false, `registration read ${name}`);

  // ⚠️ THE CONTROLS: the same watchers DID see a read, a write and a spawn the child made itself.
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
