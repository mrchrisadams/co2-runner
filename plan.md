# Plan: `co2-runner` — Deno CLI for Playwright energy measurement

## Goal

A Deno-based CLI binary that drives Playwright's bundled Firefox through a
YAML-defined user journey, records energy consumption via Firefox's Mozilla
Profiler power counters, and presents results in a native desktop webview UI
(via `deno desktop`) — or prints them to stdout when invoked headlessly.

Based on the design document at `cruft/Building a Deno CLI Tool.md` and the
upstream repo <https://github.com/mrchrisadams/playwright-co2>.

---

## Design summary (from the source document)

- Firefox's built-in Mozilla Profiler records per-interval energy in
  picoWatt-hours across parent + child processes via `MOZ_PROFILER_*` env vars.
  After the run, a `.profile` JSON is dumped and the `power` counters are summed
  to produce mWh/Joules.
- Deno v2.9's `deno desktop` feature turns `Deno.serve()` + system webview into
  a single redistributable binary per platform.
- Playwright's bundled Firefox (~120–200 MB) is too large to embed in a compiled
  binary, so the tool ships as a binary that downloads Firefox on first run via
  a `co2-runner install` subcommand.
- `deno desktop` is only available in Deno >= 2.9.0; **this machine currently
  has Deno 2.8.0**, so the desktop UI build is blocked until Deno is upgraded
  (see Phase 4). All earlier phases work on 2.8.0.
- `Deno.serve()` falls back to serving a browser tab in dev / older Deno — so
  the UI layer can still be built and exercised before the desktop binary works.

---

## Target project layout

```
co2-runner/
├── deno.json               # config, npm deps, desktop config, tasks
├── deno.lock
├── main.ts                 # CLI subcommand router + HTTP server
├── types.ts                # shared types
├── runner/
│   ├── install.ts          # `co2-runner install` — playwright install firefox
│   ├── run.ts              # `co2-runner run <journey.yaml>` — drives browser
│   └── energy.ts           # parses Firefox profile JSON -> energy figures
├── ui/
│   ├── components.ts        # dashboard HTML (no framework)
│   ├── results.ts           # ResultsStore + SSE helper
│   └── history.ts          # SQLite history via node:sqlite
├── journeys/
│   └── example.yaml         # example journey (Branch Magazine)
├── .gitignore              # ignore journey-artefacts/, node_modules, etc.
├── plan.md                 # this file
└── README.md               # usage
```

---

## Phases

### Phase 0 — Repo scaffolding

- [ ] Create `deno.json` with imports (`playwright`, `yaml`, `node:zlib`,
      `node:fs/promises`, `node:path`, `node:sqlite`), permissions, tasks
      (`dev`, `build`, `test`), and the `desktop` window config.
- [ ] Create `.gitignore` with `journey-artefacts/`, `history.db`, `.deno/`.
- [ ] Create `README.md` with one-paragraph overview and quickstart.
- [ ] Initialise empty stub modules listed in the project layout so the phases
      below can fill them in.

**Verify:** `deno task` lists the tasks; `deno check .` exits 0 once stubs land.

---

### Phase 1 — Types & journey config

- [ ] `types.ts`: `JourneyConfig`, `Step` (discriminated union for
      goto/click/fill/scroll/wait/waitForSelector), `JourneyResult`.
- [ ] `journeys/example.yaml`: copy the Branch Magazine journey from the design
      doc so we always have something to run.

**Verify:** `deno check types.ts` succeeds; `cat journeys/example.yaml` parses
visually.

---

### Phase 2 — Energy profile parser (`runner/energy.ts`)

- [ ] Implement
      `parseEnergyProfile(profilePath, journeyName): Promise<JourneyResult>`:
  - Read file, detect gzip magic (`0x1f 0x8b`), gunzip via `node:zlib` if
    needed.
  - Collect `profile.counters` + `profile.processes[].counters`, filter
    `category === "power"`.
  - Sum every sample's value `Math.max(0, v)` across all counters → total pWh.
  - Convert: `mWh = pWh / 1e9`; `joules = pWh * 3.6e-9`.
  - Return `{ name, mWh, joules, timestamp, profilePath }`.
- [ ] Add a small `deno test` that feeds a synthetic fixture (JSON with one
      power counter + a couple of samples) and checks the conversion factor.

**Verify:** `deno test runner/energy_test.ts` passes on a synthetic profile.

---

### Phase 3 — Install subcommand (`runner/install.ts`)

- [ ] Implement `installBrowsers()`:
  - `Deno.Command("deno", ["run", "--allow-all", "npm:playwright", "install", "firefox"])`.
  - Inherit stdout/stderr, exit 1 on failure, print success line.
