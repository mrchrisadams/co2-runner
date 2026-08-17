// ui/dashboard.js — client-side logic for the CO2 Runner dashboard.
// Subscribes to /events (SSE) for install-progress, firefox-status,
// journey-progress, and result events. Uses the native file picker
// (no path is ever visible to the page) and uploads YAML contents.

const evtSource = new EventSource("/events");

let firefoxInstalled = false;
let installInProgress = false;
let codegenInProgress = false;
let canCodegen = false;
let selectedFile = null; // File object from <input type=file>

evtSource.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === "result") {
    addResultCard(ev.result);
  } else if (ev.type === "progress") {
    if (ev.progress.status === "error") {
      setStatus("⚠️ " + (ev.progress.message ?? "journey failed"));
    } else {
      setStatus(
        `⏳ Step ${
          ev.progress.stepIndex + 1
        }/${ev.progress.totalSteps}: ${ev.progress.action}`,
      );
    }
  } else if (ev.type === "firefox-status") {
    firefoxInstalled = ev.installed;
    installInProgress = false;
    renderFirefoxStatus();
  } else if (ev.type === "install") {
    renderInstallEvent(ev.install);
  } else if (ev.type === "codegen") {
    renderCodegenEvent(ev.codegen);
  }
};

// ── Firefox install status ─────────────────────────────────────────────

function renderFirefoxStatus() {
  const dot = document.getElementById("firefox-dot");
  const label = document.getElementById("firefox-label");
  const btn = document.getElementById("install-btn");

  dot.classList.remove("installed", "missing", "installing");

  if (installInProgress) {
    dot.classList.add("installing");
    label.textContent = "Installing Firefox… (~150MB download)";
    btn.classList.add("hidden");
    btn.disabled = true;
  } else if (firefoxInstalled) {
    dot.classList.add("installed");
    label.textContent = "Firefox is installed — ready to run";
    btn.classList.add("hidden");
    btn.disabled = true;
  } else {
    dot.classList.add("missing");
    label.textContent = "Firefox is NOT installed — required to run journeys";
    btn.classList.remove("hidden");
    btn.disabled = false;
  }
  updateRunButton();
}

function renderInstallEvent(p) {
  if (p.phase === "starting") {
    installInProgress = true;
    renderFirefoxStatus();
    setStatus("📥 " + p.message);
  } else if (p.phase === "downloading") {
    setStatus("📥 " + p.message);
  } else if (p.phase === "complete") {
    installInProgress = false;
    setStatus("✅ " + p.message);
    // Poll the server's status endpoint to refresh firefoxInstalled
    fetch("/firefox-status").then((r) => r.json()).then((j) => {
      firefoxInstalled = j.installed;
      renderFirefoxStatus();
      // Also refresh codegen-ability: now that Firefox is installed,
      // the Record button should enable (graphical env assumed).
      refreshCodegenStatus();
    }).catch(() => {});
  } else if (p.phase === "error") {
    installInProgress = false;
    renderFirefoxStatus();
    setStatus("⚠️ " + p.message);
  }
}

async function triggerInstall() {
  const btn = document.getElementById("install-btn");
  btn.disabled = true;
  try {
    await fetch("/install", { method: "POST" });
  } catch (err) {
    setStatus("⚠️ install request failed: " + err.message);
    btn.disabled = false;
  }
}

// ── File picker ─────────────────────────────────────────────────────────

function onFilePicked(e) {
  const file = e.target.files[0];
  selectedFile = file ?? null;
  const labelEl = document.getElementById("file-label-text");
  const fileLabel = document.querySelector(".file-label");
  if (file) {
    labelEl.textContent = "📄 " + file.name;
    fileLabel.classList.add("has-file");
  } else {
    labelEl.textContent = "📄 Choose a journey YAML or codegen JS file…";
    fileLabel.classList.remove("has-file");
  }
  updateRunButton();
}

function updateRunButton() {
  const btn = document.getElementById("run-btn");
  btn.disabled = !firefoxInstalled || !selectedFile || installInProgress;
}

// ── Run journey ──────────────────────────────────────────────────────────

