/**
 * The import-boundary analysis — CMP-0019, first half (TSK-0006).
 *
 * ⚠️ **It never executes application code.** It reads files as text and walks the import graph.
 * AST-0022 is why: a non-compliant read is served FRESH whenever a compliant one shares its route,
 * so every behavioural check passes on a codebase that breaks the contract until the compliant
 * sibling moves. A rule that can only be observed by running the thing is a rule nothing enforces.
 *
 * ⚠️ **SCOPE IS EVERY MODULE UNDER `app/`; REACHABILITY ONLY SUPPLIES THE CHAIN.** The first
 * version had it the other way round — it checked only what a route could reach, and since no view
 * imports the reader yet it walked two files and reported the project clean without ever looking at
 * the modules the rule is about. A check that passes because it examined nothing is worse than no
 * check, so the scope is the directory and the graph walk exists to answer "reached from where".
 *
 *   - An intermediate module cannot hide a violation. `page.js` importing `helper.js` which
 *     re-exports `lib/` is reported at `helper.js` — the file whose import statement is the
 *     violation — with the chain that reaches it.
 *   - An orphan cannot hide one either: a module nothing imports yet is still checked, because the
 *     rule is about the code rather than its popularity.
 *   - `app/server.mjs` — the walking skeleton DEC-0017 preserves — is excluded BY NAME through
 *     `shellBoundaryConfig`, not by unreachability. It is a standalone Node program that happens to
 *     live in `app/`. Naming it makes a second exclusion a visible act.
 *
 * ⚠️ **Regex, not a parser, and it says so.** Comments are stripped first (preserving line numbers)
 * so a `lib/` path inside prose cannot raise a false alarm. What this cannot see is a computed
 * specifier — `import(someVariable)` — which is recorded as a limitation rather than silently
 * treated as absence. TSK-0015 carries the same caveat.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const CODE = /\.(js|mjs|cjs|jsx|ts|tsx)$/;
const RESOLVE_ORDER = ["", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", "/index.js", "/index.mjs", "/index.jsx"];

/** Files the App Router treats as entry points. Anything reachable from one of these is app code. */
export const ROUTE_ENTRIES = /^(page|layout|route|template|loading|error|not-found|global-error|default)\.(js|mjs|jsx|ts|tsx)$/;

/**
 * Blank out comments while preserving every newline, so a match's line number stays true and a
 * `../../lib/x.mjs` written inside a doc comment cannot be mistaken for an import.
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const keepNewlines = (s) => s.replace(/[^\n]/g, " ");
  while (i < src.length) {
    const block = src.indexOf("/*", i);
    const line = src.indexOf("//", i);
    const next = block === -1 ? line : line === -1 ? block : Math.min(block, line);
    if (next === -1) return out + src.slice(i);
    out += src.slice(i, next);
    if (next === block) {
      const end = src.indexOf("*/", next + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += keepNewlines(src.slice(next, stop));
      i = stop;
    } else {
      const end = src.indexOf("\n", next);
      const stop = end === -1 ? src.length : end;
      out += keepNewlines(src.slice(next, stop));
      i = stop;
    }
  }
  return out;
}

/**
 * Every module specifier in one file, with the line it appears on.
 *
 * Covers the three forms the contract names: static `import … from`, side-effect `import "x"`,
 * `export … from`, and a dynamic `import("x")` whose argument is a literal.
 */
export function specifiersIn(src) {
  const text = stripComments(src);
  const found = [];
  // ⚠️ The line is computed from the KEYWORD, not from the match start. The patterns below consume
  // the character before `import`/`export` so a specifier inside an identifier cannot match — and
  // that character is usually the previous line's newline, which reported every statement one line
  // early. Caught by the transitive fixture, whose violation is deliberately not on line 1.
  const push = (m, index) => {
    const at = index + Math.max(0, m[0].search(/\b(?:import|export)\b/));
    found.push({ spec: m[1], line: text.slice(0, at).split("\n").length });
  };
  // ⚠️ The first pattern is TEMPERED — it cannot cross a `;` or another `import`/`export` keyword.
  // A plain lazy `[\s\S]*?` let a side-effect `import "server-only";` on one line run on to the
  // `from "./y.js"` of the NEXT statement, reporting that specifier against the wrong line and
  // swallowing the statement between them. Multi-line import clauses still match, because they
  // contain neither a semicolon nor a second keyword.
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\b(?:(?!\bimport\b|\bexport\b|;)[\s\S])*?\bfrom\s*["']([^"']+)["']/g,
    /(?:^|[\s;}])import\s*["']([^"']+)["']/g, //  side-effect import
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, //  literal dynamic import
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text)); ) push(m, m.index);
  }
  return found.sort((a, b) => a.line - b.line);
}

