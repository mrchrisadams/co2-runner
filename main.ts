// main.ts — CLI subcommand router + HTTP server.

import { installBrowsers } from "./runner/install.ts";
import { runJourney } from "./runner/run.ts";
import { ResultsStore, type StoreEvent } from "./ui/results.ts";
import { renderDashboard } from "./ui/components.ts";
import { History, defaultDbPath } from "./ui/history.ts";

const args = Deno.args;
const isServeMode = args[0] === "serve";

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
    console.log(`${result.mWh.toFixed(4)} mWh  (${result.joules.toFixed(4)} J)`);
    Deno.exit(0);
  }
}

// ── HTTP server (dev + desktop modes) ───────────────────────────────────────
const store = new ResultsStore();
const history = new History(defaultDbPath());

function sseEncode(event: StoreEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const port = parseInt(Deno.env.get("PORT") ?? "8000", 10);
Deno.serve({ port }, async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === "/" && req.method === "GET") {
    return new Response(renderDashboard(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (url.pathname === "/events" && req.method === "GET") {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // push existing results immediately
    for (const r of store.results) {
      await writer.write(encoder.encode(sseEncode({ type: "result", result: r })));
    }

    const unsubscribe = store.subscribe((event) => {
      writer.write(encoder.encode(sseEncode(event)));
    });

    // close the stream when the client disconnects
    req.signal?.addEventListener("abort", () => {
      unsubscribe();
      writer.close();
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
    let body: { journey?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid JSON body" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const journey = body.journey;
    if (!journey) {
      return new Response(JSON.stringify({ error: "journey required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    runJourney(journey, store)
      .then((result) => {
        try {
          history.insert(result);
        } catch (err) {
          console.warn(`history write failed: ${(err as Error).message}`);
        }
      })
      .catch((err) => {
        console.error(`journey failed: ${err.message}`);
        store.progress({
          name: journey,
          stepIndex: -1,
          totalSteps: 0,
          action: "error",
          status: "error",
          message: err.message,
        });
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
