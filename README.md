# Kiln

Kiln is a local-first project-planning system that turns an early idea into a structured,
reviewable implementation handoff. It combines a Pi-powered planning agent with a browser workspace
and keeps requirements, decisions, evidence, tasks, and approvals in version-controlled files.

> **Current release:** `v26.9.0`, the first official Kiln release. Kiln uses calendar versions in
> `YY.M.N` form. Its setup, planning-agent package, browser workspace, validation, research, and
> handoff workflows are implemented and tested. Review release notes before updating an active
> project.

## Prerequisites

- Git.
- Node.js 22.19.0 or newer. CI tests Node.js 22 and 24.
- npm, which is included with Node.js.
- An interactive terminal for first-time trust and provider authentication.
- Internet access for cloning, dependency installation, and cloud-model authentication. A local
  model is also supported when you configure and operate its server through Pi.

Kiln runs on the local computer and needs no database or hosted application service. Using a cloud
model can consume paid tokens or provider quota; setup asks before running a live model check.

## Quick start

Run these commands from an empty project directory:

```sh
git init
git clone --branch v26.9.0 --depth 1 https://github.com/don-milsey-miller/kiln.git .planning
node .planning/bin/setup.mjs --name "My Project" --description "What this project should accomplish"
node .planning/bin/start-kiln.mjs
```

Setup installs the locked dependencies, creates `planning-content/`, protects Kiln's local state
from Git, registers the bundled Pi package, and guides you through trust, model, and optional web
research choices. It does not silently inspect provider credentials or send a model request.

When startup completes, Kiln prints a loopback URL such as <http://127.0.0.1:3000> and opens Pi in
the terminal. A new session begins with `/kiln-start`; answer its project question, then follow the
plan in the browser. Enter `/quit` in Pi to stop both processes. Run the same start command later to
resume the project.

Use `node .planning/bin/setup.mjs --help` to see every setup option and its refusal-safe exit code.
Rerunning completed setup with the same choices does not rewrite the project.

## What Kiln creates

The tool and the project's planning records remain separate:

```text
your-project/
├── .planning/          # Kiln itself; ignored by the project repository
├── planning-content/   # authored planning records; commit these
└── docs/plan/          # generated handoff package after all gates pass
```

`planning-content/` moves through nine gated stages, from intake through handoff. Structured JSON
files are the source of truth; stage documents and the browser are readable views of those records.
Kiln refuses invalid writes and does not infer approval from prose or unchecked boxes.

The repository is also its own working example: [`planning-content/`](planning-content/) contains
Kiln's project history, and [`docs/plan/`](docs/plan/) is its generated handoff package.

## Common tasks

### Resume the planning agent

From the containing project directory:

```sh
node .planning/bin/start-kiln.mjs
```

The launcher verifies the recorded model and project identity before starting the browser workspace
and Pi. It refuses instead of silently changing providers, models, or planning content.

### Open the browser without the agent

Use browser-only mode when you want to inspect the workspace without starting Pi:

```sh
npm --prefix .planning start
```

Open <http://127.0.0.1:3000>. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop it. This command is not a
substitute for `start-kiln.mjs` when you want the planning agent.

### Add source material

Activate the `source` artifact type for the project, then use **Add source material** in the browser
or copy a file into `.pi/ingest/inbox/`. Kiln retains raw bytes locally under `.pi/ingest/blobs/`
and commits a typed `SRC-*` record plus normalized Markdown to `planning-content/`. Repeated bytes
share one retained blob, while separate import actions remain separate source records.

Plain text is normalized locally. Audio transcription is optional and disabled unless both
`OPENAI_API_KEY` is present and `KILN_INGEST_REMOTE_PROCESSING` is exactly `allow`; an API key alone
does not authorize a remote upload. The default OpenAI adapter uses `gpt-transcribe` and refuses
audio larger than 25,000,000 bytes before making a request. Material marked as an external
reference remains external reference material—ingestion never converts its contents into approved
project intent.

### Update Kiln

Review the target release notes, then move the ignored tool clone to that immutable release tag. For
example, after a later `v26.9.1` release:

```sh
git -C .planning fetch --tags origin
git -C .planning checkout v26.9.1
```

