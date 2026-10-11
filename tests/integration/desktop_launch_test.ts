import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const TSX = fileURLToPath(
  new URL("../../node_modules/.bin/tsx", import.meta.url),
);

// Regression test for the desktop-launch crash: `deno desktop` launches the
// binary with DENO_SERVE_ADDRESS set and NO CLI args. The CLI router must
// detect this and start the HTTP server instead of printing usage + exit(1).
//
// We can't perfectly replicate the desktop environment (the desktop runtime
// sets DENO_SERVE_ADDRESS to a special value the embedded webview knows
// how to connect to). What we *can* check: the binary, when launched with
// no args while DENO_SERVE_ADDRESS is present, does NOT exit early with a
// usage error, and stays alive long enough to serve the dashboard.

const SERVER_PORT = 8000; // the server falls back to this when DENO_SERVE_ADDRESS is bogus
const BASE = `http://localhost:${SERVER_PORT}`;

test("desktop launch (no args + DENO_SERVE_ADDRESS) does not exit with usage error", () => {
  return new Promise<void>((resolve, reject) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      // A realistic-but-not-functional value: this triggers desktop mode
      // detection in main.ts. The Deno runtime will complain about the
      // format on stderr but still bind to the default port.
      DENO_SERVE_ADDRESS: "desktop-webview-internal",
      CO2_RUNNER_DB: `/tmp/co2-runner-desktop-${Date.now()}.db`,
    };
    // NOTE: deliberately NO args, mimicking `deno desktop`.
    const child = spawn(TSX, ["main.ts"], {
      detached: true,
      env,
      stdio: "pipe",
    });
    const exited = new Promise<boolean>((r) => child.once("exit", () => r(true)));

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });

    const cleanup = async () => {
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
        await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      }
    };

    (async () => {
      // Poll for the server coming up; if it does, the binary didn't exit
      // with the usage error.
      for (let i = 0; i < 50; i++) {
        try {
          const res = await fetch(BASE);
          if (res.status === 200) {
            await cleanup();
            assert(
              !stdout.includes("USAGE:"),
              "desktop launch printed usage text — bug regressed",
            );
            assert(
              !stdout.toLowerCase().includes("unknown subcommand"),
              "desktop launch rejected missing arg — bug regressed",
            );
            resolve();
            return;
          }
        } catch {
          // server not up yet
          if (i > 5 && stdout.includes("USAGE:")) {
            await cleanup();
            reject(
              new Error(
                `binary exited with usage error instead of starting server.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
              ),
            );
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      await cleanup();
      reject(
        new Error(
          `server did not come up within 5s.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    })();
  });
});
