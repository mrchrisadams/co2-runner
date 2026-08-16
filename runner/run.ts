// runner/run.ts — drives Playwright Firefox through a YAML journey and
// collects energy data via the Mozilla Profiler power counters.

import { firefox } from "playwright";
import { parse as parseYaml } from "yaml";
import { parseEnergyProfile } from "./energy.ts";
import { artefactsDir } from "../ui/paths.ts";
import type { ResultsStore } from "../ui/results.ts";
import type { JourneyConfig, JourneyResult, PageLike, Step } from "../types.ts";

const slugify = (s: string) => s.replace(/\s+/g, "-");

function validateConfig(raw: unknown, source: string): JourneyConfig {
  const o = raw as Record<string, unknown>;
  if (typeof o?.name !== "string") {
    throw new Error(`journey ${source}: missing or non-string 'name' field`);
  }
  if (!Array.isArray(o?.steps)) {
    throw new Error(`journey ${source}: 'steps' must be an array`);
  }
  if (o.steps.length === 0) {
    throw new Error(`journey ${source}: 'steps' array is empty`);
  }
  for (let i = 0; i < o.steps.length; i++) {
    const s = (o.steps as unknown[])[i] as Record<string, unknown>;
    if (typeof s?.action !== "string") {
      throw new Error(
        `journey ${source}: step ${i} missing or non-string 'action'`,
      );
    }
  }
  return o as unknown as JourneyConfig;
}

export async function runJourney(
  journeyPath: string,
  store?: ResultsStore,
): Promise<JourneyResult> {
  const raw = await Deno.readTextFile(journeyPath);
  const config = validateConfig(parseYaml(raw), journeyPath);

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
    env: {
      ...Deno.env.toObject(),
      MOZ_PROFILER_STARTUP: "1",
      MOZ_PROFILER_STARTUP_ENTRIES: "10000000",
      MOZ_PROFILER_STARTUP_INTERVAL: "10",
      MOZ_PROFILER_STARTUP_FEATURES: "js,stack,cpu,threads,power",
      MOZ_PROFILER_STARTUP_THREADS: "GeckoMain,Compositor,Renderer",
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
