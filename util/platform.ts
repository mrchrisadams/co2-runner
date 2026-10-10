// util/platform.ts — the single sanctioned way to query the host OS.
//
// The previous runtime's `build.os` returned `"darwin" | "linux" | "windows"`.
// Node's `process.platform` returns `"darwin" | "linux" | "win32"`, so
// everything in the codebase branches through os() to keep the original
// spelling (win32 → windows).

export function os(): "darwin" | "linux" | "windows" {
  const platform = process.platform;
  if (platform === "darwin" || platform === "linux") return platform;
  if (platform === "win32") return "windows";
  throw new Error(`unsupported platform: ${platform}`);
}

/**
 * The full environment as a plain string map (process.env can contain
 * undefined values, unlike the previous runtime's toObject() it replaces).
 */
export function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
