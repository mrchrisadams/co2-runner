# Architecture

This document describes the high-level architecture of `co2-runner` — how the
major components fit together, where state lives, and how the two modes (CLI
binary + desktop app) share a server-side core.

## Components at a glance

```mermaid
graph TB
    subgraph "User surfaces"
        CLI["./co2-runner<br/>(compiled CLI binary)"]
        DESKTOP["dist/CO2Runner.app<br/>(deno desktop bundle)"]
        DEV["deno task serve<br/>(dev mode, browser tab)"]
    end

    subgraph "HTTP server (main.ts)"
        ROUTES["Route handler<br/>/ /firefox-status /install<br/>/codegen-status /codegen<br/>/run /events /history"]
    end

    subgraph "Journey execution (runner/)"
        RUN["run.ts<br/>YAML dispatcher"]
        RUNSCRIPT["run-script.ts<br/>.spec.js codegen-script runner"]
        ENERGY["energy.ts<br/>Firefox profile → mWh/J"]
        CODEGEN["codegen.ts<br/>playwright codegen subprocess"]
        INSTALL["install.ts<br/>playwright install firefox"]
    end

    subgraph "Dashboard (ui/)"
        COMP["components.ts<br/>HTML shell + inlined JS"]
        DASHJS["dashboard.js<br/>SSE listener + UI logic"]
    end

    subgraph "Persistence + paths"
        RESULTS["results.ts<br/>in-memory store + SSE broadcast"]
        HISTORY["history.ts<br/>SQLite via node:sqlite"]
        PATHS["paths.ts<br/>~/.co2-runner/* resolution"]
        DENOBIN["util/deno-bin.ts<br/>findDenoBinary()"]
    end

    subgraph "External"
        FF["Playwright's bundled Firefox<br/>(~150MB, downloaded via install)"]
        DENO["standalone Deno CLI<br/>(bundled in desktop app, or system-installed)"]
        PWTEST["@playwright/test runner<br/>(invoked via deno run npm:... for .spec.js)"]
        PWCODEGEN["playwright codegen<br/>(invoked via deno run npm:... for recording)"]
        SITE["User's target website"]
    end

    CLI --> ROUTES
    DESKTOP --> ROUTES
    DEV --> ROUTES

    ROUTES --> RESULTS
    ROUTES --> RUN
    ROUTES --> CODEGEN
    ROUTES --> INSTALL
    ROUTES --> HISTORY
    ROUTES --> COMP

    COMP -.->|inlines at build time| DASHJS

    RUN -->|".yaml / .yml"| RUN
    RUN -->|".js / .mjs / .ts"| RUNSCRIPT
    RUNSCRIPT --> ENERGY
    RUN --> ENERGY
    RUN --> FF
    RUNSCRIPT --> PWTEST
    CODEGEN --> PWCODEGEN
    INSTALL --> DENO

    RUN --> PATHS
    RUNSCRIPT --> PATHS
    CODEGEN --> PATHS
    RESULTS --> HISTORY
    HISTORY --> PATHS

    DENOBIN -->|locates| DENO
    RUNSCRIPT --> DENOBIN
    CODEGEN --> DENOBIN
    INSTALL --> DENOBIN

    PWTEST --> FF
    PWCODEGEN --> FF
    FF -->|drives| SITE
```

## Mode 1: Compiled CLI binary

`deno task compile` produces a single ~80 MB Mach-O executable (`./co2-runner`)
that bundles the Deno runtime + all TypeScript + npm dependencies (Playwright,
YAML parser, node:sqlite). The user runs subcommands directly:

```mermaid
sequenceDiagram
    actor User
    participant CLI as ./co2-runner
    participant DenoRT as Embedded Deno runtime
    participant Runner as runner/run.ts
    participant Firefox as Playwright Firefox
    participant Site as Target website

    User->>CLI: ./co2-runner run journeys/example.yaml
    CLI->>DenoRT: parse args + load main.ts
    DenoRT->>Runner: runJourney(path, store)
    Runner->>Runner: read YAML, build MOZ_PROFILER_* env
    Runner->>Firefox: firefox.launch({ env })
    Firefox->>Site: page.goto(...), click, scroll, ...
    Site-->>Firefox: render responses
    Firefox-->>Runner: browser.close() → MOZ_PROFILER_SHUTDOWN writes profile.json
    Runner->>Runner: parseEnergyProfile() → sum power counters
    Runner-->>CLI: JourneyResult { mWh, joules }
    CLI->>History: insert(result) into ~/.co2-runner/history.db
    CLI-->>User: "2.46 mWh (8.86 J)"
```

