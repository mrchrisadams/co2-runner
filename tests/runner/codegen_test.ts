// Unit tests for runner/codegen.ts.
//
// Covers the pure logic: filename slug + host extraction + graphical
// display detection. The actual `launchCodegen` call (which spawns
// `playwright codegen` and opens windows) is exercised by an integration
// test, and is tricky to assert against — it depends on a graphical
// environment + network access + user interaction.

import { assert, assertEquals } from "jsr:@std/assert";
import {
  buildCodegenFilename,
  hasGraphicalDisplay,
} from "../../runner/codegen.ts";

Deno.test("buildCodegenFilename: produces <timestamp>-<host>.spec.js for a URL with hostname", () => {
  const name = buildCodegenFilename(
    "https://branch.climateaction.tech/some/path?q=1",
  );
  // We don't pin the timestamp (it'd flake), just assert the shape.
  const re =
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-branch\.climateaction\.tech\.spec\.js$/;
  assert(
    re.test(name),
    `expected <timestamp>-branch.climateaction.tech.spec.js, got: ${name}`,
  );
});

Deno.test("buildCodegenFilename: extracts hostname from URLs without paths", () => {
  const name = buildCodegenFilename("https://example.com");
  assert(
    name.endsWith("-example.com.spec.js"),
    `expected suffix -example.com.spec.js, got: ${name}`,
  );
});

Deno.test("buildCodegenFilename: falls back to slugified raw string for non-URL input", () => {
  // No scheme — `new URL()` throws — handler falls back to slugifying.
  const name = buildCodegenFilename("branch.climateaction.tech/some/path");
  // host should preserve dots (we only replace non-[a-zA-Z0-9.-]); the
  // '/some/path' part becomes dashes.
  assert(
    name.includes("branch.climateaction.tech-some-path"),
    `expected slugified host-path in name, got: ${name}`,
  );
  assert(name.endsWith(".spec.js"));
});

Deno.test("buildCodegenFilename: timestamp uses dashes instead of colons (filename-safe)", () => {
  const name = buildCodegenFilename("https://example.com");
  // Filename must NOT contain ':' (forbidden on Windows, problematic on
  // macOS for some shell tools).
  assert(!name.includes(":"), `filename contains ':', got: ${name}`);
});

Deno.test("hasGraphicalDisplay: returns a boolean synchronously", () => {
  const result = hasGraphicalDisplay();
  assertEquals(typeof result, "boolean");
});

Deno.test({
  name: "hasGraphicalDisplay: returns true on macOS dev machine",
  ignore: Deno.build.os !== "darwin",
  fn: () => {
    assertEquals(hasGraphicalDisplay(), true);
  },
});
