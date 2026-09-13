/**
 * `kiln_project_status` as a model receives it — TSK-0048 (G3a), toward ACC-0068.
 *
 * ⚠️ **THIS IS THE DISCLOSURE BOUNDARY'S TEST.** The handler registered by the package runs against a real
 * content root, and what is asserted is the result and refusal a model would receive: every string value
 * cleaned, every path reduced to the content root or null, raw loader errors replaced by authored refusals
 * (F101), and project-authored identifiers and filenames treated as untrusted (F105).
 *
 * ⚠️ **EVERY PLANT IS PROVED PRESENT BEFORE ITS ABSENCE IS ASSERTED.** A secret nobody put where the result
 * could reach would be absent for the wrong reason.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readActivatedTypes } from "../lib/activation.mjs";
import { yamlString } from "../lib/project-scaffold.mjs";
import { PROJECT_STATUS_MESSAGES, PROJECT_STATUS_REFUSAL, readProjectStatus } from "../lib/project-status.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { createValidators } from "../lib/validate.mjs";
import register from "../pi-package/extensions/kiln.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemas = loadSchemaSet(join(ROOT, "schemas"));
const validators = createValidators(join(ROOT, "schemas"));

const SECRET = "sk-ant-api03-STATUSPLANTEDCREDENTIAL00000";
const GITHUB_TOKEN = "ghp_PLANTEDSTATUSTOKEN000000000000000000";
const WINDOWS_PATH = "C:\\Users\\operator\\secret\\token.txt";
const POSIX_PATH = "/home/operator/secret/token.txt";

const statusTool = (deps = {}) => {
  const tools = new Map();
  register({ registerTool: (tool) => tools.set(tool.name, tool) }, deps);
  return tools.get("kiln_project_status");
};

/** Invoke with the shared resolver pointed at this project, restoring the environment afterwards. */
async function invoke(tool, contentRoot) {
  const saved = process.env.PLANNING_CONTENT_DIR;
  process.env.PLANNING_CONTENT_DIR = contentRoot;
  try {
    return await tool.execute("call-1", {});
  } finally {
    if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved;
  }
}

const env = (id, type, extra) => ({ id, type, schemaVersion: 2, reviewStatus: "approved", lifecycle: "active", title: id, ...extra });

function project({ name = "Fixture", description = "A project.", stageDocument = "# Stage 01 - Intake\n", artifacts = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), "kiln-status-tool-"));
  try {
    const contentRoot = join(base, "planning-content");
    mkdirSync(join(contentRoot, "data"), { recursive: true });
    mkdirSync(join(contentRoot, "stages"), { recursive: true });
    writeFileSync(
      join(contentRoot, "project.yaml"),
      `name: ${yamlString(name)}\ndescription: ${yamlString(description)}\ncapabilities:\n  artifactTypes:\n    activated: [requirement, task]\n`
    );
    if (stageDocument !== null) writeFileSync(join(contentRoot, "stages", "01-intake.md"), stageDocument);
    for (const [rel, doc] of Object.entries(artifacts)) {
      mkdirSync(dirname(join(contentRoot, rel)), { recursive: true });
      writeFileSync(join(contentRoot, rel), typeof doc === "string" ? doc : JSON.stringify(doc, null, 2));
    }
    return { base, contentRoot };
  } catch (e) {
    rmSync(base, { recursive: true, force: true });
    throw e;
  }
}

/** Every spelling a string can reach serialised JSON in. */
const spellings = (text) => [...new Set([text, JSON.stringify(text).slice(1, -1), text.split("\\").join("/")])];

function assertAbsent(serialised, planted, label) {
  for (const text of planted)
    for (const spelling of spellings(text)) assert.equal(serialised.includes(spelling), false, `${label}: the result carries ${spelling}`);
}

function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      out[full] = st.isDirectory() ? { dir: true, mtimeMs: st.mtimeMs } : { bytes: readFileSync(full).toString("base64"), mtimeMs: st.mtimeMs };
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

/* ============================================================================ the result */

