# Building a Deno CLI Tool

*Created: 14/08/2026, 09:43:07*

---

**You**

I want to make a deno based cli tool, that lets users install the playwright bundled version of Firefox and drive it using config like this repo here

https://github.com/mrchrisadams/playwright-co2

But also use the new deno web ui so the energy figures output by the code shows up in an actual app rather than just on The command line .

Ideally this would be a downloadable binary that installs and then drives a Firefox browser, while providing the same playwright cli used to automate common user journeys.

---

**Assistant**

Excellent — now I have everything I need. Let me write the complete design guide.

---

# Deno CLI Tool: Playwright CO2 Monitor with Desktop UI

Here's a complete design for your tool — let's call it **`co2-runner`**. I'll cover the architecture, all the key files, and the important caveats.

---

## How it all fits together

The repo you linked uses Firefox's built-in Mozilla Profiler, triggered via environment variables (`MOZ_PROFILER_*`), to record energy consumption in picoWatt-hours across all browser processes. [^2] The Firefox profile JSON is parsed after the run and the power counters are summed to get total mWh/Joules. [^2]

For the UI layer, Deno's new `deno desktop` feature (available since Deno v2.9.0) turns any TypeScript project into a self-contained native binary with an embedded webview. [^1] It serves your UI via `Deno.serve()` and points a native OS webview at it — same code works in a browser tab during development and in the compiled binary. [^1]</kcite>

**The one unavoidable constraint:** Playwright's bundled Firefox is ~100–200 MB. You cannot embed it inside a compiled binary. The tool therefore ships as a binary that downloads Firefox on first run (via `playwright install firefox`), similar to how the Playwright CLI itself works. The binary handles everything else. [^3]

---

## Project structure

```
co2-runner/
├── deno.json               # Deno config, npm deps, desktop config
├── main.ts                 # Entry: CLI subcommand router + desktop UI server
├── runner/
│   ├── install.ts          # `co2-runner install` — downloads Firefox via playwright
│   ├── run.ts              # `co2-runner run <journey.yaml>` — executes journey, collects energy
│   └── energy.ts           # Parses Firefox profile JSON → energy figures
├── ui/
│   ├── index.html          # Main app shell
│   ├── results.ts          # Server-Sent Events stream for live results
│   └── components.ts       # HTML rendering helpers (no framework needed)
├── journeys/
│   └── example.yaml        # Example journey config
└── types.ts                # Shared types
```

---

## `deno.json`

```jsonc
{
  "name": "co2-runner",
  "version": "0.1.0",
  "imports": {
    "playwright": "npm:playwright@^1.45",
    "yaml": "npm:yaml@^2.4",
    "zlib": "node:zlib",
    "fs": "node:fs/promises",
    "path": "node:path"
  },
  "tasks": {
    "dev": "deno desktop main.ts --hmr",
    "build": "deno desktop main.ts --target all"
  },
  "desktop": {
    "window": {
      "title": "CO2 Runner",
      "width": 1024,
      "height": 700
    }
  },
  "permissions": {
    "allow-read": true,
    "allow-write": true,
    "allow-env": true,
    "allow-run": true,
    "allow-net": "playwright.download.prss.microsoft.com"
  }
}
```

---

## Journey config format (`journeys/example.yaml`)

This is what you'd share/version-control per site:

```yaml
name: "Branch Magazine reader journey"
url: "https://branch.climateaction.tech/"
browser: firefox        # only firefox supports power profiling via MOZ_PROFILER
headless: false         # headless loses power data fidelity
steps:
  - action: goto
    url: "https://branch.climateaction.tech/"
    waitFor: networkidle

  - action: scroll
    distance: 600
    human: true         # uses randomised step sizes + pauses

  - action: wait
    ms: 3000            # simulate reading

  - action: click
    selector: "role=link[name='Go to issue']"
    waitFor: domcontentloaded

  - action: scroll
    distance: 800
    human: true

  - action: wait
    ms: 4000

  - action: click
    selector: "#post-4208 >> role=link[name=\"Editors' Letter\"]"
    waitFor: domcontentloaded

  - action: scroll
    distance: 2000
    human: true

  - action: wait
    ms: 5000
```

---

## `main.ts` — CLI router + desktop server