/** True when a specifier is computed rather than literal — reported, never silently ignored. */
export function computedDynamicImports(src) {
  const text = stripComments(src);
  const found = [];
  const re = /\bimport\s*\(\s*(?!["'])/g;
  for (let m; (m = re.exec(text)); ) found.push({ line: text.slice(0, m.index).split("\n").length });
  return found;
}

function resolveRelative(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // bare specifier: a package, not ours
  const base = resolve(dirname(fromFile), spec);
  for (const ext of RESOLVE_ORDER) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const listFiles = (dir) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? listFiles(join(dir, e.name)) : CODE.test(e.name) ? [join(dir, e.name)] : []
      );

const inside = (file, dir) => {
  const rel = relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !resolve(rel).startsWith(sep) ? true : false;
};

/**
 * Walk the application's import graph from its route entry points and report every module outside
 * the allowed directory that reaches `lib/`.
 *
 * @param {{appDir: string, libDir: string, allowedDir: string}} opts
 * @returns {{entries: string[], reachable: string[], violations: Array<{file: string, line: number, specifier: string, chain: string[]}>, computed: Array<{file: string, line: number}>}}
 */
export function analyseShellBoundary({ appDir, libDir, allowedDir, exclude = [] }) {
  const entries = listFiles(appDir).filter((f) => ROUTE_ENTRIES.test(f.split(sep).pop()));
  const excluded = new Set(exclude.map((p) => resolve(p)));

  // ⚠️ REACHABILITY IS FOR THE CHAIN, NOT FOR THE SCOPE, and that distinction was a real bug. An
  // earlier version checked only what a route could reach — and since no view imports the reader
  // yet, it walked two files and reported a clean project without ever looking at the modules the
  // rule is about. A check that passes because it examined nothing is worse than no check.
  const chains = new Map(); // file -> the first path from an entry that reaches it
  const queue = entries.map((f) => ({ file: f, chain: [f] }));
  while (queue.length) {
    const { file, chain } = queue.shift();
    if (chains.has(file)) continue;
    chains.set(file, chain);
    for (const { spec } of specifiersIn(readFileSync(file, "utf-8"))) {
      const target = resolveRelative(file, spec);
      if (target && !inside(target, libDir) && !chains.has(target)) queue.push({ file: target, chain: [...chain, target] });
    }
  }

  // The SCOPE is every module under app/, minus declared exclusions. An orphan that reaches lib/ is
  // a violation waiting for its first importer, and the rule is about the code, not its popularity.
  const violations = [];
  const computed = [];
  const scanned = listFiles(appDir).filter((f) => !excluded.has(resolve(f)));

  for (const file of scanned) {
    const src = readFileSync(file, "utf-8");
    for (const { line } of computedDynamicImports(src)) computed.push({ file, line });
    if (inside(file, allowedDir)) continue; // the door is allowed to reach lib/ — that is its job
    for (const { spec, line } of specifiersIn(src)) {
      const target = resolveRelative(file, spec);
      if (target && inside(target, libDir))
        violations.push({ file, line, specifier: spec, chain: chains.get(file) ?? [file] });
    }
  }

  return { entries, scanned, reachable: [...chains.keys()], violations, computed };
}

/** One human line per violation, naming the file that contains the offending import. */
export function formatViolation(v, root = process.cwd()) {
  const rel = (p) => relative(root, p).split(sep).join("/");
  const via = v.chain.length > 1 ? `\n      reached from: ${v.chain.map(rel).join(" → ")}` : "";
  return `${rel(v.file)}:${v.line}  imports ${v.specifier} — only modules under app/server/ may reach lib/${via}`;
}

/**
 * The project's own boundary configuration — one definition, used by the lint command and by the
 * tests, so they cannot disagree about what is checked.
 *
 * ⚠️ ONE EXCLUSION, AND IT IS DECLARED RATHER THAN INFERRED. `app/server.mjs` is the walking
 * skeleton DEC-0017 preserves as the verified substrate reference: a standalone Node program that
 * happens to live in `app/`, reachable from no route, importing `lib/` directly as it always has.
 * Naming it here makes adding a second exclusion a visible act. The alternative considered and
 * rejected was excluding everything unreachable from a route — which would have quietly excluded
 * every module no view imports yet, which today is most of the shell.
 */
export function shellBoundaryConfig(root) {
  return {
    appDir: join(root, "app"),
    libDir: join(root, "lib"),
    allowedDir: join(root, "app", "server"),
    exclude: [join(root, "app", "server.mjs")],
  };
}
