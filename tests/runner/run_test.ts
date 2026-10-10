import { test } from "node:test";
import assert from "node:assert/strict";
import { executeStep } from "../../runner/run.ts";
import { MockPage } from "../fixtures/mock_page.ts";
import type { PageLike, Step } from "../../types.ts";

test("executeStep: goto waits for load state", async () => {
  const page: PageLike = new MockPage();
  const step: Step = {
    action: "goto",
    url: "https://example.com",
    waitFor: "networkidle",
  };
  await executeStep(page, step);
  const calls = (page as unknown as MockPage).calls;
  assert.deepEqual(calls, [
    { method: "goto", args: ["https://example.com"] },
    { method: "waitForLoadState", args: ["networkidle"] },
  ]);
});

test("executeStep: click waits for domcontentloaded", async () => {
  const page = new MockPage();
  const step: Step = {
    action: "click",
    selector: "role=link[name='Next']",
    waitFor: "domcontentloaded",
  };
  await executeStep(page, step);
  const loc = page.locator("role=link[name='Next']");
  assert.deepEqual(loc.calls.map((c) => c.method), ["click"]);
  assert.deepEqual(page.calls.map((c) => c.method), ["waitForLoadState"]);
});

test("executeStep: fill passes value to locator", async () => {
  const page = new MockPage();
  const step: Step = {
    action: "fill",
    selector: "#search",
    value: "carbon",
  };
  await executeStep(page, step);
  const loc = page.locator("#search");
  assert.deepEqual(loc.calls, [{ method: "fill", args: ["carbon"] }]);
});

test("executeStep: non-human scroll uses window.scrollBy", async () => {
  const page = new MockPage();
  const step: Step = { action: "scroll", distance: 500 };
  await executeStep(page, step);
  assert.deepEqual(page.calls, [
    { method: "evaluate", args: ["window.scrollBy(0, 500)"] },
  ]);
});

test("executeStep: human scroll issues multiple wheel events covering distance", async () => {
  const page = new MockPage();
  const step: Step = { action: "scroll", distance: 600, human: true };
  await executeStep(page, step);

  const wheelCalls = page.mouse.calls;
  const totalScrolled = wheelCalls.reduce(
    (sum, c) => sum + (c.args[1] as number),
    0,
  );
  assert.deepEqual(totalScrolled, 600);
  assert.deepEqual(wheelCalls.length >= 3, true); // 600 / (120..240) → at least 3 chunks
});

test("executeStep: negative human scroll respects direction", async () => {
  const page = new MockPage();
  const step: Step = { action: "scroll", distance: -300, human: true };
  await executeStep(page, step);
  const wheelCalls = page.mouse.calls;
  assert.deepEqual(wheelCalls.every((c) => (c.args[1] as number) <= 0), true);
  const totalScrolled = wheelCalls.reduce(
    (sum, c) => sum + (c.args[1] as number),
    0,
  );
  assert.deepEqual(totalScrolled, -300);
});

test("executeStep: wait calls waitForTimeout with given ms", async () => {
  const page = new MockPage();
  const step: Step = { action: "wait", ms: 120 };
  await executeStep(page, step);
  assert.deepEqual(page.totalWaitMs(), 120);
});

test("executeStep: waitForSelector calls locator.waitFor with visible state", async () => {
  const page = new MockPage();
  const step: Step = {
    action: "waitForSelector",
    selector: "#loaded",
  };
  await executeStep(page, step);
  // locator is created and .waitFor called; recorded on the locator itself.
  const loc = page.locator("#loaded");
  assert.deepEqual(loc.calls.length, 1);
  assert.deepEqual(loc.calls[0].method, "waitFor");
});
