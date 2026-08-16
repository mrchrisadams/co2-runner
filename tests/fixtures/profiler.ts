// Builds synthetic Firefox profiler profile JSON objects for testing.
// Mirrors the structure parseEnergyProfile consumes.

// Re-exported from the production module so there is a single source of
// truth for the picoWatt-hour conversion constants.
export { PWH_TO_JOULES, PWH_TO_MWH } from "../../runner/energy.ts";

export interface CounterSample {
  time: number;
  value: number;
}

export interface ProfilerCounter {
  name: string;
  category: string;
  samples: { data: Array<[number, number]> };
}

export interface ProfilerProfile {
  counters?: ProfilerCounter[];
  processes?: Array<{ counters?: ProfilerCounter[] }>;
}

export interface PowerCounterSpec {
  values: number[];
  inProcess?: "parent" | number; // which child-process slot, or parent default
}

export function buildProfile(
  parentCounters: PowerCounterSpec[] = [],
  childProcesses: PowerCounterSpec[][] = [],
): ProfilerProfile {
  const makeCounter = (vs: number[]): ProfilerCounter => ({
    name: "Power:Timer",
    category: "power",
    samples: {
      data: vs.map((v, i) => [i * 1000, v] as [number, number]),
    },
  });

  return {
    counters: parentCounters.map((c) => makeCounter(c.values)),
    processes: childProcesses.map((cs) => ({
      counters: cs.map((c) => makeCounter(c.values)),
    })),
  };
}
