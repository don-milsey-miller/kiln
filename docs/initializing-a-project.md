# Initializing a project

This is how you start a new planning workspace: an empty project directory becomes one with a
`planning-content/` tree Kiln can open, lint, and eventually publish a handoff package from.

The command creates **structure and nothing else**. It writes no planning artifacts, no stage
approvals, and no decisions. Those are yours to make, and a tool that pre-filled them would be
putting words in your mouth on the first day of the project.

## Requirements

- Git, if you want the tool directory ignored automatically.
- Node.js 22 or newer.

You do **not** need to have installed Kiln's dependencies first. The initializer uses only Node's
built-in modules, so it runs in a clone where `npm install` has never happened — which is the point,
because it is what creates the project you would be installing for.

## The layout

Kiln keeps the tool and your documents in separate directories:

```text
your-project/
├── .planning/          the tool — a clone, ignored by your repository, updated with `git pull`
├── planning-content/   your documents — committed to your repository
└── docs/plan/          the published handoff package, once a handoff succeeds
```

`planning-content/` is the **sibling** of `.planning/`, not a directory inside it. That is the one
rule Kiln uses to find your content, and it is why tool updates can never touch your documents.

## Starting a new project

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

Open <http://127.0.0.1:3000>.

The same command is also available as a package script, which is useful when you are already inside
`.planning/`:

```sh
npm --prefix .planning run init:project -- \
  --project-root .. \
  --name "My Project"
```

Prefer the direct `node` form in documentation and scripts. `--project-root .` reads as "the
directory I am in", which is easier to check at a glance than `..` relative to a directory the
`--prefix` flag put you in.

## Options

| Option | |
| --- | --- |
| `--project-root <path>` | **Required.** The project that will *contain* `planning-content/`. |
| `--name <name>` | **Required** unless a terminal is attached to prompt. Written into `project.yaml`. |
| `--description <text>` | Optional. One or more sentences about what the project is for. |
| `--non-interactive` | Refuse rather than prompt for anything missing. |
| `--help` | Print usage and exit. |

The command prints every absolute directory it is about to use before it uses one, so you can check
that `--project-root` resolved to the directory you meant.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The content root was created, or already existed and is **valid**. |
| `1` | Something was in the way, the content root is damaged, or initialization failed. |
| `2` | The arguments or the target directory were unusable. |

A second run of a completed, intact initialization exits `0` and changes nothing, so this is safe to
put in a setup script that may run more than once.

