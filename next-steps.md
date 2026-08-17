# Next steps — the build order

> Written 2026-08-14. **Derived from `references/notes-transcriptions/notes.md`, which stays canonical** —
> where this file and that one disagree, that one wins. This is a running order, not a decision record;
> decisions belong in notes.md with a number.
>
> The framing that produced this list: notes.md is done thinking for now. 67 decisions, ~1,600 lines,
> and the remaining open questions are a default-tier setting and a try-it panel — the trust spike's
> answers became #67 on 2026-08-15 and #68 on 2026-08-16.
> **The next few answers have to come from code rather than from the document.**
>
> **Status:** step 0 done (2026-08-14). **Step 1 done (2026-08-16) — all six checks answered.**
> Check 1 answered **no** on 2026-08-15 (the documented silent failure is real; trust is the
> variable — see #67), checks 3, 4, 5, 6 answered the same day, and **check 2 answered *yes* on
> 2026-08-16**: the `tools:` allowlist is a boundary in the child's tool *registry*, not prompt
> shaping, and it covers custom tools identically (→ #68). The frontier-model blocker below was
> stale — the machine already had a working `openai-codex` credential. **Next: delete
> `D:\spike-pi-trust`, then settle 0(d), then step 2.**
>
> _Revised 2026-08-15 after a review pass: 0(c) closed and 0(d) opened · step 1 given mechanical
> observables, a remedy path, and three more checks · two new steps — 2 (the watcher spike) and 4
> (activation) · schemas are now step 3 and the walking skeleton step 5._

---

## ~~Step 0 — there's no repo yet~~ ✅ done 2026-08-14

`git init` on `main`, the #20 three-way split (`.planning/` gitignored — verified with
`git check-ignore` · `planning-content/` committed · `docs/plan/` committed), and
`planning-content/project.yaml` carrying the pipeline shape (#4) and `schemaVersion: 1` (#50).
The manifest parses. Nothing is committed yet — the tree is staged-in-spirit only.

**What the manifest deliberately does not carry**, because something else owns it:
per-stage *produces* / *exit criteria* (the single `stages/` set, #34) · roles (discovered
from stage-8 assignments, #18) · status (per-doc frontmatter, #4). `planning-content/stages/`
is empty for the same reason — #43 makes templates *generated* from activated types plus
schemas, so hand-writing stage docs now would author exactly the thing that must be generated.
They arrive with step 4, once activation makes generation possible.

### Four things step 0 surfaced

| | Item | State |
|---|---|---|
| a | **Default sandbox tiers in a fresh `project.yaml`** — the open question notes.md already flags. Written as **tier 1 only**: the reading where a wrong default grants nothing. | Provisional. Needs a number in notes.md, or a deliberate raise. |
| b | **`artifactTypes.activated` is `[]`.** Activation is a stage-2 agent-proposes / PM-approves decision (#39) and stage 2 hasn't run. Step 3's four types are recorded in the file as a *proposal*, not an approval. | Correct as-is. Resolves at step 4, when stage 2 actually runs. |
| c | **Where the tool half sits in this repo.** This repo *is* the tool — it becomes `.planning/` in a user's project (#1, #20, #32) — so `app/` `pi-package/` `schemas/` `templates/` `stages/` are top-level here, and the `planning-content/` just created is this project dogfooding itself. | **Settled**, and it always was — see below. Needs a number in notes.md, not a decision. |
| d | **How the app finds content once this repo _is_ `.planning/`.** A consumer's content sits at `../planning-content` relative to the tool root; this repo's own dogfood copy sits at `./planning-content`. Two different paths that look identical from inside this repo. | **Open — and it's the load-bearing half of what (c) was pointing at.** Wants settling before step 2, which is where it first bites. |

**(c) was never a decision — it was a reading of one.** The layout diagram in notes.md
("The handoff package" → The layout) already places `app/ pi-package/ schemas/ templates/ stages/
sessions/` inside `.planning/`, and #1 / #20 / #32 make this repo the thing that clones into it.
So the spike puts its `pi-package/` at the top level and nothing is blocked. What's owed is a
decision row recording what the diagram already implies.

⚠️ **(d) is the one to settle first now**, and it's sharper than (c) was:

- **Path resolution.** The file watcher (#30) and the lint (#47) must bind to the *parent's*
  `planning-content/` and never to the tool's dogfood copy. Inside this repo the two resolve to the
  same directory — so a wrong rule here works perfectly right up until somebody else clones it.
- **Nobody writes the consumer's `.gitignore`.** The `.planning/` line in this repo's `.gitignore`
  is inert here; it only does work in a *user's* project, and that file currently has no author.
  It belongs to the setup script (#49) and it is not in the step chain notes.md sketches for it.

---

## 1. The trust spike ✅ answered 2026-08-16 — six of six

_The directory at `D:\spike-pi-trust` is now owed its deletion. Its answers are in notes.md as #67,
#68 and amendments to #26 / #33 / #50 / #66; nothing else in it is meant to survive, `delegate.ts`
least of all — it now has two bug fixes in it that make it look more finished than it is._

**Hours, timeboxed, throwaway.** This is a *spike* in the XP sense — code written to answer a
question, then deleted. Its output is six yes/no answers, not an artifact.

### What "trust" means here

Pi packages run extensions with full system access. Pi therefore gates whether a project directory
is trusted before loading them — and **non-interactive modes don't prompt**, they fall back to a
saved or default decision. #65 launches every specialist as a non-interactive child
(`pi --mode json -p --no-session`), so this is directly in the path.

### Why it earns its own step

Every contract in the roster is enforced by typed tools (#66). If trust silently isn't granted,
the extension doesn't load, the typed tools don't exist — **and the child doesn't error.** It writes
plausible freehand prose instead. That's the failure principle 2 exists to prevent, arriving through
the back door wearing the appearance of success.

### The setup

Throwaway directory · minimal Pi package with one typed tool and the adapted `subagent` extension ·
`pi install -l` (#32) · one `agents/research.md` definition · orchestrator delegates one bounded task.

**Scaffolded 2026-08-15 at `D:\spike-pi-trust`** against pi 0.80.6. Prerequisites turned out to be
already in place — pi installed, provider configured, and the official `subagent` example **on disk**
inside the installed package rather than only on GitHub, so the adaptation copies from the exact
version being run.

⚠️ **Reading the shipped docs turned three of these six into predictions** (see the trust block in
notes.md's Open questions). That doesn't retire the run — the premise of this step is that nobody
has run it — but it changes what the run is *for*. A prediction that holds is a confirmation; a
prediction that fails is the most valuable thing this spike can produce. Record both the same way.

⚠️ ~~**The remaining checks need a working provider, and right now there isn't one.**~~ **Resolved
2026-08-16, and the blocker was never real.** The configured default is `llamacpp / qwen35-4b` and
that server is still down — but `~/.pi/agent/auth.json` already held an `openai-codex` OAuth
credential whose access token had expired a month earlier and which **refreshed itself silently on
first use**. `pi --list-models` shows the whole `gpt-5.x` family. Check 2 ran on
`openai-codex/gpt-5.4-mini`, so #37 was satisfied without configuring anything.

**The general lesson, which is worth more than the specific one:** a blocker recorded from a failed
command is a claim with a shelf life, and this one was written down as a prerequisite rather than as
an observation. Re-test a recorded blocker before building around it.

Two setup conditions that are easy to skip and both distort the result:

- **Commit this repo first.** Nothing is committed yet — `git log` has no commits and every path is
  untracked. "Throwaway, then deleted" should be `git clean`, not judgment about which files were
  the spike.
- **Run it against a frontier model** (#37). A weak model that simply fails to call a typed tool
  looks exactly like check 1 coming back *no*, and that is the one confusion this whole step exists
  to avoid.

### The six checks

Each check needs a **mechanical observable**. Every question below can be answered by watching what
the child *does*, and behaviour confounds the harness with the model — which is the same
false-success this step exists to catch, arriving in the measurement instead of the product.

| # | Check | Observe it by | If **no** |
|---|---|---|---|
| 1 | Are our **typed tools present in the child**? | Dumping the child's registered tool list from `--mode json` — or registering a tool that echoes its own name. Not by whether the output looked structured. | #66's enforcement story collapses back to prose, and the output contract is a request rather than a boundary. |
| 2 | ✅ **answered *yes*, 2026-08-16.** Does the **`tools:` allowlist actually block a write**, or merely omit the tool from the prompt? | Omit write from the allowlist, then give the child a task that *requires* a write, and confirm the refusal comes from the **harness** rather than the model. Test a **custom** tool too — the claim is that `--tools` covers built-in, extension and custom alike. | Role leakage (Risks) goes back to being instructional. This is the check that matters most — the mitigation was upgraded from "prose" to "mechanical" on a claim that was read, not run. |
| 3 | Does **`AGENTS.md` reach the child**, as #66 assumes? | A canary string in `AGENTS.md`, echoed back. Run it **twice** — with and without `--no-context-files` — so the escape hatch #66 names as its fallback is proven at the same time. | #66's invariants-vs-role-instruction split is wrong and needs re-drawing — probably toward `--no-context-files` plus explicit injection. |
| 4 | Does an **extension hook fire at turn end** — and does it fire **inside a non-interactive child**? | Register a hook that appends a fixed marker, and look for it in both the orchestrator's turn and a delegated child's. | The second half is the real risk. If hooks only fire in the interactive orchestrator, specialists writing artifacts get no lint feedback, and #48's claim to be what makes provider-agnosticism (#10) *real* holds only for the orchestrator. That reshapes step 5. |
| 5 | Does **`pi install -l` reference the package, or copy it**? | Edit a file inside the installed package, don't reinstall, and see whether the child picks the change up. | #50's update path breaks. `git pull` inside `.planning/` stops being sufficient on its own and the setup script (#49) gains a mandatory reinstall step. |
| 6 | Does a **`skills-overrides/` SKILL.md beat the packaged one** (#33)? | Ship a packaged skill, drop a same-named file in the override path, and see which body actually reaches the agent. | Tuning a skill means editing the tool — which is a merge conflict on the next update, i.e. precisely the failure #20 exists to prevent. |

⚠️ Check 2 is the easiest to false-pass: if the child never attempts a write at all, you have learned
nothing and it reads as a pass. The task has to force the attempt.

✅ **And that is exactly what happened on 2026-08-16 — the check survived it by not depending on the
attempt.** The frontier model, correctly, never emitted a write call; it reported the tool missing and
stopped. The answer came instead from dumping the child's tool registry at `session_start`, *before*
the model ran: `write` was absent from `getAllTools()`, `getActiveTools()` and the prompt's
`selectedTools` alike, so `--tools` removes the tool rather than hiding it, and "the model didn't try"
became a consequence of the boundary instead of a confound with it. **Generalise this — the reliable
form of a "does the harness enforce X" check is an observable taken upstream of the model, not a
judgement about what the model then did.** Same move that answered check 5 with no model at all.
Two side findings came with it: the default tool set (no `--tools`) includes `bash`, `edit` and
`write` → **#68**; and `delegate.ts` had never completed a delegation at all, which is why checks
1/3/4 had only ever been run top-level.

**Check 4 rides along free.** #48 is described in notes.md as plausibly the highest-leverage item in
the document, and without this it goes untested until step 5. Same throwaway package, same afternoon.

**Checks 5 and 6 are about the _update_ story, not the build** — which is exactly why they're easy to
skip and expensive to skip. #50 (`git pull` in `.planning/`) and #33 (skill overrides) are both
promises made to a *future* user on a *future* clone, so a wrong assumption doesn't surface on this
machine at all. The package is already installed at this point; both are minutes.

### If a check comes back *no*

The spike also has to leave a **remedy**, or it gets run twice. Specifically: notes.md's leaning is
that the setup script records the project trust decision at install time (#49) — so establish
**where that decision is persisted and how to write it**, not merely whether the default is right.
A confirmed problem with no known fix is half an answer.

### Where the answers go

The code is disposable; the answers are not. Each check lands in notes.md as a numbered decision or
an amendment to #65 / #66 — including the *no*s and their remedies. A finding that lives only in
scrollback was paid for and not kept.

⚠️ **Do not keep the adapted `subagent` extension.** It is the one piece that will look
production-shaped once it works, and keeping it means the real `pi-package/` inherits code written
to throwaway standards, *before* the three contracts exist to shape it. Rewrite it from the example
with the answers in hand.

⚠️ The trust behaviour itself comes from the 2026-08-14 verification's reading of the Pi docs.
Nobody has run it. That is the entire reason this is step 1.

---

## 2. The watcher spike

**Half a day, timeboxed, throwaway.** Same rules as step 1 — code written to answer a question, then
deleted.

#30 calls the file watcher the mechanism joining the two halves, and #55 puts it in the skeleton.
But the risky part isn't "does the watcher fire." It's what happens when a *second process that
knows nothing about the dev server* (#12) writes underneath it.

### Why it sits here rather than just before the skeleton

One of its answers is a constraint on **step 3**: if a partial read is possible, the typed tools have
to write atomically — temp file plus rename, never truncate-in-place. That's a property of the first
typed tool, not something to retrofit into four of them. Answering it after the schemas are written
means writing them twice.

### The three checks

| # | Check | Observe it by | If **no** |
|---|---|---|---|
| 1 | Can the app read a **half-written file**? | An external process writing a large MDX doc in a loop, non-atomically, while a watcher parses on every event. Count the parse failures. | Every typed tool must write atomically, and the app needs a parse-failure path that isn't a crash. Cheap if known now. |
| 2 | Does watching behave on **Windows**? | The same loop, but watching what the real app will watch — nested dirs, renames, rapid successive writes. Look for missed and coalesced events. | The watcher needs polling or a debounce strategy, and #30's "must work on its own" gets a caveat with a platform attached. |
| 3 | Does the **#31 partition actually hold**? | Two writers on one file — one touching frontmatter only, one touching the body only — running concurrently. | "Partition, don't lock" was chosen over locking on the strength of a prediction. If regions don't stay separate in practice, #31 reopens and locking comes back off the Rejected list. |

⚠️ This is the one spike where **the platform is part of the question.** Development is on Windows;
file-event semantics differ enough from macOS/Linux that "it works" here and "it works" is not the
same statement. Record which it was.

**Where the answers go:** same as step 1 — notes.md, with numbers. Check 3 in particular can reopen a
Rejected item, which is the sort of thing that must not live only in a terminal.

---

## 3. Four schemas, not sixteen

#38's sixteen types are the stated critical path and the biggest risk in notes.md. #54 makes stage 5
the flagship. But the minimum set that proves the **loop** rather than the catalogue is:

```
requirement  →  decision  →  schema  →  api-spec
```

Enough to exercise trace links, one typed tool, a generated template (#43), the lint (#46), and
#61's per-field propagation classes — against real content rather than in the abstract.

**Bake the materiality class in from the first schema.** Retrofitting `structural` / `semantic` /
`advisory` / `cosmetic` across sixteen schemas later is exactly the kind of chore that doesn't
get done. Note that these four types will only exercise three of the four classes — `advisory` is
thin here, and it's also the class notes.md already parks as needing per-*edge* declarations. Bake
it in anyway; just don't read "the schemas work" as covering it.

### Decide this before schema one: trace links to types that aren't activated

`decision` carries *linked evidence* and *downstream dependencies* (the decision register). Both
point at types this set does not activate. So the very first schema hits a question the catalogue
never had to answer: **what does a trace link to a non-activated type do?** Lint error, permitted
but unresolvable, or the field doesn't exist on this project at all. Pick now — it's the same
retrofit argument as materiality, and it lands on day one rather than later.

### What these four prove, and what they don't

They prove the **authoring** loop: trace links, a typed tool, a generated template, the lint,
per-field propagation. That's the right first target and it matches #54's stage-5 flagship.

They do **not** touch the **evidence** loop. Nearly every lint rule with teeth — #57's thresholds,
#58's destructive floor, #59's acknowledgement, orphan runbook steps, tier→rung consistency — lives
on `assertion` / `evidence` / `runbook-step`, and that machinery is the most novel thing in the
design. Naming that here so the gap is deliberate rather than discovered: it stays unproven past
the end of this running order.

---

## 4. Run stages 1–2 on this project, for real

**The step that was missing, and it closes a circle.** Step 5 renders one MDX doc. Templates are
*generated* from the activated artifact types (#43). `artifactTypes.activated` is `[]`, and step 0
declined to hand-write stage docs on exactly that reasoning. Activation is a stage-2 decision the
agent proposes and the PM approves (#39) — and stage 2 has not run.

So as written, step 5 either needs an activation list it cannot legitimately obtain, or it
hand-authors the very thing step 0 refused to author. The way out is to stop treating this project's
own `planning-content/` as a placeholder and **work stage 1 and stage 2 of the pipeline on this
project**:

- it is the only legitimate source of an approved `activated` list, which unblocks #43 and step 5;
- it turns 0(b) from "resolves when stage 2 runs" into something with a date;
- and it is the cheapest possible test of whether the pipeline is any good — before nine skills and
  sixteen schemas are built on the assumption that it is.

Step 3's four types are the *proposal* this step approves or rejects. If working stage 2 for real
produces a different four, that is a finding, not a failure.

⚠️ Manual is fine here. The orchestrator doesn't exist yet, so this is the PM doing stage 1 and 2 by
hand against the stage definitions. The output that matters is `activated` in `project.yaml` and two
real documents to render.

---

## 5. Walking skeleton (#55), with the lint loop (#48) wired in early

Manifest → tracker view → one MDX doc rendering → status write-back → **the file watcher**.
The watcher is the whole integration surface between the two halves (#12), so a skeleton without
it doesn't prove the risky part — and by now step 2 has told you how it has to be built.

Wire #48's turn-end lint hook in **during** this step rather than after. notes.md already argues
it's plausibly the highest-leverage item in the document; it's also the thing that tells you
whether the four schemas in step 3 were the right four.

---

## Why this order

**Both spikes come first, and neither is on the critical path by accident.** Step 1 gates the agent
half — six answers change what #65, #66, #50, #33 and #48 mean. Step 2 gates the app half, and one
of its answers is a constraint on the very first typed tool, which is why it precedes the schemas
rather than the skeleton. Between them they cost under two days and they are the last cheap moment
to be wrong.

The schemas then gate everything else, including the app, and shrinking sixteen to four is what makes
the critical path start moving. Activation is what makes the templates in #43 generatable at all, and
it is the first time the pipeline gets used rather than described. The skeleton is where the two
halves first touch, and #48 turns the lint from a report into a feedback loop before there's much
content to be wrong about.

**What this order is not:** a claim that the agent half and the app half are sequential. The useful
version of that statement is narrower — **step 3 is the only dependency the two halves share.**
Whether anything actually runs in parallel is a question about how many people are working, and the
answer here is one.

**Where this stops, deliberately.** The running order ends at the first point the two halves touch.
It does not cover the three specialist contracts, the remaining twelve artifact types, the sandbox
tiers, or the runbook — which is to say the evidence loop, the most novel machinery in the design,
is still ahead. Step 5 is the end of the beginning, not the run-up to done.
