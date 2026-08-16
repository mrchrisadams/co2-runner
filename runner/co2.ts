// runner/co2.ts — grid-intensity data from Electricity Maps + Wh → gCO2e.
//
// Uses the Electricity Maps yearly 2025 dataset (re-published via co2.js
// under the Open Database License). Each entry has:
//   - zone ID (e.g. "GB", "AU-NSW", "US-CAL-CISO")
//   - zone name (e.g. "Great Britain", "New South Wales")
//   - optional country name (for sub-national zones)
//   - carbon intensity (gCO2eq/kWh)
//   - carbon-free energy share (%)
//
// Conversion: gCO2e = Wh × intensity(gCO2/kWh) / 1000
//
// The data file is downloaded at build time from co2.js's GitHub repo
// and embedded into the binary via `import ... with { type: "json" }`.

// deno-lint-ignore no-import-prefix
import emData from "../data/electricity-maps-yearly-2025.json" with {
  type: "json",
};

export interface GridIntensityEntry {
  /** Zone ID from Electricity Maps, e.g. "GB", "AU-NSW", "US-CAL-CISO". */
  zoneId: string;
  /** Country name (if sub-national zone) or undefined for country-level. */
  countryName?: string;
  /** Zone name, e.g. "Great Britain", "New South Wales". */
  zoneName: string;
  /** Carbon intensity in gCO2eq/kWh. */
  intensity: number;
  /** Carbon-free energy share (%). */
  carbonFree: number;
  /** Display label for the dropdown: "Country, Zone - (ID) - intensity - carbonFree%" */
  label: string;
}

let cachedEntries: GridIntensityEntry[] | null = null;

type EmData = Record<
  string,
  {
    zone: { zoneName: string; countryName?: string };
    carbonIntensity: { value: number; unit: string };
    renewableEnergy: { value: number; unit: string };
    carbonFreeEnergy: { value: number; unit: string };
  }
>;

/**
 * Sorted list of all grid-intensity entries from the Electricity Maps
 * 2025 dataset. Country-level entries first (sorted alphabetically by
 * zone name), then sub-national zones (sorted by country then zone name).
 */
export function gridIntensityEntries(): GridIntensityEntry[] {
  if (cachedEntries) return cachedEntries;

  const data = emData as EmData;
  const entries: GridIntensityEntry[] = [];

  for (const [zoneId, entry] of Object.entries(data)) {
    const countryName = entry.zone.countryName;
    const zoneName = entry.zone.zoneName;
    const intensity = entry.carbonIntensity.value;
    const carbonFree = entry.carbonFreeEnergy.value;

    // Label format: "Country, Zone - (ID) - intensity - carbonFree%"
    // If there's no country name (country-level entry), just "Zone - (ID) - ..."
    const label = countryName
      ? `${countryName}, ${zoneName} - (${zoneId}) - ${intensity} gCO₂e / KWh- ${carbonFree}% carbon free`
      : `${zoneName} - (${zoneId}) - ${intensity} gCO₂e / KWh - ${carbonFree}% carbon free`;

    entries.push({
      zoneId,
      countryName,
      zoneName,
      intensity,
      carbonFree,
      label,
    });
  }

  // Sort: country-level first (alphabetical by zone name), then sub-national
  // (by country name then zone name).
  entries.sort((a, b) => {
    if (a.countryName && !b.countryName) return 1;
    if (!a.countryName && b.countryName) return -1;
    if (a.countryName && b.countryName) {
      const c = a.countryName.localeCompare(b.countryName);
      if (c !== 0) return c;
      return a.zoneName.localeCompare(b.zoneName);
    }
    return a.zoneName.localeCompare(b.zoneName);
  });

  cachedEntries = entries;
  return entries;
}

/**
 * Convert watt-hours to grams of CO2 equivalent, using the given
 * grid-intensity value.
 *
 *   gCO2e = Wh × intensity(gCO2/kWh) / 1000
 */
export function whToGramsCO2e(wh: number, intensity: number): number {
  if (!intensity || intensity <= 0) return 0;
  return (wh * intensity) / 1000;
}