- [ ] Add `--allow-scripts=npm:playwright` note to README because Playwright's
      npm lifecycle scripts must run during install.

**Verify:** `deno task install` (or `deno run --allow-all runner/install.ts`)
succeeds; `ls ~/Library/Caches/ms-playwright/firefox-*/` shows Firefox.

---

### Phase 4 — Runner (`runner/run.ts`)

- [ ] Implement `runJourney(journeyPath, store): Promise<JourneyResult>`:
  - Parse YAML, build `MOZ_PROFILER_*` env (STARTUP=1, ENTRIES=10000000,
    INTERVAL=10, FEATURES=js,stack,cpu,threads,power,
    THREADS=GeckoMain,Compositor,Renderer,
    SHUTDOWN=`journey-artefacts/<slug>-profile.json`).
  - Launch Firefox via Playwright with that env.
  - Open context with `recordHar` to `journey-artefacts/<slug>.har`.
  - Execute steps via `executeStep` dispatcher.
  - Close context, close browser (flushes HAR + profile).
  - Call `parseEnergyProfile` and push result to `store`.
- [ ] `executeStep` supports goto, click, fill, scroll (human + non-human),
      wait, waitForSelector. Human scroll = randomised 120–240px steps with
      40–180ms pauses.
- [ ] Respect `config.headless` (default false; warn if true, because headless
      changes the power profile).
- [ ] Emit progress events to `store` so the UI can show "running step 3/7..." —
      a `JourneyProgress` type in `types.ts`.

**Verify:** `deno run --allow-all main.ts run journeys/example.yaml` (in CLI
mode) prints an Energy Report with non-zero mWh (macOS). Inspect
`journey-artefacts/` for the `.profile` and `.har`.

---

### Phase 5 — UI server & ResultsStore (`ui/results.ts`, `ui/components.ts`)

- [ ] `ResultsStore`: holds `JourneyResult[]`, `subscribe(cb)`, `push(result)`,
      optional `progress` channel.
- [ ] `renderDashboard()` returns the inline HTML from the design doc (dark
      theme, SSE listener, run form).
- [ ] `main.ts` wires up `Deno.serve()` routes:
  - `GET /` → dashboard HTML
  - `GET /events` → SSE stream (pushes existing results, subscribes to new)
  - `POST /run` body `{ journey }` → kicks off `runJourney` non-blocking,
    returns `{ started: true }`
- [ ] Pure CLI path: if no `DENO_SERVE_ADDRESS` env (i.e. running as
      `dify run main.ts install`), after `run` print mWh and joules, then
      `Deno.exit(0)`.

**Verify:** `deno task dev` (or `deno run --allow-all --unstable main.ts serve`)
opens a tab/window; visiting `/events` keeps the connection open; POSTing `/run`
streams a result card.

---

### Phase 6 — History persistence (`ui/history.ts`)

- [ ] Use `node:sqlite` (`DatabaseSync`, available in Deno 2.2+).
- [ ] Schema: `runs(id, name, mWh, joules, timestamp, profile)`.
- [ ] On every `runJourney` completion, `INSERT` the result.
- [ ] UI endpoint `GET /history` returns the last N runs as JSON; render them at
      dashboard load so previous sessions are visible.
- [ ] DB path: `~/.co2-runner/history.db` (or `CO2_RUNNER_DB` env if set).
- [ ] **Note in README** why Deno KV is avoided (stuck in beta since May 2025;
      Deno team signalling it may be replaced).

**Verify:** Two back-to-back runs; restart the server; `/history` shows both.

---

### Phase 7 — Build & distribution

- [x] Upgrade Deno to >= 2.9 on this machine (running Deno 2.9.5).
- [x] Set deno.json `tasks.build` and `tasks.compile` / `tasks.desktop` /
      `tasks.compile:all` / `tasks.desktop:all`.
- [x] Cross-compile CLI binary for `aarch64-apple-darwin` (host) via
      `deno task compile` — 76 MB Mach-O arm64 binary; `--help`, `serve`
      smoke-tested.
- [x] Cross-compile desktop app bundle for `aarch64-apple-darwin` via
      `deno task desktop` → `dist/CO2Runner.app` (76 MB); process launches and
      runs `laufey_webview` with the embedded UI.
- [ ] Cross-compile remaining targets (x86_64-apple-darwin,
      x86_64-unknown-linux-gnu, x86_64-pc-windows-msvc) — wired in
      `.github/workflows/build.yml`; not yet run locally.
