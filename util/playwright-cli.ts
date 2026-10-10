// util/playwright-cli.ts — resolve Playwright's CLI entry points for the
// subprocess spawns (browser install, codegen, .spec.js journeys).
//
// co2-runner runs the Playwright CLIs as `node <cli-entry> <subcommand>`:
// journey scripts and the generated playwright config import
// "@playwright/test" bare, which only resolves against node_modules under
// real Node (the previous `deno run npm:@playwright/test` pipeline breaks
// once a repo-root node_modules exists).
//
// `./cli.js` is not in either package's exports map, so we resolve
// "<pkg>/package.json" (which is exported) and take the sibling cli.js.
// Dev/workspace runs find it via module resolution up the tree; packaged
// builds (phase 5+) ship a Playwright payload under
// ~/.co2-runner/payload/node_modules instead — extend resolveCliEntry with
// that fallback (via co2RunnerHome()) when packaging lands.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface PlaywrightCliPaths {
  /** CLI entry providing the `install` subcommand. */
  install: string;
  /** CLI entry providing the `codegen` subcommand. */
  codegen: string;
  /** CLI entry providing the `test` subcommand. */
  test: string;
  /** The node_modules dir the CLI entries resolved from. */
  nodeModules: string;
}

async function resolveCliEntry(
  pkg: string,
): Promise<{ cli: string; nodeModules: string }> {
  try {
    const pkgJson = createRequire(import.meta.url).resolve(
      `${pkg}/package.json`,
    );
    const packageDir = dirname(pkgJson);
    // packageDir ends with "/<pkg>" (scope included); strip it to get the
    // node_modules dir the package resolved from.
    const nodeModules = packageDir.slice(0, packageDir.length - pkg.length - 1);
    return { cli: join(packageDir, "cli.js"), nodeModules };
  } catch {
    throw new Error(
      `Could not resolve the Playwright CLI entry for ${pkg}. co2-runner ` +
        "spawns Playwright via node for install/codegen/.spec.js journeys; " +
        "install Playwright as a dev dependency by running `npm install` " +
        "in the project checkout.",
    );
  }
}

// Under the Electron desktop shell the runtime binary is the Electron app
// binary; anything spawned without ELECTRON_RUN_AS_NODE boots a second GUI
// instance instead of running the CLI as plain Node. Every Playwright CLI
// spawn site calls playwrightCliPaths() first, so assert the env here.
// No-op under plain Node (Electron only reads the var at process startup).
function ensureNodeSubprocessEnv(): void {
  if (process.versions.electron) {
    process.env.ELECTRON_RUN_AS_NODE ??= "1";
  }
}

export async function playwrightCliPaths(): Promise<PlaywrightCliPaths> {
  ensureNodeSubprocessEnv();
  const playwright = await resolveCliEntry("playwright");
  const test = await resolveCliEntry("@playwright/test");
  return {
    install: playwright.cli,
    codegen: playwright.cli,
    test: test.cli,
    nodeModules: test.nodeModules,
  };
}
