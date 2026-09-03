# Pi compatibility spike — `@earendil-works/pi-coding-agent` 0.84.4

The runnable evidence behind section 21 of
[`docs/agent-delivery-technical-proposal.md`](../../docs/agent-delivery-technical-proposal.md), and
behind `EVD-0077`–`EVD-0086` and `AST-0041`–`AST-0053` in the planning graph. `CMP-0041` is the
component and `TSK-0018`–`TSK-0023` are its tasks, all complete and accepted.

## Two tiers

| | What it asserts | When it runs |
| --- | --- | --- |
| **Retained results** — [`test/pi-compat.test.mjs`](../../test/pi-compat.test.mjs) | That the evidence in [`runs/`](runs/) is complete and honest: both platforms present, every claim paired with its control, nothing machine-identifying surviving redaction — and that the pin in `package.json` still matches the pin the evidence was taken under | Every `npm test` |
| **Live re-proof** — `runSpike()` | That the pinned runtime *still behaves this way*, measured against a real consumer install | `KILN_PI_COMPAT=live`, and one CI matrix cell |

The first tier is not a weaker version of the second. "Is our evidence complete" and "does Pi still
do this" are different questions, and without the first the second can pass while the record it
rests on has quietly rotted.

⚠️ **A pinned-version bump fails the default tier.** The test compares `package.json`'s pin against
the pin recorded in each result file and refuses a mismatch, naming the command to re-run. That is
the mechanism that makes an upgrade re-prove the contract instead of inheriting it — which is the
whole of `TSK-0023`.

## What it establishes

Every claim has a control that would have failed if the claimed behaviour were absent. Two rules
apply throughout, both learned here the hard way:

1. **Take the mechanical observable upstream of the model.** The marker is written when the
   extension module loads — before `session_start`, long before inference.
2. **Negative evidence requires proof the observation point was reached.** An absent marker means
   nothing if the process died first, so every run records `reachedObservationPoint` and the test
   refuses a row that did not.

| Question | Answer | The control that makes it a finding |
| --- | --- | --- |
| `QST-0026` Is there a public trust API? | Yes — `ProjectTrustStore`, and it is causal | `set(false)` and `set(null)` both revert; `--approve` shows the same extension loading |
| `QST-0027` Can session state move outside the project? | Yes, three routes | Each checked against the directory the transcript did *not* go to |
| `QST-0028` What does `pi install -l` write? | A relative entry; separators differ by platform | Both platforms; the test asserts the two differ by *only* the separator |
| `QST-0029` What must a child inherit? | `PI_CODING_AGENT_DIR` alone on POSIX; Windows adds nine names regardless | Sentinels absent from the child, present in the inherited-env control |
| `QST-0030` How is a task bound with stdin closed? | The `-p` argument, seen at the provider | Read from the provider's received request, never from the model's reply |
| `QST-0031` Do the 0.80.6 findings hold? | Four hold, one not re-tested | Each re-measured rather than assumed |
| `QST-0033` Is OAuth discovery provable? | **Decided, not open.** api_key is proved here; OAuth is verified only by a manual account-bound run (`DEC-0032`) | A fabricated OAuth record validates a storage shape, not usable authentication — so this suite deliberately does not attempt it |

### What this suite does NOT establish

Named here because a component that lists work it has not done is the failure this whole cycle exists
to undo. ⚠️ **None of these belongs to `CMP-0041` any more.** Narrowing the component's text was not
enough while the graph still had these tasks implementing it, so each was retargeted to the component
it actually verifies — and each has an acceptance criterion there:

| Not proved | Why | Now owned by |
| --- | --- | --- |
| Pi's authentication-only TUI, and what it does with no TTY | Needs a real terminal, so it is a manually invoked check rather than a suite cell | `TSK-0065` → `CMP-0027` |
| OAuth for a built-in provider | Verified only by a real `/login` plus a revocation control; a fabricated credential would prove a storage shape and nothing else (`DEC-0032`) | `TSK-0066` → `CMP-0027`, manual and outside CI |
| The Kiln capability signature | It belongs to a package that does not exist yet | `TSK-0067` → `CMP-0031` |

