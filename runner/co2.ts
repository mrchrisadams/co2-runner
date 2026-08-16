// runner/co2.ts — grid-intensity data + Wh → gCO2e conversion.
//
// Uses @tgwf/co2's averageIntensity (Ember yearly averages) and
// marginalIntensity (UNFCCC yearly averages) datasets to convert
// energy figures (Wh) into carbon-equivalent figures (gCO2e).
//
// Conversion formula: gCO2e = Wh × intensity(gCO2/kWh) / 1000
//
// The datasets are static (built into @tgwf/co2 at publish time) so
// we cache them once at module load + expose a flat list for the UI
// to render as a dropdown.

import { averageIntensity, marginalIntensity } from "@tgwf/co2";

export interface GridIntensityEntry {
  /** Stable key for the dropdown value — e.g. "WORLD", "USA", "EUROPE". */
  code: string;
  /** Human-readable label — e.g. "World average", "United States", "Europe". */
  label: string;
  /** gCO2 per kWh. */
  intensity: number;
  /** Data source for transparency. */
  source: "average" | "marginal";
}

let cachedEntries: GridIntensityEntry[] | null = null;

/**
 * Flat list of all grid-intensity entries, sorted: WORLD first, then
 * regional aggregates (alphabetical), then countries (alphabetical).
 * Average figures come before marginal for the same region (when duplicate).
 *
 * Used by the server's /grid-intensities endpoint.
 */
export function gridIntensityEntries(): GridIntensityEntry[] {
  if (cachedEntries) return cachedEntries;

  const avg = averageIntensity.data as Record<string, number>;
  const mar = marginalIntensity.data as Record<string, number>;

  const entries: GridIntensityEntry[] = [];

  // WORLD first — that's the default selection in the UI.
  if ("WORLD" in avg) {
    entries.push({
      code: "WORLD",
      label: "World average (Ember)",
      intensity: avg.WORLD,
      source: "average",
    });
  }

  // Regional aggregates next (codes longer than 3 chars that aren't WORLD).
  const regionalAvg = Object.keys(avg).filter((k) =>
    k.length > 3 && k !== "WORLD"
  ).sort();
  for (const code of regionalAvg) {
    entries.push({
      code: `AVG-${code}`,
      label: `${titleCase(code)} (Ember average)`,
      intensity: avg[code],
      source: "average",
    });
  }

  // Countries (3-letter ISO codes) — average first, then marginal.
  const countries = Object.keys(avg).filter((k) => k.length === 3).sort();
  for (const code of countries) {
    entries.push({
      code: `AVG-${code}`,
      label: `${countryName(code)} (Ember average)`,
      intensity: avg[code],
      source: "average",
    });
  }
  const marginalCountries = Object.keys(mar).filter((k) => k.length === 3)
    .sort();
  for (const code of marginalCountries) {
    entries.push({
      code: `MAR-${code}`,
      label: `${countryName(code)} (UNFCCC marginal)`,
      intensity: mar[code],
      source: "marginal",
    });
  }

  cachedEntries = entries;
  return entries;
}

/**
 * Convert watt-hours to grams of CO2 equivalent, using the given
 * grid-intensity entry (from gridIntensityEntries()).
 *
 *   gCO2e = Wh × intensity(gCO2/kWh) / 1000
 *
 * Returns 0 if intensity is undefined / 0.
 */
export function whToGramsCO2e(wh: number, intensity: number): number {
  if (!intensity || intensity <= 0) return 0;
  return (wh * intensity) / 1000;
}

// ── helpers ────────────────────────────────────────────────────────────

function titleCase(s: string): string {
  return s.split(" ").map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(
    " ",
  );
}

