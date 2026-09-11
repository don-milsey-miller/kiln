/**
 * Kiln's owned fields in Pi's project settings — TSK-0029, against ACC-0047 and ACC-0048.
 *
 * ⚠️ **THE CONTENTION TESTS USE PI'S OWN LOCK, AND ONE USES PI ITSELF.** A Pi writer is represented two
 * ways. Where the test must hold the lock for a chosen time, it takes the lock through the exact
 * `proper-lockfile` copy Pi's package resolves, with the options Pi passes. Where the claim is that a real
 * Pi save cannot overwrite Kiln, the pinned SDK's exported `SettingsManager` performs the save in a child
 * process — Pi's own code, its own lock retries, its own field-level merge.
 *
 * ⚠️ **"NOTHING LEFT BEHIND" MEANS NO LOCK AND NO TEMPORARY FILE.** A `<file>.lock` directory or an
 * `atomicWrite` temporary file surviving a refusal is a leak even though the settings bytes are intact, so
 * every refusal path checks for both.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { REFUSAL, SetupRefusal, runTransaction } from "../lib/setup-transaction.mjs";
import { STATE_MODE, ensureProjectId, projectRecordTarget } from "../lib/local-state.mjs";
import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import {
  PROJECT_SESSION_DIR,
  SETTINGS_REFUSAL,
  SKILL_OVERRIDE_PATH,
  SettingsRefusal,
  THINKING_LEVELS,
  applyKilnSettings,
  mergeSettingsText,
  readSettings,
  settingsTarget,
  validateDesired,
} from "../lib/pi-settings.mjs";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PI_DIR = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");

/** The `proper-lockfile` Pi's package itself resolves, so the lock taken here is Pi's lock. */
const piLockfile = createRequire(join(PI_DIR, "package.json"))("proper-lockfile");
const PI_LOCK_OPTIONS = Object.freeze({ realpath: false });

const PORTABLE = "../.planning/pi-package";
const WINDOWS_LITERAL = "..\\.planning\\pi-package";

const DESIRED = Object.freeze({
  stateMode: STATE_MODE.PROJECT,
  provider: "anthropic",
  model: "claude-fable-5",
  thinkingLevel: "medium",
  packageEntry: PORTABLE,
});

const project = ({ pi = true } = {}) => {
  const dir = reapLater(mkdtempSync(join(tmpdir(), "kiln-settings-")));
  if (pi) mkdirSync(join(dir, ".pi"));
  return dir;
};
const settingsFile = (dir) => join(dir, ".pi", "settings.json");
const writeSettings = (dir, text) => writeFileSync(settingsFile(dir), text);
const readText = (dir) => readFileSync(settingsFile(dir), "utf-8");
const json = (o) => JSON.stringify(o, null, 2);

/** Locks and temporary files in `.pi` — neither may survive a finished merge or a refusal. */
const artifacts = (dir) =>
  existsSync(join(dir, ".pi"))
    ? readdirSync(join(dir, ".pi")).filter((n) => n.endsWith(".lock") || n.includes(".vpw-tmp"))
    : [];

const withTx = (dir, body, files = [settingsTarget()]) => runTransaction({ projectRoot: dir, files }, body);
const apply = (dir, desired = DESIRED, options = {}, files = undefined) =>
  withTx(dir, (tx) => applyKilnSettings({ transaction: tx, desired, ...options }), files);

async function refusal(promise, check) {
  try {
    await promise;
  } catch (e) {
    check(e);
    return e;
  }
  assert.fail("expected a refusal, and the operation succeeded");
}

/* ============================================ ACC-0047: preservation ============================ */

test("⚠️ ACC-0047 unrelated keys, their order, and unrelated packages and skills survive the merge", async () => {
  const dir = project();
  const original = {
    theme: "dark",
    packages: ["npm:third-party-a", { source: "git:github.com/example/tools", skills: ["only-this"] }],
    compaction: { enabled: true, reserveTokens: 16384 },
    skills: ["../team-skills"],
    enableSkillCommands: false,
    "vendor.future-setting": { nested: [1, 2, 3] },
  };
  writeSettings(dir, json(original) + "\n");

  const result = await apply(dir);
  assert.equal(result.changed, true);

  const merged = JSON.parse(readText(dir));
  // ⚠️ Existing string keys keep their order; Kiln's absent keys follow them. Integer-like names: see the Pi-order test.
  assert.deepEqual(Object.keys(merged).slice(0, Object.keys(original).length), Object.keys(original));
  for (const key of ["theme", "compaction", "enableSkillCommands", "vendor.future-setting"])
    assert.deepEqual(merged[key], original[key], `${key} must be carried through unchanged`);
  assert.deepEqual(merged.packages, [...original.packages, PORTABLE], "third-party packages keep their place and form");
  assert.deepEqual(merged.skills, ["../team-skills", SKILL_OVERRIDE_PATH], "an unrelated skill path keeps its place");
  assert.equal(merged.defaultProvider, "anthropic");
  assert.equal(merged.defaultModel, "claude-fable-5");
  assert.equal(merged.defaultThinkingLevel, "medium");
  assert.equal(merged.sessionDir, PROJECT_SESSION_DIR);
  assert.deepEqual(artifacts(dir), []);
});

