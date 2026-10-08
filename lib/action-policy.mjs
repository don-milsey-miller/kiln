/**
 * What a runbook step is, and what its project requires of the claims beneath it - #181.
 *
 * `project.yaml` carries a table: for each class of action, the lowest confidence rung a claim must have before
 * an instruction of that class may rest on it.
 *
 *   confidence:
 *     thresholds:
 *       informational: 2
 *       mutating: 3
 *       destructive: 4
 *
 * ⚠️ **ONE READER, AND ONE RESOLVER.** Before #181 nothing read the table: the lint chose between two hard-coded
 * rungs on a boolean, so a project's own policy was a comment. Every caller that needs the policy takes it from
 * here, so the table means one thing wherever it is asked about.
 *
 * ⚠️ **A POLICY THAT CANNOT BE READ BLOCKS; IT DOES NOT DEFAULT.** An absent table, or an absent class, takes the
 * default, because that is what the scaffold writes. A value that is not a rung, a value below the floor, a key
 * that is not a class and a key given twice are different: somebody wrote a policy and it does not say what they
 * meant. Guessing would let a typo lower a threshold. The class is reported as having no usable threshold, and
 * the lint blocks every step of that class until the manifest is corrected.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The classes a runbook step may be, from the least to the most consequential. */
export const ACTION_CLASSES = Object.freeze(["informational", "mutating", "destructive"]);

/**
 * The ladder a threshold names a rung of, 1 to 5.
 *
 * ⚠️ **FIVE RUNGS OF POLICY, FOUR OF EVIDENCE.** `production-validated` is a rung a project may require. Nothing
 * Kiln records can derive it: `effective-assertion.mjs` stops at `environment-matched`. A class set to 5 is
 * therefore always blocked, which is what asking for it means today.
 */
export const POLICY_RUNGS = Object.freeze(["unverified", "source-supported", "experimentally-validated", "environment-matched", "production-validated"]);

/** The defaults, and the floor: a project may raise a threshold and may never lower one. */
export const THRESHOLD_FLOOR = Object.freeze({ informational: 2, mutating: 3, destructive: 4 });

export const POLICY_PROBLEM = Object.freeze({
  UNKNOWN_KEY: "unknown-class",
  DUPLICATE_KEY: "duplicate-class",
  NOT_A_RUNG: "not-a-rung",
  BELOW_FLOOR: "below-floor",
  MALFORMED: "malformed-table",
});

/** The name of rung `n`, or `null` when `n` is not a rung. */
export const rungName = (n) => (Number.isInteger(n) && n >= 1 && n <= POLICY_RUNGS.length ? POLICY_RUNGS[n - 1] : null);

const strip = (line) => line.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
const indentOf = (line) => /^[ \t]*/.exec(line)[0].length;

