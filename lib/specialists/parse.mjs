/**
 * Read a role definition back — TSK-0051 (S12), toward ACC-0072 and ACC-0073.
 *
 * ⚠️ **A CLOSED READER, NOT A YAML PARSER (D18's rule, applied again).** This reads a document Kiln
 * itself generated, so it accepts exactly the shape Kiln writes and refuses everything else by name.
 * A general parser would accept folded scalars, anchors, aliases, flow sequences and merge keys, and a
 * checker that accepts more than the writer produces is a checker that cannot tell a hand-edit from a
 * generation.
 *
 * ⚠️ **THE KEY SET IS CLOSED AND ORDERED, WHICH IS WHAT MAKES ACC-0073 A STRUCTURAL CHECK.** A `model:`
 * line does not need its own rule: it is a key outside the set, reported as one. The explicit
 * model-selection codes exist anyway, because "you may not choose a model here" is a better sentence for
 * an operator than "unknown key", and because a criterion that names model selection deserves a refusal
 * that names it back.
 *
 * ⚠️ **EVERY REFUSAL NAMES A LINE NUMBER AND NEVER A PATH.** The caller knows which file it handed over.
 */

import { FRONTMATTER_KEYS, GENERATED_NOTICE } from "./render.mjs";

export const PARSE_REFUSAL = Object.freeze({
  NO_FRONTMATTER: "frontmatter-missing",
  UNCLOSED: "frontmatter-unclosed",
  NOTICE_MISSING: "generated-notice-missing",
  MALFORMED_LINE: "frontmatter-line-malformed",
  UNKNOWN_KEY: "frontmatter-unknown-key",
  DUPLICATE_KEY: "frontmatter-duplicate-key",
  KEY_MISSING: "frontmatter-key-missing",
  KEY_ORDER: "frontmatter-key-order",
  SCALAR_NOT_JSON: "frontmatter-scalar-not-json",
  MODEL_SELECTION: "frontmatter-declares-model-selection",
  TOOLS_NOT_A_LIST: "tools-not-a-list",
  TOOLS_EMPTY: "tools-empty",
  TOOLS_DUPLICATE: "tools-duplicate",
  SECTION_MISSING: "section-missing",
  SECTION_ORDER: "section-order",
  SECTION_UNKNOWN: "section-unknown",
});

/**
 * Keys that choose a model, named explicitly — ACC-0073.
 *
 * ⚠️ A role-shipped model would silently override the operator's project selection, which is the whole
 * reason this criterion exists. Reported under its own code rather than as an unknown key.
 */
export const MODEL_SELECTION_KEYS = Object.freeze([
  "provider",
  "model",
  "models",
  "thinking",
  "thinkingLevel",
  "reasoning",
  "reasoningEffort",
  "apiKey",
  "baseUrl",
  "api",
]);

export class RoleParseRefusal extends Error {
  constructor(code, message, line = null) {
    super(message);
    this.name = "RoleParseRefusal";
    this.code = code;
    this.line = line;
  }
}

const refuse = (code, message, line = null) => {
  throw new RoleParseRefusal(code, message, line);
};

/** A JSON string, and nothing else that YAML would also accept. */
function jsonScalar(raw, key, line) {
  // ⚠️ ONE CHECK, NOT TWO. An earlier version also refused anything not starting with a quote, which
  // `JSON.parse` and the `typeof` below already refuse between them: a bare word, a single-quoted string
  // and a folded scalar all throw, and a number or a boolean fails the type check. The extra branch was
  // unreachable, so a mutation removing it survived - which is how it was found.
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    refuse(PARSE_REFUSAL.SCALAR_NOT_JSON, `\`${key}\` is not a well-formed JSON string.`, line);
  }
  if (typeof value !== "string") refuse(PARSE_REFUSAL.SCALAR_NOT_JSON, `\`${key}\` must be a string.`, line);
  return value;
}

/**
 * The frontmatter and the section headings of one role definition.
 *
 * @param {string} text
 * @returns {{name: string, role: string, description: string, tools: string[], sections: string[]}}
 */
