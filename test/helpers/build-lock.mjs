/**
 * Exclusive use of the project's `.next` directory, across test files.
 *
 * ⚠️ IT GUARDS THE WHOLE RUN, NOT JUST THE BUILD, AND THE SECOND VERSION IS WHY. Holding it around
 * the build alone looked like the frugal choice — a server run and a stream read have no reason to
 * wait for each other — and it failed immediately: `shell-smoke` deletes `.next` before rebuilding,
 * and it deleted it out from under the launcher's already-running server. The shared resource was
 * never the build step; it is the build DIRECTORY, for as long as anything is serving from it.
 *
 * ⚠️ `node --test` RUNS FILES IN PARALLEL, which is what surfaced this. First as
 * `Another next build process is already running`, then — after the narrow fix — as a server dying
 * mid-request. Both are the same collision seen from different ends.
 *
 * ⚠️ It reuses `lib/lock.mjs` rather than inventing a second locking scheme, for the reason #47
 * gives everywhere else: one implementation, so nobody's second copy drifts. `maxWaitMs` is
 * generous because the thing being waited for is a production build.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { withLock } from "../../lib/lock.mjs";

const BUILD_LOCK = join(tmpdir(), "vpw-next-build.lock");

/** Run `fn` with exclusive use of `.next`. */
export const withBuildLock = (fn) => withLock(BUILD_LOCK, fn, { maxWaitMs: 15 * 60_000, staleMs: 20 * 60_000 });