```typescript
// main.ts
import { installBrowsers } from "./runner/install.ts";
import { runJourney } from "./runner/run.ts";
import { ResultsStore } from "./ui/results.ts";
import { renderDashboard } from "./ui/components.ts";

const args = Deno.args;
const store = new ResultsStore();

// ── CLI subcommand handling ─────────────────────────────────────────────────
// When running as a desktop binary, args come after the binary name.
// When invoked as `deno run main.ts install` etc., same deal.

(async () => {
  if (args[0] === "install") {
    await installBrowsers();
    Deno.exit(0);
  }

  if (args[0] === "run") {
    const journeyPath = args[1];
    if (!journeyPath) {
      console.error("Usage: co2-runner run <journey.yaml>");
      Deno.exit(1);
    }
    // In CLI mode: run then print; in desktop mode: run then update UI
    const result = await runJourney(journeyPath, store);
    if (!Deno.env.get("DENO_SERVE_ADDRESS")) {
      // Pure CLI: just print and exit
      console.log(`\n=== Energy Report: ${result.name} ===`);
      console.log(`${result.mWh.toFixed(4)} mWh  (${result.joules.toFixed(4)} J)`);
      Deno.exit(0);
    }
    return; // Desktop: results are streamed to the UI
  }
})();

// ── Desktop UI server ───────────────────────────────────────────────────────
// deno desktop binds Deno.serve() to the webview automatically via
// DENO_SERVE_ADDRESS. In dev mode this serves to a browser tab.

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === "/") {
    return new Response(renderDashboard(), {
      headers: { "content-type": "text/html" },
    });
  }

  // Server-Sent Events: live energy results pushed to the UI
  if (url.pathname === "/events") {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Push any already-completed results immediately
    for (const r of store.results) {
      await writer.write(encoder.encode(`data: ${JSON.stringify(r)}\n\n`));
    }

    // Subscribe to new results
    store.subscribe((r) => {
      writer.write(encoder.encode(`data: ${JSON.stringify(r)}\n\n`));
    });

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  }

  // Trigger a run from the UI via POST /run
  if (url.pathname === "/run" && req.method === "POST") {
    const { journey } = await req.json();
    runJourney(journey, store); // non-blocking, streams results via SSE
    return new Response(JSON.stringify({ started: true }), {
      headers: { "content-type": "application/json" },
    });
  }

  return new Response("Not found", { status: 404 });
});
```

---

## `runner/run.ts` — the core energy-measurement runner

```typescript
// runner/run.ts
import { firefox } from "playwright";
import { parse as parseYaml } from "yaml";
import { readFile } from "fs";
import { parseEnergyProfile } from "./energy.ts";
import type { ResultsStore } from "../ui/results.ts";
import type { JourneyResult, JourneyConfig, Step } from "../types.ts";

const rand = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

export async function runJourney(
  journeyPath: string,
  store: ResultsStore
): Promise<JourneyResult> {
  const raw = await Deno.readTextFile(journeyPath);
  const config: JourneyConfig = parseYaml(raw);

  const PROFILE_PATH = `journey-artefacts/${config.name.replace(/\s+/g, "-")}-profile.json`;
  const HAR_PATH = `journey-artefacts/${config.name.replace(/\s+/g, "-")}.har`;

  await Deno.mkdir("journey-artefacts", { recursive: true });

  const browser = await firefox.launch({
    headless: config.headless ?? false,
    env: {
      ...Deno.env.toObject(),
      MOZ_PROFILER_STARTUP: "1",
      MOZ_PROFILER_STARTUP_ENTRIES: "10000000",
      MOZ_PROFILER_STARTUP_INTERVAL: "10",
      MOZ_PROFILER_STARTUP_FEATURES: "js,stack,cpu,threads,power",
      MOZ_PROFILER_STARTUP_THREADS: "GeckoMain,Compositor,Renderer",
      MOZ_PROFILER_SHUTDOWN: PROFILE_PATH,
    },
  });

  const context = await browser.newContext({
    recordHar: { path: HAR_PATH, mode: "full", content: "embed" },
  });
  const page = await context.newPage();

  // Execute steps from config
  for (const step of config.steps) {
    await executeStep(page, step);
  }

  await context.close(); // HAR flushed here
  await browser.close(); // profile written here

  // Parse energy
  const result = await parseEnergyProfile(PROFILE_PATH, config.name);
  store.push(result);
  return result;
}

async function executeStep(page: any, step: Step) {
  const rand = (a: number, b: number) =>
    Math.floor(Math.random() * (b - a + 1)) + a;

  switch (step.action) {
    case "goto":
      await page.goto(step.url);
      if (step.waitFor) await page.waitForLoadState(step.waitFor);
      break;

    case "click":
      await page.locator(step.selector).click();
      if (step.waitFor) await page.waitForLoadState(step.waitFor);
      break;

    case "fill":
      await page.locator(step.selector).fill(step.value);
      break;

    case "scroll":
      if (step.human) {
        // Human-like scroll with randomised step sizes
        let remaining = Math.abs(step.distance);
        const dir = step.distance >= 0 ? 1 : -1;
        while (remaining > 0) {
          const step_px = Math.min(rand(120, 240), remaining);
          await page.mouse.wheel(0, dir * step_px);
          remaining -= step_px;
          await page.waitForTimeout(rand(40, 180));
        }
      } else {
        await page.evaluate(`window.scrollBy(0, ${step.distance})`);
      }
      break;

    case "wait":
      await page.waitForTimeout(step.ms);
      break;

    case "waitForSelector":
      await page.locator(step.selector).waitFor({ state: "visible" });
      break;
  }
}
```

