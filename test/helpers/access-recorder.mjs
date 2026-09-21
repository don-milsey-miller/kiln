/**
 * Observe filesystem reads, credential-variable reads and network calls at Node's own boundary.
 *
 * ⚠️ **AT THE BUILT-IN MODULES, NOT AT KILN'S WRAPPERS.** Every function on `fs` and `fs.promises` is
 * wrapped and `syncBuiltinESMExports()` is called, so code that imported `readFileSync` by name —
 * Pi's bundle included — goes through the recorder too. `process.env` is replaced with a Proxy over a
 * controlled object, so the operator's real environment is neither read nor offered. `fetch`, `http`,
 * `https`, `net`, `tls` and `dns` are replaced with functions that record and throw.
 *
 * Only paths under `root`, paths whose file name is in `basenames` wherever they are, and names in
 * `names` are recorded, so Node's own activity is not noise.
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const pathOf = (arg) => {
  if (typeof arg === "string") return arg;
  if (arg instanceof URL) return fileURLToPath(arg);
  if (Buffer.isBuffer(arg)) return arg.toString();
  return null;
};

const normal = (p) => p.replace(/\\/g, "/").toLowerCase();

/**
 * @param {{root: string, names: Iterable<string>, env: Record<string,string>, basenames?: string[]}} options
 * @returns {{fs: string[], env: string[], net: string[], counts: () => {fs: number, env: number, net: number}, restore: () => void}}
 */
export function recordAccess({ root, names, env, basenames = [] }) {
  // path.basename, so both separators are handled on Windows without a hand-written pattern.
  const files = new Set(basenames.map((n) => n.toLowerCase()));
  const seen = { fs: [], env: [], net: [] };
  const rootKey = normal(root);
  const watched = new Set(names);
  const undo = [];

  const wrapAll = (target, label) => {
    for (const key of Object.keys(target)) {
      const original = target[key];
      if (typeof original !== "function" || /^[A-Z]/.test(key)) continue;
      target[key] = function (...args) {
        const p = pathOf(args[0]);
        if (p && (normal(p).startsWith(rootKey) || files.has(basename(p).toLowerCase()))) seen.fs.push(`${label}${key} ${p}`);
        return original.apply(this, args);
      };
      undo.push(() => { target[key] = original; });
    }
  };
  wrapAll(fs, "fs.");
  wrapAll(fs.promises, "fs.promises.");

  const refuse = (label) => function () {
    seen.net.push(label);
    throw new Error(`network access refused by the recorder: ${label}`);
  };
  for (const [mod, keys, label] of [
    [http, ["request", "get"], "http"],
    [https, ["request", "get"], "https"],
    [net, ["connect", "createConnection"], "net"],
    [tls, ["connect"], "tls"],
    [dns, ["lookup", "resolve"], "dns"],
  ])
    for (const key of keys) {
      const original = mod[key];
      mod[key] = refuse(`${label}.${key}`);
      undo.push(() => { mod[key] = original; });
    }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { seen.net.push(`fetch ${String(input)}`); throw new Error("network access refused by the recorder: fetch"); };
  undo.push(() => { globalThis.fetch = originalFetch; });

  syncBuiltinESMExports();

  const originalEnv = process.env;
  process.env = new Proxy(env, {
    get(target, key) {
      if (typeof key === "string" && watched.has(key)) seen.env.push(`get ${key}`);
      return Reflect.get(target, key);
    },
    has(target, key) {
      if (typeof key === "string" && watched.has(key)) seen.env.push(`has ${key}`);
      return Reflect.has(target, key);
    },
    getOwnPropertyDescriptor(target, key) {
      if (typeof key === "string" && watched.has(key)) seen.env.push(`descriptor ${key}`);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    ownKeys(target) {
      seen.env.push("enumerate");
      return Reflect.ownKeys(target);
    },
  });
  undo.push(() => { process.env = originalEnv; });

  return {
    ...seen,
    counts: () => ({ fs: seen.fs.length, env: seen.env.length, net: seen.net.length }),
    restore: () => {
      for (const u of undo.reverse()) u();
      syncBuiltinESMExports();
    },
  };
}
