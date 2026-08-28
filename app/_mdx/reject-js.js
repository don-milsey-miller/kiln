import { visit } from "unist-util-visit";

/**
 * The remark plugin that makes a stage document data rather than a program — CMP-0013, DEC-0020.
 *
 * ⚠️ IT REJECTS. It does not strip. That is the amendment the whole contract turns on: stripping and
 * rejection both produce a page with no executed code, so a test that renders a document and looks
 * for a side effect passes identically on either — and the author of a document that quietly lost a
 * line is told nothing. `file.fail` carries the node's position, so the author gets a path and a
 * line:column. A stripping plugin has nothing to report, because by construction nothing is wrong
 * afterwards.
 *
 * ⚠️ NO `server-only` HERE, deliberately. This is a pure AST function and it is the piece worth
 * testing directly against a real `@mdx-js/mdx` compile; marking it would make it throw under plain
 * Node (AST-0033) and force the tests to exercise a stub instead of the thing that ships.
 *
 * ⚠️ THE PERMITTED SET IS PASSED IN, not read from a module here. The set is a security boundary and
 * belongs where a reviewer looks for one: `app/_mdx/components.js`, beside the implementations.
 */

const isComponentName = (name) => typeof name === "string" && /^[A-Z]/.test(name.split(".")[0]);

export default function remarkRejectJs(options = {}) {
  const allowed = new Set(options.allow ?? []);

  return (tree, file) => {
    visit(tree, (node) => {
      // `import` / `export` — a document may not reach for anything the mapping did not give it.
      if (node.type === "mdxjsEsm")
        file.fail("MDX import/export is not permitted in a stage document.", node);

      // `{ anything }` — the documentation is explicit that an expression may contain a whole
      // JavaScript program, so this is the difference between a document and a script.
      if (node.type === "mdxFlowExpression" || node.type === "mdxTextExpression")
        file.fail("MDX JavaScript expressions are not permitted in a stage document.", node);

      if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
        if (node.name !== null && isComponentName(node.name) && !allowed.has(node.name))
          file.fail(
            `Component <${node.name}> is not in the permitted set (${[...allowed].join(", ") || "none"}).`,
            node
          );

        for (const attr of node.attributes ?? []) {
          // `{...spread}`
          if (attr.type === "mdxJsxExpressionAttribute")
            file.fail("MDX JSX spread attributes are not permitted in a stage document.", attr);
          // `prop={expression}` — a value node rather than a string is an expression
          if (attr.type === "mdxJsxAttribute" && attr.value && typeof attr.value === "object")
            file.fail(`MDX JSX attribute expressions are not permitted (attribute "${attr.name}").`, attr);
        }
      }
    });
  };
}
