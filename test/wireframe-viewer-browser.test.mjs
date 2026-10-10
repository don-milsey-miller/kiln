/**
 * The wireframe viewer, in a real browser - #188.
 *
 * This builds the real application, serves a copy of this repository's planning content with seven wireframes added
 * to it, and drives the review panel in Chromium over the DevTools protocol: real pointer, wheel and key input, the
 * page's own geometry, its accessibility tree, and the bytes on disk before and after.
 *
 * ⚠️ **THE EXPECTED DRAWING IS THE PROJECTION.** Each record is projected here with the real schema validator, and
 * the page is compared with that: every element's box as the browser laid it out, in the wireframe's own units,
 * against the bounds the record declares.
 *
 * ⚠️ **THE CHECKS ARE SHOWN TO FAIL.** The geometry check and the selection check are plain functions over what the
 * page reports. Each is run on the page as served and passes. Then the test takes the geometry off the page, and
 * separately the selection marker, and each function has to throw. A check that cannot fail proves nothing about
 * the page it passed on.
 *
 * Five of the wireframes are shaped like the ones the issue was reported against. The sixth is everything a
 * well-formed record may still do: four levels of nesting, overlap, a 300-character label with no space in it,
 * strings that would be markup, a repeated id, dangling and ambiguous annotation targets, traces to artifacts that
 * do not exist, and a region outside its viewport. The seventh fails its schema.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createValidators } from "../lib/validate.mjs";
import { projectWireframe, WIREFRAME_REFUSAL, WIREFRAME_WARNING } from "../app/_review/wireframe-projection.js";
import { findBrowser, launchBrowser, until } from "./helpers/browser.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";
import { installReaper, reapLater } from "./helpers/reap.mjs";
import { component, envelope, fiveWireframes, region } from "./helpers/wireframe-fixtures.mjs";

installReaper();

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NEXT_CLI = join(ROOT, "node_modules", "next", "dist", "bin", "next");
const STAGE = "05-solution-design";
const browserPath = findBrowser();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exitedWithin = (exited, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    exited.then(() => (clearTimeout(timer), resolve(true)));
  });
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// Artifacts in this repository's own plan, so every trace in the five resolves in the project that is served.
const IDS = { requirements: ["REQ-0001", "REQ-0002", "REQ-0003", "REQ-0004"], decisions: ["DEC-0001", "DEC-0002"], schemaVersion: 2 };
const FIVE = fiveWireframes(IDS);
const LONG_LABEL = "L".repeat(300);
const LONG_CONTENT = Array.from({ length: 250 }, (_, i) => `word${i}`).join(" ");
const HOSTILE_LABEL = `<img src=x onerror="window.__kiln188 = 1">`;
const HOSTILE_CONTENT = `<script>window.__kiln188 = 1</script>`;
const HARD = envelope(
  "WIR-0006",
  "Everything a well-formed record may do",
  {
    viewport: { width: 800, height: 600 },
    regions: [
      region("shell", "main", "Shell", [0, 0, 800, 600], {
        components: [
          component("long", "text", LONG_LABEL, [20, 20, 200, 40], LONG_CONTENT),
          component("twin", "button", "First twin", [640, 20, 60, 40]),
          component("twin", "button", "Second twin", [710, 20, 60, 40]),
          component("under", "table", "Underneath", [520, 300, 200, 150], "Partly covered."),
          component("over", "dialog", "On top", [600, 350, 180, 150]),
          component("hostile", "text", HOSTILE_LABEL, [20, 520, 300, 60], HOSTILE_CONTENT),
        ],
        regions: [region("panel", "section", "Panel", [100, 100, 400, 380], { regions: [region("inner", "section", "Inner", [150, 150, 300, 200], { components: [component("deep", "button", "Deep", [170, 170, 120, 40])] })] })],
      }),
      region("drawer", "aside", "Drawer", [-200, 0, 180, 600]),
    ],
    annotations: [
      { id: "on-deep", target: "deep", note: "Attached four levels down.", requirements: ["REQ-0001"] },
      { id: "dangling", target: "nowhere", note: "Aimed at nothing.", requirements: ["REQ-9999"] },
      { id: "which-twin", target: "twin", note: "Aimed at two things.", requirements: [] },
    ],
    implements: ["REQ-0001"],
    decidedBy: ["DEC-9999"],
    openQuestions: ["QST-9999"],
  },
  { schemaVersion: 2 }
);
const INVALID = envelope("WIR-0007", "Fails its schema", { viewport: { width: 800, height: 600 }, regions: [region("main", "main", "Main", [0, 0, 0, 600])], implements: ["REQ-0001"] }, { schemaVersion: 2 });
// Its second region lies four viewport widths out, so everything is in view only at 20%, below the 25% floor.
const FAR = envelope(
  "WIR-0008",
  "Wider than a quarter-scale view",
  { viewport: { width: 800, height: 600 }, regions: [region("near", "main", "Near", [0, 0, 800, 600]), region("far", "aside", "Far", [3200, 0, 800, 600])], implements: ["REQ-0001"] },
  { schemaVersion: 2 }
);
const RECORDS = [...FIVE, HARD, INVALID, FAR];

const validate = createValidators(join(ROOT, "schemas")).wireframe;
const KNOWN = new Set([...readdirSync(join(ROOT, "planning-content", "data"), { recursive: true }).map((f) => /([A-Z]{3}-\d{4,})\.json$/.exec(String(f))?.[1]).filter(Boolean), ...RECORDS.map((r) => r.id)]);
const projected = (doc) => projectWireframe(doc, { validate, knownIds: KNOWN });

/** Everything the tests read from the page, in one evaluation. */
const STATE = `(() => {
  const panel = document.querySelector("[data-vpw-review]");
  const placed = (el) => { if (!el || el.closest("[hidden]")) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const viewer = document.querySelector("[data-wf-viewer]");
  const page = {
    review: panel?.getAttribute("data-vpw-review") ?? null,
    placed: placed(panel),
    href: location.pathname + location.search,
    loaded: document.readyState === "complete",
    innerWidth: window.innerWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    scrollY: Math.round(window.scrollY),
    // Read under a guard: a page with no origin refuses storage, and the failure message should still say where it is.
    storage: (() => { try { return localStorage.length + sessionStorage.length; } catch { return -1; } })(),
    injected: typeof window.__kiln188,
    refused: document.querySelector("[data-vpw-wireframe-refused]")?.getAttribute("data-vpw-wireframe-refused") ?? null,
    refusedText: document.querySelector("[data-vpw-wireframe-refused]")?.textContent ?? null,
    json: document.querySelector("pre[data-vpw-review-content]")?.textContent ?? null,
    form: (() => { const f = [...document.forms].find((f) => f.querySelector("select[name=status]")); return f ? { id: f.querySelector("input[name=id]")?.value, path: f.querySelector("input[name=path]")?.value, button: f.querySelector("button[type=submit]")?.textContent.trim() } : null; })(),
    options: [...document.querySelectorAll("select[name=artifact] option")].map((o) => o.value).filter(Boolean),
    viewer: viewer?.getAttribute("data-wf-viewer") ?? null,
  };
  if (!viewer) return page;
  const svg = viewer.querySelector("svg[viewBox]");
  const canvas = viewer.querySelector("[data-wf-canvas]");
  const matrix = svg.getScreenCTM();
  const toScreen = (x, y) => { const p = new DOMPoint(x, y).matrixTransform(matrix); return { x: p.x, y: p.y }; };
  const moving = [viewer, ...viewer.querySelectorAll("*")].filter((el) => { const s = getComputedStyle(el); return parseFloat(s.transitionDuration) > 0 || s.animationName !== "none" || s.scrollBehavior === "smooth"; }).length;
  return {
    ...page,
    hydrated: Object.keys(canvas).some((k) => k.startsWith("__reactProps")),
    viewBox: svg.getAttribute("viewBox").split(" ").map(Number),
    zoom: Number(viewer.querySelector("[data-wf-zoom]").getAttribute("data-wf-zoom")),
    zoomText: viewer.querySelector("[data-wf-zoom]").textContent,
    svgBox: (() => { const b = svg.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; })(),
    scale: matrix.a,
    elements: [...svg.querySelectorAll("g[data-wf-key]")].map((g) => {
      const rect = g.querySelector("rect");
      const box = rect.getBBox();
      return {
        key: g.getAttribute("data-wf-key"),
        role: g.getAttribute("data-wf-role"),
        selected: g.getAttribute("data-wf-selected") === "true",
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        centre: toScreen(box.x + box.width / 2, box.y + box.height / 2),
        dashed: Boolean(rect.getAttribute("stroke-dasharray")),
        label: g.querySelector("text")?.textContent ?? null,
        badges: [...svg.querySelectorAll("[data-wf-badge]")].filter((b) => b.getAttribute("data-wf-badge-for") === g.getAttribute("data-wf-key")).map((b) => Number(b.getAttribute("data-wf-badge"))),
      };
    }),
    items: [...viewer.querySelectorAll("[data-wf-item]")].map((b) => {
      const entry = b.closest("[data-wf-entry]");
      let depth = 0;
      for (let ul = b.closest("ul"); ul && viewer.contains(ul); ul = ul.parentElement.closest("ul")) depth += 1;
      const own = (selector) => [...entry.querySelectorAll(selector)].filter((el) => el.closest("[data-wf-entry]") === entry);
      return {
        key: b.getAttribute("data-wf-item"),
        current: b.getAttribute("aria-current"),
        text: b.textContent,
        depth,
        drawn: placed(b),
        right: b.getBoundingClientRect().right,
        bounds: own("[data-wf-bounds]")[0]?.textContent ?? null,
        content: own("[data-wf-content]")[0]?.textContent ?? null,
        annotations: own("[data-wf-annotation]").map((a) => a.textContent),
      };
    }),
    selection: viewer.querySelector("[data-wf-selection]").getAttribute("data-wf-selection"),
    selectionText: viewer.querySelector("[data-wf-selection]").textContent,
    controls: [...viewer.querySelectorAll("[data-wf-control]")].map((b) => ({ id: b.getAttribute("data-wf-control"), drawn: placed(b), right: b.getBoundingClientRect().right, left: b.getBoundingClientRect().left })),
    links: [...viewer.querySelectorAll("a[data-wf-trace]")].map((a) => a.getAttribute("href")),
    traces: [...viewer.querySelectorAll("[data-wf-traces] a[data-wf-trace]")].map((a) => a.getAttribute("href")),
    unresolved: [...viewer.querySelectorAll("[data-wf-trace-unresolved]")].map((s) => s.getAttribute("data-wf-trace-unresolved")),
    warnings: [...viewer.querySelectorAll("[data-wf-warning]")].map((w) => w.getAttribute("data-wf-warning")),
    unattached: [...viewer.querySelectorAll("[data-wf-unattached] [data-wf-annotation]")].map((a) => a.getAttribute("data-wf-annotation")),
    markup: viewer.querySelectorAll("script, img, iframe, object, embed, canvas").length,
    moving,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    focus: document.activeElement?.getAttribute("data-wf-control") ?? (document.activeElement?.hasAttribute("data-wf-canvas") ? "canvas" : document.activeElement?.getAttribute("data-wf-item") ?? null),
    text: viewer.textContent,
  };
})()`;

