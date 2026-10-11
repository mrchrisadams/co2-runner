# ADR-006: Migrate the runtime from Deno to Node

Date: 2026-10-10

## Status

Accepted. Supersedes [ADR-004](adr-004-bundle-standalone-deno.md) (bundling a
standalone Deno CLI into the desktop app) — that workaround is deleted along
with the Deno runtime itself.

## Context

On 2026-10-09 the Deno team
[announced](https://deno.com/blog/cloudflare) they are joining Cloudflare. The
Deno runtime receives one year of monthly bug-fix/security releases (until
~October 2027), after which development ends; Deno Deploy shuts down after six
months. Building this project on Deno therefore has a hard expiry date.

The project's Deno-specific surface at migration time:

- Runtime APIs: `Deno.serve` (HTTP + SSE), `Deno.Command` (Playwright
  subprocesses), `Deno.env`/`build`/`args`/fs APIs (~150 call sites)
- `deno test` (88 test registrations), `deno lint`/`fmt`/`check`
- `deno compile` for CLI binaries, `deno desktop` (laufey) for the macOS app
- `scripts/bundle-deno.ts`: downloaded a standalone Deno CLI into the .app so
  Finder-launched subprocesses worked (ADR-004)

The dominant dependency is Playwright (journeys run in Firefox; energy
measurement reads Firefox profiler power counters). Playwright is a Node
package first — on Bun it is upstream-unsupported with documented launch and
`--compile` breakages.

## Decision

Migrate to **Node.js** (≥22.5, for built-in `node:sqlite`):

- **Server**: Hono + `@hono/node-server` (Deno.serve's `(req) => Response`
  handler ports nearly verbatim; loopback-only binding preserved).
- **Runtime shims**: `util/platform.ts` (OS-name mapping — `process.platform`
  says `win32`, not `windows`), `util/fsx.ts` (fs/promises with Deno-shaped
  helpers), `util/spawn.ts` (child_process with Deno.Command ergonomics;
  env MERGES over the parent — callers blank keys explicitly).
- **Playwright**: stays in real Node processes. Subprocess sites spawn
  `node <playwright-cli> <cmd>` via `util/playwright-cli.ts`; under Electron
  the runtime binary is Electron with `ELECTRON_RUN_AS_NODE=1`.
- **CLI**: Node SEA (`node --experimental-sea-config` + postject), built
  per-OS by `scripts/build-cli.mjs`. Playwright is never embedded (a stub
  fails lazily with a pointer to the payload story).
- **Desktop**: Electron. The BrowserWindow is UI only — it loads the Hono
  server on loopback; journeys still run in Firefox via Playwright (the
  energy measurement depends on Firefox's profiler, not the app's webview).
  Packaged with electron-builder (mac arm64 dmg, ad-hoc signing).
- **Tests**: `node:test` + tsx (`npm test`), `node:assert/strict`,
  `--test-force-exit` (Playwright keeps handles alive). Helpers spawn the
  server detached and reap its whole process group.

Executed via jj workspaces, one phase per workspace (see
`MIGRATION_PLAN_NODE.md` for the full plan, incident log, and delegation
model).

## Consequences

- The one-year Deno EOL no longer binds the project.
- The desktop app grows from ~75 MB to ~140 MB (Electron bundles Chromium).
- The SEA CLI can no longer run journeys from inside the binary (no
  `node_modules`, `process.execPath` is the binary) — dev mode uses tsx;
  packaged distributions need a Playwright payload (tracked for a follow-up).
- Cross-compilation is gone: CLI binaries build on native runners per-OS
  (the Intel-mac target was already dropped in October 2026).
- Ad-hoc signing only — the Gatekeeper warning remains (unchanged).
- Node SEA is stability 1.1 ("active development"); the Node version is
  pinned via `engines` + CI.
