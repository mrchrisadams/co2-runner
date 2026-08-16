// Builds synthetic Firefox profiler profile JSON objects for testing.
// Mirrors the structure parseEnergyProfile consumes.

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

// totalPWh is divided by 1e9 to get mWh, and multiplied by 3.6e-9
// to get joules. So 1e9 pWh → 1 mWh → 0.0036 J.
export const PWH_TO_MWH = 1e-9;
export const PWH_TO_JOULES = 3.6e-9;