test("⚠️ Kiln's package and skill entries occur exactly once, in either Pi form, and nothing else moves", () => {
  const current = json({
    packages: ["npm:a", { source: PORTABLE, skills: ["kept-filter"] }, "npm:b", PORTABLE, WINDOWS_LITERAL],
    skills: ["../other", SKILL_OVERRIDE_PATH, "../more", SKILL_OVERRIDE_PATH],
  });
  const merged = JSON.parse(mergeSettingsText(current, { ...DESIRED, packageEntryEquivalents: [WINDOWS_LITERAL] }));
  // ⚠️ The first Kiln occurrence keeps its place and its filters; duplicates and the proven literal go.
  assert.deepEqual(merged.packages, ["npm:a", { source: PORTABLE, skills: ["kept-filter"] }, "npm:b"]);
  assert.deepEqual(merged.skills, ["../other", SKILL_OVERRIDE_PATH, "../more"]);

  // A proven-equivalent spelling in object form, first in the list, is corrected in place with its filters kept.
  const literalFirst = json({ packages: [{ source: WINDOWS_LITERAL, extensions: [] }, "npm:c"] });
  assert.deepEqual(
    JSON.parse(mergeSettingsText(literalFirst, { ...DESIRED, packageEntryEquivalents: [WINDOWS_LITERAL] })).packages,
    [{ source: PORTABLE, extensions: [] }, "npm:c"]
  );

  // ⚠️ WITHOUT TSK-0030's DECISION, packages is not Kiln's to touch: no entry supplied, nothing changed.
  const untouched = JSON.parse(mergeSettingsText(json({ packages: [WINDOWS_LITERAL, "npm:d"] }), { ...DESIRED, packageEntry: null }));
  assert.deepEqual(untouched.packages, [WINDOWS_LITERAL, "npm:d"]);
});

/* ============================================ ACC-0047: refusal ================================= */

test("⚠️ ACC-0047 malformed JSON, a non-object root and an invalid Kiln-owned value are refused, the file untouched", async () => {
  const SECRET = "sk-ant-SETTINGS-MALFORMED-PLANTED-7c21";
  const cases = [
    ["malformed", `{ "apiKey": ${SECRET} `],
    ["array root", "[]"],
    ["number root", "42"],
    ["string root", '"text"'],
    ["null root", "null"],
    ["thinking level", json({ defaultThinkingLevel: "turbo" })],
    ["provider type", json({ defaultProvider: 5 })],
    ["empty model", json({ defaultModel: "" })],
    ["packages not an array", json({ packages: { a: 1 } })],
    ["skills not an array", json({ skills: "../x" })],
    ["sessionDir type", json({ sessionDir: 7 })],
  ];

  for (const [label, text] of cases) {
    const dir = project();
    writeSettings(dir, text);
    let bodyRan = false;
    const e = await refusal(
      withTx(dir, async (tx) => {
        bodyRan = true;
        return applyKilnSettings({ transaction: tx, desired: DESIRED });
      }),
      (x) => assert.ok(x instanceof SetupRefusal && x.reason === REFUSAL.MALFORMED, `${label}: got ${x?.reason ?? x}`)
    );
    assert.equal(bodyRan, false, `${label}: refused at plan time, before the merge could run`);
    assert.equal(readText(dir), text, `${label}: the file must be byte-identical`);
    assert.deepEqual(artifacts(dir), [], `${label}: no lock or temporary file`);
    // ⚠️ V8's parser quotes the input; the refusal must not.
    assert.ok(!e.message.includes(SECRET) && !e.message.includes("apiKey"), `${label}: the refusal quotes the file: ${e.message}`);
  }
});

test("the refusal reasons are distinct, name only the key, and unknown fields are kept rather than refused", () => {
  const reasonOf = (text) => {
    try {
      readSettings(text);
    } catch (e) {
      return [e.reason, e.detail.field];
    }
    return null;
  };
  assert.deepEqual(reasonOf("{ nope"), [SETTINGS_REFUSAL.MALFORMED, undefined]);
  assert.deepEqual(reasonOf("[]"), [SETTINGS_REFUSAL.NOT_AN_OBJECT, undefined]);
  assert.deepEqual(reasonOf("null"), [SETTINGS_REFUSAL.NOT_AN_OBJECT, undefined]);
  assert.deepEqual(reasonOf(json({ defaultThinkingLevel: "turbo" })), [SETTINGS_REFUSAL.INVALID_OWNED_VALUE, "defaultThinkingLevel"]);

  // ⚠️ D31: there is no version field to check, and nothing Kiln does not own is refused.
  const unknown = { someFuturePiSetting: { x: 1 }, "third.party": true, schemaVersion: 99 };
  assert.deepEqual(readSettings(json(unknown)), unknown);
  assert.deepEqual(readSettings("\uFEFF{}"), {}, "a byte-order mark is not malformed JSON");
});

