// main.ts — CLI subcommand router + HTTP server.

import { isAbsolute, relative, resolve } from "path";
import {
  installBrowsers,
  installBrowsersWithProgress,
  isFirefoxInstalled,
} from "./runner/install.ts";
import { runJourney } from "./runner/run.ts";
import { ResultsStore, type StoreEvent } from "./ui/results.ts";
import { renderDashboard } from "./ui/components.ts";
import { History } from "./ui/history.ts";
import { defaultDbPath, uploadsDir } from "./ui/paths.ts";

const args = Deno.args;
const isServeMode = args[0] === "serve";
// `deno desktop` sets DENO_SERVE_ADDRESS and passes no args; in that case we
// skip CLI subcommand parsing entirely and go straight to the HTTP server.
const isDesktopMode = !!Deno.env.get("DENO_SERVE_ADDRESS");

const USAGE = `co2-runner — measure real browser energy per user journey

USAGE:
  co2-runner install                    Download Playwright's bundled Firefox
  co2-runner run <journey.yaml>         Run a journey, emit energy figures
  co2-runner serve                     Start the HTTP / desktop UI
  co2-runner --help                     Show this message

ENV:
  PORT                  HTTP port for serve mode (default 8000)
  CO2_RUNNER_DB         SQLite history DB path (default ~/.co2-runner/history.db)
  DENO_SERVE_ADDRESS    Set by \`deno desktop\`; when present, run suppresses stdout

EXAMPLES:
  co2-runner install
  co2-runner run journeys/example.yaml
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

  if (args[0] !== "install" && args[0] !== "run" && args[0] !== "serve") {
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

// ── HTTP server (dev + desktop modes) ───────────────────────────────────────
const store = new ResultsStore();
const history = new History(defaultDbPath());

// On startup, check whether Firefox is already installed and broadcast the
// status to subscribers (UI uses this to enable/disable the Run button).
isFirefoxInstalled().then((installed) => store.setFirefoxInstalled(installed));

function sseEncode(event: StoreEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

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

    runJourney(journeyPath, store, { displayName })
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

  if (url.pathname === "/history" && req.method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    return new Response(JSON.stringify(history.recent(limit)), {
      headers: { "content-type": "application/json" },
    });
  }

  return new Response("Not found", { status: 404 });
});