export function parseRoleDefinition(text) {
  if (typeof text !== "string") refuse(PARSE_REFUSAL.NO_FRONTMATTER, "A role definition must be text.");
  const lines = text.split("\n");

  // ⚠️ LINE ONE, OR IT IS NOT FRONTMATTER (D43). A document whose block starts lower is one no other
  // reader would treat as having frontmatter at all, and handing it to a child would deliver the
  // delimiter as prose.
  if (lines[0] !== "---") refuse(PARSE_REFUSAL.NO_FRONTMATTER, "A role definition must begin with `---` on line one.", 1);

  const close = lines.indexOf("---", 1);
  if (close < 0) refuse(PARSE_REFUSAL.UNCLOSED, "The frontmatter never closes.", 1);

  const block = lines.slice(1, close);
  if (block[0] !== GENERATED_NOTICE) refuse(PARSE_REFUSAL.NOTICE_MISSING, "The generated-by notice must be the first line inside the frontmatter.", 2);

  const values = {};
  const order = [];
  const tools = [];
  let inTools = false;

  for (let i = 1; i < block.length; i += 1) {
    const line = block[i];
    const at = i + 2; // 1-based, past the opening delimiter

    if (inTools) {
      if (line.startsWith("  - ")) {
        const tool = jsonScalar(line.slice(4), "tools", at);
        if (tools.includes(tool)) refuse(PARSE_REFUSAL.TOOLS_DUPLICATE, `\`${tool}\` is listed twice.`, at);
        tools.push(tool);
        continue;
      }
      inTools = false;
    }

    if (line.trim() === "") refuse(PARSE_REFUSAL.MALFORMED_LINE, "A blank line in the frontmatter.", at);
    if (line.startsWith(" ")) refuse(PARSE_REFUSAL.MALFORMED_LINE, "An indented line outside a tool list.", at);
    if (line.startsWith("#")) refuse(PARSE_REFUSAL.MALFORMED_LINE, "Only the generated-by notice may be a comment.", at);

    const colon = line.indexOf(":");
    if (colon <= 0) refuse(PARSE_REFUSAL.MALFORMED_LINE, `Not a \`key: value\` line: ${JSON.stringify(line)}.`, at);
    const key = line.slice(0, colon);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) refuse(PARSE_REFUSAL.MALFORMED_LINE, `\`${key}\` is not a plain key.`, at);

    if (MODEL_SELECTION_KEYS.includes(key))
      refuse(PARSE_REFUSAL.MODEL_SELECTION, `\`${key}\` chooses a model or a provider. A role definition may not: the operator's project selection decides that.`, at);
    if (!FRONTMATTER_KEYS.includes(key)) refuse(PARSE_REFUSAL.UNKNOWN_KEY, `\`${key}\` is not one of ${FRONTMATTER_KEYS.join(", ")}.`, at);
    if (order.includes(key)) refuse(PARSE_REFUSAL.DUPLICATE_KEY, `\`${key}\` appears twice.`, at);
    order.push(key);

    const rest = line.slice(colon + 1);
    if (key === "tools") {
      if (rest.trim() !== "") refuse(PARSE_REFUSAL.TOOLS_NOT_A_LIST, "`tools` must be a block sequence, one `  - \"name\"` per line.", at);
      inTools = true;
      continue;
    }
    if (!rest.startsWith(" ")) refuse(PARSE_REFUSAL.MALFORMED_LINE, `\`${key}\` must be followed by a space.`, at);
    values[key] = jsonScalar(rest.slice(1), key, at);
  }

  for (const key of FRONTMATTER_KEYS) if (!order.includes(key)) refuse(PARSE_REFUSAL.KEY_MISSING, `\`${key}\` is missing.`, 2);
  if (order.join(",") !== FRONTMATTER_KEYS.join(","))
    refuse(PARSE_REFUSAL.KEY_ORDER, `The keys must appear as ${FRONTMATTER_KEYS.join(", ")}; they appear as ${order.join(", ")}.`, 2);

  // ⚠️ ACC-0072's SECOND SENTENCE. An empty list is reported as empty and never as "no opinion": the
  // measured hazard is that a child with no declared tools is handed read, bash, edit and write.
  if (tools.length === 0)
    refuse(PARSE_REFUSAL.TOOLS_EMPTY, "`tools` is empty. A role that declares no tools does not narrow the child; it inherits the agent's defaults.", 2);

  const sections = [...text.slice(text.indexOf("\n", close)).matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  return { ...values, tools, sections };
}
