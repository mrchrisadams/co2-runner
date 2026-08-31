// runner/gmt.ts — hand a YAML journey to the Green Metrics Tool cluster.
//
// co2-runner normally measures energy locally: it drives Playwright's Firefox
// on the user's machine and sums the Mozilla Profiler's power counters. This
// module is the second opinion — it submits the same journey to the Green
// Metrics Tool (GMT) cluster via the green-coding gateway, the same backend
// webNRG (website-tester.green-coding.io) uses, and reads the RAPL figures
// back once the cluster has run it.
//
// The exchange is three unauthenticated HTTP calls:
//
//   1. POST  gateway.green-coding.io/save        → { data: { job_id } }
//   2. GET   api.green-coding.io/v2/runs?job_id= → poll until a run appears
//   3. GET   api.green-coding.io/v1/phase_stats/single/<run uuid>
//
// GMT does not take a journey file. It takes a *bare Playwright body* which it
// base64-decodes and eval()s inside a closure where `page`, `context`,
// `browser` and `sleep` are already globals (see the GMT repo's
// templates/partials/gmt-playwright-ipc.js). journeyToGmtScript() below is the
// translation layer from our YAML step list to that body.
//
// IMPORTANT: the two numbers are NOT directly comparable, and anything that
// displays them together has to say so. A local run measures the whole Firefox
// process on the user's desktop across the entire journey; GMT measures RAPL
// package energy inside a container on a dedicated cluster machine, for the
// journey phase only, with a pre-warmed cache and a Squid proxy in front.

import { parseJourneyConfig } from "./journey-config.ts";
import type { GmtMetrics, GmtProgress, JourneyConfig, Step } from "../types.ts";

export const GATEWAY_SAVE_URL = "https://gateway.green-coding.io/save";

/**
 * Origin we present to the gateway.
 *
 * The gateway worker gates /save on a hard allowlist of browser origins — it
 * is the only thing standing between the public internet and the GMT API
 * token the worker holds. co2-runner is not a browser and sends no Origin of
 * its own, so without this every submission comes back as
 * "Access from not supported site".
 *
 * We send webNRG's origin because co2-runner submits through exactly the same
 * gateway path webNRG does, and both are Green Coding Solutions properties.
 * The trade-off is that gateway logs cannot tell a desktop submission from a
 * webNRG one; if that ever matters, add a dedicated entry (e.g.
 * "app://co2-runner") to `allowedOrigins` in gateway.green-coding.io's
 * cloudflare-worker.js and change this constant to match.
 */
export const CLIENT_ORIGIN = "https://website-tester.green-coding.io";
export const API_BASE = "https://api.green-coding.io";
export const METRICS_BASE = "https://metrics.green-coding.io";

/**
 * The usage-scenario phase our journey body runs in, and the template the
 * gateway picks for `mode: website-script`. Both are fixed by GMT's
 * templates/website/usage_scenario_playwright_js_cached.yml.
 */
export const GMT_PHASE = "Run User Journey";
export const GMT_FILENAME =
  "templates/website/usage_scenario_playwright_js_cached.yml";

/** Poll cadence + ceiling. Cluster runs typically land in 5–30 minutes. */
export const POLL_INTERVAL_MS = 30_000;
export const POLL_MAX_MS = 90 * 60 * 1000;

/**
 * Second, much shorter poll: /v1/phase_stats/single answers 204 for a few
 * seconds *after* the run row is finished, because the API caches the empty
 * result from before the measurements were written. Giving up on that first
 * 204 loses a run whose data lands moments later, so we re-ask on this cadence
 * until the ceiling.
 */
export const METRICS_RETRY_INTERVAL_MS = 5_000;
export const METRICS_RETRY_MAX_MS = 5 * 60 * 1000;

/** Injected in tests. */
export interface GmtDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── YAML journey → GMT Playwright body ─────────────────────────────────────

export interface GmtScript {
  /** The URL GMT opens (and caches) before running the body. */
  page: string;
  /** Bare Playwright statements — no imports, no test() wrapper. */
  script: string;
  /**
   * Rough wall-clock estimate, shown in the submission preview so the user
   * knows roughly how much cluster time they are asking for. Informational
   * only — GMT bounds a journey by its runner's
   * --measurement-flow-process-duration (24 h by default), so there is no
   * length we need to refuse up front.
   */
  estimatedSeconds: number;
}

