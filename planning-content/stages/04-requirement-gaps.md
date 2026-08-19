# Stage 4 — Requirement Gaps

> **Status: AGENT PROPOSAL, awaiting PM decisions.** Stage 4 is `decidedBy: User`
> (`stages/04-requirement-gaps.json`). The agent surfaces gaps; **the PM decides them.** Nothing below
> is decided, and the register is deliberately not filled in on the PM's behalf.
>
> Derived by walking the fourteen active requirements against what actually exists in the repo — not
> against the roadmap, and not against what is nearly done.

---

## Coverage: which requirements have an implementation path

| | Requirement | State |
|---|---|---|
| REQ-0001 | Process defined by the system | ✅ `stages/` + the gate |
| REQ-0002 | State inspectable at any time | ✅ lint, gates, skeleton |
| REQ-0003 | **Answerable from external sources** | ❌ **nothing** |
| REQ-0004 | A claim records its source | ✅ `evidence.sources` |
| REQ-0005 | **Claims testable by execution** | ❌ **nothing** |
| REQ-0006 | A tested claim records its environment | ✅ `evidence.environment` |
| REQ-0007 | Every load-bearing claim carries how it is known | ✅ #96's derivation |
| REQ-0008 | Claim strength readable without prose | ✅ verdict + confidence |
| REQ-0009 | Instructions rest on resolved claims | ✅ #99 |
| REQ-0010 | **Handoff actionable without returning** | ❌ **nothing** |
| REQ-0011 | **Serves a human OR an agent** | ⚠️ **half** — artifacts are machine-readable; nothing exports, and the human half is unsettled |
| REQ-0012 | **Costly validation needs authorisation** | ⚠️ **decided, unenforceable** (#77) — nothing can spend money, so nothing enforces it |
| REQ-0013 | Decisions recorded with alternatives | ✅ `decision`, `DEC-0001` |
| REQ-0014 | Questions tracked as objects | ✅ `question` |

**Nine of fourteen are met. Five are not, and three of those five have no vehicle other than the agent
half.**

⚠️ **The uncomfortable one is REQ-0003.** *"The agent cannot research"* is the intake's problem 2 — the
PM's own words, *"educated guessing"* — and it is still true. Stage 3 was answered by reading, but by
**the agent running that session**, not by the product. Building the capability the whole project was
started to fix has not begun.

## Open decisions raised — the register

Five, as `question` artifacts with `blocks` edges to the requirements they hold up. **None is decided.**

| | Question | Blocks |
|---|---|---|
| QST-0005 | How does a specialist obtain internet research capability? | REQ-0003 |
| QST-0006 | What implements sandboxed execution, and which tier first? | REQ-0005, REQ-0012 |
| QST-0007 | Does the handoff export exist in v1, and what produces it? | REQ-0010, REQ-0011 |
| QST-0008 | Is the skeleton's rendering sufficient for REQ-0011's human half? | REQ-0011 |
| QST-0009 | Which of these gaps **block**, and which are simply not done? | — |

⚠️ **QST-0009 exists because stage 4's exit criterion turns on a word nobody has defined here:** *every
**blocking** gap has a user decision recorded.* Without a definition the stage cannot be exited honestly
in either direction — everything could be called blocking, or nothing could. That is a defect in the
stage definition as much as in this project, and it is the second time #91's *draft made authoritative*
has shown a seam.

---

## What stage 4 says about the catalogue (#106)

Running the stage produced **authentic demand and authentic absence**, which is what it was for:

| Type | Demand from the requirements | Verdict |
|---|---|---|
| `task`, `role-assignment` | **REQ-0010 via #19** — the handoff is sliced per role, and a slice is over tasks | **demand exists**, conditional on QST-0007 |
| `acceptance-criterion` | none directly. REQ-0009 is about assertions backing instructions, not about acceptance | **no demand yet** |
| `risk` | **none. No requirement mentions risk at all.** Stage 6 produces it because the stage table says so | **no demand** |

⚠️ **`risk` is the sharper finding.** It is in #38's sixteen and stage 6 declares it, and **nothing the
PM asked for requires it.** That is not proof it should go — the intake was not exhaustive — but it is
the first evidence about a catalogue type derived from demand rather than from the catalogue, and #106
says that evidence is what should decide.

## What stage 4 says about the agent half

**REQ-0003, REQ-0005 and REQ-0012 have no vehicle except the specialist contracts.** The research
specialist is what makes REQ-0003 possible; the validation specialist is what makes REQ-0005 and
REQ-0012 possible. So the answer to *"are the specialist contracts the next critical implementation
work"* is: **they are the only path to three unmet `must` requirements**, which is a stronger reason
than their being available.

⚠️ That does **not** decide the order. QST-0005 and QST-0006 have to be answered first — a research
specialist with no research capability, or a validation specialist with no sandbox, would be #67's
toolless child in a different costume: a contract with nothing behind it.

---

## Exit criteria — PM decision required

`stages/04-requirement-gaps.json` declares one, `mechanised: false`:

> **every-blocking-gap-decided** — Every blocking gap has a user decision recorded.

**Cannot be attested until QST-0009 is answered**, because until then "blocking" has no meaning on this
project. The gate will report `gate/criterion-pending-human` and refuse to be ready (#93), which is the
correct behaviour and not an obstacle to route around.
