import { createElement } from "react";

/**
 * The permitted component set — the whole vocabulary a stage document may use.
 *
 * ⚠️ THIS IS A SECURITY BOUNDARY, not a styling convenience. Once `import` is rejected, this object
 * is the ONLY route by which a component can reach a document (AST-0023): there is nothing else for
 * an author to reach for. Adding a key here widens what agent-authored content can invoke, which is
 * why it lives beside the implementations and is exported as one reviewable list.
 *
 * ⚠️ WRITTEN WITH `createElement` RATHER THAN JSX, and that is not a style choice. Node cannot parse
 * JSX, so a JSX version of this file could not be imported by a test — and the tests would have had
 * to build their own component map, which would make them a check on a stub rather than on the
 * vocabulary that actually ships. The same reason `reject-js.js` carries no `server-only` marker.
 *
 * ⚠️ No `server-only` here either: this file is imported by the compiler and by the tests.
 */

export function Callout({ children }) {
  return createElement(
    "aside",
    {
      "data-vpw-mdx": "Callout",
      style: {
        border: "1px solid #e6dcc4",
        borderLeft: "4px solid #b58a2b",
        background: "#fdfaf2",
        borderRadius: "4px",
        padding: "11px 14px",
        margin: "12px 0",
      },
    },
    children
  );
}

/** The permitted set, as names. The plugin refuses every capitalised element outside it. */
export const PERMITTED = ["Callout"];

/** What `run()` is handed as the document's component scope. */
export const components = { Callout };