---

## `runner/energy.ts` — Firefox profile parser

```typescript
// runner/energy.ts
import { gunzipSync } from "zlib";
import type { JourneyResult } from "../types.ts";

export async function parseEnergyProfile(
  profilePath: string,
  journeyName: string
): Promise<JourneyResult> {
  const raw = await Deno.readFile(profilePath);
  const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
  const json = isGzip
    ? gunzipSync(raw).toString("utf8")
    : new TextDecoder().decode(raw);
  const profile = JSON.parse(json);

  // Collect power counters from parent process AND all child processes
  // (each web/content process has its own counters)
  const powerCounters = [
    ...(profile.counters ?? []),
    ...(profile.processes ?? []).flatMap((p: any) => p.counters ?? []),
  ].filter((c: any) => c.category === "power");

  if (powerCounters.length === 0) {
    throw new Error(
      "No power counters found — check platform support and perf_event_paranoid on Linux"
    );
  }

  // Samples are per-interval energy in picoWatt-hours (NOT cumulative)
  const totalPWh = powerCounters.reduce(
    (sum: number, c: any) =>
      sum +
      c.samples.data.reduce((s: number, [, v]: [any, number]) => s + Math.max(0, v), 0),
    0
  );

  const mWh = totalPWh / 1e9;
  const joules = totalPWh * 3.6e-9;
  const timestamp = new Date().toISOString();

  return { name: journeyName, mWh, joules, timestamp, profilePath };
}
```

---

## `ui/components.ts` — the dashboard HTML

