import { spawn as spawnPty } from "node-pty";

const cleanEnv = (env) => Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string"));

export function startPty(file, args = [], options = {}) {
  let output = "";
  let exit = null;
  const waiters = new Set();
  const terminal = spawnPty(process.execPath, [file, ...args], {
    name: process.platform === "win32" ? "xterm-256color" : "xterm-256color",
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    cwd: options.cwd ?? process.cwd(),
    env: cleanEnv({ ...process.env, ...(options.env ?? {}) }),
  });

  const settle = () => {
    for (const waiter of [...waiters]) {
      if (waiter.pattern.test(output)) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(output);
      }
    }
  };
  terminal.onData((chunk) => {
    output += chunk;
    settle();
  });
  const exited = new Promise((resolve) => {
    terminal.onExit((event) => {
      exit = event;
      settle();
      // node-pty's Windows ConPTY worker is disposed only by kill(), even after a clean child
      // exit. Dispose that drain worker directly so a successful PTY test does not keep Node alive
      // or spawn a late process-list helper against a console that has already closed.
      terminal._agent?._conoutSocketWorker?.dispose?.();
      resolve({ ...event, output });
    });
  });

  return Object.freeze({
    write: (text) => terminal.write(text),
    resize: (cols, rows = 24) => terminal.resize(cols, rows),
    kill: () => {
      try {
        if (exit) terminal.destroy();
        else terminal.kill();
      } catch {
        // A PTY that already exited is closed; cleanup is complete.
      }
    },
    output: () => output,
    exit: () => exit,
    exited: () => exited,
    waitFor(pattern, timeoutMs = 8_000) {
      const expression = pattern instanceof RegExp ? pattern : new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      if (expression.test(output)) return Promise.resolve(output);
      return new Promise((resolve, reject) => {
        const waiter = { pattern: expression, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`PTY did not render ${expression} within ${timeoutMs}ms.\n${output}`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
  });
}
