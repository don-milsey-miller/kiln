/**
 * The one-time file that tells Kiln's guard inside Pi which session Pi must have opened — ACC-0103, F128.
 *
 * ⚠️ **WHY A FILE, AND WHY ONLY ITS PATH IS IN THE ENVIRONMENT.** The guard needs the session id, the transcript's
 * canonical path and its digest. Passed as environment values they were inherited by every process Pi started,
 * which the H2 probe measured, and on Linux the starting environment stays readable through `/proc` after being
 * deleted. So the supervisor writes them to a file only it and the guard touch, passes the file's PATH, and the
 * guard removes the variable, reads the file and deletes it before Pi has started anything.
 *
 * ⚠️ **EXCLUSIVE, OWNER-ONLY AND NEVER FOLLOWED THROUGH A LINK.** Created with O_EXCL, so an existing file or link
 * at the name is a refusal rather than a file to write through; mode 0600 where the platform honours modes; opened
 * for reading with O_NOFOLLOW where it exists, and compared by device and inode with what `lstat` saw, so a link
 * swapped in between is noticed. On Windows the mode bits are not an access control: the file inherits the
 * runtime directory's ACL, which is the operator's own project state.
 *
 * ⚠️ **REMOVED ON EVERY PATH, AND ONLY IF IT IS STILL THE FILE KILN WROTE.** The guard deletes it after reading;
 * the supervisor's `remove()` runs on success, refusal, spawn failure and child exit, and is idempotent. It
 * deletes nothing that has since been replaced by something else at the same name.
 */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** The one environment variable the guard reads, and removes. */
export const GUARD_ENV = "KILN_SESSION_GUARD";
export const GUARD_VERSION = 1;
/** Large enough for an id, a path and a digest; anything bigger is not a guard file. */
const MAX_GUARD_BYTES = 16 * 1024;

export const GUARD_PROBLEM = Object.freeze({
  NO_RUNTIME_DIR: "the runtime directory is not a real directory",
  EXISTS: "a file already exists where the guard file belongs",
  WRITE_FAILED: "the guard file could not be written",
  NOT_NAMED: "no guard file was named",
  NOT_A_FILE: "the guard file is not a regular file",
  CHANGED: "the guard file changed while it was being read",
  UNREADABLE: "the guard file could not be read",
  INVALID: "the guard file does not hold a valid expectation",
});

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

/**
 * Write the expectation for one launch. Returns `{ok, path, remove}` or `{ok: false, problem}`.
 *
 * @param {{runtimeDir: string, expected: {sessionId: string, file: string, digest: string},
 *          randomBytes: (n: number) => Buffer}} opts
 */
export function createGuardFile({ runtimeDir, expected, randomBytes }) {
  try {
    const dir = lstatSync(runtimeDir);
    if (!dir.isDirectory() || dir.isSymbolicLink()) return { ok: false, problem: GUARD_PROBLEM.NO_RUNTIME_DIR };
  } catch {
    return { ok: false, problem: GUARD_PROBLEM.NO_RUNTIME_DIR };
  }

  const path = join(runtimeDir, `session-guard-${randomBytes(16).toString("hex")}.json`);
  const body = Buffer.from(
    JSON.stringify({ guardVersion: GUARD_VERSION, sessionId: expected.sessionId, file: expected.file, digest: expected.digest }),
    "utf-8"
  );
  let fd;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
  } catch (e) {
    return { ok: false, problem: e?.code === "EEXIST" ? GUARD_PROBLEM.EXISTS : GUARD_PROBLEM.WRITE_FAILED, code: e?.code ?? "unknown" };
  }

  let identity;
  try {
    writeSync(fd, body);
    fsyncSync(fd);
    identity = fstatSync(fd);
  } catch (e) {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {}
    return { ok: false, problem: GUARD_PROBLEM.WRITE_FAILED, code: e?.code ?? "unknown" };
  }
  closeSync(fd);

  let removed = false;
  /** Idempotent. Deletes the file only while it is still the one written here. */
  const remove = () => {
    if (removed) return "already-removed";
    let now;
    try {
      now = lstatSync(path);
    } catch (e) {
      if (e?.code === "ENOENT") {
        removed = true;
        return "absent";
      }
      return "unreadable";
    }
    // ⚠️ **DEVICE AND INODE ARE NOT ENOUGH: LINUX REUSES AN INODE AT ONCE.** Measured in CI: a file created at
    // the same name right after the guard file was deleted received the same inode, and cleanup deleted it. So
    // the size and the bytes must also still be exactly what was written here.
    if (now.isSymbolicLink() || !sameFile(now, identity) || now.size !== body.length) return "replaced";
    try {
      if (!readFileSync(path).equals(body)) return "replaced";
    } catch (e) {
      if (e?.code === "ENOENT") {
        removed = true;
        return "absent";
      }
      return "unreadable";
    }
    try {
      unlinkSync(path);
      removed = true;
      return "removed";
    } catch (e) {
      if (e?.code === "ENOENT") {
        removed = true;
        return "absent";
      }
      return "failed";
    }
  };
  return { ok: true, path, remove };
}

/**
 * Inside Pi: take the expectation, once. The variable is removed first, the file is read without following a
 * link, deleted, and only then parsed, so every outcome leaves neither behind.
 *
 * @returns {{ok: true, expected: {sessionId: string, file: string, digest: string}} | {ok: false, problem: string}}
 */
export function takeGuardFile(env = process.env) {
  const path = env[GUARD_ENV];
  delete env[GUARD_ENV];
  if (typeof path !== "string" || path.length === 0) return { ok: false, problem: GUARD_PROBLEM.NOT_NAMED };

  let seen;
  try {
    seen = lstatSync(path);
  } catch {
    return { ok: false, problem: GUARD_PROBLEM.UNREADABLE };
  }
  if (seen.isSymbolicLink() || !seen.isFile()) return { ok: false, problem: GUARD_PROBLEM.NOT_A_FILE };

  let text;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    const opened = fstatSync(fd);
    if (!sameFile(opened, seen) || opened.size > MAX_GUARD_BYTES) {
      closeSync(fd);
      return { ok: false, problem: GUARD_PROBLEM.CHANGED };
    }
    const buf = Buffer.alloc(opened.size);
    let at = 0;
    while (at < buf.length) {
      const n = readSync(fd, buf, at, buf.length - at, at);
      if (n === 0) break;
      at += n;
    }
    closeSync(fd);
    fd = undefined;
    text = buf.subarray(0, at).toString("utf-8");
  } catch {
    if (fd !== undefined) closeSync(fd);
    return { ok: false, problem: GUARD_PROBLEM.UNREADABLE };
  } finally {
    // Deleted whether or not it read cleanly, and only while it is still the file that was examined.
    try {
      const now = lstatSync(path);
      if (!now.isSymbolicLink() && sameFile(now, seen)) unlinkSync(path);
    } catch {}
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, problem: GUARD_PROBLEM.INVALID };
  }
  const str = (v) => typeof v === "string" && v.length > 0;
  if (doc?.guardVersion !== GUARD_VERSION || !str(doc.sessionId) || !str(doc.file) || !/^[0-9a-f]{64}$/.test(doc.digest ?? ""))
    return { ok: false, problem: GUARD_PROBLEM.INVALID };
  return { ok: true, expected: { sessionId: doc.sessionId, file: doc.file, digest: doc.digest } };
}
