/**
 * The project's trust decision — TSK-0032, against ACC-0051.
 *
 * ⚠️ **EVERY CASE POINTS AT A TEMPORARY AGENT DIRECTORY, AND ONE CASE PROVES WHY.** Pi's own default
 * agent directory is the operator's `~/.pi/agent`, and this store writes into it. A test that let the
 * module default would edit the trust store of whoever ran the suite — on their own machine, for their
 * own projects — so the module has no default at all, and the case below proves it with a factory that
 * throws if it is ever called and a count that stays at zero. Nothing here reads the operator's store:
 * proving a file was not touched by opening it is a strange way to respect it.
 *
 * ⚠️ **THE STORE IS PI'S OWN, RUNNING FOR REAL.** These tests use the exported `ProjectTrustStore`
 * from the pinned package through the module under test. Nothing here fakes it: the claim is about
 * what Pi records and reads back, and a stub would assert only that this file agrees with itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import { TRUST, TRUST_REFUSAL, TrustRefusal, denyTrust, grantTrust, readTrust, revokeTrust } from "../lib/pi-trust.mjs";

installReaper();

const ROOT = process.cwd();
const WINDOWS = process.platform === "win32";

/** A temporary Pi agent directory. Never the operator's. */
const agentDir = () => reapLater(mkdtempSync(join(tmpdir(), "kiln-trust-agent-")));

/** A project directory with a nested child, so `..` has somewhere to come back from. */
const project = () => {
  const dir = reapLater(mkdtempSync(join(tmpdir(), "kiln-trust-project-")));
  mkdirSync(join(dir, "sub"));
  return dir;
};

async function refusal(promise, check) {
  try {
    await promise;
  } catch (e) {
    check(e);
    return e;
  }
  assert.fail("expected a refusal, and the operation succeeded");
}

/* ============================================ the three states ================================== */

test("⚠️ ACC-0051 a project nobody has been asked about reads as missing, not as denied", async () => {
  const agent = agentDir();
  const dir = project();

  const read = await readTrust({ projectRoot: dir, agentDir: agent, toolRoot: ROOT });
  assert.equal(read.state, TRUST.MISSING);
  assert.equal(read.recordedFor, null, "nothing was recorded, so no path answered for it");
  assert.notEqual(TRUST.MISSING, TRUST.DENIED, "the two are different answers and must stay different values");

  // ⚠️ AND READING CREATED NOTHING. A read that wrote a default would be the defaulting AST-0042 warns about.
  assert.deepEqual(readdirSync(agent), [], "reading a decision writes nothing into the agent directory");
});

test("⚠️ ACC-0051 grant, deny and revoke each land, read back through a fresh store", async () => {
  const agent = agentDir();
  const dir = project();
  const where = { projectRoot: dir, agentDir: agent, toolRoot: ROOT };
  const state = async () => (await readTrust(where)).state;

  const granted = await grantTrust(where);
  assert.equal(granted.state, TRUST.APPROVED);
  assert.equal(granted.changed, true, "it was missing before");
  assert.equal(await state(), TRUST.APPROVED, "and a separate read agrees");

  const denied = await denyTrust(where);
  assert.equal(denied.state, TRUST.DENIED);
  assert.equal(denied.changed, true, "approved became denied");
  assert.equal(await state(), TRUST.DENIED);

  const revoked = await revokeTrust(where);
  assert.equal(revoked.state, TRUST.MISSING, "revocation leaves a project nobody has been asked about");
  assert.equal(revoked.changed, true);
  assert.equal(await state(), TRUST.MISSING);

  // Re-granting after a revocation is a change again; re-granting an approval is not.
  assert.equal((await grantTrust(where)).changed, true);
  assert.equal((await grantTrust(where)).changed, false, "the same decision twice changes nothing");
});

test("⚠️ ACC-0051 a denial and an absent decision stay distinguishable, in the state and in the record", async () => {
  const agent = agentDir();
  const denied = project();
  const untouched = project();
  const at = (dir) => ({ projectRoot: dir, agentDir: agent, toolRoot: ROOT });

  await denyTrust(at(denied));

  const deniedRead = await readTrust(at(denied));
  const missingRead = await readTrust(at(untouched));

  assert.equal(deniedRead.state, TRUST.DENIED);
  assert.equal(missingRead.state, TRUST.MISSING);
  assert.notEqual(deniedRead.state, missingRead.state);
  assert.ok(deniedRead.recordedFor, "a denial names the path it was recorded against");
  assert.equal(missingRead.recordedFor, null, "an unasked project has no record to name");
});

/* ============================================ the canonical key ================================= */

