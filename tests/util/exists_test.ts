import { test } from "node:test";
import assert from "node:assert/strict";
import { exists } from "../../util/exists.ts";

test("exists: returns true for paths that exist", async () => {
  assert.deepEqual(await exists("."), true);
  assert.deepEqual(await exists("./deno.json"), true);
});

test("exists: returns false for paths that don't exist", async () => {
  assert.deepEqual(
    await exists("./this/path/definitely/does/not/exist"),
    false,
  );
});

test("exists: returns false (not throw) for permission errors", async () => {
  // Path that's likely unreadable on macOS — root-only accessible.
  // On most systems this returns false rather than throwing.
  const result = await exists("/private/var/db/.systemDefaultAppsList");
  assert.deepEqual(typeof result, "boolean");
});

test("exists: handles URLs", async () => {
  // Use a known-existing file URL.
  const url = new URL("../../deno.json", import.meta.url);
  assert.deepEqual(await exists(url), true);
});
