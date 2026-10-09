import { createReadStream, lstatSync } from "node:fs";
import { basename } from "../runtime-path.mjs";

import { canonicalPath, isAtOrInside } from "../content-root.mjs";
import { ingestPaths } from "./store.mjs";

async function defaultWatcherFactory(path, options) {
  const { default: chokidar } = await import("chokidar");
  return chokidar.watch(path, options);
}

export async function createInboxWatcher(service, opts = {}) {
  if (!service || typeof service.enqueue !== "function") throw new TypeError("An ingestion service is required.");
  const paths = ingestPaths({ contentRoot: opts.contentRoot });
  const inboxRoot = canonicalPath(paths.inbox);
  const createWatcher = opts.createWatcher ?? defaultWatcherFactory;
  const onResult = opts.onResult ?? (() => {});
  const watcher = await createWatcher(paths.inbox, {
    ignoreInitial: opts.ignoreInitial ?? true,
    persistent: true,
    followSymlinks: false,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: opts.stabilityThresholdMs ?? 1500,
      pollInterval: opts.pollIntervalMs ?? 100,
    },
  });

  watcher.on("add", async (path) => {
    try {
      const canonical = canonicalPath(path);
      const stat = lstatSync(path);
      if (!isAtOrInside(canonical, inboxRoot) || stat.isSymbolicLink() || !stat.isFile()) return;
      const result = await service.enqueue({
        source: createReadStream(path),
        filename: basename(path),
        relationship: opts.relationship ?? "project-manager-input",
        origin: "inbox",
      });
      onResult({ ok: true, path: basename(path), result });
    } catch (error) {
      onResult({ ok: false, path: basename(path), code: error?.code ?? "processing-failed" });
    }
  });
  return watcher;
}