/**
 * Deterministic stand-ins for the randomised values executeStep() uses for
 * human-like scrolling. The cluster re-runs journeys over time to build a
 * timeline, so the submitted body must not vary between submissions —
 * otherwise a change in the graph could just be a different dice roll.
 * These are the midpoints of run.ts's rand(120, 240) / rand(40, 180).
 */
const SCROLL_CHUNK_PX = 180;
const SCROLL_PAUSE_MS = 110;

/** Per-step wall-clock guesses for the pre-flight duration check. */
const STEP_COST_MS = {
  goto: 2000,
  click: 1000,
  fill: 200,
  waitForSelector: 1000,
  scrollInstant: 50,
} as const;

const js = (v: string) => JSON.stringify(v);

function emitStep(step: Step, lines: string[]): number {
  switch (step.action) {
    case "goto": {
      lines.push(`await page.goto(${js(step.url)});`);
      if (step.waitFor) {
        lines.push(`await page.waitForLoadState(${js(step.waitFor)});`);
      }
      return STEP_COST_MS.goto;
    }

    case "click": {
      lines.push(`await page.locator(${js(step.selector)}).click();`);
      if (step.waitFor) {
        lines.push(`await page.waitForLoadState(${js(step.waitFor)});`);
      }
      return STEP_COST_MS.click;
    }

    case "fill": {
      lines.push(
        `await page.locator(${js(step.selector)}).fill(${js(step.value)});`,
      );
      return STEP_COST_MS.fill;
    }

    case "scroll": {
      if (!step.human) {
        lines.push(
          `await page.evaluate("window.scrollBy(0, ${step.distance})");`,
        );
        return STEP_COST_MS.scrollInstant;
      }
      // Wrapped in a block so repeated scroll steps don't collide on the
      // `remaining` / `chunk` bindings — the whole body is eval'd as one
      // function, so these share a scope.
      const total = Math.abs(step.distance);
      const dir = step.distance >= 0 ? 1 : -1;
      lines.push(
        `{`,
        `  let remaining = ${total};`,
        `  while (remaining > 0) {`,
        `    const chunk = Math.min(${SCROLL_CHUNK_PX}, remaining);`,
        `    await page.mouse.wheel(0, ${dir} * chunk);`,
        `    remaining -= chunk;`,
        `    await page.waitForTimeout(${SCROLL_PAUSE_MS});`,
        `  }`,
        `}`,
      );
      return Math.ceil(total / SCROLL_CHUNK_PX) * SCROLL_PAUSE_MS;
    }

    case "wait": {
      lines.push(`await page.waitForTimeout(${step.ms});`);
      return step.ms;
    }

    case "waitForSelector": {
      lines.push(
        `await page.locator(${
          js(step.selector)
        }).waitFor({ state: "visible" });`,
      );
      return STEP_COST_MS.waitForSelector;
    }
  }
}

/**
 * Translates a validated YAML journey into the body GMT expects.
 *
 * The journey's leading `goto` is deliberately kept even though GMT's template
 * already opens the page in an earlier (hidden) phase: our local measurement
 * includes the initial page load, so dropping it here would compare a
 * load-plus-interactions figure against an interactions-only one. GMT's copy
 * of that load is served from the warm cache, so it is cheaper than ours —
 * which is one more reason the two figures are indicative, not equal.
 */
export function journeyToGmtScript(config: JourneyConfig): GmtScript {
  const lines: string[] = [];
  let estimatedMs = 0;
  let firstGoto: string | undefined;

  for (const step of config.steps) {
    if (step.action === "goto" && firstGoto === undefined) {
      firstGoto = step.url;
    }
    estimatedMs += emitStep(step, lines);
  }

  const page = config.url ?? firstGoto;
  if (!page) {
    throw new Error(
      `journey '${config.name}': cannot submit to the GMT cluster without a ` +
        `starting URL — add a top-level 'url:' field or a 'goto' step`,
    );
  }

  return {
    page,
    script: lines.join("\n"),
    estimatedSeconds: Math.ceil(estimatedMs / 1000),
  };
}

