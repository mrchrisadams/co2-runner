// runner/journey-config.ts — parse + validate a YAML journey definition.
//
// Split out of run.ts so the GMT submission path (runner/gmt.ts) can reuse
// the same validation without pulling in Playwright, which run.ts imports at
// module load time.

import { parse as parseYaml } from "yaml";
import type { JourneyConfig } from "../types.ts";

export function validateConfig(raw: unknown, source: string): JourneyConfig {
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

/** Parses YAML source text into a validated JourneyConfig. */
export function parseJourneyConfig(
  yamlText: string,
  source: string,
): JourneyConfig {
  return validateConfig(parseYaml(yamlText), source);
}
