# `app/server/` — the only door from the application into `lib/`

Every module here begins with `import "server-only"` and re-exports from `lib/` by **explicit name**.
`export *` is not permitted: it would make this directory a hole rather than a door, widening the
exposed surface every time `lib/` gains an export, with no diff for anyone to review (DEC-0021).

## Deliberately narrow writes

The application exposes exactly two write capabilities: review-status mutation and source intake.
The ingestion adapter accepts source bytes plus portable metadata, never a destination path. It can
write only through the ingestion service into `.pi/ingest/` and the typed `source` boundary.

`lib/attestations.mjs` is the concrete case: `loadStageAttestations` is a read, and
`writeStageAttestation` takes the content lock. They are exports of the same module, so
`export * from "../../lib/attestations.mjs"` would have exposed a locking capability by accident —
which is what the explicit-names rule exists to prevent, not a hypothetical.

Review-status writing and source intake are reviewed separately and pinned by boundary tests. A
Server Component or route can run concurrently in ways a CLI never does, which is why neither
adapter exposes a generic writer or raw filesystem primitive.

## Why the guard is not in `lib/`

`server-only` resolves its `react-server` export condition to an empty module inside the RSC
compiler and to a throwing module everywhere else. `lib/` is imported by every command in `bin/` and
by the whole test suite under plain Node, so marking it there would break the tool in order to
protect the application (AST-0033). The marker lives here, and the marker propagates through a
re-export — a client component that reaches `lib/` through one of these files fails the build at
that file's line 1.
