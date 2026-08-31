// main.ts — CLI subcommand router + HTTP server.

import { isAbsolute, relative, resolve } from "path";
import {
  installBrowsers,
  installBrowsersWithProgress,
  isFirefoxInstalled,
} from "./runner/install.ts";
import {
  buildCodegenFilename,
  hasGraphicalDisplay,
  launchCodegen,
} from "./runner/codegen.ts";
import { runJourney } from "./runner/run.ts";
import { ResultsStore, type StoreEvent } from "./ui/results.ts";
import { renderDashboard } from "./ui/components.ts";
import { History } from "./ui/history.ts";
import {
  co2RunnerHome,
  defaultDbPath,
  recordedJourneysDir,
  uploadsDir,
} from "./ui/paths.ts";
import { gridIntensityEntries } from "./runner/co2.ts";
import {
  resumePendingSubmissions,
  submitJourney,
  watchSubmission,
} from "./runner/gmt-jobs.ts";
import { journeyToGmtScript, loadJourneyForGmt } from "./runner/gmt.ts";
import { parseJourneyConfig } from "./runner/journey-config.ts";

const args = Deno.args;
const isServeMode = args[0] === "serve";
// `deno desktop` sets DENO_SERVE_ADDRESS and passes no args; in that case we
// skip CLI subcommand parsing entirely and go straight to the HTTP server.
const isDesktopMode = !!Deno.env.get("DENO_SERVE_ADDRESS");

const USAGE = `co2-runner — measure real browser energy per user journey

USAGE:
  co2-runner install                    Download Playwright's bundled Firefox
  co2-runner run <journey>               Run a journey, emit energy figures
    <journey> may be:
      .yaml / .yml                       declarative config
      .js / .mjs / .ts                   Playwright codegen script
  co2-runner codegen <url> [output.spec.js]
                                         Record a journey via Playwright codegen
  co2-runner submit <journey.yaml>       Measure the journey on the Green Metrics
                                         Tool cluster instead of locally
    --email <addr>                       Get an e-mail when the run finishes
    --no-wait                            Submit and exit without polling
    --print-script                       Print the generated body, submit nothing
  co2-runner serve                       Start the HTTP / desktop UI
  co2-runner --help                      Show this message

ENV:
  PORT                  HTTP port for serve mode (default 8000)
  CO2_RUNNER_DB         SQLite history DB path (default ~/.co2-runner/history.db)
  DENO_SERVE_ADDRESS    Set by \`deno desktop\`; when present, run suppresses stdout

EXAMPLES:
  co2-runner install
  co2-runner run journeys/example.yaml
  co2-runner run journeys/example.spec.js
  co2-runner codegen https://branch.climateaction.tech/
  co2-runner submit journeys/example.yaml --email me@example.com
  co2-runner serve
`;

if (!isDesktopMode) {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    console.log(USAGE);
    Deno.exit(0);
  }

  if (args[0] === undefined) {
    console.error(USAGE);
    Deno.exit(1);
  }

  if (
    args[0] !== "install" && args[0] !== "run" && args[0] !== "serve" &&
    args[0] !== "codegen" && args[0] !== "submit"
  ) {
    console.error(`unknown subcommand: ${args[0]}\n\n${USAGE}`);
    Deno.exit(1);
  }
}

// ── CLI subcommands (install / run) ────────────────────────────────────────
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
  const store = new ResultsStore();
  const result = await runJourney(journeyPath, store);

  // Persist to history regardless of mode
  try {
    const hist = new History(defaultDbPath());
    hist.insert(result);
    hist.close();
  } catch (err) {
    console.warn(`⚠️  history write failed: ${(err as Error).message}`);
  }

  // Pure CLI: print and exit
  if (!isServeMode && !Deno.env.get("DENO_SERVE_ADDRESS")) {
    console.log(`\n=== Energy Report: ${result.name} ===`);
    console.log(
      `${result.mWh.toFixed(4)} mWh  (${result.joules.toFixed(4)} J)`,
    );
    Deno.exit(0);
  }
}

