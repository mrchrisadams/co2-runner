# ADR 004: Bundle standalone Deno CLI into the desktop app

## Status

Accepted

## Context

After ADR 003 (in-app codegen) landed, users reported:

> "⚠️ Failed to spawn 'deno': entity not found"

when clicking the Record button inside the desktop app.

### Root cause

co2-runner's compiled desktop binary (produced by `deno desktop`) embeds the
Deno _runtime_ as a `libruntime.dylib` + the laufey webview layer. The running
process is NOT a Deno CLI executable — `Deno.execPath()` returns
`…/CO2Runner.app/Contents/MacOS/laufey_webview`, which can't be re-executed as a
CLI.

But the codegen / install / `.spec.js`-runner features (ADRs 002 + 003) all
spawn `deno` as a subprocess via `new Deno.Command("deno", { … })`:

- `runner/codegen.ts` → `deno run … npm:playwright codegen …`
- `runner/install.ts` → `deno run … npm:playwright install firefox`
- `runner/run-script.ts` → `deno run … npm:@playwright/test test …`

When the app is launched via Finder, macOS gives it a minimal PATH
(`just`/usr/bin:/bin:/usr/sbin:/sbin`) that doesn't include`~/.deno/bin`. The spawn fails with`entity
not found`.

The same bug was latent in `/install` and `run-script` too — user just happened
to hit it on codegen first because they'd never clicked "Install Firefox" from
the desktop UI (they'd run `./co2-runner install` from the CLI where Deno was on
PATH).

### The fundamental conflict

The desktop binary embeds the Deno **runtime** (a dylib that the laufey webview
loads at process start), not the Deno **CLI** (the standalone executable that
parses `deno run …` invocations and resolves `npm:` specifiers). These are
separate artifacts:

- The runtime is what we need to _run_ the co2-runner server.
- The CLI is what we need to _spawn_ codegen / install / `@playwright/test test`
  subprocesses.

We can't get away from spawning `deno` as a subprocess: codegen and install
invoke `npm:playwright` / `npm:@playwright/test` as command-line entrypoints,
which only the Deno CLI knows how to load. The in-process runtime can't load
those npm entry-points the same way.

## Decision

We will embed a real standalone Deno CLI binary inside the `.app` bundle at
build time. End-users download a self-contained DMG and never need to run
`curl … | sh` themselves.

### Implementation

- **`scripts/bundle-deno.ts`** — build-time script invoked by
  `deno task desktop` after `deno desktop` produces the bare `.app`. Downloads
  `https://dl.deno.land/release/v<version>/deno-<triple>.zip`, unzips into
  `dist/CO2Runner.app/Contents/Resources/deno/deno`, `chmod 0755`. Platform
  detected from `Deno.build.{os,arch}`; defaults to the running Deno version
  (`Deno.version.deno`) if no explicit version is passed.
- **Re-codesign the bundle ad-hoc with `--deep`** after embedding, because
  `deno desktop`'s original signature was computed before the bundled binary was
  added. Without re-signing, macOS would refuse to launch the parent process (or
  show a "damaged" warning).
- **Regenerate the `.dmg`** via `hdiutil create` after bundling. `deno desktop`
  creates the initial DMG with pre-bundle contents, so without this step the
  shipped DMG would still have the bug. Uses a staging directory with a
  `/Applications` symlink for drag-to-install.
- **`util/deno-bin.ts` `findDenoBinary()`** checks the bundled location first:
  `<execPath>/../Resources/deno/deno` (derived from `Deno.execPath()` which
  returns `…/CO2Runner.app/Contents/MacOS/laufey_webview`). Falls back to
  `$DENO_BIN` env, `~/.deno/bin/deno`, Homebrew paths, distro paths, then bare
  `deno` (PATH lookup). Cached after first successful resolution.

### Size cost

The bundled Deno CLI binary is ~77 MB, bumping the DMG from ~36 MB to ~75 MB.
One-time download cost for end-users.

## Considered alternatives

### Alternative 1: status quo + clearer error message

Document the Deno dependency in the README, surface a one-time modal in the
desktop app when codegen/install/.spec.js-runner is invoked without Deno on
PATH: "This action requires Deno — click here to install it."

**Rejected because** it's the worst-of-both-worlds: users who downloaded a DMG
to avoid installing anything still have to install something, just with extra
friction in the middle. The 77 MB size penalty is worth the zero-setup
guarantee.

### Alternative 2: drop subprocess spawns — use in-process Playwright APIs

Rewrite the codegen / install / `.spec.js`-runner to use Playwright's in-process
APIs (`firefox.launch()` directly, plus Playwright's internal codegen module via
`playwright/lib/codegen`). No `deno` subprocess needed.

**Rejected because**:

- `playwright/lib/codegen` is an internal path that breaks between minor
  Playwright versions (same reasoning as ADR 003).
- The `.spec.js`-runner relies on `@playwright/test`'s fixture system;
  reproducing it in-process is a substantial project and changing it would
  silently change the energy profile (see ADR 002's alternatives).
- `playwright install firefox` is a CLI entrypoint that downloads the bundled
  browser; reimplementing the download logic in-process is fragile (it changes
  between Playwright versions) for zero benefit.

The subprocess pattern is the lowest-risk integration across all three features.

### Alternative 3: ship Deno as a sidecar, not embedded

Distribute a separate `deno` binary alongside the `.app` (e.g. `CO2Runner.dmg`
extracts to `/Applications/CO2Runner.app` +
`/Applications/co2-runner-deno/deno`, and the app looks it up relative to its
own path).

**Rejected because** users would accidentally delete the sidecar binary,
misplace it, or never copy it during install. Embedding inside the `.app` bundle
is self-contained — copy one `.app` to `/Applications` and everything works.

## Consequences

- **Positive**: Desktop app is genuinely self-contained. Click Record / Install
  Firefox / Run `.spec.js` in a Finder-launched app — all work zero-setup.
- **Positive**: Same mechanism fixes the latent `Install Firefox` bug in the
  desktop UI (which spawned `deno run
  npm:playwright install firefox` and
  would have failed the same way if anyone had clicked it without Deno on PATH).
- **Positive**: `findDenoBinary()`'s fallback chain still works in dev mode, CLI
  compile mode, and any future runtime surface — the bundled path is only the
  first candidate, not a hard requirement.
- **Negative**: DMG grows from ~36 MB to ~75 MB. One-time download cost;
  acceptable trade for zero-setup.
- **Negative**: Build script (`scripts/bundle-deno.ts`) has to re- codesign the
  bundle + regenerate the DMG after `deno desktop` produces its initial
  artefacts. Two extra build steps that could break in CI (network download,
  `hdiutil` quirks).
- **Negative**: The bundled Deno CLI needs to match the platform triple of the
  host that built the bundle. Cross-compiling the desktop app for other
  platforms (via `deno task desktop:all`) would need to bundle the right Deno
  binary for each target — not yet wired up. Future work for cross-platform
  release automation.
- **Negative**: Code-signing identity is still ad-hoc (`-`). Recipients see the
  "developer cannot be verified" Gatekeeper warning on first launch. Real
  distribution would need a Developer ID signature + notarisation; out of scope
  for v1.
