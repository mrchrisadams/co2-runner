import { test } from "node:test";
import { os } from "../../util/platform.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// Integration tests for the grid-intensity + open-home endpoints.

import assert from "node:assert/strict";

const TSX = fileURLToPath(
  new URL("../../node_modules/.bin/tsx", import.meta.url),
);

const SERVER_PORT = 8820;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

async function withServer(run: () => Promise<void>): Promise<void> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CO2_RUNNER_DB: `/tmp/co2-grid-${Date.now()}.db`,
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

test("GET /grid-intensities returns Electricity Maps entries with zone IDs", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/grid-intensities`);
    assert.deepEqual(res.status, 200);
    const json = await res.json();
    const entries = json.entries;
    assert(Array.isArray(entries));
    assert(
      entries.length > 100,
      `expected ≥100 entries, got ${entries.length}`,
    );
    // First entry should be country-level (no countryName).
    assert(!entries[0].countryName, `first entry should be country-level`);
    assert(typeof entries[0].intensity === "number");
    // Sample zone IDs from Electricity Maps.
    const ids = entries.map((e: { zoneId: string }) => e.zoneId);
    assert(ids.includes("GB"), "missing GB");
    assert(ids.includes("AU-NSW"), "missing AU-NSW");
    assert(ids.includes("FR"), "missing FR");
  }));

test("POST /open-home opens ~/.co2-runner on macOS (or returns a clear error)", () => {
  // Skip on non-macOS where `open` isn't available — the endpoint
  // still works via xdg-open (Linux) / explorer (Windows), but those
  // aren't easy to assert in a unit test without mocking.
  if (os() !== "darwin") return;

  return withServer(async () => {
    const res = await fetch(`${BASE}/open-home`, { method: "POST" });
    assert.deepEqual(res.status, 200);
    const json = await res.json();
    assert(typeof json.opened === "string");
    // The opened path should contain ".co2-runner" somewhere (either
    // ~/.co2-runner/ or a $CO2_RUNNER_HOME override).
    assert.ok(json.opened.includes("co2-runner"));
  });
});
