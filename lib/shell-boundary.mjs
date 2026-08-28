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

/* ==================================================================================================
 * The read and `<Suspense>` confinement analysis — CMP-0019, second half (TSK-0015).
 * ================================================================================================ */

/** Ranges covered by a `<Suspense>` element, so an enclosure question becomes an interval question. */
export function suspenseRanges(src) {
  const text = stripComments(src);
  const ranges = [];
  const stack = [];
  const re = /<\s*(\/?)\s*Suspense\b([^>]*)>/g;
  for (let m; (m = re.exec(text)); ) {
    const closing = m[1] === "/";
    const selfClosing = /\/\s*$/.test(m[2] ?? "");
    if (closing) {
      const open = stack.pop();
      if (open !== undefined) ranges.push([open, m.index + m[0].length]);
    } else if (!selfClosing) {
      stack.push(m.index);
    }
  }
  return ranges;
}

const lineAt = (text, index) => text.slice(0, index).split("\n").length;

/** Every place `<Name` is rendered, with whether a `<Suspense>` encloses it. */
export function jsxUsages(src, name) {
  const text = stripComments(src);
  const ranges = suspenseRanges(src);
  const out = [];
  const re = new RegExp(`<\\s*${name}\\b`, "g");
  for (let m; (m = re.exec(text)); )
    out.push({
      line: lineAt(text, m.index),
      enclosed: ranges.some(([a, b]) => m.index > a && m.index < b),
    });
  return out;
}

/**
 * Import bindings from a matching module: the LOCAL name and the name it was imported under.
 *
 * ⚠️ Both are needed because the confinement rule is fail-closed on renaming. A reader-consuming
 * component must be rendered by its declared name, so `import { Panel as P }` is an indirection the
 * analyser refuses rather than silently follows.
 */
export function importBindings(src, resolveSpec) {
  const text = stripComments(src);
  const out = [];
  const re = /(?:^|[\s;}])import\s+([^;]*?)\s+from\s*["']([^"']+)["']/g;
  for (let m; (m = re.exec(text)); ) {
    if (!resolveSpec(m[2])) continue;
    const line = lineAt(text, m.index + Math.max(0, m[0].search(/\bimport\b/)));
    const clause = m[1];
    const braced = clause.match(/\{([^}]*)\}/);
    if (braced)
      for (const part of braced[1].split(",")) {
        const [imported, local] = part.trim().split(/\s+as\s+/).map((x) => x?.trim());
        if (imported) out.push({ local: local ?? imported, imported, isDefault: false, line });
      }
    const def = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
    if (def && !def.startsWith("*")) out.push({ local: def, imported: "default", isDefault: true, line });
  }
  return out;
}

/**
 * How often `name` appears as an identifier versus as a JSX tag.
 *
 * ⚠️ Import statements are removed first, so the binding itself is not counted as a use. Anything
 * left over that is NOT a `<Name>` or `</Name>` is the component being handled as a value — passed
 * as a prop, aliased to a variable, called directly — which is the indirection this analysis cannot
 * follow and therefore refuses.
 */
export function identifierUses(src, name) {
  const text = stripComments(src).replace(/(?:^|[\s;}])import\s+[^;]*?\s+from\s*["'][^"']+["']/g, " ");
  const all = text.match(new RegExp(`\\b${name}\\b`, "g")) ?? [];
  const jsx = text.match(new RegExp(`<\\s*/?\\s*${name}\\b`, "g")) ?? [];
  return { total: all.length, jsx: jsx.length, indirect: all.length - jsx.length };
}

/** Names this file imports from `spec`, plus the default import if any. */
function importedNamesFrom(src, resolveSpec) {
  const text = stripComments(src);
  const names = [];
  const re = /(?:^|[\s;}])import\s+([^;]*?)\s+from\s*["']([^"']+)["']/g;
  for (let m; (m = re.exec(text)); ) {
    if (!resolveSpec(m[2])) continue;
    const clause = m[1];
    const braced = clause.match(/\{([^}]*)\}/);
    if (braced)
      for (const part of braced[1].split(","))
        names.push(part.trim().split(/\s+as\s+/).pop().trim());
    const def = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
    if (def && !def.startsWith("*")) names.push(def);
  }
  return names.filter(Boolean);
}

/**
 * Confine planning-content reads to the designated reader, and prove every component that awaits it
 * is rendered inside a `<Suspense>` boundary.
 *
 * ⚠️ SCOPE IS EVERY MODULE UNDER `app/`, for the same reason the import boundary's is: a
 * reachability-scoped check examined almost nothing while the shell had no views.
 *
 * ⚠️ It asserts the READER EXISTS AND WAS SEEN. A confinement check whose designated destination is
 * missing or misspelled would report a clean project by confining reads to nowhere.
 *
 * ⚠️ THE ENCLOSURE RULE IS FAIL-CLOSED. A reader-consuming component may only be rendered as a
 * literal `<Name>` at a call site that also carries the `<Suspense>`. Aliasing it, handing it to a
 * wrapper as a value, rendering it through a variable, or relying on a boundary in a parent layout
 * are all REFUSED as `unsupported-indirection` — not because any of them is wrong, but because the
 * enclosure question moves somewhere this analysis cannot answer it. Allowing one is a deliberate
 * extension of the analyser, never an exemption.
 */
