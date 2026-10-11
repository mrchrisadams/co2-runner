# co2-runner

CO2-runner is a tool to help understand and manage the 'client side' energy use of browsers when estimating the energy consumption carbon footprint of web applications.

It is available as a cross platform app with a graphical user interface, for people who are not comfortable with the terminal, and a command line interface for people who are, and want to automate various actions.

Use it to record user journeys using a browser, write the steps to a file, then re-run the steps on demand, to simulate the same user journey being carried out, and then see the estimated energy used by a browser, along with the corresponding carbon footprint.

## What is it? The technical version

A Node-based CLI tool + desktop app that drives Playwright's bundled Firefox
through YAML-defined user journeys, records real browser energy consumption via
the Mozilla Profiler's power counters, and presents results in an Electron
window (or stdout in headless CLI mode).
## Requirements

- Node **>= 22.5** (for the built-in `node:sqlite`) and npm.
- macOS (Apple Silicon) or Windows for accurate power profiling. Linux needs
  `perf_event_paranoid <= 1`.

## Quickstart

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright's bundled Firefox (first run only)
npm run install-browsers

# 3. Run an example journey + view results in an Electron window
npm run desktop:dev
# → or serve the UI in a browser tab: npm run dev (http://localhost:8000)

# Or run from the CLI without the UI:
npm run run
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

Distributable artifacts are built with Node tooling:

### CLI binary (Node SEA single executable for `install` / `run` / `serve`)

```bash
# Host platform
npm run compile                  # → ./dist/co2-runner-<triple>
```

Each CLI binary embeds the app bundle but **not** Playwright — journeys, browser
install and codegen need a Playwright checkout (dev) or an install payload
(packaged distributions; see `scripts/build-cli.mjs`). Playwright's bundled
Firefox is never embedded — users run `./co2-runner install` once after download
to fetch it (~120–200 MB).

### Desktop app (Electron window with the UI)

```bash
# macOS app bundle + dmg (arm64)
npm run desktop                  # → ./dist/CO2Runner.dmg

# Dev mode: Electron window + live server
npm run desktop:dev
```

### CI builds

`.github/workflows/build.yml` runs on every push and PR:

- `test` — `npm run check` (tsc) + `npm test` under `xvfb` (headed Firefox)
- `build-cli` — builds the Node SEA CLI on native macOS / Linux / Windows
  runners, smoke-tests `--help`, uploads each artifact
- `build-desktop` — builds `CO2Runner.dmg` via electron-builder (macOS, arm64)
- `release` — on a `v*` or `2026*` git tag, attaches all artifacts to a GitHub
  Release with auto-generated notes

Tagging a release:

```bash
jj bookmark create v0.1.0 -r @
jj git push -b v0.1.0
```

## Caveats

- **Firefox is not bundled in the compiled binary** (~120-200 MB). Run
  `co2-runner install` once per machine (or click the **Install Firefox** button
  in the desktop app).
- **Playwright is not embedded in the SEA CLI binary.** In a Node single-file
  executable, `process.execPath` is the binary itself and `node_modules` is not
  embedded, so the browser install / codegen / `.spec.js`-runner subprocesses
  cannot run from it. `--help` and `serve` work in-process; journeys need a
  Playwright checkout (dev) or an install payload (packaged distributions — see
  `scripts/build-cli.mjs`).
- **The desktop app is ~140 MB** (Electron bundles Chromium + Node; the old
  Deno/system-webview DMG was ~75 MB).
- **Journey selectors are site-version-specific.** `journeys/example.yaml` and
  `journeys/example.spec.js` target the current (Issue 9) layout of
  `branch.climateaction.tech`. If the site is revised, re-record with
  `npx playwright codegen` or update the YAML selector lines to match.
- **Desktop app screenshots on macOS**: to capture the running desktop app
  window with `screencapture`, grant the launching terminal (or whatever shell
  you build from) Screen Recording permission in System Settings → Privacy &
  Security → Screen Recording.
