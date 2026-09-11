---
name: kiln-planning
description: Where Kiln's planning artifacts live and how they are written. Names the discipline; the tools that enforce it are not registered yet.
---

# Kiln planning artifacts

Kiln's planning content is a set of typed artifacts under a content root: requirements, components,
tasks, acceptance criteria, evidence, decisions, assertions and questions. Each has a schema, an id,
and traces to others by id.

Two rules hold wherever those artifacts are written:

- Artifacts are created and revised through typed operations that validate against the schema, never
  by hand-editing files. A hand-written artifact is one nothing checked.
- An artifact's outcome is never stored where it can be asserted directly. A task's status is derived
  from the acceptance criteria that accept it, so a task cannot be marked finished by editing it.

**This skill names the discipline; it does not implement it.** The typed tools that carry it out are
registered by later work (TSK-0044 and TSK-0045), and the `/kiln-start` orchestrator flow is not
implemented. Until those land, this file establishes the resource name and says plainly what is not
here yet, rather than describing behaviour an operator would then look for and not find.
