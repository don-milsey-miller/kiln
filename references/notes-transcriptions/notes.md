# Visual Project Workflow — planning scratchpad

> This is a **thinking document**, not a spec. Write in it. Contradict it.
> Anything marked _(draft)_ is a first guess meant to be argued with.
> Last worked on: 2026-08-18

> **Provenance.** This file is canonical. The three documents beside it —
> `Audio Transcription 1.md`, `Audio Transcription 2.md`, and
> `ai_project_planning_consolidated_vision.md` — are **frozen source material**,
> consolidated into this file on 2026-08-13. Don't edit them; they're the record of
> how the thinking got here. Everything they contain is either folded in below, sitting
> in **Parking lot**, or listed in **Rejected** — see **Coverage** at the end of this
> document for the section-by-section audit.
>
> **A fourth document arrived 2026-08-18** — `Visual Project Workflow — Conversation Review
> and Implementation Readiness Notes.md`. It is **not** source material of the same kind: it
> was written *after* this file, as a review of it, so it restates rather than supplies most
> of what it contains. Folded in the same day. Four things in it were genuinely new and are
> now **#78** (the #31 successor), **#79** (semantic staleness), **#80** (the triage rule)
> and an amended **#76** (two verification spikes and an evidence vertical slice added to the
> build order). The rest was already here. It stays useful as a second reading of the same
> material by someone who had to reconstruct it — which is roughly the test a future
> maintainer will apply.
>
> Worth stating up front, because it's the single most useful thing that fell out of
> reconciling them: the vision doc's §41 declares *"canonical source of truth —
> unresolved"* and lists Markdown / YAML / JSON / relational DB / document DB /
> event-sourced / hybrid as live options. **That question is answered here** — principle 2
> plus Decided #13 and #19 settle it as *data files are canonical, documents are
> renderings*. Several more of the vision doc's §48 "ten most important MVP decisions"
> were likewise already closed in this file. The vision doc was written from the
> transcripts without this file in view; where the two disagree, this file wins.

---

## North Star

A **clonable planning system**. Drop it into a new project directory, run one setup command, and get a local web app that walks me through the project planning lifecycle from raw user intent to a finished plan the team can execute on.

Each stage of the pipeline produces a **visual document** — not a wall of markdown, but a rendered page with interactive API specs, pan/zoom wireframes, and schema diagrams. The web app is the interface to the planning process itself: I can see at a glance which stage I'm in, what's blocked, and what's left to decide.

**And the plan has to be more than well-formatted guesswork.** Where the plan rests on a technical claim that could be wrong, the system researches it against current sources and — when it matters enough — proves it in a disposable environment before that claim is allowed to carry weight. The handoff ships with the evidence attached.

"Done" for v1 = I can clone this into a real project, work an actual plan end to end in the browser, and hand the team something they can execute on without coming back to me for missing pieces.

---

## The user journey

_The canonical narrative. When a design decision is unclear, check it against this._

1. I create a new directory on my dev workstation.
2. I clone this **capabilities repo** into it.
3. I run a **build script** that initializes the project and brings the web app online locally.
4. The repo ships a **pre-configured Pi agent environment** — the orchestrator plus its specialist agents, skills, and extensions. Nothing for me to assemble.
5. I configure **my LLM provider of choice** — Claude, Codex, Ollama, vLLM, llama.cpp. This is the only setup step that's actually mine.
6. The orchestrator and I **work through each phase together, interactively** — building out each document, working the decision points, gaps, and roadblocks. It delegates research and validation work to specialists; I only ever talk to it.
7. Documents get updated **by both of us**. I review and interact with them in the web app. That's what makes the doc process engaging instead of a slog.
8. When we've both validated the documentation is complete, it's **passed to the implementation phase** — which is outside the scope of this project.

**What this reframes:** the agent isn't an external tool I happen to use alongside this repo. **The agent configuration IS half the product.** The repo is roughly 50% web app, 50% shipped Pi package. Both halves have to be built.

**And step 7 is the hard part.** Two writers on the same files at once means the app needs live file watching, not just build-time reads.

⚠️ **The 50/50 in #11 was budgeted before #26.** A single agent with nine skills is meaningfully less work than an orchestrator plus three specialists with contracts, scoped context, and routing. The split is probably closer to 40/60 now, and the agent half is the one that's never been built before.

