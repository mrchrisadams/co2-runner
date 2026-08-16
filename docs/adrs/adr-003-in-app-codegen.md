# ADR 003: Integrate `playwright codegen` into the app

## Status

Accepted

## Context

Once ADR 002 (codegen script support) landed, users still had to leave the app
to record a new journey:

1. Open a terminal
2. Run `npx playwright codegen https://example.com` (needs Node or Deno on PATH,
   plus the Playwright package installed)
3. Manually save the resulting code into `journeys/`
4. Pick the file via the co2-runner UI's file picker
5. Click Run

Step 2-3 is the painful part — the Playwright Inspector is a powerful two-window
desktop UI (browser + inspector), but most of the users we want to reach
(sustainability analysts, designers) aren't comfortable with a CLI workflow.
Even developers benefit from one fewer context switch.

## Decision

We will integrate Playwright codegen _as a subprocess_ spawned from inside
co2-runner, exposing it via both the CLI and the desktop app's web UI.

Concretely:

- **`runner/codegen.ts`** — `launchCodegen({ startUrl, outputPath })` spawns
  `deno run -A --allow-scripts=npm:playwright npm:playwright
  codegen --browser=firefox --target=playwright-test
  --output=<outputPath> <startUrl>`.
  The Inspector + Firefox windows appear directly on the user's desktop; control
  returns when the user closes the Inspector.
- **CLI subcommand**: `co2-runner codegen <url> [output.spec.js]`.
  Auto-generates the output path under
  `~/.co2-runner/recorded-journeys/<timestamp>-<host>.spec.js` when not
  supplied.
- **HTTP endpoint**: `POST /codegen { startUrl }` spawns the subprocess in the
  background, returns `{ started, outputPath }`. Gates on Firefox installed +
  graphical display (409 otherwise).
- **UI**: 🔴 Record button next to the file picker opens a modal prompting for
  the start URL. After recording completes, the saved path is shown; the user
  picks the file via the existing file picker to run it. **(We intentionally do
  NOT auto-load the recorded file into the picker after recording — the user
  explicitly picks it themselves, keeping the run path uniform for recorded vs
  externally-recorded scripts.)**

### Decision: subprocess spawn, not in-process embedding

Playwright's codegen is also exposed as a JS module (`playwright/lib/codegen`) —
you can call it programmatically and host the browser inside your own
Electron/webview window.

**We rejected that approach** because `playwright/lib/codegen` is an internal
path, not a stable public API. The Playwright team has historically broken it
between minor versions, and the codegen UI itself is a complex web app (it's how
the official Inspector is built) — embedding it inside our webview would mean
reverse- engineering its build setup and committing to tracking upstream
changes.

Subprocess spawning is the lowest-risk integration: Playwright's own CLI is the
most-tested code path, the Inspector window is the official supported UI, and
any upstream changes are transparent (we just pass new flags through if/when
needed).

### Decision: hardcode browser to Firefox

Codegen supports `--browser=chromium|firefox|webkit`. We hard-code Firefox
because recorded scripts are meant to be re-run by co2-runner, which only
measures Firefox energy (via `MOZ_PROFILER_*` env vars). Recording in Chromium
would produce CSS selectors that might not match Firefox's DOM, and re-running
in Firefox would be misleading.

### Decision: leave recorded journeys on disk

Old recorded `.spec.js` files accumulate in `~/.co2-runner/recorded-journeys/`.
We never silently delete user-generated content — even old ones. Users who care
about cleanup can `rm` them themselves.

### Decision: detect headless Linux explicitly

`hasGraphicalDisplay()` returns true on macOS + Windows, checks `$DISPLAY` /
`$WAYLAND_DISPLAY` on Linux. When false, the codegen gate refuses with a clear
error rather than letting Playwright crash with an opaque
`browserType.launch: Executable doesn't exist` deep inside its webview backend.
This is a UX choice — surface the problem at a layer the user can act on.

## Considered alternatives

### Alternative 1: documentation-only — show users the CLI command

A "Record a journey" button that opens a modal with the exact shell command
(`npx playwright codegen <url>`) and instructions on where to save the result.

**Rejected because** it's not really "in the app" — it's just documentation. The
goal is one-button recording for non-technical users; this doesn't deliver that.

### Alternative 2: in-app codegen via `playwright/lib/codegen`

Programmatically host the codegen UI inside the co2-runner desktop window.

**Rejected because** `playwright/lib/codegen` is an internal path that breaks
between minor Playwright versions, and the codegen UI is a complex web app whose
build setup would need to be reverse- engineered. High maintenance cost for
visual polish only.

### Alternative 3: auto-load the recorded file into the UI

After codegen completes, automatically populate the file picker + run button
with the recorded file.

**Rejected because** it assumes the user wants to run it immediately, which
isn't always true — they might want to inspect it, edit it, or record another
journey first. The explicit file-picker step is a deliberate UX checkpoint.

## Consequences

- **Positive**: One-button recording from inside the app. Users no longer need a
  terminal or `npx` installed.
- **Positive**: Works wherever Deno CLI is available — CLI, dev server, desktop
  app (the latter requires ADR 004's bundled binary to work without an external
  Deno install).
- **Positive**: Recorded scripts are real `playwright codegen` output — same
  format users would get from running the CLI directly. No custom format
  lock-in.
- **Positive**: The same recorded `.spec.js` file goes through the exact same
  pipeline as ADR 002's codegen-script runner. Uniform.
- **Negative**: Codegen opens two extra windows on the user's desktop (Firefox +
  Inspector). The visual disconnect from the co2-runner app window is
  unavoidable without ADR 004's embedding approach.
- **Negative**: The codegen subprocess inherits the parent's environment — if
  `MOZ_PROFILER_*` env vars are set in the user's shell, codegen would
  accidentally record energy data. Mitigated by explicitly clearing
  `MOZ_PROFILER_STARTUP` / `MOZ_PROFILER_SHUTDOWN` in the spawn env.
- **Negative**: Codegen requires a graphical environment. On headless Linux
  servers, the gate refuses with a clear error; there's no headless codegen
  fallback.
- **Negative**: Spawned codegen needs Deno CLI on PATH. Worked around in dev/CLI
  mode by `findDenoBinary()` searching well-known locations, and fully solved in
  ADR 004 by bundling Deno into the desktop app.
