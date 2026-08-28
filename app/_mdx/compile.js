import "server-only";
import { compile, run } from "@mdx-js/mdx";
import * as runtime from "react/jsx-runtime";

import remarkRejectJs from "./reject-js.js";
import { PERMITTED, components } from "./components.js";

/**
 * The restricted MDX compiler — CMP-0013, TSK-0008.
 *
 * ⚠️ `@mdx-js/mdx` AT REQUEST TIME, NEVER `@next/mdx`. That is DEC-0020's mechanism and it is not a
 * preference: AST-0030 measured a file-routed `.mdx` page compiled INTO the build, so an edit to a
 * stage document changed nothing a running server served. `next.config.mjs` carries the same note,
 * because the absence of an MDX integration there is the other half of this decision.
 *
 * ⚠️ THE COMPILER AND ITS PLUGIN CHAIN ARE PINNED (`@mdx-js/mdx` at an exact version, one remark
 * plugin, no rehype or recma stage). DEC-0020's first obligation: changing the version or adding a
 * plugin reopens security validation BEFORE it ships. The rejection was measured at the remark stage
 * only, and a later stage could reintroduce what it refused.
 *
 * ⚠️ REJECTION IS THE CONTRACT; STRIPPING IS DEFENCE IN DEPTH BENEATH IT. The plugin fails the
 * compile with a path and a line:column. `development: false` and the absence of any provider are
 * the layer underneath — if the rejection were ever bypassed, an unmapped name would still resolve
 * to nothing rather than to something. Neither layer may be swapped for the other: a stripped
 * document renders happily and tells its author nothing.
 */

/** What a caller gets when a document is refused: locatable, and never a rendered page. */
export class StageDocumentRejected extends Error {
  constructor(message, { path, line, column }) {
    super(message);
    this.name = "StageDocumentRejected";
    this.path = path ?? null;
    this.line = line ?? null;
    this.column = column ?? null;
  }
}

/**
 * Compile one stage document to a renderable component.
 *
 * @param {{name: string, text: string}} doc  the document as authored, from the reader
 * @returns {Promise<{Content: Function, components: object}>}
 * @throws {StageDocumentRejected} with the document path and a line:column
 */
export async function compileStageDocument({ name, text }) {
  let compiled;
  try {
    compiled = await compile(
      { path: name, value: text },
      {
        // ⚠️ `format: "mdx"` IS LOAD-BEARING AND WAS ADDED AFTER A MEASUREMENT. Left to infer the
        // format from the path, `@mdx-js/mdx` parses a `.md` file as PLAIN MARKDOWN: JSX is not
        // parsed, a mapped component renders as a bare paragraph, and — the part that matters —
        // `{1 + 1}` compiles without complaint, because there is no expression node for the plugin
        // to reject. The whole contract becomes vacuous, silently, decided by a filename.
        format: "mdx",
        outputFormat: "function-body",
        development: false,
        remarkPlugins: [[remarkRejectJs, { allow: PERMITTED }]],
        // ⚠️ No rehype or recma plugins. The pinning obligation is about the CHAIN, not the version.
      }
    );
  } catch (cause) {
    // A VFileMessage carries `line`/`column`/`file`; anything else is re-raised with what it had.
    throw new StageDocumentRejected(cause.reason ?? cause.message, {
      path: cause.file ?? name,
      line: cause.line ?? null,
      column: cause.column ?? null,
    });
  }

  const mod = await run(String(compiled), { ...runtime, baseUrl: import.meta.url });
  return { Content: mod.default, components };
}
