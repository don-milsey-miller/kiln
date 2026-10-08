/**
 * When the production build on disk may be served again - #184.
 *
 * Every start used to run the compiler. `lib/build-cache.mjs` decides, before it is run, whether the build in
 * `.next` is the one this start would make. This file holds that decision against a small tool directory with a
 * build laid out the way Next leaves one: every field of the key, every way the output can be wrong, every way a
 * marker can be wrong, and what is and is not written down.
 *
 * `test/build-reuse.test.mjs` runs the real launcher and the real compiler.
 *
 * ⚠️ **EVERYTHING THAT IS NOT PROVEN REBUILDS.** No case below falls back to "probably fine".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILD_MARKER, BUILD_REASON, buildKey, currentSystem, decideBuild, invalidateBuildMarker, readBuildInputs, recordBuild, reuseBlockedBy, validateBuildOutput } from "../lib/build-cache.mjs";
import { TEMP_SUFFIX } from "../lib/atomic-write.mjs";
import { REBUILD_FLAG, main as startKiln, parseArgs } from "../bin/start-kiln.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = [".next\\BUILD_ID", ".next\\routes-manifest.json", ".next\\server\\pages-manifest.json", ".next\\required-server-files.json"];
const CODES = new Set(Object.values(BUILD_REASON));

/** A tool directory with its inputs, an installed tree, and a completed build, as the launcher would find them. */
function checkout({ build = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "kiln-build-cache-"));
  const root = join(base, "tool");
  const put = (relative, text) => {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), text);
  };
  put("app/page.js", "export default function Page() { return null; }\n");
  put("app/server/content.js", "export const x = 1;\n");
  put("lib/lint.mjs", "export const y = 2;\n");
  put("schemas/common.schema.json", "{}\n");
  put("stages/01-intake.json", "{}\n");
  put("next.config.mjs", "export default {};\n");
  put("package.json", '{"name":"tool"}\n');
  put("package-lock.json", '{"lockfileVersion":3}\n');
  put("node_modules/next/package.json", '{"name":"next","version":"16.3.8"}\n');
  put("node_modules/.package-lock.json", '{"packages":{}}\n');
  // Not build inputs: nothing here is read by the build.
  put("test/a.test.mjs", "// a test\n");
  put("README.md", "# tool\n");
  const layOut = (id = "build-id-one") => {
    put(".next/BUILD_ID", id);
    put(".next/routes-manifest.json", "{}");
    put(".next/server/pages-manifest.json", "{}");
    put(".next/required-server-files.json", JSON.stringify({ version: 1, config: {}, appDir: root, relativeAppDir: "", files: REQUIRED, ignore: [] }));
  };
  if (build) layOut();
  return {
    base,
    root,
    put,
    layOut,
    marker: join(root, ".next", BUILD_MARKER),
    /** What the launcher does after a successful compile. */
    record: async () => recordBuild({ root, decision: decideBuild({ root, env: {} }) }),
    decide: (over = {}) => decideBuild({ root, env: {}, ...over }),
    remove: () => rmSync(base, { recursive: true, force: true }),
  };
}
/** A checkout whose build has been recorded, which an unchanged start therefore reuses. */
async function recorded() {
  const c = checkout();
  assert.deepEqual(await c.record(), { recorded: true, buildId: "build-id-one" });
  assert.deepEqual([c.decide().action, c.decide().reason], ["reuse", BUILD_REASON.REUSED]);
  return c;
}
const reasonOf = (decision) => {
  assert.equal(decision.action, "build", `reused, with ${decision.reason}`);
  assert.ok(CODES.has(decision.reason), `${decision.reason} is not one of the fixed reasons`);
  return decision.reason;
};

/* ------------------------------------------------------------------ the key */

test("⚠️ #184 an unchanged checkout reuses its build, and what is not a build input does not change that", async () => {
  const c = await recorded();
  try {
    const before = readFileSync(c.marker, "utf-8");
    // Tests, documentation and anything else outside the inputs.
    c.put("test/a.test.mjs", "// a different test\n");
    c.put("README.md", "# renamed\n");
    c.put("docs/notes.md", "new\n");
    c.put("planning-content/project.yaml", "name: something\n");
    // ⚠️ TIMES ARE NOT IDENTITY: every input touched, with nothing in it changed.
    const later = new Date(Date.now() + 60_000);
    for (const file of ["app/page.js", "lib/lint.mjs", "package-lock.json", "next.config.mjs", "node_modules/.package-lock.json", ".next/BUILD_ID"]) utimesSync(join(c.root, file), later, later);
    const decision = c.decide();
    assert.deepEqual([decision.action, decision.reason], ["reuse", BUILD_REASON.REUSED]);
    // Deciding to reuse writes nothing.
    assert.equal(readFileSync(c.marker, "utf-8"), before);
    assert.equal(readFileSync(join(c.root, ".next", "BUILD_ID"), "utf-8"), "build-id-one");
  } finally {
    c.remove();
  }
});

