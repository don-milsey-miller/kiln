---
name: kiln-planning
description: Where Kiln's planning artifacts live and how they are written. The typed tools that write them are registered in this session, and a task's status is derived rather than stored.
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

## The typed tools

Kiln's package registers the typed tools that carry these rules in this session. Each resolves the
project's content root itself, validates against the schema, and refuses rather than guessing. Among
them:

- `kiln_project_status` reports the artifact count and every blocker standing in the way of handoff,
  and `kiln_lint` returns the planning lint's findings. Both read only.
- The `kiln_create_*` tools create one artifact of their type.
- `kiln_revise_artifact`, `kiln_link_trace` and `kiln_set_lifecycle` change an existing artifact.

Approving an artifact and satisfying a user-owned exit criterion are the operator's decisions.

## Not in this skill

The `/kiln-start` prompt and the stage context Kiln adds to a session carry the planning flow: the
current stage derived from the stage definitions and attestations, its blockers, the recommended next
action and that stage's skill. This skill describes the artifacts and the tools that write them, not
that flow.