test("⚠️ ACC-0068 kiln_project_status keeps its existing fields and schema, and adds the derived state, identity and Stage 1 document", async () => {
  const tool = statusTool();
  assert.deepEqual(tool.parameters, { type: "object", properties: {}, additionalProperties: false }, "the schema is unchanged");

  const f = project();
  try {
    const result = await invoke(tool, f.contentRoot);
    const status = result.details;
    assert.equal(result.output, JSON.stringify(status, null, 2));

    assert.deepEqual(Object.keys(status).sort(), ["artifactCount", "blockers", "ok", "orchestration", "project", "ready", "stageOneDocument"]);
    assert.equal(status.ok, true);
    assert.equal(typeof status.ready, "boolean");
    assert.equal(Number.isInteger(status.artifactCount), true);
    assert.ok(Array.isArray(status.blockers));
    for (const b of status.blockers) assert.deepEqual(Object.keys(b).sort(), ["detail", "reason", "ruleId"]);

    assert.equal(status.orchestration.fresh, true);
    assert.equal(status.orchestration.complete, false);
    assert.equal(status.orchestration.currentStage.id, "01-intake");
    assert.equal(status.orchestration.nextAction.kind, "work-toward-criterion");
    assert.deepEqual(status.project, { name: "Fixture", description: "A project.", issues: [] });
    assert.deepEqual(status.stageOneDocument, { stageId: "01-intake", path: "stages/01-intake.md", text: "# Stage 01 - Intake\n", truncated: false });
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0068 the content root is resolved once per invocation", async () => {
  const f = project();
  const tool = statusTool();
  const saved = process.env.PLANNING_CONTENT_DIR;
  process.env.PLANNING_CONTENT_DIR = f.contentRoot;
  const realEnv = process.env;
  let reads = 0;
  process.env = new Proxy(realEnv, {
    get(target, prop) {
      if (prop === "PLANNING_CONTENT_DIR") reads++;
      return target[prop];
    },
  });
  try {
    const result = await tool.execute("call-1", {});
    assert.equal(result.details.ok, true);
    assert.equal(reads, 1, "the shared resolver was asked once, and everything else used its answer");
  } finally {
    process.env = realEnv;
    if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved;
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* ============================================================================ F105 and F103 */

test("⚠️ F105 planted secrets and absolute paths in messages, identifiers, filenames, identity, the document and nested arrays never reach the result", async () => {
  const f = project({
    description: `Owned by ${SECRET} at ${WINDOWS_PATH} and ${POSIX_PATH}`,
    stageDocument: null,
    artifacts: {
      // A project-authored filename and a project-authored id.
      [`data/requirements/${SECRET}.json`]: env(GITHUB_TOKEN, "requirement", { statement: "S", priority: "must" }),
      // A project-authored title, which the handoff gate quotes in its blocker message.
      "data/tasks/TSK-0001.json": env("TSK-0001", "task", { title: `Ship ${SECRET} from ${WINDOWS_PATH}`, statement: "S", role: "platform", acceptedBy: [] }),
    },
  });
  const notes = join(f.contentRoot, "data", "notes.md");
  // A token no provider prefix names: only the long letter-and-digit rule can catch it.
  const UNPREFIXED = "Zq9xW2eR7tY5uI3oP1aS8dF6gH4jK0lMnB7";
  // Legitimate text the rules must leave alone, and one they are recorded as redacting.
  const KEPT = "kiln-stage-08-implementation-plan uses data/acceptance-criterions/ACC-0066.json";
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  writeFileSync(
    join(f.contentRoot, "stages", "01-intake.md"),
    `# Stage 1\n\nKey ${GITHUB_TOKEN}\nOpaque ${UNPREFIXED}\nNotes at ${notes} and ${POSIX_PATH}\n${KEPT}\nCommit ${COMMIT}\n`
  );
  try {
    // The plants really are in what the readers return, so their absence below means something.
    const raw = readProjectStatus({ contentRoot: f.contentRoot, schemas, validators, activated: readActivatedTypes(f.contentRoot) }, { toolRoot: ROOT });
    const rawText = JSON.stringify(raw);
    for (const planted of [SECRET, GITHUB_TOKEN]) assert.ok(rawText.includes(planted), `the reader returns ${planted}`);

    const result = await invoke(statusTool(), f.contentRoot);
    const status = result.details;
    assert.equal(status.ok, true);

    assertAbsent(result.output, [SECRET, GITHUB_TOKEN, WINDOWS_PATH, POSIX_PATH, f.contentRoot, f.base, homedir(), tmpdir()], "F105");
    assert.equal(/[A-Za-z]:(\\\\|\/)/.test(result.output), false, "no drive-lettered path survives");

    const o = status.orchestration;
    assert.ok(o.blockers.some((b) => b.path === "data/requirements/<credential>.json"), "a filename's secret is redacted and the path stays relative");
    assert.ok(o.blockers.some((b) => b.artifactId === "<credential>"), "an id's secret is redacted inside a nested array");
    for (const b of o.blockers)
      assert.deepEqual(Object.keys(b).sort(), ["artifactId", "criterion", "missing", "path", "ruleId", "severity", "source", "stageId", "type"]);
    assert.ok(status.blockers.some((b) => typeof b.detail === "string" && b.detail.includes("<credential>")), "a message quoting a title is cleaned");
    // An unquoted path runs to the next delimiter, so the second path and the prose between go with the first.
    assert.equal(status.project.description, "Owned by <credential> at <path>");
    assert.ok(status.stageOneDocument.text.includes("Key <credential>"));
    assert.ok(status.stageOneDocument.text.includes("Notes at <content-root>/data/notes.md and <path>"), status.stageOneDocument.text);

    assertAbsent(result.output, [UNPREFIXED], "an unprefixed token");
    assert.ok(status.stageOneDocument.text.includes("Opaque <credential>"), "the long-run rule catches what no prefix names");
    assert.ok(status.stageOneDocument.text.includes(KEPT), "hyphenated ids and relative paths are not redacted");
    // ⚠️ THE RECORDED LIMITATION, PINNED: legitimate token-like text is redacted too.
    assert.ok(status.stageOneDocument.text.includes("Commit <credential>"), "a 40-character commit hash is redacted as token-like");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ F105 path fields are reduced to the content root or null before cleaning, and property names are never rewritten", async () => {
  const f = project();
  const inside = join(f.contentRoot, "data", "requirements", "REQ-0001.json");
  const blocker = (path, extra = {}) => ({
    source: "lint",
    ruleId: "storage/id-mismatch-filename",
    severity: "error",
    artifactId: "REQ-0001",
    path,
    stageId: null,
    criterion: null,
    type: null,
    missing: ["schema", `typed tool ${SECRET}`],
    ...extra,
  });
  const injected = {
    orchestration: {
      fresh: false,
      complete: false,
      currentStage: { id: "01-intake", name: "Intake", decidedBy: "User" },
      blockers: [blocker(inside, { [POSIX_PATH]: SECRET }), blocker(POSIX_PATH), blocker("../outside/REQ-0002.json"), blocker(WINDOWS_PATH)],
      nextAction: { kind: "resolve-finding", stageId: "01-intake", ruleId: "storage/id-mismatch-filename", artifactId: "REQ-0001", path: inside, criterion: null, type: null },
    },
    project: { name: "N", description: "D", issues: [] },
    stageOneDocument: { stageId: "01-intake", path: "stages/01-intake.md", text: "t" },
  };
  try {
    const result = await invoke(statusTool({ readProjectStatus: () => injected }), f.contentRoot);
    const o = result.details.orchestration;
    assert.equal(o.blockers[0].path, "data/requirements/REQ-0001.json", "absolute inside the root: reduced");
    assert.equal(o.blockers[1].path, null, "absolute outside the root: null");
    assert.equal(o.blockers[2].path, null, "climbing out of the root: null");
    assert.equal(o.blockers[3].path, null, "a drive-lettered path outside the root: null");
    assert.equal(o.nextAction.path, "data/requirements/REQ-0001.json");
    assert.ok(Object.hasOwn(o.blockers[0], POSIX_PATH), "a path-shaped property name is left as the shape defines it");
    assert.equal(o.blockers[0][POSIX_PATH], "<credential>", "while its value is cleaned");
    assert.deepEqual(o.blockers[0].missing, ["schema", "typed tool <credential>"], "strings inside nested arrays are cleaned");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ G3a an absolute path runs fail-closed to its next delimiter in every form, and prose without a path is kept", async () => {
  const f = project();
  const home = join(homedir(), "My Documents", "report draft.txt"); // a machine root continued by a spaced path
  const inRoot = join(f.contentRoot, "Shared Notes", "plan v2.md"); // the content root continued by a spaced path
  const cases = [
    // Windows native, forward-slash and POSIX forms, with spaces in folders and file names.
    ["See C:\\Users\\operator\\My Documents\\x.txt and more.", "See <path>"],
    ["See C:/Users/operator/My Documents/x.txt and more.", "See <path>"],
    ["See /home/operator/My Documents/x.txt and more.", "See <path>"],
    ["Escaped C:\\\\Users\\\\operator\\\\My Documents\\\\x.txt here", "Escaped <path>"],
    // A spaced last segment with no extension.
    ["File C:\\dir\\secret notes", "File <path>"],
    ["File /srv/secret notes", "File <path>"],
    // UNC paths: native, forward-slash and JSON-escaped, each ended by a different delimiter.
    ["Share \\\\fileserver\\Team Share\\plan notes, done", "Share <path>, done"],
    ["Share //fileserver/Team Share/plan notes; done", "Share <path>; done"],
    ["Share \\\\\\\\fileserver\\\\Team Share\\\\plan notes) done", "Share <path>) done"],
    // Windows extended paths, quoted and unquoted.
    ['Ext "\\\\?\\C:\\Users\\operator\\Long Folder\\file" done', 'Ext "<path>" done'],
    ["Ext \\\\?\\UNC\\fileserver\\Team Share\\file", "Ext <path>"],
    // A single-segment POSIX path: unquoted, quoted and in parentheses.
    ["Key /secret and more", "Key <path>"],
    ['Quoted "/secret" here', 'Quoted "<path>" here'],
    ["(see /secret) then", "(see <path>) then"],
    // Quoted paths and the other delimiters.
    ['Quoted "C:\\Program Files\\Secret App\\config.json" here', 'Quoted "<path>" here'],
    ["Then C:\\Program Files\\Secret App\\config.json, then", "Then <path>, then"],
    ["Key /opt/Secret Stuff/key.pem\nNext line", "Key <path>\nNext line"],
    // A credential inside a path: the path goes whole, rather than stopping at a credential marker.
    [`Cred C:\\keys\\${SECRET}\\tail file.txt more`, "Cred <path>"],
    [`Cred /keys/${SECRET}/tail file.txt more`, "Cred <path>"],
    // Windows paths from the root of the current drive: native, JSON-serialized, quoted, and a spaced extensionless end.
    ["Root-relative \\Users\\operator\\secret.txt here", "Root-relative <path>"],
    ["Serialized \\\\Users\\\\operator\\\\secret.txt, then", "Serialized <path>, then"],
    ['Quoted "\\Users\\operator\\secret.txt" here', 'Quoted "<path>" here'],
    ["Folder \\Users\\operator\\Private Notes\\final draft", "Folder <path>"],
    // Known roots continued by spaced paths.
    [`Home ${home} here`, "Home <path>"],
    [`Root ${inRoot} here`, "Root <content-root>/Shared Notes/plan v2.md here"],
  ];
  const unknownOrMachine = cases.slice(0, -1).map(([input]) => input);
  // ⚠️ THE POSITIVE CONTROLS: prose with spaces, ratios, dates, `and/or`, a bare slash and URLs holds no path start.
  const PROSE = [
    "Meet in the main hall at 10 am, bring notes / questions and/or ideas.",
    "Ratio 1/2 of the budget, see section 3.4 and https://example.com/a b",
    "Dates 2026/09/13, fractions 3/4, and http://host/path stay as written",
  ];
  const FRAGMENTS = [
    "My Documents", "Documents\\x.txt", "Documents/x.txt", "x.txt", "secret notes", "/secret", "fileserver", "Team Share",
    "plan notes", "Long Folder", "Secret App", "config.json", "Secret Stuff", "key.pem", "operator", "Program Files", "report draft",
    "tail file", SECRET, "secret.txt", "Private Notes", "final draft",
  ];
  // ⚠️ THE BACKSLASH CONTROL: a backslash inside ordinary words starts nothing.
  const INTERNAL_BACKSLASH = "Ratios like A\\B and yes\\no stay, as does the and\\or choice";

  const blocker = (text) => ({ source: "gate", ruleId: "gate/criterion-pending-human", severity: "error", artifactId: null, path: null, stageId: "01-intake", criterion: "c", type: null, missing: [text] });
  const injected = {
    orchestration: {
      fresh: false,
      complete: false,
      currentStage: { id: "01-intake", name: PROSE[1], decidedBy: PROSE[2] },
      blockers: cases.map(([input]) => blocker(input)),
      nextAction: { kind: "work-toward-criterion", stageId: "01-intake", ruleId: "gate/criterion-pending-human", artifactId: null, path: null, criterion: INTERNAL_BACKSLASH, type: null },
    },
    project: { name: PROSE[0], description: cases[0][0], issues: [] },
    stageOneDocument: { stageId: "01-intake", path: "stages/01-intake.md", text: cases.map(([input]) => input).join("\n") },
  };
  try {
    const result = await invoke(statusTool({ readProjectStatus: () => injected }), f.contentRoot);
    const status = result.details;

    // Exact renderings, so no trailing segment of any path can survive unnoticed.
    cases.forEach(([input, expected], index) =>
      assert.equal(status.orchestration.blockers[index].missing[0], expected, `nested array value: ${JSON.stringify(input)}`)
    );
    assert.equal(status.stageOneDocument.text, cases.map(([, expected]) => expected).join("\n"), "the document, line by line");
    assert.equal(status.project.description, cases[0][1], "a nested object value");

    assert.equal(status.project.name, PROSE[0]);
    assert.equal(status.orchestration.currentStage.name, PROSE[1]);
    assert.equal(status.orchestration.currentStage.decidedBy, PROSE[2]);
    assert.equal(status.orchestration.nextAction.criterion, INTERNAL_BACKSLASH, "backslashes inside words are kept");

    // Neither a whole path nor any fragment of one survives, raw or JSON-escaped.
    assertAbsent(result.output, [...unknownOrMachine, home, ...FRAGMENTS], "fail-closed paths");

    // A refusal carries nothing a loader error said.
    const refused = await invoke(
      statusTool({
        readProjectStatus: () => {
          throw new Error("failed at \\\\fileserver\\Team Share\\state.json, /opt/Secret Stuff/key.pem and \\Users\\operator\\Private Notes\\final draft");
        },
      }),
      f.contentRoot
    );
    assert.deepEqual(refused.details, {
      ok: false,
      code: PROJECT_STATUS_REFUSAL.PROJECT_STATE_UNREADABLE,
      message: PROJECT_STATUS_MESSAGES[PROJECT_STATUS_REFUSAL.PROJECT_STATE_UNREADABLE],
    });
    assertAbsent(refused.output, ["fileserver", "Team Share", "state.json", "Secret Stuff", "key.pem", "operator", "Private Notes", "final draft"], "paths in a refusal");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* ============================================================================ F101 */

test("⚠️ F101 a loader error becomes an authored refusal, and nothing it quoted reaches the model", async () => {
  const f = project();
  mkdirSync(join(f.contentRoot, "state", "stage-attestations"), { recursive: true });
  writeFileSync(join(f.contentRoot, "state", "stage-attestations", "01-intake.json"), `${SECRET} ${POSIX_PATH} {`);
  try {
    const ctx = { contentRoot: f.contentRoot, schemas, validators, activated: readActivatedTypes(f.contentRoot) };
    assert.throws(
      () => readProjectStatus(ctx, { toolRoot: ROOT }),
      (e) => e.code === PROJECT_STATUS_REFUSAL.PROJECT_STATE_UNREADABLE && e.cause.message.includes(f.contentRoot),
      "the loader's own error named the file"
    );

    const result = await invoke(statusTool(), f.contentRoot);
    assert.deepEqual(result.details, {
      ok: false,
      code: PROJECT_STATUS_REFUSAL.PROJECT_STATE_UNREADABLE,
      message: PROJECT_STATUS_MESSAGES[PROJECT_STATUS_REFUSAL.PROJECT_STATE_UNREADABLE],
    });
    assertAbsent(result.output, [SECRET, POSIX_PATH, f.contentRoot, f.base], "F101");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0068 a missing Stage 1 document is a stable refusal, not a null", async () => {
  const f = project({ stageDocument: null });
  try {
    const result = await invoke(statusTool(), f.contentRoot);
    assert.deepEqual(result.details, {
      ok: false,
      code: PROJECT_STATUS_REFUSAL.STAGE_DOCUMENT_MISSING,
      message: PROJECT_STATUS_MESSAGES[PROJECT_STATUS_REFUSAL.STAGE_DOCUMENT_MISSING],
    });
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* ============================================================================ the cap (D19) */

test("⚠️ ACC-0068 the Stage 1 document is capped at 64 KiB of cleaned UTF-8 without splitting a character", async () => {
  const kept = "a".repeat(64 * 1024 - 2) + "é"; // exactly 64 KiB
  const over = project({ stageDocument: `${kept}😀 and more` });
  // The two-byte character starts at the last byte of the limit, so a byte cut would land inside it.
  const straddleKept = "a".repeat(64 * 1024 - 1);
  const straddle = project({ stageDocument: `${straddleKept}\u00e9 and more` });
  const shrinks = project({ stageDocument: `${POSIX_PATH} `.repeat(2500) });
  try {
    const capped = (await invoke(statusTool(), over.contentRoot)).details.stageOneDocument;
    assert.equal(capped.truncated, true);
    assert.equal(Buffer.byteLength(capped.text, "utf8"), 64 * 1024);
    assert.equal(capped.text, kept, "cut before the character that would cross the limit");
    assert.equal(capped.text.includes("\uFFFD"), false, "no character was split");

    const straddled = (await invoke(statusTool(), straddle.contentRoot)).details.stageOneDocument;
    assert.equal(straddled.truncated, true);
    assert.equal(straddled.text, straddleKept, "the character crossing the limit is dropped whole");
    assert.equal(Buffer.byteLength(straddled.text, "utf8"), 64 * 1024 - 1);
    assert.equal(straddled.text.includes("\uFFFD"), false, "no replacement character stands in for half of it");

    assert.ok(Buffer.byteLength(`${POSIX_PATH} `.repeat(2500), "utf8") > 64 * 1024, "the raw document is over the limit");
    const cleaned = (await invoke(statusTool(), shrinks.contentRoot)).details.stageOneDocument;
    assert.equal(cleaned.truncated, false, "the limit applies to what the model receives, after cleaning");
    assert.equal(cleaned.text, "<path>", "one unquoted path runs through everything that follows it on its line");
  } finally {
    rmSync(over.base, { recursive: true, force: true });
    rmSync(straddle.base, { recursive: true, force: true });
    rmSync(shrinks.base, { recursive: true, force: true });
  }
});

/* ============================================================================ side effects */

test("⚠️ ACC-0068 registration reads nothing", () => {
  const READS = ["readFileSync", "readdirSync", "statSync", "lstatSync", "existsSync", "openSync", "realpathSync", "accessSync", "opendirSync"];
  const originals = Object.fromEntries(READS.map((name) => [name, fs[name]]));
  const seen = [];
  for (const name of READS)
    fs[name] = function (...args) {
      seen.push(name);
      return originals[name].apply(this, args);
    };
  syncBuiltinESMExports();
  try {
    register({ registerTool: () => {} });
  } finally {
    for (const name of READS) fs[name] = originals[name];
    syncBuiltinESMExports();
  }
  assert.deepEqual(seen, [], "registering the package touched the filesystem");
});

test("⚠️ ACC-0068 an invocation writes nothing, reaches no network, starts no process and changes no file", async () => {
  const f = project();
  const WRITES = ["writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "rmSync", "rmdirSync", "unlinkSync", "renameSync", "copyFileSync", "symlinkSync", "utimesSync", "truncateSync", "writeSync", "createWriteStream"];
  const PROCESSES = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
  const seen = [];
  const restore = [];
  const watch = (target, name, label) => {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function (...args) {
      seen.push(label);
      return original.apply(this, args);
    };
    restore.push(() => {
      target[name] = original;
    });
  };
  const readOnlyOpen = fs.openSync;
  fs.openSync = function (path, flags, ...rest) {
    if (flags !== undefined && flags !== "r" && flags !== "rs" && flags !== fs.constants.O_RDONLY) seen.push(`fs.openSync(${flags})`);
    return readOnlyOpen.call(this, path, flags, ...rest);
  };
  restore.push(() => {
    fs.openSync = readOnlyOpen;
  });
  for (const name of WRITES) watch(fs, name, `fs.${name}`);
  for (const name of ["writeFile", "appendFile", "mkdir", "rm", "unlink", "rename"]) watch(fs.promises, name, `fs.promises.${name}`);
  for (const name of PROCESSES) watch(childProcess, name, `child_process.${name}`);
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

  const tool = statusTool();
  const before = snapshot(f.base);
  let result;
  try {
    result = await invoke(tool, f.contentRoot);
  } finally {
    for (const undo of restore.reverse()) undo();
    syncBuiltinESMExports();
  }
  try {
    assert.equal(result.details.ok, true);
    assert.deepEqual(seen, [], "the invocation wrote, connected or spawned");
    assert.deepEqual(snapshot(f.base), before, "no byte or modification time changed");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
