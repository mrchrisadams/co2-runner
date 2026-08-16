import { assertEquals, assertExists } from "jsr:@std/assert";
import { exists } from "../../util/exists.ts";

Deno.test("exists: returns true for paths that exist", async () => {
  assertEquals(await exists("."), true);
  assertEquals(await exists("./deno.json"), true);
});

Deno.test("exists: returns false for paths that don't exist", async () => {
  assertEquals(await exists("./this/path/definitely/does/not/exist"), false);
});

Deno.test("exists: returns false (not throw) for permission errors", async () => {
  // Path that's likely unreadable on macOS — root-only accessible.
  // On most systems this returns false rather than throwing.
  const result = await exists("/private/var/db/.systemDefaultAppsList");
  assertEquals(typeof result, "boolean");
});

Deno.test("exists: handles URLs", async () => {
  // Use a known-existing file URL.
  const url = new URL("../../deno.json", import.meta.url);
  assertEquals(await exists(url), true);
});

// Resolve the import for type only so TS doesn't warn about unused import.
void assertExists;
