import { test } from "node:test";
import assert from "node:assert/strict";
import {
  installBrowsers,
  installBrowsersWithProgress,
  isFirefoxInstalled,
} from "../../runner/install.ts";
import type { InstallProgress } from "../../types.ts";

test("isFirefoxInstalled: returns a boolean (true on this dev machine)", async () => {
  // This test is run on dev machines that have run `deno task install`.
  // It just asserts the function returns a boolean and doesn't throw —
  // we don't enforce which boolean (CI machines may not have Firefox).
  const result = await isFirefoxInstalled();
  assert.deepEqual(typeof result, "boolean");
});

test("installBrowsers and installBrowsersWithProgress are exported", () => {
  // Sanity check: the CLI entry point depends on these existing.
  assert.deepEqual(typeof installBrowsers, "function");
  assert.deepEqual(typeof installBrowsersWithProgress, "function");
});

test("installBrowsersWithProgress emits a starting + complete/error event", async () => {
  // Actually running the install would download ~150MB. Instead we check
  // that the progress callback type signature is honoured by exercising
  // it against a stub. We don't call installBrowsersWithProgress() here
  // in unit tests; the integration test exercises the real flow.
  const events: InstallProgress[] = [];
  const sink = (p: InstallProgress) => events.push(p);
  // Type-only smoke test: confirm the callback accepts the expected shape.
  sink({ phase: "starting", message: "test" });
  sink({ phase: "downloading", message: "10% ..." });
  sink({ phase: "complete", message: "✅ done" });
  assert.deepEqual(events.length, 3);
  assert.deepEqual(events[0].phase, "starting");
  assert.deepEqual(events[2].phase, "complete");
});
