/**
 * The restricted MDX contract, run against a REAL `@mdx-js/mdx` compile — TSK-0008, ACC-0017.
 *
 * ⚠️ THIS EXERCISES THE PLUGIN THAT SHIPS, not a stub. `app/_mdx/reject-js.js` deliberately carries
 * no `server-only` marker so it can be imported here: the marker throws outside the RSC compiler
 * (AST-0033), and a test that worked around that would be checking something other than the code in
 * production. `compile.js` — which does carry the marker — is proven separately, by a production
 * build.
 *
 * ⚠️ EVERY REJECTION ASSERTS A POSITION, never just a throw. Rejection and stripping both end with a
 * page containing no executed code; the difference visible to an author is the diagnostic, so the
 * diagnostic is what the criterion is about (ACC-0017's last sentence).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, run } from "@mdx-js/mdx";
import * as runtime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import remarkRejectJs from "../app/_mdx/reject-js.js";
import { PERMITTED, components } from "../app/_mdx/components.js";

// ⚠️ A `.md` PATH ON PURPOSE. If `format: "mdx"` is ever dropped from the options below, MDX infers
// plain markdown from this extension and every rejection in this file stops firing — the suite goes
// green while the contract does nothing. Naming the fixture `.md` makes that regression impossible
// to miss, and it is not hypothetical: it is how these tests first passed.
const PATH = "stages/06-risk-feasibility.md";

const build = (text) =>
  compile(
    { path: PATH, value: text },
    {
      // ⚠️ Must match compile.js exactly, `format` included. Without it a `.md` path parses as plain
      // markdown and every rejection below stops firing — which is how this suite passed vacuously
      // for the real stage documents before the format was pinned.
      format: "mdx",
      outputFormat: "function-body",
      development: false,
      remarkPlugins: [[remarkRejectJs, { allow: PERMITTED }]],
    }
  );

/** Compile and fail, returning the message with its position. */
async function rejected(text) {
  try {
    await build(text);
  } catch (e) {
    return e;
  }
  return null;
}

const FORBIDDEN = {
  "ESM import": 'import { readFileSync } from "node:fs";\n\n# Doc\n',
  "ESM export": "export const x = 1;\n\n# Doc\n",
  "flow expression": "# Doc\n\n{1 + 1}\n",
  "text expression": "# Doc\n\nInline {1 + 1} expression.\n",
  "JSX attribute expression": '# Doc\n\n<Callout tone={"warn"}>text</Callout>\n',
  "JSX spread attribute": "# Doc\n\n<Callout {...{ tone: 'warn' }}>text</Callout>\n",
  "unmapped component": "# Doc\n\n<Danger>not permitted</Danger>\n",
};

for (const [label, text] of Object.entries(FORBIDDEN)) {
  test(`REJECTS ${label}, with a path and a line:column`, async () => {
    const e = await rejected(text);
    assert.ok(e, `${label} compiled — it must be refused, not stripped`);
    assert.equal(e.file ?? e.name, PATH, `the diagnostic must name the document: ${JSON.stringify(e)}`);
    assert.equal(typeof e.line, "number", "the diagnostic must carry a line");
    assert.equal(typeof e.column, "number", "the diagnostic must carry a column");
    assert.ok((e.reason ?? e.message ?? "").length > 10, "and say what was refused");
  });
}

test("⚠️ every forbidden construct in the contract has a case above", () => {
  // DEC-0020 names five constructs plus unmapped components. A construct that lost its case would
  // leave the rule enforced by nothing, which is how a contract quietly narrows.
  assert.deepEqual(Object.keys(FORBIDDEN).sort(), [
    "ESM export",
    "ESM import",
    "JSX attribute expression",
    "JSX spread attribute",
    "flow expression",
    "text expression",
    "unmapped component",
  ]);
});

test("a permitted document compiles and its mapped component renders", async () => {
  const text = "# Stage 6\n\nOrdinary markdown.\n\n<Callout>the mapped component rendered</Callout>\n";
  const compiled = await build(text);
  const mod = await run(String(compiled), { ...runtime, baseUrl: import.meta.url });
  const html = renderToStaticMarkup(createElement(mod.default, { components }));

  assert.match(html, /<h1>/, "markdown must still render");
  assert.match(html, /data-vpw-mdx="Callout"/, "the mapped component must render, not be dropped");
  assert.match(html, /the mapped component rendered/);
});

test("the permitted set is the only vocabulary, and it is small", () => {
  // ⚠️ Pinned deliberately. Widening the set widens what agent-authored content can invoke, and this
  // line is what makes that a visible act rather than an edit nobody reviews.
  assert.deepEqual(PERMITTED, ["Callout"]);
  assert.deepEqual(Object.keys(components).sort(), ["Callout"]);
});

test("⚠️ a stripping plugin would pass a render check — which is why this suite asserts refusals", async () => {
  // The control for the whole file. With the plugin removed, the forbidden document compiles: no
  // error, and an expression evaluates. If these tests only checked the rendered output for absence
  // of an effect, that result and a rejection would be indistinguishable.
  const withoutPlugin = await compile(
    { path: PATH, value: "# Doc\n\nInline {1 + 1} expression.\n" },
    // Same format pin, plugin removed — so the ONLY difference between this and a guarded compile is
    // the plugin. Without the pin this control would compile as markdown and prove nothing.
    { format: "mdx", outputFormat: "function-body", development: false }
  );
  const mod = await run(String(withoutPlugin), { ...runtime, baseUrl: import.meta.url });
  assert.match(renderToStaticMarkup(createElement(mod.default, {})), /2/, "unguarded, the expression evaluates");

  // ...and with the plugin it is refused rather than silently emptied.
  const e = await rejected("# Doc\n\nInline {1 + 1} expression.\n");
  assert.ok(e && typeof e.line === "number");
});

test("⚠️ every REAL stage document compiles under the restricted contract", async () => {
  // The integration question this contract has to survive, checked on the project's own content
  // rather than on samples. A stage document that violates the rule should fail here, at commit
  // time, with a path and a position — not at render time, in front of the operator.
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "planning-content", "stages");

  const docs = readdirSync(dir).filter((f) => /\.mdx?$/.test(f));
  assert.ok(docs.length >= 9, `expected the nine stage documents, saw ${docs.length}`);

  const refused = [];
  for (const f of docs) {
    try {
      await build(readFileSync(join(dir, f), "utf-8"));
    } catch (e) {
      refused.push(`${f}:${e.line}:${e.column} ${e.reason ?? e.message}`);
    }
  }
  assert.deepEqual(refused, [], "a stage document does not survive the contract it is written under");
});
