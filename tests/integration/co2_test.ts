// Integration tests for the grid-intensity + open-home endpoints.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";

const SERVER_PORT = 8820;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

async function withServer(run: () => Promise<void>): Promise<void> {
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    CO2_RUNNER_DB: `/tmp/co2-grid-${Date.now()}.db`,
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

Deno.test("GET /grid-intensities returns WORLD first + sample countries", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/grid-intensities`);
    assertEquals(res.status, 200);
    const json = await res.json();
    const entries = json.entries;
    assert(Array.isArray(entries));
    assert(
      entries.length > 100,
      `expected ≥100 entries, got ${entries.length}`,
    );
    assertEquals(entries[0].code, "WORLD");
    assert(typeof entries[0].intensity === "number");
    // Sample country codes present.
    const codes = entries.map((e: { code: string }) => e.code);
    assert(codes.includes("AVG-USA"), "missing AVG-USA");
    assert(codes.includes("MAR-USA"), "missing MAR-USA");
  }));

Deno.test("POST /open-home opens ~/.co2-runner on macOS (or returns a clear error)", () => {
  // Skip on non-macOS where `open` isn't available — the endpoint
  // still works via xdg-open (Linux) / explorer (Windows), but those
  // aren't easy to assert in a unit test without mocking.
  if (Deno.build.os !== "darwin") return;

  return withServer(async () => {
    const res = await fetch(`${BASE}/open-home`, { method: "POST" });
    assertEquals(res.status, 200);
    const json = await res.json();
    assert(typeof json.opened === "string");
    // The opened path should contain ".co2-runner" somewhere (either
    // ~/.co2-runner/ or a $CO2_RUNNER_HOME override).
    assertStringIncludes(json.opened, "co2-runner");
  });
});
