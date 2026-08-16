import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { renderDashboard } from "../../ui/components.ts";

Deno.test("renderDashboard produces a complete HTML document", () => {
  const html = renderDashboard();
  assertStringIncludes(html, "<!DOCTYPE html>");
  assertStringIncludes(html, "</html>");
  assertStringIncludes(html, "<title>CO2 Runner</title>");
});

Deno.test("renderDashboard wires up the SSE endpoint and run form", () => {
  const html = renderDashboard();
  assertStringIncludes(html, "EventSource(\"/events\")");
  assertStringIncludes(html, 'fetch("/run"');
  assertStringIncludes(html, 'fetch("/history');
  assertStringIncludes(html, 'id="journey-input"');
  assertStringIncludes(html, 'id="run-btn"');
});

Deno.test("renderDashboard renders both mWh and Joules metric slots", () => {
  const html = renderDashboard();
  assertStringIncludes(html, "mWh");
  assertStringIncludes(html, "Joules");
});

Deno.test("renderDashboard displays app title", () => {
  assertStringIncludes(renderDashboard(), "🌱 CO2 Runner");
});