- [x] Document first-run user flow in README: `./co2-runner install` then
      `./co2-runner run journeys/my.yaml`.
- [x] Write a GitHub Actions workflow (`build.yml`) that builds all four CLI
      targets + macOS desktop bundle and uploads release assets on git tag.

**Verify:** Downloaded binary on a fresh machine: `install` works, `run` works,
UI opens.

---

### Phase 8 — Polish (optional, post-1.0)

- [ ] CO2 conversion layer via
      [CO2.js](https://github.com/thegreenwebfoundation/co2.js).
- [ ] Compare two runs side-by-side in the UI (A/B test mode).
- [ ] Aggregate multiple repeat runs into median + stdev.
- [ ] Export results as CSV/JSON from the UI.
- [ ] Bundled Chromium webview option (`--bundle-webview` to `deno desktop`) for
      pixel-identical rendering.

### Phase 9 — Codegen script support (`runner/run-script.ts`)

- [x] `runner/run-script.ts` — `runScript(scriptPath, store, opts)`: spawns
      `deno run -A --allow-scripts=npm:playwright npm:@playwright/test test
      <script> --config <generated>`,
      inherits `MOZ_PROFILER_*` env, parses the resulting profile JSON via the
      existing `parseEnergyProfile()`.
- [x] Generated `playwright.config.ts` per run, written to
      `<artefacts-dir>/<slug>-playwright.config.ts`, deleted after the run. Uses
      `use.contextOptions.recordHar` (NOT `use.recordHar` — that's a per-test
      fixture option, not a config-level one) to capture a full HAR with
      response bodies embedded.
- [x] Single-test validation via `playwright test --list` — rejects >1 `test()`
      per file with a clear error. Multi-test files fragment energy data across
      browser sessions and are out of scope for this phase; users split them
      into one test per file.
- [x] `runJourney()` dispatcher in `runner/run.ts` keys off file extension:
      `.yaml/.yml` → existing YAML pipeline; `.js/.mjs/.ts` → `runScript()`. No
      changes to main.ts or the CLI subcommand — both formats pass through
      transparently.
- [x] `POST /run` upgrade: body field `journeyContents` (new) replaces
      `journeyYaml` (kept as legacy alias). The temp file's suffix is derived
      from `journeyName`'s extension so the dispatcher routes correctly.
      Uploaded scripts are written to
      `~/.co2-runner/uploaded-journeys/<ts>-<name>` (not the OS tmp dir) to
      avoid Playwright's `--list` walking system temp folders and tripping
      EPERM.
- [x] `journeys/example.spec.js` — codegen-style single-test script mirroring
      `journeys/example.yaml`'s Branch Magazine journey.
- [x] UI file picker `accept` attribute gains `.js,.mjs,.ts`. The dashboard
      sends the uploaded file's name as `journeyName` so the server dispatcher
      picks the right pipeline.
- [x] Tests: `tests/runner/run-script_test.ts` (4 unit tests for
      `isScriptFile` + extension list),
      `tests/integration/run-script_journey_test.ts` (2 tests: end-to-end run,
      multi-test rejection).

**Verified end-to-end via the dev server's `POST /run`:**

```
POST /run {
  journeyContents: <contents of journeys/example.spec.js>,
  journeyName:    "example.spec.js"
}
→ {"started": true}
→ SSE: firefox-status + progress (validate, run) + result
  result.name         = "example.spec.js"
  result.mWh          = 2.3059
  result.joules       = 8.3015
  result.profilePath  = ~/.co2-runner/journey-artefacts/example-spec-js-profile.json
  ~/.co2-runner/journey-artefacts/example-spec-js.har (797 KB, full HAR with bodies)
```

**Out of scope (deferred):**

- [ ] Multi-test files — would fragment energy across browser sessions; out of
      scope for v1.
- [ ] Custom Playwright reporter that surfaces in-test assertion failures with
      line numbers via SSE. Currently the failure is reported via the
      subprocess's non-zero exit code, which gives a generic "journey script
      failed (exit code N)" message + the full Playwright trace is in server
      stderr.

### Phase 10 — In-app codegen (`runner/codegen.ts`)

Users can now record a journey directly from co2-runner, without leaving the app
to run `npx playwright codegen` in a terminal. Implementation spawns
Playwright's codegen as a subprocess — same approach as the existing install/run
subprocess pattern.

- [x] `runner/codegen.ts` — `launchCodegen({ startUrl, outputPath })` spawns
      `deno run -A --allow-scripts=npm:playwright npm:playwright
      codegen --browser=firefox --target=playwright-test --output=<path>
      <url>`.
      The Inspector + Firefox windows appear directly on the user's desktop.
      Streams stdout lines as `CodegenProgress` events via the optional
      `onProgress` callback.
- [x] `hasGraphicalDisplay()` — synchronously checks the env for DISPLAY /
      WAYLAND_DISPLAY on Linux; always true on macOS + Windows. Used to fail
      fast with a clear message rather than letting Playwright crash with an
      opaque "browserType.launch: Executable doesn't exist" inside an
      unreachable webview backend.
- [x] `buildCodegenFilename(startUrl)` — formats as `<timestamp>-<host>.spec.js`
      (colons in ISO timestamps replaced with dashes for filename safety on
      Windows).
- [x] CLI subcommand: `co2-runner codegen <url> [output.spec.js]`.
      Auto-generates the output path under `~/.co2-runner/recorded-journeys/` if
      not supplied. Gates on Firefox installed + graphical display; refuses with
      a clear error message otherwise.
- [x] HTTP endpoints:
  - `GET /codegen-status` →
    `{ canCodegen, firefoxInstalled,
    hasGraphicalDisplay, codegenInProgress }`
    — used by the UI to decide whether to enable the Record button.
  - `POST /codegen` with body `{ startUrl }` → spawns the codegen subprocess in
    the background, returns `{ started, outputPath }`. Gates on Firefox +
    display, returns 409 with a helpful message otherwise. Progress + completion
    events flow through the SSE stream as `codegen` events.
- [x] UI: 🔴 Record button next to the file picker. Opens a modal asking for the
      start URL, then fires `POST /codegen`. The button is disabled until
      `firefoxInstalled && hasGraphicalDisplay` (user feedback: shows pulsing
      animation while recording in progress). When the user closes the
      Inspector, a `complete` event arrives with the saved path; the user
      manually picks the file via the existing file picker to run it.
- [x] `CodegenProgress` type added to types.ts; `ResultsStore` gains
      `codegenProgress()` + `codegenInProgress` state + new 'codegen' event
      variant in `StoreEvent`.

**Verified end-to-end via the desktop app:**

```
$ open dist/CO2Runner.app
$ curl http://127.0.0.1:<port>/codegen-status
{"canCodegen":true,"firefoxInstalled":true,"hasGraphicalDisplay":true,"codegenInProgress":false}

$ curl -X POST http://127.0.0.1:<port>/codegen -d '{"startUrl":"https://example.com"}'
{"started":true,"outputPath":"~/.co2-runner/recorded-journeys/2026-...-example.com.spec.js"}

# (Inspector + Firefox windows open on desktop)
# (user clicks around, closes Inspector)

$ ls ~/.co2-runner/recorded-journeys/2026-...-example.com.spec.js
$ cat ~/.co2-runner/recorded-journeys/2026-...-example.com.spec.js
import { test, expect } from '@playwright/test';
test('test', async ({ page }) => {
  await page.goto('https://example.com/');
});

# Run the recorded journey through co2-runner:
$ ./co2-runner run ~/.co2-runner/recorded-journeys/2026-...-example.com.spec.js
=== Energy Report: 2026-...-example.com ===
1.5470 mWh  (5.5692 J)
```

Tests:

- `tests/runner/codegen_test.ts` (6 unit tests): filename slug format, hostname
  extraction, fallback for non-URL input, filename-safe timestamps,
  `hasGraphicalDisplay()` return type + macOS value.
- `tests/integration/codegen_test.ts` (4 tests): `GET /codegen-status` shape,
  `POST /codegen` 400 paths (missing body / missing startUrl), `POST /codegen`
  200-or-409 gate behaviour.

### Phase 11 — Bundle Deno CLI into desktop app (`scripts/bundle-deno.ts`)

The desktop app's codegen / install / `.spec.js`-runner features spawn `deno` as
a subprocess (via `Deno.Command`). When launched via Finder, macOS gives the app
a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that doesn't include
`~/.deno/bin`. The spawn fails with `Failed to spawn 'deno': entity not found`.

The fundamental conflict: the desktop binary embeds the Deno _runtime_ as a
dylib/blob, but not the Deno _CLI_ — they're different artifacts. Codegen +
install need the CLI (because they shell out to `npm:playwright` /
`npm:@playwright/test` which Deno's CLI loads, not the in-process runtime).

Fix: embed a real standalone `deno` CLI binary inside the .app bundle at build
time. End-users download a self-contained DMG and never need to run
`curl ... | sh` themselves.

- [x] `scripts/bundle-deno.ts` — build-time script invoked by
      `deno task desktop` after `deno desktop` produces the bare .app. Downloads
      `https://dl.deno.land/release/v<version>/deno-<triple>.zip`, unzips into
      `dist/CO2Runner.app/Contents/Resources/deno/deno`, `chmod 0755`. Platform
      detected from `Deno.build.{os,arch}`; errors clearly on
      non-macOS/non-Linux/non-Windows triples. Defaults to the running Deno
      version (`Deno.version.deno`) if no explicit version is passed.
- [x] Re-codesign the bundle ad-hoc with `--deep` after embedding, because
      `deno desktop`'s original signature was computed before the bundled binary
      was added. Without re-sign, macOS would refuse to launch the parent
      process (or show a "damaged" warning).
- [x] Regenerate the `.dmg` after bundling. `deno desktop` creates the initial
      DMG with pre-bundle contents; without regeneration, the shipped DMG would
      still have the bug. Uses `hdiutil create` with a staging directory
      containing the .app + `/Applications` symlink for drag-to-install.
- [x] `util/deno-bin.ts` `findDenoBinary()` updated: checks the bundled path
      first (`<execPath>/../Resources/deno/deno` — derived from
      `Deno.execPath()` which returns
      `.../CO2Runner.app/Contents/MacOS/laufey_webview`). Falls back to
      `$DENO_BIN`, `~/.deno/bin/deno`, Homebrew, distro paths, then bare `deno`
      (PATH lookup).
- [x] `DenoNotFoundError` message updated to point at the bundled-binary
      fallback as option 1, then `curl ... | sh`, then `DENO_BIN` override.
- [x] `.gitignore` excludes `bundled-deno/` (just defensive — the actual bundled
      binary lives inside `dist/` which is already ignored).
- [x] Tests: `tests/util/deno-bin_test.ts` +2 tests covering bundled-path-first
      priority and `bundledDenoPath()` returning null in dev mode.

**Verified end-to-end (Finder-launched desktop app, the user's failure
scenario):**

```
$ open dist/CO2Runner.app
$ curl http://127.0.0.1:<port>/codegen-status
{"canCodegen":true,...}

$ curl -X POST /codegen -d '{"startUrl":"https://example.com"}'
{"started":true,"outputPath":"...example.com.spec.js"}

$ ps
62208 .../CO2Runner.app/Contents/Resources/deno/deno   ← bundled binary
62212 .../firefox-1538/firefox/Nightly.app/.../firefox ← Playwright's Firefox
```

Previously: `Failed to spawn 'deno': entity not found` immediately.

**Size cost:** DMG grows from 36 MB to 75 MB (~77 MB of bundled deno CLI).
Trade-off is one-time download cost vs zero-setup for non-technical end-users.

## Known caveats to track

1. **`deno desktop` requires Deno >= 2.9.0.** Now satisfied (running 2.9.5).
2. **Power profiling platform support**: works on macOS (Apple Silicon + Intel)
   and Windows. Linux needs `perf_event_paranoid <= 1` plus a kernel supporting
   `perf`.
3. **Firefox is not embedded in the binary** (~120–200 MB). Always installed via
   the `install` subcommand.
4. **Playwright via Deno**: pin Playwright version, test on each Deno upgrade
   (there were timeout regressions in Deno 2.6.0). Use
   `--allow-scripts=npm:playwright` for lifecycle scripts.
5. **`--unsafe-proto` required by Playwright under Deno 2.9+**: Deno disabled
   `Object.prototype.__proto__` writes by default; Playwright leans on it for
   its internal object model and silently hangs without the flag. Baked into the
   compile/desktop tasks.
6. **Journey selectors are site-version-specific**: `journeys/example.yaml`
   matches Branch's Issue 9 layout (`role=link[name='Issue 9']`, not
   `'Go to issue'`). Re-check before public demos.
7. **Headless mode**: keep `headless: false` by default; documented that
   headless skews the power profile.
8. **Deno KV avoided**: stuck in beta per Deno's May 2025 "Greatly Exaggerated"
   post; use `node:sqlite` instead.
9. **macOS screen capture**: capturing the desktop app window with
   `screencapture` requires Screen Recording permission for the launching
   terminal in System Settings → Privacy & Security.

## Done when

- `co2-runner install` → installs Firefox.
- `co2-runner run journeys/example.yaml` → executes the journey, emits energy
  figures to stdout, and stores them in `~/.co2-runner/history.db`.
- `deno task dev` opens a UI showing live SSE-fed result cards plus history.
- `co2-runner run` from inside the desktop binary streams results to the
  webview.
- Compiled binaries for all four targets run end-to-end on a fresh machine.
