# Plan: Adapting PR #1 (GMT / webNRG submission) to the Node-based project

PR: <https://github.com/mrchrisadams/co2-runner/pull/1>
*"Adds the option to submit GMT runs through webNRG"* by ribalba (1 commit: `a02d855`)

The PR was written against the **Deno 2.9** codebase. The project has since
migrated to **Node >= 22.5** (`tsx`, `node:test`, Hono, `node:sqlite`), so the PR
cannot be merged as-is. The goal is to re-implement the *idea* as fresh commits
on top of current `main`.

---

## 1. Fetch the PR

jj does not have a native "fetch PR" command, but it is fully git-compatible.
Options, easiest first:

```sh
# Option A: fetch the PR ref directly from GitHub (works with any remote)
jj git fetch --remote origin
# GitHub exposes every PR as a ref: pull/N/head. If origin is the PR author's
# repo or you add it, you can fetch:
git fetch origin 'refs/pull/1/head:refs/remotes/origin/pr-1'   # colocated repo only

# Option B: add the author's fork as a second remote and fetch its main
jj git remote add ribalba https://github.com/ribalba/co2-runner.git
jj git fetch --remote ribalba
```

Then inspect the fetched commit without switching your working copy:

```sh
jj --no-pager log -r 'remote_bookmarks()' --no-graph
jj --no-pager show <change-id>          # the PR commit
jj --no-pager diff -r <change-id> --git > /tmp/pr1.patch   # optional: export as patch
```

Because jj snapshots everything, do **not** `jj edit` into the PR commit and try
to "update it in place" — the Deno code it touches no longer exists. Treat it
as **reference material**, not as a branch to rebase.

## 2. Adapt the PR into a new set of commits

Start a new change on top of current `main` (`jj new main -m "..."`), then port
the PR's design rather than its diff. The PR touches 17 files; the important
pieces are:

| PR file | Purpose | Adaptation notes for Node |
|---|---|---|
| `runner/gmt.ts` | Pure protocol: `journeyToGmtScript()`, POST `/save`, poll `/v2/runs`, parse `/v1/phase_stats/single` | Port as-is; keep all I/O injectable via `GmtDeps` (swap Deno `fetch` — Node 22 `fetch` is global, so minimal change). Deno type imports (`deno/types`) → local `types.ts` |
| `runner/gmt-jobs.ts` | Persistence in `gmt_submissions` table, SSE broadcast, `resumePendingSubmissions()` at startup | Deno KV / `node:sqlite` differences: PR already used `DatabaseSync`; verify table creation matches current `ui/db` or history module schema in `main` |
| `runner/run.ts`, `main.ts` | CLI: `co2-runner submit journeys/x.yaml --email --no-wait --print-script` | Wire into the Node CLI (`tsx main.ts`); keep `print-script` offline-safe |
| `ui/components.ts`, `ui/results.ts`, `ui/history.ts`, `ui/dashboard.js` | Preview modal + "Measure on cluster" button, side-by-side display | Port UI changes; check the current UI file layout on `main` (may have moved since) |
| `types.ts` | New types (`GmtDeps`, submission rows) | Merge with current `types.ts` on `main` |
| `docs/adrs/adr-006-gmt-cluster-submission.md`, `docs/architecture.md`, `README.md` | ADR + docs | Port nearly verbatim; update any Deno references to the Node build commands |

Suggested **commit sequence** (one logical change each, using
`jj desc -m` before writing code):

1. `Add GMT script translation and protocol client (runner/gmt.ts)`
2. `Add GMT submission job persistence and SSE lifecycle (runner/gmt-jobs.ts)`
3. `Add submit command and gmt-preview/gmt-submit HTTP endpoints`
4. `Add cluster submission UI with consent preview modal`
5. `Add tests for GMT protocol, jobs, and endpoints`
6. `Add ADR-006 and document GMT cluster submission`

Key behavioural decisions from ADR-006 to preserve:

- Deterministic script output (fixed 180 px / 110 ms scroll), byte-identical across calls.
- Reject `.spec.js` journeys with a clear message (YAML only).
- Persist the `job_id` **before** polling; resume pending rows on startup with original `submitted_at`.
- Two-phase wait: 30 s / 90 min run poll, then 5 s / 5 min phase-stats poll; retry only 204/429/5xx.
- Submission never happens implicitly — always behind the preview modal or an explicit `submit` command.

## 3. Get the tests running with the same new functionality

The PR's tests are written for `deno test`; this project uses
**`tsx --test`** (`npm test`, Node's built-in `node:test`). Port rather than
copy:

- PR tests: `tests/runner/gmt_test.ts` (27 protocol tests, fetch-stubbed),
  `tests/runner/gmt-jobs_test.ts` (11 lifecycle tests), plus additions to
  `tests/integration/http_test.ts` and `tests/ui/components_test.ts`.
- Replace `Deno.test(...)` with `test('...', ...)` from `node:test`, and
  `assertEquals` from `@std/assert` with `node:assert/strict`.
- Because `runner/gmt.ts` was designed with injectable `GmtDeps`, the fetch
  stubbing ports cleanly — no network is needed for the protocol tests.
- Copy the PR's HTTP fixtures (gateway `/save` response, `/v2/runs` rows,
  phase_stats payloads) into the new tests so the positional column parsing is
  covered.
- Run: `npm run check` (tsc) then `npm test`
  (`tsx --test --test-concurrency=1 --test-force-exit tests/**/*.ts`).

Definition of done: all new GMT tests green under `npm test`, existing suite
unchanged and green, `tsc --noEmit` clean.

## 4. Rebase the new feature into main

Because the work was authored directly on top of `main` in jj, "rebasing" is
mostly about keeping it current and landing it:

```sh
# keep the feature up to date with main while you work
jj rebase -d main            # from the feature commit (or -s <first> for the whole stack)

# when ready to land: fast-forward main to the last commit of the stack
jj bookmark move main --to <last-change-id>
jj git push -b main

# or, if you prefer a reviewable branch/PR instead of direct push:
jj bookmark create gmt-submission -r <last-change-id>
jj git push -b gmt-submission   # then open a PR from it
```

If conflicts appear after a rebase, jj shows them as conflict markers in the
working copy — edit the files to resolve, then `jj st` to confirm. `jj undo`
reverses any mistaken rewrite.

---

## Keeping this plan out of pushed history

This document lives in its **own jj change** (change ID `prnyxwtt`,
description: *"Add plan for adapting PR #1 GMT webNRG support to Node build"*),
as a sibling of `main` — not a descendant you would push. When you're done with
it:

```sh
jj abandon prnyxwtt        # removes just this plan commit; nothing else is affected
```

Because the feature commits are **not** descendants of it, abandoning it will
not touch the feature work. Just make sure `main` (or your feature bookmark)
never gets moved onto `prnyxwtt` before pushing.
