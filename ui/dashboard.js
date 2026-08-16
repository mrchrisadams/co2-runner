const evtSource = new EventSource("/events");
evtSource.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === "result") addResultCard(ev.result);
  else if (ev.type === "progress") setStatus(`⏳ Step ${ev.progress.stepIndex + 1}/${ev.progress.totalSteps}: ${ev.progress.action}`);
};

function addResultCard(r) {
  const card = document.createElement("div");
  card.className = "result-card";
  
  // We can't use the template literal as defined above directly because it uses 'r'.
  // Let's make it a function instead for better clarity and to avoid scoping issues.
  card.innerHTML = renderResultCard(r);
  
  document.getElementById("results").prepend(card);
  setStatus("");
}

function renderResultCard(r) {
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
    </div>
    <div class="result-time">${new Date(r.timestamp).toLocaleString()}</div>
  `;
}

function setStatus(msg) { document.getElementById("status").textContent = msg; }

async function startRun() {
  const journey = document.getElementById("journey-input").value.trim();
  if (!journey) return;
  const btn = document.getElementById("run-btn");
  btn.disabled = true;
  setStatus("⏳ Running journey...");
  try {
    const res = await fetch("/run", {
      method: "POST",
      body: JSON.stringify({ journey }),
      headers: { "content-type": "application/json" }
    });
    if (res.ok) setStatus("🚀 Journey started — results will appear below");
  } finally {
    btn.disabled = false;
  }
}

async function loadHistory() {
  const res = await fetch("/history?limit=20");
  const runs = await res.json();
  runs.reverse().forEach(addResultCard);
}
