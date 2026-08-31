import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert";
import {
  awaitMetrics,
  awaitPhaseStats,
  CLIENT_ORIGIN,
  fetchMetrics,
  fetchRunByJobId,
  GMT_PHASE,
  journeyToGmtScript,
  MetricsNotReadyError,
  pollForRun,
  submitToGateway,
} from "../../runner/gmt.ts";
import type { JourneyConfig } from "../../types.ts";

const journey = (over: Partial<JourneyConfig> = {}): JourneyConfig => ({
  name: "test journey",
  url: "https://example.com/",
  steps: [{ action: "goto", url: "https://example.com/" }],
  ...over,
});

// ── Journey → GMT script body ──────────────────────────────────────────────

Deno.test("journeyToGmtScript emits a bare body with no imports or test wrapper", () => {
  const { script } = journeyToGmtScript(journey({
    steps: [
      { action: "goto", url: "https://example.com/", waitFor: "networkidle" },
      { action: "wait", ms: 1500 },
    ],
  }));
  assertEquals(
    script,
    [
      `await page.goto("https://example.com/");`,
      `await page.waitForLoadState("networkidle");`,
      `await page.waitForTimeout(1500);`,
    ].join("\n"),
  );
});

Deno.test("journeyToGmtScript translates every step action", () => {
  const { script } = journeyToGmtScript(journey({
    steps: [
      { action: "click", selector: "role=link[name='Next']", waitFor: "load" },
      { action: "fill", selector: "#search", value: "carbon" },
      { action: "scroll", distance: 500 },
      { action: "waitForSelector", selector: ".results" },
    ],
  }));
  assertEquals(script.split("\n"), [
    `await page.locator("role=link[name='Next']").click();`,
    `await page.waitForLoadState("load");`,
    `await page.locator("#search").fill("carbon");`,
    `await page.evaluate("window.scrollBy(0, 500)");`,
    `await page.locator(".results").waitFor({ state: "visible" });`,
  ]);
});

Deno.test("journeyToGmtScript emits human scroll as a self-contained block", () => {
  // Two human scrolls in one journey must not collide on their loop bindings:
  // GMT eval()s the whole body as a single function, so a bare `let remaining`
  // twice would be a redeclaration SyntaxError.
  const { script } = journeyToGmtScript(journey({
    steps: [
      { action: "scroll", distance: 600, human: true },
      { action: "scroll", distance: -200, human: true },
    ],
  }));
  assertEquals(script.split("\n").filter((l) => l === "{").length, 2);
  assertStringIncludes(script, "let remaining = 600;");
  assertStringIncludes(script, "let remaining = 200;");
  // Negative distance keeps its direction.
  assertStringIncludes(script, "await page.mouse.wheel(0, -1 * chunk);");
  assertStringIncludes(script, "await page.mouse.wheel(0, 1 * chunk);");
});

Deno.test("journeyToGmtScript is deterministic across calls", () => {
  // The cluster builds a timeline from repeat submissions, so a journey must
  // serialise identically every time — no randomised scroll chunks.
  const config = journey({
    steps: [{ action: "scroll", distance: 900, human: true }],
  });
  assertEquals(
    journeyToGmtScript(config).script,
    journeyToGmtScript(config).script,
  );
});

Deno.test("journeyToGmtScript escapes selectors and URLs into JS literals", () => {
  const { script } = journeyToGmtScript(journey({
    steps: [
      { action: "fill", selector: `#a"b`, value: `say "hi"\nthen quit` },
    ],
  }));
  // The generated line must be valid JS — quotes and newlines encoded.
  assertStringIncludes(script, `"#a\\"b"`);
  assertStringIncludes(script, `"say \\"hi\\"\\nthen quit"`);
  assertEquals(script.split("\n").length, 1);
});

Deno.test("journeyToGmtScript takes the page URL from the first goto when no url field", () => {
  const { page } = journeyToGmtScript({
    name: "no url field",
    steps: [
      { action: "wait", ms: 100 },
      { action: "goto", url: "https://second.example/" },
      { action: "goto", url: "https://third.example/" },
    ],
  });
  assertEquals(page, "https://second.example/");
});

