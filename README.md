# Kiln

Kiln is a local planning workspace for turning an early project idea into a plan that can survive
implementation. It keeps requirements, decisions, evidence, tasks, and stage approvals in structured
files, then presents the same material through a browser-based workspace.

The repository also plans itself. The content in `planning-content/` is Kiln's own project history,
and `docs/plan/` is the handoff package generated from it. That makes this checkout both the tool and
a working example of its output.

## Project status

Kiln is pre-1.0 (`0.0.0`). The application, schemas, validation rules, research tools, and handoff
publisher are implemented and tested. Two pieces of the intended product are still missing:

- There is no command to scaffold a fresh project's `planning-content/` directory.
- The packaged planning-agent roster has not been built yet. The specialist contracts in
  `lib/specialists/` are present, but they are not a runnable agent package.

You can run and develop Kiln today, inspect its own completed plan, and point it at another valid
Kiln content directory. Starting a brand-new planning workspace is still a manual process.

## Requirements

- Git
- Node.js 22 or newer (Node 22 and 24 are tested in CI)
- npm, which is included with Node.js

Kiln runs locally and does not need a database or hosted service. Research is optional and may
require credentials for the configured search provider.

## Initialize a local checkout

Clone the repository and install the locked dependency versions:

```sh
git clone https://github.com/don-milsey-miller/kiln.git
cd kiln
npm ci
```

Run the test suite once to confirm the checkout works on your machine:

```sh
npm test
```

Then start Kiln:

```sh
npm start
```

Open <http://127.0.0.1:3000>. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> in the terminal to stop the server.

`npm start` builds and runs the production application. If `node_modules/` is missing or older than
`package-lock.json`, it installs dependencies first, so this shorter first-run sequence also works:

```sh
git clone https://github.com/don-milsey-miller/kiln.git
cd kiln
npm start
```

The launcher prints the absolute path of the planning content it opened. In a normal checkout it
opens this repository's `planning-content/` directory.

## Open a different planning workspace

Set `PLANNING_CONTENT_DIR` to an existing Kiln content directory before starting the app. The path
must exist; Kiln will stop with an error instead of silently opening different content.

PowerShell:

```powershell
$env:PLANNING_CONTENT_DIR = "C:\path\to\your-project\planning-content"
npm start
```

macOS or Linux:

```sh
PLANNING_CONTENT_DIR=/path/to/your-project/planning-content npm start
```

The intended layout for a consuming project is:

```text
your-project/
├── .planning/          # a clone of this repository; ignored by your project
└── planning-content/   # your project's files; committed to your project
```

This keeps tool updates separate from project documents. Update the tool with `git pull` inside
`.planning/`; commit `planning-content/` in the containing project. Until the scaffold command is
implemented, Kiln does not create a valid empty `planning-content/` tree for you.

For launcher options and shutdown behavior, see
[`docs/running-the-shell.md`](docs/running-the-shell.md).

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm start` | Install if needed, build the production app, and start it on loopback. |
| `npm test` | Run the full Node.js test suite. |
| `npm run shell:build` | Build the Next.js application without starting it. |
| `npm run lint:shell` | Check the boundary between the application and the planning engine. |
| `npm run lint:plan` | Validate the content selected by `PLANNING_CONTENT_DIR`. |
| `npm run handoff` | Publish a handoff package after all required gates pass. |
| `npm run research:probe` | Check whether the optional research backend is available. |
| `npm run research:search -- "question"` | Search for candidate sources without changing project files. |
| `npm run migrate:content` | Preview a content-schema migration; add `-- --apply` to write it. |
| `npm run dev` | Run the older standalone watcher prototype, not the main application. |

When working with this repository's own plan, set the content path explicitly for commands that use
the shared content resolver:

PowerShell:

```powershell
$env:PLANNING_CONTENT_DIR = (Resolve-Path .\planning-content).Path
npm run lint:plan
```

macOS or Linux:

```sh
PLANNING_CONTENT_DIR="$PWD/planning-content" npm run lint:plan
```

## Repository layout

| Path | Contents |
| --- | --- |
| `app/` | Next.js application and its server-side adapters. |
| `bin/` | Command-line entry points. |
| `lib/` | Validation, stage gates, research, locking, migrations, and handoff logic. |
| `schemas/` | JSON schemas for planning artifacts. |
| `stages/` | Definitions for the nine planning stages. |
| `planning-content/` | Kiln's own planning data and stage documents. |
| `docs/plan/` | Generated handoff package for Kiln itself. |
| `references/` | Project research and the original decision record. |
| `test/` | Automated tests. |

The application imports planning behavior through `app/server/`; it does not reach directly into
`lib/`. Structured files under `planning-content/data/` are the source of truth, while stage pages
and handoff documents are readable views of that data.

## License

Kiln is available under the [MIT License](LICENSE). Your own `planning-content/` files remain your
work.
