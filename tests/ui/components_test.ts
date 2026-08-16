import { assertStringIncludes } from "jsr:@std/assert";
import { renderDashboard } from "../../ui/components.ts";

// The dashboard is split across two files: an HTML shell produced by
// renderDashboard() and a sibling JavaScript module (ui/dashboard.js) serving
// the behaviour. Tests that pin wiring (EventSource, fetch, metric labels)
// must read both files and assert against the combined output.

async function dashboardBundle(): Promise<string> {
  const html = renderDashboard();
  const js = await Deno.readTextFile("./ui/dashboard.js");
  return `${html}\n${js}`;
}

Deno.test("renderDashboard produces a complete HTML document", () => {
  const html = renderDashboard();
  assertStringIncludes(html, "<!DOCTYPE html>");
  assertStringIncludes(html, "</html>");
  assertStringIncludes(html, "<title>CO2 Runner</title>");
});

Deno.test("dashboard wires up the SSE endpoint and run form", async () => {
  const bundle = await dashboardBundle();
  assertStringIncludes(bundle, 'EventSource("/events")');
  assertStringIncludes(bundle, 'fetch("/run"');
  assertStringIncludes(bundle, 'fetch("/history');
  assertStringIncludes(bundle, 'id="journey-input"');
  assertStringIncludes(bundle, 'id="run-btn"');
});

Deno.test("dashboard renders both mWh and Joules metric slots", async () => {
  const bundle = await dashboardBundle();
  assertStringIncludes(bundle, "mWh");
  assertStringIncludes(bundle, "Joules");
});

Deno.test("renderDashboard displays app title", () => {
  assertStringIncludes(renderDashboard(), "🌱 CO2 Runner");
});
