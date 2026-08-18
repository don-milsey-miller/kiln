# Next steps — the build order

> Written 2026-08-14. **Derived from `references/notes-transcriptions/notes.md`, which stays canonical** —
> where this file and that one disagree, that one wins. This is a running order, not a decision record;
> decisions belong in notes.md with a number.
>
> ✅ **And as of 2026-08-18 the order itself has one: #76.** An audit found the two files were circular —
> this one deferred to notes.md while notes.md cited "step 3" and "step 5" as deadlines it never
> defined, and resolved an imported item as "merged into the build order" that lived only here. The
> five steps, their gating, the only-shared-dependency claim and where the order deliberately stops are
> now in notes.md. Five other things that were living here alone went with them: the four-type
> rationale and the evidence-loop gap → **#38** · `activated: []` and why this project must run its own
> stage 2 → **#39** · "re-test a recorded blocker before building around it" and "don't keep the adapted
> `subagent` extension" → the spike-1 section · the tier-1-vs-tiers-1-and-2 disagreement between this
> repo's manifest and the sandbox leaning → Open questions, **and closed the same day as #77**. **What
> remains here is scheduling and scratch: check tables, run records, and what is owed next.**
>
> The framing that produced this list: notes.md is done thinking for now. **99 decisions as of
> 2026-08-18**, and the only open question left in it is a cosmetic one — try-it panels in API specs.
> **The next few answers have to come from code rather than from the document.**
>
> ⚠️ **Revised 2026-08-18 from `Visual Project Workflow — Conversation Review and Implementation
> Readiness Notes.md`.** That document is a review of notes.md written after it, so most of it restates
> what was already recorded. Four things in it were new: **#78** closes the #31 successor (short-lived
> lockfile), **#79** names semantic staleness and deliberately doesn't solve it, **#80** writes down the
> triage rule this project has been following unstated, and **#76 grew from five steps to seven** — two
> verification spikes before the schemas, and an evidence vertical slice after the skeleton.
>
> **Status:** step 0 done (2026-08-14). **Step 1 done (2026-08-16) — all six checks answered.**
> **Step 2 done (2026-08-17) — all three checks answered → #72, #73, and #31 reopened.**
> _Step 1:_ check 1 answered **no** on 2026-08-15 (the documented silent failure is real; trust is the
> variable — see #67), checks 3, 4, 5, 6 answered the same day, and **check 2 answered *yes* on
> 2026-08-16**: the `tools:` allowlist is a boundary in the child's tool *registry*, not prompt
> shaping, and it covers custom tools identically (→ #68). The frontier-model blocker below was
> stale — the machine already had a working `openai-codex` credential.
> _Step 2:_ the app **can** read a half-written file (always, not rarely) → #72 · `fs.watch` is
> unusable on Windows and chokidar is not → #73 · and the #31 partition **does not hold**, which
> un-rejected locking. ✅ **Its successor is now #78 — a short-lived lockfile — decided 2026-08-18,
> ahead of its step-5 deadline.**
> **0(c) and 0(d) both closed 2026-08-16** → #69, #70, #71; one fixture test is owed at step 5.
> **Step 3's two blocking decisions closed 2026-08-18 → #74 (JSON Schema is the source of truth,
> types generated from it) and #75 (a trace link to a non-activated type is permitted but
> unresolvable, at advisory weight).** #72 is a constraint on the first typed tool written there.
>
> ✅ **Step 2a done (2026-08-18) — writing `~/.pi/agent/trust.json` works, and it is causal.** Entry
> present → the non-interactive child loads the package and registers the typed tools with no
> `--approve`; entry removed → reverts; entry set to `false` → reverts. **#67(a) is measured rather than
> documented**, and #67(b) — detecting a toolless child — is now the whole of what's left on that row.
>
> ✅ **Step 2b done (2026-08-18) — outcome A: `planning-content/skills-overrides/` wins.** Registered
> through the settings `skills` array, the override beats the packaged skill; editing it tracks; removing
> it restores the packaged one. **#33 stands as written** and the customization story can be documented.
> The check-6 caveat that predicted the opposite was a documented-order reading, and it was wrong.
> ⚠️ Precedence between that path and `.pi/skills/` is untested **by choice** — #80 branch 3, with a reopen condition, because the product does not create that configuration.
>
> ✅ **Side finding — a step-1 loose end closed, and it earned a decision row.** Every 2b run hung until
> stdin was closed: the inherited-stdin bug from `delegate.ts`, reproduced with no delegation code
> involved, so **the stdin half is the load-bearing fix**. That plus the hung-child and toolless-child
> failures are now **#81, the specialist spawn contract** — `stdio: ["ignore","pipe","pipe"]` → bounded
> spawn timeout → capability check (#67b), and no specialist output is accepted until all three pass.
> Three defences, three different silent failures, all three observed rather than imagined. It doesn't
> block step 3; it lands with the delegation extension.
>
> **Next: step 3 — the four schemas.** Both verification spikes are answered; nothing is owed before it.
>
> ✅ **All spike directories deleted 2026-08-18**, children before parents: `D:\spikes\trust-verify`
> (2a), `D:\spikes\override-verify` (2b), `D:\spike-watcher` (an earlier watcher attempt carrying
> `node_modules`), then the `D:\spikes` wrapper. `D:\spike-pi-trust` was already gone before 2a started
> — the note that used to sit here claiming a path guard had preserved it was stale, which is why 2a
> had to be rebuilt from scratch. **Nothing throwaway remains on disk; every answer is in notes.md.**
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
| a | **Default sandbox tiers in a fresh `project.yaml`** — written as **tier 1 only**: the reading where a wrong default grants nothing. | ✅ **Closed 2026-08-18 → #77**, and the tier-1-only manifest turns out to be **right on this machine for a reason it didn't know**: tier 2 is now capability-detected, `docker` is not on PATH here, so tier 2 is *recommended-pending-approval* rather than available. What's owed is the recommendation to the PM, not an edit to the file. |
| b | **`artifactTypes.activated` is `[]`.** Activation is a stage-2 agent-proposes / PM-approves decision (#39) and stage 2 hasn't run. Step 3's four types are recorded in the file as a *proposal*, not an approval. | Correct as-is. Resolves at step 4, when stage 2 actually runs. |
| c | **Where the tool half sits in this repo.** This repo *is* the tool — it becomes `.planning/` in a user's project (#1, #20, #32) — so `app/` `pi-package/` `schemas/` `templates/` `stages/` are top-level here, and the `planning-content/` just created is this project dogfooding itself. | ✅ **Closed 2026-08-16 → #69.** It always was settled; it now has a number. |
| d | **How the app finds content once this repo _is_ `.planning/`.** A consumer's content sits at `../planning-content` relative to the tool root; this repo's own dogfood copy sits at `./planning-content`. Two different paths that look identical from inside this repo. | ✅ **Closed 2026-08-16 → #70 (resolution) and #71 (the consumer's `.gitignore`).** And the hazard was worse than written — see below. |

**(c) was never a decision — it was a reading of one.** The layout diagram in notes.md
("The handoff package" → The layout) already places `app/ pi-package/ schemas/ templates/ stages/
sessions/` inside `.planning/`, and #1 / #20 / #32 make this repo the thing that clones into it.
So the spike puts its `pi-package/` at the top level and nothing is blocked. What's owed is a
decision row recording what the diagram already implies. ✅ **That row is #69.**

✅ **(d) settled 2026-08-16 — and settling it turned up a sharper version of itself.** Full reasoning
and the rejected alternatives are in notes.md under "Resolving the content root". In short:

- **Path resolution → #70.** The problem was not two paths that look alike, it was that **the wrong
  one exists and parses in every consumer install.** `planning-content/` is committed in this repo, so
  a consumer's `.planning/planning-content/project.yaml` is present on day one — as *our* manifest,
  for a different project. Any resolver that tries `./` before `../` succeeds against the wrong
  project and says nothing. So: **one rule, `<toolRoot>/../planning-content`, with no fallback**, one
  documented override (`PLANNING_CONTENT_DIR`, which is how this repo dogfoods), and one resolver that
  the watcher (#30), the lint (#47) and the typed tools all call. A missing content root refuses to
  start rather than guessing.
- **Why not record the path at setup time?** Because both checkouts would then hold different correct
  values, both would work, and the consumer's branch would still be exercised only by consumers.
  Under #70 a wrong rule breaks **this machine** immediately, since `../planning-content` doesn't
  exist here. The scarce property was local falsifiability, not explicitness.
- **The consumer's `.gitignore` → #71.** It goes in the setup script (#49): one marked block,
  appended once, recorded, and **never re-added if the PM deletes it** — deleting the line is a
  decision to commit `.planning/`, and silently restoring it is the same override-the-PM move #67
  rejected.
- **What's owed in code, not prose:** a fixture test that builds the consumer layout in a temp
  directory and asserts what resolves. That is the piece that actually closes this, because it
  exercises the consumer path on the developer's machine. It lands with the first code that resolves
  anything — **step 5**, and it is the only part of 0(d) still outstanding.

---

## 1. The trust spike ✅ answered 2026-08-16 — six of six

_✅ `D:\spike-pi-trust` **is gone** — confirmed 2026-08-18 while starting 2a, which had to be rebuilt
elsewhere as a result. Its answers are in notes.md as #67,
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

## 2. The watcher spike ✅ answered 2026-08-17 — three of three

_Ran at `D:\spikes\watcher`, in a **consumer-shaped layout** (`.planning/` beside a sibling
`planning-content/`) so it bound to #70's rule rather than the dogfood path — per the ⚠️ below.
**Windows 11 · Node v24.18.0 · chokidar 5.0.0.** Full results in notes.md under "The watcher — what's
actually true"._

| # | Answer | Landed as |
|---|---|---|
| 1 | ❌ **Yes, the app can read a half-written file — 120 of 120 naive reads were partial.** Not an edge case; the normal case. Atomic writes fix it *and* keep the best revision fidelity, where the obvious alternative (`awaitWriteFinish`) collapsed 40 revisions into 1. | **#72** — temp+rename with a bounded `EPERM` retry, which a live run needed |
| 2 | ⚠️ **Only with the right library.** `fs.watch` recursive reported **1 distinct path for 400 file creations, three runs of three, with no error.** chokidar: 400/400 every run. | **#73** — chokidar, `awaitWriteFinish` off, and events are *hints*, never the #16 change feed |
| 3 | ❌ **No — the partition does not hold.** Two processes on disjoint regions of one file: **CORRUPT 5 of 5** non-atomically; **lost updates 4 of 5** even when both wrote atomically; compare-and-swap narrowed it and did not close it. Lockfile and sidecar each held 5 of 5. | **#31 reopened**, locking un-rejected, successor decision in Open questions with a leaning |

**The one that reshapes something:** check 3 did what the step said it might — it reopened a Rejected
item. #31's "partition, don't lock" was intent, not mechanism: neither writer can change its own region
without rewriting the whole file, so the regions are disjoint in intent and identical in operation.
Choosing the successor (lockfile vs sidecar) was a decision with a #4 consequence, ~~owed by step 5~~ —
✅ **taken 2026-08-18 as #78, the lockfile**, ahead of that deadline. Both candidates were mechanically
safe, so the spike could not choose; the sidecar's reconciliation ambiguity did.

**Check 0, which wasn't on the list.** Building #70's resolver against a real consumer layout —
including a `<toolRoot>/planning-content/` holding another project's manifest — demonstrated the trap
#70 was reasoned from. That's a rehearsal of the fixture test 0(d) owes at step 5, and the resolver is
the one piece of this spike worth re-reading before writing the real one.

⚠️ **Two caveats recorded rather than buried.** The `fs.watch` result is Windows-specific
(`ReadDirectoryChangesW` buffer behaviour) and re-measuring on macOS/Linux is owed before anyone calls
the watcher cross-platform. And check 3's contention rate — 120 writes in about a second — is far above
anything real; that makes the loss *rarer* in practice, not absent, which is worse to discover.

✅ **`D:\spikes\watcher` deleted 2026-08-17**, once the answers above were in notes.md.

---

<details>
<summary>The step as written, before it ran</summary>

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

⚠️ **Watch what the spike binds to.** #70 now fixes how the content root is found, and this is the
first code that has to find one. Even throwaway, resolve it the #70 way rather than hard-coding
`./planning-content` — a spike that hard-codes the dogfood path is a spike that answers its three
questions against a layout no consumer has.

⚠️ This is the one spike where **the platform is part of the question.** Development is on Windows;
file-event semantics differ enough from macOS/Linux that "it works" here and "it works" is not the
same statement. Record which it was.

**Where the answers go:** same as step 1 — notes.md, with numbers. Check 3 in particular can reopen a
Rejected item, which is the sort of thing that must not live only in a terminal.

</details>

---

## 2a + 2b. Two verification spikes — hours, not days

_Added 2026-08-18 from the review document; recorded as the amendment to **#76**. Neither is a design
question any more. Each is one binary result, each is already owed, and each is #80's second branch:
not blocking, but expensive to be wrong about._

⚠️ **#80 requires a branch-2 spike to be bounded before it starts, not bounded by good intentions.**
Both below carry all three: a narrow question, observable pass/fail criteria, and a stopping condition.
**Stopping condition for both: the table's last row is observed, either way.** A result of *no* is an
answer and ends the spike — it does not license exploratory engineering toward a fix. The fix is a
decision, made afterwards, with the answer in hand.

### 2a — Project trust ✅ answered 2026-08-18 — it works, and it is causal

_Full write-up in notes.md under "RUN 2026-08-18". `#67(a)` is now measured rather than documented._

⚠️ **`D:\spike-pi-trust` was already gone** — deleted at some point after the note below was written,
so the "run it in the existing environment" plan was not available. Rebuilt as a minimal fixture at
`D:\spikes\trust-verify`: one package, one extension, one custom tool. Same shape, not the same files.

**Preconditions were clean, which matters more than usual here:** `defaultProjectTrust: "never"`, and
`~/.pi/agent/trust.json` **did not exist at all**, so no decision on any parent path could confound
the result.

**The observable is upstream of the model** — the extension writes a marker at *load* time, before
`session_start` and long before inference. The `llamacpp` provider was down for every run and every
session still completed normally, which is check 1's silent failure reproduced by accident and exactly
why the marker isn't read from model behaviour.

| run | `~/.pi/agent/trust.json` | `--approve` | extension loaded |
|---|---|---|---|
| 1 | file absent | no | ❌ |
| 2 | file absent | **yes** | ✅ |
| 3 | `{"D:\spikes\trust-verify": true}` | no | ✅ |
| 4 | `{"D:\spikes\trust-verify": false}` | no | ❌ |
| 5 | file absent (removed) | no | ❌ |

**Runs 4 and 5 are why this is an answer rather than a coincidence.** Run 3 alone shows only that tools
appeared after a file was written. Removing the entry reverts the behaviour, and flipping it to `false`
reverts it too — so the recorded decision is *causal*. Run 2 is the fixture control.

**The format**, which was the unverified part: a flat JSON object mapping **canonical directory →
boolean** (`realpathSync(dir)`, so `D:\spikes\trust-verify` on Windows), keys sorted, two-space
indent, trailing newline. Closest decision on the current-or-parent path wins. A #49 setup step writing
this is a dozen lines.

**One result worth more than the yes/no:** run 4 turns #67's own argument from an assumption into a
result. The case against `--approve` was that a recorded decision is one the PM "can read and delete."
An explicit `false` is honoured — **declining works, and it survives.**

⚠️ **#67(b) is untouched and is now the whole of what's left.** Nothing detects a child that came up
without our typed tools, and every failing run above completed normally with no error anywhere.

⚠️ **Methodological note.** The first attempt at run 4 wrote an empty transcript — the process was
killed by a harness timeout before pi produced anything — and its "extension absent" would have read as
a clean negative. It was re-run. **An absence is only evidence once you can show that the thing which
would have produced a presence actually ran**; every row above has a same-size transcript for that
reason.

<details>
<summary>The step as written, before it ran</summary>

#67 chose "the setup script records the PM's trust decision" over `--approve`, for good reasons that
still hold. **The mechanism it chose was never run.** Three commands were executed on 2026-08-15
(default → no extension · `--approve` → loads · `-e <path>` → loads); writing
`~/.pi/agent/trust.json` was not one of them. It comes from `security.md`, read and not run.

| | Step | Confirm |
|---|---|---|
| 1 | Clean project, restrictive `defaultProjectTrust`, `pi install -l` | — |
| 2 | Launch a non-interactive child | typed tools **absent** |
| 3 | Write the trust entry **exactly as the setup script would** | — |
| 4 | Launch the same child | extension loaded · custom tools registered · **no `--approve`** |
| 5 | **Remove the entry**, launch again | reverts to untrusted |

⚠️ **Step 5 is the control and it is the one that gets skipped.** Without it, a child that loads for
an unrelated reason — a stale global setting, a parent-path decision already sitting in `trust.json`,
an inherited environment — reads as a pass.

**If it fails:** nothing architectural. Both fallbacks are already proven on this machine, and the
loss is a setup step.

</details>

### 2b — Skill overrides ✅ answered 2026-08-18 — **outcome A, our path wins**

_Fixture at `D:\spikes\override-verify`. Full write-up in notes.md under the 2b RUN block._

**The observable was provenance, not behaviour.** `before_agent_start` exposes
`systemPromptOptions.skills`, each entry carrying `filePath` / `baseDir` / `sourceInfo` — so the probe
recorded **which file Pi loaded**, upstream of the model, and read the marker off that path.

| run | override at `planning-content/skills-overrides/` | skill Pi loaded |
|---|---|---|
| 1 | absent (no `skills` entry in settings) | `PACKAGED` ← `pi-package/skills/…` |
| 2 | `OVERRIDE` | **`OVERRIDE`** ← the override path |
| 3 | edited to `OVERRIDE-V2` | **`OVERRIDE-V2`** ← same path |
| 4 | files deleted, settings entry left in place | `PACKAGED` ← `pi-package/skills/…` |

Runs 3 and 4 make it causal: the loaded body tracks edits, and removing the override brings the
packaged skill back, so it was **shadowed and recoverable**, not broken. Exactly one `plan-check` was
loaded in runs 2 and 3 — replacement, not coexistence.

⚠️ **The prediction this refutes was mine, and drawn from the shipped docs.** Check 6's caveat reasoned
from `skills.md`'s location list (Packages before Settings) plus "collisions keep the first skill found"
and concluded a settings-registered override would lose. **The listing order is not the precedence
order.** #33 stands as written; the customization story can be documented.

⚠️ **Not tested, and deliberately so — #80 branch 3.** Relative precedence between
`planning-content/skills-overrides/` and `.pi/skills/` when both hold the same skill. That control
existed to separate "precedence is broken" from "our path isn't in discovery," and neither turned out
to be true. **The product does not currently create that configuration**, so testing it now would be
the premature-architecture half of #80. **Reopen condition:** the first design in which both locations
can hold the same skill name — most plausibly a setup step that materializes overrides into
`.pi/skills/`.

**Side finding that closes a step-1 loose end.** Every run hung — nothing emitted, every directory,
including 2a's fixture and an empty one — **until stdin was closed** (`< /dev/null`). That is the
inherited-stdin bug from the spike's `delegate.ts`, reproduced with no delegation code involved. Step 1
applied two fixes together and recorded that which one mattered was unknown. **It is the stdin half**:
`stdio: ["ignore", "pipe", "pipe"]` is required however the child is spawned. And it raises the value
of the spawn timeout, because the failure is a *silent indefinite hang* — a child that never speaks
looks exactly like one that is thinking.

<details>
<summary>The step as written, before it ran</summary>

Check 6 proved precedence exists — from `.pi/skills/`, which is one of Pi's own discovery locations.
**`planning-content/skills-overrides/` is not.** It would be registered through the settings `skills`
array, and in the documented discovery order settings come *after* packages; since collisions "warn
and keep the first skill found," an override registered that way plausibly **loses**.

| | Outcome | What it means |
|---|---|---|
| A | The override wins | #33 stands as written |
| B | The packaged skill wins | Setup materializes overrides into `.pi/skills/`. #33's *location* changes; its promise survives |
| C | Some third loading path gives the right precedence | Record that as the shipped mechanism |

</details>

---

## 3. Four schemas, not sixteen

⚠️ **Step 2 left a constraint here, which is why it ran first.** #72: the first typed tool writes
temp-file-plus-rename with a bounded `EPERM`/`EBUSY` retry, never truncate-in-place. That is a property
of the first one written, not a retrofit across four. #31's successor is *not* owed here — it's owed at
step 5, when the app first writes a status field.

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

### ~~Decide these two before schema one~~ ✅ both closed 2026-08-18

Full reasoning is in notes.md, which is canonical — these were being tracked here in a running order
whose own header says decisions don't live here.

- **What the schemas are written in → #74. JSON Schema is the source of truth; TypeScript types are
  generated from it.** #47's third caller decided it: the lint runs in a Pi extension hook inside a
  non-interactive child with no build step, and two of the three callers are not the Next.js app.
  Materiality (#61) rides in a custom keyword; cross-field rules JSON Schema can't express go in the
  lint. Zod lost narrowly, not badly.
- **What a trace link to a non-activated type does → #75. Permitted but unresolvable**, reported by
  the lint at *advisory* weight, resolving itself when the type is activated. Pointing at a
  non-activated type is the normal state of any project using fewer than all sixteen, so a hard error
  makes the common case unusable and projecting the field away makes every later activation a
  migration.

⚠️ **#75 lands the first real advisory rule on the thinnest class.** `advisory` is the one of #61's
four these four types barely exercise, and the one already parked as needing per-*edge* declarations.
Don't read "the schemas work" as covering it.

### Proving the rest of step 3 — one artifact first, then clone

_Ordering agreed 2026-08-18. **Do not build the tools across all four types at once.** Prove the whole
loop on `requirement` alone, then clone it — a bug in the shared machinery found once is a bug found
four times if the machinery is written four times first._

```
#84 resolver → requirement typed tool → validate → #83 allocate → #78 lock
   → #72 atomic write → generated requirement template (#43) → lint the result (#46/#47)
```

✅ **`#84` and the `#70`/`#86` resolver are done** — `lib/schema-resolver.mjs`, `lib/content-root.mjs`,
21 tests. Built as their own modules **before** the lint, deliberately: the lint is the obvious place
to write resolution and that is exactly the risk — template generation and the renderer would then
depend on lint internals, which is #47's problem one level further down.

⚠️ **Then feed the same loop malformed artifacts on purpose**, and confirm the lint catches what the
typed tool prevented. That is what distinguishes **prevent** from **detect** in the four-layer defence
model — two layers that look identical while everything is working, and are not.
⚠️ **The malformed-artifact pass must fail at three layers, not one** _(added 2026-08-18)_. Otherwise
"prevent, detect, gate" is three names for JSON validation. Feed each deliberately:

| Layer | Example | Caught by |
|---|---|---|
| **Schema-invalid** | no `statement`; `derivedFrom` a bare string; unknown property | the **typed tool** would have prevented it — so this proves the lint still catches what arrives another way |
| **Schema-valid, structurally inconsistent** | `data/requirements/DEC-0004.json` · `REQ-0007.json` holding `"id": "REQ-0008"` · a trace link to an ID nothing allocated | **only the lint** — the schema cannot see a filename, a directory, or another file |
| **Schema-valid, structurally valid, incomplete for the stage** | every requirement present and legal, but stage 2's exit criterion unmet — a requirement nothing can test | **only the gate** (#46's two boundaries) |

The three layers look identical while everything is working, which is precisely why each needs a
deliberate failure of its own to prove it exists.


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

## 5a. Pressure-test the evidence types against the substrate — **before** the skeleton

_Reordered 2026-08-18 (#76's third amendment, #95). This used to come after the skeleton._

Implement `assertion`, `evidence` and `runbook-step` and run them hard against everything step 3
settled: #82's primitives · #83's allocation · #84's resolution · #86's wrap-don't-model rule ·
#87's one-file-per-artifact · #88's create contract · #89's lint families.

**Expect the conventions to move.** #38 already records that these three stress the substrate in ways
the first four cannot — identity across revisions, evidence attachment, and **confidence as a computed
rather than authored field**, which nothing in `requirement`/`decision`/`schema`/`api-spec` exercises at
all. If they do not move anything, that is a result worth being suspicious of.

⚠️ **Why this moved ahead of the skeleton.** #80 branch 1, in its strengthened form: the skeleton is
where these conventions get poured into a renderer, a watcher and a status write-back. Building it
first is a commitment made before the types most able to falsify it exist. Step 4's stage 2 pushed the
same way independently — **seven of fifteen requirements landed on the evidence loop**, derived from the
intake rather than from this architecture.

---

### What 5a already has to build against (#96)

`confidence` is **derived, not stored**. One shared derivation produces an *effective assertion view*
— assertion + evidence links + each evidence record's source/experiment/environment — consumed by the
gates, the renderer and the handoff. Two axes, never one:

| Axis | Values | Answers |
|---|---|---|
| `verdict` | `unresolved` · `supported` · `refuted` | what did the examination conclude? |
| `confidence` | `unverified` · `source-supported` · `experimentally-validated` · `environment-matched` | how well was it examined? |

⚠️ **The pressure test must include refuting evidence.** A rung on its own is ambiguous —
`experimentally-validated` is compatible with the claim being **false** — and testing only the
supporting path is how that ambiguity survived being written down.

**Both open items are now closed (#96, #82), and each becomes a required fixture rather than a note.**

**Verdict derivation, with applicability filtering first:**

| applicable evidence remaining | `verdict` |
|---|---|
| none | `unresolved` |
| support only | `supported` |
| refutation only | `refuted` |
| **support and refutation both** | **`contested`** |

⚠️ **Filtering before deciding is the load-bearing half.** Without it a stale record or one from a
mismatched environment manufactures a contradiction, and `contested` becomes noise nobody reads.
**`contested` blocks promotion into an instruction** (#57, #58). It may mean a modelling error, an
environment mismatch, stale evidence, or genuinely unsettled reality — **the system exposes the
condition and does not diagnose the cause**, because diagnosing it automatically would be guessing at
the moment the plan is least entitled to guess.

**Two fixtures 5a must contain, both of which fail silently if omitted:**

1. **Contradictory but equally applicable evidence must not collapse to a stronger rung.** The failure
   this catches is a `contested` assertion presenting as `environment-matched` — maximum apparent
   authority on a claim the evidence disputes.
2. **Relation names follow domain meaning, not shared target type.** `assertion.supportedBy` /
   `refutedBy` split; `requirement.evidencedBy` and `decision.evidencedBy` do **not**. A requirement
   states a desired condition and a decision records a choice — "refuting" either is a different act,
   not a mirrored one. Split a relation only when #41's test says something downstream must traverse
   the halves differently.

---

## 5b. Walking skeleton (#55), with the lint loop (#48) wired in early

Manifest → tracker view → one MDX doc rendering → status write-back → **the file watcher**.

⚠️ **Render an evidence-oriented artifact, not another easy catalogue type.** The point of doing 5a
first is lost if the skeleton then proves itself against `requirement` and leaves `assertion` and
`evidence` untested through the UI.

Everything the previous version of this step carried still applies — 0(d)'s fixture test _(✅ delivered
early, see #69's amendment)_, #78's lockfile for the status write-back, #79's boundary, and #48's
turn-end lint hook wired in **during** rather than after.

---

## 5c. Complete the evidence slice end to end

One assertion, carried the whole way: `requirement → assertion → research → evidence → validation →
confidence rung → runbook step → lint → render`. Immediately after 5b, not later.

---

## 6. Broaden the catalogue — **only after 5c passes**

_#76 constraint, unchanged by the reorder: broad catalogue expansion does not begin until the evidence
slice passes. What changed is only that the slice now happens around the skeleton rather than after it._

⚠️ **`schema` and `api-spec` typed tools live here, not earlier** (#95). They are implemented and
**not activated on this project** — this intake never asked for a data model or an API. They are still
owed for v1 catalogue completeness (#38), but owed to *future consumer projects*, so they rank behind
the activated evidence path. **Cheap is not a reason:** `decision`'s typed tool is the cheapest item on
the gate's worklist and is still not next.

⚠️ **The gate is a worklist, not a priority queue.** #94 made it report accurately what is absent;
nothing in it ranks anything. Priority comes from #80 branch 1 — what blocks the next implementation
*commitment* — which is what produced this ordering in the first place.

---

<details>
<summary>Step 5 and 6 as written before the 2026-08-18 reorder</summary>

## 5. Walking skeleton (#55)
Manifest → tracker view → one MDX doc rendering → status write-back → **the file watcher**.
The watcher is the whole integration surface between the two halves (#12), so a skeleton without
it doesn't prove the risky part — and by now step 2 has told you how it has to be built.

**Carry 0(d)'s outstanding half in here:** the fixture test that builds a consumer layout in a temp
directory — `.planning/` beside a sibling `planning-content/` — and asserts what #70 resolves. The
skeleton is the first code with a resolver to test, and until that test exists the consumer path is
still only exercised by consumers. _Step 2's check 0 rehearsed exactly this and it passed; it does not
count, because it ran in a throwaway directory that no longer needs to exist._

**#31's successor is #78, and this is the step that first depends on it** — the status write-back in
the line above *is* the app's first write into a file the agent also writes. Implement it as the row
states, in this order: **acquire lock → fresh read → modify → #72 atomic temp+rename → release lock.**
⚠️ **The fresh read goes after acquisition**, or the lock serializes stale writes rather than
preventing them — which reproduces the lost update the spike measured, behind a mechanism that looks
correct. #78 also lists what the implementation owes and calls none of it optional: bounded acquisition
retry · stale-lock detection · a crashed-writer path · owner identification · cleanup · and
Windows-specific behaviour, which #72 already proved is not theoretical.

⚠️ **What the lock does not buy you is #79.** #78 gives **write integrity**; #79 is **reasoning
freshness**, and it doesn't exist. A worker reads a dependency set, reasons, one member of that set
changes, and the worker commits output derived from the old one — cleanly, into a well-formed document
with resolving trace links and nothing reporting a problem. **A correct lock makes that failure harder
to see, not easier**, which is why the boundary is worth holding in mind precisely here, at the step
that first ships a lock. Out of scope; don't let it land as staleness being handled.

Wire #48's turn-end lint hook in **during** this step rather than after. notes.md already argues
it's plausibly the highest-leverage item in the document; it's also the thing that tells you
whether the four schemas in step 3 were the right four.

## 6. One evidence vertical slice — the loop nothing else touches

_Added 2026-08-18 from the review document; in **#76**'s amendment. Not the evidence catalogue. **One
assertion, carried the whole way.**_

Steps 3–5 prove the **authoring** loop: schemas, typed tools, templates, lint, tracing, rendering,
status write-back, the watcher. That is the right first target and it is real progress. It is also
**not the product's claim.**

> An authoring loop plus a working UI proves a sophisticated documentation interface for AI-generated
> planning. The claim is a plan that knows which of its statements are guesses, which are documented,
> which were tested, and which are safe enough to become instructions someone will run.

Nothing in steps 1–5 exercises the second sentence at all.

### The slice

```
requirement → assertion → research → source-supported evidence
  → validation task → sandbox run → observed evidence
  → confidence rung → planning decision → runbook step → lint → render
```

One assertion. Something real enough to be meaningful and cheap enough that **the workflow rather than
the infrastructure is what's under test** — if the experiment itself is hard, the slice is measuring
the wrong thing.

What it puts under load, none of which steps 3–5 touch: whether a rung is a property anyone can
compute consistently · whether the tier→rung table survives contact with a real run (#77 already made
its ceiling machine-dependent) · whether `n/a` with a reason (#45) is enough for a claim that *cannot*
be validated here · whether the lint's `runbook step → assertion → evidence → threshold` chain (#57,
#58, #59) is checkable rather than merely stateable · and whether the trace chain is legible to a
human once it has five hops in it.

### What each result is worth

- **It works and feels natural.** The most novel part of the design is real, and the remaining twelve
  types are pattern application.
- **It's awkward, redundant, or expensive.** Learned *before* sixteen schemas and nine stages harden
  around it — which is the entire point of doing this at step 6 and not step 12.

⚠️ **`assertion` / `evidence` / `runbook-step` are also the types most likely to break conventions
settled in step 3.** They stress ID identity across revisions, evidence attachment, and confidence as a
computed rather than authored field. Let them challenge the four-type conventions early; that is a
feature of this ordering, not a risk of it.

### The tension this ordering creates, stated rather than buried

Running the slice *after* the skeleton means step 3's schemas and trace conventions already exist when
the novel artifacts finally exercise them. That is acceptable and probably right — conventions need
something to be conventions *of*. **It is only right while those conventions are still treated as
revisable.**

> If the slice shows that `assertion`, `evidence` or `runbook-step` need trace semantics the first four
> did not anticipate, **the slice succeeded.** Change the conventions.

The failure mode is the opposite reflex: contorting the evidence model to fit whatever step 3 happened
to establish. That converts a finding into debt and wastes the step — you would have paid for the
experiment and then discarded its result to protect four files.

⚠️ **And a hard constraint from #76: broad catalogue expansion does not begin until this passes.**
Otherwise the slice is "next" on paper while twelve more schemas and the specialist contracts quietly
harden around an evidence model nobody has run.

---

---

</details>

---

## Why this order

**It is not a build sequence any more; it is an uncertainty-reduction sequence** _(2026-08-18)_. Each
step earns the right to make the next implementation commitment — which is #80 branch 1 applied to the
order itself rather than to individual questions:

> spikes remove mechanical uncertainty → schemas establish the authoring substrate → dogfooding tests
> the methodology → the skeleton proves the two halves can touch → **the evidence slice proves that what
> they produce is more than documentation**

That last boundary is the one the original five-step order left implicit. A manifest, a visual UI,
structured artifacts, file watching, typed writes and lint feedback could all work beautifully and
leave you with a sophisticated AI planning-document generator. **The skeleton proves the authoring
product. It does not prove the product thesis.**

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

**The two verification spikes are not a third phase.** They are stale-dated debts from step 1 — one
mechanism chosen but never run (#67's `trust.json`), one behaviour proved on the wrong path (#33's
override location). They sit before the schemas because they cost hours and get more expensive to run
the further the code gets from the spike that would answer them, not because anything waits on them.

**Where this stops, deliberately** _(revised 2026-08-18)_. The order used to end at the first point the
two halves touch, and it named the evidence loop as the thing still ahead of it. **Step 6 changes
that** — one assertion carried the whole way, which is the smallest thing that tests the product's
actual claim rather than its authoring machinery. What remains outside: the three specialist contracts,
the other twelve artifact types, the sandbox tiers beyond whatever the slice needs, and the runbook as
a produced artifact. **Step 6 is the end of the beginning.** Step 5 is now the end of the part that
would have looked finished while proving the less interesting half.


