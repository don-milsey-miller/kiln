/**
 * The orchestrator's content-root guard and the marker's removal — TSK-0048 (G3b), toward ACC-0071.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalPath } from "../lib/content-root.mjs";
import {
  SELF_HOST_MARKER,
  SELF_HOST_VALIDATED,
  TOOL_CONTENT_REFUSED,
  ToolContentRefusal,
  assertOrchestratorContentRoot,
  withoutSelfHostMarker,
} from "../lib/orchestrator-root.mjs";

const link = (target, path) => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");

function roots() {
  const base = mkdtempSync(join(tmpdir(), "kiln-orch-root-"));
  const tool = join(base, "tool");
  const nested = join(tool, "planning-content");
  const deeper = join(tool, "a", "b", "planning-content");
  const external = join(base, "project", "planning-content");
  for (const dir of [nested, deeper, external]) mkdirSync(dir, { recursive: true });
  const sibling = join(base, "sibling-content");
  link(nested, sibling);
  return { base, tool, nested, deeper, external, sibling };
}

const MALFORMED = ["", "true", "1", "yes", "validated", "validated-v2", "VALIDATED-V1", "Validated-v1", " validated-v1", "validated-v1 ", "validated-v1\n"];

function refuses(fn, r, content, label) {
  assert.throws(
    fn,
    (e) =>
      e instanceof ToolContentRefusal &&
      e.code === TOOL_CONTENT_REFUSED &&
      e.contentRoot === canonicalPath(content) &&
      e.toolRoot === canonicalPath(r.tool) &&
      e.message.includes(canonicalPath(content)) &&
      e.message.includes(canonicalPath(r.tool)),
    label
  );
}

test("⚠️ ACC-0071 an external consumer content root is accepted, and a marker beside it grants nothing and changes nothing", () => {
  const r = roots();
  try {
    const plain = assertOrchestratorContentRoot({ contentRoot: r.external, toolRoot: r.tool, env: {} });
    assert.deepEqual(plain, { contentRoot: canonicalPath(r.external), toolRoot: canonicalPath(r.tool), selfHost: false });
    for (const value of [SELF_HOST_VALIDATED, ...MALFORMED])
      assert.deepEqual(assertOrchestratorContentRoot({ contentRoot: r.external, toolRoot: r.tool, env: { [SELF_HOST_MARKER]: value } }), plain, `marker ${JSON.stringify(value)}`);
  } finally {
    rmSync(r.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0071 the tool root itself, a nested root and a deeper root are refused without the marker, naming both canonical paths", () => {
  const r = roots();
  try {
    for (const [label, content] of [["equality", r.tool], ["nested", r.nested], ["deeper", r.deeper]])
      refuses(() => assertOrchestratorContentRoot({ contentRoot: content, toolRoot: r.tool, env: {} }), r, content, label);
  } finally {
    rmSync(r.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0071 a sibling that is a symlink or junction into the tool root is refused by where it leads", () => {
  const r = roots();
  try {
    assert.notEqual(canonicalPath(r.sibling), r.sibling, "the sibling really is a link");
    refuses(() => assertOrchestratorContentRoot({ contentRoot: r.sibling, toolRoot: r.tool, env: {} }), r, r.nested, "sibling link");
  } finally {
    rmSync(r.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0071 an absent or malformed marker refuses; only the exact validated value permits", () => {
  const r = roots();
  try {
    refuses(() => assertOrchestratorContentRoot({ contentRoot: r.nested, toolRoot: r.tool, env: {} }), r, r.nested, "absent");
    for (const value of MALFORMED)
      refuses(() => assertOrchestratorContentRoot({ contentRoot: r.nested, toolRoot: r.tool, env: { [SELF_HOST_MARKER]: value } }), r, r.nested, `malformed ${JSON.stringify(value)}`);
    refuses(
      () => assertOrchestratorContentRoot({ contentRoot: r.nested, toolRoot: r.tool, env: { kiln_self_host: SELF_HOST_VALIDATED } }),
      r,
      r.nested,
      "a differently-cased name in a plain object is not the marker"
    );

    for (const content of [r.tool, r.nested, r.sibling])
      assert.deepEqual(assertOrchestratorContentRoot({ contentRoot: content, toolRoot: r.tool, env: { [SELF_HOST_MARKER]: SELF_HOST_VALIDATED } }), {
        contentRoot: canonicalPath(content),
        toolRoot: canonicalPath(r.tool),
        selfHost: true,
      });
  } finally {
    rmSync(r.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0071 on Windows the roots compare without case", { skip: process.platform !== "win32" }, () => {
  const r = roots();
  try {
    refuses(() => assertOrchestratorContentRoot({ contentRoot: r.nested.toUpperCase(), toolRoot: r.tool, env: {} }), r, r.nested.toUpperCase(), "upper-cased content root");
  } finally {
    rmSync(r.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0071 every spelling of the marker is removed: case-insensitively on Windows, exactly elsewhere", () => {
  const env = { PATH: "p", KILN_SELF_HOST: "validated-v1", kiln_self_host: "validated-v1", Kiln_Self_Host: "x", KILN_SELF_HOSTED: "kept", OTHER: "o" };
  const before = { ...env };

  assert.deepEqual(withoutSelfHostMarker(env, "win32"), { PATH: "p", KILN_SELF_HOSTED: "kept", OTHER: "o" });
  assert.deepEqual(withoutSelfHostMarker(env, "linux"), { PATH: "p", kiln_self_host: "validated-v1", Kiln_Self_Host: "x", KILN_SELF_HOSTED: "kept", OTHER: "o" });
  assert.deepEqual(env, before, "the inherited environment is not edited");
  assert.deepEqual(withoutSelfHostMarker(undefined, "linux"), {});
});
