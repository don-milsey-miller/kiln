#!/usr/bin/env node
/**
 * TSK-0065, toward ACC-0090: Pi's interactive `/login`, and what the same launch does without a TTY.
 *
 *   node tools/pi-compat/login-check.mjs controls      # scripted, no operator needed
 *   node tools/pi-compat/login-check.mjs interactive   # an operator at a real terminal types /login
 *
 * ⚠️ **LINUX ONLY.** Every run goes through `script(1)`, which gives Pi a pseudo-terminal and keeps a
 * byte transcript. Nothing here says how Pi behaves in a Windows terminal.
 *
 * ⚠️ **PI 0.84.4 HAS NO AUTHENTICATION-ONLY LAUNCH (F7).** `/login` exists only inside the full
 * interactive TUI, so that is what the interactive run launches. Whether auth is configured afterwards
 * is asked separately with `pi auth check --no-refresh`, which confirms locally configured auth and
 * does not show that a key works against a provider.
 *
 * ⚠️ **THE CONTROLS ARE NOT THE INTERACTIVE MODE (F8).** They keep the launch arguments fixed and vary
 * stdin and stdout. Pi selects print mode when either is not a TTY, so each control records which
 * mode it observed and a bounded outcome, never "the TUI without a terminal".
 *
 * ⚠️ **NOTHING OF KILN'S, AND NOTHING OF THE OPERATOR'S.** Pi runs with an allowlisted environment, an
 * isolated HOME, agent directory and working directory, and every discovery source switched off.
 * The throwaway key is generated here, removed from the transcript, and the transcript is refused if
 * any 8-character run of it survives.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { redact, redactionViolations } from "./lib/redact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
// A subdirectory: every JSON directly under runs/ is a platform record to test/pi-compat.test.mjs.
const RUNS = join(HERE, "runs", "login");
const MODE = process.argv[2];
const CONTROL_TIMEOUT_S = 20;

if (process.platform !== "linux") fail("this check runs on Linux only, under script(1)");
if (!["controls", "interactive"].includes(MODE)) fail("usage: login-check.mjs controls|interactive");
if (spawnSync("script", ["--version"], { encoding: "utf8" }).status !== 0) fail("script(1) is not available");

/** The pinned CLI, resolved from this checkout's install. */
const piPkg = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent");
const manifest = JSON.parse(readFileSync(join(piPkg, "package.json"), "utf8"));
const PI_CLI = join(piPkg, typeof manifest.bin === "string" ? manifest.bin : manifest.bin.pi);
const PINNED = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).dependencies["@earendil-works/pi-coding-agent"];

/** The launch arguments, identical for the interactive run and every control. */
export const LAUNCH_ARGS = [
  "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
  "--no-context-files", "--no-approve", "--offline",
];

const WORK = mkdtempSync(join(tmpdir(), "kiln-login-"));
const HOME_DIR = join(WORK, "home");
const AGENT_DIR = join(WORK, "agent");
const PROJECT = join(WORK, "project");
for (const d of [HOME_DIR, AGENT_DIR, PROJECT]) mkdirSync(d, { recursive: true });

/** The only environment Pi receives. No credential name can reach it. */
const ENV = {
  // Node's own directory and the system binaries only, never the operator's PATH.
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: HOME_DIR,
  TERM: process.env.TERM || "xterm-256color",
  LANG: "C.UTF-8",
  PI_CODING_AGENT_DIR: AGENT_DIR,
};

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const envPrefix = `env -i ${Object.entries(ENV).map(([k, v]) => q(`${k}=${v}`)).join(" ")}`;
const piCommand = `${envPrefix} ${q(process.execPath)} ${q(PI_CLI)} ${LAUNCH_ARGS.map(q).join(" ")}`;

