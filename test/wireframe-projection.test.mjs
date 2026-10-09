/**
 * The wireframe projection, on its own - #188.
 *
 * `projectWireframe` is the only thing between a record on disk and the interactive viewer. These prove what it
 * returns for a well-formed record (nesting, order, coordinates, links) and that a malformed one comes back as a
 * bounded refusal or a bounded list of warnings, never as geometry.
 *
 * ⚠️ **THE VALIDATOR IS THE REAL ONE**, compiled from `schemas/wireframe.schema.json`. A stub that returned `true`
 * would prove the projection trusts its caller, which is the opposite of the point.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createValidators } from "../lib/validate.mjs";
import { projectWireframe, WIREFRAME_LIMITS, WIREFRAME_REFUSAL as REFUSAL, WIREFRAME_WARNING as WARNING } from "../app/_review/wireframe-projection.js";
import { component, envelope, fiveWireframes, region } from "./helpers/wireframe-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const validate = createValidators(join(ROOT, "schemas")).wireframe;

const IDS = { requirements: ["REQ-0001", "REQ-0002", "REQ-0003", "REQ-0004"], decisions: ["DEC-0001", "DEC-0002"] };
const KNOWN = new Set([...IDS.requirements, ...IDS.decisions, "QST-0001", "CMP-0001"]);
const project = (doc, knownIds = KNOWN) => projectWireframe(doc, { validate, knownIds });
const view = (doc, knownIds) => {
  const result = project(doc, knownIds);
  assert.equal(result.ok, true, JSON.stringify(result.refusal));
  return result.view;
};
const wireframe = (body) => envelope("WIR-0001", "A screen", { viewport: { width: 1000, height: 800 }, implements: ["REQ-0001"], ...body });
const codes = (v) => v.warnings.map((w) => w.code);
const freeze = (value) => {
  if (value && typeof value === "object") for (const v of Object.values(Object.freeze(value))) freeze(v);
  return value;
};

test("each of the five synthetic wireframes projects every region, component and annotation, with nothing to report", () => {
  const expected = [[5, 11, 3], [6, 13, 3], [5, 11, 4], [6, 13, 4], [6, 10, 5]];
  const five = fiveWireframes(IDS);
  assert.equal(five.length, 5);
  five.forEach((doc, i) => {
    const v = view(doc);
    const [regions, components, annotations] = expected[i];
    assert.equal(v.id, `WIR-000${i + 1}`);
    assert.equal(v.elements.filter((e) => e.role === "region").length, regions, doc.id);
    assert.equal(v.elements.filter((e) => e.role === "component").length, components, doc.id);
    assert.equal(v.annotations.length, annotations, doc.id);
    assert.deepEqual(v.warnings, [], `${doc.id}: ${JSON.stringify(v.warnings)}`);
    assert.equal(v.omittedWarnings, 0);
    assert.deepEqual(v.viewport, doc.viewport);
    assert.deepEqual(v.extent, { x: 0, y: 0, ...doc.viewport }, "nothing lies outside the viewport, so the extent is the viewport");
    assert.ok(v.annotations.every((a) => a.targetKey && a.targetProblem === null && a.requirements.every((l) => l.resolved)));
    assert.ok([...v.traces.implements, ...v.traces.decidedBy].every((l) => l.resolved));
  });
});

test("a region is followed by its components and then by its nested regions, to any depth, each with a key of its own", () => {
  const v = view(
    wireframe({
      regions: [
        region("outer", "main", "Outer", [0, 0, 1000, 800], {
          // Declared before `components` here, and still drawn after them.
          regions: [
            region("inner", "section", "Inner", [100, 100, 600, 500], {
              components: [component("inner-button", "button", "Inner button", [120, 120, 100, 40])],
              regions: [region("innermost", "section", "Innermost", [200, 200, 300, 200], { components: [component("deep", "text", "Deep", [220, 220, 100, 40], "Deep text")] })],
            }),
            region("second", "section", "Second", [720, 100, 200, 200]),
          ],
          components: [component("first", "button", "First", [10, 10, 50, 20]), component("other", "button", "Other", [70, 10, 50, 20])],
        }),
        region("footer", "footer", "Footer", [0, 760, 1000, 40]),
      ],
    })
  );
  assert.deepEqual(
    v.elements.map((e) => [e.key, e.id, e.role, e.depth, e.parentKey]),
    [
      ["r0", "outer", "region", 1, null],
      ["r0.c0", "first", "component", 2, "r0"],
      ["r0.c1", "other", "component", 2, "r0"],
      ["r0.r0", "inner", "region", 2, "r0"],
      ["r0.r0.c0", "inner-button", "component", 3, "r0.r0"],
      ["r0.r0.r0", "innermost", "region", 3, "r0.r0"],
      ["r0.r0.r0.c0", "deep", "component", 4, "r0.r0.r0"],
      ["r0.r1", "second", "region", 2, "r0"],
      ["r1", "footer", "region", 1, null],
    ]
  );
  assert.equal(v.elements.find((e) => e.id === "deep").content, "Deep text");
  assert.equal(v.elements.find((e) => e.id === "first").content, null, "a component with no content has none, not an empty string");
  assert.equal(new Set(v.elements.map((e) => e.key)).size, v.elements.length);
  assert.deepEqual(v.warnings, []);
});

test("⚠️ bounds are viewport coordinates at every depth: a child's are returned as written, never offset by its parent's", () => {
  const doc = wireframe({
    regions: [region("panel", "section", "Panel", [400, 300, 500, 400], { components: [component("inside", "button", "Inside", [420, 320, 100, 40])], regions: [region("sub", "section", "Sub", [600, 500, 200, 100])] })],
  });
  const v = view(doc);
  assert.deepEqual(v.elements.find((e) => e.id === "inside").bounds, { x: 420, y: 320, width: 100, height: 40 });
  assert.deepEqual(v.elements.find((e) => e.id === "sub").bounds, { x: 600, y: 500, width: 200, height: 100 });
  assert.deepEqual(v.warnings, [], "an absolute child inside its parent is not reported");

  // The same child written relative to its parent lands outside it, which is what the advisory is for.
  const relative = view(wireframe({ regions: [region("panel", "section", "Panel", [400, 300, 500, 400], { components: [component("inside", "button", "Inside", [20, 20, 100, 40])] })] }));
  assert.deepEqual(relative.elements[1].bounds, { x: 20, y: 20, width: 100, height: 40 }, "it is drawn where it says, not where a parent-relative reading would put it");
  assert.deepEqual(relative.warnings.map((w) => [w.code, w.severity]), [[WARNING.OUTSIDE_PARENT, "advisory"]]);
  assert.match(relative.warnings[0].message, /"inside" \(r0\.c0\) extends outside "panel"/);
});

test("an element outside the viewport is an advisory, and the extent grows to hold it", () => {
  const v = view(wireframe({ regions: [region("main", "main", "Main", [0, 0, 1000, 800]), region("drawer", "aside", "Drawer", [-200, 100, 180, 900])] }));
  assert.deepEqual(v.warnings.map((w) => [w.code, w.severity]), [[WARNING.OUTSIDE_VIEWPORT, "advisory"]]);
  assert.deepEqual(v.extent, { x: -200, y: 0, width: 1200, height: 1000 });
  assert.deepEqual(v.viewport, { width: 1000, height: 800 }, "the declared viewport is unchanged");
});

test("overlapping elements are valid: both are returned, in document order, with nothing reported", () => {
  const v = view(
    wireframe({
      regions: [
        region("page", "main", "Page", [0, 0, 1000, 800], { components: [component("under", "table", "Under", [100, 100, 400, 300]), component("over", "dialog", "Over", [200, 150, 400, 300])] }),
        region("overlay", "overlay", "Overlay", [0, 0, 1000, 800]),
      ],
    })
  );
  assert.deepEqual(v.elements.map((e) => e.id), ["page", "under", "over", "overlay"]);
  assert.deepEqual(v.warnings, []);
});

test("two elements with one id are both returned under different keys, and an annotation aimed at that id is not attached to either", () => {
  const v = view(
    wireframe({
      regions: [region("main", "main", "Main", [0, 0, 1000, 800], { components: [component("save", "button", "Save", [10, 10, 80, 30]), component("save", "button", "Save again", [100, 10, 80, 30]), component("only", "button", "Only", [200, 10, 80, 30])] })],
      annotations: [
        { id: "a1", target: "save", note: "Which one?", requirements: ["REQ-0001"] },
        { id: "a2", target: "only", note: "This one.", requirements: ["REQ-0002"] },
      ],
    })
  );
  const saves = v.elements.filter((e) => e.id === "save");
  assert.deepEqual(saves.map((e) => [e.key, e.label, e.duplicateId, e.annotations]), [["r0.c0", "Save", true, []], ["r0.c1", "Save again", true, []]]);
  assert.deepEqual(codes(v), [WARNING.DUPLICATE_ELEMENT_ID, WARNING.ANNOTATION_TARGET_AMBIGUOUS]);
  assert.match(v.warnings[0].message, /2 elements declare the id "save": r0\.c0, r0\.c1/);
  assert.deepEqual(v.annotations.map((a) => [a.key, a.number, a.targetKey, a.targetProblem]), [["a0", 1, null, "ambiguous"], ["a1", 2, "r0.c2", null]]);
  assert.deepEqual(v.elements.find((e) => e.id === "only").annotations, [2], "an element lists the numbers of the annotations attached to it");
  assert.equal(v.elements.find((e) => e.id === "only").duplicateId, undefined);
});

test("an annotation whose target no element declares is kept, unattached, and reported; a repeated annotation id is reported", () => {
  const v = view(
    wireframe({
      regions: [region("main", "main", "Main", [0, 0, 1000, 800])],
      annotations: [
        { id: "a1", target: "nowhere", note: "Dangling.", requirements: ["REQ-0001"] },
        { id: "a1", target: "main", note: "Same id, different note.", requirements: ["REQ-0001"] },
      ],
    })
  );
  assert.deepEqual(codes(v), [WARNING.DUPLICATE_ANNOTATION_ID, WARNING.ANNOTATION_TARGET_MISSING]);
  assert.deepEqual(v.annotations.map((a) => [a.note, a.target, a.targetKey, a.targetProblem]), [["Dangling.", "nowhere", null, "missing"], ["Same id, different note.", "main", "r0", null]]);
  assert.match(v.warnings[1].message, /annotation "a1" targets "nowhere"/);
});

test("⚠️ all four trace sources are checked against the project: a missing artifact is text, not a link, and a wrong type is reported", () => {
  const v = view(
    wireframe({
      regions: [region("main", "main", "Main", [0, 0, 1000, 800])],
      annotations: [{ id: "a1", target: "main", note: "Note.", requirements: ["REQ-0002", "REQ-9999", "CMP-0001"] }],
      implements: ["REQ-0001", "REQ-8888", "DEC-0001"],
      decidedBy: ["DEC-0002", "DEC-7777", "REQ-0003"],
      openQuestions: ["QST-0001", "QST-6666", "REQ-0004"],
    })
  );
  assert.deepEqual(v.traces.implements, [{ id: "REQ-0001", resolved: true }, { id: "REQ-8888", resolved: false }, { id: "DEC-0001", resolved: true }]);
  assert.deepEqual(v.traces.decidedBy, [{ id: "DEC-0002", resolved: true }, { id: "DEC-7777", resolved: false }, { id: "REQ-0003", resolved: true }]);
  assert.deepEqual(v.traces.openQuestions, [{ id: "QST-0001", resolved: true }, { id: "QST-6666", resolved: false }, { id: "REQ-0004", resolved: true }]);
  assert.deepEqual(v.annotations[0].requirements, [{ id: "REQ-0002", resolved: true }, { id: "REQ-9999", resolved: false }, { id: "CMP-0001", resolved: true }]);
  assert.deepEqual(
    v.warnings.map((w) => [w.code, w.severity, w.message.match(/[A-Z]{3}-\d{4}/)[0]]),
    [
      [WARNING.TRACE_UNRESOLVED, "warning", "REQ-9999"],
      [WARNING.TRACE_WRONG_TYPE, "warning", "CMP-0001"],
      [WARNING.TRACE_UNRESOLVED, "warning", "REQ-8888"],
      [WARNING.TRACE_WRONG_TYPE, "warning", "DEC-0001"],
      [WARNING.TRACE_UNRESOLVED, "warning", "DEC-7777"],
      [WARNING.TRACE_WRONG_TYPE, "warning", "REQ-0003"],
      [WARNING.TRACE_WRONG_TYPE, "warning", "REQ-0004"],
      // The schema lets a question be recorded after the wireframe that raises it.
      [WARNING.TRACE_UNRESOLVED, "advisory", "QST-6666"],
    ]
  );
  // With no project to check against, nothing resolves and nothing becomes a link.
  const alone = projectWireframe(wireframe({ regions: [region("main", "main", "Main", [0, 0, 1000, 800])] }), { validate }).view;
  assert.deepEqual(alone.traces.implements, [{ id: "REQ-0001", resolved: false }]);
});

test("the record's strings come back exactly as written, as strings, whatever they contain", () => {
  const hostile = `<script>window.__kiln188 = 1</script><img src=x onerror="window.__kiln188 = 1">&amp;"'‮`;
  const v = view(
    wireframe({
      title: hostile,
      regions: [region(hostile, hostile, hostile, [0, 0, 1000, 800], { components: [component("c", "button", hostile, [10, 10, 100, 40], hostile)] })],
      annotations: [{ id: hostile, target: hostile, note: hostile, requirements: ["REQ-0001"] }],
    })
  );
  assert.equal(v.title, hostile);
  assert.deepEqual([v.elements[0].id, v.elements[0].kind, v.elements[0].label], [hostile, hostile, hostile]);
  assert.deepEqual([v.elements[1].label, v.elements[1].content], [hostile, hostile]);
  assert.deepEqual([v.annotations[0].id, v.annotations[0].note, v.annotations[0].target, v.annotations[0].targetKey], [hostile, hostile, hostile, "r0"]);
  const strings = [];
  const walk = (value) => (typeof value === "string" ? strings.push(value) : value && typeof value === "object" ? Object.values(value).forEach(walk) : null);
  walk(v);
  assert.ok(strings.length > 8);
  assert.ok(!JSON.stringify(v).includes("__html"), "nothing in the projection is marked as markup");
});

test("⚠️ a record that fails its schema is refused, with no geometry at all", () => {
  const good = () => wireframe({ regions: [region("main", "main", "Main", [0, 0, 1000, 800], { components: [component("c", "button", "C", [10, 10, 100, 40])] })] });
  const broken = {
    "a zero width": (d) => (d.regions[0].components[0].bounds.width = 0),
    "a negative height": (d) => (d.regions[0].bounds.height = -5),
    "no bounds": (d) => delete d.regions[0].components[0].bounds,
    "a coordinate that is a string": (d) => (d.regions[0].bounds.x = "0"),
    "a coordinate that is null": (d) => (d.regions[0].bounds.y = null),
    "an extra key in bounds": (d) => (d.regions[0].bounds.z = 1),
    "no viewport": (d) => delete d.viewport,
    "a zero viewport": (d) => (d.viewport.width = 0),
    "no regions": (d) => (d.regions = []),
    "regions that is not a list": (d) => (d.regions = { 0: d.regions[0] }),
    "an element with no id": (d) => delete d.regions[0].id,
    "an annotation with no target": (d) => (d.annotations = [{ id: "a", note: "n", requirements: [] }]),
    "a trace id that is not an artifact id": (d) => (d.implements = ["javascript:alert(1)"]),
    "another type": (d) => (d.type = "requirement"),
  };
  for (const [what, change] of Object.entries(broken)) {
    const doc = good();
    change(doc);
    const result = project(doc);
    assert.equal(result.ok, false, what);
    assert.equal(result.view, undefined, what);
    assert.equal(result.refusal.code, REFUSAL.SCHEMA_INVALID, what);
    assert.ok(result.refusal.messages.length >= 1 && result.refusal.messages.length <= WIREFRAME_LIMITS.refusalMessages, what);
  }
  for (const notARecord of [null, undefined, "WIR-0001", 7, []]) assert.equal(project(notARecord).refusal.code, REFUSAL.SCHEMA_INVALID);
  // No validator, or one that throws, is a record that was not validated.
  assert.equal(projectWireframe(good()).refusal.code, REFUSAL.SCHEMA_INVALID);
  const throws = () => {
    throw new RangeError("Maximum call stack size exceeded");
  };
  assert.deepEqual(projectWireframe(good(), { validate: throws }).refusal, { code: REFUSAL.SCHEMA_INVALID, messages: ["(root) could not be validated (RangeError)"], omitted: 0 });
  // A validator that says yes to a record of another type is still not believed.
  assert.equal(projectWireframe({ ...good(), type: "requirement" }, { validate: () => true }).refusal.code, REFUSAL.SCHEMA_INVALID);
});

test("⚠️ a refusal is bounded: at most five messages, each at most 240 characters, with the rest counted", () => {
  const long = "x".repeat(5000);
  const doc = wireframe({ regions: Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, kind: "k", label: "l", bounds: { x: 0, y: 0, width: 0, height: 0 }, [long]: 1 })) });
  const { refusal } = project(doc);
  assert.equal(refusal.code, REFUSAL.SCHEMA_INVALID);
  assert.equal(refusal.messages.length, WIREFRAME_LIMITS.refusalMessages);
  assert.ok(refusal.messages.every((m) => m.length <= WIREFRAME_LIMITS.messageLength));
  assert.ok(refusal.omitted >= 595, `${refusal.omitted} omitted`);
  assert.ok(JSON.stringify(refusal).length < 2000, `${JSON.stringify(refusal).length} characters`);
});

test("geometry beyond the coordinate limit, and a tree beyond the size limits, are refused", () => {
  const far = (at) => project(wireframe({ regions: [region("main", "main", "Main", at)] })).refusal;
  assert.equal(far([0, 0, 1e6 + 1, 10]).code, REFUSAL.OUT_OF_RANGE);
  assert.equal(far([-1e6 - 1, 0, 10, 10]).code, REFUSAL.OUT_OF_RANGE);
  assert.equal(far([999_999, 0, 10, 10]).code, REFUSAL.OUT_OF_RANGE, "the far edge counts, not only the origin");
  assert.equal(far([0, 0, 1e300, 1e300]).code, REFUSAL.OUT_OF_RANGE);
  assert.equal(project(wireframe({ viewport: { width: 1e7, height: 10 }, regions: [region("main", "main", "Main", [0, 0, 10, 10])] })).refusal.code, REFUSAL.OUT_OF_RANGE);
  assert.equal(project(wireframe({ regions: [region("main", "main", "Main", [0, 0, 1e6, 1e6])] })).ok, true, "the limit itself is allowed");
  assert.equal(project(wireframe({ regions: [region("main", "main", "Main", [-1e6, -1e6, 10, 10])] })).ok, true);
  const many = project(wireframe({ regions: Array.from({ length: 400 }, (_, i) => region(`r${i}`, "k", "l", [2e6, 0, 10, 10])) })).refusal;
  assert.deepEqual([many.code, many.messages.length, many.omitted], [REFUSAL.OUT_OF_RANGE, 5, 395]);

  const flat = (count) => wireframe({ regions: [region("main", "main", "Main", [0, 0, 1000, 800], { components: Array.from({ length: count }, (_, i) => component(`c${i}`, "k", "l", [0, 0, 10, 10])) })] });
  assert.equal(project(flat(WIREFRAME_LIMITS.elements - 1)).ok, true);
  assert.deepEqual(project(flat(WIREFRAME_LIMITS.elements)).refusal, { code: REFUSAL.TOO_LARGE, messages: ["more than 2000 regions and components"], omitted: 0 });

  const nested = (depth) => {
    let node = region("leaf", "k", "l", [0, 0, 10, 10]);
    for (let i = 1; i < depth; i++) node = region(`n${i}`, "k", "l", [0, 0, 10, 10], { regions: [node] });
    return wireframe({ regions: [node] });
  };
  assert.equal(project(nested(WIREFRAME_LIMITS.depth)).ok, true);
  assert.deepEqual(project(nested(WIREFRAME_LIMITS.depth + 1)).refusal, { code: REFUSAL.TOO_LARGE, messages: ["regions are nested deeper than the limit of 32"], omitted: 0 });

  const annotated = (count) => wireframe({ regions: [region("main", "main", "Main", [0, 0, 1000, 800])], annotations: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, target: "main", note: "n", requirements: [] })) });
  assert.equal(project(annotated(WIREFRAME_LIMITS.annotations)).ok, true);
  assert.equal(project(annotated(WIREFRAME_LIMITS.annotations + 1)).refusal.code, REFUSAL.TOO_LARGE);
});

test("⚠️ warnings are bounded too, and a warning is never crowded out by advisories", () => {
  const long = "y".repeat(4000);
  const v = view(
    wireframe({
      // 300 advisories: every component is outside the viewport and outside its parent.
      regions: [region("main", "main", "Main", [0, 0, 1000, 800], { components: Array.from({ length: 150 }, (_, i) => component(`c${i}`, "k", "l", [5000, 5000, 10, 10])) })],
      annotations: [{ id: long, target: long, note: "n", requirements: [] }],
    })
  );
  assert.equal(v.warnings.length, WIREFRAME_LIMITS.warnings);
  assert.equal(v.omittedWarnings, 301 - WIREFRAME_LIMITS.warnings);
  assert.deepEqual([v.warnings[0].code, v.warnings[0].severity], [WARNING.ANNOTATION_TARGET_MISSING, "warning"]);
  assert.ok(v.warnings.every((w) => w.message.length <= WIREFRAME_LIMITS.messageLength));
  assert.ok(v.warnings.slice(1).every((w) => w.severity === "advisory"));
});

test("the projection is deterministic and does not change the record it reads", () => {
  for (const doc of fiveWireframes(IDS)) {
    const before = JSON.stringify(doc);
    const first = view(freeze(structuredClone(doc)));
    assert.deepEqual(view(doc), first);
    assert.equal(JSON.stringify(view(doc)), JSON.stringify(first));
    assert.equal(JSON.stringify(doc), before);
  }
});

test("⚠️ the viewer is a view and nothing else: it imports only React, and has no way to send, store, navigate or inject", () => {
  const viewer = readFileSync(join(ROOT, "app", "stage", "[stageId]", "wireframe-viewer.js"), "utf-8");
  assert.ok(viewer.startsWith(`"use client";`));
  assert.deepEqual([...viewer.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]), ["react"]);
  assert.ok(!/\bimport\s*\(|\brequire\s*\(/.test(viewer), "no other module is loaded later");
  const forbidden = {
    "a request": /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/,
    "browser storage": /localStorage|sessionStorage|indexedDB|document\.cookie/,
    "a change of address": /history\.(pushState|replaceState)|location\.(assign|replace|reload)|location\.href\s*=|useRouter|next\/navigation/,
    "a server action": /use server|_write\/|<form\b|formAction/,
    "markup from a string": /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write/,
    "a canvas element": /<canvas\b/,
    "motion": /transition|animation|@keyframes|scrollIntoView|behavior:\s*"smooth"/,
  };
  for (const [what, pattern] of Object.entries(forbidden)) assert.ok(!pattern.test(viewer), `the viewer contains ${what}: ${viewer.match(pattern)?.[0]}`);
  // The panel that places the viewer, and the projection that feeds it, never mark a string as markup either.
  for (const file of [join("app", "stage", "[stageId]", "review-panel.js"), join("app", "_review", "wireframe-projection.js")])
    assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(readFileSync(join(ROOT, file), "utf-8")), file);
});