test("⚠️ #184 every field of the key invalidates the build, each with its own reason", async () => {
  const change = [
    // What the build is made from, tracked or not: the bytes on disk are what is read.
    ["an application file edited", (c) => c.put("app/page.js", "export default function Page() { return 1; }\n"), BUILD_REASON.SOURCE],
    ["a library file edited", (c) => c.put("lib/lint.mjs", "export const y = 3;\n"), BUILD_REASON.SOURCE],
    ["a new application file", (c) => c.put("app/stage/page.js", "export default () => null;\n"), BUILD_REASON.SOURCE],
    ["an application file removed", (c) => rmSync(join(c.root, "app", "server", "content.js")), BUILD_REASON.SOURCE],
    ["an application file renamed", (c) => (c.put("app/server/renamed.js", "export const x = 1;\n"), rmSync(join(c.root, "app", "server", "content.js"))), BUILD_REASON.SOURCE],
    ["a schema edited", (c) => c.put("schemas/common.schema.json", '{"a":1}\n'), BUILD_REASON.SOURCE],
    ["a stage definition edited", (c) => c.put("stages/01-intake.json", '{"a":1}\n'), BUILD_REASON.SOURCE],
    ["the Next configuration edited", (c) => c.put("next.config.mjs", "export default { poweredByHeader: false };\n"), BUILD_REASON.SOURCE],
    ["the manifest edited", (c) => c.put("package.json", '{"name":"tool","version":"2"}\n'), BUILD_REASON.SOURCE],
    ["the lockfile edited", (c) => c.put("package-lock.json", '{"lockfileVersion":3,"packages":{}}\n'), BUILD_REASON.SOURCE],
    // ⚠️ AN OPTIONAL INPUT THAT APPEARS. Each of these is something Next would pick up the moment it exists.
    ["a pages directory", (c) => c.put("pages/index.js", "export default () => null;\n"), BUILD_REASON.OPTIONAL_INPUTS],
    ["a src directory", (c) => c.put("src/app/page.js", "export default () => null;\n"), BUILD_REASON.OPTIONAL_INPUTS],
    ["a public directory", (c) => c.put("public/robots.txt", "User-agent: *\n"), BUILD_REASON.OPTIONAL_INPUTS],
    ["a middleware file", (c) => c.put("middleware.js", "export function middleware() {}\n"), BUILD_REASON.OPTIONAL_INPUTS],
    ["an instrumentation file", (c) => c.put("instrumentation.ts", "export function register() {}\n"), BUILD_REASON.OPTIONAL_INPUTS],
    ["a second Next configuration", (c) => c.put("next.config.ts", "export default {};\n"), BUILD_REASON.OPTIONAL_INPUTS],
    ["a jsconfig", (c) => c.put("jsconfig.json", "{}\n"), BUILD_REASON.OPTIONAL_INPUTS],
    // The installed tree, which is read and never decided here.
    ["npm laid down a different tree", (c) => c.put("node_modules/.package-lock.json", '{"packages":{"node_modules/x":{}}}\n'), BUILD_REASON.INSTALLED_TREE],
    ["npm's record of the tree is gone", (c) => rmSync(join(c.root, "node_modules", ".package-lock.json")), BUILD_REASON.INSTALLED_TREE],
    ["another Next is installed", (c) => c.put("node_modules/next/package.json", '{"name":"next","version":"16.3.9"}\n'), BUILD_REASON.NEXT_VERSION],
  ];
  for (const [name, apply, reason] of change) {
    const c = await recorded();
    try {
      apply(c);
      assert.equal(reasonOf(c.decide()), reason, name);
    } finally {
      c.remove();
    }
  }

  // The machine and the runtime, supplied: each is one field, and each has its own reason.
  const c = await recorded();
  try {
    const system = currentSystem(c.root);
    assert.deepEqual([system.nodeVersion, system.platform, system.arch, system.nextVersion], [process.versions.node, process.platform, process.arch, "16.3.8"]);
    for (const [field, value, reason] of [
      // ⚠️ THE WHOLE NODE VERSION: a patch release is a different runtime until shown otherwise.
      ["nodeVersion", system.nodeVersion.replace(/\d+$/, (patch) => String(Number(patch) + 1)), BUILD_REASON.NODE_VERSION],
      ["nodeVersion", "99.0.0", BUILD_REASON.NODE_VERSION],
      ["platform", system.platform === "win32" ? "linux" : "win32", BUILD_REASON.PLATFORM],
      // ⚠️ THE ARCHITECTURE AS WELL AS THE PLATFORM: the compiler's native binary is one per pair.
      ["arch", system.arch === "x64" ? "arm64" : "x64", BUILD_REASON.ARCH],
      ["nextVersion", "17.0.0", BUILD_REASON.NEXT_VERSION],
      ["installedTree", "f".repeat(64), BUILD_REASON.INSTALLED_TREE],
    ])
      assert.equal(reasonOf(c.decide({ system: { ...system, [field]: value } })), reason, `${field} = ${value}`);
    // Supplied as they are, nothing has changed.
    assert.equal(c.decide({ system }).action, "reuse");

    // ⚠️ THE SAME CHECKOUT SOMEWHERE ELSE. The build embeds where it was made, so a copy is not the build's.
    const moved = join(c.base, "moved");
    cpSync(c.root, moved, { recursive: true });
    assert.equal(reasonOf(decideBuild({ root: moved, env: {} })), BUILD_REASON.CHECKOUT);
    assert.deepEqual(validateBuildOutput(moved), { ok: false, reason: BUILD_REASON.APP_DIR });
    // A key is over all of the fields and the contract's version, and is stable for the same inputs.
    assert.equal(buildKey(c.root).key, buildKey(c.root).key);
    assert.notEqual(buildKey(c.root).key, buildKey(moved).key);
    assert.match(buildKey(c.root).key, /^[0-9a-f]{64}$/);
  } finally {
    c.remove();
  }
});

