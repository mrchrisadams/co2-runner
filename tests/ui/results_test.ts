import { test } from "node:test";
import assert from "node:assert/strict";
import { ResultsStore } from "../../ui/results.ts";
import type { JourneyResult } from "../../types.ts";

const sample = (i: number): JourneyResult => ({
  name: `journey-${i}`,
  mWh: i * 0.5,
  joules: i * 1.8,
  timestamp: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
  profilePath: `/tmp/p-${i}.json`,
});

test("ResultsStore push retains results in order", () => {
  const s = new ResultsStore();
  s.push(sample(0));
  s.push(sample(1));
  assert.deepEqual(s.results.length, 2);
  assert.deepEqual(s.results[0].name, "journey-0");
  assert.deepEqual(s.results[1].name, "journey-1");
});

test("ResultsStore subscribers receive result events", () => {
  const s = new ResultsStore();
  const received: string[] = [];
  s.subscribe((ev) => {
    if (ev.type === "result") received.push(ev.result.name);
  });
  s.push(sample(5));
  assert.deepEqual(received, ["journey-5"]);
});

test("ResultsStore subscribers receive progress events", () => {
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
  assert.deepEqual(lastProgress, { stepIndex: 2, total: 5 });
});

test("ResultsStore unsubscribe stops delivery", () => {
  const s = new ResultsStore();
  let count = 0;
  const off = s.subscribe(() => count++);
  s.push(sample(0)); // → 1
  off();
  s.push(sample(1)); // ignored
  assert.deepEqual(count, 1);
});

test("ResultsStore installProgress emits install events", () => {
  const s = new ResultsStore();
  const seen: string[] = [];
  s.subscribe((ev) => {
    if (ev.type === "install") seen.push(ev.install.phase);
  });
  s.installProgress({ phase: "starting", message: "hi" });
  s.installProgress({ phase: "downloading", message: "50%" });
  s.installProgress({ phase: "complete", message: "done" });
  assert.deepEqual(seen, ["starting", "downloading", "complete"]);
});

test("ResultsStore setFirefoxInstalled updates state + broadcasts", () => {
  const s = new ResultsStore();
  assert.deepEqual(s.firefoxInstalled, false);
  const seen: boolean[] = [];
  s.subscribe((ev) => {
    if (ev.type === "firefox-status") seen.push(ev.installed);
  });
  s.setFirefoxInstalled(true);
  assert.deepEqual(s.firefoxInstalled, true);
  assert.deepEqual(seen, [true]);
  s.setFirefoxInstalled(false);
  assert.deepEqual(s.firefoxInstalled, false);
  assert.deepEqual(seen, [true, false]);
});