// Tiny ISO-3 → English country-name map for the most common cases.
// Falls back to the bare code if we don't have a friendly name — better
// than nothing and keeps the bundle small.
const COUNTRY_NAMES: Record<string, string> = {
  AFG: "Afghanistan",
  ALB: "Albania",
  DZA: "Algeria",
  AND: "Andorra",
  AGO: "Angola",
  ARG: "Argentina",
  ARM: "Armenia",
  AUS: "Australia",
  AUT: "Austria",
  AZE: "Azerbaijan",
  BHS: "Bahamas",
  BHR: "Bahrain",
  BGD: "Bangladesh",
  BRB: "Barbados",
  BLR: "Belarus",
  BEL: "Belgium",
  BLZ: "Belize",
  BEN: "Benin",
  BTN: "Bhutan",
  BOL: "Bolivia",
  BIH: "Bosnia and Herzegovina",
  BWA: "Botswana",
  BRA: "Brazil",
  BRN: "Brunei",
  BGR: "Bulgaria",
  BFA: "Burkina Faso",
  BDI: "Burundi",
  KHM: "Cambodia",
  CMR: "Cameroon",
  CAN: "Canada",
  CPV: "Cape Verde",
  CAF: "Central African Republic",
  TCD: "Chad",
  CHL: "Chile",
  CHN: "China",
  COL: "Colombia",
  COM: "Comoros",
  COG: "Congo",
  CRI: "Costa Rica",
  CIV: "Côte d'Ivoire",
  HRV: "Croatia",
  CUB: "Cuba",
  CYP: "Cyprus",
  CZE: "Czech Republic",
  DNK: "Denmark",
  DJI: "Djibouti",
  DMA: "Dominica",
  DOM: "Dominican Republic",
  ECU: "Ecuador",
  EGY: "Egypt",
  SLV: "El Salvador",
  GNQ: "Equatorial Guinea",
  ERI: "Eritrea",
  EST: "Estonia",
  ETH: "Ethiopia",
  FJI: "Fiji",
  FIN: "Finland",
  FRA: "France",
  GAB: "Gabon",
  GMB: "Gambia",
  GEO: "Georgia",
  DEU: "Germany",
  GHA: "Ghana",
  GRC: "Greece",
  GRD: "Grenada",
  GTM: "Guatemala",
  GIN: "Guinea",
  GNB: "Guinea-Bissau",
  GUY: "Guyana",
  HTI: "Haiti",
  HND: "Honduras",
  HKG: "Hong Kong",
  HUN: "Hungary",
  ISL: "Iceland",
  IND: "India",
  IDN: "Indonesia",
  IRN: "Iran",
  IRQ: "Iraq",
  IRL: "Ireland",
  ISR: "Israel",
  ITA: "Italy",
  JAM: "Jamaica",
  JPN: "Japan",
  JOR: "Jordan",
  KAZ: "Kazakhstan",
  KEN: "Kenya",
  KIR: "Kiribati",
  PRK: "North Korea",
  KOR: "South Korea",
  KWT: "Kuwait",
  KGZ: "Kyrgyzstan",
  LAO: "Laos",
  LVA: "Latvia",
  LBN: "Lebanon",
  LSO: "Lesotho",
  LBR: "Liberia",
  LBY: "Libya",
  LIE: "Liechtenstein",
  LTU: "Lithuania",
  LUX: "Luxembourg",
  MKD: "North Macedonia",
  MDG: "Madagascar",
  MWI: "Malawi",
  MYS: "Malaysia",
  MDV: "Maldives",
  MLI: "Mali",
  MLT: "Malta",
  MHL: "Marshall Islands",
  MRT: "Mauritania",
  MUS: "Mauritius",
  MEX: "Mexico",
  FSM: "Micronesia",
  MDA: "Moldova",
  MCO: "Monaco",
  MNG: "Mongolia",
  MNE: "Montenegro",
  MAR: "Morocco",
  MOZ: "Mozambique",
  MMR: "Myanmar",
  NAM: "Namibia",
  NRU: "Nauru",
  NPL: "Nepal",
  NLD: "Netherlands",
  NZL: "New Zealand",
  NIC: "Nicaragua",
  NER: "Niger",
  NGA: "Nigeria",
  NOR: "Norway",
  OMN: "Oman",
  PAK: "Pakistan",
  PLW: "Palau",
  PAN: "Panama",
  PNG: "Papua New Guinea",
  PRY: "Paraguay",
  PER: "Peru",
  PHL: "Philippines",
  POL: "Poland",
  PRT: "Portugal",
  QAT: "Qatar",
  ROU: "Romania",
  RUS: "Russia",
  RWA: "Rwanda",
  KNA: "Saint Kitts and Nevis",
  LCA: "Saint Lucia",
  VCT: "Saint Vincent and the Grenadines",
  WSM: "Samoa",
  SMR: "San Marino",
  STP: "São Tomé and Príncipe",
  SAU: "Saudi Arabia",
  SEN: "Senegal",
  SRB: "Serbia",
  SYC: "Seychelles",
  SLE: "Sierra Leone",
  SGP: "Singapore",
  SVK: "Slovakia",
  SVN: "Slovenia",
  SLB: "Solomon Islands",
  SOM: "Somalia",
  ZAF: "South Africa",
  SSD: "South Sudan",
  ESP: "Spain",
  LKA: "Sri Lanka",
  SDN: "Sudan",
  SUR: "Suriname",
  SWE: "Sweden",
  CHE: "Switzerland",
  SYR: "Syria",
  TJK: "Tajikistan",
  TZA: "Tanzania",
  THA: "Thailand",
  TLS: "Timor-Leste",
  TGO: "Togo",
  TON: "Tonga",
  TTO: "Trinidad and Tobago",
  TUN: "Tunisia",
  TUR: "Turkey",
  TKM: "Turkmenistan",
  TUV: "Tuvalu",
  UGA: "Uganda",
  UKR: "Ukraine",
  ARE: "United Arab Emirates",
  GBR: "United Kingdom",
  USA: "United States",
  URY: "Uruguay",
  UZB: "Uzbekistan",
  VUT: "Vanuatu",
  VEN: "Venezuela",
  VNM: "Vietnam",
  YEM: "Yemen",
  ZMB: "Zambia",
  ZWE: "Zimbabwe",
};

function countryName(iso3: string): string {
  return COUNTRY_NAMES[iso3] ?? iso3;
}
