# Visual Project Workflow

A clonable, local-first planning system. Drop it beside a new project, run one command, and get a
local web app that walks the project from raw intent to a plan a team can execute — with the
evidence for its technical claims attached.

Each stage produces a **document you read in a browser**, not a wall of Markdown. You and an agent
author them together: the agent may write across any stage, you stay focus-locked to the current one
and advance when its exit criteria are met.

And the plan is meant to be more than well-formatted guesswork. Where it rests on a technical claim
that could be wrong, the system researches that claim against real sources and — when it matters
enough — proves it in a disposable sandbox before the claim is allowed to carry weight. The handoff
package ships with that evidence attached, or it refuses to ship.

## Status

**Pre-1.0 and honest about it.** Version `0.0.0`. This repo is the tool half, and the tool half
substantially works: schemas, the lint, the research and validation capabilities, the handoff
publisher, and the application shell are built and tested (407 tests, two lint gates, all green).

What is **not** built yet:

- **`pi-package/` — the agent roster.** The specialist *contracts* exist (`lib/specialists/`); the
  packaged orchestrator and its specialists do not. Roughly half the product by design, and the
  half with the least precedent to copy from.
- **A setup script.** The consumer flow below describes the intended shape (#1). Today you clone and
  run `npm start` yourself.

The plan for the tool's own application shell is closed: every stage gate attested, no blockers, and
a published handoff package of 261 artifacts under [`docs/plan/`](docs/plan/README.md). One of its 25
shell criteria travels as a *resolved* failure rather than as a gap — `fail`, `superseded`, naming
its successor — which is the shape this project wants failures to have.

## Requirements

Node **≥ 22** (developed on 24). No other runtime, no database, no service to sign up for. Research
is the one capability that wants a credential, and it is opt-in.

## Quick start

```
npm start
```

That is `node bin/start-shell.mjs`. It installs dependencies if they are missing or stale, builds for
production, starts on `http://127.0.0.1:3000`, and prints **which planning content it is reading** as
an absolute path. <kbd>Ctrl</kbd>+<kbd>C</kbd> stops it.

Production mode is the only shipped configuration (DEC-0018): `next dev` and `next build` produce
different artifacts, so shipping the development server would mean shipping something this project
can never validate.

Point it at different content with `PLANNING_CONTENT_DIR=/path/to/planning-content npm start`. A path
that does not exist is a refusal with exit code 2, never a silent fallback.

Full operational detail — options, what stopping it guarantees, why production mode only — is in
[`docs/running-the-shell.md`](docs/running-the-shell.md).

## The one concept to understand first: the tool/content split

The tool and your documents are **different directories with different owners** (#20), so that this
repo can improve without you losing or rewriting your project's plan.

| | Lives in | Owned by | Updated by |
|---|---|---|---|
| The tool | `.planning/` in your project, gitignored | this repo | `git pull` inside it |
| Your documents | `planning-content/`, committed | you | you and the agent |

So the intended consumer flow is: `mkdir my-project` → clone this repo into it as `.planning/` →
your content lives beside it and is committed to *your* repo.

**In this repo that split is inert**, because this repo *is* the tool (#69). The `planning-content/`
you see here is this project's own plan, written with its own pipeline — the tool has been planning
itself since stage 1. That is also the most complete example available of what the output looks like.

## Layout

| Path | What it is |
|---|---|
| `app/` | The Next.js application — stage view, review panel, and the `/events` change stream. |
| `app/server/` | The only door from the application into `lib/`. Explicit re-exports, no `export *`. [Read why](app/server/README.md). |
| `lib/` | The engine: lint, schemas, locking, handoff, research, validation, specialist contracts. |
| `bin/` | The commands. Every one of them is documented in its own header. |
| `schemas/` | The twelve artifact schemas — the shape all content is validated against. |
| `stages/` | The single definition set for the nine stages. The app renders from it; the skills derive from it (#34). |
| `planning-content/` | This project's own plan. In a consumer project, **yours**. [Read more](planning-content/README.md). |
| `docs/plan/` | The generated handoff package. Nothing in it is written by hand. |
| `references/` | Source material and the canonical decision record. |
| `test/` | 407 tests, run with `npm test`. |

## Commands

| Command | What it does |
|---|---|
| `npm start` | Install, build, start the app. The documented launcher. |
| `npm test` | The full suite, on the Node test runner. No framework. |
| `npm run lint:plan` | Validate planning content. Needs `PLANNING_CONTENT_DIR` — it [refuses to guess](#two-rules-that-explain-most-of-the-code). |
| `npm run lint:shell` | Check the application never reaches around `app/server/` into `lib/`. |
| `npm run handoff` | Publish the frozen handoff package. Explicit, deterministic, never a gate side effect. |
| `npm run research:search -- "a question"` | Find candidate sources. Returns candidates, records nothing. |
| `npm run research:record -- <url> --claim … --quote …` | Record evidence. The quote is verified against the fetched page before anything is written. |
| `npm run research:probe` | Is research usable on this host, right now? Measured against the live backend; spends no search credit. |
| `npm run migrate:content` | Advance content to the current schema version. Dry run by default; `-- --apply` writes. |
| `npm run dev` | The walking skeleton (`app/server.mjs`) — an earlier standalone prototype that proved the watcher, the render-time derivation and the status write-back. Kept, but it is not the application. |

## Two rules that explain most of the code

**1. Structured data is canonical; every readable document is a rendering of it.** The JSON under
`data/` and the MDX under `stages/` are not two copies that might drift — one is derived from the
other. This is why `docs/plan/` says, at the top, that editing it edits a rendering.

**2. Refusing beats guessing.** A tool that reads one directory while you believe it reads another is
worse than a tool that will not start. So `lint:plan` refuses to resolve content it was not pointed
at, the launcher prints its absolute content root, `handoff` will not publish a plan whose stage
gates are unattested, and a research quote that is not on the page is not recorded. Where you find a
refusal here, it is usually load-bearing.

## Conventions

Two numbering systems, and they are not the same thing:

- **`#n`** — a row in `references/notes-transcriptions/notes.md`, the canonical decision record.
  That file wins over every other document in the repo, including this one.
- **`DEC-0021`, `AST-0015`, `REQ-0010`, `TSK-0013`** — artifacts in `planning-content/data/`, the
  project's own plan. These are what the app renders and the lint validates.

Both appear throughout the source. Header comments carry the *why*, and a `⚠️` in one usually marks
a place where an earlier belief turned out to be wrong and was corrected — those are worth reading
before changing the code beneath them.

## License

[MIT](LICENSE). Clone it, fork it, use it in your own projects, commercial ones included — keep the
copyright notice. Your `planning-content/` is your own work and this license makes no claim on it.
