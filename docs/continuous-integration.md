# Continuous integration

Kiln's CI runs each verification where its contract requires it, instead of running the complete
suite in every operating-system and Node-version combination. The classification is executable:
[`test/ci-groups.mjs`](../test/ci-groups.mjs) names every test file exactly once, and the suite fails
when a test is missing or duplicated.

## Trigger and cancellation contract

- Pull requests run once through the `pull_request` trigger. Feature-branch pushes do not start a
  second copy of the workflow.
- A push to `main` runs the workflow again against the merge commit.
- Manual dispatch remains available.
- A newer run cancels an older run only when both have the same workflow and pull-request/ref key.
  Unrelated pull requests and `main` therefore cannot cancel one another.

The workflow has only `contents: read`. The checkout and Node setup actions are pinned to immutable
commits, with their release tags retained as comments for maintainers.

## Jobs and guarantees

| Job | Environments | What it proves |
| --- | --- | --- |
| Repository invariants | Ubuntu, Node 24 | One deliberately uncached `npm ci`, production audit, and generated-file drift checks. |
| Core | Ubuntu, Node 24 | Deterministic schemas, planning state, transforms, registries, and adapters. |
| Node compatibility | Ubuntu, Node 22 and 24 | ESM/module loading, Pi package/runtime integration, and Node-facing APIs. |
| Platform behavior | Ubuntu and Windows, Node 24 | Process trees, signals, terminals, filesystem identity, locks, cleanup, and shutdown. |
| Setup and recovery | Ubuntu and Windows, Node 24 | Project identity, state protection, setup, recovery, and transactional writes. |
| Clean consumer | Ubuntu/Node 24 and Windows/Node 22 | Cold project setup, browser/production shell, and end-to-end consumer journeys. |
| Live Pi compatibility | Ubuntu, Node 24 | A fresh consumer install and live proof against the pinned Pi runtime. |

The Windows platform job repeats the three generated-output checks. This is intentional and is the
minimum cross-platform control for path separators and line endings: once per operating system,
instead of once in every Node/OS product cell. The production audit is platform-independent and runs
once, fail-closed, on the uncached install.

Every other job may restore npm's download cache, but still runs `npm ci` into a fresh `node_modules`.
The cache saves downloads; it does not replace installation.

## Local commands

Run the same groups CI invokes:

```text
npm run test:ci:core
npm run test:ci:node
npm run test:ci:platform
npm run test:ci:setup
npm run test:ci:consumer
npm run test:pi-compat
```

`npm test` remains the complete local suite. It runs those five exhaustive groups serially, in separate
Node processes, and disables file-level concurrency inside each child. Setup or consumer journeys that
install dependencies therefore cannot overlap any test importing or inspecting the checkout's
`node_modules`. Group commands use the same Node test runner
and print a ranked `[kiln-ci-profile]` table for the 15 slowest files plus group wall time. CI therefore
records separate Ubuntu and Windows measurements in ordinary logs without a second profiling execution.

When adding a test, place it in exactly one group based on what it exercises. The classification test
will reject an unclassified file. Do not choose a broader group merely because it is convenient:

- pure data/state behavior belongs in `core`;
- runtime/package or module-loader behavior belongs in `node`;
- OS process/filesystem behavior belongs in `platform`;
- setup, recovery, and state-protection behavior belongs in `setup`;
- a fresh-project, production build, browser, or full journey belongs in `consumer`.

## Baseline and optimization decisions

The last full Cartesian PR run before this change was [CI run 36632042657](https://github.com/don-milsey-miller/kiln/actions/runs/36632042657):

| Cell | Duration |
| --- | ---: |
| Ubuntu / Node 22 | 6m 55s |
| Ubuntu / Node 24 | 9m 26s |
| Windows / Node 22 | 14m 49s |
| Windows / Node 24 | 12m 26s |

That is 43m 36s of runner time and a 14m 49s critical path for one PR workflow. Before the trigger
fix, an uncancelled feature-branch push plus its pull-request run could double that work.

The high-cost cases retain their intended controls:

- clean-consumer and production-shell tests run once on each OS and are not given a shared mutable
  project or build;
- process lifecycle, lock, signal, and cleanup tests still run on Windows and POSIX;
- setup/recovery and process-lifecycle tests are separate parallel jobs because profiling showed
  their costs stacked into the platform critical path even though they share no mutable fixture;
- Node-specific integration runs on both supported Node releases;
- the live Pi proof is isolated so it runs in parallel and has its own timeout;
- repeated Next builds are reduced by environment classification, not by sharing `.next` across
  tests that mutate it or claim a clean-build guarantee;
- Node's file-level parallelism remains enabled, while tests that truly share `.next` keep their
  existing explicit lock;
- no path filter is applied. Planning content, schemas, package metadata, and documentation can feed
  generated or packaged behavior indirectly, so a broad skip rule is not demonstrably safe.

The first local Windows profiles after classification measured core at 2m 54s, Node compatibility at
1m 30s, the original combined platform bucket at 8m 57s, and clean-consumer at 2m 37s. The combined
platform result prompted the separate setup/recovery job before the workflow was proposed. The
associated pull request records the definitive clean-run job timings and before/after totals after
the workflow runs on both platforms. Future optimization should start from the ranked profile lines
rather than from lower timeouts or deleted coverage.
