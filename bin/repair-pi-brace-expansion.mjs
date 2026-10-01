#!/usr/bin/env node
/** Keep Pi's published shrinkwrap from reinstalling a vulnerable brace-expansion release. */

import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PATCHED_BRACE_EXPANSION = "5.0.12";
const LOCK_ENTRY = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function installedPiBraceExpansion(root) {
  const manifest = join(root, LOCK_ENTRY, "package.json");
  if (!existsSync(manifest)) return null;
  return readJson(manifest).version ?? null;
}

function repairLockfile(root, sourceEntry) {
  const path = join(root, "package-lock.json");
  if (!existsSync(path)) return;
  const lock = readJson(path);
  const entry = lock.packages?.[LOCK_ENTRY];
  if (!entry) throw new Error(`package-lock.json has no ${LOCK_ENTRY} entry.`);
  const source = lock.packages?.["node_modules/brace-expansion"] ?? sourceEntry;
  lock.packages[LOCK_ENTRY] = {
    ...entry,
    version: PATCHED_BRACE_EXPANSION,
    resolved: source.resolved,
    integrity: source.integrity,
  };
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
}

export function repairPiBraceExpansion(root, { check = false } = {}) {
  const current = installedPiBraceExpansion(root);
  if (check) {
    if (current !== PATCHED_BRACE_EXPANSION)
      throw new Error(`Pi has brace-expansion ${current ?? "missing"}; expected ${PATCHED_BRACE_EXPANSION}. Run npm install.`);
    return { repaired: false, version: current };
  }

  const source = join(root, "node_modules", "brace-expansion");
  const target = join(root, LOCK_ENTRY);
  const sourceManifest = join(source, "package.json");
  if (!existsSync(sourceManifest))
    throw new Error(`The root brace-expansion ${PATCHED_BRACE_EXPANSION} package is missing.`);
  const sourceEntry = readJson(sourceManifest);
  if (sourceEntry.version !== PATCHED_BRACE_EXPANSION)
    throw new Error(`The root brace-expansion package is ${sourceEntry.version}; expected ${PATCHED_BRACE_EXPANSION}.`);

  if (current !== PATCHED_BRACE_EXPANSION) {
    const temporary = `${target}.kiln-${process.pid}`;
    rmSync(temporary, { recursive: true, force: true });
    cpSync(source, temporary, { recursive: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(temporary, target);
  }
  repairLockfile(root, sourceEntry);
  return { repaired: current !== PATCHED_BRACE_EXPANSION, version: PATCHED_BRACE_EXPANSION };
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invoked) {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const result = repairPiBraceExpansion(root, { check: process.argv.includes("--check") });
    process.stdout.write(`[pi-dependency] brace-expansion ${result.version}${result.repaired ? " repaired" : " verified"}.\n`);
  } catch (error) {
    process.stderr.write(`[pi-dependency] ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