```typescript
// ui/components.ts
export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>CO2 Runner</title>
  <style>
    :root {
      --bg: #0f1117; --surface: #1a1d27; --accent: #4ade80;
      --text: #e2e8f0; --muted: #64748b; --border: #2d3148;
      font-family: system-ui, sans-serif;
    }
    body { background: var(--bg); color: var(--text); margin: 0; padding: 2rem; }
    h1 { color: var(--accent); font-size: 1.5rem; margin-bottom: 0.25rem; }
    .subtitle { color: var(--muted); margin-bottom: 2rem; font-size: 0.9rem; }
    .run-form { display: flex; gap: 0.75rem; margin-bottom: 2rem; }
    .run-form input {
      flex: 1; background: var(--surface); border: 1px solid var(--border);
      color: var(--text); padding: 0.5rem 0.75rem; border-radius: 6px;
    }
    .run-form button {
      background: var(--accent); color: #000; padding: 0.5rem 1.25rem;
      border: none; border-radius: 6px; cursor: pointer; font-weight: 600;
    }
    #results { display: grid; gap: 1rem; }
    .result-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 1.25rem;
      animation: fadeIn 0.3s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; } }
    .result-name { font-weight: 600; margin-bottom: 0.5rem; }
    .result-metrics { display: flex; gap: 2rem; }
    .metric-value { font-size: 1.8rem; font-weight: 700; color: var(--accent); }
    .metric-label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; }
    .result-time { font-size: 0.75rem; color: var(--muted); margin-top: 0.5rem; }
    #status { color: var(--muted); font-size: 0.85rem; min-height: 1.5rem; }
  </style>
</head>
<body>
  <h1>🌱 CO2 Runner</h1>
  <p class="subtitle">Measure real browser energy consumption per user journey</p>

  <div class="run-form">
    <input id="journey-input" type="text" placeholder="Path to journey YAML (e.g. journeys/example.yaml)" />
    <button onclick="startRun()">▶ Run Journey</button>
  </div>
  <div id="status"></div>
  <div id="results"></div>

  <script>
    // Connect to SSE stream
    const evtSource = new EventSource("/events");
    evtSource.onmessage = (e) => {
      const r = JSON.parse(e.data);
      addResultCard(r);
    };

    function addResultCard(r) {
      const card = document.createElement("div");
      card.className = "result-card";
      card.innerHTML = \`
        <div class="result-name">\${r.name}</div>
        <div class="result-metrics">
          <div>
            <div class="metric-value">\${r.mWh.toFixed(4)}</div>
            <div class="metric-label">mWh</div>
          </div>
          <div>
            <div class="metric-value">\${r.joules.toFixed(4)}</div>
            <div class="metric-label">Joules</div>
          </div>
        </div>
        <div class="result-time">\${new Date(r.timestamp).toLocaleString()}</div>
      \`;
      document.getElementById("results").prepend(card);
    }

    async function startRun() {
      const journey = document.getElementById("journey-input").value.trim();
      if (!journey) return;
      document.getElementById("status").textContent = "⏳ Running journey...";
      const res = await fetch("/run", {
        method: "POST",
        body: JSON.stringify({ journey }),
        headers: { "content-type": "application/json" }
      });
      if (res.ok) {
        document.getElementById("status").textContent = "🚀 Journey started — results will appear below";
      }
    }
  </script>
</body>
</html>`;
}
```

---

## `runner/install.ts` — first-run browser install

```typescript
// runner/install.ts
export async function installBrowsers() {
  console.log("Installing Playwright's bundled Firefox...");
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-all", "npm:playwright", "install", "firefox"],
    stdout: "inherit",
    stderr: "inherit",
  });
  const result = await cmd.output();
  if (!result.success) {
    console.error("Firefox install failed");
    Deno.exit(1);
  }
  console.log("✅ Firefox installed. Run: co2-runner run journeys/example.yaml");
}
```

---

## `types.ts`

```typescript
export interface JourneyConfig {
  name: string;
  headless?: boolean;
  steps: Step[];
}

export type Step =
  | { action: "goto"; url: string; waitFor?: string }
  | { action: "click"; selector: string; waitFor?: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "scroll"; distance: number; human?: boolean }
  | { action: "wait"; ms: number }
  | { action: "waitForSelector"; selector: string };

export interface JourneyResult {
  name: string;
  mWh: number;
  joules: number;
  timestamp: string;
  profilePath: string;
}
```

---

## Building the binary

```bash
# Dev mode (opens browser tab)
deno task dev

# Build a desktop binary for your current platform
deno desktop main.ts

# Cross-compile for all platforms from one machine
deno desktop main.ts --target all
# → produces: main-x86_64-unknown-linux-gnu
#             main-x86_64-apple-darwin
#             main-aarch64-apple-darwin
#             main-x86_64-pc-windows-msvc.exe
```

`deno desktop` bundles your code, the Deno runtime, and the OS's native webview into a single redistributable binary per platform. [^1] It uses the system webview by default (small binary), with an opt-in bundled Chromium (CEF) backend for pixel-identical rendering across platforms. [^1]

**End-user flow:**
```bash
# First run: install Firefox
./co2-runner install

