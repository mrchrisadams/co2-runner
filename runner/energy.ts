// runner/energy.ts
// Parses a Firefox Mozilla Profiler profile JSON into an energy figure.
// Power counters are reported per-interval in picoWatt-hours; we sum them
// across parent + child processes and convert to mWh / Joules.

import { gunzipSync } from "zlib";
import type { JourneyResult } from "../types.ts";

interface ProfilerCounter {
  category: string;
  samples: { data: Array<[unknown, number]> };
}

interface ProfilerProfile {
  counters?: ProfilerCounter[];
  processes?: Array<{ counters?: ProfilerCounter[] }>;
}

export async function parseEnergyProfile(
  profilePath: string,
  journeyName: string,
): Promise<JourneyResult> {
  const raw = await Deno.readFile(profilePath);
  const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
  const json = isGzip
    ? gunzipSync(raw).toString("utf8")
    : new TextDecoder().decode(raw);
  const profile = JSON.parse(json) as ProfilerProfile;

  const powerCounters = [
    ...(profile.counters ?? []),
    ...(profile.processes ?? []).flatMap((p) => p.counters ?? []),
  ].filter((c) => c.category === "power");

  if (powerCounters.length === 0) {
    throw new Error(
      "No power counters found — check platform support and perf_event_paranoid on Linux",
    );
  }

  const totalPWh = powerCounters.reduce(
    (sum, c) =>
      sum +
      c.samples.data.reduce((s, [, v]) => s + Math.max(0, v), 0),
    0,
  );

  const mWh = totalPWh / 1e9;
  const joules = totalPWh * 3.6e-9;
  const timestamp = new Date().toISOString();

  return { name: journeyName, mWh, joules, timestamp, profilePath };
}
