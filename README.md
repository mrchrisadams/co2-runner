# co2-runner

A Deno-based CLI tool that drives Playwright's bundled Firefox through
YAML-defined user journeys, records real browser energy consumption via the
Mozilla Profiler's power counters, and presents results in a desktop webview UI
(or stdout in headless CLI mode).

Based on the design at <https://github.com/mrchrisadams/playwright-co2>.

## Requirements

- Deno **>= 2.9.0** (for `deno desktop` binary builds; also supports
  `deno compile` for CLI binaries).
- macOS (Apple Silicon or Intel) or Windows for accurate power profiling. Linux
  needs `perf_event_paranoid <= 1`.

## Quickstart

```bash
# 1. Install Playwright's bundled Firefox (first run only)
deno task install

# 2. Run an example journey + view results in a browser tab
deno task dev
# → opens UI at http://localhost:8000

# Or run from the CLI without the UI:
deno task run
# → prints an Energy Report to stdout
```

## Usage

```
co2-runner install              Downloads Playwright's bundled Firefox
co2-runner run <journey>        Runs a journey + emits energy figures
  <journey> may be:
    .yaml / .yml                — declarative config (see journeys/example.yaml)
    .js / .mjs / .ts            — Playwright codegen script (see journeys/example.spec.js)
co2-runner codegen <url> [output.spec.js]
                                Record a new journey via Playwright codegen
co2-runner serve                Starts the desktop / HTTP UI
co2-runner --help               Show usage
```

## Journey formats

co2-runner supports two journey file formats, dispatched by extension.

### YAML journeys (`journeys/example.yaml`)

A declarative format — a list of `steps` (`goto`/`click`/`fill`/`scroll`/`wait`)
that co2-runner executes. Best when you want a small, hand-writable journey
definition. Steps are sequential; energy is summed across the whole run.

### Playwright codegen scripts (`journeys/example.spec.js`)

For more complex journeys, use `playwright codegen` to record a script:

```sh
# Record a journey against branch.climateaction.tech
npx playwright codegen https://branch.climateaction.tech
```