/** Reads a YAML journey off disk and prepares it for submission. */
export async function loadJourneyForGmt(
  journeyPath: string,
): Promise<{ config: JourneyConfig; script: GmtScript }> {
  assertYamlJourney(journeyPath);
  const raw = await Deno.readTextFile(journeyPath);
  const config = parseJourneyConfig(raw, journeyPath);
  return { config, script: journeyToGmtScript(config) };
}

/**
 * GMT submission is YAML-only for now. Codegen scripts would need their
 * test() body unwrapped and their expect() calls stripped (GMT has no
 * expect), which is a separate piece of work.
 */
export function assertYamlJourney(journeyPath: string): void {
  const lower = journeyPath.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return;
  throw new Error(
    `only YAML journeys can be submitted to the GMT cluster (got ` +
      `'${journeyPath}'). Codegen .spec.js journeys are not supported yet.`,
  );
}

// ── 1. Submit ──────────────────────────────────────────────────────────────

/**
 * POSTs the journey to the green-coding gateway and returns the job id.
 *
 * Note this sends the target URL and the generated script body — and the
 * email, if given — to a third-party service. Callers must only reach this
 * on an explicit user action.
 */
export async function submitToGateway(
  opts: { page: string; script: string; email?: string },
  deps: GmtDeps = {},
): Promise<number> {
  const doFetch = deps.fetchImpl ?? fetch;

  const response = await doFetch(GATEWAY_SAVE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "origin": CLIENT_ORIGIN,
    },
    body: JSON.stringify({
      page: opts.page,
      script: opts.script,
      language: "js",
      mode: "website-script",
      email: opts.email ?? "",
      schedule_mode: "one-off",
    }),
  });

  if (!response.ok) {
    const text = (await response.text().catch(() => "")).trim();
    // The gateway's own message is the useful part; only add a hint when we
    // can tell which failure this is. Guessing wrong sends people chasing
    // the wrong problem (an origin rejection is not a URL problem).
    let hint = "";
    if (/not supported site/i.test(text)) {
      hint = ` — the gateway did not accept the Origin we sent ` +
        `('${CLIENT_ORIGIN}'). Its allowlist lives in ` +
        `gateway.green-coding.io/cloudflare-worker.js`;
    } else if (/could not access webpage/i.test(text)) {
      hint = ` — the gateway could not reach ${opts.page}. Is it public? ` +
        `If it is HTTP-only, prefix the URL with http://`;
    }
    throw new Error(
      `gateway rejected the submission (HTTP ${response.status})` +
        (text ? `: ${text}` : "") + hint,
    );
  }

  const jobId = (await response.json())?.data?.job_id;
  if (typeof jobId !== "number") {
    throw new Error("gateway accepted the submission but returned no job id");
  }
  return jobId;
}

// ── 2. Poll for the run ────────────────────────────────────────────────────

export interface GmtRun {
  runId: string;
  failed: boolean;
  createdAt: string;
}

/**
 * Looks up the run the gateway job produced.
 *
 * Returns null while the job is still queued (HTTP 204 / no row) or while the
 * machine is measuring (`end_measurement` unset and not failed). Column order
 * is fixed by GMT's api/scenario_runner.py `/v2/runs` SELECT.
 */
export async function fetchRunByJobId(
  jobId: number,
  deps: GmtDeps = {},
): Promise<GmtRun | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  const response = await doFetch(
    `${API_BASE}/v2/runs?job_id=${encodeURIComponent(String(jobId))}&limit=1`,
  );

  if (response.status === 204) return null; // no run row yet
  if (!response.ok) {
    throw new Error(
      `GMT API returned HTTP ${response.status} for the run list`,
    );
  }

  const row = (await response.json())?.data?.[0];
  if (row == null) return null;

  const runId = row[0] as string;
  const createdAt = row[4] as string;
  const endMeasurement = row[10];
  const failed = row[11] === true;

  // Still measuring: the row exists but has no end timestamp.
  if (!failed && endMeasurement == null) return null;

  return { runId, failed, createdAt };
}

export interface PollOptions {
  onTick?: (waitedSeconds: number) => void;
  intervalMs?: number;
  maxMs?: number;
  /** Defaults to now. Set when resuming a submission made earlier. */
  startedAtMs?: number;
  /** Cadence for the shorter second wait on the run's measurements. */
  metrics?: Omit<MetricsWaitOptions, "onTick">;
}