test("⚠️ ACC-0051 equivalent spellings of one project share one decision", async () => {
  const agent = agentDir();
  const dir = project();

  const spellings = [dir, `${dir}${sep}`, `${dir}${sep}.`, join(dir, "sub", "..")];

  const granted = await grantTrust({ projectRoot: dir, agentDir: agent, toolRoot: ROOT });
  const canonical = granted.projectRoot;

  for (const spelling of spellings) {
    const read = await readTrust({ projectRoot: spelling, agentDir: agent, toolRoot: ROOT });
    assert.equal(read.state, TRUST.APPROVED, `${spelling} must share the decision`);
    assert.equal(read.projectRoot, canonical, `${spelling} must canonicalise to the one directory`);
  }

  // ⚠️ AND A DENIAL THROUGH ANOTHER SPELLING REPLACES IT rather than sitting beside it as a second row.
  await denyTrust({ projectRoot: join(dir, "sub", ".."), agentDir: agent, toolRoot: ROOT });
  for (const spelling of spellings)
    assert.equal(
      (await readTrust({ projectRoot: spelling, agentDir: agent, toolRoot: ROOT })).state,
      TRUST.DENIED,
      `${spelling} must see the replacement, not a second decision`
    );
});

test("⚠️ ACC-0051 the canonical key is Pi's own rule, including where that rule is case-sensitive", async () => {
  // ⚠️ **KILN NORMALISES THE WAY PI DOES, NOT THE WAY IT MIGHT PREFER.** Pi keys its store on
  // `realpathSync(resolve(cwd))`, which on Windows keeps whatever case it was handed. A differently
  // cased spelling is therefore a DIFFERENT key in Pi's store, and this is asserted against Pi's own
  // store rather than assumed: a Kiln that folded case would stop matching decisions Pi itself records
  // through its own prompt, which is a worse failure than the one it would be papering over.
  const agent = agentDir();
  const dir = project();
  await grantTrust({ projectRoot: dir, agentDir: agent, toolRoot: ROOT });

  const { ProjectTrustStore } = await import(resolvePinnedSdk(ROOT).url);
  const store = new ProjectTrustStore(agent);
  assert.equal(store.get(dir), true, "precondition: Pi sees the decision at the spelling Kiln recorded");

  if (!WINDOWS) return; // On POSIX a differently cased path is a different directory, and usually absent.

  const shouted = dir.toUpperCase();
  assert.equal(store.get(shouted), null, "Pi itself does not match a differently cased spelling");
  assert.equal(
    (await readTrust({ projectRoot: shouted, agentDir: agent, toolRoot: ROOT })).state,
    TRUST.MISSING,
    "and Kiln reports what Pi would, rather than inventing a case rule Pi does not share"
  );
});

/* ============================================ no agent directory, no store ====================== */

test("⚠️ ACC-0051 the agent directory is always the caller's to name, and no store is opened without one", async () => {
  const dir = project();

  // ⚠️ **A POISONED FACTORY, SO THE PROOF DOES NOT DEPEND ON LOOKING AT THE OPERATOR'S FILES.** If the
  // module ever defaulted an agent directory, the only way to act on it would be to open a store — so a
  // factory that refuses to be called, and a count that stays at zero, says the same thing as inspecting
  // `~/.pi/agent/trust.json` would, without this suite ever reading the operator's own store.
  let opened = 0;
  const poison = () => {
    opened += 1;
    throw new Error("a store was opened without an agent directory");
  };

  for (const [label, call] of [
    ["read", () => readTrust({ projectRoot: dir, toolRoot: ROOT, storeFactory: poison })],
    ["grant", () => grantTrust({ projectRoot: dir, toolRoot: ROOT, storeFactory: poison })],
    ["deny", () => denyTrust({ projectRoot: dir, toolRoot: ROOT, storeFactory: poison })],
    ["revoke", () => revokeTrust({ projectRoot: dir, toolRoot: ROOT, storeFactory: poison })],
    ["empty agent directory", () => grantTrust({ projectRoot: dir, agentDir: "   ", toolRoot: ROOT, storeFactory: poison })],
    ["whitespace and a tab", () => readTrust({ projectRoot: dir, agentDir: "\t ", toolRoot: ROOT, storeFactory: poison })],
  ]) {
    const e = await refusal(call(), (x) =>
      assert.ok(x instanceof TrustRefusal && x.reason === TRUST_REFUSAL.NO_AGENT_DIR, `${label}: got ${x?.reason ?? x}`)
    );
    assert.equal(e.detail.field, "agentDir", label);
    assert.ok(!e.message.includes(homedir()), `${label}: the refusal names the operator's home: ${e.message}`);
  }

  assert.equal(opened, 0, "no store was opened at all, so nothing could have been defaulted");
});

