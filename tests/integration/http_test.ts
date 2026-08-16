import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";

const SERVER_PORT = 8799;
const BASE = `http://localhost:${SERVER_PORT}`;

async function withServer(run: () => Promise<void>): Promise<void> {
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    CO2_RUNNER_DB: `/tmp/co2-runner-http-${Date.now()}.db`,
    PORT: String(SERVER_PORT),
  };
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "main.ts", "serve"],
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const child = cmd.spawn();

  // wait for server to come up
  let up = false;
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(BASE);
      up = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert(up, "server did not start in time");

  try {
    await run();
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {}
    await child.status;
  }
}

Deno.test("GET / returns the dashboard HTML", () =>
  withServer(async () => {
    const res = await fetch(BASE);
    const html = await res.text();
    assertEquals(res.status, 200);
    assertStringIncludes(html, "<!DOCTYPE html>");
    assertStringIncludes(html, "CO2 Runner");
  }));

Deno.test("GET /history returns JSON list (empty by default)", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/history`);
    const json = await res.json();
    assertEquals(res.status, 200);
    assertEquals(Array.isArray(json), true);
    assertEquals(json.length, 0);
  }));

Deno.test("GET /history?limit=1 honours limit", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/history?limit=1`);
    assertEquals(res.status, 200);
  }));

Deno.test("POST /run without body returns 400", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/run`, { method: "POST" });
    assertEquals(res.status, 400);
  }));

Deno.test("POST /run with journey accepts and reports started", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ journey: "journeys/example.yaml" }),
    });
    const json = await res.json();
    assertEquals(res.status, 200);
    assertEquals(json, { started: true });
  }));

Deno.test("GET /unknown returns 404", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/this-does-not-exist`);
    assertEquals(res.status, 404);
  }));

Deno.test("GET /events opens an SSE stream and sends firefox-status on connect", () =>
  withServer(async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${BASE}/events`, { signal: ctrl.signal });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/event-stream");

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

Deno.test("NOT modified by previous tests: history stays empty", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/history`);
    const json = await res.json();
    assertEquals(json.length, 0);
  }));