Deno.test("journeyToGmtScript prefers the explicit url field over the first goto", () => {
  const { page } = journeyToGmtScript(journey({
    url: "https://canonical.example/",
    steps: [{ action: "goto", url: "https://other.example/" }],
  }));
  assertEquals(page, "https://canonical.example/");
});

Deno.test("journeyToGmtScript rejects a journey with no starting URL", () => {
  const err = assertThrows(
    () =>
      journeyToGmtScript({
        name: "urlless",
        steps: [{ action: "wait", ms: 100 }],
      }),
    Error,
  );
  assertStringIncludes(err.message, "starting URL");
});

Deno.test("journeyToGmtScript does not cap journey length", () => {
  // GMT bounds a journey by its runner's --measurement-flow-process-duration
  // (24 h by default), so there is nothing for us to refuse up front. The
  // estimate is reported, not enforced.
  const { estimatedSeconds, script } = journeyToGmtScript(journey({
    steps: [{ action: "wait", ms: 600_000 }],
  }));
  assertEquals(estimatedSeconds, 600);
  assertStringIncludes(script, "await page.waitForTimeout(600000);");
});

Deno.test("journeyToGmtScript keeps the leading goto so the phase includes page load", () => {
  // GMT's template opens the page in an earlier hidden phase, but a local run
  // measures the load too — dropping it here would compare unlike things.
  const { script } = journeyToGmtScript(journey());
  assertStringIncludes(script, `await page.goto("https://example.com/");`);
});