test("⚠️ ACC-0051 a project directory that is not there is refused before anything is opened", async () => {
  const agent = agentDir();
  for (const [label, projectRoot] of [
    ["absent", join(tmpdir(), "kiln-trust-not-here-2f1a")],
    ["a file, not a directory", join(ROOT, "package.json")],
    ["empty", "   "],
    ["missing", undefined],
  ]) {
    const e = await refusal(grantTrust({ projectRoot, agentDir: agent, toolRoot: ROOT }), (x) =>
      assert.ok(x instanceof TrustRefusal && x.reason === TRUST_REFUSAL.INVALID_PROJECT, `${label}: got ${x?.reason ?? x}`)
    );
    assert.equal(e.detail.field, "projectRoot", label);
  }
  assert.deepEqual(readdirSync(agent), [], "nothing was written for a project that cannot be named");
});

/* ============================================ the write is verified ============================ */

/**
 * A store that records into a shared map, so several instances can be handed out over one "file".
 * ⚠️ USED ONLY BY THE TWO TESTS BELOW. Every other test runs Pi's real store, because the claim there
 * is about what Pi records; the claim HERE is about what this module does when a write does not land,
 * which the real store will not do on request.
 */
const fakeStore = (rows, { onGet } = {}) => {
  const instances = [];
  const factory = () => {
    const instance = {
      get: (cwd) => (onGet ? onGet(cwd, rows, instance, instances) : (rows.has(cwd) ? rows.get(cwd) : null)),
      getEntry: (cwd) => (rows.has(cwd) ? { path: cwd, decision: rows.get(cwd) } : null),
      set: (cwd, decision) => (decision === null ? rows.delete(cwd) : rows.set(cwd, decision)),
    };
    instances.push(instance);
    return instance;
  };
  return { factory, instances };
};

test("⚠️ ACC-0051 a write is read back through a SECOND store instance, not the one that wrote it", async () => {
  const dir = project();
  const { factory, instances } = fakeStore(new Map());

  const granted = await grantTrust({ projectRoot: dir, agentDir: agentDir(), toolRoot: ROOT, storeFactory: factory });

  assert.equal(granted.state, TRUST.APPROVED);
  assert.equal(instances.length, 2, "one store performed the write, a second read it back");
  assert.notEqual(instances[0], instances[1], "and they are not the same object answering twice");
});

test("⚠️ ACC-0051 a write that does not land is refused, never reported as settled", async () => {
  const dir = project();
  // The writer accepts everything; every later reader says the project is still untouched.
  const rows = new Map();
  const { factory, instances } = fakeStore(rows, { onGet: (cwd, map, instance, all) => (all.indexOf(instance) === 0 ? map.get(cwd) ?? null : null) });

  const e = await refusal(
    grantTrust({ projectRoot: dir, agentDir: agentDir(), toolRoot: ROOT, storeFactory: factory }),
    (x) => assert.ok(x instanceof TrustRefusal && x.reason === TRUST_REFUSAL.NOT_PERSISTED, `got ${x?.reason ?? x}`)
  );
  assert.deepEqual(e.detail, { wanted: TRUST.APPROVED, observed: TRUST.MISSING });
  assert.equal(instances.length, 2, "the refusal came from the second instance's reading, not the first's");
});

/* ============================================ the boundary DEC-0027 draws ====================== */

test("⚠️ ACC-0051 the module reaches Pi only through the package's root export, and writes no trust file", () => {
  const source = readFileSync(join(ROOT, "lib", "pi-trust.mjs"), "utf-8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // ⚠️ WHAT DEC-0027 WITHDREW: writing Pi's user-scoped trust file, in any spelling.
  assert.ok(!/trust\.json/.test(code), "the module names Pi's trust file");
  assert.ok(!/writeFileSync|appendFileSync|createWriteStream|atomicWrite/.test(code), "the module writes a file itself");

  // ⚠️ AND WHAT IT REQUIRES: the root export, reached through the pinned resolver, never an inner path.
  assert.ok(!/trust-manager|\/dist\/|@earendil-works/.test(code), "the module reaches into Pi's internals");
  assert.match(code, /resolvePinnedSdk/, "the SDK is located by the pinned resolver");
  assert.match(code, /sdk\.ProjectTrustStore/, "and the store comes from the package root");

  // No quiet fallback to the operator's agent directory.
  assert.ok(!/homedir|USERPROFILE|PI_CODING_AGENT_DIR|\.pi[\\/]agent/.test(code), "the module knows a default agent directory");
});
