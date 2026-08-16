// runner/install.ts — first-run browser install.
// Playwright's bundled Firefox is ~120-200MB and cannot be embedded
// inside a `deno compile` binary, so users install it on first run.

import { firefox } from "playwright";
import { exists } from "../util/exists.ts";

export interface InstallProgress {
  phase: "starting" | "downloading" | "complete" | "error";
  message: string;
}

type ProgressCb = (p: InstallProgress) => void | Promise<void>;

/**
 * Has Playwright's bundled Firefox been downloaded to this machine?
 * Tests whether the file `firefox.executablePath()` points at actually exists.
 */
export async function isFirefoxInstalled(): Promise<boolean> {
  try {
    const exe = firefox.executablePath();
    return await exists(exe);
  } catch {
    // executablePath() throws when the browser metadata hasn't been resolved.
    return false;
  }
}

/**
 * Install Playwright's bundled Firefox, streaming progress events to the
 * caller (used by the HTTP /install endpoint to push to the SSE stream).
 *
 * Spawns `deno run --allow-all npm:playwright install firefox` and parses
 * its stdout for download progress lines.
 */
export async function installBrowsersWithProgress(
  onProgress?: ProgressCb,
): Promise<void> {
  const emit = (p: InstallProgress) => onProgress?.(p);

  emit({
    phase: "starting",
    message: "Installing Playwright's bundled Firefox...",
  });
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-all",
      "--allow-scripts=npm:playwright",
      "npm:playwright",
      "install",
      "firefox",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();

  const dec = new TextDecoder();
  const stdout = child.stdout.getReader();
  const stderr = child.stderr.getReader();

  // Forward stdout lines as "downloading" progress events.
  // Playwright's installer prints lines like:
  //   Downloading Firefox 146.0 from ....   4% of ...
  const forwardStream = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    isStderr: boolean,
  ) => {
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
          emit({ phase: "downloading", message: trimmed });
        }
      }
    }
    if (buf.trim()) {
      const line = buf.trim();
      if (isStderr) console.error(line);
      else emit({ phase: "downloading", message: line });
    }
  };

  await Promise.all([
    forwardStream(stdout, false),
    forwardStream(stderr, true),
  ]);

  const status = await child.status;
  if (!status.success) {
    emit({
      phase: "error",
      message: "Firefox install failed — see server stderr for details",
    });
    throw new Error("Firefox install failed");
  }
  emit({
    phase: "complete",
    message: "✅ Firefox installed. You can now run journeys.",
  });
}

/** Original CLI entry point. Equivalent to installBrowsersWithProgress() with no callback. */
export async function installBrowsers(): Promise<void> {
  await installBrowsersWithProgress();
}