The next setup or start checks the locked dependency tree. A release checkout is intentionally
detached at its tag; do not use `git pull` to turn it into an unreviewed moving target.

### Versioning and releases

Kiln uses Calendar Versioning in `YY.M.N` form:

- `YY` is the final two digits of the release year;
- `M` is the month number from `1` through `12`, without a leading zero; and
- `N` starts at `0` for the first release of the month and increments for each additional release
  that month.

For example, `26.9.0` is the first September 2026 release, followed by `26.9.1`; the first October
2026 release is `26.10.0`. Git tags add a `v` prefix, such as `v26.9.0`. Calendar components do not
express SemVer compatibility promises; release notes identify material or incompatible changes.
See the [versioning and release policy](docs/versioning.md) and [changelog](CHANGELOG.md).

### Publish the handoff

After every required stage attestation and executable-artifact review passes:

```sh
npm --prefix .planning run handoff
```

The command validates the plan and writes a deterministic package to `docs/plan/`. See the
[handoff contract](docs/handoff-contract.md) for gates, contents, and integrity rules.

## Configuration

Setup records non-secret project choices and machine-local approvals separately. Provider secrets
remain in Pi's authentication store or the host environment; do not place them in
`planning-content/`.

| Setting | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | No | `3000` | Loopback port for the browser workspace. The host remains `127.0.0.1`. |
| `PLANNING_CONTENT_DIR` | No | Sibling `planning-content/` | Opens an explicit existing content directory. Kiln prints the resolved absolute path and refuses a missing path. |
| `VPW_SHUTDOWN_GRACE_MS` | No | `8000` | Milliseconds the browser process may exit gracefully before termination escalates. |
| `TAVILY_API_KEY` | Only for Tavily research | — | Enables the optional public-web research adapter after the project and this computer approve research. Treat it as a secret. |
| `TYPESAFE_API_KEY` | Only for TypeSafe decisioning | — | Enables optional Jev routing and artifact comparison after the project and this computer explicitly opt in. Treat it as a secret. |
| `OPENAI_API_KEY` | Only for remote source processing | — | Authenticates optional OpenAI extraction providers. It has no effect unless remote processing is separately authorized. Treat it as a secret. |
| `KILN_INGEST_REMOTE_PROCESSING` | No | disabled | Set exactly to `allow` to authorize configured source bytes to be sent to a remote extraction provider. |
| `KILN_OPENAI_TRANSCRIPTION_MODEL` | No | `gpt-transcribe` | Overrides the OpenAI transcription model when remote processing is authorized. |

`setup.mjs` also accepts explicit non-interactive answers for automation, including `--trust`,
`--provider`, `--model`, `--thinking`, `--research`, and `--live-model-check`. Omitted decisions are
prompted in an interactive terminal or refused in `--non-interactive` mode; they are never guessed.

To open content that is not beside the tool clone, set `PLANNING_CONTENT_DIR` before starting. See
[Running the shell](docs/running-the-shell.md) for PowerShell and POSIX examples, launcher behavior,
and shutdown guarantees.

### Enable semantic decisioning

TypeSafe Jev can optionally classify a turn into a stage-permitted activity/tool family and compare a
proposed artifact with selected existing artifacts. It is advisory: Kiln still owns permissions, gates,
approvals, validation, and canonical state.

```sh
TYPESAFE_API_KEY="..." npm --prefix .planning run decisioning:configure -- \
  --project-root . --provider typesafe
```

See [Optional semantic decisioning with TypeSafe Jev](docs/decisioning.md) for consent, privacy, CLI,
fallback, and architecture details.

## Develop Kiln

Clone the repository and install exactly what the lockfile declares:

```sh
git clone https://github.com/don-milsey-miller/kiln.git
cd kiln
npm ci
```

Kiln's own planning content lives inside the checkout rather than beside it. Set its path explicitly
before running content-aware development commands.

PowerShell:

```powershell
$env:PLANNING_CONTENT_DIR = (Resolve-Path .\planning-content).Path
npm start
```

macOS or Linux:

```sh
PLANNING_CONTENT_DIR="$PWD/planning-content" npm start
```

This is the browser-only production build. Open <http://127.0.0.1:3000> and press
<kbd>Ctrl</kbd>+<kbd>C</kbd> to stop it.