// ── CLI subcommand: codegen ─────────────────────────────────────────────────
// `co2-runner codegen <url> [output.spec.js]` — launches Playwright Inspector
// for the given URL, records the user's actions, writes the result to either
// the user-supplied path or `~/.co2-runner/recorded-journeys/<auto-name>`.
if (args[0] === "codegen") {
  const startUrl = args[1];
  if (!startUrl) {
    console.error(
      "Usage: co2-runner codegen <url> [output.spec.js]\n\n" + USAGE,
    );
    Deno.exit(1);
  }

  if (!await isFirefoxInstalled()) {
    console.error(
      "Firefox is not installed. Run `co2-runner install` first (one-time ~150MB download).",
    );
    Deno.exit(1);
  }

  if (!hasGraphicalDisplay()) {
    console.error(
      "codegen requires a graphical environment (DISPLAY or WAYLAND_DISPLAY on Linux; " +
        "always available on macOS / Windows). Run co2-runner from a desktop session.",
    );
    Deno.exit(1);
  }

  // Output path: user-supplied, or auto-generated under recordedJourneysDir().
  let outputPath: string;
  if (args[2]) {
    outputPath = await Deno.realPath(args[2]).catch(() => args[2]);
  } else {
    const dir = recordedJourneysDir();
    await Deno.mkdir(dir, { recursive: true });
    outputPath = `${dir}/${buildCodegenFilename(startUrl)}`;
  }

  console.log(`Recording journey at ${startUrl}...`);
  console.log(`  → output: ${outputPath}`);
  console.log("  Close the Playwright Inspector window when done.");
  await launchCodegen({
    startUrl,
    outputPath,
  });
  console.log(`\n✅ Saved: ${outputPath}`);
  console.log(
    `Run it with: co2-runner run ${outputPath}`,
  );
  Deno.exit(0);
}

// ── CLI subcommand: submit ──────────────────────────────────────────────────
// `co2-runner submit <journey.yaml>` — measures the journey on the Green
// Metrics Tool cluster (RAPL on dedicated hardware) instead of locally.
// The journey is translated to a bare Playwright body and POSTed to the
// green-coding gateway; see runner/gmt.ts for the protocol and for why the
// resulting figure is not directly comparable to a local one.
if (args[0] === "submit") {
  const journeyPath = args[1];
  if (!journeyPath || journeyPath.startsWith("--")) {
    console.error("Usage: co2-runner submit <journey.yaml>\n\n" + USAGE);
    Deno.exit(1);
  }

  const flags = args.slice(2);
  const emailIdx = flags.indexOf("--email");
  const email = emailIdx === -1 ? undefined : flags[emailIdx + 1];
  if (emailIdx !== -1 && (!email || email.startsWith("--"))) {
    console.error("--email needs an address");
    Deno.exit(1);
  }
  const noWait = flags.includes("--no-wait");

  // Dry run: show exactly what would be sent, send nothing.
  if (flags.includes("--print-script")) {
    const { script } = await loadJourneyForGmt(journeyPath);
    console.log(`page:   ${script.page}`);
    console.log(`length: ~${script.estimatedSeconds}s\n`);
    console.log(script.script);
    Deno.exit(0);
  }

  console.log(`Submitting ${journeyPath} to the Green Metrics Tool cluster…`);
  const submitHistory = new History(defaultDbPath());
  const outcome = await submitJourney({
    journeyPath,
    email,
    history: submitHistory,
  }).catch((err: Error) => {
    console.error(`\n⚠️  ${err.message}`);
    submitHistory.close();
    Deno.exit(1);
  });

  const submission = outcome.submission;
  console.log(`\n✅ Queued as job ${submission.jobId}`);
  console.log(`   page:   ${submission.page}`);
  console.log(`   follow: ${outcome.jobUrl}`);

  if (noWait) {
    console.log(
      `\nNot waiting (--no-wait). Run \`co2-runner serve\` later and the ` +
        `result will be picked up automatically.`,
    );
    submitHistory.close();
    Deno.exit(0);
  }

  console.log(`\nWaiting for the cluster — this usually takes 5–30 minutes.`);
  const watched = await watchSubmission(
    submission,
    submitHistory,
    // Progress goes to stderr so stdout stays a clean report.
    { gmtProgress: (p) => console.error(`   … ${p.message}`) },
  );
  submitHistory.close();

  if (!watched.ok) {
    console.error(`\n⚠️  ${watched.error}`);
    Deno.exit(1);
  }

  const m = watched.metrics;
  const fmt = (v: number | null, digits: number, unit: string) =>
    v === null ? "N/A" : `${v.toFixed(digits)} ${unit}`;

  console.log(`\n=== GMT Cluster Report: ${submission.journeyName} ===`);
  console.log(`Rendering energy   ${fmt(m.cpuEnergyMWh, 4, "mWh")}`);
  console.log(`Rendering power    ${fmt(m.cpuPowerW, 2, "W")}`);
  console.log(`Phase duration     ${fmt(m.durationSeconds, 2, "s")}`);
  console.log(`Network transfer   ${fmt(m.networkTransferKb, 2, "kB")}`);
  console.log(`Network carbon     ${fmt(m.networkCarbonG, 4, "gCO2e")}`);
  console.log(
    `Grid intensity     ${fmt(m.carbonIntensityGCO2PerKWh, 0, "gCO2e/kWh")}`,
  );
  console.log(`Details            ${m.detailsUrl}`);

  if (submission.localMWh !== null) {
    console.log(
      `\nYour last local run of this journey: ${
        submission.localMWh.toFixed(4)
      } mWh.`,
    );
    console.log(
      `These are different measurements, not a before/after: local sums the\n` +
        `whole Firefox process on this machine across the entire journey, while\n` +
        `the cluster reports RAPL package energy for the journey phase only, in\n` +
        `a container with a warm cache. Compare trends, not absolute values.`,
    );
  }
  Deno.exit(0);
}