// ── Gateway submission ─────────────────────────────────────────────────────

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response,
): {
  fetchImpl: typeof fetch;
  calls: Array<[string, RequestInit | undefined]>;
} {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push([url, init]);
    return Promise.resolve(handler(url, init));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

Deno.test("submitToGateway posts the webNRG script-mode payload and returns the job id", async () => {
  const { fetchImpl, calls } = stubFetch(() =>
    json({ data: { job_id: 4711 } })
  );

  const jobId = await submitToGateway({
    page: "https://example.com/",
    script: "await page.waitForTimeout(100);",
    email: "me@example.com",
  }, { fetchImpl });

  assertEquals(jobId, 4711);
  const [url, init] = calls[0];
  assertEquals(url, "https://gateway.green-coding.io/save");
  assertEquals(init?.method, "POST");
  // The gateway gates /save on an Origin allowlist; without this header every
  // submission comes back "Access from not supported site".
  assertEquals(
    (init?.headers as Record<string, string>)?.origin,
    CLIENT_ORIGIN,
  );
  assertEquals(JSON.parse(String(init?.body)), {
    page: "https://example.com/",
    script: "await page.waitForTimeout(100);",
    language: "js",
    mode: "website-script",
    email: "me@example.com",
    schedule_mode: "one-off",
  });
});

Deno.test("submitToGateway sends an empty email when none is given", async () => {
  const { fetchImpl, calls } = stubFetch(() => json({ data: { job_id: 1 } }));
  await submitToGateway({ page: "https://a.example/", script: "" }, {
    fetchImpl,
  });
  assertEquals(JSON.parse(String(calls[0][1]?.body)).email, "");
});

Deno.test("submitToGateway surfaces a gateway rejection", async () => {
  const { fetchImpl } = stubFetch(() =>
    new Response("bad url", { status: 422 })
  );
  const err = await assertRejects(
    () =>
      submitToGateway({ page: "https://a.example/", script: "" }, {
        fetchImpl,
      }),
    Error,
  );
  assertStringIncludes(err.message, "HTTP 422");
  assertStringIncludes(err.message, "bad url");
});

Deno.test("submitToGateway explains an Origin rejection instead of blaming the URL", async () => {
  // Guessing "is your page HTTP-only?" at an origin rejection sends people
  // chasing the wrong problem.
  const { fetchImpl } = stubFetch(() =>
    new Response("Access from not supported site", { status: 400 })
  );
  const err = await assertRejects(
    () =>
      submitToGateway({ page: "https://a.example/", script: "" }, {
        fetchImpl,
      }),
    Error,
  );
  assertStringIncludes(err.message, "Origin");
  assertStringIncludes(err.message, "cloudflare-worker.js");
});

Deno.test("submitToGateway points at the page when the gateway cannot reach it", async () => {
  const { fetchImpl } = stubFetch(() =>
    new Response(
      "Could not access webpage. Returned HTTP code was 403.",
      { status: 400 },
    )
  );
  const err = await assertRejects(
    () =>
      submitToGateway({ page: "https://a.example/", script: "" }, {
        fetchImpl,
      }),
    Error,
  );
  assertStringIncludes(err.message, "https://a.example/");
  assertStringIncludes(err.message, "http://");
});

Deno.test("submitToGateway errors when the gateway returns no job id", async () => {
  const { fetchImpl } = stubFetch(() => json({ data: {} }));
  await assertRejects(
    () =>
      submitToGateway({ page: "https://a.example/", script: "" }, {
        fetchImpl,
      }),
    Error,
    "no job id",
  );
});

// ── Run polling ────────────────────────────────────────────────────────────

/** A /v2/runs row in GMT's column order. */
const runRow = (
  over: { id?: string; endMeasurement?: unknown; failed?: boolean } = {},
) => [
  over.id ?? "uuid-1",
  "name",
  "uri",
  "main",
  "2026-08-19T10:00:00Z",
  0,
  "file.yml",
  { __GMT_VAR_PAGE__: "https://example.com/" },
  "machine",
  "commit",
  over.endMeasurement === undefined ? 1_700_000_000 : over.endMeasurement,
  over.failed ?? false,
  6,
  null,
];

Deno.test("fetchRunByJobId returns null while the job is queued", async () => {
  const { fetchImpl } = stubFetch(() => new Response(null, { status: 204 }));
  assertEquals(await fetchRunByJobId(9, { fetchImpl }), null);
});

Deno.test("fetchRunByJobId returns null while the run is still measuring", async () => {
  const { fetchImpl } = stubFetch(() =>
    json({ data: [runRow({ endMeasurement: null })] })
  );
  assertEquals(await fetchRunByJobId(9, { fetchImpl }), null);
});

Deno.test("fetchRunByJobId returns a finished run", async () => {
  const { fetchImpl, calls } = stubFetch(() => json({ data: [runRow()] }));
  const run = await fetchRunByJobId(9, { fetchImpl });
  assertEquals(run, {
    runId: "uuid-1",
    failed: false,
    createdAt: "2026-08-19T10:00:00Z",
  });
  assertStringIncludes(calls[0][0], "job_id=9");
});

Deno.test("fetchRunByJobId returns a failed run rather than waiting for an end timestamp", async () => {
  // A failed run never gets end_measurement, so treating "no end timestamp"
  // as "still running" would poll it until the 90-minute ceiling.
  const { fetchImpl } = stubFetch(() =>
    json({ data: [runRow({ endMeasurement: null, failed: true })] })
  );
  assertEquals((await fetchRunByJobId(9, { fetchImpl }))?.failed, true);
});

Deno.test("pollForRun retries until the run appears", async () => {
  let attempts = 0;
  const { fetchImpl } = stubFetch(() => {
    attempts++;
    return attempts < 3
      ? new Response(null, { status: 204 })
      : json({ data: [runRow()] });
  });
  const ticks: number[] = [];

  let clock = 0;
  const run = await pollForRun(
    9,
    { intervalMs: 1000, onTick: (s) => ticks.push(s) },
    {
      fetchImpl,
      sleepImpl: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
    },
  );

  assertEquals(run.runId, "uuid-1");
  assertEquals(attempts, 3);
  assertEquals(ticks, [0, 1]);
});

Deno.test("pollForRun gives up after the ceiling and points at the job page", async () => {
  const { fetchImpl } = stubFetch(() => new Response(null, { status: 204 }));
  let clock = 0;
  const err = await assertRejects(
    () =>
      pollForRun(4711, { intervalMs: 1000, maxMs: 3000 }, {
        fetchImpl,
        sleepImpl: (ms) => {
          clock += ms;
          return Promise.resolve();
        },
        now: () => clock,
      }),
    Error,
  );
  assertStringIncludes(err.message, "still queued");
  assertStringIncludes(err.message, "job_id=4711");
});

Deno.test("pollForRun honours a startedAtMs from a resumed submission", async () => {
  // A job left pending across a restart must age out against its original
  // submit time instead of getting a fresh 90-minute budget every startup.
  let attempts = 0;
  const { fetchImpl } = stubFetch(() => {
    attempts++;
    return new Response(null, { status: 204 });
  });
  await assertRejects(
    () =>
      pollForRun(1, { maxMs: 1000, startedAtMs: -10_000 }, {
        fetchImpl,
        sleepImpl: () => Promise.resolve(),
        now: () => 0,
      }),
    Error,
    "still queued",
  );
  assertEquals(attempts, 1);
});

// ── Phase stats ────────────────────────────────────────────────────────────

const phaseStats = (runId: string, over: Record<string, unknown> = {}) => ({
  data: {
    data: {
      [GMT_PHASE]: {
        data: {
          cpu_energy_rapl_msr_component: {
            data: { Package_0: { data: { [runId]: { mean: 7_200_000 } } } },
          },
          cpu_power_rapl_msr_component: {
            data: { Package_0: { data: { [runId]: { mean: 12_500 } } } },
          },
          phase_time_syscall_system: {
            data: { "[SYSTEM]": { data: { [runId]: { mean: 5_500_000 } } } },
          },
          network_total_cgroup_container: {
            data: {
              "gmt-playwright-nodejs": { data: { [runId]: { mean: 431_000 } } },
            },
          },
          network_carbon_formula_global: {
            data: { "[FORMULA]": { data: { [runId]: { mean: 250_000 } } } },
          },
          carbon_intensity_elephant_machine: {
            data: { DE: { data: { [runId]: { mean: 412 } } } },
          },
          ...over,
        },
      },
    },
  },
});

Deno.test("fetchMetrics converts GMT's raw units", async () => {
  const { fetchImpl, calls } = stubFetch(() => json(phaseStats("uuid-1")));
  const m = await fetchMetrics("uuid-1", { fetchImpl });

  assertStringIncludes(calls[0][0], "/v1/phase_stats/single/uuid-1");
  assertEquals(m.cpuEnergyMWh, 2); // 7.2e6 µJ = 2 mWh
  assertEquals(m.cpuPowerW, 12.5); // 12500 mW
  assertEquals(m.durationSeconds, 5.5); // 5.5e6 µs
  assertEquals(m.networkTransferKb, 431); // 431000 bytes
  assertEquals(m.networkCarbonG, 0.25); // 250000 µg
  assertEquals(m.carbonIntensityGCO2PerKWh, 412);
  assertEquals(
    m.detailsUrl,
    "https://metrics.green-coding.io/stats.html?id=uuid-1",
  );
});

Deno.test("fetchMetrics returns null for metrics the run did not report", async () => {
  const stats = phaseStats("uuid-1");
  // deno-lint-ignore no-explicit-any
  delete (stats.data.data[GMT_PHASE].data as any).network_carbon_formula_global;
  const { fetchImpl } = stubFetch(() => json(stats));
  const m = await fetchMetrics("uuid-1", { fetchImpl });
  assertEquals(m.networkCarbonG, null);
  assertEquals(m.cpuEnergyMWh, 2); // the rest still comes through
});

Deno.test("fetchMetrics errors when the journey phase is absent", async () => {
  const { fetchImpl } = stubFetch(() => json({ data: { data: {} } }));
  const err = await assertRejects(
    () => fetchMetrics("uuid-1", { fetchImpl }),
    Error,
  );
  assertStringIncludes(err.message, GMT_PHASE);
});

Deno.test("fetchMetrics errors on a 204 (results not written yet)", async () => {
  const { fetchImpl } = stubFetch(() => new Response(null, { status: 204 }));
  await assertRejects(
    () => fetchMetrics("uuid-1", { fetchImpl }),
    MetricsNotReadyError,
    "not available yet",
  );
});

Deno.test("awaitPhaseStats retries the 204 the API caches after a run finishes", async () => {
  let attempts = 0;
  const { fetchImpl } = stubFetch(() => {
    attempts++;
    return attempts < 3
      ? new Response(null, { status: 204 })
      : json(phaseStats("uuid-1"));
  });
  const ticks: number[] = [];

  let clock = 0;
  const m = await awaitPhaseStats("uuid-1", {
    intervalMs: 1000,
    onTick: (s) => ticks.push(s),
  }, {
    fetchImpl,
    sleepImpl: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  });

  assertEquals(m.cpuEnergyMWh, 2);
  assertEquals(attempts, 3);
  assertEquals(ticks, [0, 1]);
});

Deno.test("awaitPhaseStats retries a 5xx but not a 4xx", async () => {
  let attempts = 0;
  const { fetchImpl } = stubFetch(() => {
    attempts++;
    return attempts < 2
      ? new Response(null, { status: 502 })
      : json(phaseStats("uuid-1"));
  });
  const m = await awaitPhaseStats("uuid-1", { intervalMs: 1 }, {
    fetchImpl,
    sleepImpl: () => Promise.resolve(),
  });
  assertEquals(m.cpuEnergyMWh, 2);

  const { fetchImpl: notFound, calls } = stubFetch(() =>
    new Response(null, { status: 404 })
  );
  await assertRejects(
    () =>
      awaitPhaseStats("uuid-1", { intervalMs: 1 }, {
        fetchImpl: notFound,
        sleepImpl: () => Promise.resolve(),
      }),
    Error,
    "HTTP 404",
  );
  assertEquals(calls.length, 1);
});

Deno.test("awaitPhaseStats gives up after the ceiling with the run's link", async () => {
  const { fetchImpl } = stubFetch(() => new Response(null, { status: 204 }));
  let clock = 0;
  const err = await assertRejects(
    () =>
      awaitPhaseStats("uuid-1", { intervalMs: 1000, maxMs: 3000 }, {
        fetchImpl,
        sleepImpl: (ms) => {
          clock += ms;
          return Promise.resolve();
        },
        now: () => clock,
      }),
    MetricsNotReadyError,
  );
  assertStringIncludes(err.message, "not available yet");
  assertStringIncludes(err.message, "id=uuid-1");
});

// ── End-to-end orchestration ───────────────────────────────────────────────

Deno.test("awaitMetrics polls then reports metrics", async () => {
  let runCalls = 0;
  const { fetchImpl } = stubFetch((url) => {
    if (url.includes("/v2/runs")) {
      runCalls++;
      return runCalls < 2
        ? new Response(null, { status: 204 })
        : json({ data: [runRow()] });
    }
    return json(phaseStats("uuid-1"));
  });

  const seen: string[] = [];
  const m = await awaitMetrics(
    42,
    "j",
    (p) => {
      seen.push(p.status);
    },
    { intervalMs: 1 },
    { fetchImpl, sleepImpl: () => Promise.resolve() },
  );

  assertEquals(m.cpuEnergyMWh, 2);
  assertEquals(seen, ["pending"]);
});

Deno.test("awaitMetrics reports a failed cluster run as an error", async () => {
  const { fetchImpl } = stubFetch(() =>
    json({ data: [runRow({ endMeasurement: null, failed: true })] })
  );
  const err = await assertRejects(
    () =>
      awaitMetrics(42, "j", undefined, {}, {
        fetchImpl,
        sleepImpl: () => Promise.resolve(),
      }),
    Error,
  );
  assertStringIncludes(err.message, "could not measure");
  assertStringIncludes(err.message, "stats.html?id=uuid-1");
});
