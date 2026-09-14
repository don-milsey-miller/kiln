/**
 * A registered tool whose every result is checked at the boundary Pi reads - F114, toward ACC-0065, ACC-0109 and
 * ACC-0110.
 *
 * ⚠️ **PI SENDS A TOOL'S `content` TO THE PROVIDER, AND NOTHING ELSE.** Reading `output` or `details` from a handler
 * proves what Kiln returned, not what a model receives, and every Kiln result once reached models as
 * `(no tool output)` while both looked complete. So each exercised result and refusal must carry exactly one text
 * item equal to `output`, and `output` must still be the rendering of `details`.
 */

import assert from "node:assert/strict";

/** Each exercised tool name, with how many results and refusals passed the check. */
export const exercised = new Map();

export function assertProviderVisible(name, result) {
  assert.deepEqual(Object.keys(result ?? {}).sort(), ["content", "details", "output"], `${name}: a result carries content, output and details, and nothing else`);
  assert.ok(Array.isArray(result.content) && result.content.length === 1, `${name}: exactly one content item`);
  assert.deepEqual(result.content[0], { type: "text", text: result.output }, `${name}: the one content item is text equal to output`);
  assert.equal(result.output, JSON.stringify(result.details, null, 2), `${name}: output is still the rendering of details`);
}

/** The tool with its handler checked on every call. */
export function providerVisible(tool) {
  if (typeof tool?.execute !== "function") return tool;
  return {
    ...tool,
    execute: async (...args) => {
      const result = await tool.execute(...args);
      assertProviderVisible(tool.name, result);
      const seen = exercised.get(tool.name) ?? { results: 0, refusals: 0 };
      if (result.details?.ok === false) seen.refusals++;
      else seen.results++;
      exercised.set(tool.name, seen);
      return result;
    },
  };
}