⚠️ **Kiln's own no-TTY refusal is a fourth thing, and it is not here either.** It was split out of the
TUI task on 2026-09-03: the criterion demanded a stated Kiln recovery route, which cannot be observed
before the setup command exists. It is now `TSK-0068` against `CMP-0039`, downstream of both setup and
the Pi observation above. A criterion that cannot be evaluated when its task completes is a
promissory note, not a criterion.

## Isolation — and why `PI_CODING_AGENT_DIR` is not enough

⚠️ **The first version of this spike inherited the whole host environment.** `PI_CODING_AGENT_DIR`
isolates the *stored* auth file and does nothing whatever about *environment* authentication, so on
a machine carrying `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` a reproduction could have reached a paid
provider. Two defences now, and both are load-bearing:

- The child environment is built from an **allowlist** of OS and runtime names
  ([`lib/consumer.mjs`](lib/consumer.mjs)) — never a denylist, because a denylist misses every
  provider variable nobody thought of.
- **Every run that can reach inference passes an explicit `--model`** naming a loopback fake.

Nothing here contacts a network except the consumer's own `npm install`. `ModelRuntime.create()` is
called with `allowModelNetwork: false`.

## The fixture is a real consumer

⚠️ **The first version was not.** It created a bare `.planning/pi-package` and then ran Pi out of
*this repository's* `node_modules`, so the one assertion the exercise exists to make — that a
consumer resolves the pinned runtime from its own `.planning/node_modules` — was never touched. It
also hard-coded one developer's scratch path.

[`lib/consumer.mjs`](lib/consumer.mjs) now generates a temporary directory, runs `git init` and
leaves the repository **unborn** with no commits, copies the tool from `git ls-files` so an
uncommitted local file cannot make a run pass, runs the consumer's own `npm install` inside
`.planning`, and resolves the CLI through the copied tool's installed `bin.pi`. The test asserts
both halves: the CLI is inside the consumer, **and** it is not inside the development checkout.

## Running it

```sh
node tools/pi-compat/run-all.mjs                  # build a consumer and prove everything
node tools/pi-compat/run-all.mjs --keep <dir>     # reuse a built consumer, skipping npm install
bash tools/pi-compat/posix-bootstrap.sh           # POSIX; fetches Node to /tmp only if needed
```

Results are written to [`runs/<platform>.json`](runs/), **redacted at write time** — the runner
refuses to save a file that still contains a home path or anything credential-shaped.

## Traps worth knowing before editing these

- **The tool handler is `execute(toolCallId, params, signal, onUpdate, ctx)`.** Reading the first
  argument as the parameters yields the call id, and the probe then reports a null challenge against
  a tool that was in fact called correctly.
- **`ctx.getSystemPromptOptions()` is command-context only.** Unavailable at `session_start`, so
  loaded-skill provenance needs `before_agent_start` — which needs a model turn.
- **A fake provider that re-issues a tool call whenever it sees the trigger text loops forever.**
  `fake-provider.mjs` answers once and returns prose after a tool result is in the conversation.
- **`npm` on Windows is `npm.cmd` and Node 20+ refuses to spawn it without `shell: true`.**
- **`getAll()` returns 1291 models** — the entire built-in catalogue. Present `getAvailable()`.
- **`--models` is a NAME FILTER, not a path.** Pointing it at a file yields `No models match pattern
  <path>` and exit 0, which is how the environment-auth cell first managed to fail in both
  directions and still look like a finding.
- **`spikeEnv({ exact })` must be forwarded by whatever wraps it.** The wrapper silently dropped it
  once, so a cell asking for a precise environment quietly got the default allowlist — HOME included
  — and the recorded result contradicted itself (`homeWasPassed: false` beside `HOME: true`).
  Recording both halves of a condition is what makes that catchable.
- **A `--keep` run captures no npm output**, so its record under-covers `ACC-0040`. The record now
  carries `meta.consumerWasReused` and the test refuses a reused one.
