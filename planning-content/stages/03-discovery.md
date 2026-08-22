# Stage 3 — Discovery / Research

> ## ⚠️ RECONSTRUCTED, and NOT gate-complete.
>
> **Written 2026-08-22 about work done 2026-08-17 and 2026-08-18.** It is a **provenance record, not a
> stage run**: nothing here was produced by executing the stage, and no exit criterion is attested on
> the strength of it. `03-discovery`'s gate remains **`ready: false`** with `unknowns-resolved` and
> `sources-reconciled` both pending, which is correct and is not something this document may change.
>
> **Why it exists.** Stage 3 genuinely ran twice — experimentally for `QST-0001`, and through source
> research for the Next.js question — and until now that work was visible **only by traversing
> questions, assertions and evidence** and reading later notes. The artifacts were the record; there
> was no narrative. This is the narrative, and it claims nothing the artifacts do not already hold.

---

## The two runs

| | Question | Method | Settled by |
|---|---|---|---|
| **A** | `QST-0001` — why did the concurrency test fail once under full-suite parallel load? | **Experiment**, a fixed matrix bounded before it started | `AST-0004`, `AST-0005` |
| **B** | `QST-0004` — can a Next.js dev app reflect externally written files and do lock-protected write-backs? | **Source research, then a live probe matrix** | `AST-0006`…`AST-0012`, `DEC-0001` |

Both are answered. Neither used a `research-finding` artifact, and that is the finding this document
most wants to preserve.

## Run A — experimental discovery (`QST-0001`)

**Evidence produced:** `EVD-0003` (the unexplained failure), `EVD-0004` (recurrence reproduced and
classified), `EVD-0005` (post-fix matrix, 80 runs, no recurrence).

**Assertions:** `AST-0004` — *Windows surfaces exclusive-create contention as `EPERM`, not only
`EEXIST`* — and `AST-0005` — *with contention codes retried, concurrent creates complete without
error*. `AST-0003` remains **refuted** by `EVD-0003`, and that is deliberate: the claim was
*"the concurrency test passes on every completed full-suite run"*, and one failure falsifies it.

⚠️ **The scope discipline that came out of this run is the durable part.** Run 19 proved the
**reproduced** failure was `EPERM`; it did not prove the **original** uninstrumented failure
necessarily was. That distinction is recorded in the artifacts and must not be smoothed over here —
later understanding does not retroactively enrich what an earlier observation recorded.

## Run B — source research, then probing (`QST-0004`)

**Source evidence:** `EVD-0006`, `EVD-0007`, `EVD-0008` — Next.js documentation on the Cache
Components model, the previous caching model, and `revalidatePath` being server-triggered.

**Experimental evidence:** `EVD-0010`…`EVD-0015` — one record per probe cell, plus `EVD-0009`, which
is a matrix **summary** and is marked as not attachable to any single-cell claim.

**Assertions:** `AST-0006` through `AST-0012`, and `DEC-0001` (adopt Next.js when product UI work
begins, not as cleanup).

### The apparent source contradiction, and how it was resolved

The documentation appeared to say two incompatible things about a filesystem read under Cache
Components: that it **freezes into the static shell**, and that it is **treated as uncached data**.

⚠️ **It was resolved by ENVIRONMENT SCOPING, not by choosing a side.** Both statements are true of
different configurations, and once each claim was scoped to the configuration it was actually about,
the contradiction disappeared:

- `AST-0007` — a **synchronous** read freezes into the static shell. Derived verdict: **`contested`**
  — supported by the docs, refuted by `EVD-0012` in `next dev`.
- `AST-0009` — an **awaited** read is treated as uncached data. `supported` / `environment-matched`.
- `AST-0011` — in **`next dev`** with Cache Components, a synchronous read does **not** freeze.
  `supported` / `environment-matched`.
- `AST-0010` — in a **production build**, it does. `supported` / **`source-supported` only** — the
  experiment was never run, and the assertion says so.

⚠️ **`AST-0007` is still `contested`, and leaving it that way is the honest outcome.** It is contested
**because it is under-scoped** — it says "with Cache Components" without saying *dev or build*, so its
own evidence disagrees with it. The resolution was not to repair `AST-0007` but to **write the two
scoped claims beside it**, `AST-0010` and `AST-0011`, which are each settleable. That is #112 in the
record rather than in a note: a `contested` verdict on an under-scoped claim is information about the
claim, not a conflict in the world.

**Two of those claims are held apart by nothing but their environment scope**, which is exactly what
the applicability filter was built to do. A single unscoped claim would have been contested by its own
evidence and would have read as a defect in the docs rather than a difference between dev and build.

⚠️ **`AST-0010` is still owed an experiment.** It rests on documentation alone. Recording that here
rather than letting it pass as settled is the point of a provenance document.

## What this says about `research-finding`

**No `research-finding` artifact was created, and none was needed.** The stage's declared output was
covered by types that already exist:

| Stage 3 declared output | What actually carried it |
|---|---|
| source inventory with citations | `evidence(kind: source)` + `evidence.sources` |
| hypotheses requiring validation | `assertion` at rung 1 (`unverified`) |
| findings doc / feasibility notes / prior art | prose — this document, and `notes.md` |
| contradictory sources resolved or surfaced | **environment scoping across `AST-0007` / `AST-0009` / `AST-0011`** |

⚠️ **`QST-0002` stays unresolved, on purpose.** The last row is the one that could have justified the
type, and it did **not**: this contradiction was **apparent**, and scoping dissolved it. What would
bear on `QST-0002` is a **genuinely irreconcilable conflict between sources describing the SAME
configuration** — where scoping cannot help and something must hold the unresolved disagreement.
**That has not been encountered.**

⚠️ **No `research-finding` was manufactured to satisfy the stage definition.** The definition lists it
under `produces[]`, so the gate reports `gate/type-not-implemented`, and **that finding is accurate and
should stand**. Creating an artifact to silence a gate would invert #106 — the gate reports what the
project activated, and says nothing about whether the type should exist. **A stage definition is
authoritative (#90), not correct (#91).**

---

## Exit criteria — deliberately NOT attested

`stages/03-discovery.json` declares two, both `mechanised: false`:

| Criterion | Why it is not attested here |
|---|---|
| **unknowns-resolved** — all flagged unknowns answered, promoted, or raised as a validation task | `AST-0010` is documentation-supported with **no experiment**, and it is a flagged unknown that is neither answered nor raised as a validation task. |
| **sources-reconciled** — contradictory sources resolved or surfaced | The Next.js contradiction **was** resolved by scoping. But this document is reconstructed, and **a criterion attested from a reconstruction is attested from a document rather than from a run.** |

⚠️ **Attesting either would make this document do the one thing it says it is not doing.** #93 gives
`satisfied` / `not-satisfied` / `n/a` to a PM who has **looked**; a retrospective narrative is not a
substitute for looking, and a gate that turned green because someone wrote a summary would be the
clearest possible example of the failure this whole project exists to prevent.
