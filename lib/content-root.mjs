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
 * Resolve the content root. Throws ContentRootError rather than returning a guess.
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveContentRoot(env = process.env) {
  const override = env[OVERRIDE_ENV];
  const [candidate, how] = override
    ? [resolve(override), `${OVERRIDE_ENV}=${override}`]
    : [resolve(join(toolRoot(), "..", "planning-content")), "<toolRoot>/../planning-content"];

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
