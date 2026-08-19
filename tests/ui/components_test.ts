import { assertStringIncludes } from "jsr:@std/assert";
import { renderDashboard } from "../../ui/components.ts";

// renderDashboard() reads dashboard.js at module-load time via Deno's
// `import ... with { type: "file" }` syntax. This embeds the JS into
// the compiled binary (Deno's compiler recognises the directive and
// inlines the file's contents as a string). Critical: this only works
// because the import is statically analyzable; reading the file at
// request-time via `Deno.readTextFile` would fail in compiled binaries
// (Deno's compiler embeds files as virtual modules, not on disk).

Deno.test("renderDashboard produces a complete HTML document", () => {
  const html = renderDashboard();
  assertStringIncludes(html, "<!DOCTYPE html>");
  assertStringIncludes(html, "</html>");
  assertStringIncludes(html, "<title>CO2 Runner</title>");
});

Deno.test("renderDashboard inlines the dashboard JavaScript", () => {
  // The dashboard JS is inlined into the HTML response (<script>...</script>
  // rather than <script src=/dashboard.js>) so the page works in compiled
  // CLI binaries and desktop bundles where Deno.cwd() is unreliable.
  const html = renderDashboard();
  assertStringIncludes(html, 'EventSource("/events")');
  assertStringIncludes(html, 'fetch("/run"');
  assertStringIncludes(html, 'fetch("/firefox-status"');
  assertStringIncludes(html, 'fetch("/install"');
  assertStringIncludes(html, 'fetch("/history');
  assertStringIncludes(html, 'id="journey-input"');
  assertStringIncludes(html, 'id="run-btn"');
  // The JS body is inline (no external script src):
  assertStringIncludes(html, "<script>\n");
});

Deno.test("renderDashboard renders both mWh and Joules metric slots", () => {
  const html = renderDashboard();
  assertStringIncludes(html, "mWh");
  assertStringIncludes(html, "Joules");
});

Deno.test("renderDashboard displays app title", () => {
  assertStringIncludes(renderDashboard(), "🌱 CO2 Runner");
});

Deno.test("renderDashboard wires up the GMT cluster submission flow", () => {
  const html = renderDashboard();
  assertStringIncludes(html, 'id="gmt-btn"');
  assertStringIncludes(html, 'id="gmt-modal"');
  assertStringIncludes(html, 'id="gmt-results"');
  assertStringIncludes(html, 'fetch("/gmt-preview"');
  assertStringIncludes(html, 'fetch("/gmt-submit"');
  assertStringIncludes(html, 'fetch("/gmt-submissions');
});

Deno.test("renderDashboard warns before anything leaves the machine", () => {
  // Cluster submission is co2-runner's only third-party call. The modal has
  // to say so, and has to show the script that would be sent.
  const html = renderDashboard();
  assertStringIncludes(html, "This leaves your machine.");
  assertStringIncludes(html, "gateway.green-coding.io");
  assertStringIncludes(html, 'id="gmt-preview-script"');
});

Deno.test("renderDashboard qualifies the local-vs-cluster comparison", () => {
  // Showing two energy figures side by side without saying they measure
  // different things would invite a false before/after reading.
  const html = renderDashboard();
  assertStringIncludes(html, "not a before/after");
});
