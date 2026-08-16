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
co2-runner install           Downloads Playwright's bundled Firefox
co2-runner run <journey.yaml>  Runs a journey + emits energy figures
co2-runner serve               Starts the desktop / HTTP UI
co2-runner --help              Show usage
```

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
  `co2-runner install` once per machine.
- **`--unsafe-proto` is required by Playwright.** Deno 2.9 disables
  `Object.prototype.__proto__` assignment by default, but Playwright's internal
  object model leans on it; without the flag, the browser launches but freezes
  on the first interaction. All `deno task` scripts and the compiled binaries
  already embed the flag — only relevant if you bypass them with your own
  `deno run`/`deno compile` invocation.
- **Journey selectors are site-version-specific.** `journeys/example.yaml`
  targets the current (Issue 9) layout of `branch.climateaction.tech`. If the
  site is revised, update the `click.selector` lines to match.
- **Deno KV is avoided** (stuck in beta since Deno's May 2025 "Greatly
  Exaggerated" post). History uses `node:sqlite` (`DatabaseSync`) which is built
  into Deno 2.2+ with no extra deps.
- **Desktop app screenshots on macOS**: to capture the running desktop app
  window with `screencapture`, grant the launching terminal (or whatever shell
  you build from) Screen Recording permission in System Settings → Privacy &
  Security → Screen Recording.

See `plan.md` for the full implementation plan.
