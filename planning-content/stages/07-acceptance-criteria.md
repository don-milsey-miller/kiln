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

## 5. ⚠️ Carried forward — `DEC-0020`'s four acceptance obligations

**Also not a run of this stage**, and recorded here for the same reason as §4: the constraint should
arrive before the criteria are written, not as a correction afterwards.

⚠️ **These are deliberately NOT `acceptance-criterion` artifacts yet, and the schema is what says so.**
`evaluates` is required with `minItems: 1` and targets `component` — *"a criterion that evaluates
nothing cannot be run"*. The application shell has no components until stage 5 produces them, so
authoring criteria now would mean either inventing a component to point at or weakening the field that
makes the cascade traversable. They become artifacts at roadmap step 3a; until then they are prose
with a named home.

| | Obligation | Why it is not obvious |
|---|---|---|
| 1 | **The compiler and plugin chain are pinned.** Changing the MDX version, or adding any remark / rehype / recma plugin, reopens security validation before the change ships. | The validated property belongs to a *chain*, not to a line of code. A later rehype or recma stage could reintroduce JavaScript after the remark plugin has already approved the document — and `EVD-0042` records that stage as **not tested**. This is a #80 condition: it fires when the change is **proposed**, not when a document is found to have escaped. |
| 2 | **Document-supplied JavaScript stays rejected**, with stripping underneath as defence in depth. | ⚠️ The criterion must check **the refusal**, not the absence of executed code. Stripping alone also produces no executed code, so a test that renders a document and finds no side effect passes identically on both — and the whole point of the amendment is that the two are not the same. |
| 3 | **Per-request compilation cost is measured**, not assumed acceptable. | It is unmeasured today (`EVD-0044` omission). The fallback if it is unaffordable is plain markdown for stage documents — already `DEC-0020`'s second recorded alternative, so it is a decision to *return to*, not one to invent under pressure. |
| 4 | **Runtime reading and compilation compose with `DEC-0019`.** The read that feeds the compiler awaits `connection()` inside a `<Suspense>` boundary. | Neither contract has been observed with the other. And `REQ-0021` covers this read exactly as it covers any other — the compiler's input is a planning-content read like any other planning-content read. |

⚠️ **Obligations 2 and 4 are the ones that can be written as criteria; 1 and 3 are not product
properties.** Pinning is a reopening condition and cost is an owed measurement. Recording all four
here rather than forcing them into one shape keeps the axes separate — the same reason `resolution`
was not folded into `reviewStatus`.

---

## 6. Run 2 — 2026-08-27: criteria for the application shell

`ACC-0013`–`ACC-0035`, twenty-three criteria across `CMP-0012`–`CMP-0020`. Every one of the nine
components is evaluated by at least one; none was left to be covered later.

| Component | Criteria |
|---|---|
| `CMP-0012` reader | `ACC-0016` |
| `CMP-0013` MDX compiler | `ACC-0017`–`ACC-0020` |
| `CMP-0014` server adapter | `ACC-0023`, `ACC-0025`–`ACC-0027` |
| `CMP-0015` project view | `ACC-0013`–`ACC-0015`, `ACC-0035` |
| `CMP-0016` stage view | `ACC-0016`, `ACC-0018`, `ACC-0035` |
| `CMP-0017` change stream | `ACC-0028`–`ACC-0031` |
| `CMP-0018` review action | `ACC-0034` |
| `CMP-0019` boundary check | `ACC-0021`–`ACC-0024` |
| `CMP-0020` launcher | `ACC-0032`, `ACC-0033` |

**All twenty-three are `not-evaluated`.** Nothing is built, so nothing has been run. That is the
correct state and it is also §2's answer working: `implementedBy` is empty, the criteria are
unevaluated, and between them they say plainly that this design exists and does not yet work.

### ⚠️ Four criteria exist to defeat a test that would otherwise pass on broken code

This is what §1's *"objective"* standard does not by itself catch, and the run turned it up four
times:

- **`ACC-0017`** ends *"a document that merely renders without the forbidden construct's effect is a
  FAIL"*. Stripping produces a page with no executed code, exactly as rejection does — so a test that
  renders and looks for a side effect passes identically on both, and the distinction `DEC-0020` was
  amended to preserve would be lost by a criterion that looked perfectly reasonable.
- **`ACC-0021`–`ACC-0023`** all say *"without executing the application"*. `AST-0022` measured that a
  non-compliant read is served fresh whenever a compliant read shares its route, so every behavioural
  check passes on a codebase that violates the contract.
- **`ACC-0024`** requires the boundary check to be **falsified against known violations**, and fails
  the check if the fixtures pass. ⚠️ Added because it happened during this work: a refusal test written
  the same week passed with the refusal deleted, because the assertion that mattered sat behind a
  condition that was never true. **A check nobody has seen fail is a check nobody has seen.**
- **`ACC-0027`** forbids asserting the diagnostic's *wording*. Next.js produced two different messages
  for one violation reached two ways, and one of them named the wrong router — a test pinned to that
  string would pass on a wrong message and break on a corrected one.

**`ACC-0020` is the one criterion carrying a number nobody has measured** — a 300 ms p95 compile
budget. It is written as a number rather than as "acceptable" so it stays pass/fail, and the note says
what to do if the first evaluation misses it badly: not relax the number, but take `DEC-0020`'s own
second alternative, plain markdown for stage documents.

---

## Exit criteria

| Criterion | Attestation |
|---|---|
| **criteria-objective** | ✅ `satisfied` — eight of nine are pass/fail outright; AC-9's testable half is objective and its judgment half is named rather than hidden. ⚠️ Basis is prose: the criteria are a table here, not artifacts, pending the PM's decision on `acceptance-criterion`. |

⚠️ **THIS ATTESTATION IS NOW STALE, and it is left standing rather than quietly re-scoped.** It was
evaluated on 2026-08-22 against the NINE criteria in §1, all of them `CMP-0011`'s. §6 added
twenty-three more against nine components, and **no one has judged those against this criterion.**
`criteria-objective` needs re-attesting for run 2 before stage 7 can be said to have passed for the
application shell — the same drift stage 6 carried for two days, named here on the day it appeared
rather than found later.

⚠️ §4 and §5 remain constraints recorded ahead of work, not attested claims.
