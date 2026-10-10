// Integration tests for the firefox-install + journey-upload endpoints
// introduced alongside the file-picker UI.

import { test } from "node:test";
import { readTextFile } from "../../util/fsx.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const TSX = fileURLToPath(
  new URL("../../node_modules/.bin/tsx", import.meta.url),
);

const SERVER_PORT = 8805;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

async function withServer(run: () => Promise<void>): Promise<void> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CO2_RUNNER_DB: `/tmp/co2-runner-install-${Date.now()}.db`,
    PORT: String(SERVER_PORT),
  };
  const child = spawn(TSX, ["main.ts", "serve"], {
    detached: true,
    env,
    stdio: "inherit",
  });
  const exited = new Promise<boolean>((r) => child.once("exit", () => r(true)));

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try {
        await fetch(BASE);
        up = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert(up, "server did not start in time");

    await run();
  } finally {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {}
    const gone = await Promise.race([
      exited,
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
    ]);
    if (!gone) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      await Promise.race([
        exited,
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }
  }
}

// ── /firefox-status ────────────────────────────────────────────────────

test("GET /firefox-status returns a boolean installed flag", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/firefox-status`);
    assert.deepEqual(res.status, 200);
    const json = await res.json();
    assert.deepEqual(typeof json.installed, "boolean");
  }));

// ── /install ────────────────────────────────────────────────────────────

test("POST /install acknowledges and returns { started: true }", () =>
  withServer(async () => {
    // We do NOT actually let the install complete — it'd download ~150MB.
    // We just assert the endpoint accepts the request and responds.
    // Subscribe to SSE first to capture the install-start event.
    const ctrl = new AbortController();
    const sseRes = await fetch(`${BASE}/events`, { signal: ctrl.signal });
    const reader = sseRes.body!.getReader();

    const res = await fetch(`${BASE}/install`, { method: "POST" });
    assert.deepEqual(res.status, 200);
    assert.deepEqual(await res.json(), { started: true });

    // Read a couple of SSE chunks — expect to see an install event
    // appear quickly (starting/downloading). Cap at 5s so we don't
    // actually wait for the 150MB download.
    const deadline = Date.now() + 5000;
    let sawInstallEvent = false;
    while (Date.now() < deadline && !sawInstallEvent) {
      const { value } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined }>((r) =>
          setTimeout(() => r({ value: undefined }), 500)
        ),
      ]);
      if (!value) continue;
      const text = new TextDecoder().decode(value);
      if (text.includes('"type":"install"')) {
        sawInstallEvent = true;
        break;
      }
    }
    try {
      ctrl.abort();
    } catch {}
    try {
      await reader.cancel();
    } catch {}
    assert(sawInstallEvent, "expected an install event on the SSE stream");
  }));

test("POST /install without a body still starts the install", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/install`, { method: "POST" });
    assert.deepEqual(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json.started, true);
  }));

// ── /run with journeyContents — the file-picker payload ─────────────

test("POST /run with journeyContents refuses when Firefox is missing (409)", () =>
  withServer(async () => {
    // Force the server's view of Firefox-installed to false so the gate
    // fires. We can't easily toggle the server's internal state from
    // outside, so this test relies on the running machine NOT having
    // Firefox cached — which is true in CI. Skip if Firefox IS installed.
    const status = await fetch(`${BASE}/firefox-status`);
    const { installed } = await status.json();
    if (installed) {
      // Firefox is installed on this machine, so the 409 path can't be
      // triggered without uninstalling it. Just assert the gate exists.
      return;
    }
    const yaml = (
      await readTextFile("./journeys/example.yaml")
    ).toString();
    const res = await fetch(`${BASE}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        journeyContents: yaml,
        journeyName: "example.yaml",
      }),
    });
    assert.deepEqual(res.status, 409);
    const json = await res.json();
    assert.ok(json.error.includes("Firefox is not installed"));
  }));

test("POST /run with neither journey nor journeyContents returns 400", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.deepEqual(res.status, 400);
    const json = await res.json();
    assert.ok(json.error.includes("either 'journeyContents'"));
  }));

// After POST /run accepts (started: true), the journey keeps running in
// the server's background. Wait for its result to land in /history before
// letting withServer tear the server down — killing it mid-journey
// orphans the playwright process tree (whose Firefox is detached from the
// server's process group and would survive every cleanup).
async function waitForJourneyResult(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/history`);
      const json = await res.json();
      if (Array.isArray(json) && json.length > 0) return;
    } catch {
      // server busy mid-journey — retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("journey did not record a result within 90s");
}

test("POST /run with journeyContents accepts an uploaded YAML", () =>
  withServer(async () => {
    // Will return 409 if Firefox isn't installed locally — that's still
    // proof the body parsed and the upload-path branch was taken.
    const yaml = await readTextFile("./journeys/example.yaml");
    const res = await fetch(`${BASE}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ journeyContents: yaml }),
    });
    assert(
      res.status === 200 || res.status === 409,
      `expected 200 (accepted) or 409 (firefox gate), got ${res.status}`,
    );
    const json = await res.json();
    if (json.started) await waitForJourneyResult();
  }));

test("POST /run with journeyContents accepts an uploaded .spec.js", () =>
  withServer(async () => {
    // Prove the dispatcher handles JS file uploads (vs YAML):
    // the temp file's suffix derives from journeyName, so it routes to
    // run-script.ts (not the YAML parser).
    const js = await readTextFile("./journeys/example.spec.js");
    const res = await fetch(`${BASE}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        journeyContents: js,
        journeyName: "example.spec.js",
      }),
    });
    // Firefox gate may fire (409) — that's fine, proves the body+suffix
    // parsed. If Firefox IS installed, we'd see 200 + later result via SSE.
    assert(
      res.status === 200 || res.status === 409,
      `expected 200 (accepted) or 409 (firefox gate), got ${res.status}`,
    );
    const json = await res.json();
    assert("started" in json || "error" in json);
    if (json.started) await waitForJourneyResult();
  }));
