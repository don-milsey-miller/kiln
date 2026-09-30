# Changelog

Kiln uses the `YY.M.N` Calendar Versioning policy documented in
[`docs/versioning.md`](docs/versioning.md).

## 26.9.0 — 2026-09-29

First official Kiln release.

### Highlights

- Local-first, nine-stage project-planning workflow with structured requirements, decisions,
  evidence, tasks, approvals, and a deterministic development handoff.
- Pi-powered planning agent with explicit trust, provider/model selection, resumable sessions, and
  typed Kiln tools.
- Browser workspace for reviewing project status and authored planning artifacts.
- Optional web research and isolated validation capabilities with explicit consent boundaries.
- Cross-platform setup, recovery, process supervision, and cleanup coverage on Windows and Linux.
- Exact Pi dependency pinning with retained compatibility evidence, including interactive login and
  account-bound OAuth controls.

### Requirements and limitations

- Node.js 22.19.0 or newer and Git are required.
- Initial trust and provider authentication require an interactive terminal.
- Cloud providers and optional web research may consume paid quota.
- Release numbers are calendar identifiers, not SemVer compatibility promises; review release notes
  before updating an active project.
- Kiln has no separate support SLA.
