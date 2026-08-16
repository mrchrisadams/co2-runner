import { assertEquals } from "jsr:@std/assert";
import { ResultsStore } from "../../ui/results.ts";
import type { JourneyResult } from "../../types.ts";

const sample = (i: number): JourneyResult => ({
  name: `journey-${i}`,
  mWh: i * 0.5,
  joules: i * 1.8,
  timestamp: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
  profilePath: `/tmp/p-${i}.json`,
});

Deno.test("ResultsStore push retains results in order", () => {
  const s = new ResultsStore();
  s.push(sample(0));
  s.push(sample(1));
  assertEquals(s.results.length, 2);
  assertEquals(s.results[0].name, "journey-0");
  assertEquals(s.results[1].name, "journey-1");
});

Deno.test("ResultsStore subscribers receive result events", () => {
  const s = new ResultsStore();
  const received: string[] = [];
  s.subscribe((ev) => {
    if (ev.type === "result") received.push(ev.result.name);
  });
  s.push(sample(5));
  assertEquals(received, ["journey-5"]);
});

Deno.test("ResultsStore subscribers receive progress events", () => {
  const s = new ResultsStore();
  let lastProgress: { stepIndex: number; total: number } | null = null;
  s.subscribe((ev) => {
    if (ev.type === "progress") {
      lastProgress = {
        stepIndex: ev.progress.stepIndex,
        total: ev.progress.totalSteps,
      };
    }
  });
  s.progress({
    name: "x",
    stepIndex: 2,
    totalSteps: 5,
    action: "scroll",
    status: "running",
  });
  assertEquals(lastProgress, { stepIndex: 2, total: 5 });
});

Deno.test("ResultsStore unsubscribe stops delivery", () => {
  const s = new ResultsStore();
  let count = 0;
  const off = s.subscribe(() => count++);
  s.push(sample(0)); // → 1
  off();
  s.push(sample(1)); // ignored
  assertEquals(count, 1);
});

Deno.test("ResultsStore installProgress emits install events", () => {
  const s = new ResultsStore();
  const seen: string[] = [];
  s.subscribe((ev) => {
    if (ev.type === "install") seen.push(ev.install.phase);
  });
  s.installProgress({ phase: "starting", message: "hi" });
  s.installProgress({ phase: "downloading", message: "50%" });
  s.installProgress({ phase: "complete", message: "done" });
  assertEquals(seen, ["starting", "downloading", "complete"]);
});

Deno.test("ResultsStore setFirefoxInstalled updates state + broadcasts", () => {
  const s = new ResultsStore();
  assertEquals(s.firefoxInstalled, false);
  const seen: boolean[] = [];
  s.subscribe((ev) => {
    if (ev.type === "firefox-status") seen.push(ev.installed);
  });
  s.setFirefoxInstalled(true);
  assertEquals(s.firefoxInstalled, true);
  assertEquals(seen, [true]);
  s.setFirefoxInstalled(false);
  assertEquals(s.firefoxInstalled, false);
  assertEquals(seen, [true, false]);
});
