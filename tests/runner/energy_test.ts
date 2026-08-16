import {
  assertAlmostEquals,
  assertEquals,
  assertRejects,
} from "jsr:@std/assert";
import { gzipSync } from "node:zlib";
import { parseEnergyProfile } from "../../runner/energy.ts";
import {
  buildProfile,
  PWH_TO_JOULES,
  PWH_TO_MWH,
} from "../fixtures/profiler.ts";

async function writeProfile(path: string, profile: unknown): Promise<string> {
  await Deno.writeTextFile(path, JSON.stringify(profile));
  return path;
}

Deno.test("parseEnergyProfile sums power counters across parent + children", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".json" });
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
    assertEquals(result.name, "test-journey");
    assertAlmostEquals(result.mWh, totalPWh * PWH_TO_MWH, 1e-12);
    assertAlmostEquals(result.joules, totalPWh * PWH_TO_JOULES, 1e-12);
    assertEquals(typeof result.timestamp, "string");
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
});

Deno.test("parseEnergyProfile ignores negative sample values", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".json" });
  try {
    const profile = buildProfile([
      { values: [100, -50, 100] },
    ]);
    await writeProfile(tmp, profile);
    const result = await parseEnergyProfile(tmp, "neg-test");
    assertAlmostEquals(result.mWh, 200 * PWH_TO_MWH, 1e-12);
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
});

Deno.test("parseEnergyProfile ignores non-power counters", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".json" });
  try {
    const profile = buildProfile([{ values: [100, 100] }]);
    profile.counters![0].category = "cpu";
    await writeProfile(tmp, profile);
    await assertRejects(
      () => parseEnergyProfile(tmp, "no-power"),
      Error,
      "No power counters found",
    );
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
});

Deno.test("parseEnergyProfile handles gzip profiles", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".json" });
  try {
    const profile = buildProfile([{ values: [1_000_000_000] }]); // 1 mWh
    const json = JSON.stringify(profile);
    const gz = gzipSync(new TextEncoder().encode(json));
    await Deno.writeFile(tmp, gz);

    const result = await parseEnergyProfile(tmp, "gzip-test");
    assertAlmostEquals(result.mWh, 1, 1e-9);
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
});

Deno.test("parseEnergyProfile throws if file has no power counters", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await writeProfile(tmp, { counters: [], processes: [] });
    await assertRejects(
      () => parseEnergyProfile(tmp, "empty"),
      Error,
      "No power counters found",
    );
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
});
