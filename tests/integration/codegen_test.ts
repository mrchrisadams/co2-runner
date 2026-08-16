// Integration tests for the /codegen endpoint + /codegen-status endpoint.
//
// We don't actually launch the codegen Inspector in tests — that requires
// a graphical environment + user interaction with the Inspector window
// to close it. These tests verify the HTTP contract:
//  - GET /codegen-status returns the right shape
//  - POST /codegen without a startUrl returns 400
//  - POST /codegen with a startUrl returns 200 (Firefox is installed on
//    dev machines; on CI without Firefox it returns 409 — both are
//    acceptable, proving the body parsed + was routed).
//
// To test the actual `playwright codegen` launch flow, do it manually:
//   deno task serve
//   curl -X POST http://localhost:8000/codegen \
//     -H 'content-type: application/json' \
//     -d '{"startUrl":"https://example.com"}'
// ...close the Inspector window, check ~/.co2-runner/recorded-journeys/.

import { assert, assertEquals } from "jsr:@std/assert";

const SERVER_PORT = 8810;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

async function withServer(run: () => Promise<void>): Promise<void> {
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    CO2_RUNNER_DB: `/tmp/co2-codegen-${Date.now()}.db`,
    PORT: String(SERVER_PORT),
  };
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--unsafe-proto", "main.ts", "serve"],
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const child = cmd.spawn();

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

Deno.test("GET /codegen-status returns the expected shape", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/codegen-status`);
    assertEquals(res.status, 200);
    const json = await res.json();
    // Shape: { canCodegen, firefoxInstalled, hasGraphicalDisplay, codegenInProgress }
    assertEquals(typeof json.canCodegen, "boolean");
    assertEquals(typeof json.firefoxInstalled, "boolean");
    assertEquals(typeof json.hasGraphicalDisplay, "boolean");
    assertEquals(typeof json.codegenInProgress, "boolean");
    // On a macOS dev machine: canCodegen is true iff Firefox installed.
    if (json.firefoxInstalled && json.hasGraphicalDisplay) {
      assertEquals(json.canCodegen, true);
    }
    // No codegen in flight — we haven't POSTed /codegen yet.
    assertEquals(json.codegenInProgress, false);
  }));

Deno.test("POST /codegen without a startUrl returns 400", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/codegen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assert(json.error.includes("startUrl required"));
  }));

Deno.test("POST /codegen with invalid JSON returns 400", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/codegen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assertEquals(res.status, 400);
    const json = await res.json();
    assert(json.error.includes("invalid JSON"));
  }));

Deno.test("POST /codegen with startUrl returns 200 or 409 (graphical+Firefox gate)", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/codegen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startUrl: "https://example.com" }),
    });
    assert(
      res.status === 200 || res.status === 409,
      `expected 200 (started) or 409 (gate refused), got ${res.status}`,
    );

    if (res.status === 200) {
      // Server accepted + is now spawning playwright codegen. We need to
      // kill the spawned Inspector process to keep the test clean — but
      // we can't easily kill it from outside. As a mitigation, the test
      // suite's withServer() teardown kills the server, which leaves
      // the spawned deno-playwright-codegen subprocess orphaned. The user
      // running tests locally will see an Inspector window pop up + can
      // close it manually. CI machines without a display skip this path
      // (the server returns 409 instead).
      const json = await res.json();
      assert(json.started === true);
      assert(typeof json.outputPath === "string");
      assert(
        json.outputPath.includes("recorded-journeys"),
        `expected outputPath to live under recorded-journeys, got ${json.outputPath}`,
      );
    } else {
      const json = await res.json();
      assert(typeof json.error === "string");
      // Error message should reference Firefox install state OR graphical env.
      assert(
        json.error.toLowerCase().includes("firefox") ||
          json.error.toLowerCase().includes("graphical"),
        `expected gate error message, got: ${json.error}`,
      );
    }
  }));