async function startRun() {
  if (!selectedFile) return;
  const btn = document.getElementById("run-btn");
  btn.disabled = true;
  setStatus("⏳ Uploading journey…");
  const slowMo = document.getElementById("slowmo-checkbox").checked;
  const filmReel = document.getElementById("filmreel-checkbox").checked;
  try {
    const contents = await selectedFile.text();
    const res = await fetch("/run", {
      method: "POST",
      body: JSON.stringify({
        journeyContents: contents,
        journeyName: selectedFile.name,
        slowMo,
        filmReel,
      }),
      headers: { "content-type": "application/json" },
    });
    if (res.ok) {
      setStatus("🚀 Journey started — results will appear below");
    } else {
      const j = await res.json().catch(() => ({ error: "request failed" }));
      setStatus("⚠️ " + j.error);
    }
  } catch (err) {
    setStatus("⚠️ " + err.message);
  } finally {
    updateRunButton();
  }
}

// ── Result card rendering ────────────────────────────────────────────────
//
// Each card has a grid-intensity dropdown that updates the CO2e metric
// client-side. The intensity entries are fetched once from
// /grid-intensities (cached in the gridIntensities global) and cloned
// into each card.

let gridIntensities = []; // Array of { zoneId, zoneName, countryName, intensity, carbonFree, label }

async function ensureGridIntensitiesLoaded() {
  if (gridIntensities.length > 0) return;
  try {
    const res = await fetch("/grid-intensities");
    const j = await res.json();
    gridIntensities = j.entries ?? [];
  } catch {
    // network error — leave gridIntensities empty; CO2e will show as '—'
  }
}

function addResultCard(r) {
  const card = document.createElement("div");
  card.className = "result-card";
  card.innerHTML = renderResultCard(r);
  document.getElementById("results").prepend(card);
  // Wire up the grid-intensity dropdown on the freshly-added card.
  // Finds the <select> via its DOM reference under this card.
  const select = card.querySelector(".grid-select");
  if (select) {
    select.addEventListener(
      "change",
      () => updateCardCO2e(card, r.mWh, select.value),
    );
    // Compute initial CO2e using the default selection (WORLD).
    updateCardCO2e(card, r.mWh, select.value);
  }
  setStatus("");
}

function renderResultCard(r) {
  // Build the <option> list from gridIntensities (Electricity Maps 2025).
  // Each entry's label already includes the full formatted string:
  // "Country, Zone - (ID) - intensity - carbonFree%"
  const options = gridIntensities.length > 0
    ? gridIntensities.map((e) =>
      `<option value="${e.intensity}">${e.label}</option>`
    ).join("")
    : `<option value="">Loading grid data…</option>`;

  return `
    <div class="result-name">${r.name}</div>
    <div class="result-metrics">
      <div>
        <div class="metric-value">${r.mWh.toFixed(4)}</div>
        <div class="metric-label">mWh</div>
      </div>
      <div>
        <div class="metric-value">${r.joules.toFixed(4)}</div>
        <div class="metric-label">Joules</div>
      </div>
      <div>
        <div class="metric-value co2e" data-co2e>—</div>
        <div class="metric-label">
          gCO₂e
          <select class="grid-select" title="Grid intensity">${options}</select>
        </div>
      </div>
    </div>
    <div class="result-time">${new Date(r.timestamp).toLocaleString()}</div>
  `;
}

