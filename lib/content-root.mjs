/**
 * #70 — how the app finds `planning-content/`, and #47's "one resolver, every caller".
 *
 * ONE rule: `contentRoot = <toolRoot>/../planning-content`. No fallback, no search, no cwd.
 * One documented override: PLANNING_CONTENT_DIR (how this repo dogfoods itself, since
 * `../planning-content` does not exist here). A missing content root refuses to start
 * rather than guessing — the failure #70 exists to prevent is silently resolving against
 * the tool's OWN shipped `planning-content/`, which is present in every consumer install
 * and parses perfectly well as a different project's manifest.
 *
 * This module also owns CONTAINMENT for #86's payloadRef paths. The schema pattern
 * rejects absolute paths and literal `..`, and that is validation, not a boundary:
 * a syntactically innocent path can still leave the content root through a symlink or a
 * platform normalisation quirk. Only resolution against the canonicalised root is a
 * boundary, and it lives here so there is exactly one of it.
 */

import { existsSync, statSync, realpathSync } from "node:fs";
import { dirname, resolve, join, sep, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

const OVERRIDE_ENV = "PLANNING_CONTENT_DIR";

export class ContentRootError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContentRootError";
  }
}

export class PathEscapeError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathEscapeError";
  }
}

/** The tool root — this repo, which becomes a consumer's `.planning/`. Derived from this
 *  module's own location, never from cwd: cwd is whatever the user happened to be in. */
export function toolRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Canonicalise as far as the filesystem allows. realpathSync resolves symlinks, which is
 * the whole point; but it throws on paths that do not exist yet, and a payload path may
 * legitimately point at a file about to be written. So: canonicalise the deepest existing
 * ancestor and re-append the rest.
 */
function canonicalise(p) {
  let current = resolve(p);
  const trailing = [];
  for (;;) {
    if (existsSync(current)) return join(realpathSync(current), ...trailing);
    const parent = dirname(current);
    if (parent === current) return resolve(p); // nothing on this path exists
    trailing.unshift(current.slice(parent.length + 1));
    current = parent;
  }
}

/** Windows paths compare case-insensitively; POSIX paths do not. */
function samePathPrefix(child, parent) {
  const norm = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * WHERE the rule points, before asking whether anything is there.
 *
 * ⚠️ Split out of `resolveContentRoot` so a caller that has to REPORT the path — the launcher prints
 * it, and prints it again in its refusal — does not re-derive it. Two derivations of "where content
 * lives" is exactly the disagreement #70 is about, and it would be at its most confusing in the error
 * message telling an operator which directory was looked at.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{path: string, how: string, override: boolean}}
 */
export function contentRootCandidate(env = process.env) {
  const override = env[OVERRIDE_ENV];
  return override
    ? { path: resolve(override), how: `${OVERRIDE_ENV}=${override}`, override: true }
    : { path: resolve(join(toolRoot(), "..", "planning-content")), how: "<toolRoot>/../planning-content", override: false };
}

/**
 * Resolve the content root. Throws ContentRootError rather than returning a guess.
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveContentRoot(env = process.env) {
  const { path: candidate, how, override } = contentRootCandidate(env);

  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new ContentRootError(
      `No planning content root.\n` +
        `  resolved: ${candidate}\n` +
        `  rule:     ${how}\n` +
        `  toolRoot: ${toolRoot()}\n` +
        `Set ${OVERRIDE_ENV} to point at the project's planning-content directory. ` +
        `Refusing to guess: this tool ships its own planning-content/, and falling back to it ` +
        `would resolve against a different project's manifest without saying so (#70).`
    );
  }

  // Backstop for a future bug rather than part of the mechanism: the content root must not
  // live INSIDE the tool root unless the override put it there deliberately.
  const canonical = canonicalise(candidate);
  if (!override && samePathPrefix(canonical, canonicalise(toolRoot()))) {
    throw new ContentRootError(
      `Resolved content root lies inside the tool root, which #70 forbids without an explicit override.\n` +
        `  resolved: ${canonical}\n  toolRoot: ${canonicalise(toolRoot())}`
    );
  }
  return canonical;
}

/**
 * The PROJECT root — the directory that owns `.pi/`, `.gitignore`, Pi's working directory and the
 * runtime state root. One rule, derived from the content root and never from the tool root.
 *
 * ⚠️ **`projectRoot = dirname(contentRoot)`, ALWAYS — never `<toolRoot>/..`.** The two agree in a
 * normal consumer install and diverge exactly where it matters: with `PLANNING_CONTENT_DIR` set, the
 * project is the owner of THAT directory, and `<toolRoot>/..` would name somewhere else entirely.
 * Deriving it from the resolved content root is what keeps a second path rule from appearing beside
 * the first, which is the disagreement #70 exists to prevent.
 *
 * ⚠️ **It is derived from the RESOLVED root, so it inherits that resolution's refusals.** No project
 * root exists for a project whose content root does not, and callers get one error rather than a
 * plausible directory that happens to be the parent of something missing.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{path: string, how: string, override: boolean}}
 */
