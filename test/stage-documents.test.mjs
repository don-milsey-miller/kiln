/**
 * The stage document's intake section, and the only writer for it — TSK-0049, toward ACC-0113.
 *
 * ⚠️ **THE HOSTILE INPUT HERE IS THE POINT, AND IT IS NOT REJECTED.** An operator may answer with the text
 * of an anchor, a label, a code fence or an MDX expression, and every one of those is a legitimate answer.
 * The contract is that storing it changes neither what comes back nor where the next entry goes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildScaffold } from "../lib/project-scaffold.mjs";
import {
  ANSWERS_HEADING,
  INTAKE_PLACEHOLDER,
  READING_HEADING,
  STAGE_DOCUMENT_REFUSAL,
  StageDocumentRefusal,
  intakeSection,
  parseIntakeSection,
  writeStageDocumentEntry,
} from "../lib/stage-documents.mjs";

const DOC = "stages/01-intake.md";
const SECRET = "sk-ant-api03-STAGEDOCUMENTPLANTED0000000";

/** A content root holding one stage document, shaped exactly as the initializer generates one. */
function project(document = starter()) {
  const base = mkdtempSync(join(tmpdir(), "kiln-stage-doc-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(join(contentRoot, "stages"), { recursive: true });
  if (document !== null) writeFileSync(join(contentRoot, DOC), document);
  return { base, contentRoot, path: join(contentRoot, DOC) };
}

const starter = () =>
  `# Stage 1 — Intake\n\n## Purpose\n\nVerbatim request, context, stakeholders.\n\n${intakeSection()}\n## Working notes\n\n_Nothing yet._\n`;

const read = (f) => readFileSync(f.path, "utf8");
const write = (f, verbatim, interpretation, stage = "01-intake") => writeStageDocumentEntry(f.contentRoot, stage, { verbatim, interpretation });

const refuses = (code) => (e) => e instanceof StageDocumentRefusal && e.code === code;

async function refusal(f, code, label, call) {
  const before = read(f);
  await assert.rejects(call, refuses(code), label);
  assert.equal(read(f), before, `${label}: the document was changed by a refusal`);
}

/* ============================================================================ what is preserved */

test("⚠️ ACC-0113 every answer comes back as the exact string it was given, however hostile", async () => {
  const f = project();
  try {
    // ⚠️ EACH ONE IS A THING AN OPERATOR MAY ACTUALLY TYPE, and several of them are this parser's own syntax.
    const answers = [
      "plain words",
      READING_HEADING,
      ANSWERS_HEADING,
      "**A99**",
      "```\nan inner fence\n```",
      "````\nfour of them\n````",
      "{expr} <Component /> and an <a href=x>",
      'import x from "y";\nexport const z = 1;',
      "trailing newline\n",
      "no trailing newline",
      "  leading and trailing spaces  ",
      "\ttab\tseparated\t",
      "a\r\nCRLF\r\nbody",
      "sentence one.\n\nsentence two.",
      "emoji 🜂🔥 and a family 👩‍👩‍👧‍👦",
      "—en dash, ünïcödé, ﻿zero-width",
      "-".repeat(4096),
      INTAKE_PLACEHOLDER,
      "`",
      "\\{escaped already\\}",
    ];

    for (const [i, answer] of answers.entries()) {
      const result = await write(f, answer, `reading ${i + 1}`);
      assert.equal(result.entry, `A${i + 1}`, `answer ${i} took the wrong label`);
    }

    const parsed = parseIntakeSection(read(f));
    assert.deepEqual(
      parsed.answers.map((a) => a.text),
      answers,
      "an answer did not come back as the string it was given"
    );
    assert.deepEqual(
      parsed.readings.map((r) => r.text),
      answers.map((_, i) => `reading ${i + 1}`)
    );
    assert.deepEqual(
      parsed.answers.map((a) => a.label),
      answers.map((_, i) => i + 1)
    );
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0113 an anchor or a label inside an answer is stored, not obeyed, and the next entry still lands correctly", async () => {
  const f = project();
  try {
    // ⚠️ THIS IS THE ATTACK THE FRAME EXISTS FOR. A parser that searched for headings would find a second
    // `### Kiln's reading` here; one that took the highest label would call the next entry A100.
    const hostile = [READING_HEADING, "**A99**", ANSWERS_HEADING, "**A1**", "```text kiln=A7 units=3 fence=3", "###"].join("\n");
    assert.equal((await write(f, hostile, "they pasted the document at us")).entry, "A1");

    const second = await write(f, "an ordinary second answer", "and then answered normally");
    assert.equal(second.entry, "A2", "the pasted label moved the next entry");

    const parsed = parseIntakeSection(read(f));
    assert.deepEqual(parsed.answers, [
      { label: 1, text: hostile },
      { label: 2, text: "an ordinary second answer" },
    ]);
    assert.deepEqual(parsed.readings, [
      { label: 1, text: "they pasted the document at us" },
      { label: 2, text: "and then answered normally" },
    ]);

    // ⚠️ THE ANSWER'S COPY OF THE HEADING IS STILL THERE — stored, not removed — and the region that counts
    // is the last one. Both readings are under it, and no answer followed the copy.
    const text = read(f);
    assert.equal(text.split(READING_HEADING).length - 1, 2, "the answer's copy of the heading was altered");
    const region = text.slice(text.lastIndexOf(READING_HEADING));
    assert.ok(region.includes("**A1** they pasted the document at us"));
    assert.ok(region.includes("**A2** and then answered normally"));
    assert.equal(region.includes("```text kiln="), false, "an answer was written into the reading region");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0113 the measure is UTF-16 code units, so an answer of astral characters frames correctly", async () => {
  const f = project();
  try {
    const answer = "🔥".repeat(10);
    assert.equal(answer.length, 20, "the fixture is only interesting if code units and code points differ");
    await write(f, answer, "fire");

    assert.match(read(f), /units=20 /, "the frame recorded something other than code units");
    assert.equal(parseIntakeSection(read(f)).answers[0].text, answer);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0113 the fence is longer than any run of backticks in the answer", async () => {
  const f = project();
  try {
    for (const [answer, expected] of [
      ["no backticks", 3],
      ["one ` here", 3],
      ["```\nthree\n```", 4],
      ["`````\nfive\n`````", 6],
    ]) {
      const g = project();
      try {
        await write(g, answer, "reading");
        assert.match(read(g), new RegExp(`\n\`{${expected}}text kiln=A1 `), `${JSON.stringify(answer)} took the wrong fence`);
        assert.equal(parseIntakeSection(read(g)).answers[0].text, answer);
      } finally {
        rmSync(g.base, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* ============================================================================ the two regions */

test("⚠️ ACC-0113 the operator's wording is stored untouched and Kiln's reading is stored separately and escaped", async () => {
  const f = project();
  try {
    await write(f, "the {braces} and <angles> are theirs", "Kiln's own {braces} and <angles>");
    const text = read(f);

    const answers = text.slice(text.indexOf(ANSWERS_HEADING), text.indexOf(READING_HEADING));
    const readings = text.slice(text.indexOf(READING_HEADING));

    assert.ok(answers.includes("the {braces} and <angles> are theirs"), "the operator's wording was altered");
    assert.equal(answers.includes("\\{"), false, "the operator's wording was escaped");
    assert.ok(readings.includes("\\{braces\\} and \\<angles\\>"), "Kiln's reading was not escaped for the MDX compile");
    assert.equal(readings.includes("the {braces} and <angles> are theirs"), false, "the wording leaked into the reading");
    assert.equal(parseIntakeSection(text).readings[0].text, "Kiln's own {braces} and <angles>");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0113 the first entry replaces the placeholder in both regions, and later entries append in order", async () => {
  const f = project();
  try {
    assert.equal(read(f).split(INTAKE_PLACEHOLDER).length - 1, 2, "the starter has a placeholder in each region");

    await write(f, "first", "reading one");
    const once = read(f);
    assert.equal(once.includes(INTAKE_PLACEHOLDER), false, "a placeholder survived the first write");

    await write(f, "second", "reading two");
    const twice = read(f);
    assert.ok(twice.indexOf("**A1**") < twice.indexOf("**A2**"), "the entries are out of order");
    assert.ok(twice.indexOf("**A2**") < twice.indexOf(READING_HEADING), "an answer landed in the reading region");
    assert.ok(twice.indexOf("## Working notes") > twice.indexOf(`**A2** reading two`), "a reading landed outside its region");

    // Everything the writer did not write is exactly as it was.
    assert.equal(twice.slice(0, twice.indexOf(ANSWERS_HEADING)), starter().slice(0, starter().indexOf(ANSWERS_HEADING)));
    assert.equal(twice.slice(twice.indexOf("## Working notes")), starter().slice(starter().indexOf("## Working notes")));
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* ============================================================================ refusals */

test("⚠️ ACC-0113 a request that is not one is refused before the document is opened", async () => {
  const f = project();
  try {
    // ⚠️ CALLED WITHOUT THE HELPER'S DEFAULT, because "no stage at all" is one of the shapes a model sends.
    await refusal(f, STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, "no stage", writeStageDocumentEntry(f.contentRoot, undefined, { verbatim: "a", interpretation: "b" }));
    await refusal(f, STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, "no arguments", writeStageDocumentEntry(f.contentRoot, "01-intake"));

    for (const [label, stage] of [
      ["not a stage id", "intake"],
      ["a path", "01-intake/../../etc"],
      ["absolute", "C:/stages/01-intake"],
      ["upper case", "01-INTAKE"],
      ["empty", ""],
    ])
      await refusal(f, STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, label, write(f, "answer", "reading", stage));

    for (const [label, verbatim, interpretation] of [
      ["an empty answer", "", "reading"],
      ["an answer that is not a string", 7, "reading"],
      ["no reading", "answer", ""],
      ["a blank reading", "answer", "   "],
      ["a reading that is not a string", "answer", null],
      ["a reading over two lines", "answer", "first\nsecond"],
      ["a reading with a carriage return", "answer", "first\rsecond"],
    ])
      await refusal(f, STAGE_DOCUMENT_REFUSAL.INVALID_REQUEST, label, write(f, verbatim, interpretation));
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0113 the document has to be inside the content root, and has to be there at all", async () => {
  const absent = project(null);
  const directory = project(null);
  const escaping = project(null);
  try {
    await assert.rejects(write(absent, "answer", "reading"), refuses(STAGE_DOCUMENT_REFUSAL.MISSING));

    mkdirSync(join(directory.contentRoot, DOC), { recursive: true });
    await assert.rejects(write(directory, "answer", "reading"), refuses(STAGE_DOCUMENT_REFUSAL.UNREADABLE));

    // ⚠️ A stages/ that is a link out of the root is refused, not followed to whatever lives there.
    const outside = join(escaping.base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "01-intake.md"), `${SECRET}\n${intakeSection()}`);
    rmSync(join(escaping.contentRoot, "stages"), { recursive: true, force: true });
    symlinkSync(outside, join(escaping.contentRoot, "stages"), process.platform === "win32" ? "junction" : "dir");

    await assert.rejects(write(escaping, "answer", "reading"), refuses(STAGE_DOCUMENT_REFUSAL.OUTSIDE_ROOT));
    assert.equal(readFileSync(join(outside, "01-intake.md"), "utf8").startsWith(SECRET), true, "the file outside the root was written to");
  } finally {
    for (const f of [absent, directory, escaping]) rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0113 a document without the section, or with a renamed anchor, is refused rather than upgraded", async () => {
  for (const [label, document] of [
    ["no section at all", "# Stage 1\n\n## Working notes\n\n_Nothing yet._\n"],
    ["the section, renamed", starter().replace("## Intake", "## Intake capture")],
    ["the answers anchor, renamed", starter().replace(ANSWERS_HEADING, "### What they said")],
    ["the reading anchor, renamed", starter().replace(READING_HEADING, "### What we think")],
    ["the answers anchor, deleted", starter().replace(`${ANSWERS_HEADING}\n`, "")],
    ["another section before the anchors", starter().replace(ANSWERS_HEADING, "## Something else")],
  ]) {
    const f = project(document);
    try {
      await refusal(f, STAGE_DOCUMENT_REFUSAL.ANCHOR_MISSING, label, write(f, "answer", "reading"));
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  }
});

test("⚠️ ACC-0113 a frame that does not verify is refused, and nothing in the document is rewritten to fix it", async () => {
  const f = project();
  try {
    await write(f, "first answer", "reading one");
    const written = read(f);

    for (const [label, document] of [
      ["a measure one short", written.replace("units=12 ", "units=11 ")],
      ["a measure one long", written.replace("units=12 ", "units=13 ")],
      ["a measure past the document", written.replace("units=12 ", "units=99999 ")],
      ["a declared fence length that is not the fence's", written.replace("fence=3", "fence=4")],
      ["a frame naming another entry", written.replace("kiln=A1", "kiln=A2")],
      ["no frame line at all", written.replace(/```text kiln=A1[^\n]*\n/, "")],
      ["no blank line after the label", written.replace("**A1**\n\n```text", "**A1**\n```text")],
      ["a closing fence that is not the opening one", written.replace(/\n```\n\n### Kiln/, "\n````\n\n### Kiln")],
      ["prose of somebody's own in the answers", written.replace("**A1**", "A note I added myself\n\n**A1**")],
      ["prose of somebody's own in the readings", written.replace("**A1** reading one", "Mine too\n**A1** reading one")],
      ["a placeholder left beside an entry", written.replace("**A1**\n", `${INTAKE_PLACEHOLDER}\n\n**A1**\n`)],
    ]) {
      const g = project(document);
      try {
        await refusal(g, STAGE_DOCUMENT_REFUSAL.FRAME_INVALID, label, write(g, "answer", "reading"));
      } finally {
        rmSync(g.base, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0113 the labels have to run A1 upwards in both regions, and the regions have to agree", async () => {
  const f = project();
  try {
    await write(f, "first answer", "reading one");
    await write(f, "second answer", "reading two");
    const written = read(f);

    for (const [label, document] of [
      ["an answer removed", written.replace(/\*\*A1\*\*\n\n```text kiln=A1[^]*?\n```\n\n/, "")],
      ["a reading removed", written.replace("**A1** reading one\n", "")],
      ["answers starting at A2", written.split("kiln=A1").join("kiln=A2").split("**A1**\n").join("**A2**\n")],
      ["readings out of order", written.replace("**A1** reading one\n**A2** reading two\n", "**A2** reading two\n**A1** reading one\n")],
    ]) {
      const g = project(document);
      try {
        await refusal(g, STAGE_DOCUMENT_REFUSAL.ENTRIES_INVALID, label, write(g, "answer", "reading"));
      } finally {
        rmSync(g.base, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* ============================================================================ the write itself */

test("⚠️ ACC-0113 concurrent writes serialise, keep both entries, and leave nothing behind", async () => {
  const f = project();
  try {
    const results = await Promise.all([write(f, "left", "from the left"), write(f, "right", "from the right")]);
    assert.deepEqual(results.map((r) => r.entry).sort(), ["A1", "A2"], "a write was lost");

    const parsed = parseIntakeSection(read(f));
    assert.deepEqual(parsed.answers.map((a) => a.text).sort(), ["left", "right"]);
    assert.deepEqual(parsed.readings.map((r) => r.text).sort(), ["from the left", "from the right"]);

    assert.deepEqual(readdirSync(join(f.contentRoot, "stages")), ["01-intake.md"], "the write left a temporary file behind");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0113 the document the initializer generates is one this writer accepts", async () => {
  const scaffold = buildScaffold({
    name: "Fixture",
    description: "A project",
    schemaVersion: 2,
    stageDefinitions: {
      "01-intake": { id: "01-intake", name: "Intake", decidedBy: "User", producesProse: "Verbatim request.", exitCriteria: [] },
      "02-intent-decomposition": { id: "02-intent-decomposition", name: "Intent decomposition", decidedBy: "Agent", producesProse: "Intent.", exitCriteria: [] },
    },
  });

  for (const id of ["01-intake", "02-intent-decomposition"]) {
    const f = project(null);
    const path = join(f.contentRoot, "stages", `${id}.md`);
    try {
      writeFileSync(path, scaffold.get(`stages/${id}.md`));
      assert.equal((await write(f, "an answer", "a reading", id)).entry, "A1");
      assert.deepEqual(parseIntakeSection(readFileSync(path, "utf8")).answers, [{ label: 1, text: "an answer" }]);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  }
});
