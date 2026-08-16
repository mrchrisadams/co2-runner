// util/deno-bin.ts — locate the Deno CLI binary.
//
// Compiled `deno compile` and `deno desktop` binaries embed the Deno
// runtime as a dylib/binary blob; the running process is NOT a deno
// CLI executable. Calling `new Deno.Command("deno", ...)` from inside
// a compiled binary fails with "entity not found" if the user's PATH
// doesn't include a real `deno` install (e.g. when the app is launched
// via Finder, whose PATH is just /usr/bin:/bin).
//
// This helper searches well-known locations so subprocess spawns work
// regardless of how the app was launched. The FIRST place we look is
// the bundled binary inside the .app bundle (Contents/Resources/deno/deno),
// so a self-contained .dmg with the bundled deno works zero-setup.

import { exists } from "./exists.ts";

/**
 * Absolute path to the bundled deno binary inside the .app bundle.
 * Returns null when the current process isn't running from inside a
 * .app bundle (dev mode, CLI compile, etc.).
 *
 * Computed from Deno.execPath(): when running from the desktop bundle,
 * it returns .../CO2Runner.app/Contents/MacOS/laufey_webview, so the
 * bundled deno lives at .../CO2Runner.app/Contents/Resources/deno/deno.
 */
export function bundledDenoPath(): string | null {
  const execPath = Deno.execPath();
  const macosIdx = execPath.lastIndexOf("/MacOS/");
  if (macosIdx === -1) return null;
  const contentsDir = execPath.substring(0, macosIdx);
  return `${contentsDir}/Resources/deno/deno`;
}

/** Candidates, in priority order. First existing file is returned. */
export function denoBinaryCandidates(): string[] {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  const candidates: string[] = [];

  // 1. Bundled deno inside the desktop app bundle (Contents/Resources/deno/deno).
  //    Highest priority so a self-contained .dmg works zero-setup.
  const bundled = bundledDenoPath();
  if (bundled) candidates.push(bundled);

  // 2. DENO_BIN env var — explicit user override (devs testing a custom
  //    deno build, or pointing at a side-installed binary).
  const env = Deno.env.get("DENO_BIN");
  if (env) candidates.push(env);

  // 3. ~/.deno/bin/deno — the default install location for
  //    `curl -fsSL https://deno.land/install.sh | sh` on macOS/Linux.
  if (home) candidates.push(`${home}/.deno/bin/deno`);

  // 4. Homebrew paths (macOS).
  //    - /opt/homebrew/bin/deno (Apple Silicon)
  //    - /usr/local/bin/deno (Intel, also used by some users explicitly)
  candidates.push("/opt/homebrew/bin/deno");
  candidates.push("/usr/local/bin/deno");

  // 5. Generic distro installs (Linux).
  candidates.push("/usr/bin/deno");
  candidates.push("/usr/local/bin/deno");

  // 6. Finally, just `deno` — relies on PATH being correctly set
  //    (works in dev mode, not in compiled binaries launched from GUI).
  candidates.push("deno");

  return candidates;
}

/**
 * Resolve the absolute path to a working `deno` CLI binary, or null if
 * none can be found. Cached after first successful resolution so we
 * don't stat the filesystem on every subprocess spawn.
 */
let cachedDenoBin: string | null | undefined = undefined;

export async function findDenoBinary(): Promise<string | null> {
  if (cachedDenoBin !== undefined) return cachedDenoBin;

  for (const candidate of denoBinaryCandidates()) {
    if (candidate === "deno") {
      // Bare PATH lookup — verify by spawning `deno --version`.
      try {
        const cmd = new Deno.Command(candidate, { args: ["--version"] });
        const child = cmd.spawn();
        const status = await child.status;
        if (status.success) {
          cachedDenoBin = candidate;
          return candidate;
        }
      } catch {
        // not on PATH; continue
      }
      continue;
    }

    if (await exists(candidate)) {
      // Verify it's actually executable (not a stale symlink).
      try {
        const cmd = new Deno.Command(candidate, { args: ["--version"] });
        const child = cmd.spawn();
        const status = await child.status;
        if (status.success) {
          cachedDenoBin = candidate;
          return candidate;
        }
      } catch {
        // file exists but not executable; keep trying
      }
    }
  }

  cachedDenoBin = null;
  return null;
}

/** Error thrown when no Deno binary can be located. */
export class DenoNotFoundError extends Error {
  constructor() {
    super(
      "Could not find the `deno` CLI on this machine. co2-runner needs to " +
        "spawn `deno` as a subprocess for codegen / install / .spec.js journeys, " +
        "which isn't available when the app is launched via Finder (PATH " +
        "doesn't include ~/.deno/bin).\n\n" +
        "Fix options:\n" +
        "  1. Use the latest dist/CO2Runner.dmg — recent builds bundle deno " +
        "directly inside the .app so this shouldn't happen.\n" +
        "  2. Install Deno with `curl -fsSL https://deno.land/install.sh | sh`.\n" +
        "  3. Set the DENO_BIN env var to point at an existing deno binary.",
    );
    this.name = "DenoNotFoundError";
  }
}