test("⚠️ #184 an uncommitted change rebuilds once, is then reused, and putting it back rebuilds again", async () => {
  const c = await recorded();
  try {
    const original = readFileSync(join(c.root, "app", "page.js"), "utf-8");
    // No repository is consulted: this directory has none, and the edit is seen all the same.
    assert.equal(existsSync(join(c.root, ".git")), false);
    c.put("app/page.js", `${original}// edited, not committed\n`);
    assert.equal(reasonOf(c.decide()), BUILD_REASON.SOURCE);
    c.layOut("build-id-two");
    await c.record();
    assert.equal(c.decide().action, "reuse", "the build of the edited checkout is not reused while the edit stands");
    // One marker describes one build: the earlier inputs are no longer what is on disk.
    c.put("app/page.js", original);
    assert.equal(reasonOf(c.decide()), BUILD_REASON.SOURCE);
  } finally {
    c.remove();
  }
});

/* ------------------------------------------------------------------ what the marker cannot describe */

test("⚠️ #184 an .env file, NODE_OPTIONS and a public-environment reference each disable reuse, and none is written down", async () => {
  const c = await recorded();
  try {
    const marker = readFileSync(c.marker, "utf-8");
    const SECRET = "sk-live-0123456789abcdefghijklmnopqrstuvwxyzABCD";

    // ⚠️ NODE_OPTIONS, WHATEVER IT SAYS. The decision carries a code and nothing of the value.
    const options = c.decide({ env: { NODE_OPTIONS: `--require ${join(homedir(), "inject.js")} --title=${SECRET}` } });
    assert.equal(reasonOf(options), BUILD_REASON.NODE_OPTIONS);
    assert.ok(!JSON.stringify(options).includes(SECRET) && !JSON.stringify(options).includes(homedir()));
    for (const empty of [{}, { NODE_OPTIONS: "" }, { NODE_OPTIONS: "   " }]) assert.equal(c.decide({ env: empty }).action, "reuse");
    // Other environment values are not read at all: a credential under any name changes nothing and goes nowhere.
    const noisy = c.decide({ env: { NEXT_PUBLIC_API_KEY: SECRET, OPENAI_API_KEY: SECRET, PLANNING_CONTENT_DIR: homedir(), KILN_RUN_ID: "a".repeat(32), PORT: "4321" } });
    assert.deepEqual([noisy.action, JSON.stringify(noisy).includes(SECRET)], ["reuse", false]);

    // ⚠️ AN .env FILE IN THE TOOL ROOT, of any of the names Next reads. Its name and contents stay out of everything.
    for (const name of [".env", ".env.local", ".env.production", `.env.${SECRET}`]) {
      c.put(name, `NEXT_PUBLIC_TOKEN=${SECRET}\n`);
      const decision = c.decide();
      assert.equal(reasonOf(decision), BUILD_REASON.ENV_FILE, name);
      assert.ok(!JSON.stringify(decision).includes(SECRET) && !JSON.stringify(decision).includes(".env"), name);
      assert.equal(reuseBlockedBy(c.root, {}), BUILD_REASON.ENV_FILE);
      rmSync(join(c.root, name));
    }
    assert.equal(c.decide().action, "reuse");

    // ⚠️ A BUILD MADE WHILE REUSE IS DISABLED IS NOT RECORDED, forced or not, so taking the cause away afterwards does
    // not leave a build that looks reusable.
    for (const [name, disable, enable, reason] of [
      ["an .env file", () => c.put(".env.local", `TOKEN=${SECRET}
`), () => rmSync(join(c.root, ".env.local")), BUILD_REASON.ENV_FILE],
      ["NODE_OPTIONS", () => {}, () => {}, BUILD_REASON.NODE_OPTIONS],
    ])
      for (const forced of [false, true]) {
        disable();
        const env = reason === BUILD_REASON.NODE_OPTIONS ? { NODE_OPTIONS: `--title=${SECRET}` } : {};
        const decision = c.decide({ env, forced });
        assert.equal(reasonOf(decision), forced ? BUILD_REASON.FORCED : reason, name);
        assert.equal(decision.unrecordable, reason, name);
        assert.ok(!JSON.stringify(decision).includes(SECRET));
        // What the launcher does: the marker goes, the compiler runs, and nothing is written afterwards.
        invalidateBuildMarker(c.root);
        c.layOut("build-made-while-disabled");
        assert.deepEqual(await recordBuild({ root: c.root, decision }), { recorded: false, reason }, name);
        assert.equal(existsSync(c.marker), false, `a build made with ${name} was recorded`);
        enable();
        assert.equal(reasonOf(c.decide()), BUILD_REASON.NO_MARKER, `a build made with ${name} was reused once it was gone`);
        c.layOut();
        await c.record();
        assert.equal(c.decide().action, "reuse");
      }
    // A file that only resembles one is not one.
    c.put(".envrc", "x\n");
    c.put("env.txt", "x\n");
    assert.equal(c.decide().action, "reuse");

    // ⚠️ A BUILD INPUT THAT ASKS FOR A PUBLIC ENVIRONMENT VALUE. Next writes such a value into the build, and nothing
    // here records one, so reuse is off for as long as the reference is there.
    const name = ["NEXT", "PUBLIC", "ANYTHING"].join("_");
    c.put("app/page.js", `export default function Page() { return process.env.${name}; }\n`);
    assert.equal(reasonOf(c.decide()), BUILD_REASON.PUBLIC_ENV);
    assert.equal(readBuildInputs(c.root).referencesPublicEnv, true);
    c.layOut("build-id-two");
    assert.deepEqual(await c.record(), { recorded: false, reason: BUILD_REASON.PUBLIC_ENV });
    assert.equal(reasonOf(c.decide()), BUILD_REASON.PUBLIC_ENV, "a build that inlines a public value was reused");
    assert.equal(c.decide({ forced: true }).unrecordable, BUILD_REASON.PUBLIC_ENV);

    // The marker written before any of this never held an environment name, a value or a path.
    for (const absent of [SECRET, "NODE_OPTIONS", ".env", "NEXT_PUBLIC", c.root, c.root.replaceAll("\\", "/"), c.root.replaceAll("\\", "\\\\"), homedir()]) assert.ok(!marker.includes(absent), `the marker holds ${absent}`);
  } finally {
    c.remove();
  }
});

