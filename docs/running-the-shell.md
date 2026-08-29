# Running the shell

One command, from a clone with Node present:

```
npm start
```

That is `node bin/start-shell.mjs`. It installs dependencies if they are missing or older than
`package-lock.json`, builds the application for production, starts it, and prints where it is
listening and which planning content it is reading.

```
[vpw] dependencies present; skipping install
[vpw] building (production)…
[vpw] planning content root: D:\visual-project-workflow\planning-content
[vpw] starting on http://127.0.0.1:3000
[vpw] run directory: C:\Users\…\Temp\vpw-launch-a1b2c3
[vpw] ready — http://127.0.0.1:3000
```

Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop it.

## What it reads, and how you know

The content root is **printed at startup and always absolute**. The application falls back to the
running project's own `planning-content/`, so an operator who never sets anything still gets a
correct answer — and would otherwise have no way to know *which* answer. Point it elsewhere with:

```
PLANNING_CONTENT_DIR=/path/to/planning-content npm start
```

A path that does not exist is a refusal with exit code 2, not a fallback. That is the same rule the
CLI follows: resolving against some other project's content while reporting success is worse than
not starting.

## Options

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Loopback port. The host is always `127.0.0.1`. |
| `PLANNING_CONTENT_DIR` | the project's own `planning-content/` | Which content to read. Resolved to an absolute path and printed. |
| `VPW_SHUTDOWN_GRACE_MS` | `8000` | How long the child gets to exit before it is killed. |

## Production mode only

`next build` then `next start`, per DEC-0018. The development server is a contributor workflow and
is not a shipped configuration: AST-0015 measured the two producing different artifacts, so shipping
`next dev` would mean shipping something this project can never validate.

## What stopping it guarantees

The launcher owns **one** child — the `next start` process. On stop it asks the child to exit, waits
up to `VPW_SHUTDOWN_GRACE_MS`, escalates if it has not gone, removes its own run directory, and then
exits itself.

The file watcher is **not** a second process. It is chokidar, created inside the application process
by the change-stream service on the first `/events` subscription and closed when the last subscriber
leaves. Terminating the application process releases any watcher still open, through process
teardown. An earlier version of this contract said the launcher "owns both the application process
and the file watcher" and terminates the watcher with the application; that described a call across
a process boundary that cannot be made without IPC or a shutdown endpoint, and it is corrected in
DEC-0022.

### Stopping it from another program

<kbd>Ctrl</kbd>+<kbd>C</kbd> is the operator's path and works everywhere. A supervising process
should instead **write `stop` to the launcher's stdin, or close it** — on Windows
`process.kill(pid, "SIGTERM")` is `TerminateProcess`, a hard kill that no handler sees, so the
graceful path would never run and the run directory would be left behind. That is measured, not
assumed: the first version of the cleanup test did exactly that and watched two directories survive.
