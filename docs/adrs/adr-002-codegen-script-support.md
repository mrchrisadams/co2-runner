# ADR 002: Support Playwright codegen scripts (.spec.js) as a journey format

## Status

Accepted

## Context

co2-runner's original journey format is YAML — a hand-writable declarative list
of `steps` (`goto` / `click` / `fill` / `scroll` / `wait`). This works for
small, well-understood journeys but breaks down for anything complex:

- **Maintenance burden.** As a site's UI evolves, selectors drift, and fixing a
  YAML journey means re-reading the page's DOM to find new `role=link[name='…']`
  strings. The original `journeys/example.yaml` broke this way against the
  Branch Magazine redesign (`'Go to issue'` became `'Go to issue 9'`).
- **No interactive recording.** Authors have to mentally simulate the Playwright
  execution model when writing YAML by hand — they can't see what a `click`
  actually targets until they run the journey and watch it timeout.
- **Limited action surface.** The YAML schema only covers five step types.
  Anything fancier (keyboard shortcuts, drag-and-drop, file uploads, iframes)
  requires new step types + new parser code.

Playwright ships a tool — `playwright codegen` — that solves all three: it opens
a real browser + an Inspector window, records the user's actions, and emits a
`.spec.js` file using `@playwright/test`'s `test()` API. The output is the full
Playwright API, so users get every action Playwright supports, with selectors
chosen by Playwright's own heuristics (which are usually better than hand-picked
YAML).

## Decision

We will add a second supported journey format alongside YAML: Playwright
`codegen`-style scripts (`.js` / `.mjs` / `.ts`), dispatched by file extension
via a thin router in `runner/run.ts`.

Concretely:

- **`runner/run-script.ts`** — `runScript(scriptPath, store, opts)` spawns `deno
  run -A --allow-scripts=npm:playwright npm:@playwright/test test
  <script> --config <generated>`, inherits `MOZ_PROFILER_*` env (so
  Firefox writes its profile on shutdown), parses the profile via the
  existing `parseEnergyProfile()`.
- **`runner/run.ts`** — `runJourney()` becomes a dispatcher: `.js` / `.mjs` /
  `.ts` → `runScript()`; everything else → the existing YAML pipeline. CLI
  subcommands and HTTP routes pass through transparently.
- **Generated `playwright.config.ts` per run** — written to
  `<artefacts-dir>/<slug>-playwright.config.ts`, uses
  `use.contextOptions.recordHar` to capture a full HAR with response bodies,
  deleted after the run. This is critical: `use.recordHar` is a per-test fixture
  option (not a config-level one), so a generated config is the only way to
  inject HAR capture without modifying the user's script.
- **HAR capture is mandatory** for both formats — it's needed for downstream
  processing outside the Firefox profiler (network analysis, third-party
  requests, asset sizes). The codegen-script pipeline produces HAR files with
  the same shape as the YAML pipeline so downstream tooling is format-agnostic.
- **Single-test validation** via `playwright test --list`. Files with more than
  one `test()` registration are rejected with a clear error. Multi-test files
  fragment energy data across separate browser sessions (each `test()` opens +
  closes its own browser), and the `MOZ_PROFILER_SHUTDOWN` env var only fires on
  the last browser close — so energy would only be captured for the final test,
  silently undercounting the journey. Rejecting multi-test files avoids silent
  data loss.
- **Assertion failures abort the journey** with an SSE error event. No energy
  figure is produced, since a failed `expect()` means the page reached an
  unexpected state and the energy data is meaningless.
- **Headless warning** — skipped for `.spec.js` files. If a user explicitly sets
  `test.use({ headless: true })` in their script, that's their decision; we
  don't second-guess it. (The YAML pipeline warns on `headless: true` because
  it's a top-level field more likely to be a mistake.)

## Considered alternatives

### Alternative 1: parse `.spec.js` and re-execute in-process

Instead of spawning `playwright test`, dynamically `import()` the spec file,
find its `test()` registration, extract the `page` callback, and run it directly
against an in-process Firefox we control.

**Rejected because** codegen output uses `@playwright/test`'s fixture-injected
`{ page }` parameter, not a raw `browser.newPage()`. Re-implementing the fixture
system (context per-test, automatic close, storage state, etc.) is a substantial
project, and getting it wrong would silently change the energy profile. Codegen
output is designed for `playwright test`'s runner; running it under that runner
is the zero-risk option.

### Alternative 2: extend YAML with more step types

Add `keyboard`, `drag`, `upload`, etc. to the YAML schema to cover the cases
users actually need.

**Rejected because** YAML's value is its simplicity — a small declarative
surface for common cases. Bolting on advanced actions would convert YAML into a
poor reimplementation of Playwright's API. Better to keep YAML small and let
users graduate to full codegen scripts when they need the full API.

### Alternative 3: require users to wrap their codegen scripts manually

Ask users to add `test.use({ recordHar: ... })` and similar boilerplate to their
scripts themselves.

**Rejected because** it pushes expensive-to-debug complexity onto users — if
they forget the `recordHar` line, they get a journey with no HAR and don't find
out until they try to use it later. Auto-injecting via a generated
`playwright.config.ts` keeps codegen scripts untouched ("record → save → run"
with zero hand-editing) and produces interchangeable HAR files across the two
formats.

## Consequences

- **Positive**: Users can record journeys interactively with
  `playwright codegen` (or co2-runner's integrated codegen button — see ADR 003)
  and immediately run them. No hand-writing or selector tweaking required.
- **Positive**: Full Playwright API is available — `keyboard`, `dragAndDrop`,
  file uploads, iframes, multi-tab flows, etc.
- **Positive**: HAR files have identical shape whether the journey came from
  YAML or codegen, so downstream analysis tools don't need to special-case the
  format.
- **Positive**: YAML pipeline is untouched, so users with simple hand-written
  journeys see no regression.
- **Negative**: codegen-script runs require Deno CLI to be installed (the
  subprocess is `deno run npm:@playwright/test test ...`). This turned out to be
  a real UX problem for desktop-app users; addressed in ADR 004 by bundling Deno
  into the .app.
- **Negative**: Multi-test `.spec.js` files are rejected. Users who naturally
  write multiple tests per file (e.g. one per page section) have to split them
  into separate files. This is a deliberate v1 constraint — multi-test
  fragmentation of energy data is a hard problem we explicitly defer.
- **Negative**: A generated `playwright.config.ts` is written to the artefacts
  dir on every codegen-script run. If the user's script sets its own
  `test.use({ recordHar })`, that overrides our config — we emit a one-time
  warning progress event but can't enforce compliance.