"Valid" is checked, not assumed. `state/setup.json` says Kiln wrote the content root; it does not say
the content root still works. A rerun also verifies that everything the project cannot function
without is still present, and exits `1` if not — see [Damage](#damage) below.

## What gets created

```text
planning-content/
├── project.yaml                    the manifest
├── README.md
├── data/                           empty — artifacts are created by the typed tools
├── stages/
│   ├── 01-intake.md                one starter document per stage
│   └── ...
├── state/
│   ├── setup.json                  what the initializer did
│   └── stage-attestations/         empty — nothing is attested yet
└── skills-overrides/
```

### `project.yaml`

Carries your project's name and description, the current content schema version, the nine-stage
pipeline, sandbox tier 1, and the confidence thresholds.

`capabilities.artifactTypes.activated` is **empty on purpose**. Choosing which artifact types a
project uses is a stage-2 decision — the agent proposes, you approve — and stage 2 is the first point
at which the project's shape is knowable. Templates are generated from the activated set, so an
initializer that guessed here would turn its guess into the documents you were then asked to fill in.

### The starter stage documents

Generated from Kiln's stage definitions, so each one states its stage's purpose, its decision owner,
and its exit criteria. The criteria are printed as guidance, not as checkboxes: a criterion is
discharged by recording an attestation against it — `satisfied`, `not-satisfied`, or `n/a` with a
reason — not by ticking a line in a document.

None of the prose in Kiln's own `planning-content/` is copied. That directory is Kiln's project
history, and inheriting it would hand you somebody else's decisions under your project's name.

### What is deliberately not created

- **No planning artifacts.** An artifact nobody authored is a claim nobody made.
- **No stage attestations.** A missing attestation means *unattested*, which is the truth about a
  project on its first day. Every stage gate therefore starts closed, and the app shows stage 1 as
  the current stage.
- **No `.ids.json`.** The ID allocator creates its counter on the first allocation.
- **No `docs/plan/`.** That is published by `npm run handoff`, only after every gate passes.

## `.gitignore`

When the project is a Git repository, the initializer appends one marked block:

```gitignore
# Kiln planning tool
.planning/
# End Kiln planning tool
```

- Existing content is preserved. The block is genuinely appended — the file is never rebuilt from a
  copy Kiln is holding — so an edit that lands while the command is running is not reverted.
- The block is added at most once, and the existing file's line endings are matched.
- If `.planning/` is already ignored by a rule you wrote, Kiln leaves the file alone and records that
  it *observed* the rule rather than adding one.
- If you later delete the block, rerunning initialization will not put it back. A command you expect
  to do nothing should not overrule a deliberate edit.

`state/setup.json` records which of those happened:

```json
{
  "setupVersion": 1,
  "steps": {
    "contentScaffold": "complete",
    "gitignore": "added"
  }
}
```

It holds no timestamps and no absolute paths — it is committed to your repository, and anything
machine-specific in it would produce a diff on every machine that ran the command.

If the directory is not a Git repository, the initializer says so and continues. Add the rule
yourself if you make it one later: `.planning/` is a clone with its own remote, and committing it
would nest one repository inside another.

## Running it again

The initializer is safe to rerun.

- If the first run completed and the content root is intact, the second changes no bytes and
  exits `0`.
- Files you have edited are never overwritten. Edits are **reported** as drift, not repaired —
  restoring a stage document you rewrote would undo your work in the name of a no-op.
- Nothing is ever recreated. A rerun reports; it does not restore.
- Two initializers running at once serialize through a lock; one creates the tree and the other
  reports that it already exists.

### Damage

A rerun checks that the content root still has what it cannot work without, and exits `1` naming
what is gone if it does not. It still restores nothing — rewriting a manifest underneath a project
that holds your artifacts would be a worse answer than a non-zero exit. Recover the files from Git,
or move the content root aside and initialize again.

**Required** — missing means damaged:

- `project.yaml`
- `state/setup.json`
- one `stages/<stage-id>.md` per stage
- the directories `data/`, `stages/`, `state/`, `state/stage-attestations/`, `skills-overrides/`

**Not required** — missing or edited is reported, and exits `0`:

- `README.md`, which is prose you own
- any `.gitkeep`, which exists only to make Git track an empty directory; deleting one once `data/`
  holds artifacts is correct housekeeping, and a project that did so should not report damage forever
- the contents of any generated file — editing them is the point

A `state/setup.json` that cannot be read, or that declares a `setupVersion` this tool does not write,
also exits `1`. The version gates that record's shape, and there is no migration for it yet: a tool
that guessed at a shape it did not know, in order to decide whether to leave your project alone, is
the failure the field exists to prevent. If the record is newer than the tool, update the tool with
`git pull` inside `.planning/`.

## When it refuses

There is **no `--force`.** Every refusal below protects documents somebody wrote, and a flag that
turns "I will not overwrite your planning content" into one keystroke is a flag that eventually gets
typed by someone who has not read what it does. If a content root really must be replaced, remove it
yourself — the operating system already makes that deliberate.

| Refusal | Why, and what to do |
| --- | --- |
| `planning-content/` exists, is not empty, and has no `state/setup.json` | Kiln did not write it. The conflicting entries are listed. Move them aside, or keep the existing project. |
| The target is inside `.planning/` | Content lives beside the tool, never inside it. From inside `.planning/`, pass `--project-root ..`. |
| The target does not exist | The initializer fills a project in; it does not decide where one lives. Create the directory first. |
| No `--name` and no terminal to prompt at | The name is written into the manifest and nothing can derive it. |

A failed run leaves no `planning-content/` directory at all. The tree is built in a hidden staging
directory and moved into place only after it has been read back off disk and validated, so an
interrupted run costs you a rerun rather than a half-written content root to clean up by hand.

## What this command does not do

It creates planning content, and stops there. It does not install dependencies, configure an LLM or
research provider, choose artifact types, write an intake document for you, initialize Git, or start
the server.

Those belong to a later `setup` command that will compose this one with the packaged planning-agent
roster, once that package exists. Keeping them apart is what lets this command be complete and useful
now, rather than pretending the unfinished half of Kiln is available.

## Working on this repository itself

Kiln is its own consumer: its content lives at `<repo>/planning-content`, not at
`<repo>/../planning-content`. The sibling rule does not apply to it, so development commands name the
content directory explicitly.

PowerShell:

```powershell
$env:PLANNING_CONTENT_DIR = (Resolve-Path .\planning-content).Path
npm run lint:plan
```

macOS or Linux:

```sh
PLANNING_CONTENT_DIR="$PWD/planning-content" npm run lint:plan
```

`init-project.mjs` refuses to initialize this repository for the same reason: the target would be the
tool directory.