# Then run a journey + view results in the desktop window
./co2-runner run journeys/my-site.yaml
# → a window opens with live results, OR if DENO_SERVE_ADDRESS not set, prints to stdout
```

---

## Important caveats

| Topic | Detail |
|---|---|
| **Power profiling platform support** | `MOZ_PROFILER_*` power counters work on **macOS (Apple Silicon & Intel)** and **Windows**. On Linux you need `perf_event_paranoid ≤ 1` and a kernel with `perf` support. [^2] |
| **Firefox not bundled in binary** | Playwright's Firefox is ~120-200MB — too large to embed in `deno compile`. The `install` subcommand downloads it via `playwright install firefox`. Users run it once. |
| **Deno Desktop requires v2.9+** | `deno desktop` was introduced in Deno v2.9.0. [^1] |
| **Playwright + Deno version pinning** | There were regressions in Deno 2.6.0 with Playwright timeouts. [^5] Pin to a known-good version and test carefully. |
| **`--allow-scripts`** | Playwright's npm install needs lifecycle scripts. Add `"npmLifecycleScripts": { "playwright": true }` to `deno.json` or pass `--allow-scripts=npm:playwright` when installing. [^4] |
| **Headless vs headed energy data** | The original repo runs headless: false deliberately — headless mode changes the power profile significantly and makes measurements less meaningful. Keep it that way. |

---

## What this gives you vs. the original repo

| Feature | playwright-co2 (original) | co2-runner (this) |
|---|---|---|
| Journey config | Hardcoded JS | YAML file, shareable/versionable |
| Energy output | `console.log` only | Desktop window with live SSE updates |
| Distribution | `npm install` required | Single downloaded binary |
| Browser install | Manual | `co2-runner install` subcommand |
| Multiple journeys | One at a time | Queue multiple, see all results in UI |
| Framework | Node.js | Deno (TypeScript native, no config) |

The next logical steps would be adding a CO2 conversion layer on top of the mWh figure (using something like the [CO2.js](https://github.com/thegreenwebfoundation/co2.js) library, which the Green Web Foundation maintains), and adding a history store backed by Deno KV so results persist across runs.

**References**

[^1]: [Desktop apps | Deno Docs](https://docs.deno.com/runtime/desktop/) (38%)
[^2]: [raw.githubusercontent.com](https://raw.githubusercontent.com/mrchrisadams/playwright-co2/main/playwright-energy-journey.mjs) (28%)
[^3]: [deno compile | Deno Docs](https://docs.deno.com/runtime/reference/cli/compile/) (17%)
[^4]: [Deno in 2024](https://deno.com/blog/deno-in-2024) (11%)
[^5]: [Playwright tests executed with deno run timing out on 2.6.0 #31595](https://github.com/denoland/deno/issues/31595) (6%)

---

**You**


Is deno kv not deprecated.?

---

**Assistant**

Good — the picture is clear. You're right to flag it, and I was wrong to recommend it without caveats. Here's the accurate state of play:

**Deno KV is not deprecated, but it is stuck in a kind of limbo.** In May 2025, Deno published a post literally titled *"Reports of Deno's Demise Have Been Greatly Exaggerated"*, which contained this telling admission: [^1]

> *"Deno KV will remain in beta. We will continue to address critical bugs and security issues for its current version. While KV is useful for its intended purpose, its role is not to be the central or evolving solution for all state management in Deno. We reserve the right to make significant changes to Deno KV in the future."*

And the current docs still require you to pass `--unstable-kv` to use it, confirming it has never graduated out of beta. [^2]

So: not deprecated, but explicitly not being developed further in its current form, with the Deno team signalling they'll likely replace it with something more like Cloudflare Durable Objects.

---

## Better alternatives for persistence in this tool

Since this is a **local CLI binary** (not a Deploy app), you don't need a distributed store anyway. Much simpler options:

| Option | Why it fits |
|---|---|
| **SQLite via `npm:better-sqlite3`** | Deno has excellent Node compat; synchronous, zero config, single file on disk — perfect for storing run history |
| **Flat JSON/NDJSON file** | Simplest possible — append each `JourneyResult` as a line to `~/.co2-runner/history.ndjson`. No deps. |
| **`npm:lowdb`** | Tiny JSON database with a nice API, works great in Deno via npm compat |

For a tool like this, I'd honestly just go with **NDJSON append** — one line per run, trivially readable by other tools, no deps, survives binary updates without migrations. Something like:

```typescript
const entry = JSON.stringify({ ...result, timestamp: new Date().toISOString() });
await Deno.writeTextFile(historyPath, entry + "\n", { append: true });
```

Apologies for suggesting Deno KV without flagging its uncertain status — it was a bad fit for this use case even before the beta stagnation.

**References**

[^1]: [Reports of Deno's Demise Have Been Greatly Exaggerated](https://deno.com/blog/greatly-exaggerated) (64%)
[^2]: [Deno KV Quick Start](https://docs.deno.com/deploy/kv/) (36%)

---

**You**

How is deno’s native SQLite handling work, without better-SQLite now?

---

**Assistant**

Great — that's everything needed. Here's the full picture:

---

## Deno's native SQLite: `node:sqlite`

Since **Deno v2.2** (February 2025), SQLite is built directly into the runtime via the `node:sqlite` module — no npm packages, no FFI, no WASM. [^2] The long-open GitHub issue requesting a native SQLite API was effectively closed with this release. [^3]

It mirrors the Node.js `node:sqlite` API exactly, so it's portable between the two runtimes.

---

### The key thing: it's entirely synchronous

There is no async version. The class is `DatabaseSync`, the statement class is `StatementSync`, and every operation blocks. [^1] For a local CLI tool like `co2-runner` this is actually ideal — no `await` noise, no Promise chains around your DB writes.

---

### Basic usage

```typescript
import { DatabaseSync } from "node:sqlite";

