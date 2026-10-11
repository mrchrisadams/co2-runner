import { test } from "node:test";
import { mkdir, readTextFile, remove, writeTextFile } from "../../util/fsx.ts";
import { os } from "../../util/platform.ts";
// Integration test: full run-script.js pipeline via the dispatcher in
// runner/run.ts. Requires Firefox installed locally + internet access to
// reach branch.climateaction.tech — so it skips gracefully when either
// is missing (CI machines, dev machines without the cache).
//
// To run locally: `deno test --allow-all tests/integration/run-script_journey_test.ts`

import assert from "node:assert/strict";
import { isFirefoxInstalled } from "../../runner/install.ts";
import { runJourney } from "../../runner/run.ts";
import { exists } from "../../util/exists.ts";
import { artefactsDir } from "../../ui/paths.ts";

async function canReach(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

// Energy measurement reads hardware power counters. On Linux these are
// exposed via perf_event, which many hosts (including GitHub Actions
// runners) restrict via /proc/sys/kernel/perf_event_paranoid — when that's
// the case the journey can still run but produces no power data, so we skip
// the assertion that a non-trivial energy figure was captured.
async function canMeasureEnergy(): Promise<boolean> {
  if (os() !== "linux") return true;
  try {
    const text = await readTextFile(
      "/proc/sys/kernel/perf_event_paranoid",
    );
    const value = parseInt(text.trim(), 10);
    // > 1 disallows unprivileged perf sampling of other processes.
    return value <= 1;
  } catch {
    return true;
  }
}

test(
  "runJourney dispatches .spec.js to the codegen-script pipeline",
  {
    skip: !(await isFirefoxInstalled()) ||
      !(await canReach("https://branch.climateaction.tech/")) ||
      !(await canMeasureEnergy()),
  },
  async () => {
    // Use the bundled example.spec.js — mirrors example.yaml.
    const scriptPath = "./journeys/example.spec.js";
    const result = await runJourney(scriptPath);

    // Shape: JourneyResult
    assert.deepEqual(typeof result.name, "string");
    assert.deepEqual(typeof result.mWh, "number");
    assert.deepEqual(typeof result.joules, "number");
    assert.deepEqual(typeof result.timestamp, "string");
    assert.deepEqual(typeof result.profilePath, "string");

    // Energy: the Branch journey takes more than a few seconds, so we
    // expect non-zero power-counter sum. Tighten to > 0.0001 so we don't
    // flake on extremely fast machines but still catch a parser regression.
    assert(result.mWh > 0.0001, `expected non-trivial mWh, got ${result.mWh}`);
    assert(
      result.joules > 0.0001,
      `expected non-trivial J, got ${result.joules}`,
    );

    // Slug-derived artefact paths under ~/.co2-runner/journey-artefacts/
    const dir = artefactsDir();
    assert(
      result.profilePath.startsWith(dir),
      `profile path should live inside ${dir}, got ${result.profilePath}`,
    );
    assert(await exists(result.profilePath), "profile JSON missing on disk");

    // HAR should sit next to the profile (slug + .har).
    const harPath = result.profilePath.replace(/-profile\.json$/, ".har");
    assert(await exists(harPath), `HAR missing at expected path ${harPath}`);
  },
);

test(
  "runScript rejects multi-test files with a clear error",
  async () => {
    const { runScript } = await import("../../runner/run-script.ts");

    // Write the temp script INSIDE the artefacts dir (which we own) to
    // avoid Playwright's `--list` walking system temp folders like
    // /var/folders/.../com.apple.amsengagementd and tripping EPERM.
    const dir = `${artefactsDir()}/test-fixtures`;
    await mkdir(dir, { recursive: true });
    const tmp = `${dir}/multi-test-${Date.now()}.spec.js`;
    await writeTextFile(
      tmp,
      `import { test } from "@playwright/test";
test("one", async ({ page }) => { await page.goto("about:blank"); });
test("two", async ({ page }) => { await page.goto("about:blank"); });
`,
    );
    try {
      let caught: Error | null = null;
      try {
        await runScript(tmp);
      } catch (e) {
        caught = e as Error;
      }
      assert(caught !== null, "expected runScript to throw");
      assert(
        caught!.message.includes("2 test() registrations") ||
          caught!.message.includes("multi"),
        `expected multi-test rejection message, got: ${caught!.message}`,
      );
    } finally {
      await remove(tmp).catch(() => {});
    }
  },
);
