# Changelog

Kiln uses the `YY.M.N` Calendar Versioning policy documented in
[`docs/versioning.md`](docs/versioning.md).

## 26.10.0 — 2026-10-13

First October 2026 release. Changes below are relative to `26.9.0`.

### Highlights

- Added guided end-to-end setup and onboarding, including project identity, trust, model selection,
  optional capabilities, recovery, and an explicit final review before launch.
- Added operator-controlled voice dictation and speech output in Pi's TUI through ElevenLabs, with
  editable transcripts, no voice-based approval, bounded capture and playback, and no retained
  audio by default.
- Added local source ingestion for text, PDF, image, and audio material, with browser upload, a
  watched inbox, retained local blobs, typed source records, and explicit consent for remote
  extraction.
- Added optional semantic decisioning for intake, research, evidence, planning review, proposals,
  and specialist routing. All model-written decisions remain advisory.
- Added durable Stage 4 decision bundles, bounded compaction recovery, recorded `/new` sessions,
  and a resumable-session chooser that excludes corrupt and incompatible transcripts.
- Added pan-and-zoom wireframe review, review-first stage pages, human-readable gate labels, and
  clearer pending-versus-blocked presentation.

### Agent, CLI, and runtime changes

- Added `start-kiln.mjs --rpc`. On Windows, RPC starts now refuse Node releases affected by a known
  exit crash. Supported lines are Node 22.19 or newer 22.x, 24.20 or newer 24.x, 26.7 or newer 26.x,
  and stable Node 27 or later.
- Delegation now resolves the pinned child executable and passes only the selected provider route,
  research permission context, and research credential. Delegated children no longer inherit the
  operator session's stage frame, checkpoint, recovery message, carry-over, or credential vault.
- Stage-document and payload writes are cancellable and bounded, with typed refusal results.
- `lint-plan --json` now omits artifact records by default. Use `--include-records` when records are
  required.

### Performance, security, and reliability

- Added verified production-build reuse. Use `--rebuild` to force a new build.
- Added clean-consumer installed-tree and production-trace audits.
- Updated Next.js, sharp, source-map-js, and nested brace-expansion dependencies to address
  production advisories.
- Preserved unsigned Windows child crash codes in the job host and prevented change-stream reloads
  from overriding completed browser navigation.
- Bounded research output, stage text, confirmation rendering, compaction context, and lint JSON.

### Migration and compatibility notes

- JSON lint consumers that need artifact records must add `--include-records`.
- Windows RPC integrations must use a supported Node release. An unsafe release is refused with exit
  code 2; there is no bypass.
- Voice requires ElevenLabs plus supported `ffmpeg` and `ffplay` installations. Audio logging is
  opt-in.

### Known limitations

- Voice input and output have been manually validated with physical audio devices on Windows.
  Native Linux microphone and speaker validation remains tracked in issue #113; macOS is deferred.
- Cloud model, research, and extraction services may consume paid quota after explicit consent.
- Calendar versions identify release order and do not promise SemVer compatibility.

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
