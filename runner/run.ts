// runner/run.ts — journey dispatcher + YAML journey runner.
//
// co2-runner supports two journey formats, dispatched by file extension:
//   .yaml / .yml  — YAML config file (processed by runJourney below)
//   .js / .mjs / .ts — Playwright codegen script (delegated to run-script.ts)
//
// Both formats land at the same JourneyResult shape and the same artefacts
// dir, so the UI / history / energy parser stay format-agnostic.

import { firefox } from "playwright";
import { parseJourneyConfig } from "./journey-config.ts";
import { parseEnergyProfile } from "./energy.ts";
import { isScriptFile, runScript } from "./run-script.ts";
import { artefactsDir } from "../ui/paths.ts";
import type { ResultsStore } from "../ui/results.ts";
import type { JourneyResult, PageLike, Step } from "../types.ts";

const slugify = (s: string) => s.replace(/\s+/g, "-");

export async function runJourney(
  journeyPath: string,
  store?: ResultsStore,
  opts?: { displayName?: string; slowMo?: boolean; filmReel?: boolean },
): Promise<JourneyResult> {
  // Dispatcher: .js/.mjs/.ts go to the codegen-script pipeline; everything
  // else is treated as YAML.
  if (isScriptFile(journeyPath)) {
    return runScript(journeyPath, store, opts);
  }

  const raw = await Deno.readTextFile(journeyPath);
  const config = parseJourneyConfig(raw, journeyPath);

  if (config.browser && config.browser !== "firefox") {
    throw new Error(
      `Browser '${config.browser}' not supported — only firefox supports power profiling`,
    );
  }

  if (config.headless) {
    console.warn(
      "⚠️  headless mode changes the power profile and may skew measurements",
    );
  }

  const ARTEFACTS_DIR = artefactsDir();
  await Deno.mkdir(ARTEFACTS_DIR, { recursive: true });
  const slug = slugify(config.name);
  const PROFILE_PATH = `${ARTEFACTS_DIR}/${slug}-profile.json`;
  const HAR_PATH = `${ARTEFACTS_DIR}/${slug}.har`;

  const browser = await firefox.launch({
    headless: config.headless ?? false,
    slowMo: opts?.slowMo ? 1500 : undefined,
    firefoxUserPrefs: opts?.filmReel
      ? {
        // CompositorScreenshot markers are only emitted by the basic
        // compositor, not by WebRender. WebRender uses a different
        // rendering pipeline that bypasses the ScreenshotGrabber.
        // Disable WebRender to get the film reel.
        "gfx.webrender.all": false,
        "layers.acceleration.force-enabled": false,
        "gfx.webrender.enabled": false,
      }
      : undefined,
    env: {
      ...Deno.env.toObject(),
      MOZ_PROFILER_STARTUP: "1",
      MOZ_PROFILER_STARTUP_ENTRIES: "10000000",
      MOZ_PROFILER_STARTUP_INTERVAL: "10",
      MOZ_PROFILER_STARTUP_FEATURES: opts?.filmReel
        ? "js,stackwalk,cpu,screenshots,power"
        : "js,stackwalk,cpu,power",
      MOZ_PROFILER_STARTUP_THREADS: "GeckoMain,Compositor,Renderer",
      MOZ_PROFILER_STARTUP_FILTERS: "GeckoMain,Compositor,Renderer",
      MOZ_PROFILER_SHUTDOWN: PROFILE_PATH,
    },
  });

  try {
    const context = await browser.newContext({
      recordHar: { path: HAR_PATH, mode: "full", content: "embed" },
    });
    const page = await context.newPage();

    const total = config.steps.length;
    for (let i = 0; i < total; i++) {
      const step = config.steps[i];
      store?.progress({
        name: config.name,
        stepIndex: i,
        totalSteps: total,
        action: step.action,
        status: "running",
      });
      await executeStep(page, step);
    }

    await context.close(); // HAR flushed
  } finally {
    await browser.close(); // profile written
  }

  const result = await parseEnergyProfile(PROFILE_PATH, config.name);
  store?.push(result);
  return result;
}

// exported for unit testing with an injected page-like object.
export async function executeStep(
  page: PageLike,
  step: Step,
): Promise<void> {
  const rand = (a: number, b: number) =>
    Math.floor(Math.random() * (b - a + 1)) + a;

  switch (step.action) {
    case "goto":
      await page.goto(step.url);
      if (step.waitFor) await page.waitForLoadState(step.waitFor);
      break;

    case "click":
      await page.locator(step.selector).click();
      if (step.waitFor) await page.waitForLoadState(step.waitFor);
      break;

    case "fill":
      await page.locator(step.selector).fill(step.value);
      break;

    case "scroll":
      if (step.human) {
        let remaining = Math.abs(step.distance);
        const dir = step.distance >= 0 ? 1 : -1;
        while (remaining > 0) {
          const stepPx = Math.min(rand(120, 240), remaining);
          await page.mouse.wheel(0, dir * stepPx);
          remaining -= stepPx;
          await page.waitForTimeout(rand(40, 180));
        }
      } else {
        await page.evaluate(`window.scrollBy(0, ${step.distance})`);
      }
      break;

    case "wait":
      await page.waitForTimeout(step.ms);
      break;

    case "waitForSelector":
      await page.locator(step.selector).waitFor({ state: "visible" });
      break;
  }
}
