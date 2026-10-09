/**
 * What a production build recorded in its `.nft.json` traces, read from the manifests themselves (#186).
 *
 * ⚠️ **THE MANIFESTS ARE THE EVIDENCE.** The build printing no warning proves nothing: `d2ff706` printed none and its
 * ingest route traced 1,218 files, the clone's `.git` and `planning-content` among them. Nor does a `turbopackIgnore`
 * comment in the source. So nothing here reads the build's output or the source. It reads every manifest under
 * `.next`, resolves every entry to the file it names, and judges that file.
 *
 * ⚠️ **EVERY ENTRY IS RESOLVED CANONICALLY BEFORE IT IS JUDGED.** An entry is a path relative to its manifest, and a
 * link or junction inside an allowed directory can name a file anywhere. `realpathSync.native` follows them, so the
 * rule is applied to where the file is and not to how the entry is spelled.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The only places inside the tool root a trace may name, each with the reason it is there. Everything Kiln reads at
 * run time from its own checkout (`schemas/`, `stages/`, `package.json`) is read from disk by `next start`, whose
 * working directory is the checkout. None of it has to be in a trace, so none of it is allowed in one.
 */
export const TRACE_ALLOWLIST = Object.freeze([
  { root: ".next/server/", why: "the build's own compiled server output" },
  { root: "node_modules/next/", why: "the framework's server runtime" },
  { root: "node_modules/@next/env/", why: "next's environment loader" },
  { root: "node_modules/react/", why: "the rendering runtime" },
  { root: "node_modules/react-dom/", why: "the rendering runtime" },
  { root: "node_modules/@swc/helpers/", why: "helpers the compiled output imports" },
  { root: "node_modules/styled-jsx/", why: "required by next's server runtime" },
  { root: "node_modules/client-only/", why: "required by next's server runtime" },
  { root: "node_modules/semver/", why: "required by next's image optimiser through sharp" },
  { root: "node_modules/sharp/", why: "next's image optimiser" },
  { root: "node_modules/@img/", why: "sharp's platform-specific binaries" },
  { root: "node_modules/detect-libc/", why: "required by sharp" },
  // Measured in CI on Windows with Node 22: npm installs `@img/sharp-wasm32` there, and `next-server.js.nft.json`
  // names four files of this, its one dependency. Node 24 on Windows and on Linux installed neither.
  { root: "node_modules/@emnapi/runtime/", why: "required by sharp's WebAssembly build, which npm installs on Node 22" },
  { root: "node_modules/readdirp/", why: "the change stream's directory watcher" },
]);

/**
 * Ceilings over every manifest together, counting each resolved file once.
 *
 * Measured on a clean consumer clone, Windows, Node 24.18.0, Next 16.3.8: 973 files and 17,328,277 bytes with the
 * fix, 2,093 files and 33,420,130 bytes on `d2ff706` without it. The ceilings sit between the two, so the defect
 * fails both and an ordinary dependency update does not.
 *
 * ⚠️ **SHARP'S PLATFORM BINARIES ARE COUNTED APART, UNDER THEIR OWN CEILING.** The fixed build on Linux measured
 * 977 files and 36,009,834 bytes, 18,681,842 more than Windows, and `@img/sharp-libvips-linux-x64` is 18,711,101
 * bytes unpacked. One byte ceiling high enough for that would pass the defect on Windows. So `bytes` covers
 * everything outside `node_modules/@img/` and is the same on every platform, and `platformBytes` covers what is
 * inside it. Measured there: 492,150 bytes on Windows with Node 24, 9,804,007 on Windows with Node 22, where
 * sharp's WebAssembly build is installed as well, and 19,173,969 on Linux.
 *
 * Both are a second control: the allowlist is what rejects a file that should not be there, however small.
 */
export const PLATFORM_BINARY_ROOT = "node_modules/@img/";
export const TRACE_CEILINGS = Object.freeze({ files: 1250, bytes: 24 * 1024 * 1024, platformBytes: 22 * 1024 * 1024 });

function manifestsUnder(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) manifestsUnder(path, out);
    else if (entry.name.endsWith(".nft.json")) out.push(path);
  }
  return out;
}

