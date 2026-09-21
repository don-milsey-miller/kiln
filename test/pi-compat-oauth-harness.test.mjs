/**
 * The TSK-0066 OAuth harness's own failure paths — `tools/pi-compat/oauth-check.mjs --self-test`.
 *
 * ⚠️ **NO ACCOUNT, NO TUI, NO RECORD.** Self-test plants a fake credential in place of the operator's
 * login and injects one fault. It proves nothing about OAuth: what it holds is that the harness removes
 * the stored credential on every exit path it can see, never prints a credential value, refuses a
 * discovery child that did not exit 0, and never saves a record from a self-test.
 *
 * ⚠️ **A PROCESS KILLED OUTRIGHT RUNS NOTHING.** That case is covered by the sweep at startup, which is
 * tested here by leaving a directory behind and running the harness again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = join(ROOT, "tools", "pi-compat", "oauth-check.mjs");
const RUNS = join(ROOT, "tools", "pi-compat", "runs", "oauth");
const TARGET = ["--provider", "openai-codex", "--model", "gpt-5.5"];

/** The fake credential's values, written out here so the test does not take them from the harness. */
const PLANTED = ["selftest-access-9d2c71b4e0", "selftest-refresh-5a8e03f6c1"];

const listRuns = () => (existsSync(RUNS) ? readdirSync(RUNS).sort() : []);
const run = (extra) =>
  spawnSync(process.execPath, [HARNESS, ...TARGET, ...extra], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });

for (const [fault, reason] of [
  ["throw-after-credential", /stopped by an unexpected Error/],
  ["leak-in-record", /carries part of a stored credential value/],
  ["leak-path-in-record", /retains \d+ machine-identifying fragment\(s\) \(/],
  ["discover-nonzero", /discovery did not finish cleanly \(exit 3/],
]) {
  test(`self-test ${fault}: refused, credential removed, nothing printed or saved`, () => {
    const before = listRuns();
    const r = run(["--self-test", fault]);
    const output = `${r.stdout}\n${r.stderr}`;

    assert.equal(r.status, 2, `the harness exited ${r.status}:\n${output}`);
    assert.match(r.stderr, reason);

    const work = (r.stdout.match(/^WORK=(.+)$/m) ?? [])[1];
    assert.ok(work, "the self-test did not report its isolated directory");
    assert.equal(existsSync(work.trim()), false, "the isolated directory, with its stored credential, was left behind");

    // ⚠️ NO VALUE AND NO 8-CHARACTER PIECE OF ONE, on either stream.
    for (const value of PLANTED)
      for (let i = 0; i + 8 <= value.length; i++)
        assert.equal(output.includes(value.slice(i, i + 8)), false, `the output carries part of a planted credential value`);
    // A violation's message may name the kind of fragment found, never the fragment.
    assert.equal(output.includes("kilnprobeuser"), false, "the output carries the fragment a violation found");

    assert.deepEqual(listRuns(), before, "a self-test saved a record");
  });
}

test("a directory left by a killed run is removed by the next run", () => {
  const left = mkdtempSync(join(tmpdir(), "kiln-oauth-"));
  mkdirSync(join(left, "agent"), { recursive: true });
  writeFileSync(join(left, "agent", "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth" } }));

  const r = run(["--dry-run"]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(existsSync(left), false, "the leftover directory survived");
  assert.match(r.stdout, /removed a leftover isolated directory/);
});

test("the dry run takes a baseline, saves nothing and leaves nothing behind", () => {
  const before = listRuns();
  const leftBefore = readdirSync(tmpdir()).filter((e) => e.startsWith("kiln-oauth-"));
  const r = run(["--dry-run"]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /in the catalogue and unavailable/);
  assert.deepEqual(listRuns(), before);
  assert.deepEqual(readdirSync(tmpdir()).filter((e) => e.startsWith("kiln-oauth-")), leftBefore.filter((e) => existsSync(join(tmpdir(), e))));
});

const retained = join(RUNS, `oauth-${process.platform === "win32" ? "windows" : process.platform}.json`);
test("a retained real-account record is not overwritten", { skip: existsSync(retained) ? false : "no retained record on this platform, and without one this run would start the real login" }, () => {
  const bytes = readFileSync(retained);
  const r = run([]);
  assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /already exists; a retained record is not overwritten/);
  assert.deepEqual(readFileSync(retained), bytes, "the retained record changed");
});
