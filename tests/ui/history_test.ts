import { assertEquals } from "jsr:@std/assert";
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
  const dir = await Deno.makeTempDir();
  const dbPath = `${dir}/history.db`;
  const h = new History(dbPath);
  try {
    await fn(h);
  } finally {
    h.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("History.insert stores a run and recent() returns it newest-first", async () => {
  await withHistory(async (h) => {
    h.insert(sample(0));
    h.insert(sample(1));
    h.insert(sample(2));

    const rows = h.recent(10);
    assertEquals(rows.length, 3);
    assertEquals(rows[0].name, "journey-2");
    assertEquals(rows[2].name, "journey-0");
  });
});

Deno.test("History.recent respects limit", async () => {
  await withHistory(async (h) => {
    for (let i = 0; i < 5; i++) h.insert(sample(i));
    assertEquals(h.recent(2).length, 2);
    assertEquals(h.recent(2)[0].name, "journey-4");
  });
});

Deno.test("History re-opens existing file with schema intact", async () => {
  const dir = await Deno.makeTempDir();
  const dbPath = `${dir}/history.db`;
  try {
    const h1 = new History(dbPath);
    h1.insert(sample(0));
    h1.close();

    const h2 = new History(dbPath); // new connection on same file
    assertEquals(h2.recent().length, 1);
    h2.insert(sample(1));
    assertEquals(h2.recent().length, 2);
    h2.close();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("History preserves numeric fidelity", async () => {
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
    assertEquals(got.mWh, 3.14159265);
    assertEquals(got.joules, 11.3097);
  });
});

Deno.test("defaultDbPath honours CO2_RUNNER_DB env", () => {
  Deno.env.set("CO2_RUNNER_DB", "/tmp/custom-co2.db");
  try {
    assertEquals(defaultDbPath(), "/tmp/custom-co2.db");
  } finally {
    Deno.env.delete("CO2_RUNNER_DB");
  }
});

Deno.test("defaultDbPath falls back to HOME/.co2-runner/history.db", () => {
  Deno.env.delete("CO2_RUNNER_DB");
  const home = Deno.env.get("HOME") ?? ".";
  assertEquals(defaultDbPath(), `${home}/.co2-runner/history.db`);
});