// Opens file-based DB, creates it if it doesn't exist
const db = new DatabaseSync("~/.co2-runner/history.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    mWh       REAL NOT NULL,
    joules    REAL NOT NULL,
    timestamp TEXT NOT NULL,
    profile   TEXT
  );
`);
```
[^2]

---

### Prepared statements (the right way to insert)

```typescript
const insert = db.prepare(
  `INSERT INTO runs (name, mWh, joules, timestamp, profile)
   VALUES (?, ?, ?, ?, ?)`
);

insert.run(result.name, result.mWh, result.joules, result.timestamp, result.profilePath);
```

Prepared statements are parameterised, so they're SQL-injection safe and fast for repeated inserts. [^1]

---

### Querying back

`StatementSync` has four execution methods:

| Method | Returns |
|---|---|
| `.all(...params)` | `Record<string, SQLOutputValue>[]` — all rows as array |
| `.get(...params)` | First row as object, or `undefined` |
| `.run(...params)` | `{ changes, lastInsertRowid }` — for INSERT/UPDATE/DELETE |
| `.iterate(...params)` | Iterator — good for large result sets |

```typescript
// All historical runs, newest first
const history = db.prepare(
  `SELECT * FROM runs ORDER BY timestamp DESC`
).all();

// Last 10 runs for a specific journey
const recent = db.prepare(
  `SELECT * FROM runs WHERE name = ? ORDER BY timestamp DESC LIMIT 10`
).all("Branch Magazine reader journey");
```
[^1]

---

### Transactions

No special transaction class — you just use `exec()` with standard SQL:

```typescript
db.exec("BEGIN");
try {
  insert.run(/* ... */);
  insert.run(/* ... */);
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}
```
[^1]

---

### Permissions required

Just the standard file permissions — no special flags for SQLite itself:

```bash
deno run --allow-read --allow-write db.ts
```
[^2]

---

### How it compares to the alternatives for this project

| | `node:sqlite` (built-in) | `@db/sqlite` (JSR) | `npm:better-sqlite3` |
|---|---|---|---|
| Zero deps | ✅ | ❌ (downloads FFI .so) | ❌ (npm install) |
| Works in compiled binary | ✅ | ⚠️ (FFI path issues) | ⚠️ |
| Synchronous API | ✅ | ✅ | ✅ |
| Permissions needed | `--allow-read/write` | `--allow-ffi` + `--allow-env` | `--allow-read/write` |
| API stability | Mirrors Node.js stable | Separate API | Node ecosystem standard |

For a compiled binary that needs zero setup friction, `node:sqlite` is the clear winner — it's baked into the Deno executable, so it just works in the distributed binary without any native library gymnastics.

**References**

[^1]: [sqlite - Node documentation | Deno Docs](https://docs.deno.com/api/node/sqlite/) (48%)
[^2]: [Deno 2.2: OpenTelemetry, Lint Plugins, node:sqlite | Deno](https://deno.com/blog/v2.2) (31%)
[^3]: [SQLite API · Issue #11657 · denoland/deno](https://github.com/denoland/deno/issues/11657) (21%)

---