test("⚠️ the desired state is validated before anything is created", async () => {
  const bad = [
    ["provider", { provider: "" }],
    ["provider", { provider: " anthropic" }],
    ["model", { model: "claude\nfable" }],
    ["thinkingLevel", { thinkingLevel: "turbo" }],
    ["stateMode", { stateMode: "external" }],
    ["packageEntry", { packageEntry: "/abs/pi-package" }],
    ["packageEntry", { packageEntry: "C:/pi-package" }],
    ["packageEntry", { packageEntry: "C:\\pi-package" }],
    ["packageEntry", { packageEntry: "~/pi-package" }],
    ["packageEntry", { packageEntry: WINDOWS_LITERAL }],
    ["packageEntry", { packageEntry: "pi-package" }],
    ["packageEntryEquivalents", { packageEntry: null, packageEntryEquivalents: [WINDOWS_LITERAL] }],
  ];
  for (const [field, override] of bad) {
    const dir = project({ pi: false });
    const e = await refusal(apply(dir, { ...DESIRED, ...override }), (x) =>
      assert.ok(x instanceof SettingsRefusal && x.reason === SETTINGS_REFUSAL.INVALID_DESIRED, `${JSON.stringify(override)}: ${x?.reason ?? x}`)
    );
    assert.equal(e.detail.field, field);
    assert.equal(existsSync(join(dir, ".pi")), false, `${JSON.stringify(override)}: nothing may be created for a request that cannot be written`);
  }
  for (const level of THINKING_LEVELS) assert.equal(validateDesired({ ...DESIRED, thinkingLevel: level }).thinkingLevel, level);
});

/* ============================================ newline, stability, session dir =================== */

test("⚠️ an existing trailing-newline style is kept, and a new file has none", async () => {
  for (const [label, trailing] of [
    ["LF", "\n"],
    ["none", ""],
    ["CRLF", "\r\n"],
  ]) {
    const dir = project();
    writeSettings(dir, json({ theme: "light" }) + trailing);
    await apply(dir);
    const text = readText(dir);
    if (trailing === "") assert.equal(/\s$/.test(text), false, label);
    else assert.ok(text.endsWith(trailing) && !text.endsWith(trailing + trailing), `${label}: ${JSON.stringify(text.slice(-4))}`);
  }

  const fresh = project({ pi: false });
  await apply(fresh);
  assert.equal(/\s$/.test(readText(fresh)), false, "a new file ends without a newline, as Pi writes it");
});

test("⚠️ ACC-0047 applying the same desired state again changes no bytes and no modification time", async () => {
  const dir = project();
  writeSettings(dir, json({ theme: "dark", packages: ["npm:x"] }) + "\n");
  assert.equal((await apply(dir)).changed, true);
  const bytes = readFileSync(settingsFile(dir));
  const mtime = statSync(settingsFile(dir)).mtimeMs;

  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await apply(dir)).changed, false, "the second application reports no change");
  assert.deepEqual(readFileSync(settingsFile(dir)), bytes, "and the bytes are identical");
  assert.equal(statSync(settingsFile(dir)).mtimeMs, mtime, "and the file was not touched");
  assert.deepEqual(artifacts(dir), []);

  // ⚠️ "Nothing to do" is decided on content: the desired state in a different layout is not rewritten.
  const indented = project();
  const four = JSON.stringify(JSON.parse(mergeSettingsText(null, DESIRED)), null, 4);
  writeSettings(indented, four);
  assert.equal((await apply(indented)).changed, false);
  assert.equal(readText(indented), four);
});

test("⚠️ sessionDir is .pi/sessions in project mode and absent in external mode", () => {
  assert.equal(JSON.parse(mergeSettingsText(null, DESIRED)).sessionDir, PROJECT_SESSION_DIR);

  const external = { ...DESIRED, stateMode: STATE_MODE.USER };
  const removed = JSON.parse(mergeSettingsText(json({ theme: "dark", sessionDir: join(tmpdir(), "x", "sessions"), after: 1 }), external));
  assert.equal(Object.hasOwn(removed, "sessionDir"), false, "external mode removes the owned key");
  assert.deepEqual(Object.keys(removed).slice(0, 2), ["theme", "after"], "and the keys around it keep their order");

  assert.equal(Object.hasOwn(JSON.parse(mergeSettingsText(json({ theme: "dark" }), external)), "sessionDir"), false);
});

/* ============================================ fresh files and refusals ========================== */

test("⚠️ a fresh file is created under the lock, and a refusal on a fresh project leaves nothing behind", async () => {
  const dir = project({ pi: false });
  let lockedDuringMerge = false;
  const result = await apply(dir, DESIRED, {
    onLockAcquired: async ({ path }) => {
      lockedDuringMerge = existsSync(`${path}.lock`);
    },
  });
  assert.equal(result.changed, true);
  assert.equal(lockedDuringMerge, true, "the lock was held while the merge ran");
  assert.deepEqual(artifacts(dir), [], "and released afterwards, with no temporary file");
  assert.equal(existsSync(join(dir, ".planning-init.lock")), false, "the transaction lock is released too");

  const failing = project({ pi: false });
  await refusal(
    apply(failing, DESIRED, {
      onLockAcquired: async () => {
        throw new Error("failure while holding the lock");
      },
    }),
    (e) => assert.ok(e instanceof Error)
  );
  assert.equal(existsSync(join(failing, ".pi")), false, "the directory created only to hold the lock is removed");
});

