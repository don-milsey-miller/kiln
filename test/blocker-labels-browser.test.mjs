/**
 * What a reader is shown for a blocked or waiting stage, in a real browser - #183.
 *
 * The project view and the stage view used to label a criterion by its id alone: `runbook-steps-above-threshold`
 * where the stage definition says, in a sentence, what is being asked. This builds the real application, serves a
 * copy of this repository's planning content with Stage 9 made the waiting stage, and reads both views in
 * Chromium over the DevTools protocol: what is rendered, in what order, how large, how it is exposed to assistive
 * technology (read from the browser's accessibility tree), and whether a narrow page has to scroll sideways.
 *
 * ⚠️ **STAGE 9 ON PURPOSE.** Its criteria are the longest in the pipeline, in both senses: a 186-character
 * description and a 32-character id with no space in it. A layout that holds these holds the rest.
 *
 * ⚠️ **THE DEFINITIONS ARE READ, NOT RESTATED.** Every expected description and the expected order come from
 * `stages/09-handoff.json`, which this change does not touch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { findBrowser, launchBrowser, until } from "./helpers/browser.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";
import { installReaper, reapLater } from "./helpers/reap.mjs";

installReaper();

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NEXT_CLI = join(ROOT, "node_modules", "next", "dist", "bin", "next");
/** A port nothing is using. Test files in this group run at the same time, so none may be assumed. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
const STAGE = "09-handoff";
const CRITERIA = JSON.parse(readFileSync(join(ROOT, "stages", `${STAGE}.json`), "utf-8")).exitCriteria.map(({ id, describe }) => ({ id, describe }));
const LONG = CRITERIA.find((c) => c.id === "runbook-steps-above-threshold");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Whether `exited` settles within `ms`. The timer is cleared either way, so a server that left at once holds nothing up. */
const exitedWithin = (exited, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    exited.then(() => (clearTimeout(timer), resolve(true)));
  });
const browserPath = findBrowser();
const WIDE = 1280;
const NARROW = 320;

/** What one criterion's label looks like in the page, measured where it is drawn. */
const LABELS = `(() => {
  const size = (el) => parseFloat(getComputedStyle(el).fontSize);
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll("[data-vpw-criterion-label]")].filter((label) => !label.closest("[hidden]")).map((label) => {
    const description = label.querySelector("[data-vpw-criterion-description]");
    const id = label.querySelector("code[data-vpw-criterion-id]");
    const host = label.closest("li, [data-vpw-blockers]");
    return {
      id: label.getAttribute("data-vpw-criterion-label"),
      description: description ? description.textContent : null,
      idText: id ? id.textContent : null,
      idIsCode: Boolean(id) && id.tagName === "CODE",
      // The description precedes the id in the document, which is the order it is read in.
      descriptionFirst: Boolean(description && id) && Boolean(description.compareDocumentPosition(id) & Node.DOCUMENT_POSITION_FOLLOWING),
      descriptionAbove: Boolean(description && id) && description.getBoundingClientRect().top <= id.getBoundingClientRect().top,
      descriptionPx: description ? size(description) : null,
      idPx: id ? size(id) : null,
      bothDrawn: Boolean(description && id) && visible(description) && visible(id),
      right: Math.max(...[description, id].filter(Boolean).map((el) => el.getBoundingClientRect().right)),
      inListItem: Boolean(host) && host.tagName === "LI",
      list: host && host.tagName === "LI" ? host.parentElement.tagName : null,
    };
  });
})()`;
/**
 * What the browser exposes to assistive technology, from its accessibility tree.
 *
 * ⚠️ **THE TREE, NOT THE DOM'S TEXT.** `textContent` says what characters are in the document. It does not say an
 * element is exposed, what role it has, or what a list is called. Those are read here from Chromium's own
 * computed tree: every list with its name, and for each item the text a screen reader is given, in order.
 */