/** `pi auth check`, run outside any terminal. Its stdout is JSON and carries no credential. */
function authCheck() {
  const r = spawnSync(process.execPath, [PI_CLI, "auth", "check", "--provider", "openai", "--json", "--no-refresh"], {
    cwd: PROJECT, env: ENV, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
  let parsed = null;
  try { parsed = JSON.parse((r.stdout ?? "").trim()); } catch {}
  return { exit: r.status, result: parsed, stderr: r.stderr ?? "" };
}

/** Text with terminal control sequences removed, so a transcript can be read and searched. */
const plain = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/\x1b[@-Z\\-_]/g, "")
  .replace(/\r/g, "")
  // Screen padding, not content: the TUI pads every line to the terminal width.
  .replace(/[ \t]+$/gm, "");

/** What in the raw bytes shows the interactive TUI took the terminal. */
const tuiSignals = (raw) => ({
  bracketedPasteEnabled: raw.includes("\x1b[?2004h"),
  cursorHidden: raw.includes("\x1b[?25l"),
  alternateScreen: raw.includes("\x1b[?1049h"),
});

/**
 * Run Pi under script(1), with optional shell text before and after the Pi stage, and return Pi's own
 * exit code and elapsed time, the transcript and the signals.
 *
 * ⚠️ BOTH ARE TAKEN INSIDE THE PI STAGE. Timing the whole pipeline would count a feeding `sleep` as
 * Pi's time, and $? after a pipeline is the last stage's.
 */
function underScript(label, stage, { before = "", after = "", interactive = false } = {}) {
  const raw = join(WORK, `${label}.raw`);
  const exitFile = join(WORK, `${label}.exit`);
  const started = Date.now();
  const timedShell = `${before} { s=$(date +%s%3N); ${stage}; c=$?; e=$(date +%s%3N); echo "$c $((e - s))" > ${q(exitFile)}; } ${after}`;
  const inner = ["script", "-q", "-e", "-c", `bash -c ${q(timedShell)}`, raw];
  // ⚠️ A CONTROL'S script(1) READS AN OPEN, SILENT PIPE. Given /dev/null it would pass end-of-file to
  // the pseudo-terminal, and a TUI ended by that would be ended by the harness rather than by Pi.
  const r = interactive
    ? spawnSync(inner[0], inner.slice(1), { cwd: PROJECT, stdio: "inherit" })
    : spawnSync("bash", ["-c", `sleep ${CONTROL_TIMEOUT_S + 20} | ${inner.map(q).join(" ")}`], {
        cwd: PROJECT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
      });
  const bytes = existsSync(raw) ? readFileSync(raw, "utf8") : "";
  const [status, piElapsed] = (existsSync(exitFile) ? readFileSync(exitFile, "utf8").trim() : "").split(" ");
  return {
    label,
    scriptExit: r.status,
    // ⚠️ PI'S EXIT, NOT script's. The shell writes it straight after Pi returns.
    piExit: status === undefined || status === "" ? null : Number(status),
    piElapsedMs: piElapsed === undefined ? null : Number(piElapsed),
    harnessElapsedMs: Date.now() - started,
    signals: tuiSignals(bytes),
    // script(1)'s own header and footer lines are its, not Pi's.
    text: plain(bytes).split("\n").filter((l) => !/^Script (started|done) on /.test(l)).join("\n"),
  };
}

function fail(message) {
  console.error(`login-check: ${message}`);
  process.exit(2);
}

/** Refuse to keep anything that still carries the key, whole or in part. */
function assertKeyAbsent(text, key, where) {
  const secret = key.slice(key.lastIndexOf("-") + 1);
  for (let i = 0; i + 8 <= secret.length; i++)
    if (text.includes(secret.slice(i, i + 8))) fail(`${where} still carries part of the throwaway key; nothing was saved`);
  if (text.includes(key)) fail(`${where} still carries the throwaway key; nothing was saved`);
}

const meta = {
  platform: process.platform,
  node: process.version,
  pinned: PINNED,
  piVersion: manifest.version,
  ranAt: new Date().toISOString(),
  launchArgs: LAUNCH_ARGS,
  environmentNames: Object.keys(ENV).sort(),
  isolation: "HOME, PI_CODING_AGENT_DIR and the working directory are fresh temporary directories",
  terminal: "script(1) pseudo-terminal, Linux only",
};

let record;
let transcript = "";
let key = null;

if (MODE === "controls") {
  const timed = (cmd) => `timeout --foreground -k 5 ${CONTROL_TIMEOUT_S} ${cmd}`;
  const cases = [
    // The TUI control: both streams are the pseudo-terminal. Nobody types, so it is stopped at the timeout.
    // [label, streams, shell before the Pi stage, shell after it]. The Pi stage itself never changes.
    ["both-tty", "stdin TTY, stdout TTY", "", ""],
    ["stdin-closed", "stdin /dev/null, stdout TTY", "", "< /dev/null"],
    ["stdin-open-pipe", "stdin an open pipe, stdout TTY", `sleep ${CONTROL_TIMEOUT_S + 15} |`, ""],
    ["stdout-pipe", "stdin TTY, stdout a pipe", "", "| cat"],
    ["both-pipes", "stdin an open pipe, stdout a pipe", `sleep ${CONTROL_TIMEOUT_S + 15} |`, "| cat"],
  ];
  const runs = [];
  for (const [label, streams, before, after] of cases) {
    const r = underScript(label, timed(piCommand), { before, after });
    runs.push({
      label, streams,
      piExit: r.piExit,
      timedOut: r.piExit === 124 || r.piExit === 137,
      piElapsedMs: r.piElapsedMs,
      signals: r.signals,
      tuiObserved: r.signals.bracketedPasteEnabled || r.signals.alternateScreen,
      firstText: r.text.trim().slice(0, 600),
    });
    transcript += `\n===== ${label} (${streams}) =====\n${r.text}\n`;
    console.log(`  ${label.padEnd(16)} exit=${r.piExit} tui=${runs.at(-1).tuiObserved} ${r.piElapsedMs} ms`);
  }
  record = { meta: { ...meta, controlTimeoutSeconds: CONTROL_TIMEOUT_S }, controls: runs };
} else {
  key = `sk-kiln-throwaway-${randomBytes(16).toString("hex")}`;
  const before = authCheck();
  console.log(`
  Pi will start in its full interactive TUI, isolated from your own configuration.

    1. Type /login and press Enter.
    2. Choose "Sign in with an API key", then select OpenAI.
    3. Paste this throwaway key, which works nowhere:

         ${key}

    4. When Pi reports the key is saved, exit Pi (Ctrl+C twice, or /quit).

  Press Enter to start.`);
  spawnSync("bash", ["-c", "read -r _"], { stdio: "inherit" });
  const run = underScript("interactive", piCommand, { interactive: true });
  const after = authCheck();
  const authFile = join(AGENT_DIR, "auth.json");
  const stored = existsSync(authFile) ? readFileSync(authFile, "utf8") : "";
  let storedShape = null;
  try { storedShape = Object.fromEntries(Object.entries(JSON.parse(stored)).map(([p, c]) => [p, { type: c?.type ?? null }])); } catch {}

  const keyOccurrences = run.text.split(key).length - 1;
  const sanitized = run.text.split(key).join("[THROWAWAY-KEY-REDACTED]");
  transcript = sanitized;
  record = {
    meta,
    interactive: {
      piExit: run.piExit,
      scriptExit: run.scriptExit,
      piElapsedMs: run.piElapsedMs,
      signals: run.signals,
      tuiObserved: run.signals.bracketedPasteEnabled || run.signals.alternateScreen,
      loginTyped: /\/login/.test(run.text),
      keyOccurrencesRedacted: keyOccurrences,
    },
    authBefore: { exit: before.exit, result: before.result },
    authAfter: { exit: after.exit, result: after.result },
    stored: {
      authFilePresent: stored !== "",
      shape: storedShape,
      // Compared here and reduced to a boolean. The key itself is never written anywhere retained.
      storedKeyIsTheThrowawayKey: stored.includes(key),
    },
    limits: [
      "auth check --no-refresh confirms locally configured authentication; it does not show the key works against a provider",
      "Linux only: observed under script(1) in a pseudo-terminal, not in a Windows terminal",
      "the throwaway key is not a credential; account authentication is TSK-0066's",
    ],
  };
  assertKeyAbsent(JSON.stringify(record), key, "the record");
}

const out = `login-${MODE}-linux`;
const text = JSON.stringify(redact(record), null, 2) + "\n";
const cleanTranscript = redact(transcript).replace(/\n+$/, "") + "\n";
for (const [name, body] of [["record", text], ["transcript", cleanTranscript]]) {
  const v = redactionViolations(body);
  if (v.length) fail(`the ${name} retains machine-identifying content: ${JSON.stringify(v.slice(0, 3))}`);
}
if (key) {
  assertKeyAbsent(text, key, "the saved record");
  assertKeyAbsent(cleanTranscript, key, "the saved transcript");
}
mkdirSync(RUNS, { recursive: true });
writeFileSync(join(RUNS, `${out}.json`), text);
writeFileSync(join(RUNS, `${out}.transcript.txt`), cleanTranscript);
rmSync(WORK, { recursive: true, force: true });
console.log(`\nsaved runs/login/${out}.json and runs/login/${out}.transcript.txt`);
