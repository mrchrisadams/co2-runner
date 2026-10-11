import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboard } from "../../ui/components.ts";

// renderDashboard() inlines the dashboard JavaScript into the HTML
// response. The JS is read from disk at module-load time (relative to
// ui/components.ts) — packaged builds (SEA/Electron) must embed it at
// build time, which the Phase 5 esbuild bundling does.

test("renderDashboard produces a complete HTML document", () => {
  const html = renderDashboard();
  assert.ok(html.includes("<!DOCTYPE html>"));
  assert.ok(html.includes("</html>"));
  assert.ok(html.includes("<title>CO2 Runner</title>"));
});

test("renderDashboard inlines the dashboard JavaScript", () => {
  // The dashboard JS is inlined into the HTML response (<script>...</script>
  // rather than <script src=/dashboard.js>) so the page works from a single
  // document in packaged builds.
  const html = renderDashboard();
  assert.ok(html.includes('EventSource("/events")'));
  assert.ok(html.includes('fetch("/run"'));
  assert.ok(html.includes('fetch("/firefox-status"'));
  assert.ok(html.includes('fetch("/install"'));
  assert.ok(html.includes('fetch("/history'));
  assert.ok(html.includes('id="journey-input"'));
  assert.ok(html.includes('id="run-btn"'));
  // The JS body is inline (no external script src):
  assert.ok(html.includes("<script>\n"));
});

test("renderDashboard renders both mWh and Joules metric slots", () => {
  const html = renderDashboard();
  assert.ok(html.includes("mWh"));
  assert.ok(html.includes("Joules"));
});

test("renderDashboard displays app title", () => {
  assert.ok(renderDashboard().includes("🌱 CO2 Runner"));
});