async function accessibility(page) {
  await page.send("Accessibility.enable");
  const { nodes } = await page.send("Accessibility.getFullAXTree");
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const role = (node) => node.role?.value ?? null;
  const name = (node) => node.name?.value ?? "";
  const children = (node) => (node.childIds ?? []).map((id) => byId.get(id)).filter(Boolean);
  /** The static text beneath a node, in reading order. An ignored node exposes nothing of its own; its children may. */
  const texts = (node) => (role(node) === "StaticText" ? (node.ignored ? [] : [name(node)]) : children(node).flatMap(texts));
  const within = (node, wanted) => children(node).flatMap((child) => (!child.ignored && role(child) === wanted ? [child] : within(child, wanted)));
  const spoken = (node) => texts(node).map((text) => text.replace(/\s+/g, " ").trim()).filter((text) => text.length > 0);
  const exposed = nodes.filter((node) => !node.ignored);
  return {
    lists: exposed.filter((node) => role(node) === "list").map((list) => ({
      name: name(list),
      items: within(list, "listitem").map((item) => ({ spoken: spoken(item), codes: within(item, "code").map((code) => spoken(code).join(" ")) })),
    })),
    /** Everything exposed on the page, for content that is not in a list. */
    spoken: spoken(nodes.find((node) => role(node) === "RootWebArea") ?? nodes[0]),
    codes: exposed.filter((node) => role(node) === "code").map((code) => spoken(code).join(" ")),
  };
}
/** What a criterion must be exposed as: its description, then its id named as one. */
const exposedAs = (criterion) => [criterion.describe, "Criterion ID:", criterion.id];

/**
 * ⚠️ **A PANEL IS ON THE PAGE BEFORE IT IS IN PLACE.** The application streams: a panel that is still reading is
 * sent later, inside a `<div hidden>`, and a script then moves it to where its placeholder was. Between those two
 * moments the panel's markers can be found in the document and nothing of it is drawn. `placed` is true only once
 * the panel is out of any hidden container and has a size, and every wait below requires it.
 */
const PAGE = `(() => ({
  placed: (() => {
    const panel = document.querySelector("[data-vpw-current], [data-vpw-criteria]");
    if (!panel || panel.closest("[hidden]")) return false;
    const box = panel.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  })(),
  current: document.querySelector("[data-vpw-current]")?.getAttribute("data-vpw-current") ?? null,
  state: document.querySelector("[data-vpw-current]")?.getAttribute("data-vpw-gate-state") ?? null,
  blockers: document.querySelector("[data-vpw-blockers]")?.getAttribute("data-vpw-blockers") ?? null,
  blockerText: document.querySelector("[data-vpw-blockers]")?.textContent.replace(/\\s+/g, " ").trim() ?? null,
  listLabelledBy: (() => { const ul = document.querySelector("[data-vpw-blockers] ul"); const by = ul?.getAttribute("aria-labelledby"); return by ? document.getElementById(by)?.textContent ?? null : null; })(),
  criteria: document.querySelector("[data-vpw-criteria]")?.getAttribute("data-vpw-criteria") ?? null,
  viewport: window.innerWidth,
  scrollWidth: document.documentElement.scrollWidth,
  bodyScrollWidth: document.body.scrollWidth,
}))()`;

