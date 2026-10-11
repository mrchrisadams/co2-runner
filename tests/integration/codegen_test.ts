import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function killProcessTree(pid: number): void {
  let kids: number[] = [];
  try {
    kids = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    // pgrep exits non-zero when the process has no children
  }
  for (const kid of kids) killProcessTree(kid);
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

// Integration tests for the /codegen endpoint + /codegen-status endpoint.
//
// The startUrl test DOES launch a real codegen Inspector (on graphical
// machines with Firefox) and kills it again via its --output argv marker.
// These tests verify the HTTP contract:
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

import assert from "node:assert/strict";

const TSX = fileURLToPath(
  new URL("../../node_modules/.bin/tsx", import.meta.url),
);

const SERVER_PORT = 8810;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

async function withServer(run: () => Promise<void>): Promise<void> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CO2_RUNNER_DB: `/tmp/co2-codegen-${Date.now()}.db`,
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

test("GET /codegen-status returns the expected shape", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/codegen-status`);
    assert.deepEqual(res.status, 200);
    const json = await res.json();
    // Shape: { canCodegen, firefoxInstalled, hasGraphicalDisplay, codegenInProgress }
    assert.deepEqual(typeof json.canCodegen, "boolean");
    assert.deepEqual(typeof json.firefoxInstalled, "boolean");
    assert.deepEqual(typeof json.hasGraphicalDisplay, "boolean");
    assert.deepEqual(typeof json.codegenInProgress, "boolean");
    // On a macOS dev machine: canCodegen is true iff Firefox installed.
    if (json.firefoxInstalled && json.hasGraphicalDisplay) {
      assert.deepEqual(json.canCodegen, true);
    }
    // No codegen in flight — we haven't POSTed /codegen yet.
    assert.deepEqual(json.codegenInProgress, false);
  }));

test("POST /codegen without a startUrl returns 400", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/codegen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.deepEqual(res.status, 400);
    const json = await res.json();
    assert(json.error.includes("startUrl required"));
  }));

test("POST /codegen with invalid JSON returns 400", () =>
  withServer(async () => {
    const res = await fetch(`${BASE}/codegen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assert.deepEqual(res.status, 400);
    const json = await res.json();
    assert(json.error.includes("invalid JSON"));
  }));

test("POST /codegen with startUrl returns 200 or 409 (graphical+Firefox gate)", () =>
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
      // Server accepted + is now spawning playwright codegen. The spawn is
      // fire-and-forget by design (the server keeps no handle), so this
      // test finds its own codegen child via the unique --output argv
      // marker and kills its whole tree — otherwise the Inspector (and
      // its browser, which playwright detaches into its own process
      // group) would outlive the suite as orphans.
      const json = await res.json();
      assert(json.started === true);
      assert(typeof json.outputPath === "string");
      assert(
        json.outputPath.includes("recorded-journeys"),
        `expected outputPath to live under recorded-journeys, got ${json.outputPath}`,
      );

      const findCodegenPid = (): number | null => {
        try {
          const out = execFileSync(
            "pgrep",
            ["-f", `output=${json.outputPath}`],
            { encoding: "utf8" },
          );
          const pid = Number(out.split("\n")[0]);
          return Number.isFinite(pid) ? pid : null;
        } catch {
          return null;
        }
      };
      const deadline = Date.now() + 5000;
      let codegenPid: number | null = null;
      while (codegenPid === null && Date.now() < deadline) {
        codegenPid = findCodegenPid();
        if (codegenPid === null) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      if (codegenPid !== null) killProcessTree(codegenPid);
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
