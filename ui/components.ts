// ui/components.ts — dashboard HTML (no framework).
// Renders a small dark-themed app that listens to the SSE stream of
// results + progress and lets the user kick off a journey via POST /run.

export function renderDashboard(): string {


  return /* html */ `<!DOCTYPE html>
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
    .run-form { display: flex; gap: 0.75rem; margin-bottom: 1rem; }
    .run-form input {
      flex: 1; background: var(--surface); border: 1px solid var(--border);
      color: var(--text); padding: 0.5rem 0.75rem; border-radius: 6px;
    }
    .run-form button {
      background: var(--accent); color: #000; padding: 0.5rem 1.25rem;
      border: none; border-radius: 6px; cursor: pointer; font-weight: 600;
    }
    .run-form button:disabled { opacity: 0.5; cursor: not-allowed; }
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
    #status { color: var(--muted); font-size: 0.85rem; min-height: 1.5rem; }
    .history-toggle { color: var(--accent); cursor: pointer; text-decoration: underline; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>🌱 CO2 Runner</h1>
  <p class="subtitle">Measure real browser energy consumption per user journey</p>

  <div class="run-form">
    <input id="journey-input" type="text" placeholder="Path to journey YAML (e.g. journeys/example.yaml)" />
    <button id="run-btn" onclick="startRun()">▶ Run Journey</button>
  </div>
  <div id="status"></div>
  <p><span class="history-toggle" onclick="loadHistory()">Load history</span></p>
  <div id="results"></div>

  <script src="/dashboard.js"></script>
</body>

</html>`;
}
