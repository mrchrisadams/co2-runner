// Unit tests for runner/run-script.ts.
//
// These tests cover the pure logic: extension detection (isScriptFile)
// and slug derivation. The full run-script flow is exercised by
// tests/integration/run-script_test.ts (network-gated, requires Firefox
// cache + internet access).

import { assertEquals } from "jsr:@std/assert";
import { isScriptFile, SCRIPT_EXTENSIONS } from "../../runner/run-script.ts";

Deno.test("SCRIPT_EXTENSIONS lists the supported codegen formats", () => {
  // Sanity check — if we ever rename this list, we'd break the dispatcher
  // silently. Pinning the contents here makes that visible.
  assertEquals(SCRIPT_EXTENSIONS, [
    ".js",
    ".mjs",
    ".ts",
    ".spec.js",
    ".spec.ts",
  ]);
});

Deno.test("isScriptFile: true for all supported extensions", () => {
  assertEquals(isScriptFile("journeys/example.spec.js"), true);
  assertEquals(isScriptFile("journeys/example.spec.ts"), true);
  assertEquals(isScriptFile("/abs/path/journey.js"), true);
  assertEquals(isScriptFile("journey.mjs"), true);
  assertEquals(isScriptFile("JOURNEY.MJS"), true); // case-insensitive
  assertEquals(isScriptFile("JOURNEY.SPEC.JS"), true);
  assertEquals(isScriptFile("journey.ts"), true);
});

Deno.test("isScriptFile: false for YAML + non-script extensions", () => {
  assertEquals(isScriptFile("journeys/example.yaml"), false);
  assertEquals(isScriptFile("journeys/example.yml"), false);
  assertEquals(isScriptFile("journeys/example.json"), false);
  assertEquals(isScriptFile("journeys/example.txt"), false);
  assertEquals(isScriptFile("journeys/example.md"), false);
  assertEquals(isScriptFile("README"), false);
  assertEquals(isScriptFile(""), false);
});

Deno.test("isScriptFile: handles paths with dots in directory names", () => {
  // Pathological case — a directory name with a dot shouldn't confuse the
  // extension check.
  assertEquals(isScriptFile("/Users/foo/my.app/journeys/example.yaml"), false);
  assertEquals(
    isScriptFile("/Users/foo/my.app/journeys/example.spec.js"),
    true,
  );
});