const near = (a, b, tolerance = 0.02) => Math.abs(a - b) <= tolerance;
const sameBox = (actual, expected, message) => assert.ok(actual.every((n, i) => near(n, expected[i])), `${message}: view box ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

/** ⚠️ Every element is laid out, in the wireframe's own units, exactly where the record says it is. */
function checkGeometry(state, view) {
  assert.deepEqual(state.elements.map((e) => e.key), view.elements.map((e) => e.key), "the drawing has every element once, in document order");
  for (const expected of view.elements) {
    const drawn = state.elements.find((e) => e.key === expected.key);
    assert.deepEqual(drawn.box, expected.bounds, `${view.id} ${expected.key} is not drawn at its declared bounds`);
    assert.equal(drawn.role, expected.role);
    assert.equal(drawn.dashed, expected.role === "region", `${expected.key}: a region is dashed and a component is not`);
    assert.equal(drawn.label, expected.label);
    assert.deepEqual(drawn.badges, expected.annotations);
  }
}

/** ⚠️ One element is selected, and the drawing, the list and the selection panel all name the same one. */
function checkSelection(state, key) {
  assert.deepEqual(state.elements.filter((e) => e.selected).map((e) => e.key), key ? [key] : [], "the drawing marks the selected element, and only it");
  assert.deepEqual(state.items.filter((i) => i.current !== null).map((i) => [i.key, i.current]), key ? [[key, "true"]] : [], "the list marks the selected element, and only it");
  assert.equal(state.selection, key ?? "", "the selection panel names the selected element");
}

/** The list says everything the record does about every element, in the same order and nesting. */
function checkList(state, view) {
  assert.deepEqual(state.items.map((i) => [i.key, i.depth]), view.elements.map((e) => [e.key, e.depth]), "the list has every element once, nested as the record nests them");
  for (const expected of view.elements) {
    const item = state.items.find((i) => i.key === expected.key);
    assert.ok(item.text.startsWith(expected.label), `${expected.key}: the whole label is in the list`);
    const { x, y, width, height } = expected.bounds;
    assert.equal(item.bounds, `x ${x}, y ${y}, width ${width}, height ${height}`);
    assert.equal(item.content, expected.content);
    assert.equal(item.annotations.length, expected.annotations.length);
    for (const n of expected.annotations) assert.ok(item.annotations.some((text) => text.includes(view.annotations[n - 1].note)), `${expected.key}: annotation ${n}'s note is with its element`);
    assert.ok(item.drawn, `${expected.key}: its list entry is drawn`);
  }
}