// ── HTTP server (dev + desktop modes) ───────────────────────────────────────
const store = new ResultsStore();
const history = new History(defaultDbPath());

// On startup, check whether Firefox is already installed and broadcast the
// status to subscribers (UI uses this to enable/disable the Run button).
isFirefoxInstalled().then((installed) => store.setFirefoxInstalled(installed));

// Pick up any GMT cluster submissions that were still pending when we last
// exited. Cluster runs take 5-30 minutes, so it is normal for the app to be
// closed before a result lands.
const resumed = resumePendingSubmissions(history, store);
if (resumed.length > 0) {
  console.log(
    `Resuming ${resumed.length} pending GMT submission(s): ${
      resumed.map((s) => s.jobId).join(", ")
    }`,
  );
}

function sseEncode(event: StoreEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const jsonError = (error: string, status: number) =>
  jsonResponse({ error }, status);

// Resolve a client-supplied journey path against the journeys/ root and
// refuse anything that escapes it. Prevents the /run endpoint from being
// used as a path-traversal primitive (e.g. POST /run {"journey":"../../etc/passwd"}).
// Absolute paths outside JOURNEYS_ROOT are also rejected.
const JOURNEYS_ROOT = resolve(Deno.cwd(), "journeys");

function safeJourneyPath(input: string): string | null {
  const resolved = isAbsolute(input) ? input : resolve(JOURNEYS_ROOT, input);
  const rel = relative(JOURNEYS_ROOT, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return resolved;
}

const port = parseInt(Deno.env.get("PORT") ?? "8000", 10);
// Bind to loopback only: the /run endpoint can read journey files from disk,
// so we don't want to expose it to other hosts on the network.
const hostname = "127.0.0.1";
Deno.serve({ port, hostname }, async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === "/" && req.method === "GET") {
    return new Response(renderDashboard(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (url.pathname === "/favicon.ico" && req.method === "GET") {
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/firefox-status" && req.method === "GET") {
    return new Response(
      JSON.stringify({ installed: store.firefoxInstalled }),
      { headers: { "content-type": "application/json" } },
    );
  }

  if (url.pathname === "/install" && req.method === "POST") {
    // Always trigger — Playwright's installer is idempotent (it skips
    // downloads of already-present browsers). We don't gate on
    // store.firefoxInstalled here because the user might have a stale
    // "missing" status we want to override, and re-running install is
    // cheap when Firefox is already present.
    installBrowsersWithProgress((p) => store.installProgress(p))
      .then(() => store.setFirefoxInstalled(true))
      .catch((err) => {
        console.error(`install failed: ${err.message}`);
        store.installProgress({
          phase: "error",
          message: err.message,
        });
      });
    return new Response(
      JSON.stringify({ started: true }),
      { headers: { "content-type": "application/json" } },
    );
  }

  if (url.pathname === "/codegen-status" && req.method === "GET") {
    // Cheap pre-flight check the UI uses to decide whether to enable
    // the "Record Journey" button. Returns whether Firefox is installed
    // AND whether the current env has a graphical display (Linux without
    // DISPLAY/WAYLAND_DISPLAY is headless and can't run codegen).
    // Also returns the OS platform so the UI can hide features that
    // aren't supported on this platform (e.g. film reel screenshots on
    // macOS — see ADR-005).
    return new Response(
      JSON.stringify({
        canCodegen: store.firefoxInstalled && hasGraphicalDisplay(),
        firefoxInstalled: store.firefoxInstalled,
        hasGraphicalDisplay: hasGraphicalDisplay(),
        codegenInProgress: store.codegenInProgress,
        platform: Deno.build.os,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }

  if (url.pathname === "/codegen" && req.method === "POST") {
    let body: { startUrl?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid JSON body" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const startUrl = body.startUrl;
    if (!startUrl) {
      return new Response(JSON.stringify({ error: "startUrl required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    // Gates: Firefox + graphical display. Surface as 409 with a clear
    // message so the UI can guide the user (show install button if
    // Firefox is missing, etc.).
    if (!store.firefoxInstalled) {
      return new Response(
        JSON.stringify({
          error:
            "Firefox is not installed. Click 'Install Firefox' first — codegen uses the same browser as journeys.",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    if (!hasGraphicalDisplay()) {
      return new Response(
        JSON.stringify({
          error:
            "codegen requires a graphical environment. Run co2-runner from a desktop session.",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }

    // Output path: auto-generated under recordedJourneysDir(). The UI
    // notifies the user of the path via the SSE 'complete' event; they
    // then pick the file manually via the existing file picker to run
    // it (answer 2 from the design Q&A).
    const dir = recordedJourneysDir();
    await Deno.mkdir(dir, { recursive: true });
    const outputPath = `${dir}/${buildCodegenFilename(startUrl)}`;

    // Spawn in the background; progress events flow through the SSE stream
    // as 'codegen' events. The HTTP response returns immediately so the
    // UI doesn't block until the user closes the Inspector.
    launchCodegen({ startUrl, outputPath }, (p) => store.codegenProgress(p))
      .catch((err) => {
        console.error(`codegen failed: ${err.message}`);
        store.codegenProgress({
          phase: "error",
          message: err.message,
        });
      });
    return new Response(
      JSON.stringify({ started: true, outputPath }),
      { headers: { "content-type": "application/json" } },
    );
  }

  if (url.pathname === "/events" && req.method === "GET") {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // IMPORTANT: do NOT await writer.write() before returning Response.
    // TransformStream's writer.write() doesn't resolve until the readable
    // side is being drained, and Deno.serve only flushes Response headers
    // to the client once the handler returns. Awaiting here would deadlock
    // — the client never sees headers, never starts reading, the writes
    // never complete. Push the initial events onto the queue (sync), then
    // return; client draining happens after the response is returned.
    writer.write(
      encoder.encode(
        sseEncode({
          type: "firefox-status",
          installed: store.firefoxInstalled,
        }),
      ),
    );
    for (const r of store.results) {
      writer.write(
        encoder.encode(sseEncode({ type: "result", result: r })),
      );
    }

    const unsubscribe = store.subscribe(async (event) => {
      try {
        await writer.write(encoder.encode(sseEncode(event)));
      } catch {
        // writer is closed (client gone) — self-cleanup to avoid leaks
        unsubscribe();
        try {
          await writer.close();
        } catch {
          // already closed
        }
      }
    });

    // close the stream when the client disconnects
    req.signal?.addEventListener("abort", () => {
      unsubscribe();
      try {
        writer.close();
      } catch {
        // writer may already be closed by the subscriber's self-cleanup
      }
    });

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  if (url.pathname === "/run" && req.method === "POST") {
    let body: {
      journey?: string;
      journeyYaml?: string; // legacy alias for journeyContents (pre-codegen)
      journeyContents?: string;
      journeyName?: string;
      slowMo?: boolean;
      filmReel?: boolean;
    };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid JSON body" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    // Gate: a journey cannot run without Firefox installed. Surfacing this
    // here means the UI's Run button is disabled and clicking it returns
    // a meaningful error rather than a downstream Playwright launch failure.
    if (!store.firefoxInstalled) {
      return new Response(
        JSON.stringify({
          error:
            "Firefox is not installed. Click 'Install Firefox' first — it's a one-time ~150MB download.",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }

    let journeyPath: string;
    let displayName: string;

    // `journeyContents` (new) is preferred; `journeyYaml` (old name) is
    // accepted as an alias for backward-compat with older clients that
    // haven't been updated yet.
    const uploaded = body.journeyContents ?? body.journeyYaml;
    if (uploaded !== undefined) {
      const uploadedName = body.journeyName ?? "uploaded-journey.yaml";
      // Write the uploaded contents into a subdirectory under our own
      // data dir (rather than the OS tmp dir). Playwright's `--list`
      // walks the script's parent dir recursively; if that's $TMPDIR,
      // traversal hits EPERM on system subfolders like
      // com.apple.amsengagementd. Co-locating with artefacts also makes
      // the journey file itself visible if users want to inspect it.
      //
      // The uploaded file's extension is preserved verbatim in safeName,
      // so runJourney's dispatcher routes correctly: .yaml → YAML
      // pipeline, .js/.mjs/.ts → codegen-script pipeline.
      const dir = uploadsDir();
      await Deno.mkdir(dir, { recursive: true });
      const safeName = uploadedName.replace(/[^\w.-]/g, "_");
      const tmp = `${dir}/${Date.now()}-${safeName}`;
      await Deno.writeTextFile(tmp, uploaded);
      journeyPath = tmp;
      displayName = uploadedName;
    } else if (body.journey !== undefined) {
      // Legacy path-based mode (CLI, backward-compat).
      const safePath = safeJourneyPath(body.journey);
      if (!safePath) {
        return new Response(
          JSON.stringify({
            error:
              "journey path must resolve inside the journeys/ directory (path traversal blocked)",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      journeyPath = safePath;
      displayName = body.journey;
    } else {
      return new Response(
        JSON.stringify({
          error:
            "either 'journeyContents' (string contents) or 'journey' (path) is required",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    runJourney(journeyPath, store, {
      displayName,
      slowMo: !!body.slowMo,
      filmReel: !!body.filmReel,
    })
      .then((result) => {
        try {
          history.insert(result);
        } catch (err) {
          console.warn(`history write failed: ${(err as Error).message}`);
        }
        // If we wrote a temp file for uploaded contents, clean it up.
        if (uploaded !== undefined) {
          Deno.remove(journeyPath).catch(() => {});
        }
      })
      .catch((err) => {
        console.error(`journey failed: ${err.message}`);
        store.progress({
          name: displayName,
          stepIndex: -1,
          totalSteps: 0,
          action: "error",
          status: "error",
          message: err.message,
        });
        if (uploaded !== undefined) {
          Deno.remove(journeyPath).catch(() => {});
        }
      });
    return new Response(JSON.stringify({ started: true }), {
      headers: { "content-type": "application/json" },
    });
  }

  // ── Green Metrics Tool cluster submission ────────────────────────────
  //
  // Two endpoints: /gmt-preview converts a journey and returns what *would*
  // be sent (no network call), and /gmt-submit actually sends it. The preview
  // exists so the UI can show the user the exact script and target URL before
  // anything leaves the machine — this is the only feature that talks to a
  // third-party service, so it never fires without a deliberate click.

  if (url.pathname === "/gmt-preview" && req.method === "POST") {
    let body: { journeyContents?: string; journeyName?: string };
    try {
      body = await req.json();
    } catch {
      return jsonError("invalid JSON body", 400);
    }
    if (typeof body.journeyContents !== "string") {
      return jsonError("'journeyContents' is required", 400);
    }
    try {
      const config = parseJourneyConfig(
        body.journeyContents,
        body.journeyName ?? "journey",
      );
      const script = journeyToGmtScript(config);
      return jsonResponse({
        journeyName: config.name,
        page: script.page,
        script: script.script,
        estimatedSeconds: script.estimatedSeconds,
        localMWh: history.latestByName(config.name)?.mWh ?? null,
      });
    } catch (err) {
      return jsonError((err as Error).message, 400);
    }
  }

  if (url.pathname === "/gmt-submit" && req.method === "POST") {
    let body: {
      journeyContents?: string;
      journeyName?: string;
      email?: string;
    };
    try {
      body = await req.json();
    } catch {
      return jsonError("invalid JSON body", 400);
    }
    if (typeof body.journeyContents !== "string") {
      return jsonError("'journeyContents' is required", 400);
    }

    const uploadedName = body.journeyName ?? "uploaded-journey.yaml";
    if (!/\.ya?ml$/i.test(uploadedName)) {
      return jsonError(
        "only YAML journeys can be submitted to the GMT cluster — " +
          "codegen .spec.js journeys are not supported yet",
        400,
      );
    }

    // Same staging dir as /run: the converter reads from disk so the journey
    // path is the shared interface between the two pipelines.
    const dir = uploadsDir();
    await Deno.mkdir(dir, { recursive: true });
    const safeName = uploadedName.replace(/[^\w.-]/g, "_");
    const stagedPath = `${dir}/${Date.now()}-gmt-${safeName}`;
    await Deno.writeTextFile(stagedPath, body.journeyContents);

    try {
      const outcome = await submitJourney({
        journeyPath: stagedPath,
        displayName: uploadedName,
        email: body.email?.trim() || undefined,
        history,
        store,
      });
      // Poll in the background; the UI follows along over SSE.
      watchSubmission(outcome.submission, history, store)
        .catch((err) => console.error(`GMT watch failed: ${err.message}`));

      return jsonResponse({
        jobId: outcome.submission.jobId,
        page: outcome.submission.page,
        jobUrl: outcome.jobUrl,
        localMWh: outcome.submission.localMWh,
      });
    } catch (err) {
      return jsonError((err as Error).message, 502);
    } finally {
      await Deno.remove(stagedPath).catch(() => {});
    }
  }

  if (url.pathname === "/gmt-submissions" && req.method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
    return jsonResponse(history.recentGmtSubmissions(limit));
  }

  if (url.pathname === "/history" && req.method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    return new Response(JSON.stringify(history.recent(limit)), {
      headers: { "content-type": "application/json" },
    });
  }

  if (url.pathname === "/grid-intensities" && req.method === "GET") {
    // Returns the full list of grid-intensity entries (WORLD first, then
    // regional averages, then per-country average + marginal). Cached on
    // the server side after first call. Used by the dashboard to populate
    // the per-card carbon-intensity dropdown.
    return new Response(
      JSON.stringify({ entries: gridIntensityEntries() }),
      { headers: { "content-type": "application/json" } },
    );
  }

  if (url.pathname === "/open-home" && req.method === "POST") {
    // Open the co2-runner home directory (~/.co2-runner/ or
    // $CO2_RUNNER_HOME) in the OS file manager — `open` on macOS,
    // `xdg-open` on Linux, `explorer` on Windows. Makes it easy to
    // find recorded journeys / artefacts without needing to know how
    // to navigate to a hidden directory in Finder.
    const dir = co2RunnerHome();
    try {
      const cmd = Deno.build.os === "darwin"
        ? new Deno.Command("open", { args: [dir] })
        : Deno.build.os === "linux"
        ? new Deno.Command("xdg-open", { args: [dir] })
        : new Deno.Command("explorer", { args: [dir] });
      await cmd.spawn().status;
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: `could not open ${dir}: ${(err as Error).message}`,
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ opened: dir }),
      { headers: { "content-type": "application/json" } },
    );
  }

  return new Response("Not found", { status: 404 });
});