export function projectRootCandidate(env = process.env) {
  const content = contentRootCandidate(env);
  return {
    path: dirname(resolve(content.path)),
    how: `dirname(${content.how})`,
    override: content.override,
  };
}

/**
 * Resolve the canonical project root, or throw.
 *
 * With `expect` supplied — setup's `--project-root`, which a caller passes explicitly — the two are
 * compared after canonicalisation and a disagreement REFUSES, printing both paths and the rule that
 * produced each.
 *
 * ⚠️ **A MISMATCH IS NOT A CHOICE, and that is the whole reason this takes `expect` at all.** Setup
 * is handed a project root on the command line and separately resolves the one that owns the content
 * it is about to write into. If those differ, one of them is wrong, and picking either silently is
 * how a command initialises one project while reporting another. Both paths and both rules go in the
 * message so the operator can see WHICH of the two inputs to correct.
 *
 * @param {{env?: NodeJS.ProcessEnv, expect?: string}} [opts]
 */
export function resolveProjectRoot(opts = {}) {
  const env = opts.env ?? process.env;
  // Resolving the content root first is deliberate: its refusals are the more informative ones, and
  // a project root for a content root that does not exist is a directory nobody should act on.
  const contentRoot = resolveContentRoot(env);
  const resolved = canonicalise(dirname(contentRoot));

  if (opts.expect === undefined) return resolved;

  const expected = canonicalise(resolve(opts.expect));
  if (expected !== resolved) {
    const { how } = projectRootCandidate(env);
    throw new ContentRootError(
      `Project root disagreement — refusing to choose between them.\n` +
        `  supplied:    ${expected}\n` +
        `  resolved:    ${resolved}\n` +
        `  rule:        ${how}\n` +
        `  contentRoot: ${contentRoot}\n` +
        `The supplied project root does not own the planning content this would write into. ` +
        `Correct the supplied path, or point ${OVERRIDE_ENV} at the content directory that ` +
        `belongs to it (#70).`
    );
  }
  return resolved;
}

/**
 * Resolve a content-relative path (e.g. #86's `payloadRef.path`) and PROVE it stays inside
 * the content root. Throws PathEscapeError otherwise. Every typed tool, lint rule, renderer
 * and handoff call goes through this — nobody joins their own.
 *
 * @param {string} relPath  path as written in an artifact, relative to the content root
 * @param {{contentRoot?: string, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {string} absolute, canonicalised path inside the content root
 */
export function resolveInContentRoot(relPath, opts = {}) {
  const root = opts.contentRoot ?? resolveContentRoot(opts.env);

  if (typeof relPath !== "string" || relPath.length === 0)
    throw new PathEscapeError(`Payload path must be a non-empty string, got ${JSON.stringify(relPath)}.`);
  if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath))
    throw new PathEscapeError(`Payload path must be relative to the content root: ${relPath}`);

  const canonicalRoot = canonicalise(root);
  const target = canonicalise(join(canonicalRoot, relPath));

  if (!samePathPrefix(target, canonicalRoot))
    throw new PathEscapeError(
      `Payload path escapes the content root.\n` +
        `  written:   ${relPath}\n  resolved:  ${target}\n  root:      ${canonicalRoot}\n` +
        `Syntax checks in the schema are validation; this is the boundary (#86).`
    );

  return target;
}

/** True when `relPath` stays inside the content root. Non-throwing form for the lint. */
export function isInsideContentRoot(relPath, opts = {}) {
  try {
    resolveInContentRoot(relPath, opts);
    return true;
  } catch (e) {
    if (e instanceof PathEscapeError) return false;
    throw e;
  }
}

export { OVERRIDE_ENV };
