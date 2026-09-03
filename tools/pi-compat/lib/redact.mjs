/**
 * Deterministic redaction for anything the spike saves.
 *
 * ⚠️ ACC-0040 FAILED ON THE FIRST RUN AND THIS IS WHY IT EXISTS. The criterion forbids an absolute
 * user-home path in a saved fixture, and the retained results were full of
 * `C:\Users\<name>\AppData\...` because the runs genuinely happen there. Redacting at write time —
 * rather than asserting the paths happen not to appear — is the only version of this that stays
 * true on somebody else's machine.
 *
 * DETERMINISTIC means two runs on two machines produce byte-identical text for the same
 * observations, so a diff of `runs/` shows behaviour changing and never whose laptop it ran on.
 */
import { homedir, tmpdir } from "node:os";

/** Longest first, so `<tmp>` inside `<home>` is replaced by the more specific token. */
function replacements() {
  const raw = [
    [tmpdir(), "<TMP>"],
    [homedir(), "<HOME>"],
    [process.cwd(), "<CWD>"],
  ].filter(([from]) => from && from.length > 2);

  const out = [];
  for (const [from, to] of raw) {
    const win = from.replace(/\//g, "\\");
    const posix = from.replace(/\\/g, "/");
    out.push([win, to], [posix, to]);
    // JSON-encoded Windows paths arrive with doubled separators.
    out.push([win.replace(/\\/g, "\\\\"), to]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

const USERNAME_TOKENS = [process.env.USERNAME, process.env.USER, process.env.LOGNAME].filter(
  (v) => typeof v === "string" && v.length >= 3
);

/**
 * Redact a string. Absolute machine paths become tokens; a bare username becomes `<USER>`; anything
 * shaped like a key is replaced whether or not we believe one can be present.
 */
export function redactText(text) {
  let out = String(text);
  for (const [from, to] of replacements()) {
    out = out.split(from).join(to);
  }
  for (const name of USERNAME_TOKENS) {
    out = out.split(name).join("<USER>");
  }

  // ⚠️ THE REDACTOR MUST NEUTRALISE EVERY SHAPE THE DETECTOR FLAGS, and for a while it did not.
  // The replacements above only know THIS machine's home, temp and cwd, so a home path belonging to
  // somebody else — an npm cache line from a CI runner, a path embedded in a dependency's output —
  // was detected and could not be removed. A detector and a redactor that disagree is the same bug
  // class as a guard that lists fields by hand: one of them is always behind.
  out = out.replace(/([A-Za-z]:[\\/]{1,2}Users[\\/]{1,2})[^\\/"'\s]+/g, "<HOME>");
  out = out.replace(/\/home\/[^/"'\s]+/g, "<HOME>");
  out = out.replace(/\/Users\/[^/"'\s]+/g, "<HOME>");

  // Belt and braces: credential-shaped literals, and the sentinel values the controls inject.
  out = out.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "<REDACTED-KEY>");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer <REDACTED>");
  out = out.replace(/(KILN_SENTINEL_[A-Z_]*"?\s*:\s*")[^"]+"/g, '$1<REDACTED>"');
  return out;
}

/** Redact every string inside a structure, keys included, preserving shape and order. */
export function redact(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[redactText(k)] = redact(v);
    return out;
  }
  return value;
}

/**
 * The assertion side of the same rule, usable from a test: what must never appear in saved output.
 * Returns the offending fragments so a failure names them instead of merely failing.
 */
export function redactionViolations(text) {
  const found = [];
  // ⚠️ THE SEPARATOR COUNT IS `{1,2}` BECAUSE THE BYTES BEING SCANNED ARE USUALLY JSON. A Windows
  // path inside a serialised document is `C:\\Users\\alice`, with each backslash escaped, and a
  // pattern requiring a single one walks straight past it — reproduced with
  // `JSON.stringify({p: "C:\\Users\\alice\\secret"})` returning an empty violation list while the
  // same path as a raw string was flagged. The redactor already handled both spellings, so detector
  // and redactor disagreed with the DETECTOR weaker, which is the dangerous direction: the scan
  // passes on bytes the criterion forbids. Same bug class as a guard that lists fields by hand —
  // two things that must agree, maintained separately.
  const patterns = [
    [/[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/"'\s]+/g, "absolute Windows home path"],
    [/[\\/]{1,2}home[\\/]{1,2}[^\\/"'\s]+/g, "absolute POSIX home path"],
    [/[\\/]{1,2}Users[\\/]{1,2}[^\\/"'\s]+/g, "absolute macOS home path"],
    [/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "credential-shaped literal"],
    [/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "bearer token"],
    [/KILN_SENTINEL_[A-Z_]*"?\s*:\s*"[^"]+"/g, "sentinel value"],
  ];
  for (const [re, label] of patterns) {
    for (const m of String(text).matchAll(re)) found.push({ label, fragment: m[0] });
  }
  return found;
}
