# `planning-content/` — your documents

**This directory is yours. Tool updates never touch it.**

That separation is decision #20, and it exists for one reason: this repo has to be
able to improve without you losing or rewriting your project documents. The tool
clones into `.planning/` (gitignored, `git pull` to update); your content lives
here and is committed to your project repo.

If you have just cloned a project and found this directory sitting here, the tool
is missing. Clone it beside this directory and start it:

```sh
git clone https://github.com/don-milsey-miller/kiln.git .planning
npm --prefix .planning start
```

There is nothing to initialize in that case — this directory *is* the content, and
the tool resolves it as its own sibling. `node .planning/bin/init-project.mjs` is
for a project that has no `planning-content/` yet; it refuses a directory it did
not write, so it cannot be the thing that damages this one. See
[`docs/initializing-a-project.md`](../docs/initializing-a-project.md) in the tool.

## What lives here

| Path | What it is |
|---|---|
| `project.yaml` | The manifest — pipeline shape and capability declarations (#4). Start here. |
| `stages/` | The stage documents themselves, as MDX. Generated from templates (#43); authored by you and the agent. |
| `data/` | The machine-readable twin — `schema.yaml`, `tasks.json`, `assertions.yaml`, `evidence/`. |
| `skills-overrides/` | Drop a tuned `SKILL.md` here and it wins over the packaged one (#33). |

## Two writers, one directory

The app and the agent both write here, and they partition rather than lock (#31):
the app writes frontmatter and state fields, the agent writes body prose and data
files. Different regions of different files means there is nothing to clobber.
Locking would make the app feel broken every time the agent is thinking.

The file watcher on this directory is the integration mechanism between the two
halves, and it has to work on its own (#30) — the agent runs in a plain terminal
that knows nothing about the dev server.

## Why `data/` is not a duplicate

Principle 2: structured data is canonical, and every human-readable form is a
rendering of it. The MDX in `stages/` and the JSON in `data/` are not two copies
of the same thing that might drift — one is derived from the other.

---

*Decisions referenced as `#n` are rows in `references/notes-transcriptions/notes.md`,
which stays canonical.*
