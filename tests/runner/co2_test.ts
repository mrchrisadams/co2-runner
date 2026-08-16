// Unit tests for runner/co2.ts — grid intensity entries + Wh→gCO2e conversion.

import { assert, assertEquals } from "jsr:@std/assert";
import { gridIntensityEntries, whToGramsCO2e } from "../../runner/co2.ts";

Deno.test("gridIntensityEntries: returns a non-empty array on first call", () => {
  const entries = gridIntensityEntries();
  assert(
    entries.length > 100,
    "expected ≥100 entries (country + regional averages)",
  );
});

Deno.test("gridIntensityEntries: WORLD is first entry", () => {
  const entries = gridIntensityEntries();
  assertEquals(entries[0].code, "WORLD");
  // The global average from Ember; pin tightly so an upstream change
  // in @tgwf/co2's data is visible in the test failure message.
  assertEquals(typeof entries[0].intensity, "number");
  assert(
    entries[0].intensity > 400,
    `world avg should be > 400, got ${entries[0].intensity}`,
  );
});

Deno.test("gridIntensityEntries: includes sample countries + marginal entries", () => {
  const entries = gridIntensityEntries();
  const codes = entries.map((e) => e.code);
  assert(codes.includes("AVG-USA"), "expected AVG-USA (Ember average)");
  assert(codes.includes("AVG-GBR"), "expected AVG-GBR (Ember average)");
  assert(codes.includes("MAR-USA"), "expected MAR-USA (UNFCCC marginal)");
  assert(codes.includes("MAR-GBR"), "expected MAR-GBR (UNFCCC marginal)");
});

Deno.test("gridIntensityEntries: cached — returns the same array reference", () => {
  const first = gridIntensityEntries();
  const second = gridIntensityEntries();
  // Module-level cache means subsequent calls return the same array
  // reference, so the UI dropdown is populated without re-evaluating
  // the data on every call.
  assertEquals(first, second);
});

Deno.test("whToGramsCO2e: converts Wh × gCO2/kWh → gCO2e", () => {
  // 1 Wh at intensity 1000 gCO2/kWh → 1 gCO2e.
  assertEquals(whToGramsCO2e(1, 1000), 1);
  // 2 Wh at intensity 500 → 1 gCO2e.
  assertEquals(whToGramsCO2e(2, 500), 1);
  // 0.0024 Wh (≈2.4 mWh journey) at world average 472.94 → 0.001135 gCO2e.
  // Sanity-check the magnitude makes sense for a 2 mWh journey.
  const result = whToGramsCO2e(0.0024, 472.94);
  assert(result > 0 && result < 0.01, `expected ~0.001 gCO2e, got ${result}`);
});

Deno.test("whToGramsCO2e: handles edge cases gracefully", () => {
  assertEquals(whToGramsCO2e(0, 500), 0);
  assertEquals(whToGramsCO2e(100, 0), 0);
  assertEquals(whToGramsCO2e(100, -1), 0);
});
