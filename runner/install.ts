// runner/install.ts — first-run browser install.
// Playwright's bundled Firefox is ~120-200MB and cannot be embedded
// inside a `deno compile` binary, so users run `co2-runner install` once.

export async function installBrowsers(): Promise<void> {
  console.log("Installing Playwright's bundled Firefox...");
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-all",
      "--allow-scripts=npm:playwright",
      "npm:playwright",
      "install",
      "firefox",
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  const result = await cmd.output();
  if (!result.success) {
    console.error("Firefox install failed");
    Deno.exit(1);
  }
  console.log(
    "✅ Firefox installed. Run: co2-runner run journeys/example.yaml",
  );
}
