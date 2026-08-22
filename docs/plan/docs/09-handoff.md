# Stage 9 — Developer Handoff

> **Run 2026-08-22**, against the package contract `npm run handoff` actually implements
> (`docs/handoff-contract.md`, `DEC-0009`/`DEC-0010`/`DEC-0011`).
>
> ⚠️ **One criterion is attested `not-satisfied`, so the handoff still refuses — and that is the
> correct answer rather than an obstacle.** This project is not deliverable to a recipient today, and
> the machinery says so for a reason that names what is missing.

---

## 1. The package, as the command produces it

Verified by running against a complete fixture; the real project refuses before rendering.

```
docs/plan/
├── README.md            generated — what this is, and the snapshot that produced it
├── MANIFEST.json        snapshot (content hash), tool version, activated types, counts
├── data/*.json          one file per ACTIVATED type — present-and-empty when there are none
├── docs/*.md            the stage narratives
└── PLAN.md              the single-file bundle
```

✅ **The empty-file distinction survives into the frozen package**, which is what makes it worth
having: **omitted means the type does not apply to this project; present-but-empty means it applies
and there are zero instances.** A renderer that emitted files only for types with artifacts collapsed
those into one silence, and did so until #142 caught it.

## 2. Exit criteria, evaluated

### ❌ `role-slice-self-sufficient` — not satisfied

*Each assigned team member can start their part without coming back to ask a question.*

**There are no role slices, so no assigned team member can start anything.** Slices are a query over
the task graph (#19), `task` is not built, and stage 8 recorded the demand for it without building it.

⚠️ **This is not a formality.** It is REQ-0010 — *a recipient must be able to begin without asking the
planner* — and it is the requirement whose only component, `CMP-0011`, was designed before it existed.
The command that implements it works; **what it produces is not yet something a person could be handed
a slice of.**

### ✅ `runbook-steps-above-threshold` — satisfied

*Every runbook step rests on an assertion at or above the threshold (#57).*

One step. `RBS-0001` rests on `AST-0002`, derived `supported` / `environment-matched` — **rung 4,
above every threshold in `project.yaml`** (informational 2, mutating 3, destructive 4). The step is
non-destructive, so its floor is lower still.

⚠️ **One step is not a test of the rule**, and the honest reading is that this criterion has been
*checked* rather than *exercised*. The enforcement that matters is `mayBecomeInstruction`, which is
tested against constructed refuted and contested claims.

### ✅ `no-unresolved-critical-questions` — satisfied

Two questions are open: `QST-0002` (does `research-finding` own anything irreducible) and `QST-0015`
(planned versus built).

⚠️ **"Critical" is undefined in the stage table** — the same defect stage 4 hit with "blocking", which
`DEC-0002` fixed. Applying that definition by analogy: **neither question makes a load-bearing
commitment's correctness depend on its answer, and neither makes a criterion unevaluable.** Both carry
explicit triggers.

⚠️ **Recorded as a second instance of the same drafting defect**, not fixed here: an exit criterion
that turns on an undefined word is unevaluable in either direction until someone defines it, and the
first instance took a decision to resolve.

## 3. What is actually missing for a real handoff

| | Missing | Held by |
|---|---|---|
| 1 | `task`, and therefore role slices | stage 8's demand, PM approval |
| 2 | `acceptance-criterion`, so a slice can carry how the recipient knows they are done | stage 7's demand, PM approval |
| 3 | Nothing else | — |

**Two approvals stand between this project and a publishable handoff**, and both are catalogue
decisions rather than engineering. Everything the contract itself requires — determinism, atomic
replacement, refusal safety, the completeness predicate — is built and proven.

---

## Exit criteria summary

| Criterion | Attestation |
|---|---|
| **role-slice-self-sufficient** | ❌ `not-satisfied` — no slices exist; `task` is unbuilt |
| **runbook-steps-above-threshold** | ✅ `satisfied` — one step, at rung 4 |
| **no-unresolved-critical-questions** | ✅ `satisfied` — neither open question is critical under `DEC-0002`'s definition, applied by analogy |

⚠️ **`npm run handoff` therefore still refuses, on one blocker instead of eleven.** The refusal now
names a missing capability rather than an unexamined project, which is the difference between *"nobody
looked"* and *"we looked, and it is not ready."*
