# Stage 8 — Implementation Plan

> **Run 2026-08-22.** `decidedBy: Planning agent`. Run to find out whether real remaining work
> produces demand for `task`, `role-assignment` and role slices — **or only for some of them.**
> It produced demand for one of the three, and the split is the finding.

---

## 1. The remaining work, as it actually is

| | Work | Traces to | Size |
|---|---|---|---|
| W-1 | Build `acceptance-criterion` (schema, typed tool, activation) — **if approved** | REQ-0007, REQ-0008 | ~half a day, same shape as `component` |
| W-2 | Role slices in the handoff package | REQ-0010, REQ-0011 | blocked on W-3 |
| W-3 | Build `task` (schema, typed tool, activation) — **if approved** | REQ-0010 | ~half a day |
| W-4 | The product shell in Next.js when product UI work begins (`DEC-0001`) | REQ-0011 | not sized; not in scope until UI work starts |
| W-5 | `AST-0010`'s experiment | — | **deferred with a trigger** (#137); not work today |
| W-6 | `QST-0002`'s resolution | — | **waits for a same-configuration source conflict**; not work today |

⚠️ **Three of six are not work today**, and saying so is the point of running this stage rather than
listing everything imaginable. W-4, W-5 and W-6 all carry explicit triggers, and a plan that scheduled
them would be scheduling conditions rather than tasks.

## 2. ✅ Demand for `task` — #41 passes

| #41's test | `task` |
|---|---|
| **Irreducible state** | A unit of work, its size, its dependencies on other work, and its state. Not derivable: a requirement says what must be true, a component says what implements it, an acceptance criterion says how you would know — **none of them says what someone should do next, or whether it is done.** |
| **Consumers** | **#19's role slices are a query over the task graph** — no tasks, no slices. **Stage 9's `role-slice-self-sufficient` criterion** cannot be evaluated without them. **The stage-9 orphan check** flags *"a task nothing traces to"*. And **#60's cascade** runs `requirement → component → acceptance-criterion → task`. |

**The table in §1 is exactly the prose that a `task` type would replace**, and it has the same defect
stage 5's §1 had: it cannot be traversed, so `tasks-trace-to-requirement` is evaluable only by reading.

## 3. ❌ `role-assignment` — #41 FAILS, and #18 is why

**This is the split.** `task` passes and `role-assignment` does not, for a reason that is already
decided rather than newly argued:

> **#18:** *Roles are discovered from stage-8 task assignments. Assignment is by role, never by name.*
> **No roster to maintain.**

⚠️ **If there is no roster, `role-assignment` owns nothing.** The assignment is a **property of a
task** — one string, `role` — and the set of roles on a project is **derived by collecting them**,
exactly as membership in a runbook is derived by reversing `partOf` (#84, and #111's argument against
`runbook` in the same shape). A `role-assignment` artifact would hold a value already on the task plus
an identity nothing needs.

⚠️ **And it would create a second place where the same fact lives**, which #138 fixed for tool
signatures and #141 refused for runbook aggregates. **Three refusals of the same shape now**: don't
store what a traversal derives.

✅ **What survives from #19 intact:** *a slice is a query, not a document someone maintains.* That was
never in doubt — the question was only whether the query needs its own artifact type to run over, and
the answer is that it runs over `task.role`.

## 4. What the run says about the catalogue

Three stage runs have now judged types by demand rather than by list:

| Stage | Declared | Demanded |
|---|---|---|
| 3 | `research-finding` | **none** (#136) |
| 5 | `schema`, `api-spec`, `wireframe` | **`component`**, which was not declared anywhere (#139) |
| 6 | `risk` | **none** — one consumer, and it was the criterion demanding it |
| 7 | `acceptance-criterion` | ✅ **`acceptance-criterion`** — declared AND demanded, the first time those agree |
| 8 | `task` | ✅ **`task`**, and **not** `role-assignment` |

⚠️ **The pattern is not "the catalogue is wrong."** It is that **`produces[]` describes a project
type** (#140), and this project — a local planning system with no UI, no API and no deployment — needs
a different subset than the table's author imagined. **Four types have now been judged unnecessary
here and none has been removed from the catalogue**, which is the correct outcome under #107.

---

## Exit criteria

| Criterion | Attestation | Why |
|---|---|---|
| **tasks-trace-to-requirement** | ✅ `satisfied` | Every row in §1 traces to a requirement or is explicitly not-work-today with a trigger. ⚠️ Basis is prose — the same limit stage 5 had before `component` existed, and it is what §2's demand is about. |
| **tasks-developer-sized** | ⚠️ `n/a` | **Three of six rows are not tasks** (triggered conditions), and the three that are cannot be sized as developer work until the types they depend on are approved. `n/a` with a reason rather than a guess: #45's shape, and #93's point that a PM who looked and said "does not apply" is different from nobody looking. |
