import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README_PATH = resolve(ROOT, "README.md");
const README = readFileSync(README_PATH, "utf8");
const PACKAGE = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const LINES = README.split(/\r?\n/);

test("README has one accessible, unskipped heading hierarchy", () => {
  const headings = LINES.flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    return match ? [{ level: match[1].length, title: match[2], line: index + 1 }] : [];
  });

  assert.equal(headings.filter(({ level }) => level === 1).length, 1, "README must have exactly one H1");
  assert.equal(headings[0]?.level, 1, "the first heading must be the project H1");
  for (let index = 1; index < headings.length; index += 1) {
    assert.ok(
      headings[index].level <= headings[index - 1].level + 1,
      `heading level jumps at line ${headings[index].line}: ${headings[index].title}`,
    );
  }
});

test("README presents prerequisites before executable quick-start steps", () => {
  const prerequisites = README.indexOf("## Prerequisites");
  const quickStart = README.indexOf("## Quick start");
  assert.ok(prerequisites > 0, "README must declare prerequisites");
  assert.ok(quickStart > prerequisites, "prerequisites must precede the quick start");
  const minimumNode = PACKAGE.engines.node.replace(/^>=/, "");
  assert.ok(README.includes(`Node.js ${minimumNode} or newer`), "README Node.js version must match package.json");
  assert.match(README, /node \.planning\/bin\/setup\.mjs/);
  assert.match(README, /node \.planning\/bin\/start-kiln\.mjs/);
  assert.ok(existsSync(resolve(ROOT, "bin/setup.mjs")), "documented setup entry point must exist");
  assert.ok(existsSync(resolve(ROOT, "bin/start-kiln.mjs")), "documented start entry point must exist");
  assert.doesNotMatch(README, /planning-agent roster has not been built|cannot do yet is hand the planning work/i);
});

test("README code fences identify their language", () => {
  let insideFence = false;
  for (const [index, line] of LINES.entries()) {
    if (!line.startsWith("```")) continue;
    if (insideFence) {
      assert.equal(line, "```", `closing fence at line ${index + 1} must not carry a language`);
      insideFence = false;
    } else {
      assert.match(line, /^```[a-z][a-z0-9-]*$/i, `opening fence at line ${index + 1} needs a language`);
      insideFence = true;
    }
  }
  assert.equal(insideFence, false, "README has an unclosed code fence");
});

test("README repository-relative links resolve", () => {
  const links = [...README.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
  const localLinks = links.filter((href) => !/^(?:[a-z]+:|#)/i.test(href));
  assert.ok(localLinks.length > 0, "README should route readers to repository documentation");

  for (const href of localLinks) {
    const path = decodeURIComponent(href.split("#", 1)[0]);
    assert.ok(existsSync(resolve(ROOT, path)), `README link does not resolve: ${href}`);
  }
});

test("README covers the reader's main navigation needs", () => {
  for (const section of [
    "Quick start",
    "Configuration",
    "Develop Kiln",
    "Test",
    "Architecture",
    "Troubleshooting",
    "Contributing and support",
    "Security",
    "License",
  ]) {
    assert.match(README, new RegExp(`^## ${section}$`, "m"), `missing README section: ${section}`);
  }
});
