# Migration Plan: Deno → Node

> **Status: PLAN ONLY — do not execute without user confirmation.**
> This document is a complete, delegated-execution plan. Each phase has tasks,
> file-level detail, and verification steps. Phases are ordered by dependency.

## 1. Context

On 2026-10-09 Deno announced the team is joining Cloudflare
(https://deno.com/blog/cloudflare). The Deno runtime receives one year of
monthly bug-fix/security releases (~Oct 2027), then development ends. This
project (co2-runner) is built entirely on Deno: runtime APIs, `deno test`,
`deno compile` for CLI binaries, and `deno desktop` (laufey) for the macOS app.

**Chosen target: Node.js** (recommended in the review conversation — see
"Migrating Deno Project to Node or Bun.md" in the repo root). Rationale:

- Playwright is this project's most critical dependency and Node is its
  native home (Bun has documented launch/compile breakages with Playwright).
- `node:sqlite` is already used today via Deno's import-map alias — zero
  change needed.
- The existing CI builds on native runners per-OS anyway, so Node SEA's
  weaker cross-compilation story (vs `bun build --compile`) costs little.
- Electron (GUI) uses Node in its main process and its binary can act as a
  plain Node runtime (`ELECTRON_RUN_AS_NODE`), replacing the current
  77 MB bundled-Deno hack in `scripts/bundle-deno.ts`.

## 2. Verified codebase inventory (what actually uses Deno)

Counts from `rg -o "Deno\.\w+"` across non-doc source (Oct 2026):

| Deno API | Count | Sites | Node replacement |
|---|---|---|---|
| `Deno.test` | 88 | `tests/**` | `node:test` |
| `Deno.env` | 39 | everywhere | `process.env` |
| `Deno.Command` | 22 | `runner/install.ts`, `runner/codegen.ts`, `runner/run-script.ts` (×2), `scripts/bundle-deno.ts` | `node:child_process` `.spawn()` |
| `Deno.exit` | 14 | `main.ts`, runners | `process.exit` |
| `Deno.remove`/`mkdir`/`readTextFile`/`writeTextFile`/`writeFile`/`stat`/`realPath`/`readDir`/`chmod`/`symlink`/`makeTempFile`/`makeTempDir` | ~40 | runners, `main.ts`, `scripts/bundle-deno.ts` | `node:fs/promises` (`rm`, `mkdir`, `readFile`, `writeFile`, `stat`, `realpath`, `readdir`, `chmod`, `symlink`, `mkdtemp`; note: no `makeTempFile` → `mkdtemp` + write) |
| `Deno.execPath` | 10 | `util/deno-bin.ts`, `runner/run-script.ts` | `process.execPath` |
| `Deno.build.os` | 10 | `main.ts:520-522`, `runner/codegen.ts:45`, tests | `process.platform` **with mapping** (see gotcha 3.1) |
| `Deno.serve` | 3 | `main.ts:193` | Hono + `@hono/node-server` |
| `Deno.args` | 3 | `main.ts` | `process.argv.slice(2)` |
| `Deno.version` | 3 | `main.ts` | `process.versions.node` |
| `Deno.errors.NotFound` | 1 | `util/exists.ts:10` | `err.code === "ENOENT"` |

Other Deno-specific surface:

- **`deno.json` import-map aliases**: `fs` → `node:fs/promises`, `path` → `node:path`, `sqlite` → `node:sqlite`, `zlib` → `node:zlib`. Files import these aliases bare (`import { DatabaseSync } from "sqlite"` in `ui/history.ts`). Replace with real `node:` specifiers.
- **JSON import** `import emData from "../data/electricity-maps-yearly-2025.json" with { type: "json" }` (`runner/co2.ts:17`) — esbuild inlines JSON imports; syntax needs a small loader tweak.
- **Playwright subprocess pattern**: `runner/install.ts:57`, `runner/codegen.ts:118`, `runner/run-script.ts:59,246` all spawn `deno run --allow-all --allow-scripts=npm:playwright npm:playwright <cmd>`. Replace with `node <playwright-cli-path> <cmd>` (see phase 3).
- **Desktop mode**: `main.ts:30` — `deno desktop` sets `DENO_SERVE_ADDRESS`; when set, server binds to it and suppresses stdout. Electron will set an equivalent env var (e.g. `CO2_RUNNER_DESKTOP_ADDRESS`).
- **`util/deno-bin.ts`** (133 lines): `findDenoBinary()` walks well-known paths to find a deno CLI for subprocesses (Finder launches have minimal PATH). Becomes `util/runtime-bin.ts` returning the Electron-as-Node binary path.
- **`scripts/bundle-deno.ts`**: downloads the Deno CLI into the .app, re-codesigns, regenerates the DMG via `hdiutil`. **Deleted** in this migration — replaced by electron-builder packaging.
- **Permissions flags** `--allow-all`, `--unsafe-proto`, `--allow-scripts`, `--include` — all Deno-isms; disappear.
- **Tests**: 88 `Deno.test` calls, some with async `ignore:` expressions, `sanitizeOps: false`, `sanitizeResources: false` (Playwright keeps handles alive). One test (`tests/integration/run-script_journey_test.ts`) has the `canMeasureEnergy()` Linux `perf_event_paranoid` skip added Oct 2026 — port it.

## 3. Gotchas the executing agent MUST handle

1. **OS name mapping**: `Deno.build.os` returns `"darwin" | "linux" | "windows"`. `process.platform` returns `"win32"` for Windows and `"linux"`, `"darwin"`. `main.ts:520-522` and `runner/codegen.ts:45` branch on these strings; `tests/runner/codegen_test.ts:62` and `tests/integration/co2_test.ts:69` gate on `Deno.build.os`. Create a single `util/platform.ts` exporting `os(): "darwin" | "linux" | "windows"` that maps `process.platform`, and use it everywhere. Never compare raw `process.platform` to `"windows"`.
2. **SSE flush behaviour**: `main.ts:320-326` has a comment that `TransformStream`'s `writer.write()` only resolves when the readable side drains, and `Deno.serve` flushes headers on first write. With `@hono/node-server`, streaming `ReadableStream` responses generally work, but SSE headers/first-flush timing differs — verify the UI's EventSource live-updates manually (see phase 2 verification).
3. **`node:sqlite` API**: project uses `DatabaseSync` (from Node ≥22.5). In current Node docs `DatabaseSync` is a deprecated alias for `Database` — use whatever the pinned Node version documents; keep the import in one place (`ui/history.ts`).
4. **Playwright & `--unsafe-proto`**: the Deno-ism disappears under Node; nothing to do, but any code comments referencing it should be cleaned up.
5. **Firefox is the measurement instrument**: energy figures come from Firefox's profiler power counters (`runner/energy.ts` parses them). Do NOT swap the journey browser for Chromium/WebKit. The Electron shell's BrowserWindow is only the *app UI*; journeys still launch Firefox via Playwright.
6. **CI environment quirks (added Oct 2026, must survive the port)**: Playwright Firefox must be installed before tests (`npm:playwright install firefox` equivalent); tests run under `xvfb-run` (headed Firefox needs an X server on Linux runners); `run-script_journey_test.ts` skips when `/proc/sys/kernel/perf_event_paranoid > 1`.

## 4. Target stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js (current LTS, ≥22.5 for `node:sqlite`) | pin via `package.json` `engines` + CI `actions/setup-node` |
| HTTP server | `hono` + `@hono/node-server` | `Deno.serve` handler signature `(req: Request) => Response` ports almost verbatim |
| SQLite | `node:sqlite` built-in | already used today via alias |
| Test runner | `node:test` (`node --test`) | zero new deps; maps `Deno.test` → `test()` |
| Bundler | `esbuild` | single-file bundle for SEA; inlines JSON import |
| Dev runner | `tsx` | `.ts` imports without build |
| Playwright | `playwright` + `@playwright/test` npm | run subprocesses via real Node |
| CLI binary | Node SEA (`node --build-sea`) | stability 1.1 — active development; acceptable |
| GUI | Electron | `BrowserWindow` → `http://127.0.0.1:<port>`; `ELECTRON_RUN_AS_NODE` for Playwright subprocesses |
| Packaging | electron-builder (GUI), SEA (CLI) | replaces `deno compile` + `scripts/bundle-deno.ts` |

## 5. Phased workplan

### Phase 0 — Scaffolding (no behaviour change)

**Tasks:**
1. Create `package.json` with `engines.node`, deps (`hono`, `@hono/node-server`, `playwright`, `@playwright/test`, `yaml`), devDeps (`esbuild`, `tsx`, `@types/node`), scripts mirroring current `deno.json` tasks:
   - `dev` → `tsx watch main.ts serve`
   - `serve` / `install` / `run` → `tsx main.ts <cmd>`
   - `test` → `node --test` (after phase 4)
   - `lint` → eslint, `fmt` → prettier, `check` → `tsc --noEmit` (or keep deno for lint/fmt during transition — see note)
   - `compile` → esbuild + SEA build script (phase 5)
2. Add `tsconfig.json` (`module: nodenext` / `target: es2023`, `types: ["node"]`).
3. Replace bare alias imports (`"sqlite"`, `"fs"`, `"path"`, `"zlib"`) with `node:` specifiers across `ui/history.ts` and any other users.
4. Keep `deno.json` temporarily for `deno lint/fmt` parity; delete at the end of phase 7.

**Verification:** `npm install` succeeds; `npx tsc --noEmit` passes with current code apart from `Deno.*` errors (expected until phase 1).

### Phase 1 — Runtime API shim (`util/platform.ts` + mechanical replacements)

**Tasks:**
1. Create `util/platform.ts`: `os()` (win32→windows mapping), `env()` (`process.env`), `args()` (`process.argv.slice(2)`), `execPath()` (`process.execPath`), `cwd()`.
2. Create `util/fsx.ts` wrapping `node:fs/promises` with the Deno-shaped helpers used in the codebase (`readTextFile`, `writeTextFile`, `ensureDir`, `remove`, `makeTempFile` via `mkdtemp`+write, `realPath`, `chmod`, `symlink`, `readDir`, `stat`→`Deno.stat`-shaped `{ isFile, isDirectory, size }`).
3. Create `util/spawn.ts` wrapping `child_process.spawn` with the `Deno.Command` ergonomics used (piped stdout/stderr readers, `status.success`, `cmd.spawn()` + `child.status`).
4. Rewrite `util/exists.ts`: `Deno.errors.NotFound` → `(err as NodeJS.ErrnoException).code === "ENOENT"`.
5. Mechanically replace `Deno.*` call sites in `main.ts`, `runner/*.ts`, `ui/*.ts`, `util/deno-bin.ts` (→ delete in phase 6), `scripts/bundle-deno.ts` (→ delete in phase 6).
6. Replace `Deno.version` usage in `main.ts` (`process.versions.node`).

**Verification:** `npx tsc --noEmit` passes; `rg -n "Deno\." -g '!tests/**' -g '!docs/**' -g '!*.md'` returns only the files scheduled for deletion (deno-bin, bundle-deno).

### Phase 2 — HTTP server + SSE

**Tasks:**
1. Port `main.ts` server: `Deno.serve({ port, hostname }, handler)` → `serve({ fetch: handler, port, hostname })` from `@hono/node-server`, keeping the handler `(req: Request) => Response | Promise<Response>` signature and all routes (`/run`, `/install`, SSE endpoints, `/open-home`, `/codegen-status`, static UI files).
2. Verify SSE: `main.ts` uses `new TransformStream()` + a writer, with backpressure comments at lines 320–326. Node's web streams work under Hono's node-server; test that EventSource in `ui/dashboard.js` receives install/codegen progress live.
3. Desktop-mode env var: replace `DENO_SERVE_ADDRESS` with `CO2_RUNNER_DESKTOP_ADDRESS` (update `main.ts:30,48,103` and usage text).
4. Port `runner/co2.ts` JSON import: change `with { type: "json" }` import syntax to whatever esbuild/tsx accept (`assert`/`with` — check Node version support; alternatively import via `fs.readFile` + `JSON.parse` — simplest, prefer this for the bundled single file).

**Verification (manual, dev machine):**
- `npm run dev` → open UI, dashboard renders, history list loads (SQLite works).
- Start a YAML journey run from the UI; confirm live status updates arrive (SSE not buffered).
- `POST /run` with neither journey nor journeyContents returns 400 (mirror of `tests/integration/install_test.ts`).

### Phase 3 — Playwright subprocess strategy (highest risk)

**Current pattern** (3 call sites: `runner/install.ts:57`, `runner/codegen.ts:118`, `runner/run-script.ts:59` and `:246`):
```ts
new Deno.Command(denobin, ["run", "--allow-all", "--allow-scripts=npm:playwright", "npm:playwright", "install"|"codegen"|"test", ...])
```

**Target pattern:**
```ts
import { createRequire } from "node:module";
// resolve playwright's CLI entry once
const pwCli = createRequire(import.meta.url).resolve("playwright/cli.js") // or package-relative path
spawn(process.execPath, [pwCli, "install", "firefox", ...])
```
For the SEA/Electron packaged context where `node_modules` isn't on disk, `co2-runner install` (see phase 5) extracts/keeps a Playwright payload under `~/.co2-runner/` and subprocesses run via the Electron binary in `ELECTRON_RUN_AS_NODE=1` mode (in the GUI) or the extracted Node runtime (CLI).

**Tasks:**
1. Add `util/playwright-cli.ts` resolving the Playwright CLI path: dev → `node_modules`; packaged → `~/.co2-runner/payload/node_modules/playwright/cli.js`.
2. Rewrite the 4 spawn sites to use it (no `deno run`, no permission flags).
3. In-process usage (`runner/run.ts:10` `import { firefox } from "playwright"`; `runner/run-script.ts:130` `import { defineConfig, devices } from "@playwright/test"`) stays as-is — it runs in the main (Node) process.
4. Delete `util/deno-bin.ts` after confirming no references remain.

**Verification:**
- `npm run install` downloads Firefox (first run on clean machine / after `rm -rf ~/.cache/ms-playwright`).
- `npm run run` executes `journeys/example.yaml` end-to-end against branch.climateaction.tech, produces profile JSON + HAR in `~/.co2-runner/journey-artefacts/`, and non-zero mWh on a machine with power counters (macOS dev machine).
- Codegen: launch codegen mode from UI on a machine with a display; `.spec.js` file is produced.

### Phase 4 — Test migration (88 `Deno.test` calls)

**Tasks:**
1. Mechanical map `Deno.test({name, ignore, fn, sanitizeOps, sanitizeResources})` → `test(name, {ignore, ...}, fn)` from `node:test`. Note: `node:test` `ignore` is sync-only — precompute async conditions (e.g. `await isFirefoxInstalled()`, `canReach(...)`, `canMeasureEnergy()`) at module top-level before registering tests, as the current files already top-level `await`.
2. `sanitizeOps/sanitizeResources: false` have no node:test equivalent — drop them (node:test doesn't count ops).
3. Replace `jsr:@std/assert` imports (`assert`, `assertEquals`, `assertStringIncludes`) with `node:assert` (`strict`) — `assertStringIncludes` → manual `str.includes()` assert.
4. Port `tests/integration/run-script_journey_test.ts` **including** the `canMeasureEnergy()` Linux `perf_event_paranoid` skip (currently lines ~22–36).
5. Update `package.json` test script: `node --test tests/` (or `tsx --test` if `.ts` extension imports require it).

**Verification:** `npm test` passes locally with the same pass/skip profile as `deno test --allow-all` does today (2 integration tests skipped when Firefox/network/energy unavailable).

### Phase 5 — CLI binary (Node SEA)

**Tasks:**
1. `scripts/build-cli.mjs`: esbuild bundle `main.ts` → `dist/co2-runner.bundle.js` (platform-neutral, `--format=cjs`, inline JSON data — see phase 2 task 4).
2. SEA config JSON per target (bun-style matrix not needed — build on native runners):
   - `mainScript`: the bundle
   - `output`: `dist/co2-runner-<target>`
   - `executable`: the runner's own Node binary (or a downloaded target Node binary for cross-builds; version must match, `useCodeCache: false`, `useSnapshot: false`)
3. Windows: the `explorer`-open branch (`main.ts:520`) uses `platform.os()` mapping — covered by phase 1.
4. Known limitation to accept: Node SEA on macOS x64 is unsupported by Node's CI — **already dropped** Intel-mac from our release matrix (Oct 2026), so no regression for us.
5. Decide Playwright-in-CLI story: keep Playwright OUT of the binary. `co2-runner install` must ensure a Playwright payload exists under `~/.co2-runner/` (download a prebuilt tarball from our releases, or `npm install playwright` into `~/.co2-runner/payload/` using the extracted Node runtime). Document the UX in `--help`.

**Verification:** `node scripts/build-cli.mjs` on macOS; `./dist/co2-runner-aarch64-apple-darwin --help` prints usage; `./dist/co2-runner-aarch64-apple-darwin run journeys/example.yaml` completes a journey (needs the Playwright payload step).

### Phase 6 — GUI app (Electron)

**Tasks:**
1. `electron/main.ts`: spawn (or import in-process) the co2-runner server on a dynamic port; `BrowserWindow.loadURL("http://127.0.0.1:<port>")`. Env var `CO2_RUNNER_DESKTOP_ADDRESS` set for the server child.
2. Playwright subprocesses from within the packaged app use the Electron binary: `spawn(process.execPath, [pwCli, ...], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } })` — keep the `runAsNode` fuse enabled.
3. Replace `scripts/bundle-deno.ts` entirely: electron-builder config for `mac` (arm64 only, target `dmg`), producing `dist/CO2Runner.dmg` with drag-to-install (electron-builder DMG does this natively — no `hdiutil` staging code needed).
4. Ad-hoc signing parity: electron-builder `mac.identity: null` ≈ today's ad-hoc codesign. Notarisation is out of scope (flagged to user separately).
5. App bundle still needs Firefox on first run — `/install` endpoint flow is unchanged.

**Verification:** `npx electron .` launches the app window with working UI; a full journey runs from the GUI and results appear in history (SQLite); `npx electron-builder --mac dmg` produces `dist/CO2Runner.dmg` that mounts, drags to /Applications, and launches on a clean Apple Silicon Mac.

### Phase 7 — CI + release pipeline port

**Port `.github/workflows/build.yml` preserving every October-2026 fix:**

1. `actions/setup-node` (pin LTS) replaces `denoland/setup-deno`; install Playwright Firefox before tests; tests under `xvfb-run -a node --test` (or `xvfb-run -a npm test`).
2. `build-cli` job: native matrix — keep current targets (macos-14/aarch64, ubuntu-22.04, windows-latest; Intel mac already dropped). Each runs `node scripts/build-cli.mjs` + `--help` smoke test.
3. `build-desktop` job (macos-14): `npx electron-builder --mac dmg`; upload `dist/CO2Runner.dmg` as artifact named `CO2Runner-aarch64-apple-darwin.dmg` (keeps release asset naming).
4. `release` job: unchanged logic — `softprops/action-gh-release` with `files: artifacts/*`, `generate_release_notes: true`, gated on `refs/tags/v*` OR `refs/tags/2026*` prefixes. **Do not lose this trigger.**
5. Delete `deno.json`, `deno.lock`; remove Deno references from `README.md`, `docs/` (update, don't delete ADRs — add a new ADR-00X "migrate runtime to Node" superseding the Deno-bundling ADR-004).

**Verification:** push a `2026-1` tag (or a test tag matching `2026*`); the run goes green end-to-end and a GitHub Release is created with `CO2Runner.dmg` + CLI binaries attached.

### Phase 8 — Docs & cleanup

1. Update `README.md` quickstart (npm instead of deno tasks; install.sh references).
2. New ADR: "Runtime migration: Deno → Node" (context: Cloudflare announcement link; decision: Node + Electron + SEA; consequences incl. Playwright-payload install step, ~100 MB Electron app vs 75 MB Deno DMG).
3. Update `docs/architecture.md` C4 diagrams (Deno CLI bundling → Electron/SEA).
4. Remove `util/deno-bin.ts`, `scripts/bundle-deno.ts`, `.playwright-cli/` cruft if unused.

## 6. Accepted regressions / tradeoffs

- App size: Electron ~100 MB+ vs ~75 MB Deno DMG.
- Node SEA is stability 1.1 (active development) — pin Node version per release.
- No Intel-mac CLI (already dropped from releases in Oct 2026).
- Ad-hoc signing only — Gatekeeper warning remains (pre-existing).
- Extra first-run step for CLI users: Playwright payload install (Deno `--include npm:playwright` embedded it in one binary).

## 7. Acceptance criteria (definition of done)

- [ ] `npm test` green on macOS dev machine with same skip-profile as Deno today
- [ ] `npm run serve` UI works: dashboard, history (SQLite), SSE live updates
- [ ] YAML journey + `.spec.js` journey run end-to-end with energy figures on macOS
- [ ] Codegen produces `.spec.js` from a graphical session
- [ ] `co2-runner install` fetches Firefox (and Playwright payload, packaged context)
- [ ] CLI SEA binaries build on all 3 CI runners with passing `--help` smoke test
- [ ] `CO2Runner.dmg` builds in CI, mounts, installs, launches on Apple Silicon
- [ ] Tag `2026-1` produces a complete GitHub Release with DMG + CLI assets
- [ ] No `Deno.` references remain in `src` (only in docs/ADRs as history)
