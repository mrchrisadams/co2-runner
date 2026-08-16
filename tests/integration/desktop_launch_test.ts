import { assert } from "jsr:@std/assert";

// Regression test for the desktop-launch crash: `deno desktop` launches the
// binary with DENO_SERVE_ADDRESS set and NO CLI args. The CLI router must
// detect this and start the HTTP server instead of printing usage + exit(1).
//
// We can't perfectly replicate the desktop environment (the desktop runtime
// sets DENO_SERVE_ADDRESS to a special value the embedded webview knows
// how to connect to). What we *can* check: the binary, when launched with
// no args while DENO_SERVE_ADDRESS is present, does NOT exit early with a
// usage error, and stays alive long enough to serve the dashboard.

const SERVER_PORT = 8000; // Deno.serve falls back to this when DENO_SERVE_ADDRESS is bogus
const BASE = `http://localhost:${SERVER_PORT}`;

Deno.test("desktop launch (no args + DENO_SERVE_ADDRESS) does not exit with usage error", () => {
  return new Promise<void>((resolve, reject) => {
    const env: Record<string, string> = {
      ...Deno.env.toObject(),
      // A realistic-but-not-functional value: this triggers desktop mode
      // detection in main.ts. The Deno runtime will complain about the
      // format on stderr but still bind to the default port.
      DENO_SERVE_ADDRESS: "desktop-webview-internal",
      CO2_RUNNER_DB: `/tmp/co2-runner-desktop-${Date.now()}.db`,
    };
    // NOTE: deliberately NO args, mimicking `deno desktop`.
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--unsafe-proto", "main.ts"],
      env,
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();

    let stdout = "";
    let stderr = "";
    const dec = new TextDecoder();
    // Fire-and-forget the streams; we just sample stdout/stderr for diagnostics.
    (async () => {
      const reader = child.stdout.getReader();
      let chunk;
      while ((chunk = await reader.read()).done === false) {
        stdout += dec.decode(chunk.value);
      }
    })().catch(() => {});
    (async () => {
      const reader = child.stderr.getReader();
      let chunk;
      while ((chunk = await reader.read()).done === false) {
        stderr += dec.decode(chunk.value);
      }
    })().catch(() => {});

    const cleanup = async () => {
      try {
        child.kill("SIGTERM");
      } catch {}
      try {
        await child.status;
      } catch {}
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
