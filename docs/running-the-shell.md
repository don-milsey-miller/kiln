# Running Kiln

For a consumer project, run the canonical launcher from the directory containing `.planning/`:

```
node .planning/bin/start-kiln.mjs
```

Guided setup offers this handoff when configuration is complete. The lower-level browser-only shell
command below remains useful for inspection and contributor work.

## Structured mode for integrations

By default the launcher gives a terminal Pi's interactive display. A program that drives Kiln, such as an
automation harness or another tool reading the session, should not read that display: an interactive
terminal repaints as it works, so its output is much larger than what was actually said. Start the same
launcher with `--rpc` instead:

```
node .planning/bin/start-kiln.mjs --rpc
```

- Standard input and standard output carry Pi's own RPC protocol: one JSON command per line in, one JSON
  event per line out, with no terminal rendering. Kiln adds the flag and nothing else; it does not
  translate events or provide a client. Send a `prompt` command with `/kiln-start` to begin a new
  session, and close standard input to end the run.
- Kiln's own `[kiln]` notices and the browser launcher's output go to standard error, so every line of
  standard output is one JSON event.
- A confirmation arrives as one `extension_ui_request` event and takes one `extension_ui_response`. Kiln
  still expires it after five minutes.
- Terminal shortcuts are unavailable: there is no Ctrl+C stop and no voice shortcut. Use the protocol's
  `abort` command to interrupt a turn.
- Nothing is asked on the terminal. A launch that would need an answer, such as a missing consent, refuses
  instead.

RPC is not guaranteed to emit fewer bytes. It provides structured, replay-free events so integrations
can select what they consume.

The mode is selected only by the flag. A pseudo-terminal without `--rpc` still gets the interactive
display, because a terminal is also how a person uses Kiln.

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
