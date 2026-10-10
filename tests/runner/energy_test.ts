import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { parseEnergyProfile } from "../../runner/energy.ts";
import {
  buildProfile,
  PWH_TO_JOULES,
  PWH_TO_MWH,
} from "../fixtures/profiler.ts";
import {
  makeTempFile,
  remove,
  writeFile,
  writeTextFile,
} from "../../util/fsx.ts";

function almostEquals(actual: number, expected: number, tolerance: number) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

async function writeProfile(path: string, profile: unknown): Promise<string> {
  await writeTextFile(path, JSON.stringify(profile));
  return path;
}

test("parseEnergyProfile sums power counters across parent + children", async () => {
  const tmp = await makeTempFile({ suffix: ".json" });
  try {
    const profile = buildProfile(
      [{ values: [100, 200] }], // parent: 300 pWh
      [
        [{ values: [50, 50] }], // child 0: 100 pWh
        [{ values: [250] }], // child 1: 250 pWh
      ],
    );
    await writeProfile(tmp, profile);

    const result = await parseEnergyProfile(tmp, "test-journey");

    const totalPWh = 300 + 100 + 250; // 650 pWh
    assert.deepEqual(result.name, "test-journey");
    almostEquals(result.mWh, totalPWh * PWH_TO_MWH, 1e-12);
    almostEquals(result.joules, totalPWh * PWH_TO_JOULES, 1e-12);
    assert.deepEqual(typeof result.timestamp, "string");
  } finally {
    await remove(tmp).catch(() => {});
  }
});

test("parseEnergyProfile ignores negative sample values", async () => {
  const tmp = await makeTempFile({ suffix: ".json" });
  try {
    const profile = buildProfile([
      { values: [100, -50, 100] },
    ]);
    await writeProfile(tmp, profile);
    const result = await parseEnergyProfile(tmp, "neg-test");
    almostEquals(result.mWh, 200 * PWH_TO_MWH, 1e-12);
  } finally {
    await remove(tmp).catch(() => {});
  }
});

test("parseEnergyProfile ignores non-power counters", async () => {
  const tmp = await makeTempFile({ suffix: ".json" });
  try {
    const profile = buildProfile([{ values: [100, 100] }]);
    profile.counters![0].category = "cpu";
    await writeProfile(tmp, profile);
    await assert.rejects(
      () => parseEnergyProfile(tmp, "no-power"),
      /No power counters found/,
    );
  } finally {
    await remove(tmp).catch(() => {});
  }
});

test("parseEnergyProfile handles gzip profiles", async () => {
  const tmp = await makeTempFile({ suffix: ".json" });
  try {
    const profile = buildProfile([{ values: [1_000_000_000] }]); // 1 mWh
    const json = JSON.stringify(profile);
    const gz = gzipSync(new TextEncoder().encode(json));
    await writeFile(tmp, gz);

    const result = await parseEnergyProfile(tmp, "gzip-test");
    almostEquals(result.mWh, 1, 1e-9);
  } finally {
    await remove(tmp).catch(() => {});
  }
});

test("parseEnergyProfile throws if file has no power counters", async () => {
  const tmp = await makeTempFile({ suffix: ".json" });
  try {
    await writeProfile(tmp, { counters: [], processes: [] });
    await assert.rejects(
      () => parseEnergyProfile(tmp, "empty"),
      /No power counters found/,
    );
  } finally {
    await remove(tmp).catch(() => {});
  }
});