No subprocess spawn is needed for `.yaml` journeys — the embedded Deno runtime
imports `playwright` directly and calls `firefox.launch()` in-process.

## Mode 2: Desktop app (`deno task desktop`)

`deno task desktop` produces `dist/CO2Runner.dmg` — a macOS app bundle
containing:

```mermaid
graph LR
    subgraph "CO2Runner.app"
        subgraph "Contents/MacOS/"
            LW["laufey_webview<br/>(system webview host)"]
            LIBRT["libruntime.dylib<br/>(Deno runtime)"]
        end
        subgraph "Contents/Resources/"
            BUNDLED["deno/<br/>bundled standalone Deno CLI<br/>(~77 MB)"]
        end
    end

    LW -->|loads| LIBRT
    LIBRT -->|imports| MAIN["main.ts<br/>(route handler + Deno.serve)"]
    MAIN -->|spawns subprocess via<br/>findDenoBinary()| BUNDLED
```

When the user double-clicks the app:

1. `laufey_webview` launches (the system webview's host process).
2. `laufey_webview` loads `libruntime.dylib` — the embedded Deno runtime that
   runs the co2-runner HTTP server (`Deno.serve()` in `main.ts`).
3. `laufey_webview` opens a native window and points it at the HTTP server (the
   address is set via `DENO_SERVE_ADDRESS`).
4. The dashboard HTML + inlined `dashboard.js` loads in the webview.
5. The user clicks "Record" / "Install" / "Run" → the server spawns a subprocess
   using the **bundled** `deno` binary at `Contents/Resources/deno/deno` (see
   ADR 004 for why this matters).

## Journey formats + dispatcher

Two supported journey formats, routed by file extension via the dispatcher in
`runner/run.ts`:

```mermaid
flowchart TD
    REQ["POST /run { journeyContents, journeyName }<br/>OR<br/>./co2-runner run <path>"]
    REQ --> TMP["Write uploaded contents to<br/>~/.co2-runner/uploaded-journeys/<ts>-<name>"]
    TMP --> DISP{"runJourney(path)<br/>isScriptFile(path)?"}

    DISP -->|".yaml / .yml"| YAML["YAML pipeline<br/>(runner/run.ts)"]
    DISP -->|".js / .mjs / .ts"| JS["Script pipeline<br/>(runner/run-script.ts)"]

    YAML --> Y_LN["firefox.launch({ env: MOZ_PROFILER_* })"]
    Y_LN --> Y_RUN["loop: executeStep(page, step)"]
    Y_RUN --> Y_CLOSE["context.close() → HAR flushed<br/>browser.close() → profile written"]
    Y_CLOSE --> PARSE["parseEnergyProfile()"]

    JS --> VALIDATE["playwright test --list<br/>→ reject if >1 test()"]
    VALIDATE --> CONFIG["Generate playwright.config.ts<br/>with use.contextOptions.recordHar"]
    CONFIG --> SPAWN["deno run npm:@playwright/test test<br/>--config <generated> --reporter=line<br/>(inherits MOZ_PROFILER_* env)"]
    SPAWN --> CLOSE2["subprocess exits<br/>Firefox writes profile on shutdown"]
    CLOSE2 --> PARSE

    PARSE --> RESULT["JourneyResult { mWh, joules, ... }"]
    RESULT --> HISTORY["~/.co2-runner/history.db (SQLite)"]
    RESULT --> SSE["broadcast 'result' event via SSE"]
    RESULT --> ART["~/.co2-runner/journey-artefacts/<slug>-profile.json + .har"]
```

Both pipelines produce the same `JourneyResult` shape, write artefacts to the
same `~/.co2-runner/journey-artefacts/` directory, and persist to the same
`~/.co2-runner/history.db`. Downstream tooling that consumes the HAR or the
history doesn't need to know which format produced it.

## Codegen flow (recording a new journey)

```mermaid
sequenceDiagram
    actor User
    participant UI as co2-runner dashboard
    participant Server as main.ts HTTP server
    participant Codegen as runner/codegen.ts
    participant Deno as Bundled deno CLI
    participant PW as playwright codegen subprocess
    participant Inspector as Playwright Inspector window
    participant Firefox as Playwright Firefox
    participant Site as Target website

    User->>UI: Click 🔴 Record, enter start URL
    UI->>Server: POST /codegen { startUrl }
    Server->>Server: hasFirefoxInstalled() && hasGraphicalDisplay()?
    Server->>Codegen: launchCodegen({ startUrl, outputPath })
    Codegen->>Codegen: findDenoBinary() → bundled path
    Codegen->>Deno: spawn `deno run npm:playwright codegen ...`
    Deno->>PW: cli.js entrypoint
    PW->>Firefox: launchFirefox() (no MOZ_PROFILER_* — recording only)
    Firefox->>Site: page.goto(startUrl)
    PW->>Inspector: open Inspector window alongside Firefox

    User->>Inspector: click around the site
    Inspector->>Firefox: replay actions, build script
    Firefox->>Site: drive the actual site

    User->>Inspector: close the Inspector window
    PW->>Codegen: subprocess exits, --output=<file> written
    Codegen->>Server: CodegenProgress { phase: "complete", outputPath }
    Server->>UI: SSE 'codegen' event with saved path
    UI-->>User: "✅ Recorded journey saved to <path> — pick via file picker to run"
```

The recorded `.spec.js` is a real `playwright codegen` output file. The user
picks it via the existing file picker to run it through the script pipeline
shown above — uniform treatment for recorded vs externally-recorded scripts.

## State + persistence

All persistent state lives under `~/.co2-runner/` (or `$CO2_RUNNER_HOME` if the
user overrides):

```mermaid
graph TB
    HOME["~/.co2-runner/<br/>(or $CO2_RUNNER_HOME)"]

    HOME --> DB["history.db<br/>SQLite via node:sqlite (DatabaseSync)<br/>runs(id, name, mWh, joules, timestamp, profile)"]
    HOME --> ART["journey-artefacts/<br/>per-run energy profile JSON + HAR<br/>(both YAML and .spec.js pipelines write here)"]
    HOME --> UP["uploaded-journeys/<br/>temp files for journeys uploaded<br/>via POST /run body"]
    HOME --> REC["recorded-journeys/<br/>output of `playwright codegen`<br/>(timestamp-host.spec.js naming)"]

    HOME --> PATHS["ui/paths.ts<br/>co2RunnerHome() / artefactsDir() /<br/>uploadsDir() / recordedJourneysDir() /<br/>defaultDbPath()"]
    PATHS -->|used by| RUNNER["runner/run.ts"]
    PATHS -->|used by| RUNSCRIPT["runner/run-script.ts"]
    PATHS -->|used by| CODEGEN["runner/codegen.ts"]
    PATHS -->|used by| MAIN["main.ts (POST /run + POST /codegen)"]
    PATHS -->|used by| HISTORY["ui/history.ts"]
```

### Why `~/.co2-runner/`, not the repo's directory

Compiled binaries (both CLI and desktop) run with an unpredictable working
directory. Relative paths like `"journey-artefacts/"` were originally used and
broke when:

- The CLI binary was invoked from a non-repo directory.
- The desktop app was launched via Finder (cwd is `/`).

The `ui/paths.ts` helper resolves all paths against `$CO2_RUNNER_HOME` (default
`~/.co2-runner/`), ensuring both modes

- the dev server all write to the same place.

## In-memory event bus (SSE)

The server pushes live events to UI clients via a Server-Sent Events stream on
`/events`. The `ResultsStore` (in `ui/results.ts`) is the in-memory pub-sub bus:

```mermaid
flowchart LR
    subgraph "Producers (server-side)"
        RUN["runner/run.ts<br/>(YAML journey)"]
        RUNSCRIPT["runner/run-script.ts<br/>(.spec.js journey)"]
        CODEGEN["runner/codegen.ts<br/>(recording)"]
        INSTALL["runner/install.ts<br/>(Firefox download)"]
        STARTUP["main.ts<br/>(on isFirefoxInstalled() resolving)"]
    end

    subgraph "Event bus (ui/results.ts)"
        STORE["ResultsStore<br/>subscribe / push / progress /<br/>installProgress / codegenProgress /<br/>setFirefoxInstalled"]
    end

    subgraph "Consumers"
        SSE["GET /events<br/>(TransformStream writer)"]
        DASHJS["dashboard.js<br/>(EventSource listener)"]
    end

    RUN -->|progress + result| STORE
    RUNSCRIPT -->|progress + result| STORE
    CODEGEN -->|codegen progress| STORE
    INSTALL -->|install progress| STORE
    STARTUP -->|firefox-status| STORE

    STORE -->|broadcast all event types| SSE
    SSE -->|text/event-stream| DASHJS
    DASHJS -->|renders result cards + status line| UI["DOM"]
```

Event types in the bus: `result`, `progress`, `install`, `codegen`,
`firefox-status`. Subscribers receive every event type and dispatch on
`event.type` in the handler.

## Build pipeline

```mermaid
flowchart TD
    SRC["Source: main.ts + runner/ + ui/ + util/ + deno.json"]

    subgraph "CLI binary"
        COMPILE["deno task compile<br/>deno compile -A --unsafe-proto<br/>--include npm:playwright<br/>--output co2-runner main.ts"]
        COMPILE --> CLIBIN["./co2-runner<br/>(~80 MB Mach-O, no DMG)<br/>Self-contained except for<br/>Firefox download"]
    end

    subgraph "Desktop app"
        DESKTOP["deno task desktop<br/>(step 1)<br/>deno desktop -A --unsafe-proto<br/>--backend webview main.ts"]
        DESKTOP --> BARE["dist/CO2Runner.app<br/>(ad-hoc signed, no DMG yet)<br/>37 MB"]
        BUNDLE["deno task desktop<br/>(step 2)<br/>deno run ... scripts/bundle-deno.ts"]
        BARE --> BUNDLE
        BUNDLE --> DOWN["Download deno-<triple>.zip<br/>from dl.deno.land (~37 MB)"]
        DOWN --> PLACE["Unzip into Contents/Resources/deno/deno<br/>chmod 0755"]
        PLACE --> SIGN["codesign --force --sign - --deep<br/>(re-sign bundle with embedded binary)"]
        SIGN --> DMG["hdiutil create → dist/CO2Runner.dmg<br/>with /Applications symlink<br/>(~75 MB, self-contained)"]
    end

    SRC --> COMPILE
    SRC --> DESKTOP
```

Two key flags are baked into both binaries at compile time:

- **`-A`** — grants all runtime permissions (file, env, net, run). Compiled
  binaries don't honor per-flag permission prompts; a future improvement would
  scope these to the minimal set.
- **`--unsafe-proto`** — restores `Object.prototype.__proto__` assignment. Deno
  2.9 disables it by default; Playwright's internal object model depends on it
  (see README caveats). Without this flag, the browser launches but stalls on
  the first interaction.

## Firefox install (one-time per machine)

Playwright's bundled Firefox (~150 MB) is too large to embed in the binary. It's
downloaded on first use via the `install` subcommand:

```mermaid
sequenceDiagram
    actor User
    participant App as co2-runner (any mode)
    participant Server as HTTP server (main.ts)
    participant Install as runner/install.ts
    participant Deno as findDenoBinary()
    participant PW as npm:playwright install subprocess
    participant Cache as ~/Library/Caches/ms-playwright/

    User->>App: click "Install Firefox" / run `./co2-runner install`
    App->>Server: POST /install (or direct call)
    Server->>Install: installBrowsersWithProgress(onProgress)
    Install->>Deno: findDenoBinary() → bundled or system path
    Install->>PW: spawn `deno run npm:playwright install firefox`
    PW->>Cache: download firefox-1538/ (~150 MB)
    PW-->>Install: subprocess exits successfully
    Install->>Server: setFirefoxInstalled(true) → broadcast via SSE
    Server-->>App: CodegenProgress { phase: "complete" }
    App-->>User: "✅ Firefox installed"
```

The same `findDenoBinary()` helper powers codegen, install, and the `.spec.js`
runner — see ADR 004 for why this exists + why the bundled binary is checked
first.

## Versions + dep tracking

```mermaid
graph LR
    subgraph "deno.json"
        IMPORTS["imports:<br/>playwright@^1.45<br/>@playwright/test@^1.45<br/>yaml@^2.4<br/>node:zlib, node:fs, node:path, node:sqlite"]
        NPMSCRIPTS["npmLifecycleScripts:<br/>playwright: true<br/>(allows Playwright's npm lifecycle<br/>hooks during install)"]
    end

    subgraph "Resolved at build time"
        DENO_RT["Embedded Deno runtime<br/>(from deno compile / deno desktop)"]
        NPM_PKGS["npm packages cached in<br/>~/Library/Caches/deno/npm/<br/>playwright, @playwright/test, yaml"]
    end

    subgraph "Runtime downloads (per-machine)"
        FIREFOX["Playwright's bundled Firefox<br/>~/Library/Caches/ms-playwright/firefox-1538/<br/>(downloaded via playwright install)"]
    end

    IMPORTS -->|resolves to| NPM_PKGS
    DENO_RT -->|runs| IMPORTS
    NPM_PKGS -->|executes| FIREFOX
```

The Playwright version pinned in `deno.json` determines both the Firefox build
number (e.g. `firefox-1538`) and the `@playwright/test` runner version. These
must stay in sync — a Playwright upgrade typically requires re-downloading
Firefox (the build number changes).

## Test layout

```mermaid
graph TB
    subgraph "tests/runner/"
        ENERGY_T["energy_test.ts<br/>(5 tests: profile parsing,<br/>gzip, no-counters error)"]
        RUN_T["run_test.ts<br/>(8 tests: step dispatcher<br/>with MockPage)"]
        RUNSCRIPT_T["run-script_test.ts<br/>(4 tests: isScriptFile dispatch)"]
        CODEGEN_T["codegen_test.ts<br/>(6 tests: filename slug,<br/>graphical display detection)"]
        INSTALL_T["install_test.ts<br/>(3 tests: exports,<br/>isFirefoxInstalled)"]
    end

    subgraph "tests/ui/"
        COMPONENTS_T["components_test.ts<br/>(4 tests: HTML + inlined JS)"]
        RESULTS_T["results_test.ts<br/>(6 tests: store + SSE broadcast)"]
        HISTORY_T["history_test.ts<br/>(6 tests: SQLite round-trip)"]
        PATHS_T["paths_test.ts<br/>(5 tests: dir resolution + env precedence)"]
    end

    subgraph "tests/util/"
        EXISTS_T["exists_test.ts<br/>(4 tests: file-exists helper)"]
        DENOBIN_T["deno-bin_test.ts<br/>(6 tests: candidate priority,<br/>bundled-path-first, error message)"]
    end

    subgraph "tests/integration/"
        HTTP_T["http_test.ts<br/>(8 tests: all routes,<br/>SSE firefox-status on connect)"]
        INSTALL_T2["install_test.ts<br/>(7 tests: /install + /run body parsing)"]
        CODEGEN_T2["codegen_test.ts<br/>(4 tests: /codegen-status,<br/>/codegen gate behaviour)"]
        DESKTOP_T["desktop_launch_test.ts<br/>(1 test: regression —<br/>no-args + DENO_SERVE_ADDRESS<br/>doesn't exit with usage error)"]
        RUNSCRIPT_T2["run-script_journey_test.ts<br/>(2 tests: end-to-end .spec.js run<br/>+ multi-test rejection)"]
    end

    subgraph "tests/fixtures/"
        PROFILER_T["profiler.ts<br/>(synthetic Firefox profile builder)"]
        MOCKPAGE_T["mock_page.ts<br/>(Playwright Page stand-in<br/>for step dispatcher tests)"]
    end
```

## Cross-references

- **ADRs**: `docs/adrs/` for the rationale behind major decisions.
  - ADR 001: HTML syntax highlighting in template literals
  - ADR 002: Support Playwright codegen scripts (.spec.js) as a journey format
  - ADR 003: Integrate `playwright codegen` into the app
  - ADR 004: Bundle standalone Deno CLI into the desktop app
- **Plan**: `plan.md` for the phased implementation history.
- **README**: `README.md` for usage + caveats from an end-user perspective.
