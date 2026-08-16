// ui/components.ts — dashboard HTML (no framework).
// Renders a small dark-themed app that listens to the SSE stream of
// results + progress + install-status events.
//
// The dashboard JavaScript is imported as a raw text string at
// module-load time so it's embedded into the compiled CLI binary AND
// desktop bundle. `with { type: "text" }` is a stable import-attribute
// supported since Deno 2.9 — the contents are inlined as a string
// constant, no disk read needed at runtime.
// (Reading from disk at request time fails in compiled binaries —
// Deno's compiler embeds files as virtual modules, not on disk.)

// deno-lint-ignore no-import-prefix
import dashboardJs from "./dashboard.js" with { type: "text" };

export function renderDashboard(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>CO2 Runner</title>
  <style>
    :root {
      --bg: #0f1117; --surface: #1a1d27; --accent: #4ade80;
      --warn: #fbbf24; --danger: #f87171;
      --text: #e2e8f0; --muted: #64748b; --border: #2d3148;
      font-family: system-ui, sans-serif;
    }
    body { background: var(--bg); color: var(--text); margin: 0; padding: 2rem; }
    h1 { color: var(--accent); font-size: 1.5rem; margin-bottom: 0.25rem; }
    .subtitle { color: var(--muted); margin-bottom: 2rem; font-size: 0.9rem; }

    .firefox-row {
      display: flex; align-items: center; gap: 0.75rem;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1rem;
    }
    .status-dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: var(--muted); flex-shrink: 0;
    }
    .status-dot.installed { background: var(--accent); }
    .status-dot.missing   { background: var(--danger); }
    .status-dot.installing { background: var(--warn); animation: pulse 1.2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
    .status-label { font-size: 0.85rem; flex: 1; }
    .install-btn {
      background: transparent; color: var(--accent);
      border: 1px solid var(--accent); border-radius: 6px;
      padding: 0.4rem 0.85rem; cursor: pointer; font-weight: 600; font-size: 0.85rem;
    }
    .install-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .install-btn.hidden { display: none; }

    .run-form { display: flex; gap: 0.75rem; margin-bottom: 1rem; align-items: stretch; }
    .run-form label.file-label {
      flex: 1; display: flex; align-items: center; gap: 0.5rem;
      background: var(--surface); border: 1px solid var(--border);
      color: var(--text); padding: 0.5rem 0.75rem; border-radius: 6px;
      cursor: pointer; font-size: 0.9rem;
    }
    .run-form label.file-label.has-file { color: var(--accent); }
    .run-form input[type=file] { display: none; }
    .run-form button {
      background: var(--accent); color: #000; padding: 0.5rem 1.25rem;
      border: none; border-radius: 6px; cursor: pointer; font-weight: 600;
    }
    .run-form button:disabled { opacity: 0.5; cursor: not-allowed; }

    #status { color: var(--muted); font-size: 0.85rem; min-height: 1.5rem; }
    #results { display: grid; gap: 1rem; margin-top: 1rem; }
    .result-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 1.25rem;
      animation: fadeIn 0.3s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; } }
    .result-name { font-weight: 600; margin-bottom: 0.5rem; }
    .result-metrics { display: flex; gap: 2rem; }
    .metric-value { font-size: 1.8rem; font-weight: 700; color: var(--accent); }
    .metric-label { font-size: 0.75rem; color: var(--muted); }
    .result-time { font-size: 0.75rem; color: var(--muted); margin-top: 0.5rem; }
    .history-toggle { color: var(--accent); cursor: pointer; text-decoration: underline; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>🌱 CO2 Runner</h1>
  <p class="subtitle">Measure real browser energy consumption per user journey</p>

  <div class="firefox-row">
    <span id="firefox-dot" class="status-dot missing"></span>
    <span id="firefox-label" class="status-label">Checking Firefox…</span>
    <button id="install-btn" class="install-btn hidden"> ↓ Install Firefox</button>
  </div>

  <div class="run-form">
    <label class="file-label" for="journey-input">
      <span id="file-label-text">📄 Choose a journey YAML file…</span>
      <input id="journey-input" type="file" accept=".yaml,.yml" />
    </label>
    <button id="run-btn" disabled>▶ Run Journey</button>
  </div>
  <div id="status"></div>
  <p><span class="history-toggle">Load history</span></p>
  <div id="results"></div>

  <script>
${dashboardJs}
  </script>
</body>

</html>`;
}