test("⚠️ #184 this repository's own build inputs reference no public environment value", () => {
  // The guard the contract rests on: the only environment recorded is the fixed build mode, which is sound only
  // while nothing the build reads asks Next to inline a value from the environment.
  const inputs = readBuildInputs(ROOT);
  assert.equal(inputs.referencesPublicEnv, false, "a build input references a NEXT_PUBLIC value; the cache contract must be revisited before reuse is sound");
  assert.match(inputs.source, /^[0-9a-f]{64}$/);
});

/* ------------------------------------------------------------------ the marker */

test("⚠️ #184 a marker that is absent, corrupt, of another version or about another build is never trusted", async () => {
  const c = await recorded();
  try {
    const good = JSON.parse(readFileSync(c.marker, "utf-8"));
    // ⚠️ WHAT MAY BE IN IT: versions, digests, the platform and architecture, the build id and the key. Nothing else.
    assert.deepEqual(Object.keys(good), ["markerVersion", "key", "buildId", "fields"]);
    assert.deepEqual(Object.keys(good.fields), ["buildMode", "checkout", "platform", "arch", "nodeVersion", "nextVersion", "installedTree", "optionalInputs", "source"]);
    assert.deepEqual([good.markerVersion, good.buildId, good.fields.buildMode], [1, "build-id-one", "production"]);
    for (const digest of ["checkout", "installedTree", "optionalInputs", "source"]) assert.match(good.fields[digest], /^[0-9a-f]{64}$/, digest);
    assert.equal(good.key, buildKey(c.root).key);

    const withMarker = (text) => (writeFileSync(c.marker, text), reasonOf(c.decide()));
    for (const [name, text, reason] of [
      ["not JSON", "{ not json", BUILD_REASON.MARKER_INVALID],
      ["empty", "", BUILD_REASON.MARKER_INVALID],
      ["an array", "[]", BUILD_REASON.MARKER_INVALID],
      ["null", "null", BUILD_REASON.MARKER_INVALID],
      ["no version", JSON.stringify({ ...good, markerVersion: undefined }), BUILD_REASON.MARKER_INVALID],
      ["a version that is not a number", JSON.stringify({ ...good, markerVersion: "1" }), BUILD_REASON.MARKER_INVALID],
      ["an earlier contract", JSON.stringify({ ...good, markerVersion: 0 }), BUILD_REASON.MARKER_VERSION],
      ["a later contract", JSON.stringify({ ...good, markerVersion: 2 }), BUILD_REASON.MARKER_VERSION],
      ["no key", JSON.stringify({ ...good, key: undefined }), BUILD_REASON.MARKER_INVALID],
      ["no build id", JSON.stringify({ ...good, buildId: "" }), BUILD_REASON.MARKER_INVALID],
      ["no fields", JSON.stringify({ ...good, fields: undefined }), BUILD_REASON.MARKER_INVALID],
      ["a field missing", JSON.stringify({ ...good, fields: { ...good.fields, arch: undefined } }), BUILD_REASON.MARKER_INVALID],
      ["a field of the wrong type", JSON.stringify({ ...good, fields: { ...good.fields, source: 7 } }), BUILD_REASON.MARKER_INVALID],
      // Every field agrees and the key does not: the marker was not written by this code for this build.
      ["a key that is not the fields'", JSON.stringify({ ...good, key: "0".repeat(64) }), BUILD_REASON.KEY],
      ["another build mode", JSON.stringify({ ...good, fields: { ...good.fields, buildMode: "development" } }), BUILD_REASON.BUILD_MODE],
      ["a build id that is not the one on disk", JSON.stringify({ ...good, buildId: "another-build" }), BUILD_REASON.BUILD_ID_MISMATCH],
    ])
      assert.equal(withMarker(text), reason, name);

    rmSync(c.marker);
    assert.equal(reasonOf(c.decide()), BUILD_REASON.NO_MARKER);
    // ⚠️ A BUILD DIRECTORY AND A BUILD ID ALONE ARE NOT A BUILD ANYONE VOUCHES FOR.
    assert.ok(existsSync(join(c.root, ".next", "BUILD_ID")));
    // And with no build directory at all.
    rmSync(join(c.root, ".next"), { recursive: true });
    assert.equal(reasonOf(c.decide()), BUILD_REASON.NO_MARKER);

    // ⚠️ `--rebuild` BUILDS, WHATEVER IS THERE.
    c.layOut();
    await c.record();
    assert.equal(c.decide().action, "reuse");
    assert.equal(reasonOf(c.decide({ forced: true })), BUILD_REASON.FORCED);
  } finally {
    c.remove();
  }
});

