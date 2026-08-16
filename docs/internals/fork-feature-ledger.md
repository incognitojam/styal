# Fork feature ledger

The fork feature ledger at `.github/fork-features.yml` records the behavioral capabilities that the
fork deliberately maintains beyond upstream. It complements the commit patch stack and the generated
fork-features issue:

- commits preserve how the implementation changed;
- the generated issue summarizes what users receive;
- the ledger states what behavior maintainers intend to preserve, where upstream changes can affect
  it, and which tests provide evidence.

The ledger is capability-oriented. A feature and its later fixes share one entry and one stable ID.
CI validates the file with `vp run --filter @t3tools/scripts ledger:check`.

## Fields

- `id`: stable lower-kebab-case capability ID. Do not rename it when implementation details move.
- `title`: short maintainer-facing capability name.
- `status`: `maintained`, `review-needed`, or `retiring`.
- `prs`: fork pull requests that introduced or materially repaired the capability.
- `invariants`: observable behavior that must remain true after upstream integration.
- `implementation_paths`: fork implementation files whose removal or rename must update the ledger.
- `upstream_paths`: files shared with upstream whose upstream changes should prompt semantic review.
- `tests`: focused evidence for the invariants. These files must continue to exist.
- `upstream.status`: `unassessed`, `tracking`, `partial`, or `equivalent`.
- `upstream.tracking`: upstream issues, pull requests, or commits used for an assessed status.
- `upstream.retire_when`: the condition under which the fork implementation can be removed.

Paths are exact files rather than broad directories or globs. Implementation and test paths must
exist in the fork, making local renames and removals fail validation instead of silently weakening the
ledger. Upstream paths are audited when an entry is added to ensure they exist on the current upstream
base; Fork Nightly disables rename detection when diffing upstream so a moved path is reported as both
the watched deletion and a new addition.

## Workflow

Add a ledger entry when a pull request creates a new maintained divergence. Add follow-up pull request
numbers, invariants, paths, and test evidence to the existing entry when repairing or extending one.
Keep implementation and upstream paths distinct, entries sorted by ID, and values within structured
lists sorted.

During an upstream rebase, review a capability when upstream changes one of its upstream paths, when
its tests need conflict resolution, or when the patch range-diff changes. Record upstream evidence
before changing `upstream.status` from `unassessed`. Fork Nightly compares the old and new upstream
commits and writes warnings plus a workflow summary section for every exact upstream-path overlap.
These warnings identify where judgment is needed; they do not claim that an overlap is a behavioral
conflict. Fork CI validation is blocking, while the Nightly overlap step is deliberately advisory so
a reporting failure cannot prevent an otherwise verified release.

When upstream provides overlapping behavior, mark the entry `review-needed` and compare the ledger's
invariants rather than implementation shape. Retire the fork patch only after upstream satisfies the
documented condition and the resulting stack passes the focused tests. Remove the ledger entry in the
same reviewed change that removes the final fork-owned behavior.

## Coverage

Coverage begins incrementally with cross-surface and frequently conflicted capabilities. The ledger's
`coverage: incremental` marker is an explicit statement that unlisted fork behavior still exists; it
must not be interpreted as a complete inventory until a reviewed backfill says otherwise.
