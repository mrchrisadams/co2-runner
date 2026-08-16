import { assertEquals } from "jsr:@std/assert";
import { executeStep } from "../../runner/run.ts";
import { MockPage } from "../fixtures/mock_page.ts";
import type { Step } from "../../types.ts";

Deno.test("executeStep: goto waits for load state", async () => {
  const page = new MockPage();
  await executeStep(page as any, {
    action: "goto",
    url: "https://example.com",
    waitFor: "networkidle",
  } as Step);
  assertEquals(page.calls, [
    { method: "goto", args: ["https://example.com"] },
    { method: "waitForLoadState", args: ["networkidle"] },
  ]);
});

Deno.test("executeStep: click waits for domcontentloaded", async () => {
  const page = new MockPage();
  await executeStep(page as any, {
    action: "click",
    selector: "role=link[name='Next']",
    waitFor: "domcontentloaded",
  } as Step);
  const loc = page.locator("role=link[name='Next']");
  assertEquals(loc.calls.map((c) => c.method), ["click"]);
  assertEquals(page.calls.map((c) => c.method), ["waitForLoadState"]);
});

Deno.test("executeStep: fill passes value to locator", async () => {
  const page = new MockPage();
  await executeStep(page as any, {
    action: "fill",
    selector: "#search",
    value: "carbon",
  } as Step);
  const loc = page.locator("#search");
  assertEquals(loc.calls, [{ method: "fill", args: ["carbon"] }]);
});

Deno.test("executeStep: non-human scroll uses window.scrollBy", async () => {
  const page = new MockPage();
  await executeStep(page as any, {
    action: "scroll",
    distance: 500,
  } as Step);
  assertEquals(page.calls, [
    { method: "evaluate", args: ["window.scrollBy(0, 500)"] },
  ]);
});

Deno.test("executeStep: human scroll issues multiple wheel events covering distance", async () => {
  const page = new MockPage();
  await executeStep(page as any, {
    action: "scroll",
    distance: 600,
    human: true,
  } as Step);

  const wheelCalls = page.mouse.calls;
  const totalScrolled = wheelCalls.reduce(
    (sum, c) => sum + (c.args[1] as number),
    0,
  );
  assertEquals(totalScrolled, 600);
  assertEquals(wheelCalls.length >= 3, true); // 600 / (120..240) → at least 3 chunks
});

Deno.test("executeStep: negative human scroll respects direction", async () => {
  const page = new MockPage();
  await executeStep(page as any, {
    action: "scroll",
    distance: -300,
    human: true,
  } as Step);
  const wheelCalls = page.mouse.calls;
  assertEquals(wheelCalls.every((c) => (c.args[1] as number) <= 0), true);
  const totalScrolled = wheelCalls.reduce(
    (sum, c) => sum + (c.args[1] as number),
    0,
  );
  assertEquals(totalScrolled, -300);
});

Deno.test("executeStep: wait calls waitForTimeout with given ms", async () => {
  const page = new MockPage();
  await executeStep(page as any, { action: "wait", ms: 120 } as Step);
  assertEquals(page.totalWaitMs(), 120);
});

Deno.test("executeStep: waitForSelector calls locator.waitFor with visible state", async () => {
  const page = new MockPage();
  await executeStep(page as any, {
    action: "waitForSelector",
    selector: "#loaded",
  } as Step);
  // locator is created and .waitFor called; recorded on the locator itself.
  const loc = page.locator("#loaded");
  assertEquals(loc.calls.length, 1);
  assertEquals(loc.calls[0].method, "waitFor");
});