function updateCardCO2e(card, mWh, intensityStr) {
  const intensity = parseFloat(intensityStr);
  // Convert: Wh → gCO2e = Wh × (gCO2/kWh) / 1000.
  // r.mWh is milliwatt-hours; we want watt-hours → divide by 1000.
  const wh = mWh / 1000;
  const gramsCO2e = (wh * intensity) / 1000;
  // Micrograms (the figure is tiny — usually < 0.01 g for a 2 mWh journey).
  // Pick the most readable unit: µg, mg, or g depending on magnitude.
  const el = card.querySelector("[data-co2e]");
  if (!el) return;
  if (gramsCO2e < 0.001) {
    el.textContent = (gramsCO2e * 1_000_000).toFixed(2) + " µg";
  } else if (gramsCO2e < 1) {
    el.textContent = (gramsCO2e * 1000).toFixed(2) + " mg";
  } else {
    el.textContent = gramsCO2e.toFixed(4) + " g";
  }
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

// ── History ──────────────────────────────────────────────────────────────

async function loadHistory() {
  const res = await fetch("/history?limit=20");
  const runs = await res.json();
  // Clear existing cards before appending — previous behaviour appended
  // duplicates every time the button was clicked.
  document.getElementById("results").innerHTML = "";
  runs.reverse().forEach(addResultCard);
}

// ── Open co2-runner home directory ───────────────────────────────────────

async function openHome() {
  try {
    const res = await fetch("/open-home", { method: "POST" });
    const j = await res.json();
    if (res.ok) {
      setStatus(`📂 Opened ${j.opened} in Finder`);
    } else {
      setStatus("⚠️ " + (j.error ?? "could not open directory"));
    }
  } catch (err) {
    setStatus("⚠️ " + err.message);
  }
}

// ── Wire up event listeners ──────────────────────────────────────────────

document.getElementById("install-btn").addEventListener(
  "click",
  triggerInstall,
);
document.getElementById("journey-input").addEventListener(
  "change",
  onFilePicked,
);
document.getElementById("run-btn").addEventListener("click", startRun);
document.getElementById("filmreel-checkbox").addEventListener(
  "change",
  (e) => {
    document.getElementById("filmreel-warning").classList.toggle(
      "visible",
      e.target.checked,
    );
  },
);
document.getElementById("record-btn").addEventListener(
  "click",
  openCodegenModal,
);
document.getElementById("codegen-cancel").addEventListener(
  "click",
  closeCodegenModal,
);
document.getElementById("codegen-start").addEventListener(
  "click",
  startCodegen,
);
document.getElementById("codegen-url-input").addEventListener(
  "input",
  updateCodegenStartButton,
);
document.getElementById("load-history-link").addEventListener(
  "click",
  loadHistory,
);
document.getElementById("open-home-link").addEventListener(
  "click",
  openHome,
);

// If we loaded before the first firefox-status broadcast arrived,
// do a one-shot fetch so the UI is correct on first paint.
fetch("/firefox-status").then((r) => r.json()).then((j) => {
  firefoxInstalled = j.installed;
  renderFirefoxStatus();
}).catch(() => {});

// Prefetch grid intensity data in the background so the first result-card
// render has it ready. If it loads after a card is already displayed, the
// card will show the default WORLD value; users can manually re-pick from
// the dropdown after the page is interactive.
ensureGridIntensitiesLoaded();

// ── Codegen (record a journey) ────────────────────────────────────────

function updateRecordButton() {
  const btn = document.getElementById("record-btn");
  btn.disabled = !canCodegen || codegenInProgress;
  if (codegenInProgress) {
    btn.classList.add("recording");
    btn.textContent = "🔴 Recording…";
  } else {
    btn.classList.remove("recording");
    btn.textContent = "🔴 Record";
  }
}

async function refreshCodegenStatus() {
  try {
    const res = await fetch("/codegen-status");
    const j = await res.json();
    canCodegen = j.canCodegen;
    codegenInProgress = j.codegenInProgress;
    updateRecordButton();
    // Hide the film reel checkbox on macOS — CompositorScreenshot markers
    // are not produced by Playwright's Firefox build on macOS because the
    // CARenderer snapshot path fails silently. See ADR-005.
    if (j.platform === "darwin") {
      document.getElementById("filmreel-checkbox").parentElement.style.display =
        "none";
      document.getElementById("filmreel-warning").style.display = "none";
    }
  } catch {
    // server not reachable; nothing to do
  }
}

function openCodegenModal() {
  if (!canCodegen) {
    if (!firefoxInstalled) {
      setStatus("⚠️ Install Firefox first — codegen uses the same browser.");
    } else {
      setStatus("⚠️ codegen requires a graphical environment.");
    }
    return;
  }
  document.getElementById("codegen-modal").classList.remove("hidden");
  document.getElementById("codegen-url-input").focus();
}

function closeCodegenModal() {
  document.getElementById("codegen-modal").classList.add("hidden");
}

function updateCodegenStartButton() {
  const url = document.getElementById("codegen-url-input").value.trim();
  document.getElementById("codegen-start").disabled = !url;
}

async function startCodegen() {
  const url = document.getElementById("codegen-url-input").value.trim();
  if (!url) return;
  closeCodegenModal();
  setStatus("🔴 Launching Playwright codegen…");
  try {
    const res = await fetch("/codegen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startUrl: url }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: "request failed" }));
      setStatus("⚠️ " + j.error);
    }
  } catch (err) {
    setStatus("⚠️ " + err.message);
  }
}

function renderCodegenEvent(p) {
  if (p.phase === "starting") {
    codegenInProgress = true;
    updateRecordButton();
    setStatus("📥 " + p.message);
  } else if (p.phase === "recording") {
    setStatus("🔴 Recording — " + p.message);
  } else if (p.phase === "complete") {
    codegenInProgress = false;
    updateRecordButton();
    setStatus("✅ " + p.message + " — pick the file via the picker to run it.");
  } else if (p.phase === "error") {
    codegenInProgress = false;
    updateRecordButton();
    setStatus("⚠️ " + p.message);
  }
}

// Initial codegen-status check (refreshes on every install completion too).
refreshCodegenStatus();