/** Polls until the cluster produces a run, or POLL_MAX_MS elapses. */
export async function pollForRun(
  jobId: number,
  opts: PollOptions = {},
  deps: GmtDeps = {},
): Promise<GmtRun> {
  const sleep = deps.sleepImpl ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const maxMs = opts.maxMs ?? POLL_MAX_MS;
  // startedAtMs lets a resumed submission carry its original submit time, so
  // a job left pending across a restart ages out instead of restarting its
  // 90-minute budget on every server start.
  const startedAt = opts.startedAtMs ?? now();

  while (true) {
    const run = await fetchRunByJobId(jobId, deps);
    if (run != null) return run;

    if (now() - startedAt > maxMs) {
      throw new Error(
        `no result after ${
          Math.round(maxMs / 60_000)
        } minutes — the job is most likely still queued. ` +
          `Check back later at ${jobDetailsUrl(jobId)}`,
      );
    }

    opts.onTick?.(Math.round((now() - startedAt) / 1000));
    await sleep(intervalMs);
  }
}

// ── 3. Read the metrics ────────────────────────────────────────────────────

/** Walks the nested phase_stats shape down to a single mean value. */
function meanOf(
  phaseData: Record<string, any> | undefined,
  metric: string,
  detail: string,
  runId: string,
): number | null {
  const value = phaseData?.[metric]?.["data"]?.[detail]?.["data"]?.[runId]
    ?.["mean"];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Same, for a metric whose detail name we don't know up front. */
function meanOfFirstDetail(
  phaseData: Record<string, any> | undefined,
  metric: string,
  runId: string,
): number | null {
  const details = phaseData?.[metric]?.["data"];
  const first = details ? Object.keys(details)[0] : undefined;
  if (first === undefined) return null;
  return meanOf(phaseData, metric, first, runId);
}

const scale = (v: number | null, factor: number) =>
  v === null ? null : v / factor;

export function runDetailsUrl(runId: string): string {
  return `${METRICS_BASE}/stats.html?id=${encodeURIComponent(runId)}`;
}

export function jobDetailsUrl(jobId: number): string {
  return `https://website-tester.green-coding.io/script-details.html?job_id=${
    encodeURIComponent(String(jobId))
  }`;
}

/**
 * Thrown while the measurements a finished run *will* have are not readable
 * yet. Distinct from a plain Error so awaitPhaseStats() knows the call is
 * worth repeating; anything else it lets through immediately.
 */
export class MetricsNotReadyError extends Error {
  constructor(readonly status: number, runId: string) {
    super(
      `the run finished but its measurements are not available yet ` +
        `(HTTP ${status}). See ${runDetailsUrl(runId)}`,
    );
    this.name = "MetricsNotReadyError";
  }
}

/**
 * Fetches phase_stats for a finished run and extracts the journey phase.
 *
 * One attempt only — throws MetricsNotReadyError on the 204 the API serves
 * from its cache in the seconds after a run finishes. Callers that can wait
 * should use awaitPhaseStats().
 */
export async function fetchMetrics(
  runId: string,
  deps: GmtDeps = {},
): Promise<GmtMetrics> {
  const doFetch = deps.fetchImpl ?? fetch;
  const response = await doFetch(
    `${API_BASE}/v1/phase_stats/single/${encodeURIComponent(runId)}`,
  );

  // 204 = no phase_stats rows (yet); 5xx/429 = the API itself is unhappy.
  // Both clear up on their own; a 4xx will not, so it is fatal here.
  if (
    response.status === 204 || response.status === 429 || response.status >= 500
  ) {
    throw new MetricsNotReadyError(response.status, runId);
  }
  if (!response.ok) {
    throw new Error(
      `GMT API returned HTTP ${response.status} for the run's measurements. ` +
        `See ${runDetailsUrl(runId)}`,
    );
  }

  const phaseData = (await response.json())?.data?.["data"]?.[GMT_PHASE]
    ?.["data"];
  if (phaseData == null) {
    throw new Error(
      `the run finished but contains no '${GMT_PHASE}' phase data. ` +
        `See ${runDetailsUrl(runId)}`,
    );
  }

  const cpuEnergyUJ = meanOf(
    phaseData,
    "cpu_energy_rapl_msr_component",
    "Package_0",
    runId,
  );
  const cpuPowerMW = meanOf(
    phaseData,
    "cpu_power_rapl_msr_component",
    "Package_0",
    runId,
  );
  const durationUS = meanOf(
    phaseData,
    "phase_time_syscall_system",
    "[SYSTEM]",
    runId,
  );
  const networkBytes = meanOf(
    phaseData,
    "network_total_cgroup_container",
    "gmt-playwright-nodejs",
    runId,
  );
  const networkCarbonUG = meanOf(
    phaseData,
    "network_carbon_formula_global",
    "[FORMULA]",
    runId,
  );

  return {
    runId,
    // GMT reports microjoules; 1 mWh = 3.6e6 µJ.
    cpuEnergyMWh: scale(cpuEnergyUJ, 3_600_000),
    cpuPowerW: scale(cpuPowerMW, 1_000),
    durationSeconds: scale(durationUS, 1e6),
    networkTransferKb: scale(networkBytes, 1000),
    networkCarbonG: scale(networkCarbonUG, 1_000_000),
    carbonIntensityGCO2PerKWh: meanOfFirstDetail(
      phaseData,
      "carbon_intensity_elephant_machine",
      runId,
    ),
    detailsUrl: runDetailsUrl(runId),
  };
}

export interface MetricsWaitOptions {
  onTick?: (waitedSeconds: number) => void;
  intervalMs?: number;
  maxMs?: number;
}

/**
 * Reads a finished run's metrics, retrying while the API says "not yet".
 *
 * A run row flips to finished before its phase_stats are readable — the API's
 * cache holds the pre-measurement answer (HTTP 204) for a few seconds longer.
 * Treating that first 204 as failure threw away runs whose data was seconds
 * away, so we re-ask on METRICS_RETRY_INTERVAL_MS until METRICS_RETRY_MAX_MS,
 * then surface the original "not available yet" message with its link.
 */
export async function awaitPhaseStats(
  runId: string,
  opts: MetricsWaitOptions = {},
  deps: GmtDeps = {},
): Promise<GmtMetrics> {
  const sleep = deps.sleepImpl ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? METRICS_RETRY_INTERVAL_MS;
  const maxMs = opts.maxMs ?? METRICS_RETRY_MAX_MS;
  const startedAt = now();

  while (true) {
    try {
      return await fetchMetrics(runId, deps);
    } catch (err) {
      if (!(err instanceof MetricsNotReadyError)) throw err;
      if (now() - startedAt > maxMs) throw err;
      opts.onTick?.(Math.round((now() - startedAt) / 1000));
      await sleep(intervalMs);
    }
  }
}

// ── Orchestration ──────────────────────────────────────────────────────────

/**
 * Waits for a submitted job and returns its metrics, reporting progress as it
 * goes. Split from submitToGateway() so a caller can persist the job id
 * before committing to a 90-minute wait — the id is the only handle on a run
 * that outlives the process.
 */
export async function awaitMetrics(
  jobId: number,
  journeyName: string,
  onProgress?: (p: GmtProgress) => void,
  opts: Omit<PollOptions, "onTick"> = {},
  deps: GmtDeps = {},
): Promise<GmtMetrics> {
  const { metrics: metricsOpts, ...pollOpts } = opts;
  const run = await pollForRun(
    jobId,
    {
      ...pollOpts,
      onTick: (waitedSeconds) =>
        onProgress?.({
          jobId,
          journeyName,
          status: "pending",
          message: `Waiting on the GMT cluster — ${
            Math.round(waitedSeconds / 60)
          } min so far`,
          waitedSeconds,
        }),
    },
    deps,
  );

  if (run.failed) {
    throw new Error(
      `the cluster could not measure this journey. The usual cause is a ` +
        `selector that does not match on the cluster's viewport (1280x800, ` +
        `no cookie banner dismissed for you). See ${runDetailsUrl(run.runId)}`,
    );
  }

  return await awaitPhaseStats(
    run.runId,
    {
      ...metricsOpts,
      onTick: (waitedSeconds) =>
        onProgress?.({
          jobId,
          journeyName,
          status: "pending",
          message:
            "The run finished — waiting for the cluster to publish its measurements",
          waitedSeconds,
        }),
    },
    deps,
  );
}