Save the resulting `.spec.js` output into `journeys/` (or pick it from the
desktop UI's file picker). co2-runner runs the script via `@playwright/test`,
capturing the same HAR + Mozilla Profiler energy data as the YAML pipeline.

**Constraints** (enforced on upload — scripts that violate these fail with a
clear error message):

- Exactly one `test()` per file. Multi-test files fragment energy data across
  separate browser sessions. Split them into one test per file.
- Assertion failures (`expect()` throwing) abort the journey with a failure
  report — no energy figure is produced, since the page reached an unexpected
  state.
- HAR is captured automatically via a generated `playwright.config.ts` that sits
  next to the profile + HAR in `~/.co2-runner/journey-artefacts/`. If your
  script sets its own `test.use({ recordHar })` it overrides co2-runner's path —
  the captured HAR may not land where expected.

Full-circle example:

```sh
# 1. Record
./co2-runner codegen https://example.com/
# (Playwright Inspector opens — click around, close Inspector when done)
# ✅ Saved: ~/.co2-runner/recorded-journeys/2026-...-example.com.spec.js

# 2. Run it
./co2-runner run ~/.co2-runner/recorded-journeys/2026-...-example.com.spec.js
# → 1.547 mWh  (5.569 J)
```

## Recording a journey from inside the app

You don't need to run `playwright codegen` from a separate terminal — co2-runner
integrates it directly. Two ways:

**In the desktop app / web UI:** click the **🔴 Record** button next to the file
picker. A modal prompts for the start URL. After you confirm, Playwright opens
its Inspector window + a Firefox window directly on your desktop. Click / type /
scroll around the site as if you were a real user. When you close the Inspector,
the recorded script is saved to
`~/.co2-runner/recorded-journeys/<timestamp>-<host>.spec.js`. Pick it via the
file picker to run it.

**In the CLI:**

```sh
co2-runner codegen https://branch.climateaction.tech/
# → opens the Playwright Inspector
# (close Inspector when done)
# → ✅ Saved: ~/.co2-runner/recorded-journeys/2026-...-branch.climateaction.tech.spec.js
# Run it with: co2-runner run ~/.co2-runner/recorded-journeys/2026-...-branch.climateaction.tech.spec.js
```

Optional second argument overrides the output path:

```sh
co2-runner codegen https://branch.climateaction.tech/ ./journeys/my-journey.spec.js
```

**Codegen gates on Firefox being installed** (same as Run Journey) and on a
graphical environment being available (always true on macOS + Windows; on Linux
requires `$DISPLAY` or `$WAYLAND_DISPLAY`).

See `journeys/example.yaml` for the journey config format. Energy figures are
persisted to `~/.co2-runner/history.db` (SQLite) for cross-run comparison.

## Building distributable binaries

Distributable artifacts are produced by two Deno 2.9+ subcommands:

### CLI binary (single executable for `install` / `run` / `serve`)

```bash
# Host platform
deno task compile                # → ./co2-runner

# Cross-compile for all four supported targets
deno task compile:all
# → co2-runner-x86_64-apple-darwin
# → co2-runner-aarch64-apple-darwin
# → co2-runner-x86_64-unknown-linux-gnu
# → co2-runner-x86_64-pc-windows-msvc.exe
```

Each CLI binary is ~76 MB (includes the Deno runtime + Playwright + YAML deps).
Playwright's bundled Firefox is NOT embedded — users run `./co2-runner install`
once after download to fetch it (~120–200 MB).

### Desktop app (native window with the UI)

```bash
# macOS app bundle on host platform
deno task desktop                # → ./dist/CO2Runner.app

# Dev mode with hot module replacement
deno task desktop:dev

# Cross-compile desktop bundles for all supported platforms
deno task desktop:all
```

The desktop binary uses the system webview (WKWebView on macOS, WebView2 on
Windows, WebKitGTK on Linux) for a small footprint and native look. Opt into the
bundled CEF backend (pixel-identical cross-platform rendering) by setting
`"backend": "cef"` in the `desktop` block of `deno.json`.

### CI builds

`.github/workflows/build.yml` runs on every push and PR:

- `test` — `deno fmt --check`, `deno lint`, `deno check`, `deno test`
- `build-cli` — cross-compiles the CLI binary for all four targets, uploads each
  as an artifact, smoke-tests `--help` on unix
- `build-desktop` — produces a macOS desktop bundle and uploads it
- `release` — on a `v*` git tag, attaches all artifacts to a GitHub Release with
  auto-generated notes

Tagging a release:

```bash
jj bookmark create v0.1.0 -r @
jj git push -b v0.1.0
```

## Caveats

- **Firefox is not bundled in the compiled binary** (~120-200 MB). Run
  `co2-runner install` once per machine (or click the **Install Firefox** button
  in the desktop app — it works without any external Deno install thanks to the
  bundled Deno CLI, see below).
- **The Deno CLI is bundled into `dist/CO2Runner.dmg`** (~77 MB of the ~75 MB
  DMG). The codegen / install / `.spec.js`-runner features spawn `deno` as a
  subprocess; without the bundle, the desktop app launched via Finder (PATH just
  `/usr/bin:/bin`) crashes with `Failed to spawn 'deno': entity not found`. The
  build script (`scripts/bundle-deno.ts`) downloads the standalone Deno binary
  into `CO2Runner.app/Contents/Resources/deno/deno` at build time, and
  `findDenoBinary()` in `util/deno-bin.ts` checks that location first. Falls
  back to `DENO_BIN` env, `~/.deno/bin/deno`, Homebrew paths, then PATH lookup.
- **`--unsafe-proto` is required by Playwright.** Deno 2.9 disables
  `Object.prototype.__proto__` assignment by default, but Playwright's internal
  object model leans on it; without the flag, the browser launches but freezes
  on the first interaction. All `deno task` scripts and the compiled binaries
  already embed the flag — only relevant if you bypass them with your own
  `deno run`/`deno compile` invocation.
- **Journey selectors are site-version-specific.** `journeys/example.yaml` and
  `journeys/example.spec.js` target the current (Issue 9) layout of
  `branch.climateaction.tech`. If the site is revised, re-record with
  `npx playwright codegen` or update the YAML selector lines to match.
- **Desktop app screenshots on macOS**: to capture the running desktop app
  window with `screencapture`, grant the launching terminal (or whatever shell
  you build from) Screen Recording permission in System Settings → Privacy &
  Security → Screen Recording.