export function analyseReadBoundary({ appDir, allowedDir, readerFile, exclude = [] }) {
  const excluded = new Set(exclude.map((p) => resolve(p)));
  const reader = resolve(readerFile);
  const scanned = listFiles(appDir).filter((f) => !excluded.has(resolve(f)));
  const readerSeen = scanned.some((f) => resolve(f) === reader);

  const violations = [];
  const add = (kind, file, line, detail) => violations.push({ kind, file, line, detail });

  // Which files consume the reader, and under which local names.
  const consumers = new Map(); // file -> [names]
  for (const file of scanned) {
    const src = readFileSync(file, "utf-8");
    const names = importedNamesFrom(src, (spec) => {
      const t = resolveRelative(file, spec);
      return t && resolve(t) === reader;
    });
    if (names.length) consumers.set(file, names);
  }

  for (const file of scanned) {
    const src = readFileSync(file, "utf-8");
    const text = stripComments(src);
    const isReader = resolve(file) === reader;
    const isAdapter = inside(file, allowedDir);

    for (const { spec, line } of specifiersIn(src)) {
      // (a) direct filesystem access anywhere in the application
      if (/^node:fs(\/promises)?$/.test(spec) || spec === "fs" || spec === "fs/promises")
        add("fs-access", file, line, `imports ${spec} — planning content is read only through the reader`);

      // (b) the adapters are the reader's to call. Anything else reaching them skips connection().
      const target = resolveRelative(file, spec);
      if (target && inside(target, allowedDir) && !isReader && !isAdapter)
        add(
          "adapter-outside-reader",
          file,
          line,
          `imports ${spec} — only the reader may call the adapters, or the read escapes connection()`
        );
    }

    // (c) a route entry that awaits the reader itself has nothing above it to wrap the read.
    const names = consumers.get(file) ?? [];
    if (names.length && ROUTE_ENTRIES.test(file.split(sep).pop())) {
      for (const n of names) {
        const re = new RegExp(`await\\s+${n}\\s*\\(`, "g");
        for (let m; (m = re.exec(text)); )
          add(
            "read-in-route-entry",
            file,
            lineAt(text, m.index),
            `awaits ${n}() in a route entry — no <Suspense> can enclose it; move the read into a child component`
          );
      }
    }
  }

  // (d) every component that awaits the reader must be enclosed wherever it is rendered.
  for (const [file, names] of consumers) {
    if (resolve(file) === reader) continue;
    const text = stripComments(readFileSync(file, "utf-8"));
    const awaited = names.filter((n) => new RegExp(`await\\s+${n}\\s*\\(`).test(text));
    if (!awaited.length) continue;

    const exported = [...text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
    const isDefault = /export\s+default\s+(?:async\s+)?function/.test(text);

    // ⚠️ The declared name is what a call site must use. For a default export it is the function's
    // own name, which is why an anonymous default export is itself refused below.
    const defaultName = (text.match(/export\s+default\s+(?:async\s+)?function\s+(\w+)/) ?? [])[1] ?? null;

    for (const other of scanned) {
      if (other === file) continue;
      const src = readFileSync(other, "utf-8");
      const bindings = importBindings(src, (spec) => {
        const t = resolveRelative(other, spec);
        return t && resolve(t) === resolve(file);
      });

      for (const b of bindings) {
        const declared = b.isDefault ? defaultName : b.imported;
        if (!b.isDefault && !exported.includes(b.imported)) continue;

        // ⚠️ FAIL CLOSED ON EVERY FORM OF INDIRECTION. The enclosure question is only answerable
        // where the component is written literally as `<Name>` at the call site that also carries the
        // boundary. Aliasing, a render prop, a variable, or a boundary living in a parent layout all
        // put the answer somewhere this analysis cannot see — so each is refused rather than assumed
        // safe. Extending the analyser is the way to allow one, not an exemption.
        if (declared === null)
          add(
            "unsupported-indirection",
            other,
            b.line,
            `imports a reader-consuming default export with no declared name — give the component a name so a call site can render it directly`
          );
        else if (b.local !== declared)
          add(
            "unsupported-indirection",
            other,
            b.line,
            `renames <${declared}> to <${b.local}> — a reader-consuming component must be rendered under its declared name`
          );

        const uses = identifierUses(src, b.local);
        if (uses.indirect > 0)
          add(
            "unsupported-indirection",
            other,
            b.line,
            `uses ${b.local} as a value ${uses.indirect} time(s) rather than rendering <${b.local}> directly — the <Suspense> enclosure cannot be determined`
          );
        else if (uses.jsx === 0)
          add(
            "unsupported-indirection",
            other,
            b.line,
            `imports ${b.local} but never renders it as <${b.local}> — nothing here can be shown to be enclosed`
          );

        for (const use of jsxUsages(src, b.local))
          if (!use.enclosed)
            add(
              "missing-suspense",
              other,
              use.line,
              `<${b.local}> reads planning content and is not enclosed by <Suspense> at this call site`
            );
      }
    }
  }

  return { scanned, readerSeen, reader, consumers: [...consumers.keys()], violations };
}

/** One human line per read-boundary violation. */
export function formatReadViolation(v, root = process.cwd()) {
  return `${relative(root, v.file).split(sep).join("/")}:${v.line}  [${v.kind}] ${v.detail}`;
}