test("a merge outside a live transaction, or of an unplanned file, is refused before anything is created", async () => {
  await refusal(applyKilnSettings({ transaction: { plan: {} }, desired: DESIRED }), (e) =>
    assert.equal(e.reason, SETTINGS_REFUSAL.NO_LEASE)
  );

  let finished = null;
  await withTx(project({ pi: false }), async (tx) => {
    finished = tx;
  });
  await refusal(applyKilnSettings({ transaction: finished, desired: DESIRED }), (e) =>
    assert.equal(e.reason, SETTINGS_REFUSAL.NO_LEASE)
  );

  const unplanned = project({ pi: false });
  await refusal(apply(unplanned, DESIRED, {}, [projectRecordTarget()]), (e) => assert.equal(e.reason, SETTINGS_REFUSAL.NOT_PLANNED));
  assert.equal(existsSync(join(unplanned, ".pi")), false);
});

/* ============================================ contention with Pi's lock ========================= */

test("⚠️ a Pi writer holding its lock is waited for, and its write survives: Kiln refuses instead of overwriting", async () => {
  const dir = project();
  writeSettings(dir, json({ theme: "dark" }));
  const path = settingsFile(dir);
  const piWrite = json({ theme: "dark", piSavedThis: true });
  let released = false;

  await refusal(
    withTx(dir, async (tx) => {
      // ⚠️ Taken AFTER the transaction planned, so the plan recorded the file as it was before Pi's write.
      piLockfile.lockSync(path, PI_LOCK_OPTIONS);
      const timer = setTimeout(() => {
        writeFileSync(path, piWrite, "utf-8"); // Pi writes in place under its lock
        piLockfile.unlockSync(path, PI_LOCK_OPTIONS);
        released = true;
      }, 100);
      try {
        return await applyKilnSettings({
          transaction: tx,
          desired: DESIRED,
          lockRetries: { retries: 60, factor: 1, minTimeout: 25, maxTimeout: 25 },
        });
      } finally {
        clearTimeout(timer);
        if (!released)
          try {
            piLockfile.unlockSync(path, PI_LOCK_OPTIONS);
          } catch {
            /* already released */
          }
      }
    }),
    (e) => assert.ok(e instanceof SetupRefusal && e.reason === REFUSAL.CONCURRENT_EDIT, `got ${e?.reason ?? e}`)
  );

  assert.equal(released, true, "Kiln waited for Pi's lock instead of writing while Pi held it");
  assert.equal(readText(dir), piWrite, "Pi's write is what remains");
  assert.deepEqual(artifacts(dir), [], "no lock or temporary file is left");
});

test("⚠️ a lock Pi keeps holding is a refusal, not a write around it, and Pi's lock stays Pi's", async () => {
  const dir = project();
  const before = json({ theme: "dark" });
  writeSettings(dir, before);
  const path = settingsFile(dir);

  piLockfile.lockSync(path, PI_LOCK_OPTIONS);
  try {
    await refusal(
      apply(dir, DESIRED, { lockRetries: { retries: 3, factor: 1, minTimeout: 20, maxTimeout: 20 } }),
      (e) => assert.ok(e instanceof SettingsRefusal && e.reason === SETTINGS_REFUSAL.LOCKED, `got ${e?.reason ?? e}`)
    );
    assert.equal(readText(dir), before, "the file is unchanged");
    assert.deepEqual(readdirSync(join(dir, ".pi")).filter((n) => n.includes(".vpw-tmp")), [], "no temporary file");
    assert.equal(existsSync(`${path}.lock`), true, "the lock still present is Pi's, and Kiln did not remove it");
  } finally {
    piLockfile.unlockSync(path, PI_LOCK_OPTIONS);
  }
  assert.deepEqual(artifacts(dir), []);
});

/** A real Pi project-settings save, through the pinned SDK's exported SettingsManager. */
const PI_SAVE = [
  "const [sdkUrl, cwd, agentDir] = process.argv.slice(-3);",
  "const { SettingsManager } = await import(sdkUrl);",
  "const manager = SettingsManager.create(cwd, agentDir);",
  "const current = manager.getProjectSettings();",
  "manager.setProjectPackages([...(current.packages ?? []), 'npm:pi-saved-package']);",
  "await manager.flush();",
  "process.stdout.write(JSON.stringify({ errorCount: manager.drainErrors().length }));",
].join("\n");

test("⚠️ a real Pi save that meets Kiln's lock writes nothing, and a later Pi save keeps Kiln's fields", async () => {
  const dir = project();
  const agentDir = reapLater(mkdtempSync(join(tmpdir(), "kiln-pi-agent-")));
  writeSettings(dir, json({ theme: "dark", packages: ["npm:third-party"] }));
  const sdkUrl = resolvePinnedSdk(ROOT).url;

  const piSave = () => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", PI_SAVE, sdkUrl, dir, agentDir], {
      encoding: "utf-8",
      timeout: 60_000,
    });
    assert.equal(r.status, 0, `the Pi save process failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };

  let during = null;
  let bytesAroundPi = null;
  await apply(dir, DESIRED, {
    onLockAcquired: async () => {
      const before = readText(dir);
      during = piSave();
      bytesAroundPi = [before, readText(dir)];
    },
  });

  // ⚠️ PI'S OWN CODE MET KILN'S LOCK: it could not take it, recorded why, and wrote nothing.
  assert.ok(during.errorCount > 0, "Pi must have reported that it could not take the lock");
  assert.equal(bytesAroundPi[1], bytesAroundPi[0], "Pi wrote nothing while Kiln held the lock");
  const afterKiln = JSON.parse(readText(dir));
  assert.ok(afterKiln.packages.includes(PORTABLE) && afterKiln.packages.includes("npm:third-party"));

  // With the lock free, Pi's save lands — and Kiln's fields and the third party's entry survive it.
  const later = piSave();
  assert.equal(later.errorCount, 0, "with the lock free, Pi's save succeeds");
  const final = JSON.parse(readText(dir));
  assert.ok(final.packages.includes("npm:pi-saved-package"), "Pi's write landed");
  assert.ok(final.packages.includes(PORTABLE) && final.packages.includes("npm:third-party"), "Kiln's entry and the third party's survived");
  for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel", "sessionDir", "skills", "theme"])
    assert.deepEqual(final[key], afterKiln[key], `${key} survived Pi's save`);
  assert.deepEqual(artifacts(dir), []);
});

