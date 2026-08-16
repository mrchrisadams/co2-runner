# co2-runner

A Deno-based CLI tool that drives Playwright's bundled Firefox through
YAML-defined user journeys, records real browser energy consumption via
the Mozilla Profiler's power counters, and presents results in a desktop
webview UI (or stdout in headless CLI mode).

Based on the design at <https://github.com/mrchrisadams/playwright-co2>.

## Requirements

- Deno **>= 2.9.0** recommended (for `deno desktop` binary builds; the CLI
  works on Deno 2.8+ via `Deno.serve` + browser tab dev mode).
- macOS (Apple Silicon or Intel) or Windows for accurate power profiling.
  Linux needs `perf_event_paranoid <= 1`.

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
co2-runner run <journey.yaml> Runs a journey + emits energy figures
co2-runner serve              Starts the desktop / HTTP UI
```

See `journeys/example.yaml` for the journey config format. Energy figures
are persisted to `~/.co2-runner/history.db` (SQLite) for cross-run comparison.

## Caveats

- **Firefox is not bundled in the compiled binary** (~120-200 MB). Run
  `co2-runner install` once per machine.
- **Deno KV is avoided** (stuck in beta since Deno's May 2025 "Greatly
  Exaggerated" post). History uses `node:sqlite` (`DatabaseSync`) which is
  built into Deno 2.2+ with no extra deps.
- **`deno desktop` requires Deno >= 2.9**. Earlier Deno versions fall back
  to serving a browser tab via `Deno.serve()`.

See `plan.md` for the full implementation plan.