_Softened 2026-08-14:_ the Pi re-verification found an **official `subagent` example extension** to adapt (#65), so the delegation runtime is no longer something to originate. 40/60 is still the right instinct; "never been built before" now applies to the *contracts and routing*, not the plumbing.

---

## Decided

_#1–13 settled 2026-08-12, #14–22 settled 2026-08-13, #23–64 settled 2026-08-13 during the consolidation, #65–66 settled 2026-08-14 by the Pi re-verification, **#67 settled 2026-08-15 and #68 settled 2026-08-16 by the trust spike — the first rows here settled by running something rather than by reading or arguing** — #69–71 settled 2026-08-16, closing next-steps.md's 0(c) and 0(d)._
_Don't re-litigate these without a reason — put the reason in **Rejected** below._
_Numbers are stable and never reused. The grouping below is for scanning; **#N** references throughout this document still resolve._

### Product & scope

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Reuse model | **Clonable template, one clone per project.** `mkdir new-project` → `git clone` this repo → run setup script → work the pipeline. | Isolated content per project, simple routing, no multi-tenant complexity. |
| 6 | MVP scope | ~~A planning tool, not a PM execution tool.~~ **Amended 2026-08-13 → see #23, #24.** A planning *and validation* tool. Zero → a complete, evidence-backed project plan **including a runbook** that can be handed to the appropriate team members to execute on. | The original line ("anything that assumes work has started") turned out to be cutting in the wrong place — it excluded validation, which happens *before* work starts and is the thing that makes a plan trustworthy. |
| 14 | Pipeline shape | **Configurable per project.** The 9 stages are a *guide*, not a fixture. Once a given project's stage set is determined, it is honored. | Projects differ. A rigid spine eventually fits some project badly, and the cost of that is a half-filled stage nobody believes in. |
| 15 | Gate model | **Asymmetric.** The agent may write across *any* stage. The human PM is focus-locked to the *current* stage and advances only when exit criteria are met. | Data legitimately flows backward between stages; a human jumping around loses the thread. See "The gate model" below. |
| 16 | Revisits | **It's a cycle, not a pipeline.** Upstream stages can reopen. Every cross-stage change raises a notification to the PM naming the specific add / edit / delete. | Discovery reopens intake in practice. Silent upstream edits are how a plan rots without anyone noticing. |
| 17 | Budget + comms plan | **In, at stage 9.** Budget is *assembled* in 9 from stage 8's estimates; the communication plan is *authored* in 9. | Both were missing from the original 9 stages. A plan handed to a team of people plausibly needs both. |
| 18 | Role model | Roles are **discovered from stage-8 task assignments**. Agent recommends; **PM has final approval**. Assignment is **by role, never by name**. | Placeholders survive the human/agent ambiguity (#8) and keep the template generic. No roster to maintain. |
| 23 | Research, validation & evidence | **In scope for the MVP.** Real internet research, sandboxed technical validation, and an evidence/confidence model are first-class parts of the product, not v2 features. The pipeline runs **through runbook production**. | They directly support the MVP. A plan that can't check its own technical claims produces polished documents carrying unresolved implementation risk — which is exactly the failure the transcripts were recorded about. |
| 24 | Scope terminus | **The MVP ends when the runbook is handed over.** In: producing a validated runbook. Out: executing it, ingesting execution output, monitoring step state, remediation loops, lessons-learned promotion, cross-project or organizational knowledge. | The old line was "work hasn't started." The new line is sharper and sits somewhere else: *we produce the instructions; we never watch anyone run them.* See "Scope" below. |
| 25 | Where validation happens | **Cross-cutting, not a stage.** Validation tasks are raised on demand from stage 3 onward, whenever a load-bearing assertion is unproven. There is a **validation gate on stage 6** — Risk + Feasibility can't exit while a load-bearing assertion sits below its required confidence. The **runbook is produced in stage 9**. _(draft — see "The pipeline")_ | A sequential validation stage would mean a stage-3 finding waits four stages to get tested, and the design work in stage 5 proceeds on unproven ground in the meantime. Demand-driven is both more useful and cheaper. Keeping it off the spine also preserves every stage number in this document. |

### Change & cascade

| # | Question | Decision | Why |
|---|---|---|---|
| 60 | Cascade propagation | **One hop, re-evaluated at each hop.** When X changes, only artifacts tracing *directly* to X are flagged. Transitive dependents are flagged only when their own parent actually moves. The full downstream blast radius stays viewable on demand — it just isn't flagged. | Transitivity was the real cause of "one edit turns six stages yellow," not severity. An acceptance criterion depends on the design component, not on the requirement behind it — whether it needs review depends on whether the component actually moved. Most chains die at hop one. |
| 61 | Materiality | **Declared per field in each artifact's schema**, not judged per diff at runtime. Four classes: `structural` (id, type, trace links) · `semantic` (the payload) · `advisory` (priority, ordering, estimate) · `cosmetic` (rationale, notes, prose). | Size and materiality are uncorrelated — `must` → `may` is one word and total; three paragraphs of clarification can change nothing. A severity *score* was never going to work. Principle 2 makes fields declarable, so materiality becomes deterministic and rides on schema work already on the critical path. ⚠️ **This row survived its first contact with a real schema, but only because a field got split** _(2026-08-18, #82)_. `status` as one field would have needed `superseded`/`retired` to cascade and `draft → approved` not to — i.e. **materiality judged from the transition, which is judged from the diff, which is the thing this row exists to avoid.** Splitting it into `reviewStatus` (advisory) and `lifecycle` (structural) kept the declaration per-field and per-schema. **Generalise the near-miss: a field that needs two materiality classes is two fields.** Reach for a transition-sensitive `x-propagation` annotation only when a genuine single field resists splitting — and treat that as an amendment to this row rather than a detail, because it weakens "declared once" to "declared once, sometimes per transition." |
| 62 | Cascade resolution | **The agent drafts the downstream edit and attaches it to the flag; the PM approves.** Nothing lands unapproved. Where no change is needed, the agent says so and the PM confirms that. | The PM reviews a concrete diff rather than an open question, and the agent is the party holding the context for *why* the upstream change happened. ⚠️ Rubber-stamping is the risk — see Risks. |
| 63 | Feed vs activity log | **Two streams.** The change feed carries only what needs a decision — amendments and cascade reviews. Cosmetic-class edits go to a separate activity log that's always available and never prompts. | #16's whole point is that the PM can trust the feed. A feed containing "note reworded" is a feed the PM stops reading, which costs the mechanism everything it was built for. |
| 64 | Cascade and evidence | **Upstream changes never invalidate evidence, and cascade never auto-triggers a validation run.** A changed requirement can make an assertion *irrelevant*; it can't make it *untrue*. Relevance gets re-checked; the evidence stands. | Evidence goes stale from environment change, not document change. And auto-triggered re-validation would let a one-word requirement edit spend money in tier 3 (#56). |

### App & repo shape

| # | Question | Decision | Why |
|---|---|---|---|
| 2 | Runtime | **Local only** (`npm run dev`) for the *planning* app — with one carve-out, see #7. | Removes all static-export constraints — and is what makes #3 possible at all. |
| 3 | App role | **Hybrid.** Document *content* is authored as MDX (by me or by the agent). The app writes back *lightweight state* — phase status, checkboxes, decisions, notes. | Content deserves a real editor + git. Status toggles deserve a click, not a file edit. |
| 4 | Phase state | **Two tiers.** `project.yaml` manifest defines the pipeline *shape* (which phases exist, order, gates) — and, from #39 and #56, the project's *capability* declarations: which artifact types and which sandbox tiers are active. Per-doc frontmatter carries *status*. | Shape and capability are project-level; status is document-level. Keeping them separate stops the manifest from becoming a dumping ground. |
| 5 | Stack | Next.js + MDX. | Given. |
| 11 | Repo shape | **~50% web app, ~50% Pi package.** _(re-estimate pending — #26 grew the agent half; see the warning under the journey.)_ | Falls out of the journey. Easy to under-budget the agent half — and #26 makes that easier still. |

### Agents & runtime

| # | Question | Decision | Why |
|---|---|---|---|
| 9 | Agent runtime | ~~One pre-configured Pi coding agent.~~ **Amended 2026-08-13 → see #26.** Pi is still the runtime; what ships on it changed. | Pi's package and skill primitives survive the change intact; the **session** primitives turned out not to be the delegation mechanism at all — re-verified 2026-08-14, see #28, #65, #66 and "Pi integration". |
| 10 | Provider | **PM's choice** — Claude, Codex, Ollama, vLLM, llama.cpp. Provider-agnostic by design. | Pi already supports this. But it means skills must work on weak local models too, not just frontier ones. |
| 12 | Chat surface | **v1: `pi` runs in a terminal beside the browser.** App watches files and hot-reloads. Embedded SDK chat deferred to v2. | Proves the pipeline and the documents first. Keeps pi's TUI approvals, diff review, and commands for free instead of rebuilding them. **Survives #26 intact** — that terminal is now the orchestrator, and the specialists run underneath it. The PM's surface doesn't change. |
| 26 | Agent architecture | **An orchestrator plus three specialists** — research, validation, planning. Each gets its own instruction file and an explicit contract: inputs · responsibilities · allowed tools · forbidden actions · output format · exit criteria · escalation conditions. | Bounded roles with scoped context beat one agent holding everything. It's the mitigation for role leakage and context-window overuse, both of which are on the risk list. See "The agent roster". |
| 27 | Context routing | **Each specialist receives only what its task needs**, never the whole project history. | Context pollution is what makes a general-purpose agent drift into the wrong role halfway through a task. |
| 28 | Session model | ~~Per-stage sessions forked from a shared project-context session.~~ **Rewritten 2026-08-14 after Pi re-verification.** **The orchestrator owns the single persistent, user-facing project session. Specialist work runs in isolated child sessions with an explicit task-scoped payload (#27) and a role-specific system prompt.** Stage sessions may be persisted separately where the transcript is worth keeping; **session forking is a lineage / review mechanism, not the mechanism that enforces specialist context scope.** | The old row made one decision do two jobs — historical organization *and* #27's isolation — and Pi's `fork()` turns out not to do the second. `AgentSessionRuntime.fork()` **replaces** the runtime's active session rather than spawning a concurrent worker, and a fork *inherits* the source branch's context, which is the opposite of what #27 asks for. A fresh child with a bounded payload satisfies #27 natively. See "Pi integration". |
| 65 | Delegation mechanism | **A `subagent`-style typed tool, registered by a shipped extension.** The orchestrator calls it with a task and a role; the extension launches an isolated child Pi process (`--mode json -p --no-session`) with that role's model, tool allowlist, and system prompt. Not a Pi core primitive — it's ours to ship. | Pi deliberately has no built-in sub-agent feature, but the SDK supports it and the Pi repo carries an **official `subagent` example extension** that is very nearly this architecture already — parallel and sequential specialist tasks, per-specialist model and tools, separate context per child. #26 survives without inventing the runtime, which is the single biggest cost reduction in this document since the consolidation. |
| 81 | The specialist spawn contract | **Three defences, in order, on every delegated child — and a specialist's output is not accepted until all three have passed. (1) `stdio: ["ignore", "pipe", "pipe"]` — stdin closed, never inherited. (2) A bounded spawn timeout. (3) A capability check: the child must prove the typed tools that specialist's contract is enforced by are actually registered (#67b).** Only then is its output eligible to be used. | **Each defence answers a different silent failure, and all three were observed rather than imagined.** (1) **Waiting on stdin** — `pi -p` reads a prompt from stdin when it doesn't get one, so an inherited pipe nobody closes blocks the child before it starts. Isolated on 2026-08-18 during step 2b: every invocation hung, in every directory including an empty one, until `< /dev/null`. This was previously confounded with the `shell: true` fix applied beside it; **the stdin half is load-bearing on its own.** (2) **A hung child** — the failure above produces no error, no exit and no output, which is *indistinguishable from inference latency*. Without a timeout the orchestrator waits forever on a child that will never speak. (3) **A normally-completing child with the wrong tool environment** — #67's original finding, re-observed in every failing run of step 2a: the session completes, `turn_end` and `agent_end` fire, and the typed tools were never there. ⚠️ **The pattern across all three is the same and it is why they belong in one row:** the child's silence or success is not evidence about the child's *environment*. Two of the three look exactly like a healthy specialist from outside, and the third looks like a busy one. **Extends #65** — that row describes how a specialist is launched; this describes what must be true before anything it returns is believed. _(Recorded 2026-08-18, after both verification spikes.)_ |
| 66 | Where specialist definitions live | **Inside the shipped package at `.planning/pi-package/agents/{research,validation,planning}.md`**, discovered by our delegation extension — *not* copied into each project's `.pi/agents/`. Each file is frontmatter (`name` · `description` · `tools` · `model`) plus a body that becomes that role's system prompt. `AGENTS.md` carries **shared project invariants only**; role-specific instruction never goes in it. | The roster is *tool configuration*, so it belongs in the tool half (#20), and shipping it in the package means it updates with `git pull` (#50). Keeping `AGENTS.md` free of orchestrator-specific behaviour also matters mechanically: Pi's own example launches children *with* normal context-file discovery, so whatever is in `AGENTS.md` reaches every specialist. Harder separation is available (`--no-context-files`, or an SDK `ResourceLoader` per child) if that turns out not to hold. |
| 67 | How specialist children get project trust | **Two halves. (a) The setup script asks once and records a trust decision for the project directory in `~/.pi/agent/trust.json` (#49). (b) The delegation extension detects a child that came up without our typed tools and fails the delegation loudly** rather than returning its prose. Explicitly **not** a hardcoded `--approve` on the spawn line, and not a global `defaultProjectTrust` change. | **The empirical half was settled by running it, 2026-08-15** — the first row in this table established by running rather than arguing. Without trust, a non-interactive child comes up with no project package, therefore none of our typed tools, and **does not error**: the session completes normally and the model answers in prose. **The design half was amended the same day.** The first version of this row hardcoded `--approve`, on the grounds that it needs no setup step and cannot be forgotten. That optimizes for fewer moving parts and pays in a permission the PM never granted: `--approve` means our extension overrides the PM's own `defaultProjectTrust` — silently, for every child, permanently, with no way to decline short of editing our code. A recorded decision keeps the grant where Pi puts it: made once, by the PM, in a file they can read and delete, as an explicit exception rather than a standing override. **And the fear that motivated the row is closed by detection, not by approval** — checking whether the child has the tools is a handful of lines and closes the hole directly, which is the better fix regardless of how trust gets granted. ⚠️ **Amended 2026-08-17 — half of this row is measured and half is not, and the row did not say so.** What the run established is that **trust is the variable**: the extension failed to load by default and loaded via `--approve` and via `-e <path>`, all three run. ~~**Writing `~/.pi/agent/trust.json` was never executed.**~~ ✅ **Executed 2026-08-18 — see the second RUN block. (a) is now measured.** A trust entry written by a script makes a non-interactive child load the package and register the typed tools with no `--approve`; removing the entry reverts it, and setting it to `false` reverts it too, so the recorded decision is **causal**. The format is a flat map of canonical directory → boolean. **The `false` result also turns this row's central argument from an assumption into a result:** a recorded decision the PM "can read and delete" is only worth choosing over `--approve` if declining is actually honoured, and it is. **State the governance property in its strong form, because that is what was proven: approve, decline and revoke are all represented persistently and honoured mechanically.** The trust record is not an allow-list — it carries an explicit denial as a first-class value. `--approve` can express exactly one of those three. **And #49's implementation is no longer speculative:** the representation is canonical-directory-to-boolean, with the *canonicalized* path being the significant part. ⚠️ **(b) remains unwritten code, and 2a made it sharper rather than smaller** — every failing run above finished a normal-looking non-interactive session with the package absent and nothing reporting it. **State it as an invariant, not a check:** *a delegated specialist result is invalid unless the child proves the planning tool contract was loaded.* ⚠️ **"Some custom tool exists" is too weak a proof.** A child with *part* of the package loaded would satisfy it and still produce a well-formed false success, which is this row's original failure wearing a green tick. The delegation extension should verify a **capability signature** — at minimum the typed tools that specialist's contract is enforced by — before accepting any output from it. The cost of being wrong is bounded — both fallbacks are proven, and `-e <path>` is the more interesting one because it loads only the file we ship rather than granting the project blanket trust, though it likely buys typed tools without packaged skills (#33). |
| 69 | This repo *is* `.planning/` | **The tool half sits at the top level of this repo** — `app/` `pi-package/` `schemas/` `templates/` `stages/` are repo-root directories, because a consumer clones this repo *as* their `.planning/` (#1, #20, #32). `planning-content/` and `docs/plan/` at this repo's top level are **this project dogfooding itself**, not part of the tool. ⚠️ **Extended 2026-08-18 with `lib/` and `test/`, and the reason is #74's:** code shared by BOTH halves — the #70 resolver, #84's schema resolution — cannot live in `app/` or `pi-package/` without one half importing the other's internals. It is plain **ESM `.mjs` with no build step**, for exactly the reason JSON Schema won #74: the Pi extension hook runs in a non-interactive child, and a module that needs a TypeScript toolchain to be *read* is one that child cannot read cheaply. Tests use the Node built-in runner, so the shared layer adds no dependency of its own; `ajv` is a dependency of validation, not of resolution. | Recording a reading, not making a choice — the layout diagram below already places those directories inside `.planning/`, and #1/#20/#32 already make this repo the thing that clones into it. It gets a number because it was being re-derived from the diagram every time it came up, and because #70 is unreadable without it. |
| 70 | How the app finds `planning-content/` | **One rule, no search, no cwd:** `contentRoot = <toolRoot>/../planning-content`, where `toolRoot` comes from the app's own module location. **One documented override**, `PLANNING_CONTENT_DIR`, which is how this repo dogfoods. **Never** a fallback to `<toolRoot>/planning-content`. Missing content root ⇒ refuse to start, naming the resolved path and the override. ⚠️ **This resolver also owns containment for `payloadRef` paths (#86)** — see the amendment on #47. A schema pattern rejecting `..` is validation; only resolution against the canonicalised root is a boundary. One resolver, every caller — the watcher (#30), the lint (#47) and the typed tools all take the path from it and none of them joins its own. | **The fallback is the whole decision, and it is a trap that ships.** This repo commits its own `planning-content/`, so every consumer's `.planning/planning-content/project.yaml` exists and parses — as *our* manifest, for a different project. A resolver that tries `./` before `../` finds it, and the consumer authors against the tool's own plan with nothing anywhere saying so. Strict `../` also makes the dogfood case fail **loudly on the developer's own machine** if the rule is ever wrong, because `../planning-content` does not exist here — which is exactly what 0(d) asked for and what a per-checkout config file would not give. See below for the rejected alternatives. |
| 71 | Who writes the consumer's `.gitignore` | **The setup script (#49)**, appending a single marked block containing `.planning/` — created if the file is absent, never rewritten, and **recorded so it is never re-added**. Not a git repo ⇒ notice and continue, don't abort. | Nobody owned this: the `.planning/` line exists only in *this* repo's `.gitignore`, where it is inert, and #49's step chain didn't mention it. The record-and-never-re-add half is #67's principle applied again — a PM who deletes the line has decided to commit `.planning/`, and a setup script that silently restores it on the next run is overriding a decision the PM made, in a file they own. Idempotency keys on **"did we add our block"**, not on "is `.planning/` present". |
| 68 | Every role declares `tools:` explicitly | **A role definition with no `tools:` line is a lint error in our own roster (#66), not a role that inherits safe defaults.** Omitting the line does not narrow the child — it hands it the *default active set*, which includes `bash`, `write` and `edit`. | **Found by running check 2, 2026-08-16.** The allowlist itself turned out to be stronger than claimed (see #26 and the spike results) — but only when it is *present*. With no `--tools` the child's active set came back `read, bash, edit, write` plus every custom tool, while `grep`, `find` and `ls` were configured-but-inactive. So "active tools" is not "all configured tools", the default is *more* permissive than the safe-looking subset, and a forgotten `tools:` line is the one way a specialist silently acquires a shell. Cheap to enforce, expensive to discover later — the same shape as #67's silent failure, in the half of the roster we author ourselves. |
| 29 | Session persistence | **To disk under `.planning/`** — it's tool state, not content, so it doesn't belong in `planning-content/` (#20). Documents stay the real state. | **Losing a session must never lose a decision.** If it can, something that should have been written to a document wasn't. |
| 30 | App ↔ agent integration | **The file watcher on `planning-content/` is the mechanism** and must work on its own. Typed tools may additionally ping the dev server for instant feedback, but only as an optimization. ✅ **Survives the watcher spike, 2026-08-17 — with a platform caveat and a library constraint: see #73.** | #12 puts the agent in a plain terminal that knows nothing about the dev server. Anything that depends on the tools calling the app is broken by construction. |
| 31 | Two writers, one file | ~~**Partition, don't lock.** The app writes frontmatter and state fields; the agent writes body prose and data files. Where they must genuinely overlap, last-write-wins plus the change feed (#16).~~ ⚠️ **REOPENED 2026-08-17 — the partition does not hold.** Two processes editing disjoint regions of one file destroyed the document in 5 runs of 5, and lost updates in 4 of 5 even when both wrote atomically. **Locking comes back off the Rejected list**; the successor decision **is #78, taken 2026-08-18** — a short-lived exclusive lockfile around each read-modify-write, on top of #72. See "The watcher — what's actually true" for the measurements and #78 for why the lockfile beat the sidecar. | ~~Different regions of different files means there's nothing to clobber.~~ **That was the error.** Different regions of *different files* have nothing to clobber; different regions of the *same file* have nothing **enforcing** them, because neither writer can change its region without rewriting the whole file. The partition described intent, and the filesystem does not read intent. |
| 72 | Typed tools write atomically | **Every write to `planning-content/` is temp file plus rename — never truncate-in-place — with a bounded retry on `EPERM`/`EBUSY`/`EACCES`.** The rename retry is not optional on Windows. Readers get no debounce; they read on the event. | **Found by running check 1, 2026-08-17.** Against a non-atomic writer, **every single** naive read was a partial read — 120 of 120, and 0 of 40 revisions were ever observed whole. This is not a rare race to be defended against downstream; it is the *normal* case, and it arrives as unparseable frontmatter and truncated bodies. With an atomic writer the same naive reader saw 0 bad reads out of 57. The retry earns its place separately: renaming over an open destination raised `EPERM` on a live run, which without a retry is a hard crash in a typed tool. |
| 73 | The watcher is `chokidar`, not `fs.watch` | **`chokidar` (v5) with `ignoreInitial`, `awaitWriteFinish` OFF, and the temp suffix from #72 ignored.** Node's built-in `fs.watch({recursive:true})` is disqualified on Windows. Watcher events are **hints that something changed, not a log of what changed** — never derive the change feed (#16) from them. | **Found by running check 2, 2026-08-17, on Windows.** `fs.watch` reported **1 distinct path for 400 file creations**, three runs out of three, with **no error event** — a silent 99.75% loss, which is the #67 failure shape again in the app half. `chokidar` reported 400/400, three of three. `awaitWriteFinish` is off because it is a trap dressed as a fix: it does suppress partial reads, but by collapsing 40 revisions into 1 — the app goes blind for exactly as long as the agent keeps writing. #72 buys the same cleanliness with none of the latency. |
| 78 | Two writers, one file — **the successor to #31** | **An exclusive lockfile around each read-modify-write, on top of #72's temp-file-plus-rename.** The lock is **held only for the duration of a single read-modify-write operation, never for an agent turn.** The order is part of the decision, not an implementation detail: **acquire lock → fresh read → modify → #72 atomic temp+rename → release lock.** ⚠️ **The fresh read must happen *after* acquisition.** A writer that acquires the lock while already holding a snapshot taken before it has serialized nothing — the lock then orders stale writes instead of preventing them, which is the same lost update the spike measured, arriving through a mechanism that looks correct. Status stays in per-doc frontmatter, so **#4 is untouched**. **The guarantee this row provides is *write integrity*, and that is all of it.** It says nothing about whether a writer's reasoning rested on state that has since moved — that is **#79, reasoning freshness**, an independent guarantee that does not exist yet and is not a reason to reopen this row. ⚠️ Note the direction of the interaction: a correct lock makes #79's failure *harder* to see, because the write lands cleanly. Revisit only if implementation surfaces a concrete reason to prefer sidecars. | **Both candidates held 5 of 5 in the spike, so this was never an empirical choice** — it is a choice about where to put the complexity. The lockfile puts it in **one place, the write path**. The sidecar removes it from the write path and distributes it into every reader — tracker, renderer, lint, handoff, stage gates, change feed, migration — each of which must then combine two files to know one thing. ⚠️ **What decided it was the sidecar's failure modes rather than its cost**, and they are the kind that appear months later: document present with its state file missing · document renamed and the state file left on the old name · document reverted in git and the state file not. **The sidecar trades a concurrency problem for a reconciliation problem**, and reconciliation has no natural moment at which it is known to be correct. #34's argument against two hand-maintained descriptions of one pipeline is the same argument in a different domain. **The original objection to locking is answered, not overruled:** #31 rejected a lock *held while the agent is thinking*, which would make the app feel broken. Nobody is proposing that. ⚠️ **What the implementation owes** — none of it optional: bounded acquisition retry · stale-lock detection · a crashed-writer path · owner identification · cleanup · and Windows-specific behaviour, which #72 already proved is not theoretical. _(Decided 2026-08-18, ratifying the leaning recorded 2026-08-17 and the review document's recommendation. Closes the open question raised by the watcher spike's check 3.)_ |
| 79 | Reasoning freshness — **recorded, deliberately not built** | **#78 and this row are two independent guarantees, and only the first one exists.** #78 answers *can two writers commit without corrupting or overwriting the physical file?* This asks *can a writer commit work whose reasoning depended on state that changed after the work began?* The general shape, which is **not** limited to two agents: a worker reads a **dependency set D at revision N** → reasons, researches or designs → **one member of D changes** → the worker commits output derived from the old D → **the filesystem operation succeeds cleanly** → the result may be semantically obsolete. The parties can be agent/agent, human/agent, or a single long-running specialist task against a PM edit. **No mechanism is chosen and none should be yet.** The likely future shape is clear enough to write down without committing to it: *task begins → record the revision or hash of each load-bearing input · task completes → compare those inputs against current state · unchanged → commit normally · changed → mark the result stale and require re-evaluation.* ⚠️ **Whatever is built must track a dependency *set*, not the destination artifact.** A planning specialist may write `C5.1` while depending on `R1`, `R2` and `D4`; checking only `C5.1`'s revision would miss every real staleness case and report freshness confidently. | **The row exists to block one inference: "#78 solved concurrent editing, therefore concurrent reasoning is safe."** It did not. #78 gives **write integrity**. This is **reasoning freshness**, and it is unsolved. ⚠️ **A correct lockfile makes this failure *more* deceptive, not less** — the write succeeds cleanly, the document is well-formed, the trace links resolve, and nothing anywhere reports a problem. The reassuring mechanism sits in front of the silent one. **Not the same thing as cascade (#60–#64), and the distinction is exact:** cascade handles the consequences of an **accepted upstream change that already exists** — it flags what depended on it and drafts the downstream edit (#62). This concerns **work already in flight while that change lands**, and the cascade machinery has no idea which snapshot an in-flight specialist read. The two can even conflict: cascade may flag `C5.1` as needing review while a specialist is mid-task producing a `C5.1` built on the *pre-change* `R1`. **Why not now:** #80's third branch. It blocks nothing — nothing runs concurrently yet, so contention has never been observed — and being wrong later is additive rather than architectural. ⚠️ **Resist choosing the mechanism early.** Git commits, monotonic counters, content hashes, leases and optimistic concurrency are all plausible and they imply different task granularities; picking one before real specialist tasks exist means designing the granularity to fit the mechanism instead of the reverse. Git-style *merging* is the wrong analogy outright — the requirement is not textual conflict resolution, it is *has the premise moved.* **Reopen condition, so this is a record and not a memory** _(and stated per #80 as the point the risk becomes **possible**, not the point it becomes **observed** — waiting for the first stale-context failure means shipping one to learn it was real)_: **when two specialist tasks can run concurrently over overlapping dependency sets.** That is a fact about the delegation extension and the task model, checkable by reading them, and it will be true before any failure occurs. _(Recorded 2026-08-18 from the review document; sharpened the same day.)_ |
| 32 | Pi package location | **In-tree at `.planning/pi-package/`**, installed by the setup script via **`pi install -l ./.planning/pi-package`**. No npm publish. _(Corrected 2026-08-14: the `-l` is load-bearing.)_ | Nothing to fetch, matches the journey, and updates ride the same `git pull` as everything else. Publishing buys nothing while there's one consumer. **`pi install` without `-l` writes to user/global settings** — which for a one-clone-per-project model (#1) would leak one project's roster into every other project on the machine. `-l` writes `.pi/settings.json` in the project. Local paths are referenced, not copied, so `git pull` updates take effect without reinstalling. |
| 33 | Skill tuning | Skills live **inside the package**, plus a `planning-content/skills-overrides/` drop point where a PM-tuned `SKILL.md` wins over the packaged one. ✅ **Verified 2026-08-18 (step 2b) — the drop point works, registered through the settings `skills` array.** Four runs with provenance read upstream of the model: packaged only → `PACKAGED`; override present → `OVERRIDE`; override edited → the edit; override removed → back to `PACKAGED`. The packaged skill is **shadowed and recoverable**, not displaced. ⚠️ **One case deferred under #80 branch 3 rather than tested:** relative precedence between this path and `.pi/skills/` when both hold the same skill. **Not tested because the product does not currently create that configuration** — setup writes overrides to one place, and inventing a test for a state nothing produces is the premature-architecture half of #80. **Reopen condition:** the first design in which both locations can hold the same skill name — most plausibly a setup step that *materializes* overrides into `.pi/skills/`, or a decision to support both drop points. ~~**The drop-point path is in doubt as of 2026-08-15** — override precedence itself is verified, but only from `.pi/skills/`, which is a Pi discovery location; `planning-content/skills-overrides/` is not.~~ _(That doubt was a documented-order prediction and it was wrong — kept for the lesson.)_ See the spike results in "Pi integration". | Tuning a skill shouldn't mean editing the tool — that's a merge conflict on the next update, which is exactly what #20 exists to prevent. The *intent* survives the spike; the *path* may not. |
| 34 | Stage definitions | **One `stages/` definition set.** The app renders from it; the skills derive from it. **Non-negotiable.** | Two hand-maintained descriptions of the same pipeline will disagree, and the disagreement surfaces as the agent confidently working to exit criteria the app isn't checking. ⚠️ **Boundary made explicit 2026-08-18 → #90.** `stages/` owns *what a stage produces and what makes it done*; `schemas/` owns *what an artifact is*. A schema's `x-stage` is derived metadata, checked against `stages/` by the lint and never read as authority — the gate infers nothing from it. This row already said why; #90 exists because an implementation crossed the line anyway and had to be corrected. |
| 35 | Provider setup | **Defer to `pi-localllm-provider`.** Document the `compat.supportsDeveloperRole: false` sharp edge in the setup docs. | It already does TUI-driven setup for exactly this provider list. Rebuilding it competes with the schemas on the critical path. That compat flag will bite someone on day one. |
| 36 | Model capability bar | **Warn, never refuse.** Publish a tested-models table instead. | A hard gate is unenforceable — you can't detect "too weak" until it's already produced something bad — and it insults users running perfectly adequate local setups. The real mitigation is templates + typed tools + the lint loop. |
| 37 | Development provider order | **Frontier model first for iteration speed, then harden against a local 7–8B before v1 ships.** | Developing against the weak model first confounds every design decision with "is this wrong, or is the model just struggling?" |
| 56 | Sandbox tier | **Three tiers ship in v1 — (1) Python virtual environment, (2) Docker / Docker Compose, (3) AWS CLI + Terraform. The PM decides which are available; the validation agent enforces the ceiling and may not exceed it.** Declared in `project.yaml`, same as artifact types (#39). | This is a **permission boundary, not a preference** — it's the one place the agent spends money and holds credentials. Making it a PM declaration means "this project validates in Docker and nowhere else" is a fact the agent is bound by, not a habit it might drift out of. Three tiers rather than one also means the cheap tier handles the common case: most claims worth checking are dependency questions, not hardware questions. |
| 77 | Sandbox tier defaults | **Tier 1 on by default. Tier 2 is capability-detected** — automatically available where Docker / Docker Compose already work on the machine, and where they don't, **recommended to the PM as an approve-or-deny**, never installed on their behalf. **Tier 3 off by default**, activated only when the project's scope calls for it. **The PM is educated on tiers 2 and 3 on demand** — when they ask, or when the project reaches a claim that needs one — never up front. | **This dissolves the question rather than picking a side of it.** The open version was a static choice between "tier 1 only" and "tiers 1 and 2", and both are guesses about a machine the template has never seen — which is why this repo's hand-written manifest and this document's leaning had already drifted apart. Making tier 2's availability a **detection result** means `project.yaml` states a fact rather than a hope. **Probe the capability, not the binary:** `docker compose version` returning successfully, not `which docker` — installed-but-daemon-stopped and installed-but-no-socket-permission both read as "available" to a naive check and then fail at `provision`, which is the silent-tier-downgrade risk arriving through the setup script instead of the agent. ⚠️ Measured here 2026-08-18: `docker` is not on PATH at all, so this repo's `tier 1 only` is **correct as written** — and now owes the PM a tier-2 recommendation rather than nothing. **Recommend, never install:** installing system software on the PM's behalf is #67's rejected move in a different costume. **Tier 3's "when scope calls for it" is #25 by another route** — validation is demand-driven from stage 3 with a gate at 6, so the tier arrives with the claim that needs it; and a project that never activates it still never loads a provider or holds a credential, which is what four rows of the risk register depend on. **Education on demand for the reason per-task approval was rejected:** a governance briefing delivered before anything needs it is a prompt everyone clicks through; delivered at the moment a claim needs the tier, it lands. ⚠️ **Two consequences, both real.** The setup script (#49) grows a capability probe. And the tier declaration in `project.yaml` gains a **third state** — `available` / `recommended-pending-approval` / `off` — which the lint and the validation agent must both read, with `recommended` behaving **exactly like off** until approved. #45's `n/a` reasons gain a second form alongside `tier 3 not activated`. ⚠️ **And a third consequence, found the same day and recorded under "Which tier can reach which rung": this makes the confidence ceiling machine-dependent.** The rung table caps confidence by tier, so an OS-packages claim reaches rung 4 under tier 2 and rung 2 at best under tier 1 — meaning the same project, planned by the same agent from the same requirements, tops out lower on a machine without Docker, and via #57 fewer of its claims may become instructions. Not a defect this row introduces; a fact it makes visible, which the static default was hiding. **It is also what the tier-2 recommendation should actually say** — the useful question is not "approve Docker?" but "without it, these claims cannot exceed rung 2." _(Decided 2026-08-18.)_ |

### Content & schemas

| # | Question | Decision | Why |
|---|---|---|---|
| 13 | Authoring model | **Schema-first.** Most artifacts are written through typed tools; prose stays freehand. Project-to-project variation is absorbed by the *manifest declaring which artifact types are active* — not by loosening the schemas. | Structure where possible, determinism in what comes out, and room for projects that aren't alike. |
| 38 | Artifact catalogue | **16 types for v1** — `requirement` · `decision` · `risk` · `acceptance-criterion` · `task` · `role-assignment` · `schema` · `api-spec` · `wireframe` · `scope-boundary` · `question` · `research-finding` · `assertion` · `evidence` · `runbook` · `runbook-step`. | ⚠️ This is **the critical path, not the app** — and #23 grew it from ten to sixteen. All of it has to land before anything can be authored against it. **Amended 2026-08-18 — the first four are not the first four alphabetically, and the reason belongs here rather than in the build order.** Step 3 (#76) builds `requirement → decision → schema → api-spec`, chosen as the minimum set that proves the **loop** rather than the catalogue: it is enough to exercise trace links, one typed tool, a generated template (#43), the lint (#46), and #61's per-field propagation classes against real content. Three of the four come straight out of stage 5's *Produces* cell in the stage table, which is why #54 calls stage 5 the flagship. ⚠️ **Name what they do not touch, so the gap is deliberate rather than discovered:** they prove the **authoring** loop and leave the **evidence** loop entirely unproven. Nearly every lint rule with teeth — #57's thresholds, #58's destructive floor, #59's acknowledgement, orphan runbook steps, tier→rung consistency — lives on `assertion` / `evidence` / `runbook-step`, and that is the most novel machinery in this document. It stays untested past the end of #76 — **until step 6, added 2026-08-18, which carries one assertion the whole way through.** ⚠️ **And treat the four as a testbed for conventions, not as four documents** _(review document, 2026-08-18)_: ID conventions · trace-link representation · status representation · materiality metadata (#61) · `n/a` with reason (#45) · unresolved links (#75) · validation error shape · migration behaviour (#50) · template generation (#43) · renderer interface. **A schema is not a JSON Schema file; it is a contract shared by the typed tool, the store, the lint, traceability, cascade, templates, the renderer and the handoff.** Get those ten right on four types and the remaining twelve become application of a pattern rather than twelve design exercises — which is the only version of #38's sixteen that is not the top risk in this document. Then let `assertion` / `evidence` / `runbook-step` **challenge** the conventions early, because they stress different parts of the architecture and are the ones most likely to break a pattern settled without them. |
| 39 | Type activation | **Agent proposes at stage 2, PM approves.** Same recommend/approve split as roles (#18). | Stage 2 is the first point the project's shape is actually knowable. Activating at setup means guessing before you know anything. ⚠️ **Amended 2026-08-18 — this row has a consequence for *this* project that took until the build order to notice.** `planning-content/project.yaml` here carries `artifactTypes.activated: []`, and correctly so: stage 2 has not run on this project, so there is no approved list and hand-writing one would be the setup-time guess this row rejects. But #43 makes templates **generated** from the activated types, and the skeleton (#76 step 5) renders a template. So the skeleton either needs an `activated` list it cannot legitimately obtain, or it hand-authors the very thing this row forbids. **The way out is to stop treating this repo's `planning-content/` as a placeholder and work stages 1 and 2 of the pipeline on this project, by hand, against the stage definitions** — which is #76's step 4, and which is also the cheapest possible test of whether the pipeline is any good, before nine skills and sixteen schemas are built on the assumption that it is. Step 3's four types (#38) are the *proposal* that step approves or rejects; **if running stage 2 for real produces a different four, that is a finding, not a failure.** |
| 40 | New artifact types | **Catalogue only for v1.** | A new type is three things, not one — a schema, a typed tool, and a renderer — and a type missing any of them is worse than not having it. The escape hatch covers the gap. |
| 41 | The escape-hatch line | The operative test is **"will anything downstream have to traverse this?"** Prose is free anywhere; anything that will be traced, filtered, or exported must be an artifact. | Mechanical rather than stylistic, which is what makes it enforceable. If stage 9 slices it by role, the lint checks it, or the change feed cascades through it — it can't be prose. |
| 42 | Confidence | **Five rungs** — `unverified` → `source-supported` → `experimentally-validated` → `environment-matched` → `production-validated`. Every assertion carries one. **The MVP tops out at rung 4**; rung 5 is on the far side of #24 by definition. | "The agent believes this should work" and "the system has demonstrated this works" are different claims, and a plan that can't tell them apart is the problem being solved. ⚠️ **Sharpened 2026-08-18 → #96.** The ladder is unchanged and its authority moves: **every *resolved* assertion and every *exported* assertion carries a rung, and the canonical assertion file does not store it.** The rung is derived from the assertion's evidence graph, so storing it duplicates a value that graph already determines. And the rung is **only half the answer** — it says how well a claim was examined, not what the examination concluded. `experimentally-validated` is compatible with the claim being **false**. The verdict axis (`unresolved · supported · refuted`) carries that, and the two are read together or not at all. |
| 43 | Templates | **Generated** from `project.yaml`'s activated artifact types plus their schemas — not hand-written per stage. | Hand-authored templates and schemas drift, and a template that disagrees with its schema teaches the agent the wrong shape. Activation and templating become one mechanism instead of two kept in sync. |
| 44 | Guiding questions | Templates **carry the stage's guiding question** (the `↓ ask:` pattern from the 3-Layers infographic) as a visible prompt. | Cheap, and it does real work against the empty-page problem — a question is far easier to start answering than a heading is to start filling. |
| 45 | Not-applicable | An explicit `n/a` with a **required `reason` string**, stored as a structured field. | The lint can then count *unjustified* N/As, which is a far better signal than counting empties. It also makes "not applicable" a decision someone made rather than a state something drifted into. |
| 74 | Schema representation | **JSON Schema is the source of truth; TypeScript types are generated from it.** Per-field materiality (#61) rides in a custom keyword. Cross-field rules that JSON Schema cannot express live in the lint (#47) rather than in a richer schema language. | **#47's third caller decides this.** One implementation, three callers — `npm run lint:plan`, the app on save, and a Pi extension hook — and that hook runs inside a **non-interactive child process with no build step in front of it**. Two of the three callers are not the Next.js app, so a representation that must be *executed* to be read is one the child cannot read cheaply. #43 compounds it: templates are **generated from** the schema, so it has to be data, not only a validator. Zod was the real alternative and it loses narrowly rather than badly — Zod 4 emits JSON Schema, so the question is only which artifact is authoritative, and **types-from-schema is a build step while schema-from-types is a coupling.** Prices accepted, both deliberately: no free TypeScript types, and expressiveness that runs out on cross-field rules. _(Decided 2026-08-18, on reaching step 3. It had never been decided or recorded as open — see the Open questions entry, kept in place.)_ |
| 75 | Trace links to non-activated types | **Permitted but unresolvable.** A trace link may name a type the project has not activated. The lint reports an unresolved reference at **advisory** weight, and it resolves itself the day that type is activated — no edit to the document, no migration. | #38 catalogues sixteen types and #39 makes activation a stage-2 decision, so **pointing at a non-activated type is the normal state of every project that activates fewer than all sixteen** — not an edge case to be handled but the common one. A lint error makes that normal case unusable: `decision` carries linked evidence, so it could not be authored at all until `evidence` were switched on. Projecting the field away is the cleanest model of what a project *is* and the worst migration — activating a type later changes the shape of documents already written, which is #50's content problem arriving on day one for no gain. And the dangling link is **information rather than a defect**: it records that a decision *ought* to have evidence behind it, which is #57/#58's machinery showing up early. ⚠️ Note the cost: this lands the first real advisory rule on the one class of #61's four that step 3's four types barely exercise, and the one already parked as needing per-*edge* declarations. _(Decided 2026-08-18.)_ |
| 82 | The shared artifact primitives | **Settled once in `schemas/common.schema.json`, consumed by every type schema.** **(0) Dialect: JSON Schema 2020-12, chosen rather than inherited** — composition behaviour is load-bearing here, so "JSON Schema" is not a precise enough statement. **(1) IDs** — `PREFIX-[0-9]{4,}`, prefix per #38 type, **four digits minimum, not exactly four.** **(2) Trace links** — always an **array** of `traceRef`, exposed as **named fields** (`derivedFrom`, `verifiedBy`, `evidencedBy`); the field name supplies the relationship, the value is only an ID. **(3) Materiality** — `x-materiality` on every property, values per #61. **(4) `n/a`** — #45's `{na, reason}` as one branch of a `oneOf`. **(5) Two status axes, not one** — `reviewStatus` (`draft · in-review · approved · amended`, **advisory, never cascades**) and `lifecycle` (`active · superseded · retired`, **structural, always cascades**). **(6) The envelope** — `id · type · schemaVersion · reviewStatus · lifecycle · title`, pulled in by `allOf` and closed with **`unevaluatedProperties: false`**, which type schemas use instead of `additionalProperties: false`. **camelCase throughout.** | **These were undecided, and `requirement` was the first thing that could not be written without them.** ⚠️ **The two-axis status is the correction that matters most, and the first version got it wrong.** One `status` field forced `superseded`/`retired` to cascade while `draft → approved` did not — which would have meant teaching #60 to inspect old and new values, **quietly destroying #61's central simplification that materiality is declared once in the schema rather than judged per diff.** Splitting the axes restores it: `reviewStatus` is progress and never cascades, `lifecycle` is whether the artifact still stands and always does. They were different things wearing one name. **`unevaluatedProperties: false` removes a synchronisation obligation across sixteen schemas** — `additionalProperties: false` only sees properties declared in the same subschema, so the envelope would have had to be re-listed everywhere, and every future envelope field would have been a sixteen-file edit. Measured both ways before adopting. ⚠️ **And it has a second trap behind it, found the same way while adding a cross-field invariant to `decision`: a TOP-LEVEL `if` beside `allOf: [$ref]` drops the referenced subschema's evaluated-property annotations**, so `unevaluatedProperties: false` then rejects every valid document for lacking the envelope fields. Isolated against four variants of the same schema — top-level `if/then/else` fails, `if/then` without `else` fails, no conditional passes, **conditional nested inside `allOf` passes.** So: **every conditional in every schema goes inside `allOf`.** The composed form is more idiomatic anyway, but it is adopted because it was measured, and the rule should be re-checked if the validator changes, since it sits on the boundary between what the spec says and what an implementation can statically analyse. ⚠️ **A seventh primitive was added the same day: `payloadRef`** — `{format, path}`, path relative to #70's content root and unable to escape it — for types that wrap an established format rather than define one. See #86. **Four digits minimum** because a format intended never to change must not carry a 9,999-artifact ceiling. **The ID prefix makes a trace reference self-describing**, so #75's check runs from the reference alone with no registry and no requirement that the target exist. **Named trace fields** because #61 declares materiality per *field*, and a relation carried in a value cannot hold a per-field annotation. ⚠️ *Not* because a generic `{rel, to}` makes #60 unimplementable — it does not; you could read `rel` and build the graph. What it breaks is the schema-declared per-field propagation model, which is the accurate and stronger objection. ⚠️ **Naming rule, added 2026-08-18 (#96): a trace field is named for what the relation MEANS in its domain, not for the type it points at.** Two fields sharing a target type are not thereby the same relation, and two relations with the same name in different types are not thereby symmetrical. `assertion.supportedBy` / `assertion.refutedBy` split because polarity is intrinsic to evidence bearing on a claim's **truth**; `requirement.evidencedBy` and `decision.evidencedBy` do **not** split, because a requirement states a desired condition and a decision records a choice, and "refuting" either is a different act rather than a mirrored one. **Schema symmetry is not a reason.** The test for splitting a relation is #41's: does anything downstream have to traverse the two halves differently? _(Decided 2026-08-18; revised the same day after review — dialect, `unevaluatedProperties`, ID width, and the status split. 21 positive and negative cases pass.)_ |
| 83 | ID allocation | **Three parts, because ID reuse is a data-integrity failure rather than an inconvenience — a reused ID silently re-points every existing trace reference at a different artifact. (a) Tools never physically delete an artifact; removal is `lifecycle: retired`. (b) A durable per-prefix high-water mark, written only by the allocator, is the authority on the next ID — never `max()` over the files that happen to exist. (c) Allocation is serialized through #78's lockfile**, so two concurrent typed-tool calls cannot both decide the next requirement is `REQ-0042`. | **"Allocated once, never reused" is a claim about persistence, and the first version asserted it without a mechanism.** Derive the next ID from the working tree and the sequence `REQ-0001, REQ-0002, REQ-0003` reuses `REQ-0003` the moment that file is deleted — and the reuse is *silent*, because every dangling reference to the old artifact suddenly resolves, to the wrong thing. (a) removes the common case: retirement is the supported removal path, and `lifecycle` exists to express it. (b) covers what (a) cannot — a human deleting a file in git, which no tool can prevent. (c) is the concurrency half; #65 launches specialists in parallel, so two children racing on the same counter is the normal case, not the edge. ⚠️ **The high-water mark is allocator state, not document state**, so it does not reopen #78 — the argument there was against splitting *one document* across two files, and this splits nothing. It lives beside the content and is written under the same lock. ⚠️ **The order inside the lock is part of the decision, not an implementation detail:** `lock → read counter → increment → **atomically persist the counter** → write the artifact → unlock`. Persisting after writing the artifact means a crash in between leaves the counter behind the tree, and the next allocation reuses a live ID. Persisting first means a crash loses a number. **Gaps in the sequence are therefore a property of the safety model, not a defect** — anything that "tidies" them reintroduces exactly the failure this row exists to prevent. ⚠️ **Note what this does not affect: interpreting a trace reference still needs no registry.** Allocation and interpretation are separate concerns, and #82's prefix convention stands on its own. _(Decided 2026-08-18, raised by review of the first schema.)_ |
| 84 | One schema-resolution layer | **Every schema consumer reads the *effective composed* schema through a single resolution layer — never the local `properties` object.** The lint (#47), template generation (#43), the typed tools, the renderer and the handoff all consume it rather than each walking `allOf` for themselves. | **Found by writing the first materiality checker, which read local `properties` and reported `id` and `type` as unclassified** — they carry their annotation on the envelope and are only *narrowed* locally, so the naive read was wrong about two of sixteen fields while looking entirely correct. Everything downstream hits the identical problem: enumerating required fields, descriptions, materiality classes and trace relationships all have to see through `allOf` and `$ref`. **This is #47's "one implementation, three callers" argument one level down**, and it is the same failure if ignored — several consumers each re-deriving composition rules is several sets of subtly different rules within a month, and the disagreements surface as a lint that passes documents the template generator cannot render. ⚠️ **What it returns is an *effective resolved schema* — every property with its annotations inherited through `$ref` and `allOf` — not a validation helper.** Keep the two conceptually distinct even if they ship in one package: validation asks *is this document legal*, resolution asks *what does the schema say about this field*, and only the second is what the lint, the template generator and the renderer actually need. Conflating them produces a layer that answers the easy question and leaves every consumer to walk composition for the hard one, which is the state that produced this row. ⚠️ **Build it as its own module *before* its first consumer, not inside one** _(2026-08-18)_. The lint is the first real consumer and is the obvious place to write it, which is exactly the risk: if resolution lives inside the lint, template generation and the renderer end up depending on lint internals, and **#47's problem reappears one level further down** — several consumers coupled through the wrong module rather than several copies of the same rules. A small module with its own tests, consumed by the lint, is the shape. _(Decided 2026-08-18. Not owed until the second consumer exists, but the first consumer should be written *through* it rather than refactored into it.)_ |
| 85 | Assumptions are references, never prose | **An assumption recorded on any artifact is a link to an `assertion` at rung 1 (`unverified`, #42) or to an open `question` — never a string field.** `decision.assumesThat` is a trace field, structural, targeting those two types. No artifact gets a prose `assumptions` array. | **The information-type model exists to stop an assumption losing its hedge and arriving downstream as a fact nobody checked.** A prose assumption is visible to a human and **invisible to every mechanism built to prevent exactly that**: it cannot be counted, cannot be linted, cannot be promoted when someone validates it, and cannot be found by anything looking for unsupported claims. #41's escape-hatch test settles it mechanically — assumptions *will* be traced and filtered, so they are artifacts, not prose. And no new type is needed: **an assumption is already what rung 1 of #42's ladder means.** ⚠️ **The cost is real and is the reason this is a decision rather than a detail: `assertion` is not among step 3's activated four, so between now and #76 step 6 a decision has nowhere to record an assumption at all.** That is #75 working as designed — the link is permitted and dangles — but it means the gap is *visible* rather than filled with something worse. **An interim prose field was the alternative and was rejected on the strongest available evidence: a prose field that exists will be used, and a field that is used does not get migrated.** It would still be there when `assertion` arrived, holding the assumptions nobody converted. ⚠️ **What is owed instead, and it belongs to the lint rather than the schema:** a rule that flags a decision whose `rationale` reads like it rests on something unrecorded. Weaker than a schema constraint, and honest about being weaker. ⚠️ **That rule is advisory-only and must never gate** _(added 2026-08-18)_. It is a **model judgement about prose**, unlike every other rule in #46/#47, which check structure and trace integrity deterministically. A lint that blocks at #46's two boundaries on the strength of how a paragraph reads is **grading writing**, which is a different system with a different failure mode — and the first false positive at a stage transition is how the whole lint gets disabled. Keep the deterministic and the judgemental rules distinguishable in the output, not merely different in severity. ⚠️ **And until `assertion` is activated, treat this as a known capability gap rather than something to compensate for.** If a real decision in #76 step 4 genuinely rests on an assumption with nowhere to go, that is **evidence that the evidence-oriented types are arriving too late in the build order** — a finding about #76, worth having. Contorting these four schemas to hide it would destroy the signal and keep the problem. _(Decided 2026-08-18, while writing `decision.schema.json`.)_ |
| 86 | Wrap the format, don't re-model it | **An artifact type whose subject already has an established canonical format carries an envelope, trace edges and a `payloadRef` — never a second structure modelling the same thing.** `api-spec` wraps **OpenAPI**; `schema` wraps a **declared** definition format (`json-schema · sql-ddl · dbml · prisma`). Neither schema defines endpoints, parameters, responses, entities, fields, keys or relations. Payload validation belongs to that format's own validator, invoked by the lint (#47), not to JSON Schema. Adding a payload format is a decision, because each one needs a parser for the ER/spec rendering and for the handoff. | **#8's dual-representation rule already said this and it needed saying as a rule rather than an example:** *"an API spec IS OpenAPI, rendered — not prose describing endpoints"* and *"a schema is a definition file, rendered as an ER diagram — not a diagram that happens to look like a schema."* The layout under "The handoff package" even names the files — `openapi.json`, `schema.yaml`. **The failure it prevents is two sources of truth before the renderer exists**, and the tell is subtle: a field proposed on the artifact that the payload format already expresses looks like convenience and is duplication. `x-wrapsExternalFormat` on both schemas exists to make that refusal explicit at the point someone would add it. ⚠️ **One deliberate exception, on `schema.storageTarget`** — stage 5's exit criterion is *"data model approved; storage target chosen"*, and that is a **planning** fact about the model rather than a fact expressible inside it. The test for any future exception is exactly that: can the payload format express it? If yes, it does not belong on the artifact. ⚠️ **Name hazard, recorded rather than left to bite.** The `schema` artifact type (#38) and JSON Schema (the meta-format governing planning artifacts, #82) are different things one word apart, and `schemas/schema.schema.json` is the collision made visible — outer `.schema.json` is the meta-format, inner `schema` is the artifact type. **If it causes one real misunderstanding, rename the type to `data-model` and keep the `SCH` prefix**; the rename is an amendment to #38 and nothing else. _(Decided 2026-08-18, writing the last two of step 3's four.)_ |
| 87 | One file per artifact | **Authoring-side artifacts are one JSON file each — `planning-content/data/<type>/<ID>.json`.** Not one aggregate file per type. The handoff (#19) still exports aggregates (`data/requirements.json`) because that package is **frozen**, and aggregating at export time is a projection rather than a shared write target. | **#78 exists because two writers on one file is hard; one file per artifact means creation never has that problem at all.** The watcher spike measured the aggregate case — two processes on one document, corrupt 5 of 5 non-atomically and lost updates 4 of 5 even atomically — and the cheapest way to not lose that fight is not to have it. With per-artifact files, two specialists creating different requirements touch disjoint *files*, which is the only level the OS enforces (#31's lesson, stated correctly this time). What remains contended is the **ID counter and nothing else**, which is exactly one small file under one short lock. ⚠️ It also makes the watcher (#73) cheap and precise: a changed artifact is a changed path, so an event names what changed instead of meaning "something in the pile moved." ⚠️ The price, paid deliberately: more files, and any consumer wanting the set does a directory read. That is a projection concern (#84's layer, the renderer, the handoff), not an authoring one.  ⚠️ **What #87 settles beyond concurrency** _(2026-08-18)_. The canonical write unit is now the **artifact, not the artifact type**, and that identity boundary runs the whole way through: ``` one artifact → one file → one watcher path → one renderer input → one lifecycle → one trace node ``` - **Watcher (#73):** the directory is the collection, the **file is the event unit**. A change to `data/requirements/REQ-0007.json` means *re-read REQ-0007*, not *re-read all requirements*. Events are still only hints — #73 stands — but the hint now points at the smallest canonical object, which makes the tracker and the change feed (#16) cheaper and easier to reason about. - **Renderer:** **no planning-time aggregate file, for convenience or otherwise.** A page needing "all requirements" gets a shared loader that enumerates `data/requirements/*.json`, validates, and builds the collection in memory. An aggregate written during planning would recreate precisely the shared write target #87 removed. - The aggregate belongs **at handoff only** (#19), where the package is frozen and aggregation is a projection rather than a write target. _(Decided 2026-08-18, writing the first typed tool.)_ |
| 88 | The typed-tool create contract | **Every create path: validate the caller's fields → take the #78 lock → allocate and persist the ID (#83) → assemble → validate the COMPLETE artifact → resolve the destination (#70) → refuse if it already exists → atomic write (#72) → release. Two validations at two boundaries, never one. No overwrite on create. No rollback of the counter.** | **The first validation is before an ID is consumed** so malformed input costs nothing; the second is on the object actually being persisted — `id`, `type`, `schemaVersion`, `reviewStatus`, `lifecycle` are all injected by the tool, and **without the second check the typed tool is the one actor in the system capable of writing schema-invalid content.** That is the failure #66's enforcement story exists to prevent, arriving from inside the enforcer. **Refuse-if-exists defends against abnormal counter state** — a reverted, corrupted or hand-edited `.ids.json`. #83 makes collision impossible under normal operation; when operation is not normal, an existing artifact must produce a loud invariant failure rather than become a victim of the atomic writer. **No rollback** because #83's invariant is that an allocated ID stays consumed: a gap is safe, and rollback reintroduces the possibility of reuse to buy back a number nobody needs. ⚠️ **Proven compositionally rather than per-helper**, which is the point — 11 tests covering: malformed input consumes no ID · success consumes exactly one · failure *after* allocation leaves a gap and the next create skips it · a pre-existing destination is never overwritten · a corrupt counter refuses to allocate · **six concurrent child processes receive six distinct IDs** · a failed rename leaves the previous file intact with no temp behind · the lock is released on every throwing path · a stale lock owned by a dead process is broken while a live one is not. ⚠️ **The concurrency test was falsified before being trusted:** the same eight processes allocating *without* the lock produced **4 distinct IDs of 8**. #83(c) is load-bearing, not theoretical, and the test can actually fail. _(Decided 2026-08-18.)_ |
| 89 | Lint architecture | **Four layers, strictly ordered: Ajv (legality) → #84 (meaning) → rules (acceptability) → findings (data).** No rule reads a raw schema file — everything needing schema metadata goes through #84. **No rule restates what the schema already enforces.** Four entry points sharing one engine: `lintArtifact` · `lintProject` · `evaluateStageGate` · `evaluateHandoffGate`. **Findings are structured data with a fixed shape** — `ruleId · severity · artifactId · path · message · details` — and no caller ever parses prose. Three severities: `error` blocks a gate, `warning` reports continuously, `advisory` is expected-for-now (#75). | **The separation each layer enforces is the whole design.** Ajv answers *is this legal JSON for this type*; #84 answers *what does this field mean*; the rules answer *is this acceptable in the planning system*. Letting a rule read schema files directly would grow a second composition model inside the lint — **#47's own failure, one level in.** And restating a schema rule in the lint produces two authorities for one invariant, which is #34's argument in a different domain; the `superseded`/`supersededBy` pair is enforced by the schema's conditional and deliberately absent from the rules. ⚠️ **The gate entry points are separate because a valid artifact can still fail a gate.** A requirement can be perfectly legal and stage 2 still unable to exit; collapsing the two makes the lint a single undifferentiated pass/fail nobody trusts, which is how #46's "blocking mid-thought" failure arrives by the back door. `evaluateStageGate` reports `criteriaDeclared: false` and **refuses to report ready** when #34's stage definitions do not exist — better than passing on criteria it has never seen. ⚠️ **What the lint exists for, tested directly: it must catch defects the typed tool cannot produce.** A valid artifact moved to the wrong directory, an `id` that stopped matching its filename, a duplicate ID, a trace to something that was never allocated, whitespace where `minLength` sees characters, an active artifact resting on a retired one — every one of them arrives by hand, merge or move, and every one is schema-valid. **That is the answer to "why lint at all when writes are typed."** _(Decided 2026-08-18. 16 tests, one per rule family plus one per defence layer.)_ |
| 90 | `stages/` owns the pipeline; schemas own the artifact | **One line, drawn explicitly: `stages/` defines what a STAGE produces and what makes it done. `schemas/` defines what an ARTIFACT is. `x-stage` on a schema is DERIVED METADATA for discoverability — never an authority.** The gate reads produced types and exit criteria from `stages/` and from nowhere else; with no definitions present it reports `stageDefinitionsFound: false`, infers nothing, and refuses to report ready. The lint checks that every `x-stage` **agrees** with `stages/` and errors on a disagreement. | **This was caught as a live regression rather than reasoned about in advance.** The first `evaluateStageGate` derived "what does stage 5 produce" from the schemas' `x-stage` annotations. It worked, and it was wrong: it made `schemas/` a **second description of the pipeline**, which is precisely the drift #34 was written to prevent — *"two hand-maintained descriptions of the same pipeline will disagree, and the disagreement surfaces as the agent confidently working to exit criteria the app isn't checking."* The mechanism was fine; the ownership was not. ⚠️ **The tell that it was wrong was already in the code:** the same function reported `criteriaDeclared: false` and refused to pass when `stages/` was absent — so it *already* treated `stages/` as authoritative for exit criteria while quietly treating schemas as authoritative for produced types. **Two authorities inside one function is worse than either choice alone.** ⚠️ **The generalisation, since this will recur:** every question of the form *"what does this stage involve"* belongs to `stages/`; every question of the form *"what does this artifact look like"* belongs to `schemas/`. Where a schema needs stage metadata for navigation it may carry it, but it is generated from or checked against `stages/` — never consulted in its place. A test asserts the gate infers nothing when definitions are absent. _(Decided 2026-08-18, correcting an implementation that had already shipped in this session.)_ |
| 91 | The nine stage definitions exist, and they are a **draft made authoritative** | **All nine of `stages/*.json` are materialised from the "What each stage actually emits" table — the whole set, not just the two step 4 exercises.** Each carries `produces` (artifact types), `exitCriteria`, `decidedBy`, and a `provenance` block recording that the source table is marked *draft — argue with every row* and that **materialising it makes it authoritative, not correct.** ⚠️ **An exit criterion nothing can check does not pass by default.** Every criterion here is `mechanised: false`; the gate reports `gate/criterion-needs-human-judgement` at error severity and refuses to be ready until the PM **acknowledges** it by id — the same shape as #45's justified `n/a` and #59's acknowledged unvalidated step. | **The full set rather than stages 1–2 because #90's invariant needs somewhere to land.** Schemas carry `x-stage`; if only two definitions existed, `schema` and `api-spec` would point at a stage that does not exist, and **a partial `stages/` would look like a complete authority** — the exact shape of failure #90 was written to close. So the invariant is now the strong one: **every `x-stage` must resolve to an existing definition AND agree with what that stage declares it produces.** Two distinct rules, `stage/x-stage-unresolvable` and `stage/x-stage-disagrees`, because "points at nothing" and "points at the wrong thing" are different repairs. ⚠️ **The transcription was itself a check and it passed:** the nine definitions were written from the table, and the four shipped schemas' annotations agree with them with no adjustment — asserted by a test that runs against the real files rather than a fixture. ⚠️ **Do not let this count as dogfooding.** *Writing* the definitions is setup for #76 step 4; **step 4 is running stages 1 and 2 against them.** The table has never been argued with, and being used is how it gets argued with. **If the real stage-2 run produces different requirements, different non-goals, or a different activation list from what the architecture assumed — including from step 3's four types — that is evidence, not a failed exercise.** _(Decided 2026-08-18.)_ |
| 92 | A stage definition enforces only what the source table **names** | **`produces[]` lists only artifact types the settled stage table names in its Produces cell. Anything a reader would infer goes in `producesCandidates[]` with `from` (the phrase it came from) and `note` (why it is not settled), and the gate does not enforce it.** Outputs with no type at all go in `outputsNotYetTyped[]`. | **Caught by review, and it had already made step 4 impossible.** The first transcription mapped stage 2's *"explicit non-goals"* onto the catalogue type `scope-boundary` — a type with no schema. The stage definition then said stage 2 could not complete until an artifact existed that the system had no vocabulary to express, so **the gate was not waiting for a decision; it was waiting for something unbuildable.** Three more of the same: stage 3's *"hypotheses requiring validation"* → `assertion`, stage 8's tasks → `role-assignment` (inferred from #18, not from the table), stage 9's *"the runbook and its evidence"* → `runbook-step` and `evidence`. ⚠️ **The general failure is a transcription that promotes an inference.** Moving prose into a machine-readable definition feels lossless and is not: *"explicit non-goals"* names an **output**, `scope-boundary` names an **artifact type**, and turning the first into the second is a design decision wearing the costume of a data-entry step. Keeping the inference visible — with the phrase that prompted it — makes promoting it a decision someone takes on purpose, most likely at #39's stage-2 activation. ⚠️ A test asserts the gate never demands a type that has no schema, so this class cannot come back silently. _(Decided 2026-08-18, correcting #91 the same day it was written.)_ |
| 93 | Human-only exit criteria are **attested**, not acknowledged | **A criterion the system cannot check is discharged by a recorded RESULT — `satisfied` · `not-satisfied` · `n/a` — with `decidedBy`, and a **required reason** for `n/a`. There is no "acknowledged" result.** Missing → `gate/criterion-pending-human`. Unrecognised result → `gate/attestation-malformed`. `n/a` without a reason → `gate/attestation-unjustified`. `not-satisfied` is a first-class outcome and blocks, distinctly from never having been evaluated. | **"Acknowledged" is the wrong verb and it hides the failure this gate exists to catch.** #59 acknowledges a *known exception* — the PM is confirming they accept something already understood. Here the PM is **evaluating whether a criterion is true**, which is a different act with a different failure mode: a gate where every criterion is acknowledged and none was ever judged true is **rigorous-looking and means nothing**. That is the same well-formed false success as a trust-denied child that completes normally, or a lint that passes for want of criteria. ⚠️ **The distinction is testable, and is tested:** `{result: "acknowledged"}` is rejected as malformed, because seeing a criterion is not a verdict on it. ⚠️ **`not-satisfied` matters as much as `satisfied`.** A stage that cannot pass because someone looked and said no is in a *known* state; one that cannot pass because nobody looked is not, and the two must not collapse into one red light. The `n/a` reason requirement is #45's shape, for #45's reason: the lint can then count **unjustified** exemptions rather than empty ones. _(Decided 2026-08-18.)_ |
| 94 | A capability gap is not a work item | **When a stage produces an activated type that is not implemented, the gate reports `gate/type-not-implemented` naming exactly what is missing — `schema`, `typed tool`, or both — and does **not** also report `gate/no-artifacts-for-stage-type` for that type.** The ordinary "activated, implemented, nothing authored yet" case keeps the original rule. One reader for the approved activation set (`lib/activation.mjs`), shared by the CLI, the lint and the tests. | **Surfaced the day stage 2's activation was approved, and it is #92's failure class arriving by a different route** — not a bad transcription this time, but **activation outpacing implementation**. Eight types approved, four with schemas, one with a typed tool. The gates for stages 3, 4 and 9 correctly said NOT READY and gave the wrong reason: *"no research-finding artifact exists"* reads as **unfinished planning** when the truth is **unbuilt product**. Those are different problems with different owners, and a PM chasing the first will never find the second. Same disguise as #85's assumption gap: a missing capability wearing a work item's clothes. ⚠️ **The partial case is the one that justifies naming the missing pieces rather than a boolean.** `decision` has a schema and no typed tool, so it reports `missing: ["typed tool"]` — a gap that was completely invisible before and would have stayed invisible under a yes/no check. ⚠️ **And the test that should have caught this could not.** The #92 test ran with `activated` set to *every type that has a schema*, so the unimplemented case it claimed to cover was unreachable by construction. **A test whose fixture excludes the failure is not a test of it** — the replacement reads `project.yaml`'s real approved set, so this project itself reproduces the condition. That is the same discipline as falsifying the concurrency test by removing the lock (#88): a check nobody has watched fail is a check nobody should trust. _(Decided 2026-08-18, immediately after step 4's activation approval made it visible.)_ |
| 95 | Catalogue support ≠ project activation | **Activation (#39) governs whether **a project** may author and require a type. It does not govern whether **the tool** supports it.** The two are independent: the shipped tool carries schemas and typed tools for the whole v1 catalogue (#38), and each project activates the subset its own stage 2 derived. An unactivated type is **inactive here**, not unbuilt — and it leaves *this* project's critical path without leaving the product's. | **Forced by step 4's result and unresolvable without the distinction.** This project's stage 2 declined to activate `schema` and `api-spec`, which are already implemented — so "is `api-spec` done?" had two defensible and opposite answers depending on whether the question was about the tool or about this plan. #94 had just separated *activated* from *implemented* at the gate; this is the same cut one level up, at the roadmap. ⚠️ **The consequence that matters for sequencing:** their typed tools are still owed for v1 catalogue completeness (#38 is the critical path and has not moved), but they are owed **to future consumer projects**, not to this one, and therefore rank behind the activated evidence path. **Cheap is not a reason** — `decision`'s tool is the cheapest thing on the gate's worklist and is still not next. ⚠️ **And the gate is a worklist, not a priority queue.** #94 made it report accurately what is absent; nothing in it ranks anything, and reading proximity as priority is how #80's triage gets skipped by accident. Priority comes from #80 branch 1 — what blocks the next implementation *commitment* — which is what produced the interleaving amendment to #76. _(Decided 2026-08-18.)_ |
| 96 | Confidence is **derived**, and verdict is a separate axis | **`confidence` is not an ordinary persisted field on `assertion`.** The canonical inputs are the assertion, its evidence links, and each evidence record's source / experiment / environment data. **One shared derivation function** produces an *effective assertion view* consumed by the gates, the renderer and the handoff export — the same shape as #84's resolution layer, for the same reason. The handoff **may materialise** the rung, and when it does it is **labelled derived, not authoritative**. **Two independent outputs, never one:** `verdict` — `unresolved · supported · refuted` — and `confidence` — `unverified · source-supported · experimentally-validated · environment-matched`. Cross-file consistency is a **lint** concern; JSON Schema cannot see an evidence graph. | **A rung alone is ambiguous, and dangerously so: "experimentally-validated" can mean the claim was tested and shown FALSE.** Confidence answers *how well was this examined*; verdict answers *what did the examination conclude*. Collapsing them produces a plan whose strongest-looking claims may be its refuted ones — the exact inversion of what #42 exists to prevent. ⚠️ **This is the third time one field has needed two meanings**, and the pattern is now worth naming: `status` split into `reviewStatus` + `lifecycle` (#82), materiality's transition problem dissolved the same way (#61), and now confidence splits from verdict. **A field that needs two materiality classes, or two answers, is two fields** — reach for a compound value only after splitting has been tried and failed. ⚠️ **Deriving rather than storing is #84 and `downstreamDependencies` again** (#82's `x-derivedRelations`): the evidence graph already holds everything the rung is computed from, so a stored rung is a second copy that goes stale silently, and it is the copy a reader trusts. **The first pressure test must include refuting evidence**, or the whole distinction goes untested — which was how the ambiguity survived being written down in the first place.  ⚠️ **Both open items settled 2026-08-18, before 5a rather than during it.** **(1) `contested` is a fourth derived verdict, computed after APPLICABILITY FILTERING**, which is the step that makes it meaningful rather than noisy: `no applicable evidence → unresolved` · `only applicable support → supported` · `only applicable refutation → refuted` · **`applicable support and refutation both remain → contested`.** Filtering first is what stops a stale or environment-mismatched record manufacturing a contradiction. **`contested` blocks promotion into an instruction** (#57's threshold, #58's floor) — it may indicate a modelling error, an environment mismatch, stale evidence, or genuinely unsettled reality, and **the system exposes the condition before deciding its cause.** Diagnosing it automatically would be guessing at exactly the moment the plan is least entitled to guess. **(2) `requirement.evidencedBy` and `decision.evidencedBy` do NOT split.** Polarity is intrinsic where evidence bears on an assertion's **truth**; a requirement expresses a *desired condition* and a decision records a *choice*, and "refuting" either means something different rather than something symmetrical. Split them only if a downstream consumer genuinely needs the polarity — which makes it a **#41 traversal question**, not schema symmetry for its own sake. _(Decided 2026-08-18, shaping #76 step 5a before it starts; both open items closed the same day.)_ |
| 97 | What 5a moved, and what survived | **`assertion`, `evidence` and `runbook-step` are built, with `lib/effective-assertion.mjs` deriving verdict and confidence (#96). The prediction that these types would break #82's primitives was WRONG — the envelope survived unchanged.** What moved was the **authoring contract**, exactly where it was predicted to: no stored confidence, no stored verdict, polarity split into `supportedBy` / `refutedBy`. Three genuinely new things came out of building rather than designing: **(1) environment match is three-way** — `match` · `unknown` · `mismatch` — because **silence is not a match**: a target fact the evidence never mentions is not a contradiction, and it caps the rung below `environment-matched` rather than excluding the record. **(2) `evidence.outcome` is not a verdict.** A successful run can *refute* a claim and a failed run can *support* one, so which way a record bears is the assertion's trace field, never the evidence's outcome. **(3) A destructive `runbook-step` needs `restsOn: minItems 1`** in schema — #58's floor has a structural half JSON Schema can enforce, and a threshold half only the lint can. | **The negative result is the useful one and it should not be glossed.** #38 recorded that these three would stress the substrate in ways the first four could not; #76 step 5a was ordered ahead of the skeleton on that basis. **The primitives held.** IDs, trace links, materiality, `n/a`, the two status axes, `unevaluatedProperties`, conditionals-inside-`allOf` — all consumed unchanged by three types with genuinely different shapes. That is evidence *for* #82 rather than a wasted step, and the ordering still earned itself: it was worth finding out **before** a renderer, a watcher and a status write-back were built on top. ⚠️ **But note precisely what was and was not falsified.** The falsification target turned out to be the **authoring contract**, not the primitives, and #96 had already moved it before 5a started — so 5a tested a prediction that had partly been resolved in advance. **A pressure test that changes nothing is suspicious** (5a says so in its own step); this one changed the contract and left the substrate, which is a real result but a narrower one than the step was sold on. ⚠️ **Still owed by 5a before 5b:** typed tools for the new types, and the lint rule that reads the derived view — `runbook-step.restsOn` pointing at a `refuted` or `contested` claim is the enforcement REQ-0009 asks for, and it does not exist yet. _(Recorded 2026-08-18. 82 tests.)_ |
| 98 | The evidence typed tools, and where polarity enters | **Four operations, and the seams between them are the decision. `createAssertion` refuses `confidence`, `verdict`, `supportedBy` and `refutedBy` — all four are either derived (#96) or added later. `createEvidence` records what was OBSERVED, including `outcome`, and never polarity. `linkEvidence` is where polarity enters, as a relation on the ASSERTION. `createRunbookStep` requires `restsOn` at the input boundary, destructive or not.** Evidence creation and linking stay **separate operations**, never one. | **Separating creation from linking is a choice about crash semantics, not tidiness.** Combining them makes a two-file transaction, and #88's contract is built for one artifact: lock, allocate, validate, write, release. **An unattached evidence record is a detectable, repairable intermediate state** — the lint can see it and a human can fix it. A half-completed "atomic attachment" is a **lie about what happened**, discovered later by someone trusting it. Given a choice between a visible incomplete state and an invisible inconsistent one, take the visible one. ⚠️ **`linkEvidence` is the system's first UPDATE path**, so it is #78 in earnest: fresh read **inside** the lock, then modify, then #72's atomic write. A snapshot taken before acquisition would let the lock serialise stale writes rather than prevent them. ⚠️ **One record may not both support and refute the same claim** — that is not a `contested` assertion, it is a mistake, and `contested` must keep meaning *two records disagreeing* or it stops meaning anything. ⚠️ **REQ-0009 is enforced twice on purpose:** the tool refuses a step with no `restsOn` (authoring half), and the schema requires it when `destructive` (structural half, #58's floor). Neither is redundant — the first stops it being written, the second stops it existing. _(Decided 2026-08-18.)_ |
| 99 | Never take the maximum rung across premises | **A runbook step's `restsOn` assertions are each checked INDEPENDENTLY against their derived state. `refuted` and `contested` block regardless of rung; `unresolved` and below-threshold produce their own findings; only `supported` at the step's required confidence may promote. The rung is never maxed, averaged, or otherwise combined across premises.** A destructive step (#58) requires `environment-matched`; an ordinary one requires `experimentally-validated`. | **One strong premise cannot compensate for one false premise, and combining them would recreate #96's silent inversion one level up.** A step whose best premise is a matched experiment and whose second premise is refuted would present as well-founded — maximum apparent authority resting partly on something known to be false. That is the same failure as a `contested` assertion reading `environment-matched`, moved from the claim to the instruction, and it is worse there because an instruction is the thing someone actually runs. ⚠️ **Tested with exactly that fixture:** a step resting on one matched-experiment-supported assertion and one refuted assertion, asserting that the refuted premise is named, that the sound one is not treated as a finding, and that it does not rescue the other. ⚠️ The finding message says *"checked independently: a sound premise elsewhere does not lift this one"* — because the first person to see a blocked step with a strong premise in it will ask why, and the answer should be in the finding rather than in this file. _(Decided 2026-08-18.)_ |
| 100 | The skeleton is framework-free, and #5 is untested by it | **5b's walking skeleton is a plain Node HTTP server (`app/server.mjs`), not Next.js.** It proves the seven properties 5b was given — canonical reads, render-time derivation, supporting/refuting/**excluded-with-reasons**, nothing derived persisted, chokidar refresh, status write-back through #78+#72, and lint findings surfaced verbatim. **#5's Next.js + MDX choice still stands and this does not test it.** | **#55's purpose is proving the risky surface, and the framework is not it.** #30 calls the watcher the entire integration surface between the two halves; #12 puts the agent in a terminal that knows nothing about the dev server. Scaffolding Next.js first would have spent the step on its least uncertain part and delayed the parts that could actually be wrong. ⚠️ **Say plainly what that costs**, because a skeleton that quietly substitutes for the product is the same shape as every other well-formed false success here: **MDX rendering, the dev server's own file-watching, HMR interacting with an external writer, and React's state model against #78's lock are all untested.** The last is the one to watch — a framework with its own opinions about when to re-read files meets a lock held by a process it does not know exists. ⚠️ **The rendered page is deliberately unattractive.** It exists to show a `contested` assertion at `environment-matched` next to the evidence that excluded itself, not to look like a product. | ⚠️ **The dogfood content is real, and the contested example is a live disagreement rather than a fixture.** `AST-0002` — *"the lockfile serialises concurrent creates"* — is supported by the six-process experiment (falsified by removing the lock: 4 distinct IDs of 8) and refuted by the single unexplained full-suite failure whose diagnosis is still owed. `RBS-0001` rests on it and is blocked by `instruction/rests-on-contested`. **The system's first real finding about itself is one nobody planted.** ⚠️ **Corrected within the day → #101: that link was wrong.** An unexplained failure with no captured output does not contradict serialisation, so `EVD-0003` was unlinked and `AST-0002` returned to `supported`. The observation now refutes `AST-0003`, a separate claim about test reliability, which is what it actually bore on. **The skeleton's contested path uses a controlled fixture instead** — the live content no longer holds a genuine disagreement, and inventing one would be worse than having none. _(Recorded 2026-08-18. 99 tests.)_ |
| 101 | Structural polarity validation cannot establish semantic bearing | **A link's POLARITY is a judgement about what an observation means, and nothing in the system can check it.** The structural guards hold — a link must resolve, one record may not both support and refute — but they say nothing about whether the record bears on the claim the way someone said it does. Therefore: **`unlinkEvidence` is a first-class typed operation**, correcting a link is a normal act rather than an exception, and **an unexplained failure is not evidence against the thing that failed** unless the observation is itself incompatible with the claim. | **Caught on the first real use of `linkEvidence`, hours after recording the distinction it violates.** `AST-0002` — *"the lockfile serialises concurrent creates"* — was linked to `EVD-0003`, an observation that *"a full-suite run failed once with no captured output."* That record never established duplicate IDs, overlapping critical sections, or anything incompatible with serialisation: **a timeout is compatible with a liveness or harness problem while serialisation is entirely correct.** The polarity came from the *feel* of a failure, which is **`evidence.outcome` masquerading as bearing** — precisely what #97 recorded as a finding and what the schema was shaped to prevent. ⚠️ **The dual-link guard prevents this structurally and cannot prevent it semantically**, and the gap between those is where `contested` erodes into *"someone assigned polarity without sufficient evidence."* A `contested` verdict is only worth blocking on if the disagreement is real. **The correction:** `EVD-0003` unlinked from `AST-0002`, which returns to `supported`; a new `AST-0003` — *"the concurrency test passes reliably under full-suite parallel load"* — carries it as refuting, because **that** is the claim the observation actually contradicts. Splitting the claim is what made the evidence honest. ⚠️ **And the skeleton's contested path now uses a controlled fixture** rather than live content, because the live content no longer contains a genuine disagreement — which is the correct state, not a gap to fill. _(Recorded 2026-08-18. The most useful result of 5b, and it was not one of 5b's seven properties.)_ |
| 102 | Evidence bears cleanly only on a claim precise enough to contradict | **An assertion must be stated so that a specific observation could falsify it.** A **universal** claim — *"passes on every completed run under this configuration"* — is contradicted by one failure. A **statistical** claim — *"passes reliably"* — is not, because it permits an unstated failure rate, and linking a single failure to it is polarity without sufficient evidence. **Write the universal form, or define the rate quantitatively with a sample size and an acceptable threshold.** Those are different assertions needing different evidence, and neither may be written as the other. ⚠️ Consequence: **`reviseArtifact` is a typed operation**, because making a claim precise means changing it, and #88 forbids hand-editing. It refuses identity and lifecycle fields, refuses trace fields (links keep their own guards, #101), and marks an **approved** artifact `amended` when its payload changes (#16) while leaving a draft alone. | **Caught on the correction to the previous correction, which is the useful part.** #101 split `AST-0002` because the evidence did not bear on it; the replacement `AST-0003` was written as *"passes reliably under full-suite parallel load"* — and **a single failure does not contradict "reliably" either.** The link would have been wrong a second time, for a subtler reason: not evidence attached to the wrong claim, but evidence attached to a claim **too vague to be contradicted by anything.** ⚠️ **This is the same failure as #82's status split and #96's verdict split, one level up.** There it was a field carrying two meanings; here it is a *sentence* carrying two claims — a universal one and a statistical one — and the evidence can only bear on one of them. **Splitting was the fix all three times.** ⚠️ **And it is why `contested` needs guarding twice over:** #101 showed structural checks cannot establish bearing; this shows that even a correctly-attached record proves nothing if the claim it attaches to cannot be falsified. **A claim nothing could contradict is not a claim the evidence model can help with**, and it will read as `supported` forever. _(Recorded 2026-08-18. `AST-0003` now reads `refuted` — correctly, and for the first time.)_ |
| 103 | A revision amends an approval only when the change is material | **`reviseArtifact` classifies every changed field through #84's effective schema and amends an approval only if at least one is material. Cosmetic-only edits leave `approved` intact** and are routed to #63's activity log rather than the change feed. **Materiality is never inferred from field names.** Default by class — cosmetic does not amend, everything else does — with a per-field override, `x-amendsApproval`, for the cases the class gets wrong. `tags` declares `false` on every type. The tool returns `changedFields`, `amends` and `stream` so callers route rather than re-derive. | **The generic mutation contract created in #102 had a bug the moment it existed: it treated "the payload changed" as a materiality class, and it is not one.** Under that rule, fixing a typo in an approved artifact's `rationale` would have reopened it — **breaking #63's explicit promise that cosmetic edits never prompt**, and doing so through a tool written to make corrections safe. The failure would have been quiet and cumulative: an approval that reopens for a wording fix trains the PM to re-approve without reading, which is the same erosion #46 describes for a lint that blocks mid-thought. ⚠️ **Advisory is the honest hard case and it is handled by declaration, not by cleverness.** `priority: must → should` plainly reopens an approval; `tags` plainly does not; both are advisory. So the class default is conservative — advisory amends — and a field may say otherwise. That is the per-field nuance #61 already parks as unresolved, given a mechanism rather than a resolution. ⚠️ **A generic operation inherits every distinction its specific predecessors made implicitly.** `writeReviewStatus` could only touch one field, so it could not get this wrong; `reviseArtifact` can touch any field, and the moment it could, it did. **Worth checking the next generic thing the same way**, because the pattern is the generalisation losing a guard nobody noticed was load-bearing. _(Recorded 2026-08-18, one exchange after #102 created the contract.)_ |
| 104 | 5c — the evidence slice, proven by what it refuses | **The slice runs `requirement → assertion → research → evidence → validation → confidence → runbook step → lint → render` end to end, and the load-bearing half is the three REFUSALS before the promotion.** A mutating step whose premise is `unresolved` blocks · with **source support only** it still blocks, at rung 2 against a required rung 4 · with an experiment in the **wrong environment** it still blocks, because the mismatched record is filtered out entirely rather than counted weakly · only an **applicable** experiment clears it. Every transition goes through the typed operations, and no artifact on disk holds a derived `verdict` or `confidence` at any point in the sequence. | **Without the negative control the slice proves that a well-supported claim passes, and says nothing about unsupported claims being stopped — which is the whole of REQ-0009.** A green end-to-end test on the happy path would have been the most reassuring possible way to leave the central promise untested. ⚠️ **The control was itself falsified before being trusted:** short-circuiting `mayBecomeInstruction` to always allow makes the slice fail at the first refusal, and restoring it makes it pass. Same discipline as removing the lock to prove the concurrency test had teeth (#88) — **a check nobody has watched fail is a check nobody should trust.** ⚠️ **Step 3b is the one that would have been skipped.** An experiment that ran in the wrong environment is the tempting middle case: it feels like partial evidence and it is *none*, because #96 filters it before the verdict rather than discounting it after. Asserting the confidence stays at `source-supported` — not somewhere between — is what pins that. ⚠️ **`research-finding` is activated but unimplemented**, so the research phase is represented by its output: a `source` evidence record carrying the citation. That is honest rather than complete, and the gate says so (#94). _(Recorded 2026-08-18. 104 tests.)_ |
| 105 | `question` is built, and applicability is claim-relative | **`question` implemented — schema and typed tool — because it passes #41 on its own terms rather than because the gate reported a gap.** It is traversed by `decision.addresses`, `requirement.openQuestions`, `assertion.openQuestions` and more, and it holds state nothing else can supply: `resolution`, `answer`, and `blocks`. ⚠️ **`resolution` is a THIRD axis alongside `reviewStatus` and `lifecycle` (#82)** — a question can be *approved*, *active* and entirely *unanswered*, and collapsing any two of the three loses exactly that. ⚠️ **Separately: applicability is CLAIM-RELATIVE.** An excluded evidence record is no evidence *for this assertion*; it is not discredited, and may be sound evidence for a differently scoped claim. The code and the view now say so. | **The third axis is the fourth instance of the same pattern and it is now predictable enough to look for.** `status` → `reviewStatus` + `lifecycle`; materiality's transition problem; `confidence` + `verdict`; now review, standing and *settledness* as three separate questions about one artifact. **When a proposed field's answer changes depending on which question you are asking, it is more than one field.** ⚠️ **The wording correction matters more than it looks.** "Excluded" reads as *rejected*, and #96's filter does not reject anything — it asks whether a record bears on **this** claim in **this** environment. An Ubuntu experiment says nothing about a RHEL claim and everything about an Ubuntu one, and a model that let "excluded here" drift into "worthless" would quietly discourage recording exactly the evidence a differently-scoped assertion will need. ⚠️ **The unresolved concurrency diagnosis is now `QST-0001`**, with its reopening condition, rather than a code comment and a commit message. That is REQ-0014 used on the project's own open question — the thing that had been carried informally for two days precisely because there was nowhere to put it. _(Recorded 2026-08-18. 109 tests.)_ |
| 106 | An activated gap is not proof the type is well-founded | **Before implementing any remaining catalogue type, apply #41 explicitly: name the state it owns that nothing else can supply, and name the consumer that must traverse it. `question` passed and is built (#105). `research-finding` and `runbook` have NOT passed and are not being built** — they are recorded as `QST-0002` and `QST-0003`, each with what would resolve it. A `gate/type-not-implemented` finding says the project **activated** something it cannot express; it says nothing about whether the type should exist. | **5c may have produced evidence against two catalogue assumptions, and the gate cannot tell the difference.** The slice completed the **research semantics with no `research-finding` artifact at all**: a `source` evidence record carried the citation, an `assertion` carried the claim, and `question.answeredBy` carried what settled it. Stage 3's declared outputs map onto existing types almost completely — *source inventory* → `evidence.sources`, *hypotheses requiring validation* → an `assertion` at rung 1, *findings doc / feasibility notes / prior art* → prose, which #41 leaves free. The one uncovered candidate is *"contradictory sources resolved or surfaced"*, and that may be an assertion with a `contested` verdict rather than a new type. **`runbook` is weaker still under #87:** membership is `runbook-step.partOf` reversed (#84), ordering is `ordinal` plus `dependsOn`, and an aggregate belongs at **handoff as a projection**. Its only real candidate is **sequence-level state no step owns** — a precondition for the whole run, abort criteria, a rollback spanning steps — and #58's floor is per-step, so a runbook-level abort genuinely has nowhere to live. That is a case worth making, and it has not been made. ⚠️ **The failure this prevents is building a type because something reported it missing.** #94 made the gate accurate about capability; accuracy about capability is not evidence about design, and treating a worklist as a mandate is how sixteen types get built because a catalogue written before any of them existed said sixteen. **#38 is still the critical path, and shrinking it is allowed to be an outcome.** _(Recorded 2026-08-18.)_ |
| 107 | Retiring a type moves three authorities at once | ⚠️ **Scope, stated because it was got wrong once (#121): this row is about RETIRING A TYPE FROM THE CATALOGUE, not about a project activating or deactivating one.** Project activation is project-scoped (#95) and touches `project.yaml` alone. **If `QST-0002` or `QST-0003` resolves against its type — or any catalogue type is ever dropped — three things change together: `project.yaml`'s `activated`, the authoritative stage definition's `produces[]`, and **#38's catalogue itself**. Deactivating alone is not retiring.** Enforced where it can be: `stage/produces-unknown-type` errors when a stage claims to produce a type the catalogue does not contain. ⚠️ Separately: **`question.resolution` stays domain state and is never promoted to the envelope.** | **Deactivating a rejected type would make the gate skip it while the methodology still claims it as an output — and the skip is what hides the contradiction.** #94 taught the gate to ignore unactivated types, which is right for a project using a subset of a real catalogue and exactly wrong for a type that should not exist. The result would be `stages/` asserting stage 3 produces something nothing can make, with no finding anywhere, because the one component that would have complained was told not to look. **A silence produced by a correct rule is the hardest kind to notice.** ⚠️ **The lint covers the half that is mechanical and not the half that matters most.** It can see a stage claiming a type absent from the catalogue; it cannot see a type still in the catalogue that nobody believes in. The three-way update is a discipline the rule supports rather than replaces. ⚠️ **On `resolution` staying local:** the split-first rule (#82, #96, #105) says split when one field carries two meanings. **It does not say every split belongs to everybody.** `resolution` is meaningful for a question and meaningless for a requirement; promoting it to the envelope would force sixteen types to answer a question only one of them is asking, which is how a shared primitive becomes a shape nothing quite fits. _(Recorded 2026-08-18.)_ |
| 108 | QST-0001 answered — a lock-**acquisition** defect, reproduced | **`openSync(lockPath, "wx")` returns `EPERM` rather than `EEXIST` under contention on Windows, and the retry loop was keyed only on `EEXIST`, so a transient was treated as fatal.** Reproduced on run 19 of a declared 40: one child of six failed in **507ms** with `EPERM`, the other five allocated distinct IDs, **no duplicate ID occurred**. Fix: retry `EEXIST · EPERM · EBUSY · EACCES` on acquisition. Post-fix matrix — isolated 40/40, full parallel 30/30, full serial 10/10 — **80 runs, no recurrence.** | **The mitigation was wrong, and the bounded matrix is what showed it.** `maxWaitMs` was raised 10s→30s on 2026-08-18 against an unconfirmed "timeout under load"; the observed failure took **507ms**. It has been reverted, because keeping a setting whose justification was disproven is how cargo-cult configuration accumulates. ⚠️ **The lesson was already in this document and had not been generalised.** #72 says *"the rename retry is not optional on Windows"* and lists `EPERM`/`EBUSY`/`EACCES`. The identical family on `open` was never considered — the same platform, the same codes, one function call away. **A finding recorded about one syscall is not a finding about the platform until someone makes it one.** ⚠️ **The instrumentation was validated before it was trusted:** forcing `maxWaitMs: 1` produced five children classified `lock-acquisition-timeout` and the assertion *"NOT a serialisation result"*, proving the classifier distinguishes causes rather than reporting whichever assertion trips first. ⚠️ **Non-reproduction is recorded as bounded, not as proof:** at a 10% per-run rate, 30 parallel runs would miss a recurrence about 4% of the time. `AST-0003` stays `refuted` and is now **scoped to the pre-fix code** — as first written it named no code version, so evidence of the old system would have gone on refuting a claim readers would take to be about the current one. **An assertion about software needs the software in its `targetEnvironment`**, or evidence outlives the thing it was about — #79's staleness arriving through scope rather than timing.  ⚠️ **Scoped correction, same day: "never serialisation" was an over-claim and is withdrawn.** Run 19 proves the **reproduced** failure was `EPERM` with serialisation intact. It does not prove the **original** 2026-08-18 occurrence was, because that one's output was never captured and nothing observed distinguishes this defect from any other cause. **The strongest honest form:** a pre-fix defect could fail lock acquisition under Windows contention because `EPERM` was not retried; the instrumented matrix reproduced that defect and serialisation remained intact in the reproduced event; the original occurrence is **unclassifiable**, but this defect explains its observed shape and did not recur across the bounded post-fix matrix. ⚠️ **`EVD-0003` still supports only *"the test failed once"* and nothing about why.** It refutes `AST-0003` and is deliberately **not** linked to `AST-0004` — an unclassifiable observation cannot bear on a claim about a cause (#101), and **answering the question did not make that record classifiable in hindsight.** The temptation to attach it retroactively is exactly the polarity-from-feel error #101 records, arriving dressed as a tidy conclusion. _(Recorded 2026-08-18. Answered as QST-0001; AST-0004 and AST-0005 carry the claims.)_ |
| 109 | QST-0002 unresolved, with bounded evidence against | **Stage 3 ran for real and needed no `research-finding`.** The reproduction and the matrix went to `evidence(kind: experiment)`, the cause and the post-fix behaviour to `assertion`, the diagnosis to `question.answer` + `answeredBy`, and the matrix design, instrumentation-validation and power calculation to prose in `summary`/`notes`. **Nothing was left without a place and nothing had to be forced into one.** ⚠️ **This does not resolve the question, and it is recorded as unanswered.** | **QST-0001 was an EXPERIMENTAL question, answered by running things — which exercises exactly half of stage 3.** It involved no source inventory, no synthesis across several sources, and **no contradictory sources needing resolution**, which is where `research-finding`'s strongest candidate lives, since stage 3's exit criterion names that case explicitly. ⚠️ **Declaring the type unfounded on this evidence would be the same error as building it because a gate said "missing" (#106)** — a conclusion drawn from the half of the space that happened to get tested. **Resolving it needs a stage 3 run on a question answered by *reading* rather than running.** _(Recorded 2026-08-18.)_ |
| 110 | Next.js reading phase — three constraints, none yet validated | **`QST-0004` asks whether a Next.js dev app can reflect externally written artifacts and do lock-protected write-backs without relying on HMR, stale server state or framework caching. The reading answers it conditionally, at rung 2 (`source-supported`), and validation is owed.** Three claims, each **scoped by mode**: **(AST-0006)** with `cacheComponents` disabled — the default — `next dev` renders every page on demand and never caches; **(AST-0007)** with Cache Components **enabled**, `fs.readFileSync` in a Server Component is a *"predictable value"* baked into the static shell, while `await readFile()` is uncached data needing `use cache` or `<Suspense>`; **(AST-0008)** Next.js has **no mechanism to learn that an external process wrote a file**, in any mode — invalidation is triggered by the app's own Server Actions or Route Handlers. | **The design guidance falls straight out and is worth having before anyone starts: don't enable Cache Components; if it is ever enabled, never read an artifact synchronously; keep the route dynamic; and supply the external-change signal yourself — which is exactly what the skeleton's chokidar watcher plus SSE already does (#100).** ⚠️ **The trap is that the SIMPLER call is the unsafe one.** `fs.readFileSync` is the obvious way to load a small JSON artifact and it is the one that silently freezes into the static shell. A page that renders correctly on first load and never changes again is #100's warning arriving through a documented, intended feature rather than a bug. ⚠️ **#12 makes AST-0008 structural rather than a configuration detail.** The agent works in a terminal that knows nothing about the dev server, so **every artifact write is external by construction** — the case Next.js has no answer for is the only case this product has. ⚠️ **All three are rung 2 and stay there until validated.** They are read, not run — the distinction this whole document is built on, and #76's own history is the argument: reading `security.md` produced a confident, correct-sounding trust design that #67 then had to have measured. _(Recorded 2026-08-18. Validation is the outstanding half of QST-0004.)_ |
| 111 | QST-0002, second partial result — the contradiction dissolved by scoping | **A reading-based stage 3 was run — the case the first result said was missing — and it still needed no `research-finding`.** Source inventory → three `evidence(kind: source)` records carrying citations in `sources`. Claims → three assertions. ⚠️ **Contradictory sources WERE encountered**: two pages of the same official documentation give the same operation opposite treatment. **And the contradiction dissolved rather than needing a home** — the sources do not disagree, they describe two different modes, and scoping each assertion's `targetEnvironment` by `cacheComponents` enabled/disabled resolved it completely. **Still unanswered**, because the disagreement was *resolvable*. | **Stage 3's exit criterion — "contradictory sources resolved or surfaced" — was satisfied by SCOPING THE CLAIMS, not by a narrative artifact.** That is the same move that fixed `AST-0003` when it named no code version, and it is what `targetEnvironment` exists for: an apparent contradiction between sources is very often two true claims about different configurations, and the fix is to say which is which. ⚠️ **The evidence against `research-finding` now covers both halves of stage 3** — the experimental (#109) and the documentary. ⚠️ **What still has not been met is a genuine UNRESOLVED disagreement**: two authorities making incompatible claims about the *same* configuration, where scoping cannot separate them and someone has to record which was believed and why. That remains the one case the type might own, and until it occurs the question stays open — closing it now would be the mirror of #106's error, concluding from the half of the space that happened to get tested. _(Recorded 2026-08-18.)_ |
| 112 | QST-0004 answered — Next.js works in `next dev`, with one condition it does not supply | **Measured across a 2×2 matrix — `fs.readFileSync` / `await readFile` × `cacheComponents` disabled / enabled — on Next.js 16.3.1, React 19.2.8, Node v24.18.0, Windows 11, `next dev`. ALL FOUR CELLS behaved identically: nothing happened during a 10-second quiet window after an external write (0 requests, 0 reads), a fresh request returned the new value, and module-scope server counters confirmed a genuine re-read rather than a replay.** ⚠️ **The condition: an external write alone produces nothing.** The application must supply the change signal. An SSE route watching the data directory delivered the event to a connected client in both modes and a reload then showed the new value — **which is exactly what the framework-free skeleton already does**, so the pattern carries rather than needing replacement. | ⚠️ **`AST-0007` was REFUTED, and it was a documentation-derived claim.** The docs say a synchronous `fs` read is a *"predictable value"* prerendered into the static shell; in `next dev` it re-read every time. The claim named **no mode**, the docs describe *"at build time"*, and in dev there is no build — **the identical defect as `AST-0003`, one day later.** A claim about software that does not say which mode of the software it is about. ⚠️ **It now reads `contested`, and the contest IS the diagnosis** — the source supports it, the experiment refutes it, both applicable precisely because it is under-scoped. Kept contested on purpose rather than tidied away: a live example of #96's verdict surfacing a condition without guessing its cause, where the cause turned out to be **a modelling error in the claim rather than disagreement about the world.** Resolved by splitting into `AST-0010` (build mode, source-supported, untested) and `AST-0011` (dev mode, confirmed). ⚠️ **The build-mode half may never matter** — #2 and #22 make the app local-only, so `next dev` might be the only mode this product runs in, and **nobody has decided that.** ⚠️ **One harness fault was found and discarded before any result was recorded:** the counters route used `dynamic = "force-dynamic"`, which Cache Components rejects outright, 500-ing the whole app. Both enabled cells first failed for that reason and **not** for anything about filesystem reads — *failure before the observation point is not negative evidence.* _(Recorded 2026-08-18. Reopens on adopting `next build` or upgrading past 16.3.1.)_ |
| 113 | A matrix experiment is N experiments | **An experiment run across a matrix must be recorded as one evidence record PER CELL, each with that cell's exact environment facts. A single record describing the whole run cannot bear on any claim about one configuration.** | **Caught by the applicability filter rather than by review, which is the part worth keeping.** The first attempt recorded one record with `cacheComponents: "both"` and `readApi: "both"`. Those values **environment-MISMATCH** every claim naming a specific mode, so #96's filter excluded it from all four assertions — every one stayed at `source-supported` with the experiment sitting there ignored. **The filter was right and the modelling was wrong**, and the symptom was silence: no error, no finding, just claims that would not move off rung 2 while an experiment that appeared to support them existed. ⚠️ **The general form: an environment fact whose value is `"both"`, `"various"` or `"all"` is not a fact.** It is a summary of several facts, and a summary cannot match a specific claim — nor should it, because the whole point of the filter is that evidence bears on the configuration it was actually observed in. **Keep the summary record if it is useful, unattached, carrying the protocol** — the per-cell records carry the bearing. _(Recorded 2026-08-18.)_ |
| 114 | `setLifecycle` — #83's retirement policy had no mechanism | **A typed operation that moves an artifact's `lifecycle`, and the fourth mutation. `supersededBy` is promoted from `decision` to the ENVELOPE — the shape lives in `common`, each type narrows `x-traceTarget` to what may replace it, the same pattern as `id` and `type`. Superseding requires naming successors; refused earlier by the tool, enforced by a conditional in the schema.** | **#83 said tools never physically delete and that removal is `lifecycle: retired`. Nothing could set it.** `reviseArtifact` refuses lifecycle deliberately (#102), so the only route to retiring an artifact was hand-editing JSON — which #88 forbids. **A policy with no mechanism is a policy nobody can follow**, and it went unnoticed for as long as nothing needed retiring. ⚠️ **#82 predicted the promotion trigger exactly** — *"may promote to the envelope if a second type needs it"* — and a second type needed it the moment an assertion had to be superseded. The narrowing pattern is what made promotion possible without a generic target: the envelope cannot say what replaces an artifact, because that differs per type, so it declares the shape and each type says the rest. ⚠️ **`AST-0007` is now superseded rather than actively contested.** Its evidence and derived verdict are preserved historically; `AST-0010` and `AST-0011` are the live claims. **`contested` must mean unresolved disagreement, not a diagnosed defect kept as current state** — leaving it live would have taught readers that contested is a place claims sit rather than a condition to resolve. _(Recorded 2026-08-18.)_ |
| 115 | The write-back half of QST-0004, which the first answer did not prove | **A Next.js route handler calling the repo's real `writeReviewStatus` — lock → fresh read inside the lock → validate → atomic write, nothing reimplemented — behaves correctly in BOTH `cacheComponents` modes: only `reviseStatus` changes with every other field byte-identical, a request for any non-`reviewStatus` lifecycle value is refused 400 with the artifact unchanged, the lock is released, no temp file remains, and the Next.js write BLOCKS while an external process holds the lock, completing after release (~1.3s).** | **The first answer proved three things and was reported as if it proved four.** External writes produce no framework signal · fresh dev requests re-read · watcher plus SSE supplies the missing signal — none of which is the write-back. **Review caught the overreach; the experiment had simply not touched the mutation path.** ⚠️ **#100 named the specific interaction to fear — React's state model against #78's lock — and it did not materialise.** The route handler is ordinary server code; the lock is an OS-level exclusive create; nothing in the framework participates. **Naming the fear precisely is what made it cheap to test**, and the same debt phrased as *"is Next.js risky here?"* would have been untestable. ⚠️ **The external-holder case is the one worth keeping.** #12 makes a concurrent external writer the normal condition rather than an edge case, and this is the only cell that exercised it: the framework waited, which is the whole point of #78 holding across a read-modify-write. _(Recorded 2026-08-18. `AST-0012` carries the claim.)_ |
| 116 | Adopt Next.js when product UI work begins, not as cleanup | **The walking skeleton is NOT migrated as cleanup. When product UI work begins, the product shell is built in Next.js, carrying forward the validated watcher / SSE / write-back contract. Migration is feature work, not framework conformity.** `AST-0010` — Cache Components under `next build` — becomes **blocking only when a production build enters scope**. Recorded in the project's own content as **`DEC-0001`**, the first `decision` artifact this system has written about itself. | **QST-0004 removed the reason the skeleton was framework-free, and that is not a reason to migrate.** #100 chose a plain server because #5's Next.js choice was untested and the risky surface was the watcher, not the renderer. That surface is now measured — reads, refresh, and the lock-protected write-back including an external lock holder — so the framework is validated. **Nothing forces a migration: the framework-free server already does what Next.js was validated to do.** What Next.js buys is **product** — MDX rendering, the interactive components #54 names as the v1 flagship, and #19's `site/` build path. ⚠️ **Migrating for its own sake would trade a working proof of the substrate for no capability**, and would do it at the moment that proof is most useful: as the reference the Next.js shell has to match. ⚠️ **The skeleton is therefore RETAINED DELIBERATELY**, not carried as a deviation owing a migration — which is what #100 left it as, and what this row changes. ⚠️ **And testing `AST-0010` now would validate a deployment mode the project has not decided to use.** #2 and #22 make the app local-only, so a production build may never happen; the honest order is decide first, then measure. _(Decided 2026-08-18. Discharges #100's debt.)_ |
| 117 | Constructed fixtures prove branches; live state proves wiring | **Two kinds of test, and they must not be confused. (a) **Constructed** fixtures exercise every branch of a rule — for the capability check: implemented · schema-only · tool-only · neither — from data the test controls. (b) **Live** project state proves the real catalogue, activation list, schemas and tool registry are wired together consistently, asserting **that classification is ACCURATE**, never that a particular gap still exists.** A live test must not fail because the project improved. | **Learnt by writing a test that passed until the project got better.** #94's partial-gap case used `decision` as its example, borrowed from live content; the moment `createDecision` was written (#116) it started failing — an improvement presenting as a regression. Replacing it with `runbook` would only have moved the trap: implementing or retiring `runbook` breaks it again. **A test that draws its fixture from live project state passes until the thing it depends on is fixed**, and its failure then carries the opposite of the message a failing test should carry. ⚠️ **The live half is still worth having, and this is the shape:** for every activated type a stage produces, compute the expected `missing` from the schema set and the tool registry and assert the gate agrees. That fails when the catalogue, activation, schemas and registry **disagree with each other** — a real defect — and passes through every legitimate change to what is implemented. It also carries a wiring invariant nothing else checks: **every registered tool must have a schema**, because a tool for a type nothing can validate leaves #88's second boundary with nothing to check against. ⚠️ **Both halves were falsified before being trusted:** disabling the tool check fails 3 tests, disabling the schema check fails 2, and both #94 tests are among them each time. _(Recorded 2026-08-18.)_ |
| 118 | Stage 4 run — nine of fourteen requirements met, and the original complaint is not one of them | **Walked all fourteen active requirements against what exists in the repo. Nine have an implementation path. Five do not: REQ-0003 (research), REQ-0005 (execution), REQ-0010 (handoff), REQ-0011 (half — machine-readable yes, human half unsettled), REQ-0012 (decided but unenforceable). Five `question` artifacts raised with `blocks` edges, none decided — stage 4 is `decidedBy: User`.** | ⚠️ **REQ-0003 is the uncomfortable result.** *"The agent cannot research"* is the intake's problem 2, in the PM's own words — *"educated guessing"* — and it is **still true.** Stage 3 was answered by reading, but by **the agent running that session, not by the product.** The capability the whole project exists to fix has not been started, and running the methodology is what surfaced that rather than a roadmap review. ⚠️ **REQ-0012 is decided and unenforceable, which is a state worth naming:** #77 settles authorisation for costly validation, and nothing can spend money, so no code path enforces it. A rule with nothing to govern reads as satisfied. ⚠️ **QST-0009 exists because stage 4's exit criterion turns on an undefined word** — *every **blocking** gap has a user decision recorded.* Without a definition the stage cannot be exited honestly in either direction. **Second seam found in #91's draft-made-authoritative table**, and the first one that blocks a stage rather than mis-scoping a type. _(Recorded 2026-08-18. Gate correctly NOT READY.)_ |
| 119 | The catalogue, judged by demand rather than by the catalogue | **Stage 4 produced the first evidence about #38's types derived from what the requirements ask for. `task` and `role-assignment`: demand exists via REQ-0010 and #19's per-role slices, conditional on QST-0007. `acceptance-criterion`: no direct demand. `risk`: NO requirement mentions risk at all.** | **`risk` is in #38's sixteen, stage 6 declares it, and nothing the PM asked for requires it.** That is not proof it should go — the intake was not exhaustive and a risk register is a normal thing to want — but it is **the first evidence about a catalogue type derived from demand rather than from the catalogue**, which is exactly what #106 said should decide. ⚠️ **Note the asymmetry with `research-finding` and `runbook` (#109, #111):** those were questioned because the methodology *did the work without them*. `risk` is questioned because **nothing asked for it in the first place** — a weaker signal, since absence of demand in one intake is not absence of demand. Recorded as a finding to carry into stage 6, not as a verdict. ⚠️ **And the agent half now has a demand-based justification rather than an availability-based one:** REQ-0003, REQ-0005 and REQ-0012 have **no vehicle except the specialist contracts** (#26). That is a stronger reason than being next on a list — but it does not set the order, because QST-0005 and QST-0006 come first. **A research specialist with no research capability, or a validation specialist with no sandbox, is #67's toolless child in a different costume: a contract with nothing behind it.** _(Recorded 2026-08-18.)_ |
| 120 | What makes a requirement gap **blocking** | **"An unresolved question is blocking when proceeding would require a load-bearing commitment whose correctness materially depends on its answer, OR when its absence makes the current stage's exit criterion unevaluable. Missing implementation alone is work, not a gap."** Recorded as `DEC-0002`, answering `QST-0009`. Applied: **QST-0005 and QST-0006 block the specialist contracts** · QST-0007 blocks handoff design only · QST-0008 blocks conditionally, latent under #116. | **Stage 4's exit criterion turned on a word the stage table never defined**, so the stage could not be exited honestly in either direction — everything could be called blocking, or nothing. ⚠️ **The definition separates two things that were being conflated:** a decision whose absence would make the next commitment possibly *wrong*, and work that is simply not *done*. Five requirements have no implementation path (#118) and **none of them is a gap by this rule** — they are work. What blocks is not knowing what will implement them. ⚠️ **The second clause is self-referential on purpose**, and QST-0009 was its own first instance: a question whose absence makes a criterion unevaluable blocks by construction. ⚠️ **The gate moved from `criterion-pending-human` to `criterion-not-satisfied` — the first time on real content.** #93 argued that a stage blocked because someone looked and said no is in a **known** state while one blocked because nobody looked is not; that distinction is now demonstrated rather than asserted, and the difference is visible in the gate output. ⚠️ **`writeStageAttestation` had to be built to do it** — the module could read evaluations and not write them, so the only way to attest was hand-editing JSON. **Third instance of the same shape** after `unlinkEvidence` (#101) and `setLifecycle` (#114). ⚠️ **Corrected 2026-08-18: a reader does not imply a writer, and stating it that way would license mutation APIs built for symmetry.** The defect is narrower and sharper: **the workflow AUTHORISES a state transition and provides no typed operation for performing it.** `loadStageAttestations` was not wrong for being read-only; it was wrong because #93 authorises a human to record a verdict and nothing could. See #121 for the audit that criterion produced. ⚠️ **On `risk` (#119): weak negative evidence is not grounds for retirement.** Stage 6 is its honest pressure test, the same way stage 3 was `research-finding`'s. _(Decided 2026-08-18.)_ |
| 121 | Capability honesty, and the audit the corrected criterion produced | **A specialist contract may only describe capabilities the host can **supply AND detect**. Where a named capability is unavailable, the specialist produces an explicit refusal or a recorded gap — never proceeds by guessing. (`DEC-0003`.)** ⚠️ **And the audit criterion is: the workflow AUTHORISES a state transition but provides no typed operation for performing it** — not "a reader exists without a writer", which would license mutation APIs built for symmetry. | **This generalises #81 from typed tools to any declared capability, and #67 measured why.** A trust-denied child completed a normal-looking session with the typed tools absent and nothing reported it. A research specialist with no search, or a validation specialist with no sandbox, fails identically: **plausible prose in place of an answer**, which is the intake's original complaint restored inside the machinery built to fix it. ⚠️ **Detectability is the load-bearing half.** A capability the host cannot *check* is one the contract cannot honestly promise, and "supply" alone would permit a contract that is true on Monday and silently false on Tuesday — #108's stale-blocker lesson applied to capabilities. ⚠️ **Boundaries before mechanisms** on both blocking questions: QST-0005 now names what counts as research, where access comes from, how provenance is retained, and what happens when it is unavailable; QST-0006 names what may execute, per-tier filesystem/network/credential limits, resource ceilings, cleanup, and **which observations survive as evidence** — that last because #96's applicability filter can only work on facts that were actually captured. ⚠️ **The corrected criterion immediately found one real defect the loose version would have buried in noise: `QST-0010` — approving artifact type activation (#39) has no typed operation.** Every other authorised transition has one; this is the last performed by hand-editing a file. ⚠️ **Corrected the same day: an earlier draft said this operation must also move `stages/` and #38 with it. That crosses the line #95 draws.** **Project activation must NOT rewrite the catalogue or the methodology** — #107's three-authority update applies when a type is **retired from the catalogue**, not when a project activates or deactivates an existing one, and a project-scoped approval that edited `stages/` or #38 would silently become a product-wide design change. The operation **validates against** them and never writes to them: the type exists in the catalogue, and the activation is compatible with the stage definitions. **Not blocking under `DEC-0002`** — nothing pending requires an activation change, so it is work rather than a gap. _(Recorded 2026-08-18.)_ |
| 122 | The evidence-survival contract — a missing fact must stay visibly unknown | **A sandbox run must declare what survives it as evidence: environment facts, tool and runtime **versions**, inputs, outputs, exit status, timing, permission denials, and **explicit redaction or omission reasons**. A fact that was not captured must be visibly absent WITH ITS REASON, never simply missing.** Owed by `QST-0006` before any tier is implemented. | **#96's filter treats an absent environment fact as `unknown` rather than `mismatch`. ⚠️ Stated precisely, because the first draft of this row got it wrong: the record stays fully APPLICABLE and still bears on the claim — what the absence changes is the ATTAINABLE RUNG, capping it below `environment-matched`. A silently omitted fact therefore decides how strong a claim can ever become, and no reader can tell it happened.** That is the same silence as #94's capability gap and #107's deactivated type: a correct rule producing an invisible outcome. **Recording why a fact is absent is the difference between *"we did not observe this"* and *"this was not observable"***, and those license completely different conclusions about a claim. ⚠️ **Versions are called out separately because they are the fact most often assumed and least often recorded.** `AST-0003` and `AST-0007` were both mis-scoped for exactly that reason — evidence that never said which build it observed, refuting claims readers would take to be about the current one. **An environment without versions is a description of a category, not of a run.** ⚠️ **Consequence to settle with the schema:** `evidence` may need a declared place for omissions. ⚠️ **And it records why the OBSERVER lacks the fact, never whether the fact matters.** Relevance is claim-relative (#105) — the same record may be decisive for another assertion — so `not relevant` is not a property evidence can honestly hold. The honest states are observation-side: **not captured · not observable · unavailable · redacted, with a reason.** The applicability layer then decides whether the missing fact matters to a particular claim, which gives the field a real consumer and is what passes #41. ⚠️ **Its exact shape waits for QST-0006**, because the states worth declaring are the ones a sandbox can genuinely DETECT — declaring a state nothing can distinguish would be the same error as promising a capability the host cannot check (#121). _(Recorded 2026-08-18.)_ |
| 57 | Confidence threshold | **Per step class, not one global number.** `informational` needs rung 2, `mutating` rung 3, `destructive` rung 4 — and anything hardware/kernel/driver-dependent needs rung 4 regardless of class. Below threshold, the planning agent raises a validation task, escalates to the PM, or ships the step flagged `unvalidated` with a required reason. `project.yaml` may **raise** the mapping, never lower it. | One number can't be right for both `cd /opt/app` and `rm -rf /var/lib/pgsql/data`. Too low and the runbook is model guesses wearing an evidence layer; too high and nothing ships. Lowering is forbidden because it would make rung 3 mean different things in different projects, which is the ladder's only real property. See "The threshold" below. |
| 58 | Who classifies a step | **The planning agent assigns the `class`, and the lint enforces a floor.** Known-destructive command patterns force `destructive` regardless of what the agent said. Every class is visible in the runbook view. | #57's bar is set by the class, so an agent that assigns its own class can lower its own bar — the same self-grading hole as a silent tier downgrade (#56). Pattern-matching catches the dangerous case mechanically without putting an approval step in front of the other 95% of rows. |
| 59 | Who authorizes an unvalidated step | **The PM acknowledges each one at the stage-9 gate.** The agent flags them as it goes; `npm run handoff` presents the list and requires per-step sign-off before the package freezes. | A review at the end rather than an interruption mid-flow, which is what keeps it from becoming the prompt everyone clicks through. And if there are forty of them, being made to look at forty of them is the correct outcome. |

### Tooling & lint

| # | Question | Decision | Why |
|---|---|---|---|
| 46 | Lint enforcement | **Warn continuously, block at exactly two boundaries** — the stage transition and `npm run handoff`. | Blocking mid-thought is wrong; blocking at a gate is the entire point of having gates. A lint that blocks while you're drafting gets disabled within a week. |
| 47 | Lint implementation | **One implementation, three callers** — `npm run lint:plan`, the app on save, and a Pi extension hook. | Three copies of the rules is three sets of rules within a month. **The same argument applies to the content path (#70)**: one resolver, every caller, and nobody joins their own — three hand-rolled path joins is three chances to find the tool's own shipped `planning-content/` instead of the project's. ⚠️ **Extended 2026-08-18 by #86's `payloadRef`: the resolver also owns *containment*, and the schema pattern does not.** `payloadRef.path` rejects absolute paths and literal `..` at the syntax level, and that is **validation, not a security boundary** — a syntactically innocent path can still escape the content root through a symlink or a platform normalisation quirk. So every consumer resolves a payload path **through this resolver**, which joins it to the content root, canonicalises both, and refuses anything that does not land inside. **Same argument as the row itself, one level down:** three hand-rolled containment checks is three chances to accept a path that leaves the project, and the failure is silent because the file it finds parses perfectly well. |
| 48 | Lint feedback loop | **A Pi extension hook runs the lint at turn end and feeds failures back to the agent. Build this early, not late.** | Plausibly the single highest-leverage item in this document. It turns the lint from a report into a self-correcting loop, and it's what makes provider-agnosticism (#10) *real* rather than nominal — a 7B model that can't produce a complete document first pass can absolutely fix a named gap on the second. |
| 49 | Setup script | **Idempotent and re-runnable**, each step checking its own precondition. Provider setup is the one step allowed to **fail without aborting** — the app comes up unconfigured with a banner. **Carries the project-trust step (#67a): ask once, record the decision in `~/.pi/agent/trust.json`.** Re-running finds the decision already present and moves on. **Also carries the consumer's `.gitignore` block (#71)** — appended once, marked, recorded, never re-added. | A setup script that can strand you halfway is worse than one that takes two runs. The trust step belongs here rather than in the delegation extension because it is a permission the PM grants, not one the tool asserts — and asking once, at the moment they are already setting the project up, is the only point where the question is in context. |
| 50 | Tool updates | **`git pull` inside `.planning/`**, then re-run `pi install -l ./.planning/pi-package` (#32). `project.yaml` carries a **schema version field** so the tool can detect and migrate older content. ✅ **Verified 2026-08-15: the reinstall is not required.** Local package paths are referenced, not copied — an edit inside the package took effect on the next run with no reinstall. Keep the reinstall documented as a repair step, not a mandatory one. | One update path for the whole tool, not one per half. #20 makes it safe by construction. |
| 51 | Clone remote | **`.planning/` keeps its own remote** — that's the update channel. | Being gitignored by the parent repo means no nested-repo confusion. |
| 52 | App's knowledge of the codebase | **Purely a document tool for v1.** It doesn't read source or link to files. | The *agent* can already read the codebase — that capability exists and doesn't need duplicating in the app. Revisit only if a real need shows up while working an actual plan. |

### Handoff & distribution

| # | Question | Decision | Why |
|---|---|---|---|
| 7 | Handoff runtime | **#2 is relaxed for stage 9 only.** The planning app stays local; the *handoff output* gets a deploy path so the team can actually reach it. | The plan has to leave my machine or it isn't a handoff. Nothing else about the app gets a server. |
| 8 | Who consumes the handoff | **Likely an AI agent team — but do not assume it.** The package must serve humans and agents equally. | Designing for only one closes the door on the other, and the guess is unverified. |
| 19 | Handoff package | `docs/plan/` committed into the real project repo: **`data/` + `docs/` + `site/` + `PLAN.md`**. Full package **plus generated per-role slices**. | MDX is an authoring format, not a delivery format. Slices are a *query* over the task graph, not separate authoring. See "The handoff package" below. |
| 20 | Tool ↔ content separation | Tool clones into **`.planning/` (gitignored)**. User content lives in **`planning-content/` (committed)**. Output in **`docs/plan/` (committed)**. | This repo must be able to improve without a user losing or rewriting their project documents. |
| 21 | Publishing | **Explicit command** (`npm run handoff`), never automatic when stage 9 hits done. | The command *is* the snapshot boundary: it runs the gate, stamps a version, freezes the bundle. Auto-publish would republish on every later edit — the moving target #19's freeze exists to prevent. |
| 22 | Distribution reach | **Local only.** No public URL, no auth story. The package travels as committed files. | Plans are sensitive. Hosting is a v2 question at best. |
| 53 | Versioning | **Git history is enough during planning.** Explicit versioning starts at `npm run handoff` (#21). | That's the only point a version number means anything to anyone. |

### Build & sequencing

| # | Question | Decision | Why |
|---|---|---|---|
| 54 | v1 components | **Schema designer + API spec** (stage 5 is the flagship), plus the **phase status board** and **change feed** as infrastructure. | Confirms the original suspicion. The board and the feed aren't components so much as the frame everything else hangs in. |
| 55 | Walking skeleton | Manifest → tracker view → one MDX doc rendering → status write-back — **plus the file watcher**. | #12 puts the agent in a separate terminal, which makes the watcher the entire integration surface between the two halves of the product. If it's not in the skeleton, the skeleton doesn't prove the thing that's actually risky. |
| 76 | The build order | **Five steps, in this order: (1) trust spike · (2) watcher spike · (3) four schemas · (4) run stages 1–2 on this project for real · (5) walking skeleton (#55) with the lint loop (#48) wired in during, not after.** Steps 1 and 2 are throwaway code answering yes/no questions; 3–5 are the product. The running detail lives in `next-steps.md`, which is a **running order, not a decision record** — where the two disagree, this row and this file win. | **Written down because this file kept citing it without defining it.** #72, the #31 successor, #74 and #75 all carry deadlines phrased as "step 3" or "step 5", and the imported-material table resolves an item as "merged into #26 and the build order" — a build order that existed only in the other file, which in turn declares *this* one canonical. That circularity is the whole reason for the row. The ordering itself is not arbitrary: **both spikes come first** because each gates a half of the product and one of step 2's answers (#72) is a constraint on the first typed tool written in step 3, so answering it afterwards means writing the schemas twice. **Step 4 sits between the schemas and the skeleton** because #43 makes templates *generated* from activated types, #39 makes activation a stage-2 decision, and stage 2 has not run — see #39's amendment. ⚠️ **The one claim worth stating precisely:** this is not a sequencing of the two halves. **Step 3 is the only dependency the app half and the agent half share**; whether anything actually runs in parallel is a question about headcount, and the answer here is one. ⚠️ **Where it deliberately stops:** at the first point the two halves touch. It does not cover the three specialist contracts, the remaining twelve artifact types, the sandbox tiers, or the runbook — which is to say the **evidence loop**, the most novel machinery in this document, is still ahead of it. Step 5 is the end of the beginning. ⚠️ **Amended later the same day, from the review document — the order grows from five steps to seven, and none of the original five moved.** Two **verification spikes** are inserted before step 3, because both are cheap, both are already known to be owed, and both are #80's second branch: (**2a**) **project trust** — reproduce exactly what the setup script will do, writing the entry into `~/.pi/agent/trust.json` rather than passing `--approve`, per the amendment to #67; and (**2b**) **the skill-override path** — prove that the directory and registration mechanism this product ships actually wins, per the caveat on #33. Neither is a design question any more; each is one binary result. And an **evidence vertical slice** is added after the skeleton (**step 6**): one assertion carried the whole way — requirement → assertion → research → validation → evidence → confidence rung → runbook step → lint → render. **The reason it earns a step rather than waiting for the catalogue** is the sharpest thing in the review document: the authoring loop and a working UI would together prove a *sophisticated documentation interface for AI-generated planning*, which is not the product's claim. The claim is a plan that knows which of its statements are guesses, which are documented, which were tested, and which are safe to become instructions — and **nothing in steps 1–5 exercises that at all.** One slice, one real assertion, deliberately cheap enough that the workflow rather than the infrastructure is what's under test. ⚠️ **Hard constraint, not a preference: broad catalogue expansion does not begin until the evidence slice passes.** Otherwise the slice is "next" on paper while twelve more schemas and the specialist contracts quietly harden conventions around an evidence model nobody has run. ⚠️ **And record the tension this ordering creates, because it is real.** Putting the slice after the skeleton means step 3's schemas and trace conventions already exist when the novel artifacts finally exercise them. That is acceptable and probably right — conventions need something to be conventions *of* — **but only while those conventions are still treated as revisable.** If the slice shows that `assertion`, `evidence` or `runbook-step` need trace semantics the first four did not anticipate, **that is the slice succeeding**, and the correct response is to change the conventions. The failure mode is the opposite reflex: contorting the evidence model to fit whatever step 3 happened to establish, which converts a finding into debt and wastes the step. **What the order actually is, once amended:** spikes remove mechanical uncertainty → schemas establish the authoring substrate → dogfooding tests the methodology → the skeleton proves the two halves can touch → **the evidence slice proves that what they produce is more than documentation.** Each step earns the right to make the next implementation commitment (#80).  ⚠️ **Amended again 2026-08-18 — the evidence types now INTERLEAVE with the skeleton rather than following it, and the reason came from running the methodology.** Step 4's stage 2, derived from the PM's own intake rather than from this architecture, put **seven of fifteen requirements on the evidence loop** and did not call for `schema` or `api-spec` at all. Combined with #38's already-recorded warning that `assertion`, `evidence` and `runbook-step` are **the types most likely to break the conventions settled in #82**, that makes the original order wrong in #80 branch-1 terms: the skeleton is where those conventions get poured into a renderer, a watcher and a status write-back, and building it first is a commitment made **before the types most able to falsify it exist**. The revised order: **(5a)** implement and pressure-test `assertion`, `evidence` and `runbook-step` against #82–#89, expecting the conventions to move · **(5b)** build the skeleton on the revised conventions, rendering an **evidence-oriented** artifact rather than another easy catalogue type · **(5c)** immediately complete the end-to-end slice — research → validation → confidence → runbook step → lint → render · **(6)** only then broaden the catalogue. **What this preserves:** the skeleton is still the point where rendering, watching, write-back and lint feedback become real, and the constraint from the earlier amendment stands unchanged — catalogue expansion waits for the slice to pass. **What it changes:** the substrate gets falsified before the UI hardens it, instead of after. _(Recorded 2026-08-18, describing an order in use since 2026-08-14; amended three times the same day.)_ |
| 80 | How the project manages uncertainty | **Three branches, in order. (1) Does this block the next *implementation commitment*? → decide it now, or spike it if evidence can decide it. (2) If not: would being wrong cause material rework or invalidate a load-bearing assumption? → run the cheapest *bounded* validation that can answer it. (3) Otherwise: record it as a numbered deferred decision carrying the specific condition that reopens it, and keep building.** ⚠️ **Branch 2 spikes are bounded by definition, not by intention** — a narrow question, observable pass/fail criteria, and a stated stopping condition, all three fixed *before* the spike starts. ⚠️ **And their evidence has to survive three known ways a spike lies to you. This is now a discipline rather than three tricks, all three paid for by runs in this document: (i) measure provenance or capability *before* model behaviour** — check 2 read the tool registry before the model ran; 2b read which file entered the system prompt. **(ii) A negative observation must prove it reached the observation point** — 2a's first run 4 wrote an empty transcript after a harness kill, and its "absent" would have read as a clean negative. **(iii) Where state is supposed to be reversible, add a reversal control** — 2a removed the trust entry and 2b removed the override, which is what turns "it appeared after I did X" into "X causes it." A branch-2 spike that skips any of the three can return a confident wrong answer, which is worse than not running it. ⚠️ **Branch 3's reopen condition is worth more than a deadline.** "Revisit at step 7" is arbitrary and expires without telling anyone why it mattered; "revisit when two specialist tasks can run concurrently over overlapping dependency sets" says what has to become true for the risk to exist. **Prefer a condition that fires when the risk becomes *possible* over one that waits for it to become *observed*** — the second means shipping the failure once to learn it was real. | **This is the project's uncertainty policy, and writing it down is what makes it one rather than a habit.** It exists to hold off two opposite failure modes that both present as diligence: **premature architecture** — solving problems that may never occur — and **wishful implementation** — building on plausible assumptions that would be expensive to unwind. The three rows already decided are one clean example of each: **#78 is branch 1** — it blocks step 5's status write-back, and there was enough information to decide it without further measurement. **Both spikes are branch 2** — neither trust behaviour nor the #31 partition blocked anything on the day it was questioned, and each sat under an entire half of the product, so both were bought cheaply and both came back *no*. **#79 is branch 3** — real, not blocking, and nothing yet shows that solving it now is cheaper than solving the observed form later. ⚠️ **"Blocks the next step" was the first phrasing and it is too locally optimizing.** Work can be technically unblocked while the next commit pours concrete over an unresolved assumption two steps ahead — which is precisely the #72 case, where a watcher answer constrained the first typed tool rather than the code being written that week. **Implementation commitment**, not step. ⚠️ **Branch 3 is the one that fails quietly**, because "record it and keep building" is indistinguishable from "we'll remember this" — and this document contains plenty of evidence that assumptions sit around until something forces them back into view. A numbered row with a reopen condition is what converts deferral from neglect into a decision. _(Recorded 2026-08-18 from the review document; sharpened the same day.)_ |

---

**These compose:** local-only (#2) is precisely what allows the app to write files back (#3). The write model survives because the carve-out in #7 is *output only* — stage 9 publishes a build, it doesn't move the app to a server. And #20 is what keeps #1's clone model honest over time: without the tool/content split, "clone the template" degrades into "your documents are trapped inside a repo you can't update."

**#2 and #22 are about the app, not the agent.** "Local only" plus "provision a cloud GPU instance for validation" reads like a contradiction and isn't one. #2 and #22 say *the planning app has no server and the plan has no public URL*. #23 says *the validation agent may reach out to a sandbox*. Different subjects. What constrains the sandbox is the governance policy, not the app's hosting model.

⚠️ **#8 is still the sharpest constraint in this list.** An AI agent cannot use a pan/zoom wireframe canvas — it needs the wireframe's *content*. See the dual-representation principle below; it's very hard to retrofit. #23 extends its reach: evidence and assertions need machine-readable form too, or the handoff ships conclusions without the reasoning behind them.

⚠️ **#16 has a hidden cost that isn't obvious from the row.** "Notify the PM of the specific change" is easy for a single edit and hard for its *consequences* — an amended stage-2 requirement should mark the stage-5 component and stage-7 criterion that depend on it. That's only computable if the traceability chain exists, which promotes traceability from a nice-to-have to infrastructure. Resolved 2026-08-13 by **#60–#64**; see "Cascade".

⚠️ **#61 puts more weight on the sixteen schemas.** Each one now also declares a propagation class per field. It's a small addition per schema and it rides on work that was happening anyway — but the critical path (#38) was already the top risk in this document, and this doesn't shorten it.

⚠️ **#23 and #24 are a pair, and the second one is the load-bearing half.** It is very easy to build the runbook artifact and then find yourself one small feature away from tracking whether its steps passed. That feature is out of scope. See "The runbook".

---

## The pipeline

The original sketch — still the spine of the whole thing:

```
USER INTENT
"I want to consistently scrape Austin Texas mugshot images to use as a dataset"
        │
        ▼
1. INTAKE
   Capture the request without prematurely designing a solution.
        │
        ▼
2. INTENT DECOMPOSITION
   Convert natural language → structured project requirements.
        │
        ▼
3. DISCOVERY / RESEARCH ─────────────┐
   Investigate unknowns, sources,    │
   constraints, policies, feasibility.│
        │                            │
        ▼                            │
4. REQUIREMENT GAPS                  │
   Determine what still requires     │   ┌──────────────────────────────┐
   user decisions.                   ├──▶│  TECHNICAL VALIDATION        │
        │                            │   │  (cross-cutting — #25)       │
        ▼                            │   │                              │
5. SOLUTION DESIGN                   │   │  hypothesis → sandbox →      │
   Define architecture, data model,  │   │  execute → observe →         │
   jobs, storage, monitoring, etc.   │   │  diagnose → retest →         │
        │                            │   │  evidence + assertion        │
        ▼                            │   └──────────────┬───────────────┘
6. RISK + FEASIBILITY REVIEW ────────┘                  │
   Technical / legal / privacy / operational / cost.    │
   ⛔ GATE: no load-bearing assertion below its         │
      required confidence rung.  ◀──────────────────────┘
        │
        ▼
7. ACCEPTANCE CRITERIA
   Define objectively what "working" means.
        │
        ▼
8. IMPLEMENTATION PLAN
   Break architecture into developer-sized work.
        │
        ▼
9. DEVELOPER HANDOFF
   Produce the implementation package — including the RUNBOOK.
        │
        ▼
   ═══ scope ends here (#24) ═══
   The executing team runs the runbook. We never see it happen.
```

### Why validation is cross-cutting rather than a 10th stage _(draft — argue with it)_

The obvious move was a validation stage between 6 and 7. Two things argued against it:

- **Timing.** A stage-3 finding would wait four stages to get tested, and stage 5 would design on unproven ground the whole time. Validation is *demand-driven* — you validate when a claim becomes load-bearing, which can happen anywhere from stage 3 on.
- **Numbering.** A 10th stage renumbers 7, 8, and 9, and this document references those numbers roughly forty times — including in my own verbatim answers below. That's a lot of breakage for a structural change I'm not certain about.

What replaces the stage is a **gate**: stage 6 is where feasibility gets judged, so stage 6 is where unproven load-bearing claims have to be settled. The validation agent has work to do throughout; stage 6 is where it has to be *done*.

⚠️ **The thing to watch:** without a stage of its own, validation has no exit criteria of its own, and work without exit criteria tends not to happen. The gate is doing all the enforcement here. If in practice validation keeps getting deferred to the gate and then done in a panic, that's the signal this decision was wrong and it should become a real stage.

### What each stage actually emits _(draft — argue with every row)_

The diagram says what each stage *does*. It doesn't say what each stage *produces*, what makes it *done*, or *who decides*. That's the gap this table tries to close — and it's the thing that turns the pipeline into an app.

| # | Stage | Produces | Exit criteria _(draft)_ | Decided by |
|---|---|---|---|---|
| 1 | Intake | Verbatim request, context, stakeholders, constraints stated up front | The ask is written down without a solution attached; objective understood; major constraints recorded; enough known to determine which stages this project needs | User |
| 2 | Intent Decomposition | Structured requirements list, glossary, explicit non-goals, **activated artifact types** (#39) | Every requirement is testable; scope boundary drawn; type activation approved | Agent → user confirms |
| 3 | Discovery / Research | Findings doc, **source inventory with citations**, feasibility notes, prior art, **hypotheses requiring validation** | All flagged unknowns are either answered, promoted to stage 4, or raised as a validation task; contradictory sources resolved or surfaced | Research agent |
| 4 | Requirement Gaps | Open-decisions register with options + tradeoffs per gap, **question backlog** | Every blocking gap has a user decision recorded | User |
| 5 | Solution Design | Architecture doc, **data model / schema designs**, **API specs**, **wireframes**, job + storage design | Data model approved; storage target chosen; all requirements traced to a component | Planning agent → user approves |
| 6 | Risk + Feasibility | Risk register (technical / legal / privacy / operational / cost), mitigations | Every high-severity risk has a mitigation or an accepted-risk signoff — **and** every load-bearing assertion has reached its required confidence rung (#25, #42) | Both |
| 7 | Acceptance Criteria | Testable criteria per requirement, definition of done | Criteria are objective — pass/fail without judgment calls | User |
| 8 | Implementation Plan | WBS, sequenced tasks, dependencies, estimates | Every task is developer-sized and traces to a requirement | Planning agent |
| 9 | Developer Handoff | The exported package, **sliced per role**, including the **runbook** and its **evidence** | Each assigned team member can start their part without coming back to ask me a question; every runbook step rests on an assertion at or above the threshold; no unresolved critical questions | — |
| — | Technical Validation _(cross-cutting)_ | Environment description, command history, logs, failures, remediations, **validated assertions with confidence** | The target assertion has been tested and the observed output captured — pass *or* fail. A documented failure is a completed validation. | Validation agent |

Notice stage 5 is where all three named interactive components land. **Stage 5 is the flagship document.** It's probably where to build first and prove the concept.

**Traceability chain:** requirement (2) → design component (5) → **assertion + evidence (validation)** → acceptance criterion (7) → task (8) → **runbook step (9)**. If every artifact carries an ID and a parent, the app can render the chain — and flag orphans (a requirement no component satisfies, a task nothing traces to, **a runbook step resting on nothing**). ~~Might also be over-engineering for v1.~~ **Upgraded 2026-08-13:** four separate decisions now depend on this chain existing — cascade notification (#16), role slicing (#19), the stage-9 completeness gate, and the stage-6 validation gate (#25). It's no longer optional; it's the substrate the others run on.

---

## The gate model — how stages actually behave

_From #14, #15, #16, #25. This is the part that turns "a list of stages" into a system with rules._

### Asymmetric write permissions

The agent and the human are **not** subject to the same movement rules, and that asymmetry is deliberate:

| Actor | Write scope | Why |
|---|---|---|
| **Agent** | Any stage, any time | Stage-3 findings legitimately rewrite stage-2 requirements. Forcing the agent to walk forward-only would mean carrying corrections in its head until it's "allowed" to apply them. |
| **Human PM** | Current stage only | The guardrail. Advance to the next stage when its exit criteria are met — not because something over there looks interesting. |

The PM's constraint is about **attention**, not permission. The value of a staged process is that it stops you designing a solution during intake; a UI that lets you wander undoes that.

Under #26 "the agent" means the orchestrator and everyone it delegates to. The specialists inherit the write scope; what constrains them isn't the stage, it's their contract — see the roster below.

### The change feed

#16 requires the PM be told *what specifically changed* upstream. That's not a toast notification — it implies a **persistent, acknowledgeable surface**: what changed, in which stage, by whom, when, and whether it's been seen. Add it to the components list; it's infrastructure, not decoration.

A **failed validation is a change-feed event**, and one of the more important ones. If the validation agent disproves an assertion the stage-5 design rests on, that's exactly the case the feed exists for.

**Status transition:** when an agent edit lands in a stage the PM already approved, the affected artifact flips `approved` → `amended` and needs re-acknowledgement. Without something like this, "approved" quietly decays into "approved at some point in the past," which is worse than no status at all because it reads as current.

**Status lives on artifacts, and stage status is derived.** "Stage 5 is amended" is not useful when two of forty design components need a look. The board shows the count — *stage 5: 2 artifacts need review* — which is a worklist rather than a colour.

---

## Cascade — how a change moves downstream

_From #60–#64. This was the sharpest unsolved thing in the document until 2026-08-13; it turned out to be mostly a framing error._

### Two things the earlier draft ran together

- **Direct amendment** — the agent edited artifact X; X sits in an approved stage; X needs re-acknowledgement. Just notification. Never controversial.
- **Cascade** — X changed, Y traces to X, does Y need review? This is the hard one, and it's what threatened to turn the board yellow.

### It was never a severity problem

The old framing said the fix was distinguishing a *material* change from a wording fix. But size and materiality are uncorrelated. `must` → `may` is one word and completely material; three paragraphs of clarification can change nothing at all. Any severity *score* would have been noise dressed as signal.

**The real culprit was transitivity.** Flag the full transitive closure of a change — component, criterion, task, runbook step — and one edit lights up four stages. But that's wrong on the merits, not just noisy: the acceptance criterion depends on **the design component**, not on the requirement behind it. Whether it needs review depends entirely on whether the component actually moved.

### The one-hop rule (#60)

Flag only direct dependents. Re-evaluate at each hop. A worked example — PM is in stage 8, stages 1–7 approved, and stage-3 research discovers the target database won't do what was assumed:

```
agent edits R2.4 (statement — semantic field)
        │
        ├─▶ C5.1  traces directly to R2.4   ⚠ flagged
        ├─▶ A7.3  traces directly to R2.4   ⚠ flagged
        │
        └─▶ T8.2  traces to A7.3, NOT to R2.4   … not flagged yet

PM reviews A7.3 → no change needed → dismissed → chain ends here, T8.2 never flagged
PM reviews C5.1 → change needed  → C5.1 edited → now whatever traces to C5.1 gets its one hop
```

Worklist of three, not four stages yellow. **Most chains die at hop one**, which is the whole reason this works.

The full blast radius stays **viewable on demand** — "9 artifacts trace downstream of R2.4" is a useful thing to be able to ask — it just doesn't become nine flags.

### Materiality is declared, not judged (#61)

Because every artifact is structured (principle 2), materiality can be classified **per field, once, at schema-design time** rather than judged per diff at runtime:

| Class | Fields | Cascades? |
|---|---|---|
| `structural` | id · type · trace links | **Always, and critical.** Deleting a requirement breaks everything tracing to it; changing an id breaks the chain silently, which is worse. |
| `semantic` | The payload — a requirement's statement, a schema's columns, an endpoint's contract | Yes |
| `advisory` | priority · ordering · estimate | Only to types that *consume* it. Priority hits stage-8 sequencing; it does not touch stage-5 design. |
| `cosmetic` | rationale · notes · prose · formatting | Never |

This is #58's trick again — mechanical where it can be, judgment only where it can't. It's also work that rides on the sixteen schemas already sitting on the critical path rather than adding a seventeenth thing.

⚠️ It isn't free of judgment. A `semantic` edit is *presumed* material and might be a typo fix. That residue is handled below rather than pretended away.

### Most of the graph doesn't exist yet

#15 focus-locks the PM to the current stage. If I'm working stage 5 and a stage-2 requirement changes, stages 7/8/9 have nothing to flip — those artifacts haven't been written. **Cascade only materializes for artifacts that already exist and were already approved.** In a forward-moving project that's a small set; it only gets interesting when the cycle genuinely reopens, which is exactly when you want it to.

### The agent proposes, the PM approves (#62)

A flag on its own leaves the PM an open question to answer. Instead the agent **drafts the downstream edit and attaches it**:

```
R2.4 statement changed  —  "attributes may nest arbitrarily"
  │
  ├─ C5.1  ⚠ review proposed edit
  │        - events.payload  TEXT
  │        + events.payload  JSONB
  │        why: R2.4 now requires nested attributes
  │
  └─ A7.3  ⚠ no change proposed — confirm?
```

The PM reviews a concrete diff instead of an open question, and the agent is the party actually holding the context for why the upstream change happened. Nothing lands unapproved, so #15's focus-lock survives — the PM is still the one deciding what changes in stages they aren't working in.

**This also absorbs the materiality residue.** The typed tool captures *why* the agent made the edit, and the feed shows it. A `semantic` field edit that was really a typo fix arrives as "typo fix — no meaning change, no downstream edit proposed," and the PM dismisses the whole hop in one gesture. So nobody has to "judge materiality" as a role: **the schema decides whether it cascades, the agent explains why it changed, the PM decides whether to act.**

⚠️ The risk is rubber-stamping. A plausible-looking diff attached to a flag is easier to approve than to think about, and this design deliberately trades some friction for throughput. See Risks.

### Evidence is not invalidated by cascade (#64)

The naive version of all this would mark the evidence under a changed requirement stale — and then, helpfully, re-run the validation. **No.**

A validated assertion doesn't stop being *true* because a requirement changed. `dnf install nvidia-driver-570 succeeded on RHEL 10` is a fact about the world; a document edit can't reach it. What a requirement change can do is make that assertion **irrelevant** — nobody needs that driver any more.

So cascade re-checks an assertion's *relevance* and never its *truth*, and it **never auto-triggers a validation run**. Auto-triggering would let a one-word requirement edit spend real money in tier 3 (#56), which is an unusually direct path from a typo to a cloud bill.

### Two streams, not one (#63)

```
CHANGE FEED (3)                         ← needs a decision
  ⚠ R2.4 amended — acknowledge
  ⚠ C5.1 needs review
  ⚠ A7.3 needs review

── activity log ─────────── (14)        ← record, never prompts
  · R1.2 rationale reworded
  · C5.4 note added
```

Cosmetic-class edits don't cascade, so they don't belong in a feed whose entire value is that everything in it matters. But they shouldn't vanish either — a `cosmetic` field misclassified in a schema would then hide a real change permanently, and the PM would lose any sense of how much the agent is touching. The log is always open and never asks for anything.

### What's still soft here

- The `advisory` class needs per-edge declarations — "priority cascades to `task` but not to `design-component`" is a statement about the *edge*, not the field, and that's a bit more schema machinery than the other three classes need.
- Unresolved cascade reviews should block at `npm run handoff` and warn everywhere else, consistent with #46 and #59. Stated here rather than as its own decision because it falls straight out of the lint philosophy.
- Nothing here has been tested against a real plan. The claim that "most chains die at hop one" is a prediction, and it's the load-bearing one — if chains routinely run three or four hops deep, this is more sequential work than it looks.

---

## Scope: planning through the runbook

**MVP = zero → a complete, evidence-backed project plan, including a runbook, that can be handed to the appropriate team members to execute on.** _(#6 settled 2026-08-12, amended by #23 and #24 on 2026-08-13)_

The 9-stage pipeline and the classical PM material aren't competing models — the pipeline is the *process*, the PM material is the *artifact vocabulary* it draws from. But the MVP scope draws a hard line through that vocabulary.

**In — artifacts that _describe the plan_:**
scope definition · requirements · architecture · data model / schemas · API specs · wireframes · WBS · task sequencing & dependencies · estimates · role assignment / RACI · risk register · acceptance criteria · budget (if the plan needs one)

**Also in, added by #23 — artifacts that _justify the plan_:**
research findings with citations · technical assertions with confidence rungs · validation evidence (commands, output, logs, failures, remediations) · sandbox environment descriptions · **the runbook**

**Out — artifacts that _track execution_:**
progress dashboards · % complete · burndown · status reports · earned value · actual-vs-planned · change management · issue/incident tracking

### Where the line actually falls now

The old line was *"anything that assumes work has started."* That was cutting in the wrong place — validation happens *before* work starts and was being excluded by it. The new line:

> **We produce the instructions. We never watch anyone run them.**

Concretely, on the far side of the line:

- executing a runbook against a real target
- ingesting execution output back into the plan
- live runbook step state (`running`, `passed`, `failed` as *current facts about a real run*)
- remediation loops driven by production failures
- lessons-learned promotion
- cross-project or organization-wide knowledge
- an autonomous implementation agent

**One deliberate exception survives unchanged:** the app *does* track progress — but through the **planning pipeline**, not through the project. The tracker answers "how far am I through planning?" It must never drift into answering "how far is the team through building?" That's a different product.

**A note on the two execution modes** from the transcripts. Mode A (agent executes in a disposable environment, to learn something) is squarely **in** — that's validation. Mode B (a human executes in production, from the runbook) is **half in**: producing the runbook is ours, and everything that happens after we hand it over is not.

**Sharpening that matters:** the handoff goes to "the appropriate team members" — plural, multi-role. Not just a developer. A developer, a designer, and a data person need different slices of the same plan. Stage 9 is therefore a **multi-role** output, which is a bigger design problem than a single handoff doc.

---

## Adaptive intake

_From vision doc §6. This is a real requirement on the intake and decomposition skills, not a philosophy note._

**Do not generate twenty questions at once.** That pattern fails in specific, repeatable ways:

- later questions rest on assumptions the earlier answers already invalidated;
- the user has to repeat corrections;
- questions go stale as project state changes;
- several questions turn out to ask the same thing;
- cognitive load goes up while answer quality goes down.

The loop instead:

```
Initial project description
        ↓
Agent interpretation
        ↓
Update structured project state
        ↓
Identify highest-value unknown
        ↓
Ask ONE question
        ↓
User response
        ↓
Update structured project state
        ↓
Repeat
```

**The worked example that makes it concrete.** The agent proposes a directory layout. I reject it and give my own naming convention. Later the agent asks about permissions on that structure. It must ask about *my* structure, and must never re-propose the rejected one. That requires state shaped like:

```
Original directory proposal:   Rejected
Replacement naming convention: Accepted
Permission model:              Unresolved
```

**Which is the whole argument for structured state over conversation memory.** Conversation is *evidence*; project state is the structured interpretation of it. Both get retained, and they are not the same thing. This is also why #29 says losing a session must never lose a decision — if a decision only existed in the transcript, it was never really recorded.

**The agent's job here is facilitation, not interrogation.** It should identify missing requirements, detect contradictions, surface assumptions, recommend established practice, explain tradeoffs, translate informal ideas into precise requirements, distinguish decisions from preferences, and identify decisions I don't yet realize need making. Closer to a strong technical facilitator than a questionnaire generator.

---

## Question backlog & information types

_From vision doc §23 and §24. Both slot into stage 4 (Requirement Gaps) and the decision register._

### Open questions are tracked objects, not planning failures

A question that can't be answered yet is a normal state, and the system should be able to hold it. Every question carries a **disposition**:

| Disposition | Meaning |
|---|---|
| `assigned:research` | The research agent can answer it from sources |
| `assigned:validation` | It needs to be proven in a sandbox |
| `escalated:pm` | Only I can decide it |
| `deferred` | Real, but not blocking this stage |
| `blocked` | Waiting on something outside the project |
| `closed` | Answered, with the evidence attached |

This is what gives the orchestrator a structured basis for "what happens next" — it can look at the backlog rather than infer next steps from conversation.

### Information types that must never blend

| Type | What it is |
|---|---|
| **Fact** | Known and verifiable |
| **Assumption** | Believed, not checked |
| **Decision** | A choice made, with alternatives and rationale |
| **Constraint** | A boundary the project can't cross |
| **Risk** | A thing that could go wrong |
| **Open question** | Unresolved, tracked above |
| **Hypothesis** | A claim proposed for testing |
| **Validated finding** | A claim that has been tested, with evidence |

The failure this prevents is the ordinary one: an assumption gets restated a few times, loses its hedge, and ends up in a runbook as an instruction. #42's confidence rungs are the machine-readable version of the same guard.

### The decision register

Every decision entry carries: the decision · alternatives considered · rationale · linked evidence · assumptions · date · status · downstream dependencies. That last field is what makes cascade computable, and the linked-evidence field is what makes #23 worth anything — a decision with no evidence link is visibly a judgment call rather than a finding.

---

## Pi integration — what's actually true

_Verified against the Pi docs 2026-08-12, not assumed. **Re-verified 2026-08-14** against the multi-agent design. Sources at the bottom of this section._

✅ **Re-verified 2026-08-14 — the roster survives, two mechanisms don't.** The 2026-08-12 pass was done against a **single-agent** design; #26 asked three questions of Pi that had never been tested. All three are now answered, plus the npm question:

| Question | Answer | Effect |
|---|---|---|
| Can one Pi agent delegate a bounded task to another? | **Yes — but not as a core primitive.** Extension/SDK layer, and there's an official example doing almost exactly this. | **#26 stands.** New **#65**. |
| Does each specialist get its own `AGENTS.md`? | **No.** `AGENTS.md` is *cwd/project* context, not agent identity, and it isn't a Pi Package resource type. | Replaced by specialist definition files — new **#66**. |
| Do forks implement orchestrator → specialist? | **No.** `fork()` *replaces* the runtime's active session, and a fork inherits context — the opposite of #27. | **#28 rewritten.** |
| Which npm package is canonical? | **`@earendil-works/pi-coding-agent`.** | Open question closed. |

**The load-bearing result: the roster does not have to collapse back to one agent**, and most of the delegation machinery already exists as a worked example rather than something to invent. That's the first thing since the consolidation that made this project *smaller*.

Pi is `earendil-works/pi` (Mario Zechner / badlogic — old `badlogic/pi-mono` URLs now redirect). npm: **`@earendil-works/pi-coding-agent`**; `@mariozechner/pi-coding-agent` is **deprecated on npm** and points at it. Every piece of the journey maps onto something Pi already does — this is a better fit than it had any right to be.

### The four capabilities that matter here

**1. The SDK embeds in a web app.** This is the big one — it means the app can host the conversation, not just display files.

```ts
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory(), modelRuntime });

session.subscribe(e => { /* text_delta, tool_execution_start/end, turn_start/end … */ });
await session.prompt("Draft the data model for stage 5");
await session.steer("Actually, make it Postgres");     // mid-stream correction
await session.followUp("Then update the API spec");    // queued
```

Docs explicitly list "build a custom UI (web, desktop, mobile)" as a supported use case. Also offers `runRpcMode()` for subprocess integration, and `createAgentSessionRuntime` for new/resume/fork session management. **Caveat:** event subscriptions bind to a specific `AgentSession` — re-subscribe after a session swap.

⚠️ **What `fork()` actually is — re-verified 2026-08-14, and it isn't what #28 originally assumed.** Sessions are persisted as JSONL trees, forks carry a `parentSession`, and `SessionManager` exposes `forkFrom()`. But `AgentSessionRuntime.fork()` **replaces the runtime's active session with the fork** — the docs warn that `runtime.session` changes and subscriptions must be rebound afterward. It is *session navigation*, not "spawn a worker while the orchestrator stays where it is." And a fork **inherits** its parent branch's conversation, which is the opposite of #27's scoped context.

So forking is a **lineage and review** primitive here, not the delegation primitive. If a stage genuinely needs its own persistent transcript later, the SDK has enough to do it — independent `SessionManager`s, each with its own `AgentSession` — just not via a single `runtime.fork()` call pretending to be concurrency. See #28.

**2. Pi Packages are exactly the "ships with the repo" mechanism.** Resources declared in `package.json` under a `pi` key, or auto-discovered from conventional dirs:

```
pi-package/
├── package.json          # { "keywords": ["pi-package"], "pi": { "skills": ["./skills"], … } }
├── extensions/           # .ts / .js — lifecycle hooks + custom tools
├── skills/<name>/SKILL.md
├── prompts/*.md
└── themes/*.json
```

Install from **npm**, **git**, or a **local path** — and **project-scoped**, into `.pi/npm/` or `.pi/git/` rather than globally. So `pi install ./pi-package` from inside the cloned repo gets the whole configuration in place with **no npm publish required** (#32). Exactly what step 4 of the journey needs.

**3. Provider config is a solved problem.** Custom providers live in `~/.pi/agent/models.json`; keys in `~/.pi/agent/auth.json`. Ollama / llama.cpp / LM Studio / vLLM all expose OpenAI-compatible endpoints. There's an official tracking issue for local-LLM provider extensions and a community wizard (`pi-localllm-provider`) that does TUI-driven setup for exactly this list — #35 defers to it rather than rebuilding it.

Known sharp edge: some OpenAI-compatible servers reject the `developer` role used by reasoning models — needs `compat.supportsDeveloperRole: false`. Expect a compat-settings section in the setup docs.

**4. `AGENTS.md` is natively loaded** (as is `CLAUDE.md`) for system-prompt customization. Skills are `SKILL.md` folders with frontmatter and discovery rules.

⚠️ **But it loads by working directory, not by agent — corrected 2026-08-14.** Pi walks the cwd hierarchy (global file, then parent dirs down to cwd) and loads what it finds. **Every session with the same cwd sees the same stack**, so there is no native "the research agent's `AGENTS.md`." `AGENTS.md` is also *not* a Pi Package resource type — packages carry extensions, skills, prompts and themes, and nothing else. Role instruction therefore ships as specialist definition files (#66), and `AGENTS.md` is reserved for invariants that are true for **every** agent on the project.

**5. Sub-agents are a supported build, not a built-in — and there's a reference implementation.** Pi has no sub-agent feature in core; the docs list "build custom tools that spawn sub-agents" as an SDK use case, and the repo ships an official `subagent` **example extension** that already does one bounded task, N parallel tasks, sequential chains, a separate process and context per specialist, and per-specialist model + tools + system prompt. Specialist definitions look like this:

```md
---
name: research
description: Research authoritative sources and return findings
tools: read, grep, find, ls
model: …
---

You are the research specialist.
…
```

The example discovers them from `~/.pi/agent/agents/*.md` or `.pi/agents/*.md` and passes the Markdown body to the child as appended system prompt. **We ship ours in the package instead (#66)**, which is a small change to the discovery path and nothing else.

⚠️ **Two sharp edges found 2026-08-15 in the example's own README, and both argue for #66 rather than against it.** The example **defaults to user-level agents only** (`~/.pi/agent/agents`); project-local `.pi/agents/*.md` load only with `agentScope: "project"` or `"both"`, and when running interactively it **prompts for confirmation** before using them (`confirmProjectAgents: false` disables). Neither behaviour survives a non-interactive child: the default wouldn't find a project roster at all, and a confirmation prompt has nobody to ask. Reading our roster out of the *package* directory — which is what #66 already says — sidesteps both, because it is neither user-level nor project-local as far as that logic is concerned. It does mean the discovery function is ours to own rather than inherited.

**The `tools:` line is stronger than expected**, and it changes the roster from prose into enforcement: it feeds Pi's `--tools` allowlist, which applies to built-in, extension **and** custom tools. So "research may read and search but may not write or provision" becomes a boundary the child physically cannot cross — not a *forbidden actions* bullet it's trusted to honour. That's a direct, mechanical mitigation for role leakage.

✅ **Run 2026-08-16 and it holds — by a stronger mechanism than the claim required.** `--tools` does
not deactivate the omitted tool, it **removes it from the child's registry**. See check 2 below.

### ✅ Trust spike results — run 2026-08-15, completed 2026-08-16

_pi 0.80.6 · Windows · `defaultProjectTrust: "never"`._
_Checks 1 and 3–6 on llama.cpp `qwen35-4b`; **check 2 on `openai-codex/gpt-5.4-mini`**, per #37._
_**Six of six answered.** Everything above this heading was read; this was run._

| # | Check | Result | What it settles |
|---|---|---|---|
| 1 | Typed tools present in a non-interactive child | ❌ **no** — silently | → **#67**. Trust is the variable; `--approve` proves it, a recorded decision grants it |
| 2 | `tools:` allowlist actually blocks a write | ✅ **yes** — at the **registry**, not the prompt | #26's role-leakage mitigation is mechanical, and → **#68** |
| 3 | `AGENTS.md` reaches the child | ✅ **yes**, and `--no-context-files` suppresses it | #66 holds, *and* its stated fallback is real |
| 4 | Turn-end hook fires in a child | ✅ **yes** (`mode: "json"`, `hasUI: false`) | #48's loop can reach specialists, not just the orchestrator |
| 5 | `pi install -l` references vs copies | ✅ **referenced** | #50's `git pull` path needs no reinstall step |
| 6 | Project skill beats a packaged skill | ✅ **yes**, via `.pi/skills/` | #33's precedence exists — but see the caveat below |

### Check 2 in detail — the allowlist is a registry boundary

_Run 2026-08-16. The blocker recorded against this check was stale: the machine already had a
working frontier provider (`openai-codex` OAuth, which refreshed itself silently on first use), so
#37 was satisfied without configuring anything._

⚠️ **The general lesson is worth more than the specific one, and it nearly cost this check a day:
re-test a recorded blocker before building around it.** The configured default (`llamacpp /
qwen35-4b`) genuinely was down, and the note written from that failed command said "the remaining
checks need a working provider, and right now there isn't one." That was recorded as a **prerequisite**
when it was only ever an **observation** — a claim with a shelf life, about a machine that changes
underneath it. The expired OAuth token refreshed itself on first use and the whole blocker evaporated.
Sibling lesson to the registry-dump technique further down: both are about not letting a stale or
downstream signal stand in for the thing itself.

**Answer: yes, and the mechanism is stronger than "the harness refuses the call."** There is no
refusal path, because there is nothing to refuse. `--tools` removes the omitted tool from the child's
tool registry outright. All three observables collapse to the same list:

| observable | what it is |
|---|---|
| `pi.getAllTools()` | everything configured in the process |
| `pi.getActiveTools()` | what the harness will dispatch |
| `systemPromptOptions.selectedTools` | what the model is told exists |

With `--tools read,grep,find,ls`, `write` was absent from **all three** — not merely hidden from the
prompt, and not present-but-inactive. The same held for our custom `spike_record_finding`, which
settles the one half of the claim that was untested: **`--tools` treats built-in, extension and custom
tools identically**, in both directions. Named in the allowlist, the custom tool was registered *and
dispatched* (`typed_tool_called` fired). Omitted, it did not exist.

| run | `--tools` | `write` in registry | custom tool in registry | file written |
|---|---|---|---|---|
| A0 | *(none — baseline)* | ✅ | ✅ | — |
| A1 | `read,grep,find,ls` | ❌ | ❌ | — |
| A2 | `read,grep,find,ls,write` | ✅ | ❌ | — |
| A3 | `read,spike_record_finding` | ❌ | ✅ | — |
| B1 | `research` allowlist, direct | ❌ | ❌ | **absent** |
| B2 | `scribe` allowlist, direct | ✅ | ❌ | **written** |
| C1 | `read,spike_record_finding` | ❌ | ✅ | *(tool called)* |
| D1 | `research`, **via `delegate`** | ❌ | ❌ | **absent** |
| D2 | `scribe`, **via `delegate`** | ✅ | ❌ | **written** |

⚠️ **The documented false-pass did occur, and the registry dump is the only reason it didn't matter.**
In B1 and D1 the model never emitted a write call at all — it reported the tool was unavailable and
stopped. Judged behaviourally, that is exactly the outcome this check was warned would teach nothing.
What rescues it is that the dump was taken *before* the model ran: the tool was not in the child's
registry, so "the model didn't try" is a **consequence** of the boundary rather than a confound with
it. **Technique worth keeping: take the mechanical observable upstream of the model, not downstream
of its behaviour.** It is the same move that answered check 5 without a model at all. ⚠️ **It has a
partner, learned on 2026-08-18 in the 2a run: negative evidence requires proof that the observation
point was reached.** This one guards the positives; that one guards the negatives. A spike needs both.

**Three consequences, in descending order of how much they change:**

- **#26's forbidden-actions contract is now enforcement, and the Risks row can drop its hedge.** A
  role that omits `write` cannot write, cannot `edit`, and — because `bash` is a separate tool
  subject to the same allowlist — cannot shell around it either. B1's child was left with
  `read, grep, find, ls` and had no route to the filesystem at all.
- **→ #68.** The default active set is *more* permissive than it looks: with no `--tools`, the child
  came up with `read, bash, edit, write` plus every custom tool, while `grep`, `find` and `ls` were
  configured but **inactive**. A forgotten `tools:` line is therefore not a narrower role, it is a
  role with a shell.
- **The delegation path itself is now exercised end to end** — orchestrator → `delegate` tool →
  non-interactive child → allowlist applied → result returned. That was an open gap under check 1,
  which had only ever been run top-level. It is closed in both directions (D1 negative, D2 positive).

⚠️ **And it was only open because our own extension was broken — which is the finding to carry into
the real one.** No delegated child had ever completed before this run: the spike's `delegate.ts`
spawned with `shell: true` and inherited an open stdin, so children loaded the extension and then hung
forever. Two bugs, both ours, neither about Pi: `shell: true` on Windows re-parses argv and splits a
multi-word task prompt, and `pi -p` reads a prompt from stdin when it doesn't get one, so an inherited
pipe nothing ever closes blocks the child before `session_start`. The fixes are `spawn(process.execPath,
[process.argv[1], ...args])` — the orchestrator is itself Pi, so `argv[1]` is already `cli.js` — and
`stdio: ["ignore", "pipe", "pipe"]`. **Both were applied together and neither was isolated**, so which
one was load-bearing is unknown; the real extension should do both regardless. It also means a
delegated child that hangs looks identical to one that is thinking, which argues for a spawn timeout
in the real extension alongside #67(b)'s toolless-child detection.

✅ **"Which one was load-bearing" is answered — 2026-08-18, as a side finding of step 2b.** Every `pi
--mode json -p` invocation in that spike hung indefinitely, producing nothing, in every directory
including an empty one, **until stdin was closed** (`< /dev/null`). No delegation code was involved at
all. So the **stdin half is load-bearing on its own**: `stdio: ["ignore", "pipe", "pipe"]` is required
regardless of how the child is spawned, and `shell: true` removal — while still correct for the argv
splitting — was not what unblocked it. ⚠️ **And this raises the value of the spawn timeout argued for
below**, because the failure mode is a *silent indefinite hang* rather than an error: a child that
never speaks looks exactly like a child that is thinking, which is the same shape as #67(b)'s
failure and needs the same kind of loud answer.

⚠️ **Which is exactly why the adapted `subagent` extension does not survive the spike** _(recorded here
2026-08-18; it had been sitting in the build order rather than in this file)_. It is the one piece of
throwaway code that looks production-shaped once it works, and it now carries two bug fixes that make
it look more finished than it is. Keeping it means the real `pi-package/` inherits code written to
throwaway standards **before the three contracts (#26) exist to shape it** — and inherits it at the
one place where a subtle defect looks like a thinking child rather than a broken one. **Rewrite it
from the shipped example with the answers in hand**, carrying across the two fixes above, the spawn
timeout, and #67(b) — not the file.

**Check 5 was answered without the model at all**, which is worth noting as technique: editing the
extension and re-running produced the edited marker in the log at load time, and `.pi/` contained
nothing but `settings.json` — no copy of the package anywhere. Two independent confirmations, neither
of which depends on anything the model chose to do.

⚠️ **Check 6 has a caveat that changes #33's shape.** The override won from `.pi/skills/`, which is
one of Pi's own discovery locations. **`planning-content/skills-overrides/` is not** — it would have
to be registered through the settings `skills` array, and in the documented discovery order settings
come *after* packages. Since collisions "warn and keep the first skill found," an override registered
that way would plausibly **lose** to the packaged skill — the exact opposite of what #33 promises. So
the mechanism exists and our chosen path may not reach it. Either setup materializes overrides into
`.pi/skills/`, or the ordering has to be tested directly. ~~**Untested either way; do not assume #33
works as written.**~~

✅ **Tested 2026-08-18 as step 2b, and the caveat above is wrong.** The settings-registered override at
`planning-content/skills-overrides/` **wins**, and the packaged skill is shadowed rather than broken —
four runs, provenance read from `systemPromptOptions.skills` upstream of the model. **#33 stands as
written.** See the 2b RUN block for the table. ⚠️ **Keep the reasoning above in place anyway, because
the way it failed is the lesson:** it was a careful reading of the shipped docs, and it was still
wrong. `skills.md` lists locations in an order that is *not* the precedence order, and "collisions keep
the first skill found" does not resolve to the listing sequence. **A prediction from documentation is a
prediction, and this file has now been wrong in both directions** — check 1 confirmed a documented
behaviour nobody had run, and this one refuted one.

**The test, and what each result means** _(from the review document, 2026-08-18 — it is now #76 step
2b)_. Ship a packaged skill whose body says `PACKAGED` and an override of the same name whose body says
`OVERRIDE`, register the override **through the exact mechanism this product plans to ship**, and
establish **which source Pi actually loaded**.

⚠️ **Hold this to the same causal standard as 2a, which means two things.** First, make the collision
**intentional and unmistakable** — same skill name, bodies with nothing in common — so there is no
reading in which both sources could have produced the observed result. Second, and this is the half
that gets skipped: **the observable is which file Pi loaded, not how the model behaved.** A model that
happens to act like the override is not evidence the override loaded — that is the same false pass
check 2 was warned about, and it survived only because the registry dump was taken *before* the model
ran. Read the provenance from the skill registry at load time, exactly as check 2 read
`getAllTools()`. **The technique is already proven in this file: the observable goes upstream of the
model, never downstream of its behaviour.** ⚠️ **The framing matters more than the fixture:** the question is
not whether Pi supports overrides — that is already answered, from `.pi/skills/`, and re-answering it
would be a false pass. The question is whether **`planning-content/skills-overrides/` plus the settings
`skills` array** produces the precedence #33 promises. Three outcomes, all of them useful: **(A)** it
wins — keep #33 as written; **(B)** the packaged skill wins, as the documented discovery order suggests
it will — then setup materializes overrides into `.pi/skills/`, and #33's *location* changes while its
promise survives; **(C)** some third loading path gives the right precedence — record that as the
shipped mechanism. **Close this before the customization story is documented anywhere a user can read
it**, because #33's whole purpose is that tuning a skill must not mean editing the tool (#20).

### Design consequences

- **One skill per pipeline stage** is the obvious shape — `skills/01-intake/SKILL.md` … `skills/09-handoff/SKILL.md`. Each carries that stage's method, its exit criteria, and the artifact format it must emit. Under #34 these derive from the single `stages/` definition set rather than being hand-maintained beside it.
- **Extensions are how principle 2 gets enforced.** Don't let the agent freehand MDX into existence. Register **typed custom tools** (`defineTool()`) — `set_phase_status`, `record_decision`, `write_schema`, `add_requirement`, `link_trace`, and now `record_finding`, `record_assertion`, `attach_evidence`, `open_question`, `write_runbook_step` — so the agent writes *structured data* by construction rather than by discipline. A weak local model that can't be trusted to hand-write valid frontmatter can still call a typed tool correctly.
- **Provider-agnostic (#10) is a real constraint on skill authoring.** Skills must degrade gracefully to a 7B local model. Short, imperative, example-heavy — not clever. This gets harder under #26: four agent contracts are four more things a weak model has to hold.
- ⚠️ **Security:** Pi packages run with full system access; extensions execute arbitrary code. Fine for a package I write and ship myself, but worth stating in the repo's README since users are cloning and running it. #23 raises the stakes — the validation agent provisions infrastructure and holds credentials. See Risks.

**Sources:** [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) · [Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) · [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) · [Models](https://pi.dev/docs/latest/models) · [local-LLM providers issue](https://github.com/earendil-works/pi/issues/4155) · [pi-localllm-provider](https://github.com/freeyoung/pi-localllm-provider) · [author's write-up](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)

**Added 2026-08-14:** [subagent example — index.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts) · [subagent example — README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md) · [session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md) · [SDK](https://pi.dev/docs/latest/sdk) · [usage / context files](https://pi.dev/docs/latest/usage) · [packages](https://pi.dev/docs/latest/packages) · [quickstart](https://pi.dev/docs/latest/quickstart)

---

## The agent roster

_From #26, #27. Contracts follow the seven-field shape: inputs · responsibilities · allowed tools · forbidden actions · output format · exit criteria · escalation._

The PM talks to **one** agent. That hasn't changed and shouldn't — #12's terminal beside the browser is still the whole interface. What changed is what sits behind it.

```
                        ME (in a terminal)
                              │
                              ▼
                     ┌─────────────────┐
                     │  ORCHESTRATOR   │  routes · tracks phase · enforces gates
                     │  (boring)       │  asks me for decisions
                     └────────┬────────┘
                              │  bounded tasks, scoped context
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
      ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
      │  RESEARCH    │ │  VALIDATION  │ │  PLANNING    │
      │  findings    │ │  evidence    │ │  artifacts   │
      │  hypotheses  │ │  assertions  │ │  runbook     │
      └──────────────┘ └──────────────┘ └──────────────┘
              │               │               │
              └───────────────┴───────────────┘
                              ▼
                    planning-content/ + data files
```

### Orchestrator

**The only user-facing surface.** Receives my input, determines the current stage, maintains workflow state, creates tasks for specialists, gives each one scoped context, collects outputs, tracks task status, detects unmet dependencies, decides who acts next, requests my decisions and reviews, enforces exit criteria.

**Non-responsibilities, and these are the important half:** it does **not** perform deep research itself. It does **not** become the primary technical architect. It does **not** run sandbox experiments. It does **not** generate all the documentation. It is **not** the canonical knowledge store — the files are.

> **The orchestrator should remain intentionally boring.**

That line is doing real work. The failure mode it names is orchestrator bloat: the router quietly starts doing the interesting parts itself because it's right there and it has the context, and within a month you're back to one agent holding everything.

### Research agent

**Inputs:** target question · relevant requirements · environment constraints.

Internet research, authoritative sources first, vendor documentation, comparison of alternatives, compatibility constraints, documented assumptions, citations, research briefs.

**Hard constraint — this is the point of the role:** it emits **findings and hypotheses only**. It may never promote a research finding directly into a trusted instruction. A source-supported claim is rung 2 (#42) and stays there until something tests it.

### Validation agent

**Inputs:** hypothesis · candidate procedure · required environment · success criteria · **the activated sandbox tiers (#56)**.

Provisions or connects to a sandbox, executes the proposed commands, observes output, captures logs, diagnoses failures, iterates on remediation, compares observed against expected, records environment details **and the tier it ran in**, produces a pass/fail conclusion with evidence, and **tears down what it provisioned**.

**Forbidden — and this one is a hard boundary, not a guideline:** it may not use a tier the PM hasn't activated. If a claim genuinely requires tier 3 and only tiers 1–2 are available, the correct output is **escalate to the PM** with the reason — not "validate it approximately in Docker and call it done." Quietly downgrading the tier and reporting success is the single worst thing this agent can do, because it produces a confident wrong answer wearing the evidence layer's authority.

**A failure is a successful validation.** Disproving a procedure in a sandbox is the product working — it's the failure moving from stage 11 to stage 6, which is the entire thesis.

### Planning agent

**Inputs:** validated evidence · decisions · requirements · artifact dependencies.

Synthesises requirements, maintains architecture and planning documents, translates validated conclusions into runbook steps, identifies dependencies, maintains traceability between decisions and evidence, ensures downstream artifacts reflect upstream changes.

**Must preferentially generate from validated evidence.** Where it has to work from an unvalidated assumption, the resulting artifact carries that confidence rung rather than hiding it.

### Scoped context — what each one actually receives

```
Research agent receives:    target question · relevant requirements · environment constraints
Validation agent receives:  hypothesis · candidate procedure · required environment · success criteria
Planning agent receives:    validated evidence · decisions · requirements · artifact dependencies
```

**No specialist receives the whole project history by default.** That's #27, and it's the mitigation for two things on the risk list at once — context-window overuse and role leakage. An agent given everything drifts toward doing everything.

### How this maps onto Pi

_Rewritten 2026-08-14. Two of the four original rows were wrong about Pi; see "Pi integration"._

- **Delegation is a typed `subagent` tool we register from a shipped extension (#65)** — not a Pi core feature, and not session forking. Each call launches an isolated child process with its own context, model, and tool set.
- **Each specialist is a definition file in the package (#66)** — `agents/research.md`, `agents/validation.md`, `agents/planning.md`. Frontmatter carries `tools` and `model`; the body *is* the role's system prompt, which is where the seven-field contract lives.
- ~~Per-agent `AGENTS.md`~~ — **Pi doesn't work that way.** `AGENTS.md` is cwd-scoped, shared by every session in the project, so it holds invariants only (#66).
- Per-stage `SKILL.md`, derived from the single `stages/` definition set (#34).
- **The contract is enforced at two layers, not one.** *Output format* → typed tools via `defineTool()`; an agent's output format isn't prose in an instruction file, it's the schema of the tool it may call. *Allowed tools / forbidden actions* → the definition's `tools:` allowlist, which Pi applies to built-in, extension and custom tools alike. The research agent doesn't merely promise not to provision infrastructure; it has no tool that can.
- ~~Forked sessions enforce scoped context~~ — **no.** Scoped context is enforced by what the orchestrator puts in the child's task payload (#27), because the child starts fresh. A *fork* would inherit the parent's conversation, which is the failure mode #27 exists to prevent. Forking stays available as lineage/review (#28).

⚠️ **This is still a second architecture to build and test** alongside the web app — but as of 2026-08-14 it's meaningfully less new than it looked. The delegation layer has a reference implementation to adapt rather than a design to originate; what remains genuinely ours is the three contracts, the routing, and the scoped-context payloads. #11's ~50/50 estimate still predates it, but the correction is smaller than the ⚠️ under the journey feared.

---

## Research, validation & evidence

_From #23, #25, #42. The largest genuinely new capability, and the reason the transcripts exist._

The diagnosis, in one line from the transcripts: **the runbook had become the place where technical discovery happens.** Someone writes a plan, hands it over, and the person executing it discovers the package doesn't exist on this distro. That's discovery — it just happened at the most expensive possible moment.

> **Discovery should happen in disposable environments. Execution should happen from validated instructions.**

### The confidence ladder (#42)

| Rung | Status | What it means |
|---|---|---|
| 1 | `unverified` | Someone asserted it. Possibly the model. |
| 2 | `source-supported` | Authoritative documentation says so. Nobody has run it. |
| 3 | `experimentally-validated` | It was executed somewhere and worked. |
| 4 | `environment-matched` | It was executed in an environment materially like the target, and worked. |
| 5 | `production-validated` | It worked in production. **Out of scope (#24)** — we never see production. |

Two inequalities worth keeping in the front of your mind, because collapsing either is how bad plans get made:

```
research finding  ≠  experimentally validated finding
validated in sandbox  ≠  guaranteed in production
```

### The assertion

The one real schema literal any of the source documents produced, and it drops straight into the catalogue as the `assertion` artifact type:

```yaml
assertion: "NVIDIA driver installation method"
status: experimentally_validated

source_support:
  - vendor_documentation

validation:
  sandbox_tier: 3          # 1 venv · 2 docker · 3 cloud — see #56
  operating_system: RHEL 10
  gpu_family: NVIDIA
  environment_match: partial
  result: success

production_validation:
  status: pending          # and stays pending — see #24
```

**Runbook steps are generated preferentially from high-confidence assertions.** That's what stops speculative information silently becoming implementation instructions. Which rung is the minimum is still open — see Open questions.

### Evidence

**What gets captured:** source references and documentation links · tested commands · environment details · package versions · terminal output · configuration files · logs · benchmark results · known failures · successful remediations.

**What it attaches to:** requirements · decisions · assertions · runbook steps. Evidence floating free of the thing it supports is just log files.

Under principle 2 this is not a special case — evidence is structured data with a rendering, same as everything else. The `docs/plan/data/evidence/` directory in the handoff is the canonical form; the human-readable version is derived.

### Sandboxes — three tiers (#56)

The PM declares which tiers a project may use. The validation agent enforces that ceiling.

| Tier | What it is | Provisions | Costs money | Needs credentials | What it can actually answer |
|---|---|---|---|---|---|
| **1** | **Python virtual environment** | a `venv` on this machine | No | No | Does this package exist at this version? Do these dependencies resolve together? Does this import work? Does this script behave? Version-conflict questions. |
| **2** | **Docker / Docker Compose** | containers on this machine | No | No | Does this OS package install on this distro? Does the service start? Do these services wire together? Anything needing a clean root filesystem or a specific base image. |
| **3** | **AWS CLI + Terraform** | real cloud infrastructure | **Yes** | **Yes** | Hardware-dependent claims — GPUs, drivers, kernel modules, instance-specific behaviour. Anything that cannot be faked locally. |

**Why three rather than one.** Most claims worth checking are dependency questions, and a venv answers those in seconds for nothing. Escalating every validation to a container — let alone an EC2 instance — would make validation expensive enough that it quietly stops happening, which is the failure this whole capability exists to prevent. The tier should match the claim.

**The rule still holds: do not hard-code sandboxing to one provider.** The capability isn't AWS. The capability is **agent-controlled disposable execution**. Tier 3 happens to be Terraform + AWS in v1 because that's what's available; the interface has to be tier-shaped, not vendor-shaped, so a fourth tier or a different cloud slots in without touching the validation agent.

**Controller verbs, identical across all three tiers:** `provision` · `execute` · `observe` · `reset` · `destroy`. A venv's `destroy` is `rm -rf`; tier 3's is `terraform destroy`. Same contract, wildly different consequences for getting it wrong.

### Which tier can reach which rung _(draft — argue with it)_

The tier caps the confidence rung, and it caps it **relative to what's being claimed** — not absolutely:

| Claim is about… | Tier 1 (venv) | Tier 2 (Docker) | Tier 3 (cloud) |
|---|---|---|---|
| Python packages / dependency resolution | **rung 4** if the target runs the same interpreter and OS, else rung 3 | rung 4 | rung 4 |
| OS packages, services, filesystem | rung 2 at best — it can't see the OS | **rung 4** if the base image matches the target distro and version, else rung 3 | rung 4 |
| Hardware, GPUs, drivers, kernel modules | rung 2 | rung 2 — a container shares the host kernel and has no GPU of its own unless one is passed through | **rung 4**, and only here |

⚠️ **The specific failure this table exists to prevent:** validating an NVIDIA driver procedure inside a container, seeing it exit zero, and recording rung 4. The tier that ran it has to be recorded on the assertion alongside the environment match, or the ladder is decoration.

⚠️ **Amended 2026-08-18 — #77 makes this table machine-dependent, and that consequence is worth stating
out loud because it lives between two rows that don't reference each other.** The table caps the rung by
**tier**, and #77 makes tier 2's availability a **detection result** — Docker is available where Docker
already works, and merely *recommended* where it doesn't. Put those together and the conclusion is
uncomfortable in a useful way: **the confidence ceiling of a plan depends on the PM's laptop.** An
OS-packages claim reaches rung 4 under tier 2 and rung 2 at best under tier 1, so the same project,
planned by the same agent, from the same requirements, tops out lower on a machine without Docker —
and via #57, fewer of its claims may become instructions someone runs.

⚠️ **Measured here 2026-08-18: `docker` is not on PATH on this machine, so every OS-level claim in this
project currently caps at rung 2** until the tier-2 recommendation is approved.

Three things follow, and none of them are arguments against #77:

- **This is not a defect introduced by #77 — it is a fact #77 made visible.** The ceiling was always a
  function of what could actually be executed. The static-default version simply hid it behind a
  template value that was a guess about the same machine.
- **It belongs in the tier-2 recommendation prompt.** "Docker isn't installed; approve tier 2?" is a
  weaker question than the true one, which is *"without Docker, claims about OS packages, services and
  the filesystem cannot exceed rung 2, and #57's threshold will block some of them from becoming
  runbook steps."* That is #77's education-on-demand clause doing exactly what it was written for —
  and it is the moment the education is actually load-bearing rather than a briefing.
- **It sharpens the silent-tier-downgrade risk rather than creating it.** The risk row describes an
  agent approximating a tier-3 claim in a container and reporting success. The same shape now exists
  one tier down, and the defence is the same: the rung is capped by what ran, so an unavailable tier
  produces a **capped rung and an `n/a` with a reason** (#45), not a confident answer. What must never
  happen is a missing tier being treated as a reason to lower the *threshold* instead of the *rung*.

### The threshold — when may a claim become an instruction (#57)

_"Confidence threshold" was jargon for something concrete, so here it is in plain terms._

The planning agent writes runbook steps. Every step rests on an assertion. Every assertion carries a rung. The threshold is the answer to:

> **How good does the evidence have to be before a claim is allowed to become an instruction someone will actually run?**

Set it too low and the runbook is the old problem with extra ceremony — model guesses formatted as commands, now wearing an evidence layer that makes them *look* checked, which is worse than no evidence layer at all. Set it uniformly high and nothing ever ships, because "every step validated in a matched environment" is a bar most projects can't clear for most steps.

Both failure modes are real. The way out is that **runbook steps are not equally risky**, so no single number is right for all of them.

**The threshold is a function of what the step does.** Every `runbook-step` carries a `class`, assigned by the planning agent:

| Class | What it does | Examples | Minimum rung |
|---|---|---|---|
| `informational` | Reads, checks, prints. Changes nothing, so it can't break anything. | `nvidia-smi` · `cat /etc/os-release` · `df -h` · "confirm the service is listening" | **2** — a source saying "this is how you check" is enough |
| `mutating` | Installs, configures, writes, restarts. The bulk of any runbook. | `dnf install nvidia-driver` · editing a config · `systemctl enable` | **3** — somebody actually ran it and it worked |
| `destructive` | Deletes data, repartitions, drops a database, cuts over DNS. No undo. | `rm -rf /var/lib/pgsql/data` · `terraform destroy` · a schema migration | **4** — matched environment, or it doesn't ship |

**One override, and it's the one that matters most here:** any step whose behaviour depends on **hardware, kernel, or drivers** requires **rung 4 regardless of class** — and by #56's tier→rung table, rung 4 for those claims is only reachable in tier 3. That is precisely the RHEL 10 / NVIDIA / CUDA case. A container exiting zero tells you nothing about a driver, and this rule is what stops that non-result from being promoted into an instruction.

**What happens when a step falls below its threshold** — this is the half I left out, and it's the operative half. The planning agent has exactly three moves, in order of preference:

1. **Raise a validation task.** The default, and the entire reason the validation agent exists. The claim gets tested and the step gets written afterward.
2. **Escalate to the PM.** When the required tier isn't activated (#56), or the claim isn't testable at all — a vendor licensing question, say, or something only true of a production network. The PM decides whether to activate a tier, accept it unvalidated, or cut the step.
3. **Ship it marked.** The step goes into the runbook with an explicit `unvalidated` flag and a **required reason string** — same shape as `n/a` (#45). **The PM acknowledges each one at the stage-9 gate (#59)**; the package doesn't freeze until they have.

⚠️ Move 3 has to exist. Without an escape valve, a single unvalidatable step makes the whole plan unshippable, and a gate that can't be satisfied gets switched off — the same failure as a lint that blocks mid-draft (#46). But an escape valve that isn't *visible* is just a hole, which is why #59 puts a human signature on each use rather than a counter nobody reads.

### Who grades the homework (#58, #59)

#57 has a hole in it if you stop there: **the bar is set by the class, and the planning agent assigns the class.** An agent that can call a destructive step `mutating` has quietly lowered its own bar — structurally the same failure as a silent tier downgrade (#56), and just as invisible after the fact. Two guards, chosen to put friction only where it earns its keep:

**Class assignment: agent classifies, lint enforces a floor (#58).** The agent assigns, but the lint pattern-matches known-destructive commands and overrides:

```
agent says:  class: mutating
              cmd: rm -rf /var/lib/pgsql/data
                     ↓
lint:        ⛔ pattern match → forced to `destructive`
                     ↓
bar rises:   rung 3 → rung 4
```

Candidate patterns: `rm -rf` · `dd` · `mkfs` · `fdisk`/`parted` · `DROP TABLE`/`DROP DATABASE` · destructive migrations · `terraform destroy` · `kubectl delete` · force-pushes · anything touching a partition table. The list will be incomplete forever — that's fine, because it's a floor, not a classifier. The agent still classifies everything else, and every class is visible in the runbook view so a wrong one is auditable.

The reason this beats PM-approves-every-class (#18's pattern): the dangerous rows are exactly the mechanically-detectable ones. Making a human confirm the class of forty `dnf install` lines to catch the one `rm -rf` is a review nobody does properly by row fifteen.

**Unvalidated steps: PM acknowledges each at the gate (#59).** Not a count, a signature:

```
npm run handoff

⚠ 7 steps ship unvalidated:
  □ 12  dnf install nvidia-driver-570
        reason: tier 3 not activated
  □ 18  modprobe nvidia
        reason: needs real GPU
  …

acknowledge each to continue
```

This is a review at the freeze boundary, not an interruption during planning — which is precisely why it escapes the objection I raised against per-task tier approval (#56's open question): that one would fire constantly during work and decay into reflex clicking; this one fires once, at the end, when the whole picture is visible. And a runbook with forty unvalidated steps *should* cost the PM forty acknowledgements.

**Global or per-project?** The class→rung mapping above is the default and it lives in `project.yaml`. **A project may raise it; it may not lower it.** Raising is a legitimate risk call — a regulated deployment might want `mutating` at rung 4. Lowering would make rung 3 mean something different in different projects, which destroys the only property the ladder has.

**The graceful-degradation property, which falls out of that and is worth naming.** A project that activates no sandbox tiers can't get any assertion above rung 2. Every `mutating` step therefore falls below threshold, and — after the PM declines to activate a tier — ships marked `unvalidated` with a reason. **That's the correct behaviour, not a failure.** The output is an honest plan that says out loud which parts are guesses. Which is still strictly better than today, where the same plan exists and nothing distinguishes the guesses from the checked parts.

_Two clarifications, since both tripped me up while writing this:_ the threshold applies to **the assertion behind the step**, not to the step's wording — one assertion can back several steps. And a step resting on **no** assertion at all isn't a threshold problem, it's a traceability orphan, which the lint already catches.

**The kind of question this answers empirically** — and note how mundane they are, which is the point: Does this package exist? Does this repository resolve? Does this command succeed? Is this driver compatible? Does the service start? Does the config survive a reboot? Does the expected output actually occur?

### Environment fidelity

Rung 4 exists because perfect fidelity is often impractical and shouldn't become a blocker. What matters is that the **degree of match is represented** rather than assumed. The variables that determine it:

operating system · OS version · CPU architecture · hardware class · GPU vendor/family · kernel version · driver version · package manager behaviour · relevant software versions · network constraints · security controls

A validation that matched on OS and package manager but not on GPU family is rung 3 with a documented gap, not rung 4. Saying so is more useful than pretending either way.

### Governance — a first-class subsystem, not a shell-access feature

**Governance weight scales with the tier**, which is most of the argument for having tiers at all:

| Tier | What governance actually needs to say |
|---|---|
| **1 — venv** | Almost nothing. Where it may write, and a disk ceiling. No credentials, no cost, no teardown risk beyond a stale directory. |
| **2 — Docker** | Image sources, resource limits, no host-network or privileged mode by default, mount scope, container teardown. Still no money and no credentials. |
| **3 — cloud** | The full policy below. This is the only tier that can cost money or leak a credential. |

**Tier 3 policy surface:** approved providers and accounts · approved regions · approved instance families · maximum instance count · maximum runtime · cost ceiling · network exposure · production-network isolation · credential scope · **automatic teardown** · resource tagging · audit logging

A concrete example of the shape, from the transcripts:

```
Provider:                  AWS
Region:                    us-east-1
Allowed instance types:    g4dn.xlarge, g5.xlarge
Maximum instances:         1
Maximum lifetime:          4 hours
Auto-destroy:              Required
Internet access:           Allowed
Production network access: Denied
```

**A project that never activates tier 3 never loads any of that** — no provider configured, no credentials present, nothing to leak. That's the practical payoff of #56 making the tier a declared ceiling rather than a runtime choice: the cheap projects are secure by absence rather than by policy.

⚠️ Every one of cost runaway, resource leakage, credential exposure, and destructive experimentation is a *governance* failure rather than an agent failure — and all four live entirely in tier 3. See Risks.

### Beyond infrastructure

The transcripts noted that sandboxing generalizes past infrastructure — code generation, unit and integration tests, build validation, dependency testing, deployment simulation. Worth designing the interface so it doesn't preclude that, but v1 doesn't need it. The driving example is a driver install, and that's enough to prove the shape.

---

## The runbook

_From #23, #24. The new end of the pipeline, and the easiest place for scope to creep back in._

The runbook is produced in **stage 9**, by the planning agent, from validated assertions. It's the executable face of the stage-8 implementation plan.

**Philosophy, and it's the inverse of what usually happens:**

> The runbook is **executable evidence of completed planning** — a validation checklist, not an experimental notebook.

Preconditions before one gets emitted: commands tested where practical · dependencies identified · ordering validated · expected outputs known · known failures documented · remediation pre-written for foreseeable problems.

**Contents:** ordered commands · prerequisites · environment requirements · expected output per step · validation criteria · known exceptions · remediation guidance · **evidence references**.

**Every step also carries a `class`** — `informational` · `mutating` · `destructive` — which is what sets the evidence bar it has to clear before it's allowed to exist (#57). A step that couldn't clear its bar ships flagged `unvalidated` with a stated reason, so the executing team can see which instructions were proven and which are the planner's best understanding. That distinction is most of what makes the runbook worth more than a list of commands.

### Step states — a schema, not a live status

Each `runbook-step` carries a state field with seven possible values:

`pending` · `running` · `passed` · `failed` · `remediated` · `skipped` · `blocked`

⚠️ **Read that carefully, because this is exactly where #24 gets violated.** Those states are **the vocabulary the artifact ships with** so the executing team has somewhere to record what happened *in their own system*. They are **not** live state this app tracks. We ship a runbook where every step is `pending`. What happens to those values afterward is none of our business.

The failure mode is seductive and specific: you build the runbook artifact, notice the state field is right there, and think "it'd be trivial to let someone paste their output in and mark it passed." That single feature drags in output ingestion, result evaluation, remediation loops, and lessons learned — the entire deferred half of the vision doc. It's one small step across the line and there's no natural place to stop afterward.

A failed step's shape — `expected` / `observed` / `likely cause` / `recommended fix` — is likewise part of the artifact's schema, authored during planning from what validation actually observed. It's pre-written guidance, not a live incident record.

---

## Source material — what to steal from each

`references/media/` — four infographics. Treated as vocabulary and visual reference, not doctrine.

**The Three Layers of Planning** (strategic / tactical / operational)
- **Visual language worth stealing:** the card-with-colored-spine layout. Numbered badge, title, subtitle, time-horizon pill on the right, then a 4-column grid inside. This maps almost directly onto a phase card: `05 | SOLUTION DESIGN | produces… | exit criteria… | owner… | common mistakes…`
- The bottom "FROM STRATEGY TO EXECUTION" band with its `↓ ask:` prompts is a nice pattern — each stage could carry a guiding question. **Promoted to #44.**
- **Methodology worth considering:** strategic/tactical/operational as a *second axis* cutting across the 9 stages. Probably too much for v1.

**How to write a project plan** (10-step numbered grid)
- **Layout:** the numbered-cell grid — each cell pairs a checklist with a small chart. Good model for a phase overview page: checklist on the left, live visual on the right.
- **Content:** the 10 conventional plan sections (overview, SMART goals, scope, WBS, timeline, resources, budget, risk, communication, monitoring). Useful checklist to test the 9 stages against — *does my pipeline drop anything important?* Budget and communication plan were caught this way and are now #17.
- In-scope / out-of-scope Venn is a genuinely good little component for stage 2.

**Project Management Documentation** (branching template tree)
- Effectively a **menu of ~40 document templates** across 10 categories. This is the best source for "what artifact should stage N produce."
- Directly relevant pulls: business case + charter (stage 1), RAID log + risk ID + cause/effect (stage 6), WBS construction (stage 8), gap analysis (stage 4), stakeholder matrix (stage 1).
- The spine-and-branch diagram itself could be the **document index view**.

**Project Management Chart 1** (radial mind-map)
- Weakest of the four on content. But the **radial layout is a candidate for the app's overview/navigation view** — center node = project, spokes = the 9 stages, color-coded by status. An alternative to a linear tracker.

---

## Document types & interactive components

Named as must-haves:

- **Interactive API specs** — source: OpenAPI. Open: expandable endpoints and request/response schemas for sure, but do we want try-it panels in a *plan*? Nothing exists to call yet.
- **Pan/zoom wireframes** — source: a layout tree (regions, components, annotations). Pan/zoom + annotation pins linking to requirements are the *view*.
- **Schema designs** — source: a schema definition file. Rendered as ER-style tables + relationships. _(principle 2 makes "derived from a single source definition" mandatory, not just ideal)_

Candidates surfaced by the reference material, filtered through the plan-vs-execution line:

| Component | Stage | In MVP? |
|---|---|---|
| WBS tree (collapsible) | 8 | ✅ plan artifact |
| Dependency graph | 8 | ✅ plan artifact |
| Gantt / timeline | 8 | ✅ — but the *planned* schedule only. No actual-vs-planned bars. |
| RACI / role assignment matrix | 8–9 | ✅ — but **derived, not authored** (#18). It's a projection of stage-8 task assignments, so it can't drift from them. |
| Risk probability × impact heatmap | 6 | ✅ plan artifact |
| Decision log / open-decisions register | 4 | ✅ pairs directly with the Requirement Gaps stage |
| In-scope / out-of-scope diagram | 2 | ✅ cheap and high-value |
| Requirement traceability view | cross-cutting | ⚠️ **v1, and no longer optional** — #16 cascade, #19 role slicing, the stage-9 gate, and the stage-6 validation gate all run on the chain. The *view* may be v2; the *data* cannot be. |
| Change / amendment feed | cross-cutting | ✅ required by #16. Persistent and acknowledgeable, not a toast. Carries amendments and cascade reviews only (#63). |
| **Activity log** | cross-cutting | ✅ **new** — cosmetic-class edits (#63). Always open, never prompts. |
| **Cascade review queue** | cross-cutting | ✅ **new** — flagged dependents with the agent's proposed diff attached (#62). Probably a view *of* the feed rather than a separate surface. |
| Phase status board (the tracker) | cross-cutting | ✅ — tracks *planning* progress, the one sanctioned exception |
| **Question backlog board** | 4 + cross-cutting | ✅ **new** — dispositions, owners, what's blocking |
| **Assertion / confidence view** | cross-cutting | ✅ **new** — every load-bearing claim with its rung and its evidence. This is what the stage-6 gate reads. |
| **Evidence viewer** | cross-cutting | ✅ **new** — command, environment, output, verdict. Plain, but it's what makes the plan auditable. |
| **Runbook view** | 9 | ✅ **new** — steps, expected output, remediation, evidence links. **Read-only. Renders `pending` and stays there (#24).** |
| KPI tiles / progress gauges | — | ❌ execution tracking, out of scope |
| Burndown, status reports, earned value | — | ❌ out of scope |
| Live runbook execution tracking | — | ❌ **out of scope (#24)** — the seductive one |

### Two principles to hold onto

**1. The document is the primary object.** These are *MDX components* — a document is prose with embedded live visuals, not a dashboard with a text field bolted on.

**2. Every component renders structured data. Nothing is hand-drawn.** _(forced by Decided #8)_

If an AI agent might be on the receiving end, then every visual artifact needs a machine-readable twin. The way to get that for free is to never author the visual directly — author the **data**, and let the component render it:

```
          schema.yaml / spec.json / wireframe.json / assertions.yaml
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
    <SchemaDiagram/>            raw export
    human reads it              agent reads it
```

Consequences if this holds:
- A wireframe is a **JSON layout tree** (regions, components, annotations), not an SVG someone drew. Pan/zoom is a *view* of it.
- An API spec is **OpenAPI**, rendered — not prose describing endpoints.
- A schema is a **definition file**, rendered as an ER diagram — not a diagram that happens to look like a schema.
- An assertion is a **structured record with a confidence rung**, rendered — not a sentence in a paragraph that sounds confident.
- The stage 9 export is then nearly free: ship the visual build for humans, ship the source data for agents. Same artifacts, two readings.
- Cost: authoring is harder. You can't sketch. Every visual needs a data format designed first.

**This is the decision most expensive to reverse.** Hand-drawn artifacts can't be made machine-readable later without redoing them.

_This principle is also the answer to the vision doc's §41. There is no "is Markdown the database?" question here, because the documents were never the database._

### How principle 2 survives contact with real projects _(Decided #13)_

The obvious objection: no two projects are alike, so a rigid schema will eventually fit badly. The resolution is to **vary which structures apply, not how strict they are**:

| Layer | Varies per project? | Enforced? |
|---|---|---|
| Which artifact types a project uses | ✅ declared in `project.yaml` | — |
| The shape of each artifact type | ❌ fixed by its tool's schema | ✅ at the tool call |
| Narrative prose around them | ✅ freehand MDX | ❌ |

So a project with no API surface simply doesn't activate the API-spec artifact. It never gets a half-filled, malformed one. Determinism comes from the schemas being non-negotiable *once active*; flexibility comes from activation being a per-project choice (#39).

**Escape hatch:** every document can carry a freeform section for the thing no schema anticipated. Deliberate, not default. The line is #41's mechanical test — *will anything downstream have to traverse this?*

⚠️ **Failure mode to watch:** the escape hatch becoming the path of least resistance. If the agent starts dumping everything into freeform prose because it's easier than filling a schema, principle 2 is dead and nobody notices until stage 9.

### Four layers of defense

Templates and lint are **complementary, not alternatives** — they catch different things, and neither covers the other's gap:

| Layer | Mechanism | Covers |
|---|---|---|
| **Prevent** | Document templates (#43) | Makes structure the default path. Agent fills slots instead of inventing them. |
| **Enforce** | Tool schemas (#13) | Malformed output impossible at write time. |
| **Detect** | Lint (#46, #47) | Slots present but empty, stubbed, or prose-filled. Drift over time. |
| **Gate** | Exit criteria + stage-6 validation gate + stage-9 check + unvalidated-step acknowledgement (#59) | Stops an incomplete or unproven plan leaving the building — or, where it must leave anyway, makes someone sign for the parts that weren't proven. |

**What templates genuinely fix**
- **The empty-page problem.** With artifact slots pre-placed, filling structure is the low-effort path and the escape hatch becomes the thing you'd have to go add. That directly inverts the failure mode above.
- **Weak local models (#10).** This is the strongest argument. A 7B model filling pre-placed slots massively outperforms the same model asked to invent a document's structure. Templates may be what makes provider-agnosticism actually viable rather than nominally supported.
- **Cross-project consistency**, which matters for the multi-role/agent handoff (#8) — every stage-5 doc looks like every other stage-5 doc.
- They show what "complete" looks like, pairing naturally with each stage's exit criteria.

**What templates do NOT fix**
- Erosion is a **runtime** behavior; a template is only a starting state. Nothing stops a slot being left stubbed or filled with prose.
- Templates can't detect their own drift. Only the lint can tell you a section is present-but-hollow.

⚠️ **New failure mode templates introduce: stub completion.** A doc where every section exists but half are placeholder text *looks* finished and passes a glance — arguably worse than an obviously empty doc, which at least announces itself. The lint has to check **substance, not presence**.

**Lint checks:** required artifacts present for activated types · artifacts non-empty and non-placeholder · escape-hatch ratio · unresolved TODO/TBD markers · exit criteria satisfied · frontmatter valid · traceability orphans (a requirement no component satisfies, a task tracing to nothing, **a runbook step resting on no assertion**) · **unjustified `n/a` without a reason (#45)** · **destructive command patterns classified below `destructive` — override, don't warn (#58)** · **runbook steps below their class threshold and not flagged `unvalidated` with a reason (#57)** · **`unvalidated` steps still unacknowledged at the handoff gate (#59)** · **unresolved cascade reviews — warn everywhere, block at `npm run handoff` (#60)** · **assertions whose recorded `sandbox_tier` can't support their recorded rung (#56)** · **load-bearing assertions still at rung 1 past the stage-6 gate**.

⚠️ **Storage-identity invariants, added 2026-08-18 with #87 — lint rules, deliberately not schema
conventions.** One file per artifact makes **directory membership part of canonical identity**, and the
schema cannot see any of it: a file is schema-valid while being structurally wrong for the storage
model. Three checks, all cheap:

- `data/requirements/DEC-0004.json` — the artifact's `type` must match the directory it lives in.
- `REQ-0007.json` containing `"id": "REQ-0008"` — the `id` must match the filename.
- an ID whose prefix disagrees with its own `type` field (#82's prefix table is the arbiter).

All three arise from manual moves, hand edits, or a bad merge — never from the typed tool, which is
exactly why they belong to **detect** rather than **prevent**.

⚠️ #58 is the one lint rule that **mutates rather than reports**. Everything else in this list produces a finding a human or the agent then acts on; the destructive-pattern floor rewrites the class itself. That's deliberate — a warning about a misclassified `rm -rf` is a warning that can be ignored — but it's a genuine exception to how the lint otherwise behaves, and it should be obvious in the output when it fires.

---

## The handoff package

_From #19, #20, #21, #22, #53. Settled 2026-08-13 — including the MDX question, which needed pushing back on._

### Pushback: agents do NOT read MDX more easily than Markdown

The working assumption was *"if the executing team is AI agents, they can read MDX just as easily if not more easily than Markdown."* **That's backwards.**

**MDX is Markdown with holes in it.** `<SchemaDiagram src="./schema.yaml" />` hands a reader a *component invocation*, not a schema. The actual content lives in two places the MDX doesn't contain: the referenced data file, and the component's render logic. An agent handed that MDX has to resolve imports across files and then guess at the component's semantics to know what it was even looking at. Arbitrary JSX isn't parseable without knowing the component library.

So for an agent, MDX is strictly **worse** than plain Markdown — it's the same prose with the load-bearing parts removed.

But this was never actually a format question, because principle 2 already answered it: **the data files are the machine-readable twin.** The question isn't "MDX or Markdown," it's "which renderings do we ship." Both are renderings. So:

> **Ship the data as canonical. Ship a rendering per audience. MDX never leaves the planning app.**

That costs one flatten step at publish time and buys both audiences a first-class read.

### The layout

```
my-project/                  ← the real project repo
├── .planning/               ← TOOL. gitignored. `git pull` to update.
│   ├── app/  pi-package/
│   ├── schemas/  templates/  stages/
│   └── sessions/            ← Pi session state (#29)
├── planning-content/        ← USER CONTENT. committed. never touched by tool updates.
│   ├── project.yaml
│   ├── stages/01-intake.mdx …
│   ├── skills-overrides/    ← PM-tuned SKILL.md wins over packaged (#33)
│   └── data/schema.yaml, tasks.json, assertions.yaml, evidence/ …
└── docs/plan/               ← FROZEN HANDOFF. committed.
    ├── data/                ← agents. canonical.
    │   ├── requirements.json   schema.yaml   openapi.json
    │   ├── wireframes/*.json
    │   ├── tasks.json       ← IDs, deps, acceptance criteria, role
    │   ├── assertions.json  ← claims + confidence rung + evidence refs
    │   ├── evidence/        ← commands, output, logs, environments
    │   └── runbook.json     ← ordered steps, expected output, remediation
    ├── docs/                ← humans reading in the repo (GitHub-renderable)
    │   └── 01-intake.md … 09-handoff.md · RUNBOOK.md
    │       (schemas→tables, wireframes→SVG, specs→code fences)
    ├── site/                ← humans wanting pan/zoom + expandable API
    └── PLAN.md              ← single-file context bundle
```

**Why the split matters (#20):** a new developer or PM who clones the project repo finds `planning-content/` sitting there and re-clones the tool beside it. The tool improves independently; nobody's documents are held hostage by a version. It also directly answers "would the repo's contents clutter the workspace" — `.planning/` is gitignored, so no.

### Resolving the content root — #69, #70, #71 _(settled 2026-08-16)_

The diagram above is written from the *consumer's* root. This repo is the tool half of it (#69), so
the same two directories sit at two different depths depending on who is looking:

```
a consumer                              this repo, in development
──────────────────────────────          ────────────────────────────────
my-project/                             visual-project-workflow/   ← toolRoot
├── .planning/          ← toolRoot      ├── app/  pi-package/  …
│   ├── app/  pi-package/  …            ├── planning-content/   ← dogfood content
│   └── planning-content/  ← OURS       └── docs/plan/
├── planning-content/   ← THEIRS
└── docs/plan/
```

⚠️ **The hazard is worse than "two paths that look alike", and it ships.** `planning-content/` is
**committed in this repo**, so a consumer's `.planning/planning-content/project.yaml` exists on every
install and parses cleanly — as *our* manifest, for a different project, with a different pipeline and
a different `activated` list. A resolver that tries `./planning-content` before `../planning-content`
therefore does not fail; it succeeds against the wrong project, and nothing anywhere says so. That is
#67's failure shape — a well-formed success with the wrong contents underneath — reappearing in the
app half, and it is why #70 has no fallback rather than a carefully-ordered one.

**Why strict `../` and an override, rather than a path recorded at setup.** Both remove the guessing.
The difference is where a wrong rule surfaces. Under #70, `../planning-content` does not exist in this
repo, so a broken resolver breaks the developer's own machine on the first run. Under a
setup-written path file, this checkout and a consumer's checkout hold *different* correct values, both
work, and the consumer's branch is exercised only by consumers — which is precisely the "works
perfectly right up until somebody else clones it" property 0(d) was raised to prevent. Explicitness
was never the scarce thing here; **local falsifiability was.**

Rejected along the way:

| | Why not |
|---|---|
| Search upward for the nearest `planning-content/project.yaml` | Finds the shipped copy first in every consumer install. The bug is the search, not the search order. |
| Resolve relative to `cwd` | cwd is a property of how the process was launched, not of the layout. Works from the project root, silently wrong from anywhere else. |
| A `contentRoot` written into `.planning/` by setup (#49) | See above — correct, but it makes the dogfood and consumer cases *different configurations of the same code*, so neither tests the other. Also one more file that must be gitignored, because committing it would ship a value pointing at our own content. |
| Stop shipping `planning-content/` in the tool repo | Would remove the trap, and costs the thing step 0 deliberately built: this project planning itself, in the open, in the repo. #70 contains the trap at the resolver instead, which is one rule rather than a structural amputation. |

**Two guards, both cheap, neither load-bearing:**
- Refuse to start if the resolved content root lies **inside** the tool root, unless
  `PLANNING_CONTENT_DIR` was set explicitly. A backstop for a future bug, not part of the mechanism —
  in this repo the override is set, so it never fires here.
- A fixture test that **builds the consumer layout in a temp directory** — `.planning/` plus a sibling
  `planning-content/` — and asserts what resolves. This is the one that actually closes 0(d)'s
  complaint, because it exercises the consumer path on the developer's machine. It belongs with the
  first code that resolves anything, i.e. the skeleton (step 5), not later. ✅ **DELIVERED 2026-08-18, ahead of step 5** — `test/content-root.test.mjs` builds the consumer layout in a temp directory (`.planning/` beside a sibling `planning-content/`, plus the tool's own decoy `planning-content/` inside `.planning/`) and asserts what resolves. It came early because #86's `payloadRef` made containment part of the same module, and a containment test needs the same fixture.

**And the second half of 0(d) was the quieter one.** The `.planning/` line in this repo's `.gitignore`
does nothing here; it only does work in a *user's* project, and that file had no author. → **#71**,
which puts it in the setup script and makes it a decision the PM can reverse — a deleted line stays
deleted. Note what this is not: setup does not manage the consumer's `.gitignore`, it appends to it
once and then leaves it alone forever.

**Why evidence ships with the plan.** A runbook step that says "install via method B" is worth much less than one that also says "method A failed on RHEL 10, here's the output; method B succeeded, here's the output; the test environment matched on OS and package manager but not GPU family." The second one lets the executing team reason when reality diverges. Shipping conclusions without evidence is how a plan becomes something you either obey or abandon.

### Two questions this retires

**"What does an agent actually receive — a URL, a repo folder, a bundled file, an MCP server?"**
The question was about the **delivery channel**: how the package physically reaches the executing team. Four options existed — fetch a URL (needs a server; ruled out by #22), a folder on disk, one bundled context file, or a live MCP server the agent queries. The `docs/` answer already picked one: **the folder in the repo is the delivery.** It's present the moment anyone clones, with zero infrastructure. `PLAN.md` is the bundled-file option thrown in for free, for the case where someone wants to drop the whole plan into a context window. MCP server → parking lot.

**"What export?"**
"Export" = the stage-9 handoff package, i.e. `docs/plan/`. And yes, `tasks.json` is a **first-class machine-readable task graph** — IDs, dependencies, acceptance criteria, role — sitting separate from the prose. It costs nothing extra because stage 8's WBS is already structured data under principle 2.

### Role slices

Generated by filtering the task graph by role and pulling the traced requirements and acceptance criteria along with each task. Nothing is duplicated and nothing can drift, because a slice is a *query*, not a document someone maintains. The full package stays canonical — a lead or an agent team sequencing cross-role work needs to see the whole thing.

### Why publishing is an explicit command (#21)

The benefit is that **the command is the snapshot boundary.** The executing team gets nothing until planning is complete, and the output must then be frozen — but nothing *creates that moment* unless something explicit does. Auto-publishing when stage 9 flips to done would silently republish on every later edit, which is exactly the moving target the freeze exists to prevent.

So `npm run handoff` is the natural home for four things that have to happen together: the **completeness gate** (layer 4 of the four defenses above), the **unvalidated-step acknowledgement** (#59), the **version stamp** (#53), and the **freeze**.

The acknowledgement belongs here specifically because it's the last moment the PM sees the plan as a whole before someone else has to execute it. Anywhere earlier and it's a decision made without the full picture; anywhere later and the package has already left.

Re-publish path, for when an unexpected variable genuinely does hit the plan: `npm run handoff --version 1.1`, with a changelog of what changed since 1.0 — fed by the same change feed from the gate model section. The executing team can then see *what* moved rather than diffing two folders.

---

## The watcher — what's actually true

_Step 2 of the build order, run 2026-08-17. **Windows 11 · Node v24.18.0 · NTFS · chokidar 5.0.0.**
Three checks, all three answered, and one of them reopens a Decided row. The code was throwaway; it
ran in a **consumer-shaped layout** — a `.planning/` beside a sibling `planning-content/` — so the
resolver it bound to was #70's rule and not the dogfood path._

**Check 0, which wasn't one of the three.** Before anything else the spike built #70's resolver and
pointed it at a consumer layout that also contained the trap: a `<toolRoot>/planning-content/` holding
a *different* project's manifest, exactly as every consumer install will after cloning this repo. The
strict rule landed on the sibling; the tool's own copy was present and parsed the whole time. **#70's
central claim — that the wrong root exists and succeeds — is now demonstrated rather than reasoned.**
The refusal path names the resolved path and the override. This is a rehearsal of the fixture test
0(d) still owes at step 5, not a substitute for it.

### The three checks

| # | Check | Result | What it settles |
|---|---|---|---|
| 1 | Can the app read a half-written file? | ❌ **yes, always** — 120 of 120 naive reads were partial | → **#72**. Atomic writes are a property of the first typed tool, not a later fix |
| 2 | Does watching behave on Windows? | ⚠️ **only with the right library** — `fs.watch` lost 399 of 400 events, silently | → **#73**. And events are hints, not a log |
| 3 | Does the #31 partition hold? | ❌ **no** — the document was destroyed in 5 runs of 5 | **#31 reopens.** Locking comes off the Rejected list |

### Check 1 — the partial read is the normal case, not the edge case

A second process wrote a 300KB MDX doc 40 times over while a watcher parsed on every event. The
question was how many parse failures. The answer was all of them.

| | writer | reader | bad reads | revisions the app saw |
|---|---|---|---|---|
| A | non-atomic | naive on-event read | **120 / 120** | **0 / 40** |
| B | non-atomic | `awaitWriteFinish` | 0 / 1 | **1 / 40** |
| C | **atomic** (tmp+rename) | naive on-event read | **0 / 57** | **35 / 40** |
| D | non-atomic | raw `fs.watch` | 400 / 445 | 40 / 40 |
| E | **atomic** | `awaitWriteFinish` | 0 / 5 | 5 / 40 |

Two things in that table matter more than the headline.

**The obvious remedy is the wrong one.** Row B looks like a pass — zero bad reads — and is in fact the
worst row in the table. `awaitWriteFinish` waits for the file to stop changing, so while the agent is
actively writing, *the file never stops changing*: 40 revisions collapsed into **one** event, delivered
after the writer exited. An app tuned that way is at its least responsive precisely when the PM is
watching the agent work. Row C gets clean reads **and** 35 of 40 revisions, because atomic rename means
there is no such thing as a partially-visible state to wait out.

**The rename is not free on Windows.** Row C crashed on the first attempt with `EPERM` renaming over
the destination while a reader had it open. Once retried it happened on 1 of 40 renames — rare enough
to survive development untouched, common enough to fire in front of a user. Hence the retry clause in
#72, which is the sort of thing that only ever gets written down if a spike hits it.

### Check 2 — `fs.watch` fails the way this project cares about most

| operation | `chokidar` | `fs.watch` recursive |
|---|---|---|
| 100 files created at once | **100 / 100** | 2 events, 1 named path |
| 400 files created at once (×3 runs) | **400 / 400** each run | **1 / 400** each run, **no error** |
| 150 rapid writes to one file | 13 events (coalesced) | 301 events (amplified) |
| file in a directory created *after* watch start | ✅ seen | ✅ seen |
| plain rename `a → b` | `add:b` + `unlink:a` | 5 raw events |
| **atomic rename over an existing file** | **`change` — one, clean** | 53 events, including the `.tmp` path |

`fs.watch` doesn't merely drop events under burst — it drops them **without reporting an error**, and
the surviving notification can arrive with a `null` filename. A watcher that says "something happened,
I won't say what, and I won't say I lost anything" is the same silent-success failure as #67, relocated
to the app half. That settles the library question.

Three consequences beyond the choice:

- **Events are hints.** Even chokidar coalesced 150 writes into 13. The app may use an event to mean
  *re-read this path*; it may never use the event stream to mean *this is what changed*. #16's change
  feed has to be derived from content, from the same source of truth the documents are.
- **#72 and #73 agree with each other, which is luck worth banking.** Atomic rename shows up in
  chokidar as a single ordinary `change` — no `unlink`+`add` flap, so the app never sees the document
  briefly cease to exist. The remedy for check 1 costs the watcher nothing.
- **`.tmp` must be ignored explicitly.** chokidar hid the temp-file churn here; a hand-rolled watcher
  did not. Ignore the suffix by rule rather than relying on that.

⚠️ **Measured on Windows only.** Per step 2's own warning: "it works here" and "it works" are not the
same statement, and the `fs.watch` result in particular is a Windows `ReadDirectoryChangesW` buffer
behaviour that will look different on macOS and Linux. #73 is safe regardless — chokidar was exact on
every burst — but the *reason* it's required is platform-specific and should be re-measured before
anyone claims the watcher is cross-platform.

### Check 3 — "partition, don't lock" was a statement of intent, not a mechanism

Two OS processes, one file, 60 edits each, concurrent. The app writer touched only an `appCounter`
frontmatter field; the agent writer touched only a body marker. Disjoint regions, exactly as #31
describes. Five repeats per strategy, because the first pass of this check produced a mode that passed
once and then leaked updates twice — **one sample is not an answer**, and that near-miss is the most
useful thing the check produced.

| strategy | result over 5 runs | |
|---|---|---|
| truncate-in-place read-modify-write | **CORRUPT, 5 / 5** | frontmatter no longer parsed *at all* |
| atomic (tmp + rename) | **lost updates, 4 / 5** | well-formed, but up to 24 of 60 edits vanished |
| atomic + stat-based compare-and-swap | **lost updates, 4 / 5** | narrows the window, does not close it |
| atomic + exclusive-create lockfile | **holds, 5 / 5** | |
| separate files (app owns a sidecar) | **holds, 5 / 5** | |

**Why the partition can't work as written.** Neither writer can change its own region without reading
and rewriting the entire file. So every "frontmatter-only" write is a whole-file write carrying a
snapshot of the body that may already be stale. The regions are disjoint in *intent* and completely
overlapping in *operation*. Nothing about being careful which fields you touch changes that.

**Why compare-and-swap doesn't rescue it**, which is the subtle one: checking `mtime`+`size` before
renaming is a check and then a swap, and the other process fits between them. Two edits in the same
millisecond, or two edits that leave the file the same length, are invisible to it. It converted a
frequent loss into an infrequent one — which is strictly worse to *discover*, because it will pass
in development and lose a PM's status toggle in the wild.

**And the corruption result deserves its own line.** Non-atomic concurrent writes did not produce a
document with the wrong values in it. They produced a document that **is not a document** — no parseable
frontmatter, both counters unreadable, 5 runs out of 5. That is not "last-write-wins plus the change
feed"; there is no version of that file for the change feed to describe.

⚠️ **What this spike did not prove.** Both writers hammered the file 60 times in about a second, which
is far more contention than reality: the app writes a status toggle on a click, the agent writes a doc
now and then. The *rate* is unrealistic and I'm not claiming otherwise. But nothing about the failure is
rate-dependent in kind — lower contention makes the lost update rarer, not impossible, and a rare
silent data loss with no reproduction is a worse bug to own than a common one. Two of the five runs
above lost fewer than five edits; one lost none. That distribution is the argument, not the average.

### What #31 becomes — ✅ settled 2026-08-18 as #78, the lockfile

_Both candidates below held 5 of 5, so the measurements did not choose between them. The reasoning that
did is in #78's row: the sidecar's cost is not its complexity but its **failure modes** — state file
missing, state file left behind by a rename, state file not reverted with a git revert — which turn a
concurrency problem into a reconciliation problem that has no moment at which it is known to be correct._

Both survivors held 5 of 5, and they are not variations on each other:

- **A lockfile** (exclusive create, retry, atomic write inside it). Keeps status in frontmatter, which
  is what **#4** deliberately chose. Costs the thing #31 rejected locking *for* — though the original
  objection ("makes the app feel broken whenever the agent is thinking") is weaker than it reads, since
  the lock is held for a single read-modify-write, not for the duration of a turn.
- **A sidecar** — the app owns `<doc>.state.json` outright and never writes the MDX at all. Partition at
  the **file** level, where the OS actually enforces it, which is the honest version of "partition, don't
  lock". Costs a direct collision with **#4**: status stops living in per-doc frontmatter, and the
  handoff, the lint (#47) and the tracker all have to read two files to know one thing.

**Not choosing between these here.** The asymmetric write permissions in the gate model already say
the app and the agent own different things; whether that ownership is expressed as a lock or as a file
boundary is a design decision with consequences for #4 and the handoff, and it belongs in the same
place the other 73 do — decided deliberately, with a number. It is in Open questions.

⚠️ **This blocks nothing at step 3.** #72 is the constraint the schemas' typed tools need, and it is
settled. The #31 successor only has to be decided before the app writes its first status field, which
is step 5.

---

## Risks

_New section 2026-08-13. Merged from the vision doc §45 and transcript T1 §25, filtered to what's actually in scope after #24. Ordered roughly by how likely they are to bite._

| Risk | Shape | Mitigation in this design |
|---|---|---|
| **The schemas are the critical path** | 16 schemas (#38) all have to land before anything can be authored against them. Nothing else can start. This is a project-management risk, not a design one, and it's the biggest. | Sequence honestly. Build stage 5's schemas first (#54) and prove the loop on one stage before doing the other fifteen. |
| **Orchestrator bloat** | The router starts doing the interesting parts itself. Within a month you're back to one agent. | "Intentionally boring" is a written non-responsibility list, not a vibe. It belongs verbatim in the orchestrator's own instruction file — **not `AGENTS.md`**, which every specialist also reads (#66). |
| **Agent role leakage** | The research agent starts making architecture decisions; the planning agent starts making claims it hasn't validated. | Contracts with explicit *forbidden actions* (#26), scoped context (#27), and typed tools that simply don't exist for out-of-role writes. **Strengthened 2026-08-14:** each specialist's `tools:` allowlist is enforced by Pi across built-in, extension and custom tools, so the boundary is mechanical rather than instructional. ✅ **Verified 2026-08-16 by check 2** — and the mechanism is registry removal, so an out-of-role tool is not refused, it is *absent*. The hedge is gone; **the residual risk moved to #68**, a role that forgets to declare `tools:` at all. |
| **Standing project trust** | #67 has setup record a trust decision for the project directory. That decision persists and is not scoped to the package that prompted it — anything later dropped into `.pi/` or arriving inside the project also loads. The risk moved when #67 was amended: it is no longer "our code grants trust invisibly" but "a grant the PM made once keeps applying to content that arrives later." | Much reduced by the amendment, because the grant is now visible in `~/.pi/agent/trust.json`, was made deliberately, and can be revoked by deleting a line. What remains is the case where `planning-content/` or `.pi/` arrives from somewhere else — a clone, a colleague, a merge — carrying an extension nobody read. #20 makes that path real: content is committed and travels. Partly mitigated by the tool half being gitignored and coming from one remote (#51), and by #67(b) failing loudly rather than silently when tools are missing. If project-supplied extensions ever become a feature, this row is where the argument has to restart. |
| **Context-window overuse** | The instinct to fix "the agent doesn't know X" by adding X to the context, forever. | Structured state outside the context (#4), isolated child sessions per specialist task (#28, #65), scoped routing (#27). If persistent understanding is being solved by stuffing context, something should have been written to a file. |
| **False determinism** | Sandbox success gets read as a production guarantee. Rung 4 gets treated as rung 5. | The ladder (#42) is explicit about the gap, and rung 5 is unreachable by construction (#24). Environment match is recorded, not assumed. |
| **Environment mismatch** | Validation in a slightly-wrong environment produces confident, wrong instructions — worse than no validation, because it carries authority. | Fidelity variables recorded per validation; `environment_match: partial` is a legitimate and common answer. |
| **Silent tier downgrade** | A claim needs tier 3, only tiers 1–2 are active, and the agent validates it approximately in a container and reports success. | ⚠️ **The sharpest new risk from #56.** Forbidden explicitly in the validation agent's contract; the correct output is escalation. `sandbox_tier` is recorded on every assertion so the mismatch is visible after the fact, and the tier→rung table is what makes it checkable. |
| **Self-grading on step class** | The planning agent calls a destructive step `mutating`, which lowers the evidence bar it then has to clear. Same shape as the row above, and just as invisible. | #58's lint floor overrides the class on known-destructive patterns rather than warning about it. Not complete — the pattern list will always lag — so the class is also visible per step in the runbook view and in the handoff. |
| **Acknowledgement fatigue** | #59 asks the PM to sign off each unvalidated step. Enough of them and it becomes reflex clicking, which is worse than no gate because it manufactures a signature. | Fires once at the freeze boundary rather than during planning, so volume is the signal rather than the noise. ⚠️ Genuinely unmitigated beyond that — if runbooks routinely ship with dozens of unvalidated steps, the problem isn't the gate, it's that validation isn't happening, and the gate is just where it surfaces. |
| **Cost runaway** | Repeated GPU instance provisioning during an iterative validation loop. | **Tier 3 only.** Governance policy: cost ceiling, max instance count, max lifetime. Ships with the template, not bolted on. |
| **Resource leakage** | Teardown fails or is skipped; instances run for a month. | **Tier 3 only.** `destroy` is part of the controller contract, auto-teardown is a required policy field, and resource tagging makes orphans findable. |
| **Credential exposure** | The validation agent holds provider credentials, and Pi extensions run with full system access. | **Tier 3 only** — a project that never activates it has no credentials to leak, which is the best mitigation available. Where it is active: narrowly-scoped credentials, production-network isolation, audit logging. ⚠️ Still the weakest area in this design, and it needs real work before anything provisions cloud infrastructure. |
| **Destructive experimentation** | An experiment reaches something real. | **Tier 3 only.** Production-network access denied by policy; discovery/production separation is architectural, not procedural. |
| **Research drift** | The research agent burns time and tokens on low-value edge cases. | Bounded task with a target question (#27), and a question backlog with dispositions so "what's worth researching" is an explicit list rather than a judgment call mid-turn. |
| **Stub completion** | Every section present, half of them placeholder. Looks finished. | Lint checks substance, not presence. `n/a` requires a reason (#45). |
| **Documentation churn** | Every upstream change regenerates six downstream documents; the change feed becomes noise and gets ignored. | **Addressed 2026-08-13** by one-hop cascade (#60), declared materiality (#61), and the two-stream split (#63). The residual risk is the next row. |
| **Rubber-stamping cascade diffs** | #62 attaches a drafted downstream edit to every flag. A plausible-looking diff is easier to approve than to think about, especially the tenth one in a row. | ⚠️ **Partly unmitigated, and deliberately so** — #62 trades friction for throughput on purpose. What limits it: the agent must state *why*, one-hop keeps the queue short enough to actually read, and nothing lands unapproved so the record shows who accepted what. If cascade queues routinely run long, that's the signal to revisit. |
| **Scope creep back across #24** | The runbook artifact makes execution tracking look one small feature away. | Stated explicitly in "The runbook", listed in Rejected, and checked for in verification. It will still be tempting. |

---

## Answered — 2026-08-13

_All four blocks below are settled and promoted to **Decided #14–22**. Kept verbatim rather than deleted, because the reasoning here is richer than what the table rows compress it into — the table says *what*, this says *why*._

_The four questions that came back at me — MDX vs Markdown, "what does an agent actually receive", "what export?", and the benefit of an explicit publish command — are all answered in **The handoff package** above._

**Pipeline shape** → _#14, #15, #16, #17_
- Are the 9 stages fixed, or configurable per project via the manifest? (Decision #4 implies configurable — is that actually wanted, or is a fixed pipeline the point?)
	- The 9 stages are configurable per project and meant to act as more of a guide then ridged or fixed. 
- Are stage gates **hard** (can't open stage 5 until 4 is done) or **advisory** (warn, don't block)?
	- Whatever the determined stages end up being for a particular project they must be honored. So perhaps the system determines an initial stage workflow and can be flexible enough to adjust when the stage workflow needs to adjust. I can see where data from one stage impacts the contents from subsequent stages so the Agent can modify and adjust data across multiple stages, but I am thinking the human project manager should be guard railed to the current document stage that is currently being worked and only move forward to the next stage when appropriate. 
- Can stages be revisited / looped? Discovery often reopens intake. Is this a pipeline or a cycle?
	- As much as I would like for it to be a pipeline I recognize that it is probably more like a cycle. If previous stages have to be revisited or if contents need to be adjusted (add, edit, delete) the project manager should be notified of the specific changes made.
- Do budget and communication plan belong in the 9 stages? _Leaning in now — a plan handed to a team of people plausibly needs both. Neither has a home in the current 9 stages._
	- Yes, those can both belong to stage 9

**The multi-role handoff** → _#18, #19_

_(Note: your answer to the first question settled **who decides** roles rather than the package shape itself. Resolved 2026-08-13 as **full package + generated per-role slices** — since roles now fall out of the stage-8 task graph, a slice is a query rather than a document anyone maintains.)_

- Is the stage 9 package **role-scoped** (developer view, designer view, QA view) or one document everyone reads?
	- Role Assignments should be recommended by the AI Agent but final approval must fall to the project manager.
- Does the plan assign **named people** or **role placeholders**? Named people implies a roster somewhere; placeholders keep the template generic — and placeholders survive the human/agent ambiguity better.
	- Plan assignments by role, not by name
- Where do roles get defined — `project.yaml`, or discovered from task assignments in stage 8?
	- discovered from task assignments in stage 8

**The stage 9 deploy path** _(now that #7 opened it)_ → _#19, #20, #21, #22_
- Where does it deploy — Vercel, a static bundle, a self-contained HTML file, a `docs/` folder committed into the real project repo? More than one?
	- a docs/ folder committed into the real project repo
	- keep project docs separate from the project planning files that are cloned from the git repo so that if changes are made to the repo the users project documents are not impacted. This will allow for the project management repo to be able to improve and grow without the customer losing or re-writing their project documents.
- Is the deployed output **static** (almost certainly — nothing should need a server) and does it stay **read-only**?
	- I am going to go free form for this question and hopefully it puts some context. Perhaps during the initial build phase of when the user would incorporate this project management repo into their project, all of this repos contents would be ignored by git so that it does not clutter the projects workspace... or maybe have the saved MDX files saved somewhere that could be discoverable in the event that the repo gets cloned by a new developer / project manager. When the entire planning pipeline is finalized and the project is ready to be handed off a Markdown version of the documents should be made available for human readability... however, if the team executing on the plan is a team of AI Agents then my assumption is that they are capable of readying MDX documentation just as easily if not more easier then Markdown or some other format. Push bask on this assumption and help me finalize this thought.  
- Is it **public**? A project plan may be sensitive. Auth, or an unlisted URL, or purely local artifacts passed by hand?
	- I believe it to be out of scope to make this project plan publicly accessible. Maybe something worth looking into in the future, but locally hosted on the developers workstation. 
- Is publishing an explicit command (`npm run handoff`) or automatic when stage 9 hits done?
	- What would be the benefit of this? Why might this be necessary?
- Does it snapshot a **version**, so a team executing against "the plan" isn't chasing a moving target while I keep editing?
	- The executing team shouldn't receive any of the documents until the entire planning pipeline is completed. So the final product must be snapshotted, version controlled, and does not change unless an unexpected variable is introduced that impacts the plan. 

**Serving agents as well as humans** _(from #8)_ → _#19; see "The handoff package"_
- What does an agent actually receive — a URL it fetches, a repo folder, a single bundled context file, an MCP server?
	- I do not understand what you are asking here. Please elaborate so I can better respond.
- Does the export include a **machine-readable task graph** (IDs, dependencies, acceptance criteria) as a first-class file, separate from the prose?
	- What export?
- Should the handoff carry its own `CLAUDE.md` / instructions telling an agent team how to read the package and where to start?
	- no, that will be later.
- Do agents need the *whole* plan or just their slice — and does role-scoping mean the same thing for an agent as for a person?
	- this is out of scope for now

---

## Answered — the consolidation, 2026-08-13

_Two questions raised while reconciling this file against the transcripts and the vision doc. Both promoted to **Decided**; kept here because the framing matters more than the row does._

**How far does the research / validation / evidence / runbook machinery come into scope?** → _#23, #24_
- The three documents do cover components that are considered out of scope for the MVP. Keep the current scope after runbook development. Research, Sandbox Validation, Evidence are valid for this MVP as they directly support MVP.

**One pre-configured agent, or the orchestrator + specialist roster?** → _#26, #27_
- Real multi-agent roster: orchestrator (boring router) with `agents/research/`, `agents/validation/`, `agents/planning/` — each carrying inputs, tools, forbidden actions, output schema, and exit criteria.

**Everything under Open questions that carried a `_leaning:_`** was promoted on the same day → _#28–#37, #39–#55_. The reasoning stayed where it was written; see below.

---

## Answered — the Pi re-verification, 2026-08-14

_The ⚠️ at the top of "Pi integration" said everything there had been checked against a **single-agent** design and had to be re-checked before building the roster. That check is done. It was a documentation check, as predicted — but it wasn't cost-free: it confirmed one decision, closed one question, and **invalidated two mechanisms** the document had been leaning on since the consolidation._

**Can one Pi agent hand a bounded task to another with its own instruction file and scoped context?** → _#26 confirmed, new #65_
- **Yes**, and better than expected. Pi has no sub-agent primitive in core, but the SDK supports building one and the repo carries an official `subagent` example extension covering single, parallel, and sequential specialist tasks with per-specialist process, context, model, tools, and system prompt.
- So the fear behind the question — *if Pi can't do this, the roster collapses back to one agent* — is retired. **#26 stands as written.**
- The unexpected bonus: the `tools:` allowlist is real enforcement across built-in, extension and custom tools. "Forbidden actions" stops being a paragraph the model is trusted to obey and becomes a set of tools that aren't there. That's the best mitigation in the document for role leakage, and it arrived free. ✅ **Read on 2026-08-14, run on 2026-08-16 (check 2). "A set of tools that aren't there" turned out to be literally accurate** — the omitted tool is absent from the child's registry, not merely inactive or unmentioned.

**Or does the orchestrator have to be implemented as session forking?** → _#28 rewritten_
- **No — and forking wouldn't have worked anyway**, which is the more valuable half of the answer. `AgentSessionRuntime.fork()` *replaces* the runtime's active session rather than spawning a worker beside it, and a fork *inherits* its parent's conversation. #27 asks for the opposite of inheritance.
- The original #28 was quietly doing two unrelated jobs: organizing history per stage, and isolating specialist context. Only the first is a forking question. Split apart, both get easier — fresh children with bounded payloads for isolation, forks for lineage if a stage transcript is ever worth keeping.
- Pi's own subagent example doesn't fork at all. It launches `pi --mode json -p --no-session` per task. Disposable is the right default here anyway: #29 already says the documents are the real state and losing a session must never lose a decision.

**Do per-agent instruction files load cleanly per session?** → _#66_
- **No, because there's no such thing.** `AGENTS.md` discovery walks the *working directory* hierarchy; agent identity isn't part of it, and `AGENTS.md` isn't a Pi Package resource type either. Every session in the project sees the same file.
- Worth noting the sharp edge, since it's easy to get backwards: Pi's example launches children *without* `--no-context-files`, so `AGENTS.md` still reaches every specialist **in addition to** its role prompt. That's fine — good, even — if it holds shared invariants. It's actively harmful if orchestrator behaviour is sitting in it, which is what the old design implied.

**The canonical Pi npm package name** → _closed_
- **`@earendil-works/pi-coding-agent`.** `@mariozechner/pi-coding-agent` is deprecated on npm and its deprecation notice points here. The repo is `earendil-works/pi`; `badlogic/pi-mono` redirects.

**What it cost, and what it bought.** Two rewrites (#28, the roster's Pi mapping), one correction (#32's missing `-l`), two new decisions (#65, #66), and one new spike (project trust for non-interactive children — see Open questions). Against that: the roster survives intact, and the delegation runtime turns out to be an example to adapt rather than an architecture to invent. **Net, this made the project smaller** — the first thing since the consolidation that did.

⚠️ **One caveat on the caveat.** This pass is documentation and source reading, not something anyone has run. The `subagent` example is an *example*, not a supported API, and adapting it is our maintenance burden when Pi moves. The trust spike is the point where this stops being a documentation check.

---

## Open questions

_Still genuinely open. `_leaning:_` lines are my position — a starting point to argue with, **not** a decision. Items that were promoted to **Decided** on 2026-08-13 are marked `→ #N` and their reasoning is kept in place._

### Genuinely unresolved

**What replaces #31 — how two writers share one document** **→ #78, closed 2026-08-18** _(raised 2026-08-17 by the watcher spike, check 3; closed by the review document, which reached the same leaning independently and pushed it forward from step 5)_

✅ **Closed, and closed earlier than its own deadline said.** This entry gave step 5 as the deadline
because that is when the app first writes a status field. The review document argued for taking it
first instead, and it is right: the decision costs nothing to make now, it is the one remaining
architectural choice, and #72 — which both candidates sit on — is already binding on step 3's typed
tools. **It also surfaced #79**, which this entry did not see: a lock solves simultaneous writes and
does nothing about an agent working from a premise that has since moved.

Not a question about whether there's a problem; that part is measured. Truncate-in-place concurrent
writes corrupted the document 5 runs of 5, atomic writes lost updates 4 of 5, and stat-based
compare-and-swap lost them 4 of 5. Two strategies held 5 of 5, and the choice between them is a design
decision rather than an empirical one:

- **Lockfile** — exclusive create, retry, atomic write inside it. Status stays in per-doc frontmatter,
  so **#4** is untouched and the handoff/lint/tracker keep reading one file to know one thing. The
  price is the thing #31 rejected locking for, and #31's objection deserves re-reading rather than
  re-quoting: "makes the app feel broken whenever the agent is thinking" assumed a lock held across a
  turn. This one is held across a single read-modify-write — ~~microseconds, not minutes~~. ⚠️ **That
  latency claim does not survive into #78**, which states the scope as *a single read-modify-write
  operation, never an agent turn*. The distinction from the rejected lock is the **scope**, not a
  number the implementation would then have to hit.
- **Sidecar** — the app owns `<doc>.state.json` and never writes the MDX. Partition at the **file**
  level, which is the only level the OS enforces, and therefore the honest form of "partition, don't
  lock." The price is a straight collision with **#4**: status leaves frontmatter, and three consumers
  (#47's lint, the tracker, the handoff) each have to read two files and reconcile them.
	- _leaning:_ **the lockfile**, on the grounds that it keeps a document a single object. The sidecar
	  trades a concurrency problem for a consistency problem — two files that can disagree, with no
	  mechanism keeping them in step — and #34's argument against two hand-maintained descriptions of
	  one pipeline is the same argument. But this is a leaning and not a decision: the sidecar's appeal
	  is that it needs no coordination protocol at all, and #3 already frames app-written state as
	  *lightweight* and separable.
- Either way, one thing is already settled by #72 and is not part of this question: **the write itself
  is temp-file-plus-rename.** Both candidates sit on top of that, neither substitutes for it.
- Deadline: **step 5.** The app writes its first status field there and cannot do so without an answer.
  It does not block step 3.

**Try-it panels in API specs** _(from #54's stage-5 flagship; moved here 2026-08-18 from inside the trust spike's RUN block, where it had been sitting with nothing to do with trust)_

- Expandable endpoints and schemas, certainly. But do we want try-it panels in a *plan*? Nothing exists to call yet.
	- _leaning:_ **no for v1, and say so in the schema rather than leaving it undecided.** A try-it panel against an API that hasn't been built is either a dead button or a mock, and a mock in a plan is a claim with no evidence behind it — which is the one thing #23's evidence model exists to stop. The honest version of "try it" in a plan is an `assertion` with `evidence`. Revisit when stage 9 ships a handoff to a team that has built the thing.
- No deadline. This is the only cosmetic item left in this section, and it changes nothing upstream of itself.

**What the schemas are actually written in** **→ #74, closed 2026-08-18** _(raised 2026-08-17, on reaching step 3 — open for one day, which is roughly how long it deserved)_

Never decided, and never recorded as undecided until now — it surfaced only when step 3 became the
next thing to do. Three consumers pull in different directions:

- **#61** needs per-field metadata — the materiality class hangs off every field, so the
  representation has to carry annotations the validator itself ignores.
- **#43** *generates* templates from the schema, so it has to be readable as **data**, not only
  executable as a validator.
- **#47** wants one implementation and three callers: `npm run lint:plan`, the app on save, and a Pi
  extension hook. That third one is the binding constraint — it runs inside a **non-interactive child
  process** with no build step in front of it.

- **Zod, or another TS-first validator** — types come free on the app side, which is TypeScript, and
  the validator and the type are one artifact that cannot drift. The price is that the schema is
  *code*: #43's template generation has to introspect a validator rather than read a document, and the
  Pi extension needs compiled JS or a TS loader. ⚠️ Weaken this fairly — Zod 4 can emit JSON Schema, so
  "TS-first" and "readable as data" are not strictly exclusive; the question becomes which artifact is
  the **source of truth** and which is generated.
- **JSON Schema as the source of truth** — plain data, read cheaply by both halves and by anything
  added later, with per-field materiality riding in a custom keyword. The price is no TypeScript types
  without a generation step, and JSON Schema runs out of expressiveness on cross-field rules — which
  pushes those into the lint (#47), arguably where they belong anyway.
- **YAML with our own validator** — matches `project.yaml`, and it is the most readable by a human and
  an agent alike. The price is writing and maintaining the validator, and "our own schema language" is
  a thing that grows.
	- _leaning:_ **JSON Schema as the source of truth, types generated from it.** #47's three callers is
	  what decides it: two of the three are not the Next.js app, and a representation that needs a
	  TypeScript toolchain to be *read* is one the Pi child cannot read cheaply. Types-from-schema is a
	  build step; schema-from-types is a coupling.
- Deadline: **step 3, before the first schema.** Four schemas written one way and rewritten the other
  is the same retrofit this project keeps arguing against.

**What a trace link to a non-activated artifact type does** **→ #75, closed 2026-08-18** _(raised 2026-08-15 in next-steps.md step 3; moved here 2026-08-17, because decisions belong in this file)_

#38 catalogues sixteen types, #39 makes activation a stage-2 decision the agent proposes and the PM
approves, and step 3 builds four. So `decision` — which carries *linked evidence* and *downstream
dependencies* — has fields pointing at types the project has not activated. This is not an edge case:
it is the state of **every** project that activates fewer than all sixteen, which is the intended
normal.

- **Lint error** — a trace link may only reference an activated type. Clean, and it makes partial
  activation unusable: `decision` cannot be authored at all until `evidence` is switched on.
- **Permitted but unresolvable** — the link is allowed, the lint reports an unresolved reference at
  advisory weight, and it resolves by itself the day the type is activated. The price is that a
  document can carry references that currently go nowhere, and the tracker has to render that state.
- **The field doesn't exist on this project** — schemas are projected through the activated set, so a
  non-activated target means the field is simply absent. The cleanest model and the worst migration:
  activating a type later changes the shape of documents already written, which is #50's
  content-migration problem arriving on day one.
	- _leaning:_ **permitted but unresolvable, at advisory weight.** A hard error makes the normal case
	  unusable, and projecting fields away turns every later activation into a migration. The
	  unresolved link is also real information rather than a defect — it records that a decision
	  *ought* to have evidence behind it, which is #57/#58's machinery showing up early.
- ⚠️ Note which class this lands in: `advisory` is the one of #61's four that step 3's four types
  barely exercise, and the one already parked as needing per-*edge* declarations. Choosing it here
  means the first real advisory rule is this one.
- Deadline: **step 3, before the first schema** — the same retrofit argument as materiality (#61).

**Sandbox governance defaults** **→ #77, closed 2026-08-18** _(narrowed by #56)_

✅ **Closed, and the answer was neither of the two candidates below.** Both leanings were static —
"tier 1 only" or "tiers 1 and 2 on" — and both are guesses about a machine no template has seen, which
is exactly why this repo's manifest and this document's leaning had drifted apart into a disagreement
before anyone decided anything. **#77 makes tier 2 capability-detected** (available where Docker
already works; recommended for approval where it doesn't; never installed on the PM's behalf), leaves
tier 1 on and tier 3 off, and makes tier 3 activation follow the project's scope rather than a setup
question.

**It also answers the second sub-question below, and answers it differently from its leaning.** The
leaning said "once at setup, changeable at any time." #77 is a **hybrid**: tiers 1 and 2 are settled at
setup — one detection, one recommendation if needed — while **tier 3 is demand-driven**, arriving with
the claim that needs it. That is #25's shape, not a per-task prompt, so the objection below still
holds against what it was aimed at.
- #56 answers most of this by construction — tier 1 and tier 2 need almost no policy, and a project that never activates tier 3 has no credentials to govern. What's left: **which tiers are active by default in a fresh `project.yaml`?**
	- _leaning:_ **tiers 1 and 2 on, tier 3 off.** They cost nothing and need no credentials, so leaving them off just means validation doesn't happen. Tier 3 requires a deliberate act, because a permissive default someone forgets to tighten is worse than a restrictive one someone has to loosen.
- Does the PM set tiers once at setup, or per stage / per validation task?
	- _leaning:_ once at setup, changeable at any time, recorded in the change feed (#16) when it changes. Per-task approval sounds safer and would be — for about a week, until it becomes a prompt everyone clicks through.

**Project trust for non-interactive specialist subprocesses** **→ #67, closed 2026-08-15; its mechanism verified 2026-08-18.** ✅ The half that ships — writing `~/.pi/agent/trust.json` — has now been run, with removal and explicit-`false` controls showing it is causal. See the second RUN block. **What remains of this item is #67(b) alone:** detecting a child that came up without our typed tools, which is unwritten code rather than an open question. _(raised 2026-08-14, and it replaced the two questions the re-verification closed)_

_Reasoning kept in place below, per this section's convention. It is worth keeping in full because the leaning was half-right in an instructive way: it correctly saw that trust has to be granted deliberately, and put the grant in the wrong half of the product._
- #65 launches each specialist as a **non-interactive** child (`--mode json -p`). Non-interactive modes **don't prompt for trust** — they use the saved or default trust decision. Does a child launched that way load the project-local package (#32) and its typed tools?
- This matters more than the fork question ever did: every contract in the roster is enforced by typed tools (#66), so a child that silently comes up *without* them doesn't fail loudly — it falls back to freehand output, which is exactly the failure principle 2 exists to prevent.
	- _leaning:_ the setup script records the trust decision for the project directory at install time, same step as `pi install -l`. But this is a **spike, not a leaning** — run one delegated task end to end and confirm the typed tools are present in the child before building three contracts on top of it.

⚠️ **Narrowed 2026-08-15 by reading the shipped docs** (they install with the package, at
`node_modules/@earendil-works/pi-coding-agent/docs/` — no need to fetch them). Still open, because
nobody has run it, but the question is now much sharper and the *documented* answer is **no**:

> `security.md`: "Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust
> prompt. Without an applicable saved trust decision, `defaultProjectTrust: "ask"` and `"never"`
> **ignore such resources**, while `"always"` trusts them. Use `--approve`/`-a` or
> `--no-approve`/`-na` to override project trust for one run."

Three things fall out, and the first is the uncomfortable one:

- **`pi install -l` is what arms the trap.** The resources that *require* trust are
  `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`,
  `.pi/SYSTEM.md`. `-l` writes `.pi/settings.json` — so #32's project-local install is precisely the
  act that makes the project untrusted-by-default. The two decisions interact, and neither row
  mentions the other.
- **The official example spawns without `--approve`.** Its launch line is
  `["--mode","json","-p","--no-session"]` and nothing in it touches trust. So on documented
  behaviour a specialist child comes up **without our typed tools** — and, per the paragraph above,
  without erroring.
- **There are two candidate remedies, and one is far cheaper than the leaning.** Either the setup
  script writes a decision into `~/.pi/agent/trust.json` (keyed by canonical directory; closest
  decision on the current-or-parent path wins), or **our delegation extension simply passes
  `--approve` when it spawns a child**. The second is a one-line change in code we already have to
  write, needs no new setup step, and cannot drift out of date. The spike should establish which.

⚠️ Note what trust does *not* gate: `AGENTS.md` and `CLAUDE.md` "are loaded regardless of project
trust unless context loading is disabled." So #66's assumption survives even in the failure case —
which is the worst combination, since it means a trust-denied child still sounds correctly briefed
while having none of the tools its contract is enforced by.

### ✅ RUN 2026-08-15 — check 1 answered, and the answer is **no**

_First empirical result in this document. Everything above this line was read; this was run._
_Environment: pi 0.80.6 · Windows · `defaultProjectTrust: "never"` in user settings._

```
pi install -l ./pi-package          → .pi/settings.json written, package registered
pi --mode json -p --no-session ...  → extension NEVER LOADED. No error. No warning.
pi ... --approve                    → extension loaded
pi ... -e ./extensions/probe.ts     → extension loaded
```

The two controls are what make this a finding rather than an anecdote: a broken extension and an
untrusted one look identical from outside, so "it didn't load" is only a trust result once the same
file is shown loading by another route. Both controls loaded it.

**So the documented behaviour holds, and the failure is exactly as silent as feared.** The run
produced a well-formed session — `turn_start`, `turn_end`, `agent_end` all fired — with our typed
tools simply absent. Nothing anywhere said so.

**What the run proves is that trust is the variable — not which mechanism should grant it.**
`--approve` on the spawn line flips the result, so the diagnosis is certain. But `--approve` and a
recorded decision in `~/.pi/agent/trust.json` both close it, and choosing between them is a design
question the spike cannot answer. See **#67**, which went to the recorded decision plus loud
detection — and which was written the `--approve` way first, then amended the same day. The leaning
in this section turned out to be right after all: **it correctly put the grant in the setup script**,
and the thing it was missing was not the location but the detection.

⚠️ **And here is what was *not* run, stated plainly, because this block is the empirical record and an
omission here reads as a measurement** _(added 2026-08-17)_. Three commands above were executed. A
fourth was not: **nothing ever wrote `~/.pi/agent/trust.json` and re-ran the child.** The route #67
chose is therefore the one route in this section with no line in the code block. That is not a reason
to change #67 — the reasoning for preferring a recorded decision over `--approve` stands on its own —
but it means #67(a) ships on `security.md`'s word, and #67(b) is a design rather than code. The
verification is cheap and belongs before #49: write the decision the way the setup script would, run
the same child, and confirm the extension loads without `--approve`. If it doesn't, the fallbacks are
already proven on this machine and the loss is a setup step, not the design.

**The test, with the control that makes it a test** _(from the review document, 2026-08-18 — it is now
#76 step 2a)_. Clean project · restrictive `defaultProjectTrust` · `pi install -l` · launch a
non-interactive child and **confirm the typed tools are absent** · write the trust entry exactly as the
setup script would · launch the same child and confirm the extension loaded, the custom tools are
registered, and **no `--approve` was needed** · then **remove the entry and confirm the child reverts to
untrusted.** That last step is the control, and it is the one that would otherwise be skipped: without
it, a child that loads for some unrelated reason — a stale global setting, a parent-path decision
already in `trust.json`, an inherited environment — reads as a pass. Same discipline as the two controls
that made the original run a finding rather than an anecdote. Result is binary; there is nothing to
design.

⚠️ **The distinction that matters, and it took being challenged to see it.** `--approve` is not a
formality — it means the delegation extension overrides the PM's own `defaultProjectTrust` on their
behalf, silently, for every child, with no way to decline short of editing our code. On this very
machine that setting is `"never"`. "Convenient" is not an answer to that. A recorded decision is
made once, by the PM, in a file they can read and delete.

**Side finding — check 4 came back free, and positive.** `turn_end` fired with `mode: "json"`,
`hasUI: false` — which is precisely the child's invocation (`--mode json -p --no-session`). So
turn-end hooks *do* work in a non-interactive child, and #48's lint feedback loop can reach
specialists rather than only the orchestrator. **With one dependency worth stating: no trust means no
extension, and no extension means no hook.** #48 rides on the `--approve` decision above.


### ✅ RUN 2026-08-18 — 2a answered: writing `trust.json` works, and it is causal

_Second empirical result on trust. **The mechanism #67 chose has now been executed**, which is what the
amendment above said was owed. Environment: pi 0.80.6 · Windows · `defaultProjectTrust: "never"` ·
`~/.pi/agent/trust.json` **did not exist** at the start, so there was no pre-existing decision on any
parent path to confound the result._

⚠️ **The original spike directory was gone.** `D:\spike-pi-trust` had been deleted, so this ran in a
freshly built minimal fixture at `D:\spikes\trust-verify` — one package, one extension, one custom tool.
Same shape, not the same files.

**The observable is upstream of the model**, per the technique check 2 established: the extension writes
a marker file at **load time**, before `session_start` and long before any inference. Its presence means
the extension loaded; its absence means it never did. The configured provider (`llamacpp`) was down for
every run and every session still completed — which is the silent failure of check 1 reproduced
incidentally, and the reason the marker is not taken from model behaviour.

| run | `~/.pi/agent/trust.json` | `--approve` | extension loaded |
|---|---|---|---|
| 1 | file absent | no | ❌ |
| 2 | file absent | **yes** | ✅ |
| 3 | `{"D:\spikes\trust-verify": true}` | no | ✅ |
| 4 | `{"D:\spikes\trust-verify": false}` | no | ❌ |
| 5 | file absent (removed) | no | ❌ |

**Runs 3, 4 and 5 are the answer #67 needed.** Run 3 alone would only show that the tools appeared
after a file was written. **Run 5 removes the entry and the behaviour reverts**, and **run 4 flips it to
`false` and the behaviour reverts too** — so the recorded decision is *causal*, not correlated with
something else that changed. Run 2 is the fixture control: the same extension demonstrably can load.

**The format, which was the unverified part.** A flat JSON object mapping **canonical directory →
boolean**, keys sorted, two-space indent, trailing newline — `realpathSync(dir)` as the key, so on
Windows that is `D:\spikes\trust-verify` with escaped separators. Read with the closest decision on
the current-or-parent path winning, exactly as `security.md` describes. A setup script (#49) writing
this is a dozen lines.

**Three things this settles beyond the yes/no:**

- **#67(a) is now measured rather than documented.** The row's amendment can be read as discharged.
- **Run 4 vindicates #67's actual argument.** The case against `--approve` was that a recorded decision
  is "made once, by the PM, in a file they can read and delete." An explicit `false` is honoured — so
  the PM can *decline*, and declining survives. That was an assumption too, and it is now a result.
- **Run 2's registry confirms #68 again** — the default active set with no `--tools` was
  `bash, edit, find, grep, ls, read, write` plus the custom tool.

⚠️ **What this does not cover: #67(b).** The delegation extension still does not detect a child that
came up without our typed tools. Trust being grantable does not make a missing grant loud, and every
run above that failed did so in a session that completed normally with no error anywhere.

⚠️ **A reusable spike-design principle, not housekeeping — the second of a pair.** The first attempt at
run 4 produced an empty output file: the process was killed by a harness timeout before pi wrote
anything, and its "extension absent" would have read as a clean negative. It was re-run.

> **Negative evidence requires proof that the observation point was reached.** "Marker absent" means
> nothing if the process never got as far as loading extensions.

Same-size completed transcripts on every row are what supply that proof here. **Pair this with the rule
check 2 established** — *take the mechanical observable upstream of the model, not downstream of its
behaviour* — and the two together cover both directions in which a spike can lie to you: a positive
that came from the model rather than the mechanism, and a negative that came from the process never
running. Every check in this project from here on should be able to say which control covers which.

⚠️ **The rebuild was a gain, not a cost.** Losing `D:\spike-pi-trust` forced a fresh fixture, and a
fresh fixture eliminated two confounds the original could not have ruled out: **accumulated historical
state** from six earlier checks, and **any pre-existing parent-path trust decision**. The run started
from a machine with no `trust.json` at all. That is a cleaner basis for a causal claim than reusing the
environment would have been.

### ✅ RUN 2026-08-18 — 2b answered: **outcome A. Our override path wins.**

_Fixture at `D:\spikes\override-verify`, consumer-shaped: `pi-package/skills/plan-check/SKILL.md`
carrying `BODY-MARKER: PACKAGED`, and `planning-content/skills-overrides/plan-check/SKILL.md` carrying
`OVERRIDE`, registered through the **settings `skills` array** — the exact mechanism this product plans
to ship. pi 0.80.6 · Windows · trust granted by the #67(a) mechanism verified earlier the same day._

**The observable is provenance, not behaviour.** `before_agent_start` exposes
`systemPromptOptions.skills`, and every entry carries `filePath`, `baseDir` and `sourceInfo` — so the
probe records **which file Pi loaded**, upstream of the model, and reads the marker off that path. No
run depends on what the model said.

| run | override at `planning-content/skills-overrides/` | skill Pi loaded |
|---|---|---|
| 1 | absent (no `skills` entry in settings) | `PACKAGED` ← `pi-package/skills/…` |
| 2 | `OVERRIDE` | **`OVERRIDE`** ← `planning-content/skills-overrides/…` |
| 3 | edited to `OVERRIDE-V2` | **`OVERRIDE-V2`** ← same path |
| 4 | files deleted, **settings entry left in place** | `PACKAGED` ← `pi-package/skills/…` |

**Runs 3 and 4 are what make this causal rather than coincidental.** Run 3 shows the loaded body tracks
edits to that file, so run 2 was not a cached or lucky match. Run 4 removes the override and the
packaged skill returns — while the settings entry stays — so the packaged skill was **shadowed**, not
broken, and shadowing is reversible. In runs 2 and 3 exactly **one** `plan-check` was loaded: the
override replaced it rather than sitting beside it.

⚠️ **This contradicts the prediction, and the prediction was mine, drawn from the docs.** Check 6's
caveat reasoned from `skills.md`'s location list — Global → Project → **Packages** → **Settings** → CLI
— plus "name collisions warn and keep the first skill found," and concluded that a settings-registered
override would **lose** to the packaged skill. It does not. **The listing order in that document is not
the precedence order**, at least between packages and settings. `sourceInfo` for the winner is
`{source: "local", scope: "project", origin: "top-level"}`; for the packaged one it is
`{source: "..\pi-package", scope: "project", origin: "package"}`.

**So #33 stands as written** — outcome A of the three. `planning-content/skills-overrides/` is a real
override location, tuning a skill does not mean editing the tool, and #20's merge-conflict-on-update
failure stays prevented. The customization story can now be documented.

⚠️ **What was *not* tested, so nobody reads more into this than it says:** relative precedence between
`planning-content/skills-overrides/` and `.pi/skills/` when both hold the same skill. That control was
prepared and became unnecessary — it existed to separate "precedence is broken" from "our path isn't in
discovery," and neither is true. If the setup script ever writes to both, this needs answering first.

**Side finding, and it closes an open loose end from step 1.** Every run in this spike hung — pi
produced nothing, in every directory, including 2a's fixture and an empty one — until stdin was closed:
`< /dev/null`. That is the **inherited-stdin bug** found in the spike's `delegate.ts`, reproduced at the
shell level with no delegation code involved. Step 1 recorded that two fixes were applied together —
`shell: true` removal and `stdio: ["ignore", …]` — and that **"which one was load-bearing is unknown."**
It is known now: **the stdin half is load-bearing on its own.** Same command, only difference `<
/dev/null`, hang versus exit 0. The real extension needs `stdio: ["ignore", "pipe", "pipe"]`
irrespective of how it spawns — and the spawn timeout argued for there is worth more than it looked,
since this failure mode is a silent indefinite hang, not an error.
### Promoted 2026-08-13 — reasoning retained

**The setup script**
- What does it actually do? Best guess at the full chain: prompt for project name → write `project.yaml` → scaffold empty phase docs from templates → `npm install` → `pi install -l ./.planning/pi-package` (#32) → record the project trust decision → provider setup → `git init` → launch the app. That's a lot for one script; does it need to be resumable / re-runnable? **→ #49**
	- _leaning:_ idempotent and re-runnable, with each step checking its own precondition rather than tracking overall progress. Provider setup is the one step allowed to **fail without aborting** — the app should come up unconfigured with a banner, not refuse to start. A setup script that can strand you halfway is worse than one that takes two runs.
- How does a cloned project pull template *updates* later, if at all? **→ #50**
	- _leaning:_ `git pull` inside `.planning/`, which #20 makes safe by construction. Add a schema version field to `project.yaml` so the tool can detect content written by an older version and migrate it.
- Does the clone keep the template's git remote, or detach entirely? **→ #51**
	- _leaning:_ `.planning/` keeps its own remote — that's the update channel. Being gitignored by the parent repo means no nested-repo confusion.

**Agent ↔ app integration** _(embed-vs-terminal settled by #12 — v1 is terminal beside browser)_
- How does the app learn about agent edits — a file watcher on `content/`, or do the typed tools ping the dev server directly? **→ #30**
	- _leaning:_ the file watcher on `planning-content/` is the source of truth and **must work on its own**, because #12 puts the agent in a plain terminal that knows nothing about the dev server. Typed tools may additionally ping the server for instant feedback, but only as an optimization — never as the mechanism.
- **Two writers, one file.** What stops me and the agent clobbering each other mid-phase? Lock the doc while the agent has the turn? **→ #31**
	- _leaning:_ don't lock — **partition**. The app writes frontmatter and state fields; the agent writes body prose and data files. Different regions of different files, so there's nothing to clobber. Where they genuinely must overlap, last-write-wins plus the change feed (#16) is enough for a single-user local tool. Locking is a big hammer that makes the app feel broken whenever the agent is thinking.
- One long Pi session for the whole project, or **a session per phase**? Per-phase keeps context tight and maps to `fork()`; one session keeps continuity. **→ #28** _(now also carrying #26's scoped-context requirement)_
	- _leaning:_ per-phase sessions forked from a shared project-context session. Keeps context tight, maps cleanly onto `fork()`, and a stage's session becomes a reviewable record of how that document was arrived at.
- Session persistence — `SessionManager.create()` to disk so a plan survives a restart, or in-memory and rely on the documents as the real state? **→ #29**
	- _leaning:_ persist to disk under `.planning/` — it's tool state, not content, so it doesn't belong in `planning-content/` (#20). But the documents stay the real state: **losing a session must never lose a decision.** If it can, something that should have been written to a document wasn't.

_Deferred to v2 with the embedded chat: who approves file writes when the agent is driven from a browser; whether pi's TUI affordances (approvals, diff review, slash commands) get rebuilt or dropped._

**Artifact types & schemas** _(from #13)_
- What's the **catalogue** of artifact types? Each one needs a schema designed before anything can be authored against it. **→ #38**
	- _leaning:_ the components table above is already ~80% of the catalogue. Proposed v1 set: `requirement` · `decision` · `risk` · `acceptance-criterion` · `task` · `role-assignment` · `schema` · `api-spec` · `wireframe` · `scope-boundary`. Ten schemas is a real chunk of work and it all has to land before anything can be authored against it — this is the critical path, not the app.
	- **Amended by #23:** six more — `question` · `research-finding` · `assertion` · `evidence` · `runbook` · `runbook-step`. Sixteen. The critical-path warning got worse, not better.
- Who activates them for a project — me at setup, or the agent as the plan reveals its shape? **→ #39**
	- _leaning:_ agent proposes at stage 2 (the first point the project's shape is actually knowable), PM approves — the same recommend/approve split as roles (#18). Fluidity comes from the proposal, predictability from the approval. Activating at setup means guessing before you know anything.
- Can a project define a **new** artifact type, or only choose from the catalogue? **→ #40**
	- _leaning:_ catalogue only for v1. A new type is three things, not one — a schema, a typed tool, and a renderer — and a type missing any of them is worse than not having it. The escape hatch covers the gap in the meantime.
- Where does the escape-hatch line sit, concretely? **→ #41**
	- _leaning:_ the operative test is **"will anything downstream have to traverse this?"** Prose is free anywhere, but anything that will be **traced, filtered, or exported** must be an artifact. Concretely: if stage 9 needs to slice it by role, or the lint needs to check it, or the change feed needs to cascade through it, it can't be prose. That's a mechanical test rather than a stylistic one, which is what makes it enforceable.
- What checks that a document isn't mostly escape hatch — a lint, a build warning, a completeness gate at stage 9? **→ #46**
	- _leaning:_ lint warns on the ratio continuously; the stage-9 gate blocks.

**Templates & lint**
- Are templates **generated** from activated artifact types + schemas, or hand-written per stage? **→ #43**
	- _leaning:_ generated. Hand-authored templates and schemas drift, and a template that disagrees with its schema teaches the agent the wrong shape.
- Does the lint **block** or just **warn**? **→ #46**
	- _leaning:_ **warn continuously, block at exactly two boundaries** — the stage transition and `npm run handoff`. Blocking mid-thought is wrong; blocking at a gate is the entire point of having gates. A lint that blocks while you're still drafting gets disabled within a week.
- Who runs it — a `npm run lint:plan` command, the app on save, a Pi extension hook, or all three? **→ #47**
	- _leaning:_ all three, but **one implementation with three callers**. Three copies of the rules is three sets of rules within a month.
- Can the agent **see** lint output and fix its own gaps? **→ #48**
	- _leaning:_ **yes — and this may be the single highest-leverage item in this document.** A Pi extension hook that runs the lint at turn end and feeds failures back turns the lint from a report into a self-correcting loop. It's also plausibly what makes provider-agnosticism (#10) *real* rather than nominal: a 7B model that can't reliably produce a complete document on the first pass can absolutely fix a named gap on the second. Build this early, not late — it changes what every other piece can assume about output quality.
- How does the lint distinguish "deliberately empty because not applicable" from "forgotten"? **→ #45**
	- _leaning:_ an explicit `n/a` with a **required** `reason` string, stored as a structured field. The lint then counts unjustified N/As, which is a much better signal than counting empties. It also makes "not applicable" a decision someone made rather than a state something drifted into.
- Do templates carry the stage's guiding question (the `↓ ask:` pattern)? **→ #44**
	- _leaning:_ yes. Cheap, already identified as worth stealing, and it does real work against the empty-page problem — a question is far easier to start answering than a heading is to start filling.

**The shipped Pi package**
- In-tree and `pi install ./pi-package`, or published to npm and installed by name? **→ #32**
	- _leaning:_ in-tree at `.planning/pi-package/`, installed by the setup script. Nothing to fetch, matches the journey, and updates ride the same `git pull` as everything else. Publishing to npm adds a release step that buys nothing while there's one consumer.
- How does a cloned project pull *updates* to the skills later, if at all? **→ #50**
	- _leaning:_ same `git pull` in `.planning/`, then re-run `pi install`. One update path for the whole tool, not one per half.
- Do skills live inside the package, or loose in the repo where the PM can tune them? **→ #33**
	- _leaning:_ inside the package, **plus** a `planning-content/skills-overrides/` drop point where a PM can put a tuned `SKILL.md` that wins over the packaged one. Tuning a skill shouldn't mean editing the tool — that's a merge conflict on the next update, which is exactly what #20 exists to prevent.
- Does the app read the same phase definitions the skills use, so the two halves can't drift? **→ #34**
	- _leaning:_ **yes, and treat this as non-negotiable.** One `stages/` definition set; the app renders from it and the skills derive from it. Same drift argument as templates-vs-schemas — two hand-maintained descriptions of the same pipeline will disagree, and the disagreement will surface as the agent confidently working to exit criteria the app isn't checking.

**Provider setup** _(journey step 5 — the only step that's really the PM's)_
- Does the build script wizard this, or defer to `pi-localllm-provider`? **→ #35**
	- _leaning:_ defer. It already does TUI-driven setup for exactly this provider list; rebuilding it is work that competes with the schemas on the critical path. Do document the `compat.supportsDeveloperRole: false` sharp edge in the setup docs — that one will bite someone on day one.
- Is there a **minimum model capability bar**? **→ #36**
	- _leaning:_ **warn, never refuse.** Publish a tested-models table instead. A hard capability gate is unenforceable (you can't reliably detect "this model is too weak" until it's already produced something bad) and it insults users running perfectly adequate local setups. The real mitigation isn't a gate — it's templates + typed tools + the lint feedback loop, which together make a weak model's output structurally valid even when it isn't brilliant.
- Which provider do I develop and test against first? **→ #37**
	- _leaning:_ develop against a frontier model for iteration speed, then harden against a local 7–8B before v1 ships. Developing against the weak model first means every design decision gets confounded by "is this wrong, or is the model just struggling?" — you'd move at a fraction of the speed and learn less.

**Cascade severity** _(from #16, the gate model)_ **→ #60–#64**
- If stage 2 is amended, does everything downstream that traces to it also flip to `amended`? Mechanically computable, but one wording fix turning six stages yellow trains the PM to dismiss the feed. Needs a material-vs-cosmetic distinction — **and who judges materiality, the agent or the PM?**
	- _Was the sharpest unsolved thing in this document._ **Answered 2026-08-13 — and the question was wrong.**
	- The framing assumed a **severity** axis. There isn't a usable one: size and materiality are uncorrelated, so any score would have been noise dressed as signal. The actual cause of "six stages yellow" was **transitivity** — flagging the full downstream closure when an acceptance criterion depends on the design component, not on the requirement behind it. One-hop cascade (#60) fixes it without any severity notion at all.
	- "Who judges materiality" also dissolved rather than got answered. **The schema decides whether it cascades** (#61, per-field classes — deterministic, and possible only because principle 2 made artifacts structured). **The agent explains why it changed** (#62, captured by the typed tool). **The PM decides whether to act.** No one party judges.
	- Severity levels are now in **Rejected**, not the parking lot — they were solving a problem that turned out not to be the problem.

**The confidence threshold** _(from #42)_ **→ #57**
- Which rung must an assertion reach before the planning agent may build a runbook step on it? And is it one global threshold or per-project?
	- _leaning (superseded):_ rung 3 minimum for any step that changes system state, rung 2 for informational steps, and a `project.yaml` field so a high-stakes project can raise it. Not confident about this one.
	- **Answered 2026-08-13.** The leaning had the right instinct and two holes. It never said **what happens to a step that falls below the bar** — which turns out to be the operative half — and it treated "changes system state" as one bucket when destructive and merely-mutating steps deserve different bars. Resolved as a three-class mapping with a hardware override, three below-threshold moves, and raise-but-never-lower. The wording was also just bad: "threshold" named the number and never said what it gated. See "The threshold — when may a claim become an instruction".

**The sandbox** _(from #23)_
- Which sandbox ships in v1 — Docker-only, or the cloud provisioner too? **→ #56**
	- _leaning (superseded):_ ship the interface provider-shaped with **Docker as the only v1 implementation**, and add the cloud provisioner after the loop works. It keeps credential handling off the critical path, at the cost of not being able to validate the motivating RHEL 10 / CUDA example in v1.
	- **Answered 2026-08-13 — better than the leaning.** Three tiers, **PM decides and the agent enforces**: venv · Docker/Compose · AWS CLI + Terraform. This reframes the question: it was never "which one do we build," it's "what is this project allowed to reach for." A venv tier below Docker is the part I'd collapsed — most claims worth checking are dependency questions, and making those cost a container is how validation quietly stops happening. Credential handling stays off the critical path for any project that doesn't activate tier 3, which is most of them.

**Scope of the app's knowledge**
- Does it know anything about the codebase being planned, or is it purely a document tool sitting alongside? **→ #52**
	- _leaning:_ purely a document tool for v1. The **agent** can already read the codebase — that capability exists and doesn't need duplicating in the app.

**Output**
- Do documents get versioned across planning revisions, or is git history enough? **→ #53**
	- _leaning:_ git history is enough *during* planning. Explicit versioning starts at `npm run handoff` (#21), which is the only point a version number means anything to anyone.

**Build**
- Which interactive components ship in v1? **→ #54**
	- _leaning:_ schema designer + API spec, confirming the suspicion — stage 5 is the flagship. Plus the phase status board and the change feed, though those are infrastructure rather than components.
- What's the minimum walking skeleton? **→ #55**
	- _leaning:_ manifest → tracker view → one MDX doc rendering → status write-back, **plus the file watcher**. #12 puts the agent in a separate terminal, which makes the watcher the entire integration surface between the two halves of the product — if it's not in the skeleton, the skeleton doesn't prove the thing that's actually risky.

---

## Parking lot

_Raw ideas. No obligation to develop them._

- **MCP server exposing the plan as queryable tools** (`get_task(id)`, `list_requirements(role)`) so an agent team queries the plan instead of loading all of it. The fourth delivery option from #19 — deliberately not chosen for v1, but the one that gets more attractive the larger a plan gets.
- **A `CLAUDE.md` / `AGENTS.md` inside the handoff** telling an executing agent team how to read the package and where to start. Explicitly deferred, not rejected.
- **Strategic / tactical / operational as a second axis** cutting across the 9 stages (from the 3-Layers infographic). Too much for v1.
- **Radial mind-map as the overview navigation view** (from Chart 1) — an alternative to a linear tracker.
- **Per-edge propagation declarations** — the `advisory` class (#61) needs to say "priority cascades to `task` but not to `design-component`," which is a property of the edge rather than the field. More schema machinery than the other three classes need; may turn out to be unnecessary once real edges exist.
- **A reviewer / governor agent** — a fifth role that challenges conclusions, checks evidence sufficiency, verifies exit criteria were actually met rather than declared met, and blocks promotion of weak evidence. The argument for it is real: an agent approving its own work is a structural weakness. But it's a fifth contract to write before the first four have proven themselves, and the PM currently plays this role.
- **Cross-boundary research packages** — a portable artifact (question · sources · conclusions · assumptions · environment · tested commands · validation results · applicability constraints · confidence) for moving validated knowledge into a restricted environment that can't do its own research. Directly useful for the work environment that motivated this whole project, and it's mostly a serialization of things #23 already produces. Genuinely attractive; just not v1.
- **An event-driven workflow model** — `research requested` / `validation passed` / `decision required` / `runbook ready` as first-class events the orchestrator reacts to, instead of routing logic living inside a conversation. Probably where this ends up if the orchestrator gets complicated enough. Not needed while there are nine stages and four agents.
- **Generalized sandboxing beyond infrastructure** — code generation, unit and integration tests, build validation, dependency testing, deployment simulation. Keep the sandbox interface from precluding it; don't build it.
- **Project archetype / classification** driving which stages a project gets automatically, rather than the agent proposing them. Would make #14 deterministic rather than conversational. Needs a taxonomy nobody has designed.

---

## Rejected / not doing

_Dead ends go here with a one-line reason, so they don't get reconsidered six weeks from now._

- **A public or hosted plan URL** — project plans are sensitive and nothing here justifies an auth story. Local only (#22).
- **MDX as the handoff format** — an agent receives component invocations, not content; MDX is strictly worse than Markdown for a machine reader. Ship data + rendered Markdown instead (#19).
- **Auto-publishing when stage 9 hits done** — it would silently republish on every subsequent edit, which is precisely the moving target the freeze exists to prevent (#21).
- **Named-person assignment in the plan** — implies a roster to maintain and breaks the moment the executing "person" is an agent (#18).
- ~~**Locking documents while the agent has the turn**~~ — ⚠️ **UN-rejected 2026-08-17.** The reason given ("partitioning what each writer touches solves the same problem") was measured by the watcher spike and is false: partitioning within a file solves nothing, because neither writer can touch its region without rewriting the whole file. The rejection still stands *as written* — nobody is proposing a lock held for the duration of a turn — but a lock held for one read-modify-write is now a live candidate. See #31 and Open questions. **Hard-rejected 2026-08-13** by #31; it was previously a leaning.
- **Runbook execution monitoring** — live step state, "paste your output here," pass/fail evaluation of a real run. The far side of #24, and the single most likely thing to creep back in.
- **Execution-output ingestion** — feeding what actually happened back into the plan. Same line.
- **Remediation loops driven by production failures** — the runbook ships with *pre-written* remediation from validation; it does not learn from real runs.
- **Lessons-learned promotion** — deciding which project facts are reusable knowledge. Out with the rest of the post-runbook half (#24).
- **An organization-wide knowledge repository** — several products away, and the vision doc's own advice is not to build it before the core loop proves itself.
- **An autonomous implementation agent** — executing approved runbooks without a human. Explicitly deferred in every source document and out under #24.
- **Severity levels on the change feed** — proposed as the fix for cascade noise, and it was solving the wrong problem. Size and materiality are uncorrelated, so the score would have been noise. Transitivity was the actual cause; #60 fixes it without a severity axis (#60–#64).
- **Transitive-closure cascade** — flagging every artifact downstream of a change. Correct-looking, and it's what turns the board yellow. The closure stays *viewable*; it just doesn't become flags (#60).
- **Auto-applying downstream edits without approval** — the plan would stay internally consistent with no PM latency, but edits would land in stages the PM isn't focused on, which is exactly what #15's focus-lock exists to prevent (#62).
- **Auto-triggered re-validation on upstream change** — a one-word requirement edit could spend real money in tier 3. Evidence goes stale from environment change, not document change (#64).
- **Session forking as the delegation mechanism** — `AgentSessionRuntime.fork()` replaces the runtime's active session instead of spawning a worker beside it, and a fork inherits the parent's conversation, which is the opposite of #27's scoped context. Delegation is a typed tool launching isolated children (#65); forking stays available for lineage and review (#28). **Rejected 2026-08-14** by re-verification, not by argument.
- **Per-agent `AGENTS.md`** — Pi discovers context files by working directory, not by agent identity, and `AGENTS.md` isn't a Pi Package resource type. Role instruction ships as specialist definition files; `AGENTS.md` holds shared invariants only (#66).
- **A dedicated validation stage between 6 and 7** — validation is demand-driven from stage 3 onward with a gate at 6 (#25). A stage would make a stage-3 finding wait four stages to get tested. _(Revisit if validation keeps getting deferred to the gate in practice — see the warning in "The pipeline".)_

---

## Coverage — what came from where

_The audit trail for the 2026-08-13 consolidation. Every section of `ai_project_planning_consolidated_vision.md` has a disposition here. `notes.md` is canonical; where the two disagreed, this file won._

| Vision doc §§ | Topic | Disposition |
|---|---|---|
| 1, 3, 53 | Executive summary, product thesis, final definition | **Merged** into North Star |
| 2 | Origin of the project | **Context only** — the frustration it describes is what this whole file is |
| 4.1–4.10 | Guiding design principles | **Distributed** — 4.1/4.2/4.3 → Adaptive intake + #4; 4.5–4.9 → Research/validation/evidence; 4.10 → the agent roster |
| 5 | Desired user experience | **Already covered** — matches the user journey almost line for line |
| 6 | Conversational intake model | **Imported** → "Adaptive intake" |
| 7 | Agent as planning facilitator | **Imported** → Adaptive intake, final paragraph |
| 8 | Dynamic project pipeline | **Already covered** by #14. The archetype/classification idea → Parking lot |
| 9, 9.1–9.4 | Multi-agent architecture + contracts | **Imported** → "The agent roster", #26 |
| 9.5, 9.6 | Human implementer / knowledge curator | **Partly out** — implementer role is on the far side of #24; curator role goes with lessons-learned |
| 10 | Future agent roles | **Parking lot** (reviewer/governor) / **Rejected** (implementation agent, knowledge curator) |
| 11 | Agent context model | **Imported** → #27, scoped-context routing |
| 12 | Agent contracts | **Imported** → the seven-field contract shape |
| 13 | Research and discovery | **Imported** → #23, "Research, validation & evidence" |
| 14 | Sandboxed experimentation | **Imported** → same section |
| 15 | Sandbox options | **Imported** → "Sandboxes", including the no-hard-coding rule |
| 16 | Environment fidelity | **Imported** → "Environment fidelity", and it's what rung 4 means |
| 17 | GPU driver validation example | **Kept as the worked example** throughout |
| 18 | Sandbox governance | **Imported** → "Governance", plus five Risks rows |
| 19 | Evidence model | **Imported** → #42, the confidence ladder |
| 20 | Technical assertions | **Imported** → the assertion schema, verbatim; `assertion` type in #38 |
| 21 | Evidence store | **Imported** → "Evidence"; `evidence` type in #38 |
| 22 | Decision register | **Imported** → "The decision register" |
| 23 | Distinguishing information types | **Imported** → "Information types that must never blend" |
| 24 | Question backlog | **Imported** → "Open questions are tracked objects"; `question` type in #38 |
| 25 | Phase exit criteria | **Merged** into the stage emission table |
| 26 | Documentation lifecycle | **Already covered** by #16 and the traceability chain. Its propagation problem — "requirement changes → architecture affected → runbook potentially invalid" — is our cascade, **resolved by #60–#64** |
| 27 | Raw conversation logging | **Partly imported** → Adaptive intake ("conversation is evidence, state is the interpretation"). Full layered store not needed at this scope |
| 28 | Runbook philosophy | **Imported** → "The runbook" |
| 29 | Human-in-the-loop production execution | **Split** — producing the runbook is in; everything after handover is **Rejected** under #24 |
| 30 | Automatic runbook monitoring | **Rejected** (#24) |
| 31 | Runbook step states | **Imported as schema only** — explicitly not as live state. See the ⚠️ in "The runbook" |
| 32 | Failure and remediation logging | **Split** — validation failures are captured as evidence; production failures are **Rejected** |
| 33 | Lessons learned | **Rejected** (#24) |
| 34, 35 | Organizational knowledge, knowledge promotion | **Rejected** (#24) |
| 36 | MVP scope | **Superseded** by #23/#24 — narrower on execution, same on research/validation |
| 37 | Explicitly deferred capabilities | **Merged** into Rejected and Parking lot |
| 38 | Recommended MVP workflow (9 stages) | **Superseded** — our 9 stages hold; stages 7–9 of theirs (Implementation / Feedback / Closeout) are out |
| 39 | Event-driven workflow model | **Parking lot** |
| 40 | Canonical state domains | **Merged** into #38's catalogue |
| 41 | Canonical source of truth — "unresolved" | **Resolved here** — principle 2 + #13 + #19. Data canonical, documents rendered |
| 42 | Documentation vs machine state | **Already covered** by principle 2 |
| 43 | Workaround for the limited work environment | **Context only** — it's the motivation for #23, and #23 is the actual fix |
| 44 | Cross-boundary research packages | **Parking lot** |
| 45 | Key risks | **Imported** → "Risks", filtered to what's in scope |
| 46 | Critical framing challenge | **Already covered** — "the final document is a projection of state" is principle 2 by another route |
| 47 | Thin vertical slice | **Adapted** — our thin slice is stage 5 plus the walking skeleton (#54, #55), not the CUDA scenario. The CUDA example stays as the validation worked example |
| 48 | Ten most important MVP decisions | **All ten closed** — 1→#13/#19, 2→#26, 3→#26, 4→#38, 5→#42, 6→decision register, 7→question backlog, 8→stage table, 9→**#56**, 10→#26 forbidden actions + #56's tier ceiling |
| 49 | Suggested repository structure | **Superseded** by #20's three-way split, which it doesn't have |
| 50 | Example end-to-end lifecycle | **Merged** into the pipeline diagram, truncated at #24 |
| 51, 52 | Architectural direction, near-term focus | **Merged** into #26 and the build order |

**From the transcripts, beyond what the vision doc carried forward:**

| Source | Item | Disposition |
|---|---|---|
| T1 §9 | The concrete AWS sandbox policy block | **Imported** verbatim as the governance example |
| T1 §14 | Mode A / Mode B execution split | **Imported** → the note under "Where the line actually falls" |
| T1 §16 | Cross-boundary research package | **Parking lot** |
| T1 §19 | Generalized sandboxing beyond infrastructure | **Parking lot**, with a note to keep the interface open to it |
| T1 §20 | The three foundational capabilities | **Merged** into #23 |
| T1 §25 | Sandbox autonomy risk register | **Imported** → Risks |
| T1 §26 | "Discovery in disposable environments, execution from validated instructions" | **Imported** as the framing line for #23 |
| T1 §28 | Reprioritized 12-item roadmap | **Adapted** — items 1–8 are in scope; 9–12 are out under #24 |
| T2 §3 | The Pi harness proposal | **Already decided** — #9, verified in "Pi integration" and **re-verified against the multi-agent design 2026-08-14** (#28 rewritten, #65/#66 added) |
| T2 §6 | The rejected-directory-structure example | **Imported** → Adaptive intake, worked example |
| T2 §11 | Five-way storage separation | **Partly covered** by #4 and #20; full separation not needed at this scope |
| T2 §16 | Runbook step states + ✓/✗ rendering | **Imported as schema only** (see §31 above) |
| T2 §17 | Failure/remediation record schema | **Split** — validation half in, production half out |
| T2 §26 | Six capability layers | **Layers 1–4 in scope; 5–6 out** under #24 |
