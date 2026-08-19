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
      --warn: #fbbf24; --danger: #f87171; --info: #60a5fa;
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
    .slowmo-label {
      display: flex; align-items: center; gap: 0.4rem;
      font-size: 0.8rem; color: var(--muted);
      margin-bottom: 1rem; cursor: pointer;
    }
    .slowmo-label input[type=checkbox] { cursor: pointer; }
    .option-checkbox {
      display: flex; align-items: flex-start; gap: 0.4rem;
      font-size: 0.8rem; color: var(--muted);
      margin-bottom: 0.5rem; cursor: pointer;
    }
    .option-checkbox input[type=checkbox] { cursor: pointer; margin-top: 0.1rem; }
    .option-warning {
      color: var(--danger); font-size: 0.75rem;
      margin-left: 1.25rem; margin-bottom: 0.5rem; display: none;
    }
    .option-warning.visible { display: block; }
    #record-btn {
      background: transparent; color: var(--warn);
      border: 1px solid var(--warn);
    }
    #record-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    #record-btn.recording {
      background: var(--warn); color: #000;
      animation: pulse 1.2s infinite;
    }

    /* Modal for codegen URL input */
    .modal {
      position: fixed; inset: 0; background: rgba(0,0,0,0.6);
      display: flex; align-items: center; justify-content: center;
      z-index: 100;
    }
    .modal.hidden { display: none; }
    .modal-content {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 1.5rem; max-width: 500px; width: 90%;
    }
    .modal-content h3 { margin: 0 0 0.5rem; color: var(--text); font-size: 1.1rem; }
    .modal-hint { color: var(--muted); font-size: 0.85rem; margin: 0 0 1rem; line-height: 1.4; }
    .modal-input {
      width: 100%; box-sizing: border-box;
      background: var(--bg); border: 1px solid var(--border);
      color: var(--text); padding: 0.5rem 0.75rem; border-radius: 6px;
      font-size: 0.9rem; margin-bottom: 1rem;
    }
    .modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
    .modal-btn-secondary {
      background: transparent; color: var(--muted);
      border: 1px solid var(--border); border-radius: 6px;
      padding: 0.5rem 1rem; cursor: pointer; font-weight: 600;
    }
    .modal-btn-primary {
      background: var(--warn); color: #000;
      border: none; border-radius: 6px;
      padding: 0.5rem 1rem; cursor: pointer; font-weight: 600;
    }
    .modal-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

    #status { color: var(--muted); font-size: 0.85rem; min-height: 1.5rem; }
    #results { display: grid; gap: 1rem; margin-top: 1rem; }
    .result-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 1.25rem;
      animation: fadeIn 0.3s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; } }
    .result-name { font-weight: 600; margin-bottom: 0.5rem; }
    .result-metrics { display: flex; gap: 2rem; flex-wrap: wrap; }
    .metric-value { font-size: 1.8rem; font-weight: 700; color: var(--accent); }
    .metric-value.co2e { color: var(--warn); }
    .metric-label { font-size: 0.75rem; color: var(--muted); }
    .metric-label .grid-select {
      background: var(--bg); color: var(--muted); border: 1px solid var(--border);
      border-radius: 4px; padding: 0.1rem 0.3rem; font-size: 0.7rem;
      margin-top: 0.25rem; max-width: 420px;
    }
    .result-time { font-size: 0.75rem; color: var(--muted); margin-top: 0.5rem; }
    .action-row { margin: 0.5rem 0 0; display: flex; gap: 1rem; font-size: 0.85rem; }
    .action-link { color: var(--accent); cursor: pointer; text-decoration: underline; }
    .action-link:hover { color: #6ee7a3; }
    .em-footer {
      margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border);
      color: var(--muted); font-size: 0.75rem; line-height: 1.5;
    }
    .em-footer a { color: var(--accent); text-decoration: none; }
    .em-footer a:hover { text-decoration: underline; }

    /* ── Green Metrics Tool cluster submission ────────────────────────── */
    #gmt-btn {
      background: transparent; color: var(--info);
      border: 1px solid var(--info);
    }
    #gmt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .modal-content.wide { max-width: 700px; }
    .script-preview {
      background: var(--bg); border: 1px solid var(--border);
      border-radius: 6px; padding: 0.75rem; margin-bottom: 1rem;
      max-height: 220px; overflow: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.75rem; line-height: 1.5; color: var(--text);
      white-space: pre; tab-size: 2;
    }
    .privacy-note {
      background: rgba(251, 191, 36, 0.1);
      border-left: 3px solid var(--warn);
      color: var(--text); font-size: 0.8rem; line-height: 1.5;
      padding: 0.6rem 0.75rem; margin-bottom: 1rem; border-radius: 0 6px 6px 0;
    }
    .modal-btn-info {
      background: var(--info); color: #000;
      border: none; border-radius: 6px;
      padding: 0.5rem 1rem; cursor: pointer; font-weight: 600;
    }
    .modal-btn-info:disabled { opacity: 0.5; cursor: not-allowed; }
    .gmt-section-title {
      font-size: 0.95rem; color: var(--info);
      margin: 2rem 0 0.5rem; font-weight: 600;
    }
    .gmt-section-title.hidden { display: none; }
    #gmt-results { display: grid; gap: 1rem; }
    .gmt-card {
      background: var(--surface); border: 1px solid var(--border);
      border-left: 3px solid var(--info);
      border-radius: 10px; padding: 1.25rem;
    }
    .gmt-card.failed { border-left-color: var(--danger); }
    .gmt-card-head {
      display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap;
    }
    .gmt-card-name { font-weight: 600; }
    .gmt-card-page { color: var(--muted); font-size: 0.8rem; }
    .gmt-status {
      font-size: 0.85rem; color: var(--muted); margin-top: 0.4rem;
    }
    .gmt-status.pending::before { content: "⏳ "; }
    .gmt-status.error { color: var(--danger); }
    .gmt-metrics {
      display: grid; gap: 0.75rem 2rem; margin-top: 0.9rem;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    }
    .gmt-metric-value {
      font-size: 1.15rem; font-weight: 700; color: var(--info);
    }
    .gmt-metric-value.local { color: var(--accent); }
    .gmt-metric-label { font-size: 0.7rem; color: var(--muted); }
    .gmt-caveat {
      color: var(--muted); font-size: 0.72rem; line-height: 1.5;
      margin-top: 0.9rem; padding-top: 0.6rem;
      border-top: 1px solid var(--border);
    }
    .gmt-links { margin-top: 0.6rem; font-size: 0.8rem; }
    .gmt-links a { color: var(--info); text-decoration: none; }
    .gmt-links a:hover { text-decoration: underline; }
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
      <span id="file-label-text">📄 Choose a journey YAML or codegen JS file…</span>
      <input id="journey-input" type="file" accept=".yaml,.yml,.js,.mjs,.ts" />
    </label>
    <button id="record-btn">🔴 Record</button>
    <button id="gmt-btn" disabled title="Measure this journey on the Green Metrics Tool cluster instead of locally">☁️ Measure on cluster</button>
    <button id="run-btn" disabled>▶ Run Journey</button>
  </div>
  <label class="option-checkbox" for="slowmo-checkbox">
    <input id="slowmo-checkbox" type="checkbox" />
    Run user journey with 1.5 second delay between each step
  </label>

  <label class="option-checkbox" for="filmreel-checkbox">
    <input id="filmreel-checkbox" type="checkbox" />
    Capture film reel screenshots (viewable in Firefox Profiler)
  </label>
  <div id="filmreel-warning" class="option-warning">
    ⚠️ Capturing screenshots adds computational overhead that inflates energy readings. Turn this off for accurate measurements.
  </div>

  <!-- URL prompt modal for codegen recording -->
  <div id="codegen-modal" class="modal hidden">
    <div class="modal-content">
      <h3>Record a new journey</h3>
      <p class="modal-hint">
        Enter the URL to start at. Playwright's Inspector will open in a new
        Firefox window — click around the site as if you were a user. When you
        close the Inspector, the recorded script will be saved and you can
        pick it via the file picker to run.
      </p>
      <input
        id="codegen-url-input"
        type="url"
        placeholder="https://branch.climateaction.tech/"
        class="modal-input"
      />
      <div class="modal-actions">
        <button id="codegen-cancel" class="modal-btn-secondary">Cancel</button>
        <button id="codegen-start" class="modal-btn-primary" disabled>🔴 Start recording</button>
      </div>
    </div>
  </div>
  <!-- Confirmation modal for a Green Metrics Tool cluster submission.
       Shows the exact payload before anything leaves the machine. -->
  <div id="gmt-modal" class="modal hidden">
    <div class="modal-content wide">
      <h3>Measure on the Green Metrics Tool cluster</h3>
      <p class="modal-hint">
        Your journey is translated into a Playwright snippet and measured on
        Green Coding Solutions' cluster, which reads CPU energy from RAPL on
        dedicated hardware. Results usually take 5&ndash;30 minutes.
      </p>
      <div class="privacy-note">
        <b>This leaves your machine.</b> The target URL, the snippet below and
        your e-mail (if given) are sent to
        <b>gateway.green-coding.io</b> and the run is publicly listed on
        metrics.green-coding.io.
      </div>
      <div><span class="gmt-card-page">Target URL:</span> <span id="gmt-preview-page"></span></div>
      <div><span class="gmt-card-page">Estimated length:</span> <span id="gmt-preview-duration"></span></div>
      <pre id="gmt-preview-script" class="script-preview"></pre>
      <input
        id="gmt-email-input"
        type="email"
        placeholder="Your e-mail (optional — the cluster pings you when done)"
        class="modal-input"
      />
      <div class="modal-actions">
        <button id="gmt-cancel" class="modal-btn-secondary">Cancel</button>
        <button id="gmt-confirm" class="modal-btn-info">☁️ Submit to cluster</button>
      </div>
    </div>
  </div>
  <div id="status"></div>
  <div class="action-row">
    <span class="action-link" id="load-history-link">Load history</span>
    <span class="action-link" id="open-home-link">📂 Open co2-runner home directory</span>
  </div>
  <div id="results"></div>

  <div id="gmt-section-title" class="gmt-section-title hidden">☁️ Green Metrics Tool cluster</div>
  <div id="gmt-results"></div>

  <footer class="em-footer">
    Carbon intensity data from
    <a href="https://www.electricitymaps.com/data/methodology" target="_blank" rel="noopener">Electricity Maps</a>.
    Published under the
    <a href="https://opendatacommons.org/licenses/odbl/summary/" target="_blank" rel="noopener">Open Database License (ODbL)</a>.
    More, higher-resolution data available at
    <a href="https://www.electricitymaps.com/data" target="_blank" rel="noopener">electricitymaps.com/data</a>.
  </footer>

  <script>
${dashboardJs}
  </script>
</body>

</html>`;
}