/**
 * ⚠️ What assistive technology is given for the list, read from the browser's accessibility tree and not the DOM:
 * the same nesting as the record, and each element's content, annotation notes and requirement links inside its own
 * list item.
 */
function checkAccessibleList(nodes, view, stageId) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const role = (n) => n.role?.value ?? "";
  const name = (n) => n.name?.value ?? "";
  const exposed = (n) => !n.ignored;
  const ancestors = (n) => {
    const up = [];
    for (let at = byId.get(n.parentId); at; at = byId.get(at.parentId)) up.push(at);
    return up;
  };
  /** Everything under a list item that belongs to it and not to a list item nested inside it. */
  const own = (item) => {
    const found = [];
    const walk = (n) => {
      for (const child of (n.childIds ?? []).map((id) => byId.get(id)).filter(Boolean)) {
        if (exposed(child) && role(child) === "listitem") continue;
        if (exposed(child)) found.push(child);
        walk(child);
      }
    };
    walk(item);
    return found;
  };
  const itemOf = (element) => {
    const buttons = nodes.filter((n) => exposed(n) && role(n) === "button" && name(n) === element.label);
    assert.equal(buttons.length, 1, `${view.id} ${element.key}: ${buttons.length} buttons are exposed as ${JSON.stringify(element.label.slice(0, 60))}`);
    const above = ancestors(buttons[0]).filter(exposed);
    const item = above.find((n) => role(n) === "listitem");
    assert.ok(item, `${element.key}: its button is not inside a list item`);
    return { item, above };
  };
  for (const element of view.elements) {
    const { item, above } = itemOf(element);
    // Hierarchy: one list per level of nesting, and the enclosing list item is the parent element's.
    assert.equal(above.filter((n) => role(n) === "list").length, element.depth, `${element.key}: exposed ${above.filter((n) => role(n) === "list").length} lists deep, declared ${element.depth}`);
    const outer = ancestors(item).filter(exposed).find((n) => role(n) === "listitem") ?? null;
    if (element.parentKey === null) assert.equal(outer, null, `${element.key}: a top-level element is exposed inside another`);
    else assert.equal(outer?.nodeId, itemOf(view.elements.find((e) => e.key === element.parentKey)).item.nodeId, `${element.key}: it is not exposed inside its parent's list item`);

    const inside = own(item);
    const texts = inside.filter((n) => role(n) === "StaticText").map(name);
    const links = inside.filter((n) => role(n) === "link").map(name);
    if (element.content !== null) assert.ok(texts.includes(element.content), `${element.key}: its content is not exposed as text in its list item`);
    for (const n of element.annotations) {
      const annotation = view.annotations[n - 1];
      assert.ok(texts.includes(annotation.note), `${element.key}: annotation ${n}'s note is not exposed as text in its list item`);
      for (const requirement of annotation.requirements.filter((r) => r.resolved)) assert.ok(links.includes(requirement.id), `${element.key}: annotation ${n}'s requirement ${requirement.id} is not exposed as a link in its list item`);
    }
  }
  // A requirement link is a link by role, named by the id, and goes to the review route on this stage.
  const requirement = view.annotations.flatMap((a) => a.requirements).find((r) => r.resolved);
  assert.ok(requirement, `${view.id} has no resolved annotation requirement to check`);
  const link = nodes.find((n) => exposed(n) && role(n) === "link" && name(n) === requirement.id);
  const url = link?.properties?.find((p) => p.name === "url")?.value?.value ?? "";
  assert.ok(url.endsWith(`/stage/${stageId}?artifact=${requirement.id}`), `the exposed link for ${requirement.id} goes to ${JSON.stringify(url)}`);
}

const digest = (dir) => {
  const hash = createHash("sha256");
  for (const name of readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name)).sort()) hash.update(relative(dir, name)).update("\0").update(readFileSync(name)).update("\0");
  return hash.digest("hex");
};

