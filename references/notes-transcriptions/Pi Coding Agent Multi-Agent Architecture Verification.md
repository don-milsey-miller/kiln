The **orchestrator + three-specialist roster survives**. Pi can support it without replacing Pi.

What does **not** survive unchanged is the mechanism currently described in `notes.md`: per-agent `AGENTS.md` plus forked sessions as the delegation/scoping mechanism. Your document currently treats those as the Pi mapping for #26/#28.

|Question|Verified answer|Effect on the design|
|---|---|---|
|Can one Pi agent delegate a bounded task to another?|**Yes, but not as a built-in Pi primitive.**|Keep #26; implement delegation as an extension/SDK layer.|
|Does each specialist get its own `AGENTS.md`?|**No, not natively.** `AGENTS.md` is cwd/project context.|Use specialist agent-definition files/system prompts instead.|
|Do forks implement the orchestrator → specialist model?|**Not cleanly.** Forking exists, but it is session branching/replacement, not the native sub-agent mechanism.|Rewrite #28; separate delegation from session lineage.|
|Canonical npm package?|**`@earendil-works/pi-coding-agent`**|Close this open question.|

### 1. Can one Pi agent hand a bounded task to another with its own instruction file?

**Yes. This is now well demonstrated by Pi itself.**

Pi still deliberately has **no built-in sub-agent feature** in core. Its own README says sub-agents are something you build with extensions or install as a package. But the SDK explicitly lists “build custom tools that spawn sub-agents” as a supported use case. ([pi.dev](https://pi.dev/docs/latest/sdk "SDK · Documentation · Pi"))

More importantly, the current Pi repository contains an **official example `subagent` extension** that is almost exactly your architecture. It registers a `subagent` tool callable by the parent model and supports:

- one bounded agent task;
    
- multiple specialist tasks in parallel;
    
- sequential specialist chains;
    
- a separate Pi process/context for each specialist;
    
- per-specialist model and tool configuration;
    
- a dedicated system prompt for each specialist. ([GitHub](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts "pi/packages/coding-agent/examples/extensions/subagent/index.ts at main · earendil-works/pi · GitHub"))
    

The specialist definitions look like this conceptually:

```md
---
name: research
description: Research authoritative sources and return findings
tools: read, grep, find, ls
model: ...
---

You are the research specialist.
...
```

Pi's example discovers these from `~/.pi/agent/agents/*.md` or project-local `.pi/agents/*.md`. The Markdown body becomes that specialist's system-prompt material. ([GitHub](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md "pi/packages/coding-agent/examples/extensions/subagent/README.md at main · earendil-works/pi · GitHub"))

So the answer to the load-bearing question is:

**Pi can implement #26. You do not have to collapse back to one agent.**

There is also stronger enforcement available than your document assumes. The specialist's `tools:` frontmatter is passed through Pi's `--tools` allowlist, and current Pi applies that allowlist to built-in, extension, and custom tools. That means “research may read/search but may not write/provision” can be an actual tool boundary, not merely prose in its contract. ([GitHub](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts "pi/packages/coding-agent/examples/extensions/subagent/index.ts at main · earendil-works/pi · GitHub"))

---

### 2. Does per-agent `AGENTS.md` load cleanly per session?

**No. This part of the current design should change.**

Native `AGENTS.md` discovery is based on the session's **working directory hierarchy**, not agent identity. Pi loads the global file plus matching `AGENTS.md`/`CLAUDE.md` files walking from parent directories through the cwd. All sessions using the same cwd therefore normally see the same project context stack. ([Pi](https://pi.dev/docs/latest/usage "Using Pi · Documentation · Pi"))

Also, `AGENTS.md` is **not a Pi Package resource type**. Pi Packages formally package extensions, skills, prompts, and themes; there is no `agents`/`AGENTS.md` entry in the package manifest. ([Pi](https://pi.dev/docs/latest/packages "Pi Packages · Documentation · Pi"))

The official subagent example solves this differently: `.pi/agents/research.md`, `.pi/agents/validation.md`, etc. are read by the **extension**, and their bodies are passed to each child as an appended system prompt. ([GitHub](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md "pi/packages/coding-agent/examples/extensions/subagent/README.md at main · earendil-works/pi · GitHub"))

I would therefore change the conceptual division to:

```text
AGENTS.md
  └─ shared project-wide invariants only

specialist definitions
  ├─ research.md
  ├─ validation.md
  └─ planning.md
       └─ role contract + tool/model policy + role-specific instructions
```

One subtlety matters: Pi's example launches the child without `--no-context-files`, so **normal project `AGENTS.md` discovery still applies in addition to the specialist prompt**. That is useful if `AGENTS.md` contains only shared invariants, but dangerous if it contains orchestrator-specific behavior. This follows from the child invocation in the example plus Pi's normal context-file behavior. ([GitHub](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts "pi/packages/coding-agent/examples/extensions/subagent/index.ts at main · earendil-works/pi · GitHub"))

If you need harder separation, Pi supports `--no-context-files`, or the SDK lets you construct a `ResourceLoader` with different system/context material for every child session. ([Pi](https://pi.dev/docs/latest/usage "Using Pi · Documentation · Pi"))

So I would **remove “Per-agent `AGENTS.md`” from the agent-roster mapping**.

---

### 3. How do forked sessions behave under an orchestrator?

This is where the current document needs the largest correction.

Pi absolutely supports session forking. Sessions are persisted as JSONL trees, forks can have a `parentSession`, and `SessionManager` exposes `forkFrom()` and branched-session operations. ([GitHub](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md "pi/packages/coding-agent/docs/session-format.md at main · earendil-works/pi · GitHub"))

But `AgentSessionRuntime.fork()` means **replace the runtime's active session with the fork**. Pi explicitly warns that `runtime.session` changes and subscriptions/extensions must be rebound after the replacement. It is a session-navigation primitive, not “spawn another live agent while the orchestrator remains where it is.” ([Pi](https://pi.dev/docs/latest/sdk "SDK · Documentation · Pi"))

And Pi's own subagent implementation does **not fork at all**. For every delegated task it launches:

```text
pi --mode json -p --no-session ...
```

as a separate process. Each child therefore receives an isolated context and disappears when the bounded task completes. ([GitHub](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts "pi/packages/coding-agent/examples/extensions/subagent/index.ts at main · earendil-works/pi · GitHub"))

That means this sentence in your current architecture is too strong:

> “Per-stage sessions forked from a shared project-context session … This is also the mechanism #26 runs on.”

Your file currently makes #28 responsible both for historical session organization and for #27's context isolation. Those are actually **two separate concerns**.

There is also a conceptual problem: **forking and scoped context pull in opposite directions.** A fork inherits the source branch's conversation context. #27 says specialists should receive _only_ what their task needs. Fresh child sessions with an explicit bounded payload satisfy #27 more naturally than forks do.

I would change #28 to something closer to:

> **The orchestrator owns the persistent user-facing project session. Specialist work runs in isolated child Pi processes/sessions with explicit task-scoped context and role-specific instructions. Stage sessions may be persisted separately where their conversation history is useful, but session forking is a lineage/review mechanism, not the mechanism used to enforce specialist context scope.**

That also fits #29 better: your documents remain canonical state; specialist transcripts can be disposable unless there is a specific audit reason to persist them. Your existing principle already says losing a Pi session must never lose a project decision.

If later you decide each stage genuinely needs a persistent transcript, Pi has enough primitives to do that. You can create or fork independent `SessionManager`s and give each its own `AgentSession`; just don't use a single `AgentSessionRuntime.fork()` call as if it created a concurrent worker. ([Pi](https://pi.dev/docs/latest/sdk "SDK · Documentation · Pi"))

---

### 4. Which npm package is canonical?

Resolved:

**`@earendil-works/pi-coding-agent`**

Current Pi documentation installs exactly that package:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

and the SDK imports from it. ([Pi](https://pi.dev/docs/latest/quickstart "Quickstart · Documentation · Pi"))

The old **`@mariozechner/pi-coding-agent` is explicitly deprecated on npm**, with the publisher message directing users to `@earendil-works/pi-coding-agent`. ([npm](https://www.npmjs.com/package/%40mariozechner/pi-coding-agent?utm_source=chatgpt.com "mariozechner/pi-coding-agent"))

The canonical repository is now `earendil-works/pi`; old `badlogic/pi-mono` GitHub URLs redirect there. ([GitHub](https://github.com/earendil-works/pi?utm_source=chatgpt.com "earendil-works/pi: AI agent toolkit: unified LLM API ..."))

So the warning at the end of your Pi section can be removed.

## Two additional Pi issues the verification exposed

First, **#32 needs `-l`**. `pi install` defaults to user/global settings. Project-scoped installation uses `-l` and writes `.pi/settings.json`. For your clone-per-project model, the setup flow should therefore be something like:

```bash
pi install -l ./.planning/pi-package
```

rather than an unqualified `pi install ...`. Pi supports local-path packages, and local paths are referenced directly rather than copied. ([Pi](https://pi.dev/docs/latest/packages "Pi Packages · Documentation · Pi"))

Second, **specialist definitions will not automatically ride inside a Pi Package**. Package discovery knows extensions, skills, prompts, and themes, while the subagent example independently searches `.pi/agents/*.md`. ([Pi](https://pi.dev/docs/latest/packages "Pi Packages · Documentation · Pi")) You therefore need one small adaptation: either have setup materialize the three role definitions into `.pi/agents/`, or modify your shipped delegation extension so it discovers bundled role definitions from `.planning/pi-package/agents/`. I prefer the latter: the roster is tool configuration, so it should remain in the tool package rather than being copied into each project's state.

There is one more spike worth doing before considering Pi fully closed: verify that a **non-interactive specialist subprocess loads your project-local package and typed tools under Pi's project-trust rules**. Non-interactive modes do not prompt for trust; they use the saved/default trust decision instead. Since your specialist contracts rely heavily on typed tools, that behavior matters more than session forking does. ([Pi](https://pi.dev/docs/latest/usage "Using Pi · Documentation · Pi"))

**Net result:** #26 stays. The roster does **not** need to collapse. #28 should be rewritten, “per-agent `AGENTS.md`” should be replaced by specialist definitions/injected prompts, the npm question is closed, and #32 needs a project-local-install correction. The official subagent extension substantially lowers the amount of new Pi architecture you actually have to invent.