test("⚠️ Pi's lock is held at the moment the settings file is atomically replaced", async () => {
  // ⚠️ **THE HOOK TESTS CANNOT SEE THIS WINDOW, AND THIS ONE CAN.** A lock released after the hook but before
  // `tx.merge` would still pass every test that looks during the hook, while no longer covering the identity
  // check or the write. So the rename that puts the file in place is observed directly: `atomicWrite` imports
  // `renameSync` from `node:fs`, and `syncBuiltinESMExports` makes a wrapper visible to that import.
  const dir = project();
  writeSettings(dir, json({ theme: "dark" }));
  const nodeFs = createRequire(import.meta.url)("node:fs");
  const originalRename = nodeFs.renameSync;
  const lockPresentAtReplace = [];
  nodeFs.renameSync = function (from, to) {
    if (String(to).endsWith("settings.json")) lockPresentAtReplace.push(existsSync(`${to}.lock`));
    return originalRename.apply(this, arguments);
  };
  syncBuiltinESMExports();
  try {
    assert.equal((await apply(dir)).changed, true);
  } finally {
    nodeFs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
  assert.deepEqual(lockPresentAtReplace, [true], "the lock was held when the file was replaced, and there was one replacement");
  assert.deepEqual(artifacts(dir), [], "and released afterwards");
});

/* ============================================ key order against Pi's own save =================== */

/** Keys at one indentation depth in the order the text writes them, which a parse would reorder. */
const writtenKeys = (text, depth) => [...text.matchAll(new RegExp(`^ {${2 * depth}}"([^"]+)":`, "gm"))].map((m) => m[1]);

test("⚠️ ACC-0047 integer-like keys keep their values and take the order Pi's own save gives them, not their textual position", async () => {
  // Interleaved on purpose: integer-like names between string keys, "01" (not integer-like), and the same mix nested.
  const text = [
    "{",
    '  "theme": "dark",',
    '  "10": "ten",',
    '  "01": "zero-one",',
    '  "nested": {',
    '    "b": 1,',
    '    "2": "two",',
    '    "a": 3,',
    '    "1": "one"',
    "  },",
    '  "2": "two",',
    '  "zeta": true,',
    '  "1": "one"',
    "}",
  ].join("\n");
  const original = JSON.parse(text);
  const textual = writtenKeys(text, 1);
  assert.deepEqual(textual, ["theme", "10", "01", "nested", "2", "zeta", "1"], "the fixture's own textual order");

  const kilnDir = project();
  writeSettings(kilnDir, text);
  await apply(kilnDir);
  const kilnText = readText(kilnDir);

  // Pi's own save of the identical file, through the pinned SDK.
  const piDir = project();
  writeSettings(piDir, text);
  const agentDir = reapLater(mkdtempSync(join(tmpdir(), "kiln-pi-agent-")));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", PI_SAVE, resolvePinnedSdk(ROOT).url, piDir, agentDir], {
    encoding: "utf-8",
    timeout: 60_000,
  });
  assert.equal(r.status, 0, `the Pi save process failed: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).errorCount, 0, "Pi's save succeeded");
  const piText = readText(piDir);

  const kiln = JSON.parse(kilnText);
  for (const key of textual) assert.deepEqual(kiln[key], original[key], `${key} keeps its value`);

  const unrelated = (keys) => keys.filter((k) => textual.includes(k));
  assert.deepEqual(unrelated(writtenKeys(kilnText, 1)), unrelated(writtenKeys(piText, 1)), "Kiln writes the unrelated keys in the order Pi's save writes them");
  assert.deepEqual(
    unrelated(writtenKeys(kilnText, 1)),
    ["1", "2", "10", "theme", "01", "nested", "zeta"],
    "integer-like names first in ascending order, then string keys in their textual order"
  );
  assert.deepEqual(writtenKeys(kilnText, 2), writtenKeys(piText, 2), "and one level down");
  assert.deepEqual(writtenKeys(kilnText, 2), ["1", "2", "b", "a"]);
  assert.notDeepEqual(unrelated(writtenKeys(kilnText, 1)), textual, "integer-like names do not keep their textual position");
});

/* ============================================ releasing Kiln's lock ============================= */

/** Kiln's own `proper-lockfile`. Pi resolves a separate nested copy, so replacing this one leaves Pi's alone. */
const kilnLockfile = createRequire(import.meta.url)("proper-lockfile");

/**
 * Run `body` with each release Kiln receives replaced by `makeRelease(realRelease)`, and `afterLock` — when
 * given — called with the options Kiln passed, which is how a test reaches its `onCompromised`. The real lock
 * is released afterwards either way, so a simulated failure never leaks a lock into the next test.
 */
async function withRelease(makeRelease, body, afterLock = null) {
  const original = kilnLockfile.lock;
  const real = [];
  kilnLockfile.lock = async (file, options) => {
    const release = await original.call(kilnLockfile, file, options);
    real.push(release);
    if (afterLock) afterLock(options);
    return makeRelease(release);
  };
  try {
    return await body();
  } finally {
    kilnLockfile.lock = original;
    for (const release of real) await release().catch((e) => assert.equal(e.code, "ERELEASED"));
  }
}

const failingRelease = () => async () => {
  throw Object.assign(new Error("simulated release failure"), { code: "EPERM" });
};
const noOpRelease = () => async () => {};
const isCleanupRefusal = (label) => (r) =>
  assert.ok(r instanceof SettingsRefusal && r.reason === SETTINGS_REFUSAL.LOCK_CLEANUP_FAILED, `${label}: got ${r?.reason ?? r}`);

test("⚠️ a release that fails after a successful merge is a cleanup refusal, not a success", async () => {
  const dir = project();
  writeSettings(dir, json({ theme: "dark" }));
  let lockAtRefusal = null;
  const e = await withRelease(failingRelease, async () => {
    const refused = await refusal(apply(dir), isCleanupRefusal("after success"));
    lockAtRefusal = existsSync(`${settingsFile(dir)}.lock`);
    return refused;
  });
  assert.equal(lockAtRefusal, true, "the lock really was still there when the refusal was raised");
  assert.deepEqual(e.detail, { step: "lock-release-failed" }, "nothing failed before the release, so there is no priorReason");
  assert.equal(JSON.parse(readText(dir)).defaultProvider, "anthropic", "the merge itself landed; what is refused is the lock");
  assert.ok(!e.message.includes("simulated") && !e.message.includes(dir), `the refusal quotes the release error or a path: ${e.message}`);
  assert.deepEqual(artifacts(dir), []);
});

test("⚠️ a release that fails after an earlier refusal keeps that refusal's code as priorReason, never its message", async () => {
  const SECRET = "sk-ant-PRIOR-FAILURE-PLANTED-41f0";
  const cases = [
    {
      label: "concurrent edit",
      onLockAcquired: async ({ path }) => writeFileSync(path, json({ theme: "edited by someone else" })),
      priorReason: REFUSAL.CONCURRENT_EDIT,
    },
    {
      label: "unexpected error",
      onLockAcquired: async () => {
        throw new Error(`failure carrying ${SECRET}`);
      },
      priorReason: "unexpected-error",
    },
  ];
  for (const { label, onLockAcquired, priorReason } of cases) {
    const dir = project();
    writeSettings(dir, json({ theme: "dark" }));
    const e = await withRelease(failingRelease, () => refusal(apply(dir, DESIRED, { onLockAcquired }), isCleanupRefusal(label)));
    assert.deepEqual(e.detail, { step: "lock-release-failed", priorReason }, label);
    assert.ok(!e.message.includes(SECRET) && !e.message.includes("simulated"), `${label}: ${e.message}`);
    assert.equal(JSON.parse(readText(dir)).defaultProvider, undefined, `${label}: the earlier refusal still stopped the merge`);
    assert.deepEqual(artifacts(dir), [], label);
  }
});

test("⚠️ a release that returns without removing Kiln's lock is detected, and a lock another writer takes afterwards is not", async () => {
  const afterSuccess = project();
  writeSettings(afterSuccess, json({ theme: "dark" }));
  const e1 = await withRelease(noOpRelease, () => refusal(apply(afterSuccess), isCleanupRefusal("after success")));
  assert.deepEqual(e1.detail, { step: "lock-left-behind" });

  const afterRefusal = project();
  writeSettings(afterRefusal, json({ theme: "dark" }));
  const failFirst = {
    onLockAcquired: async () => {
      throw new Error("earlier failure");
    },
  };
  const e2 = await withRelease(noOpRelease, () => refusal(apply(afterRefusal, DESIRED, failFirst), isCleanupRefusal("after refusal")));
  assert.deepEqual(e2.detail, { step: "lock-left-behind", priorReason: "unexpected-error" });
  for (const dir of [afterSuccess, afterRefusal]) assert.deepEqual(artifacts(dir), []);

  // ⚠️ POSITIVE CONTROL: Pi takes its lock the moment Kiln's is gone. The directory at that path is Pi's, not Kiln's leftover.
  const handedOver = project();
  writeSettings(handedOver, json({ theme: "dark" }));
  const path = settingsFile(handedOver);
  try {
    const result = await withRelease(
      (release) => async () => {
        await release();
        piLockfile.lockSync(path, PI_LOCK_OPTIONS);
      },
      () => apply(handedOver)
    );
    assert.equal(result.changed, true, "Pi's lock taken after Kiln's release is not reported as Kiln's");
    assert.equal(existsSync(`${path}.lock`), true, "and it is left in place for Pi");
  } finally {
    try {
      piLockfile.unlockSync(path, PI_LOCK_OPTIONS);
    } catch {
      /* Pi never took it; the assertions above say why */
    }
  }
  assert.deepEqual(artifacts(handedOver), []);
});

test("⚠️ a lock lost before the merge writes nothing, and releasing it does not replace that refusal", async () => {
  const SECRET = "sk-ant-COMPROMISE-PLANTED-9d3c";
  // ⚠️ Kiln's own onCompromised, invoked the moment the lock is taken: the loss is certain and its timing is not a race.
  const compromise = (options) => options.onCompromised(new Error(`lock lost carrying ${SECRET}`));

  const cases = [
    ["a release that succeeds", (release) => release],
    [
      // What proper-lockfile itself does once it has given a compromised lock up.
      "proper-lockfile reporting ERELEASED",
      (release) => async () => {
        await release();
        throw Object.assign(new Error("Lock is already released"), { code: "ERELEASED" });
      },
    ],
  ];

  for (const [label, makeRelease] of cases) {
    const dir = project();
    const before = json({ theme: "dark" });
    writeSettings(dir, before);
    const e = await withRelease(
      makeRelease,
      () =>
        refusal(apply(dir), (r) =>
          assert.ok(r instanceof SettingsRefusal && r.reason === SETTINGS_REFUSAL.LOCK_COMPROMISED, `${label}: got ${r?.reason ?? r}`)
        ),
      compromise
    );
    assert.deepEqual(e.detail, { when: "before-merge" }, `${label}: the loss was seen before the merge, not after it`);
    assert.equal(readText(dir), before, `${label}: the file is byte-identical, so the merge never ran`);
    assert.deepEqual(artifacts(dir), [], `${label}: no lock or temporary file survives`);
    assert.ok(!e.message.includes(SECRET) && !e.message.includes(dir), `${label}: the refusal quotes the error or a path: ${e.message}`);
  }
});

test("⚠️ a lock lost while the merge writes is refused, and the write it completed is not rolled back", async () => {
  // ⚠️ **THE ONLY MOMENT THAT IS ACTUALLY THE WRITE WINDOW.** The compromise has to land after the identity
  // check and the atomic replacement, which no hook around `tx.merge` can reach. The rename that puts the file
  // in place is the seam: it runs for real, and Kiln's own `onCompromised` is invoked before it returns.
  const SECRET = "sk-ant-DURING-MERGE-PLANTED-6b17";
  const dir = project();
  writeSettings(dir, json({ theme: "dark" }));

  let onCompromised = null;
  let renames = 0;
  const nodeFs = createRequire(import.meta.url)("node:fs");
  const originalRename = nodeFs.renameSync;
  nodeFs.renameSync = function (from, to) {
    const result = originalRename.apply(this, arguments);
    if (String(to).endsWith("settings.json") && onCompromised) {
      renames += 1;
      onCompromised(new Error(`lock lost carrying ${SECRET}`));
    }
    return result;
  };
  syncBuiltinESMExports();

  let e;
  try {
    e = await withRelease(
      (release) => release,
      () =>
        refusal(apply(dir), (r) =>
          assert.ok(r instanceof SettingsRefusal && r.reason === SETTINGS_REFUSAL.LOCK_COMPROMISED, `got ${r?.reason ?? r}`)
        ),
      (options) => {
        onCompromised = options.onCompromised;
      }
    );
  } finally {
    nodeFs.renameSync = originalRename;
    syncBuiltinESMExports();
  }

  assert.equal(renames, 1, "the merge replaced the file once, and the lock was lost at that moment");
  assert.deepEqual(e.detail, { when: "during-merge" }, "the loss was seen after the write, not before it");
  assert.equal(JSON.parse(readText(dir)).defaultProvider, "anthropic", "the write that completed is reported, not rolled back");
  assert.deepEqual(artifacts(dir), [], "no temporary file, and no lock of Kiln's");
  assert.ok(!e.message.includes(SECRET) && !e.message.includes(dir), `the refusal quotes the error or a path: ${e.message}`);
});

test("⚠️ a directory another writer put a file into is never removed, and one that cannot be removed is reported", async () => {
  // Kiln created .pi only to hold the lock, and another writer put a file there before the merge failed.
  const shared = project({ pi: false });
  const theirs = join(shared, ".pi", "other-writer.json");
  await refusal(
    apply(shared, DESIRED, {
      onLockAcquired: async () => {
        writeFileSync(theirs, "{}");
        throw new Error("earlier failure");
      },
    }),
    (e) => assert.equal(e.message, "earlier failure", "a directory that is not empty is not a cleanup failure")
  );
  assert.equal(readFileSync(theirs, "utf-8"), "{}", "the other writer's file, and so its directory, survive");
  assert.deepEqual(artifacts(shared), []);

  // An empty directory that cannot be removed is a cleanup refusal, not a silent leftover.
  const stuck = project({ pi: false });
  const nodeFs = createRequire(import.meta.url)("node:fs");
  const originalRmdir = nodeFs.rmdirSync;
  try {
    const e = await refusal(
      apply(stuck, DESIRED, {
        onLockAcquired: async ({ path }) => {
          // Armed only now, so the transaction's own plan-time probes are unaffected.
          const target = dirname(path);
          nodeFs.rmdirSync = function (p, ...rest) {
            if (p === target) throw Object.assign(new Error("simulated busy directory"), { code: "EBUSY" });
            return originalRmdir.call(this, p, ...rest);
          };
          syncBuiltinESMExports();
          throw new Error("earlier failure");
        },
      }),
      isCleanupRefusal("directory")
    );
    assert.deepEqual(e.detail, { step: "directory-not-removed", priorReason: "unexpected-error" });
  } finally {
    nodeFs.rmdirSync = originalRmdir;
    syncBuiltinESMExports();
  }
  assert.deepEqual(artifacts(stuck), [], "the lock itself was released");
});

/* ============================================ ACC-0048: no secret, no machine path =============== */

const SECRETS = Object.freeze({
  ANTHROPIC_API_KEY: "sk-ant-KILN-SETTINGS-PLANTED-5e8a",
  TAVILY_API_KEY: "tvly-KILN-SETTINGS-PLANTED-b2d4",
});

function fingerprints(value) {
  const hash = (alg) => createHash(alg).update(value).digest("hex");
  return [
    ["value", value],
    ["sha256", hash("sha256")],
    ["sha256-prefix", hash("sha256").slice(0, 12)],
    ["sha1", hash("sha1")],
    ["md5", hash("md5")],
    ["base64", Buffer.from(value).toString("base64")],
    ["base64url", Buffer.from(value).toString("base64url")],
    ["tail", value.slice(-6)],
    ["reversed", [...value].reverse().join("")],
  ];
}

const leaksSecret = (text) => Object.values(SECRETS).some((s) => fingerprints(s).some(([, fp]) => text.includes(fp)));

/** A path in every spelling a JSON file could hold it: raw, JSON-escaped, and with forward slashes. */
const spellings = (p) => [p, JSON.stringify(p).slice(1, -1), p.replace(/\\/g, "/")];
const leaksPath = (text, dir) =>
  /[A-Za-z]:[\\/]|\/home\/|\/Users\/|AppData|XDG_/.test(text) ||
  /"~|~\//.test(text) ||
  [dir, homedir(), tmpdir()].some((p) => spellings(p).some((s) => text.includes(s)));

test("⚠️ ACC-0048 the merge and ensureProjectId write no credential, fingerprint, absolute path or ~ reference", async () => {
  const dir = project();

  // ⚠️ POSITIVE CONTROLS: each detector sees exactly what it exists to see.
  for (const secret of Object.values(SECRETS))
    for (const [kind, fp] of fingerprints(secret)) assert.ok(leaksSecret(`x${fp}x`), `the detector must see a ${kind}`);
  const absoluteSession = join(dir, ".pi", "sessions");
  assert.ok(leaksPath(JSON.stringify({ sessionDir: absoluteSession }), dir), "the detector must see an absolute path in JSON");
  assert.ok(leaksPath('{"skills":["~/skills"]}', dir), "the detector must see a ~ reference");

  // The input carries an absolute session path; external mode must remove it.
  const input = json({ theme: "dark", sessionDir: absoluteSession });
  assert.ok(leaksPath(input, dir), "the input really does carry an absolute path");
  writeSettings(dir, input);

  const saved = Object.fromEntries(Object.keys(SECRETS).map((k) => [k, process.env[k]]));
  let secretsWerePresent = false;
  try {
    Object.assign(process.env, SECRETS);
    await withTx(
      dir,
      async (tx) => {
        await applyKilnSettings({
          transaction: tx,
          desired: { ...DESIRED, stateMode: STATE_MODE.USER },
          onLockAcquired: async () => {
            secretsWerePresent = Object.entries(SECRETS).every(([k, v]) => process.env[k] === v);
          },
        });
        await ensureProjectId({ transaction: tx, randomBytes });
      },
      [settingsTarget(), projectRecordTarget()]
    );
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
  assert.equal(secretsWerePresent, true, "the planted credentials were in the environment while the merge ran");

  const outputs = {
    "settings.json (external mode)": readText(dir),
    "kiln.json": readFileSync(join(dir, ".pi", "kiln.json"), "utf-8"),
    "settings.json (project mode, fresh)": mergeSettingsText(null, DESIRED),
  };
  for (const [label, text] of Object.entries(outputs)) {
    assert.equal(leaksSecret(text), false, `${label} carries a planted credential or its fingerprint`);
    assert.equal(leaksPath(text, dir), false, `${label} carries an absolute path or ~ reference: ${text}`);
  }
});

/* ============================================ agreement and structure =========================== */

test("THINKING_LEVELS is exactly the pinned Pi package's list", () => {
  const chunks = join(PI_DIR, "dist", "bundle", "chunks");
  let found = null;
  for (const name of readdirSync(chunks)) {
    if (!name.endsWith(".js")) continue;
    const m = readFileSync(join(chunks, name), "utf-8").match(/VALID_THINKING_LEVELS=\[([^\]]*)\]/);
    if (m) {
      found = JSON.parse(`[${m[1]}]`);
      break;
    }
  }
  assert.ok(found, "VALID_THINKING_LEVELS was not found in the pinned package");
  assert.deepEqual([...THINKING_LEVELS], found);
});

test("the module reads no environment and uses Pi's lock library, never Pi's storage", () => {
  const code = readFileSync(join(ROOT, "lib", "pi-settings.mjs"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/process\s*\.\s*env/.test(code), "no environment is read");
  assert.ok(!/@earendil-works|FileSettingsStorage/.test(code), "Pi's unexported storage is not imported");
  assert.match(code, /from "proper-lockfile"/, "the lock is proper-lockfile, the library Pi's lock uses");
});
