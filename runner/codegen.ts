// runner/codegen.ts — wraps `playwright codegen` as a subprocess so users
// can record a journey directly from the co2-runner UI or CLI without
// leaving the app.
//
// Approach: spawn Playwright's own codegen binary with our chosen flags
// (Firefox browser, playwright-test target, --output pointing to a
// predictable path under our control). Playwright opens its Inspector +
// Firefox windows directly on the user's desktop; when the user closes
// the Inspector, the recorded script is written to --output and the
// subprocess exits.
//
// Codegen requires a graphical environment. On headless Linux without
// DISPLAY, refuse with a clear error before the user opens a window they
// can't see.

import type { CodegenProgress } from "../types.ts";
import { DenoNotFoundError, findDenoBinary } from "../util/deno-bin.ts";

export interface CodegenOptions {
  /** URL to navigate to when the Inspector opens. */
  startUrl: string;
  /**
   * Absolute path where the recorded .spec.js will be written.
   * Caller is responsible for choosing a location (e.g. user-supplied
   * save dialog in the UI, or ~/.co2-runner/recorded-journeys/... in CLI).
   */
  outputPath: string;
}

export interface CodegenResult {
  /** Absolute path of the recorded script (same as options.outputPath). */
  scriptPath: string;
}

/**
 * Detect whether the current environment has a graphical display that
 * Playwright's Inspector can attach to. On macOS + Windows this is
 * always true; on Linux it requires $DISPLAY or $WAYLAND_DISPLAY.
 *
 * Used to fail fast with a clear message rather than letting Playwright
 * throw an opaque "browserType.launch: Executable doesn't exist" or
 * segfault deep in the webview backend.
 */
export function hasGraphicalDisplay(): boolean {
  const plat = Deno.build.os;
  if (plat === "darwin" || plat === "windows") return true;
  // Linux: check both X11 ($DISPLAY) and Wayland ($WAYLAND_DISPLAY).
  if (Deno.env.get("DISPLAY")) return true;
  if (Deno.env.get("WAYLAND_DISPLAY")) return true;
  return false;
}

/**
 * Build a slug-friendly filename for a recorded journey based on the
 * start URL. The format mirrors the one we discussed:
 *
 *   <timestamp>-<host>.spec.js
 *
 * e.g.
 *   2026-08-16T22-50-00-branch.climateaction.tech.spec.js
 *
 * ISO timestamps aren't filename-safe (contain ':'), so we replace
 * colons with dashes. The host is slugified to alphanumerics + dots +
 * dashes; other characters (path, query, fragment) are stripped.
 */
export function buildCodegenFilename(startUrl: string): string {
  const ts = new Date().toISOString().replace(/[:]/g, "-").replace(
    /\.\d+Z$/,
    "Z",
  );
  let host = "unknown";
  try {
    host = new URL(startUrl).hostname || "unknown";
  } catch {
    // startUrl may not be parseable as URL (e.g. "example.com" with no
    // scheme); fall back to slugifying the raw string.
    host = startUrl.replace(/[^a-zA-Z0-9.-]/g, "-").replace(/^-+|-+$/g, "") ||
      "unknown";
  }
  return `${ts}-${host}.spec.js`;
}

/**
 * Launch `playwright codegen <startUrl> --browser=firefox --target=playwright-test
 * --output=<outputPath>` as a subprocess. The Inspector + Firefox windows
 * appear directly on the user's desktop; control returns when the user
 * closes the Inspector.
 *
 * Streams progress events to the optional `onProgress` callback so the
 * HTTP /codegen endpoint can forward them to UI clients via SSE.
 */
export async function launchCodegen(
  options: CodegenOptions,
  onProgress?: (p: CodegenProgress) => void | Promise<void>,
): Promise<CodegenResult> {
  const { startUrl, outputPath } = options;

  if (!hasGraphicalDisplay()) {
    throw new Error(
      "codegen requires a graphical environment (DISPLAY or WAYLAND_DISPLAY on Linux; " +
        "always available on macOS / Windows). Run co2-runner from a desktop session.",
    );
  }

  onProgress?.({
    phase: "starting",
    message: `Launching Playwright codegen for ${startUrl}...`,
  });

  // Resolve the deno CLI binary. Compiled desktop binaries don't include
  // `deno` on PATH (Finder launches apps with a minimal PATH that
  // doesn't include ~/.deno/bin). Look in well-known locations first.
  const denoBin = await findDenoBinary();
  if (!denoBin) {
    throw new DenoNotFoundError();
  }

  const cmd = new Deno.Command(denoBin, {
    args: [
      "run",
      "-A",
      "--allow-scripts=npm:playwright",
      "npm:playwright",
      "codegen",
      "--browser=firefox",
      "--target=playwright-test",
      `--output=${outputPath}`,
      startUrl,
    ],
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      // Playwright codegen should NOT spin up the Mozilla Profiler —
      // we're only recording a journey, not measuring energy. Explicitly
      // unset any MOZ_PROFILER_* vars the parent process might have set
      // (e.g. dev-server mode inherited from the user's shell).
      MOZ_PROFILER_STARTUP: "",
      MOZ_PROFILER_SHUTDOWN: "",
    },
  });

  const child = cmd.spawn();

  // Forward stdout/stderr lines as 'recording' progress events. The
  // codegen binary doesn't emit much, but anything it does print is
  // useful to surface in the UI status line.
  const dec = new TextDecoder();
  await Promise.all([
    streamToProgress(child.stdout, dec, onProgress, false),
    streamToProgress(child.stderr, dec, onProgress, true),
  ]);

  const status = await child.status;
  if (!status.success) {
    onProgress?.({
      phase: "error",
      message:
        `codegen exited with code ${status.code} — see server stderr for details`,
    });
    throw new Error(`playwright codegen failed (exit code ${status.code})`);
  }

  onProgress?.({
    phase: "complete",
    outputPath,
    message: `✅ Recorded journey saved to ${outputPath}`,
  });

  return { scriptPath: outputPath };
}

async function streamToProgress(
  stream: ReadableStream<Uint8Array>,
  dec: TextDecoder,
  onProgress: ((p: CodegenProgress) => void | Promise<void>) | undefined,
  isStderr: boolean,
): Promise<void> {
  if (!onProgress) {
    // No subscriber; drain to avoid backpressure, but ignore content.
    await stream.cancel();
    return;
  }
  const reader = stream.getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (isStderr) {
        console.error(trimmed);
      } else {
        console.log(trimmed);
        onProgress({
          phase: "recording",
          message: trimmed,
        });
      }
    }
  }
}
