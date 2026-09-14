/**
 * Every project-bound handler refuses the tool's own planning content — TSK-0048 (G3b), toward ACC-0071.
 *
 * ⚠️ **A TEMPORARY TOOL ROOT, NEVER THIS REPOSITORY.** `register(pi, { toolRoot })` points the handlers at a
 * directory under the temporary directory holding copies of `schemas/` and `stages/`. A handler that wrongly
 * got past the guard could only ever write into that copy.
 *
 * ⚠️ **TWO SURFACES.** The model result is fixed and holds no path. The operator notice names both canonical
 * paths, once, and only when the invocation has a UI; without one nothing reaches a terminal stream.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPath, pathIdentityKey } from "../lib/content-root.mjs";
import { yamlString } from "../lib/project-scaffold.mjs";
import register, { SIGNATURE } from "../pi-package/extensions/kiln.js";
import { providerVisible } from "./helpers/provider-visible.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTLESS = new Set(["kiln_capability", "research_capability", "research_search", "research_fetch", "validation_capability", "validation_run"]);
const REFUSED = Object.freeze({ ok: false, code: "tool-content-refused", contentRoot: "<content-root>", toolRoot: "<tool-root>" });
const MALFORMED = ["", "true", "1", "validated", "validated-v2", "VALIDATED-V1", " validated-v1", "validated-v1 "];
const link = (target, path) => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");

function writeProject(contentRoot) {
  mkdirSync(join(contentRoot, "data"), { recursive: true });
  mkdirSync(join(contentRoot, "stages"), { recursive: true });
  writeFileSync(join(contentRoot, "project.yaml"), `name: ${yamlString("Fixture")}\ndescription: ${yamlString("A project.")}\n`);
  writeFileSync(join(contentRoot, "stages", "01-intake.md"), "# Stage 01 - Intake\n");
}

/** A tool root with copied schemas and stages, a content root nested in it, an external one, and a sibling link into it. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "kiln-tool-content-"));
  try {
    const tool = join(base, "tool");
    mkdirSync(tool, { recursive: true });
    cpSync(join(ROOT, "schemas"), join(tool, "schemas"), { recursive: true });
    cpSync(join(ROOT, "stages"), join(tool, "stages"), { recursive: true });
    const nested = join(tool, "planning-content");
    writeProject(nested);
    const external = join(base, "project", "planning-content");
    writeProject(external);
    const sibling = join(base, "sibling-content");
    link(nested, sibling);
    return { base, tool, nested, external, sibling };
  } catch (e) {
    rmSync(base, { recursive: true, force: true });
    throw e;
  }
}

const toolsFor = (fx) => {
  const tools = new Map();
  register({ registerTool: (tool) => tools.set(tool.name, providerVisible(tool)) }, { toolRoot: fx.tool });
  return tools;
};

/** The handlers whose subject is a project: every declared tool that is not projectless. */
const PROJECT_BOUND = SIGNATURE.tools.filter((name) => !PROJECTLESS.has(name)).sort();

