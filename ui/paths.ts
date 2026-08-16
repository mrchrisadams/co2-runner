// ui/paths.ts — stable per-user filesystem locations for co2-runner.
//
// Compiled binaries (both `deno compile` CLI and `deno desktop` bundle) run
// with an unpredictable working directory. Relative paths like
// "journey-artefacts/" or "history.db" either land in whatever cwd the user
// happened to launch the binary from, or hit EROFS in macOS desktop-sandbox
// mode. We resolve everything against a stable per-user directory:
//
//   $CO2_RUNNER_HOME   (override; takes precedence)
//   $HOME/.co2-runner/  (default; created on demand)

export function co2RunnerHome(): string {
  const env = Deno.env.get("CO2_RUNNER_HOME");
  if (env) return env;
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return `${home}/.co2-runner`;
}

export function artefactsDir(): string {
  return `${co2RunnerHome()}/journey-artefacts`;
}

export function defaultDbPath(): string {
  const env = Deno.env.get("CO2_RUNNER_DB");
  if (env) return env;
  return `${co2RunnerHome()}/history.db`;
}
