# Migration Plan: Deno → Bun

> **Status: PLAN ONLY — do not execute without user confirmation.**
> Companion to `MIGRATION_PLAN_NODE.md`. Each phase has tasks, file-level
> detail, and verification steps. Ordered by dependency.

## 1. Context

On 2026-10-09 Deno announced the team is joining Cloudflare
(https://deno.com/blog/cloudflare). The Deno runtime receives one year of
monthly bug-fix/security releases (~Oct 2027), then development ends.

**Chosen target: Bun.** This is the alternative to the (recommended) Node
plan. Bun's advantages for this project:

- `bun build --compile --target bun-<os>-<arch>` is the closest equivalent to
  `deno compile --target` — true cross-compilation from any host, all six
  targets (linux/windows/darwin × x64/arm64, plus musl).
- `Bun.serve({ fetch })` is a near drop-in for `Deno.serve`.
- No bundler needed for dev; `bun test` runs `.ts` natively.

**Known risks (documented in the review conversation, verify before starting):**

- **Playwright on Bun is unsupported upstream** (microsoft/playwright#38095:
  "doesn't test against Bun"). `firefox.launch()` hung under Bun 1.3.14 on
  Windows (fixed in a 1.4.0 canary); `bunx playwright install firefox`
  segfaulted on 1.3.14; `bun build --compile` breaks with Playwright because
  it reads its own `package.json` via `__dirname` paths the compiler can't
  embed. **Mitigation: Playwright must run in a real Node subprocess, never
  in-process in Bun and never embedded in the compiled binary.** This plan
  bakes that in.
- `node:sqlite` is **not implemented in Bun** → use `bun:sqlite` behind a
  small adapter.
- Energy measurement depends on **Firefox's** profiler power counters. Do
  NOT substitute Bun.WebView (WebKit) or any Chromium-based webview for the
  journey browser.

**Before starting, the executing agent must verify current Bun status:**
(1) is stable Bun ≥ the 1.4 line with the Windows Playwright hang fix?
(2) does `bun build --compile` still break with Playwright? If the latter is
fixed, some of phase 3 simplifies — but the subprocess-through-Node design
below is still the safe default.

## 2. Verified codebase inventory (what actually uses Deno)

Counts from `rg -o "Deno\.\w+"` across non-doc source (Oct 2026):

| Deno API | Count | Sites | Bun replacement |
|---|---|---|---|
| `Deno.test` | 88 | `tests/**` | `bun:test` |
| `Deno.env` | 39 | everywhere | `process.env` / `Bun.env` |
| `Deno.Command` | 22 | `runner/install.ts`, `runner/codegen.ts`, `runner/run-script.ts` (×2), `scripts/bundle-deno.ts` | `Bun.spawn` (or `node:child_process`) |
| `Deno.exit` | 14 | `main.ts`, runners | `process.exit` |
| `Deno.remove`/`mkdir`/`readTextFile`/`writeTextFile`/`writeFile`/`stat`/`realPath`/`readDir`/`chmod`/`symlink`/`makeTempFile`/`makeTempDir` | ~40 | runners, `main.ts`, `scripts/bundle-deno.ts` | `node:fs/promises` (implemented in Bun) |
| `Deno.execPath` | 10 | `util/deno-bin.ts`, `runner/run-script.ts` | `process.execPath` / `Bun.execPath` |
| `Deno.build.os` | 10 | `main.ts:520-522`, `runner/codegen.ts:45`, tests | `process.platform` **with mapping** (see gotcha 3.1) |
| `Deno.serve` | 3 | `main.ts:193` | `Bun.serve({ fetch, port, hostname })` |
| `Deno.args` | 3 | `main.ts` | `process.argv.slice(2)` / `Bun.argv` |
| `Deno.version` | 3 | `main.ts` | `Bun.version` |
| `Deno.errors.NotFound` | 1 | `util/exists.ts:10` | `err.code === "ENOENT"` |

Other Deno-specific surface:

- **`deno.json` import-map aliases** (`fs`, `path`, `sqlite`, `zlib` → `node:*`): replace with real `node:`/`bun:` specifiers. `ui/history.ts` imports `DatabaseSync` from `"sqlite"` — becomes the adapter (phase 1).
- **JSON import** `with { type: "json" }` (`runner/co2.ts:17`): `bun build` inlines JSON imports; for runtime, use `Bun.file(...).json()` or keep the import syntax (Bun supports it).
- **Playwright subprocess pattern** (4 sites: `runner/install.ts:57`, `runner/codegen.ts:118`, `runner/run-script.ts:59,246`): currently `deno run npm:playwright <cmd>` → becomes `node <payload>/node_modules/playwright/cli.js <cmd>` (see phase 3).
- **In-process Playwright** (`runner/run.ts:10` `import { firefox } from "playwright"`; `runner/run-script.ts:130` `import { defineConfig, devices } from "@playwright/test"`): **must move out of process** under Bun (see phase 3, task 3).
- **Desktop mode**: `DENO_SERVE_ADDRESS` env var (`main.ts:30,48,103`) → new equivalent e.g. `CO2_RUNNER_DESKTOP_ADDRESS`.
- **`util/deno-bin.ts`**: `findDenoBinary()` — replaced by a runtime-bin util that finds (a) the bundled/extracted Node binary for Playwright, (b) system Node as fallback.
- **`scripts/bundle-deno.ts`**: bundles Deno CLI into the .app + `hdiutil` DMG regen. Deleted — replaced by the GUI packaging route (phase 6).
- **Permissions flags** (`--allow-all`, `--unsafe-proto`, `--allow-scripts`, `--include`): disappear.
- **Tests**: 88 `Deno.test` calls with async `ignore:`, `sanitizeOps/Resources: false`; one test has the Linux `perf_event_paranoid` skip (added Oct 2026) — port it.

## 3. Gotchas the executing agent MUST handle

1. **OS name mapping**: `Deno.build.os` → `"darwin"|"linux"|"windows"`; `process.platform` → `"darwin"|"linux"|"win32"`. Create `util/platform.ts` with `os(): "darwin"|"linux"|"windows"` mapping `process.platform`; use everywhere. Never compare `process.platform === "windows"`.
2. **`bun:sqlite` vs `node:sqlite`**: Bun implements `bun:sqlite` (`Database`, `query`, etc.), NOT `node:sqlite`. Isolate all SQL behind a small adapter module so a future runtime switch is one-file.
3. **Playwright isolation rule**: journeys, codegen, install, and `@playwright/test` runs all execute in a **Node child process**. The Bun process never imports `playwright` or `@playwright/test` at runtime. (Imports may exist in types only if carefully split — safer to remove entirely and drive via the subprocess protocol.)
4. **SSE**: `main.ts:320-326` relies on `TransformStream` + `Deno.serve` flush timing. `Bun.serve` supports streaming `ReadableStream` responses; verify EventSource live updates in the UI manually.
5. **CI quirks (added Oct 2026, must survive)**: Playwright Firefox installed before tests; `xvfb-run` for headed Firefox on Linux runners; `run-script_journey_test.ts` skips when `perf_event_paranoid > 1`.

## 4. Target stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Bun (current stable; verify Playwright-related fixes first) | |
| HTTP server | `Bun.serve({ fetch, port, hostname })` | near drop-in for `Deno.serve` |
| SQLite | `bun:sqlite` behind `util/db.ts` adapter | `node:sqlite` unimplemented in Bun |
| Test runner | `bun:test` | maps `Deno.test` closely |
| Bundler/compile | `bun build --compile --target bun-<os>-<arch>` | cross-compiles from any host |
| Playwright | npm `playwright` + `@playwright/test`, **run via Node subprocess** | never in-process, never in binary |
| Node runtime for Playwright | ship a Node binary in the install payload | replaces the bundled-Deno trick; `BUN_BE_BUN` exists but would put Playwright on Bun — rejected |
| GUI | Electrobun (Bun runtime, system webview) — primary; Tauri + Bun sidecar as fallback | Electrobun is young: macOS 14+, Win11 x64, Ubuntu 24.04+; per-OS builds; no built-in installers |
| Packaging | `bun build --compile` (CLI), Electrobun build + `hdiutil` DMG (GUI) | |

## 5. Phased workplan

### Phase 0 — Scaffolding (no behaviour change)

**Tasks:**
1. Create `package.json` with deps (`yaml`), devDeps (`@types/bun`), scripts mirroring `deno.json` tasks:
   - `dev` → `bun --watch main.ts serve`
   - `serve` / `install` / `run` → `bun main.ts <cmd>`
   - `test` → `bun test`
   - `compile` → `bun build --compile ...` script (phase 5)
   - lint/fmt → eslint + prettier (or keep `deno lint/fmt` during transition, delete at phase 7)
2. Add `tsconfig.json` (`module: esnext`, `types: ["bun"]`, `target: es2023`).
3. Replace bare alias imports (`"sqlite"`, `"fs"`, `"path"`, `"zlib"`) with real specifiers.

**Verification:** `bun install` succeeds; `bun run dev` starts (with expected runtime errors until phase 1).

### Phase 1 — Runtime API shim + SQLite adapter

**Tasks:**
1. `util/platform.ts`: `os()` (win32→windows), `env()`, `args()`, `execPath()`, `cwd()` (Bun implements all `process.*` used).
2. `util/fsx.ts` wrapping `node:fs/promises` with Deno-shaped helpers (`readTextFile`, `writeTextFile`, `ensureDir`, `remove`, `makeTempFile` via `mkdtemp`, `realPath`, `chmod`, `symlink`, `readDir`, stat-shaping).
3. `util/spawn.ts` wrapping `Bun.spawn` with the `Deno.Command` ergonomics used (piped streams as `ReadableStream`, exit status).
4. `util/db.ts`: thin SQLite adapter exposing the operations `ui/history.ts` needs (open, exec, prepare/run/all). Implement with `bun:sqlite`; keep the interface `node:sqlite`-shaped so a later runtime switch is one file. Rewrite `ui/history.ts` against it.
5. Rewrite `util/exists.ts` (`ENOENT`).
6. Mechanically replace `Deno.*` across `main.ts`, `runner/*.ts`, `ui/*.ts`.
7. `runner/co2.ts` JSON import: verify under Bun; else switch to `Bun.file("data/...").json()` — but note the data file must be embedded for the compiled binary (phase 5 uses `bun build --embed` or inlines via import).

**Verification:** `bun run check`-equivalent (tsc) passes; `rg -n "Deno\."` in src returns only files scheduled for deletion.

### Phase 2 — HTTP server + SSE

**Tasks:**
1. `Deno.serve({ port, hostname }, handler)` → `Bun.serve({ port, hostname, fetch: handler })`; keep handler signature `(req: Request) => Response | Promise<Response>`.
2. Verify SSE live updates (install progress, codegen status) via the UI's EventSource — `main.ts:320-326` flush behaviour.
3. Replace `DENO_SERVE_ADDRESS` → `CO2_RUNNER_DESKTOP_ADDRESS` (`main.ts:30,48,103` + usage text).

**Verification (manual):** `bun run dev`; dashboard renders; history loads; a journey run streams progress to the UI live.

### Phase 3 — Playwright isolation (highest risk — different from Node plan)

**Design rule: all Playwright work happens in a Node child process.**

**Tasks:**
1. `util/node-runtime.ts`: locate a Node binary for Playwright subprocesses — search `~/.co2-runner/payload/node` (installed by `co2-runner install`), then system `node` on PATH. Error message mirrors today's `DenoNotFoundError` UX (points at install instructions).
2. `util/playwright-cli.ts`: resolve the Playwright CLI JS entry under `~/.co2-runner/payload/node_modules/playwright/cli.js` (installed by `co2-runner install`; dev fallback: project `node_modules`).
3. **In-process usage must be externalised** — this differs from today's code:
   - `runner/run.ts:10` (`firefox.launch` for YAML journeys): move journey execution into a small Node-side worker script (`scripts/journey-worker.mjs`) driven over stdin/stdout JSON-RPC, spawned via the Node runtime. The Bun process orchestrates; Node+Playwright executes.
   - `runner/run-script.ts:130` (`@playwright/test` config): the `.spec.js` pipeline already subprocesses Playwright — repoint the 4 `Deno.Command` sites (`install.ts:57`, `codegen.ts:118`, `run-script.ts:59,246`) to `spawn(nodeRuntime, [pwCli, cmd, ...])`.
4. Firefox power profiling env vars / profile capture logic (currently in `runner/run.ts` around the launch) moves with the worker — verify the Mozilla Profiler `MOZ_PROFILER_STARTUP` (or equivalent) settings and profile-file handoff survive the process boundary (worker writes profile JSON + HAR to the artefacts dir; Bun process parses via `runner/energy.ts`, which is pure parsing and stays).
5. Delete `util/deno-bin.ts` once unreferenced.

**Verification:**
- `bun run install` downloads Firefox AND the Node+Playwright payload to `~/.co2-runner/payload/`.
- `bun run run` completes `journeys/example.yaml` with non-zero mWh on a Mac (proves power counters survive the worker boundary).
- Codegen works from a graphical session.

### Phase 4 — Test migration (88 `Deno.test` calls)

**Tasks:**
1. Map `Deno.test({name, ignore, fn})` → `test(name, fn)` / `test.skip(name, ...)` from `bun:test`. Precompute async `ignore:` conditions (`isFirefoxInstalled`, `canReach`, `canMeasureEnergy`) at module top level — both runners support this pattern today.
2. `sanitizeOps/sanitizeResources: false` → drop (no equivalent needed).
3. `jsr:@std/assert` → `node:assert/strict` or Bun's bundled expect; `assertStringIncludes` → `assert(str.includes(...))`.
4. Port `tests/integration/run-script_journey_test.ts` **including** the `canMeasureEnergy()` `perf_event_paranoid` skip.
5. Tests that import `playwright` directly (if any besides integration paths through `runJourney`) go through the subprocess surface, per phase 3.

**Verification:** `bun test` matches today's Deno pass/skip profile locally.

### Phase 5 — CLI binary (bun compile)

**Tasks:**
1. `scripts/build-cli.ts`: `bun build --compile main.ts --target bun-<os>-<arch> --outfile dist/co2-runner-<target>` for the matrix: `bun-darwin-aarch64`, `bun-linux-x64`, `bun-windows-x64` (Intel mac optional — Bun supports `bun-darwin-x64`, unlike Node SEA).
2. Embed grid data (`data/electricity-maps-yearly-2025.json`) via import inline or `--embed`.
3. Windows: `main.ts:520` explorer branch uses `platform.os()` — covered by phase 1. Cross-compiled Windows binaries can't get icons/version metadata (except `hideConsole`) — accepted.
4. Playwright stays OUT of the binary: `co2-runner install` provisions `~/.co2-runner/payload/` (Node runtime + playwright + firefox). Extend `runner/install.ts` flow accordingly.
5. Smoke-test each target's `--help`.

**Verification:** cross-compile all targets from the macOS dev machine; run `dist/co2-runner-darwin-aarch64 run journeys/example.yaml` (with payload installed).

### Phase 6 — GUI app (Electrobun; fallback Tauri sidecar)

**Tasks:**
1. Evaluate Electrobun against current stable (it was young as of the review: verify build story, DMG output, per-OS support: macOS 14+, Win11 x64, Ubuntu 24.04+ with WebKitGTK).
2. Electrobun main process (Bun runtime) starts/loads the co2-runner server (in-process `Bun.serve` is fine — no Playwright in-process rule broken since Playwright is subprocessed via Node), webview loads `http://127.0.0.1:<port>` with `CO2_RUNNER_DESKTOP_ADDRESS` set.
3. DMG: Electrobun has no built-in installers → adapt the `hdiutil` staging approach from `scripts/bundle-deno.ts` (symlink /Applications, `hdiutil create -format UDZO`) as `scripts/package-dmg.ts` for the Electrobun `.app`.
4. Ad-hoc codesign parity (Electrobun docs' codesign step; `identity: null` equivalent).
5. **Fallback if Electrobun is insufficient**: Tauri v2 with the Bun-compiled CLI as a sidecar (`externalBin`), per Tauri's sidecar guide. The webview is UI-only; journeys still run Firefox via the Node payload.
6. Delete `scripts/bundle-deno.ts`.

**Verification:** `CO2Runner.app` launches with working UI; full journey from the GUI lands in history; DMG mounts, drag-installs, and launches on a clean Apple Silicon Mac.

### Phase 7 — CI + release pipeline port

**Port `.github/workflows/build.yml` preserving every October-2026 fix:**

1. `oven-sh/setup-bun` replaces `denoland/setup-deno`; install Playwright Firefox (+ Node for payload tests) before tests; `xvfb-run -a bun test` on Linux.
2. `build-cli` job: current matrix (macos-14/aarch64, ubuntu-22.04, windows-latest; Intel mac already dropped — optionally re-add since Bun cross-compiles from one host). Keep `--help` smoke tests.
3. `build-desktop` job (macos-14): Electrobun build + `scripts/package-dmg.ts`; upload `dist/CO2Runner.dmg` as artifact `CO2Runner-aarch64-apple-darwin.dmg` (release asset naming parity).
4. `release` job: unchanged — `softprops/action-gh-release`, `files: artifacts/*`, `generate_release_notes: true`, gated on `refs/tags/v*` OR `refs/tags/2026*`. **Do not lose this trigger.**
5. Delete `deno.json`, `deno.lock`; update `README.md`, `docs/`; new ADR superseding ADR-004 ("migrate runtime to Bun").

**Verification:** push tag `2026-1` (or test tag matching `2026*`); green run; GitHub Release created with DMG + CLI assets.

### Phase 8 — Docs & cleanup

1. README quickstart (`bun` commands; install.sh → payload install).
2. New ADR: "Runtime migration: Deno → Bun" (context: Cloudflare announcement; decision: Bun + Electrobun + Node-subprocess Playwright; consequences: Playwright-isolation complexity, Node payload in install).
3. Update `docs/architecture.md` C4 diagrams.
4. Remove `util/deno-bin.ts`, `scripts/bundle-deno.ts`.

## 6. Accepted regressions / tradeoffs

- Playwright upstream doesn't test against Bun — mitigated by Node subprocess isolation, but adds a worker protocol (phase 3) that the Node plan doesn't need.
- `node:sqlite` unavailable → `bun:sqlite` adapter (small lock-in, isolated in `util/db.ts`).
- Electrobun is young (no built-in installers, per-OS builds) — DMG tooling is our own; if it fails, fall back to Tauri sidecar (adds Rust toolchain).
- Cross-compiled Windows binary lacks icon/version metadata.
- Ad-hoc signing only — Gatekeeper warning remains (pre-existing).
- Extra first-run step for all users: Node+Playwright payload install (Deno embedded Playwright in one binary).

## 7. Acceptance criteria (definition of done)

- [ ] `bun test` green on macOS with same skip-profile as Deno today
- [ ] `bun run serve` UI works: dashboard, history (bun:sqlite), SSE live updates
- [ ] YAML journey + `.spec.js` journey run end-to-end (via Node worker) with energy figures on macOS
- [ ] Codegen produces `.spec.js` from a graphical session
- [ ] `co2-runner install` provisions Firefox + Node/Playwright payload
- [ ] CLI binaries cross-compile for all targets with passing `--help` smoke test
- [ ] `CO2Runner.dmg` builds in CI, mounts, installs, launches on Apple Silicon
- [ ] Tag `2026-1` produces a complete GitHub Release with DMG + CLI assets
- [ ] No `Deno.` references remain in `src` (only in docs/ADRs as history)
