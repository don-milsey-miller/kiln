# Kiln

Kiln is a local planning workspace for turning an early project idea into a plan that can survive
implementation. It keeps requirements, decisions, evidence, tasks, and stage approvals in structured
files, then presents the same material through a browser-based workspace.

The repository also plans itself. The content in `planning-content/` is Kiln's own project history,
and `docs/plan/` is the handoff package generated from it. That makes this checkout both the tool and
a working example of its output.

## Project status

Kiln is pre-1.0 (`0.0.0`). The application, schemas, validation rules, research tools, project
initializer, and handoff publisher are implemented and tested. One piece of the intended product is
still missing:

- The packaged planning-agent roster has not been built yet. The specialist contracts in
  `lib/specialists/` are present, but they are not a runnable agent package.

You can start a new planning workspace, run and develop Kiln, and inspect its own completed plan.
What you cannot do yet is hand the planning work to a packaged agent roster.

## Start a new project

From an empty project directory:

```sh
git init
git clone https://github.com/don-milsey-miller/kiln.git .planning

node .planning/bin/init-project.mjs \
  --project-root . \
  --name "My Project" \
  --description "What this project is intended to accomplish"

npm --prefix .planning start
```

That creates your project's `planning-content/` directory beside the tool, adds `.planning/` to your
`.gitignore`, and opens the workspace at <http://127.0.0.1:3000>.

The initializer needs only Node's built-in modules, so it runs before Kiln's dependencies have been
installed. It creates structure and nothing else — no planning artifacts, no stage approvals, no
decisions — and it is safe to run again: a completed project is left untouched, and it will not
overwrite anything you have written.

For options, exit codes, what gets created, and how reruns and refusals behave, see
[`docs/initializing-a-project.md`](docs/initializing-a-project.md).

## Requirements

- Git
- Node.js 22 or newer (Node 22 and 24 are tested in CI)
- npm, which is included with Node.js

Kiln runs locally and does not need a database or hosted service. Research is optional and may
require credentials for the configured search provider.

## First-run assumptions and current boundaries

Kiln's current content initializer needs only Node's built-in modules. The planned Pi agent-delivery
setup described in [`docs/agent-delivery-technical-proposal.md`](docs/agent-delivery-technical-proposal.md)
has additional operating assumptions:

- **Internet connectivity is assumed.** A normal first run must be able to clone Kiln from GitHub,
  install its locked npm dependencies, complete any provider authentication that requires a network,
  and reach the selected cloud model service. Kiln does not currently promise an offline bootstrap,
  proxy-specific setup, private-registry support, or custom-certificate setup. Tavily remains optional.
- **Kiln itself is not version-pinned yet.** Before 1.0, the documented clone follows the repository's
  current default branch. This remains intentional until a complete end-to-end project has been run
  and the project manager is satisfied with the resulting project state. Kiln will then establish a
  pinned release/version workflow for new projects; until that point, tool updates may change behavior.
- **Local model servers are managed by the project manager.** When Pi uses llama.cpp, vLLM, Ollama,
  LM Studio, or another local inference engine, the project manager owns its installation, model
  files, configuration, startup, health, hardware resources, updates, and shutdown. Kiln may discover
  and validate the Pi configuration, but it does not provision or operate the server. Managed local
  inference is a possible later Kiln capability and is out of scope for the first agent-delivery
  implementation.
- **Model-provider usage may cost money.** The agent-delivery capability may be configured to use
  services such as OpenAI or other paid model providers. Intake turns and delegated specialist work
  can therefore consume billable tokens or provider quota. The project manager is responsible for the
  selected account, pricing plan, limits, and charges; Kiln must disclose a potentially billable live
  check before running one.

## Work on Kiln itself

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

Kiln finds a project's content at `.planning/../planning-content` — the sibling of the tool
directory. **This repository is its own consumer**, so its content is *inside* the checkout rather
than beside it, and the rule does not reach it. Development commands therefore name the content
directory explicitly.

PowerShell:

```powershell
$env:PLANNING_CONTENT_DIR = (Resolve-Path .\planning-content).Path
npm start
```

macOS or Linux:

```sh
PLANNING_CONTENT_DIR="$PWD/planning-content" npm start
```

Open <http://127.0.0.1:3000>. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> in the terminal to stop the server.

`npm start` builds and runs the production application, installing dependencies first if
`node_modules/` is missing or older than `package-lock.json`. It prints the absolute path of the
planning content it opened, and it refuses to start rather than guessing at one — running it here
without the variable set will tell you exactly this and exit.

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
`.planning/`; commit `planning-content/` in the containing project. In that layout Kiln finds the
content directory on its own — `PLANNING_CONTENT_DIR` is only needed to open a workspace that is not
the tool's sibling, such as this repository's own.

For launcher options and shutdown behavior, see
[`docs/running-the-shell.md`](docs/running-the-shell.md).

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run init:project -- --project-root <path> --name <name>` | Create a new project's `planning-content/`. |
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
