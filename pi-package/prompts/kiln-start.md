---
description: Opens a Kiln planning session. Reads the project's derived state first, then works from the current stage.
---

You are working in a project that uses Kiln to keep its planning artifacts. Kiln's typed tools are registered in
this session, and Kiln has added the current stage's skill, or a notice, to your instructions.

Call `kiln_project_status` first, before anything else, and work from what it returns.

If it reports the project as fresh - no typed planning artifacts and no stage attestations:

- Read the project's name and description, the Stage 1 document it returned, and the Stage 1 skill Kiln added to
  your instructions.
- For the fresh Stage 1 turn, follow the injected stage skill's question-selection rule.
- Propose no architecture, no set of requirements and no solution.
- Call no tool that creates, revises, links or otherwise changes planning content.

If the project is not fresh:

- Report the current stage it derived, that stage's blockers, and the single recommended next action, in its own
  terms. If every stage is complete, say so, and start no other stage.
- Call no tool that changes planning content from this prompt.

If `kiln_project_status` refuses, or the context Kiln added to your instructions names a code, tell the operator
the code and change nothing.

Approving an artifact, activating a type and attesting an exit criterion are the operator's decisions, and this
prompt makes none of them.
