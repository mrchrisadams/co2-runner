import { test } from "node:test";
// Unit tests for runner/run-script.ts.
//
// These tests cover the pure logic: extension detection (isScriptFile)
// and slug derivation. The full run-script flow is exercised by
// tests/integration/run-script_test.ts (network-gated, requires Firefox
// cache + internet access).

import assert from "node:assert/strict";
import { isScriptFile, SCRIPT_EXTENSIONS } from "../../runner/run-script.ts";

test("SCRIPT_EXTENSIONS lists the supported codegen formats", () => {
  // Sanity check — if we ever rename this list, we'd break the dispatcher
  // silently. Pinning the contents here makes that visible.
  assert.deepEqual(SCRIPT_EXTENSIONS, [
    ".js",
    ".mjs",
    ".ts",
    ".spec.js",
    ".spec.ts",
  ]);
});

test("isScriptFile: true for all supported extensions", () => {
  assert.deepEqual(isScriptFile("journeys/example.spec.js"), true);
  assert.deepEqual(isScriptFile("journeys/example.spec.ts"), true);
  assert.deepEqual(isScriptFile("/abs/path/journey.js"), true);
  assert.deepEqual(isScriptFile("journey.mjs"), true);
  assert.deepEqual(isScriptFile("JOURNEY.MJS"), true); // case-insensitive
  assert.deepEqual(isScriptFile("JOURNEY.SPEC.JS"), true);
  assert.deepEqual(isScriptFile("journey.ts"), true);
});

test("isScriptFile: false for YAML + non-script extensions", () => {
  assert.deepEqual(isScriptFile("journeys/example.yaml"), false);
  assert.deepEqual(isScriptFile("journeys/example.yml"), false);
  assert.deepEqual(isScriptFile("journeys/example.json"), false);
  assert.deepEqual(isScriptFile("journeys/example.txt"), false);
  assert.deepEqual(isScriptFile("journeys/example.md"), false);
  assert.deepEqual(isScriptFile("README"), false);
  assert.deepEqual(isScriptFile(""), false);
});

test("isScriptFile: handles paths with dots in directory names", () => {
  // Pathological case — a directory name with a dot shouldn't confuse the
  // extension check.
  assert.deepEqual(
    isScriptFile("/Users/foo/my.app/journeys/example.yaml"),
    false,
  );
  assert.deepEqual(
    isScriptFile("/Users/foo/my.app/journeys/example.spec.js"),
    true,
  );
});