test("⚠️ #184 the marker is removed before a build and written only after one that validates", async () => {
  const c = await recorded();
  try {
    // Before the compiler: gone, and removing what is not there is not an error.
    invalidateBuildMarker(c.root);
    assert.equal(existsSync(c.marker), false);
    invalidateBuildMarker(c.root);
    const empty = checkout({ build: false });
    try {
      invalidateBuildMarker(empty.root);
    } finally {
      empty.remove();
    }

    // ⚠️ A BUILD THAT FAILED OR WAS INTERRUPTED: whatever it left, nothing vouches for it.
    assert.equal(reasonOf(c.decide()), BUILD_REASON.NO_MARKER);
    rmSync(join(c.root, ".next", "server", "pages-manifest.json"));
    assert.deepEqual(await recordBuild({ root: c.root, decision: c.decide() }), { recorded: false, reason: BUILD_REASON.FILE_MISSING });
    assert.equal(existsSync(c.marker), false, "a build with a required file missing was recorded");
    writeFileSync(join(c.root, ".next", "BUILD_ID"), "  \n");
    c.put(".next/server/pages-manifest.json", "{}");
    assert.deepEqual(await recordBuild({ root: c.root, decision: c.decide() }), { recorded: false, reason: BUILD_REASON.BUILD_ID_EMPTY });
    assert.equal(existsSync(c.marker), false);

    // A build that completed: recorded whole, with no temporary file beside it.
    c.layOut("build-id-two");
    assert.deepEqual(await recordBuild({ root: c.root, decision: c.decide() }), { recorded: true, buildId: "build-id-two" });
    assert.deepEqual(readdirSync(join(c.root, ".next")).filter((name) => name.includes(TEMP_SUFFIX)), []);
    assert.equal(JSON.parse(readFileSync(c.marker, "utf-8")).buildId, "build-id-two");
    assert.equal(c.decide().action, "reuse");
  } finally {
    c.remove();
  }
});

