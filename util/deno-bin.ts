// util/deno-bin.ts — locate the Deno CLI binary.
//
// Compiled `deno compile` and `deno desktop` binaries embed the Deno
// runtime as a dylib/binary blob; the running process is NOT a deno
// CLI executable. Calling `new Deno.Command("deno", ...)` from inside
// a compiled binary fails with "entity not found" if the user's PATH
// doesn't include a real `deno` install (e.g. when the app is launched
// via Finder, whose PATH is just /usr/bin:/bin).
//
// This helper searches well-known install locations so subprocess
// spawns work regardless of how the app was launched.

import { exists } from "./exists.ts";

/** Candidates, in priority order. First existing file is returned. */
export function denoBinaryCandidates(): string[] {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  const candidates: string[] = [];

  // 1. DENO_BIN env var — explicit user override.
  const env = Deno.env.get("DENO_BIN");
  if (env) candidates.push(env);

  // 2. ~/.deno/bin/deno — the default install location for
  //    `curl -fsSL https://deno.land/install.sh | sh` on macOS/Linux.
  if (home) candidates.push(`${home}/.deno/bin/deno`);

  // 3. Homebrew paths (macOS).
  //    - /opt/homebrew/bin/deno (Apple Silicon)
  //    - /usr/local/bin/deno (Intel, also used by some users explicitly)
  candidates.push("/opt/homebrew/bin/deno");
  candidates.push("/usr/local/bin/deno");

  // 4. Generic distro installs (Linux).
  candidates.push("/usr/bin/deno");
  candidates.push("/usr/local/bin/deno");

  // 5. Finally, just `deno` — relies on PATH being correctly set
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
      "Could not find the `deno` CLI on this machine. co2-runner's " +
        "codegen need to spawn `deno` as a subprocess, which isn't " +
        "available when the app is launched via Finder (PATH doesn't " +
        "include ~/.deno/bin).\n\n" +
        "Fix: install Deno with `curl -fsSL https://deno.land/install.sh | sh`, " +
        "or set the DENO_BIN env var to point at an existing deno binary.",
    );
    this.name = "DenoNotFoundError";
  }
}