test(
  "⚠️ #188 a wireframe is drawn at its declared bounds, with a list that selects the same element, and no interaction reaches the artifact",
  { timeout: 20 * 60_000, skip: browserPath || process.env.CI ? false : "no Chromium-based browser on this machine; CI runners have one" },
  async () => {
    await withBuildLock(async () => {
      rmSync(join(ROOT, ".next"), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      await execFileP(process.execPath, [NEXT_CLI, "build"], { cwd: ROOT, timeout: 6 * 60_000, maxBuffer: 16 << 20 });

      const base = reapLater(mkdtempSync(join(tmpdir(), "vpw-wireframes-")));
      const content = join(base, "planning-content");
      cpSync(join(ROOT, "planning-content"), content, { recursive: true });
      const manifest = readFileSync(join(content, "project.yaml"), "utf-8");
      assert.ok(manifest.includes("activated: [acceptance-criterion,"), "the manifest's activated list is not where this test expects it");
      writeFileSync(join(content, "project.yaml"), manifest.replace("activated: [acceptance-criterion,", "activated: [wireframe, acceptance-criterion,"));
      const dir = join(content, "data", "wireframes");
      mkdirSync(dir, { recursive: true });
      const written = new Map(RECORDS.map((doc) => [doc.id, JSON.stringify(doc, null, 2) + "\n"]));
      for (const [id, text] of written) writeFileSync(join(dir, `${id}.json`), text);
      const before = digest(content);

      const PORT = await freePort();
      const origin = `http://127.0.0.1:${PORT}`;
      const server = spawn(process.execPath, [NEXT_CLI, "start", "--hostname", "127.0.0.1", "--port", String(PORT)], { cwd: ROOT, stdio: "ignore", env: { ...process.env, PLANNING_CONTENT_DIR: content } });
      const serverExited = new Promise((resolve) => server.once("exit", resolve));
      let browser = null;
      try {
        let up = false;
        for (const readyBy = Date.now() + 90_000; Date.now() < readyBy && !up; ) {
          try {
            await fetch(`${origin}/`, { signal: AbortSignal.timeout(5_000) });
            up = true;
          } catch {
            await sleep(1000);
          }
        }
        assert.ok(up, `the server never accepted a connection on ${PORT}`);

        browser = await launchBrowser(browserPath);
        const { page } = browser;
        await page.send("Network.enable");
        const requests = () => page.events.filter((e) => e.method === "Network.requestWillBeSent").map((e) => `${e.params.request.method} ${e.params.request.url}`);
        const resize = (width) => page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await resize(1280);

        // ⚠️ EVERY WAIT ALSO WAITS FOR THE DOCUMENT TO FINISH LOADING. The application streams, so what a wait looks
        // for can be on the page before its `load` event. Chromium turns a navigation that a script starts before
        // `load` into a replacement of the current history entry. A form submitted or a link clicked that early
        // leaves no entry to go back to, and `history.back()` then lands on the blank page the browser started on
        // (CI run 37977397140, Windows).
        const wait = async (ready, what) => {
          const shown = await until(page, STATE, (s) => Boolean(s) && s.loaded && ready(s), 60_000);
          assert.ok(shown.ok, `${what}: ${JSON.stringify(shown.value)?.slice(0, 1500)}`);
          return shown.value;
        };
        const ready = (id) => (s) => s.placed && s.viewer === id && s.hydrated;
        const open = async (id) => {
          await page.goto(`${origin}/stage/${STAGE}?artifact=${id}`);
          return wait(ready(id), `${id} was never drawn`);
        };
        const read = () => page.eval(STATE);
        const press = (id) => page.eval(`document.querySelector('[data-wf-control="${id}"]').click()`);
        const pick = (key) => page.eval(`document.querySelector('[data-wf-item="${key}"]').click()`);
        const mouse = (type, { x, y }, extra = {}) => page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
        /** A real click where an element is drawn, with the drawing scrolled into the window first. */
        const clickAt = async (point) => {
          await mouse("mouseMoved", point, { button: "none", buttons: 0 });
          await mouse("mousePressed", point);
          await mouse("mouseReleased", point);
        };
        const showCanvas = () => page.eval(`document.querySelector("[data-wf-canvas]").scrollIntoView({ block: "center" })`);
        const centreOf = async (key) => (await showCanvas(), (await read()).elements.find((e) => e.key === key).centre);
        const key = async (name, code, text) => {
          await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code, ...(text ? { text } : {}) });
          await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code });
        };
        /** Run something that leaves the page. It is deferred, so the evaluation has returned before the page goes. */
        const leave = (expression) => page.eval(`void setTimeout(() => { ${expression} }, 0)`);
        const chooser = `${origin}/stage/${STAGE}?type=wireframe`;
        const choose = (id) => leave(`const form = [...document.forms].find((f) => f.querySelector("select[name=artifact]")); form.querySelector("select[name=artifact]").value = "${id}"; form.requestSubmit();`);
        const atChooser = (s) => s.viewer === null && s.options.length === RECORDS.length;

        // ── Five wireframes, reached the way a reviewer reaches them, each compared with its projection. ──
        await page.goto(chooser);
        const listed = await wait(atChooser, "the chooser never listed the wireframes");
        assert.deepEqual(listed.options, RECORDS.map((r) => r.id));
        for (const [index, doc] of FIVE.entries()) {
          const { view } = projected(doc);
          await choose(doc.id);
          const shown = await wait(ready(doc.id), `${doc.id} was never drawn`);
          assert.equal(shown.href, `/stage/${STAGE}?artifact=${doc.id}`);
          checkGeometry(shown, view);
          checkList(shown, view);
          // ⚠️ It starts from its own record: the declared viewport at 100% and nothing selected, whatever was left
          // on the wireframe before it.
          checkSelection(shown, null);
          sameBox(shown.viewBox, [0, 0, doc.viewport.width, doc.viewport.height], `${doc.id} on arrival`);
          assert.equal(shown.zoom, 100);
          assert.deepEqual(shown.warnings, []);
          assert.deepEqual(shown.unresolved, []);
          assert.deepEqual(shown.traces, [...doc.implements, ...(doc.decidedBy ?? [])].map((id) => `/stage/${STAGE}?artifact=${id}`));
          assert.equal(shown.links.length, doc.annotations.reduce((n, a) => n + a.requirements.length, 0) + shown.traces.length, "every annotation requirement is a link too");
          // The record and the review form are still there, and the form is for this artifact.
          assert.equal(shown.json, JSON.stringify(doc, null, 2));
          assert.deepEqual(shown.form, { id: doc.id, path: `/stage/${STAGE}`, button: "Update review status" });
          assert.equal(shown.markup, 0, "the viewer contains no <canvas> and no embedded content");

          // Leave it zoomed, moved and with something selected, then go back and choose the next one.
          await pick(view.elements[2].key);
          await press("zoom-in");
          await press("pan-right");
          const left = await wait((s) => s.selection === view.elements[2].key && s.zoom === 125, `${doc.id} did not take a selection and a zoom`);
          assert.ok(left.viewBox[0] > 0);
          await leave("history.back()");
          const back = await wait(atChooser, `back from ${doc.id} did not return to the chooser`);
          assert.equal(back.href, `/stage/${STAGE}?type=wireframe`);
          if (index === FIVE.length - 1) {
            await leave("history.forward()");
            assert.equal((await wait((s) => s.placed && s.viewer === doc.id, `forward did not return to ${doc.id}`)).href, `/stage/${STAGE}?artifact=${doc.id}`);
          }
        }

        // ── A trace link opens the existing review route on this stage, and back returns to the wireframe. ──
        const one = FIVE[0];
        const view = projected(one).view;
        await open(one.id);
        await leave(`document.querySelector('[data-wf-traces] a[data-wf-trace="REQ-0001"]').click()`);
        const linked = await wait((s) => s.placed && s.review === "REQ-0001", "the requirement link did not open the review route");
        assert.equal(linked.href, `/stage/${STAGE}?artifact=REQ-0001`);
        assert.equal(linked.viewer, null, "a requirement has no wireframe view");
        assert.deepEqual(linked.form, { id: "REQ-0001", path: `/stage/${STAGE}`, button: "Update review status" });
        assert.equal(JSON.parse(linked.json).id, "REQ-0001");
        await leave("history.back()");
        assert.equal((await wait((s) => s.placed && s.viewer === one.id, "back from the requirement did not return to the wireframe")).href, `/stage/${STAGE}?artifact=${one.id}`);

        // ── Selection: a click on the drawing and a click in the list select the same thing. ──
        let state = await open(one.id);
        // The page has finished loading when it has sent nothing for two seconds. Requests are counted from there.
        for (let seen = -1; seen !== requests().length; ) {
          seen = requests().length;
          await sleep(2000);
        }
        const sentBefore = requests().length;
        const target = view.elements.find((e) => e.id === "results-table");
        await clickAt(await centreOf(target.key));
        state = await wait((s) => s.selection === target.key, "a click on the drawing selected nothing");
        checkSelection(state, target.key);
        assert.ok(state.selectionText.includes(target.label) && state.selectionText.includes(target.content) && state.selectionText.includes("x 40, y 352, width 590, height 408"), state.selectionText);
        assert.ok(state.items.find((i) => i.key === target.key).text.endsWith("(selected)"), "the selected entry says so in words, not only by its outline");
        const other = view.elements.find((e) => e.id === "search");
        await pick(other.key);
        state = await wait((s) => s.selection === other.key, "a click in the list selected nothing");
        checkSelection(state, other.key);
        assert.ok(state.selectionText.includes("Search runs on submit"), "the selected element's annotation is shown with it");

        // ── Controls. 100% is the declared viewport, whatever size the drawing is on the page. ──
        const [W, H] = [one.viewport.width, one.viewport.height];
        assert.deepEqual(state.controls.map((c) => [c.id, c.drawn]), ["zoom-in", "zoom-out", "pan-left", "pan-right", "pan-up", "pan-down", "reset", "fit"].map((id) => [id, true]));
        await press("zoom-in");
        state = await wait((s) => s.zoom === 125, "zoom in");
        sameBox(state.viewBox, [W * 0.1, H * 0.1, W / 1.25, H / 1.25], "zoom in keeps the centre");
        assert.equal(state.zoomText, "Zoom 125%");
        await press("pan-right");
        await press("pan-down");
        state = await wait((s) => s.viewBox[0] > W * 0.1 + 1 && s.viewBox[1] > H * 0.1 + 1, "pan right and down");
        sameBox(state.viewBox, [W * 0.1 + (W * 0.1) / 1.25, H * 0.1 + (H * 0.1) / 1.25, W / 1.25, H / 1.25], "a pan moves a tenth of what is visible");
        await press("pan-left");
        await press("pan-up");
        await press("zoom-out");
        state = await wait((s) => s.zoom === 100, "zoom out");
        sameBox(state.viewBox, [0, 0, W, H], "the opposite controls undo each other");
        checkSelection(state, other.key);
        // Fit keeps the selection. Reset clears it.
        await press("zoom-in");
        await press("fit");
        state = await wait((s) => s.zoom === 100, "fit");
        sameBox(state.viewBox, [0, 0, W, H], "fit, when nothing lies outside the viewport");
        checkSelection(state, other.key);
        await press("zoom-in");
        await press("pan-left");
        await press("reset");
        state = await wait((s) => s.zoom === 100 && s.selection === "", "reset");
        sameBox(state.viewBox, [0, 0, W, H], "reset");
        checkSelection(state, null);
        checkGeometry(state, view);

        // ── Pointer: a drag pans and selects nothing. ──
        await showCanvas();
        state = await read();
        const start = { x: (state.svgBox.left + state.svgBox.right) / 2, y: (state.svgBox.top + state.svgBox.bottom) / 2 };
        await mouse("mouseMoved", start, { button: "none", buttons: 0 });
        await mouse("mousePressed", start);
        await mouse("mouseMoved", { x: start.x - 40, y: start.y - 20 });
        await mouse("mouseMoved", { x: start.x - 80, y: start.y - 40 });
        await mouse("mouseReleased", { x: start.x - 80, y: start.y - 40 });
        const dragged = await wait((s) => s.viewBox[0] > 1, "a drag did not pan");
        sameBox(dragged.viewBox, [80 / state.scale, 40 / state.scale, W, H], "the drawing follows the pointer");
        checkSelection(dragged, null);
        await press("reset");
        await wait((s) => s.viewBox[0] === 0, "reset after the drag");

        // ── Wheel: a plain wheel scrolls the page and leaves the drawing alone. Ctrl+wheel zooms about the pointer. ──
        await page.eval("window.scrollTo(0, 0)");
        await showCanvas();
        state = await read();
        const over = { x: (state.svgBox.left + state.svgBox.right) / 2, y: (state.svgBox.top + state.svgBox.bottom) / 2 };
        await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: over.x, y: over.y, deltaX: 0, deltaY: 120 });
        const scrolled = await wait((s) => s.scrollY > state.scrollY, "a plain wheel over the drawing did not scroll the page");
        sameBox(scrolled.viewBox, [0, 0, W, H], "a plain wheel must not zoom");
        assert.equal(scrolled.zoom, 100);
        await showCanvas();
        state = await read();
        // The pointer is over a known point of the wireframe, a quarter of the way in from the top-left.
        const anchor = { x: state.svgBox.left + (state.svgBox.width - W * state.scale) / 2 + (W / 4) * state.scale, y: state.svgBox.top + (state.svgBox.height - H * state.scale) / 2 + (H / 4) * state.scale };
        await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: anchor.x, y: anchor.y, deltaX: 0, deltaY: -100, modifiers: 2 });
        const zoomed = await wait((s) => s.zoom > 100, "Ctrl+wheel did not zoom");
        assert.equal(zoomed.scrollY, state.scrollY, "Ctrl+wheel must not scroll the page");
        const factor = zoomed.zoom / 100;
        assert.ok(near(factor, Math.exp(0.22), 0.01), `one wheel step zoomed by ${factor}`);
        // The point under the pointer stayed under it: a quarter of the way into the new view box.
        assert.ok(near(zoomed.viewBox[0] + zoomed.viewBox[2] / 4, W / 4, 0.5) && near(zoomed.viewBox[1] + zoomed.viewBox[3] / 4, H / 4, 0.5), `the zoom was not about the pointer: ${JSON.stringify(zoomed.viewBox)}`);
        await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: anchor.x, y: anchor.y, deltaX: 0, deltaY: 100, modifiers: 2 });
        await wait((s) => near(s.zoom, 100, 0.5), "Ctrl+wheel the other way did not zoom back out");
        await press("reset");

        // ── Keyboard: the drawing takes focus and every control has a key. A list entry is a button. ──
        await page.eval(`document.querySelector("[data-wf-canvas]").focus()`);
        assert.equal((await read()).focus, "canvas");
        await key("+", 187);
        state = await wait((s) => s.zoom === 125, "+ did not zoom in");
        await key("ArrowRight", 39);
        await key("ArrowDown", 40);
        state = await wait((s) => s.viewBox[1] > H * 0.1 + 1, "the arrow keys did not pan");
        sameBox(state.viewBox, [W * 0.1 + (W * 0.1) / 1.25, H * 0.1 + (H * 0.1) / 1.25, W / 1.25, H / 1.25], "arrow keys");
        await key("ArrowLeft", 37);
        await key("ArrowUp", 38);
        await key("-", 189);
        state = await wait((s) => s.zoom === 100, "- did not zoom out");
        sameBox(state.viewBox, [0, 0, W, H], "the opposite keys undo each other");
        await page.eval(`document.querySelector('[data-wf-item="${target.key}"]').focus()`);
        await key("Enter", 13, "\r");
        state = await wait((s) => s.selection === target.key, "Enter on a list entry did not select it");
        checkSelection(state, target.key);
        await page.eval(`document.querySelector("[data-wf-canvas]").focus()`);
        await key("+", 187);
        await key("f", 70);
        state = await wait((s) => s.zoom === 100, "F did not fit");
        checkSelection(state, target.key);
        await key("Escape", 27);
        state = await wait((s) => s.selection === "", "Escape did not clear the selection");
        await pick(target.key);
        await key("+", 187);
        await wait((s) => s.zoom === 125 && s.selection === target.key, "select and zoom before 0");
        await page.eval(`document.querySelector("[data-wf-canvas]").focus()`);
        await key("0", 48);
        state = await wait((s) => s.zoom === 100 && s.selection === "", "0 did not reset");
        sameBox(state.viewBox, [0, 0, W, H], "0 resets");

        // ⚠️ None of that sent a request, changed the address, or stored anything.
        assert.deepEqual(requests().slice(sentBefore), [], "interacting with the viewer sent a request");
        assert.equal(state.href, `/stage/${STAGE}?artifact=${one.id}`);
        assert.equal(state.storage, 0, "the viewer stored something in the browser");

        // ── What assistive technology is given: the list's buttons and the named controls, not the drawing. ──
        await page.send("Accessibility.enable");
        const { nodes } = await page.send("Accessibility.getFullAXTree");
        const exposed = nodes.filter((n) => !n.ignored);
        const buttons = exposed.filter((n) => n.role?.value === "button").map((n) => n.name?.value ?? "");
        for (const element of view.elements) assert.ok(buttons.includes(element.label), `no button is exposed for ${element.label}`);
        for (const name of ["Zoom in", "Zoom out", "Pan left", "Pan right", "Pan up", "Pan down", "Reset view and clear selection", "Fit everything in view"]) assert.ok(buttons.includes(name), `no control is exposed as ${name}`);
        assert.ok(exposed.some((n) => n.role?.value === "group" && /^Drawing of Catalogue overview\. Arrow keys pan/.test(n.name?.value ?? "")), "the drawing is not exposed as a named, focusable group");
        assert.equal(exposed.filter((n) => /^Svg/i.test(n.role?.value ?? "") || n.role?.value === "graphics-document").length, 0, "the drawing's shapes are exposed twice");
        // The list's nesting, each component's content, each annotation's note and a requirement link.
        assert.ok(view.elements.some((e) => e.content !== null) && view.elements.some((e) => e.annotations.length > 0 && e.depth === 2), "the first wireframe no longer has what this check reads");
        checkAccessibleList(nodes, view, STAGE);

        // ── Reduced motion. Nothing moves by default, so the preference changes nothing and everything still works. ──
        assert.equal(state.moving, 0, "something in the viewer has a transition or an animation");
        await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        state = await open(one.id);
        assert.equal(state.reducedMotion, true);
        assert.equal(state.moving, 0);
        await press("zoom-in");
        await pick(target.key);
        state = await wait((s) => s.zoom === 125 && s.selection === target.key, "the viewer did not respond with reduced motion preferred");
        assert.equal(state.moving, 0);
        await page.send("Emulation.setEmulatedMedia", { features: [] });

        // ── ⚠️ The mutation control. The two checks pass on the page as served. ──
        state = await open(one.id);
        await pick(target.key);
        state = await wait((s) => s.selection === target.key, "selection before the control");
        checkGeometry(state, view);
        checkSelection(state, target.key);
        // Take the geometry off the drawing. The geometry check must fail, and the selection check must not.
        await page.eval(`for (const rect of document.querySelectorAll("g[data-wf-key] > rect")) for (const name of ["x", "y", "width", "height"]) rect.removeAttribute(name)`);
        state = await read();
        assert.throws(() => checkGeometry(state, view), /is not drawn at its declared bounds/, "the geometry check passed on a drawing with no bounds");
        checkSelection(state, target.key);
        // Take the selection out of the list only. The selection check must fail, and the geometry check must not.
        state = await open(one.id);
        await pick(target.key);
        await wait((s) => s.selection === target.key, "selection before the second control");
        await page.eval(`document.querySelector('[data-wf-item][aria-current]').removeAttribute("aria-current")`);
        state = await read();
        assert.throws(() => checkSelection(state, target.key), /the list marks the selected element/, "the selection check passed with the list out of step");
        checkGeometry(state, view);
        // And out of the drawing only.
        state = await open(one.id);
        await pick(target.key);
        await wait((s) => s.selection === target.key, "selection before the third control");
        await page.eval(`document.querySelector('g[data-wf-selected]').removeAttribute("data-wf-selected")`);
        state = await read();
        assert.throws(() => checkSelection(state, target.key), /the drawing marks the selected element/, "the selection check passed with the drawing out of step");
        checkGeometry(state, view);

        // ── The hard record: nesting, overlap, long text, markup-like text, and everything it warns about. ──
        const hard = projected(HARD).view;
        state = await open(HARD.id);
        checkGeometry(state, hard);
        checkList(state, hard);
        assert.deepEqual(state.items.find((i) => i.text.startsWith("Deep")).depth, 4);
        assert.deepEqual(state.warnings, hard.warnings.map((w) => w.code), "the warnings the projection returned are the ones on the page");
        assert.deepEqual(
          [...state.warnings].sort(),
          [WIREFRAME_WARNING.ANNOTATION_TARGET_AMBIGUOUS, WIREFRAME_WARNING.ANNOTATION_TARGET_MISSING, WIREFRAME_WARNING.DUPLICATE_ELEMENT_ID, WIREFRAME_WARNING.OUTSIDE_VIEWPORT, WIREFRAME_WARNING.TRACE_UNRESOLVED, WIREFRAME_WARNING.TRACE_UNRESOLVED, WIREFRAME_WARNING.TRACE_UNRESOLVED]
        );
        assert.deepEqual(state.unattached, ["a1", "a2"], "an annotation with no single target is listed on its own");
        assert.deepEqual(state.unresolved.sort(), ["DEC-9999", "QST-9999", "REQ-9999"], "an artifact that does not exist is named, not linked");
        assert.ok(!state.links.some((href) => /9999/.test(href)));
        // Text that would be markup is on the page as the characters it is, and nothing ran.
        assert.equal(state.injected, "undefined", "a string from the record was executed");
        assert.equal(state.markup, 0, "a string from the record became an element");
        assert.ok(state.text.includes(HOSTILE_LABEL) && state.text.includes(HOSTILE_CONTENT));
        assert.ok(state.text.includes(LONG_LABEL) && state.text.includes(LONG_CONTENT), "the long label and content are on the page in full");
        // Overlap: a click where two components overlap selects the one drawn last. The list reaches the other.
        const under = hard.elements.find((e) => e.id === "under");
        const top = hard.elements.find((e) => e.id === "over");
        await showCanvas();
        state = await read();
        const overlap = { x: top.bounds.x + 30, y: top.bounds.y + 50 };
        assert.ok(overlap.x < under.bounds.x + under.bounds.width && overlap.y < under.bounds.y + under.bounds.height, "the test's point is not inside both components");
        const origin0 = state.elements.find((e) => e.key === top.key);
        await clickAt({ x: origin0.centre.x + (overlap.x - (top.bounds.x + top.bounds.width / 2)) * state.scale, y: origin0.centre.y + (overlap.y - (top.bounds.y + top.bounds.height / 2)) * state.scale });
        state = await wait((s) => s.selection !== "", "a click on overlapping elements selected nothing");
        checkSelection(state, top.key);
        await pick(under.key);
        state = await wait((s) => s.selection === under.key, "the covered element could not be selected from the list");
        checkSelection(state, under.key);
        // Both elements that declare one id can be selected, each on its own.
        const twins = hard.elements.filter((e) => e.id === "twin");
        for (const twin of twins) {
          await pick(twin.key);
          checkSelection(await wait((s) => s.selection === twin.key, "a twin could not be selected"), twin.key);
        }
        // Fit takes in the region outside the viewport. Reset returns to the viewport and clears the selection.
        await press("fit");
        state = await wait((s) => s.zoom === 80, "fit did not take in the whole extent");
        sameBox(state.viewBox, [-200, -75, 1000, 750], "fit frames the viewport and everything outside it");
        checkSelection(state, twins[1].key);
        await press("reset");
        state = await wait((s) => s.zoom === 100 && s.selection === "", "reset on the hard record");
        sameBox(state.viewBox, [0, 0, 800, 600], "reset is the declared viewport");
        // The same list, four levels deep, as assistive technology is given it.
        checkAccessibleList((await page.send("Accessibility.getFullAXTree")).nodes, hard, STAGE);

        // ── ⚠️ The lowest zoom is min(25%, the zoom Fit needs). Here Fit needs 80%, so zooming out stops at 25%. ──
        for (let i = 0; i < 10; i += 1) await press("zoom-out");
        state = await wait((s) => s.zoom === 25, "zooming out did not stop at 25%");
        sameBox(state.viewBox, [-1200, -900, 3200, 2400], "25% of an 800 by 600 viewport, about its centre");
        await press("zoom-out");
        await press("zoom-in");
        state = await wait((s) => s.zoom === 31.25, "one more zoom out moved below 25%");
        // And here Fit needs 20%. Fit reaches it, everything is in view, and zooming out goes no lower.
        const far = projected(FAR).view;
        assert.deepEqual(far.extent, { x: 0, y: 0, width: 4000, height: 600 });
        state = await open(FAR.id);
        checkGeometry(state, far);
        assert.equal(state.zoom, 100);
        await press("fit");
        state = await wait((s) => s.zoom === 20, "fit did not go below 25% for a record that needs it");
        assert.equal(state.zoomText, "Zoom 20%");
        sameBox(state.viewBox, [0, -1200, 4000, 3000], "fit frames both regions");
        for (const element of far.elements) assert.ok(element.bounds.x >= state.viewBox[0] && element.bounds.x + element.bounds.width <= state.viewBox[0] + state.viewBox[2], `${element.id} is not inside the fitted view`);
        await press("zoom-out");
        await press("zoom-out");
        await press("zoom-in");
        state = await wait((s) => s.zoom === 25, "zooming out went below the zoom Fit needs");
        for (let i = 0; i < 10; i += 1) await press("zoom-out");
        state = await wait((s) => s.zoom === 20, "zooming out from 25% did not stop where Fit does");
        await press("reset");
        state = await wait((s) => s.zoom === 100, "reset from below 25%");
        sameBox(state.viewBox, [0, 0, 800, 600], "reset from below 25%");

        // ── Narrow. Nothing scrolls sideways, and the list and its details are all still drawn. ──
        await resize(320);
        state = await open(HARD.id);
        assert.equal(state.innerWidth, 320);
        assert.ok(state.scrollWidth <= 320, `the page is ${state.scrollWidth}px wide in a 320px window`);
        checkGeometry(state, hard);
        checkList(state, hard);
        assert.ok(state.items.every((i) => i.right <= 320), "a list entry runs off the side");
        assert.ok(state.controls.every((c) => c.drawn && c.left >= 0 && c.right <= 320), "a control is off the side or not drawn");
        assert.ok(state.svgBox.width > 200 && state.svgBox.right <= 320, `the drawing is ${state.svgBox.width}px wide`);
        await pick(under.key);
        checkSelection(await wait((s) => s.selection === under.key, "selection at the narrow width"), under.key);
        const fifth = await open(FIVE[4].id);
        assert.ok(fifth.scrollWidth <= 320);
        checkGeometry(fifth, projected(FIVE[4]).view);
        checkList(fifth, projected(FIVE[4]).view);
        await resize(1280);

        // ── A record that fails its schema is refused where it is shown. The rest of the page is unaffected. ──
        const refusal = projected(INVALID).refusal;
        assert.equal(refusal.code, WIREFRAME_REFUSAL.SCHEMA_INVALID);
        await page.goto(`${origin}/stage/${STAGE}?artifact=${INVALID.id}`);
        const refused = await wait((s) => s.placed && s.review === INVALID.id, "the invalid wireframe's review panel never appeared");
        assert.equal(refused.viewer, null, "a record that failed its schema reached the viewer");
        assert.equal(refused.refused, WIREFRAME_REFUSAL.SCHEMA_INVALID);
        for (const message of refusal.messages) assert.ok(refused.refusedText.includes(message), message);
        assert.equal(refused.json, JSON.stringify(INVALID, null, 2), "the record is still shown as written");
        assert.deepEqual(refused.form, { id: INVALID.id, path: `/stage/${STAGE}`, button: "Update review status" });

        // ── ⚠️ Nothing was written. Every request was a read, and the project is byte for byte what it was. ──
        assert.deepEqual(requests().filter((r) => !r.startsWith("GET ")), [], "something other than a read was sent");
        for (const [id, text] of written) assert.equal(readFileSync(join(dir, `${id}.json`), "utf-8"), text, `${id} changed on disk`);
        assert.equal(digest(content), before, "the planning content changed");
      } finally {
        await browser?.close();
        server.kill();
        if (!(await exitedWithin(serverExited, 20_000))) {
          server.kill("SIGKILL");
          await exitedWithin(serverExited, 10_000);
        }
        assert.ok(server.exitCode !== null || server.signalCode !== null, "the application server was still running when the test ended");
      }
    });
  }
);
