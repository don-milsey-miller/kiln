/**
 * #39 — which artifact types this project has activated.
 *
 * Activation is a stage-2 decision the agent proposes and the PM approves, recorded in
 * `project.yaml`. It is READ here and never inferred: nothing in the codebase is allowed to
 * decide for itself which types a project uses.
 *
 * One reader, because the CLI, the lint, the tests and eventually the app all need this and
 * four hand-rolled parsers is four chances to disagree about what the PM approved — the same
 * argument as #47's one resolver and #87's one layout.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read `artifactTypes.activated` from a project manifest.
 * Accepts the inline form `activated: [a, b]` and the block form `activated:\n  - a\n  - b`.
 *
 * @returns {string[]} activated type names, or [] when the manifest or the key is absent
 */
export function readActivatedTypes(contentRoot) {
  const manifest = join(contentRoot, "project.yaml");
  if (!existsSync(manifest)) return [];
  const text = readFileSync(manifest, "utf-8");

  const inline = /^\s*activated:\s*\[([^\]]*)\]/m.exec(text);
  if (inline) return split(inline[1]);

  const block = /^\s*activated:\s*(?:#[^\n]*)?\n((?:\s*-\s*[^\n]*\n?)+)/m.exec(text);
  if (block)
    return block[1]
      .split("\n")
      .map((l) => /^\s*-\s*(.*)$/.exec(l)?.[1] ?? "")
      .map(clean)
      .filter(Boolean);

  return [];
}

const clean = (s) => s.replace(/#.*$/, "").trim().replace(/^["']|["']$/g, "");
const split = (s) => s.split(",").map(clean).filter(Boolean);
