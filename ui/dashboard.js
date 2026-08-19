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
  } else if (ev.type === "gmt") {
    renderGmtEvent(ev.gmt);
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
  updateGmtButton();
}

// The cluster does its own measuring, so this button does NOT depend on a
// local Firefox install — only on a YAML journey being picked. Codegen
// .spec.js journeys cannot be translated to a GMT script body yet.
function updateGmtButton() {
  const btn = document.getElementById("gmt-btn");
  btn.disabled = !selectedFile || !/\.ya?ml$/i.test(selectedFile.name);
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

// ── Green Metrics Tool cluster submission ────────────────────────────────
//
// A second opinion on the local Firefox-profiler figure: the same journey is
// translated into a Playwright snippet and measured on Green Coding
// Solutions' cluster, which reads CPU energy from RAPL on dedicated hardware.
//
// This is the only part of co2-runner that talks to a third-party service, so
// it never fires implicitly. The button opens a modal that shows the exact
// snippet and target URL; nothing is sent until the user confirms there.

// Cards by job id, so SSE updates can patch a card in place rather than
// re-rendering the whole list on every 30-second poll tick.
const gmtCards = new Map();

async function openGmtModal() {
  if (!selectedFile) return;
  setStatus("⏳ Preparing cluster submission…");
  let preview;
  try {
    const contents = await selectedFile.text();
    const res = await fetch("/gmt-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        journeyContents: contents,
        journeyName: selectedFile.name,
      }),
    });
    preview = await res.json();
    if (!res.ok) {
      setStatus("⚠️ " + (preview.error ?? "could not prepare the journey"));
      return;
    }
  } catch (err) {
    setStatus("⚠️ " + err.message);
    return;
  }

  setStatus("");
  document.getElementById("gmt-preview-page").textContent = preview.page;
  document.getElementById("gmt-preview-duration").textContent = "~" +
    preview.estimatedSeconds + " s";
  document.getElementById("gmt-preview-script").textContent = preview.script;
  document.getElementById("gmt-modal").classList.remove("hidden");
}

function closeGmtModal() {
  document.getElementById("gmt-modal").classList.add("hidden");
}

async function submitToGmt() {
  if (!selectedFile) return;
  const btn = document.getElementById("gmt-confirm");
  btn.disabled = true;
  try {
    const contents = await selectedFile.text();
    const res = await fetch("/gmt-submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        journeyContents: contents,
        journeyName: selectedFile.name,
        email: document.getElementById("gmt-email-input").value.trim(),
      }),
    });
    const j = await res.json();
    if (res.ok) {
      closeGmtModal();
      setStatus("☁️ Submitted as job " + j.jobId + " — waiting on the cluster");
    } else {
      setStatus("⚠️ " + (j.error ?? "submission failed"));
    }
  } catch (err) {
    setStatus("⚠️ " + err.message);
  } finally {
    btn.disabled = false;
  }
}

function renderGmtEvent(p) {
  upsertGmtCard({
    jobId: p.jobId,
    journeyName: p.journeyName,
    page: p.page ?? null,
    status: p.status,
    localMWh: p.localMWh ?? null,
    metrics: p.metrics ?? null,
    error: p.status === "error" ? p.message : null,
    message: p.message,
  });
}

function upsertGmtCard(sub) {
  document.getElementById("gmt-section-title").classList.remove("hidden");

  let card = gmtCards.get(sub.jobId);
  if (!card) {
    card = document.createElement("div");
    gmtCards.set(sub.jobId, card);
    document.getElementById("gmt-results").prepend(card);
  }
  // A card created by an earlier event may already know the page URL that
  // this event omits; keep whatever we have.
  if (sub.page) card.dataset.page = sub.page;

  card.className = "gmt-card" + (sub.status === "error" ? " failed" : "");
  card.innerHTML = renderGmtCard(sub, card.dataset.page ?? "");
}

const gmtNum = (v, digits, unit) =>
  typeof v === "number" && isFinite(v)
    ? v.toFixed(digits) + (unit ? " " + unit : "")
    : "N/A";

function renderGmtCard(sub, page) {
  const jobUrl =
    "https://website-tester.green-coding.io/script-details.html?job_id=" +
    encodeURIComponent(sub.jobId);

  let body;
  if (sub.status === "complete" && sub.metrics) {
    const m = sub.metrics;
    const local = typeof sub.localMWh === "number"
      ? '<div><div class="gmt-metric-value local">' +
        sub.localMWh.toFixed(4) +
        '</div><div class="gmt-metric-label">mWh — your local run</div></div>'
      : "";
    body = '<div class="gmt-metrics">' +
      '<div><div class="gmt-metric-value">' + gmtNum(m.cpuEnergyMWh, 4, "") +
      '</div><div class="gmt-metric-label">mWh — cluster (RAPL)</div></div>' +
      local +
      '<div><div class="gmt-metric-value">' + gmtNum(m.cpuPowerW, 2, "W") +
      '</div><div class="gmt-metric-label">CPU power</div></div>' +
      '<div><div class="gmt-metric-value">' +
      gmtNum(m.networkTransferKb, 1, "kB") +
      '</div><div class="gmt-metric-label">Network transfer</div></div>' +
      '<div><div class="gmt-metric-value">' +
      gmtNum(m.networkCarbonG, 4, "g") +
      '</div><div class="gmt-metric-label">Network CO₂e</div></div>' +
      '<div><div class="gmt-metric-value">' +
      gmtNum(m.carbonIntensityGCO2PerKWh, 0, "") +
      '</div><div class="gmt-metric-label">gCO₂e/kWh — grid at run time</div></div>' +
      "</div>" +
      '<div class="gmt-links"><a href="' + m.detailsUrl +
      '" target="_blank" rel="noopener">Full run on metrics.green-coding.io ↗</a></div>' +
      '<p class="gmt-caveat">' +
      "The cluster figure and your local figure measure different things and are " +
      "not a before/after. Locally, co2-runner sums the whole Firefox process on " +
      "this machine across the entire journey. The cluster reports RAPL package " +
      "energy for the journey phase only, inside a container with a warm cache and " +
      "a proxy in front. Compare each against its own history, not against each other." +
      "</p>";
  } else {
    body = '<div class="gmt-status ' + sub.status + '">' +
      escapeHtml(sub.error ?? sub.message ?? "Waiting on the cluster…") +
      "</div>";
  }

  return '<div class="gmt-card-head">' +
    '<span class="gmt-card-name">' + escapeHtml(sub.journeyName) + "</span>" +
    '<span class="gmt-card-page">' + escapeHtml(page) + "</span>" +
    "</div>" +
    body +
    '<div class="gmt-links"><a href="' + jobUrl +
    '" target="_blank" rel="noopener">Job ' + sub.jobId +
    " on webNRG ↗</a></div>";
}

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

// Past + in-flight submissions, so a card survives a page reload (a cluster
// run easily outlives the browser tab that started it).
async function loadGmtSubmissions() {
  try {
    const res = await fetch("/gmt-submissions?limit=20");
    const subs = await res.json();
    subs.reverse().forEach((s) => upsertGmtCard({ ...s, message: null }));
  } catch {
    // server not reachable; nothing to do
  }
}

document.getElementById("gmt-btn").addEventListener("click", openGmtModal);
document.getElementById("gmt-cancel").addEventListener("click", closeGmtModal);
document.getElementById("gmt-confirm").addEventListener("click", submitToGmt);

loadGmtSubmissions();