async function invoke(tool, contentRoot, { marker, ctx } = {}) {
  const saved = { dir: process.env.PLANNING_CONTENT_DIR, marker: process.env.KILN_SELF_HOST };
  process.env.PLANNING_CONTENT_DIR = contentRoot;
  if (marker === undefined) delete process.env.KILN_SELF_HOST;
  else process.env.KILN_SELF_HOST = marker;
  try {
    return await tool.execute("call-1", {}, undefined, undefined, ctx);
  } finally {
    if (saved.dir === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved.dir;
    if (saved.marker === undefined) delete process.env.KILN_SELF_HOST;
    else process.env.KILN_SELF_HOST = saved.marker;
  }
}

const uiRecorder = () => {
  const notices = [];
  return { notices, ctx: { hasUI: true, ui: { notify: (message, type) => notices.push({ message, type }) } } };
};

function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = fs.lstatSync(full);
      out[full] = st.isDirectory() ? { dir: true, mtimeMs: st.mtimeMs } : { bytes: st.isFile() ? readFileSync(full).toString("base64") : "link", mtimeMs: st.mtimeMs };
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

function assertNoPath(serialised, fx, label) {
  for (const root of [fx.base, fx.tool, fx.nested, canonicalPath(fx.base)])
    for (const spelling of [root, JSON.stringify(root).slice(1, -1), root.split("\\").join("/")])
      assert.equal(serialised.includes(spelling), false, `${label}: the result carries ${spelling}`);
  assert.equal(/[A-Za-z]:[\\/]/.test(serialised), false, `${label}: a drive-lettered path`);
  assert.equal(/(^|["\s])\/[^\s"]/.test(serialised), false, `${label}: a POSIX path`);
}

/** Watch writes, processes, the network and reads of project or schema content for the length of `run`. */
async function watching(fx, run) {
  const seen = [];
  const restore = [];
  const underGuarded = (path) => {
    if (typeof path !== "string") return false;
    const key = pathIdentityKey(resolve(path));
    return [fx.nested, join(fx.tool, "schemas"), join(fx.tool, "stages")].some((root) => {
      const r = pathIdentityKey(resolve(root));
      return key === r || key.startsWith(r + (r.endsWith("\\") || r.endsWith("/") ? "" : process.platform === "win32" ? "\\" : "/"));
    });
  };
  const watch = (target, name, label, when = () => true) => {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function (...args) {
      if (when(...args)) seen.push(label);
      return original.apply(this, args);
    };
    restore.push(() => {
      target[name] = original;
    });
  };
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "rmSync", "rmdirSync", "unlinkSync", "renameSync", "copyFileSync", "symlinkSync", "utimesSync", "writeSync"])
    watch(fs, name, `fs.${name}`);
  for (const name of ["readFileSync", "readdirSync", "opendirSync"]) watch(fs, name, `read ${name}`, (path) => underGuarded(path));
  watch(fs, "openSync", "fs.openSync(write)", (_path, flags) => flags !== undefined && flags !== "r" && flags !== "rs" && flags !== fs.constants.O_RDONLY);
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) watch(childProcess, name, `child_process.${name}`);
  watch(net, "connect", "net.connect");
  watch(net, "createConnection", "net.createConnection");
  for (const [module, label] of [[http, "http"], [https, "https"]]) {
    watch(module, "request", `${label}.request`);
    watch(module, "get", `${label}.get`);
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    seen.push("fetch");
    throw new Error("network reached");
  };
  restore.push(() => {
    globalThis.fetch = realFetch;
  });
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    for (const undo of restore.reverse()) undo();
    syncBuiltinESMExports();
  }
  return seen;
}

/* ============================================================================ every handler */