/** True when `target` is `root` or lies under it. Both are canonical already. */
function inside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * @param {string} toolRoot  the Kiln checkout whose `.next` is inspected
 * @param {{allowlist?: ReadonlyArray<{root: string}>, ceilings?: {files: number, bytes: number, platformBytes: number}}} [opts]
 * @returns {{manifests: number, files: number, bytes: number, platformBytes: number, resolved: string[],
 *            violations: Array<{manifest: string, entry: string, resolved: string, reason: string}>, ceilings: string[]}}
 */
export function inspectBuildTraces(toolRoot, { allowlist = TRACE_ALLOWLIST, ceilings = TRACE_CEILINGS } = {}) {
  const root = realpathSync.native(toolRoot);
  const dist = join(root, ".next");
  const manifests = existsSync(dist) ? manifestsUnder(dist).sort() : [];
  const sizes = new Map();
  const violations = [];
  for (const manifest of manifests) {
    const name = relative(root, manifest).split(sep).join("/");
    for (const entry of JSON.parse(readFileSync(manifest, "utf8")).files ?? []) {
      const written = resolve(dirname(manifest), entry);
      let resolved;
      try {
        resolved = realpathSync.native(written);
      } catch (error) {
        violations.push({ manifest: name, entry, resolved: written, reason: `cannot be resolved (${error.code ?? error.message})` });
        continue;
      }
      const stat = statSync(resolved);
      // ⚠️ ONLY A REGULAR FILE IS ACCEPTED. A directory entry stands for everything in it and has no size of its
      // own, so one inside an allowed root would pass the allowlist and slip under the byte ceiling.
      if (!stat.isFile()) {
        violations.push({ manifest: name, entry, resolved, reason: `is not a regular file (${stat.isDirectory() ? "a directory" : "another kind of entry"})` });
        continue;
      }
      sizes.set(resolved, stat.size);
      if (!inside(root, resolved)) {
        violations.push({ manifest: name, entry, resolved, reason: "is outside the Kiln tool root" });
        continue;
      }
      const rel = relative(root, resolved).split(sep).join("/");
      if (!allowlist.some(({ root: allowed }) => rel.startsWith(allowed)))
        violations.push({ manifest: name, entry, resolved, reason: `is not under an allowed runtime root (${rel})` });
    }
  }
  let bytes = 0;
  let platformBytes = 0;
  for (const [file, size] of sizes) {
    if (inside(root, file) && relative(root, file).split(sep).join("/").startsWith(PLATFORM_BINARY_ROOT)) platformBytes += size;
    else bytes += size;
  }
  const over = [];
  if (sizes.size > ceilings.files) over.push(`${sizes.size} traced files, over the ceiling of ${ceilings.files}`);
  if (bytes > ceilings.bytes) over.push(`${bytes} traced bytes, over the ceiling of ${ceilings.bytes}`);
  if (platformBytes > ceilings.platformBytes) over.push(`${platformBytes} traced bytes of platform binaries, over the ceiling of ${ceilings.platformBytes}`);
  return { manifests: manifests.length, files: sizes.size, bytes, platformBytes, resolved: [...sizes.keys()].sort(), violations, ceilings: over };
}

/** The failure text: each offending trace with the files it resolved to, then any ceiling exceeded. */
export function describeTraceFailures(report, limit = 40) {
  const byManifest = new Map();
  for (const v of report.violations) byManifest.set(v.manifest, [...(byManifest.get(v.manifest) ?? []), v]);
  const lines = [];
  for (const [manifest, list] of byManifest) {
    lines.push(`${manifest}: ${list.length} offending entr${list.length === 1 ? "y" : "ies"}`);
    for (const v of list.slice(0, limit)) lines.push(`  ${v.resolved} ${v.reason}`);
    if (list.length > limit) lines.push(`  ... and ${list.length - limit} more`);
  }
  lines.push(...report.ceilings);
  lines.push(`${report.manifests} manifests, ${report.files} files, ${report.bytes} bytes, ${report.platformBytes} bytes of platform binaries`);
  return lines.join("\n");
}
