# Stage 7 — Acceptance Criteria

> **Run 2026-08-22.** `decidedBy: User`. Run against `CMP-0011`, because it is the only component
> whose acceptance bar was written **before** the code — every other component was described after it
> existed, and criteria written after the fact describe what was built rather than what was required.

---

## 1. The criteria, and whether each is objective

The PM's acceptance bar for the handoff command is already a set of acceptance criteria. Testing them
against this stage's own exit criterion — *pass/fail without judgment calls* — is the first honest
check available.

| | Criterion | Objective? | Evaluated |
|---|---|---|---|
| AC-1 | Every provision or execution path reaches a recorded destroy attempt… *(here: every refusal path writes nothing)* | ✅ | pass |
| AC-2 | Re-evaluate completeness immediately before snapshotting; never trust an earlier gate result | ✅ **structurally** — there is no parameter through which readiness can be asserted | pass |
| AC-3 | Gate evaluation and canonical input snapshot under the same content lock | ✅ — testable by holding the lock and observing the wait | pass |
| AC-4 | A refusal or rendering failure writes nothing and preserves the previous package | ✅ — byte comparison | pass |
| AC-5 | Render into a temporary package, validate it, then replace `docs/plan/` atomically | ✅ | pass |
| AC-6 | Two runs from identical input and version produce byte-identical output | ✅ — the strongest of the eight | pass |
| AC-7 | Removed source material cannot survive as stale generated files | ✅ | pass |
| AC-8 | Generate only the approved surfaces and activated content | ✅ — enumerable | pass |
| AC-9 | Include the snapshot identity **without introducing authored state** into the package | ⚠️ **partly** — see below | pass, by a proxy |

⚠️ **AC-9 is the one that is not fully objective, and it is worth being precise about why.** *"Include
a snapshot identity"* is pass/fail. *"Without introducing authored state"* is a **judgment about
provenance**: no test can look at a string and tell whether a human wrote it. What is testable are
**proxies** — the package contains no wall-clock timestamp, and every file is reproduced byte-identically
from the same input, which together mean nothing in it could have come from outside the content. **The
proxies are strong, and they are still proxies.**

**So: eight of nine are objective, and the ninth is objective in its testable half.** Recorded rather
than rounded up, because *"criteria are objective"* attested over a criterion that is partly a
judgment call is the sort of small dishonesty that makes a gate stop meaning anything.

## 2. What this says about `QST-0015` — planned versus built

`QST-0015` asked whether `component` needs a planned/built axis, since `CMP-0011` took the orphan
count to zero while nothing was built. **Running stage 7 answers it, and the answer is no — because
the question turns out to be three questions with three existing homes:**

| Question | Where it already lives |
|---|---|
| *Does code exist for this component?* | `implementedBy` — empty means no, populated means yes |
| *Does it do what was required?* | **Acceptance criteria**, evaluated |
| *Does the plan claim it is finished?* | The **stage attestation**, which is where a human says so |

⚠️ **A `state: planned \| built` field would sit between two things that already have homes and answer
neither well.** It says nothing about whether the thing works, and — the decisive objection — **it is
stored state that would go stale.** Someone sets it to `built`, the code rots or is deleted, and the
field still says `built`. That is exactly the failure #96 exists to prevent: **`built` is DERIVABLE**
from `implementedBy` plus the evaluation of criteria, and a derived value that gets stored is a value
that can lie.

✅ **The hazard `QST-0015` named is real and is answered differently than by a field:** the orphan
count going to zero is not misleading *as long as something else says what "satisfied" means*. Today
that is the attestation. **When acceptance criteria exist as artifacts it becomes mechanical.**

## 3. ✅ Demand for `acceptance-criterion` — #41 applied

This is the second type a real stage run has demanded, and unlike `risk` it has **consumers that were
decided before the type was proposed**:

| #41's test | `acceptance-criterion` |
|---|---|
| **Irreducible state** | A pass/fail condition attached to a requirement or component, and whether it has been evaluated. Not derivable: a requirement says what must be true, a component says what implements it, and **neither says how you would know it worked.** |
| **Consumers** | **#60's cascade — its worked example is literally `acceptance-criterion → component`.** #19's role slices pull *"the traced requirements and acceptance criteria along with each task"*. Stage 7's own exit criterion. And **`QST-0015`'s mechanical answer**, per §2. |

⚠️ **Not built here.** Adding a type is a catalogue act (#40) and stage 7 is `decidedBy: User`. The
argument is recorded; the decision is the PM's, exactly as `component`'s was.

⚠️ **And note what would change if it were built:** the criteria in §1 stop being a table in a
document and become artifacts the stage-9 role slice can carry — which is the same movement stage 5
made when the trace stopped being prose.

---

## 4. ⚠️ Carried forward for the application shell — `REQ-0021`, and a criterion that cannot be behavioural

**Not a run of this stage.** Stage 7 has run once, against `CMP-0011`. The application shell has no
components yet, so it cannot run here — this section exists so the constraint arrives *before* the
criteria are written rather than as a correction afterwards.

**`AST-0022` removes an option this stage would otherwise reach for first.** The natural acceptance
criterion for `DEC-0019` is *"change a file, request the page, see the new value"* — objective,
pass/fail, exactly the shape §1 rewards. **It is also a criterion that passes on a codebase that
breaks the contract.** A read that omits `connection()` is served fresh whenever a compliant read
shares its route; the two are observationally identical until the compliant sibling is moved, cached
or deleted, and then every read on that route silently reverts to build-time content.

⚠️ **This is the AC-9 problem inverted, and the inversion is the point.** AC-9 was a criterion whose
*objectivity* was partly a judgment call, and §1 handled it by naming strong proxies and saying they
were proxies. Here the criterion is **perfectly objective and measures the wrong thing.** Being
pass/fail is not the same as being evidence, and a stage whose exit criterion asks only for the first
will happily certify the second. **Objective, mechanical, and blind is the worst of the three
combinations**, because nothing in the attestation looks wrong.

**So `REQ-0021` requires static enforcement**, and acceptance for `REQ-0016`–`REQ-0018` may not rest
on freshness behaviour alone. Two obligations, and the second is the one that gets dropped:

| | What must be checked | Why behaviour cannot check it |
|---|---|---|
| 1 | No planning-content read outside the approved `connection()`-backed abstraction | A stray read is fresh by proximity; the page looks correct |
| 2 | Every read site is enclosed by a `<Suspense>` boundary | An abstraction supplies `connection()`; a caller can still omit the boundary. That builds fine **without** Cache Components and **fails the build with it** — so the omission surfaces as a config change breaking the build, not as the contract violation it is |

⚠️ **The mechanism is stage 5's to choose**, not this stage's: a lint rule, a module-boundary
constraint, a generated single accessor, or a build step that greps for content-root paths would each
satisfy it. What is fixed is the property — **checkable without executing the application**. ⚠️ And it
must not settle Cache Components: `DEC-0019` was chosen so the contract holds with that flag either
way, and an enforcement design that only works under one setting would spend that property.

⚠️ **It also constrains `QST-0018`.** If a stage document may reference components, the permitted-component
set is another surface a direct read could enter through, and static confinement has to cover it.
That is a condition `QST-0018`'s answer must satisfy — **not a decision about what that answer is.**

---

## Exit criteria

| Criterion | Attestation |
|---|---|
| **criteria-objective** | ✅ `satisfied` — eight of nine are pass/fail outright; AC-9's testable half is objective and its judgment half is named rather than hidden. ⚠️ Basis is prose: the criteria are a table here, not artifacts, pending the PM's decision on `acceptance-criterion`. |

⚠️ **This attestation covers the 2026-08-22 run against `CMP-0011` and nothing else.** §4 is a
constraint recorded ahead of a run that has not happened; the application shell reaches this stage
only after stage 5 produces its components. **Nothing in §4 is attested.**