test("⚠️ ACC-0071 every project-bound handler refuses a nested tool content root with the fixed result, notifies the operator once, and touches nothing", async () => {
  const fx = fixture();
  try {
    const tools = toolsFor(fx);
    assert.equal(PROJECT_BOUND.length, 22, "every declared tool that has a project is covered");
    assert.deepEqual(PROJECT_BOUND.filter((name) => !tools.has(name)), []);

    const before = snapshot(fx.base);
    const outcomes = [];
    const seen = await watching(fx, async () => {
      for (const name of PROJECT_BOUND) {
        const ui = uiRecorder();
        outcomes.push({ name, result: await invoke(tools.get(name), fx.nested, { ctx: ui.ctx }), notices: ui.notices });
      }
    });

    assert.deepEqual(seen, [], "a refusal wrote, spawned, connected, or read project or schema content");
    assert.deepEqual(snapshot(fx.base), before, "no byte or modification time changed");
    for (const { name, result, notices } of outcomes) {
      assert.deepEqual(result.details, REFUSED, name);
      assert.equal(result.output, JSON.stringify(REFUSED, null, 2), `${name}: the model output is exactly the fixed result`);
      assertNoPath(result.output, fx, name);
      assert.equal(notices.length, 1, `${name}: the operator is told once`);
      assert.equal(notices[0].type, "error");
      assert.ok(notices[0].message.includes(canonicalPath(fx.nested)), `${name}: the notice names the canonical content root`);
      assert.ok(notices[0].message.includes(canonicalPath(fx.tool)), `${name}: and the canonical tool root`);
    }
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

/* ============================================================================ which roots */

test("⚠️ ACC-0071 the tool root itself, a sibling link into it, an absent marker and every malformed marker are refused", async () => {
  const fx = fixture();
  try {
    const status = toolsFor(fx).get("kiln_project_status");
    assert.deepEqual((await invoke(status, fx.tool)).details, REFUSED, "equality");

    const ui = uiRecorder();
    assert.deepEqual((await invoke(status, fx.sibling, { ctx: ui.ctx })).details, REFUSED, "a sibling junction or symlink into the tool root");
    assert.ok(ui.notices[0].message.includes(canonicalPath(fx.nested)), "the notice names where the link leads");

    assert.deepEqual((await invoke(status, fx.nested)).details, REFUSED, "absent marker");
    for (const marker of MALFORMED) assert.deepEqual((await invoke(status, fx.nested, { marker })).details, REFUSED, `malformed marker ${JSON.stringify(marker)}`);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0071 the validated marker permits the tool's own content, and nothing is refused or notified", async () => {
  const fx = fixture();
  try {
    const tools = toolsFor(fx);
    const ui = uiRecorder();
    const status = await invoke(tools.get("kiln_project_status"), fx.nested, { marker: "validated-v1", ctx: ui.ctx });
    assert.equal(status.details.ok, true, JSON.stringify(status.details));
    assert.equal(status.details.stageOneDocument.text, "# Stage 01 - Intake\n");
    const lint = await invoke(tools.get("kiln_lint"), fx.nested, { marker: "validated-v1", ctx: ui.ctx });
    assert.equal(lint.details.ok, true);
    assert.deepEqual(ui.notices, []);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0071 an external consumer content root is served, and a marker beside it changes nothing", async () => {
  const fx = fixture();
  try {
    const status = toolsFor(fx).get("kiln_project_status");
    const plain = (await invoke(status, fx.external)).details;
    assert.equal(plain.ok, true);
    for (const marker of ["validated-v1", "garbage"]) assert.deepEqual((await invoke(status, fx.external, { marker })).details, plain, `marker ${marker}`);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

/* ============================================================================ surfaces */

test("⚠️ ACC-0071 without a UI the refusal notifies nothing and writes nothing to a terminal stream", async () => {
  const fx = fixture();
  const writes = [];
  const originals = { out: process.stdout.write, err: process.stderr.write, error: console.error, warn: console.warn, log: console.log };
  const record = (label) => (chunk, ...rest) => {
    const text = String(chunk);
    if (text.includes(canonicalPath(fx.tool)) || text.includes("Refusing to open")) writes.push(label);
    return label.startsWith("console") ? undefined : originals[label === "stdout" ? "out" : "err"].call(label === "stdout" ? process.stdout : process.stderr, chunk, ...rest);
  };
  try {
    const tools = toolsFor(fx);
    const notified = [];
    const contexts = [
      ["no context", undefined],
      ["hasUI false", { hasUI: false, ui: { notify: () => notified.push("hasUI false") } }],
      ["a UI without notify", { hasUI: true, ui: {} }],
    ];
    process.stdout.write = record("stdout");
    process.stderr.write = record("stderr");
    console.error = record("console.error");
    console.warn = record("console.warn");
    console.log = record("console.log");
    const results = [];
    try {
      for (const [label, ctx] of contexts)
        for (const name of ["kiln_project_status", "kiln_create_requirement"]) results.push([`${label} / ${name}`, await invoke(tools.get(name), fx.nested, { ctx })]);
    } finally {
      process.stdout.write = originals.out;
      process.stderr.write = originals.err;
      console.error = originals.error;
      console.warn = originals.warn;
      console.log = originals.log;
    }
    for (const [label, result] of results) assert.deepEqual(result.details, REFUSED, label);
    assert.deepEqual(notified, [], "a context without a UI is not notified");
    assert.deepEqual(writes, [], "nothing about the refusal reached a terminal stream");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});