/* ------------------------------------------------------------------ the output */

test("⚠️ #184 the build's own list of required files is checked: present, a file, and really inside the build directory", async () => {
  const manifestOf = (c, change) => {
    const path = join(c.root, ".next", "required-server-files.json");
    writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, "utf-8")))));
  };
  const cases = [
    ["the list is missing", (c) => rmSync(join(c.root, ".next", "required-server-files.json")), BUILD_REASON.NO_MANIFEST],
    ["the list is not JSON", (c) => writeFileSync(join(c.root, ".next", "required-server-files.json"), "{ not json"), BUILD_REASON.MANIFEST_INVALID],
    ["the list is of another version", (c) => manifestOf(c, (m) => ({ ...m, version: 2 })), BUILD_REASON.MANIFEST_INVALID],
    ["the list names no files", (c) => manifestOf(c, (m) => ({ ...m, files: [] })), BUILD_REASON.MANIFEST_INVALID],
    ["the list has no application directory", (c) => manifestOf(c, (m) => ({ ...m, appDir: undefined })), BUILD_REASON.MANIFEST_INVALID],
    ["the build was made in another directory", (c) => manifestOf(c, (m) => ({ ...m, appDir: join(c.base, "elsewhere") })), BUILD_REASON.APP_DIR],
    ["a required file is missing", (c) => rmSync(join(c.root, ".next", "routes-manifest.json")), BUILD_REASON.FILE_MISSING],
    ["a required file is a directory", (c) => (rmSync(join(c.root, ".next", "routes-manifest.json")), mkdirSync(join(c.root, ".next", "routes-manifest.json"))), BUILD_REASON.FILE_MISSING],
    ["the build id is missing", (c) => rmSync(join(c.root, ".next", "BUILD_ID")), BUILD_REASON.FILE_MISSING],
    ["the build id is empty", (c) => writeFileSync(join(c.root, ".next", "BUILD_ID"), ""), BUILD_REASON.BUILD_ID_EMPTY],
    ["the build id is blank", (c) => writeFileSync(join(c.root, ".next", "BUILD_ID"), " \n\t"), BUILD_REASON.BUILD_ID_EMPTY],
    // ⚠️ THE LIST IS READ FROM THE BUILD DIRECTORY, SO IT IS NOT TRUSTED TO STAY INSIDE IT.
    ["a path that climbs out", (c) => manifestOf(c, (m) => ({ ...m, files: [...m.files, ".next\\..\\package.json"] })), BUILD_REASON.FILE_OUTSIDE],
    ["a path that climbs out with forward slashes", (c) => manifestOf(c, (m) => ({ ...m, files: [...m.files, ".next/../../outside.json"] })), BUILD_REASON.FILE_OUTSIDE],
    ["a path elsewhere in the checkout", (c) => manifestOf(c, (m) => ({ ...m, files: [...m.files, "app\\page.js"] })), BUILD_REASON.FILE_OUTSIDE],
    ["an absolute path", (c) => manifestOf(c, (m) => ({ ...m, files: [...m.files, join(c.root, "package.json")] })), BUILD_REASON.FILE_OUTSIDE],
    ["the build directory itself", (c) => manifestOf(c, (m) => ({ ...m, files: [...m.files, ".next"] })), BUILD_REASON.FILE_OUTSIDE],
    ["an entry that is not a path", (c) => manifestOf(c, (m) => ({ ...m, files: [...m.files, 7] })), BUILD_REASON.FILE_OUTSIDE],
    ["an empty entry", (c) => manifestOf(c, (m) => ({ ...m, files: [...m.files, ""] })), BUILD_REASON.FILE_OUTSIDE],
  ];
  for (const [name, apply, reason] of cases) {
    const c = await recorded();
    try {
      apply(c);
      assert.deepEqual(validateBuildOutput(c.root), { ok: false, reason }, name);
      assert.equal(reasonOf(c.decide()), reason, name);
    } finally {
      c.remove();
    }
  }

  // ⚠️ A LINK THAT LEADS OUT. Each path is spelled inside the build directory, and is somewhere else.
  const c = await recorded();
  try {
    assert.deepEqual(validateBuildOutput(c.root), { ok: true, buildId: "build-id-one" });
    const outside = join(c.base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "pages-manifest.json"), "{}");
    // A directory on the way that is a link: a junction on Windows, which needs no privilege.
    rmSync(join(c.root, ".next", "server"), { recursive: true });
    symlinkSync(outside, join(c.root, ".next", "server"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(existsSync(join(c.root, ".next", "server", "pages-manifest.json")), true, "the linked file is not reachable, so this proves nothing");
    assert.deepEqual(validateBuildOutput(c.root), { ok: false, reason: BUILD_REASON.FILE_OUTSIDE });
    assert.equal(reasonOf(c.decide()), BUILD_REASON.FILE_OUTSIDE);

    // And a file that is itself a link, where the platform lets one be made.
    rmSync(join(c.root, ".next", "server"), { recursive: true, force: true });
    c.put(".next/server/pages-manifest.json", "{}");
    rmSync(join(c.root, ".next", "routes-manifest.json"));
    let linked = true;
    try {
      symlinkSync(join(outside, "pages-manifest.json"), join(c.root, ".next", "routes-manifest.json"), "file");
    } catch {
      linked = false; // Windows without the privilege to make file links
    }
    if (linked) assert.deepEqual(validateBuildOutput(c.root), { ok: false, reason: BUILD_REASON.FILE_OUTSIDE });
  } finally {
    c.remove();
  }
});

