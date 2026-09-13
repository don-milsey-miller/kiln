/**
 * What the package's handwritten resources say about Kiln's tools — F87, before TSK-0048's first real session.
 *
 * ⚠️ **F87 WAS TWO FALSE SENTENCES THAT WOULD HAVE STOPPED A SESSION.** `kiln-planning` said the typed tools
 * were "registered by later work", and `/kiln-start` told the model to say the tools were not registered and
 * take no other action. Both were false once TSK-0044 and TSK-0045 registered the tools, and a session that
 * believed them would have refused to use tools it held.
 *
 * ⚠️ **THE DETECTOR IS PROVED ON F87'S OWN SENTENCES.** A pattern list that matched nothing would pass every
 * resource forever, so the first test runs it over the exact sentences F87 found and requires every one to be
 * caught. Only then are the shipped files checked.
 *
 * ⚠️ **THE ORCHESTRATOR FLOW MAY STILL BE DEFERRED; THE TOOLS MAY NOT.** Both resources say plainly that the
 * `/kiln-start` flow is not implemented, because it is not. What neither may say is that the tools are absent
 * or waiting on later work — and every tool either names must be one the package declares.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = join(ROOT, "pi-package");
const DECLARED = JSON.parse(readFileSync(join(PACKAGE, "signature.json"), "utf8")).tools;

const RESOURCES = Object.freeze({
  "skills/kiln-planning/SKILL.md": readFileSync(join(PACKAGE, "skills", "kiln-planning", "SKILL.md"), "utf8"),
  "prompts/kiln-start.md": readFileSync(join(PACKAGE, "prompts", "kiln-start.md"), "utf8"),
});

/** Lower case, one space between words, no Markdown emphasis or code marks: the claim, not its typography. */
const normalise = (text) => text.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ");

/** Each is a way of saying the tools are absent or deferred. */
const ABSENT_OR_DEFERRED = Object.freeze([
  // ⚠️ THE TOOLS MUST BE THE SUBJECT. An earlier form let any "is not available" within 80 characters of the
  // word "tools" count, and flagged an accurate sentence whose subject was the planning flow.
  ["tools said not to be registered, implemented or available", /\btools?\s+(?:that\s+(?:[a-z']+\s+){1,5})?(?:are|is|were)\s+not\s+(?:yet\s+)?(?:registered|implemented|available)\b/],
  ["anything said not to be registered", /\bnot\s+(?:yet\s+)?registered\b/],
  ["tools deferred to later or future work", /\b(?:registered|implemented|provided|added)\s+(?:by|in)\s+(?:later|future|subsequent)\s+(?:work|tasks?|slices?)\b/],
  ["tools deferred with 'neither are the typed tools'", /\bneither\s+are\s+the\s+(?:typed\s+)?tools\b/],
  ["tools deferred until something lands", /\buntil\s+(?:those|they|the\s+tools)\s+(?:land|are\s+registered|exist)\b/],
  ["a planning task named as where the tools come from", /\btsk-\d{4}\b/],
]);

const claims = (text) => ABSENT_OR_DEFERRED.filter(([, pattern]) => pattern.test(normalise(text))).map(([label]) => label);

/** The exact sentences F87 found in the shipped resources before this correction. */
const F87_SENTENCES = Object.freeze([
  "description: Where Kiln's planning artifacts live and how they are written. Names the discipline; the tools that enforce it are not registered yet.",
  "**This skill names the discipline; it does not implement it.** The typed tools that carry it out are\nregistered by later work (TSK-0044 and TSK-0045), and the `/kiln-start` orchestrator flow is not\nimplemented.",
  "Until those land, this file establishes the resource name and says plainly what is not\nhere yet, rather than describing behaviour an operator would then look for and not find.",
  "reading the current plan, choosing the\nnext piece of work, and delegating to specialists under their role boundaries — **is not implemented\nyet**, and neither are the typed tools it depends on.",
  "For this session: say that Kiln's package loaded and that its tools are not registered yet, and take\nno other action.",
]);

/** Accurate sentences that mention the tools and something unavailable, where the unavailable thing is not the tools. */
const ACCURATE_SENTENCES = Object.freeze([
  "say that Kiln's package loaded and that its typed tools are registered, and that the planning flow this prompt opens is not available yet.",
  "Kiln's package is loaded, and its typed tools are registered in this session. The orchestrator flow this prompt will carry is not implemented yet.",
]);

test("⚠️ F87 the detector catches every sentence F87 found, and flags no accurate sentence about the flow", () => {
  for (const sentence of F87_SENTENCES)
    assert.ok(claims(sentence).length > 0, `the detector missed a sentence F87 found: ${JSON.stringify(sentence)}`);
  for (const sentence of ACCURATE_SENTENCES)
    assert.deepEqual(claims(sentence), [], `the detector flagged an accurate sentence: ${JSON.stringify(sentence)}`);
});

test("⚠️ F87 neither kiln-planning nor /kiln-start claims the tools are absent or deferred", () => {
  for (const [path, text] of Object.entries(RESOURCES))
    assert.deepEqual(claims(text), [], `${path} says the tools are absent or deferred`);
});

test("⚠️ F87 both resources say the typed tools are registered in this session", () => {
  for (const [path, text] of Object.entries(RESOURCES))
    assert.match(normalise(text), /\btyped tools\b[^.]{0,60}\bregistered in this session\b/, `${path} does not say the tools are registered`);
});

test("⚠️ F87 every tool the resources name is one the package declares", () => {
  for (const [path, text] of Object.entries(RESOURCES)) {
    const named = [...text.matchAll(/`((?:kiln|research|validation)_[a-z_*]+)`/g)].map((m) => m[1]);
    for (const name of named) {
      if (name.endsWith("*")) {
        const prefix = name.slice(0, -1);
        assert.ok(DECLARED.some((d) => d.startsWith(prefix)), `${path} names ${name}, and no declared tool starts with ${prefix}`);
      } else {
        assert.ok(DECLARED.includes(name), `${path} names ${name}, which the package does not declare`);
      }
    }
  }
  // The skill's own claim that the read tools exist is checked by name, not only by pattern.
  const skillNames = [...RESOURCES["skills/kiln-planning/SKILL.md"].matchAll(/`(kiln_[a-z_]+)`/g)].map((m) => m[1]);
  for (const read of ["kiln_project_status", "kiln_lint"]) assert.ok(skillNames.includes(read), `kiln-planning does not name ${read}`);
});

test("⚠️ F87 the orchestrator flow is still stated as not implemented, and no approval or attestation tool is offered", () => {
  for (const [path, text] of Object.entries(RESOURCES)) {
    assert.match(normalise(text), /\borchestrator flow\b[^.]{0,200}\bnot implemented yet\b/, `${path} no longer says the orchestrator flow is not implemented`);
    for (const boundaryTool of ["kiln_set_review_status", "kiln_write_stage_attestation", "kiln_set_type_activation"])
      assert.equal(text.includes(boundaryTool), false, `${path} names ${boundaryTool}, whose use is TSK-0050's boundary`);
  }
});