/** The `key: value` entries of the thresholds table as written, in order, or `null` when there is no table. */
function tableEntries(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  for (let i = 0; i < lines.length; i++) if (/^confidence:[ \t]*(?:#.*)?$/.test(lines[i])) sections.push(i);
  if (sections.length === 0) return { entries: null, malformed: false };
  if (sections.length > 1) return { entries: [], malformed: true };

  // The lines that belong to `confidence:`: everything indented beneath it, up to the next top-level key.
  const body = [];
  for (let i = sections[0] + 1; i < lines.length; i++) {
    const line = strip(lines[i]);
    if (line.trim().length === 0) continue;
    if (indentOf(line) === 0) break;
    body.push(line);
  }
  const heads = body.map((line, at) => ({ line, at })).filter(({ line }) => /^[ \t]+thresholds:/.test(line));
  if (heads.length === 0) return { entries: null, malformed: false };
  if (heads.length > 1) return { entries: [], malformed: true };

  const head = heads[0];
  const rest = head.line.replace(/^[ \t]+thresholds:[ \t]*/, "");
  const pairs = [];
  if (rest.length > 0) {
    // The inline form: `thresholds: { informational: 2, mutating: 3 }`.
    const flow = /^\{(.*)\}$/.exec(rest.trim());
    if (!flow) return { entries: [], malformed: true };
    for (const part of flow[1].split(",")) if (part.trim().length > 0) pairs.push(part.trim());
  } else {
    const depth = indentOf(head.line);
    for (let i = head.at + 1; i < body.length; i++) {
      if (indentOf(body[i]) <= depth) break;
      pairs.push(body[i].trim());
    }
  }
  const entries = [];
  for (const pair of pairs) {
    const match = /^([^:]+):[ \t]*(.*)$/.exec(pair);
    if (!match) return { entries: [], malformed: true };
    entries.push({ key: match[1].trim().replace(/^["']|["']$/g, ""), value: match[2].trim() });
  }
  return { entries, malformed: false };
}

/**
 * The project's threshold for each action class.
 *
 * @returns {{thresholds: Record<string, number|null>, problems: {problem: string, key?: string, value?: string, floor?: number}[]}}
 *   A class whose threshold is `null` has no usable policy and is blocked. `problems` says why, once each.
 */
export function readConfidenceThresholds(contentRoot) {
  const defaults = () => ({ ...THRESHOLD_FLOOR });
  const blocked = () => Object.fromEntries(ACTION_CLASSES.map((name) => [name, null]));
  const manifest = join(contentRoot, "project.yaml");
  if (!existsSync(manifest)) return { thresholds: defaults(), problems: [] };

  const { entries, malformed } = tableEntries(readFileSync(manifest, "utf-8"));
  if (malformed) return { thresholds: blocked(), problems: [{ problem: POLICY_PROBLEM.MALFORMED }] };
  if (entries === null) return { thresholds: defaults(), problems: [] };

  const thresholds = defaults();
  const problems = [];
  const seen = new Set();
  let unknown = false;
  for (const { key, value } of entries) {
    if (!ACTION_CLASSES.includes(key)) {
      // ⚠️ A KEY THAT IS NOT A CLASS IS MOST LIKELY A CLASS MISSPELLED, and which one cannot be known. Every class
      // is blocked, so the misspelled one cannot quietly take its default.
      unknown = true;
      problems.push({ problem: POLICY_PROBLEM.UNKNOWN_KEY, key: key.slice(0, 60) });
      continue;
    }
    if (seen.has(key)) {
      thresholds[key] = null;
      problems.push({ problem: POLICY_PROBLEM.DUPLICATE_KEY, key });
      continue;
    }
    seen.add(key);
    const rung = /^[0-9]+$/.test(value) ? Number(value) : NaN;
    if (rungName(rung) === null) {
      thresholds[key] = null;
      problems.push({ problem: POLICY_PROBLEM.NOT_A_RUNG, key, value: value.slice(0, 60) });
    } else if (rung < THRESHOLD_FLOOR[key]) {
      thresholds[key] = null;
      problems.push({ problem: POLICY_PROBLEM.BELOW_FLOOR, key, value, floor: THRESHOLD_FLOOR[key] });
    } else thresholds[key] = rung;
  }
  return { thresholds: unknown ? blocked() : thresholds, problems };
}

export const ACTION_CLASS_SOURCE = Object.freeze({
  DECLARED: "declared",
  LEGACY_DESTRUCTIVE: "legacy-destructive",
  LEGACY_DEFAULT: "legacy-default",
  UNKNOWN: "unknown",
  CONFLICT: "conflict",
});

/**
 * The class of a stored runbook step, and where that answer came from.
 *
 * ⚠️ **`actionClass` IS THE AUTHORITY. `destructive` IS WHAT STEPS WRITTEN BEFORE IT CARRY.** A step that declares a
 * class is that class. A step that does not is read conservatively from the old boolean: `true` is destructive,
 * and `false` or absent is `mutating`, never `informational`. Nothing before #181 recorded that a step was only an
 * inspection, so nothing may be assumed to be one.
 *
 * ⚠️ **FAILS CLOSED.** A class that is not one of the three, and a step whose two fields contradict each other,
 * resolve to no class at all. The lint blocks such a step outright.
 *
 * @returns {{actionClass: string|null, source: string}}
 */
export function resolveActionClass(doc) {
  const declared = doc?.actionClass;
  const legacy = doc?.destructive;
  if (declared !== undefined) {
    if (!ACTION_CLASSES.includes(declared)) return { actionClass: null, source: ACTION_CLASS_SOURCE.UNKNOWN };
    if ((legacy === true && declared !== "destructive") || (legacy === false && declared === "destructive")) return { actionClass: null, source: ACTION_CLASS_SOURCE.CONFLICT };
    return { actionClass: declared, source: ACTION_CLASS_SOURCE.DECLARED };
  }
  if (legacy === true) return { actionClass: "destructive", source: ACTION_CLASS_SOURCE.LEGACY_DESTRUCTIVE };
  if (legacy === false || legacy === undefined) return { actionClass: "mutating", source: ACTION_CLASS_SOURCE.LEGACY_DEFAULT };
  return { actionClass: null, source: ACTION_CLASS_SOURCE.UNKNOWN };
}
