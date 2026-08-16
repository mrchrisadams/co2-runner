// Unit tests for runner/co2.ts — Electricity Maps grid intensity data + conversion.

import { assert, assertEquals } from "jsr:@std/assert";
import { gridIntensityEntries, whToGramsCO2e } from "../../runner/co2.ts";

Deno.test("gridIntensityEntries: returns a non-empty array", () => {
  const entries = gridIntensityEntries();
  assert(entries.length > 100, `expected ≥100 entries, got ${entries.length}`);
});

Deno.test("gridIntensityEntries: each entry has the expected shape + label format", () => {
  const entries = gridIntensityEntries();
  for (const e of entries) {
    assertEquals(typeof e.zoneId, "string");
    assertEquals(typeof e.zoneName, "string");
    assertEquals(typeof e.intensity, "number");
    assertEquals(typeof e.carbonFree, "number");
    assertEquals(typeof e.label, "string");
    // Label must contain the zone ID in parentheses + the intensity value.
    assert(
      e.label.includes(`(${e.zoneId})`),
      `label missing zone ID: ${e.label}`,
    );
    assert(
      e.label.includes(String(e.intensity)),
      `label missing intensity: ${e.label}`,
    );
    assert(
      e.label.includes(`${e.carbonFree}%`),
      `label missing carbonFree%: ${e.label}`,
    );
  }
});

Deno.test("gridIntensityEntries: includes sample country + sub-national zones", () => {
  const entries = gridIntensityEntries();
  const ids = entries.map((e) => e.zoneId);
  assert(ids.includes("GB"), "missing GB (Great Britain)");
  assert(ids.includes("US"), "missing US (United States)");
  assert(ids.includes("AU-NSW"), "missing AU-NSW (New South Wales)");
  assert(ids.includes("FR"), "missing FR (France)");
  assert(ids.includes("JP-TK"), "missing JP-TK (Tokyo)");
});

Deno.test("gridIntensityEntries: country-level before sub-national", () => {
  const entries = gridIntensityEntries();
  // First entry should be a country-level (no countryName).
  assert(
    !entries[0].countryName,
    `first entry should be country-level, got ${entries[0].label}`,
  );
  // Sub-national entries (with countryName) should appear after all country-level.
  let seenSubNational = false;
  for (const e of entries) {
    if (e.countryName) seenSubNational = true;
    if (seenSubNational && !e.countryName) {
      assert(false, `country-level entry after sub-national: ${e.label}`);
    }
  }
});

Deno.test("gridIntensityEntries: cached — returns same array reference", () => {
  const first = gridIntensityEntries();
  const second = gridIntensityEntries();
  assertEquals(first, second);
});

Deno.test("whToGramsCO2e: converts Wh × gCO2/kWh → gCO2e", () => {
  assertEquals(whToGramsCO2e(1, 1000), 1);
  assertEquals(whToGramsCO2e(2, 500), 1);
  // 0.0024 Wh (2.4 mWh) at GB intensity 176 → 0.000422 gCO2e.
  const result = whToGramsCO2e(0.0024, 176);
  assert(result > 0 && result < 0.01, `expected ~0.0004 gCO2e, got ${result}`);
});

Deno.test("whToGramsCO2e: handles edge cases", () => {
  assertEquals(whToGramsCO2e(0, 500), 0);
  assertEquals(whToGramsCO2e(100, 0), 0);
  assertEquals(whToGramsCO2e(100, -1), 0);
});
