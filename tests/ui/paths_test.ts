import { test } from "node:test";
import assert from "node:assert/strict";
import {
  artefactsDir,
  co2RunnerHome,
  defaultDbPath,
  recordedJourneysDir,
  uploadsDir,
} from "../../ui/paths.ts";

test("co2RunnerHome honours CO2_RUNNER_HOME env", () => {
  process.env["CO2_RUNNER_HOME"] = "/tmp/custom-co2-home";
  try {
    assert.deepEqual(co2RunnerHome(), "/tmp/custom-co2-home");
    assert.deepEqual(artefactsDir(), "/tmp/custom-co2-home/journey-artefacts");
    assert.deepEqual(defaultDbPath(), "/tmp/custom-co2-home/history.db");
  } finally {
    delete process.env["CO2_RUNNER_HOME"];
  }
});

test("co2RunnerHome falls back to HOME when env unset", () => {
  delete process.env["CO2_RUNNER_HOME"];
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
  assert.deepEqual(co2RunnerHome(), `${home}/.co2-runner`);
  assert.deepEqual(artefactsDir(), `${home}/.co2-runner/journey-artefacts`);
  assert.deepEqual(defaultDbPath(), `${home}/.co2-runner/history.db`);
});

test("defaultDbPath honours CO2_RUNNER_DB env (highest precedence)", () => {
  process.env["CO2_RUNNER_DB"] = "/tmp/custom-hist.db";
  delete process.env["CO2_RUNNER_HOME"];
  try {
    assert.deepEqual(defaultDbPath(), "/tmp/custom-hist.db");
  } finally {
    delete process.env["CO2_RUNNER_DB"];
  }
});

test("uploadsDir resolves under co2RunnerHome", () => {
  process.env["CO2_RUNNER_HOME"] = "/tmp/custom-co2-home";
  try {
    assert.deepEqual(uploadsDir(), "/tmp/custom-co2-home/uploaded-journeys");
  } finally {
    delete process.env["CO2_RUNNER_HOME"];
  }
});

test("recordedJourneysDir resolves under co2RunnerHome", () => {
  process.env["CO2_RUNNER_HOME"] = "/tmp/custom-co2-home";
  try {
    assert.deepEqual(
      recordedJourneysDir(),
      "/tmp/custom-co2-home/recorded-journeys",
    );
  } finally {
    delete process.env["CO2_RUNNER_HOME"];
  }
});
