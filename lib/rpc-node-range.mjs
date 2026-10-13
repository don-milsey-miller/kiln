/**
 * The Node releases on which a Windows `--rpc` session can crash as it exits - #218.
 *
 * Pi's RPC mode calls `process.exit()` as soon as it has disposed its runtime. On Windows, Node releases carrying
 * nodejs/node#56645 can then abort inside their own exit with a libuv assertion and status `0xC0000409`, after the
 * session's work is done. The launch is reported as a crash although nothing went wrong in it.
 *
 * ⚠️ **ONLY THESE RANGES, MEASURED AT EVERY BOUNDARY.** The defect arrived with V8 12.8 in Node 23.0.0 and was fixed
 * by nodejs/node#61999, released in 24.20.0 and 26.7.0. The 23.x and 25.x lines ended without it. So: all of 23.x,
 * 24.0 through 24.19, all of 25.x, and 26.0 through 26.6. Node 22 never had it. Stable 27 onward is
 * treated as safe and was not measured: no 27 release exists yet, and the fix is on the branch it will be cut from.
 *
 * ⚠️ **ONLY WINDOWS, AND ONLY `--rpc`.** Pi's interactive and print modes end differently and did not crash on the
 * same releases. Other platforms are not affected. A terminal or piped launch is never refused by this.
 *
 * ⚠️ **A PRERELEASE OF A FIRST FIXED RELEASE IS UNSAFE.** `24.20.0` and `26.7.0` were measured as the stable releases
 * that carry the fix. A `24.20.0-rc.1` or a `26.7.0-nightly` build is cut before its release and was not measured,
 * so it is not assumed to carry it. Anything later on the same line, prerelease or not, comes after the fix. The
 * same holds for `27.0.0`: its prereleases began before the fix reached Node's main branch, so only the stable
 * release and what follows it are treated as safe.
 *
 * ⚠️ **THE WHOLE STRING IS A VERSION OR IT IS NOT READ.** `major.minor.patch`, then an optional prerelease and
 * optional build metadata, and nothing else. Text that merely begins like a version is unreadable, and an unreadable
 * version is not called unsafe.
 *
 * ⚠️ **NO OVERRIDE.** A way to launch anyway would make the crashing path a supported one. Node 23 and 25 have no
 * safe release at all. Safe releases are available on other maintained lines: 22, 24 and 26.
 */

/** The stable code the refusal is known by. */
export const RPC_NODE_REFUSED = "node-version-unsafe-for-rpc";

/**
 * `[major, first safe minor]` for a line that was fixed part-way, or `[major, null]` for one that never was. Minors
 * below the first safe one are unsafe, and so is a prerelease of `major.<first safe minor>.0`. For 27 the first safe
 * minor is 0, so no stable release is unsafe and only the prereleases of `27.0.0` are.
 */
const UNSAFE = Object.freeze([
  [23, null],
  [24, 20],
  [25, null],
  [26, 7],
  [27, 0],
]);

const IDENTIFIERS = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
/** The whole of a version: `major.minor.patch`, an optional `-prerelease`, an optional `+build`. */
const VERSION = new RegExp(`^v?(\\d+)\\.(\\d+)\\.(\\d+)(-${IDENTIFIERS})?(\\+${IDENTIFIERS})?$`);

/**
 * Whether a Node version is one of the releases above. A version this cannot read is not called unsafe.
 *
 * @param {string} version  as `process.versions.node` gives it, with or without a leading `v`
 */
export function nodeUnsafeForRpc(version) {
  const match = VERSION.exec(typeof version === "string" ? version : "");
  if (!match) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const prerelease = match[4] !== undefined;
  return UNSAFE.some(([unsafeMajor, firstSafeMinor]) => {
    if (major !== unsafeMajor) return false;
    if (firstSafeMinor === null || minor < firstSafeMinor) return true;
    // A prerelease of the first fixed release itself, `x.<firstSafeMinor>.0-anything`, precedes that release.
    return minor === firstSafeMinor && patch === 0 && prerelease;
  });
}

/**
 * The refusal for this launch, or `null` when it may proceed.
 *
 * @param {{rpc: boolean, platform?: string, nodeVersion?: string}} launch
 * @returns {null | {code: string, message: string}}
 */
export function rpcNodeRefusal({ rpc, platform = process.platform, nodeVersion = process.versions.node } = {}) {
  if (rpc !== true || platform !== "win32" || !nodeUnsafeForRpc(nodeVersion)) return null;
  return Object.freeze({
    code: RPC_NODE_REFUSED,
    message:
      `Node ${nodeVersion} on Windows can crash when a --rpc session exits after completing work (${RPC_NODE_REFUSED}; nodejs/node#56645). ` +
      `Use Node 22.19.0 or newer 22.x, Node 24.20.0 or newer 24.x, Node 26.7.0 or newer 26.x, or stable Node 27+. Nothing was started.`,
  });
}