test(
  "⚠️ #183 both views label a criterion by its description, with its id as smaller secondary text, at any width",
  { timeout: 15 * 60_000, skip: browserPath || process.env.CI ? false : "no Chromium-based browser on this machine; CI runners have one" },
  async () => {
    await withBuildLock(async () => {
      // Retried: the test that held the build lock before this one may have a server that is still letting go of it.
      rmSync(join(ROOT, ".next"), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      await execFileP(process.execPath, [NEXT_CLI, "build"], { cwd: ROOT, timeout: 6 * 60_000, maxBuffer: 16 << 20 });

      // A COPY of this repository's planning content, with Stage 9 made the stage that is waiting.
      const base = reapLater(mkdtempSync(join(tmpdir(), "vpw-blockers-")));
      const content = join(base, "planning-content");
      cpSync(join(ROOT, "planning-content"), content, { recursive: true });
      const attestations = join(content, "state", "stage-attestations", `${STAGE}.json`);
      const recorded = JSON.parse(readFileSync(attestations, "utf-8"));
      const set = (change) => {
        const doc = structuredClone(recorded);
        change(doc.attestations);
        writeFileSync(attestations, JSON.stringify(doc, null, 2) + "\n");
      };
      // No decision on any of the three: the stage awaits all of them.
      set((all) => {
        for (const { id } of CRITERIA) delete all[id];
      });

      const PORT = await freePort();
      const server = spawn(process.execPath, [NEXT_CLI, "start", "--hostname", "127.0.0.1", "--port", String(PORT)], { cwd: ROOT, stdio: "ignore", env: { ...process.env, PLANNING_CONTENT_DIR: content } });
      const serverExited = new Promise((resolve) => server.once("exit", resolve));
      let browser = null;
      try {
        let up = false;
        for (const readyBy = Date.now() + 90_000; Date.now() < readyBy && !up; ) {
          try {
            await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(5_000) });
            up = true;
          } catch {
            await sleep(1000);
          }
        }
        assert.ok(up, `the server never accepted a connection on ${PORT}`);

        browser = await launchBrowser(browserPath);
        const { page } = browser;
        const width = (px) => page.send("Emulation.setDeviceMetricsOverride", { width: px, height: 900, deviceScaleFactor: 1, mobile: false });
        const open = async (path, ready) => {
          await page.goto(`http://127.0.0.1:${PORT}${path}`);
          const shown = await until(page, PAGE, ready, 60_000);
          assert.ok(shown.ok, `${path} never showed what was expected: ${JSON.stringify(shown.value)}`);
          return shown.value;
        };
        const projectReady = (blockers) => (s) => s?.placed === true && s.current === STAGE && s.blockers === blockers;
        const stageReady = (s) => s?.placed === true && s.criteria === STAGE;
        /** The assertions that hold for a criterion's label wherever it is rendered. */
        const assertLabel = (label, where) => {
          const expected = CRITERIA.find((c) => c.id === label.id);
          assert.ok(expected, `${where}: an unknown criterion ${label.id}`);
          assert.equal(label.description, expected.describe, `${where}: ${label.id} is not labelled by its definition's description`);
          assert.equal(label.idText, label.id, `${where}: ${label.id}'s id is not on the page as text`);
          assert.ok(label.idIsCode, `${where}: ${label.id}'s id is not in <code>`);
          assert.ok(label.descriptionFirst && label.descriptionAbove, `${where}: ${label.id}'s id comes before its description`);
          assert.ok(label.idPx < label.descriptionPx, `${where}: ${label.id}'s id (${label.idPx}px) is not smaller than its description (${label.descriptionPx}px)`);
          assert.ok(label.bothDrawn, `${where}: ${label.id}'s description or id is not drawn`);
        };
        /** No sideways scrolling, and no label drawn past the edge of the page. */
        const assertFits = (state, labels, where) => {
          assert.ok(state.scrollWidth <= state.viewport, `${where}: the page is ${state.scrollWidth}px wide in a ${state.viewport}px viewport`);
          assert.ok(state.bodyScrollWidth <= state.viewport, `${where}: the body is ${state.bodyScrollWidth}px wide in a ${state.viewport}px viewport`);
          for (const label of labels) assert.ok(label.right <= state.viewport + 0.5, `${where}: ${label.id} is drawn to ${label.right}px in a ${state.viewport}px viewport`);
        };

        for (const px of [WIDE, NARROW]) {
          await width(px);

          /* ---- the project view: several blockers */
          const project = await open("/", projectReady(String(CRITERIA.length)));
          assert.equal(project.state, "awaiting-attestation");
          assert.equal(project.viewport, px);
          const blockers = await page.eval(LABELS);
          // ⚠️ EVERY PENDING CRITERION, IN THE ORDER THE STAGE DEFINITION LISTS THEM.
          assert.deepEqual(blockers.map((b) => b.id), CRITERIA.map((c) => c.id), `project view at ${px}px`);
          for (const blocker of blockers) {
            assertLabel(blocker, `project view at ${px}px`);
            assert.deepEqual([blocker.inListItem, blocker.list], [true, "UL"], `project view at ${px}px: ${blocker.id} is not an item of a list`);
          }
          assert.equal(project.listLabelledBy, "Awaiting:", "the list of blockers has no accessible name");

          // ⚠️ WHAT ASSISTIVE TECHNOLOGY IS GIVEN, FROM THE BROWSER'S ACCESSIBILITY TREE. A list called "Awaiting:"
          // with one item for each blocker, and in each item the description, then the id announced as an id.
          const projectTree = await accessibility(page);
          const blockerList = projectTree.lists.find((list) => list.name === "Awaiting:");
          assert.ok(blockerList, `project view at ${px}px: no list named "Awaiting:" is exposed; lists are ${JSON.stringify(projectTree.lists.map((l) => l.name))}`);
          assert.deepEqual(blockerList.items.map((item) => item.spoken), CRITERIA.map(exposedAs), `project view at ${px}px: what each blocker is exposed as`);
          // The id is exposed as code, and it is the only thing that is.
          assert.deepEqual(blockerList.items.map((item) => item.codes), CRITERIA.map((c) => [c.id]));
          // The long Stage 9 criterion is there whole, not cut.
          assert.equal(blockers.find((b) => b.id === LONG.id).description.length, LONG.describe.length);
          assert.ok(LONG.describe.length > 150);
          // And the ids are not what the summary leads with.
          assert.ok(project.blockerText.startsWith(`Awaiting: ${CRITERIA[0].describe}`), project.blockerText.slice(0, 120));
          assertFits(project, blockers, `project view at ${px}px`);

          /* ---- the stage view: every criterion, the same label */
          const stage = await open(`/stage/${STAGE}`, stageReady);
          await page.eval(`document.querySelector("[data-vpw-criteria]").open = true`);
          const rows = await page.eval(LABELS);
          assert.deepEqual(rows.map((r) => r.id), CRITERIA.map((c) => c.id), `stage view at ${px}px`);
          for (const row of rows) {
            assertLabel(row, `stage view at ${px}px`);
            assert.deepEqual([row.inListItem, row.list], [true, "UL"], `stage view at ${px}px: ${row.id} is not an item of a list`);
          }
          // ⚠️ CONSISTENT: the two views say the same thing about the same criterion.
          assert.deepEqual(rows.map((r) => [r.id, r.description, r.idText]), blockers.map((b) => [b.id, b.description, b.idText]));

          // And expose the same thing: each criterion's item begins with its description and its named id, before
          // the attestation status that only this view adds.
          const stageTree = await accessibility(page);
          const criteriaList = stageTree.lists.find((list) => list.items.length === CRITERIA.length && list.items.every((item, i) => item.codes.includes(CRITERIA[i].id)));
          assert.ok(criteriaList, `stage view at ${px}px: no list of the stage's criteria is exposed: ${JSON.stringify(stageTree.lists.map((l) => l.items.map((i) => i.codes)))}`);
          assert.deepEqual(criteriaList.items.map((item) => item.spoken.slice(0, 3)), CRITERIA.map(exposedAs), `stage view at ${px}px: what each criterion is exposed as`);
          assert.deepEqual(criteriaList.items.map((item) => item.spoken.slice(0, 3)), blockerList.items.map((item) => item.spoken), "the two views expose a criterion differently");
          assertFits({ ...stage, ...(await page.eval(PAGE)) }, rows, `stage view at ${px}px`);
        }

        /* ---- one blocker: no list of one, and the same label */
        await width(NARROW);
        set((all) => {
          for (const { id } of CRITERIA) all[id] = { result: "satisfied", decidedBy: "a test", reason: "Set in a copy." };
          all[LONG.id] = { result: "not-satisfied", decidedBy: "a test", reason: "Set in a copy." };
        });
        const single = await open("/", (s) => s?.placed === true && s.current === STAGE && s.blockers === "1" && s.state === "blocked");
        const [only, ...others] = await page.eval(LABELS);
        assert.equal(others.length, 0);
        assertLabel(only, "one blocker");
        assert.equal(only.id, LONG.id);
        assert.equal(only.inListItem, false, "a single blocker is rendered as a list of one");
        assert.ok(single.blockerText.startsWith(`Blocked on: ${LONG.describe}`), single.blockerText.slice(0, 120));
        // Exposed in reading order with no list around it: the lead, the description, the id named as one.
        const singleTree = await accessibility(page);
        const lead = singleTree.spoken.indexOf("Blocked on:");
        assert.ok(lead !== -1, "the lead text of a single blocker is not exposed");
        assert.deepEqual(singleTree.spoken.slice(lead, lead + 4), ["Blocked on:", ...exposedAs(LONG)]);
        assert.ok(singleTree.codes.includes(LONG.id));
        assert.ok(!singleTree.lists.some((list) => list.items.some((item) => item.codes.includes(LONG.id))), "a single blocker is exposed as a list");
        assertFits(single, [only], "one blocker at the narrow width");
      } finally {
        await browser?.close();
        // ⚠️ WAITED FOR, NOT ONLY ASKED. A server still exiting holds its port and its files while the next test starts.
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
