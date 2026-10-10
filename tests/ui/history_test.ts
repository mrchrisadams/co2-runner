import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { History } from "../../ui/history.ts";
import { defaultDbPath } from "../../ui/paths.ts";
import type { JourneyResult } from "../../types.ts";

const sample = (i: number): JourneyResult => ({
  name: `journey-${i}`,
  mWh: i * 0.25,
  joules: i * 0.9,
  timestamp: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
  profilePath: `/tmp/p-${i}.json`,
});

async function withHistory(fn: (h: History) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "co2-test-"));
  const dbPath = `${dir}/history.db`;
  const h = new History(dbPath);
  try {
    await fn(h);
  } finally {
    h.close();
    await rm(dir, { recursive: true }).catch(() => {});
  }
}

test("History.insert stores a run and recent() returns it newest-first", async () => {
  await withHistory(async (h) => {
    h.insert(sample(0));
    h.insert(sample(1));
    h.insert(sample(2));

    const rows = h.recent(10);
    assert.deepEqual(rows.length, 3);
    assert.deepEqual(rows[0].name, "journey-2");
    assert.deepEqual(rows[2].name, "journey-0");
  });
});

test("History.recent respects limit", async () => {
  await withHistory(async (h) => {
    for (let i = 0; i < 5; i++) h.insert(sample(i));
    assert.deepEqual(h.recent(2).length, 2);
    assert.deepEqual(h.recent(2)[0].name, "journey-4");
  });
});

test("History re-opens existing file with schema intact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "co2-test-"));
  const dbPath = `${dir}/history.db`;
  try {
    const h1 = new History(dbPath);
    h1.insert(sample(0));
    h1.close();

    const h2 = new History(dbPath); // new connection on same file
    assert.deepEqual(h2.recent().length, 1);
    h2.insert(sample(1));
    assert.deepEqual(h2.recent().length, 2);
    h2.close();
  } finally {
    await rm(dir, { recursive: true }).catch(() => {});
  }
});

test("History preserves numeric fidelity", async () => {
  await withHistory(async (h) => {
    const r: JourneyResult = {
      name: "pi",
      mWh: 3.14159265,
      joules: 11.3097,
      timestamp: "2026-08-16T12:00:00.000Z",
      profilePath: null as unknown as string,
    };
    h.insert(r);
    const got = h.recent(1)[0];
    assert.deepEqual(got.mWh, 3.14159265);
    assert.deepEqual(got.joules, 11.3097);
  });
});

test("defaultDbPath honours CO2_RUNNER_DB env", () => {
  process.env["CO2_RUNNER_DB"] = "/tmp/custom-co2.db";
  try {
    assert.deepEqual(defaultDbPath(), "/tmp/custom-co2.db");
  } finally {
    delete process.env["CO2_RUNNER_DB"];
  }
});

test("defaultDbPath falls back to HOME/.co2-runner/history.db", () => {
  delete process.env["CO2_RUNNER_DB"];
  const home = process.env["HOME"] ?? ".";
  assert.deepEqual(defaultDbPath(), `${home}/.co2-runner/history.db`);
});