## Test

Run the complete suite:

```sh
npm test
```

The full local command runs the same exhaustive CI groups and their files serially. This is intentional:
setup and clean-consumer journeys may install dependencies in isolated fixtures, and must not overlap
suites that are importing or inspecting the checkout's dependency tree, especially on Windows.

CI uses explicit, locally reproducible groups:

| Command | Contract |
| --- | --- |
| `npm run test:ci:core` | Deterministic planning, schema, state, and adapter behavior. |
| `npm run test:ci:node` | Node.js runtime, module-loading, and package integration. |
| `npm run test:ci:platform` | Process, terminal, filesystem, and shutdown behavior. |
| `npm run test:ci:setup` | Setup, recovery, state protection, and transactions. |
| `npm run test:ci:consumer` | Clean-project and production-shell journeys. |
| `npm run test:pi-compat` | Retained Pi compatibility evidence; CI enables its live tier. |

Additional validation commands include `npm run lint:shell`, `npm run lint:plan`,
`npm run audit:production`, `npm run skills:check`, `npm run authoring-schemas:check`, and
`npm run roles:check`. The [CI guide](docs/continuous-integration.md) explains why each group runs in
its selected operating systems and Node.js versions.

## Architecture

| Path | Responsibility |
| --- | --- |
| [`app/`](app/) | Next.js browser workspace and server-side adapters. |
| [`bin/`](bin/) | Setup, startup, validation, research, migration, and handoff commands. |
| [`lib/`](lib/) | Planning rules, gates, locking, runtime checks, and typed tools. |
| [`pi-package/`](pi-package/) | Bundled Pi extension, prompt, and planning-stage skills. |
| [`schemas/`](schemas/) | Machine-enforced planning and runtime record contracts. |
| [`stages/`](stages/) | Definitions and exit criteria for the nine planning stages. |
| [`specialists/`](specialists/) | Specialist roles used by delegated planning work. |
| [`test/`](test/) | Unit, integration, compatibility, and end-to-end tests. |

The application accesses planning behavior through `app/server/`; structured content remains behind
that boundary. For design details, read the [agent-delivery technical proposal](docs/agent-delivery-technical-proposal.md),
[project initialization guide](docs/initializing-a-project.md), and [generated plan](docs/plan/README.md).

## Troubleshooting

### Setup was interrupted

Run the recovery command printed by setup. From the project root, it is normally:

```sh
node .planning/bin/setup.mjs --resume
```

Setup refuses to continue when recovery evidence is ambiguous; follow the named corrective action
rather than deleting project records.

### No model is available

Run setup in an interactive terminal and follow its Pi authentication prompt:

```sh
node .planning/bin/setup.mjs
```

Kiln accepts only an authenticated model you explicitly inspect, select, and approve. It does not
fall back to another provider or copy credentials into the project.

### The browser opened the wrong content or did not start

Read the absolute content path and URL printed at startup. A missing explicit path or occupied port
is a refusal, not a silent fallback. Set `PLANNING_CONTENT_DIR` or `PORT` deliberately and retry;
[Running the shell](docs/running-the-shell.md) contains platform-specific examples.

### You only need an empty content scaffold

Use the dependency-free initializer described in
[Initializing a project](docs/initializing-a-project.md). It creates `planning-content/` without
installing or configuring the planning agent.

## Contributing and support

Use [GitHub issues](https://github.com/don-milsey-miller/kiln/issues) for reproducible bugs and
focused feature requests. Before opening a pull request, run `npm test` and the validation commands
that cover your change. Include tests for behavior changes and update the relevant documentation in
the same pull request.

Kiln has no separate support SLA. Search existing issues before filing a new one.

## Security

Never commit provider credentials, tokens, Pi authentication data, `.pi/` runtime state, or local
environment files. Use unmistakable placeholders in examples and keep secrets in the provider's
supported authentication store or environment variable.

Do not post vulnerability details publicly. Open a
[GitHub issue](https://github.com/don-milsey-miller/kiln/issues) requesting a private maintainer
contact channel without including exploit details or secrets.

## License

Kiln is available under the [MIT License](LICENSE). Planning content created for your own project
remains your work.
