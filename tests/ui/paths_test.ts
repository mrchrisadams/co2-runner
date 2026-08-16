import { assertEquals } from "jsr:@std/assert";
import {
  artefactsDir,
  co2RunnerHome,
  defaultDbPath,
  recordedJourneysDir,
  uploadsDir,
} from "../../ui/paths.ts";

Deno.test("co2RunnerHome honours CO2_RUNNER_HOME env", () => {
  Deno.env.set("CO2_RUNNER_HOME", "/tmp/custom-co2-home");
  try {
    assertEquals(co2RunnerHome(), "/tmp/custom-co2-home");
    assertEquals(artefactsDir(), "/tmp/custom-co2-home/journey-artefacts");
    assertEquals(defaultDbPath(), "/tmp/custom-co2-home/history.db");
  } finally {
    Deno.env.delete("CO2_RUNNER_HOME");
  }
});

Deno.test("co2RunnerHome falls back to HOME when env unset", () => {
  Deno.env.delete("CO2_RUNNER_HOME");
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  assertEquals(co2RunnerHome(), `${home}/.co2-runner`);
  assertEquals(artefactsDir(), `${home}/.co2-runner/journey-artefacts`);
  assertEquals(defaultDbPath(), `${home}/.co2-runner/history.db`);
});

Deno.test("defaultDbPath honours CO2_RUNNER_DB env (highest precedence)", () => {
  Deno.env.set("CO2_RUNNER_DB", "/tmp/custom-hist.db");
  Deno.env.delete("CO2_RUNNER_HOME");
  try {
    assertEquals(defaultDbPath(), "/tmp/custom-hist.db");
  } finally {
    Deno.env.delete("CO2_RUNNER_DB");
  }
});

Deno.test("uploadsDir resolves under co2RunnerHome", () => {
  Deno.env.set("CO2_RUNNER_HOME", "/tmp/custom-co2-home");
  try {
    assertEquals(uploadsDir(), "/tmp/custom-co2-home/uploaded-journeys");
  } finally {
    Deno.env.delete("CO2_RUNNER_HOME");
  }
});

Deno.test("recordedJourneysDir resolves under co2RunnerHome", () => {
  Deno.env.set("CO2_RUNNER_HOME", "/tmp/custom-co2-home");
  try {
    assertEquals(
      recordedJourneysDir(),
      "/tmp/custom-co2-home/recorded-journeys",
    );
  } finally {
    Deno.env.delete("CO2_RUNNER_HOME");
  }
});
