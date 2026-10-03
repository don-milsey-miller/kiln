/** Read-only, bounded normalized-source preview for the local browser review surface. */

import { lstatSync, readFileSync } from "node:fs";

import { canonicalPath, isAtOrInside, resolveInContentRoot } from "./content-root.mjs";

export const SOURCE_PREVIEW_LIMIT = 8_000;

/**
 * The caller supplies a validated source artifact, never a browser path. The stored relative
 * payload reference is resolved inside the content root and checked again after canonicalization.
 */
export function readSourcePreview(doc, { contentRoot, limit = SOURCE_PREVIEW_LIMIT }) {
  if (doc?.type !== "source" || typeof doc.derivedPayload?.path !== "string") return { unavailable: true };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SOURCE_PREVIEW_LIMIT) return { unavailable: true };
  try {
    const path = resolveInContentRoot(doc.derivedPayload.path, { contentRoot });
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !isAtOrInside(canonicalPath(path), canonicalPath(contentRoot)))
      return { unavailable: true };
    const bytes = readFileSync(path);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      content: content.slice(0, limit),
      truncated: content.length > limit,
      format: doc.derivedPayload.format,
    };
  } catch {
    return { unavailable: true };
  }
}
