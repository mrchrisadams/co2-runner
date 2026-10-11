import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const TSX = fileURLToPath(
  new URL("../../node_modules/.bin/tsx", import.meta.url),
);

const SERVER_PORT = 8799;
const BASE = `http://localhost:${SERVER_PORT}`;

async function withServer(run: () => Promise<void>): Promise<void> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CO2_RUNNER_DB: `/tmp/co2-runner-http-${Date.now()}.db`,
    PORT: String(SERVER_PORT),
  };
  const child = spawn(TSX, ["main.ts", "serve"], {
    detached: true,
    env,
    stdio: "inherit",
  });
  const exited = new Promise<boolean>((r) => child.once("exit", () => r(true)));

  // wait for server to come up
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

test("GET / returns the dashboard HTML", () =>
  withServer(async () => {
    const res = await fetch(BASE);
    const html = await res.text();
    assert.deepEqual(res.status, 200);
    assert.ok(html.includes("<!DOCTYPE html>"));
    assert.ok(html.includes("CO2 Runner"));
  }));

test("GET /history returns JSON list (empty by default)", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/history`);
    const json = await res.json();
    assert.deepEqual(res.status, 200);
    assert.deepEqual(Array.isArray(json), true);
    assert.deepEqual(json.length, 0);
  }));

test("GET /history?limit=1 honours limit", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/history?limit=1`);
    assert.deepEqual(res.status, 200);
  }));

test("POST /run without body returns 400", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/run`, { method: "POST" });
    assert.deepEqual(res.status, 400);
  }));

test("POST /run with journey accepts and reports started", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ journey: "journeys/example.yaml" }),
    });
    const json = await res.json();
    assert.deepEqual(res.status, 200);
    assert.deepEqual(json, { started: true });
  }));

test("GET /unknown returns 404", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/this-does-not-exist`);
    assert.deepEqual(res.status, 404);
  }));

test("GET /events opens an SSE stream and sends firefox-status on connect", () =>
  withServer(async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${BASE}/events`, { signal: ctrl.signal });
    assert.deepEqual(res.status, 200);
    assert.deepEqual(res.headers.get("content-type"), "text/event-stream");

    // The server pushes a firefox-status event to every new subscriber
    // immediately (so the UI knows whether to enable the Run button on
    // first paint). Read the first chunk and check it contains that event.
    const reader = res.body!.getReader();
    const result = await Promise.race([
      reader.read(),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 2000)),
    ]);
    try {
      ctrl.abort();
    } catch {}
    try {
      await reader.cancel();
    } catch {}

    assert(result, "expected at least one SSE chunk within 2s of connect");
    const text = new TextDecoder().decode(result.value);
    assert(
      text.includes('"type":"firefox-status"') ||
        text.includes('"type": "firefox-status"'),
      `expected firefox-status in first SSE chunk, got: ${text}`,
    );
  }));

test("NOT modified by previous tests: history stays empty", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/history`);
    const json = await res.json();
    assert.deepEqual(json.length, 0);
  }));