/* ------------------------------------------------------------------ --rebuild through both entry points */

test("⚠️ #184 --rebuild: start-kiln accepts it once and hands it to the browser launcher only", async () => {
  assert.equal(REBUILD_FLAG, "--rebuild");
  assert.deepEqual(parseArgs([]), { selfHost: false, rpc: false, rebuild: false, override: {} });
  assert.deepEqual(parseArgs(["--rebuild"]), { selfHost: false, rpc: false, rebuild: true, override: {} });
  assert.deepEqual(parseArgs(["--rpc", "--rebuild", "--self-host"]), { selfHost: true, rpc: true, rebuild: true, override: {} });
  // ⚠️ TWICE IS A REFUSAL, and so is anything this command does not know.
  assert.match(parseArgs(["--rebuild", "--rebuild"]).error, /^--rebuild was given more than once\./);
  assert.match(parseArgs(["--rpc", "--rebuild", "--rpc", "--rebuild"]).error, /^--rebuild was given more than once\./);
  for (const unknown of ["--rebuild=1", "--Rebuild", "rebuild", "--re-build", "--force"]) assert.match(parseArgs([unknown]).error, /^Unrecognised argument: /, unknown);
  assert.match(parseArgs(["--bogus"]).error, /--rebuild to build the browser shell even when its build could be reused/);
  // The other flags are as they were: a repeated `--rpc` or `--self-host` is still accepted.
  assert.deepEqual(parseArgs(["--rpc", "--rpc"]), { selfHost: false, rpc: true, rebuild: false, override: {} });
  assert.deepEqual(parseArgs(["--self-host", "--self-host"]), { selfHost: true, rpc: false, rebuild: false, override: {} });

  // What the command hands the supervisor, read back through its one seam.
  const base = mkdtempSync(join(tmpdir(), "kiln-rebuild-flag-"));
  mkdirSync(join(base, "project", "planning-content"), { recursive: true });
  writeFileSync(join(base, "project", "planning-content", "project.yaml"), "name: rebuild flag\n");
  const saved = { content: process.env.PLANNING_CONTENT_DIR, exit: process.exit, error: console.error };
  process.env.PLANNING_CONTENT_DIR = join(base, "project", "planning-content");
  console.error = () => {};
  process.exit = () => {
    throw new Error("exit");
  };
  try {
    const handed = async (argv) => {
      let spec = null;
      await startKiln(argv, {
        checkLaunch: async () => ({ selection: { provider: "p", model: "m", thinkingLevel: "off" } }),
        runSupervisor: async (launch) => {
          spec = launch;
          return { trigger: "agent-exit", agentExit: { code: 0, signal: null, observed: true }, shutdown: { launcher: { sentStop: true, endRequested: true, exitObserved: true }, launcherTree: { treeStopped: true } } };
        },
      }).catch((e) => {
        if (e.message !== "exit") throw e;
      });
      assert.ok(spec, `the supervisor was never handed a launch for ${JSON.stringify(argv)}`);
      return spec;
    };
    for (const [argv, rebuild] of [[[], false], [["--rpc"], false], [["--rebuild"], true], [["--rpc", "--rebuild"], true]]) {
      const spec = await handed(argv);
      // ⚠️ TO `start-shell.mjs`, AS ITS ONLY ARGUMENT, AND TO NOTHING ELSE.
      assert.deepEqual(spec.launcher.args, [join(ROOT, "bin", "start-shell.mjs"), ...(rebuild ? ["--rebuild"] : [])], JSON.stringify(argv));
      assert.ok(!spec.agent.args.includes("--rebuild"), `Pi was handed --rebuild for ${JSON.stringify(argv)}`);
      assert.ok(!JSON.stringify(spec.agent).includes("rebuild"));
      // And a structured run still reserves standard output for Pi's protocol.
      assert.equal(spec.structuredStdout === true, argv.includes("--rpc"));
    }
    const plain = await handed([]);
    const forced = await handed(["--rebuild"]);
    assert.deepEqual(forced.agent.args, plain.agent.args, "--rebuild changed what Pi is started with");
  } finally {
    process.exit = saved.exit;
    console.error = saved.error;
    if (saved.content === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved.content;
    rmSync(base, { recursive: true, force: true });
  }
});

test("⚠️ #184 --rebuild: start-shell takes it once, and refuses anything else before it does any work", () => {
  const shell = (args) => spawnSync(process.execPath, [join(ROOT, "bin", "start-shell.mjs"), ...args], { encoding: "utf-8", timeout: 60_000, env: { ...process.env, PORT: "not-a-port" } });
  // ⚠️ REFUSED ON THE ARGUMENT, before the port, the content root, the install or the build are looked at: the port
  // here is not one, and that is not what is reported.
  for (const [args, said] of [
    [["--bogus"], "Unrecognised argument: --bogus"],
    [["--rebuild", "--bogus"], "Unrecognised argument: --bogus"],
    [["--rebuild=1"], "Unrecognised argument: --rebuild=1"],
    [["rebuild"], "Unrecognised argument: rebuild"],
    [["--rpc"], "Unrecognised argument: --rpc"],
    [["--rebuild", "--rebuild"], "--rebuild was given more than once."],
  ]) {
    const run = shell(args);
    assert.equal(run.status, 2, `${JSON.stringify(args)} exited ${run.status}: ${run.stderr}`);
    assert.ok(run.stderr.includes(`[vpw] ${said}`), `${JSON.stringify(args)}: ${run.stderr}`);
    assert.ok(run.stderr.includes("This command takes --rebuild"), run.stderr);
    assert.equal(run.stdout, "", "a refused command line printed something on standard output");
    assert.ok(!run.stderr.includes("PORT"), "the argument was not what was refused");
  }
  // `--rebuild` alone is accepted: what stops this run is the port, which comes next.
  for (const args of [["--rebuild"], []]) {
    const run = shell(args);
    assert.equal(run.status, 2);
    assert.ok(!run.stderr.includes("Unrecognised argument") && !run.stderr.includes("more than once"), `${JSON.stringify(args)}: ${run.stderr}`);
  }
});
